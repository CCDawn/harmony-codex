import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CompanionConversationService,
  handleCompanionRoute
} from '../src/companionConversationService.js';

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
      this.payload = JSON.parse(body);
    }
  };
}

function makeRequest(method = 'GET') {
  return { method, url: '/' };
}

test('each read creates a fresh desktop client and closes it in finally', async () => {
  const clients = [];
  const service = new CompanionConversationService({
    clientFactory() {
      const client = {
        closed: false,
        async profileDetails() {
          return { id: 'profile-1', name: '熊大', roomId: 'room-1', avatarUrl: 'https://cdn.example/avatar.png' };
        },
        async discover() {
          return { id: 'profile-1', name: '熊大', roomId: 'room-1' };
        },
        async messages(input) {
          this.messageInput = input;
          return { entries: [{ itemId: 'room:m1', role: 'user', text: '你好', final: true }], nextCursor: 'next-1' };
        },
        close() {
          this.closed = true;
        }
      };
      clients.push(client);
      return client;
    }
  });

  assert.deepEqual(await service.getProfile(), {
    profile: { id: 'profile-1', name: '熊大', roomId: 'room-1', avatarUrl: 'https://cdn.example/avatar.png' }
  });
  assert.deepEqual(await service.getMessages({ profileId: 'profile-1', roomId: 'room-1', before: 'cursor-1' }), {
    entries: [{ itemId: 'room:m1', role: 'user', text: '你好', final: true }],
    nextCursor: 'next-1'
  });

  assert.equal(clients.length, 2);
  assert.notEqual(clients[0], clients[1]);
  assert.ok(clients.every((client) => client.closed));
  assert.deepEqual(clients[1].messageInput, { before: 'cursor-1' });
});

test('a failed profile read still closes its short-lived client', async () => {
  let closed = false;
  const service = new CompanionConversationService({
    clientFactory: () => ({
      async profileDetails() {
        throw new Error('private connector detail');
      },
      close() {
        closed = true;
      }
    })
  });

  await assert.rejects(service.getProfile(), /private connector detail/);
  assert.equal(closed, true);
});

test('messages require an exact discovered profile and room before reading', async (t) => {
  for (const discovered of [
    { id: 'other-profile', roomId: 'room-1' },
    { id: 'profile-1', roomId: 'other-room' }
  ]) {
    await t.test(JSON.stringify(discovered), async () => {
      let messagesCalled = false;
      let closed = false;
      const service = new CompanionConversationService({
        clientFactory: () => ({
          async discover() { return discovered; },
          async messages() { messagesCalled = true; return { entries: [], nextCursor: null }; },
          close() { closed = true; }
        })
      });

      await assert.rejects(
        service.getMessages({ profileId: 'profile-1', roomId: 'room-1' }),
        (error) => error.statusCode === 409
      );
      assert.equal(messagesCalled, false);
      assert.equal(closed, true);
    });
  }
});

test('message parameters are validated before opening a client', async () => {
  let clientsCreated = 0;
  const service = new CompanionConversationService({
    clientFactory() {
      clientsCreated += 1;
      return { close() {} };
    }
  });

  await assert.rejects(service.getMessages({ roomId: 'room-1' }), (error) => error.statusCode === 400);
  await assert.rejects(service.getMessages({ profileId: 'profile-1' }), (error) => error.statusCode === 400);
  assert.equal(clientsCreated, 0);
});

test('profile route returns only verified profile metadata and rejects unsafe avatar schemes', async () => {
  const response = responseCapture();
  let closed = false;
  const service = new CompanionConversationService({
    clientFactory: () => ({
      async profileDetails() {
        return {
          id: 'profile-1', name: '熊大', roomId: 'room-1', avatarUrl: 'javascript:alert(1)',
          arbitrary: 'must not be returned'
        };
      },
      close() { closed = true; }
    })
  });

  const handled = await handleCompanionRoute({
    request: makeRequest(),
    response,
    url: new URL('http://127.0.0.1/companion/profile?avatarUrl=https%3A%2F%2Fevil.example%2Fx.png'),
    service
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, {
    profile: { id: 'profile-1', name: '熊大', roomId: 'room-1', avatarUrl: null }
  });
  assert.equal(closed, true);
});

test('GET messages passes the verified identifiers and optional cursor to the service', async () => {
  const response = responseCapture();
  const calls = [];
  const service = {
    async getMessages(input) {
      calls.push(input);
      return { entries: [{ itemId: 'room:m2', role: 'assistant', text: '回复', final: true }], nextCursor: 'cursor-2' };
    }
  };

  const handled = await handleCompanionRoute({
    request: makeRequest(),
    response,
    url: 'http://127.0.0.1/companion/messages?profileId=profile-1&roomId=room-1&before=cursor-1',
    service
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, [{ profileId: 'profile-1', roomId: 'room-1', before: 'cursor-1' }]);
  assert.deepEqual(response.payload, {
    entries: [{ itemId: 'room:m2', role: 'assistant', text: '回复', final: true }],
    nextCursor: 'cursor-2'
  });
});

test('missing or duplicate identifiers receive 400 without calling the service', async (t) => {
  for (const query of ['', '?profileId=profile-1', '?profileId=profile-1&roomId=',
    '?profileId=profile-1&profileId=profile-2&roomId=room-1']) {
    await t.test(query || '(empty query)', async () => {
      const response = responseCapture();
      let calls = 0;
      const handled = await handleCompanionRoute({
        request: makeRequest(),
        response,
        url: `http://127.0.0.1/companion/messages${query}`,
        service: { async getMessages() { calls += 1; return { entries: [], nextCursor: null }; } }
      });
      assert.equal(handled, true);
      assert.equal(response.statusCode, 400);
      assert.equal(calls, 0);
    });
  }
});

test('unmatched paths fall through; known non-GET paths return 405', async () => {
  const ignoredResponse = responseCapture();
  const ignored = await handleCompanionRoute({
    request: makeRequest(), response: ignoredResponse,
    url: 'http://127.0.0.1/other', service: {}
  });
  assert.equal(ignored, false);
  assert.equal(ignoredResponse.statusCode, null);

  const response = responseCapture();
  const handled = await handleCompanionRoute({
    request: makeRequest('POST'), response,
    url: 'http://127.0.0.1/companion/messages', service: {}
  });
  assert.equal(handled, true);
  assert.equal(response.statusCode, 405);
});
