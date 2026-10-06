import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractCodexProjects } from './codexProjects.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolveWorkspaceRoot();

export function resolveWorkspaceRoot(env = process.env) {
  return env.CODEX_BRIDGE_WORKSPACE
    ? path.resolve(env.CODEX_BRIDGE_WORKSPACE)
    : projectRoot;
}

export function resolveProjects(env = process.env) {
  if (env.CODEX_BRIDGE_WORKSPACE) {
    const root = resolveWorkspaceRoot(env);
    return [createProject('probe', path.basename(root) || 'workspace', root)];
  }

  const statePath = env.CODEX_GLOBAL_STATE_PATH
    ? path.resolve(env.CODEX_GLOBAL_STATE_PATH)
    : path.join(os.homedir(), '.codex', '.codex-global-state.json');
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const projects = extractCodexProjects(state);
    if (projects.length > 0) {
      return projects.map((project) => createProject(project.id, project.name, project.root));
    }
  } catch {
  }
  return [createProject('probe', 'codex-harmony', workspaceRoot)];
}

function createProject(id, name, root) {
  return {
    id,
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

export const config = {
  repoRoot: projectRoot,
  host: process.env.CODEX_BRIDGE_HOST ?? '127.0.0.1',
  port: Number.parseInt(process.env.CODEX_BRIDGE_PORT ?? '8787', 10),
  outboxEnabled: process.env.CODEX_BRIDGE_OUTBOX !== '0',
  outboxPath: process.env.CODEX_BRIDGE_OUTBOX_PATH
    ? path.resolve(process.env.CODEX_BRIDGE_OUTBOX_PATH)
    : path.join(projectRoot, 'logs', 'state', 'mobile-outbox.json'),
  mobileFilesDir: process.env.CODEX_BRIDGE_MOBILE_FILES_DIR
    ? path.resolve(process.env.CODEX_BRIDGE_MOBILE_FILES_DIR)
    : path.join(projectRoot, 'logs', 'mobile-files'),
  mobileFileMaxBytes: Math.max(
    1,
    Number.parseInt(process.env.CODEX_BRIDGE_MOBILE_FILE_MAX_BYTES ?? `${10 * 1024 * 1024}`, 10)
  ),
  remoteFileMaxBytes: Math.max(
    1,
    Number.parseInt(process.env.CODEX_BRIDGE_REMOTE_FILE_MAX_BYTES ?? `${25 * 1024 * 1024}`, 10)
  ),
  appServerRuntimeMode: process.env.CODEX_BRIDGE_RUNTIME_MODE ?? 'desktop',
  appServerCanaryThreadIds: String(process.env.CODEX_BRIDGE_APP_SERVER_CANARY_THREADS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  // 语音链路（M2）：/voice 升级隧道目标端口 + 受管 voice_server.py 子进程。
  // voiceEnabled 默认关闭，仅在显式 CODEX_BRIDGE_VOICE_ENABLED=1 时启用。
  voiceEnabled: process.env.CODEX_BRIDGE_VOICE_ENABLED === '1',
  voicePort: Math.max(1, Number.parseInt(process.env.CODEX_BRIDGE_VOICE_PORT ?? '8790', 10) || 8790),
  voiceCommand: process.env.CODEX_BRIDGE_VOICE_COMMAND ?? '',
  voiceAutoReconnect: process.env.CODEX_BRIDGE_VOICE_AUTO_RECONNECT !== '0',
  voiceReconnectDelayMs: Math.max(
    0,
    Number.parseInt(process.env.CODEX_BRIDGE_VOICE_RECONNECT_DELAY_MS ?? '2000', 10) || 0
  ),
  projects: resolveProjects()
};
