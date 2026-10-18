export interface SessionConnectionFailureContext {
  diagnosticsAvailable: boolean;
  failureClass: string;
  requiresDesktopCdp: boolean;
  desktopProcessMode: string;
  repairAction: string;
}

export interface SessionConnectionFailurePresentation {
  kind: string;
  title: string;
  message: string;
  action: string;
  actionLabel: string;
}

/** Classify the failed read, using only diagnostics obtained after that failure. */
export class SessionConnectionFailure {
  static present(error: string, context: SessionConnectionFailureContext): SessionConnectionFailurePresentation {
    const text = error.toLowerCase();
    // A current request's auth/transport failure takes precedence over desktop state.
    if (/http\s+(401|403)\b/.test(text)) {
      return { kind: 'authentication', title: '访问验证未通过',
        message: '请重新配对电脑，核对访问凭证和动态验证码后重试。',
        action: 'pairing', actionLabel: '重新配对' };
    }
    if (text.indexOf('bridge 协议不兼容') >= 0) {
      return { kind: 'protocol', title: '电脑端服务需要更新',
        message: '手机与电脑端版本不兼容，请更新电脑端桥接服务后重试。',
        action: 'retry', actionLabel: '刷新重试' };
    }
    if (/timeout|timed out|超时|http\s+504\b/.test(text)) {
      return { kind: 'timeout', title: '读取会话超时',
        message: '电脑或网络暂时没有响应，请稍后刷新重试，并确认电脑在线。',
        action: 'retry', actionLabel: '刷新重试' };
    }
    if (text.indexOf('桥接请求失败') >= 0 || (!/http\s+\d{3}\b/.test(text) && text.indexOf('cdp') < 0
      && /econnrefused|econnreset|enetunreach|ehostunreach|failed to connect|could not connect|couldn.t connect|network|网络|连接失败|无法连接/.test(text))) {
      return { kind: 'network', title: '与电脑的连接暂时断开',
        message: '请确认手机网络、电脑和连接服务在线；地址变更后可重新配对。',
        action: 'retry', actionLabel: '刷新重试' };
    }
    if (context.diagnosticsAvailable) {
      if (context.failureClass === 'codex_not_running' || context.desktopProcessMode === 'missing') {
        return { kind: 'desktop_missing', title: 'Codex 桌面尚未运行',
          message: '需要启动桌面连接才能读取会话。点击后确认恢复，或在电脑上启动 Codex。',
          action: 'hard_restart', actionLabel: '启动桌面连接' };
      }
      if (context.requiresDesktopCdp || context.failureClass === 'codex_plain_no_cdp'
        || context.desktopProcessMode === 'plain' || context.repairAction === 'desktop_cdp_restart_required') {
        return { kind: 'desktop_interface_missing', title: '桌面连接接口未开启',
          message: '当前 Codex 启动方式无法提供手机连接，需要确认重启桌面后恢复。',
          action: 'hard_restart', actionLabel: '恢复桌面连接' };
      }
      if (context.failureClass === 'desktop_cdp_unavailable' || context.failureClass === 'desktop_live_host_offline'
        || context.repairAction === 'soft_recover_live_host') {
        return SessionConnectionFailure.desktopDisconnected();
      }
    }
    // A raw CDP error can establish disconnection, but cannot establish a required restart.
    if (/cdp/.test(text) && /econnrefused|econnreset|不可用|未连接|连接失败|无法连接|断开/.test(text)) {
      return SessionConnectionFailure.desktopDisconnected();
    }
    if (/http\s+(502|503)\b/.test(text)) {
      return { kind: 'service_unavailable', title: '连接服务暂时不可用',
        message: '请确认电脑上的连接服务正在运行，然后刷新重试。',
        action: 'retry', actionLabel: '刷新重试' };
    }
    return { kind: 'unknown', title: '暂时无法读取会话',
      message: '尚未确认故障原因，请先刷新重试；仍然失败时可查看错误详情。',
      action: 'retry', actionLabel: '刷新重试' };
  }

  private static desktopDisconnected(): SessionConnectionFailurePresentation {
    return { kind: 'desktop_disconnected', title: '桌面连接暂时断开',
      message: '可以尝试恢复桌面连接，或先刷新重试。恢复连接不会自动重启 Codex。',
      action: 'soft_repair', actionLabel: '恢复连接' };
  }
}
