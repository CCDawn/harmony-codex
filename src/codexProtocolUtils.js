import { materializeImageItemForMobile, materializeLocalImageForMobile, materializeMarkdownImagesForMobile } from './codexSessions.js';

export async function waitForTurnCompletion({ notifications, threadId, turnId, timeoutMs }) {
  const existing = findCompleted(notifications, threadId, turnId);
  if (existing) {
    return existing.params;
  }

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const completed = findCompleted(notifications, threadId, turnId);
      if (completed) {
        clearInterval(timer);
        resolve(completed.params);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error('等待 Codex app-server 回合完成超时'));
      }
    }, 250);
  });
}

export function findCompleted(notifications, threadId, turnId) {
  return notifications.find((message) => {
    if (message.method !== 'turn/completed') {
      return false;
    }
    const params = message.params ?? {};
    if (extractThreadId(message) !== threadId) {
      return false;
    }
    return !turnId || extractTurnId(message) === turnId;
  }) ?? null;
}

export function extractLatestAgentMessage(turn) {
  if (!turn?.items) {
    return '';
  }
  const messages = turn.items
    .filter((item) => item.type === 'agentMessage' && typeof item.text === 'string')
    .map((item) => item.text.trim())
    .filter(Boolean);
  return messages.at(-1) ?? '';
}

export function findTurn(thread, turnId) {
  if (!thread?.turns || !turnId) {
    return null;
  }
  return thread.turns.find((turn) => turn.id === turnId) ?? null;
}

export function summarizeTurnStatus(turn) {
  if (!turn) {
    return 'Codex app-server 回合已完成';
  }
  if (turn.status === 'failed') {
    return turn.error?.message ?? 'Codex app-server 回合失败';
  }
  return `Codex app-server 回合状态：${turn.status}`;
}

export function summarizeThreadForEvent(response) {
  const thread = response?.thread ?? response ?? {};
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const latestTurn = turns.at(-1) ?? null;
  return {
    thread: {
      id: firstString([thread.id, thread.threadId, thread.thread_id]) ?? '',
      sessionId: firstString([thread.sessionId, thread.session_id, thread.id]) ?? '',
      cwd: typeof thread.cwd === 'string' ? thread.cwd : '',
      status: thread.status ?? null,
      name: typeof thread.name === 'string' ? cleanTitle(thread.name) : '',
      preview: typeof thread.preview === 'string' ? cleanTitle(thread.preview) : '',
      path: typeof thread.path === 'string' ? thread.path : '',
      turnCount: turns.length,
      latestTurnId: firstString([latestTurn?.id, latestTurn?.turnId, latestTurn?.turn_id]) ?? '',
      latestTurnStatus: typeof latestTurn?.status === 'string' ? latestTurn.status : ''
    }
  };
}

export function extractChangedFiles(turn) {
  if (!turn?.items) {
    return [];
  }
  const files = [];
  for (const item of turn.items) {
    if (item.type !== 'fileChange' || !Array.isArray(item.changes)) {
      continue;
    }
    for (const change of item.changes) {
      if (typeof change.path === 'string') {
        files.push(change.path);
      }
    }
  }
  return [...new Set(files)];
}

export function buildSessionSnapshot(thread, { threadId, prompt, mobileImagesDir } = {}) {
  const id = thread?.id || threadId;
  const updatedAt = timestampToIso(thread?.updatedAt) || new Date().toISOString();
  const entries = extractConversationEntries(thread, { threadId: id, mobileImagesDir });
  if (entries.length === 0 && prompt) {
    entries.push({
      timestamp: updatedAt,
      type: 'userMessage',
      role: 'user',
      text: prompt
    });
  }
  return {
    id,
    title: cleanTitle(thread?.name || thread?.preview || prompt || '未命名会话'),
    updatedAt,
    relativeTime: '刚刚',
    projectRoot: thread?.cwd || '',
    projectLabel: thread?.cwd ? basename(String(thread.cwd)) : '未归类',
    source: 'app-server-live',
    pinned: false,
    detailAvailable: true,
    filePath: thread?.path || '',
    entries,
    entryCount: entries.length
  };
}

export function extractConversationEntries(thread, { threadId = thread?.id ?? '', mobileImagesDir = '' } = {}) {
  const entries = [];
  // Activity records may precede the spawn tool result in the same snapshot.
  // Resolve only exact receiver IDs and retain the original spawn instruction.
  const spawnedAgents = new Map();
  const agentPaths = new Map();
  for (const turn of thread?.turns ?? []) {
    for (const item of turn.items ?? []) {
      if (item?.type === 'subAgentActivity' && typeof item.agentThreadId === 'string'
        && typeof item.agentPath === 'string' && item.agentPath.trim()) agentPaths.set(item.agentThreadId, item.agentPath.trim());
      if (item?.type !== 'collabAgentToolCall' || normalizeCollabTool(item.tool) !== 'spawn_agent') continue;
      for (const receiver of Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []) {
        if (typeof receiver === 'string' && receiver && !spawnedAgents.has(receiver)) spawnedAgents.set(receiver, item);
      }
    }
  }
  for (const turn of thread?.turns ?? []) {
    const turnId = String(turn.id ?? '');
    const turnTimestamp = timestampToIso(turn.startedAt ?? turn.completedAt) || timestampToIso(thread?.updatedAt) || '1970-01-01T00:00:00.000Z';
    for (const [index, item] of (turn.items ?? []).entries()) {
      const itemId = typeof item.id === 'string' && item.id ? item.id : `missing-item-${index}`;
      const timestamp = millisecondsToIso(item.startedAtMs) || turnTimestamp;
      const identity = { timestamp, threadId, turnId, itemId,
        syncId: `official:${Buffer.from(JSON.stringify([threadId, turnId, itemId])).toString('base64url')}` };
      if (item.type === 'userMessage') {
        const text = extractUserMessageText(item.content, mobileImagesDir);
        if (text) {
          entries.push({
            ...identity,
            type: item.type,
            role: 'user',
            text,
            ...(typeof item.clientId === 'string' ? { clientId: item.clientId } : {})
          });
        }
        continue;
      }
      if (item.type === 'agentMessage') {
        const questions = Array.isArray(item.questions) ? item.questions : [];
        const questionText = questions.map(question => [question?.title, ...(Array.isArray(question?.options) ? question.options : [])]
          .filter(value => typeof value === 'string' && value.trim()).join('\n')).filter(Boolean).join('\n\n');
        const nativeText = typeof item.text === 'string' ? materializeMarkdownImagesForMobile(item.text, mobileImagesDir) : '';
        const text = nativeText.trim() ? nativeText : questionText;
        if (!text.trim()) continue;
        entries.push({
          ...identity,
          type: item.type,
          role: 'assistant',
          text,
          liveKind: String(turn.status).toLowerCase() === 'inprogress' && index === turn.items.length - 1
            && item.completedAtMs == null ? 'streaming' : 'completed',
          ...(questions.length ? { questions } : {})
        });
        continue;
      }
      if (item.type === 'reasoning') {
        const text = Array.isArray(item.summary) ? item.summary.filter(value => typeof value === 'string').join('\n').trim() : '';
        const active = String(turn.status).toLowerCase() === 'inprogress' && index === turn.items.length - 1 && item.completedAtMs == null;
        entries.push({ ...identity, type: active ? 'live_activity' : 'reasoning', role: 'system',
          text: active ? '思考中' : text || '思考过程', liveKind: active ? 'reasoning' : 'completed' });
        continue;
      }
      if (item.type === 'plan' && typeof item.text === 'string' && item.text.trim()) {
        entries.push({ ...identity, type: 'plan', role: 'assistant', text: item.text });
        continue;
      }
      if (item.type === 'imageGeneration') {
        const localPath = typeof item.savedPath === 'string' ? materializeLocalImageForMobile(item.savedPath, mobileImagesDir) : '';
        const result = typeof item.result === 'string' ? item.result : '';
        const image = localPath ? `![桌面端图片](${localPath})`
          : /^data:image\//i.test(result) ? materializeImageItemForMobile({ url: result }, mobileImagesDir)
            : /^(?:iVBORw0KGgo|\/9j\/|R0lGOD|UklGR)/.test(result)
              ? materializeImageItemForMobile({ base64: result }, mobileImagesDir) : '';
        const text = image || (String(item.status).toLowerCase() === 'inprogress' ? '正在生成图片' : '[生成的图片：预览不可用]');
        entries.push({ ...identity, type: 'imageGeneration', role: 'assistant', text });
        continue;
      }
      const tool = officialToolItem(item, itemId, mobileImagesDir, spawnedAgents, agentPaths);
      if (tool) {
        entries.push({ ...identity, type: tool.status === 'running' ? 'tool_call' : 'tool_result', role: 'tool',
          text: tool.target || tool.name, toolItems: [tool] });
      }
    }
  }
  return entries;
}

function officialToolItem(item, id, mobileImagesDir = '', spawnedAgents = new Map(), agentPaths = new Map()) {
  const state = String(item.status ?? '').toLowerCase().replace(/[-_ ]/g, '');
  const status = state === 'inprogress' || state === 'running' ? 'running'
    : ['failed', 'declined', 'interrupted', 'cancelled', 'canceled'].includes(state) || item.success === false ? 'failed'
      : state === 'completed' || item.success === true ? 'completed' : 'unknown';
  const base = { id, name: item.type, verb: 'Called', target: '', detail: '', status };
  if (item.type === 'commandExecution') {
    const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
    const action = actions.length === 1 ? actions[0] : null;
    const command = summarizeCommand(item.command);
    const lastUnknown = [...actions].reverse().find(value => value?.type === 'unknown' && summarizeCommand(value.command));
    const unknownCommand = summarizeCommand(lastUnknown?.command) || command;
    const verb = action?.type === 'read' ? 'Read' : action?.type === 'search' ? 'Searched' : 'Ran';
    const target = actions.length > 1 && actions.some(value => value?.type !== 'unknown') ? actions.map(value => {
      if (value?.type === 'read') return `读取 ${value.name || value.path || '文件'}`;
      if (value?.type === 'search') return `搜索 ${value.query || value.path || '内容'}`;
      if (value?.type === 'listFiles') return `列出文件${value.path ? ` ${value.path}` : ''}`;
      return happyCommandTarget(summarizeCommand(value?.command));
    }).join('；') : action?.type === 'read' ? action.name || action.path || command || '文件'
      : action?.type === 'search' ? action.query || action.path || command || '内容'
        : action?.type === 'listFiles' ? `列出文件${action.path ? ` ${action.path}` : ''}` : happyCommandTarget(unknownCommand);
    return { ...base, name: 'commandExecution', verb, target,
      displayCommand: unwrapShellCommand(unknownCommand || command || ''),
      detail: String(item.aggregatedOutput ?? '').slice(0, 8000),
      ...copyOfficialFields(item, ['source', 'pluginId', 'scriptPath']),
      ...(command ? { args: command } : {}) };
  }
  if (item.type === 'fileChange') {
    const paths = Array.isArray(item.changes) ? item.changes.map(change => change?.path).filter(value => typeof value === 'string' && value) : [];
    const detail = Array.isArray(item.changes) ? item.changes.map(change => typeof change?.diff === 'string' ? change.diff : '')
      .filter(Boolean).join('\n').slice(0, 8000) : '';
    return { ...base, verb: 'Edited', target: paths.join('、') || '文件', detail };
  }
  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
    const name = String(item.tool ?? '').trim() || 'tool';
    const content = item.type === 'mcpToolCall' ? item.result?.content : item.contentItems;
    const details = Array.isArray(content) ? content.map(value => {
      if ((value?.type === 'text' || value?.type === 'inputText') && typeof value.text === 'string') return value.text;
      if (value?.type === 'image' || value?.type === 'inputImage') return materializeImageItemForMobile(value, mobileImagesDir) || '[图片：预览不可用]';
      return '';
    }).filter(Boolean) : [];
    if (typeof item.error?.message === 'string') details.unshift(item.error.message);
    return { ...base, name, target: [item.server ?? item.namespace, name].filter(Boolean).join('/'),
      args: typeof item.arguments === 'string' ? item.arguments : item.arguments != null ? JSON.stringify(item.arguments, null, 2) : '',
      detail: details.join('\n').slice(0, 8000) };
  }
  if (item.type === 'subAgentActivity') {
    const target = [item.agentPath || item.agentThreadId || '子代理', item.kind].filter(Boolean).join(' · ');
    // A historic start or interaction is not evidence the child is still alive.
    const eventStatus = item.kind === 'completed' ? 'completed' : item.kind === 'interrupted' ? 'stopped' : 'unknown';
    const spawn = spawnedAgents.get(item.agentThreadId);
    const prompt = typeof spawn?.prompt === 'string' ? spawn.prompt : undefined;
    const model = item.model ?? spawn?.model;
    const reasoningEffort = item.reasoningEffort ?? spawn?.reasoningEffort;
    return { ...base, target, status: eventStatus, agentThreadId: item.agentThreadId, agentPath: item.agentPath, kind: item.kind,
      args: JSON.stringify({ kind: item.kind, agentThreadId: item.agentThreadId, agentPath: item.agentPath, model, reasoningEffort, prompt }, null, 2),
      ...(prompt !== undefined ? { prompt, taskName: prompt } : {}), model, reasoningEffort };
  }
  if (item.type === 'collabAgentToolCall') {
    const name = normalizeCollabTool(item.tool) || '协作工具';
    const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter(value => typeof value === 'string' && value) : [];
    const states = item.agentsStates && typeof item.agentsStates === 'object' && !Array.isArray(item.agentsStates)
      ? item.agentsStates : {};
    const ids = [...new Set([...receivers, ...Object.keys(states)])];
    const agents = ids.map(agentId => {
      const state = states[agentId];
      const report = typeof state?.message === 'string' ? state.message : '';
      return { name: agentId, status: normalizeCollabAgentStatus(state?.status),
        ...(agentPaths.has(agentId) ? { displayName: agentPaths.get(agentId) } : {}), ...(report ? { report } : {}) };
    });
    return { ...base, name, target: receivers.length ? receivers.join('、') : '子代理', rawType: item.type, rawTool: item.tool,
      ...copyOfficialFields(item, ['senderThreadId', 'receiverThreadIds', 'agentsStates', 'prompt', 'model', 'reasoningEffort']),
      ...(receivers.length === 1 ? { agentThreadId: receivers[0] } : {}),
      ...(agents.length ? { agents } : {}),
      ...(typeof item.prompt === 'string' ? { args: item.prompt, taskName: item.prompt } : {}) };
  }
  if (item.type === 'webSearch') return { ...base, name: 'webSearch', verb: 'Searched', target: String(item.query || '网络') };
  if (item.type === 'imageView') return { ...base, name: 'imageView', verb: 'Viewed', target: String(item.path || '图片') };
  return null;
}

function copyOfficialFields(item, keys) {
  const fields = {};
  for (const key of keys) if (Object.hasOwn(item, key)) fields[key] = item[key];
  return fields;
}

function normalizeCollabTool(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return name === 'wait' ? 'wait_agent' : name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function normalizeCollabAgentStatus(value) {
  switch (value) {
    case 'pendingInit': return 'pending';
    case 'running': return 'running';
    case 'completed': return 'completed';
    case 'interrupted':
    case 'shutdown': return 'stopped';
    case 'errored': return 'failed';
    default: return 'unknown';
  }
}

// Happy Coder, MIT, commit 2cab104da57898360eea11cee423b6a57d9e50d7:
// packages/happy-cli/src/codex/utils/sessionProtocolMapper.ts, lines 455-471.
// JavaScript adaptation removes only the TypeScript parameter/return types.
function summarizeCommand(command) {
  if (typeof command === 'string' && command.trim().length > 0) {
    return command;
  }
  if (Array.isArray(command)) {
    const cmd = command.map(v => String(v)).join(' ').trim();
    return cmd.length > 0 ? cmd : null;
  }
  return null;
}
function commandToTitle(command) {
  if (!command) {
    return 'Run command';
  }
  const short = command.length > 80 ? `${command.slice(0, 77)}...` : command;
  return `Run \`${short}\``;
}

function happyCommandTarget(command) {
  const title = commandToTitle(command ? unwrapShellCommand(command) : command);
  // The existing phone component supplies its own translated “执行” verb.
  return command ? title.slice(5, -1) : '命令';
}

// Paseo, Copyright (c) 2025-present Mohamed Boudra, Apache-2.0.
// https://github.com/getpaseo/paseo/blob/fd65985e9d588109898fcf84298b6ecd1815462a/packages/server/src/server/agent/providers/codex/tool-call-mapper.ts#L222-L241
// Adapted by removing TypeScript annotations; license: docs/third-party/paseo-LICENSE.txt.
function unwrapShellCommand(command) {
  const trimmed = command.trim();
  const unix = trimmed.match(/^(?:(?:\/[^/\s]+)*\/)?(?:zsh|bash|sh)\s+-(?:lc|c)\s+([\s\S]+)$/);
  if (unix?.[1]) return stripMatchingEdgeQuotes(unix[1].trim());

  const windows = trimmed.match(
    /^(?:"[^"]*\\)?(?:pwsh|powershell|cmd)(?:\.exe)?"?(?:\s+-[A-Za-z]+(?:\s+[^-\s][^\s]*)?)*\s+(?:-Command|-c|\/c)\s+([\s\S]+)$/i,
  );
  return windows?.[1] ? stripMatchingEdgeQuotes(windows[1].trim()) : trimmed;
}

function stripMatchingEdgeQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function millisecondsToIso(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

export function sanitize(value) {
  if (!value || typeof value !== 'object') {
    return value;
  }
  const copy = Array.isArray(value) ? [...value] : { ...value };
  for (const key of Object.keys(copy)) {
    if (typeof copy[key] === 'string' && copy[key].length > 3000) {
      copy[key] = `${copy[key].slice(0, 3000)}... [truncated ${copy[key].length - 3000} chars]`;
    } else if (copy[key] && typeof copy[key] === 'object') {
      copy[key] = sanitize(copy[key]);
    }
  }
  return copy;
}

function extractUserMessageText(content, mobileImagesDir = '') {
  if (!Array.isArray(content)) {
    return '';
  }
  const renderedText = content.map(item => item?.type === 'text' && typeof item.text === 'string'
    ? materializeMarkdownImagesForMobile(item.text, mobileImagesDir) : '');
  const representedImages = new Set(renderedText.flatMap(value => [...value.matchAll(/!\[[^\]]*\]\(([^)\r\n]+)\)/g)].map(match => match[1])));
  return content.map((item, index) => {
    if (item?.type === 'text' && typeof item.text === 'string') return renderedText[index];
    if (item?.type === 'localImage') {
      const imagePath = materializeLocalImageForMobile(item.path, mobileImagesDir);
      if (imagePath && representedImages.has(imagePath)) return '';
      return imagePath ? `![桌面端图片](${imagePath})` : '[图片：预览不可用]';
    }
    if (item?.type === 'image') {
      const url = typeof item.url === 'string' ? item.url : '';
      if (/^https?:\/\//i.test(url)) return `![图片](${url})`;
      return materializeImageItemForMobile(item, mobileImagesDir) || '[图片：预览不可用]';
    }
    if (item?.type === 'mention' || item?.type === 'skill') return [item.name, item.path].filter(Boolean).join(' ');
    if (item?.type === 'localAudio' || item?.type === 'audio') return item.path ? `[音频] ${item.path}` : '[音频]';
    if (typeof item?.path === 'string' || typeof item?.name === 'string') return [item.name, item.path].filter(Boolean).join(' ');
    return item && typeof item === 'object' ? '[附件：此类型暂不支持预览]' : '';
  }).filter(Boolean).join('\n');
}

function timestampToIso(value) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return '';
  }
  return new Date(numeric * 1000).toISOString();
}

function extractThreadId(message) {
  const params = message?.params ?? {};
  return firstString([
    params.threadId,
    params.thread_id,
    params.thread?.id,
    params.turn?.threadId,
    params.turn?.thread_id,
    params.item?.threadId,
    params.item?.thread_id,
    params.event?.threadId,
    params.event?.thread_id
  ]);
}

function extractTurnId(message) {
  const params = message?.params ?? {};
  return firstString([
    params.turnId,
    params.turn_id,
    params.turn?.id,
    params.turn?.turnId,
    params.turn?.turn_id,
    params.item?.turnId,
    params.item?.turn_id,
    params.event?.turnId,
    params.event?.turn_id
  ]);
}

function firstString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function cleanTitle(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= 80) {
    return text || '未命名会话';
  }
  return `${text.slice(0, 80)}...`;
}

function basename(value) {
  const normalized = value.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/);
  return parts.at(-1) || normalized;
}
