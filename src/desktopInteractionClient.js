import { CodexDesktopCdpClient } from './codexDesktopCdpClient.js';
import { DESKTOP_MODULE_GRAPH_LOADER } from './desktopModuleGraph.js';
import { NATIVE_CONTINUE_DESKTOP } from './nativeContinueDesktop.js';
import { projectCanonicalSessionTail } from './recentSessionProjection.js';

const DIAGNOSTIC_STAGES = new Set(['entry', 'asset-discovery', 'mounted-manager',
  'mounted-manager-ambiguous', 'mounted-manager-scan-timeout', 'manager-open', 'conversation-read', 'renderer', 'transport']);

// Native App Host facades carry their own generation guard. Legacy builds use
// the existing manager binding in the mounted UI provider; never create a
// manager, resume a thread, or start an independent app-server here.
const LOAD_MANAGER = String.raw`
const entry = [...document.scripts].find(script => script.type === 'module' && script.src);
if (!entry) throw Object.assign(new Error(), { code: 'DESKTOP_INTERACTIONS_UNAVAILABLE', stage: 'entry' });
let loader = window.__codexHarmonyDesktopInteractionRuntime;
if (!loader || loader.entryUrl !== entry.src || loader.discoveryVersion !== 9) {
  loader = { entryUrl: entry.src, discoveryVersion: 9 };
  loader.promise = (async () => {
    let fallback = { module: {}, nativeExports: [], managerFamily: null, hostFamily: null, questionStateFamily: null, questionInitializer: null,
      questionFlattener: null, questionAnswerReader: null, questionHelperFamily: null };
    ${DESKTOP_MODULE_GRAPH_LOADER}
    for await (const {assetUrl, source} of activeDesktopModules()) {
      const names = [...source.matchAll(/([A-Za-z_$][\w$]*)\??\.appServerManagers/g)].map(match => match[1]);
      // Import aliases elsewhere in the bundle can reuse an internal name.
      // Only its own export block maps that name to the public module export.
      const exportBlock = source.slice(Math.max(source.lastIndexOf('export{'), source.lastIndexOf('export {')));
      const exportNames = new Map([...exportBlock.matchAll(/([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/g)]
        .map(match => [match[1], match[2]]));
      const exportedName = internalName => exportNames.get(internalName);
      // The start-turn wrapper's writing-block context helper is exported from
      // the active graph. Resolve its semantics, never a build hash or alias.
      const continueContextName = source.includes('codex-writing-block-deleted-thread-v1:')
        ? source.match(/function\s+([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{return\s+\3==null\?\4:[A-Za-z_$][\w$]*\(\2,\3,[A-Za-z_$][\w$]*=>[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*,void 0\),\4,!0\)\}/)?.[1] : null;
      const candidateExports = [...new Set(names)].map(exportedName).filter(Boolean);
      // The official registry getter identifies the family independently of
      // minified variable/export names. Only already-created bindings are read.
      const familyName = source.match(/getForHostId\(([A-Za-z_$][\w$]*)\)\{return this\.scope\.get\([A-Za-z_$][\w$]*\)\.includes\(\1\)\?this\.scope\.get\(([A-Za-z_$][\w$]*),\1\):null\}/)?.[2];
      // Question state remains independent of how this desktop exposes its
      // manager. Newer bundles import the native facade and omit the registry
      // getter, while their mounted question-state family is still exported.
      const questionStateName = source.match(/\.set\(([A-Za-z_$][\w$]*),[A-Za-z_$][\w$]*,\{\.\.\.[A-Za-z_$][\w$]*,isSkipped:!0\}\)/)?.[1];
      // Resolve the same exported synchronizer and its two data helpers used by
      // Desktop. Require recognizable function semantics, not minified names.
      const initializer = [...source.matchAll(/function\s+([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{let\{turnId:[A-Za-z_$][\w$]*,questions:[A-Za-z_$][\w$]*,answersByQuestionItemId:[A-Za-z_$][\w$]*\}=\4;/g)]
        .find(match => {
          const end = source.indexOf('function ', match.index + match[0].length);
          const body = source.slice(match.index, end < 0 ? match.index + 6000 : end);
          return questionStateName && body.includes(questionStateName + '.resolve(' + match[2] + '.node,' + match[2] + '.chain,')
            && body.includes(match[2] + '.set(' + questionStateName + ',');
        })?.[1];
      const flattenDetail = source.match(/function\s+([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{return\s+\3\.map\(\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)=>\(\{id:[A-Za-z_$][\w$]*\(\2,\5\),sourceItemId:\2,questionIndex:\5,title:\4\.title,options:\4\.options\?\?\[\]\}\)\)\}/)?.[1];
      let flattener;
      if (flattenDetail) {
        const escape = value => value.replace(/[^A-Za-z0-9_]/g, '\\$&');
        const id = '[A-Za-z_$][\\w$]*';
        const mapItem = source.match(new RegExp('function\\s+(' + id + ')\\((' + id + ')\\)\\{return\\s+' + id + '\\(\\2\\)\\?' + escape(flattenDetail) + '\\(\\2\\.id,\\2\\.questions\\):\\[\\]\\}'))?.[1];
        if (mapItem) flattener = source.match(new RegExp('function\\s+(' + id + ')\\((' + id + ')\\)\\{return\\s+\\2\\.flatMap\\((' + id + ')=>'+ id + '\\(\\3\\)\\?' + escape(mapItem) + '\\(\\3\\):\\[\\]\\)\\}'))?.[1];
      }
      const answerReader = [...source.matchAll(/function\s+([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{let\s+[A-Za-z_$][\w$]*=new Set\(\2\.flatMap\(/g)]
        .find(match => {
          const end = source.indexOf('function ', match.index + match[0].length);
          const body = source.slice(match.index, end < 0 ? match.index + 6000 : end);
          return body.includes('answersByQuestionItemId:new Map(') && body.includes('replyItemIds:new Set(')
            && body.includes('steeringUserMessage') && body.includes('accepted');
        })?.[1];
      // The skip, draft and panel helpers must come from the same module as the
      // discovered native question family, including its derived group atoms.
      let skipFunction, draftFunction, selectFunction, closeFunction, selectedFamily, busyFamily;
      if (questionStateName && initializer) {
        const start = source.indexOf('function ' + initializer + '(');
        const segment = source.slice(start, Math.min(source.length, start + 10000));
        const functions = [...segment.matchAll(/function\s+([A-Za-z_$][\w$]*)\([^)]*\)\{/g)];
        for (let i = 0; i < functions.length; i++) {
          const name = functions[i][1];
          const body = segment.slice(functions[i].index, functions[i + 1]?.index ?? segment.length);
          const readsQuestion = body.includes('.get(' + questionStateName + ',');
          if (!readsQuestion) continue;
          if (body.includes('isSkipped:!0') && body.includes('.set(' + questionStateName + ',')) skipFunction = name;
          if (body.includes('.draft!==') && body.includes('draft:') && body.includes('.set(' + questionStateName + ',')) draftFunction = name;
          if (body.includes('.questionIds.includes(') && body.includes('.selectedQuestionKey.entityKey===')) {
            selectFunction = name;
            selectedFamily = body.match(/\.get\(([A-Za-z_$][\w$]*),[A-Za-z_$][\w$]*\)/)?.[1];
          }
          if (body.includes('?.entityKey===') && body.includes('.itemId===') && body.includes(',null)')) closeFunction = name;
        }
        const busy = [...segment.matchAll(/([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*,\(([A-Za-z_$][\w$]*),\{get:([A-Za-z_$][\w$]*)\}\)=>\3\([A-Za-z_$][\w$]*,\2\)\.some\(([A-Za-z_$][\w$]*)=>\3\(([A-Za-z_$][\w$]*),\{\.\.\.\2,itemId:\4\}\)\?\.isSubmitting===!0\)/g)]
          .find(match => match[5] === questionStateName);
        busyFamily = busy?.[1];
      }
      if (candidateExports.length || exportedName(familyName) || exportedName(questionStateName)
        || exportedName(initializer) || exportedName(flattener) || exportedName(answerReader) || exportedName(continueContextName)) {
        const module = await import(assetUrl);
        if (continueContextName && typeof module[exportedName(continueContextName)] === 'function') {
          fallback.continueContext = module[exportedName(continueContextName)];
        }
        const nativeExports = candidateExports.filter(name => typeof module[name]?.appServerManagers?.open === 'function');
        const managerFamily = familyName && module[exportedName(familyName)];
        const questionStateFamily = questionStateName && module[exportedName(questionStateName)];
        if (questionStateFamily) fallback.questionStateFamily = questionStateFamily;
        if (questionStateFamily && typeof module[exportedName(initializer)] === 'function'
          && typeof module[exportedName(flattener)] === 'function' && typeof module[exportedName(answerReader)] === 'function') {
          fallback.questionInitializer = module[exportedName(initializer)];
          fallback.questionFlattener = module[exportedName(flattener)];
          fallback.questionAnswerReader = module[exportedName(answerReader)];
          fallback.questionHelperFamily = questionStateFamily;
        }
        if (questionStateFamily && [skipFunction, draftFunction, selectFunction, closeFunction]
          .every(name => typeof module[exportedName(name)] === 'function')
          && module[exportedName(selectedFamily)] && module[exportedName(busyFamily)]) {
          fallback.questionActions = { family: questionStateFamily, skip: module[exportedName(skipFunction)],
            draft: module[exportedName(draftFunction)], select: module[exportedName(selectFunction)],
            close: module[exportedName(closeFunction)], selected: module[exportedName(selectedFamily)],
            busy: module[exportedName(busyFamily)] };
        }
        if (nativeExports.length || managerFamily) fallback = { ...fallback, module, nativeExports, managerFamily };
      }
      // The connection publisher identifies the imported family used for the
      // ready host/RPC pair. Resolve that import from the active module graph.
      if (!/\/renderer-app-server-managers-[a-z0-9_-]+\.js$/i.test(new URL(assetUrl).pathname)) continue;
      const identifiers = [...source.matchAll(/\.set\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*,\s*\{\s*status\s*:\s*([\x60'\"])ready\3\s*,\s*client\s*:\s*\{\s*hostId\s*:\s*\2\s*,\s*rpc\s*:\s*[A-Za-z_$][\w$]*\s*\}\s*\}\s*\)/g)]
        .map(match => match[1]);
      if (!identifiers.length) continue;
      const families = [...new Set(identifiers)];
      if (families.length !== 1) throw new Error('Ambiguous host family');
      const imports = [];
      for (const match of source.matchAll(/\bimport\s*\{([^{}]*)\}\s*from\s*([\x60'\"])([^\x60'\"]+)\2/g)) {
        for (const spec of match[1].split(',')) {
          const binding = spec.trim().match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
          if (binding && (binding[2] ?? binding[1]) === families[0]) imports.push({ name: binding[1], url: new URL(match[3], assetUrl).href });
        }
      }
      if (imports.length !== 1) continue;
      for await (const dependency of activeDesktopModules()) {
        if (dependency.assetUrl !== imports[0].url) continue;
        const assetUrl = dependency.assetUrl;
        const module = await import(assetUrl);
        const hostFamily = module[imports[0].name];
        if (!hostFamily) break;
        if (fallback.hostFamily && fallback.hostFamily !== hostFamily) throw new Error('Ambiguous host family');
        fallback.hostFamily = hostFamily;
        break;
      }
    }
    return fallback;
  })();
  window.__codexHarmonyDesktopInteractionRuntime = loader;
}
let discovery;
try { discovery = await loader.promise; }
catch (error) {
  if (window.__codexHarmonyDesktopInteractionRuntime === loader) delete window.__codexHarmonyDesktopInteractionRuntime;
  throw Object.assign(new Error(), { code: 'DESKTOP_INTERACTIONS_UNAVAILABLE', stage: 'asset-discovery' });
}
let state = window.__codexHarmonyDesktopInteractions;
if (!state || state.discovery !== discovery) {
  state = { discovery, managers: new Map(), bindingIds: new WeakMap() };
  window.__codexHarmonyDesktopInteractions = state;
}
state.bindingIds ??= new WeakMap();
const bindingId = value => {
  if (!state.bindingIds.has(value)) state.bindingIds.set(value, crypto.randomUUID());
  return state.bindingIds.get(value);
};
const key = JSON.stringify([params.hostId, params.threadId]);
let lease = state.managers.get(key);
const requiredMethods = ['getConversation', 'replyWithCommandExecutionApprovalDecision',
  'replyWithFileChangeApprovalDecision', 'replyWithPermissionsRequestApprovalResponse',
  'replyWithUserInputResponse', 'sendFollowUpMessage'];
const validManager = manager => requiredMethods.every(name => typeof manager?.[name] === 'function');
let mountedLookupStage = 'mounted-manager';
const assertMountedTime = deadline => {
  if (Date.now() >= deadline) throw Object.assign(new Error(), {
    code: params.operation === 'respond' ? 'DESKTOP_REQUEST_STALE' : 'DESKTOP_INTERACTIONS_UNAVAILABLE',
    stage: 'mounted-manager-scan-timeout'
  });
};
function* mountedOwners(deadline) {
  const pending = [window.__codexRoot?._internalRoot?.current], seen = new Set(), owners = new Set();
  while (pending.length) {
    assertMountedTime(deadline);
    const fiber = pending.pop();
    if (!fiber || seen.has(fiber)) continue;
    seen.add(fiber);
    const context = fiber.tag === 10 ? fiber.memoizedProps?.value : null;
    if (context instanceof Map) for (const owner of context.values()) {
      assertMountedTime(deadline);
      if (owners.has(owner) || !(owner?.familyBindings instanceof Map)) continue;
      owners.add(owner);
      yield owner;
    }
    pending.push(fiber.sibling, fiber.child);
  }
}
const boundedRead = async (promise, timeout) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Read timed out')), timeout);
    })]);
  } finally { clearTimeout(timer); }
};
const findLegacyOwner = async () => {
  const family = discovery.hostFamily || discovery.managerFamily;
  if (!family) return null;
  const deadline = Date.now() + 3000;
  let found = null;
  for (const owner of mountedOwners(deadline)) {
    // Read only existing host-keyed bindings. Never call scope.get(family,
    // host), a family factory or a registry open method to create a manager.
    const members = owner.familyBindings.get(family);
    if (members instanceof Map) {
      const binding = members.get(params.hostId)?.value;
      if (typeof binding?.get !== 'function') continue;
      let manager, client;
      try {
        const value = binding.get();
        if (discovery.hostFamily) {
          if (value?.status !== 'ready' || value.client?.hostId !== params.hostId) continue;
          client = value.client;
          manager = client.rpc;
        } else manager = value;
        if (!validManager(manager) || typeof manager.getHostId !== 'function'
          || await boundedRead(Promise.resolve().then(() => manager.getHostId()), Math.max(1, deadline - Date.now())) !== params.hostId) continue;
        const current = binding.get();
        if (discovery.hostFamily ? current?.status !== 'ready' || current.client !== client || client.hostId !== params.hostId || client.rpc !== manager
          : current !== manager) continue;
      } catch { continue; }
      if (found && (found.owner !== owner || found.binding !== binding || found.manager !== manager || found.client !== client)) {
        mountedLookupStage = 'mounted-manager-ambiguous';
        return null;
      }
      found = { owner, binding, manager, client };
    }
  }
  return found;
};
let legacyOwner = null;
{
  legacyOwner = await findLegacyOwner();
  if (!legacyOwner) {
    state.managers.delete(key);
    // Allow a later read to rediscover a replaced bundle or newly mounted UI.
    if (window.__codexHarmonyDesktopInteractionRuntime === loader) delete window.__codexHarmonyDesktopInteractionRuntime;
    throw Object.assign(new Error(), { code: params.operation === 'respond'
      ? 'DESKTOP_REQUEST_STALE' : 'DESKTOP_INTERACTIONS_UNAVAILABLE', stage: mountedLookupStage });
  }
  if (!lease || lease.owner !== legacyOwner.owner || lease.binding !== legacyOwner.binding
    || lease.manager !== legacyOwner.manager || lease.client !== legacyOwner.client) {
    lease = { ...legacyOwner, generation: crypto.randomUUID() };
    state.managers.set(key, lease);
  }
}
if (params.operation === 'respond' && (!lease || lease.generation !== params.request?.__desktopGeneration)) {
  throw Object.assign(new Error(), { code: 'DESKTOP_REQUEST_STALE' });
}
let conversation;
try {
  conversation = await boundedRead(Promise.resolve().then(() => lease.manager.getConversation(params.threadId)), 5000);
  if (legacyOwner) {
    const current = await findLegacyOwner();
    if (!current || current.owner !== lease.owner || current.binding !== lease.binding
      || current.manager !== lease.manager || current.client !== lease.client) throw new Error('Legacy manager was replaced');
  }
} catch (error) {
  state.managers.delete(key);
  if (error?.stage === 'mounted-manager-scan-timeout') throw error;
  throw Object.assign(new Error(), { code: params.operation === 'respond' ? 'DESKTOP_REQUEST_STALE' : 'DESKTOP_INTERACTIONS_UNAVAILABLE',
    stage: 'conversation-read' });
}
// This explicit read-only projection returns only a bounded whitelist of full
// canonical message turns. Other operations retain their request-only surface.
if (params.operation === 'session-projection') {
  const projectCanonicalSessionTail = ${projectCanonicalSessionTail.toString()};
  const result = projectCanonicalSessionTail(conversation, params.threadId);
  const current = await findLegacyOwner();
  if (!current || current.owner !== lease.owner || current.binding !== lease.binding
    || current.manager !== lease.manager || current.client !== lease.client) {
    throw Object.assign(new Error(), { code: 'DESKTOP_INTERACTIONS_UNAVAILABLE', stage: 'conversation-read' });
  }
  return result;
}
// Canonical pages and optimistic desktop items coexist. Only request metadata,
// file-change content and question fields leave the remaining operations.
${NATIVE_CONTINUE_DESKTOP}
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
// Canonical history keys are Desktop entity identities; the same turnId can
// have a tail key unrelated to the legacy turn:<id> spelling.
let nativeActive = null;
if (activeTurn && conversation?.turnHistory?.kind === 'canonical') {
  const history = conversation.turnHistory.history;
  const matches = (history?.islands ?? []).flatMap(island => (island?.entries ?? []).flatMap(entry => {
    const entityKey = entry?.value;
    const turn = typeof entityKey === 'string' ? history?.entitiesByKey?.[entityKey] : null;
    return turn?.turnId === activeTurn.turnId && turn.status === 'inProgress' ? [{ entityKey, turn }] : [];
  }));
  if (matches.length === 1) nativeActive = matches[0];
} else if (activeTurn) nativeActive = { entityKey: 'turn:' + activeTurn.turnId, turn: activeTurn };
const asyncQuestionIds = new Set((activeTurn?.items ?? []).flatMap(item =>
  item.type === 'agentMessage' && Array.isArray(item.questions)
    ? item.questions.map((_, index) => JSON.stringify(['request_user_input_async', item.id, index])) : []));
let questionStates = new Map();
let questionBindings = new Map();
const scanQuestionBindings = () => {
  questionStates = new Map();
  questionBindings = new Map();
  if (!activeTurn || !asyncQuestionIds.size || !discovery.questionStateFamily) return;
  const deadline = Date.now() + 3000;
  for (const owner of mountedOwners(deadline)) {
    const members = owner.familyBindings.get(discovery.questionStateFamily);
    if (!(members instanceof Map)) continue;
    for (const [serializedKey, entry] of members) {
      assertMountedTime(deadline);
      let scope;
      try { scope = typeof serializedKey === 'string' ? JSON.parse(serializedKey) : serializedKey; }
      catch { continue; }
      if (scope?.hostId !== params.hostId || scope?.threadId !== params.threadId
        || typeof scope?.entityKey !== 'string' || !asyncQuestionIds.has(scope.itemId)
        || (scope.entityKey.startsWith('turn:') && scope.entityKey !== 'turn:' + activeTurn.turnId)) continue;
      const binding = entry?.value;
      const value = typeof binding?.get === 'function' ? binding.get() : undefined;
      // A noncanonical alias belongs to this turn only when its own native
      // state proves the turn identity. Never infer it from the item id alone.
      if (value?.turnId !== activeTurn.turnId
        && !(scope.entityKey === nativeActive?.entityKey && value == null)) continue;
      const matches = questionBindings.get(scope.itemId) ?? [];
      matches.push({ owner, binding, scope });
      questionBindings.set(scope.itemId, matches);
      if (value?.turnId === activeTurn.turnId) {
        const values = questionStates.get(scope.itemId) ?? [];
        values.push(value);
        questionStates.set(scope.itemId, values);
      }
    }
  }
};
scanQuestionBindings();
// Desktop lazily mounts question state. Only its own synchronizer may create
// missing members, using a real mounted scope and its complete turn snapshot.
const findQuestionScope = () => {
  const familyScope = discovery.questionStateFamily?.scope;
  if (!familyScope || familyScope.id == null) return null;
  const deadline = Date.now() + 3000;
  const pendingFibers = [window.__codexRoot?._internalRoot?.current], seenFibers = new Set();
  let result = null, conflict = false;
  while (pendingFibers.length) {
    assertMountedTime(deadline);
    const fiber = pendingFibers.pop();
    if (!fiber || seenFibers.has(fiber)) continue;
    seenFibers.add(fiber);
    const seenHooks = new Set();
    for (let hook = fiber.memoizedState; hook && typeof hook === 'object' && !seenHooks.has(hook); hook = hook.next) {
      assertMountedTime(deadline);
      seenHooks.add(hook);
      const ref = hook.memoizedState?.current;
      if (ref?.node !== lease.owner || typeof ref?.get !== 'function' || typeof ref?.set !== 'function'
        || typeof ref?.watch !== 'function') continue;
      if (ref.scope !== familyScope || !(ref.chain instanceof Map) || ref.chain.get(familyScope.id) !== lease.owner
        || (result && (result.chain !== ref.chain || result.node !== ref.node || result.scope !== ref.scope))) {
        conflict = true;
      } else result ??= ref;
    }
    pendingFibers.push(fiber.sibling, fiber.child);
  }
  return conflict ? null : result;
};
const missingQuestionState = id => {
  const matches = questionBindings.get(id);
  return !matches || (matches.length === 1 && typeof matches[0].binding?.get === 'function'
    && matches[0].binding.get() == null);
};
if (params.readOnly !== true && activeTurn && nativeActive && asyncQuestionIds.size && [...asyncQuestionIds].some(missingQuestionState)
  && discovery.questionHelperFamily === discovery.questionStateFamily
  && typeof discovery.questionInitializer === 'function' && typeof discovery.questionFlattener === 'function'
  && typeof discovery.questionAnswerReader === 'function'
  && [...questionBindings.values()].flat().every(match => match.scope.entityKey === nativeActive.entityKey)) {
  const scope = findQuestionScope();
  if (scope) {
    const turnIndex = turns.indexOf(activeTurn);
    const laterItems = turns.slice(turnIndex + 1).flatMap(turn => (turn.items ?? [])
      .filter(item => item?.type === 'userMessage' || item?.type === 'steeringUserMessage'));
    const flat = discovery.questionFlattener(nativeActive.turn.items ?? []);
    const answerMap = discovery.questionAnswerReader([...(activeTurn.items ?? []), ...laterItems])?.answersByQuestionItemId;
    const flatIds = Array.isArray(flat) ? flat.map(question => question?.id) : [];
    const consistent = Array.isArray(flat) && flat.length === asyncQuestionIds.size
      && new Set(flatIds).size === flat.length && flatIds.every(id => asyncQuestionIds.has(id))
      && answerMap instanceof Map && [...questionBindings].every(([id, matches]) =>
        asyncQuestionIds.has(id) && matches.length === 1 && typeof matches[0].binding?.get === 'function'
        && typeof matches[0].binding?.set === 'function' && (() => {
          const current = matches[0].binding.get();
          return current == null || (current.turnId === activeTurn.turnId && current.isSubmitting !== true
            && (current.lastSubmission == null || current.lastSubmission === answerMap.get(id)));
        })());
    if (consistent) {
      discovery.questionInitializer(scope, { hostId: params.hostId, threadId: params.threadId,
        entityKey: nativeActive.entityKey }, { turnId: activeTurn.turnId, status: activeTurn.status,
        questions: flat, answersByQuestionItemId: answerMap });
      scanQuestionBindings();
    }
  }
}
const asyncSubmitting = [...questionStates].some(([id, values]) =>
  asyncQuestionIds.has(id) && values.some(value => value?.isSubmitting === true));
let cachedQuestionScope;
const questionScope = () => cachedQuestionScope === undefined
  ? (cachedQuestionScope = findQuestionScope()) : cachedQuestionScope;
const writableQuestionBindings = id => {
  const matches = questionBindings.get(id);
  const actions = discovery.questionActions;
  if (!matches?.length || actions?.family !== discovery.questionStateFamily || !questionScope()) return null;
  const entities = new Set();
  for (const { owner, binding, scope } of matches) {
    if (owner !== lease.owner || entities.has(scope.entityKey)
      || typeof binding?.get !== 'function' || typeof binding?.set !== 'function') return null;
    entities.add(scope.entityKey);
    const current = binding.get();
    if (!current || typeof current !== 'object' || Array.isArray(current)
      || current.turnId !== activeTurn?.turnId || current.isSubmitting === true
      || current.lastSubmission != null || typeof current.draft !== 'string') return null;
  }
  return [...matches].sort((a, b) => a.scope.entityKey < b.scope.entityKey ? -1 : a.scope.entityKey > b.scope.entityKey ? 1 : 0);
};
const bindingIdentities = matches => matches.map(({ owner, binding, scope }) =>
  [scope.entityKey, bindingId(owner), bindingId(binding)]);
for (const turn of activeTurn && !asyncSubmitting ? [activeTurn] : []) {
  for (const item of turn.items ?? []) {
    if (item.type !== 'agentMessage' || !Array.isArray(item.questions)) continue;
    const questions = [];
    for (const [index, question] of item.questions.entries()) {
      const id = JSON.stringify(['request_user_input_async', item.id, index]);
      const officialStates = questionStates.get(id) ?? [];
      if (answered.has(id) || seenQuestions.has(id) || typeof question.title !== 'string'
        || officialStates.some(value => value?.lastSubmission != null)
        || (officialStates.length > 0 && officialStates.every(value => value?.isSkipped === true))) continue;
      seenQuestions.add(id);
      questions.push({ id, header: '', question: question.title, isOther: true, isSecret: false,
        options: (question.options ?? []).filter(option => typeof option === 'string')
          .map(label => ({ label, description: '' })) });
    }
    if (questions.length && turn.turnId) {
      const bindings = questions.map(question => writableQuestionBindings(question.id));
      const skipBindings = bindings.every(Boolean) ? bindings.map(bindingIdentities) : null;
      requests.push({
        id: JSON.stringify(['async', turn.turnId, item.id]), method: 'desktop/asyncUserInput',
        params: { threadId: params.threadId, turnId: turn.turnId, itemId: item.id, questions },
        __desktopGeneration: lease.generation, __skipBindings: skipBindings
      });
    }
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
  if (Object.hasOwn(params.result, 'skipQuestionId')) {
    const id = params.result.skipQuestionId;
    const index = pending.params.questions.findIndex(question => question.id === id);
    const matches = index >= 0 && pending.__skipBindings && writableQuestionBindings(id);
    if (!matches || answered.has(id) || asyncSubmitting
      || JSON.stringify(bindingIdentities(matches)) !== JSON.stringify(pending.__skipBindings[index])) {
      throw Object.assign(new Error(), { code: 'DESKTOP_REQUEST_STALE' });
    }
    const scope = questionScope(), actions = discovery.questionActions;
    const stale = () => Object.assign(new Error(), { code: 'DESKTOP_REQUEST_STALE' });
    const threadKey = { hostId: params.hostId, threadId: params.threadId };
    let selected, selectionAction = null, selectionTarget = null;
    try {
      // The official scope must resolve precisely the same state as each
      // mounted binding before any alias is changed.
      for (const match of matches) {
        if (scope.get(discovery.questionStateFamily, match.scope) !== match.binding.get()
          || scope.get(actions.busy, { ...threadKey, entityKey: match.scope.entityKey }) !== false) throw stale();
      }
      selected = scope.get(actions.selected, threadKey);
      if (selected != null) {
        if (!selected.selectedQuestionKey || !Array.isArray(selected.questionIds)
          || new Set(selected.questionIds).size !== selected.questionIds.length) throw stale();
        const currentKey = selected.selectedQuestionKey;
        if (currentKey.hostId !== params.hostId || currentKey.threadId !== params.threadId) throw stale();
        if (currentKey.itemId === id) {
          const currentAlias = matches.find(match => match.scope.entityKey === currentKey.entityKey);
          if (!currentAlias || !selected.questionIds.includes(id)) throw stale();
          const groupKey = { ...threadKey, entityKey: currentKey.entityKey };
          if (scope.get(actions.busy, groupKey) !== false) throw stale();
          const group = selected.questionIds.map(itemId => {
            const entries = (questionBindings.get(itemId) ?? []).filter(match => match.scope.entityKey === currentKey.entityKey);
            if (entries.length !== 1 || entries[0].owner !== lease.owner
              || typeof entries[0].binding?.get !== 'function') throw stale();
            const value = entries[0].binding.get();
            if (!value || value.turnId !== activeTurn.turnId || typeof value.draft !== 'string'
              || scope.get(discovery.questionStateFamily, entries[0].scope) !== value) throw stale();
            return { itemId, value };
          });
          const selectedIndex = group.findIndex(item => item.itemId === id);
          const next = group.slice(selectedIndex + 1).find(item => item.value.isSkipped !== true);
          // Preserve other drafts and give the user an explicit way to submit;
          // never invoke the desktop's automatic final-question submission.
          const draft = !next && group.find(item => {
            const text = item.value.draft.trim();
            return item.itemId !== id && text.length > 0 && (item.value.lastSubmission == null
              || typeof item.value.lastSubmission === 'string' && text !== item.value.lastSubmission.trim());
          });
          const target = next ?? draft;
          if (target) { selectionAction = 'select'; selectionTarget = { ...groupKey, itemId: target.itemId }; }
          else selectionAction = 'close';
        }
      }
      for (const match of matches) if (typeof match.binding.get()?.draft !== 'string') throw stale();
    } catch (error) {
      if (error?.code === 'DESKTOP_REQUEST_STALE') throw error;
      throw stale();
    }
    try {
      for (const match of matches) {
        const current = match.binding.get();
        if (current.isSkipped !== true) actions.skip(scope, match.scope);
        if (match.binding.get()?.draft !== '') actions.draft(scope, match.scope, '');
      }
      if (selectionAction === 'select') actions.select(scope, selectionTarget);
      if (selectionAction === 'close') actions.close(scope, selected.selectedQuestionKey);
      if (matches.some(match => match.binding.get()?.isSkipped !== true || match.binding.get()?.draft !== '')) {
        throw new Error('Skip not confirmed');
      }
      if (selectionAction) {
        const after = scope.get(actions.selected, threadKey);
        if (selectionAction === 'close' ? after != null
          : after?.selectedQuestionKey?.entityKey !== selectionTarget.entityKey
            || after?.selectedQuestionKey?.itemId !== selectionTarget.itemId) throw new Error('Panel update not confirmed');
      }
    } catch {
      throw Object.assign(new Error(), { code: 'DESKTOP_RESPONSE_UNCONFIRMED' });
    }
    return { ok: true, requestId: pending.id };
  }
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
// Native replies update the desktop conversation optimistically, so removing
// the request from that local snapshot is not an acknowledgement. Subscribe
// before dispatch and wait for the server's exact request-resolution event.
if (typeof lease.manager.subscribe !== 'function') {
  throw Object.assign(new Error(), { code: 'DESKTOP_RESPONSE_UNCONFIRMED' });
}
let subscription, remoteSubscription, timer, dispatched = false, resolvedBeforeDispatch = false;
let disposed = false, broken = false;
let resolveAck, rejectAck;
const ack = new Promise((resolve, reject) => { resolveAck = resolve; rejectAck = reject; });
// A broken subscription can reject before we begin awaiting the acknowledgement.
ack.catch(() => {});
const unconfirmed = () => Object.assign(new Error(), { code: 'DESKTOP_RESPONSE_UNCONFIRMED' });
try {
  subscription = lease.manager.subscribe({ type: 'notification', key: { hostId: params.hostId },
    methods: 'serverRequest/resolved', listener: event => {
      if (event?.method !== 'serverRequest/resolved' || event.params?.threadId !== params.threadId
        || event.params?.requestId !== pending.id) return;
      if (!dispatched) resolvedBeforeDispatch = true;
      else resolveAck();
    } });
  if (typeof subscription?.then !== 'function' || typeof subscription?.onRpcBroken !== 'function'
    || typeof subscription?.[Symbol.dispose] !== 'function') throw unconfirmed();
  const onBroken = () => { broken = true; rejectAck(unconfirmed()); };
  subscription.onRpcBroken(onBroken);
  const deadline = Date.now() + 3000;
  // Dispose a late subscription even if the handshake itself timed out.
  const ready = Promise.resolve(subscription).then(value => {
    remoteSubscription = value;
    if (disposed) value?.[Symbol.dispose]?.();
    return value;
  });
  remoteSubscription = await boundedRead(ready, Math.max(1, deadline - Date.now()));
  if (typeof remoteSubscription?.[Symbol.dispose] !== 'function'
    || typeof remoteSubscription?.onRpcBroken !== 'function') throw unconfirmed();
  remoteSubscription.onRpcBroken(onBroken);
  if (resolvedBeforeDispatch) throw Object.assign(new Error(), { code: 'DESKTOP_REQUEST_STALE' });
  const snapshot = await boundedRead(Promise.resolve().then(() => lease.manager.getConversation(params.threadId)),
    Math.max(1, deadline - Date.now()));
  const current = Array.isArray(snapshot?.requests) && snapshot.requests.find(request => request.id === pending.id);
  const { __desktopGeneration, __fileChanges, ...expected } = params.request;
  const currentChanges = expected.method === 'item/fileChange/requestApproval'
    ? conversationTurns(snapshot).filter(turn => turn.turnId === expected.params.turnId)
      .flatMap(turn => turn.items ?? []).find(item => item.type === 'fileChange' && item.id === expected.params.itemId)?.changes ?? null
    : undefined;
  if (resolvedBeforeDispatch || !current || current.completed === true
    || JSON.stringify(canonical(current)) !== JSON.stringify(canonical(expected))
    || (expected.method === 'item/fileChange/requestApproval'
      && JSON.stringify(canonical(currentChanges)) !== JSON.stringify(canonical(__fileChanges)))) {
    throw Object.assign(new Error(), { code: 'DESKTOP_REQUEST_STALE' });
  }
  if (legacyOwner) {
    const owner = await findLegacyOwner();
    if (!owner || owner.owner !== lease.owner || owner.binding !== lease.binding
      || owner.manager !== lease.manager || owner.client !== lease.client || resolvedBeforeDispatch) {
      throw Object.assign(new Error(), { code: 'DESKTOP_REQUEST_STALE' });
    }
  }
  if (broken || Date.now() >= deadline) throw unconfirmed();
  dispatched = true;
  const write = lease.manager[method](params.threadId, pending.id, result);
  await Promise.race([Promise.all([Promise.resolve(write), ack]), new Promise((_, reject) => {
    timer = setTimeout(() => reject(unconfirmed()), Math.max(1, deadline - Date.now()));
  })]);
  return { ok: true, requestId: pending.id };
} finally {
  clearTimeout(timer);
  disposed = true;
  subscription?.[Symbol.dispose]?.();
  remoteSubscription?.[Symbol.dispose]?.();
}
`;

export class DesktopInteractionClient {
  constructor(client = new CodexDesktopCdpClient(), options = {}) {
    this.client = client;
    this.hostId = options.hostId ?? client.hostId ?? 'local';
    this.pendingReads = new Map();
  }

  async listRequests(threadId, { readOnly = false } = {}) {
    const key = readOnly ? `${threadId}:read-only` : threadId;
    const existing = this.pendingReads.get(key);
    if (existing) return existing;
    if (this.pendingReads.size >= 128) throw interactionError('DESKTOP_INTERACTIONS_UNAVAILABLE', 503);
    const read = this.invoke({ operation: 'list', threadId, ...(readOnly ? { readOnly: true } : {}) }, 'return requests;');
    this.pendingReads.set(key, read);
    try { return await read; }
    finally { if (this.pendingReads.get(key) === read) this.pendingReads.delete(key); }
  }

  async respond(threadId, request, result) {
    if (!request || typeof request !== 'object' || !result || typeof result !== 'object') {
      throw interactionError('DESKTOP_REQUEST_INVALID', 400);
    }
    return this.invoke({ operation: 'respond', threadId, request, result }, RESPOND);
  }

  readContinueSnapshot(threadId) { return this.invoke({ operation: 'native-continue-status', threadId }, ''); }
  readContinueContext(threadId) { return this.invoke({ operation: 'native-continue-context', threadId }, ''); }
  async readRecentSessionProjection(threadId) {
    const key = `${threadId}:session-projection`;
    const existing = this.pendingReads.get(key);
    if (existing) return existing;
    if (this.pendingReads.size >= 128) throw interactionError('DESKTOP_INTERACTIONS_UNAVAILABLE', 503);
    const read = this.invoke({ operation: 'session-projection', threadId, readOnly: true }, '');
    this.pendingReads.set(key, read);
    try { return await read; }
    finally { if (this.pendingReads.get(key) === read) this.pendingReads.delete(key); }
  }
  continueTurn(threadId, expectedTurnId, operationId) {
    return this.invoke({ operation: 'native-continue', threadId, expectedTurnId, operationId }, '');
  }

  async invoke(params, body) {
    if (typeof params.threadId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(params.threadId)) {
      throw interactionError('DESKTOP_REQUEST_INVALID', 400);
    }
    let response;
    try {
      await this.client.ensureConnected();
      response = await this.client.evaluate(`(async()=>{const params=${JSON.stringify({ ...params, hostId: this.hostId })};
      let nativeContinueWriteAttempted=false;try{
      ${LOAD_MANAGER}
      ${body}
    }catch(error){return {__desktopInteractionError:true,code:error?.code || 'DESKTOP_INTERACTIONS_UNAVAILABLE',
      stage:${JSON.stringify([...DIAGNOSTIC_STAGES])}.includes(error?.stage) ? error.stage : 'renderer',
      ...(params.operation==='native-continue'?{continueWriteAttempted:nativeContinueWriteAttempted}:{})};}})()`);
    } catch {
      const error = interactionError('DESKTOP_INTERACTIONS_UNAVAILABLE', 503, 'transport');
      if (params.operation === 'native-continue') error.continueWriteAttempted = true;
      throw error;
    }
    if (response?.__desktopInteractionError) {
      const code = response.code;
      const error = interactionError(code, code === 'DESKTOP_REQUEST_STALE' || code === 'DESKTOP_ASYNC_ANSWER_CONFLICT' ? 409
        : code === 'DESKTOP_REQUEST_UNSUPPORTED' ? 422 : 503, response.stage);
      if (params.operation === 'native-continue') error.continueWriteAttempted = response.continueWriteAttempted === true;
      throw error;
    }
    return response;
  }

  close() { this.client.close?.(); }
}

function interactionError(code, statusCode, stage) {
  if (!['DESKTOP_INTERACTIONS_UNAVAILABLE', 'DESKTOP_REQUEST_STALE', 'DESKTOP_ASYNC_ANSWER_CONFLICT',
    'DESKTOP_REQUEST_UNSUPPORTED', 'DESKTOP_REQUEST_INVALID', 'DESKTOP_RESPONSE_UNCONFIRMED', 'NATIVE_CONTINUE_UNAVAILABLE'].includes(code)) {
    code = 'DESKTOP_INTERACTIONS_UNAVAILABLE';
  }
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  error.stage = DIAGNOSTIC_STAGES.has(stage) ? stage : 'renderer';
  return error;
}
