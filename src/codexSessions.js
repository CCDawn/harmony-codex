import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createLiveActivityEntry } from './codexLiveActivity.js';
import { classifyCodexClientNotice, createCodexClientNoticeEntry } from './codexClientNotices.js';
import { extractVisibleWorkspaceRoots, extractWorkspaceLabels } from './codexProjects.js';
import { normalizeModelId, normalizeReasoningEffort } from './sessionSettingsStore.js';

const DEFAULT_CODEX_HOME = path.join(os.homedir(), '.codex');
const MAX_VISIBLE_MESSAGE_LENGTH = 20000;
const ACTIVITY_TAIL_BYTES = 1024 * 1024;
const SESSION_ACTIVITY_CACHE_LIMIT = 400;
const SESSION_ACTIVITY_RUNNING_TTL_MS = 15 * 1000;
const SESSION_DETAIL_FULL_READ_LIMIT_BYTES = 32 * 1024 * 1024;
const SESSION_DETAIL_TAIL_BYTES = 8 * 1024 * 1024;
const RECENT_ASSISTANT_PROGRESS_WINDOW_MS = 10 * 60 * 1000;

export class CodexSessionStore {
  constructor(options = {}) {
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? DEFAULT_CODEX_HOME;
    this.sessionIndexPath = path.join(this.codexHome, 'session_index.jsonl');
    this.globalStatePath = path.join(this.codexHome, '.codex-global-state.json');
    this.stateDbPath = path.join(this.codexHome, 'state_5.sqlite');
    this.sessionsRoot = path.join(this.codexHome, 'sessions');
    this.mobileImagesDir = options.mobileImagesDir ?? path.join(process.cwd(), 'logs', 'mobile-images');
    this.sessionDetailFullReadLimitBytes = positiveNumber(
      options.sessionDetailFullReadLimitBytes,
      SESSION_DETAIL_FULL_READ_LIMIT_BYTES
    );
    this.sessionDetailTailBytes = positiveNumber(options.sessionDetailTailBytes, SESSION_DETAIL_TAIL_BYTES);
  }

  async listSessions({ limit = 50, query = '' } = {}) {
    const desktopSessions = await this.listDesktopSidebarSessions({ limit, query });
    if (desktopSessions.length > 0) {
      return desktopSessions;
    }
    return this.listSessionIndexSessions({ limit, query });
  }

  async listDesktopProjects() {
    const state = await readDesktopSidebarState(this.globalStatePath);
    return [...state.visibleWorkspaceRoots].map((root) => ({
      root,
      name: projectLabelForRoot(root, state.workspaceLabels)
    }));
  }

  async decorateDesktopThreads(threads) {
    const state = await readDesktopSidebarState(this.globalStatePath);
    return threads.map((thread) => {
      const projectRoot = normalizeWorkspaceRoot(state.threadWorkspaceHints[thread.id] ?? thread.projectRoot);
      return {
        ...thread,
        pinned: thread.pinned || state.pinnedThreadIds.has(thread.id),
        projectRoot,
        projectLabel: projectRoot ? projectLabelForRoot(projectRoot, state.workspaceLabels) : '未归类',
        sidebarSection: state.projectlessThreadIds.has(thread.id) ? 'recent' : 'project'
      };
    }).sort((a, b) => Number(b.pinned) - Number(a.pinned));
  }

  async listDesktopSidebarSessions({ limit = 50, query = '' } = {}) {
    const [sidebarState, sessionIndex] = await Promise.all([
      readDesktopSidebarState(this.globalStatePath),
      this.readSessionIndexSummaries()
    ]);
    const normalizedQuery = query.trim().toLowerCase();
    const max = clampLimit(limit);
    let rows = [];

    try {
      const db = new DatabaseSync(this.stateDbPath, { readOnly: true });
      rows = db.prepare(`
        SELECT id, rollout_path, title, cwd, updated_at_ms, updated_at, thread_source, source, archived, first_user_message, preview, has_user_event
        FROM threads
        WHERE COALESCE(archived, 0) = 0
          AND COALESCE(thread_source, '') != 'subagent'
          AND COALESCE(source, '') != 'exec'
        ORDER BY COALESCE(updated_at_ms, 0) DESC, COALESCE(updated_at, 0) DESC
        LIMIT 500
      `).all();
      db.close();
    } catch {
      return [];
    }

    const [filePathsById, existingRolloutPaths] = await Promise.all([
      this.listSessionFilePathsById(),
      collectExistingRolloutPathInfo(rows)
    ]);
    const sessions = rows
      .map((row) => buildDesktopSessionCandidate(row, sessionIndex, sidebarState, filePathsById, existingRolloutPaths))
      .filter((candidate) => candidate.id.length > 0)
      .filter((candidate) => Boolean(candidate.fileInfo))
      .filter((candidate) => isDesktopVisibleSession(candidate, sidebarState))
      .filter((candidate) => {
        if (normalizedQuery.length === 0) {
          return true;
        }
        return `${candidate.id} ${candidate.title} ${candidate.projectLabel} ${candidate.projectRoot}`.toLowerCase().includes(normalizedQuery);
      })
      .sort((left, right) => {
        if (left.pinned !== right.pinned) {
          return left.pinned ? -1 : 1;
        }
        return right.updatedAtMs - left.updatedAtMs;
      })
      .slice(0, max)
      .map((candidate) => finalizeDesktopSessionCandidate(candidate));

    return sessions;
  }

  async listSessionIndexSessions({ limit = 50, query = '' } = {}) {
    const [records, sidebarState] = await Promise.all([
      readJsonl(this.sessionIndexPath),
      readDesktopSidebarState(this.globalStatePath)
    ]);
    const latestById = new Map();
    for (const record of records) {
      if (!record.id) {
        continue;
      }
      const previous = latestById.get(record.id);
      if (!previous || String(record.updated_at ?? '').localeCompare(String(previous.updated_at ?? '')) >= 0) {
        latestById.set(record.id, record);
      }
    }

    const normalizedQuery = query.trim().toLowerCase();
    return [...latestById.values()]
      .filter((record) => {
        if (normalizedQuery.length === 0) {
          return true;
        }
        return `${record.id ?? ''} ${record.thread_name ?? ''}`.toLowerCase().includes(normalizedQuery);
      })
      .sort((left, right) => String(right.updated_at ?? '').localeCompare(String(left.updated_at ?? '')))
      .slice(0, clampLimit(limit))
      .map((record) => {
        const id = String(record.id);
        const projectRoot = normalizeWorkspaceRoot(sidebarState.threadWorkspaceHints[id] ?? '');
        return {
          id,
          title: String(record.thread_name ?? '未命名会话'),
          updatedAt: String(record.updated_at ?? ''),
          relativeTime: '',
          projectRoot,
          projectLabel: projectRoot.length > 0 ? projectLabelForRoot(projectRoot, sidebarState.workspaceLabels) : '未归类',
          sidebarSection: sidebarState.projectlessThreadIds.has(id) ? 'recent' : 'project',
          source: 'session-index',
          activitySource: 'unknown',
          activityStatus: 'idle',
          activityUpdatedAt: '',
          runtimeState: 'idle',
          runtimeSource: 'unknown',
          runtimeUpdatedAt: '',
          canInterrupt: false,
          terminalReason: '',
          pinned: sidebarState.pinnedThreadIds.has(id),
          detailAvailable: true
        };
      });
  }

  async getSessionReasoningEffort(sessionId) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(sessionId ?? ''))) {
      return '';
    }
    let db = null;
    try {
      db = new DatabaseSync(this.stateDbPath, { readOnly: true });
      const row = db.prepare('SELECT reasoning_effort FROM threads WHERE id = ?').get(String(sessionId));
      return normalizeReasoningEffort(row?.reasoning_effort ?? '');
    } catch {
      return '';
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore sqlite close failures during best-effort desktop state reads.
      }
    }
  }

  async getSessionModel(sessionId) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(sessionId ?? ''))) {
      return '';
    }
    let db = null;
    try {
      db = new DatabaseSync(this.stateDbPath, { readOnly: true });
      const row = db.prepare('SELECT model FROM threads WHERE id = ?').get(String(sessionId));
      return normalizeModelId(row?.model ?? '');
    } catch {
      return '';
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore sqlite close failures during best-effort desktop state reads.
      }
    }
  }

  async getSessionSummaryById(sessionId) {
    const bareSummary = {
      id: sessionId,
      title: '未命名会话',
      updatedAt: '',
      detailAvailable: false
    };
    const sidebarState = await readDesktopSidebarState(this.globalStatePath);
    let row = null;
    let desktopDbReadable = true;
    try {
      const db = new DatabaseSync(this.stateDbPath, { readOnly: true });
      row = db.prepare(`
        SELECT id, rollout_path, title, cwd, updated_at_ms, updated_at, first_user_message, preview
        FROM threads
        WHERE id = ?
          AND COALESCE(archived, 0) = 0
          AND COALESCE(thread_source, '') != 'subagent'
          AND COALESCE(source, '') != 'exec'
      `).get(String(sessionId)) ?? null;
      db.close();
    } catch {
      desktopDbReadable = false;
      row = null;
    }

    if (row) {
      const id = String(row.id ?? '');
      const rolloutPath = normalizeFilePath(row.rollout_path ?? '');
      const [fileInfo, indexRecord] = await Promise.all([
        this.getSessionFileInfoForId(id, rolloutPath),
        readLatestSessionIndexRecord(this.sessionIndexPath, id)
      ]);
      const indexSummary = indexRecord
        ? { title: String(indexRecord.thread_name ?? ''), updatedAt: String(indexRecord.updated_at ?? '') }
        : null;
      return buildDesktopSessionSummary(row, fileInfo, sidebarState, indexSummary) ?? bareSummary;
    }
    if (desktopDbReadable && (await this.hasDesktopSidebarRows())) {
      // Desktop sidebar database is readable and non-empty: an id missing from it stays a bare
      // summary, mirroring how listDesktopSidebarSessions filters it out of listSessions.
      return bareSummary;
    }
    const indexRecord = await readLatestSessionIndexRecord(this.sessionIndexPath, sessionId);
    if (indexRecord) {
      return buildSessionIndexSummary(indexRecord, sidebarState);
    }
    return bareSummary;
  }

  async hasDesktopSidebarRows() {
    try {
      const db = new DatabaseSync(this.stateDbPath, { readOnly: true });
      const row = db.prepare(`
        SELECT 1 FROM threads
        WHERE COALESCE(archived, 0) = 0
          AND COALESCE(thread_source, '') != 'subagent'
          AND COALESCE(source, '') != 'exec'
        LIMIT 1
      `).get();
      db.close();
      return Boolean(row);
    } catch {
      return false;
    }
  }

  async getSessionFileInfoForId(sessionId, rolloutPath) {
    if (rolloutPath.length > 0) {
      return sessionFileInfo(rolloutPath);
    }
    const files = await collectFiles(this.sessionsRoot);
    const matches = files.filter((file) => path.basename(file).includes(sessionId) && file.endsWith('.jsonl'));
    matches.sort((left, right) => right.localeCompare(left));
    return matches.length > 0 ? sessionFileInfo(matches[0]) : null;
  }

  async getSession(sessionId, { tail = 80 } = {}) {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
      const error = new Error('Invalid Codex session id');
      error.statusCode = 400;
      throw error;
    }

    const summary = await this.getSessionSummaryById(sessionId);
    const filePath = await this.findSessionFile(sessionId);
    if (!filePath) {
      return {
        ...summary,
        filePath: '',
        detailAvailable: false,
        entries: [{
          timestamp: new Date().toISOString(),
          type: 'missing_session_file',
          role: 'system',
          text: '这个会话仍在 Codex 桌面侧栏数据库中，但本地会话文件已经不存在或已被归档，暂时无法在手机端读取历史内容。'
        }],
        entryCount: 1
      };
    }
    const lines = await readSessionDetailLines(filePath, {
      fullReadLimitBytes: this.sessionDetailFullReadLimitBytes,
      tailBytes: this.sessionDetailTailBytes
    });
    const records = parseSessionRecordLines(lines);
    const visibleTail = clampLimit(tail, 200);
    const stat = await fs.stat(filePath).catch(() => null);
    const activity = summarizeActivityRecords(records, {
      fileUpdatedAtMs: Number(stat?.mtimeMs ?? 0)
    });
    const activeTurnStartedAt = latestVisibleUserTimestamp(records, { mobileImagesDir: this.mobileImagesDir });
    const parsedEntries = parseSessionRecords(records, {
      mobileImagesDir: this.mobileImagesDir,
      pendingToolCallsActive: activity.status === 'running',
      pendingToolCallsActiveAfter: activeTurnStartedAt
    });
    const hasDetailActivity = activity.updatedAt.length > 0 || activity.status !== 'idle';
    const liveActivity = activity.status === 'running'
      ? summarizeLiveActivityFromRecords(records, { threadId: sessionId, afterTimestamp: activeTurnStartedAt })
      : null;
    const entries = appendLiveActivityEntry(parsedEntries.slice(-visibleTail), liveActivity);
    const effectiveActivity = hasDetailActivity
      ? activity
      : {
          status: summary.runtimeState ?? summary.activityStatus ?? activity.status,
          updatedAt: summary.runtimeUpdatedAt ?? summary.activityUpdatedAt ?? activity.updatedAt,
          terminalReason: summary.terminalReason ?? activity.terminalReason ?? ''
        };
    const runtime = createSessionRuntimeSnapshot(
      effectiveActivity,
      hasDetailActivity ? 'session-file' : (summary.runtimeSource ?? summary.activitySource ?? 'unknown')
    );
    return {
      ...summary,
      activityStatus: runtime.runtimeState,
      activityUpdatedAt: runtime.runtimeUpdatedAt,
      ...runtime,
      lastVisibleRole: hasDetailActivity ? activity.lastVisibleRole : (summary.lastVisibleRole ?? activity.lastVisibleRole),
      detailAvailable: true,
      filePath,
      entries,
      entryCount: entries.length
    };
  }

  async getSessionSync(sessionId, { limit = 80, after = '', before = '' } = {}) {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
      const error = new Error('Invalid Codex session id');
      error.statusCode = 400;
      throw error;
    }

    const summary = await this.getSessionSummaryById(sessionId);
    const filePath = await this.findSessionFile(sessionId);
    if (!filePath) {
      return {
        ...summary,
        filePath: '',
        detailAvailable: false,
        entries: [{
          timestamp: new Date().toISOString(),
          type: 'missing_session_file',
          role: 'system',
          text: '这个会话仍在 Codex 桌面侧栏数据库中，但本地会话文件已经不存在或已被归档，暂时无法在手机端读取历史内容。'
        }],
        entryCount: 1,
        sync: createEmptySessionSync({ mode: 'missing' })
      };
    }

    const pageLimit = clampLimit(limit, 200);
    const afterOffset = parseSyncOffset(after);
    const beforeOffset = parseSyncOffset(before);
    const mode = afterOffset !== null ? 'after' : (beforeOffset !== null ? 'before' : 'recent');
    let page = await readSessionSyncLinePage(filePath, {
      mode,
      limit: pageLimit,
      afterOffset,
      beforeOffset,
      fullReadLimitBytes: this.sessionDetailFullReadLimitBytes,
      tailBytes: this.sessionDetailTailBytes
    });
    if (mode === 'recent') {
      page = await expandRecentSyncPageToUserAnchor(filePath, page, {
        limit: pageLimit,
        tailBytes: this.sessionDetailTailBytes,
        fullReadLimitBytes: this.sessionDetailFullReadLimitBytes,
        mobileImagesDir: this.mobileImagesDir
      });
    }
    const records = parseSessionRecordLineEntries(page.lineEntries);
    const activity = summarizeActivityRecords(records, {
      fileUpdatedAtMs: Number(page.stat?.mtimeMs ?? 0)
    });
    const fullActivity = mode === 'after'
      ? summarizeSessionActivity(filePath)
      : activity;
    const activeTurnStartedAt = latestVisibleUserTimestamp(records, { mobileImagesDir: this.mobileImagesDir });
    const parsedEntries = parseSessionRecords(records, {
      mobileImagesDir: this.mobileImagesDir,
      pendingToolCallsActive: mode !== 'before' && fullActivity.status === 'running',
      pendingToolCallsActiveAfter: activeTurnStartedAt
    });
    const visibleEntries = trimEntriesForSyncPage(parsedEntries, pageLimit, mode);
    const hasTrimmedAfterEntries = mode === 'after' && parsedEntries.length > visibleEntries.length;
    const hasDetailActivity = fullActivity.updatedAt.length > 0 || fullActivity.status !== 'idle';
    const liveActivity = mode !== 'before' && fullActivity.status === 'running'
      ? summarizeLiveActivityFromRecords(records, { threadId: sessionId, afterTimestamp: activeTurnStartedAt })
      : null;
    const entries = mode === 'before'
      ? visibleEntries
      : appendLiveActivityEntry(visibleEntries, liveActivity);
    const sync = createSessionSync({
      mode,
      filePath,
      stat: page.stat,
      lineEntries: page.lineEntries,
      entries,
      afterOffset,
      beforeOffset,
      hasMoreBefore: page.hasMoreBefore,
      hasMoreAfter: page.hasMoreAfter || hasTrimmedAfterEntries
    });
    const effectiveActivity = hasDetailActivity
      ? fullActivity
      : {
          status: summary.runtimeState ?? summary.activityStatus ?? fullActivity.status,
          updatedAt: summary.runtimeUpdatedAt ?? summary.activityUpdatedAt ?? fullActivity.updatedAt,
          terminalReason: summary.terminalReason ?? fullActivity.terminalReason ?? ''
        };
    const runtime = createSessionRuntimeSnapshot(
      effectiveActivity,
      hasDetailActivity ? 'session-file' : (summary.runtimeSource ?? summary.activitySource ?? 'unknown')
    );
    return {
      ...summary,
      activityStatus: runtime.runtimeState,
      activityUpdatedAt: runtime.runtimeUpdatedAt,
      ...runtime,
      lastVisibleRole: hasDetailActivity ? fullActivity.lastVisibleRole : (summary.lastVisibleRole ?? fullActivity.lastVisibleRole),
      detailAvailable: true,
      filePath,
      entries,
      entryCount: entries.length,
      sync
    };
  }

  async verifySessionTarget(sessionId, fingerprint = {}) {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
      const error = new Error('Invalid Codex session id');
      error.statusCode = 400;
      throw error;
    }

    const detail = await this.getSession(sessionId, { tail: 1 });
    if (detail.detailAvailable === false) {
      const error = new Error('目标会话缺少本地历史文件，已阻止发送，避免消息串到其他会话。');
      error.statusCode = 409;
      throw error;
    }

    const expectedFilePath = normalizeFilePath(fingerprint?.filePath ?? '');
    const actualFilePath = normalizeFilePath(detail.filePath ?? '');
    if (expectedFilePath.length > 0 && actualFilePath.length > 0 && expectedFilePath !== actualFilePath) {
      const error = new Error('手机端会话文件指纹已过期，已阻止发送。请重新打开这个会话后再发送。');
      error.statusCode = 409;
      throw error;
    }

    const expectedProjectRoot = normalizeWorkspaceRoot(fingerprint?.projectRoot ?? '');
    const actualProjectRoot = normalizeWorkspaceRoot(detail.projectRoot ?? '');
    if (expectedProjectRoot.length > 0 && actualProjectRoot.length > 0 && expectedProjectRoot !== actualProjectRoot) {
      const error = new Error('手机端会话项目指纹与本地 Codex 记录不一致，已阻止发送。请重新选择会话。');
      error.statusCode = 409;
      throw error;
    }

    return {
      id: detail.id,
      title: detail.title,
      projectRoot: detail.projectRoot ?? '',
      projectLabel: detail.projectLabel ?? '',
      filePath: actualFilePath,
      entryCount: detail.entryCount,
      verifiedAt: new Date().toISOString()
    };
  }

  async getSessionFileCursor(sessionId, filePath = '') {
    const resolvedPath = normalizeFilePath(filePath) || await this.findSessionFile(sessionId);
    if (!resolvedPath) {
      return null;
    }

    try {
      const stat = await fs.stat(resolvedPath);
      if (!stat.isFile()) {
        return null;
      }
      return {
        sessionId,
        filePath: resolvedPath,
        offset: stat.size,
        updatedAtMs: stat.mtimeMs
      };
    } catch {
      return null;
    }
  }

  async readSessionEntriesAfterCursor(cursor) {
    const records = await this.readSessionRecordsAfterCursor(cursor);
    return parseSessionRecords(records, { mobileImagesDir: this.mobileImagesDir });
  }

  async readSessionRecordsAfterCursor(cursor) {
    if (!cursor?.filePath || !Number.isFinite(Number(cursor.offset))) {
      return [];
    }

    const filePath = normalizeFilePath(cursor.filePath);
    const startOffset = Math.max(0, Number(cursor.offset));
    let handle = null;
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile() || stat.size <= startOffset) {
        return [];
      }

      const byteLength = stat.size - startOffset;
      const buffer = Buffer.alloc(byteLength);
      handle = await fs.open(filePath, 'r');
      await handle.read(buffer, 0, byteLength, startOffset);
      const lines = buffer.toString('utf8').split(/\r?\n/).filter((line) => line.trim().length > 0);
      return parseSessionRecordLines(lines);
    } catch {
      return [];
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async findSessionFile(sessionId) {
    const rolloutPath = await this.getThreadRolloutPath(sessionId);
    if (rolloutPath && await fileExists(rolloutPath)) {
      return rolloutPath;
    }

    const files = await collectFiles(this.sessionsRoot);
    const matches = files.filter((file) => path.basename(file).includes(sessionId) && file.endsWith('.jsonl'));
    matches.sort((left, right) => right.localeCompare(left));
    return matches[0] ?? null;
  }

  async getThreadRolloutPath(sessionId) {
    try {
      const db = new DatabaseSync(this.stateDbPath, { readOnly: true });
      const row = db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(sessionId);
      db.close();
      return normalizeFilePath(row?.rollout_path ?? '');
    } catch {
      return '';
    }
  }

  async listSessionFilePathsById() {
    const result = new Map();
    const files = await collectFiles(this.sessionsRoot);
    for (const file of files) {
      if (!file.endsWith('.jsonl')) {
        continue;
      }
      const match = path.basename(file).match(/([0-9a-f]{4,}-[0-9a-f-]{20,})/i);
      if (match) {
        result.set(match[1], await sessionFileInfo(file));
      }
    }
    return result;
  }

  async readSessionIndexSummaries() {
    const records = await readJsonl(this.sessionIndexPath);
    const latestById = new Map();
    for (const record of records) {
      if (!record.id) {
        continue;
      }
      const previous = latestById.get(record.id);
      if (!previous || String(record.updated_at ?? '').localeCompare(String(previous.updatedAt ?? '')) >= 0) {
        latestById.set(String(record.id), {
          id: String(record.id),
          title: String(record.thread_name ?? ''),
          updatedAt: String(record.updated_at ?? '')
        });
      }
    }
    return latestById;
  }
}

async function readJsonl(filePath) {
  let raw = '';
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return [];
  }

  const records = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      records.push(JSON.parse(line));
    } catch {
    }
  }
  return records;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

async function readDesktopSidebarState(filePath) {
  let parsed = {};
  try {
    parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    parsed = {};
  }
  return {
    workspaceLabels: extractWorkspaceLabels(parsed),
    threadWorkspaceHints: parsed['thread-workspace-root-hints'] ?? {},
    pinnedThreadIds: new Set(Array.isArray(parsed['pinned-thread-ids']) ? parsed['pinned-thread-ids'].map(String) : []),
    projectlessThreadIds: new Set(Array.isArray(parsed['projectless-thread-ids']) ? parsed['projectless-thread-ids'].map(String) : []),
    visibleWorkspaceRoots: new Set(extractVisibleWorkspaceRoots(parsed))
  };
}

function normalizePathArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(normalizeWorkspaceRoot).filter(Boolean);
}

function normalizeKeyedPaths(value) {
  const normalized = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return normalized;
  }
  for (const [key, label] of Object.entries(value)) {
    normalized[normalizeWorkspaceRoot(key)] = String(label);
  }
  return normalized;
}

function normalizeWorkspaceRoot(value) {
  return String(value ?? '')
    .replace(/^\\\\\?\\/, '')
    .replace(/[\\/]+$/, '');
}

function projectLabelForRoot(projectRoot, workspaceLabels) {
  const normalized = normalizeWorkspaceRoot(projectRoot);
  return workspaceLabels[normalized] ?? path.basename(normalized) ?? normalized;
}

function isDesktopVisibleSession(session, sidebarState) {
  if (session.pinned || sidebarState.projectlessThreadIds.has(session.id)) {
    return true;
  }
  const projectRoot = normalizeWorkspaceRoot(session.projectRoot);
  if (projectRoot.length === 0 || sidebarState.visibleWorkspaceRoots.size === 0) {
    return sidebarState.visibleWorkspaceRoots.size === 0;
  }
  for (const workspaceRoot of sidebarState.visibleWorkspaceRoots) {
    if (isSameOrChildPath(projectRoot, workspaceRoot)) {
      return true;
    }
  }
  return false;
}

function isSameOrChildPath(candidate, parent) {
  const left = normalizeWorkspaceRoot(candidate).toLowerCase();
  const right = normalizeWorkspaceRoot(parent).toLowerCase();
  return left === right || left.startsWith(`${right}${path.sep.toLowerCase()}`);
}

function cleanTitle(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= 100) {
    return text;
  }
  return `${text.slice(0, 100)}...`;
}

function formatRelativeTime(updatedAtMs) {
  if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0) {
    return '';
  }
  const diffMs = Date.now() - updatedAtMs;
  if (diffMs < 60 * 1000) {
    return '刚刚';
  }
  const minutes = Math.floor(diffMs / (60 * 1000));
  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} 小时前`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days} 天前`;
  }
  return new Date(updatedAtMs).toLocaleDateString('zh-CN');
}

async function collectFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let items = [];
    try {
      items = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      const fullPath = path.join(current, item.name);
      if (item.isDirectory()) {
        stack.push(fullPath);
      } else if (item.isFile()) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

async function fileExists(filePath) {
  if (!filePath) {
    return false;
  }
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function collectExistingRolloutPathInfo(rows) {
  const paths = [...new Set(rows.map((row) => normalizeFilePath(row.rollout_path ?? '')).filter(Boolean))];
  const existing = new Map();
  await Promise.all(paths.map(async (filePath) => {
    const info = await sessionFileInfo(filePath);
    if (info) {
      existing.set(filePath, info);
    }
  }));
  return existing;
}

function getKnownSessionFileInfo(sessionId, rolloutPath, filePathsById, existingRolloutPaths) {
  if (rolloutPath.length > 0) {
    return existingRolloutPaths.get(rolloutPath) ?? null;
  }
  return filePathsById.get(sessionId) ?? null;
}

async function sessionFileInfo(filePath) {
  if (!filePath) {
    return null;
  }
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return null;
    }
    return {
      path: filePath,
      updatedAtMs: stat.mtimeMs
    };
  } catch {
    return null;
  }
}

function buildDesktopSessionCandidate(row, sessionIndex, sidebarState, filePathsById, existingRolloutPaths) {
  const id = String(row.id ?? '');
  const indexSummary = sessionIndex.get(id);
  const rolloutPath = normalizeFilePath(row.rollout_path ?? '');
  const fileInfo = getKnownSessionFileInfo(id, rolloutPath, filePathsById, existingRolloutPaths);
  const title = cleanTitle(indexSummary?.title || row.title || row.first_user_message || row.preview || '未命名会话');
  const projectRoot = normalizeWorkspaceRoot(sidebarState.threadWorkspaceHints[id] ?? row.cwd ?? '');
  const desktopUpdatedAtMs = Number(row.updated_at_ms ?? 0);
  const fileUpdatedAtMs = Number(fileInfo?.updatedAtMs ?? 0);
  const updatedAtMs = fileUpdatedAtMs > 0 ? fileUpdatedAtMs : desktopUpdatedAtMs;
  return {
    id,
    title,
    updatedAt: updatedAtMs > 0 ? new Date(updatedAtMs).toISOString() : String(indexSummary?.updatedAt ?? ''),
    updatedAtMs,
    relativeTime: formatRelativeTime(updatedAtMs),
    projectRoot,
    projectLabel: projectRoot.length > 0 ? projectLabelForRoot(projectRoot, sidebarState.workspaceLabels) : '未归类',
    sidebarSection: sidebarState.projectlessThreadIds.has(id) ? 'recent' : 'project',
    source: 'desktop-sidebar',
    pinned: sidebarState.pinnedThreadIds.has(id),
    hasUserEvent: Number(row.has_user_event ?? 0) === 1,
    fileInfo
  };
}

function finalizeDesktopSessionCandidate(candidate) {
  // Activity tail parsing (1MB sync read + JSON per line) happens only here, after
  // filtering/sorting/truncation, so a list request pays it solely for returned sessions.
  const activity = summarizeSessionActivity(candidate.fileInfo?.path ?? '');
  const runtime = createSessionRuntimeSnapshot(
    activity,
    Number(candidate.fileInfo?.updatedAtMs ?? 0) > 0 ? 'session-file' : 'desktop-sidebar'
  );
  return {
    id: candidate.id,
    title: candidate.title,
    updatedAt: candidate.updatedAt,
    relativeTime: candidate.relativeTime,
    projectRoot: candidate.projectRoot,
    projectLabel: candidate.projectLabel,
    sidebarSection: candidate.sidebarSection,
    source: 'desktop-sidebar',
    activitySource: runtime.runtimeSource,
    activityStatus: runtime.runtimeState,
    activityUpdatedAt: runtime.runtimeUpdatedAt,
    ...runtime,
    lastVisibleRole: activity.lastVisibleRole,
    pinned: candidate.pinned,
    detailAvailable: true
  };
}

function buildDesktopSessionSummary(row, fileInfo, sidebarState, indexSummary) {
  const id = String(row.id ?? '');
  if (id.length === 0 || !fileInfo) {
    return null;
  }
  const title = cleanTitle(indexSummary?.title || row.title || row.first_user_message || row.preview || '未命名会话');
  const projectRoot = normalizeWorkspaceRoot(sidebarState.threadWorkspaceHints[id] ?? row.cwd ?? '');
  const desktopUpdatedAtMs = Number(row.updated_at_ms ?? 0);
  const fileUpdatedAtMs = Number(fileInfo.updatedAtMs ?? 0);
  const updatedAtMs = fileUpdatedAtMs > 0 ? fileUpdatedAtMs : desktopUpdatedAtMs;
  // No activity tail read here on purpose: getSession/getSessionSync recompute runtime state
  // from the detail window; the summary only carries neutral runtime fields for shape parity
  // with listSessions output.
  const runtime = createSessionRuntimeSnapshot(
    emptySessionActivity(),
    fileUpdatedAtMs > 0 ? 'session-file' : 'desktop-sidebar'
  );
  return {
    id,
    title,
    updatedAt: updatedAtMs > 0 ? new Date(updatedAtMs).toISOString() : String(indexSummary?.updatedAt ?? ''),
    relativeTime: formatRelativeTime(updatedAtMs),
    projectRoot,
    projectLabel: projectRoot.length > 0 ? projectLabelForRoot(projectRoot, sidebarState.workspaceLabels) : '未归类',
    sidebarSection: sidebarState.projectlessThreadIds.has(id) ? 'recent' : 'project',
    source: 'desktop-sidebar',
    activitySource: runtime.runtimeSource,
    activityStatus: runtime.runtimeState,
    activityUpdatedAt: runtime.runtimeUpdatedAt,
    ...runtime,
    lastVisibleRole: '',
    pinned: sidebarState.pinnedThreadIds.has(id),
    detailAvailable: true
  };
}

function buildSessionIndexSummary(record, sidebarState) {
  const id = String(record.id ?? '');
  const projectRoot = normalizeWorkspaceRoot(sidebarState.threadWorkspaceHints[id] ?? '');
  return {
    id,
    title: String(record.thread_name ?? '未命名会话'),
    updatedAt: String(record.updated_at ?? ''),
    relativeTime: '',
    projectRoot,
    projectLabel: projectRoot.length > 0 ? projectLabelForRoot(projectRoot, sidebarState.workspaceLabels) : '未归类',
    sidebarSection: sidebarState.projectlessThreadIds.has(id) ? 'recent' : 'project',
    source: 'session-index',
    activitySource: 'unknown',
    activityStatus: 'idle',
    activityUpdatedAt: '',
    runtimeState: 'idle',
    runtimeSource: 'unknown',
    runtimeUpdatedAt: '',
    canInterrupt: false,
    pinned: sidebarState.pinnedThreadIds.has(id),
    detailAvailable: true
  };
}

async function readLatestSessionIndexRecord(sessionIndexPath, sessionId) {
  const wanted = String(sessionId ?? '');
  if (wanted.length === 0) {
    return null;
  }
  const records = await readJsonl(sessionIndexPath);
  let latest = null;
  for (const record of records) {
    if (!record || String(record.id ?? '') !== wanted) {
      continue;
    }
    if (!latest || String(record.updated_at ?? '').localeCompare(String(latest.updated_at ?? '')) >= 0) {
      latest = record;
    }
  }
  return latest;
}

const sessionActivityCache = new Map();

function emptySessionActivity() {
  return {
    status: 'idle',
    updatedAt: '',
    terminalReason: '',
    lastVisibleRole: ''
  };
}

function summarizeSessionActivity(filePath) {
  if (!filePath) {
    return emptySessionActivity();
  }
  try {
    const stat = fsSync.statSync(filePath);
    const cacheKey = `${filePath}\u0000${stat.size}\u0000${stat.mtimeMs}`;
    const cached = sessionActivityCache.get(cacheKey);
    const runningVerdictIsStale = cached?.summary.status === 'running'
      && Date.now() - cached.computedAtMs > SESSION_ACTIVITY_RUNNING_TTL_MS;
    if (cached && !runningVerdictIsStale) {
      sessionActivityCache.delete(cacheKey);
      sessionActivityCache.set(cacheKey, cached);
      return { ...cached.summary };
    }
    const raw = readFileTail(filePath, ACTIVITY_TAIL_BYTES);
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const summary = summarizeActivityRecords(parseSessionRecordLines(lines), {
      fileUpdatedAtMs: stat.mtimeMs
    });
    sessionActivityCache.set(cacheKey, { summary, computedAtMs: Date.now() });
    while (sessionActivityCache.size > SESSION_ACTIVITY_CACHE_LIMIT) {
      const oldestKey = sessionActivityCache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      sessionActivityCache.delete(oldestKey);
    }
    return { ...summary };
  } catch {
    return emptySessionActivity();
  }
}

function createSessionRuntimeSnapshot(activity = {}, source = 'unknown') {
  const runtimeState = normalizeSessionRuntimeState(activity.status);
  return {
    runtimeState,
    runtimeSource: String(source || 'unknown'),
    runtimeUpdatedAt: String(activity.updatedAt ?? ''),
    canInterrupt: runtimeState === 'running',
    terminalReason: normalizeTerminalReason(activity.terminalReason, runtimeState)
  };
}

function normalizeSessionRuntimeState(status) {
  const normalized = String(status ?? '').trim().toLowerCase();
  if (normalized === 'running' || normalized === 'waiting_approval' || normalized === 'interrupted' || normalized === 'failed' || normalized === 'completed') {
    return normalized;
  }
  return 'idle';
}

function normalizeTerminalReason(reason, runtimeState) {
  const normalized = String(reason ?? '').trim().toLowerCase();
  if (normalized === 'completed' || normalized === 'interrupted' || normalized === 'failed') {
    return normalized;
  }
  if (runtimeState === 'completed' || runtimeState === 'interrupted' || runtimeState === 'failed') {
    return runtimeState;
  }
  return '';
}

function summarizeActivityRecords(records, options = {}) {
  let lastTaskStartedAt = '';
  let lastTaskCompleteAt = '';
  let lastTurnAbortedAt = '';
  let lastUserAt = '';
  let lastAssistantProgressAt = '';
  let lastAssistantFinalAt = '';
  let lastWorkStartedAt = '';
  let lastToolOutputAt = '';
  let lastVisibleAt = '';
  let lastVisibleRole = '';
  for (const record of records) {
    const timestamp = String(record.timestamp ?? '');
    const type = String(record.type ?? '');
    const payload = record.payload ?? {};
    if (isTurnAbortedRecord(record)) {
      lastTurnAbortedAt = latestTimestamp(lastTurnAbortedAt, timestamp);
      continue;
    }
    if (type === 'event_msg' && payload.type === 'task_started') {
      lastTaskStartedAt = timestamp;
      lastWorkStartedAt = latestTimestamp(lastWorkStartedAt, timestamp);
      continue;
    }
    if (type === 'event_msg' && payload.type === 'task_complete') {
      lastTaskCompleteAt = timestamp;
      continue;
    }
    if (type === 'response_item' && payload.type === 'function_call') {
      lastWorkStartedAt = latestTimestamp(lastWorkStartedAt, timestamp);
    } else if (type === 'response_item' && payload.type === 'reasoning') {
      lastWorkStartedAt = latestTimestamp(lastWorkStartedAt, timestamp);
    } else if (type === 'response_item' && payload.type === 'function_call_output') {
      lastToolOutputAt = latestTimestamp(lastToolOutputAt, timestamp);
    }
    const entry = summarizeRecord(record);
    if (entry) {
      lastVisibleAt = entry.timestamp;
      lastVisibleRole = entry.role;
      if (entry.role === 'user') {
        lastUserAt = entry.timestamp;
        lastAssistantProgressAt = '';
        lastAssistantFinalAt = '';
      } else if (entry.role === 'assistant') {
        if (String(payload.phase ?? '') === 'final_answer') {
          lastAssistantFinalAt = entry.timestamp;
        } else if (String(payload.phase ?? '') === 'commentary' || type === 'event_msg') {
          lastAssistantProgressAt = entry.timestamp;
          lastWorkStartedAt = latestTimestamp(lastWorkStartedAt, entry.timestamp);
        }
      }
    }
  }
  const terminal = latestTerminalRecord([
    { status: 'completed', at: lastTaskCompleteAt },
    { status: 'completed', at: lastAssistantFinalAt },
    { status: 'interrupted', at: lastTurnAbortedAt }
  ]);
  const lastTerminalAt = terminal?.at ?? '';
  const taskIsOpen = lastTaskStartedAt && (!lastTerminalAt || lastTaskStartedAt > lastTerminalAt);
  if (taskIsOpen) {
    const lastOpenActivityAt = latestTimestamp(lastWorkStartedAt, lastAssistantProgressAt, lastVisibleAt);
    const outputIsLatestOpenActivity = lastToolOutputAt
      && lastToolOutputAt >= lastOpenActivityAt
      && (!lastTerminalAt || lastToolOutputAt > lastTerminalAt);
    const taskActivityAt = outputIsLatestOpenActivity
      ? lastToolOutputAt
      : latestTimestamp(lastTaskStartedAt, lastAssistantProgressAt, lastWorkStartedAt);
    if (isRecentAssistantProgress(taskActivityAt, options)) {
      return {
        status: 'running',
        updatedAt: taskActivityAt,
        terminalReason: '',
        lastVisibleRole
      };
    }
  }
  if (
    lastUserAt &&
    (!lastTaskCompleteAt || lastUserAt > lastTaskCompleteAt) &&
    lastAssistantProgressAt &&
    !lastAssistantFinalAt &&
    isRecentAssistantProgress(lastAssistantProgressAt, options)
  ) {
    return {
      status: 'running',
      updatedAt: lastAssistantProgressAt,
      terminalReason: '',
      lastVisibleRole
    };
  }
  const lastPostTerminalActivityAt = latestTimestamp(lastAssistantProgressAt, lastWorkStartedAt, lastToolOutputAt);
  if (
    lastTerminalAt &&
    lastPostTerminalActivityAt > lastTerminalAt &&
    isRecentAssistantProgress(lastPostTerminalActivityAt, options)
  ) {
    return {
      status: 'running',
      updatedAt: lastPostTerminalActivityAt,
      terminalReason: '',
      lastVisibleRole
    };
  }
  if (!lastUserAt && lastAssistantProgressAt && (!lastTerminalAt || lastAssistantProgressAt > lastTerminalAt) && isRecentAssistantProgress(lastAssistantProgressAt, options)) {
    return {
      status: 'running',
      updatedAt: lastAssistantProgressAt,
      terminalReason: '',
      lastVisibleRole
    };
  }
  if (lastTerminalAt) {
    return {
      status: terminal.status,
      updatedAt: lastTerminalAt,
      terminalReason: terminal.status,
      lastVisibleRole
    };
  }
  return {
    status: 'idle',
    updatedAt: lastVisibleAt,
    terminalReason: '',
    lastVisibleRole
  };
}

function latestTerminalRecord(candidates) {
  let latest = null;
  for (const candidate of candidates) {
    const at = String(candidate.at ?? '');
    if (!at) {
      continue;
    }
    if (!latest || at > latest.at) {
      latest = {
        status: String(candidate.status ?? 'completed'),
        at
      };
    }
  }
  return latest;
}

function isRecentAssistantProgress(timestamp, options = {}) {
  const progressMs = Date.parse(timestamp || '');
  if (!Number.isFinite(progressMs)) {
    return false;
  }
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const fileUpdatedAtMs = Number(options.fileUpdatedAtMs ?? 0);
  const freshByRecordTime = nowMs - progressMs >= 0 && nowMs - progressMs <= RECENT_ASSISTANT_PROGRESS_WINDOW_MS;
  const freshByFileTime = fileUpdatedAtMs > 0 && Math.abs(fileUpdatedAtMs - progressMs) <= RECENT_ASSISTANT_PROGRESS_WINDOW_MS && nowMs - fileUpdatedAtMs <= RECENT_ASSISTANT_PROGRESS_WINDOW_MS;
  return freshByRecordTime || freshByFileTime;
}

function latestTimestamp(...values) {
  let latest = '';
  for (const value of values) {
    if (!value) {
      continue;
    }
    const timestamp = String(value);
    if (!latest || timestamp > latest) {
      latest = timestamp;
    }
  }
  return latest;
}

function readFileTail(filePath, maxBytes) {
  const fd = fsSync.openSync(filePath, 'r');
  try {
    const stat = fsSync.fstatSync(fd);
    const length = Math.min(stat.size, maxBytes);
    const start = Math.max(0, stat.size - length);
    const buffer = Buffer.alloc(length);
    fsSync.readSync(fd, buffer, 0, length, start);
    return buffer.toString('utf8');
  } finally {
    fsSync.closeSync(fd);
  }
}

function normalizeFilePath(value) {
  return String(value ?? '')
    .replace(/^\\\\\?\\/, '')
    .trim();
}

async function readAllLines(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

async function readAllLineEntries(filePath) {
  const buffer = await fs.readFile(filePath);
  return splitBufferLineEntries(buffer, 0);
}

async function readSessionDetailLines(filePath, options = {}) {
  const fullReadLimitBytes = positiveNumber(options.fullReadLimitBytes, SESSION_DETAIL_FULL_READ_LIMIT_BYTES);
  const tailBytes = positiveNumber(options.tailBytes, SESSION_DETAIL_TAIL_BYTES);
  const stat = await fs.stat(filePath);
  if (stat.size <= fullReadLimitBytes) {
    return readAllLines(filePath);
  }

  const bytesToRead = Math.min(stat.size, tailBytes);
  const startsInMiddle = stat.size > bytesToRead;
  const raw = readFileTail(filePath, bytesToRead);
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (startsInMiddle && lines.length > 0) {
    lines.shift();
  }
  return lines;
}

async function readSessionSyncLinePage(filePath, options = {}) {
  const stat = await fs.stat(filePath);
  const mode = options.mode ?? 'recent';
  const limit = clampLimit(options.limit, 200);
  const fullReadLimitBytes = positiveNumber(options.fullReadLimitBytes, SESSION_DETAIL_FULL_READ_LIMIT_BYTES);
  const tailBytes = positiveNumber(options.tailBytes, SESSION_DETAIL_TAIL_BYTES);

  if (mode === 'after') {
    const afterOffset = Math.min(Math.max(0, Number(options.afterOffset ?? 0)), stat.size);
    const lineEntries = await readLineEntriesAfterOffset(filePath, afterOffset, stat.size);
    return {
      stat,
      lineEntries,
      hasMoreBefore: afterOffset > 0,
      hasMoreAfter: false
    };
  }

  if (mode === 'before') {
    const beforeOffset = Math.min(Math.max(0, Number(options.beforeOffset ?? stat.size)), stat.size);
    const lineEntries = await readLineEntriesBeforeOffset(filePath, beforeOffset, {
      tailBytes,
      fullReadLimitBytes,
      limit
    });
    return {
      stat,
      lineEntries,
      hasMoreBefore: lineEntries.length > 0 ? lineEntries[0].startOffset > 0 : beforeOffset > 0,
      hasMoreAfter: beforeOffset < stat.size
    };
  }

  if (stat.size <= fullReadLimitBytes) {
    const allEntries = await readAllLineEntries(filePath);
    const lineEntries = allEntries.slice(-Math.max(limit * 8, limit + 40));
    return {
      stat,
      lineEntries,
      hasMoreBefore: lineEntries.length > 0 && lineEntries[0].startOffset > 0,
      hasMoreAfter: false
    };
  }

  const bytesToRead = Math.min(stat.size, Math.min(tailBytes, Math.max(256 * 1024, limit * 64 * 1024)));
  const startOffset = Math.max(0, stat.size - bytesToRead);
  const buffer = Buffer.alloc(bytesToRead);
  const handle = await fs.open(filePath, 'r');
  try {
    await handle.read(buffer, 0, bytesToRead, startOffset);
  } finally {
    await handle.close().catch(() => {});
  }
  const lineEntries = splitBufferLineEntries(buffer, startOffset);
  if (startOffset > 0 && lineEntries.length > 0) {
    lineEntries.shift();
  }
  return {
    stat,
    lineEntries: lineEntries.slice(-Math.max(limit * 8, limit + 40)),
    hasMoreBefore: lineEntries.length > 0 ? lineEntries[0].startOffset > 0 : startOffset > 0,
    hasMoreAfter: false
  };
}

async function readLineEntriesAfterOffset(filePath, afterOffset, fileSize) {
  if (!Number.isFinite(afterOffset) || afterOffset >= fileSize) {
    return [];
  }
  const byteLength = fileSize - afterOffset;
  const buffer = Buffer.alloc(byteLength);
  const handle = await fs.open(filePath, 'r');
  try {
    await handle.read(buffer, 0, byteLength, afterOffset);
  } finally {
    await handle.close().catch(() => {});
  }
  return splitBufferLineEntries(buffer, afterOffset);
}

async function readLineEntriesBeforeOffset(filePath, beforeOffset, options = {}) {
  if (!Number.isFinite(beforeOffset) || beforeOffset <= 0) {
    return [];
  }
  const fullReadLimitBytes = positiveNumber(options.fullReadLimitBytes, SESSION_DETAIL_FULL_READ_LIMIT_BYTES);
  const tailBytes = positiveNumber(options.tailBytes, SESSION_DETAIL_TAIL_BYTES);
  const limit = clampLimit(options.limit, 200);
  const bytesToRead = beforeOffset <= fullReadLimitBytes
    ? beforeOffset
    : Math.min(beforeOffset, Math.min(tailBytes, Math.max(256 * 1024, limit * 64 * 1024)));
  const startOffset = Math.max(0, beforeOffset - bytesToRead);
  const buffer = Buffer.alloc(bytesToRead);
  const handle = await fs.open(filePath, 'r');
  try {
    await handle.read(buffer, 0, bytesToRead, startOffset);
  } finally {
    await handle.close().catch(() => {});
  }
  const lineEntries = splitBufferLineEntries(buffer, startOffset)
    .filter((entry) => entry.endOffset <= beforeOffset);
  if (startOffset > 0 && lineEntries.length > 0) {
    lineEntries.shift();
  }
  return lineEntries.slice(-Math.max(limit * 8, limit + 40));
}

function splitBufferLineEntries(buffer, startOffset) {
  const entries = [];
  let lineStart = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) {
      continue;
    }
    const lineEnd = index > lineStart && buffer[index - 1] === 0x0d ? index - 1 : index;
    const line = buffer.toString('utf8', lineStart, lineEnd);
    if (line.trim().length > 0) {
      entries.push({
        line,
        startOffset: startOffset + lineStart,
        endOffset: startOffset + index + 1
      });
    }
    lineStart = index + 1;
  }
  if (lineStart < buffer.length) {
    const line = buffer.toString('utf8', lineStart);
    if (line.trim().length > 0) {
      entries.push({
        line,
        startOffset: startOffset + lineStart,
        endOffset: startOffset + buffer.length
      });
    }
  }
  return entries;
}

function parseSessionLines(lines, options = {}) {
  return parseSessionRecords(parseSessionRecordLines(lines), options);
}

function parseSessionRecordLines(lines) {
  const records = [];
  for (const line of lines) {
    let record = null;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    records.push(record);
  }
  return records;
}

function parseSessionRecordLineEntries(lineEntries) {
  const records = [];
  for (const entry of lineEntries) {
    let record = null;
    try {
      record = JSON.parse(entry.line);
    } catch {
      continue;
    }
    Object.defineProperty(record, '__syncStartOffset', {
      value: entry.startOffset,
      enumerable: false
    });
    Object.defineProperty(record, '__syncEndOffset', {
      value: entry.endOffset,
      enumerable: false
    });
    records.push(record);
  }
  return records;
}

function parseSessionRecords(records, options = {}) {
  const entries = [];
  for (const [recordIndex, record] of records.entries()) {
    const summarized = summarizeRecord(record, options);
    const recordEntries = Array.isArray(summarized) ? summarized : [summarized];
    for (const [entryIndex, entry] of recordEntries.entries()) {
      if (!entry) {
        continue;
      }
      entries.push(decorateSessionEntrySync(entry, record, recordIndex, entryIndex));
    }
  }
  const assignedEntries = assignSessionEntrySyncIds(compactToolStatusRuns(dedupeAdjacentMessages(entries), {
    pendingToolCallsActive: options.pendingToolCallsActive !== false,
    pendingToolCallsActiveAfter: options.pendingToolCallsActiveAfter ?? ''
  }));
  return dedupeStableSyncIdEntries(assignedEntries);
}

function decorateSessionEntrySync(entry, record, recordIndex, entryIndex) {
  const startOffset = Number(record.__syncStartOffset);
  const endOffset = Number(record.__syncEndOffset);
  if (!Number.isFinite(startOffset) || !Number.isFinite(endOffset)) {
    return entry;
  }
  return {
    ...entry,
    syncStartOffset: startOffset,
    syncEndOffset: endOffset,
    syncRecordIndex: recordIndex,
    syncEntryIndex: entryIndex
  };
}

function assignSessionEntrySyncIds(entries) {
  return entries.map((entry, index) => {
    if (entry.syncId) {
      return entry;
    }
    const startOffset = Number(entry.syncStartOffset);
    const endOffset = Number(entry.syncEndOffset);
    if (Number.isFinite(startOffset) && Number.isFinite(endOffset)) {
      return {
        ...entry,
        syncId: `${startOffset}:${endOffset}:${entry.role}:${entry.type}:${entry.itemId ?? entry.syncEntryIndex ?? index}`
      };
    }
    const hash = crypto.createHash('sha1')
      .update(`${entry.timestamp}|${entry.role}|${entry.type}|${entry.itemId ?? ''}|${entry.text ?? ''}`)
      .digest('hex')
      .slice(0, 16);
    return {
      ...entry,
      syncId: `entry:${hash}`
    };
  });
}

function dedupeStableSyncIdEntries(entries) {
  const deduped = [];
  const indexes = new Map();
  for (const entry of entries) {
    const syncId = String(entry.syncId ?? '');
    if (!syncId.startsWith('generated-image:')) {
      deduped.push(entry);
      continue;
    }
    const existingIndex = indexes.get(syncId);
    if (existingIndex === undefined) {
      indexes.set(syncId, deduped.length);
      deduped.push(entry);
      continue;
    }
    const preferred = preferredGeneratedImageEntry(deduped[existingIndex], entry);
    if (preferred === entry) {
      deduped.splice(existingIndex, 1);
      for (const [key, index] of indexes.entries()) {
        if (index > existingIndex) {
          indexes.set(key, index - 1);
        }
      }
      indexes.set(syncId, deduped.length);
      deduped.push(entry);
      continue;
    }
    deduped[existingIndex] = preferred;
  }
  return deduped;
}

function preferredGeneratedImageEntry(left, right) {
  const leftRank = visibleMessageSourceRank(left);
  const rightRank = visibleMessageSourceRank(right);
  if (rightRank > leftRank) {
    return right;
  }
  if (rightRank === leftRank && String(right.text ?? '').length >= String(left.text ?? '').length) {
    return right;
  }
  return left;
}

function trimEntriesForSyncPage(entries, limit, mode) {
  const max = clampLimit(limit, 200);
  if (mode === 'recent') {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index]?.role !== 'user') {
        continue;
      }
      const anchored = entries.slice(index);
      if (anchored.length <= max * 2) {
        return anchored;
      }
      const recent = entries.slice(-(max - 1));
      return [entries[index], ...recent];
    }
    return entries.slice(-max);
  }
  if (entries.length <= max) {
    return entries;
  }
  return mode === 'after' ? entries.slice(0, max) : entries.slice(-max);
}

async function expandRecentSyncPageToUserAnchor(filePath, page, options = {}) {
  let lineEntries = page.lineEntries ?? [];
  if (!page.hasMoreBefore || hasVisibleUserLineEntry(lineEntries, options)) {
    return page;
  }

  const limit = clampLimit(options.limit, 200);
  const baseTailBytes = positiveNumber(options.tailBytes, SESSION_DETAIL_TAIL_BYTES);
  const maxAttempts = 6;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const firstOffset = Number(lineEntries[0]?.startOffset ?? 0);
    if (!Number.isFinite(firstOffset) || firstOffset <= 0) {
      break;
    }
    const older = await readLineEntriesBeforeOffset(filePath, firstOffset, {
      tailBytes: baseTailBytes * (2 ** attempt),
      fullReadLimitBytes: options.fullReadLimitBytes,
      limit
    });
    if (older.length === 0) {
      continue;
    }
    lineEntries = mergeLineEntryPages(older, lineEntries);
    if (hasVisibleUserLineEntry(lineEntries, options)) {
      break;
    }
  }

  return {
    ...page,
    lineEntries,
    hasMoreBefore: lineEntries.length > 0 ? lineEntries[0].startOffset > 0 : page.hasMoreBefore
  };
}

function mergeLineEntryPages(left, right) {
  const seen = new Set();
  const merged = [];
  for (const entry of [...left, ...right]) {
    const key = `${entry.startOffset}:${entry.endOffset}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(entry);
  }
  return merged.sort((a, b) => Number(a.startOffset) - Number(b.startOffset));
}

function hasVisibleUserLineEntry(lineEntries, options = {}) {
  return latestVisibleUserTimestamp(parseSessionRecordLineEntries(lineEntries), options).length > 0;
}

function createSessionSync({ mode, filePath, stat, lineEntries, entries, afterOffset = null, beforeOffset = null, hasMoreBefore = false, hasMoreAfter = false }) {
  const visibleEntries = entries.filter((entry) => entry.type !== 'live_activity');
  const firstVisible = visibleEntries.find((entry) => Number.isFinite(Number(entry.syncStartOffset)));
  const lastVisible = [...visibleEntries].reverse().find((entry) => Number.isFinite(Number(entry.syncEndOffset)));
  const fileSize = Number(stat?.size ?? 0);
  const cursorStart = Number(firstVisible?.syncStartOffset);
  const cursorEnd = Number(lastVisible?.syncEndOffset);
  const fallbackStart = lineEntries.length > 0 ? Number(lineEntries[0].startOffset) : (beforeOffset ?? afterOffset ?? fileSize);
  const fallbackEnd = lineEntries.length > 0 ? Number(lineEntries.at(-1).endOffset) : (afterOffset ?? beforeOffset ?? fileSize);
  return {
    mode,
    source: 'session-file',
    filePath,
    fileSize,
    snapshotFileSize: fileSize,
    pageDirection: mode,
    fileUpdatedAt: new Date(Number(stat?.mtimeMs ?? 0)).toISOString(),
    cursorStart: String(Number.isFinite(cursorStart) ? cursorStart : fallbackStart),
    cursorEnd: String(mode === 'after' && visibleEntries.length === 0
      ? Math.max(fileSize, Number(afterOffset ?? 0))
      : (Number.isFinite(cursorEnd) ? cursorEnd : fallbackEnd)),
    hasMoreBefore: Boolean((hasMoreBefore || (Number.isFinite(cursorStart) ? cursorStart > 0 : fallbackStart > 0))
      && (Number.isFinite(cursorStart) ? cursorStart > 0 : fallbackStart > 0)),
    hasMoreAfter: Boolean(hasMoreAfter),
    entryCount: entries.length
  };
}

function createEmptySessionSync({ mode = 'empty' } = {}) {
  return {
    mode,
    source: 'session-file',
    filePath: '',
    fileSize: 0,
    fileUpdatedAt: '',
    cursorStart: '0',
    cursorEnd: '0',
    hasMoreBefore: false,
    hasMoreAfter: false,
    entryCount: 0
  };
}

function parseSyncOffset(value) {
  const text = String(value ?? '').trim();
  if (text.length === 0) {
    return null;
  }
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function appendLiveActivityEntry(entries, liveActivity) {
  const stableEntries = entries.filter((entry) => entry.type !== 'live_activity');
  if (!liveActivity) {
    return stableEntries;
  }
  return [...stableEntries, liveActivity];
}

function summarizeLiveActivityFromRecords(records, options = {}) {
  let latest = null;
  const afterTimestamp = String(options.afterTimestamp ?? '');
  for (const record of records) {
    const timestamp = String(record.timestamp ?? '');
    if (afterTimestamp.length > 0 && timestamp.length > 0 && timestamp < afterTimestamp) {
      continue;
    }
    const entry = summarizeLiveActivityRecord(record, options);
    if (entry) {
      latest = entry;
    }
  }
  if (latest) {
    return latest;
  }
  return createLiveActivityEntry({
    timestamp: new Date().toISOString(),
    kind: 'status',
    text: 'Codex 正在处理当前消息',
    threadId: options.threadId ?? ''
  });
}

function summarizeLiveActivityRecord(record, options = {}) {
  const timestamp = String(record.timestamp ?? '') || new Date().toISOString();
  const type = String(record.type ?? '');
  const payload = record.payload ?? {};

  if (type === 'event_msg' && payload.type === 'agent_message') {
    const text = sanitizeVisibleSessionText(extractTextElements(payload));
    if (text.length > 0) {
      return createLiveActivityEntry({
        timestamp,
        kind: 'assistant',
        role: 'assistant',
        text,
        threadId: options.threadId ?? '',
        turnId: String(payload.turn_id ?? payload.turnId ?? ''),
        itemId: String(payload.id ?? '')
      });
    }
  }

  if (type !== 'response_item') {
    return null;
  }

  if (payload.type === 'reasoning') {
    return createLiveActivityEntry({
      timestamp,
      kind: 'reasoning',
      text: extractReasoningSummary(payload),
      threadId: options.threadId ?? '',
      turnId: String(payload.turn_id ?? payload.turnId ?? ''),
      itemId: String(payload.id ?? '')
    });
  }

  if (payload.type === 'function_call') {
    const summary = summarizeFunctionCall(payload);
    if (summary.length === 0) {
      return null;
    }
    const kind = summary.startsWith('正在执行') ? 'command' : 'tool';
    return createLiveActivityEntry({
      timestamp,
      kind,
      text: stripActivityVerb(summary, kind),
      threadId: options.threadId ?? '',
      turnId: String(payload.turn_id ?? payload.turnId ?? ''),
      itemId: String(payload.call_id ?? payload.id ?? '')
    });
  }

  if (payload.type === 'function_call_output') {
    const output = typeof payload.output === 'string' ? summarizeToolOutput(payload.output) : '';
    const summary = output || summarizeFunctionCallOutput(payload);
    return createLiveActivityEntry({
      timestamp,
      kind: 'command',
      text: summary,
      threadId: options.threadId ?? '',
      turnId: String(payload.turn_id ?? payload.turnId ?? ''),
      itemId: String(payload.call_id ?? payload.id ?? '')
    });
  }

  if (payload.type === 'message' && payload.role === 'assistant' && payload.phase !== 'final_answer') {
    const text = sanitizeVisibleSessionText(extractMessageContent(payload.content, options));
    if (text.length > 0) {
      return createLiveActivityEntry({
        timestamp,
        kind: 'assistant',
        role: 'assistant',
        text,
        threadId: options.threadId ?? '',
        turnId: String(payload.turn_id ?? payload.turnId ?? ''),
        itemId: String(payload.id ?? '')
      });
    }
  }

  return null;
}

function stripActivityVerb(summary, kind) {
  const text = String(summary ?? '').trim();
  if (kind === 'command') {
    return text.replace(/^正在执行\s*/, '').replace(/^命令[:：]\s*/, '');
  }
  if (kind === 'tool') {
    return text.replace(/^正在调用\s*/, '');
  }
  return text;
}

function dedupeAdjacentMessages(entries) {
  const deduped = [];
  for (const entry of entries) {
    const previous = deduped.at(-1);
    if (previous && isDuplicateVisibleMessage(previous, entry)) {
      const merged = mergeVisibleMessages(previous, entry);
      previous.timestamp = merged.timestamp;
      previous.type = merged.type;
      previous.text = merged.text;
      if (Number.isFinite(Number(entry.syncEndOffset))) {
        previous.syncEndOffset = entry.syncEndOffset;
      }
      continue;
    }
    deduped.push(entry);
  }
  return deduped;
}

function compactToolStatusRuns(entries, options = {}) {
  const compacted = [];
  let toolRun = [];
  const flushToolRun = () => {
    if (toolRun.length === 0) {
      return;
    }
    const summarized = summarizeToolRun(toolRun, options);
    if (summarized) {
      compacted.push(summarized);
    }
    toolRun = [];
  };

  for (const entry of entries) {
    if (entry.role === 'tool' && (entry.type === 'tool_call' || entry.type === 'tool_result')) {
      toolRun.push(entry);
      continue;
    }
    flushToolRun();
    compacted.push(entry);
  }
  flushToolRun();
  return compacted;
}

function summarizeToolRun(entries, options = {}) {
  if (entries.length === 0) {
    return null;
  }
  const last = entries.at(-1);
  const toolItems = summarizeToolRunItems(entries);
  const completedCount = entries.filter(isCompletedToolResultEntry).reduce((sum, entry) => {
    const match = firstLine(entry.text).match(/^已运行\s+(\d+)\s+条命令$/);
    return sum + Number.parseInt(match?.[1] ?? '0', 10);
  }, 0);
  if (completedCount > 0) {
    return {
      timestamp: last.timestamp,
      type: 'tool_result',
      role: 'tool',
      text: `已运行 ${completedCount} 条命令`,
      toolItems,
      syncStartOffset: entries[0].syncStartOffset,
      syncEndOffset: last.syncEndOffset
    };
  }
  if (!shouldKeepPendingToolRunActive(last, options)) {
    return summarizeStalePendingToolRun(entries, toolItems);
  }
  return {
    ...last,
    toolItems,
    syncStartOffset: entries[0].syncStartOffset,
    syncEndOffset: last.syncEndOffset
  };
}

function shouldKeepPendingToolRunActive(lastEntry, options = {}) {
  if (options.pendingToolCallsActive === false) {
    return false;
  }
  const activeAfter = String(options.pendingToolCallsActiveAfter ?? '');
  if (activeAfter.length === 0) {
    return true;
  }
  const timestamp = String(lastEntry?.timestamp ?? '');
  return timestamp.length === 0 || timestamp >= activeAfter;
}

function summarizeStalePendingToolRun(entries, toolItems = summarizeToolRunItems(entries)) {
  const last = entries.at(-1);
  if (!last || last.type !== 'tool_call') {
    return last ? {
      ...last,
      toolItems,
      syncStartOffset: entries[0]?.syncStartOffset,
      syncEndOffset: last.syncEndOffset
    } : null;
  }
  const command = commandFromToolCallText(last.text);
  const detail = command.length > 0 ? `\n\n${command}` : '';
  return {
    ...last,
    type: 'tool_result',
    role: 'tool',
    text: `命令未返回，已停止跟踪${detail}`,
    toolItems: toolItems.map((item) => item.status === 'running' ? { ...item, status: 'stopped' } : item),
    syncStartOffset: entries[0]?.syncStartOffset,
    syncEndOffset: last.syncEndOffset
  };
}

function latestVisibleUserTimestamp(records, options = {}) {
  let latest = '';
  for (const record of records) {
    const summarized = summarizeRecord(record, options);
    const entries = Array.isArray(summarized) ? summarized : [summarized];
    for (const entry of entries) {
      if (entry?.role === 'user' && String(entry.timestamp ?? '').length > 0) {
        latest = String(entry.timestamp);
      }
    }
  }
  return latest;
}

function isCompletedToolResultEntry(entry) {
  return entry.role === 'tool'
    && entry.type === 'tool_result'
    && /^已运行\s+\d+\s+条命令$/.test(firstLine(entry.text));
}

function summarizeToolRunItems(entries) {
  const items = [];
  const itemIndexesByCallId = new Map();
  for (const entry of entries) {
    if (entry.type === 'tool_call') {
      for (const sourceItem of Array.isArray(entry.toolItems) ? entry.toolItems : []) {
        const item = { ...sourceItem };
        const itemIndex = items.length;
        items.push(item);
        if (String(entry.toolCallId ?? '').length > 0) {
          itemIndexesByCallId.set(String(entry.toolCallId), itemIndex);
        }
      }
      continue;
    }
    if (entry.type !== 'tool_result') {
      continue;
    }
    const callId = String(entry.toolCallId ?? '');
    let itemIndex = callId.length > 0 ? itemIndexesByCallId.get(callId) : undefined;
    if (!Number.isInteger(itemIndex)) {
      itemIndex = items.findIndex((item) => item.status === 'running');
    }
    if (!Number.isInteger(itemIndex) || itemIndex < 0) {
      continue;
    }
    const item = items[itemIndex];
    const updatedItem = {
      ...item,
      detail: String(entry.toolOutputDetail ?? '').trim(),
      status: toolResultStatus(entry)
    };
    if (Array.isArray(entry.toolAgents) && entry.toolAgents.length > 0) {
      updatedItem.agents = entry.toolAgents;
    }
    items[itemIndex] = updatedItem;
  }
  return items.slice(0, 50);
}

function toolResultStatus(entry) {
  const detail = String(entry.toolOutputDetail ?? entry.text ?? '');
  if (/(?:Exit code:|Process exited with code)\s*[1-9]\d*/i.test(detail)) {
    return 'failed';
  }
  return 'completed';
}

function commandFromToolCallText(text) {
  const value = String(text ?? '').trim();
  const commandPrefix = '正在执行 ';
  if (value.startsWith(commandPrefix)) {
    return value.slice(commandPrefix.length).trim();
  }
  return value;
}

function toolResultDetailText(text) {
  const lines = String(text ?? '').split(/\r?\n/).slice(1).join('\n').trim();
  return truncateInline(lines, 500);
}

function firstLine(text) {
  return String(text ?? '').split(/\r?\n/, 1)[0].trim();
}

function isDuplicateVisibleMessage(left, right) {
  if (left.role !== right.role) {
    return false;
  }
  if (left.role === 'tool') {
    return false;
  }
  const leftText = normalizeMessageForDedupe(left.text);
  const rightText = normalizeMessageForDedupe(right.text);
  if (leftText.length === 0 || rightText.length === 0) {
    return false;
  }
  if (leftText === rightText) {
    return true;
  }
  if (isDuplicateMessageSourcePair(left, right) && areMessageTimestampsClose(left.timestamp, right.timestamp)) {
    return leftText.includes(rightText) || rightText.includes(leftText);
  }
  return false;
}

function mergeVisibleMessages(left, right) {
  const leftTextLength = String(left.text ?? '').length;
  const rightTextLength = String(right.text ?? '').length;
  const richer = rightTextLength > leftTextLength
    ? right
    : (rightTextLength === leftTextLength && visibleMessageSourceRank(right) > visibleMessageSourceRank(left) ? right : left);
  return {
    timestamp: right.timestamp || left.timestamp,
    type: richer.type || right.type || left.type,
    text: richer.text
  };
}

function normalizeMessageForDedupe(value) {
  return stripDedupeOnlyBlocks(value).replace(/\s+/g, ' ').trim();
}

function stripDedupeOnlyBlocks(value) {
  return String(value ?? '')
    .replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/gi, '')
    .replace(/<citation_entries>[\s\S]*?<\/citation_entries>/gi, '')
    .replace(/<rollout_ids>[\s\S]*?<\/rollout_ids>/gi, '');
}

function isDuplicateMessageSourcePair(left, right) {
  if (left.type === right.type) {
    return false;
  }
  return visibleMessageSourceRank(left) > 0 && visibleMessageSourceRank(right) > 0;
}

function visibleMessageSourceRank(entry) {
  if (entry.type === 'response_item') {
    return 2;
  }
  if (entry.type === 'event_msg') {
    return 1;
  }
  return 0;
}

function areMessageTimestampsClose(leftTimestamp, rightTimestamp) {
  const left = Date.parse(String(leftTimestamp ?? ''));
  const right = Date.parse(String(rightTimestamp ?? ''));
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return false;
  }
  return Math.abs(left - right) <= 2000;
}

function summarizeRecord(record, options = {}) {
  const timestamp = String(record.timestamp ?? '');
  const type = String(record.type ?? 'unknown');
  const payload = record.payload ?? {};
  const noticeEntry = summarizeCodexClientNoticeRecord(record, options);
  if (noticeEntry) {
    return noticeEntry;
  }

  if (type === 'event_msg' && payload.type === 'user_message') {
    const text = extractTextElements(payload);
    if (isInternalSessionText(text)) {
      return null;
    }
    const visibleText = sanitizeVisibleSessionText(text, { stripLeadingSkillToken: true });
    if (visibleText.length === 0) {
      return null;
    }
    return {
      timestamp,
      type,
      role: 'user',
      text: truncate(visibleText, MAX_VISIBLE_MESSAGE_LENGTH)
    };
  }

  if (type === 'event_msg' && payload.type === 'agent_message') {
    const text = extractTextElements(payload);
    if (isInternalSessionText(text)) {
      return null;
    }
    const visibleText = sanitizeVisibleSessionText(text);
    if (visibleText.length === 0) {
      return null;
    }
    return {
      timestamp,
      type,
      role: 'assistant',
      text: truncate(visibleText, MAX_VISIBLE_MESSAGE_LENGTH)
    };
  }

  if (type === 'event_msg' && payload.type === 'image_generation_end') {
    return createGeneratedImageEntry({ timestamp, type, payload, options });
  }

  if (type === 'response_item') {
    const itemType = payload.type;
    if (itemType === 'message') {
      const text = extractMessageContent(payload.content, options);
      if (isInternalSessionText(text)) {
        return null;
      }
      const role = payload.role ?? 'assistant';
      const visibleText = sanitizeVisibleSessionText(text, { stripLeadingSkillToken: role === 'user' });
      if (visibleText.length === 0) {
        return null;
      }
      return {
        timestamp,
        type,
        role,
        text: truncate(visibleText, MAX_VISIBLE_MESSAGE_LENGTH)
      };
    }
    if (itemType === 'function_call') {
      const summary = summarizeFunctionCall(payload);
      return summary ? {
        timestamp,
        type: 'tool_call',
        role: 'tool',
        text: summary,
        toolCallId: toolCallId(payload),
        toolItems: [createToolCallItem(payload, timestamp)]
      } : null;
    }
    if (itemType === 'function_call_output') {
      const summary = summarizeFunctionCallOutput(payload, { ...options, includeImageMarkdown: true });
      if (!summary) {
        return null;
      }
      const entry = {
        timestamp,
        type: 'tool_result',
        role: 'tool',
        text: summary,
        toolCallId: toolCallId(payload),
        toolOutputDetail: summarizeFunctionCallOutputDetail(payload, summary)
      };
      const toolAgents = parseToolAgentsFromOutput(payload.output);
      if (toolAgents) {
        entry.toolAgents = toolAgents;
      }
      return entry;
    }
    if (itemType === 'reasoning') {
      const summary = extractReasoningSummary(payload);
      return {
        timestamp,
        type: 'reasoning',
        role: 'system',
        text: summary || '正在思考'
      };
    }
    if (itemType === 'image_generation_call') {
      return createGeneratedImageEntry({ timestamp, type, payload, options });
    }
  }

  return null;
}

function summarizeCodexClientNoticeRecord(record, options = {}) {
  const timestamp = String(record.timestamp ?? '');
  const type = String(record.type ?? '');
  const payload = record.payload ?? {};
  const payloadType = String(payload.type ?? payload.event ?? payload.kind ?? '');
  const method = String(payload.method ?? record.method ?? payload.params?.method ?? '');
  const sourceText = `${type} ${payloadType} ${method}`.toLowerCase();
  const shouldInspect = /error|failed|failure|exception|status|notification|compaction|compact|client|app_server|desktop|rate|quota|capacity|auth/.test(sourceText)
    || (type === 'response_item' && /error|status/.test(String(payload.type ?? '').toLowerCase()));
  if (!shouldInspect) {
    return null;
  }
  const notice = classifyCodexClientNotice({
    ...payload,
    method,
    source: 'session-file',
    payload
  });
  if (!notice) {
    return null;
  }
  return createCodexClientNoticeEntry(payload, {
    notice,
    timestamp: timestamp || new Date().toISOString(),
    threadId: options.threadId ?? '',
    itemId: String(payload.id ?? payload.itemId ?? payload.item_id ?? method ?? '')
  });
}

function isTurnAbortedRecord(record) {
  const type = String(record.type ?? '');
  const payload = record.payload ?? {};
  if (type === 'event_msg' && payload.type === 'turn_aborted') {
    return true;
  }
  if (type === 'event_msg' && payload.type === 'user_message') {
    return isTurnAbortedText(extractTextElements(payload));
  }
  if (type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
    return isTurnAbortedText(extractMessageContent(payload.content));
  }
  return false;
}

function isTurnAbortedText(value) {
  return String(value ?? '').trim().startsWith('<turn_aborted>');
}

function extractTextElements(payload) {
  if (typeof payload.message === 'string') {
    return payload.message;
  }
  if (Array.isArray(payload.text_elements)) {
    return payload.text_elements.map((item) => String(item.text ?? item)).join('\n');
  }
  return '';
}

function extractMessageContent(content, options = {}) {
  if (typeof content === 'string') {
    return materializeMarkdownImagesForMobile(content, options.mobileImagesDir);
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const imageMarkdown = [];
  const text = content.map((item) => {
    if (typeof item === 'string') {
      return item;
    }
    if (isImageContentItem(item)) {
      const markdown = materializeImageItemForMobile(item, options.mobileImagesDir);
      if (markdown.length > 0) {
        imageMarkdown.push(markdown);
      }
      return '';
    }
    return String(item.text ?? item.content ?? '');
  }).filter(Boolean).join('\n');
  return [materializeMarkdownImagesForMobile(text, options.mobileImagesDir), ...imageMarkdown].filter(Boolean).join('\n');
}

function isImageContentItem(item) {
  if (!item || typeof item !== 'object') {
    return false;
  }
  const type = String(item.type ?? '').toLowerCase();
  return type === 'input_image'
    || type === 'output_image'
    || Object.hasOwn(item, 'image_url')
    || Object.hasOwn(item, 'imageUrl');
}

function materializeImageItemForMobile(item, mobileImagesDir = '') {
  if (!item || typeof item !== 'object') {
    return '';
  }
  const imageUrl = item.image_url ?? item.imageUrl ?? item.url ?? item.data;
  if (typeof imageUrl === 'string' && imageUrl.trim().length > 0) {
    return materializeImageDataUrlForMobile(imageUrl, mobileImagesDir);
  }
  const base64 = String(item.base64 ?? '').trim();
  if (base64.length > 0) {
    const mimeType = String(item.mimeType ?? item.mime_type ?? 'image/png').trim() || 'image/png';
    return materializeImageBase64ForMobile(base64, mobileImagesDir, { mimeType });
  }
  return '';
}

function materializeImageDataUrlForMobile(imageUrl, mobileImagesDir = '') {
  const parsed = parseImageDataUrl(imageUrl);
  if (!parsed) {
    return '';
  }
  return materializeImageBase64ForMobile(parsed.base64, mobileImagesDir, { extension: parsed.extension });
}

function materializeImageBase64ForMobile(base64, mobileImagesDir = '', options = {}) {
  const normalizedBase64 = String(base64 ?? '').replace(/\s+/g, '');
  if (normalizedBase64.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalizedBase64)) {
    return '';
  }
  const bytes = Buffer.from(normalizedBase64, 'base64');
  if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024) {
    return '';
  }
  const uploadDir = path.resolve(mobileImagesDir || path.join(process.cwd(), 'logs', 'mobile-images'));
  const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 24);
  const extension = String(options.extension ?? '').trim()
    || (String(options.mimeType ?? '').trim().length > 0 ? imageExtensionForMime(options.mimeType) : '')
    || inferImageExtensionFromBytes(bytes)
    || 'png';
  const filePath = path.join(uploadDir, `desktop-${hash}.${extension}`);
  try {
    fsSync.mkdirSync(uploadDir, { recursive: true });
    if (!fsSync.existsSync(filePath)) {
      fsSync.writeFileSync(filePath, bytes);
    }
    return `![桌面端图片](${filePath.replace(/\\/g, '/')})`;
  } catch {
    return '';
  }
}

function summarizeGeneratedImage(payload, options = {}) {
  const markdown = extractGeneratedImageMarkdown(payload, options.mobileImagesDir);
  if (markdown.length === 0) {
    return '';
  }
  return ['已生成图片', markdown].join('\n');
}

function createGeneratedImageEntry({ timestamp, type, payload, options = {} }) {
  const generatedImage = summarizeGeneratedImage(payload, options);
  if (!generatedImage) {
    return null;
  }
  const identity = generatedImageSyncIdentity(payload, generatedImage);
  return {
    timestamp,
    type,
    role: 'assistant',
    itemId: identity,
    syncId: identity,
    text: generatedImage
  };
}

function generatedImageSyncIdentity(payload, markdown) {
  const callId = String(payload?.id ?? payload?.call_id ?? payload?.callId ?? '').trim();
  const imageKeys = [...String(markdown ?? '').matchAll(/desktop-([a-f0-9]{16,64})\.[a-z0-9]+/gi)]
    .map((match) => match[1].toLowerCase());
  const imageKey = imageKeys.length > 0 ? imageKeys.join('-') : crypto.createHash('sha1').update(String(markdown ?? '')).digest('hex').slice(0, 16);
  return `generated-image:${callId || 'unknown'}:${imageKey}`;
}

function extractGeneratedImageMarkdown(payload, mobileImagesDir = '') {
  const candidates = collectGeneratedImageCandidates(payload?.result);
  const markdown = [];
  for (const candidate of candidates) {
    let rendered = '';
    if (candidate.kind === 'data-url') {
      rendered = materializeImageDataUrlForMobile(candidate.value, mobileImagesDir);
    } else if (candidate.kind === 'base64') {
      rendered = materializeImageBase64ForMobile(candidate.value, mobileImagesDir, { mimeType: candidate.mimeType });
    }
    if (rendered.length > 0 && !markdown.includes(rendered)) {
      markdown.push(rendered);
    }
  }
  return markdown.join('\n');
}

function collectGeneratedImageCandidates(value, mimeType = '') {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return [];
    }
    if (/^data:image\//i.test(trimmed)) {
      return [{ kind: 'data-url', value: trimmed, mimeType }];
    }
    if (looksLikeBase64Image(trimmed)) {
      return [{ kind: 'base64', value: trimmed, mimeType }];
    }
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectGeneratedImageCandidates(item, mimeType));
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  const nextMimeType = String(value.mimeType ?? value.mime_type ?? value.media_type ?? value.content_type ?? mimeType ?? '');
  const direct = [
    value.image,
    value.image_url,
    value.imageUrl,
    value.data,
    value.base64,
    value.b64_json,
    value.result
  ].flatMap((item) => collectGeneratedImageCandidates(item, nextMimeType));
  return direct;
}

function looksLikeBase64Image(value) {
  const text = String(value ?? '').replace(/\s+/g, '');
  if (text.length < 16 || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    return false;
  }
  return /^(iVBORw0KGgo|\/9j\/|UklGR|R0lGOD)/.test(text) || text.length > 1024;
}

function materializeLocalImageForMobile(imagePath, mobileImagesDir = '') {
  const filePath = normalizeLocalImagePath(imagePath);
  if (filePath.length === 0 || !isSupportedImageFilePath(filePath)) {
    return '';
  }
  try {
    const stat = fsSync.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 20 * 1024 * 1024) {
      return '';
    }
    const uploadDir = path.resolve(mobileImagesDir || path.join(process.cwd(), 'logs', 'mobile-images'));
    const resolvedFilePath = path.resolve(filePath);
    if (isPathInside(resolvedFilePath, uploadDir)) {
      return resolvedFilePath.replace(/\\/g, '/');
    }
    const bytes = fsSync.readFileSync(resolvedFilePath);
    const extension = path.extname(resolvedFilePath).slice(1).toLowerCase() || 'png';
    const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 24);
    const copiedPath = path.join(uploadDir, `desktop-${hash}.${extension}`);
    fsSync.mkdirSync(uploadDir, { recursive: true });
    if (!fsSync.existsSync(copiedPath)) {
      fsSync.writeFileSync(copiedPath, bytes);
    }
    return copiedPath.replace(/\\/g, '/');
  } catch {
    return '';
  }
}

function materializeMarkdownImagesForMobile(text, mobileImagesDir = '') {
  return String(text ?? '').replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, label, target) => {
    const trimmedTarget = String(target ?? '').trim();
    const dataMarkdown = materializeImageDataUrlForMobile(trimmedTarget, mobileImagesDir);
    if (dataMarkdown.length > 0) {
      const dataPath = dataMarkdown.match(/\((.+)\)$/)?.[1] ?? '';
      return dataPath.length > 0 ? `![${label || '桌面端图片'}](${dataPath})` : match;
    }
    if (/^https?:\/\//i.test(trimmedTarget)) {
      return match;
    }
    const copiedPath = materializeLocalImageForMobile(trimmedTarget, mobileImagesDir);
    if (copiedPath.length === 0) {
      return match;
    }
    return `![${label || '桌面端图片'}](${copiedPath})`;
  });
}

function normalizeLocalImagePath(value) {
  const trimmed = String(value ?? '').trim().replace(/^["']|["']$/g, '');
  if (trimmed.length === 0 || /^https?:\/\//i.test(trimmed) || /^data:/i.test(trimmed)) {
    return '';
  }
  if (/^file:\/\//i.test(trimmed)) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return '';
    }
  }
  return trimmed.replace(/\//g, path.sep);
}

function isSupportedImageFilePath(value) {
  return /\.(png|jpe?g|webp|gif)$/i.test(String(value ?? '').trim());
}

function isPathInside(filePath, parentDir) {
  const relative = path.relative(path.resolve(parentDir), path.resolve(filePath));
  return relative.length === 0 || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function parseImageDataUrl(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) {
    return null;
  }
  return {
    extension: imageExtensionForMime(match[1]),
    base64: match[2].replace(/\s+/g, '')
  };
}

function imageExtensionForMime(mimeType) {
  const normalized = String(mimeType ?? '').toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') {
    return 'jpg';
  }
  if (normalized === 'image/webp') {
    return 'webp';
  }
  if (normalized === 'image/gif') {
    return 'gif';
  }
  return 'png';
}

function inferImageExtensionFromBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4) {
    return 'png';
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg';
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp';
  }
  if (bytes.length >= 6 && bytes.toString('ascii', 0, 3) === 'GIF') {
    return 'gif';
  }
  return 'png';
}

function summarizeFunctionCall(payload) {
  const name = String(payload.name ?? '').trim();
  if (name === 'exec_command' || name === 'shell_command' || name === 'command') {
    const command = commandFromFunctionArguments(payload.arguments);
    return command ? `正在执行 ${command}` : '正在执行命令';
  }
  if (name === 'view_image') {
    return '正在查看图片';
  }
  if (name.length > 0) {
    return `正在调用 ${name}`;
  }
  return '正在调用工具';
}

function toolCallId(payload) {
  return String(payload.call_id ?? payload.callId ?? '').trim();
}

function createToolCallItem(payload, timestamp) {
  const name = String(payload.name ?? '').trim() || 'tool';
  const presentation = functionCallPresentation(payload);
  const item = {
    id: toolCallId(payload) || `${name}-${timestamp}`,
    name,
    verb: presentation.verb,
    target: presentation.target,
    detail: '',
    status: 'running'
  };
  const normalizedToolName = name.toLowerCase();
  if (isDelegatingToolName(normalizedToolName)) {
    const args = delegatedToolCallArgs(payload.arguments);
    if (args) {
      item.args = args;
    }
    const taskName = delegatedToolCallTaskName(payload.arguments);
    if (taskName) {
      item.taskName = taskName;
    }
  }
  return item;
}

function isDelegatingToolName(normalizedName) {
  return normalizedName === 'followup_task'
    || normalizedName === 'spawn_agent'
    || normalizedName.endsWith('/followup_task')
    || normalizedName.endsWith('/spawn_agent');
}

function isLikelyEncryptedToolText(value) {
  const text = String(value ?? '').trim();
  if (text.startsWith('gAAAA')) {
    return true;
  }
  return text.length >= 80 && /^[A-Za-z0-9+/=_\-]+$/.test(text);
}

function delegatedToolCallArgs(argumentsValue) {
  const parsed = parseFunctionArguments(argumentsValue);
  for (const key of ['message', 'instructions', 'prompt', 'task', 'input', 'directive']) {
    const value = parsed[key];
    if (typeof value === 'string' && value.trim().length > 0 && !isLikelyEncryptedToolText(value)) {
      return clampText(value.trim(), 800);
    }
  }
  const raw = String(argumentsValue ?? '').trim();
  if (raw.length > 0 && raw.length <= 200 && !isLikelyEncryptedToolText(raw)) {
    return raw;
  }
  return '';
}

function delegatedToolCallTaskName(argumentsValue) {
  const parsed = parseFunctionArguments(argumentsValue);
  const value = parsed.task_name ?? parsed.taskName;
  const name = typeof value === 'string' ? value.trim() : '';
  return name.length > 0 ? clampText(name, 120) : '';
}

function clampText(value, maxLength) {
  const text = String(value ?? '');
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function functionCallPresentation(payload) {
  const name = String(payload.name ?? '').trim();
  const normalizedName = name.toLowerCase();
  const argumentsValue = parseFunctionArguments(payload.arguments);

  if (normalizedName === 'exec_command' || normalizedName === 'shell_command' || normalizedName === 'command') {
    return {
      verb: 'Ran',
      target: truncateInline(rawCommandFromFunctionArguments(payload.arguments) || name || 'command', 1200)
    };
  }
  if (normalizedName === 'apply_patch' || normalizedName.includes('edit') || normalizedName.includes('write')) {
    return {
      verb: 'Edited',
      target: truncateInline(patchTarget(argumentsValue) || argumentTarget(argumentsValue) || name || 'working tree', 1200)
    };
  }
  if (normalizedName === 'view_image') {
    return {
      verb: 'Viewed',
      target: truncateInline(argumentTarget(argumentsValue) || 'image', 1200)
    };
  }
  if (normalizedName.includes('search') || normalizedName.includes('find') || normalizedName.includes('grep') || normalizedName.includes('query')) {
    return {
      verb: 'Searched',
      target: truncateInline(searchTarget(argumentsValue) || name || 'search', 1200)
    };
  }
  if (normalizedName.includes('read') || normalizedName.includes('open') || normalizedName.includes('get_file')) {
    return {
      verb: 'Read',
      target: truncateInline(argumentTarget(argumentsValue) || name || 'resource', 1200)
    };
  }
  if (normalizedName.includes('imagegen') || normalizedName.includes('image_gen') || normalizedName.includes('generate_image')) {
    return {
      verb: 'Generated',
      target: truncateInline(argumentTarget(argumentsValue) || 'image', 1200)
    };
  }
  return {
    verb: 'Called',
    target: truncateInline(argumentTarget(argumentsValue) || name || 'tool', 1200)
  };
}

function parseFunctionArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  try {
    const parsed = JSON.parse(String(value ?? '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function patchTarget(argumentsValue) {
  const patch = String(argumentsValue.patch ?? argumentsValue.input ?? argumentsValue.diff ?? '');
  const match = patch.match(/^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+)$/m);
  return String(match?.[1] ?? '').trim();
}

function searchTarget(argumentsValue) {
  const direct = String(
    argumentsValue.query
      ?? argumentsValue.q
      ?? argumentsValue.pattern
      ?? argumentsValue.search
      ?? ''
  ).trim();
  if (direct.length > 0) {
    return direct;
  }
  const queries = argumentsValue.search_query;
  if (Array.isArray(queries) && queries.length > 0) {
    return String(queries[0]?.q ?? queries[0]?.query ?? '').trim();
  }
  return argumentTarget(argumentsValue);
}

function argumentTarget(argumentsValue) {
  const directKeys = ['path', 'file', 'filePath', 'file_path', 'uri', 'url', 'ref_id', 'resource', 'title'];
  for (const key of directKeys) {
    const value = String(argumentsValue[key] ?? '').trim();
    if (value.length > 0) {
      return value;
    }
  }
  return '';
}

function summarizeFunctionCallOutput(payload, options = {}) {
  if (Array.isArray(payload.output)) {
    const imageMarkdown = options.includeImageMarkdown === true
      ? payload.output.map((item) => materializeImageItemForMobile(item, options.mobileImagesDir)).filter(Boolean)
      : [];
    if (payload.output.some((item) => item?.type === 'input_image')) {
      return ['已查看图片', ...imageMarkdown].filter(Boolean).join('\n');
    }
    if (imageMarkdown.length > 0) {
      return ['已生成图片', ...imageMarkdown].join('\n');
    }
  }
  const output = typeof payload.output === 'string' ? payload.output : '';
  const commandCount = countToolCommands(output);
  if (commandCount > 0) {
    const summary = summarizeToolOutput(output);
    return summary.length > 0 ? `已运行 ${commandCount} 条命令\n${summary}` : `已运行 ${commandCount} 条命令`;
  }
  return '工具调用完成';
}

function summarizeFunctionCallOutputDetail(payload, summary) {
  if (typeof payload.output === 'string') {
    const detail = summarizeToolOutput(payload.output);
    if (detail.length > 0) {
      return detail;
    }
  }
  return toolResultDetailText(summary) || firstLine(summary);
}

function parseToolAgentsFromOutput(output) {
  if (typeof output !== 'string' || !output.includes('"agents"')) {
    return null;
  }
  const parsed = parseEmbeddedJsonObject(output);
  if (!parsed || !Array.isArray(parsed.agents)) {
    return null;
  }
  const agents = [];
  for (const raw of parsed.agents) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      continue;
    }
    const name = String(raw.agent_name ?? raw.name ?? '').trim();
    if (name.length === 0) {
      continue;
    }
    const normalized = normalizeAgentStatusValue(raw.agent_status ?? raw.status);
    const agent = { name, status: normalized.status };
    if (normalized.report.length > 0) {
      agent.report = normalized.report;
    }
    agents.push(agent);
    if (agents.length >= 20) {
      break;
    }
  }
  return agents.length > 0 ? agents : null;
}

function parseEmbeddedJsonObject(text) {
  const value = String(text ?? '').trim();
  if (value.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    // fall through to embedded extraction
  }
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(value.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeAgentStatusValue(value) {
  if (typeof value === 'string') {
    const status = value.trim();
    return { status: status.length > 0 ? clampText(status, 40) : 'unknown', report: '' };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (typeof value.completed === 'string' && value.completed.trim().length > 0) {
      return { status: 'completed', report: clampText(value.completed.trim(), 2000) };
    }
    if (typeof value.failed === 'string' && value.failed.trim().length > 0) {
      return { status: 'failed', report: clampText(value.failed.trim(), 2000) };
    }
    if (typeof value.error === 'string' && value.error.trim().length > 0) {
      return { status: 'failed', report: clampText(value.error.trim(), 2000) };
    }
  }
  return { status: 'unknown', report: '' };
}

function commandFromFunctionArguments(value) {
  return truncateInline(rawCommandFromFunctionArguments(value), 110);
}

function rawCommandFromFunctionArguments(value) {
  try {
    const parsed = JSON.parse(String(value ?? '{}'));
    const command = String(parsed.cmd ?? parsed.command ?? '').trim();
    return command;
  } catch {
    return '';
  }
}

function countToolCommands(output) {
  const text = String(output ?? '');
  if (/Process exited with code|Wall time:|Chunk ID:|Exit code:/i.test(text)) {
    return 1;
  }
  return 0;
}

function summarizeToolOutput(output) {
  const text = String(output ?? '').replace(/\r\n/g, '\n').trim();
  if (text.length === 0) {
    return '';
  }
  const lines = text.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^Original token count:/i.test(line));
  const important = [];
  for (const line of lines) {
    if (/^(Exit code:|Process exited with code|Wall time:|Chunk ID:)/i.test(line)) {
      important.push(line);
    }
  }
  if (important.length > 0) {
    return truncateInline(important.join('；'), 500);
  }
  return truncateInline(lines.slice(0, 3).join('；'), 500);
}

function extractReasoningSummary(payload) {
  const raw = payload.text ?? payload.summaryText ?? payload.summary;
  let text = '';
  if (typeof raw === 'string') {
    text = raw;
  } else if (Array.isArray(raw)) {
    text = raw.map((item) => {
      if (typeof item === 'string') {
        return item;
      }
      if (item && typeof item === 'object') {
        return String(item.text ?? '');
      }
      return '';
    }).join('\n');
  } else if (raw && typeof raw === 'object') {
    text = String(raw.text ?? '');
  }
  text = text.trim();
  return text.length > 0 ? truncateInline(text, 120) : '';
}

function truncateInline(value, maxLength) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function clampLimit(value, max = 100) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return 50;
  }
  return Math.min(Math.max(parsed, 1), max);
}

function truncate(value, maxLength) {
  const text = String(value ?? '');
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function isInternalSessionText(value) {
  const text = String(value ?? '').trim();
  if (text.length === 0) {
    return false;
  }
  return isTurnAbortedText(text)
    || text.startsWith('<permissions instructions>')
    || text.startsWith('<environment_context>')
    || text.startsWith('<app-context>')
    || text.startsWith('<collaboration_mode>')
    || text.startsWith('<skills_instructions>')
    || text.startsWith('<plugins_instructions>')
    || text.startsWith('<image_resize_notice>')
    || text.startsWith('# AGENTS.md instructions');
}

function sanitizeVisibleSessionText(value, options = {}) {
  let text = String(value ?? '');
  text = stripInternalInstructionBlocks(text);
  text = stripImagePlaceholderBlocks(text);
  text = stripCodexDirectiveBlocks(text);
  if (options.stripLeadingSkillToken === true) {
    text = stripLeadingSkillToken(text);
  }
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function stripImagePlaceholderBlocks(value) {
  return String(value ?? '')
    .replace(/<image(?:\s+[^>]*)?>\s*<\/image>/gi, '')
    .replace(/^\s*<image(?:\s+[^>]*)?>\s*$/gim, '')
    .replace(/^\s*<\/image>\s*$/gim, '');
}

function stripInternalInstructionBlocks(value) {
  let text = String(value ?? '');
  const blockNames = [
    'permissions instructions',
    'environment_context',
    'app-context',
    'collaboration_mode',
    'skills_instructions',
    'plugins_instructions',
    'turn_aborted',
    'personality_spec',
    'image_resize_notice'
  ];
  for (const name of blockNames) {
    text = stripXmlLikeBlock(text, name);
  }
  const agentsIndex = text.indexOf('# AGENTS.md instructions');
  if (agentsIndex >= 0) {
    text = text.slice(0, agentsIndex);
  }
  return text;
}

function stripCodexDirectiveBlocks(value) {
  const lines = String(value ?? '').split('\n');
  const kept = [];
  let skippingDirective = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!skippingDirective && isCodexDirectiveStart(trimmed)) {
      skippingDirective = !isCodexDirectiveEnd(trimmed);
      continue;
    }
    if (skippingDirective) {
      if (isCodexDirectiveEnd(trimmed)) {
        skippingDirective = false;
      }
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

function isCodexDirectiveStart(trimmedLine) {
  return trimmedLine.startsWith('::code-comment{')
    || trimmedLine.startsWith('::archive{');
}

function isCodexDirectiveEnd(trimmedLine) {
  return trimmedLine.endsWith('}');
}

function stripXmlLikeBlock(value, blockName) {
  let text = String(value ?? '');
  const open = `<${blockName}>`;
  const close = `</${blockName}>`;
  let guard = 0;
  while (guard < 12) {
    const start = text.indexOf(open);
    if (start < 0) {
      break;
    }
    const end = text.indexOf(close, start + open.length);
    if (end < 0) {
      text = text.slice(0, start);
      break;
    }
    text = `${text.slice(0, start)}${text.slice(end + close.length)}`;
    guard += 1;
  }
  return text;
}

function stripLeadingSkillToken(value) {
  return String(value ?? '').replace(/^\s*\$[A-Za-z0-9][A-Za-z0-9_.-]*(?:\s+|$)/, '');
}
