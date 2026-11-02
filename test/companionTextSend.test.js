import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { CompanionDesktopClient, historyEntries } from '../src/companionDesktopClient.js';
import { CompanionConversationService, handleCompanionRoute } from '../src/companionConversationService.js';

const requestId = '12345678-1234-4123-8123-123456789abc';
const input = { profileId: 'assistant', roomId: 'official-room', text: '你好\n保留原文 ', requestId };
const submitted = { requestId, state: 'submitted', itemId: 'room:server-message' };

function fakeService({ discovered = { id: input.profileId, roomId: input.roomId }, send } = {}) {
  const calls = { created: 0, closed: 0, writes: [] };
  const service = new CompanionConversationService({ clientFactory() {
    calls.created++;
    return {
      async discover() { return discovered; },
      async sendText(value) {
        calls.writes.push(value);
        return send ? send(value) : { ...submitted };
      },
      close() { calls.closed++; }
    };
  } });
  return { service, calls };
}

// Execute the exact generated desktop body, replacing only module discovery.
// This verifies actual request options and receipt handling without CDP/network.
function desktopWithApi(api) {
  const calls = { connected: 0, evaluated: 0 };
  const client = new CompanionDesktopClient({
    async ensureConnected() { calls.connected++; },
    async evaluate(expression) {
      calls.evaluated++;
      const marker = 'const params=';
      const start = expression.indexOf(marker) + marker.length;
      const end = expression.indexOf(';\n', start);
      const catchStart = expression.lastIndexOf('}catch(error){');
      assert.ok(end > start && catchStart > end);
      // Retain the production catch wrapper, including fixed classifications.
      return new Function('api', 'AbortSignal', `return (async()=>{try{${expression.slice(expression.indexOf(marker))}`)(api, AbortSignal);
    },
    close() {}
  });
  return { client, calls };
}

function primary(profile = {}) {
  return { profile: { id: input.profileId, messaging_room_id: input.roomId,
    aeon_kind: 'orbit', status: 'active', ...profile } };
}

function responseCapture() {
  return { statusCode: null, payload: null,
    writeHead(code) { this.statusCode = code; },
    end(body) { this.payload = JSON.parse(body); }
  };
}

test('invalid text, identities and request IDs are rejected before opening a desktop client', async () => {
  const { service, calls } = fakeService();
  const invalid = [
    { text: '' }, { text: ' \r\n' }, { text: null }, { text: ['message'] },
    { text: 'a'.repeat(20001) }, { profileId: '' }, { profileId: 'a'.repeat(513) },
    { roomId: null }, { requestId: '' }, { requestId: 'local-1' }, { requestId: requestId + '\n' }
  ];
  for (const change of invalid) {
    await assert.rejects(service.sendText({ ...input, ...change }), error => error.statusCode === 400);
  }
  assert.equal(calls.created, 0);
});

test('profile and room must both match the official personal assistant before writing', async () => {
  for (const discovered of [
    { id: 'another-assistant', roomId: input.roomId },
    { id: input.profileId, roomId: 'another-room' }
  ]) {
    const { service, calls } = fakeService({ discovered });
    await assert.rejects(service.sendText(input), error => error.statusCode === 409);
    assert.equal(calls.writes.length, 0);
    assert.equal(calls.closed, 1);
  }
});

test('concurrent and repeated sends share one official submission with stable UUID and unchanged text', async () => {
  const gate = Promise.withResolvers();
  const { service, calls } = fakeService({ send: () => gate.promise });
  const pending = service.sendText({ ...input, requestId: requestId.toUpperCase() });
  const duplicate = service.sendText(input);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.writes.length, 1);
  assert.deepEqual(calls.writes[0], input);
  gate.resolve(submitted);
  assert.deepEqual(await pending, submitted);
  assert.deepEqual(await duplicate, submitted);
  assert.deepEqual(await service.sendText(input), submitted);
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.created, 1);
  assert.equal(calls.closed, 1);
});

test('a request UUID cannot be reused for different text, profile or room', async () => {
  const { service, calls } = fakeService();
  await service.sendText(input);
  for (const change of [{ text: 'different' }, { profileId: 'other' }, { roomId: 'other' }]) {
    await assert.rejects(service.sendText({ ...input, ...change }), error => error.statusCode === 409);
  }
  assert.equal(calls.writes.length, 1);
});

test('timeout, lost connection, HTTP 408 and HTTP 5xx stay uncertain and are never replayed', async () => {
  for (const error of [new Error('private CDP detail'),
    Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
    Object.assign(new Error('timeout'), { status: 408 }),
    Object.assign(new Error('private server failure'), { status: 503 })]) {
    const { service, calls } = fakeService({ send() { throw error; } });
    const expected = { requestId, state: 'uncertain', itemId: null };
    assert.deepEqual(await service.sendText(input), expected);
    assert.deepEqual(await service.sendText(input), expected);
    assert.equal(calls.writes.length, 1);
    assert.equal(calls.closed, 1);
  }
});

test('known 4xx rejection remains a failed request and exposes no connector details', async () => {
  const { service, calls } = fakeService({ send() {
    throw Object.assign(new Error('private server failure'), { status: 403 });
  } });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(service.sendText(input), error => {
      assert.equal(error.statusCode, 403);
      assert.doesNotMatch(error.message, /private/);
      return true;
    });
  }
  assert.equal(calls.writes.length, 1);
});

test('missing or mismatched server receipts cannot fabricate submitted state', async () => {
  for (const receipt of [null, {}, { requestId, state: 'submitted', itemId: null },
    { ...submitted, requestId: 'other' }, { ...submitted, itemId: requestId },
    { ...submitted, state: 'uncertain' }]) {
    const { service } = fakeService({ send: () => receipt });
    assert.deepEqual(await service.sendText(input), { requestId, state: 'uncertain', itemId: null });
  }
});

test('a full request ledger fails before writing instead of evicting uncertain request IDs', async () => {
  const { service, calls } = fakeService();
  for (let index = 0; index < 4096; index++) service.sendRequests.set(`reserved-${index}`, {});
  await assert.rejects(service.sendText(input), error => error.statusCode === 503);
  assert.equal(calls.created, 0);
});

test('the official POST uses the verified room, content.text and matching idempotency UUID with retry disabled', async () => {
  const requests = [];
  const { client } = desktopWithApi({
    async safeGet(path, options) {
      assert.equal(path, '/tbo/primary');
      assert.equal(options.retry, false);
      return primary();
    },
    async safePost(path, options) {
      requests.push({ path, options });
      return { id: 'server-message', room_id: input.roomId, request_id: requestId };
    }
  });
  assert.deepEqual(await client.sendText(input), submitted);
  assert.equal(requests.length, 1);
  const { path, options } = requests[0];
  assert.equal(path, '/messaging/rooms/{room_id}/messages');
  assert.deepEqual(options.parameters, { path: { room_id: input.roomId } });
  assert.deepEqual(options.requestBody, { content: { text: input.text }, request_id: requestId,
    idempotency_token: requestId, timezone_offset_min: new Date().getTimezoneOffset() });
  assert.equal(options.retry, false);
  assert.ok(options.signal instanceof AbortSignal);
});

test('a changed or inactive primary during the write evaluation causes no POST', async () => {
  for (const change of [{ id: 'other' }, { messaging_room_id: 'other' },
    { status: 'inactive' }, { aeon_kind: 'different-kind' }]) {
    let writes = 0;
    const { client } = desktopWithApi({
      async safeGet() { return primary(change); },
      async safePost() { writes++; return { id: 'forbidden' }; }
    });
    await assert.rejects(client.sendText(input), error => error.statusCode === 409);
    assert.equal(writes, 0);
  }
});

test('only the official server message id confirms a desktop submission', async () => {
  for (const message of [null, {}, { id: '' }, { id: ' ' }, { id: 123 },
    { id: 'm', room_id: 'other-room' }, { id: 'm', request_id: 'other-request' }]) {
    const { client } = desktopWithApi({ async safeGet() { return primary(); }, async safePost() { return message; } });
    assert.deepEqual(await client.sendText(input), { requestId, state: 'uncertain', itemId: null });
  }
});

test('desktop input validation does not connect or evaluate a write', async () => {
  const { client, calls } = desktopWithApi({});
  await assert.rejects(client.sendText({ ...input, text: '  ' }), error => error.statusCode === 400);
  assert.equal(calls.connected, 0);
  assert.equal(calls.evaluated, 0);
});

test('POST messages parses the request body and returns the normalized receipt', async () => {
  const { service, calls } = fakeService();
  const response = responseCapture();
  const request = Readable.from([Buffer.from(JSON.stringify(input))]);
  request.method = 'POST';
  assert.equal(await handleCompanionRoute({ request, response, url: '/companion/messages', service }), true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, submitted);
  assert.deepEqual(calls.writes, [input]);
});

test('malformed, oversized and non-object POST bodies cannot write messages', async () => {
  for (const [body, expectedStatus] of [['{', 400], ['[]', 400], ['null', 400],
    ['"text"', 400], [JSON.stringify({ ...input, text: 'a'.repeat(140000) }), 413]]) {
    const { service, calls } = fakeService();
    const response = responseCapture();
    const request = Readable.from([Buffer.from(body)]);
    request.method = 'POST';
    await handleCompanionRoute({ request, response, url: '/companion/messages', service });
    assert.equal(response.statusCode, expectedStatus);
    assert.equal(calls.writes.length, 0);
  }
});

test('the POST route returns identity conflict before sending and safely represents uncertainty', async () => {
  for (const [options, status, expected] of [
    [{ discovered: { id: 'other', roomId: input.roomId } }, 409, { error: 'The personal assistant changed; refresh the conversation' }],
    [{ send() { throw new Error('private timeout'); } }, 200, { requestId, state: 'uncertain', itemId: null }]
  ]) {
    const { service } = fakeService(options);
    const response = responseCapture();
    const request = Readable.from([Buffer.from(JSON.stringify(input))]);
    request.method = 'POST';
    await handleCompanionRoute({ request, response, url: '/companion/messages', service });
    assert.equal(response.statusCode, status);
    assert.deepEqual(response.payload, expected);
  }
});

test('missing safePost is a deterministic compatibility failure through desktop, service and HTTP', async () => {
  let reads = 0;
  const { client } = desktopWithApi({ async safeGet() { reads++; return primary(); } });
  const service = new CompanionConversationService({ clientFactory: () => client });
  const response = responseCapture();
  const request = Readable.from([Buffer.from(JSON.stringify(input))]);
  request.method = 'POST';
  await handleCompanionRoute({ request, response, url: '/companion/messages', service });
  assert.equal(response.statusCode, 422);
  assert.deepEqual(response.payload, { error: 'Companion request failed', failureClass: 'api_compatibility' });
  await assert.rejects(service.sendText(input), error => error.failureClass === 'api_compatibility');
  assert.equal(reads, 1, 'unsupported write capability is detected before write-time identity reads');
});

test('known HTTP rejection preserves its fixed auth classification through the POST route', async () => {
  const { service } = fakeService({ send() {
    throw Object.assign(new Error('private rejection'), { status: 403 });
  } });
  const request = Readable.from([Buffer.from(JSON.stringify(input))]);
  request.method = 'POST';
  const response = responseCapture();
  await handleCompanionRoute({ request, response, url: '/companion/messages', service });
  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.payload, { error: 'Companion request failed', failureClass: 'auth' });
});

test('verified official request identity resolves an uncertain receipt without another POST', async () => {
  let writes = 0;
  let entries = [];
  const service = new CompanionConversationService({ clientFactory: () => ({
    async discover() { return { id: input.profileId, roomId: input.roomId }; },
    async sendText() { writes++; throw new Error('response lost after acceptance'); },
    async messages() { return { entries, nextCursor: null }; },
    close() {}
  }) });
  assert.equal((await service.sendText(input)).state, 'uncertain');
  entries = historyEntries([{ id: 'server-message', request_id: requestId.toUpperCase(),
    role: 'user', created_at: '2026-10-19T00:00:00Z', content: { text: input.text } }]);
  const page = await service.getMessages(input);
  assert.equal(page.entries[0].requestId, requestId);
  assert.deepEqual(await service.sendText(input), submitted);
  assert.equal(writes, 1);
});

test('historical text similarity, wrong author, wrong content or invalid identity cannot resolve uncertainty', async () => {
  let entries = [];
  let writes = 0;
  const service = new CompanionConversationService({ clientFactory: () => ({
    async discover() { return { id: input.profileId, roomId: input.roomId }; },
    async sendText() { writes++; return { requestId, state: 'uncertain', itemId: null }; },
    async messages() { return { entries }; },
    close() {}
  }) });
  await service.sendText(input);
  for (const change of [{ requestId: undefined }, { requestId: 'invalid' }, { role: 'assistant' },
    { text: input.text + 'different' }, { itemId: 'room:' }]) {
    entries = [{ ...submitted, role: 'user', text: input.text, final: true, ...change }];
    await service.getMessages(input);
    assert.equal((await service.sendText(input)).state, 'uncertain');
  }
  assert.equal(writes, 1);
});

test('module discovery incompatibility remains deterministic before any text write', async () => {
  let writes = 0;
  const service = new CompanionConversationService({ clientFactory: () => ({
    async discover() { throw Object.assign(new Error('private loader detail'), { failureClass: 'api_compatibility' }); },
    async sendText() { writes++; },
    close() {}
  }) });
  await assert.rejects(service.sendText(input), error => error.statusCode === 422
    && error.failureClass === 'api_compatibility' && !error.message.includes('private'));
  assert.equal(writes, 0);
});

test('official history observed before a lost send response confirms the pending receipt', async () => {
  const gate = Promise.withResolvers();
  let writes = 0;
  const service = new CompanionConversationService({ clientFactory: () => ({
    async discover() { return { id: input.profileId, roomId: input.roomId }; },
    async sendText() { writes++; return gate.promise; },
    async messages() { return { entries: [{ itemId: submitted.itemId, requestId,
      role: 'user', text: input.text, final: true }] }; },
    close() {}
  }) });
  const pending = service.sendText(input);
  await new Promise(resolve => setImmediate(resolve));
  await service.getMessages(input);
  gate.reject(new Error('response lost'));
  assert.deepEqual(await pending, submitted);
  assert.deepEqual(await service.sendText(input), submitted);
  assert.equal(writes, 1);
});

test('matching request IDs in another verified room cannot confirm this room receipt', async () => {
  let roomId = input.roomId;
  const service = new CompanionConversationService({ clientFactory: () => ({
    async discover() { return { id: input.profileId, roomId }; },
    async sendText() { return { requestId, state: 'uncertain', itemId: null }; },
    async messages() { return { entries: [{ itemId: submitted.itemId, requestId,
      role: 'user', text: input.text, final: true }] }; },
    close() {}
  }) });
  await service.sendText(input);
  roomId = 'another-official-room';
  await service.getMessages({ ...input, roomId });
  assert.equal((await service.sendText(input)).state, 'uncertain');
});

test('official rows without a valid original message ID never create a submitted receipt', async () => {
  const entries = historyEntries([undefined, null, '', ' ', 123, {}, 'a'.repeat(513)].map(id => ({
    id, request_id: requestId, role: 'user', content: { text: input.text }
  })));
  const service = new CompanionConversationService({ clientFactory: () => ({
    async discover() { return { id: input.profileId, roomId: input.roomId }; },
    async sendText() { return { requestId, state: 'uncertain', itemId: null }; },
    async messages() { return { entries }; },
    close() {}
  }) });
  await service.sendText(input);
  await service.getMessages(input);
  assert.equal((await service.sendText(input)).state, 'uncertain');
  assert.deepEqual(entries, []);
});
