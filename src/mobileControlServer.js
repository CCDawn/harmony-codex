import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const ACTIVE = new Set(['queued', 'running']);
const STATUSES = new Set([...ACTIVE, 'succeeded', 'failed', 'needs_confirmation']);
const PHASE_MESSAGES = Object.freeze({ checking: '正在检查连接', starting_services: '正在启动服务',
  connecting_desktop: '正在连接桌面', restarting_desktop: '正在重启桌面', verifying: '正在验证连接' });
const FINAL_MESSAGES = Object.freeze({ succeeded: '连接修复已验证完成', failed: '修复未完成，请检查电脑端状态',
  needs_confirmation: '需要确认后才能重启桌面' });
const MAX_JOBS = 200;

function failure(statusCode) { return Object.assign(new Error('Control request rejected'), { statusCode }); }
function ownerOf(request) {
  if (request.codexAuth?.kind === 'master') return 'master';
  if (request.codexAuth?.kind === 'device' && typeof request.codexAuth.deviceId === 'string' && request.codexAuth.deviceId) {
    return `device:${request.codexAuth.deviceId}`;
  }
  throw failure(401);
}
function safeVerification(value) {
  if (!value || typeof value !== 'object') return undefined;
  return { bridge: value.bridge === true, sessions: value.sessions === true, targetSession: value.targetSession === true,
    desktopRequired: value.desktopRequired !== false, desktop: value.desktop === true };
}
function verified(value) {
  return value?.bridge === true && value.sessions === true && value.targetSession === true
    && (value.desktopRequired === false || value.desktop === true);
}
function validateBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !/^[A-Za-z0-9._-]{8,128}$/.test(value.requestId ?? '') || typeof value.requestId !== 'string'
    || !['auto', 'hard'].includes(value.mode) || typeof value.sessionId !== 'string' || value.sessionId.length > 128
    || typeof value.confirmHardRestart !== 'boolean') throw failure(400);
  if (value.mode === 'hard' && value.confirmHardRestart !== true) throw failure(409);
  return { requestId: value.requestId, mode: value.mode, sessionId: value.sessionId, confirmHardRestart: value.confirmHardRestart };
}
async function readBody(request) {
  let bytes = 0; const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 8192) { request.resume(); throw failure(413); }
    chunks.push(chunk);
  }
  try { return validateBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch (error) { throw failure(error.statusCode ?? 400); }
}

// This server owns its job file only. It never owns the bridge's device registry or repair processes.
export function createMobileControlServer({ targetId, stateDir, authorize, executeRepair, now = () => Date.now() } = {}) {
  if (typeof authorize !== 'function') throw new TypeError('authorize is required');
  if (typeof executeRepair !== 'function') throw new TypeError('executeRepair is required');
  if (typeof targetId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(targetId)) throw new TypeError('Invalid targetId');
  if (!stateDir) throw new TypeError('stateDir is required');
  const file = path.join(stateDir, 'mobile-control-jobs.json');
  const prefix = `/control/v1/targets/${targetId}`;
  let jobs = []; let requests = []; let initialized; let sequence = Promise.resolve(); let runner = Promise.resolve();
  const at = () => new Date(now()).toISOString();
  const serialize = (operation) => {
    const result = sequence.then(operation); sequence = result.catch(() => {}); return result;
  };
  async function persist() {
    await fs.mkdir(stateDir, { recursive: true });
    const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, targetId, jobs, requests }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  function initialize() {
    if (!initialized) initialized = serialize(async () => {
      let saved;
      try {
        const stat = await fs.stat(file);
        if (stat.size > 2 * 1024 * 1024) throw failure(503);
        saved = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch (error) { if (error.code === 'ENOENT') return; throw failure(503); }
      if (saved?.version !== 1 || saved.targetId !== targetId || !Array.isArray(saved.jobs) || !Array.isArray(saved.requests)
        || saved.jobs.length > MAX_JOBS || saved.requests.length > MAX_JOBS * 10) throw failure(503);
      jobs = saved.jobs.map((entry) => {
        const job = entry?.job;
        if (typeof entry.owner !== 'string' || !job || !/^[a-f0-9]{32}$/.test(job.id ?? '') || !STATUSES.has(job.status)) throw failure(503);
        validateBody({ ...job, confirmHardRestart: true });
        const safe = { version: 1, id: job.id, requestId: job.requestId, mode: job.mode, sessionId: job.sessionId,
          status: job.status, phase: Object.hasOwn(PHASE_MESSAGES, job.phase) ? job.phase : 'checking',
          message: FINAL_MESSAGES[job.status] ?? PHASE_MESSAGES.checking,
          createdAt: String(job.createdAt ?? ''), updatedAt: String(job.updatedAt ?? ''), completedAt: job.completedAt === null ? null : String(job.completedAt ?? '') };
        if (job.verification) safe.verification = safeVerification(job.verification);
        if (ACTIVE.has(safe.status)) Object.assign(safe, { status: 'failed', message: '管理服务已重启，先前修复结果未确认', updatedAt: at(), completedAt: at() });
        return { owner: entry.owner, confirmHardRestart: entry.confirmHardRestart === true, job: safe };
      });
      requests = saved.requests.map((entry) => {
        validateBody({ ...entry, confirmHardRestart: true });
        if (!jobs.some((item) => item.job.id === entry.jobId && item.owner === entry.owner)) throw failure(503);
        return { owner: entry.owner, requestId: entry.requestId, mode: entry.mode, sessionId: entry.sessionId,
          confirmHardRestart: entry.confirmHardRestart === true, jobId: entry.jobId };
      });
      await persist();
    });
    return initialized;
  }
  async function update(entry, change) {
    await serialize(async () => { Object.assign(entry.job, change, { updatedAt: at() }); await persist(); });
  }
  async function run(entry) {
    try {
      await update(entry, { status: 'running' });
      const result = await executeRepair({ ...structuredClone(entry.job), confirmHardRestart: entry.confirmHardRestart === true }, async (report) => {
        if (!report || !Object.hasOwn(PHASE_MESSAGES, report.phase) || !ACTIVE.has(entry.job.status)) return;
        const next = { phase: report.phase, message: PHASE_MESSAGES[report.phase] };
        if (report.verification) next.verification = safeVerification(report.verification);
        await update(entry, next);
      });
      const verification = safeVerification(result?.verification);
      const status = result?.requiresConfirmation === true ? 'needs_confirmation'
        : result?.ok === true && verified(verification) ? 'succeeded' : 'failed';
      await update(entry, { status, message: FINAL_MESSAGES[status], completedAt: at(), ...(verification ? { verification } : {}) });
    } catch {
      await update(entry, { status: 'failed', message: FINAL_MESSAGES.failed, completedAt: at() }).catch(() => {});
    }
  }
  async function admit(owner, input) {
    return serialize(async () => {
      const existing = requests.find((entry) => entry.owner === owner && entry.requestId === input.requestId);
      if (existing) {
        if (existing.mode !== input.mode || existing.sessionId !== input.sessionId || existing.confirmHardRestart !== input.confirmHardRestart) throw failure(409);
        return { entry: jobs.find((entry) => entry.job.id === existing.jobId), created: false };
      }
      const active = jobs.find((entry) => ACTIVE.has(entry.job.status));
      if (active && (active.owner !== owner || active.job.mode !== input.mode || active.job.sessionId !== input.sessionId)) throw failure(409);
      if (requests.length >= MAX_JOBS * 10) throw failure(409);
      const timestamp = at();
      const previousJobs = [...jobs]; const previousRequests = [...requests];
      const entry = active ?? { owner, confirmHardRestart: input.confirmHardRestart, job: { version: 1, id: randomBytes(16).toString('hex'), requestId: input.requestId,
        mode: input.mode, sessionId: input.sessionId, status: 'queued',
        phase: 'checking', message: '修复任务已排队', createdAt: timestamp, updatedAt: timestamp, completedAt: null } };
      if (!active) {
        if (jobs.length >= MAX_JOBS) {
          const removed = jobs.shift(); requests = requests.filter((item) => item.jobId !== removed.job.id);
        }
        jobs.push(entry);
      }
      requests.push({ owner, ...input, jobId: entry.job.id });
      try { await persist(); }
      catch (error) {
        jobs = previousJobs; requests = previousRequests;
        throw error;
      }
      return { entry, created: !active };
    });
  }
  function send(response, status, data, headers = {}) {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers, connection: 'close' });
    response.end(JSON.stringify(data));
  }
  const server = createServer(async (request, response) => {
    try {
      // Validate the raw path before URL normalizes dot segments or encoded separators.
      const rawPath = String(request.url ?? '').split('?')[0];
      const route = rawPath.startsWith(`${prefix}/`) ? rawPath.slice(prefix.length) : '';
      if (!(route === '/status' || route === '/repairs' || /^\/repairs\/[a-f0-9]{32}$/.test(route))) throw failure(404);
      const url = new URL(request.url, 'http://control.local');
      await authorize({ request, url }); const owner = ownerOf(request);
      await initialize(); await sequence;
      const canRead = (entry) => owner === 'master' || entry.owner === owner;
      if (request.method === 'GET' && route === '/status') {
        const active = jobs.find((entry) => ACTIVE.has(entry.job.status) && canRead(entry));
        const last = jobs.findLast(canRead);
        send(response, 200, { version: 1, agent: { online: true, targetId, version: 1 },
          activeJob: active ? structuredClone(active.job) : null, lastJob: last ? structuredClone(last.job) : null });
      } else if (request.method === 'GET' && route.startsWith('/repairs/')) {
        const entry = jobs.find((item) => item.job.id === route.slice('/repairs/'.length) && canRead(item));
        if (!entry) throw failure(404);
        send(response, 200, { version: 1, job: structuredClone(entry.job) });
      } else if (request.method === 'POST' && route === '/repairs') {
        const input = await readBody(request); const { entry, created } = await admit(owner, input);
        send(response, 202, { version: 1, job: structuredClone(entry.job) });
        if (created) runner = run(entry);
      } else throw failure(405);
    } catch (error) {
      const status = [400, 401, 403, 404, 405, 409, 413, 429, 503].includes(error?.statusCode) ? error.statusCode : 503;
      if (!response.headersSent && !response.destroyed) send(response, status, { version: 1, error: ({ 400: '请求格式无效', 401: '身份验证失败', 403: '无权访问', 404: '未找到目标或任务',
        405: '请求方法不受支持', 409: '修复请求冲突或需要确认', 413: '请求内容过大', 429: '请求过于频繁', 503: '管理服务暂时不可用' })[status] },
      { ...(error?.responseHeaders?.['retry-after'] ? { 'retry-after': error.responseHeaders['retry-after'] } : {}),
        ...(error?.responseHeaders?.['x-codex-bridge-2fa'] ? { 'x-codex-bridge-2fa': 'required' } : {}) });
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  server.keepAliveTimeout = 1000;
  return { server, initialize, async close() {
    if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await runner; await sequence;
  } };
}
