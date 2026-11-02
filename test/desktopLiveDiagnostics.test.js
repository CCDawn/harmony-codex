import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyDiagnostics } from '../src/desktopLiveDiagnostics.js';

const packagedShell = '"C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.721.4979.0_x64__test\\app\\ChatGPT.exe"';

test('desktop diagnostics recognize the packaged ChatGPT main process and ignore its children and app-server', () => {
  const result = classifyDiagnostics({
    inspectedAt: '2026-07-28T00:00:00.000Z',
    statusFile: null,
    processes: [
      {
        processId: 100,
        parentProcessId: 1,
        name: 'ChatGPT.exe',
        commandLine: packagedShell,
        creationDate: '2026-07-28T00:00:00.000Z'
      },
      {
        processId: 101,
        parentProcessId: 100,
        name: 'ChatGPT.exe',
        commandLine: `${packagedShell} --type=renderer`,
        creationDate: '2026-07-28T00:00:01.000Z'
      },
      {
        processId: 102,
        parentProcessId: 100,
        name: 'codex.exe',
        commandLine: '"C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.721.4979.0_x64__test\\app\\resources\\codex.exe" app-server',
        creationDate: '2026-07-28T00:00:02.000Z'
      }
    ]
  }, { desktopLive: false });

  assert.equal(result.desktopProcessMode, 'plain');
  assert.equal(result.codexProcessCount, 1);
  assert.equal(result.codexProcessId, 100);
  assert.equal(result.failureClass, 'codex_plain_no_cdp');
});

test('desktop diagnostics extract CDP from the packaged ChatGPT main process', () => {
  const result = classifyDiagnostics({
    inspectedAt: '2026-07-28T00:00:00.000Z',
    statusFile: null,
    processes: [
      {
        processId: 200,
        parentProcessId: 1,
        name: 'ChatGPT.exe',
        commandLine: `${packagedShell} --remote-debugging-port=54808`,
        creationDate: '2026-07-28T00:00:00.000Z'
      }
    ]
  }, { desktopLive: false });

  assert.equal(result.desktopProcessMode, 'cdp');
  assert.equal(result.codexProcessCount, 1);
  assert.equal(result.cdpPort, 54808);
  assert.equal(result.requiresDesktopCdp, false);
});

// —— 地面真相：desktopLive=true 会被「CDP 端口无真实应答」推翻 ——

const cdpShell = '"C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.721.4979.0_x64__test\\app\\ChatGPT.exe" --remote-debugging-port=9229';

test('desktop diagnostics demote a desktopLive claim when the CDP endpoint never answers', () => {
  const result = classifyDiagnostics({
    inspectedAt: '2026-10-19T15:50:00.000Z',
    statusFile: null,
    processes: [
      {
        processId: 300,
        parentProcessId: 1,
        name: 'ChatGPT.exe',
        commandLine: cdpShell,
        creationDate: '2026-10-19T15:46:00.000Z'
      }
    ],
    cdpLiveness: {
      checked: true,
      ok: false,
      ports: [9229],
      reason: 'CDP 端口有监听但无真实应答（127.0.0.1:9229）：请求 Codex 桌面 CDP 入口超时'
    }
  }, { desktopLive: true });

  assert.equal(result.cdpResponsive, false);
  assert.equal(result.failureClass, 'desktop_cdp_unavailable');
  assert.equal(result.requiresDesktopCdp, false);
  assert.equal(result.mobileRecoverable, true);
  assert.equal(result.desktopProcessMode, 'cdp');
});

test('desktop diagnostics keep a desktopLive claim when the CDP endpoint truly answers', () => {
  const result = classifyDiagnostics({
    inspectedAt: '2026-10-19T15:50:00.000Z',
    statusFile: null,
    processes: [
      {
        processId: 300,
        parentProcessId: 1,
        name: 'ChatGPT.exe',
        commandLine: cdpShell,
        creationDate: '2026-10-19T15:46:00.000Z'
      }
    ],
    cdpLiveness: { checked: true, ok: true, port: 9229, browser: 'Codex/26.721.4979.0' }
  }, { desktopLive: true });

  assert.equal(result.cdpResponsive, true);
  assert.equal(result.failureClass, 'none');
  assert.equal(result.mobileRecoverable, true);
});

test('a heartbeat claim without any Codex process and a dead CDP endpoint is codex_not_running', () => {
  const result = classifyDiagnostics({
    inspectedAt: '2026-10-19T15:50:00.000Z',
    statusFile: null,
    processes: [],
    cdpLiveness: { checked: true, ok: false, ports: [9229], reason: 'connect ECONNREFUSED 127.0.0.1:9229' }
  }, { desktopLive: true });

  assert.equal(result.failureClass, 'codex_not_running');
  assert.equal(result.requiresDesktopCdp, true);
  assert.equal(result.mobileRecoverable, false);
});

test('DesktopLiveDiagnostics.inspect probes CDP candidates and feeds the ground truth into classification', async () => {
  const { DesktopLiveDiagnostics } = await import('../src/desktopLiveDiagnostics.js');
  const probedOptions = [];
  class HeadlessDiagnostics extends DesktopLiveDiagnostics {
    async readProcesses() {
      return [
        {
          processId: 300,
          parentProcessId: 1,
          name: 'ChatGPT.exe',
          commandLine: cdpShell,
          creationDate: '2026-10-19T15:46:00.000Z'
        }
      ];
    }

    async readStatusFile() {
      return null;
    }
  }
  const diagnostics = new HeadlessDiagnostics({
    cdpLivenessTimeoutMs: 250,
    cdpLivenessProbe: async (options) => {
      probedOptions.push(options);
      return { checked: true, ok: false, ...options.ports ? { ports: options.ports } : {}, reason: 'probe-stub' };
    }
  });

  const result = await diagnostics.inspect({ desktopLive: true });

  assert.deepEqual(probedOptions, [{ ports: [9229], timeoutMs: 250 }]);
  assert.equal(result.cdpResponsive, false);
  assert.equal(result.failureClass, 'desktop_cdp_unavailable');
  assert.equal(result.cdpLiveness.ok, false);
});
