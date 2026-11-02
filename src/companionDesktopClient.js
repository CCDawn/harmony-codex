import { CodexDesktopCdpClient } from './codexDesktopCdpClient.js';
import { companionCallRecords } from './companionCallHistory.js';
import { annotateCompanionError } from './companionErrors.js';
import { randomUUID } from 'node:crypto';
import { DESKTOP_MODULE_GRAPH_LOADER } from './desktopModuleGraph.js';

// Resolve the exports from the running desktop build, not another installed build.
const LOAD_API = DESKTOP_MODULE_GRAPH_LOADER + String.raw`
let api;
for await (const {assetUrl, source} of activeDesktopModules()) {
  const internalName = source.match(/([A-Za-z_$][\w$]*)\.safeGet\(['"\`]\/tbo\/primary['"\`]/)?.[1];
  if (!internalName) continue;
  const exportBlock = source.slice(source.lastIndexOf('export{') >= 0
    ? source.lastIndexOf('export{') : source.lastIndexOf('export {'));
  const exportedName = [...exportBlock.matchAll(/([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/g)]
    .find(match => match[1] === internalName)?.[2];
  if (!exportedName) continue;
  const module = await import(assetUrl);
  const candidate = module[exportedName];
  if (typeof candidate?.safeGet === 'function' && typeof candidate?.postResponse === 'function') {
    api = candidate;
    break;
  }
}
if (!api) throw Object.assign(new Error('Desktop Companion API export unavailable'), {failureClass:'api_compatibility'});
`;

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// This is a read-only subscription to the desktop's existing messaging topic.
// The upstream events invalidate messages; they are not token deltas. Keep the
// function self-contained because it also executes inside the desktop renderer.
export function attachCompanionMessageTopic(topic, roomId, emit, isCurrent) {
  let active = true;
  let subscribed = false;
  let initialRecovery = true;
  let scheduled = false;
  const cleanups = [];
  const stop = () => {
    if (!active) return;
    active = false;
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  };
  const control = reason => {
    if (!active) return;
    stop();
    emit({ kind: 'control', reason });
  };
  const current = () => {
    if (!active) return false;
    if (isCurrent()) return true;
    control('terminal');
    return false;
  };
  const refresh = () => {
    if (!current() || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (current()) emit({ kind: 'update' });
    });
  };
  try {
    // A bounded lease also releases our ownership if the bridge process dies
    // before it can run renderer cleanup. Renew by reconnecting and repairing
    // history; this timer never fetches messages.
    const lease = setTimeout(() => control('reconnect'), 60000);
    cleanups.push(() => clearTimeout(lease));
    cleanups.push(topic.onMessage(event => {
      if (!current() || event?.payload?.room_id !== roomId) return;
      if (['calpico-message-add', 'calpico-message-update', 'calpico-message-task-associated'].includes(event.type)) refresh();
      else if (event.type === 'calpico-room-leave') control('terminal');
    }));
    cleanups.push(topic.onDisconnect(() => control('reconnect')));
    cleanups.push(topic.onPotentialMissedMessages(() => {
      // A first subscription has no offset. Its initial authoritative read
      // covers that recovery signal; subsequent gaps require history repair.
      if (initialRecovery) initialRecovery = false;
      else control('gap');
    }));
    cleanups.push(topic.onSubscribed(() => {
      if (subscribed) { control('reconnect'); return; }
      subscribed = true;
      refresh();
      queueMicrotask(() => { initialRecovery = false; });
    }));
    // Do not call unsubscribe(): another desktop consumer may own the topic.
    const release = topic.retainSubscription();
    if (active) cleanups.push(release);
    else release();
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
}

const LOAD_MESSAGE_TOPIC = String.raw`
let live;
for await (const {assetUrl, source} of activeDesktopModules()) {
  // Discover symbols by their actual call sites in the running build. Never
  // reuse hashed exports or code from a different installed desktop version.
  const topicFactory = source.match(/([A-Za-z_$][\w$]*)\(\w+\?\?\(\w+===\x60all\x60\?\x60calpico-chatgpt-messaging-all\x60:\x60calpico-chatgpt-messaging\x60\)/)?.[1];
  const identity = source.match(/\.scope\.get\(([A-Za-z_$][\w$]*)\)!==\w+\.access\.accountId\|\|\w+\.scope\.get\(([A-Za-z_$][\w$]*)\)!==\w+\.access\.userId/);
  if (!topicFactory || !identity) continue;
  const exportBlock = source.slice(Math.max(source.lastIndexOf('export{'), source.lastIndexOf('export {')));
  const exports = [...exportBlock.matchAll(/([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/g)];
  const module = await import(assetUrl);
  const resolve = internal => module[exports.find(match => match[1] === internal)?.[2]];
  const factory = resolve(topicFactory), account = resolve(identity[1]), user = resolve(identity[2]);
  if (typeof factory !== 'function' || typeof account?.resolve !== 'function' || typeof user?.resolve !== 'function') continue;
  // Read the existing authenticated AppScope; no token extraction, additional
  // login, thread, turn, voice call or independent WebSocket is created here.
  const pending = [window.__codexRoot?._internalRoot?.current];
  let scanned = 0;
  while (pending.length && scanned++ < 10000) {
    const fiber = pending.pop();
    if (!fiber) continue;
    const chain = fiber.memoizedProps?.value;
    if (chain instanceof Map && chain.has(account.scope.id) && chain.has(user.scope.id)) {
      const read = atom => { const node = chain.get(atom.scope.id); return node.store.get(atom.resolve(node, chain)); };
      const accountId = read(account), userId = read(user);
      if (typeof accountId !== 'string' || !accountId || typeof userId !== 'string' || !userId) break;
      const topic = factory('calpico-chatgpt-messaging',
        () => api.safeGet('/celsius/ws/user', {retry:false,
          additionalHeaders:{'ChatGPT-Account-ID':accountId},expectedIdentity:{accountId,userId}}).then(result => result.websocket_url),
        JSON.stringify([accountId,userId]));
      if (!['onMessage','onDisconnect','onSubscribed','onPotentialMissedMessages','retainSubscription'].every(key => typeof topic?.[key] === 'function')) break;
      live = {topic,isCurrent:()=>read(account) === accountId && read(user) === userId};
      break;
    }
    if (fiber.sibling) pending.push(fiber.sibling);
    if (fiber.child) pending.push(fiber.child);
  }
  if (live) break;
}
if (!live) throw Object.assign(new Error('Desktop messaging subscription unavailable'), {failureClass:'api_compatibility'});
`;

function historyCreatedAt(value) {
  // The official field is a timestamp with an explicit timezone. Date.parse
  // alone also accepts ambiguous dates, numbers and impossible calendar days.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return null;
  const day = value.slice(0, 10);
  const calendar = Date.parse(`${day}T00:00:00Z`);
  const timestamp = Date.parse(value);
  return Number.isFinite(calendar) && new Date(calendar).toISOString().slice(0, 10) === day
    && Number.isFinite(timestamp) ? timestamp : null;
}

export function historyEntries(items, authors = null) {
  const roles = authors && new Map(authors.map(author => [author.accountUserId, author.role]));
  return (Array.isArray(items) ? items : [])
    .filter(item => typeof item?.id === 'string' && item.id.trim() && item.id.length <= 512)
    .filter(item => !item.deleted_at && typeof item.content?.text === 'string' && item.content.text.trim())
    .filter(item => !roles || roles.has(item.account_user_id))
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))
    .map(item => {
      const createdAt = historyCreatedAt(item.created_at);
      return { itemId: `room:${item.id}`, role: roles ? roles.get(item.account_user_id) : (item.role === 'user' ? 'user' : 'assistant'),
        text: item.content.text, final: true,
        ...(typeof item.request_id === 'string' && REQUEST_ID_PATTERN.test(item.request_id)
          ? { requestId: item.request_id.toLowerCase() } : {}),
        ...(createdAt !== null ? { createdAt } : {}) };
    });
}

export class CompanionDesktopClient {
  constructor(client = new CodexDesktopCdpClient({ timeoutMs: 35000 })) {
    this.client = client;
    this.profile = null;
    this.callId = null;
    this.roomMetadata = null;
  }

  async invoke(body, params = {}, timeoutMs = 30000, stage = 'unknown') {
    let result;
    try {
      await this.client.ensureConnected();
      result = await this.client.evaluate(`(async()=>{try{${LOAD_API}\nconst params=${JSON.stringify(params)};\n${body}}catch(error){
return {__companionError:true,status:Number(error?.status)||0,name:String(error?.name||'Error'),failureClass:['api_compatibility','account'].includes(error?.failureClass)?error.failureClass:null};}})()`, timeoutMs);
    } catch (error) {
      throw annotateCompanionError(error, { stage });
    }
    if (result?.__companionError) {
      const name = result.name === 'TimeoutError' ? 'TimeoutError' : 'Error';
      const status = Number(result.status);
      const error = new Error(Number.isInteger(status) && status >= 100 && status <= 599
        ? `Companion HTTP ${status}` : `Companion ${name}`);
      error.name = name;
      error.status = status;
      if (['api_compatibility','account'].includes(result.failureClass)) error.failureClass = result.failureClass;
      throw annotateCompanionError(error, { stage });
    }
    return result;
  }

  async discover() {
    const profile = await this.invoke(`
const result = await api.safeGet('/tbo/primary', {retry:false});
const p = result?.profile;
if (!p?.id || !p.messaging_room_id || p.aeon_kind !== 'orbit' || p.status !== 'active') {
  throw Object.assign(new Error('Active personal assistant messaging room unavailable'), {failureClass:'account'});
}
return {id:p.id,name:p.display_name || '个人助手',roomId:p.messaging_room_id};`, {}, 30000, 'discover');
    if (this.profile && (this.profile.id !== profile.id || this.profile.roomId !== profile.roomId)) {
      throw new Error('Personal assistant selection changed');
    }
    this.profile = profile;
    return profile;
  }

  async history() {
    if (!this.profile) await this.discover();
    const metadata = await this.getRoomMetadata();
    const response = await this.invoke(`
return await api.safeGet('/messaging/rooms/{room_id}/messages', {
  parameters:{path:{room_id:params.roomId},query:{limit:32}}, retry:false});`, this.profile);
    return { entries: historyEntries(response?.items, metadata.authors) };
  }

  async getRoomMetadata() {
    if (this.roomMetadata) return this.roomMetadata;
    if (!this.profile) await this.discover();
    const metadata = await this.invoke(`
const room = await api.safeGet('/messaging/rooms/{room_id}', {
  parameters:{path:{room_id:params.roomId}},retry:false});
const members = (room?.members || []).filter(member => member.aeon_id === room.aeon_id);
if (!room?.aeon_id || members.length !== 1) throw new Error('Personal assistant room identity unavailable');
return {avatarUrl:typeof members[0].avatar_url === 'string' ? members[0].avatar_url : null,
  authors:room.members.filter(member => typeof member.account_user_id === 'string').map(member => ({
    accountUserId:member.account_user_id,role:member.aeon_id === room.aeon_id ? 'assistant' : 'user'
  }))};`, this.profile);
    if (!metadata?.authors?.some(author => author.role === 'assistant')) {
      throw new Error('Personal assistant room author unavailable');
    }
    this.roomMetadata = metadata;
    return metadata;
  }

  async profileDetails() {
    const profile = await this.discover();
    const metadata = await this.getRoomMetadata();
    return { ...profile, avatarUrl: metadata.avatarUrl };
  }

  async messages({ before } = {}) {
    if (!this.profile) await this.discover();
    if (before != null && (typeof before !== 'string' || before.length > 4096)) {
      throw new Error('Invalid Companion history cursor');
    }
    // Both reads target the already discovered room. Keep author validation as
    // a gate on returned entries while avoiding an extra network wait in polling.
    const [metadata, response] = await Promise.all([this.getRoomMetadata(), this.invoke(`
return await api.safeGet('/messaging/rooms/{room_id}/messages', {
  parameters:{path:{room_id:params.roomId},query:{limit:32,...(params.before ? {before:params.before} : {})}},
  retry:false});`, { roomId: this.profile.roomId, before: before || undefined })]);
    const items = Array.isArray(response?.items) ? response.items : [];
    const oldest = items.slice().sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))[0];
    return {
      entries: historyEntries(items.filter(message => !Array.isArray(message?.content?.attachments)
        || !message.content.attachments.some(attachment => attachment?.type === 'call')), metadata.authors),
      calls: companionCallRecords(response?.items, metadata.authors),
      // This server can return null cursors on a full page. Its supported
      // `before=<oldest message id>` also retrieves non-overlapping older pages.
      nextCursor: typeof response?.prev_cursor === 'string' ? response.prev_cursor
        : items.length === 32 && typeof oldest?.id === 'string' ? oldest.id : null
    };
  }

  async subscribeMessages({ profileId, roomId, signal, onEntry, onControl } = {}) {
    if (this.liveStop) throw new Error('Companion subscription already active');
    const profile = await this.discover();
    if (profile.id !== profileId || profile.roomId !== roomId) {
      throw Object.assign(new Error('Personal assistant selection changed'), {statusCode:409});
    }
    await this.getRoomMetadata();
    signal?.throwIfAborted();
    const binding = `__companionWatch_${randomUUID().replaceAll('-', '')}`;
    const socket = this.client.socket;
    if (!socket || typeof socket.addEventListener !== 'function' || typeof this.client.call !== 'function') {
      throw Object.assign(new Error('Desktop subscription transport unavailable'), {failureClass:'api_compatibility'});
    }
    let active = true;
    let refreshing = false;
    let dirty = false;
    let stopPromise;
    let startupTimer;
    let sawUpdate = false;
    const installation = Promise.withResolvers();
    const previous = new Map();
    const stop = () => {
      if (stopPromise) return stopPromise;
      active = false;
      clearTimeout(startupTimer);
      signal?.removeEventListener('abort', abort);
      socket.removeEventListener('message', receive);
      socket.removeEventListener('close', disconnected);
      socket.removeEventListener('error', disconnected);
      stopPromise = (async () => {
        await installation.promise;
        // The renderer cleanup owns only this retained topic listener. Closing
        // the CDP connection alone would leave it running in the desktop.
        if (this.client.socket === socket && socket.readyState === WebSocket.OPEN) {
          try { await this.client.evaluate(`(()=>{window[${JSON.stringify(binding + '_stop')}]?.();delete window[${JSON.stringify(binding + '_stop')}];delete window[${JSON.stringify(binding)}];})()`, 5000); } catch {}
          try { await this.client.call('Runtime.removeBinding', {name:binding}, 5000); } catch {}
        }
        if (this.liveStop === stop) this.liveStop = null;
      })();
      return stopPromise;
    };
    const control = reason => {
      if (!active) return;
      void stop();
      onControl?.({type:'stream.control',reason});
    };
    const abort = () => { void stop(); };
    const disconnected = () => control('reconnect');
    const refresh = async () => {
      dirty = true;
      if (refreshing || !active) return;
      refreshing = true;
      try {
        while (active && dirty) {
          dirty = false;
          // Coalesce notifications while a read is in flight into one further
          // read. No timer periodically reads messages or simulates deltas.
          await this.discover();
          if (!active) break;
          const page = await this.messages();
          if (!active) break;
          for (const entry of page.entries) {
            const fingerprint = JSON.stringify(entry);
            if (previous.get(entry.itemId) === fingerprint) continue;
            previous.delete(entry.itemId);
            previous.set(entry.itemId, fingerprint);
            if (previous.size > 128) previous.delete(previous.keys().next().value);
            onEntry?.(entry);
            if (!active) break;
          }
        }
      } catch { control('reconnect'); }
      finally { refreshing = false; }
    };
    const receive = event => {
      if (!active) return;
      let message, payload;
      try {
        message = JSON.parse(event.data);
        if (message.method !== 'Runtime.bindingCalled' || message.params?.name !== binding
            || typeof message.params.payload !== 'string' || message.params.payload.length > 512) return;
        payload = JSON.parse(message.params.payload);
      } catch { return; }
      if (payload?.kind === 'update') {
        sawUpdate = true;
        clearTimeout(startupTimer);
        void refresh();
      } else if (payload?.kind === 'control' && ['gap','terminal','reconnect'].includes(payload.reason)) control(payload.reason);
    };
    this.liveStop = stop;
    socket.addEventListener('message', receive);
    socket.addEventListener('close', disconnected);
    socket.addEventListener('error', disconnected);
    signal?.addEventListener('abort', abort, {once:true});
    try {
      await this.client.call('Runtime.addBinding', {name:binding});
      signal?.throwIfAborted();
      await this.invoke(`
${LOAD_MESSAGE_TOPIC}
if (!live.isCurrent()) throw Object.assign(new Error('Messaging account changed'), {failureClass:'account'});
const current = await api.safeGet('/tbo/primary', {retry:false});
if (current?.profile?.id !== params.profileId || current?.profile?.messaging_room_id !== params.roomId
    || current?.profile?.aeon_kind !== 'orbit' || current?.profile?.status !== 'active') {
  throw Object.assign(new Error('Personal assistant selection changed'), {failureClass:'account'});
}
const emit = event => window[params.binding](JSON.stringify(event));
window[params.binding + '_stop'] = (${attachCompanionMessageTopic.toString()})(live.topic, params.roomId, emit, live.isCurrent);
return {subscribed:true};`, {profileId,roomId,binding}, 30000, 'subscribe_messages');
      installation.resolve();
      signal?.throwIfAborted();
      if (!active) { await stop(); return stop; }
      if (!sawUpdate) startupTimer = setTimeout(() => control('reconnect'), 15000);
      return stop;
    } catch (error) {
      installation.resolve();
      await stop();
      throw error;
    }
  }

  async sendText({ profileId, roomId, text, requestId } = {}) {
    if (typeof profileId !== 'string' || !profileId.trim() || profileId.length > 512
        || typeof roomId !== 'string' || !roomId.trim() || roomId.length > 512
        || typeof text !== 'string' || !text.trim() || text.length > 20000
        || typeof requestId !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
      const error = new Error('Invalid Companion text request');
      error.statusCode = 400;
      throw error;
    }
    // This check runs in the same desktop evaluation as the POST, so a cached
    // profile or a previous service read cannot silently retarget a write.
    const result = await this.invoke(`
if (typeof api.safePost !== 'function') {
  throw Object.assign(new Error('Desktop Companion text API unavailable'), {status:422,failureClass:'api_compatibility'});
}
const current = await api.safeGet('/tbo/primary', {retry:false});
const p = current?.profile;
if (p?.id !== params.profileId || p?.messaging_room_id !== params.roomId
    || p?.aeon_kind !== 'orbit' || p?.status !== 'active') {
  return {identityChanged:true};
}
const message = await api.safePost('/messaging/rooms/{room_id}/messages', {
  parameters:{path:{room_id:params.roomId}},
  requestBody:{content:{text:params.text},request_id:params.requestId,
    idempotency_token:params.requestId,timezone_offset_min:new Date().getTimezoneOffset()},
  retry:false,signal:AbortSignal.timeout(25000)});
// Only a concrete server message identity confirms submission. Never substitute
// the request UUID or accept a receipt belonging to another room/request.
const valid = typeof message?.id === 'string' && message.id.trim() && message.id.length <= 512
  && (message.room_id == null || message.room_id === params.roomId)
  && (message.request_id == null || message.request_id === params.requestId);
return {itemId:valid ? 'room:' + message.id : null};`,
    { profileId, roomId, text, requestId }, 30000, 'send_text');
    if (result?.identityChanged) {
      const error = new Error('The personal assistant changed; refresh the conversation');
      error.statusCode = 409;
      throw error;
    }
    const itemId = typeof result?.itemId === 'string' && result.itemId.startsWith('room:')
      && result.itemId.length > 5 && result.itemId.length <= 517 ? result.itemId : null;
    return { requestId, state: itemId ? 'submitted' : 'uncertain', itemId };
  }

  async start({ sdp }) {
    if (this.callId) throw new Error('A personal assistant call is already allocated');
    if (typeof sdp !== 'string' || !sdp.startsWith('v=0') || sdp.length > 100000) throw new Error('Invalid SDP offer');
    const profile = await this.discover();
    const result = await this.invoke(`
const response = await api.postResponse('/tbo/{tbo_id}/voice/calls', {
  parameters:{path:{tbo_id:params.id}},requestBody:{sdp:params.sdp},retry:false,
  signal:AbortSignal.timeout(40000)});
const callId = response.headers.get('location')?.split('?')[0]?.split('/').at(-1);
if (!/^rtc_[^/?#]+$/.test(callId || '')) throw new Error('Invalid personal assistant call receipt');
const sdp = await response.text();
return {callId,sdp};`, { ...profile, sdp }, 45000, 'create');
    this.callId = result.callId;
    return result;
  }

  async attach() { return this.callAction('attach'); }

  async callAction(action) {
    if (action !== 'attach' && action !== 'stop') throw new Error('Unsupported personal assistant call action');
    if (!this.profile || !this.callId) throw new Error('No owned personal assistant call');
    return this.invoke(`
await api.safePost('/tbo/{tbo_id}/voice/calls/{call_id}/${action}', {
  parameters:{path:{tbo_id:params.id,call_id:params.callId}},retry:false});
return {ok:true};`, { id: this.profile.id, callId: this.callId }, 30000, action);
  }

  async stop() {
    if (!this.callId) return { ok: true };
    const result = await this.callAction('stop');
    this.callId = null;
    return result;
  }

  close() {
    if (this.liveStop) return this.liveStop().finally(() => this.client.close());
    this.client.close();
  }
}
