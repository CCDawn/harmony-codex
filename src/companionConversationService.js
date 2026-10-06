import { CompanionDesktopClient } from './companionDesktopClient.js';
import { sendJson } from './json.js';

const COMPANION_PATHS = new Set(['/companion/profile', '/companion/messages']);
const MAX_ID_LENGTH = 512;
const MAX_CURSOR_LENGTH = 4096;

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
 * Read-only Companion conversation access. Every operation owns a short-lived
 * desktop client; voice-call ownership remains exclusively in voice sessions.
 */
export class CompanionConversationService {
  constructor({ clientFactory = () => new CompanionDesktopClient() } = {}) {
    this.clientFactory = clientFactory;
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
        nextCursor: typeof page.nextCursor === 'string' ? page.nextCursor : null
      };
    } finally {
      await closeClient(client);
    }
  }

}

/** Handle the read-only Companion endpoints; return false for other paths. */
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
  if (request?.method !== 'GET') {
    sendJson(response, 405, { error: requestErrorPayload(405) });
    return true;
  }
  if (!service) {
    sendJson(response, 503, { error: 'Companion service unavailable' });
    return true;
  }

  try {
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
    sendJson(response, statusCode, { error: requestErrorPayload(statusCode) });
    return true;
  }
}
