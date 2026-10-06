import { CodexDesktopCdpClient } from './codexDesktopCdpClient.js';

// Resolve the exports from the running desktop build, not another installed build.
const LOAD_API = `
const entry = [...document.scripts].find(s => s.type === 'module' && s.src);
if (!entry) throw new Error('Desktop module entry unavailable');
const indexSource = await (await fetch(entry.src)).text();
const assetName = indexSource.match(/app-shared-[a-z0-9]+\\.js/)?.[0];
if (!assetName) throw new Error('Desktop shared module unavailable');
const assetUrl = new URL(assetName, entry.src).href;
const source = await (await fetch(assetUrl)).text();
const internalName = source.match(/([A-Za-z_$][\\w$]*)\\.safeGet\\(\x60\\/tbo\\/primary\x60/)?.[1];
const escapedName = internalName?.replace(/[.*+?^$\x7b\x7d()|[\x5c\x5d\\\\]/g, '\\\\$&');
const exportedName = internalName && source.match(new RegExp('(?:[,{])' + escapedName + ' as ([A-Za-z_$][\\\\w$]*)'))?.[1];
if (!exportedName) throw new Error('Desktop Companion API export unavailable');
const module = await import(assetUrl);
const api = module[exportedName];
if (!api?.safeGet || !api?.postResponse) throw new Error('Desktop Companion API incompatible');
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

  async invoke(body, params = {}, timeoutMs = 30000) {
    await this.client.ensureConnected();
    const result = await this.client.evaluate(`(async()=>{try{${LOAD_API}\nconst params=${JSON.stringify(params)};\n${body}}catch(error){
return {__companionError:true,status:Number(error?.status)||0,name:String(error?.name||'Error')};}})()`, timeoutMs);
    if (result?.__companionError) {
      const error = new Error(`Companion ${result.status ? `HTTP ${result.status}` : result.name}`);
      error.status = result.status;
      throw error;
    }
    return result;
  }

  async discover() {
    const profile = await this.invoke(`
const result = await api.safeGet('/tbo/primary', {retry:false});
const p = result?.profile;
if (!p?.id || !p.messaging_room_id || p.aeon_kind !== 'orbit' || p.status !== 'active') {
  throw new Error('Active personal assistant messaging room unavailable');
}
return {id:p.id,name:p.display_name || '个人助手',roomId:p.messaging_room_id};`);
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
    const metadata = await this.getRoomMetadata();
    const response = await this.invoke(`
return await api.safeGet('/messaging/rooms/{room_id}/messages', {
  parameters:{path:{room_id:params.roomId},query:{limit:32,...(params.before ? {before:params.before} : {})}},
  retry:false});`, { roomId: this.profile.roomId, before: before || undefined });
    const items = Array.isArray(response?.items) ? response.items : [];
    const oldest = items.slice().sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))[0];
    return {
      entries: historyEntries(response?.items, metadata.authors),
      // This server can return null cursors on a full page. Its supported
      // `before=<oldest message id>` also retrieves non-overlapping older pages.
      nextCursor: typeof response?.prev_cursor === 'string' ? response.prev_cursor
        : items.length === 32 && typeof oldest?.id === 'string' ? oldest.id : null
    };
  }

  async start({ sdp }) {
    if (this.callId) throw new Error('A personal assistant call is already allocated');
    if (typeof sdp !== 'string' || !sdp.startsWith('v=0') || sdp.length > 100000) throw new Error('Invalid SDP offer');
    const profile = await this.discover();
    const result = await this.invoke(`
const response = await api.postResponse('/tbo/{tbo_id}/voice/calls', {
  parameters:{path:{tbo_id:params.id}},requestBody:{sdp:params.sdp},retry:false});
const callId = response.headers.get('location')?.split('?')[0]?.split('/').at(-1);
if (!/^rtc_[^/?#]+$/.test(callId || '')) throw new Error('Invalid personal assistant call receipt');
const sdp = await response.text();
return {callId,sdp};`, { ...profile, sdp });
    this.callId = result.callId;
    return result;
  }

  async attach() { return this.callAction('attach'); }

  async callAction(action) {
    if (!this.profile || !this.callId) throw new Error('No owned personal assistant call');
    return this.invoke(`
await api.safePost('/tbo/{tbo_id}/voice/calls/{call_id}/${action}', {
  parameters:{path:{tbo_id:params.id,call_id:params.callId}},retry:false});
return {ok:true};`, { id: this.profile.id, callId: this.callId });
  }

  async stop() {
    if (!this.callId) return { ok: true };
    const result = await this.callAction('stop');
    this.callId = null;
    return result;
  }

  close() { this.client.close(); }
}
