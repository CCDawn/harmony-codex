import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { CompanionTextMessage, CompanionTextReceipt } from '../model/CompanionModels';
import { VoiceTranscriptEntry } from '../model/BridgeModels';

export interface CompanionTextPartition {
  bridgeUrl: string;
  profileId: string;
  roomId: string;
}

interface CompanionTextDocument {
  version: number;
  partition: string;
  messages: CompanionTextMessage[];
}

/** Recovery outbox only. No voice turns, automatic retries, or normal threads. */
export class CompanionTextService {
  private static cache: Map<string, CompanionTextMessage[]> = new Map<string, CompanionTextMessage[]>();

  static partitionKey(partition: CompanionTextPartition): string {
    const match = /^(https?):\/\/([^/?#]+)(?:[/?#]|$)/i.exec(partition.bridgeUrl.trim());
    if (match === null || match[2].indexOf('@') >= 0 || !partition.profileId.trim() || !partition.roomId.trim()) {
      throw new Error('无法确认文字消息所属服务和个人助手');
    }
    const scheme = match[1].toLowerCase();
    const port = scheme === 'https' ? ':443' : ':80';
    const authority = match[2].toLowerCase();
    const origin = `${scheme}://${authority.endsWith(port) ? authority.slice(0, -port.length) : authority}`;
    return JSON.stringify([origin, partition.profileId.trim(), partition.roomId.trim()]);
  }

  static newRequestId(): string {
    return util.generateRandomUUID(true);
  }

  static load(context: common.Context, partition: CompanionTextPartition): CompanionTextMessage[] {
    const key = CompanionTextService.partitionKey(partition);
    if (!CompanionTextService.cache.has(key)) {
      const path = CompanionTextService.documentPath(context, partition);
      let raw = '';
      let foundDocument = false;
      try {
        raw = fileIo.readTextSync(path);
        foundDocument = true;
      } catch (error) {
        if (!CompanionTextService.isMissing(error)) {
          throw new Error('文字待确认记录读取失败，原始文件已保留');
        }
        try {
          raw = fileIo.readTextSync(`${path}.bak`);
          foundDocument = true;
        } catch (backupError) {
          if (!CompanionTextService.isMissing(backupError)) {
            throw new Error('文字待确认记录备份读取失败');
          }
        }
      }
      let messages: CompanionTextMessage[] = [];
      if (foundDocument) {
        let document: CompanionTextDocument;
        try {
          document = JSON.parse(raw) as CompanionTextDocument;
        } catch (_) {
          throw new Error('文字待确认记录损坏，原始文件已保留');
        }
        if (document.version !== 1 || document.partition !== key || !Array.isArray(document.messages)) {
          throw new Error('文字待确认记录身份不匹配，已停止读取');
        }
        messages = document.messages.map((message: CompanionTextMessage): CompanionTextMessage => {
          if (typeof message.requestId !== 'string' || !message.requestId
            || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 20000
            || typeof message.detail !== 'string' || !Number.isFinite(message.createdAt)
            || ['pending', 'submitted', 'uncertain', 'failed'].indexOf(message.state) < 0
            || (message.itemId !== null && (typeof message.itemId !== 'string' || !message.itemId.startsWith('room:')))) {
            throw new Error('文字待确认记录内容异常，原始文件已保留');
          }
          return {
            requestId: message.requestId, text: message.text,
            state: message.state === 'pending' ? 'uncertain' : message.state,
            itemId: message.itemId, createdAt: message.createdAt,
            detail: message.state === 'pending' ? '上次发送被中断，请先核对官方记录，避免重复发送' : message.detail
          };
        });
      }
      CompanionTextService.cache.set(key, messages);
    }
    return CompanionTextService.messages(partition);
  }

  static messages(partition: CompanionTextPartition): CompanionTextMessage[] {
    return (CompanionTextService.cache.get(CompanionTextService.partitionKey(partition)) ?? []).slice();
  }

  /** Creates the bubble before disk/network work. Caller must save successfully before POST. */
  static enqueue(partition: CompanionTextPartition, text: string, requestId: string): CompanionTextMessage {
    const key = CompanionTextService.partitionKey(partition);
    if (!CompanionTextService.cache.has(key)) {
      throw new Error('文字待确认记录尚未载入');
    }
    if (!text.trim() || text.length > 20000 || !requestId) {
      throw new Error('请输入 1 至 20000 字文字');
    }
    const message: CompanionTextMessage = {
      requestId, text, state: 'pending', itemId: null, createdAt: Date.now(), detail: ''
    };
    const existing = CompanionTextService.messages(partition);
    if (existing.some((current: CompanionTextMessage) => current.requestId === requestId)) {
      throw new Error('文字发送编号重复');
    }
    CompanionTextService.cache.set(key, existing.concat([message]));
    return message;
  }

  static applyReceipt(partition: CompanionTextPartition, receipt: CompanionTextReceipt): void {
    const key = CompanionTextService.partitionKey(partition);
    CompanionTextService.cache.set(key, CompanionTextService.messages(partition).map(
      (message: CompanionTextMessage): CompanionTextMessage => message.requestId !== receipt.requestId ? message : {
        requestId: message.requestId, text: message.text, createdAt: message.createdAt,
        state: receipt.state, itemId: receipt.itemId,
        detail: receipt.state === 'uncertain' ? '提交结果不确定，请先核对官方记录，避免重复发送' : ''
      }));
  }

  static markFailure(partition: CompanionTextPartition, requestId: string, detail: string, certain: boolean): void {
    const key = CompanionTextService.partitionKey(partition);
    CompanionTextService.cache.set(key, CompanionTextService.messages(partition).map(
      (message: CompanionTextMessage): CompanionTextMessage => message.requestId !== requestId ? message : {
        requestId: message.requestId, text: message.text, createdAt: message.createdAt, itemId: message.itemId,
        state: certain ? 'failed' : 'uncertain', detail
      }));
  }

  /** Text similarity, assistant responses, and submitted receipts are never acknowledgements. */
  static reconcile(partition: CompanionTextPartition, history: VoiceTranscriptEntry[]): boolean {
    const previous = CompanionTextService.messages(partition);
    const remaining = previous.filter((message: CompanionTextMessage) => message.itemId === null
      || !history.some((entry: VoiceTranscriptEntry) => entry.itemId === message.itemId && entry.role === 'user'));
    CompanionTextService.cache.set(CompanionTextService.partitionKey(partition), remaining);
    return previous.length !== remaining.length;
  }

  static recoverText(message: CompanionTextMessage, draft: string): string {
    return message.state === 'failed' && draft.length === 0 ? message.text : draft;
  }

  static save(context: common.Context, partition: CompanionTextPartition): void {
    const key = CompanionTextService.partitionKey(partition);
    const document: CompanionTextDocument = {
      version: 1, partition: key, messages: CompanionTextService.messages(partition)
    };
    const path = CompanionTextService.documentPath(context, partition);
    const directory = path.substring(0, path.lastIndexOf('/'));
    try {
      fileIo.mkdirSync(directory, true);
    } catch (error) {
      const code = String((error as Record<string, Object>).code ?? '');
      if (code !== '13900015' && code !== 'EEXIST') {
        throw new Error('文字待确认记录目录创建失败');
      }
    }
    const file = fileIo.openSync(`${path}.tmp`, fileIo.OpenMode.CREATE | fileIo.OpenMode.WRITE_ONLY | fileIo.OpenMode.TRUNC);
    try {
      const bytes = new util.TextEncoder().encodeInto(JSON.stringify(document));
      if (fileIo.writeSync(file.fd, bytes.buffer) !== bytes.length) {
        throw new Error('文字待确认记录未完整保存');
      }
      fileIo.fsyncSync(file.fd);
    } finally {
      fileIo.closeSync(file);
    }
    let backedUp = false;
    try {
      fileIo.renameSync(path, `${path}.bak`);
      backedUp = true;
    } catch (error) {
      if (!CompanionTextService.isMissing(error)) {
        throw new Error('文字待确认记录备份失败，已停止覆盖');
      }
    }
    try {
      fileIo.renameSync(`${path}.tmp`, path);
    } catch (_) {
      if (backedUp) {
        try { fileIo.renameSync(`${path}.bak`, path); } catch (_) {}
      }
      throw new Error('文字待确认记录保存失败，已保留可恢复副本');
    }
    try { fileIo.unlinkSync(`${path}.bak`); } catch (_) {}
  }

  private static documentPath(context: common.Context, partition: CompanionTextPartition): string {
    const key = CompanionTextService.partitionKey(partition);
    let encoded = '';
    for (let index = 0; index < key.length; index += 1) {
      encoded += key.charCodeAt(index).toString(16).padStart(4, '0');
    }
    const segments: string[] = [];
    for (let index = 0; index < encoded.length; index += 120) {
      segments.push(encoded.slice(index, index + 120));
    }
    return `${context.filesDir}/companion-text-outbox/${segments.join('/')}/messages.json`;
  }

  private static isMissing(error: Error | Object): boolean {
    const code = String((error as Record<string, Object>).code ?? '');
    return code === 'ENOENT' || code === '13900002' || /no such file|not found|does not exist/i.test(String((error as Error).message));
  }
}
