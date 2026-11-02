import { CodexContinueStatus } from '../model/BridgeModels';

export function sessionControlStateLabel(state: string): string {
  if (state === 'active' || state === 'running' || state === 'queued') return '运行中';
  if (state === 'waiting_input') return '等待回答';
  if (state === 'waiting_approval') return '等待确认';
  if (state === 'recovering') return '正在恢复';
  if (state === 'interrupted') return '已中断';
  if (state === 'failed') return '执行失败';
  if (state === 'completed') return '已完成';
  if (state === 'idle') return '空闲';
  return '状态待同步';
}

export function canContinueNativeSession(status: CodexContinueStatus | null, connected: boolean,
  hasDraft: boolean, pending: boolean, uncertain: boolean): boolean {
  return connected && !hasDraft && !pending && !uncertain && status !== null
    && status.threadId.length > 0 && status.turnId.length > 0 && status.canContinue === true
    && (status.state === 'interrupted' || status.state === 'failed');
}

// Idle and interrupted only clear old running UI. Neither proves completion.
export function sessionCompletionKind(state: string, terminalReason: string = ''): string {
  const value = terminalReason || state;
  if (value === 'completed' || value === 'complete') return 'completed';
  if (value === 'failed') return 'failed';
  return '';
}
