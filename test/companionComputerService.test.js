import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import {
  CompanionComputerService,
  handleCompanionComputerRoute,
  MAX_COMPUTER_SDP_BYTES
} from '../src/companionComputerService.js';

const OFFER_SDP = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
const ANSWER_SDP = 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';

function validSnapshot(overrides = {}) {
  return {
    profile: {
      id: 'assistant-1',
      roomId: 'room-1',
      status: 'active',
      aeonKind: 'orbit',
      activeRootThreadId: 'thread-1'
    },
    selection: { aeonId: 'assistant-1', threadId: 'thread-1' },
    environment: {
      environmentId: 'environment-1',
      status: 'ready',
      ready: true
    },
    ...overrides
  };
}

function fakeDesktopClient({ snapshots = [validSnapshot()], answerSdp = ANSWER_SDP } = {}) {
  const calls = [];
  let primaryReads = 0;
  return {
    calls,
    get primaryReads() { return primaryReads; },
    async invoke(source, params, timeoutMs) {
      calls.push({ source, params, timeoutMs });
      if (source.includes("api.safeGet('/tbo/primary'")) {
        const index = Math.min(primaryReads, snapshots.length - 1);
        primaryReads += 1;
        return structuredClone(snapshots[index]);
      }
      if (source.includes("api.postResponse('/tbo/{tbo_id}/computer/sessions'")) {
        return { sdp: answerSdp };
      }
      throw new Error('Unexpected desktop operation');
    }
  };
}

function requestedIdentity(overrides = {}) {
  return {
    assistantId: 'assistant-1',
    roomId: 'room-1',
    threadId: 'thread-1',
    environmentId: 'environment-1',
    sdp: OFFER_SDP,
    ...overrides
  };
}

function responseCapture() {
  return {
    statusCode: null,
    headers: null,
    payload: null,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.payload = body ? JSON.parse(body) : null;
    }
  };
}

test('status re-reads the primary selection and computer environment on every request', async () => {
  const desktopClient = fakeDesktopClient({ snapshots: [
    validSnapshot(),
    validSnapshot({ environment: { environmentId: 'environment-2', status: 'starting', ready: false } })
  ] });
  const service = new CompanionComputerService({ desktopClient });

  assert.deepEqual(await service.getStatus({ assistantId: 'assistant-1', roomId: 'room-1' }), {
    assistantId: 'assistant-1',
    roomId: 'room-1',
    threadId: 'thread-1',
    environmentId: 'environment-1',
    status: 'ready',
    ready: true
  });
  assert.deepEqual(await service.getStatus({ assistantId: 'assistant-1', roomId: 'room-1' }), {
    assistantId: 'assistant-1',
    roomId: 'room-1',
    threadId: 'thread-1',
    environmentId: 'environment-2',
    status: 'starting',
    ready: false
  });

  assert.equal(desktopClient.primaryReads, 2);
  assert.ok(desktopClient.calls.every(call => call.source.includes('/tbo/{tbo_id}/environment/status')));
});

test('computer session validates the fresh identity and returns only the SDP and bound ids', async () => {
  const desktopClient = fakeDesktopClient();
  const service = new CompanionComputerService({ desktopClient });

  assert.deepEqual(await service.createSession(requestedIdentity()), {
    sdp: ANSWER_SDP,
    assistantId: 'assistant-1',
    roomId: 'room-1',
    threadId: 'thread-1',
    environmentId: 'environment-1'
  });

  assert.equal(desktopClient.primaryReads, 2);
  const sessionCall = desktopClient.calls.find(call => call.source.includes('computer/sessions'));
  assert.ok(sessionCall);
  assert.match(sessionCall.source, /query:\s*\{\s*thread_id:\s*params\.threadId\s*\}/);
  assert.match(sessionCall.source, /requestBody:\s*params\.sdp/);
  assert.match(sessionCall.source, /contentType:\s*'application\/sdp'/);
  assert.equal(sessionCall.params.assistantId, 'assistant-1');
  assert.equal(sessionCall.params.threadId, 'thread-1');
  assert.equal(sessionCall.params.sdp, OFFER_SDP);
  assert.equal(desktopClient.calls.some(call => /thread\/start|recreate|takeover/i.test(call.source)), false);
});

test('a thread or environment switch during negotiation prevents returning the answer SDP', async (t) => {
  const switchedThread = validSnapshot({
    profile: { ...validSnapshot().profile, activeRootThreadId: 'thread-2' },
    selection: { aeonId: 'assistant-1', threadId: 'thread-2' }
  });
  const switchedEnvironment = validSnapshot({
    environment: { environmentId: 'environment-2', status: 'ready', ready: true }
  });

  for (const [name, current] of [['thread', switchedThread], ['environment', switchedEnvironment]]) {
    await t.test(name, async () => {
      const desktopClient = fakeDesktopClient({ snapshots: [validSnapshot(), current] });
      const service = new CompanionComputerService({ desktopClient });
      await assert.rejects(service.createSession(requestedIdentity()), error => error.statusCode === 409);
      assert.equal(desktopClient.primaryReads, 2);
      assert.equal(desktopClient.calls.filter(call => call.source.includes('computer/sessions')).length, 1);
    });
  }
});

test('session creation refuses identity or environment changes before calling computer sessions', async (t) => {
  const cases = [
    ['assistant id changed', validSnapshot(), { assistantId: 'assistant-other' }, 409],
    ['room id changed', validSnapshot(), { roomId: 'room-other' }, 409],
    ['thread id changed', validSnapshot(), { threadId: 'thread-other' }, 409],
    ['environment id changed', validSnapshot(), { environmentId: 'environment-other' }, 409],
    ['inactive profile', validSnapshot({ profile: { ...validSnapshot().profile, status: 'inactive' } }), {}, 409],
    ['wrong profile kind', validSnapshot({ profile: { ...validSnapshot().profile, aeonKind: 'chat' } }), {}, 409],
    ['selection belongs to another assistant', validSnapshot({ selection: { aeonId: 'assistant-other', threadId: 'thread-1' } }), {}, 409],
    ['selection differs from profile root thread', validSnapshot({ selection: { aeonId: 'assistant-1', threadId: 'thread-other' } }), {}, 409],
    ['remote desktop is not ready', validSnapshot({ environment: { environmentId: 'environment-1', status: 'starting', ready: false } }), {}, 503]
  ];

  for (const [name, snapshot, input, expectedStatus] of cases) {
    await t.test(name, async () => {
      const desktopClient = fakeDesktopClient({ snapshots: [snapshot] });
      const service = new CompanionComputerService({ desktopClient });
      await assert.rejects(service.createSession(requestedIdentity(input)), error => error.statusCode === expectedStatus);
      assert.equal(desktopClient.calls.some(call => call.source.includes('computer/sessions')), false);
    });
  }
});

test('oversized SDP is rejected before any desktop call', async () => {
  const desktopClient = fakeDesktopClient();
  const service = new CompanionComputerService({ desktopClient });
  const oversized = `v=0${'x'.repeat(MAX_COMPUTER_SDP_BYTES)}`;

  await assert.rejects(service.createSession(requestedIdentity({ sdp: oversized })), error => error.statusCode === 413);
  assert.equal(desktopClient.calls.length, 0);
});

test('status route validates query ids and returns the status contract', async () => {
  const response = responseCapture();
  const calls = [];
  const handled = await handleCompanionComputerRoute({
    request: { method: 'GET', url: '/' },
    response,
    url: 'http://127.0.0.1/companion/computer/status?assistantId=assistant-1&roomId=room-1',
    service: { async getStatus(input) { calls.push(input); return { ...input, threadId: 'thread-1', environmentId: 'environment-1', status: 'ready', ready: true }; } }
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, [{ assistantId: 'assistant-1', roomId: 'room-1' }]);
  assert.deepEqual(response.payload, {
    assistantId: 'assistant-1', roomId: 'room-1', threadId: 'thread-1',
    environmentId: 'environment-1', status: 'ready', ready: true
  });
});

test('session route parses JSON and never returns request SDP in error payloads', async () => {
  const response = responseCapture();
  const secretSdp = `v=0\r\n${'x'.repeat(MAX_COMPUTER_SDP_BYTES)}`;
  const body = JSON.stringify(requestedIdentity({ sdp: secretSdp }));
  let serviceCalls = 0;
  const request = Readable.from([Buffer.from(body)]);
  request.method = 'POST';
  request.url = '/companion/computer/sessions';

  const handled = await handleCompanionComputerRoute({
    request,
    response,
    url: `http://127.0.0.1${request.url}`,
    service: { async createSession() { serviceCalls += 1; throw Object.assign(new Error('private connector detail'), { statusCode: 413 }); } }
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 413);
  assert.equal(serviceCalls, 1);
  assert.doesNotMatch(JSON.stringify(response.payload), /private connector detail|v=0|xxxx/);
});

test('unknown computer paths fall through and known paths reject the wrong method', async () => {
  const ignoredResponse = responseCapture();
  assert.equal(await handleCompanionComputerRoute({
    request: { method: 'GET' }, response: ignoredResponse,
    url: 'http://127.0.0.1/companion/other', service: {}
  }), false);
  assert.equal(ignoredResponse.statusCode, null);

  const response = responseCapture();
  assert.equal(await handleCompanionComputerRoute({
    request: { method: 'DELETE' }, response,
    url: 'http://127.0.0.1/companion/computer/status', service: {}
  }), true);
  assert.equal(response.statusCode, 405);
});
