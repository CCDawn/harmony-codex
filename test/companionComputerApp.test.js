import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { MockCodexAdapter } from '../src/mockCodexAdapter.js';
import { DiagnosticLogger } from '../src/diagnosticLogger.js';

test('computer status and session routes are authenticated before service access', async () => {
  const previousToken = process.env.CODEX_BRIDGE_TOKEN;
  const previousTotpSecret = process.env.CODEX_BRIDGE_TOTP_SECRET;
  process.env.CODEX_BRIDGE_TOKEN = 'bridge-computer-test-token';
  delete process.env.CODEX_BRIDGE_TOTP_SECRET;

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-computer-app-'));
  const calls = [];
  const config = {
    appServerRuntimeMode: 'desktop',
    outboxEnabled: false,
    repoRoot: root,
    logger: new DiagnosticLogger({ root }),
    deviceRegistryPath: path.join(root, 'state', 'device-registry.json'),
    desktopLiveRecovery: { shouldRecover: () => false, async recover() { throw new Error('disabled'); } },
    desktopLiveDiagnostics: false,
    desktopSupervisor: { armed: false },
    async defaultReasoningEffortProvider() { return ''; },
    sessionSettings: {
      async getSessionSettings() { return { model: '', reasoningEffort: '', updatedAt: '' }; },
      async updateSessionSettings() { return { model: '', reasoningEffort: '', updatedAt: '' }; },
      async deleteSessionSettings() {}
    },
    companionComputerService: {
      async getStatus(input) {
        calls.push(['status', input]);
        return { ...input, threadId: 'thread-1', environmentId: 'environment-1', status: 'ready', ready: true };
      },
      async createSession(input) {
        calls.push(['session', input]);
        return {
          sdp: 'v=0\r\nanswer', assistantId: input.assistantId, roomId: input.roomId,
          threadId: input.threadId, environmentId: input.environmentId
        };
      }
    }
  };
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const unauthenticated = await fetch(`${baseUrl}/companion/computer/status?assistantId=assistant-1&roomId=room-1`);
    assert.equal(unauthenticated.status, 401);
    assert.equal(calls.length, 0);

    const headers = { authorization: 'Bearer bridge-computer-test-token' };
    const status = await fetch(`${baseUrl}/companion/computer/status?assistantId=assistant-1&roomId=room-1`, { headers });
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), {
      assistantId: 'assistant-1', roomId: 'room-1', threadId: 'thread-1',
      environmentId: 'environment-1', status: 'ready', ready: true
    });

    const offer = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n';
    const session = await fetch(`${baseUrl}/companion/computer/sessions`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        assistantId: 'assistant-1', roomId: 'room-1', threadId: 'thread-1',
        environmentId: 'environment-1', sdp: offer
      })
    });
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), {
      sdp: 'v=0\r\nanswer', assistantId: 'assistant-1', roomId: 'room-1',
      threadId: 'thread-1', environmentId: 'environment-1'
    });
    assert.deepEqual(calls.map(([kind]) => kind), ['status', 'session']);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (previousToken === undefined) delete process.env.CODEX_BRIDGE_TOKEN;
    else process.env.CODEX_BRIDGE_TOKEN = previousToken;
    if (previousTotpSecret === undefined) delete process.env.CODEX_BRIDGE_TOTP_SECRET;
    else process.env.CODEX_BRIDGE_TOTP_SECRET = previousTotpSecret;
  }
});
