// These functions also run in the renderer; keep them self-contained. Native
// host-message assembly is separate from the bounded CDP return transport.
export function stageDesktopCdpResponse(window, value) {
  const text = JSON.stringify(value);
  if (text.length <= 65536) return value;
  const buffers = window.__codexHarmonyCdpResponses ??= new Map();
  if (buffers.size >= 16) throw new Error('Codex desktop response transport is busy');
  const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  const timer = setTimeout(() => buffers.delete(id), 60000);
  buffers.set(id, { text, timer });
  return { __codexHarmonyCdpResponse: { id, length: text.length } };
}

export function desktopCdpResponseChunk(window, id, offset) {
  const buffer = window.__codexHarmonyCdpResponses?.get(id);
  if (!buffer) throw new Error('Codex desktop response transfer expired');
  return { id, offset, text: buffer.text.slice(offset, offset + 65536) };
}

export function releaseDesktopCdpResponse(window, id) {
  const buffers = window.__codexHarmonyCdpResponses;
  const buffer = buffers?.get(id);
  if (buffer) clearTimeout(buffer.timer);
  buffers?.delete(id);
  return true;
}

export async function collectDesktopCdpResponse(value, evaluate, timeoutMs) {
  const transfer = value?.__codexHarmonyCdpResponse;
  if (!transfer) return value;
  if (typeof transfer.id !== 'string' || !Number.isSafeInteger(transfer.length) || transfer.length <= 0) {
    throw new Error('Invalid Codex desktop response transfer');
  }
  const deadline = Date.now() + timeoutMs;
  const chunks = [];
  let offset = 0;
  try {
    while (offset < transfer.length) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Codex desktop response transfer timed out');
      const chunk = await evaluate(`(${desktopCdpResponseChunk.toString()})(window, ${JSON.stringify(transfer.id)}, ${offset})`, remaining);
      if (chunk?.id !== transfer.id || chunk.offset !== offset || typeof chunk.text !== 'string'
          || !chunk.text.length || chunk.text.length > 65536 || offset + chunk.text.length > transfer.length) {
        throw new Error('Invalid Codex desktop response chunk');
      }
      chunks.push(chunk.text);
      offset += chunk.text.length;
    }
    return JSON.parse(chunks.join(''));
  } finally {
    await evaluate(`(${releaseDesktopCdpResponse.toString()})(window, ${JSON.stringify(transfer.id)})`, 1000).catch(() => {});
  }
}
