import { GuardianStatus } from '../model/BridgeModels';

export class GuardianPresentation {
  static localTime(value: string | null | undefined, missing: string = '时间未记录'): string {
    if (!value || value.trim().length === 0) { return missing; }
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) { return '时间未确认'; }
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
  }

  static actionLabel(action: string): string {
    switch (action) {
      case 'reconnect': return '重新连接';
      case 'restart_services': return '恢复故障服务';
      case 'restart_desktop': return '重启 Codex';
      default: return '其他处理';
    }
  }

  static outcomeLabel(outcome: string): string {
    switch (outcome) {
      case 'requested': return '已执行，等待复查';
      case 'skipped': return '已取消';
      case 'unconfirmed': return '完成情况未确认';
      default: return '结果待确认';
    }
  }

  static phaseLabel(phase: string): string {
    switch (phase) {
      case 'disabled': return '已关闭';
      case 'checking': return '正在检查';
      case 'healthy': return '读取健康';
      case 'suspect': return '发现异常，正在确认';
      case 'repairing': return '正在修复';
      case 'cooldown': return '等待复查';
      case 'needs_attention': return '需要处理';
      case 'paused': return '链路已暂停';
      default: return '状态未确认';
    }
  }

  static summary(status: GuardianStatus | null, error: string = ''): string {
    if (error.length > 0) { return '状态读取失败，请重试'; }
    if (status === null) { return '状态尚未读取'; }
    if (!status.enabled && status.phase === 'disabled') { return '已关闭'; }
    return `${status.enabled ? '已开启' : '已关闭'} · ${GuardianPresentation.phaseLabel(status.phase)}`;
  }
}
