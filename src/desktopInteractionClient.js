import { CodexDesktopCdpClient } from './codexDesktopCdpClient.js';

// Native App Host facades carry their own generation guard. Legacy builds use
// the existing manager binding in the mounted UI provider; never create a
// manager, resume a thread, or start an independent app-server here.
const LOAD_MANAGER = String.raw`
const entry = [...document.scripts].find(script => script.type === 'module' && script.src);
if (!entry) throw Object.assign(new Error(), { code: 'DESKTOP_INTERACTIONS_UNAVAILABLE' });
let loader = window.__codexHarmonyDesktopInteractionRuntime;
if (!loader || loader.entryUrl !== entry.src || loader.discoveryVersion !== 2) {
  loader = { entryUrl: entry.src, discoveryVersion: 2 };
  loader.promise = (async () => {
    const indexSource = await (await fetch(entry.src)).text();
    const assetNames = [...new Set(indexSource.match(/app-(?:shared|initial|primary)-[a-z0-9]+\.js/g) || [])];
    for (const assetName of assetNames) {
      const assetUrl = new URL(assetName, entry.src).href;
      const source = await (await fetch(assetUrl)).text();
      const names = [...source.matchAll(/([A-Za-z_$][\w$]*)\??\.appServerManagers/g)].map(match => match[1]);
      // Import aliases elsewhere in the bundle can reuse an internal name.
      // Only its own export block maps that name to the public module export.
      const exportBlock = source.slice(Math.max(source.lastIndexOf('export{'), source.lastIndexOf('export {')));
      const exportNames = new Map([...exportBlock.matchAll(/([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/g)]
        .map(match => [match[1], match[2]]));
      const exportedName = internalName => exportNames.get(internalName);
      const candidateExports = [...new Set(names)].map(exportedName).filter(Boolean);
      // The official registry getter identifies the family independently of
      // minified variable/export names. Only already-created bindings are read.
      const familyName = source.match(/getForHostId\(([A-Za-z_$][\w$]*)\)\{return this\.scope\.get\([A-Za-z_$][\w$]*\)\.includes\(\1\)\?this\.scope\.get\(([A-Za-z_$][\w$]*),\1\):null\}/)?.[2];
      if (!candidateExports.length && !exportedName(familyName)) continue;
      const module = await import(assetUrl);
      const nativeExports = candidateExports.filter(name => typeof module[name]?.appServerManagers?.open === 'function');
      const managerFamily = familyName && module[exportedName(familyName)];
      if (!nativeExports.length && !managerFamily) continue;
      // Resolve the family used by the desktop's own skip action. Its existing
      // binding carries isSkipped/lastSubmission; never create a new binding.
      const questionStateName = source.match(/\.set\(([A-Za-z_$][\w$]*),[A-Za-z_$][\w$]*,\{\.\.\.[A-Za-z_$][\w$]*,isSkipped:!0\}\)/)?.[1];
      const questionStateFamily = questionStateName && module[exportedName(questionStateName)];
      return { module, nativeExports, managerFamily, questionStateFamily };
    }
    throw Object.assign(new Error(), { code: 'DESKTOP_INTERACTIONS_UNAVAILABLE' });
  })();
  window.__codexHarmonyDesktopInteractionRuntime = loader;
}
let discovery;
try { discovery = await loader.promise; }
catch (error) {
  if (window.__codexHarmonyDesktopInteractionRuntime === loader) delete window.__codexHarmonyDesktopInteractionRuntime;
  throw error;
}
let state = window.__codexHarmonyDesktopInteractions;
if (!state || state.discovery !== discovery) {
  state = { discovery, managers: new Map() };
  window.__codexHarmonyDesktopInteractions = state;
}
const key = JSON.stringify([params.hostId, params.threadId]);
let lease = state.managers.get(key);
const runtime = discovery.nativeExports.map(name => discovery.module[name])
  .find(value => typeof value?.appServerManagers?.open === 'function');
const requiredMethods = ['getConversation', 'replyWithCommandExecutionApprovalDecision',
  'replyWithFileChangeApprovalDecision', 'replyWithPermissionsRequestApprovalResponse',
  'replyWithUserInputResponse', 'sendFollowUpMessage'];
const validManager = manager => requiredMethods.every(name => typeof manager?.[name] === 'function');
const findLegacyOwner = () => {
  if (!discovery.managerFamily) return null;
  const root = window.__codexRoot?._internalRoot?.current;
  const pending = [root], seen = new Set();
  while (pending.length && seen.size < 20000) {
    const fiber = pending.pop();
    if (!fiber || seen.has(fiber)) continue;
    seen.add(fiber);
    const context = fiber.tag === 10 ? fiber.memoizedProps?.value : null;
    if (context instanceof Map) for (const owner of context.values()) {
      if (!(owner?.familyBindings instanceof Map)) continue;
      const members = owner.familyBindings.get(discovery.managerFamily);
      if (!(members instanceof Map)) continue;
      const binding = members.get(params.hostId)?.value;
      if (typeof binding?.get !== 'function') continue;
      const manager = binding.get();
      if (validManager(manager) && typeof manager.getHostId === 'function'
        && manager.getHostId() === params.hostId) return { owner, binding, manager };
    }
    pending.push(fiber.sibling, fiber.child);
  }
  return null;
};
let legacyOwner = null;
if (!runtime) {
  legacyOwner = findLegacyOwner();
  if (!legacyOwner) {
    state.managers.delete(key);
    throw Object.assign(new Error(), { code: params.operation === 'respond'
      ? 'DESKTOP_REQUEST_STALE' : 'DESKTOP_INTERACTIONS_UNAVAILABLE' });
  }
  if (!lease || lease.owner !== legacyOwner.owner || lease.binding !== legacyOwner.binding
    || lease.manager !== legacyOwner.manager) {
    lease = { ...legacyOwner, generation: crypto.randomUUID() };
    state.managers.set(key, lease);
  }
} else if (lease && lease.runtime !== runtime) {
  state.managers.delete(key);
  lease = null;
}
if (params.operation === 'respond' && (!lease || lease.generation !== params.request?.__desktopGeneration)) {
  throw Object.assign(new Error(), { code: 'DESKTOP_REQUEST_STALE' });
}
if (!lease) {
  const opened = await runtime.appServerManagers.open(params.hostId);
  if (opened?.status !== 'ready' || !validManager(opened.manager)) {
    throw Object.assign(new Error(), { code: 'DESKTOP_INTERACTIONS_UNAVAILABLE' });
  }
  lease = { runtime, manager: opened.manager, generation: crypto.randomUUID() };
  state.managers.set(key, lease);
}
let conversation;
try {
  conversation = await lease.manager.getConversation(params.threadId);
  if (legacyOwner) {
    const current = findLegacyOwner();
    if (!current || current.owner !== lease.owner || current.binding !== lease.binding
      || current.manager !== lease.manager) throw new Error('Legacy manager was replaced');
  }
} catch {
  state.managers.delete(key);
  throw Object.assign(new Error(), { code: params.operation === 'respond' ? 'DESKTOP_REQUEST_STALE' : 'DESKTOP_INTERACTIONS_UNAVAILABLE' });
}
// Canonical pages and optimistic desktop items coexist. Only request metadata,
// file-change content and question fields leave this renderer, never chat text.
const conversationTurns = conversation => {
const history = conversation?.turnHistory?.kind === 'canonical' ? conversation.turnHistory.history : null;
const canonicalTurns = history?.islands?.flatMap(island => island.entries.map(entry => history.entitiesByKey[entry.value])) ?? [];
const turnsById = new Map();
for (const [index, turn] of [...canonicalTurns, ...(conversation?.turns ?? [])].entries()) {
  if (!turn) continue;
  const key = turn.turnId ?? 'unbound:' + index;
  const prior = turnsById.get(key);
  const items = new Map((prior?.items ?? []).map((item, i) => [item.id ?? 'prior:' + i, item]));
  for (const [i, item] of (turn.items ?? []).entries()) items.set(item.id ?? 'current:' + i, item);
  turnsById.set(key, { ...prior, ...turn, items: [...items.values()] });
}
return [...turnsById.values()];
};
const turns = conversationTurns(conversation);
const allItems = turns.flatMap(turn => turn.items ?? []);
const nativeRequests = (Array.isArray(conversation?.requests) ? conversation.requests : [])
  .filter(request => request?.params?.threadId === params.threadId && request.completed !== true);
const requests = nativeRequests.map(request => {
  const extra = { __desktopGeneration: lease.generation };
  if (request.method === 'item/fileChange/requestApproval') {
    const item = turns.filter(turn => turn.turnId === request.params.turnId)
      .flatMap(turn => turn.items ?? []).find(item => item.type === 'fileChange' && item.id === request.params.itemId);
    extra.__fileChanges = item?.changes ?? null;
  }
  return { ...request, ...extra };
});
const answered = new Set();
const decodeAsyncReplies = text => {
  const start = '<send_user_message_question_reply>', end = '</send_user_message_question_reply>';
  if (!text.startsWith(start) || !text.endsWith(end)) return null;
  try {
    const decoded = JSON.parse(text.slice(start.length, -end.length));
    const answers = Array.isArray(decoded) ? decoded : [decoded];
    return answers.length && answers.every(answer => answer && typeof answer === 'object'
      && typeof answer.questionItemId === 'string' && typeof answer.question === 'string'
      && typeof answer.answer === 'string') ? answers : null;
  } catch { return null; }
};
for (const item of allItems) {
  if (item.type === 'steeringUserMessage' && item.status !== 'accepted') continue;
  const input = item.type === 'userMessage' ? item.content : item.type === 'steeringUserMessage' ? item.input : null;
  if (!Array.isArray(input) || input.length !== 1 || input[0]?.type !== 'text') continue;
  const text = String(input[0].text ?? '').trim();
  for (const answer of decodeAsyncReplies(text) ?? []) answered.add(answer.questionItemId);
}
const seenQuestions = new Set();
// The desktop derives async waiting from the newest inProgress turn, not from
// historical question-shaped messages. Completed/interrupted questions remain
// history even if no structured reply envelope was ever submitted.
const activeTurn = [...turns].reverse().find(turn => turn.status === 'inProgress' && turn.turnId);
const questionStates = new Map();
if (activeTurn?.items?.some(item => item.type === 'agentMessage' && Array.isArray(item.questions)
  && item.questions.length) && discovery.questionStateFamily) {
  const pending = [window.__codexRoot?._internalRoot?.current], seen = new Set(), owners = new Set();
  while (pending.length && seen.size < 20000) {
    const fiber = pending.pop();
    if (!fiber || seen.has(fiber)) continue;
    seen.add(fiber);
    const context = fiber.tag === 10 ? fiber.memoizedProps?.value : null;
    if (context instanceof Map) for (const owner of context.values()) {
      if (owners.has(owner) || !(owner?.familyBindings instanceof Map)) continue;
      owners.add(owner);
      const members = owner.familyBindings.get(discovery.questionStateFamily);
      if (!(members instanceof Map)) continue;
      for (const [serializedKey, entry] of members) {
        let scope;
        try { scope = typeof serializedKey === 'string' ? JSON.parse(serializedKey) : serializedKey; }
        catch { continue; }
        if (scope?.hostId !== params.hostId || scope?.threadId !== params.threadId
          || scope?.entityKey !== 'turn:' + activeTurn.turnId || typeof entry?.value?.get !== 'function') continue;
        const value = entry.value.get();
        if (value?.turnId === activeTurn.turnId) questionStates.set(scope.itemId, value);
      }
    }
    pending.push(fiber.sibling, fiber.child);
  }
}
for (const turn of activeTurn ? [activeTurn] : []) {
  for (const item of turn.items ?? []) {
    if (item.type !== 'agentMessage' || !Array.isArray(item.questions)) continue;
    const questions = [];
    for (const [index, question] of item.questions.entries()) {
      const id = JSON.stringify(['request_user_input_async', item.id, index]);
      const officialState = questionStates.get(id);
      if (answered.has(id) || seenQuestions.has(id) || typeof question.title !== 'string'
        || officialState?.isSkipped === true || officialState?.lastSubmission != null) continue;
      seenQuestions.add(id);
      questions.push({ id, header: '', question: question.title, isOther: true, isSecret: false,
        options: (question.options ?? []).filter(option => typeof option === 'string')
          .map(label => ({ label, description: '' })) });
    }
    if (questions.length && turn.turnId) requests.push({
      id: JSON.stringify(['async', turn.turnId, item.id]), method: 'desktop/asyncUserInput',
      params: { threadId: params.threadId, turnId: turn.turnId, itemId: item.id, questions },
      __desktopGeneration: lease.generation
    });
  }
}
`;

const RESPOND = String.raw`
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical(value[key])]));
  return value;
};
const pending = requests.find(request => request.id === params.request.id);
if (!pending || pending.completed === true
  || JSON.stringify(canonical(pending)) !== JSON.stringify(canonical(params.request))) {
  throw Object.assign(new Error(), { code: 'DESKTOP_REQUEST_STALE' });
}
const confirmProcessed = async predicate => {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    let snapshot;
    let timeout;
    try {
      snapshot = await Promise.race([lease.manager.getConversation(params.threadId),
        new Promise((_, reject) => { timeout = setTimeout(reject, Math.max(1, deadline - Date.now())); })]);
    } catch {
      state.managers.delete(key);
      throw Object.assign(new Error(), { code: 'DESKTOP_RESPONSE_UNCONFIRMED' });
    } finally { clearTimeout(timeout); }
    if (snapshot && predicate(snapshot)) return { ok: true, requestId: pending.id };
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw Object.assign(new Error(), { code: 'DESKTOP_RESPONSE_UNCONFIRMED' });
};
if (pending.method === 'desktop/asyncUserInput') {
  if (typeof lease.manager.sendFollowUpMessage !== 'function') {
    throw Object.assign(new Error(), { code: 'DESKTOP_REQUEST_UNSUPPORTED' });
  }
  const replies = pending.params.questions.map(question => ({ questionItemId: question.id,
    question: question.question, answer: (params.result.answers[question.id]?.answers ?? []).join('\n') }));
  const prompt = '<send_user_message_question_reply>\n' + JSON.stringify(replies)
    + '\n</send_user_message_question_reply>';
  // This official entrypoint inherits the thread configuration and lets the
  // desktop coordinator steer the active turn or start a follow-up in the same
  // thread, exactly as its send-now async-question UI does.
  await lease.manager.sendFollowUpMessage(params.threadId, {
    prompt, turnTrigger: 'send_user_message_async_question', usePermissionSelection: false
  });
  return await confirmProcessed(snapshot => {
    let receipt = false;
    for (const item of conversationTurns(snapshot).flatMap(turn => turn.items ?? [])) {
      if (item.type === 'steeringUserMessage' && item.status !== 'accepted') continue;
      const input = item.type === 'userMessage' ? item.content : item.type === 'steeringUserMessage' ? item.input : null;
      if (!Array.isArray(input) || input.length !== 1 || input[0]?.type !== 'text') continue;
      const decoded = decodeAsyncReplies(String(input[0].text ?? '').trim());
      if (!decoded) continue;
      for (const answer of decoded) {
        const expected = replies.find(reply => reply.questionItemId === answer.questionItemId);
        if (expected && (expected.question !== answer.question || expected.answer !== answer.answer)) {
          throw Object.assign(new Error(), { code: 'DESKTOP_ASYNC_ANSWER_CONFLICT' });
        }
      }
      if (JSON.stringify(canonical(decoded)) === JSON.stringify(canonical(replies))) receipt = true;
    }
    return receipt;
  });
}
const methods = {
  'item/commandExecution/requestApproval': 'replyWithCommandExecutionApprovalDecision',
  'item/fileChange/requestApproval': 'replyWithFileChangeApprovalDecision',
  'item/permissions/requestApproval': 'replyWithPermissionsRequestApprovalResponse',
  'item/tool/requestUserInput': 'replyWithUserInputResponse'
};
const method = methods[pending.method];
if (!method || typeof lease.manager[method] !== 'function') {
  throw Object.assign(new Error(), { code: 'DESKTOP_REQUEST_UNSUPPORTED' });
}
const result = pending.method === 'item/commandExecution/requestApproval'
  || pending.method === 'item/fileChange/requestApproval' ? params.result.decision : params.result;
await lease.manager[method](params.threadId, pending.id, result);
return await confirmProcessed(snapshot => Array.isArray(snapshot.requests)
  && !snapshot.requests.some(request => request.id === pending.id && request.completed !== true));
`;

export class DesktopInteractionClient {
  constructor(client = new CodexDesktopCdpClient(), options = {}) {
    this.client = client;
    this.hostId = options.hostId ?? client.hostId ?? 'local';
  }

  async listRequests(threadId) {
    return this.invoke({ operation: 'list', threadId }, 'return requests;');
  }

  async respond(threadId, request, result) {
    if (!request || typeof request !== 'object' || !result || typeof result !== 'object') {
      throw interactionError('DESKTOP_REQUEST_INVALID', 400);
    }
    return this.invoke({ operation: 'respond', threadId, request, result }, RESPOND);
  }

  async invoke(params, body) {
    if (typeof params.threadId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(params.threadId)) {
      throw interactionError('DESKTOP_REQUEST_INVALID', 400);
    }
    await this.client.ensureConnected();
    const response = await this.client.evaluate(`(async()=>{try{
      const params=${JSON.stringify({ ...params, hostId: this.hostId })};
      ${LOAD_MANAGER}
      ${body}
    }catch(error){return {__desktopInteractionError:true,code:error?.code || 'DESKTOP_INTERACTIONS_UNAVAILABLE'};}})()`);
    if (response?.__desktopInteractionError) {
      const code = response.code;
      throw interactionError(code, code === 'DESKTOP_REQUEST_STALE' || code === 'DESKTOP_ASYNC_ANSWER_CONFLICT' ? 409
        : code === 'DESKTOP_REQUEST_UNSUPPORTED' ? 422 : 503);
    }
    return response;
  }

  close() { this.client.close?.(); }
}

function interactionError(code, statusCode) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
