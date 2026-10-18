import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyCompanionError, companionRpcErrorFields, makeCompanionError } from '../src/companionErrors.js';

test('Companion failures use stable categories for HTTP, timeout, CDP, and unknown errors', () => {
  assert.equal(classifyCompanionError(Object.assign(new Error('ignored response body'), { status: 502 })), 'http_error');
  assert.equal(classifyCompanionError(Object.assign(new Error('private URL and SDP omitted'), { name: 'TimeoutError' })), 'timeout');
  assert.equal(classifyCompanionError(new Error('Codex 桌面 CDP 请求超时：Runtime.evaluate')), 'timeout');
  assert.equal(classifyCompanionError(new Error('Codex 桌面 CDP 连接已关闭')), 'cdp_connection');
  assert.equal(classifyCompanionError(Object.assign(new Error('socket refused'), { code: 'ECONNREFUSED' })), 'cdp_connection');
  assert.equal(classifyCompanionError(new Error('unrecognized private failure')), 'unknown_error');
});

test('RPC diagnostics preserve the legacy error field while excluding raw error data', () => {
  const raw = Object.assign(new Error('secret body https://private.invalid SDP=abc token=xyz'), { status: 502 });
  const fields = companionRpcErrorFields(raw, 'start');
  assert.deepEqual(fields, {
    error: 'Companion HTTP 502',
    errorCode: 'http_error',
    operation: 'start',
    stage: 'create',
    status: 502
  });
  assert.doesNotMatch(JSON.stringify(fields), /secret|private\.invalid|SDP|token=xyz/);
});

test('RPC operation and stage fields are strict whitelists', () => {
  const raw = Object.assign(new Error('private'), { stage: 'token=secret', operation: 'https://private.invalid' });
  const fields = companionRpcErrorFields(raw, 'not-an-operation');
  assert.deepEqual(fields, {
    error: 'Companion request failed',
    errorCode: 'unknown_error',
    operation: 'unknown',
    stage: 'unknown'
  });
  const start = Object.assign(new Error('private'), { errorCode: 'timeout', stage: 'discover' });
  assert.deepEqual(companionRpcErrorFields(start, 'start'), {
    error: 'Companion request failed',
    errorCode: 'timeout',
    operation: 'start',
    stage: 'discover'
  });
});

test('normalized errors contain no original message or cause', () => {
  const raw = new Error('raw SDP and access token');
  const safe = makeCompanionError(raw, { stage: 'attach' });
  assert.equal(safe.message, 'Companion request failed');
  assert.equal(safe.errorCode, 'unknown_error');
  assert.equal(safe.stage, 'attach');
  assert.equal(safe.cause, undefined);
  assert.doesNotMatch(JSON.stringify(safe), /raw SDP|access token/);
});
