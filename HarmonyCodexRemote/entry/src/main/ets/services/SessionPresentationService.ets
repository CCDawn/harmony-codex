import { CodexSessionAgentRef, CodexSessionEntry, CodexSessionToolItem } from '../model/BridgeModels';

export interface SessionMarkdownInlineSegment {
  id: string;
  kind: string;
  text: string;
  href: string;
}

export interface SessionMarkdownTableData {
  headers: string[];
  rows: string[][];
  alignments: string[];
}

export interface SessionToolPresentationItem {
  id: string;
  name: string;
  verb: string;
  target: string;
  detail: string;
  status: string;
  retryCount?: number;
  args?: string;
  taskName?: string;
  agents?: CodexSessionAgentRef[];
}

interface InlineToken {
  start: number;
  end: number;
  kind: string;
  text: string;
  href: string;
}

export function parseSessionMarkdownInline(text: string): SessionMarkdownInlineSegment[] {
  const value = String(text ?? '');
  const segments: SessionMarkdownInlineSegment[] = [];
  let cursor = 0;
  let sequence = 0;
  while (cursor < value.length) {
    const token = nextInlineToken(value, cursor);
    if (token.start < 0) {
      pushInlineSegment(segments, `inline-${sequence}`, 'plain', value.slice(cursor), '');
      break;
    }
    if (token.start > cursor) {
      pushInlineSegment(segments, `inline-${sequence}`, 'plain', value.slice(cursor, token.start), '');
      sequence += 1;
    }
    pushInlineSegment(segments, `inline-${sequence}`, token.kind, token.text, token.href);
    sequence += 1;
    cursor = token.end;
  }
  if (segments.length === 0) {
    pushInlineSegment(segments, 'inline-0', 'plain', value, '');
  }
  return segments;
}

export function parseSessionMarkdownTable(text: string): SessionMarkdownTableData {
  const empty: SessionMarkdownTableData = {
    headers: [],
    rows: [],
    alignments: []
  };
  const lines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line: string) => line.trim())
    .filter((line: string) => line.length > 0);
  if (lines.length < 2) {
    return empty;
  }
  const headers = markdownTableCells(lines[0]);
  const separators = markdownTableCells(lines[1]);
  if (headers.length === 0 || separators.length !== headers.length) {
    return empty;
  }
  for (const separator of separators) {
    if (!/^:?-{3,}:?$/.test(separator.replace(/\s/g, ''))) {
      return empty;
    }
  }
  const rows: string[][] = [];
  for (let index = 2; index < lines.length; index += 1) {
    const cells = markdownTableCells(lines[index]);
    if (cells.length === 0) {
      continue;
    }
    const normalized: string[] = [];
    for (let cellIndex = 0; cellIndex < headers.length; cellIndex += 1) {
      normalized.push(cells[cellIndex] ?? '');
    }
    rows.push(normalized);
  }
  return {
    headers,
    rows,
    alignments: separators.map((separator: string) => markdownTableAlignment(separator))
  };
}

export function sessionToolPresentationItems(entry: CodexSessionEntry): SessionToolPresentationItem[] {
  const structured = Array.isArray(entry.toolItems) ? entry.toolItems : [];
  if (structured.length > 0) {
    return structured.slice(0, 50).map((item: CodexSessionToolItem, index: number) => normalizeToolItem(item, index));
  }
  return legacyToolPresentationItems(entry.text);
}

export function compactAdjacentSessionToolEntries(entries: CodexSessionEntry[]): CodexSessionEntry[] {
  const compacted: CodexSessionEntry[] = [];
  entries.forEach((entry: CodexSessionEntry) => {
    const previous = compacted.length > 0 ? compacted[compacted.length - 1] : null;
    if (previous === null || !shouldMergeSessionToolEntries(previous, entry)) {
      compacted.push(entry);
      return;
    }
    compacted[compacted.length - 1] = mergeSessionToolEntries(previous, entry);
  });
  return compacted;
}

function shouldMergeSessionToolEntries(previous: CodexSessionEntry, entry: CodexSessionEntry): boolean {
  if (previous.role !== 'tool' || entry.role !== 'tool') {
    return false;
  }
  if (previous.threadId && entry.threadId && previous.threadId !== entry.threadId) {
    return false;
  }
  if (previous.turnId && entry.turnId && previous.turnId !== entry.turnId) {
    return false;
  }
  return true;
}

function mergeSessionToolEntries(previous: CodexSessionEntry, entry: CodexSessionEntry): CodexSessionEntry {
  const items = mergeSessionToolItems(
    sessionToolPresentationItems(previous),
    sessionToolPresentationItems(entry)
  );
  const running = items.some((item: CodexSessionToolItem) => item.status === 'running');
  const firstId = items.length > 0 ? items[0].id : 'tool';
  const lastId = items.length > 0 ? items[items.length - 1].id : 'tool';
  return {
    timestamp: entry.timestamp,
    type: running ? 'tool_call' : 'tool_result',
    role: 'tool',
    text: toolGroupEntryText(items),
    liveKind: entry.liveKind ?? previous.liveKind,
    threadId: entry.threadId ?? previous.threadId,
    turnId: entry.turnId ?? previous.turnId,
    itemId: `tool-group-${firstId}-${lastId}-${items.length}`,
    toolItems: items
  };
}

function mergeSessionToolItems(
  previousItems: SessionToolPresentationItem[],
  nextItems: SessionToolPresentationItem[]
): CodexSessionToolItem[] {
  const merged: CodexSessionToolItem[] = [];
  const sourceItems = previousItems.concat(nextItems).slice(0, 50);
  sourceItems.forEach((source: SessionToolPresentationItem) => {
    const retryIndex = retryTargetIndex(merged, source);
    if (retryIndex >= 0) {
      const failed = merged[retryIndex];
      merged[retryIndex] = {
        id: failed.id,
        name: source.name,
        verb: source.verb,
        target: source.target,
        detail: retryDetail(failed, source),
        status: 'completed',
        retryCount: (failed.retryCount ?? 0) + 1,
        args: source.args ?? failed.args,
        taskName: source.taskName ?? failed.taskName,
        agents: source.agents ?? failed.agents
      };
      return;
    }
    merged.push({
      id: uniqueToolItemId(merged, source.id),
      name: source.name,
      verb: source.verb,
      target: source.target,
      detail: source.detail,
      status: source.status,
      retryCount: source.retryCount,
      args: source.args,
      taskName: source.taskName,
      agents: source.agents
    });
  });
  return merged;
}

function retryTargetIndex(items: CodexSessionToolItem[], candidate: SessionToolPresentationItem): number {
  if (candidate.status !== 'completed') {
    return -1;
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if ((item.status === 'failed' || item.status === 'stopped')
      && item.name === candidate.name
      && item.target === candidate.target) {
      return index;
    }
  }
  return -1;
}

function retryDetail(failed: CodexSessionToolItem, succeeded: SessionToolPresentationItem): string {
  const attempts: string[] = [];
  const failedDetail = failed.detail.trim();
  const succeededDetail = succeeded.detail.trim();
  attempts.push(failedDetail.length > 0 ? `第 1 次（失败）：${failedDetail}` : '第 1 次：失败');
  attempts.push(succeededDetail.length > 0 ? `第 2 次（成功）：${succeededDetail}` : '第 2 次：成功');
  return attempts.join('\n');
}

function uniqueToolItemId(items: CodexSessionToolItem[], candidate: string): string {
  const base = candidate.length > 0 ? candidate : `tool-${items.length}`;
  let value = base;
  let suffix = 2;
  while (items.some((item: CodexSessionToolItem) => item.id === value)) {
    value = `${base}-${suffix}`;
    suffix += 1;
  }
  return value;
}

function toolGroupEntryText(items: CodexSessionToolItem[]): string {
  const running = items.filter((item: CodexSessionToolItem) => item.status === 'running').length;
  const failed = items.filter((item: CodexSessionToolItem) => item.status === 'failed').length;
  if (running > 0) {
    return `正在执行 ${items.length} 项操作`;
  }
  if (failed > 0) {
    return `${items.length} 项操作中有 ${failed} 项失败`;
  }
  return `已完成 ${items.length} 项操作`;
}

function nextInlineToken(value: string, from: number): InlineToken {
  for (let index = from; index < value.length; index += 1) {
    const link = linkTokenAt(value, index);
    if (link.start >= 0) {
      return link;
    }
    const code = pairedTokenAt(value, index, '`', 'code');
    if (code.start >= 0) {
      return code;
    }
    const strong = pairedTokenAt(value, index, '**', 'strong');
    if (strong.start >= 0) {
      return strong;
    }
    const strike = pairedTokenAt(value, index, '~~', 'strike');
    if (strike.start >= 0) {
      return strike;
    }
    const emphasis = emphasisTokenAt(value, index);
    if (emphasis.start >= 0) {
      return emphasis;
    }
  }
  return emptyInlineToken();
}

function linkTokenAt(value: string, index: number): InlineToken {
  if (value[index] !== '[') {
    return emptyInlineToken();
  }
  const labelEnd = value.indexOf('](', index + 1);
  if (labelEnd <= index + 1) {
    return emptyInlineToken();
  }
  const hrefEnd = value.indexOf(')', labelEnd + 2);
  if (hrefEnd <= labelEnd + 2) {
    return emptyInlineToken();
  }
  return {
    start: index,
    end: hrefEnd + 1,
    kind: 'link',
    text: value.slice(index + 1, labelEnd),
    href: value.slice(labelEnd + 2, hrefEnd)
  };
}

function pairedTokenAt(value: string, index: number, marker: string, kind: string): InlineToken {
  if (!value.startsWith(marker, index)) {
    return emptyInlineToken();
  }
  const end = value.indexOf(marker, index + marker.length);
  if (end <= index + marker.length) {
    return emptyInlineToken();
  }
  return {
    start: index,
    end: end + marker.length,
    kind,
    text: value.slice(index + marker.length, end),
    href: ''
  };
}

function emphasisTokenAt(value: string, index: number): InlineToken {
  const marker = value[index];
  if (marker !== '*' && marker !== '_') {
    return emptyInlineToken();
  }
  if (value[index + 1] === marker || (index > 0 && value[index - 1] === marker)) {
    return emptyInlineToken();
  }
  const end = value.indexOf(marker, index + 1);
  if (end <= index + 1) {
    return emptyInlineToken();
  }
  return {
    start: index,
    end: end + 1,
    kind: 'emphasis',
    text: value.slice(index + 1, end),
    href: ''
  };
}

function emptyInlineToken(): InlineToken {
  return {
    start: -1,
    end: -1,
    kind: '',
    text: '',
    href: ''
  };
}

function pushInlineSegment(
  segments: SessionMarkdownInlineSegment[],
  id: string,
  kind: string,
  text: string,
  href: string
): void {
  if (text.length === 0) {
    return;
  }
  segments.push({ id, kind, text, href });
}

function markdownTableCells(line: string): string[] {
  let value = line.trim();
  if (value.startsWith('|')) {
    value = value.slice(1);
  }
  if (value.endsWith('|')) {
    value = value.slice(0, value.length - 1);
  }
  if (value.indexOf('|') < 0) {
    return [];
  }
  return value.split('|').map((cell: string) => cell.trim());
}

function markdownTableAlignment(separator: string): string {
  const value = separator.replace(/\s/g, '');
  if (value.startsWith(':') && value.endsWith(':')) {
    return 'center';
  }
  if (value.endsWith(':')) {
    return 'right';
  }
  return 'left';
}

function normalizeToolItem(item: CodexSessionToolItem, index: number): SessionToolPresentationItem {
  return {
    id: item.id.length > 0 ? item.id : `tool-${index}`,
    name: item.name,
    verb: item.verb.length > 0 ? item.verb : 'Called',
    target: item.target.length > 0 ? item.target : item.name,
    detail: item.detail,
    status: item.status.length > 0 ? item.status : 'completed',
    retryCount: item.retryCount,
    args: item.args,
    taskName: item.taskName,
    agents: item.agents
  };
}

function legacyToolPresentationItems(text: string): SessionToolPresentationItem[] {
  const value = String(text ?? '').trim();
  const lines = value.split(/\r?\n/);
  const commandItems: SessionToolPresentationItem[] = [];
  for (const line of lines) {
    const match = line.match(/^\d+\.\s+(.+)$/);
    if (match !== null) {
      commandItems.push({
        id: `legacy-command-${commandItems.length}`,
        name: 'shell_command',
        verb: 'Ran',
        target: match[1],
        detail: '',
        status: 'completed'
      });
    }
  }
  if (commandItems.length > 0) {
    return commandItems;
  }
  if (value.startsWith('正在执行 ')) {
    return [{
      id: 'legacy-running-command',
      name: 'shell_command',
      verb: 'Running',
      target: value.slice('正在执行 '.length).trim(),
      detail: '',
      status: 'running'
    }];
  }
  if (value.startsWith('正在调用 ')) {
    const name = value.slice('正在调用 '.length).trim();
    return [{
      id: 'legacy-running-tool',
      name,
      verb: 'Calling',
      target: name,
      detail: '',
      status: 'running'
    }];
  }
  if (value === '已查看图片' || value === '正在查看图片') {
    return [{
      id: 'legacy-view-image',
      name: 'view_image',
      verb: value.startsWith('正在') ? 'Viewing' : 'Viewed',
      target: 'image',
      detail: '',
      status: value.startsWith('正在') ? 'running' : 'completed'
    }];
  }
  return [{
    id: 'legacy-tool',
    name: 'tool',
    verb: 'Tool',
    target: lines[0] ?? '工具调用',
    detail: lines.slice(1).join('\n').trim(),
    status: 'completed'
  }];
}
