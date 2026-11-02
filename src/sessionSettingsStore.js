import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const VALID_REASONING_EFFORTS = new Set(['', 'minimal', 'low', 'medium', 'high', 'xhigh']);

export class SessionSettingsStore {
  constructor(options = {}) {
    this.filePath = options.filePath ?? path.join(options.repoRoot ?? process.cwd(), 'logs', 'session-settings.json');
    this.cache = null;
    this.readPromise = null;
    this.writeQueue = Promise.resolve();
  }

  async getSessionSettings(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    await this.writeQueue;
    const data = await this.readData();
    const settings = data.sessions[normalizedSessionId] ?? {};
    return normalizeSessionSettings(settings);
  }

  async updateSessionSettings(sessionId, patch = {}) {
    return this.mutateSessionSettings(sessionId, (current) => {
      const next = { ...current, updatedAt: new Date().toISOString() };
      for (const [field, normalize] of [['model', normalizeModelId], ['reasoningEffort', normalizeReasoningEffort], ['serviceTier', normalizeServiceTier]]) {
        if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
        next[field] = normalize(patch[field]);
        // null marks a new pending choice whose desktop baseline was unknown;
        // an absent baseline identifies a legacy persistent pin.
        next[`${field}Baseline`] = patch[`${field}Baseline`] == null ? null : normalize(patch[`${field}Baseline`]);
      }
      return next;
    });
  }

  async reconcileSessionSettings(sessionId, desktopSettings, expectedSettings) {
    return this.mutateSessionSettings(sessionId, (current) => {
      // A live read begun before a newer phone POST cannot consume that POST.
      if (expectedSettings && JSON.stringify(current) !== JSON.stringify(normalizeSessionSettings(expectedSettings))) return current;
      const next = resolveSessionSettings(current, desktopSettings);
      if (next.model === current.model && next.reasoningEffort === current.reasoningEffort && next.serviceTier === current.serviceTier) return current;
      return { ...next, updatedAt: new Date().toISOString() };
    });
  }

  async deleteSessionSettings(sessionId) {
    return this.mutateSessionSettings(sessionId, () => null);
  }

  mutateSessionSettings(sessionId, mutate) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const operation = this.writeQueue.then(async () => {
      const data = await this.readData();
      const current = normalizeSessionSettings(data.sessions[normalizedSessionId] ?? {});
      const next = mutate(current);
      if (next === current) return current;
      const sessions = { ...data.sessions };
      if (next === null) delete sessions[normalizedSessionId];
      else sessions[normalizedSessionId] = next;
      await this.writeData({ version: 2, sessions });
      return next === null ? undefined : normalizeSessionSettings(next);
    });
    // A failed write must reject its caller without poisoning future writes.
    this.writeQueue = operation.then(() => {}, () => {});
    return operation;
  }

  async readData() {
    if (this.cache) return this.cache;
    this.readPromise ??= this.loadData();
    return this.readPromise;
  }

  async loadData() {
    try {
      const text = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
      this.cache = {
        version: 1,
        sessions: parsed && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)
          ? parsed.sessions
          : {}
      };
    } catch {
      this.cache = { version: 1, sessions: {} };
    }
    return this.cache;
  }

  async writeData(data) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await fs.rename(temporaryPath, this.filePath);
      this.cache = data;
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }
}

export function normalizeSessionSettings(settings = {}) {
  return {
    model: normalizeModelId(settings.model),
    reasoningEffort: normalizeReasoningEffort(settings.reasoningEffort),
    serviceTier: normalizeServiceTier(settings.serviceTier),
    updatedAt: String(settings.updatedAt ?? ''),
    ...normalizeBaselines(settings)
  };
}

function normalizeBaselines(settings) {
  const result = {};
  for (const [field, normalize] of [['model', normalizeModelId], ['reasoningEffort', normalizeReasoningEffort], ['serviceTier', normalizeServiceTier]]) {
    const key = `${field}Baseline`;
    if (Object.prototype.hasOwnProperty.call(settings, key)) {
      result[key] = settings[key] == null ? null : normalize(settings[key]);
    }
  }
  return result;
}

export function resolveSessionSettings(settings, desktopSettings = {}) {
  const next = normalizeSessionSettings(settings);
  for (const [field, normalize] of [['model', normalizeModelId], ['reasoningEffort', normalizeReasoningEffort], ['serviceTier', normalizeServiceTier]]) {
    let desktopValue = '';
    try { desktopValue = normalize(desktopSettings?.[field]); } catch { /* Unknown is not evidence of a change. */ }
    if (!next[field] || !desktopValue) continue;
    const baselineKey = `${field}Baseline`;
    const hasBaseline = Object.prototype.hasOwnProperty.call(next, baselineKey);
    if (desktopValue === next[field] || !hasBaseline
      || (next[baselineKey] !== null && desktopValue !== next[baselineKey])) {
      next[field] = '';
      next[baselineKey] = null;
    }
  }
  return next;
}

export function normalizeModelId(value) {
  const text = String(value ?? '').trim();
  const normalized = ['auto', 'default', 'none', 'null'].includes(text.toLowerCase()) ? '' : text;
  if (normalized.length === 0) {
    return '';
  }
  if (normalized.length > 128 || !/^[A-Za-z0-9._:/-]+$/.test(normalized)) {
    const error = new Error('Invalid model');
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

export function normalizeReasoningEffort(value) {
  const text = String(value ?? '').trim().toLowerCase();
  const normalized = text === 'auto' || text === 'default' || text === 'none' || text === 'null'
    ? ''
    : text;
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    const error = new Error('Invalid reasoning effort');
    error.statusCode = 400;
    error.allowedValues = [...VALID_REASONING_EFFORTS];
    throw error;
  }
  return normalized;
}

// Empty is inheritance; "default" must remain explicit to request standard speed.
export function normalizeServiceTier(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (['', 'auto', 'inherit', 'none', 'null'].includes(text)) return '';
  if (text === 'standard') return 'default';
  if (text.length > 64 || !/^[a-z0-9][a-z0-9_-]*$/.test(text)) {
    const error = new Error('Invalid service tier');
    error.statusCode = 400;
    throw error;
  }
  return text;
}

export function serviceTierParams(value) {
  const serviceTier = normalizeServiceTier(value);
  return serviceTier ? { serviceTier } : {};
}

function normalizeSessionId(sessionId) {
  const text = String(sessionId ?? '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(text)) {
    const error = new Error('Invalid Codex session id');
    error.statusCode = 400;
    throw error;
  }
  return text;
}
