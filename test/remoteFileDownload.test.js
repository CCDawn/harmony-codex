import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { DiagnosticLogger } from '../src/diagnosticLogger.js';
import { MockCodexAdapter } from '../src/mockCodexAdapter.js';

function createRemoteFileTestConfig(session) {
  // 设备注册表指向独立临时文件，避免测试读取仓库 logs/state 下的真实数据。
  const testRoot = path.join(os.tmpdir(), `codex-remote-file-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return {
    outboxEnabled: false,
    remoteFileMaxBytes: 1024 * 1024,
    logger: new DiagnosticLogger({
      root: testRoot
    }),
    deviceRegistryPath: path.join(testRoot, 'state', 'device-registry.json'),
    desktopLiveRecovery: {
      shouldRecover() {
        return false;
      },
      async recover() {
        throw new Error('test recovery disabled');
      }
    },
    desktopLiveDiagnostics: false,
    defaultReasoningEffortProvider: async () => '',
    codexSettingsProvider: async () => ({
      model: 'gpt-test',
      reasoningEffort: '',
      models: []
    }),
    sessionSettings: {
      async getSessionSettings() {
        return { model: '', reasoningEffort: '', updatedAt: '' };
      },
      async updateSessionSettings(_sessionId, patch) {
        return { ...patch, updatedAt: new Date().toISOString() };
      },
      async deleteSessionSettings() {
      }
    },
    projects: [{
      id: 'probe',
      name: 'Probe Workspace',
      root: process.cwd(),
      allowedCommands: []
    }],
    threadService: {
      async getThread(threadId) {
        if (threadId !== session.id) {
          const error = new Error('Thread not found');
          error.statusCode = 404;
          throw error;
        }
        return session;
      }
    }
  };
}

async function withRemoteFileServer(session, callback) {
  const { server } = createApp({
    config: createRemoteFileTestConfig(session),
    adapter: new MockCodexAdapter()
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test('downloads a permitted desktop file only when the current session references it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-remote-file-'));
  const filePath = path.join(root, 'architecture-review.md');
  const contents = '# Architecture\n\nVerified from the phone.\n';
  await fs.writeFile(filePath, contents, 'utf8');
  const markdownPath = filePath.replace(/\\/g, '/');
  const session = {
    id: 'thread-file-download',
    entries: [{
      role: 'assistant',
      text: `[architecture-review.md](${markdownPath})`
    }]
  };

  try {
    await withRemoteFileServer(session, async (baseUrl) => {
      const query = `path=${encodeURIComponent(filePath)}`;
      const metadataResponse = await fetch(
        `${baseUrl}/api/codex/threads/${session.id}/files/metadata?${query}`
      );
      assert.equal(metadataResponse.status, 200);
      const metadata = await metadataResponse.json();
      assert.equal(metadata.file.fileName, 'architecture-review.md');
      assert.equal(metadata.file.bytes, Buffer.byteLength(contents));
      assert.equal(metadata.file.mimeType, 'text/markdown');
      assert.equal(metadata.file.openType, 'general.plain-text');

      const downloadResponse = await fetch(
        `${baseUrl}/api/codex/threads/${session.id}/files/download?${query}`
      );
      assert.equal(downloadResponse.status, 200);
      assert.equal(await downloadResponse.text(), contents);
      assert.match(downloadResponse.headers.get('content-disposition') ?? '', /architecture-review\.md/);
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('downloads Codex desktop file links that include line and column locations', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-remote-file-location-'));
  const filePath = path.join(root, 'architecture-review.md');
  const contents = '# Architecture\n\nOpen the linked section.\n';
  await fs.writeFile(filePath, contents, 'utf8');
  const markdownPath = filePath.replace(/\\/g, '/');
  const session = {
    id: 'thread-file-location-download',
    entries: [{
      role: 'assistant',
      text: `[architecture section](${markdownPath}:303:7)`
    }]
  };

  try {
    await withRemoteFileServer(session, async (baseUrl) => {
      const requestedPath = `${filePath}:303:7`;
      const query = `path=${encodeURIComponent(requestedPath)}`;
      const metadataResponse = await fetch(
        `${baseUrl}/api/codex/threads/${session.id}/files/metadata?${query}`
      );
      assert.equal(metadataResponse.status, 200);
      const metadata = await metadataResponse.json();
      assert.equal(metadata.file.fileName, 'architecture-review.md');
      assert.equal(metadata.file.mimeType, 'text/markdown');

      const downloadResponse = await fetch(
        `${baseUrl}/api/codex/threads/${session.id}/files/download?${query}`
      );
      assert.equal(downloadResponse.status, 200);
      assert.equal(await downloadResponse.text(), contents);
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects desktop files that are not referenced by the current session', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-remote-file-'));
  const filePath = path.join(root, 'unreferenced.md');
  await fs.writeFile(filePath, 'not linked', 'utf8');
  const session = {
    id: 'thread-file-unreferenced',
    entries: [{
      role: 'assistant',
      text: 'No desktop file link is present.'
    }]
  };

  try {
    await withRemoteFileServer(session, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/codex/threads/${session.id}/files/metadata?path=${encodeURIComponent(filePath)}`
      );
      assert.equal(response.status, 403);
      const payload = await response.json();
      assert.match(payload.error, /当前会话/);
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects sensitive desktop file names even when the current session references them', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-remote-file-'));
  const filePath = path.join(root, '.env');
  await fs.writeFile(filePath, 'TOKEN=secret', 'utf8');
  const session = {
    id: 'thread-file-sensitive',
    entries: [{
      role: 'assistant',
      text: `[environment](${filePath.replace(/\\/g, '/')})`
    }]
  };

  try {
    await withRemoteFileServer(session, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/codex/threads/${session.id}/files/metadata?path=${encodeURIComponent(filePath)}`
      );
      assert.equal(response.status, 415);
      const payload = await response.json();
      assert.match(payload.error, /敏感|类型/);
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
