import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_PROJECTS = 100;

export class CodexProjectCatalog {
  constructor(options = {}) {
    this.projects = Array.isArray(options.projects) ? options.projects : [];
    this.historyPath = String(options.historyPath ?? '').trim();
    this.maxProjects = positiveInteger(options.maxProjects, DEFAULT_MAX_PROJECTS);
    this.discoveredProjectIds = new Set();
    this.initializePromise = null;
  }

  async initialize() {
    if (!this.initializePromise) {
      this.initializePromise = this.loadHistory();
    }
    await this.initializePromise;
  }

  async observeSessions(sessions = []) {
    await this.initialize();
    let changed = false;
    for (const session of sessions) {
      const root = normalizeProjectRoot(session?.projectRoot);
      if (!root || this.findProjectByRoot(root)) {
        continue;
      }
      const project = createDiscoveredProject(root, session?.projectLabel);
      this.projects.push(project);
      this.discoveredProjectIds.add(project.id);
      changed = true;
      if (this.discoveredProjectIds.size >= this.maxProjects) {
        break;
      }
    }
    if (changed) {
      await this.saveHistory();
    }
  }

  listProjects() {
    return this.projects.map((project) => ({
      id: project.id,
      name: project.name,
      root: project.root
    }));
  }

  findProjectByRoot(root) {
    const key = normalizeProjectRoot(root);
    return this.projects.find((project) => {
      const candidate = normalizeProjectRoot(project.root);
      return process.platform === 'win32'
        ? candidate.toLowerCase() === key.toLowerCase()
        : candidate === key;
    }) ?? null;
  }

  async loadHistory() {
    if (!this.historyPath) {
      return;
    }
    try {
      const parsed = JSON.parse(await fs.readFile(this.historyPath, 'utf8'));
      const entries = Array.isArray(parsed) ? parsed : parsed?.projects;
      if (!Array.isArray(entries)) {
        return;
      }
      for (const entry of entries.slice(0, this.maxProjects)) {
        const root = normalizeProjectRoot(entry?.root);
        if (!root || this.findProjectByRoot(root)) {
          continue;
        }
        const project = createDiscoveredProject(root, entry?.name);
        this.projects.push(project);
        this.discoveredProjectIds.add(project.id);
      }
    } catch {
      // Missing or stale project history is recoverable from thread/list.
    }
  }

  async saveHistory() {
    if (!this.historyPath) {
      return;
    }
    const projects = this.projects
      .filter((project) => this.discoveredProjectIds.has(project.id))
      .slice(0, this.maxProjects)
      .map((project) => ({
        id: project.id,
        name: project.name,
        root: project.root
      }));
    await fs.mkdir(path.dirname(this.historyPath), { recursive: true });
    await fs.writeFile(this.historyPath, JSON.stringify({
      version: 1,
      projects
    }, null, 2), 'utf8');
  }
}

function createDiscoveredProject(root, requestedName) {
  const name = cleanProjectName(requestedName, root);
  const key = process.platform === 'win32' ? root.toLowerCase() : root;
  return {
    id: `codex-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`,
    name,
    root,
    allowedCommands: [
      /^npm\s+test$/,
      /^npm\s+run\s+test$/,
      /^node\s+--test$/,
      /^git\s+diff(\s+--stat)?$/
    ]
  };
}

function normalizeProjectRoot(value) {
  const text = String(value ?? '').trim().replace(/^\\\\\?\\/, '');
  if (!text || !path.isAbsolute(text)) {
    return '';
  }
  return path.normalize(text).replace(/[\\/]+$/, '');
}

function cleanProjectName(value, root) {
  const requested = String(value ?? '').trim();
  if (requested && requested !== '未归类') {
    return requested;
  }
  return path.basename(root) || 'Codex 项目';
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
