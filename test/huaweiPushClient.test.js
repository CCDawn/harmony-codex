import assert from 'node:assert/strict';
import { constants, generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';
import { HuaweiPushClient } from '../src/huaweiPushClient.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
});
const serviceAccount = {
  project_id: 'sample-project-123', key_id: 'sample-key-id', private_key: privateKey,
  sub_account: 'sample-sub-account', token_uri: 'https://oauth-login.cloud.huawei.com/oauth2/v3/token'
};
const event = {
  threadId: '12345678-1234-4234-8234-123456789abc', turnId: 'official-turn',
  type: 'completed', eventId: 'a'.repeat(64)
};
const success = () => ({ ok: true, status: 200, json: async () => ({ code: '80000000', requestId: 'request-123', msg: 'Success' }) });

test('send uses the direct PS256 JWT with a complete PEM, official audience and one-hour lifetime', async () => {
  const requests = [];
  const client = new HuaweiPushClient({ serviceAccount, now: () => 1_700_000_000_999,
    fetchImpl: async (...args) => { requests.push(args); return success(); } });
  const result = await client.send({ token: 'private-push-token', event });
  assert.deepEqual(result, { accepted: true, code: '80000000' });
  assert.equal(requests.length, 1, 'no OAuth token exchange request is made');
  const [url, request] = requests[0];
  assert.equal(url, 'https://push-api.cloud.huawei.com/v3/sample-project-123/messages:send');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['push-type'], '0');
  assert.equal(request.headers['Content-Type'], 'application/json');
  const jwt = request.headers.Authorization.replace(/^Bearer /, '');
  const [header, payload, signature] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'PS256', typ: 'JWT', kid: serviceAccount.key_id });
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), {
    iss: serviceAccount.sub_account, aud: serviceAccount.token_uri, iat: 1_700_000_000, exp: 1_700_003_600
  });
  assert.equal(verify('sha256', Buffer.from(`${header}.${payload}`), {
    key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32
  }, Buffer.from(signature, 'base64url')), true);
  assert.equal(JSON.stringify(client).includes('PRIVATE KEY'), false);
  assert.equal(JSON.stringify(client).includes(serviceAccount.sub_account), false);
});

test('notification uses fixed status copy and only four safe click-routing keys', async () => {
  let body;
  const client = new HuaweiPushClient({ serviceAccount, fetchImpl: async (_url, options) => {
    body = JSON.parse(options.body); return success();
  } });
  await client.send({ token: 'private-push-token', event: {
    ...event, text: 'PRIVATE_CHAT_TEXT', command: 'PRIVATE_COMMAND', question: 'PRIVATE_QUESTION', answer: 'PRIVATE_ANSWER'
  } });
  assert.deepEqual(body.target, { token: ['private-push-token'] });
  assert.deepEqual(body.pushOptions, { testMessage: true, ttl: 86400 });
  const notification = body.payload.notification;
  assert.equal(notification.foregroundShow, false);
  assert.equal(notification.category, 'WORK');
  assert.equal(notification.appMessageId, event.eventId);
  assert.equal(notification.clickAction.actionType, 0);
  assert.deepEqual(notification.clickAction.data, {
    codexRemoteNotificationSessionId: event.threadId, codexRemoteNotificationEventType: event.type,
    codexRemoteNotificationEventId: event.eventId, codexRemoteNotificationRevision: event.eventId
  });
  assert.equal(typeof notification.title, 'string');
  assert.equal(typeof notification.body, 'string');
  for (const value of ['PRIVATE_CHAT_TEXT', 'PRIVATE_COMMAND', 'PRIVATE_QUESTION', 'PRIVATE_ANSWER', event.turnId]) {
    assert.equal(JSON.stringify(body).includes(value), false);
  }
});

test('all supported status types have fixed copy and configured category/test mode', async () => {
  const copies = new Set();
  const client = new HuaweiPushClient({ serviceAccount, category: 'CUSTOM', testMessage: false,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.payload.notification.category, 'CUSTOM');
      assert.equal(body.pushOptions.testMessage, false);
      copies.add(body.payload.notification.body);
      return success();
    } });
  for (const type of ['completed', 'failed', 'user_input_required', 'approval_required']) {
    await client.send({ token: 'sample-token', event: { ...event, type } });
  }
  assert.equal(copies.size, 4);
});

test('only HTTP success with official full-success code is accepted', async () => {
  for (const [status, code, uncertain] of [[200, '80100000', true], [200, '80300002', false],
    [200, '80300007', false], [200, '80200005', false], [503, '80000000', true], [401, '80200005', false]]) {
    const client = new HuaweiPushClient({ serviceAccount, fetchImpl: async () => ({ status, ok: status < 300,
      json: async () => ({ code, msg: 'private-token-and-illegalTokens', requestId: 'safe-request' }) }) });
    await assert.rejects(client.send({ token: 'private-token', event }), error => {
      assert.equal(error.deliveryUncertain, uncertain);
      assert.equal(error.message.includes('private-token'), false);
      assert.equal(JSON.stringify(error).includes('illegalTokens'), false);
      assert.equal(error.retryable, false);
      assert.equal(error.statusCode, 502);
      return true;
    });
  }
});

test('lost, malformed and unknown responses stay uncertain without exposing underlying secrets', async () => {
  const responses = [
    async () => { throw new Error(`private-push-token ${privateKey}`); },
    async () => ({ status: 200, ok: true, json: async () => { throw new Error('private-push-token'); } }),
    async () => ({ status: 200, ok: true, json: async () => ({ code: 'private-push-token', msg: privateKey }) }),
    async () => ({ status: 200, ok: true, json: async () => ({ code: '80000000', requestId: 'private-push-token' }) })
  ];
  for (const fetchImpl of responses.slice(0, -1)) {
    const client = new HuaweiPushClient({ serviceAccount, fetchImpl });
    await assert.rejects(client.send({ token: 'private-push-token', event }), error => {
      assert.equal(error.deliveryUncertain, true);
      assert.equal(error.retryable, false);
      assert.equal(`${error.stack} ${JSON.stringify(error)}`.includes('private-push-token'), false);
      assert.equal(`${error.stack} ${JSON.stringify(error)}`.includes('PRIVATE KEY'), false);
      return true;
    });
  }
  const client = new HuaweiPushClient({ serviceAccount, fetchImpl: responses.at(-1) });
  assert.deepEqual(await client.send({ token: 'private-push-token', event }), { accepted: true, code: '80000000' });
});

test('invalid input and key material fail safely before network access', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return success(); };
  for (const account of [undefined, {}, { ...serviceAccount, private_key: 'PRIVATE_BROKEN_KEY' },
    { ...serviceAccount, project_id: '../private-project' }]) {
    assert.throws(() => new HuaweiPushClient({ serviceAccount: account, fetchImpl }), error => {
      assert.equal(error.message.includes('PRIVATE_BROKEN_KEY'), false);
      return true;
    });
  }
  const client = new HuaweiPushClient({ serviceAccount, fetchImpl });
  for (const input of [{ token: '', event }, { token: 'private\nvalue', event }, { token: 's'.repeat(8193), event },
    { token: 'sample', event: { ...event, type: 'interrupted' } },
    { token: 'sample', event: { ...event, turnId: '' } },
    { token: 'sample', event: { ...event, threadId: '' } },
    { token: 'sample', event: { ...event, eventId: 'a'.repeat(65) } }]) {
    await assert.rejects(client.send(input), { statusCode: 400 });
  }
  assert.equal(calls, 0);
});
