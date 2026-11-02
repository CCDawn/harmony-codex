import { nativeContinueLatestTurn } from './nativeContinueEligibility.js';

// Self-contained: injected into the already mounted renderer lease. Only the
// newest contiguous canonical island and explicitly supported complete turns
// can leave the renderer. Never serialize the conversation or submission params.
export function projectCanonicalSessionTail(conversation, threadId, limits = {}) {
  const maxTurns = Math.max(1, Math.min(4, limits.maxTurns ?? 4));
  const maxItems = Math.max(1, Math.min(256, limits.maxItems ?? 256));
  const maxBytes = Math.max(1, Math.min(512 * 1024, limits.maxBytes ?? 512 * 1024));
  const empty = diagnostic => ({ threadId, source: 'mounted-canonical', turns: [], boundary: null, diagnostic });
  const history = conversation?.turnHistory?.kind === 'canonical' ? conversation.turnHistory.history : null;
  if (conversation?.id !== threadId) return empty('projection_thread_mismatch');
  const entries = history?.islands?.at(-1)?.entries;
  if (!Array.isArray(entries) || !entries.length) return empty('projection_unavailable');
  const terminal = status => ['completed', 'interrupted', 'failed'].includes(status);
  const meta = value => {
    const id = value?.turnId ?? value?.id;
    if (typeof id !== 'string' || !id || id.length > 200 || typeof value.status !== 'string' || value.status.length > 32) return null;
    const startedAt = Number.isFinite(value.turnStartedAtMs) ? value.turnStartedAtMs / 1000 : value.startedAt;
    return { id, status: value.status, ...(typeof startedAt === 'string' && startedAt.length <= 100 || Number.isFinite(startedAt) ? { startedAt } : {}),
      ...(typeof value.updatedAt === 'string' && value.updatedAt.length <= 100 || Number.isFinite(value.updatedAt) ? { updatedAt: value.updatedAt } : {}) };
  };
  let itemCount = 0, textBytes = 0;
  const fitsText = text => {
    if (typeof text !== 'string' || text.length > maxBytes) return false;
    textBytes += new TextEncoder().encode(text).byteLength;
    return textBytes <= maxBytes;
  };
  const turns = [], seen = new Set();
  let boundary = null;
  for (let index = entries.length - 1; index >= 0; index--) {
    const value = history?.entitiesByKey?.[entries[index]?.value];
    const metadata = meta(value);
    if (turns.length === maxTurns) { boundary = metadata; break; }
    const items = [];
    let error;
    let supported = metadata && terminal(metadata.status) && Array.isArray(value.items);
    if (supported && value.items.length + itemCount > maxItems) return empty('projection_limit');
    if (value?.error != null) {
      supported &&= fitsText(value.error.message)
        && (value.error.codexErrorInfo == null || typeof value.error.codexErrorInfo === 'string');
      if (supported) error = { message: value.error.message, ...(value.error.codexErrorInfo != null
        ? { codexErrorInfo: value.error.codexErrorInfo } : {}) };
    }
    const itemIds = new Set();
    for (const item of supported ? value.items : []) {
      if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 200 || itemIds.has(item.id)) { supported = false; break; }
      itemIds.add(item.id);
      // Desktop's error row is synthetic; official ThreadTurn carries it as
      // turn.error, rather than a ThreadItem. Require the same terminal error.
      if (item.type === 'error') {
        if (metadata.status !== 'failed' || item.willRetry !== false || !error
          || error.message !== item.message || (item.errorInfo != null && item.errorInfo !== error.codexErrorInfo)) { supported = false; break; }
        continue;
      }
      const mapped = { id: item.id, type: item.type };
      if (item.type === 'userMessage' && Array.isArray(item.content) && item.content.length) {
        if (item.content.length > 256) return empty('projection_limit');
        mapped.content = [];
        for (const part of item.content) {
          if (part?.type !== 'text' || !fitsText(part.text)
            || part.text_elements != null && (!Array.isArray(part.text_elements) || part.text_elements.length !== 0)) {
            supported = false; break;
          }
          mapped.content.push({ type: 'text', text: part.text, text_elements: [] });
        }
        if (!supported) break;
        if (typeof item.clientId === 'string' && item.clientId.length <= 200) mapped.clientId = item.clientId;
      } else if (item.type === 'agentMessage' && fitsText(item.text)
        && (!item.questions || Array.isArray(item.questions) && item.questions.length === 0)) {
        mapped.text = item.text;
        if (item.phase != null) {
          if (!['commentary', 'final_answer'].includes(item.phase)) { supported = false; break; }
          mapped.phase = item.phase;
        }
      } else { supported = false; break; }
      for (const name of ['startedAtMs', 'completedAtMs']) if (Number.isFinite(item[name])) mapped[name] = item[name];
      items.push(mapped);
    }
    if (!supported || seen.has(metadata.id)) {
      if (!turns.length) return empty('projection_unsupported_turn');
      boundary = metadata;
      break;
    }
    itemCount += value.items.length;
    if (itemCount > maxItems) return empty('projection_limit');
    seen.add(metadata.id);
    turns.unshift({ ...metadata, itemsView: 'full', items, ...(error ? { error } : {}) });
    const candidate = { threadId, source: 'mounted-canonical', turns, boundary: null };
    if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength > maxBytes) return empty('projection_limit');
  }
  const result = { threadId, source: 'mounted-canonical', turns, boundary };
  return new TextEncoder().encode(JSON.stringify(result)).byteLength <= maxBytes ? result : empty('projection_limit');
}

const terminal = status => ['completed', 'interrupted', 'failed'].includes(status);
const time = value => {
  if (value === undefined || value === null || value === '') return NaN;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric > 10_000_000_000 ? numeric : numeric * 1000 : Date.parse(value);
};

// Input page is already validated, ordered oldest -> newest. Its opaque cursors
// are deliberately outside this helper. The official canonical predecessor is
// an anchor: timestamps alone must not hide an unsupported or unloaded gap.
export function mergeRecentSessionProjection(threadId, pageTurns, projection) {
  const fallback = diagnostic => ({ turns: pageTurns, addedTurnIds: [], diagnostic });
  if (projection?.threadId !== threadId || projection.source !== 'mounted-canonical') return fallback('projection_thread_mismatch');
  if (!Array.isArray(projection.turns) || projection.turns.length > 4
    || Buffer.byteLength(JSON.stringify(projection)) > 512 * 1024) return fallback('projection_limit');
  if (!projection.turns.length) return fallback(['projection_unavailable', 'projection_timeout', 'projection_unsupported_turn',
    'projection_limit', 'projection_thread_mismatch'].includes(projection.diagnostic)
    ? projection.diagnostic : 'projection_unavailable');
  const native = projection.turns;
  const ids = new Set();
  let items = 0;
  for (const value of native) {
    if (!value || typeof value.id !== 'string' || !value.id || ids.has(value.id) || !terminal(value.status)
      || value.itemsView !== 'full' || !Array.isArray(value.items)
      || value.items.some(item => !item || typeof item.id !== 'string' || !item.id
        || !['userMessage', 'agentMessage'].includes(item.type))
      || new Set(value.items.map(item => item.id)).size !== value.items.length) return fallback('projection_unsupported_turn');
    ids.add(value.id); items += value.items.length;
  }
  if (items > 256) return fallback('projection_limit');
  const latestPage = pageTurns.at(-1), latestNative = native.at(-1);
  if (latestPage) {
    const latest = nativeContinueLatestTurn({ turns: pageTurns, latestTurn: latestNative });
    if (!latest) return fallback('projection_order_ambiguous');
    if (latestPage.id !== latestNative.id && latest.id === latestPage.id) return fallback('projection_older');
  }
  for (let index = 1; index < native.length; index++) {
    const latest = nativeContinueLatestTurn({ turns: [native[index - 1]], latestTurn: native[index] });
    if (!latest || latest.id !== native[index].id) return fallback('projection_order_ambiguous');
  }
  const pageIds = new Set(pageTurns.map(value => value.id));
  const additions = native.filter(value => !pageIds.has(value.id));
  if (additions.length) {
    if (!latestPage || !native.some(value => value.id === latestPage.id) && projection.boundary?.id !== latestPage.id) {
      return fallback('projection_unanchored');
    }
    for (const value of additions) {
      const latest = nativeContinueLatestTurn({ turns: [latestPage], latestTurn: value });
      if (!latest || latest.id !== value.id) return fallback('projection_order_ambiguous');
    }
  }
  const nativeById = new Map(native.map(value => [value.id, value]));
  const turns = pageTurns.map(page => {
    const value = nativeById.get(page.id);
    if (!value) return page;
    const nativeIds = value.items.map(item => item.id), pageItemIds = new Set(page.items.map(item => item.id));
    const common = nativeIds.filter(id => pageItemIds.has(id));
    const nativeSet = new Set(nativeIds);
    if (JSON.stringify(common) !== JSON.stringify(page.items.filter(item => nativeSet.has(item.id)).map(item => item.id))) return page;
    const firstNew = nativeIds.findIndex(id => !pageItemIds.has(id));
    if (firstNew >= 0 && nativeIds.slice(firstNew).some(id => pageItemIds.has(id))) return page;
    const isLater = Number.isFinite(time(value.updatedAt)) && Number.isFinite(time(page.updatedAt))
      && time(value.updatedAt) > time(page.updatedAt);
    const completesLive = terminal(value.status) && !terminal(page.status);
    const replaceExisting = isLater || completesLive;
    const byId = new Map(value.items.map(item => [item.id, item]));
    return { ...(replaceExisting ? { ...page, ...value } : page), items: [
      ...page.items.map(item => replaceExisting ? byId.get(item.id) ?? item : item),
      ...value.items.filter(item => !pageItemIds.has(item.id))
    ] };
  });
  return { turns: [...turns, ...additions], addedTurnIds: additions.map(value => value.id) };
}
