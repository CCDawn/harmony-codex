import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createMobileControlServer } from '../src/mobileControlServer.js';

const verification = { bridge: true, sessions: true, targetSession: true, desktopRequired: true, desktop: true };
const body = (requestId = 'request-0001', extra = {}) => ({ requestId, mode: 'auto', sessionId: 'session-1', confirmHardRestart: false, ...extra });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, executeRepair, options = {}) {
  const stateDir = options.stateDir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-control-'));
  const control = createMobileControlServer({ targetId: 'target-one', stateDir, executeRepair,
    authorize: async ({ request }) => { request.codexAuth = request.headers['x-device']
      ? { kind: 'device', deviceId: request.headers['x-device'] } : { kind: 'master' }; }, ...options });
  control.server.listen(0, '127.0.0.1');
  await once(control.server, 'listening');
  t.after(async () => { await control.close(); if (!options.stateDir) await fs.rm(stateDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${control.server.address().port}/control/v1/targets/target-one`;
  const post = async (data, headers = {}) => fetch(`${base}/repairs`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) });
  return { ...control, base, post, stateDir };
}

async function finished(base, id) {
  for (let n = 0; n < 100; n++) {
    const result = await (await fetch(`${base}/repairs/${id}`)).json();
    if (!['queued', 'running'].includes(result.job.status)) return result.job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('job did not finish');
}

test('jobs are asynchronous, idempotent, owner-scoped, busy-safe and durable', async (t) => {
  const release = deferred(); let calls = 0;
  const f = await fixture(t, async (_job, report) => { calls++; await report({ phase: 'connecting_desktop', message: 'SECRET' }); await release.promise; return { ok: true, verification }; });
  t.after(() => release.resolve());
  const first = await f.post(body(), { 'x-device': 'device-a' }); assert.equal(first.status, 202);
  const { job } = await first.json(); assert.match(job.id, /^[a-f0-9]{32}$/);
  assert.equal((await (await f.post(body(), { 'x-device': 'device-a' })).json()).job.id, job.id);
  assert.equal((await (await f.post(body('request-0002'), { 'x-device': 'device-a' })).json()).job.id, job.id);
  assert.equal((await f.post(body('request-0001', { sessionId: 'different' }), { 'x-device': 'device-a' })).status, 409);
  assert.equal((await f.post(body('request-0001', { confirmHardRestart: true }), { 'x-device': 'device-a' })).status, 409);
  assert.equal((await f.post(body('request-0003'), { 'x-device': 'device-b' })).status, 409);
  assert.equal((await fetch(`${f.base}/repairs/${job.id}`, { headers: { 'x-device': 'device-b' } })).status, 404);
  assert.equal((await (await fetch(`${f.base}/status`, { headers: { 'x-device': 'device-b' } })).json()).activeJob, null);
  release.resolve(); const done = await finished(f.base, job.id);
  assert.equal(done.status, 'succeeded'); assert.equal(calls, 1);
  assert.equal((await (await f.post(body('request-0002'), { 'x-device': 'device-a' })).json()).job.id, job.id);
  const state = await fs.readFile(path.join(f.stateDir, 'mobile-control-jobs.json'), 'utf8');
  assert.doesNotMatch(state, /SECRET|x-device|authorization/);
});

test('validation, missing authorization and target matching fail closed', async (t) => {
  const executed = [];
  const f = await fixture(t, async (job) => { executed.push(job); return { ok: true, verification }; });
  assert.equal((await f.post(body('bad'))).status, 400);
  assert.equal((await f.post(body('request-hard', { mode: 'hard' }))).status, 409);
  assert.equal((await f.post(body('request-long', { sessionId: 'x'.repeat(8200) }))).status, 413);
  const hard = await f.post(body('request-confirmed', { mode: 'hard', confirmHardRestart: true }));
  assert.equal(hard.status, 202); assert.equal((await finished(f.base, (await hard.json()).job.id)).status, 'succeeded');
  assert.equal(executed.length, 1); assert.equal(executed[0].confirmHardRestart, true);
  assert.equal((await fetch(f.base.replace('target-one', 'target-two') + '/status')).status, 404);
  const noAuth = await fixture(t, async () => ({ ok: true, verification }), { authorize: async () => {} });
  assert.equal((await fetch(`${noAuth.base}/status`)).status, 401);
  assert.throws(() => createMobileControlServer({ targetId: 'x', stateDir: f.stateDir, executeRepair() {} }), /authorize/);
});

test('raw target paths cannot be normalized or encoded into another target', async (t) => {
  const f = await fixture(t, async () => ({ ok: true, verification }));
  const origin = new URL(f.base);
  for (const rawPath of ['/control/v1/targets/other/../target-one/status', '/control/v1/targets/target%2Done/status',
    '/control/v1/targets/other%2F..%2Ftarget-one/status', '/control/v1/targets/target-one/./status',
    '/control/v1/targets/target-one/repairs/../status']) {
    const response = await new Promise((resolve, reject) => {
      const req = http.get({ host: origin.hostname, port: origin.port, path: rawPath }, (res) => { res.resume(); resolve(res); }); req.on('error', reject);
    });
    assert.equal(response.statusCode, 404, rawPath); assert.equal(response.headers.connection, 'close');
  }
});

test('simultaneous admissions serialize to one repair', async (t) => {
  const release = deferred(); let calls = 0;
  const f = await fixture(t, async () => { calls++; await release.promise; return { ok: true, verification }; });
  t.after(() => release.resolve());
  const responses = await Promise.all(Array.from({ length: 6 }, (_, n) => f.post(body(`concurrent-${n}`))));
  assert.ok(responses.every((result) => result.status === 202));
  const results = await Promise.all(responses.map((result) => result.json()));
  assert.equal(new Set(results.map((result) => result.job.id)).size, 1);
  release.resolve(); await finished(f.base, results[0].job.id); assert.equal(calls, 1);
});

test('status recovers the latest completed job while keeping device history private', async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return { ok: true, verification }; });
  const status = async (deviceId) => (await fetch(`${f.base}/status`, {
    headers: deviceId ? { 'x-device': deviceId } : {}
  })).json();
  assert.equal((await status('device-a')).lastJob, null);
  const first = (await (await f.post(body('history-device-a'), { 'x-device': 'device-a' })).json()).job;
  await finished(f.base, first.id);
  const afterCompletion = await status('device-a');
  assert.equal(afterCompletion.activeJob, null);
  assert.equal(afterCompletion.lastJob.id, first.id);
  assert.equal(afterCompletion.lastJob.status, 'succeeded');
  assert.equal((await status('device-b')).lastJob, null);
  const second = (await (await f.post(body('history-device-b'), { 'x-device': 'device-b' })).json()).job;
  await finished(f.base, second.id);
  assert.equal((await status('device-a')).lastJob.id, first.id);
  assert.equal((await status('device-b')).lastJob.id, second.id);
  assert.equal((await status()).lastJob.id, second.id, 'master retains access to all device jobs');
  assert.equal(calls, 2, 'reading completed status never resumes or creates a repair');
});

test('every verification field is required and desktop opt-out must be explicit', async (t) => {
  const candidates = [{ desktop: true }, { ...verification, bridge: false }, { ...verification, sessions: false },
    { ...verification, targetSession: false }, { ...verification, desktop: false },
    { bridge: true, sessions: true, targetSession: true, desktop: false },
    { ...verification, desktopRequired: false, desktop: false }];
  let index = 0; const f = await fixture(t, async () => ({ ok: true, verification: candidates[index++] }));
  for (let n = 0; n < candidates.length; n++) {
    const { job } = await (await f.post(body(`verification-${n}`))).json();
    assert.equal((await finished(f.base, job.id)).status, n === candidates.length - 1 ? 'succeeded' : 'failed');
  }
});

test('success requires every required path and errors and reports are sanitized', async (t) => {
  let n = 0;
  const f = await fixture(t, async (_job, report) => {
    await report({ phase: 'SECRET_PHASE', verification: { desktop: true, secret: 'PRIVATE' } });
    if (++n === 1) return { ok: true, verification: { desktop: true } };
    if (n === 2) throw new Error('TOKEN=PRIVATE');
    return { ok: false, requiresConfirmation: true, verification };
  });
  for (const [index, expected] of ['failed', 'failed', 'needs_confirmation'].entries()) {
    const { job } = await (await f.post(body(`request-${index}000`))).json();
    const done = await finished(f.base, job.id); assert.equal(done.status, expected);
    assert.doesNotMatch(JSON.stringify(done), /SECRET|PRIVATE|TOKEN/);
  }
});

test('disconnecting the HTTP client does not cancel the admitted repair', async (t) => {
  const admitted = deferred(); const release = deferred();
  const f = await fixture(t, async () => { admitted.resolve(); await release.promise; return { ok: true, verification }; });
  t.after(() => release.resolve());
  const request = http.request(`${f.base}/repairs`, { method: 'POST', headers: { 'content-type': 'application/json' } });
  request.on('error', () => {}); request.end(JSON.stringify(body()));
  await admitted.promise; request.destroy(); release.resolve();
  const status = await (await fetch(`${f.base}/status`)).json();
  const state = JSON.parse(await fs.readFile(path.join(f.stateDir, 'mobile-control-jobs.json'), 'utf8'));
  const id = status.activeJob?.id ?? state.jobs[0].job.id;
  assert.equal((await finished(f.base, id)).status, 'succeeded');
});

test('restart marks an interrupted job failed and never repeats it', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-control-restart-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const id = 'a'.repeat(32); const at = new Date().toISOString();
  await fs.writeFile(path.join(dir, 'mobile-control-jobs.json'), JSON.stringify({ version: 1, targetId: 'target-one',
    jobs: [{ owner: 'master', job: { version: 1, id, ...body(), status: 'running', phase: 'restarting_desktop', message: '正在重启桌面', createdAt: at, updatedAt: at, completedAt: null } }],
    requests: [{ owner: 'master', ...body(), jobId: id }] }));
  let calls = 0; const f = await fixture(t, async () => { calls++; }, { stateDir: dir });
  const result = await (await f.post(body())).json();
  assert.equal(result.job.status, 'failed'); assert.match(result.job.message, /未确认/); assert.equal(calls, 0);
});

test('durable history keeps at most 200 jobs and evicts their idempotency mappings together', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-control-limit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const at = new Date().toISOString(); const entries = Array.from({ length: 200 }, (_, n) => {
    const input = body(`history-${String(n).padStart(4, '0')}`);
    return { owner: 'master', job: { version: 1, id: n.toString(16).padStart(32, '0'), requestId: input.requestId, mode: input.mode,
      sessionId: input.sessionId, status: 'succeeded', phase: 'verifying', message: '', createdAt: at, updatedAt: at, completedAt: at } };
  });
  await fs.writeFile(path.join(dir, 'mobile-control-jobs.json'), JSON.stringify({ version: 1, targetId: 'target-one', jobs: entries,
    requests: entries.map(({ owner, job }) => ({ owner, ...body(job.requestId), jobId: job.id })) }));
  const f = await fixture(t, async () => ({ ok: true, verification }), { stateDir: dir });
  const { job } = await (await f.post(body())).json(); await finished(f.base, job.id);
  const state = JSON.parse(await fs.readFile(path.join(dir, 'mobile-control-jobs.json'), 'utf8'));
  assert.equal(state.jobs.length, 200); assert.equal(state.requests.length, 200);
  assert.equal(state.requests.some((item) => item.jobId === entries[0].job.id), false);
  assert.equal((await fetch(`${f.base}/repairs/${entries[0].job.id}`)).status, 404);
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(dir, 'mobile-control-jobs.json'))).mode & 0o777, 0o600);
});

test('reaching the idempotency map limit preserves existing completed results', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-control-map-limit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const id = 'b'.repeat(32); const at = new Date().toISOString();
  const job = { version: 1, id, requestId: 'retained-0000', mode: 'auto', sessionId: 'session-1', status: 'succeeded',
    phase: 'verifying', message: '', createdAt: at, updatedAt: at, completedAt: at, verification };
  const requests = Array.from({ length: 2000 }, (_, n) => ({ owner: 'master',
    ...body(`retained-${String(n).padStart(4, '0')}`), jobId: id }));
  await fs.writeFile(path.join(dir, 'mobile-control-jobs.json'), JSON.stringify({
    version: 1, targetId: 'target-one', jobs: [{ owner: 'master', job }], requests
  }));
  let calls = 0; const f = await fixture(t, async () => { calls++; }, { stateDir: dir });
  assert.equal((await f.post(body('new-over-limit'))).status, 409);
  const replay = await f.post(body('retained-0000'));
  assert.equal(replay.status, 202); assert.equal((await replay.json()).job.status, 'succeeded');
  const status = await (await fetch(`${f.base}/status`)).json();
  assert.equal(status.activeJob, null); assert.equal(status.lastJob.id, id);
  assert.equal((await (await fetch(`${f.base}/repairs/${id}`)).json()).job.status, 'succeeded');
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'mobile-control-jobs.json'), 'utf8'));
  assert.equal(saved.jobs.length, 1); assert.equal(saved.requests.length, 2000); assert.equal(calls, 0);
});
