import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { URL } from 'node:url';
import { EventBus } from './eventBus.js';
import { readJsonBody, sendJson } from './json.js';
import { TaskStore } from './taskStore.js';
import { DiagnosticLogger } from './diagnosticLogger.js';
import { analyzeLogRun } from './logAnalyzer.js';
import { CodexSessionStore } from './codexSessions.js';
import { CodexThreadService } from './codexThreadService.js';
import { openCodexThreadDeeplink } from './desktopDeepLink.js';
import { desktopScriptBridge } from './desktopScriptBridge.js';
import { buildDesktopScriptClient } from './desktopScriptClient.js';
import { buildSlashIndex } from './slashIndex.js';
import { capturePrimaryDesktopScreenshot } from './desktopScreenshot.js';
import { DesktopLiveRecovery } from './desktopLiveRecovery.js';
import { DesktopLiveDiagnostics } from './desktopLiveDiagnostics.js';
import { SessionSettingsStore, normalizeModelId, normalizeReasoningEffort } from './sessionSettingsStore.js';
import { effectiveCodexSettings, readCodexDefaultReasoningEffort } from './codexUserConfig.js';
import { readAppServerCodexSettings, readDesktopCodexSettings } from './codexDesktopSettings.js';
import { readDesktopVisibleReasoningEffort } from './desktopReasoningEffort.js';
import { readCodexAccountUsage } from './codexAccountUsage.js';
import { collectLinkHealth, recoverHdcLink } from './linkHealth.js';
import { DurableOutbox } from './durableOutbox.js';
import { buildBridgeProtocolHandshake } from './bridgeProtocol.js';
import { paginateTaskEvents } from './taskEventCursor.js';
import { createOutboxReceiptReconciler } from './outboxReceiptReconciler.js';
import {
  prepareRemoteSessionFile,
  publicRemoteFileMetadata,
  remoteFileContentDisposition
} from './remoteFileAccess.js';

export function createApp({ config, adapter }) {
  const eventBus = new EventBus();
  const logger = config.logger ?? new DiagnosticLogger();
  const sessions = config.sessions ?? new CodexSessionStore();
  const sessionSettings = config.sessionSettings ?? new SessionSettingsStore({
    repoRoot: config.repoRoot ?? process.cwd()
  });
  const defaultReasoningEffortProvider = config.defaultReasoningEffortProvider ?? readEffectiveDesktopReasoningEffort;
  const accountUsageProvider = config.accountUsageProvider ?? readCodexAccountUsage;
  const desktopOpener = config.desktopOpener
    ?? (typeof adapter?.openDesktopThread === 'function'
      ? adapter.openDesktopThread.bind(adapter)
      : openCodexThreadDeeplink);
  const threadService = config.threadService ?? new CodexThreadService({
    sessions,
    projects: config.projects,
    projectHistoryPath: config.projectHistoryPath
      ?? (config.repoRoot ? path.join(config.repoRoot, 'logs', 'codex-project-history.json') : null),
    eventBus,
    logger,
    desktopOpener,
    desktopThreadListProvider: typeof adapter?.listThreads === 'function'
      ? adapter.listThreads.bind(adapter)
      : null,
    runtimeStateProvider: typeof adapter?.listThreadRuntimeStates === 'function'
      ? adapter.listThreadRuntimeStates.bind(adapter)
      : null,
    archiveThreadProvider: typeof adapter?.archiveThread === 'function'
      ? adapter.archiveThread.bind(adapter)
      : null,
    model: config.model,
    sandbox: config.appServerSandbox ?? config.sandbox,
    approvalPolicy: config.appServerApprovalPolicy ?? config.approvalPolicy,
    allowIndependentAppServer: appServerRuntimeMode(config) !== 'desktop'
  });
  const codexSettingsProvider = config.codexSettingsProvider
    ?? (() => readPrimaryCodexSettings({ threadService }));
  const desktopLiveRecovery = config.desktopLiveRecovery ?? new DesktopLiveRecovery({
    repoRoot: config.repoRoot ?? process.cwd(),
    bridgeUrl: config.localBridgeUrl ?? `http://127.0.0.1:${config.port ?? 8787}`
  });
  const desktopLiveDiagnostics = config.desktopLiveDiagnostics === false
    ? null
    : config.desktopLiveDiagnostics ?? new DesktopLiveDiagnostics({
        repoRoot: config.repoRoot ?? process.cwd()
      });
  const store = new TaskStore({
    projects: config.projects,
    adapter,
    eventBus,
    logger,
    interruptReconciler: config.interruptReconciler === false
      ? null
      : config.interruptReconciler ?? createThreadInterruptReconciler({ threadService }),
    interruptReconcileTimeoutMs: config.interruptReconcileTimeoutMs,
    interruptReconcilePollMs: config.interruptReconcilePollMs,
    beforeRun: createBeforeRunDesktopVerification({
      adapter,
      logger,
      desktopLiveRecovery,
      desktopLiveDiagnostics,
      desktopOpener
    })
  });
  const outbox = config.outboxEnabled !== true && !config.outbox
    ? null
    : config.outbox ?? new DurableOutbox({
        filePath: config.outboxPath
          ?? path.join(config.repoRoot ?? process.cwd(), 'logs', 'state', 'mobile-outbox.json'),
        blockedDelayMs: config.outboxBlockedDelayMs,
        logger,
        reconcile: config.outboxReconciler
          ?? createOutboxReceiptReconciler({ threadService, sessions }),
        canDispatch: (item) => canDispatchOutboxItem({ item, store, threadService }),
        canRequeueSubmitted: (item) => canRequeueSubmittedOutboxItem({
          item,
          store,
          threadService
        }),
        dispatch: (item) => dispatchOutboxItem({
          item,
          config,
          store,
          logger,
          sessions,
          sessionSettings,
          defaultReasoningEffortProvider,
          codexSettingsProvider,
          threadService,
          desktopLiveRecovery,
          desktopLiveDiagnostics,
          desktopOpener
        })
      });

  const server = createServer(async (request, response) => {
    const startedAt = Date.now();
    const responseByteCounter = installResponseByteCounter(response);
    try {
      if (shouldLogStartedRequest(request)) {
        await logger.write('bridge', 'info', 'http.request.started', {
          method: request.method,
          url: sanitizeRequestUrl(request.url)
        });
      }
      await route({ request, response, config, store, outbox, eventBus, logger, sessions, sessionSettings, defaultReasoningEffortProvider, codexSettingsProvider, accountUsageProvider, threadService, desktopLiveRecovery, desktopLiveDiagnostics, desktopOpener });
      if (shouldLogCompletedRequest(request)) {
        const responseBytes = responseByteCounter.bytes || responseContentLength(response);
        await logger.write('bridge', 'info', 'http.request.completed', {
          method: request.method,
          url: sanitizeRequestUrl(request.url),
          statusCode: response.statusCode,
          durationMs: Date.now() - startedAt,
          responseBytes,
          trafficClass: classifyTraffic(responseBytes)
        });
      }
    } catch (error) {
      await logger.write('bridge', 'error', 'http.request.failed', {
        method: request.method,
        url: sanitizeRequestUrl(request.url),
        message: error.message,
        statusCode: error.statusCode ?? 500
      }).catch(() => {});
      if (response.headersSent || response.writableEnded) {
        if (!response.writableEnded) {
          response.end();
        }
        return;
      }
      const payload = {
        error: error.message ?? 'Internal server error'
      };
      if (error.desktop) {
        payload.desktop = error.desktop;
      }
      if (error.preflight) {
        payload.preflight = error.preflight;
      }
      sendJson(response, error.statusCode ?? 500, payload);
    }
  });
  server.on('close', () => outbox?.close());
  if (outbox) {
    void outbox.initialize()
      .then(() => outbox.dispatchReady())
      .catch((error) => logger.write('outbox', 'error', 'outbox.initialize.failed', {
        message: error?.message ?? String(error)
      }).catch(() => {}));
  }

  return { server, store, outbox, eventBus, logger, threadService };
}

function createThreadInterruptReconciler({ threadService }) {
  return async ({ task, threadId, activeTurnId }) => {
    if (!threadService || typeof threadService.getThread !== 'function' || !threadId) {
      return { status: 'unknown', reason: 'thread_service_unavailable' };
    }
    if (!activeTurnId) {
      return { status: 'unknown', reason: 'missing_active_turn_id' };
    }
    const session = await threadService.getThread(threadId, { tail: 160 });
    const runtimeState = normalizeRuntimeState(session?.runtimeState ?? session?.activityStatus);
    const terminalReason = normalizeRuntimeState(session?.terminalReason ?? '');
    const activityAt = sessionActivityTimestamp(session);
    const requestedAt = String(task?.interruptRequestedAt ?? '');
    const taskCreatedAt = Date.parse(requestedAt || String(task?.createdAt ?? ''));
    const activityTime = Date.parse(activityAt);
    const activityIsRelevant = !Number.isFinite(taskCreatedAt)
      || !Number.isFinite(activityTime)
      || activityTime >= taskCreatedAt;
    if (!activityIsRelevant) {
      return {
        status: 'unknown',
        reason: 'terminal_state_before_task',
        message: activityAt
      };
    }
    if (runtimeState === 'interrupted' || terminalReason === 'interrupted') {
      return {
        status: 'unknown',
        reason: 'thread_level_interrupted_without_turn_evidence',
        message: activityAt
      };
    }
    if (runtimeState === 'completed' || terminalReason === 'completed') {
      return {
        status: 'unknown',
        reason: 'thread_level_completed_without_turn_evidence',
        message: activityAt
      };
    }
    if (runtimeState === 'failed' || terminalReason === 'failed') {
      return {
        status: 'unknown',
        reason: 'thread_level_failed_without_turn_evidence',
        message: activityAt
      };
    }
    if (runtimeState === 'idle') {
      return {
        status: 'unknown',
        reason: 'thread_level_idle_without_turn_evidence',
        message: activityAt
      };
    }
    if (runtimeState === 'running') {
      return { status: 'running', reason: 'desktop_in_progress', message: activityAt };
    }
    return { status: 'unknown', reason: 'desktop_state_unknown', message: activityAt };
  };
}

function sessionActivityTimestamp(session) {
  if (!session || typeof session !== 'object') {
    return '';
  }
  return String(session.runtimeUpdatedAt ?? session.activityUpdatedAt ?? session.updatedAt ?? '');
}

function normalizeRuntimeState(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['running', 'in_progress', 'inprogress', 'processing'].includes(normalized)) {
    return 'running';
  }
  if (['completed', 'complete', 'done'].includes(normalized)) {
    return 'completed';
  }
  if (['interrupted', 'aborted', 'cancelled', 'canceled'].includes(normalized)) {
    return 'interrupted';
  }
  if (['failed', 'error'].includes(normalized)) {
    return 'failed';
  }
  if (['idle', 'ready', ''].includes(normalized)) {
    return normalized || '';
  }
  return normalized;
}

function shouldLogCompletedRequest(request) {
  const method = request.method ?? 'GET';
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (method === 'POST' && pathname === '/desktop/script/poll') {
    return false;
  }
  if (method === 'POST' && pathname === '/desktop/script/status') {
    return false;
  }
  if (method === 'POST' && pathname === '/desktop/script/messages') {
    return false;
  }
  return true;
}

function shouldLogStartedRequest(request) {
  const method = request.method ?? 'GET';
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  return method === 'POST' && /^\/api\/codex\/threads\/[^/]+\/messages$/.test(pathname);
}

function responseContentLength(response) {
  const value = response.getHeader('content-length');
  const text = Array.isArray(value) ? value[0] : value;
  const bytes = Number.parseInt(String(text ?? '0'), 10);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
}

function installResponseByteCounter(response) {
  let bytes = 0;
  const originalWrite = response.write.bind(response);
  const originalEnd = response.end.bind(response);
  response.write = (chunk, encoding, callback) => {
    bytes += chunkByteLength(chunk, encoding);
    return originalWrite(chunk, encoding, callback);
  };
  response.end = (chunk, encoding, callback) => {
    bytes += chunkByteLength(chunk, encoding);
    return originalEnd(chunk, encoding, callback);
  };
  return {
    get bytes() {
      return bytes;
    }
  };
}

function chunkByteLength(chunk, encoding) {
  if (chunk === undefined || chunk === null) {
    return 0;
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk.length;
  }
  if (typeof chunk === 'string') {
    return Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : 'utf8');
  }
  if (typeof chunk.byteLength === 'number') {
    return chunk.byteLength;
  }
  return 0;
}

function classifyTraffic(bytes) {
  if (bytes >= 256 * 1024) {
    return 'large';
  }
  if (bytes >= 32 * 1024) {
    return 'medium';
  }
  return 'small';
}

function createBeforeRunDesktopVerification({ adapter, logger, desktopLiveRecovery, desktopLiveDiagnostics, desktopOpener }) {
  return async ({ task, emit }) => {
    if (task.submissionSource !== 'phone_thread_message' || !task.codexSessionId) {
      return;
    }

    emit('codex.desktop_live.verification.started', {
      targetSessionId: task.codexSessionId,
      message: '正在校验桌面 Codex 会话，防止消息进入错误会话。'
    });
    if (desktopTargetReady(task.verifiedDesktopStatus, task.codexSessionId)) {
      emit('codex.desktop_live.verification.completed', {
        status: task.verifiedDesktopStatus.status,
        desktopLive: true,
        currentSessionId: task.verifiedDesktopStatus.currentSessionId ?? null,
        targetSessionId: task.codexSessionId,
        sessionVerified: task.verifiedDesktopStatus.sessionVerified === true,
        targetVerified: task.verifiedDesktopStatus.targetVerified === true,
        message: task.verifiedDesktopStatus.message ?? '发送前已由桌面 App Server 校验目标会话',
        source: 'preflight'
      });
      return;
    }
    const desktopOpen = await maybeOpenDesktopThreadForPhoneSend({
      desktopOpener,
      threadId: task.codexSessionId,
      logger
    });
    const desktop = await getRecoverableDesktopLiveStatus({
      adapter,
      sessionId: task.codexSessionId,
      logger,
      recovery: desktopLiveRecovery,
      diagnostics: desktopLiveDiagnostics,
      source: 'task.before_run.codex_thread_message'
    });
    task.verifiedDesktopStatus = {
      ...desktop,
      desktopOpen
    };
    emit('codex.desktop_live.verification.completed', {
      status: desktop.status,
      desktopLive: desktop.desktopLive === true,
      currentSessionId: desktop.currentSessionId ?? null,
      targetSessionId: task.codexSessionId,
      sessionVerified: desktop.sessionVerified === true,
      targetVerified: desktop.targetVerified === true,
      message: desktop.message ?? desktop.reason ?? ''
    });
    assertDesktopThreadReady(desktop, task.codexSessionId);
  };
}

async function route({ request, response, config, store, outbox, eventBus, logger, sessions, sessionSettings, defaultReasoningEffortProvider, codexSettingsProvider, accountUsageProvider, threadService, desktopLiveRecovery, desktopLiveDiagnostics, desktopOpener }) {
  const url = new URL(request.url, 'http://127.0.0.1');
  const method = request.method ?? 'GET';
  if (method === 'OPTIONS') {
    response.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'access-control-allow-headers': 'Content-Type,Authorization,X-Codex-Bridge-Token',
      'access-control-max-age': '86400'
    });
    response.end();
    return;
  }
  requireAuth({ request, url });

  if (method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, {
      ok: true,
      run: await logger.getCurrentRun(),
      runtime: runtimeStatus(config, threadService, url.searchParams.get('threadId') ?? '', {
        clientProtocol: url.searchParams.get('clientProtocol'),
        clientVersion: url.searchParams.get('clientVersion') ?? ''
      })
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/system/link/status') {
    const sessionId = url.searchParams.get('sessionId') ?? '';
    sendJson(response, 200, {
      link: await collectSystemLinkStatus({
        config,
        store,
        sessions,
        logger,
        diagnostics: desktopLiveDiagnostics,
        sessionId
      })
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/system/link/recover') {
    const body = await readJsonObjectBody(request);
    const sessionId = String(body.sessionId ?? '').trim();
    const mode = String(body.mode ?? 'auto').trim().toLowerCase();
    sendJson(response, 200, {
      link: await recoverSystemLink({
        config,
        store,
        sessions,
        logger,
        diagnostics: desktopLiveDiagnostics,
        recovery: desktopLiveRecovery,
        sessionId,
        mode
      })
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/system/repair/status') {
    const sessionId = url.searchParams.get('sessionId') ?? '';
    sendJson(response, 200, {
      system: await collectSystemRepairStatus({
        store,
        sessions,
        logger,
        diagnostics: desktopLiveDiagnostics,
        sessionId
      })
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/system/repair/run') {
    const body = await readJsonObjectBody(request);
    const sessionId = String(body.sessionId ?? '').trim();
    const requestedMode = String(body.mode ?? 'auto').trim().toLowerCase();
    const initial = await collectSystemRepairStatus({
      store,
      sessions,
      logger,
      diagnostics: desktopLiveDiagnostics,
      sessionId
    });
    if (initial.desktop?.desktopLive === true && requestedMode !== 'hard') {
      sendJson(response, 200, {
        system: {
          ...initial,
          repaired: false,
          repairMode: 'none',
          message: '桌面实时链路已在线，无需恢复'
        }
      });
      return;
    }
    const mode = requestedMode === 'hard'
      ? 'hard'
      : 'soft';
    if ((requestedMode === 'auto' && chooseDesktopRepairMode(initial.desktop) === 'hard')
      || (mode === 'hard' && !isHardDesktopRecoveryConfirmed(body))) {
      sendJson(response, 200, {
        system: {
          ...initial,
          repaired: false,
          repairMode: 'none',
          hardRecoveryRequired: true,
          message: '恢复 CDP 需要重启 Codex。已阻止手机端自动重启，请在桌面端一键启动，或使用明确确认的硬恢复入口。'
        }
      });
      return;
    }
    const desktop = await recoverDesktopLiveManually({
      adapter: store.adapter,
      sessionId,
      logger,
      recovery: desktopLiveRecovery,
      diagnostics: desktopLiveDiagnostics,
      reason: String(body.reason ?? 'system_repair'),
      mode
    });
    const after = await collectSystemRepairStatus({
      store,
      sessions,
      logger,
      diagnostics: desktopLiveDiagnostics,
      sessionId,
      desktopOverride: desktop
    });
    sendJson(response, 200, {
      system: {
        ...after,
        message: desktop.recoveryError || after.message,
        repaired: desktop.recoveryOk === true,
        repairMode: mode
      }
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/desktop/live/status') {
    const allowRecovery = url.searchParams.get('recover') === '1';
    sendJson(response, 200, {
      desktop: allowRecovery
        ? await getRecoverableDesktopLiveStatus({
            adapter: store.adapter,
            sessionId: url.searchParams.get('sessionId') ?? '',
            logger,
            recovery: desktopLiveRecovery,
            diagnostics: desktopLiveDiagnostics,
            source: 'status'
          })
        : await decorateDesktopLiveStatusWithDiagnostics(
            await getDesktopLiveStatus(store.adapter, url.searchParams.get('sessionId') ?? ''),
            desktopLiveDiagnostics
          )
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/desktop/live/recover') {
    const body = await readJsonObjectBody(request);
    const sessionId = String(body.sessionId ?? '').trim();
    const mode = String(body.mode ?? 'soft').trim().toLowerCase() === 'hard' ? 'hard' : 'soft';
    if (mode === 'hard' && !isHardDesktopRecoveryConfirmed(body)) {
      const initial = await decorateDesktopLiveStatusWithDiagnostics(
        await getDesktopLiveStatus(store.adapter, sessionId),
        desktopLiveDiagnostics
      );
      sendJson(response, 200, {
        desktop: decorateDesktopLiveStatus({
          ...initial,
          recoveryAttempted: false,
          recoveryOk: false,
          recoveryError: '硬恢复会重启 Codex，缺少明确确认，已阻止执行。'
        })
      });
      return;
    }
    const status = await recoverDesktopLiveManually({
      adapter: store.adapter,
      sessionId,
      logger,
      recovery: desktopLiveRecovery,
      diagnostics: desktopLiveDiagnostics,
      reason: String(body.reason ?? 'manual'),
      mode
    });
    sendJson(response, 200, { desktop: status });
    return;
  }

  if (method === 'POST' && url.pathname === '/desktop/screenshot/primary') {
    const image = await captureDesktopScreenshot({ config, logger });
    sendJson(response, 200, { image });
    return;
  }

  if (method === 'GET' && url.pathname === '/desktop/script/status') {
    sendJson(response, 200, { bridge: desktopScriptBridge.snapshot({ authRequired: isBridgeAuthRequired() }) });
    return;
  }

  if (method === 'GET' && url.pathname === '/desktop/script/client.js') {
    const bridgeUrl = getDesktopScriptBridgeUrl(request, url);
    const token = process.env.CODEX_BRIDGE_TOKEN ?? '';
    const script = buildDesktopScriptClient({ bridgeUrl, token });
    response.writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    });
    response.end(script);
    return;
  }

  if (method === 'POST' && url.pathname === '/desktop/script/connect') {
    const body = await readJsonObjectBody(request);
    sendJson(response, 200, { bridge: desktopScriptBridge.connect(body, { replace: true }) });
    return;
  }

  if (method === 'POST' && url.pathname === '/desktop/script/status') {
    const body = await readJsonObjectBody(request);
    sendJson(response, 200, { desktop: desktopScriptBridge.updateStatus(body) });
    return;
  }

  if (method === 'POST' && url.pathname === '/desktop/script/poll') {
    const body = await readJsonObjectBody(request);
    sendJson(response, 200, { commands: await desktopScriptBridge.poll(body) });
    return;
  }

  if (method === 'POST' && url.pathname === '/desktop/script/messages') {
    const body = await readJsonObjectBody(request, 8 * 1024 * 1024);
    sendJson(response, 202, desktopScriptBridge.receiveMessages(body));
    return;
  }

  if (method === 'POST' && url.pathname === '/desktop/script/reset') {
    sendJson(response, 200, desktopScriptBridge.reset());
    return;
  }

  if (method === 'GET' && url.pathname === '/projects') {
    const projects = typeof threadService.listProjects === 'function'
      ? await threadService.listProjects()
      : store.listProjects();
    sendJson(response, 200, { projects });
    return;
  }

  if (method === 'GET' && url.pathname === '/slash/index') {
    sendJson(response, 200, await buildSlashIndex({ skillRoots: config.skillRoots }));
    return;
  }

  if (method === 'GET' && url.pathname === '/tasks') {
    const desktopTasks = store.listTasks();
    const appServerRuns = appServerRuntimeMode(config) !== 'desktop' && typeof threadService?.listRuns === 'function'
      ? threadService.listRuns()
      : [];
    const taskIds = new Set(desktopTasks.map((task) => task.id));
    const tasks = [...desktopTasks, ...appServerRuns.filter((run) => !taskIds.has(run.id))]
      .map((task) => serializeTaskSummary(task));
    sendJson(response, 200, { tasks });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/codex/runtime-snapshot') {
    sendJson(response, 200, await threadService.getRuntimeSnapshot({ limit: 500 }));
    return;
  }

  if (method === 'GET' && url.pathname === '/api/codex/threads') {
    const limit = url.searchParams.get('limit') ?? '50';
    const query = url.searchParams.get('q') ?? '';
    sendJson(response, 200, { threads: await threadService.listThreads({ limit, query }) });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/codex/settings') {
    const settings = effectiveCodexSettings(
      {},
      await getDefaultCodexSettings({ codexSettingsProvider, defaultReasoningEffortProvider })
    );
    await logger.write('bridge', 'info', 'model.catalog.loaded', {
      source: settings.modelCatalogSource,
      revision: settings.modelCatalogRevision,
      modelCount: settings.modelOptions.length,
      defaultModel: settings.defaultModel
    }).catch(() => {});
    sendJson(response, 200, {
      settings
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/codex/account/usage') {
    const usage = await accountUsageProvider({
      logger,
      adapter: store.adapter,
      sessionId: url.searchParams.get('sessionId') ?? ''
    });
    await logger.write('bridge', usage?.ok ? 'info' : 'warn', 'codex.account_usage.read', {
      ok: usage?.ok === true,
      status: usage?.status ?? 'unknown',
      source: usage?.source ?? '',
      itemCount: Array.isArray(usage?.items) ? usage.items.length : 0
    }).catch(() => {});
    sendJson(response, 200, { usage });
    return;
  }

  const apiThreadSyncMatch = url.pathname.match(/^\/api\/codex\/threads\/([^/]+)\/sync$/);
  if (method === 'GET' && apiThreadSyncMatch) {
    const limit = url.searchParams.get('limit') ?? '80';
    const after = url.searchParams.get('after') ?? '';
    const before = url.searchParams.get('before') ?? '';
    const thread = await threadService.syncThread(apiThreadSyncMatch[1], { limit, after, before });
    sendJson(response, 200, { thread, session: thread });
    return;
  }

  const apiThreadMatch = url.pathname.match(/^\/api\/codex\/threads\/([^/]+)$/);
  if (method === 'GET' && apiThreadMatch) {
    const tail = url.searchParams.get('tail') ?? '120';
    const thread = await threadService.getThread(apiThreadMatch[1], { tail });
    sendJson(response, 200, { thread, session: thread });
    return;
  }

  const remoteFileMetadataMatch = url.pathname.match(/^\/api\/codex\/threads\/([^/]+)\/files\/metadata$/);
  if (method === 'GET' && remoteFileMetadataMatch) {
    const file = await prepareRemoteSessionFile({
      threadService,
      sessionId: remoteFileMetadataMatch[1],
      requestedPath: url.searchParams.get('path') ?? '',
      maxBytes: config.remoteFileMaxBytes
    });
    sendJson(response, 200, { file: publicRemoteFileMetadata(file) });
    return;
  }

  const remoteFileDownloadMatch = url.pathname.match(/^\/api\/codex\/threads\/([^/]+)\/files\/download$/);
  if (method === 'GET' && remoteFileDownloadMatch) {
    const file = await prepareRemoteSessionFile({
      threadService,
      sessionId: remoteFileDownloadMatch[1],
      requestedPath: url.searchParams.get('path') ?? '',
      maxBytes: config.remoteFileMaxBytes
    });
    const bytes = await fs.readFile(file.filePath);
    response.writeHead(200, {
      'content-type': file.mimeType,
      'content-length': bytes.length,
      'content-disposition': remoteFileContentDisposition(file.fileName),
      'cache-control': 'private, no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'access-control-allow-headers': 'Content-Type,Authorization,X-Codex-Bridge-Token'
    });
    response.end(bytes);
    return;
  }

  const apiThreadDeleteMatch = url.pathname.match(/^\/api\/codex\/threads\/([^/]+)\/delete$/);
  if ((method === 'DELETE' && apiThreadMatch) || (method === 'POST' && apiThreadDeleteMatch)) {
    const threadId = (apiThreadMatch ?? apiThreadDeleteMatch)[1];
    const deleted = await deleteCodexThread({ threadService, sessionSettings, logger, id: threadId, eventName: 'codex.thread.deleted', idKey: 'threadId' });
    sendJson(response, 200, { deleted });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/codex/threads') {
    const body = await readJsonObjectBody(request);
    const prompt = String(body.prompt ?? body.text ?? '');
    const projectId = resolveProjectId(config, String(body.projectId ?? ''));
    const submissionId = String(body.submissionId ?? '');
    if (outbox && submissionId.trim()) {
      const accepted = await outbox.enqueue({
        kind: 'new_thread',
        projectId,
        submissionId,
        text: prompt,
        payload: body
      });
      await outbox.dispatchReady();
      sendOutboxResponse(response, outbox.get(accepted.id), url);
      return;
    }
    const dispatched = await dispatchNewThreadMessage({
      body,
      config,
      store,
      logger,
      sessionSettings,
      defaultReasoningEffortProvider,
      codexSettingsProvider,
      threadService,
      desktopLiveRecovery,
      desktopLiveDiagnostics
    });
    sendJson(response, dispatched.statusCode, serializeDispatchPayload(dispatched.payload, url));
    return;
  }

  if (method === 'GET' && url.pathname === '/api/outbox') {
    sendJson(response, 200, {
      items: outbox
        ? outbox.list({
            threadId: url.searchParams.get('threadId') ?? '',
            includeTerminal: url.searchParams.get('active') !== '1'
          }).map(serializeOutboxItem)
        : []
    });
    return;
  }

  const apiOutboxMatch = url.pathname.match(/^\/api\/outbox\/([^/]+)$/);
  if ((method === 'PATCH' || method === 'PUT') && apiOutboxMatch) {
    requireOutbox(outbox);
    const item = await outbox.update(apiOutboxMatch[1], await readJsonObjectBody(request));
    sendJson(response, 200, { item: serializeOutboxItem(item) });
    return;
  }

  const apiOutboxActionMatch = url.pathname.match(/^\/api\/outbox\/([^/]+)\/(move|cancel|retry)$/);
  if (method === 'POST' && apiOutboxActionMatch) {
    requireOutbox(outbox);
    const [, itemId, action] = apiOutboxActionMatch;
    const body = await readJsonObjectBody(request);
    const item = action === 'move'
      ? await outbox.move(itemId, String(body.direction ?? ''))
      : action === 'cancel'
        ? await outbox.cancel(itemId)
        : await outbox.retry(itemId);
    if (action === 'retry') {
      await outbox.dispatchReady();
    }
    sendJson(response, 200, { item: serializeOutboxItem(outbox.get(item.id)) });
    return;
  }

  const apiThreadSettingsMatch = url.pathname.match(/^\/api\/codex\/threads\/([^/]+)\/settings$/);
  if (method === 'GET' && apiThreadSettingsMatch) {
    const threadId = apiThreadSettingsMatch[1];
    assertValidCodexSessionId(threadId);
    sendJson(response, 200, {
      settings: effectiveCodexSettings(
        await sessionSettings.getSessionSettings(threadId),
        await getThreadCodexDefaults({ codexSettingsProvider, defaultReasoningEffortProvider, sessions, threadId })
      )
    });
    return;
  }

  if (method === 'POST' && apiThreadSettingsMatch) {
    const threadId = apiThreadSettingsMatch[1];
    assertValidCodexSessionId(threadId);
    const body = await readJsonObjectBody(request);
    const settings = await sessionSettings.updateSessionSettings(threadId, {
      model: body.model,
      reasoningEffort: body.reasoningEffort
    });
    await logger.write('bridge', 'info', 'codex.thread.settings.updated', {
      threadId,
      model: settings.model || 'auto',
      reasoningEffort: settings.reasoningEffort || 'auto'
    });
    sendJson(response, 200, {
      settings: effectiveCodexSettings(
        settings,
        await getThreadCodexDefaults({ codexSettingsProvider, defaultReasoningEffortProvider, sessions, threadId })
      )
    });
    return;
  }

  const apiThreadMessageMatch = url.pathname.match(/^\/api\/codex\/threads\/([^/]+)\/messages$/);
  if (method === 'POST' && apiThreadMessageMatch) {
    const body = await readJsonObjectBody(request);
    const threadId = apiThreadMessageMatch[1];
    const projectId = resolveProjectId(config, String(body.projectId ?? ''));
    const prompt = String(body.text ?? body.prompt ?? '');
    const submissionId = String(body.submissionId ?? '');
    if (outbox && submissionId.trim()) {
      const accepted = await outbox.enqueue({
        kind: 'existing_thread',
        threadId,
        projectId,
        submissionId,
        text: prompt,
        payload: body
      });
      await outbox.dispatchReady();
      sendOutboxResponse(response, outbox.get(accepted.id), url);
      return;
    }
    const dispatched = await dispatchExistingThreadMessage({
      threadId,
      body,
      config,
      store,
      logger,
      sessions,
      sessionSettings,
      defaultReasoningEffortProvider,
      codexSettingsProvider,
      threadService,
      desktopLiveRecovery,
      desktopLiveDiagnostics,
      desktopOpener
    });
    sendJson(response, dispatched.statusCode, serializeDispatchPayload(dispatched.payload, url));
    return;
  }

  const apiRunMatch = url.pathname.match(/^\/api\/codex\/runs\/([^/]+)$/);
  if (method === 'GET' && apiRunMatch) {
    const queued = outbox?.get(apiRunMatch[1]);
    if (queued) {
      sendOutboxResponse(response, queued, url);
      return;
    }
    const task = store.getTask(apiRunMatch[1]);
    if (task) {
      sendJson(response, 200, { run: serializeTask(task, serializationOptions(url)) });
      return;
    }
    sendJson(response, 200, { run: serializeTask(threadService.getRun(apiRunMatch[1]), serializationOptions(url)) });
    return;
  }

  const apiRunInterruptMatch = url.pathname.match(/^\/api\/codex\/runs\/([^/]+)\/interrupt$/);
  if (method === 'POST' && apiRunInterruptMatch) {
    const queued = outbox?.get(apiRunInterruptMatch[1]);
    if (queued && ['queued', 'failed', 'uncertain'].includes(queued.status)) {
      const canceled = await outbox.cancel(queued.id);
      sendOutboxResponse(response, canceled, url);
      return;
    }
    const task = store.getTask(apiRunInterruptMatch[1]);
    if (task) {
      const interrupted = store.interruptTask(apiRunInterruptMatch[1]);
      const confirmed = await maybeWaitForInterruptConfirmation(store, interrupted, url);
      sendJson(response, 200, { run: serializeTask(confirmed, serializationOptions(url)) });
      return;
    }
    sendJson(response, 200, { run: serializeTask(await threadService.interruptRun(apiRunInterruptMatch[1]), serializationOptions(url)) });
    return;
  }

  const apiThreadInterruptMatch = url.pathname.match(/^\/api\/codex\/threads\/([^/]+)\/interrupt$/);
  if (method === 'POST' && apiThreadInterruptMatch) {
    const threadId = apiThreadInterruptMatch[1];
    if (shouldUseAppServerForExistingThread(config, threadId)) {
      const interrupted = await threadService.interruptThread(threadId);
      sendJson(response, 200, { run: serializeTask(interrupted, serializationOptions(url)) });
      return;
    }
    if (shouldUseDesktopPrimaryFallback(config)) {
      try {
        const interrupted = await threadService.interruptThread(threadId);
        sendJson(response, 200, { run: serializeTask(interrupted, serializationOptions(url)) });
        return;
      } catch (error) {
        if (error?.statusCode !== 404) {
          throw error;
        }
      }
    }
    const task = store.interruptSessionTask(threadId);
    const confirmed = await maybeWaitForInterruptConfirmation(store, task, url);
    sendJson(response, 200, { run: serializeTask(confirmed, serializationOptions(url)) });
    return;
  }

  const apiRunEventsMatch = url.pathname.match(/^\/api\/codex\/runs\/([^/]+)\/events$/);
  if (method === 'GET' && apiRunEventsMatch) {
    if (store.getTask(apiRunEventsMatch[1])) {
      streamEvents({ response, store, eventBus, taskId: apiRunEventsMatch[1] });
      return;
    }
    streamRunEvents({ response, eventBus, threadService, runId: apiRunEventsMatch[1] });
    return;
  }

  if (method === 'GET' && url.pathname === '/codex/sessions') {
    const limit = url.searchParams.get('limit') ?? '50';
    const query = url.searchParams.get('q') ?? '';
    sendJson(response, 200, { sessions: await threadService.listThreads({ limit, query }) });
    return;
  }

  const sessionMatch = url.pathname.match(/^\/codex\/sessions\/([^/]+)$/);
  if (method === 'GET' && sessionMatch) {
    const tail = url.searchParams.get('tail') ?? '80';
    sendJson(response, 200, { session: await threadService.getThread(sessionMatch[1], { tail }) });
    return;
  }

  const sessionDeleteMatch = url.pathname.match(/^\/codex\/sessions\/([^/]+)\/delete$/);
  if ((method === 'DELETE' && sessionMatch) || (method === 'POST' && sessionDeleteMatch)) {
    const sessionId = (sessionMatch ?? sessionDeleteMatch)[1];
    const deleted = await deleteCodexThread({ threadService, sessionSettings, logger, id: sessionId, eventName: 'codex.session.deleted', idKey: 'sessionId' });
    sendJson(response, 200, { deleted });
    return;
  }

  const sessionOpenMatch = url.pathname.match(/^\/codex\/sessions\/([^/]+)\/open$/);
  if (method === 'POST' && sessionOpenMatch) {
    sendJson(response, 202, { desktop: await desktopOpener(sessionOpenMatch[1]) });
    return;
  }

  if (method === 'POST' && url.pathname === '/logs/run') {
    const body = await readJsonObjectBody(request);
    const run = await logger.startRun(body.label ?? 'manual');
    sendJson(response, 201, { run });
    return;
  }

  if (method === 'POST' && url.pathname === '/logs') {
    const body = await readJsonObjectBody(request, 256 * 1024);
    const entry = await writeAppLog(logger, body);
    sendJson(response, 202, { ok: true, id: entry.id });
    return;
  }

  if (method === 'POST' && url.pathname === '/logs/batch') {
    const body = await readJsonObjectBody(request, 1024 * 1024);
    const logs = Array.isArray(body.logs) ? body.logs.slice(0, 200) : [];
    const entries = [];
    for (const log of logs) {
      if (!log || typeof log !== 'object' || Array.isArray(log)) {
        continue;
      }
      entries.push(await writeAppLog(logger, log));
    }
    sendJson(response, 202, { ok: true, count: entries.length, ids: entries.map((entry) => entry.id) });
    return;
  }

  if (method === 'POST' && url.pathname === '/mobile/images') {
    const startedAt = Date.now();
    await logger?.write?.('bridge', 'info', 'mobile.image.upload.started', {
      contentLength: Number.parseInt(request.headers['content-length'] ?? '0', 10) || 0,
      contentType: request.headers['content-type'] ?? ''
    }).catch(() => {});
    const body = await readJsonObjectBody(request, 32 * 1024 * 1024);
    const image = await saveMobileImageUpload({ body, config, logger });
    await logger?.write?.('bridge', 'info', 'mobile.image.upload.completed', {
      filePath: image.filePath,
      bytes: image.bytes,
      durationMs: Date.now() - startedAt
    }).catch(() => {});
    sendJson(response, 201, { image });
    return;
  }

  if (method === 'POST' && url.pathname === '/mobile/files') {
    const startedAt = Date.now();
    const body = await readJsonObjectBody(request, 24 * 1024 * 1024);
    const file = await saveMobileFileUpload({ body, config, logger });
    await logger?.write?.('bridge', 'info', 'mobile.file.upload.completed', {
      filePath: file.filePath,
      bytes: file.bytes,
      durationMs: Date.now() - startedAt
    }).catch(() => {});
    sendJson(response, 201, { file });
    return;
  }

  if (method === 'GET' && url.pathname === '/mobile/images/file') {
    await sendMobileImageFile({ response, url, config });
    return;
  }

  if (method === 'GET' && url.pathname === '/logs/summary') {
    const summary = await analyzeLogRun(logger.currentRunDir);
    sendJson(response, 200, { summary });
    return;
  }

  if (method === 'POST' && url.pathname === '/tasks') {
    const body = await readJsonObjectBody(request);
    if (body.codexSessionId) {
      assertValidCodexSessionId(body.codexSessionId);
      const sessionFingerprint = requireSessionFingerprint(body.sessionFingerprint);
      const verified = await sessions.verifySessionTarget(body.codexSessionId, sessionFingerprint);
      body.verifiedSessionTarget = verified;
      await logger.write('bridge', 'info', 'session.target.verified', {
        sessionId: body.codexSessionId,
        title: verified.title,
        projectLabel: verified.projectLabel,
        filePath: verified.filePath,
        requestedTitle: sessionFingerprint.title ?? '',
        requestedProjectLabel: sessionFingerprint.projectLabel ?? ''
      });
    }
    const task = store.createTask(body);
    sendJson(response, 202, { task: serializeTask(task, serializationOptions(url)) });
    return;
  }

  const taskMatch = url.pathname.match(/^\/tasks\/([^/]+)$/);
  if (method === 'GET' && taskMatch) {
    const task = store.getTask(taskMatch[1]);
    if (!task) {
      sendJson(response, 404, { error: 'Unknown task' });
      return;
    }
    sendJson(response, 200, { task: serializeTask(task, serializationOptions(url)) });
    return;
  }

  const taskInterruptMatch = url.pathname.match(/^\/tasks\/([^/]+)\/interrupt$/);
  if (method === 'POST' && taskInterruptMatch) {
    const task = store.interruptTask(taskInterruptMatch[1]);
    const confirmed = await maybeWaitForInterruptConfirmation(store, task, url);
    sendJson(response, 200, { task: serializeTask(confirmed, serializationOptions(url)) });
    return;
  }

  const eventsMatch = url.pathname.match(/^\/tasks\/([^/]+)\/events$/);
  if (method === 'GET' && eventsMatch) {
    streamEvents({ response, store, eventBus, taskId: eventsMatch[1] });
    return;
  }

  const approvalMatch = url.pathname.match(/^\/approvals\/([^/]+)$/);
  if (method === 'POST' && approvalMatch) {
    const body = await readJsonObjectBody(request);
    const approvalId = approvalMatch[1];
    const appServerApproval = typeof threadService.getApproval === 'function'
      ? threadService.getApproval(approvalId)
      : null;
    const approval = appServerApproval
      ? threadService.decideApproval(approvalId, body.decision)
      : store.decideApproval(approvalId, body.decision);
    sendJson(response, 200, { approval: serializeApproval(approval) });
    return;
  }

  if (method === 'GET' && url.pathname === '/user-inputs') {
    const userInputs = typeof threadService.listUserInputs === 'function'
      ? threadService.listUserInputs()
      : [];
    sendJson(response, 200, { userInputs });
    return;
  }

  const userInputMatch = url.pathname.match(/^\/user-inputs\/([^/]+)$/);
  if (method === 'POST' && userInputMatch) {
    if (typeof threadService.answerUserInput !== 'function') {
      sendJson(response, 404, { error: 'Structured user input is unavailable' });
      return;
    }
    const body = await readJsonObjectBody(request);
    const userInput = threadService.answerUserInput(userInputMatch[1], body.answers);
    sendJson(response, 200, { userInput });
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}

async function getDefaultReasoningEffort(defaultReasoningEffortProvider) {
  try {
    return normalizeReasoningEffort(await defaultReasoningEffortProvider());
  } catch {
    return '';
  }
}

async function getDefaultCodexSettings({ codexSettingsProvider, defaultReasoningEffortProvider }) {
  const fallbackReasoningEffort = await getDefaultReasoningEffort(defaultReasoningEffortProvider);
  if (typeof codexSettingsProvider !== 'function') {
    return {
      model: '',
      reasoningEffort: fallbackReasoningEffort,
      source: '',
      models: []
    };
  }
  try {
    const settings = await codexSettingsProvider();
    const providerReasoningEffort = normalizeReasoningEffort(settings?.reasoningEffort ?? '');
    return {
      model: normalizeModelId(settings?.model ?? ''),
      reasoningEffort: providerReasoningEffort || fallbackReasoningEffort,
      source: String(settings?.source ?? settings?.modelCatalogSource ?? ''),
      modelCatalogRevision: String(settings?.modelCatalogRevision ?? ''),
      models: Array.isArray(settings?.models) ? settings.models : []
    };
  } catch {
    return {
      model: '',
      reasoningEffort: fallbackReasoningEffort,
      source: '',
      models: []
    };
  }
}

async function readPrimaryCodexSettings({ threadService }) {
  try {
    return await readAppServerCodexSettings(threadService);
  } catch {
    return await readDesktopCodexSettings();
  }
}

async function getThreadDefaultReasoningEffort({ defaultReasoningEffortProvider, sessions, threadId }) {
  try {
    if (threadId && sessions && typeof sessions.getSessionReasoningEffort === 'function') {
      const threadReasoningEffort = normalizeReasoningEffort(await sessions.getSessionReasoningEffort(threadId));
      if (threadReasoningEffort) {
        return threadReasoningEffort;
      }
    }
  } catch {
    // Fall back to the visible/global desktop default when per-thread state is unavailable.
  }
  return getDefaultReasoningEffort(defaultReasoningEffortProvider);
}

async function getThreadCodexDefaults({ codexSettingsProvider, defaultReasoningEffortProvider, sessions, threadId }) {
  const defaults = await getDefaultCodexSettings({ codexSettingsProvider, defaultReasoningEffortProvider });
  let threadModel = '';
  let threadReasoningEffort = '';
  try {
    if (threadId && sessions && typeof sessions.getSessionModel === 'function') {
      threadModel = normalizeModelId(await sessions.getSessionModel(threadId));
    }
  } catch {
    threadModel = '';
  }
  try {
    if (threadId && sessions && typeof sessions.getSessionReasoningEffort === 'function') {
      threadReasoningEffort = normalizeReasoningEffort(await sessions.getSessionReasoningEffort(threadId));
    }
  } catch {
    threadReasoningEffort = '';
  }
  return {
    ...defaults,
    model: threadModel || defaults.model,
    reasoningEffort: threadReasoningEffort || defaults.reasoningEffort
  };
}

async function readEffectiveDesktopReasoningEffort() {
  const visible = await readDesktopVisibleReasoningEffort();
  if (visible) {
    return visible;
  }
  return readCodexDefaultReasoningEffort();
}

async function deleteCodexThread({ threadService, sessionSettings, logger, id, eventName, idKey }) {
  assertValidCodexSessionId(id);
  const deleted = await threadService.deleteThread(id);
  await sessionSettings?.deleteSessionSettings?.(id).catch(() => {});
  await logger.write('bridge', 'warn', eventName, {
    [idKey]: id,
    deletedFiles: deleted.deletedFiles ?? [],
    archivedThreadCount: deleted.archivedThreadCount ?? 0,
    removedIndexRecords: deleted.removedIndexRecords ?? 0,
    removedGlobalStateEntries: deleted.removedGlobalStateEntries ?? 0
  });
  return deleted;
}

async function captureDesktopScreenshot({ config, logger }) {
  const startedAt = Date.now();
  const provider = config.desktopScreenshotProvider ?? capturePrimaryDesktopScreenshot;
  const image = await provider();
  const base64 = normalizeImageBase64(String(image.base64 ?? ''));
  if (base64.length === 0) {
    const error = new Error('桌面截图内容为空。');
    error.statusCode = 500;
    throw error;
  }
  const bytes = Number(image.bytes ?? Buffer.from(base64, 'base64').length);
  await logger?.write?.('bridge', 'info', 'desktop.screenshot.captured', {
    mimeType: image.mimeType ?? 'image/png',
    bytes,
    width: image.width ?? null,
    height: image.height ?? null,
    durationMs: Number(image.durationMs ?? Date.now() - startedAt)
  }).catch(() => {});

  return {
    mimeType: image.mimeType ?? 'image/png',
    base64,
    bytes,
    width: image.width ?? null,
    height: image.height ?? null,
    capturedAt: image.capturedAt ?? new Date().toISOString()
  };
}

async function saveMobileImageUpload({ body, config, logger }) {
  const mimeType = String(body.mimeType ?? '').trim().toLowerCase();
  if (!/^image\/(png|jpe?g|webp|gif)$/.test(mimeType)) {
    const error = new Error('只支持上传 png、jpg、webp 或 gif 图片。');
    error.statusCode = 400;
    throw error;
  }

  const base64 = normalizeImageBase64(String(body.base64 ?? ''));
  if (base64.length === 0) {
    const error = new Error('图片内容为空。');
    error.statusCode = 400;
    throw error;
  }

  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) {
    const error = new Error('图片内容无法解析。');
    error.statusCode = 400;
    throw error;
  }
  if (bytes.length > 15 * 1024 * 1024) {
    const error = new Error('图片超过 15MB，请先压缩后再发送。');
    error.statusCode = 413;
    throw error;
  }

  const uploadDir = config.mobileImagesDir ?? path.join(process.cwd(), 'logs', 'mobile-images');
  await fs.mkdir(uploadDir, { recursive: true });
  const extension = imageExtension(mimeType, body.fileName);
  const safeName = safeFileName(String(body.fileName ?? 'phone-image'));
  const fileName = `${timestampFilePart()}-${safeName}.${extension}`;
  const filePath = path.join(uploadDir, fileName);
  await fs.writeFile(filePath, bytes);

  const messageText = `![手机端图片](${filePath.replace(/\\/g, '/')})`;

  await logger?.write?.('bridge', 'info', 'mobile.image.uploaded', {
    filePath,
    mimeType,
    bytes: bytes.length
  }).catch(() => {});

  return {
    fileName,
    filePath,
    mimeType,
    bytes: bytes.length,
    messageText
  };
}

async function saveMobileFileUpload({ body, config, logger }) {
  const originalName = path.basename(String(body.fileName ?? '').trim());
  assertSafeMobileFileName(originalName);
  const base64 = normalizeImageBase64(String(body.base64 ?? ''));
  if (base64.length === 0) {
    const error = new Error('文件内容为空。');
    error.statusCode = 400;
    throw error;
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) {
    const error = new Error('文件内容无法解析。');
    error.statusCode = 400;
    throw error;
  }
  const maxBytes = Math.max(1, Number(config.mobileFileMaxBytes ?? 10 * 1024 * 1024));
  if (bytes.length > maxBytes) {
    const error = new Error(`文件超过 ${Math.ceil(maxBytes / (1024 * 1024))}MB 上传限制。`);
    error.statusCode = 413;
    throw error;
  }

  const uploadDir = config.mobileFilesDir ?? path.join(process.cwd(), 'logs', 'mobile-files');
  await fs.mkdir(uploadDir, { recursive: true });
  const fileName = `${timestampFilePart()}-${safeAttachmentFileName(originalName)}`;
  const filePath = path.join(uploadDir, fileName);
  await fs.writeFile(filePath, bytes);
  const mimeType = String(body.mimeType ?? 'application/octet-stream').trim().toLowerCase()
    || 'application/octet-stream';
  const messageText = `手机端文件：${filePath.replace(/\\/g, '/')}`;
  await logger?.write?.('bridge', 'info', 'mobile.file.uploaded', {
    filePath,
    fileName,
    mimeType,
    bytes: bytes.length
  }).catch(() => {});
  return {
    fileName,
    filePath,
    mimeType,
    bytes: bytes.length,
    messageText
  };
}

async function sendMobileImageFile({ response, url, config }) {
  const requestedPath = String(url.searchParams.get('path') ?? '').trim();
  if (requestedPath.length === 0) {
    const error = new Error('缺少图片路径。');
    error.statusCode = 400;
    throw error;
  }

  const uploadDir = path.resolve(config.mobileImagesDir ?? path.join(process.cwd(), 'logs', 'mobile-images'));
  const normalizedPath = path.resolve(requestedPath);
  const relativePath = path.relative(uploadDir, normalizedPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    const error = new Error('图片路径不在允许访问的手机上传目录内。');
    error.statusCode = 403;
    throw error;
  }

  const extension = path.extname(normalizedPath).toLowerCase();
  const mimeType = imageMimeTypeFromExtension(extension);
  if (!mimeType) {
    const error = new Error('不支持预览该图片类型。');
    error.statusCode = 415;
    throw error;
  }

  const bytes = await fs.readFile(normalizedPath);
  response.writeHead(200, {
    'content-type': mimeType,
    'content-length': bytes.length,
    'cache-control': 'private, max-age=3600',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'Content-Type,Authorization,X-Codex-Bridge-Token'
  });
  response.end(bytes);
}

function normalizeImageBase64(value) {
  const text = String(value ?? '').trim();
  const comma = text.indexOf(',');
  return (comma >= 0 ? text.slice(comma + 1) : text).replace(/\s+/g, '');
}

function imageExtension(mimeType, fileName = '') {
  const lowerName = String(fileName ?? '').toLowerCase();
  const match = lowerName.match(/\.([a-z0-9]{2,5})$/);
  if (match && ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(match[1])) {
    return match[1] === 'jpeg' ? 'jpg' : match[1];
  }
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('gif')) return 'gif';
  return 'jpg';
}

function imageMimeTypeFromExtension(extension) {
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  return '';
}

function safeFileName(value) {
  const text = String(value ?? 'phone-image')
    .replace(/\.[A-Za-z0-9]{2,5}$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return text || 'phone-image';
}

function assertSafeMobileFileName(value) {
  const name = String(value ?? '').trim();
  const lower = name.toLowerCase();
  const extension = path.extname(lower);
  const allowedExtensions = new Set([
    '.txt', '.md', '.log', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.xml',
    '.csv', '.tsv', '.ini', '.cfg', '.conf', '.sql', '.html', '.css',
    '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.java', '.kt', '.kts',
    '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.sh', '.ps1',
    '.bat', '.cmd', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.png', '.jpg', '.jpeg', '.webp', '.gif'
  ]);
  const sensitive = lower === '.env'
    || lower.startsWith('.env.')
    || /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(lower)
    || ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.mobileprovision'].includes(extension)
    || /(^|[._-])(credential|credentials|secrets?|tokens?)([._-]|$)/.test(lower);
  if (!name || sensitive || !allowedExtensions.has(extension)) {
    const error = new Error('该文件类型或敏感文件名不允许上传。');
    error.statusCode = 415;
    throw error;
  }
}

function safeAttachmentFileName(value) {
  const safe = String(value ?? 'attachment.txt')
    .replace(/[^A-Za-z0-9\u4e00-\u9fff._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return safe || 'attachment.txt';
}

function timestampFilePart() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function getDesktopLiveStatus(adapter, sessionId = '') {
  if (adapter && typeof adapter.getDesktopLiveStatus === 'function') {
    return adapter.getDesktopLiveStatus(8000, sessionId);
  }
  if (adapter && typeof adapter.probe === 'function') {
    try {
      await adapter.probe();
      return {
        ok: true,
        desktopLive: true,
        status: 'ready',
        currentSessionId: null,
        targetSessionId: sessionId,
        sessionVerified: false,
        message: '已连接当前 Codex 桌面窗口实时通道',
        checkedAt: new Date().toISOString()
      };
    } catch (error) {
      return {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        currentSessionId: null,
        targetSessionId: sessionId,
        sessionVerified: false,
        message: '桌面实时通道未连接，手机端不能直接投递到当前桌面会话。',
        reason: error?.message ?? 'unknown',
        checkedAt: new Date().toISOString()
      };
    }
  }
  return {
    ok: true,
    desktopLive: false,
    status: 'unsupported',
    currentSessionId: null,
    targetSessionId: sessionId,
    sessionVerified: false,
    message: '当前桥接适配器不支持桌面实时通道检测',
    checkedAt: new Date().toISOString()
  };
}

async function getPhoneSendDesktopStatus({ config, adapter, sessionId = '', logger, recovery, diagnostics, source }) {
  if (appServerRuntimeMode(config) === 'desktop') {
    return decorateDesktopLiveStatusWithDiagnostics(
      await getDesktopLiveStatus(adapter, sessionId),
      diagnostics
    );
  }
  return getRecoverableDesktopLiveStatus({
    adapter,
    sessionId,
    logger,
    recovery,
    diagnostics,
    source
  });
}

async function getRecoverableDesktopLiveStatus({ adapter, sessionId = '', logger, recovery, diagnostics, source = 'status' }) {
  const initial = await decorateDesktopLiveStatusWithDiagnostics(
    await getDesktopLiveStatus(adapter, sessionId),
    diagnostics
  );
  if (initial.mobileRecoverable === false) {
    return initial;
  }
  if (!recovery || typeof recovery.shouldRecover !== 'function' || !recovery.shouldRecover(initial)) {
    return initial;
  }

  try {
    await recovery.recover({
      sessionId,
      logger,
      reason: `${source}: ${initial.reason ?? initial.message ?? initial.status ?? 'unknown'}`,
    });
  } catch (error) {
    return decorateDesktopLiveStatus({
      ...initial,
      recoveryAttempted: true,
      recoveryOk: false,
      recoveryError: error?.message ?? String(error),
      reason: `${initial.reason ?? initial.message ?? '桌面实时通道未连接'}；自动恢复失败：${error?.message ?? String(error)}`
    });
  }

  const recovered = await decorateDesktopLiveStatusWithDiagnostics(
    await getDesktopLiveStatus(adapter, sessionId),
    diagnostics
  );
  return decorateDesktopLiveStatus({
    ...recovered,
    recoveryAttempted: true,
    recoveryOk: recovered.desktopLive === true
  });
}

function assertDesktopReadyForNewThread(status) {
  if (status?.desktopLive === true) {
    return;
  }
  const message = status?.message ?? status?.reason ?? '桌面 CDP 不可用';
  const error = new Error(`桌面实时通道不可用，已阻止新建会话，避免手机创建桌面端不可见的独立会话：${message}`);
  error.statusCode = 503;
  error.desktop = {
    ...status,
    targetSessionId: '',
    required: 'desktop_live'
  };
  error.preflight = {
    ok: false,
    canSend: false,
    desktopLive: false,
    sessionVerified: false,
    severity: 'blocked',
    recommendedAction: 'desktop_cdp_required',
    recoverableFromPhone: false,
    message
  };
  throw error;
}

function assertDesktopThreadReady(status, threadId) {
  if (desktopTargetReady(status, threadId)) {
    return;
  }
  const preflight = status?.preflight ?? buildDesktopSendPreflight(status, threadId);
  const message = status?.message ?? status?.reason ?? '桌面 App Server 未确认目标会话，手机端已阻止发送。';
  const error = new Error(`桌面 App Server 未确认手机选择的目标会话，已阻止发送，避免产生独立会话：${message}`);
  error.statusCode = preflight.recommendedAction === 'sync_session' ? 409 : 503;
  error.desktop = {
    ...status,
    targetSessionId: status?.targetSessionId ?? threadId,
    required: 'desktop_live_verified_target'
  };
  error.preflight = preflight;
  throw error;
}

function buildDesktopSendPreflight(status, threadId) {
  const targetSessionId = status?.targetSessionId ?? threadId;
  const desktopLive = status?.desktopLive === true;
  const sessionVerified = status?.sessionVerified === true;
  const targetVerified = status?.targetVerified === true || sessionVerified;
  const ok = desktopLive && targetVerified;
  const mode = chooseDesktopRepairMode(status);
  let recommendedAction = 'none';
  let recoverableFromPhone = true;
  let severity = 'ok';
  let message = status?.message ?? status?.reason ?? '';

  if (!ok) {
    if (desktopLive) {
      recommendedAction = 'sync_session';
      recoverableFromPhone = true;
      severity = 'degraded';
      message = message || '桌面链路在线，但桌面 App Server 尚未确认手机选择的目标会话。';
    } else if (mode === 'hard') {
      recommendedAction = 'desktop_cdp_restart_required';
      recoverableFromPhone = false;
      severity = 'blocked';
      message = status?.recoveryHint ?? (message || '当前 Codex 没有可用 CDP，手机端不能软恢复。');
    } else if (status?.mobileRecoverable !== false) {
      recommendedAction = 'soft_recover_live_host';
      recoverableFromPhone = true;
      severity = 'degraded';
      message = status?.recoveryHint ?? (message || '桌面 live-host 不在线，可先从手机端软恢复后重试。');
    } else {
      recommendedAction = 'desktop_required';
      recoverableFromPhone = false;
      severity = 'blocked';
      message = status?.recoveryHint ?? (message || '手机端无法恢复当前桌面链路，需要在电脑端处理。');
    }
  }

  return {
    ok,
    canSend: ok,
    canGuideRunningTurn: ok,
    canInterrupt: ok,
    desktopLive,
    sessionVerified,
    targetVerified,
    status: status?.status ?? '',
    currentSessionId: status?.currentSessionId ?? null,
    targetSessionId,
    severity,
    recommendedAction,
    recoverableFromPhone,
    requiresHardRecovery: !ok && mode === 'hard',
    requiresDesktopCdp: status?.requiresDesktopCdp === true,
    failureClass: status?.failureClass ?? '',
    desktopProcessMode: status?.desktopProcessMode ?? '',
    recoveryAttempted: status?.recoveryAttempted === true,
    recoveryOk: status?.recoveryOk === true,
    recoveryError: status?.recoveryError ?? '',
    message
  };
}

function desktopTargetReady(status, threadId = '') {
  if (status?.desktopLive !== true) {
    return false;
  }
  if (!String(threadId ?? status?.targetSessionId ?? '').trim()) {
    return true;
  }
  return status?.sessionVerified === true || status?.targetVerified === true;
}

function assertValidCodexSessionId(sessionId) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(sessionId ?? ''))) {
    const error = new Error('Invalid Codex session id');
    error.statusCode = 400;
    throw error;
  }
}

function requireSessionFingerprint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error('手机端发送已有会话时缺少会话指纹，已阻止发送。请重新打开会话后再试，避免消息进入错误工作区。');
    error.statusCode = 409;
    throw error;
  }
  return value;
}

async function maybeOpenDesktopThreadForPhoneSend({ desktopOpener, threadId, logger }) {
  if (process.env.CODEX_BRIDGE_OPEN_DESKTOP_ON_PHONE_SEND !== '1') {
    const result = {
      ok: false,
      skipped: true,
      reason: 'disabled_for_phone_send'
    };
    await logger?.write?.('bridge', 'info', 'desktop.thread.open.skipped', {
      threadId,
      reason: result.reason
    }).catch(() => {});
    return result;
  }
  return tryOpenDesktopThread({ desktopOpener, threadId, logger });
}

async function tryOpenDesktopThread({ desktopOpener, threadId, logger }) {
  if (typeof desktopOpener !== 'function') {
    return {
      ok: false,
      skipped: true,
      reason: 'desktop opener unavailable'
    };
  }
  try {
    const result = await desktopOpener(threadId);
    await logger?.write?.('bridge', 'info', 'desktop.thread.open.requested', {
      threadId,
      result
    });
    await delay(350);
    return result;
  } catch (error) {
    const result = {
      ok: false,
      skipped: true,
      reason: error?.message ?? String(error),
      desktop: error?.desktop ?? null
    };
    await logger?.write?.('bridge', 'warn', 'desktop.thread.open.skipped', {
      threadId,
      reason: result.reason,
      desktop: result.desktop
    }).catch(() => {});
    return result;
  }
}

async function recoverDesktopLiveManually({ adapter, sessionId = '', logger, recovery, diagnostics, reason = 'manual', mode = 'soft' }) {
  const initial = await decorateDesktopLiveStatusWithDiagnostics(
    await getDesktopLiveStatus(adapter, sessionId),
    diagnostics
  );
  const hard = mode === 'hard';
  if (initial.mobileRecoverable === false && !hard) {
    await logger?.write?.('bridge', 'warn', 'desktop_live.recovery.skipped', {
      sessionId,
      reason: initial.recoveryHint ?? initial.reason ?? initial.message ?? 'not mobile recoverable',
      failureClass: initial.failureClass ?? '',
      desktopProcessMode: initial.desktopProcessMode ?? ''
    }).catch(() => {});
    return decorateDesktopLiveStatus({
      ...initial,
      recoveryAttempted: false,
      recoveryOk: false,
      recoveryError: initial.recoveryHint ?? '当前状态不能通过手机端软恢复'
    });
  }
  if (!recovery || typeof recovery.recover !== 'function') {
    const error = new Error('桌面 live 恢复器不可用');
    error.statusCode = 500;
    error.desktop = initial;
    throw error;
  }
  try {
    const result = await recovery.recover({
      sessionId,
      logger,
      reason: `manual:${reason || initial.reason || initial.message || initial.status || 'unknown'}`,
      mode: hard ? 'hard' : 'soft'
    });
    if (result?.skipped === true || (hard && (result?.attempted !== true || result?.ok !== true || result?.mode !== 'hard'))) {
      return decorateDesktopLiveStatus({
        ...initial,
        recoveryAttempted: result?.attempted === true,
        recoveryOk: false,
        recoveryError: hard ? '本次未完成 Codex 重启，请等待当前恢复结束后重试。' : '本次恢复未执行，请稍后重试。'
      });
    }
  } catch (error) {
    return decorateDesktopLiveStatus({
      ...initial,
      recoveryAttempted: true,
      recoveryOk: false,
      recoveryError: error?.message ?? String(error),
      reason: `${initial.reason ?? initial.message ?? '桌面实时通道未连接'}；手动恢复失败：${error?.message ?? String(error)}`
    });
  }
  const recovered = await decorateDesktopLiveStatusWithDiagnostics(
    await getDesktopLiveStatus(adapter, sessionId),
    diagnostics
  );
  return decorateDesktopLiveStatus({
    ...recovered,
    recoveryAttempted: true,
    recoveryOk: recovered.desktopLive === true
  });
}

async function collectSystemRepairStatus({ store, sessions, logger, diagnostics, sessionId = '', desktopOverride = null }) {
  const checkedAt = new Date().toISOString();
  const run = await logger.getCurrentRun().catch((error) => ({ error: error?.message ?? String(error) }));
  let desktop = desktopOverride;
  if (!desktop) {
    try {
      desktop = await decorateDesktopLiveStatusWithDiagnostics(
        await getDesktopLiveStatus(store.adapter, sessionId),
        diagnostics
      );
    } catch (error) {
      desktop = decorateDesktopLiveStatus({
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        currentSessionId: null,
        targetSessionId: sessionId,
        sessionVerified: false,
        message: '桌面实时通道检测失败',
        reason: error?.message ?? String(error),
        checkedAt
      });
    }
  }

  const script = desktopScriptBridge.snapshot({ authRequired: isBridgeAuthRequired() });
  const sessionProbe = await probeSessions(sessions);
  const action = chooseSystemRepairAction({ desktop, script, sessionProbe });
  return {
    ok: action.severity !== 'blocked',
    checkedAt,
    bridge: {
      ok: true,
      run
    },
    desktop,
    script,
    sessions: sessionProbe,
    recommendedAction: action.action,
    severity: action.severity,
    message: action.message,
    recoverableFromPhone: action.recoverableFromPhone
  };
}

async function collectSystemLinkStatus({ config, store, sessions, logger, diagnostics, sessionId = '', desktopOverride = null }) {
  const executionMode = systemLinkExecutionMode(config, sessionId);
  const health = await collectLinkHealth({
    repoRoot: config.repoRoot ?? process.cwd(),
    sessionId,
    logger,
    executionMode,
    desktopRequired: executionMode !== 'app_server',
    desktopStatusProvider: async () => {
      if (desktopOverride) {
        return desktopOverride;
      }
      return await decorateDesktopLiveStatusWithDiagnostics(
        await getDesktopLiveStatus(store.adapter, sessionId),
        diagnostics
      );
    },
    sessionProbeProvider: async () => await probeSessions(sessions),
    relayProbeProvider: config.linkRelayProbeProvider,
    hdcProbeProvider: config.linkHdcProbeProvider
  });
  return decorateLinkHealthWithScriptAuth(health, desktopScriptBridge.snapshot({ authRequired: isBridgeAuthRequired() }));
}

async function recoverSystemLink({ config, store, sessions, logger, diagnostics, recovery, sessionId = '', mode = 'auto' }) {
  const initial = await collectSystemLinkStatus({
    config,
    store,
    sessions,
    logger,
    diagnostics,
    sessionId
  });
  if (initial.severity === 'ok' || initial.recommendedAction === 'none') {
    return {
      ...initial,
      repaired: false,
      repairMode: 'none',
      recoveryMessage: '链路已经在线，无需恢复'
    };
  }

  const requestedMode = String(mode ?? 'auto').toLowerCase();
  const action = initial.recommendedAction;
  if (action === 'desktop_cdp_restart_required') {
    return {
      ...initial,
      repaired: false,
      repairMode: 'blocked',
      recoveryMessage: '恢复 CDP 需要重启 Codex。手机端恢复链路不会自动重启 Codex，请使用桌面一键启动或明确硬恢复。'
    };
  }

  let recoveryResult = null;
  let desktopOverride = null;
  if (action === 'soft_recover_live_host' || requestedMode === 'soft') {
    desktopOverride = await recoverDesktopLiveManually({
      adapter: store.adapter,
      sessionId,
      logger,
      recovery,
      diagnostics,
      reason: 'mobile_link_recover',
      mode: 'soft'
    });
    recoveryResult = {
      ok: desktopOverride.recoveryOk === true || desktopOverride.desktopLive === true,
      action: 'soft_recover_live_host',
      message: desktopOverride.recoveryError ?? desktopOverride.recoveryHint ?? desktopOverride.message ?? ''
    };
  } else if (action === 'restart_bridge_proxy' || action === 'restart_hdc_proxy' || action === 'reconnect_hdc') {
    recoveryResult = await recoverHdcLink({
      repoRoot: config.repoRoot ?? process.cwd()
    });
  } else if (action === 'refresh_sessions' || action === 'sync_session') {
    recoveryResult = {
      ok: true,
      action,
      message: '已重新检测会话和桌面状态'
    };
  } else {
    recoveryResult = {
      ok: false,
      action,
      message: `暂不支持的恢复动作：${action}`
    };
  }

  const after = await collectSystemLinkStatus({
    config,
    store,
    sessions,
    logger,
    diagnostics,
    sessionId,
    desktopOverride
  });
  return {
    ...after,
    repaired: recoveryResult?.ok === true && after.severity !== 'blocked',
    repairMode: recoveryResult?.action ?? action,
    recoveryResult,
    recoveryMessage: recoveryResult?.message ?? after.message
  };
}

async function probeSessions(sessions) {
  if (!sessions || typeof sessions.listSessions !== 'function') {
    return {
      ok: false,
      count: 0,
      message: '会话索引不可用'
    };
  }
  try {
    const items = await sessions.listSessions({ limit: 3 });
    return {
      ok: true,
      count: Array.isArray(items) ? items.length : 0,
      message: '会话索引可读'
    };
  } catch (error) {
    return {
      ok: false,
      count: 0,
      message: error?.message ?? String(error)
    };
  }
}

function chooseDesktopRepairMode(desktop) {
  if (desktop?.requiresDesktopCdp === true
    || desktop?.failureClass === 'codex_plain_no_cdp'
    || desktop?.failureClass === 'codex_not_running'
    || desktop?.desktopProcessMode === 'plain'
    || desktop?.desktopProcessMode === 'missing') {
    return 'hard';
  }
  return 'soft';
}

function chooseSystemRepairAction({ desktop, script, sessionProbe }) {
  if (!sessionProbe?.ok) {
    return {
      action: 'refresh_sessions',
      severity: 'degraded',
      recoverableFromPhone: true,
      message: `会话索引异常：${sessionProbe?.message ?? 'unknown'}`
    };
  }
  if (desktop?.desktopLive === true) {
    if (script?.scriptAuth?.healthy === false) {
      return {
        action: 'reconnect_desktop_script',
        severity: 'degraded',
        recoverableFromPhone: true,
        message: '桌面 CDP 可用，但脚本桥认证异常；将只重启 live-host，不重启 Codex。'
      };
    }
    if (desktop?.targetSessionId
      && desktop?.sessionVerified !== true
      && desktop?.targetVerified !== true) {
      return {
        action: 'sync_session',
        severity: 'degraded',
        recoverableFromPhone: true,
        message: '桌面链路在线，但桌面 App Server 尚未确认目标会话'
      };
    }
    return {
      action: 'none',
      severity: 'ok',
      recoverableFromPhone: true,
      message: '桌面链路在线'
    };
  }
  if (chooseDesktopRepairMode(desktop) === 'hard') {
    return {
      action: 'desktop_cdp_restart_required',
      severity: 'blocked',
      recoverableFromPhone: false,
      message: desktop?.recoveryHint ?? '恢复 CDP 需要重启 Codex，手机端不会自动执行。请用桌面一键启动或明确确认硬恢复。'
    };
  }
  if (desktop?.mobileRecoverable !== false) {
    return {
      action: 'soft_recover_live_host',
      severity: 'degraded',
      recoverableFromPhone: true,
      message: desktop?.recoveryHint ?? '可以手机端软恢复桌面 live-host'
    };
  }
  if (script?.online === true) {
    return {
      action: 'reconnect_desktop_script',
      severity: 'degraded',
      recoverableFromPhone: true,
      message: '脚本桥在线但 CDP 状态异常，可尝试重连桌面 live'
    };
  }
  return {
    action: 'desktop_required',
    severity: 'blocked',
    recoverableFromPhone: false,
    message: desktop?.recoveryHint ?? desktop?.reason ?? '手机端无法触达可恢复的桌面链路'
  };
}

function isHardDesktopRecoveryConfirmed(body = {}) {
  return body.confirmHardRestart === true || body.allowHardRestart === true;
}

async function decorateDesktopLiveStatusWithDiagnostics(status, diagnostics) {
  if (!diagnostics || typeof diagnostics.inspect !== 'function') {
    return decorateDesktopLiveStatus(status);
  }
  try {
    return decorateDesktopLiveStatus(status, await diagnostics.inspect(status));
  } catch (error) {
    return decorateDesktopLiveStatus(status, {
      available: false,
      error: error?.message ?? String(error)
    });
  }
}

function decorateDesktopLiveStatus(status, diagnostics = null) {
  const text = [
    status?.status,
    status?.message,
    status?.reason,
    status?.recoveryError
  ].map((value) => String(value ?? '')).join(' ');
  const failureClass = status?.desktopLive === true
    ? 'none'
    : status?.failureClass ?? diagnostics?.failureClass ?? 'desktop_live_unavailable';
  const requiresDesktopCdp = status?.desktopLive !== true
    && (
      status?.requiresDesktopCdp === true
      || diagnostics?.requiresDesktopCdp === true
      || /未找到现有 Codex CDP 端口|CDP 端口未在线|connect ECONNREFUSED 127\.0\.0\.1:9229|remote-debugging-port|带 CDP|no cdp/i.test(text)
    );
  const mobileRecoverable = status?.desktopLive === true
    || (
      status?.mobileRecoverable !== false
      && diagnostics?.mobileRecoverable !== false
      && !requiresDesktopCdp
      && failureClass !== 'codex_plain_no_cdp'
      && failureClass !== 'codex_not_running'
    );
  return {
    ...status,
    failureClass,
    desktopProcessMode: status?.desktopProcessMode ?? diagnostics?.desktopProcessMode ?? 'unknown',
    codexProcessId: status?.codexProcessId ?? diagnostics?.codexProcessId ?? null,
    codexProcessCount: status?.codexProcessCount ?? diagnostics?.codexProcessCount ?? null,
    codexStartedAt: status?.codexStartedAt ?? diagnostics?.codexStartedAt ?? null,
    liveHostRunning: status?.liveHostRunning ?? diagnostics?.liveHostRunning ?? null,
    liveHostProcessId: status?.liveHostProcessId ?? diagnostics?.liveHostProcessId ?? null,
    cdpPort: status?.cdpPort ?? diagnostics?.cdpPort ?? null,
    candidateCdpPorts: status?.candidateCdpPorts ?? diagnostics?.candidateCdpPorts ?? [],
    lastInjectedCdpPort: status?.lastInjectedCdpPort ?? diagnostics?.lastInjectedCdpPort ?? null,
    diagnosticsError: status?.diagnosticsError ?? diagnostics?.error ?? '',
    mobileRecoverable,
    requiresDesktopCdp,
    recoveryHint: status?.desktopLive === true
      ? '桌面实时通道已恢复。'
      : requiresDesktopCdp
        ? failureClass === 'codex_not_running'
          ? '当前没有检测到 Codex 桌面进程，发送前不会自动启动 Codex；请用桌面一键启动，或明确确认后再执行硬恢复。'
          : '当前 Codex 是普通启动态，没有可用 CDP，手机端软恢复无法接入；请用桌面一键启动，或明确确认后再执行硬恢复。'
        : '手机端可以先尝试修复桌面 live-host，然后再重试发送。'
  };
}

async function dispatchOutboxItem({
  item,
  config,
  store,
  logger,
  sessions,
  sessionSettings,
  defaultReasoningEffortProvider,
  codexSettingsProvider,
  threadService,
  desktopLiveRecovery,
  desktopLiveDiagnostics,
  desktopOpener
}) {
  const body = {
    ...(item.payload ?? {}),
    projectId: item.projectId,
    submissionId: item.submissionId,
    text: item.text,
    prompt: item.text
  };
  const dispatched = item.kind === 'new_thread'
    ? await dispatchNewThreadMessage({
        body,
        config,
        store,
        logger,
        sessionSettings,
        defaultReasoningEffortProvider,
        codexSettingsProvider,
        threadService,
        desktopLiveRecovery,
        desktopLiveDiagnostics
      })
    : await dispatchExistingThreadMessage({
        threadId: item.threadId,
        body,
        config,
        store,
        logger,
        sessions,
        sessionSettings,
        defaultReasoningEffortProvider,
        codexSettingsProvider,
        threadService,
        desktopLiveRecovery,
        desktopLiveDiagnostics,
        desktopOpener
      });
  return dispatched.payload;
}

async function canDispatchOutboxItem({ item, store, threadService }) {
  const activeStatuses = new Set(['queued', 'running', 'waiting_approval', 'recovering']);
  if (item.kind === 'existing_thread') {
    const activeDesktopTask = store.findRunningTaskForSession(item.threadId);
    if (activeDesktopTask) {
      return typeof store.canSteerSessionTask === 'function'
        && store.canSteerSessionTask(item.threadId);
    }
    let activeRun = typeof threadService?.listRuns === 'function'
      ? threadService.listRuns().find((run) => (
          (run.threadId === item.threadId || run.codexSessionId === item.threadId)
          && activeStatuses.has(String(run.status ?? '').toLowerCase())
        ))
      : null;
    if (activeRun) {
      if (
        String(activeRun.status ?? '').toLowerCase() === 'recovering'
        && typeof threadService?.reconcilePersistedRun === 'function'
      ) {
        try {
          activeRun = await threadService.reconcilePersistedRun(activeRun);
        } catch {
          // Dispatch remains the authoritative target check. A recovery probe
          // must not leave the lane permanently queued when its owner vanished.
          return true;
        }
        if (!activeStatuses.has(String(activeRun?.status ?? '').toLowerCase())) {
          return true;
        }
      }
      if (activeRun.interruptRequested === true) {
        return {
          allowed: false,
          reason: 'interrupt_pending',
          runId: String(activeRun.id ?? ''),
          turnId: String(activeRun.turnId ?? activeRun.activeCodexTurnId ?? '')
        };
      }
      return typeof threadService?.canSteerThread === 'function'
        && threadService.canSteerThread(item.threadId);
    }
    if (typeof threadService?.getThread === 'function') {
      try {
        const thread = await threadService.getThread(item.threadId, { tail: 1 });
        const status = String(thread?.activityStatus ?? thread?.runtimeState ?? '').toLowerCase();
        if (activeStatuses.has(status)) {
          return false;
        }
      } catch {
        // Dispatch performs the authoritative target verification and records
        // a retryable failure when the session or transport is unavailable.
      }
    }
    return true;
  }
  const activeProjectTask = store.listTasks().some((task) => (
    task.projectId === item.projectId
    && activeStatuses.has(String(task.status ?? '').toLowerCase())
  ));
  if (activeProjectTask) {
    return false;
  }
  return !(typeof threadService?.listRuns === 'function' && threadService.listRuns().some((run) => (
    run.projectId === item.projectId
    && activeStatuses.has(String(run.status ?? '').toLowerCase())
  )));
}

function canRequeueSubmittedOutboxItem({ item, store, threadService }) {
  const resultId = String(item?.resultId ?? '').trim();
  if (!resultId) {
    return false;
  }
  const task = store.getTask(resultId);
  if (task) {
    return task.status === 'failed'
      && !task.events.some((event) => event.type === 'codex.app_server.turn.started');
  }
  if (typeof threadService?.getRun !== 'function') {
    return false;
  }
  try {
    const run = threadService.getRun(resultId);
    return run?.status === 'failed' && !String(run.turnId ?? run.activeCodexTurnId ?? '').trim();
  } catch {
    // After a Bridge restart the historical result may not exist in the new
    // in-memory runtime. Without authoritative failure evidence, keep the
    // submitted receipt deduplicated.
    return false;
  }
}

async function dispatchNewThreadMessage({
  body,
  config,
  store,
  logger,
  sessionSettings,
  defaultReasoningEffortProvider,
  codexSettingsProvider,
  threadService,
  desktopLiveRecovery,
  desktopLiveDiagnostics
}) {
  const defaults = await getDefaultCodexSettings({ codexSettingsProvider, defaultReasoningEffortProvider });
  const requestedModel = normalizeModelId(body.model ?? '');
  const requestedReasoningEffort = normalizeReasoningEffort(body.reasoningEffort ?? '');
  const effectiveModel = requestedModel || defaults.model;
  const effectiveReasoningEffort = requestedReasoningEffort || defaults.reasoningEffort;
  const prompt = String(body.prompt ?? body.text ?? '');
  const projectId = resolveProjectId(config, String(body.projectId ?? ''));
  const submissionId = String(body.submissionId ?? '');
  if (systemLinkExecutionMode(config) === 'app_server') {
    const result = await threadService.startThread({
      projectId,
      prompt,
      model: effectiveModel,
      reasoningEffort: effectiveReasoningEffort,
      submissionId
    });
    const createdThreadId = result.thread?.id ?? result.run?.createdCodexSessionId ?? result.run?.createdThreadId ?? '';
    if (createdThreadId && (body.reasoningEffort !== undefined || body.model !== undefined)) {
      await sessionSettings.updateSessionSettings(createdThreadId, {
        model: body.model,
        reasoningEffort: body.reasoningEffort
      });
    }
    return {
      statusCode: result.run ? 202 : 201,
      payload: result
    };
  }

  const desktop = await getPhoneSendDesktopStatus({
    config,
    adapter: store.adapter,
    logger,
    recovery: desktopLiveRecovery,
    diagnostics: desktopLiveDiagnostics,
    source: 'api.codex.thread.start.preflight'
  });
  assertDesktopReadyForNewThread(desktop);
  const task = store.createTask({
    projectId,
    prompt,
    verifiedDesktopStatus: desktop,
    submissionSource: 'phone_new_thread',
    submissionId,
    model: effectiveModel,
    reasoningEffort: effectiveReasoningEffort
  });
  await logger.write('bridge', 'info', 'codex.thread.start.desktop_task.queued', {
    taskId: task.id,
    projectId,
    promptLength: prompt.length,
    model: effectiveModel || 'auto',
    reasoningEffort: effectiveReasoningEffort || 'auto',
    runtimeMode: appServerRuntimeMode(config),
    desktopStatus: desktop.status ?? '',
    desktopTransport: desktop.transport ?? '',
    submissionId: submissionId || ''
  });
  return { statusCode: 202, payload: { run: task } };
}

async function dispatchExistingThreadMessage({
  threadId,
  body,
  config,
  store,
  logger,
  sessions,
  sessionSettings,
  defaultReasoningEffortProvider,
  codexSettingsProvider,
  threadService,
  desktopLiveRecovery,
  desktopLiveDiagnostics,
  desktopOpener
}) {
  const projectId = resolveProjectId(config, String(body.projectId ?? ''));
  const prompt = String(body.text ?? body.prompt ?? '');
  const storedSettings = await sessionSettings.getSessionSettings(threadId);
  const defaults = await getThreadCodexDefaults({
    codexSettingsProvider,
    defaultReasoningEffortProvider,
    sessions,
    threadId
  });
  const requestedModel = normalizeModelId(body.model ?? storedSettings.model ?? '');
  const requestedReasoningEffort = normalizeReasoningEffort(body.reasoningEffort ?? storedSettings.reasoningEffort ?? '');
  const model = requestedModel || defaults.model;
  const reasoningEffort = requestedReasoningEffort || defaults.reasoningEffort;
  const submissionId = String(body.submissionId ?? '');
  await logger.write('bridge', 'info', 'codex.thread.message.received', {
    threadId,
    submissionId,
    projectId,
    promptLength: prompt.length,
    runtimeMode: appServerRuntimeMode(config)
  });
  assertValidCodexSessionId(threadId);
  const sessionFingerprint = requireSessionFingerprint(body.sessionFingerprint);
  const verified = await sessions.verifySessionTarget(threadId, sessionFingerprint);
  await logger.write('bridge', 'info', 'session.target.verified', {
    source: 'api.codex.thread.message',
    sessionId: threadId,
    title: verified.title,
    projectLabel: verified.projectLabel,
    filePath: verified.filePath,
    requestedTitle: sessionFingerprint.title ?? '',
    requestedProjectLabel: sessionFingerprint.projectLabel ?? '',
    submissionId,
    runtimeMode: appServerRuntimeMode(config)
  });
  if (shouldUseAppServerForExistingThread(config, threadId)) {
    if (typeof threadService?.canSteerThread === 'function' && threadService.canSteerThread(threadId)) {
      try {
        const run = await threadService.steerMessage({
          threadId,
          text: prompt,
          submissionId
        });
        await logger.write('bridge', 'info', 'codex.thread.message.app_server.steered', {
          runId: run.id,
          threadId,
          projectId,
          promptLength: prompt.length,
          submissionId,
          runtimeMode: appServerRuntimeMode(config),
          sessionFingerprintVerified: true
        });
        return { statusCode: 202, payload: { run } };
      } catch (error) {
        if (!isSafeSteerFallbackError(error)) {
          throw error;
        }
        await logger.write('bridge', 'info', 'codex.thread.message.app_server.steer_raced_terminal', {
          threadId,
          message: error?.message ?? String(error)
        });
      }
    }
    const run = await threadService.sendMessage({
      threadId,
      text: prompt,
      projectId,
      model,
      reasoningEffort,
      submissionId
    });
    await logger.write('bridge', 'info', 'codex.thread.message.app_server.queued', {
      runId: run.id,
      threadId,
      projectId,
      promptLength: prompt.length,
      submissionId,
      model: model || 'auto',
      reasoningEffort: reasoningEffort || 'auto',
      runtimeMode: appServerRuntimeMode(config),
      sessionFingerprintVerified: true
    });
    return { statusCode: 202, payload: { run } };
  }
  if (typeof store.canSteerSessionTask === 'function' && store.canSteerSessionTask(threadId)) {
    try {
      const task = await store.steerSessionTask(threadId, {
        prompt,
        submissionId
      });
      await logger.write('bridge', 'info', 'codex.thread.message.desktop_task.steered', {
        taskId: task.id,
        threadId,
        projectId,
        promptLength: prompt.length,
        turnId: task.activeCodexTurnId ?? '',
        sessionFingerprintVerified: true
      });
      return { statusCode: 202, payload: { run: task } };
    } catch (error) {
      if (!isSafeSteerFallbackError(error)) {
        throw error;
      }
      await logger.write('bridge', 'info', 'codex.thread.message.desktop_task.steer_raced_terminal', {
        threadId,
        message: error?.message ?? String(error)
      });
    }
  }
  const desktopOpen = await maybeOpenDesktopThreadForPhoneSend({
    desktopOpener,
    threadId,
    logger
  });
  const desktop = await getPhoneSendDesktopStatus({
    config,
    adapter: store.adapter,
    sessionId: threadId,
    logger,
    recovery: desktopLiveRecovery,
    diagnostics: desktopLiveDiagnostics,
    source: 'api.codex.thread.message.preflight'
  });
  const verifiedDesktopStatus = {
    ...desktop,
    desktopOpen,
    preflight: buildDesktopSendPreflight(desktop, threadId)
  };
  if (shouldUseDesktopPrimaryFallback(config) && !verifiedDesktopStatus.preflight.ok) {
    const run = await threadService.sendMessage({
      threadId,
      text: prompt,
      projectId,
      model,
      reasoningEffort,
      submissionId,
      deliveryMode: 'desktop_fallback'
    });
    await logger.write('bridge', 'warn', 'codex.thread.message.desktop_primary_fallback.queued', {
      runId: run.id,
      threadId,
      projectId,
      promptLength: prompt.length,
      model: model || 'auto',
      reasoningEffort: reasoningEffort || 'auto',
      runtimeMode: appServerRuntimeMode(config),
      desktopStatus: verifiedDesktopStatus.status ?? '',
      desktopLive: verifiedDesktopStatus.desktopLive === true,
      desktopSessionVerified: verifiedDesktopStatus.sessionVerified === true,
      recommendedAction: verifiedDesktopStatus.preflight.recommendedAction,
      sessionFingerprintVerified: true
    });
    return { statusCode: 202, payload: { run } };
  }
  assertDesktopThreadReady(verifiedDesktopStatus, threadId);
  const task = store.createTask({
    projectId,
    prompt,
    codexSessionId: threadId,
    sessionFingerprint,
    verifiedSessionTarget: verified,
    verifiedDesktopStatus,
    submissionSource: 'phone_thread_message',
    submissionId,
    model,
    reasoningEffort
  });
  await logger.write('bridge', 'info', 'codex.thread.message.desktop_task.queued', {
    taskId: task.id,
    threadId,
    projectId,
    promptLength: prompt.length,
    submissionId,
    model: model || 'auto',
    reasoningEffort: reasoningEffort || 'auto',
    desktopVerification: 'verified_before_task',
    desktopStatus: verifiedDesktopStatus.status,
    desktopCurrentSessionId: verifiedDesktopStatus.currentSessionId ?? '',
    desktopSessionVerified: verifiedDesktopStatus.sessionVerified === true,
    desktopTargetVerified: verifiedDesktopStatus.targetVerified === true
  });
  return { statusCode: 202, payload: { run: task } };
}

function isSafeSteerFallbackError(error) {
  return error?.safeToFallback === true
    || error?.code === 'CODEX_STEER_NO_ACTIVE_TURN';
}

function sendOutboxResponse(response, item, url) {
  if (!item) {
    const error = new Error('Unknown outbox item');
    error.statusCode = 404;
    throw error;
  }
  const outbox = serializeOutboxItem(item);
  if (item.status === 'submitted' && item.result) {
    sendJson(response, 202, {
      ...serializeDispatchPayload(item.result, url),
      outbox
    });
    return;
  }
  sendJson(response, 202, {
    run: serializeOutboxRun(item),
    outbox
  });
}

function serializeDispatchPayload(payload, url) {
  if (!payload || typeof payload !== 'object') {
    return {};
  }
  return {
    ...payload,
    ...(payload.run ? { run: serializeTask(payload.run, serializationOptions(url)) } : {})
  };
}

function serializeOutboxItem(item) {
  return {
    id: item.id,
    kind: item.kind,
    threadId: item.threadId,
    projectId: item.projectId,
    submissionId: item.submissionId,
    text: item.text,
    status: item.status,
    order: item.order,
    attemptCount: item.attemptCount,
    retryable: item.retryable,
    error: item.error,
    nextAttemptAt: item.nextAttemptAt,
    lastAttemptAt: item.lastAttemptAt,
    submittedAt: item.submittedAt,
    resultId: item.resultId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function serializeOutboxRun(item) {
  const queued = item.status === 'queued'
    || item.status === 'dispatching'
    || (item.status === 'failed' && item.retryable);
  const status = item.status === 'canceled'
    ? 'interrupted'
    : queued
      ? 'queued'
      : item.status === 'uncertain'
        ? 'recovering'
        : 'failed';
  return {
    id: item.id,
    projectId: item.projectId,
    prompt: '',
    promptPreview: item.text.slice(0, 160),
    promptLength: item.text.length,
    codexSessionId: item.threadId || null,
    submissionId: item.submissionId,
    status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    activeCodexTurnId: null,
    interruptReady: status === 'queued',
    runtime: {
      kind: 'durable_outbox',
      state: item.status,
      canInterrupt: status === 'queued'
    },
    error: item.error || null,
    events: [{
      id: `${item.id}-status`,
      taskId: item.id,
      type: `outbox.${item.status}`,
      payload: {
        outboxId: item.id,
        attemptCount: item.attemptCount,
        retryable: item.retryable,
        nextAttemptAt: item.nextAttemptAt
      },
      createdAt: item.updatedAt
    }]
  };
}

function requireOutbox(outbox) {
  if (!outbox) {
    const error = new Error('Durable outbox is disabled');
    error.statusCode = 404;
    throw error;
  }
}

async function readJsonObjectBody(request, maxBytes) {
  const body = await readJsonBody(request, maxBytes);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const error = new Error('Request body must be a JSON object');
    error.statusCode = 400;
    throw error;
  }
  return body;
}

async function writeAppLog(logger, body) {
  return logger.write(
    body.source ?? 'app',
    body.level ?? 'info',
    body.event ?? 'app.event',
    body.data ?? {}
  );
}

function resolveProjectId(config, requestedProjectId) {
  const requested = String(requestedProjectId ?? '').trim();
  const projects = Array.isArray(config.projects) ? config.projects : [];
  if (requested && projects.some((project) => project.id === requested)) {
    return requested;
  }
  return projects[0]?.id ?? requested;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function requireAuth({ request, url }) {
  const token = process.env.CODEX_BRIDGE_TOKEN ?? '';
  if (token.trim().length === 0) {
    return;
  }

  const authorization = request.headers.authorization ?? '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
  const queryToken = url.searchParams.get('token') ?? '';
  const headerToken = request.headers['x-codex-bridge-token'] ?? '';
  const provided = Array.isArray(headerToken) ? headerToken[0] : headerToken;

  if (bearer === token || queryToken === token || provided === token) {
    return;
  }

  if (url.pathname.startsWith('/desktop/script/')) {
    desktopScriptBridge.recordUnauthorized(url.pathname);
  }
  const error = new Error('Unauthorized');
  error.statusCode = 401;
  throw error;
}

function isBridgeAuthRequired() {
  return String(process.env.CODEX_BRIDGE_TOKEN ?? '').trim().length > 0;
}

function decorateLinkHealthWithScriptAuth(health, script) {
  const scriptAuth = script?.scriptAuth ?? null;
  const desktop = scriptAuth
    ? { ...(health.desktop ?? {}), scriptAuth }
    : health.desktop;
  const next = {
    ...health,
    desktop,
    script
  };
  if (scriptAuth?.healthy === false && health.desktop?.desktopLive === true) {
    return {
      ...next,
      ok: true,
      severity: health.severity === 'blocked' ? 'blocked' : 'degraded',
      recommendedAction: 'reconnect_desktop_script',
      recoverableFromPhone: true,
      message: '桌面 CDP 可用，但脚本桥认证异常；发送仍优先走 CDP，脚本 fallback 需要软恢复。'
    };
  }
  return next;
}

function sanitizeRequestUrl(value) {
  const rawUrl = value ?? '';
  try {
    const url = new URL(rawUrl, 'http://127.0.0.1');
    for (const key of [...url.searchParams.keys()]) {
      if (/authorization|token|password|secret|apikey|api_key|cookie/i.test(key)) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return String(rawUrl).replace(/([?&](?:authorization|token|password|secret|apikey|api_key|cookie)=)[^&]*/gi, '$1[REDACTED]');
  }
}

function getPublicBridgeUrl(request, url) {
  const configured = process.env.CODEX_BRIDGE_PUBLIC_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }
  const requested = url.searchParams.get('bridgeUrl')?.trim();
  if (requested) {
    return requested.replace(/\/+$/, '');
  }
  const forwardedProto = firstHeader(request.headers['x-forwarded-proto']) ?? 'http';
  const forwardedHost = firstHeader(request.headers['x-forwarded-host']);
  const host = forwardedHost ?? firstHeader(request.headers.host) ?? '127.0.0.1';
  return `${forwardedProto}://${host}`.replace(/\/+$/, '');
}

function getDesktopScriptBridgeUrl(request, url) {
  const requested = url.searchParams.get('bridgeUrl')?.trim();
  if (requested) {
    return requested.replace(/\/+$/, '');
  }
  const configured = process.env.CODEX_DESKTOP_SCRIPT_BRIDGE_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }
  const forwardedProto = firstHeader(request.headers['x-forwarded-proto']) ?? 'http';
  const forwardedHost = firstHeader(request.headers['x-forwarded-host']);
  const host = forwardedHost ?? firstHeader(request.headers.host) ?? '127.0.0.1';
  return `${forwardedProto}://${host}`.replace(/\/+$/, '');
}

function firstHeader(value) {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function streamEvents({ response, store, eventBus, taskId }) {
  const task = store.getTask(taskId);
  if (!task) {
    sendJson(response, 404, { error: 'Unknown task' });
    return;
  }

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });

  for (const event of task.events) {
    writeSse(response, event);
  }

  const unsubscribe = eventBus.subscribe(taskId, (event) => {
    writeSse(response, event);
  });

  response.on('close', unsubscribe);
}

function streamRunEvents({ response, eventBus, threadService, runId }) {
  const run = threadService.getRun(runId);

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });

  for (const event of run.events) {
    writeSse(response, event);
  }

  const unsubscribe = eventBus.subscribe(runId, (event) => {
    writeSse(response, event);
  });

  response.on('close', unsubscribe);
}

function writeSse(response, event) {
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function serializationOptions(url) {
  const full = process.env.CODEX_BRIDGE_FULL_TASK_RESPONSES === '1'
    || url.searchParams.get('full') === '1'
    || url.searchParams.get('full') === 'true';
  return {
    full,
    cursorRequested: url.searchParams.has('afterSeq'),
    afterSeq: parseNonNegativeInteger(
      url.searchParams.get('afterSeq'),
      parseNonNegativeInteger(url.searchParams.get('sinceEvent'), 0)
    ),
    sinceEvent: parseNonNegativeInteger(url.searchParams.get('sinceEvent'), 0),
    eventLimit: parseNonNegativeInteger(url.searchParams.get('eventLimit'), 8)
  };
}

async function maybeWaitForInterruptConfirmation(store, task, url) {
  if (!task || url.searchParams.get('confirm') !== '1') {
    return task;
  }
  const timeoutMs = parseNonNegativeInteger(url.searchParams.get('confirmTimeoutMs'), 8000);
  return await store.waitForInterruptDispatch(task.id, timeoutMs) ?? task;
}

function serializeTask(task, options = {}) {
  const normalized = normalizeTaskLike(task);
  if (options.full === true) {
    return {
      id: normalized.id,
      projectId: normalized.projectId,
      prompt: normalized.prompt,
      codexSessionId: normalized.codexSessionId,
      sessionFingerprint: normalized.sessionFingerprint,
      verifiedSessionTarget: normalized.verifiedSessionTarget,
      createdCodexSessionId: normalized.createdCodexSessionId,
      model: normalized.model,
      reasoningEffort: normalized.reasoningEffort,
      status: normalized.status,
      createdAt: normalized.createdAt,
      updatedAt: normalized.updatedAt,
      activeCodexTurnId: normalized.activeCodexTurnId,
      interruptReady: normalized.interruptReady,
      interruptRequested: normalized.interruptRequested,
      interruptDispatching: normalized.interruptDispatching,
      interruptRecovering: normalized.interruptRecovering,
      interruptAttemptCount: normalized.interruptAttemptCount,
      interruptReconcileUntil: normalized.interruptReconcileUntil,
      lastInterruptFailure: normalized.lastInterruptFailure,
      interruptState: normalized.interruptState,
      interruptError: normalized.interruptError,
      syntheticInterrupt: normalized.syntheticInterrupt,
      result: normalized.result,
      error: normalized.error,
      desktopSync: normalized.desktopSync,
      runtime: normalized.runtime,
      submissionId: normalized.submissionId,
      session: normalized.session,
      eventCount: normalized.events.length,
      eventCursor: normalized.events.length,
      eventGap: false,
      hasMoreEvents: false,
      events: normalized.events.map((event, index) => serializeEvent({ ...event, seq: event.seq ?? index + 1 }))
    };
  }

  const eventWindow = serializeEventWindow(normalized.events, options);
  return {
    id: normalized.id,
    projectId: normalized.projectId,
    prompt: compactText(normalized.prompt, 1200),
    promptPreview: compactText(normalized.prompt, 240),
    promptLength: normalized.prompt.length,
    codexSessionId: normalized.codexSessionId,
    sessionFingerprint: normalized.sessionFingerprint,
    verifiedSessionTarget: normalized.verifiedSessionTarget,
    createdCodexSessionId: normalized.createdCodexSessionId,
    model: normalized.model,
    reasoningEffort: normalized.reasoningEffort,
    status: normalized.status,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    activeCodexTurnId: normalized.activeCodexTurnId,
    interruptReady: normalized.interruptReady,
    interruptRequested: normalized.interruptRequested,
    interruptDispatching: normalized.interruptDispatching,
    interruptRecovering: normalized.interruptRecovering,
    interruptAttemptCount: normalized.interruptAttemptCount,
    interruptReconcileUntil: normalized.interruptReconcileUntil,
    lastInterruptFailure: normalized.lastInterruptFailure,
    interruptState: normalized.interruptState,
    interruptError: normalized.interruptError,
    syntheticInterrupt: normalized.syntheticInterrupt,
    resultSummary: serializeResultSummary(normalized.result),
    error: normalized.error,
    desktopSync: normalized.desktopSync,
    runtime: normalized.runtime,
    submissionId: normalized.submissionId,
    session: serializeSessionSummary(normalized.session),
    eventCount: normalized.events.length,
    latestEvent: serializeEvent(normalized.events.at(-1) ?? null),
    eventCursor: eventWindow.eventCursor,
    eventGap: eventWindow.eventGap,
    hasMoreEvents: eventWindow.hasMoreEvents,
    events: eventWindow.events
  };
}

function serializeTaskSummary(task) {
  const normalized = normalizeTaskLike(task);
  return {
    id: normalized.id,
    projectId: normalized.projectId,
    prompt: compactText(normalized.prompt, 240),
    promptPreview: compactText(normalized.prompt, 160),
    promptLength: normalized.prompt.length,
    codexSessionId: normalized.codexSessionId,
    sessionFingerprint: normalized.sessionFingerprint,
    verifiedSessionTarget: normalized.verifiedSessionTarget,
    createdCodexSessionId: normalized.createdCodexSessionId,
    model: normalized.model,
    reasoningEffort: normalized.reasoningEffort,
    status: normalized.status,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    activeCodexTurnId: normalized.activeCodexTurnId,
    interruptReady: normalized.interruptReady,
    interruptRequested: normalized.interruptRequested,
    interruptDispatching: normalized.interruptDispatching,
    interruptRecovering: normalized.interruptRecovering,
    interruptAttemptCount: normalized.interruptAttemptCount,
    interruptReconcileUntil: normalized.interruptReconcileUntil,
    lastInterruptFailure: normalized.lastInterruptFailure,
    interruptState: normalized.interruptState,
    interruptError: normalized.interruptError,
    syntheticInterrupt: normalized.syntheticInterrupt,
    resultSummary: serializeResultSummary(normalized.result),
    error: normalized.error,
    desktopSync: normalized.desktopSync,
    runtime: normalized.runtime,
    submissionId: normalized.submissionId,
    session: serializeSessionSummary(normalized.session),
    eventCount: normalized.events.length,
    latestEvent: serializeEvent(normalized.events.at(-1) ?? null)
  };
}

function normalizeTaskLike(task) {
  const result = task.result ?? null;
  const session = result?.session ?? task.session ?? null;
  const codexSessionId = task.codexSessionId ?? task.threadId ?? '';
  const createdCodexSessionId = task.createdCodexSessionId ?? task.createdThreadId ?? '';
  const activeCodexTurnId = String(task.activeCodexTurnId ?? '');
  const status = String(task.status ?? 'idle');
  const interruptRequested = task.interruptRequested === true;
  const interruptDispatching = task.interruptDispatching === true;
  const interruptRecovering = task.interruptRecovering === true;
  const interruptError = task.interruptError ?? null;
  const lastInterruptFailure = task.lastInterruptFailure ?? null;
  const syntheticInterrupt = task.syntheticInterrupt === true;
  return {
    id: String(task.id ?? ''),
    projectId: String(task.projectId ?? ''),
    prompt: String(task.prompt ?? ''),
    codexSessionId,
    sessionFingerprint: task.sessionFingerprint ?? null,
    verifiedSessionTarget: task.verifiedSessionTarget ?? null,
    createdCodexSessionId,
    model: normalizeModelId(task.model ?? ''),
    reasoningEffort: normalizeReasoningEffort(task.reasoningEffort ?? ''),
    status,
    createdAt: String(task.createdAt ?? ''),
    updatedAt: String(task.updatedAt ?? ''),
    activeCodexTurnId,
    interruptReady: task.interruptReady === true || activeCodexTurnId.length > 0,
    interruptRequested,
    interruptDispatching,
    interruptRecovering,
    interruptAttemptCount: Number(task.interruptAttemptCount ?? 0) || 0,
    interruptReconcileUntil: String(task.interruptReconcileUntil ?? ''),
    lastInterruptFailure,
    interruptState: deriveInterruptState({
      status,
      interruptRequested,
      interruptDispatching,
      interruptRecovering,
      interruptError,
      lastInterruptFailure,
      syntheticInterrupt,
      error: task.error ?? null
    }),
    interruptError,
    syntheticInterrupt,
    result,
    error: task.error ?? null,
    desktopSync: task.desktopSync ?? null,
    runtime: task.runtime ?? null,
    submissionId: String(task.submissionId ?? ''),
    session,
    events: Array.isArray(task.events) ? task.events : []
  };
}

function deriveInterruptState({ status, interruptRequested, interruptDispatching, interruptRecovering, interruptError, lastInterruptFailure, syntheticInterrupt, error }) {
  if (status === 'interrupted') {
    return 'confirmed';
  }
  if (interruptRecovering === true && ['queued', 'running', 'waiting_approval', 'recovering'].includes(status)) {
    return 'reconciling';
  }
  if (typeof interruptError === 'string' && interruptError.length > 0) {
    return 'failed';
  }
  if (syntheticInterrupt === true && status === 'failed' && String(error ?? '').indexOf('中断失败') >= 0) {
    return 'failed';
  }
  if (interruptDispatching === true && ['queued', 'running', 'waiting_approval', 'recovering'].includes(status)) {
    return 'dispatching';
  }
  if (interruptRequested === true && ['queued', 'running', 'waiting_approval', 'recovering'].includes(status)) {
    if (typeof lastInterruptFailure === 'string' && lastInterruptFailure.length > 0) {
      return 'recoverable_failed';
    }
    return 'requested';
  }
  return 'idle';
}

function serializeEventWindow(events, options = {}) {
  const page = paginateTaskEvents(events, {
    afterSeq: options.cursorRequested === true
      ? Math.max(0, options.afterSeq ?? 0)
      : Math.max(0, options.sinceEvent ?? 0),
    eventLimit: Math.max(0, options.eventLimit ?? 8),
    cursorRequested: options.cursorRequested === true
  });
  return {
    ...page,
    events: page.events.map((event) => serializeEvent(event)).filter(Boolean)
  };
}

function serializeEvent(event) {
  if (!event) {
    return null;
  }
  return {
    id: event.id,
    seq: Number(event.seq ?? 0) || undefined,
    taskId: event.taskId,
    type: event.type,
    payload: serializeEventPayload(event.payload ?? {}),
    createdAt: event.createdAt
  };
}

function serializeEventPayload(payload) {
  const body = JSON.stringify(payload ?? {});
  const bytes = Buffer.byteLength(body);
  if (bytes <= 4096) {
    return payload ?? {};
  }
  const summary = {};
  for (const [key, value] of Object.entries(payload ?? {}).slice(0, 24)) {
    summary[key] = summarizePayloadValue(value);
  }
  return {
    ...summary,
    truncated: true,
    originalBytes: bytes
  };
}

function summarizePayloadValue(value) {
  if (typeof value === 'string') {
    return compactText(value, 300);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return { type: 'array', length: value.length };
  }
  if (value && typeof value === 'object') {
    return { type: 'object', keys: Object.keys(value).slice(0, 20) };
  }
  return String(value ?? '');
}

function serializeResultSummary(result) {
  if (!result) {
    return null;
  }
  return {
    summary: compactText(result.summary ?? '', 800),
    changedFiles: Array.isArray(result.changedFiles) ? result.changedFiles.slice(0, 50) : [],
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
    desktopSync: result.desktopSync ?? null
  };
}

function serializeSessionSummary(session) {
  if (!session) {
    return null;
  }
  const entries = Array.isArray(session.entries) ? session.entries : [];
  return {
    id: session.id ?? '',
    title: session.title ?? '',
    updatedAt: session.updatedAt ?? '',
    relativeTime: session.relativeTime ?? '',
    projectRoot: session.projectRoot ?? '',
    projectLabel: session.projectLabel ?? '',
    source: session.source ?? '',
    activitySource: session.activitySource ?? '',
    activityStatus: session.activityStatus ?? '',
    activityUpdatedAt: session.activityUpdatedAt ?? '',
    runtimeState: session.runtimeState ?? session.activityStatus ?? '',
    runtimeSource: session.runtimeSource ?? session.activitySource ?? '',
    runtimeUpdatedAt: session.runtimeUpdatedAt ?? session.activityUpdatedAt ?? '',
    canInterrupt: session.canInterrupt === true,
    terminalReason: session.terminalReason ?? '',
    pinned: session.pinned === true,
    detailAvailable: session.detailAvailable !== false,
    filePath: session.filePath ?? '',
    entryCount: typeof session.entryCount === 'number' ? session.entryCount : entries.length,
    latestEntry: summarizeSessionEntry(entries.at(-1) ?? null)
  };
}

function summarizeSessionEntry(entry) {
  if (!entry) {
    return null;
  }
  return {
    timestamp: entry.timestamp ?? '',
    type: entry.type ?? '',
    role: entry.role ?? '',
    text: compactText(entry.text ?? '', 500)
  };
}

function compactText(value, limit) {
  const text = String(value ?? '');
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit))}... [truncated ${text.length - limit} chars]`;
}

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function appServerRuntimeMode(config = {}) {
  const value = String(
    config.appServerRuntimeMode
    ?? process.env.CODEX_BRIDGE_RUNTIME_MODE
    ?? 'desktop'
  ).trim().toLowerCase();
  return [
    'desktop',
    'desktop-primary',
    'app-server-shadow',
    'app-server-new-only',
    'app-server-canary',
    'app-server-primary'
  ].includes(value) ? value : 'desktop';
}

function shouldUseDesktopPrimaryFallback(config) {
  return appServerRuntimeMode(config) === 'desktop-primary';
}

function shouldUseAppServerForExistingThread(config, threadId) {
  const mode = appServerRuntimeMode(config);
  if (mode === 'app-server-primary') {
    return true;
  }
  if (mode !== 'app-server-canary') {
    return false;
  }
  const configured = config.appServerCanaryThreadIds
    ?? String(process.env.CODEX_BRIDGE_APP_SERVER_CANARY_THREADS ?? '').split(',');
  return Array.isArray(configured) && configured
    .map((item) => String(item ?? '').trim())
    .includes(String(threadId ?? '').trim());
}

function systemLinkExecutionMode(config, threadId = '') {
  const mode = appServerRuntimeMode(config);
  if (shouldUseAppServerForExistingThread(config, threadId)) {
    return 'app_server';
  }
  if (!String(threadId ?? '').trim() && mode === 'app-server-new-only') {
    return 'app_server';
  }
  return 'desktop';
}

function runtimeStatus(config, threadService, threadId = '', client = {}) {
  const mode = appServerRuntimeMode(config);
  const existingThreadExecution = shouldUseAppServerForExistingThread(config, threadId)
    ? 'app_server'
    : shouldUseDesktopPrimaryFallback(config)
      ? 'desktop_primary'
    : mode === 'app-server-canary'
      ? 'canary'
      : 'desktop';
  return {
    mode,
    existingThreadExecution,
    protocol: buildBridgeProtocolHandshake(client),
    appServer: typeof threadService?.runtimeHealth === 'function'
      ? threadService.runtimeHealth()
      : null
  };
}

function serializeApproval(approval) {
  return {
    id: approval.id,
    taskId: approval.taskId,
    status: approval.status,
    decision: approval.decision,
    command: approval.command,
    reason: approval.reason,
    risk: approval.risk,
    createdAt: approval.createdAt,
    decidedAt: approval.decidedAt
  };
}
