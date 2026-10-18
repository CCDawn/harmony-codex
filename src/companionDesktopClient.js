import { CodexDesktopCdpClient } from './codexDesktopCdpClient.js';
import { companionCallRecords } from './companionCallHistory.js';
import { annotateCompanionError } from './companionErrors.js';

// Resolve the exports from the running desktop build, not another installed build.
const LOAD_API = String.raw`
const entry = [...document.scripts].find(s => s.type === 'module' && s.src);
if (!entry) throw Object.assign(new Error('Desktop module entry unavailable'), {failureClass:'api_compatibility'});
const indexSource = await (await fetch(entry.src)).text();
// Desktop updates can relocate this client from shared to initial/primary.
// Only inspect asset names referenced by the active entry, never another build.
const assetNames = [...new Set(indexSource.match(/app-(?:shared|initial|primary)-[a-z0-9]+\.js/g) || [])];
let api;
for (const assetName of assetNames) {
  const assetUrl = new URL(assetName, entry.src).href;
  const source = await (await fetch(assetUrl)).text();
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

export function historyEntries(items, authors = null) {
  const roles = authors && new Map(authors.map(author => [author.accountUserId, author.role]));
  return (Array.isArray(items) ? items : [])
    .filter(item => !item.deleted_at && typeof item.content?.text === 'string' && item.content.text.trim())
    .filter(item => !roles || roles.has(item.account_user_id))
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))
    .map(item => ({ itemId: `room:${item.id}`, role: roles ? roles.get(item.account_user_id) : (item.role === 'user' ? 'user' : 'assistant'),
      text: item.content.text, final: true }));
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
      entries: historyEntries(response?.items, metadata.authors),
      calls: companionCallRecords(response?.items, metadata.authors),
      // This server can return null cursors on a full page. Its supported
      // `before=<oldest message id>` also retrieves non-overlapping older pages.
      nextCursor: typeof response?.prev_cursor === 'string' ? response.prev_cursor
        : items.length === 32 && typeof oldest?.id === 'string' ? oldest.id : null
    };
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

  close() { this.client.close(); }
}
