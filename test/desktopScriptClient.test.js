import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDesktopScriptClient, nextRetryDelayMs } from '../src/desktopScriptClient.js';

test('desktop script client embeds bridge url and resolves token at runtime', () => {
  const script = buildDesktopScriptClient({
    bridgeUrl: 'http://127.0.0.1:8787/',
    authRequired: true
  });

  assert.match(script, /http:\/\/127\.0\.0\.1:8787/);
  assert.match(script, /X-Codex-Bridge-Token/);
  assert.match(script, /const authRequired = true;/);
  assert.match(script, /codex-hramony-bridge-token/);
  assert.match(script, /localStorage/);
  assert.match(script, /tokenPresent: Boolean\(bridgeToken\)/);
  assert.match(script, /sendMessageFromView/);
  assert.match(script, /desktop\/script\/poll/);
  assert.match(script, /codex-hramony-remote-status/);
  assert.match(script, /远程在线/);
  assert.match(script, /心跳重试/);
  assert.match(script, /dataset\.chrOwner/);
});

test('desktop script client body never contains a token value', () => {
  const script = buildDesktopScriptClient({
    bridgeUrl: 'http://127.0.0.1:8787/',
    authRequired: true,
    token: 'secret-token'
  });

  assert.doesNotMatch(script, /secret-token/);
});

test('desktop script client skips token resolution when auth is not required', () => {
  const script = buildDesktopScriptClient({
    bridgeUrl: 'http://127.0.0.1:8787/'
  });

  assert.match(script, /const authRequired = false;/);
  assert.match(script, /if \(!authRequired\) \{\s*return '';/);
});

test('desktop script client requires bridge url', () => {
  assert.throws(() => buildDesktopScriptClient(), /bridgeUrl is required/);
});

test('retry backoff grows exponentially from 2s and caps at 30s', () => {
  assert.equal(nextRetryDelayMs(1), 2000);
  assert.equal(nextRetryDelayMs(2), 4000);
  assert.equal(nextRetryDelayMs(3), 8000);
  assert.equal(nextRetryDelayMs(4), 16000);
  assert.equal(nextRetryDelayMs(5), 30000);
  assert.equal(nextRetryDelayMs(20), 30000);
  assert.equal(nextRetryDelayMs(0), 2000);
  assert.equal(nextRetryDelayMs(undefined), 2000);
});

test('retry backoff honors Retry-After without exceeding the cap', () => {
  assert.equal(nextRetryDelayMs(1, 10000), 10000);
  assert.equal(nextRetryDelayMs(1, 60000), 30000);
  assert.equal(nextRetryDelayMs(3, 0), 8000);
  assert.equal(nextRetryDelayMs(2, 500), 4000);
});

test('desktop script client retries connect with exponential backoff', () => {
  const script = buildDesktopScriptClient({
    bridgeUrl: 'http://127.0.0.1:8787',
    authRequired: true
  });

  assert.match(script, /const retryBackoffMs = 2000;/);
  assert.match(script, /const retryBackoffMaxMs = 30000;/);
  assert.match(script, /retryBackoffMs \* 2 \*\* Math\.max\(0, failures - 1\)/);
  assert.match(script, /retry-after/);
  assert.match(script, /connectFailures \+= 1/);
  assert.match(script, /connectLoop\(\)/);
  assert.match(script, /heartbeatFailures \+= 1/);
  assert.match(script, /pollFailures \+= 1/);
});
