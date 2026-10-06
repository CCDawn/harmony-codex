export async function readJsonBody(request, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;

  try {
    for await (const chunk of request) {
      size += chunk.byteLength;
      if (size > maxBytes) {
        const error = new Error('Request body is too large');
        error.statusCode = 413;
        throw error;
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error?.statusCode) {
      throw error;
    }
    const wrapped = new Error(error?.code === 'ECONNRESET' || /aborted/i.test(error?.message ?? '')
      ? 'Client aborted request body upload'
      : `Failed to read request body: ${error?.message ?? String(error)}`);
    wrapped.statusCode = error?.code === 'ECONNRESET' || /aborted/i.test(error?.message ?? '') ? 499 : 400;
    throw wrapped;
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Request body must be valid JSON');
    error.statusCode = 400;
    throw error;
  }
}

export function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'Content-Type,Authorization,X-Codex-Bridge-Token,X-Codex-Bridge-OTP'
  });
  response.end(body);
}
