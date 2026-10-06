import { CodexDesktopCdpAdapter } from './codexDesktopCdpAdapter.js';
import { CodexDesktopScriptAdapter } from './codexDesktopScriptAdapter.js';

export class HybridCodexAdapter {
  get requiresDeliveryReceipt() { return true; }

  constructor(options = {}) {
    this.scriptDesktopAdapter = options.scriptDesktopAdapter
      ?? (options.desktopAdapter ? null : new CodexDesktopScriptAdapter(options));
    this.cdpDesktopAdapter = options.cdpDesktopAdapter
      ?? options.desktopAdapter
      ?? new CodexDesktopCdpAdapter(options);
    this.desktopAdapter = options.desktopAdapter ?? this.scriptDesktopAdapter ?? this.cdpDesktopAdapter;
    this.desktopProbeTimeoutMs = options.desktopProbeTimeoutMs
      ?? Number.parseInt(process.env.CODEX_DESKTOP_PROBE_TIMEOUT_MS ?? '8000', 10);
    this.lastDesktopUnavailableError = null;
  }

  async openDesktopThread(sessionId) {
    if (!this.cdpDesktopAdapter || typeof this.cdpDesktopAdapter.openDesktopThread !== 'function') {
      throw new Error('当前 Codex 桌面实时通道不支持会话切换');
    }
    return this.cdpDesktopAdapter.openDesktopThread(sessionId);
  }

  async archiveThread(sessionId) {
    if (!this.cdpDesktopAdapter || typeof this.cdpDesktopAdapter.archiveThread !== 'function') {
      throw new Error('当前 Codex 桌面实时通道不支持原生会话归档');
    }
    return this.cdpDesktopAdapter.archiveThread(sessionId);
  }

  listThreads(params) {
    return this.cdpDesktopAdapter.listThreads(params);
  }

  async listThreadRuntimeStates(options = {}) {
    if (!this.cdpDesktopAdapter || typeof this.cdpDesktopAdapter.listThreadRuntimeStates !== 'function') {
      return [];
    }
    return this.cdpDesktopAdapter.listThreadRuntimeStates(options);
  }

  async run(context) {
    const targetSessionId = context?.task?.codexSessionId ?? '';
    const desktopStatus = this.usableVerifiedDesktopStatus(context?.task?.verifiedDesktopStatus, targetSessionId)
      ?? await this.getDesktopLiveStatus(this.desktopProbeTimeoutMs, targetSessionId);
    this.selectDesktopAdapterForStatus(desktopStatus);
    this.emitDesktopProbeResult(context, desktopStatus);

    if (!isDesktopTargetReady(desktopStatus, targetSessionId)) {
      context.emit('codex.desktop_sync', {
        status: 'desktop_live_required',
        desktopLive: false,
        mode: targetSessionId ? 'resume' : 'new',
        targetSessionId,
        sessionVerified: false,
        message: 'Codex 桌面官方实时通道未校验，已阻止发送。请先让桌面官方通道在线；系统不会退回到独立 app-server 或 UI 粘贴。',
        reason: desktopStatus.reason ?? desktopStatus.message ?? ''
      });
      throw createDesktopVerificationError(desktopStatus);
    }

    const selectedAdapter = this.desktopAdapter;
    try {
      return await selectedAdapter.run(context);
    } catch (error) {
      if (await this.shouldRetryWithCdp(error, desktopStatus, targetSessionId, selectedAdapter)) {
        context.emit('codex.desktop_live.transport_retry', {
          from: desktopStatus.transport ?? 'script',
          to: 'cdp',
          targetSessionId,
          reason: error?.message ?? String(error)
        });
        this.desktopAdapter = this.cdpDesktopAdapter;
        return this.cdpDesktopAdapter.run(context);
      }
      throw error;
    }
  }

  usableVerifiedDesktopStatus(status, targetSessionId) {
    if (!status || typeof status !== 'object') {
      return null;
    }
    const normalizedTargetSessionId = normalizeSessionId(targetSessionId);
    const statusTargetSessionId = normalizeSessionId(status.targetSessionId ?? '');
    if (normalizedTargetSessionId !== statusTargetSessionId) {
      return null;
    }
    if (status.desktopLive !== true) {
      return null;
    }
    if (!isDesktopTargetReady(status, normalizedTargetSessionId)) {
      return null;
    }
    const sessionVerified = status.sessionVerified === true;
    const targetVerified = normalizedTargetSessionId
      ? status.targetVerified === true || sessionVerified
      : status.targetVerified === true;
    return {
      ...status,
      status: normalizedTargetSessionId
        ? (sessionVerified ? 'verified' : 'target_ready')
        : (status.status ?? 'ready'),
      targetSessionId: normalizedTargetSessionId,
      sessionVerified,
      targetVerified,
      transport: normalizeTransport(status.transport),
      message: status.message
        ?? (sessionVerified
          ? '已复用本次发送前的桌面会话校验结果。'
          : '桌面 App Server 已确认目标会话；桌面当前页面无需切换。')
    };
  }

  async steer(context) {
    const targetSessionId = normalizeSessionId(
      context?.task?.codexSessionId ?? context?.task?.createdCodexSessionId ?? ''
    );
    const desktopStatus = await this.getDesktopLiveStatus(this.desktopProbeTimeoutMs, targetSessionId);
    this.selectDesktopAdapterForStatus(desktopStatus);
    this.emitDesktopProbeResult(context, desktopStatus);
    if (!isDesktopTargetReady(desktopStatus, targetSessionId)) {
      throw createDesktopVerificationError(desktopStatus);
    }
    return this.desktopAdapter.steer(context);
  }

  async interrupt(context) {
    const targetSessionId = normalizeSessionId(
      context?.task?.codexSessionId ?? context?.task?.createdCodexSessionId ?? ''
    );
    const desktopStatus = await this.getDesktopLiveStatus(this.desktopProbeTimeoutMs, targetSessionId);
    this.selectDesktopAdapterForStatus(desktopStatus);
    this.emitDesktopProbeResult(context, desktopStatus);

    if (!isDesktopTargetReady(desktopStatus, targetSessionId)) {
      throw createDesktopVerificationError({
        ...desktopStatus,
        message: desktopStatus.message
          ?? desktopStatus.reason
          ?? '桌面实时通道未校验，已阻止中断当前会话。'
      });
    }

    const selectedAdapter = this.desktopAdapter ?? this.scriptDesktopAdapter ?? this.cdpDesktopAdapter;
    if (!selectedAdapter || typeof selectedAdapter.interrupt !== 'function') {
      throw new Error('当前桌面实时通道不支持中断');
    }
    try {
      return await selectedAdapter.interrupt(context);
    } catch (error) {
      if (await this.shouldRetryWithCdp(error, desktopStatus, targetSessionId, selectedAdapter)) {
        context.emit('codex.desktop_live.transport_retry', {
          from: desktopStatus.transport ?? 'script',
          to: 'cdp',
          targetSessionId,
          reason: error?.message ?? String(error)
        });
        this.desktopAdapter = this.cdpDesktopAdapter;
        return this.cdpDesktopAdapter.interrupt(context);
      }
      throw error;
    }
  }

  async getDesktopLiveStatus(timeoutMs = this.desktopProbeTimeoutMs, targetSessionId = '') {
    const normalizedTargetSessionId = normalizeSessionId(targetSessionId);
    const cdpStatus = await this.tryGetCdpDesktopStatus(timeoutMs, normalizedTargetSessionId);
    if (this.shouldUseCdpStatus(cdpStatus, normalizedTargetSessionId)) {
      this.desktopAdapter = this.cdpDesktopAdapter;
      this.lastDesktopUnavailableError = null;
      return cdpStatus;
    }
    const scriptStatus = await this.tryGetDesktopStatusFromAdapter(
      this.scriptDesktopAdapter,
      timeoutMs,
      normalizedTargetSessionId
    );
    if (this.shouldUseScriptStatus(scriptStatus, normalizedTargetSessionId)) {
      this.desktopAdapter = this.scriptDesktopAdapter;
      this.lastDesktopUnavailableError = null;
      return {
        ...scriptStatus,
        cdpUnavailableReason: cdpStatus?.reason ?? cdpStatus?.message ?? ''
      };
    }
    if (scriptStatus?.desktopLive === true) {
      this.desktopAdapter = this.scriptDesktopAdapter;
      this.lastDesktopUnavailableError = null;
      return {
        ...scriptStatus,
        cdpUnavailableReason: cdpStatus?.reason ?? cdpStatus?.message ?? ''
      };
    }
    if (cdpStatus) {
      if (cdpStatus.desktopLive) {
        this.desktopAdapter = this.cdpDesktopAdapter;
      }
      this.lastDesktopUnavailableError = cdpStatus.desktopLive ? null : new Error(cdpStatus.reason ?? cdpStatus.message ?? 'cdp unavailable');
      return cdpStatus;
    }
    if (scriptStatus) {
      this.lastDesktopUnavailableError = scriptStatus.desktopLive ? null : new Error(scriptStatus.reason ?? scriptStatus.message ?? 'script unavailable');
      return scriptStatus;
    }
    this.lastDesktopUnavailableError = new Error('desktop live unavailable');
    return {
      ok: true,
      desktopLive: false,
      status: 'unavailable',
      currentSessionId: null,
      targetSessionId: normalizedTargetSessionId,
      sessionVerified: false,
      transport: 'none',
      message: '桌面实时通道未连接，手机端不能直接投递到当前桌面会话。',
      reason: 'desktop live unavailable',
      checkedAt: new Date().toISOString()
    };
  }

  async tryGetCdpDesktopStatus(timeoutMs, normalizedTargetSessionId) {
    try {
      await withTimeout(
        this.cdpDesktopAdapter.probe(),
        timeoutMs,
        '连接当前 Codex 桌面窗口超时'
      );
      this.desktopAdapter = this.cdpDesktopAdapter;
      const checkedAt = new Date().toISOString();
      if (normalizedTargetSessionId) {
        const targetVerification = await this.tryVerifyDesktopTargetSession(
          this.cdpDesktopAdapter,
          normalizedTargetSessionId,
          timeoutMs
        );
        const currentSessionId = await this.tryGetCurrentDesktopSessionId(timeoutMs);
        if (!currentSessionId) {
          this.lastDesktopUnavailableError = null;
          return {
            ok: true,
            desktopLive: true,
            status: targetVerification?.verified === true ? 'target_ready' : 'unverified',
            currentSessionId: null,
            targetSessionId: normalizedTargetSessionId,
            sessionVerified: false,
            targetVerified: targetVerification?.verified === true,
            transport: 'cdp',
            message: targetVerification?.verified === true
              ? '桌面 App Server 已确认目标会话；桌面当前页面无需切换。'
              : '已连接桌面实时通道，但无法确认桌面当前会话，已阻止直接发送。',
            checkedAt
          };
        }
        if (currentSessionId !== normalizedTargetSessionId) {
          this.lastDesktopUnavailableError = null;
          return {
            ok: true,
            desktopLive: true,
            status: targetVerification?.verified === true ? 'target_ready' : 'mismatch',
            currentSessionId,
            targetSessionId: normalizedTargetSessionId,
            sessionVerified: false,
            targetVerified: targetVerification?.verified === true,
            transport: 'cdp',
            message: targetVerification?.verified === true
              ? '桌面 App Server 已确认手机选择的目标会话；桌面继续停留在当前页面。'
              : '桌面当前会话与手机选择的会话不一致，且桌面 App Server 找不到目标会话，已阻止发送。',
            checkedAt
          };
        }
        this.lastDesktopUnavailableError = null;
        return {
          ok: true,
          desktopLive: true,
          status: 'verified',
          currentSessionId,
          targetSessionId: normalizedTargetSessionId,
          sessionVerified: true,
          targetVerified: targetVerification?.verified === true,
          transport: 'cdp',
          message: '已严格校验：桌面当前显示的会话与手机选择会话一致，可以实时发送。',
          checkedAt
        };
      }
      this.lastDesktopUnavailableError = null;
      return {
        ok: true,
        desktopLive: true,
        status: 'ready',
        currentSessionId: null,
        targetSessionId: normalizedTargetSessionId,
        sessionVerified: false,
        transport: 'cdp',
        message: '已连接当前 Codex 桌面窗口实时通道',
        checkedAt
      };
    } catch (error) {
      return {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        currentSessionId: null,
        targetSessionId: normalizedTargetSessionId,
        sessionVerified: false,
        transport: 'cdp',
        message: '桌面实时通道未连接，手机端不能直接投递到当前桌面会话。',
        reason: error?.message ?? 'unknown',
        checkedAt: new Date().toISOString()
      };
    }
  }

  shouldUseCdpStatus(status, targetSessionId) {
    if (!status || status.desktopLive !== true) {
      return false;
    }
    if (!targetSessionId) {
      return true;
    }
    return isDesktopTargetReady(status, targetSessionId);
  }

  shouldUseScriptStatus(status, targetSessionId) {
    if (!status) {
      return false;
    }
    if (status.status === 'degraded') {
      return false;
    }
    if (!targetSessionId && status.desktopLive === true) {
      return true;
    }
    if (!targetSessionId) {
      return true;
    }
    if (isDesktopTargetReady(status, targetSessionId)) {
      return true;
    }
    if (status.status === 'mismatch' && status.currentSessionId) {
      return true;
    }
    if (status.status === 'unverified' && !status.currentSessionId) {
      return false;
    }
    return false;
  }

  selectDesktopAdapterForStatus(status) {
    const transport = normalizeTransport(status?.transport);
    if (transport === 'cdp' && this.cdpDesktopAdapter) {
      this.desktopAdapter = this.cdpDesktopAdapter;
      return;
    }
    if (transport === 'script' && this.scriptDesktopAdapter) {
      this.desktopAdapter = this.scriptDesktopAdapter;
    }
  }

  async shouldRetryWithCdp(error, desktopStatus, targetSessionId, attemptedAdapter = this.desktopAdapter) {
    if (!error?.safeToFallback) {
      return false;
    }
    if (normalizeTransport(desktopStatus?.transport) !== 'script') {
      return false;
    }
    if (attemptedAdapter !== this.scriptDesktopAdapter) {
      return false;
    }
    if (!this.cdpDesktopAdapter || this.cdpDesktopAdapter === this.scriptDesktopAdapter) {
      return false;
    }
    const cdpStatus = await this.tryGetCdpDesktopStatus(this.desktopProbeTimeoutMs, normalizeSessionId(targetSessionId));
    if (!this.shouldUseCdpStatus(cdpStatus, normalizeSessionId(targetSessionId))) {
      return false;
    }
    return true;
  }

  async getCurrentDesktopSessionId(timeoutMs) {
    if (typeof this.desktopAdapter.getCurrentConversationId !== 'function') {
      return null;
    }
    return withTimeout(
      this.desktopAdapter.getCurrentConversationId(),
      timeoutMs,
      '读取当前 Codex 桌面会话超时'
    );
  }

  async tryGetCurrentDesktopSessionId(timeoutMs) {
    try {
      return await this.getCurrentDesktopSessionId(timeoutMs);
    } catch {
      return null;
    }
  }

  async tryGetCurrentSessionIdFromAdapter(adapter, timeoutMs) {
    if (!adapter || typeof adapter.getCurrentConversationId !== 'function') {
      return null;
    }
    try {
      return await withTimeout(
        adapter.getCurrentConversationId(),
        timeoutMs,
        '读取桌面脚本桥当前会话超时'
      );
    } catch {
      return null;
    }
  }

  async tryVerifyDesktopTargetSession(adapter, targetSessionId, timeoutMs) {
    if (!adapter || typeof adapter.verifyTargetSession !== 'function') {
      return null;
    }
    try {
      return await withTimeout(
        adapter.verifyTargetSession(targetSessionId),
        timeoutMs,
        '校验 Codex 桌面目标会话超时'
      );
    } catch {
      return null;
    }
  }

  async tryGetDesktopStatusFromAdapter(adapter, timeoutMs, targetSessionId) {
    if (!adapter || adapter === this.cdpDesktopAdapter) {
      return null;
    }
    try {
      await withTimeout(adapter.probe(), timeoutMs, '连接桌面脚本桥超时');
      const probeStatus = typeof adapter.bridge?.getStatus === 'function'
        ? adapter.bridge.getStatus(targetSessionId)
        : null;
      if (probeStatus?.desktopLive === false) {
        return {
          ...probeStatus,
          targetSessionId,
          transport: 'script'
        };
      }
      const checkedAt = new Date().toISOString();
      const currentSessionId = await this.tryGetCurrentSessionIdFromAdapter(adapter, timeoutMs);
      if (targetSessionId) {
        const targetVerification = await this.tryVerifyDesktopTargetSession(
          adapter,
          targetSessionId,
          timeoutMs
        );
        if (!currentSessionId) {
          return {
            ok: true,
            desktopLive: true,
            status: targetVerification?.verified === true ? 'target_ready' : 'unverified',
            currentSessionId: null,
            targetSessionId,
            sessionVerified: false,
            targetVerified: targetVerification?.verified === true,
            transport: 'script',
            message: targetVerification?.verified === true
              ? '桌面 App Server 已确认目标会话；桌面当前页面无需切换。'
              : '桌面脚本桥已连接，但无法确认桌面当前会话，已阻止直接发送。',
            checkedAt
          };
        }
        if (currentSessionId !== targetSessionId) {
          return {
            ok: true,
            desktopLive: true,
            status: targetVerification?.verified === true ? 'target_ready' : 'mismatch',
            currentSessionId,
            targetSessionId,
            sessionVerified: false,
            targetVerified: targetVerification?.verified === true,
            transport: 'script',
            message: targetVerification?.verified === true
              ? '桌面 App Server 已确认手机选择的目标会话；桌面继续停留在当前页面。'
              : '桌面当前会话与手机选择的会话不一致，且桌面 App Server 找不到目标会话，已阻止发送。',
            checkedAt
          };
        }
        return {
          ok: true,
          desktopLive: true,
          status: 'verified',
          currentSessionId,
          targetSessionId,
          sessionVerified: true,
          targetVerified: targetVerification?.verified === true,
          transport: 'script',
          message: '已严格校验：桌面当前显示的会话与手机选择会话一致，可以实时发送。',
          checkedAt
        };
      }
      if (!targetSessionId) {
        return {
          ok: true,
          desktopLive: true,
          status: 'ready',
          currentSessionId,
          targetSessionId,
          sessionVerified: false,
          transport: 'script',
          message: '桌面脚本桥已连接',
          checkedAt
        };
      }
    } catch {
      return null;
    }
  }

  emitDesktopProbeResult(context, status) {
    context.emit('codex.desktop_live.probe_started', {
      status: 'checking',
      timeoutMs: this.desktopProbeTimeoutMs,
      targetSessionId: status.targetSessionId ?? ''
    });
    if (isDesktopTargetReady(status, status.targetSessionId ?? '')) {
      context.emit('codex.desktop_live.available', {
        status: status.status,
        message: status.message,
        currentSessionId: status.currentSessionId ?? null,
        targetSessionId: status.targetSessionId ?? '',
        sessionVerified: status.sessionVerified ?? false,
        targetVerified: status.targetVerified ?? false,
        transport: status.transport ?? 'unknown'
      });
      return;
    }
    context.emit('codex.desktop_live.unavailable', {
      status: status.status,
      message: status.message,
      reason: status.reason ?? '',
      currentSessionId: status.currentSessionId ?? null,
      targetSessionId: status.targetSessionId ?? '',
      sessionVerified: status.sessionVerified ?? false,
      targetVerified: status.targetVerified ?? false,
      transport: status.transport ?? 'unknown',
      safeToFallback: false
    });
  }
}

function normalizeSessionId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTransport(value) {
  return value === 'cdp' || value === 'script' ? value : '';
}

function isDesktopTargetReady(status, targetSessionId = '') {
  if (!status || status.desktopLive !== true) {
    return false;
  }
  const normalizedTargetSessionId = normalizeSessionId(targetSessionId);
  if (!normalizedTargetSessionId) {
    return true;
  }
  return status.sessionVerified === true || status.targetVerified === true;
}

function createDesktopVerificationError(status) {
  const error = new Error(status?.message || '桌面实时通道未校验，已阻止发送到现有会话。');
  error.status = status?.status ?? 'unavailable';
  error.currentSessionId = status?.currentSessionId ?? null;
  error.targetSessionId = status?.targetSessionId ?? '';
  error.targetVerified = status?.targetVerified === true;
  error.reason = status?.reason ?? status?.message ?? '';
  return error;
}

function withTimeout(promise, timeoutMs, message, onTimeout = null) {
  let settled = false;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        onTimeout?.();
      } catch {
        // Timeout cleanup is best-effort; the caller still needs the timeout error.
      }
      reject(new Error(message));
    }, Math.max(1000, timeoutMs));
    Promise.resolve(promise).then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}
