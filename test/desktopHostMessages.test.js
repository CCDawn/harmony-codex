import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexDesktopCdpClient } from '../src/codexDesktopCdpClient.js';

function rendererHarness(options = {}) {
  const rawListeners = new Set();
  const handlers = new Map();
  const bus = {
    initialized: true,
    dispatchHostMessage() {},
    startWindowMessageListener() {},
    subscribe(type, handler) {
      const set = handlers.get(type) ?? new Set();
      handlers.set(type, set);
      set.add(handler);
      return () => set.delete(handler);
    }
  };
  const emit = message => {
    for (const listener of handlers.get(message.type) ?? []) listener(message);
  };
  let imports = 0;
  const window = {
    addEventListener(_type, listener) { rawListeners.add(listener); },
    removeEventListener(_type, listener) { rawListeners.delete(listener); },
    electronBridge: {
      async sendMessageFromView(command) {
        if (options.send) return options.send(command, emit);
        const { hostId, request } = command;
        // The preload exposes chunk envelopes to raw window listeners. The
        // desktop's existing bus assembles them and emits the real response.
        for (const listener of rawListeners) listener({ data: {
          marker: 'codex-host-chunked-message-v1', kind: 'start', transferId: request.id, sequence: 0
        } });
        emit({ type: 'mcp-response', hostId, message: {
          id: request.id, result: { threadId: request.params.threadId, text: 'x'.repeat(131072) }
        } });
      }
    }
  };
  const document = { scripts: [{ type: 'module', src: 'app://-/assets/index-test.js' }] };
  const fetch = async url => ({ ok: true, text: async () => url.includes('index-test')
    ? 'import "./app-shared-test.js";' : 'hostMessageInterceptors subscribe startWindowMessageListener' });
  const importModule = async () => {
    imports++;
    if (options.failFirstImport && imports === 1) throw new Error('temporary module load failure');
    return options.unavailable ? {} : { changedExport: bus };
  };
  const client = new CodexDesktopCdpClient();
  client.ensureConnected = async () => {};
  client.call = async (_method, params) => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const run = new AsyncFunction('window', 'document', 'fetch', '__import',
      `return (${params.expression.replaceAll('import(assetUrl)', '__import(assetUrl)')});`);
    return { result: { result: { value: await run(window, document, fetch, importModule) } } };
  };
  return { client, handlers, rawListeners, window, get imports() { return imports; } };
}

test('chunked history uses the desktop assembled message bus and cleans up subscriptions', async () => {
  const previous = process.env.CODEX_DESKTOP_MCP_TIMEOUT_MS;
  process.env.CODEX_DESKTOP_MCP_TIMEOUT_MS = '1000';
  try {
    const h = rendererHarness();
    const results = await Promise.all([
      h.client.request('thread/turns/list', { threadId: 'image-thread' }),
      h.client.request('thread/read', { threadId: 'other-thread' })
    ]);
    assert.deepEqual(results.map(value => value.threadId), ['image-thread', 'other-thread']);
    assert.equal(results[0].text.length, 131072);
    assert.equal(h.handlers.get('mcp-response').size, 0);
    assert.equal(h.imports, 1, 'concurrent requests reuse the native bus discovery');
    assert.equal(h.window.__codexHarmonyCdpResponses.size, 0);
  } finally {
    if (previous === undefined) delete process.env.CODEX_DESKTOP_MCP_TIMEOUT_MS;
    else process.env.CODEX_DESKTOP_MCP_TIMEOUT_MS = previous;
  }
});

test('host fetch also receives assembled responses without depending on raw window events', async () => {
  const h = rendererHarness({ send(command, emit) {
    emit({ type: 'fetch-response', requestId: command.requestId,
      responseType: 'success', status: 200, bodyJsonString: JSON.stringify({ values: ['large-result'] }) });
  } });
  assert.deepEqual(await h.client.fetchFromHost('load-test'), { values: ['large-result'] });
  assert.equal(h.handlers.get('fetch-response').size, 0);
});

test('assembled responses retain host and request isolation and release handlers on protocol errors', async () => {
  const h = rendererHarness({ send({ hostId, request }, emit) {
    emit({ type: 'mcp-response', hostId: 'another-host', message: { id: request.id, result: 'wrong host' } });
    emit({ type: 'mcp-response', hostId, message: { id: 'another-request', result: 'wrong request' } });
    emit({ type: 'mcp-response', hostId, message: { id: request.id, error: { code: -1, message: 'expected protocol failure' } } });
  } });
  await assert.rejects(h.client.request('thread/read', { threadId: 'test' }), /expected protocol failure/);
  assert.equal(h.handlers.get('mcp-response').size, 0);
});

test('failed native receiver discovery is retried and never dispatches through a partial receiver', async () => {
  let dispatched = 0;
  const h = rendererHarness({ failFirstImport: true, send({ hostId, request }, emit) {
    dispatched++;
    emit({ type: 'mcp-response', hostId, message: { id: request.id, result: 'recovered' } });
  } });
  await assert.rejects(h.client.request('thread/read', { threadId: 'test' }), /temporary module load failure/);
  assert.equal(dispatched, 0);
  assert.equal(h.window.__codexHarmonyHostMessages, undefined);
  assert.equal(await h.client.request('thread/read', { threadId: 'test' }), 'recovered');
  assert.equal(dispatched, 1);
});

test('an incompatible desktop receiver fails before any request is dispatched', async () => {
  let dispatched = 0;
  const h = rendererHarness({ unavailable: true, send() { dispatched++; } });
  await assert.rejects(h.client.request('thread/read', { threadId: 'test' }), /assembled message receiver unavailable/);
  assert.equal(dispatched, 0);
  assert.equal(h.window.__codexHarmonyHostMessages, undefined);
});

test('one stalled CDP evaluation leaves concurrent calls and the shared socket alive', async () => {
  const client = new CodexDesktopCdpClient();
  const sent = [];
  let closed = 0;
  const socket = { readyState: WebSocket.OPEN, send(value) { sent.push(JSON.parse(value)); }, close() { closed++; } };
  client.socket = socket;
  const stalled = client.call('Runtime.evaluate', { expression: 'stalled' }, 15).catch(error => error);
  const healthy = client.call('Runtime.evaluate', { expression: 'healthy' }, 1000);
  // Attach a handler before the first deadline to avoid an unhandled rejection
  // on the old implementation, which rejects every pending request together.
  const healthyResult = healthy.catch(error => error);
  const error = await stalled;
  assert.match(error.message, /超时/);
  client.handleMessage({ data: JSON.stringify({ id: sent[1].id, result: { value: 'ok' } }) });
  assert.deepEqual(await healthyResult, { id: sent[1].id, result: { value: 'ok' } });
  assert.equal(client.socket, socket);
  assert.equal(closed, 0);
  assert.equal(client.pending.size, 0);
});
