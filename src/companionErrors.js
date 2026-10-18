const ERROR_CODES = new Set(['timeout', 'cdp_connection', 'http_error', 'unknown_error']);
const OPERATIONS = new Set(['discover', 'history', 'start', 'attach', 'stop', 'reconcile', 'unknown']);
const STAGES = new Set(['discover', 'history', 'create', 'attach', 'stop', 'reconcile', 'unknown']);

const TIMEOUT_PREFIX = /^(?:Codex 桌面 CDP 请求超时|连接 Codex 桌面 CDP 超时|请求 Codex 桌面 CDP 入口超时|等待 Codex 桌面 app-server 响应超时)/i;
const CDP_CONNECTION_PREFIX = /^(?:Codex 桌面 CDP (?:连接已关闭|连接错误|未连接|请求失败)|连接 Codex 桌面 CDP 失败|未找到 Codex 桌面窗口 CDP 入口|请求 Codex 桌面 CDP 入口失败)/i;
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ERR_HTTP_REQUEST_TIMEOUT']);
const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_SOCKET_CLOSED']);

function httpStatus(error) {
  const status = Number(error?.status);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function errorText(error) {
  return typeof error?.message === 'string' ? error.message : '';
}

export function classifyCompanionError(error) {
  if (httpStatus(error) !== null) return 'http_error';
  if (error?.name === 'TimeoutError' || TIMEOUT_CODES.has(error?.code) || TIMEOUT_PREFIX.test(errorText(error))) {
    return 'timeout';
  }
  if (CONNECTION_CODES.has(error?.code) || CDP_CONNECTION_PREFIX.test(errorText(error))) {
    return 'cdp_connection';
  }
  return 'unknown_error';
}

function defaultStage(operation) {
  if (operation === 'start') return 'create';
  return STAGES.has(operation) ? operation : 'unknown';
}

export function makeCompanionError(error, { stage } = {}) {
  const inheritedCode = ERROR_CODES.has(error?.errorCode) ? error.errorCode : null;
  const errorCode = inheritedCode ?? classifyCompanionError(error);
  const status = errorCode === 'http_error' ? httpStatus(error) : null;
  const message = status === null ? 'Companion request failed' : `Companion HTTP ${status}`;
  const safe = new Error(message);
  safe.name = 'CompanionError';
  safe.errorCode = errorCode;
  safe.status = status ?? 0;
  const inheritedStage = STAGES.has(error?.stage) ? error.stage : null;
  const requestedStage = STAGES.has(stage) ? stage : null;
  safe.stage = inheritedStage ?? requestedStage ?? 'unknown';
  if (error?.operation === 'reconcile') safe.operation = 'reconcile';
  return safe;
}

export function annotateCompanionError(error, { stage } = {}) {
  if (!error || typeof error !== 'object') return makeCompanionError(error, { stage });
  try {
    if (!ERROR_CODES.has(error.errorCode)) error.errorCode = classifyCompanionError(error);
    if (!STAGES.has(error.stage) && STAGES.has(stage)) error.stage = stage;
    if (error.operation !== 'reconcile') delete error.operation;
    return error;
  } catch {
    return makeCompanionError(error, { stage });
  }
}

export function companionRpcErrorFields(error, method) {
  const safe = makeCompanionError(error);
  const operation = safe.operation === 'reconcile'
    ? 'reconcile'
    : (OPERATIONS.has(method) ? method : 'unknown');
  const stage = STAGES.has(safe.stage) && safe.stage !== 'unknown'
    ? safe.stage
    : defaultStage(operation);
  return {
    error: safe.message,
    errorCode: safe.errorCode,
    operation,
    stage,
    ...(safe.status ? { status: safe.status } : {})
  };
}
