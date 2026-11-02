import { BridgeClient } from './BridgeClient';
import { MobileControlJob } from '../model/MobileControlModels';

/** The desktop owns execution. Closing this view never cancels a repair. */
export class MobileControlService {
  static isActive(job: MobileControlJob): boolean {
    return job.status === 'queued' || job.status === 'running';
  }

  static verified(job: MobileControlJob, sessionId: string): boolean {
    const checks = job.verification;
    return job.status === 'succeeded' && job.sessionId === sessionId && checks !== undefined
      && checks.bridge === true && checks.sessions === true && checks.targetSession === true
      && typeof checks.desktopRequired === 'boolean' && typeof checks.desktop === 'boolean'
      && (checks.desktopRequired === false || checks.desktop === true);
  }

  static requestId(): string {
    return `phone-control-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  }

  static async repair(baseUrl: string, token: string, targetId: string, sessionId: string,
    hard: boolean, onProgress: (job: MobileControlJob) => void,
    isCurrent: () => boolean = (): boolean => true): Promise<MobileControlJob> {
    const initial = await BridgeClient.startMobileControlRepair(baseUrl, token, targetId,
      sessionId, hard, MobileControlService.requestId());
    if (initial.sessionId !== sessionId || initial.mode !== (hard ? 'hard' : 'auto')) {
      throw new Error('电脑返回的修复任务不一致，请重新检查。');
    }
    return await MobileControlService.watch(baseUrl, token, targetId, initial, onProgress, isCurrent);
  }

  static async watch(baseUrl: string, token: string, targetId: string, initial: MobileControlJob,
    onProgress: (job: MobileControlJob) => void,
    isCurrent: () => boolean = (): boolean => true): Promise<MobileControlJob> {
    let job = initial;
    const deadline = Date.now() + 600000;
    let signature = '';
    while (true) {
      if (!isCurrent()) throw new Error('连接配置已切换，电脑修复仍可能在执行。');
      const nextSignature = `${job.id}:${job.status}:${job.phase}:${job.message}`;
      if (nextSignature !== signature) {
        signature = nextSignature;
        onProgress(job);
      }
      if (!MobileControlService.isActive(job)) return job;
      if (Date.now() >= deadline) {
        throw new Error('电脑修复仍在执行，当前等待已结束；重新打开设置可继续查看结果。');
      }
      await MobileControlService.delay(1500);
      if (!isCurrent()) throw new Error('连接配置已切换，电脑修复仍可能在执行。');
      try {
        const next = await BridgeClient.getMobileControlRepair(baseUrl, token, targetId, job.id);
        if (next.id !== initial.id || next.sessionId !== initial.sessionId || next.mode !== initial.mode) {
          throw new Error('电脑返回的修复任务不一致，请重新检查。');
        }
        job = next;
      } catch (error) {
        const message = (error as Error).message;
        // A transient transport loss does not imply that the desktop stopped.
        // Authentication, missing jobs, and incompatible responses need attention.
        if (!/HTTP 50[234]|超时|timeout|连接|网络|network|connect/i.test(message)
          || /HTTP 40[134]|不一致|不兼容|格式/.test(message)) throw (error as Error);
        await MobileControlService.delay(3000);
      }
    }
  }

  private static delay(ms: number): Promise<void> {
    return new Promise<void>((resolve: () => void) => { setTimeout(resolve, ms); });
  }
}
