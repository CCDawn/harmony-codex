import { CompanionDesktopClient } from './companionDesktopClient.js';
import { createHash } from 'node:crypto';
import { readJsonBody, sendJson } from './json.js';

const COMPANION_PATHS = new Set(['/companion/profile', '/companion/messages']);
const MAX_ID_LENGTH = 512;
const MAX_CURSOR_LENGTH = 4096;
const MAX_TEXT_LENGTH = 20000;
const MAX_SEND_REQUESTS = 4096;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function metadataId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_ID_LENGTH) {
    throw httpError(502, 'Personal assistant profile unavailable');
  }
  return value;
}

function metadataAvatarUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2048) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function publicProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    throw httpError(502, 'Personal assistant profile unavailable');
  }
  const id = metadataId(profile.id);
  const roomId = metadataId(profile.roomId);
  if (typeof profile.name !== 'string' || !profile.name.trim()) {
    throw httpError(502, 'Personal assistant profile unavailable');
  }
  return {
    id,
    name: profile.name,
    roomId,
    avatarUrl: metadataAvatarUrl(profile.avatarUrl)
  };
}

function requestErrorPayload(statusCode) {
  if (statusCode === 400) {
    return 'Invalid Companion request';
  }
  if (statusCode === 409) {
    return 'The personal assistant changed; refresh the conversation';
  }
  if (statusCode === 405) {
    return 'Method not allowed';
  }
  return 'Companion request failed';
}

async function closeClient(client) {
  try {
    await client.close();
  } catch {
    // Do not replace a successful read or expose connector cleanup details.
  }
}

function statusCodeFor(error) {
  const statusCode = Number(error?.statusCode);
  return Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599
    ? statusCode
    : 502;
}

function singleQueryValue(url, key, required = false) {
  const values = url.searchParams.getAll(key);
  if (values.length > 1) {
    throw httpError(400, `A single ${key} value is required`);
  }
  const value = values[0];
  if (required && (typeof value !== 'string' || !value.trim())) {
    throw httpError(400, `A valid ${key} is required`);
  }
  return value;
}

/**
 * Companion conversation access. Every operation owns a short-lived
 * desktop client; voice-call ownership remains exclusively in voice sessions.
 */
export class CompanionConversationService {
  constructor({ clientFactory = () => new CompanionDesktopClient() } = {}) {
    this.clientFactory = clientFactory;
    // Keep completed/uncertain IDs for this service's lifetime. Evicting them
    // would turn a delayed duplicate HTTP request into another upstream write.
    this.sendRequests = new Map();
  }

  async getProfile() {
    const client = this.clientFactory();
    try {
      return { profile: publicProfile(await client.profileDetails()) };
    } finally {
      await closeClient(client);
    }
  }

  async getMessages({ profileId, roomId, before } = {}) {
    const requestedProfileId = requiredId(profileId, 'profileId');
    const requestedRoomId = requiredId(roomId, 'roomId');
    if (before !== undefined && before !== null
        && (typeof before !== 'string' || before.length > MAX_CURSOR_LENGTH)) {
      throw httpError(400, 'Invalid message cursor');
    }

    const client = this.clientFactory();
    try {
      const profile = await client.discover();
      if (profile?.id !== requestedProfileId || profile?.roomId !== requestedRoomId) {
        throw httpError(409, 'The personal assistant changed; refresh the conversation');
      }
      const page = await client.messages({ before });
      if (!page || !Array.isArray(page.entries)) {
        throw httpError(502, 'Companion messages unavailable');
      }
      return {
        entries: page.entries,
        calls: Array.isArray(page.calls) ? page.calls : [],
        nextCursor: typeof page.nextCursor === 'string' ? page.nextCursor : null
      };
    } finally {
      await closeClient(client);
    }
  }

  async sendText({ profileId, roomId, text, requestId } = {}) {
    const requestedProfileId = requiredId(profileId, 'profileId');
    const requestedRoomId = requiredId(roomId, 'roomId');
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_LENGTH
        || typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
      throw httpError(400, 'Invalid Companion text request');
    }
    const stableRequestId = requestId.toLowerCase();
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([requestedProfileId, requestedRoomId, text])).digest('hex');
    const previous = this.sendRequests.get(stableRequestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw httpError(409, 'The Companion request ID is already bound to another message');
      }
      return previous.promise;
    }
    // Fail closed instead of forgetting uncertain IDs when the bounded ledger
    // fills. A retained UUID can also be sent as the official idempotency token
    // after restart; the server's deduplication retention is not established.
    if (this.sendRequests.size >= MAX_SEND_REQUESTS) {
      throw httpError(503, 'Companion send request capacity reached');
    }
    const promise = this.submitText({ profileId: requestedProfileId, roomId: requestedRoomId,
      text, requestId: stableRequestId });
    this.sendRequests.set(stableRequestId, { fingerprint, promise });
    return promise;
  }

  async submitText(input) {
    const client = this.clientFactory();
    try {
      const profile = await client.discover();
      if (profile?.id !== input.profileId || profile?.roomId !== input.roomId) {
        throw httpError(409, 'The personal assistant changed; refresh the conversation');
      }
      let receipt;
      try {
        receipt = await client.sendText(input);
      } catch (error) {
        const status = Number(error?.statusCode ?? error?.status);
        if (Number.isInteger(status) && status >= 400 && status < 500 && status !== 408) {
          throw httpError(status, 'Companion text request rejected');
        }
        // A timeout, lost CDP result or server failure can follow acceptance.
        // Keep the same request ID and never automatically replay this POST.
        return { requestId: input.requestId, state: 'uncertain', itemId: null };
      }
      const itemId = receipt?.requestId === input.requestId && receipt?.state === 'submitted'
        && typeof receipt?.itemId === 'string' && receipt.itemId.startsWith('room:')
        && receipt.itemId.length > 5 && receipt.itemId.length <= 517 ? receipt.itemId : null;
      return { requestId: input.requestId, state: itemId ? 'submitted' : 'uncertain', itemId };
    } finally {
      await closeClient(client);
    }
  }

}

/** Handle Companion endpoints; return false for other paths. */
export async function handleCompanionRoute({ request, response, url, service } = {}) {
  let parsedUrl;
  try {
    const source = url ?? request?.url;
    parsedUrl = source instanceof URL
      ? source
      : new URL(String(source ?? '/'), 'http://127.0.0.1');
  } catch {
    return false;
  }

  if (!COMPANION_PATHS.has(parsedUrl.pathname)) {
    return false;
  }
  const isSend = parsedUrl.pathname === '/companion/messages' && request?.method === 'POST';
  if (request?.method !== 'GET' && !isSend) {
    sendJson(response, 405, { error: requestErrorPayload(405) });
    return true;
  }
  if (!service) {
    sendJson(response, 503, { error: 'Companion service unavailable' });
    return true;
  }

  try {
    if (isSend) {
      const body = await readJsonBody(request, 128 * 1024);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw httpError(400, 'A Companion text request object is required');
      }
      const { profileId, roomId, text, requestId } = body;
      sendJson(response, 200, await service.sendText({ profileId, roomId, text, requestId }));
      return true;
    }
    if (parsedUrl.pathname === '/companion/profile') {
      sendJson(response, 200, await service.getProfile());
      return true;
    }

    const profileId = singleQueryValue(parsedUrl, 'profileId', true);
    const roomId = singleQueryValue(parsedUrl, 'roomId', true);
    const rawBefore = singleQueryValue(parsedUrl, 'before');
    const before = rawBefore === '' ? undefined : rawBefore;
    sendJson(response, 200, await service.getMessages({ profileId, roomId, before }));
    return true;
  } catch (error) {
    const statusCode = statusCodeFor(error);
    // Add only fixed classifications: the guardian must distinguish a desktop
    // adapter mismatch from a transport fault without publishing raw exceptions.
    const failureClass = ['api_compatibility', 'account'].includes(error?.failureClass) ? error.failureClass
      : [401, 403].includes(Number(error?.status)) ? 'auth'
        : Number(error?.status) >= 500 ? 'upstream' : null;
    sendJson(response, statusCode, { error: requestErrorPayload(statusCode),
      ...(failureClass ? { failureClass } : {}) });
    return true;
  }
}
