import { CompanionDesktopClient } from './companionDesktopClient.js';
import { createHash } from 'node:crypto';
import { readJsonBody, sendJson } from './json.js';

const COMPANION_PATHS = new Set(['/companion/profile', '/companion/messages', '/companion/events']);
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

function sendFingerprint(profileId, roomId, text) {
  return createHash('sha256').update(JSON.stringify([profileId, roomId, text])).digest('hex');
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
  // Prefer an explicit transport status; fall back to the desktop adapter's
  // HTTP status so a genuine upstream 401/403/5xx is not masked as a 502
  // gateway error (which misleads the guardian into auth/upstream ambiguity).
  const statusCode = Number(error?.statusCode ?? error?.status);
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
 * Companion conversation access. Reads own a short-lived desktop client;
 * subscriptions own one until cancellation. Voice calls stay in voice sessions.
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
      for (const entry of page.entries) {
        if (entry?.role !== 'user' || typeof entry.requestId !== 'string'
            || !REQUEST_ID_PATTERN.test(entry.requestId) || typeof entry.text !== 'string'
            || typeof entry.itemId !== 'string' || !entry.itemId.startsWith('room:')
            || entry.itemId.length <= 5 || entry.itemId.length > 517) continue;
        const requestId = entry.requestId.toLowerCase();
        const record = this.sendRequests.get(requestId);
        if (!record || record.fingerprint !== sendFingerprint(requestedProfileId, requestedRoomId, entry.text)) continue;
        // Only the exact official user message can confirm a lost receipt.
        // Retain the UUID binding; history reads never initiate another POST.
        record.confirmation = { requestId, state: 'submitted', itemId: entry.itemId };
        if (record.receipt?.state === 'uncertain') record.receipt = record.confirmation;
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

  async subscribeMessages({ profileId, roomId, signal, onEntry, onControl } = {}) {
    const requestedProfileId = requiredId(profileId, 'profileId');
    const requestedRoomId = requiredId(roomId, 'roomId');
    signal?.throwIfAborted();
    const client = this.clientFactory();
    try {
      const profile = await client.discover();
      if (profile?.id !== requestedProfileId || profile?.roomId !== requestedRoomId) {
        throw httpError(409, 'The personal assistant changed; refresh the conversation');
      }
      const stop = await client.subscribeMessages({profileId:requestedProfileId,roomId:requestedRoomId,signal,onEntry,onControl});
      let closed = false;
      return async () => {
        if (closed) return;
        closed = true;
        try { await stop(); } finally { await closeClient(client); }
      };
    } catch (error) {
      await closeClient(client);
      if (error?.failureClass === 'api_compatibility') {
        throw Object.assign(httpError(422, 'Companion subscription API unavailable'), {failureClass:'api_compatibility'});
      }
      throw error;
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
    const fingerprint = sendFingerprint(requestedProfileId, requestedRoomId, text);
    const previous = this.sendRequests.get(stableRequestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw httpError(409, 'The Companion request ID is already bound to another message');
      }
      return previous.receipt ?? previous.promise;
    }
    // Fail closed instead of forgetting uncertain IDs when the bounded ledger
    // fills. A retained UUID can also be sent as the official idempotency token
    // after restart; the server's deduplication retention is not established.
    if (this.sendRequests.size >= MAX_SEND_REQUESTS) {
      throw httpError(503, 'Companion send request capacity reached');
    }
    const record = { fingerprint, promise: null, receipt: null, confirmation: null };
    record.promise = this.submitText({ profileId: requestedProfileId, roomId: requestedRoomId,
      text, requestId: stableRequestId }).then(receipt => {
      record.receipt = receipt.state === 'uncertain' && record.confirmation ? record.confirmation : receipt;
      return record.receipt;
    });
    this.sendRequests.set(stableRequestId, record);
    return record.promise;
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
        if (error?.failureClass === 'api_compatibility') throw error;
        const status = Number(error?.statusCode ?? error?.status);
        if (Number.isInteger(status) && status >= 400 && status < 500 && status !== 408) {
          const rejected = httpError(status, 'Companion text request rejected');
          rejected.status = status;
          if (error?.failureClass === 'account') rejected.failureClass = 'account';
          throw rejected;
        }
        // A timeout, lost CDP result or server failure can follow acceptance.
        // Keep the same request ID and never automatically replay this POST.
        return { requestId: input.requestId, state: 'uncertain', itemId: null };
      }
      const itemId = receipt?.requestId === input.requestId && receipt?.state === 'submitted'
        && typeof receipt?.itemId === 'string' && receipt.itemId.startsWith('room:')
        && receipt.itemId.length > 5 && receipt.itemId.length <= 517 ? receipt.itemId : null;
      return { requestId: input.requestId, state: itemId ? 'submitted' : 'uncertain', itemId };
    } catch (error) {
      // Both module discovery and write capability checks run before the POST.
      // Preserve deterministic rejection for callers that distinguish 4xx from
      // a response lost after server acceptance.
      if (error?.failureClass === 'api_compatibility') {
        throw Object.assign(httpError(422, 'Companion text API unavailable'), { failureClass: 'api_compatibility' });
      }
      throw error;
    } finally {
      await closeClient(client);
    }
  }

}

async function openCompanionEventStream({request,response,service,profileId,roomId}) {
  const abort = new AbortController();
  const buffered = new Map();
  let ready = false;
  let closed = false;
  let cleanup;
  let heartbeat;
  let pendingControl;
  let bufferedBytes = 0;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    abort.abort();
    request.removeListener?.('aborted', close);
    response.removeListener?.('close', close);
    if (cleanup) void Promise.resolve().then(cleanup).catch(() => {});
  };
  const control = reason => {
    if (closed) return;
    if (!ready) { pendingControl = reason; return; }
    // No event ID: this upstream subscription has no durable replay sequence.
    response.end(`event: stream.control\ndata: ${JSON.stringify({type:'stream.control',reason})}\n\n`);
    close();
  };
  const write = entry => {
    if (closed) return;
    if (!ready) {
      if (buffered.size >= 128 && !buffered.has(entry.itemId)) { pendingControl = 'gap'; return; }
      const bytes = Buffer.byteLength(JSON.stringify(entry));
      const replaced = buffered.get(entry.itemId);
      const nextBytes = bufferedBytes + bytes - (replaced ? Buffer.byteLength(JSON.stringify(replaced)) : 0);
      if (nextBytes > 256 * 1024) { pendingControl = 'gap'; return; }
      bufferedBytes = nextBytes;
      buffered.set(entry.itemId, entry);
      return;
    }
    const frame = `event: companion.message\ndata: ${JSON.stringify({entry})}\n\n`;
    // Never build an unbounded backlog for a paused/slow phone. A gap closes
    // this stream so the consumer repairs authoritative history on reconnect.
    if (Buffer.byteLength(frame) > 256 * 1024 || response.writableLength > 256 * 1024) { control('gap'); return; }
    if (!response.write(frame)) control('gap');
  };
  request.on?.('aborted', close);
  response.on?.('close', close);
  try {
    cleanup = await service.subscribeMessages({profileId,roomId,signal:abort.signal,onEntry:write,
      onControl:event => control(['gap','terminal','reconnect'].includes(event?.reason) ? event.reason : 'reconnect')});
    if (closed) { await cleanup(); return; }
    response.writeHead(200, {'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform',
      connection:'keep-alive','x-accel-buffering':'no'});
    response.flushHeaders?.();
    ready = true;
    if (pendingControl) { control(pendingControl); return; }
    // A comment opens the stream without inventing an application event/ID.
    if (!response.write(': companion subscribed\n\n')) { control('gap'); return; }
    for (const entry of buffered.values()) write(entry);
    buffered.clear();
    bufferedBytes = 0;
    if (!closed) heartbeat = setInterval(() => {
      if (!response.write(': keepalive\n\n')) control('gap');
    }, 15000);
  } catch (error) {
    close();
    if (response.headersSent) {
      if (!response.writableEnded) response.end();
      return;
    }
    if (abort.signal.aborted && response.destroyed) return;
    throw error;
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
    if (parsedUrl.pathname === '/companion/events') {
      await openCompanionEventStream({request,response,service,profileId,roomId});
      return true;
    }
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
