import { CompanionDesktopClient } from './companionDesktopClient.js';
import { readJsonBody, sendJson } from './json.js';

const STATUS_PATH = '/companion/computer/status';
const SESSION_PATH = '/companion/computer/sessions';
const MAX_ID_LENGTH = 512;
const MAX_REQUEST_BYTES = 80 * 1024;
export const MAX_COMPUTER_SDP_BYTES = 64 * 1024;

const READ_COMPUTER_CONTEXT = `
const data = await api.safeGet('/tbo/primary', {retry:false});
const p = data?.profile;
const selection = data?.selection;
const asString = value => typeof value === 'string' ? value : '';
let environment = {environmentId:'',status:'unknown',ready:false};
if (p?.id && selection?.aeon_id === p.id && selection?.thread_id === p.active_root_thread_id) {
  const result = await api.safeGet('/tbo/{tbo_id}/environment/status', {
    parameters:{path:{tbo_id:p.id},query:{thread_id:selection.thread_id}},retry:false
  });
  environment = {
    environmentId:asString(result?.environmentId),
    status:asString(result?.status) || 'unknown',
    ready:Array.isArray(result?.capabilities)
      && result.capabilities.some(capability => capability?.type === 'remote_desktop' && capability?.status === 'ready')
  };
}
return {
  profile:{
    id:asString(p?.id),
    roomId:asString(p?.messaging_room_id),
    status:asString(p?.status),
    aeonKind:asString(p?.aeon_kind),
    activeRootThreadId:asString(p?.active_root_thread_id)
  },
  selection:{aeonId:asString(selection?.aeon_id),threadId:asString(selection?.thread_id)},
  environment
};`;

const CREATE_COMPUTER_SESSION = `
const response = await api.postResponse('/tbo/{tbo_id}/computer/sessions', {
  parameters:{path:{tbo_id:params.assistantId},query:{thread_id:params.threadId}},
  requestBody:params.sdp,
  contentType:'application/sdp',
  retry:false
});
return {sdp:await response.text()};`;

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requiredId(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_ID_LENGTH) {
    throw httpError(400, `A valid ${label} is required`);
  }
  return value;
}

function singleQueryValue(url, key) {
  const values = url.searchParams.getAll(key);
  if (values.length !== 1 || !values[0]?.trim()) {
    throw httpError(400, `A single ${key} value is required`);
  }
  return requiredId(values[0], key);
}

function contextError() {
  return httpError(409, 'The personal assistant or selected thread changed; refresh computer status');
}

function validateContext(context, { assistantId, roomId, threadId } = {}) {
  const profile = context?.profile;
  const selection = context?.selection;
  if (!profile || profile.status !== 'active' || profile.aeonKind !== 'orbit'
      || !profile.id || !profile.roomId || !profile.activeRootThreadId
      || selection?.aeonId !== profile.id
      || selection?.threadId !== profile.activeRootThreadId) {
    throw contextError();
  }
  if ((assistantId !== undefined && profile.id !== assistantId)
      || (roomId !== undefined && profile.roomId !== roomId)
      || (threadId !== undefined && selection.threadId !== threadId)) {
    throw contextError();
  }
  return context;
}

function safeEnvironmentStatus(environment) {
  const value = environment?.status;
  return typeof value === 'string' && value.length <= 64 ? value : 'unknown';
}

function safeEnvironmentId(environment) {
  const value = environment?.environmentId;
  return typeof value === 'string' && value.trim() && value.length <= MAX_ID_LENGTH ? value : null;
}

function validateSdp(sdp) {
  if (typeof sdp !== 'string' || !sdp.startsWith('v=0')) {
    throw httpError(400, 'A valid SDP offer is required');
  }
  if (Buffer.byteLength(sdp, 'utf8') > MAX_COMPUTER_SDP_BYTES) {
    throw httpError(413, 'SDP offer is too large');
  }
}

async function closeClient(client) {
  try {
    await client.close?.();
  } catch {
    // Cleanup errors must not replace the request result or expose connector details.
  }
}

function statusCodeFor(error) {
  const statusCode = Number(error?.statusCode);
  return Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599
    ? statusCode
    : 502;
}

function errorPayload(statusCode) {
  if (statusCode === 400) return { error: 'Invalid Companion computer request' };
  if (statusCode === 409) return { error: 'Companion computer identity changed; refresh status' };
  if (statusCode === 413) return { error: 'SDP offer is too large' };
  if (statusCode === 405) return { error: 'Method not allowed' };
  if (statusCode === 503) return { error: 'Remote desktop is not ready' };
  return { error: 'Companion computer request failed' };
}

/** Read-only identity and environment validation plus an explicitly targeted SDP session. */
export class CompanionComputerService {
  constructor({ desktopClient } = {}) {
    this.desktopClient = desktopClient ?? null;
  }

  async withDesktopClient(operation) {
    const client = this.desktopClient ?? new CompanionDesktopClient();
    try {
      return await operation(client);
    } finally {
      if (!this.desktopClient) await closeClient(client);
    }
  }

  async readContext(client) {
    const context = await client.invoke(READ_COMPUTER_CONTEXT);
    return validateContext(context);
  }

  async getStatus({ assistantId, roomId } = {}) {
    const expectedAssistantId = requiredId(assistantId, 'assistantId');
    const expectedRoomId = requiredId(roomId, 'roomId');
    return this.withDesktopClient(async client => {
      const context = validateContext(await this.readContext(client), {
        assistantId: expectedAssistantId,
        roomId: expectedRoomId
      });
      const environmentId = safeEnvironmentId(context.environment);
      return {
        assistantId: context.profile.id,
        roomId: context.profile.roomId,
        threadId: context.selection.threadId,
        environmentId,
        status: safeEnvironmentStatus(context.environment),
        ready: context.environment?.ready === true && environmentId !== null
      };
    });
  }

  async createSession(input = {}) {
    const assistantId = requiredId(input.assistantId, 'assistantId');
    const roomId = requiredId(input.roomId, 'roomId');
    const threadId = requiredId(input.threadId, 'threadId');
    const environmentId = requiredId(input.environmentId, 'environmentId');
    validateSdp(input.sdp);

    return this.withDesktopClient(async client => {
      const context = validateContext(await this.readContext(client), { assistantId, roomId, threadId });
      const currentEnvironmentId = safeEnvironmentId(context.environment);
      if (context.environment?.ready !== true || !currentEnvironmentId) {
        throw httpError(503, 'Remote desktop is not ready');
      }
      if (currentEnvironmentId !== environmentId) {
        throw contextError();
      }

      const result = await client.invoke(CREATE_COMPUTER_SESSION, { assistantId, threadId, sdp: input.sdp });
      const answerSdp = result?.sdp;
      if (typeof answerSdp !== 'string' || !answerSdp.startsWith('v=0')
          || Buffer.byteLength(answerSdp, 'utf8') > MAX_COMPUTER_SDP_BYTES) {
        throw httpError(502, 'Computer session response unavailable');
      }

      const finalContext = validateContext(await this.readContext(client), { assistantId, roomId, threadId });
      const finalEnvironmentId = safeEnvironmentId(finalContext.environment);
      if (finalContext.environment?.ready !== true || !finalEnvironmentId) {
        throw httpError(503, 'Remote desktop is not ready');
      }
      if (finalEnvironmentId !== environmentId) {
        throw contextError();
      }
      return { sdp: answerSdp, assistantId, roomId, threadId, environmentId: finalEnvironmentId };
    });
  }
}

/** Handle the authenticated Companion computer endpoints. */
export async function handleCompanionComputerRoute({ request, response, url, service } = {}) {
  let parsedUrl;
  try {
    const source = url ?? request?.url;
    parsedUrl = source instanceof URL
      ? source
      : new URL(String(source ?? '/'), 'http://127.0.0.1');
  } catch {
    return false;
  }

  if (parsedUrl.pathname !== STATUS_PATH && parsedUrl.pathname !== SESSION_PATH) {
    return false;
  }
  const expectedMethod = parsedUrl.pathname === STATUS_PATH ? 'GET' : 'POST';
  if (request?.method !== expectedMethod) {
    sendJson(response, 405, errorPayload(405));
    return true;
  }
  if (!service) {
    sendJson(response, 503, errorPayload(503));
    return true;
  }

  try {
    if (parsedUrl.pathname === STATUS_PATH) {
      const result = await service.getStatus({
        assistantId: singleQueryValue(parsedUrl, 'assistantId'),
        roomId: singleQueryValue(parsedUrl, 'roomId')
      });
      sendJson(response, 200, result);
      return true;
    }

    const body = await readJsonBody(request, MAX_REQUEST_BYTES);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw httpError(400, 'Request body must be a JSON object');
    }
    const result = await service.createSession(body);
    sendJson(response, 200, result);
    return true;
  } catch (error) {
    const statusCode = statusCodeFor(error);
    sendJson(response, statusCode, errorPayload(statusCode));
    return true;
  }
}
