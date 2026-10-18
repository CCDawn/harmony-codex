import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { VoiceTranscriptEntry } from '../model/BridgeModels';

export interface CompanionTranscriptPartition {
  bridgeUrl: string;
  assistantId: string;
  roomId: string;
}

interface CompanionTranscriptDocument {
  schemaVersion: number;
  origin: string;
  assistantId: string;
  roomId: string;
  entries: VoiceTranscriptEntry[];
}

const TRANSCRIPT_DIRECTORY: string = 'companion-transcripts';
const DOCUMENT_FILE: string = 'turns.json';
const TEMP_FILE: string = 'turns.tmp';
const BACKUP_FILE: string = 'turns.bak';

/**
 * Durable phone-side recovery copy for final voice turns. This store never
 * claims that a transcript was written to Codex; that requires a matching
 * official room-history item. No transcript count or text limit is applied.
 */
export class CompanionTranscriptStore {
  private static pendingWrites: Map<string, Promise<void>> = new Map<string, Promise<void>>();

  static partitionKey(partition: CompanionTranscriptPartition): string {
    return CompanionTranscriptStore.partitionDirectory(partition, '');
  }

  static async load(
    context: common.Context,
    partition: CompanionTranscriptPartition
  ): Promise<VoiceTranscriptEntry[]> {
    const path = CompanionTranscriptStore.documentPath(context, partition);
    const pending = CompanionTranscriptStore.pendingWrites.get(path);
    if (pending !== undefined) {
      await pending;
    }
    return await CompanionTranscriptStore.readPartition(context, partition, path);
  }

  static async appendFinal(
    context: common.Context,
    partition: CompanionTranscriptPartition,
    entry: VoiceTranscriptEntry
  ): Promise<void> {
    if ((entry.role !== 'user' && entry.role !== 'assistant') || entry.final !== true
      || typeof entry.text !== 'string' || entry.text.length === 0
      || typeof entry.itemId !== 'string' || entry.itemId.length === 0
      || typeof entry.callId !== 'string' || entry.callId.length === 0) {
      throw new Error('手机转写内容或通话身份不完整，未写入本地缓存');
    }
    if ((entry.localAssistantId !== undefined && entry.localAssistantId !== partition.assistantId.trim())
      || (entry.localRoomId !== undefined && entry.localRoomId !== partition.roomId.trim())
      || (entry.localBridgeOrigin !== undefined
        && CompanionTranscriptStore.normalizeBridgeOrigin(entry.localBridgeOrigin)
          !== CompanionTranscriptStore.normalizeBridgeOrigin(partition.bridgeUrl))) {
      throw new Error('手机转写原始分区身份不匹配，未写入本地缓存');
    }
    const path = CompanionTranscriptStore.documentPath(context, partition);
    const previous = CompanionTranscriptStore.pendingWrites.get(path) ?? Promise.resolve();
    const operation = previous.then(async (): Promise<void> => {
      const entries = await CompanionTranscriptStore.readPartition(context, partition, path);
      const normalized: VoiceTranscriptEntry = {
        itemId: entry.itemId,
        role: entry.role,
        text: entry.text,
        final: true,
        phoneTranscript: true,
        localStorageStatus: 'saved',
        callId: entry.callId,
        localBridgeOrigin: CompanionTranscriptStore.normalizeBridgeOrigin(partition.bridgeUrl),
        localAssistantId: partition.assistantId.trim(),
        localRoomId: partition.roomId.trim()
      };
      const index = entries.findIndex((current: VoiceTranscriptEntry) => current.itemId === normalized.itemId);
      if (index >= 0) {
        entries[index] = normalized;
      } else {
        entries.push(normalized);
      }
      const document: CompanionTranscriptDocument = {
        schemaVersion: 1,
        origin: CompanionTranscriptStore.normalizeBridgeOrigin(partition.bridgeUrl),
        assistantId: partition.assistantId.trim(),
        roomId: partition.roomId.trim(),
        entries
      };
      try {
        CompanionTranscriptStore.writePartition(context, partition, path, JSON.stringify(document));
      } catch (_) {
        throw new Error('手机转写保存失败，当前页面内容仍在，但没有确认写入本机');
      }
    });
    const settled = operation.then((): void => {}, (): void => {});
    CompanionTranscriptStore.pendingWrites.set(path, settled);
    try {
      await operation;
    } finally {
      if (CompanionTranscriptStore.pendingWrites.get(path) === settled) {
        CompanionTranscriptStore.pendingWrites.delete(path);
      }
    }
  }

  static normalizeBridgeOrigin(bridgeUrl: string): string {
    const value = String(bridgeUrl ?? '').trim();
    const match = /^(https?):\/\/([^/?#]+)(?:[/?#]|$)/i.exec(value);
    if (match === null || match[2].indexOf('@') >= 0) {
      throw new Error('桥接地址无效，无法确定手机转写缓存所属服务');
    }
    const scheme = match[1].toLowerCase();
    const authority = match[2].toLowerCase();
    const defaultPort = scheme === 'https' ? ':443' : ':80';
    return `${scheme}://${authority.endsWith(defaultPort) ? authority.slice(0, -defaultPort.length) : authority}`;
  }

  private static async readPartition(
    context: common.Context,
    partition: CompanionTranscriptPartition,
    path: string
  ): Promise<VoiceTranscriptEntry[]> {
    let raw: string = '';
    try {
      raw = fileIo.readTextSync(path);
    } catch (error) {
      if (CompanionTranscriptStore.isMissingFile(error)) {
        const backupPath = CompanionTranscriptStore.siblingPath(path, BACKUP_FILE);
        try {
          raw = fileIo.readTextSync(backupPath);
          try {
            fileIo.renameSync(backupPath, path);
          } catch (_) {
            // The backup remains readable and is retained if recovery rename fails.
          }
        } catch (backupError) {
          if (CompanionTranscriptStore.isMissingFile(backupError)) {
            return [];
          }
          throw new Error('手机转写缓存读取失败，原始文件已保留');
        }
      } else {
        throw new Error('手机转写缓存读取失败，原始文件已保留');
      }
    }
    let document: CompanionTranscriptDocument;
    try {
      document = JSON.parse(raw) as CompanionTranscriptDocument;
    } catch (_) {
      throw new Error('手机转写缓存无法读取，原始数据已保留');
    }
    const expectedOrigin = CompanionTranscriptStore.normalizeBridgeOrigin(partition.bridgeUrl);
    if (document.schemaVersion !== 1 || document.origin !== expectedOrigin
      || document.assistantId !== partition.assistantId.trim() || document.roomId !== partition.roomId.trim()
      || !Array.isArray(document.entries)) {
      throw new Error('手机转写缓存身份不匹配，已停止读取以避免显示到其他助手会话');
    }
    const entries: VoiceTranscriptEntry[] = [];
    document.entries.forEach((entry: VoiceTranscriptEntry) => {
      if ((entry.role !== 'user' && entry.role !== 'assistant') || entry.final !== true
        || typeof entry.itemId !== 'string' || entry.itemId.length === 0
        || typeof entry.text !== 'string' || entry.text.length === 0
        || entry.phoneTranscript !== true || typeof entry.callId !== 'string' || entry.callId.length === 0) {
        throw new Error('手机转写缓存内容异常，原始数据已保留');
      }
      entries.push({
        itemId: entry.itemId,
        role: entry.role,
        text: entry.text,
        final: true,
        phoneTranscript: true,
        localStorageStatus: 'saved',
        callId: entry.callId,
        localBridgeOrigin: expectedOrigin,
        localAssistantId: partition.assistantId.trim(),
        localRoomId: partition.roomId.trim()
      });
    });
    return entries;
  }

  private static writePartition(
    context: common.Context,
    partition: CompanionTranscriptPartition,
    path: string,
    serialized: string
  ): void {
    const directory = CompanionTranscriptStore.partitionDirectory(partition, context.filesDir);
    try {
      fileIo.mkdirSync(directory, true);
    } catch (error) {
      // Harmony reports EEXIST even for recursive creation of an existing directory.
      const code = String((error as Record<string, Object>).code ?? '');
      if (code !== '13900015' && code !== 'EEXIST') {
        throw new Error('手机转写目录创建失败');
      }
    }
    const tempPath = CompanionTranscriptStore.siblingPath(path, TEMP_FILE);
    const backupPath = CompanionTranscriptStore.siblingPath(path, BACKUP_FILE);
    CompanionTranscriptStore.writeTextFile(tempPath, serialized);
    try {
      fileIo.unlinkSync(backupPath);
    } catch (_) {
    }
    let movedCurrentToBackup: boolean = false;
    try {
      fileIo.renameSync(path, backupPath);
      movedCurrentToBackup = true;
    } catch (_) {
      // The first write has no current document to back up.
    }
    try {
      fileIo.renameSync(tempPath, path);
    } catch (error) {
      if (movedCurrentToBackup) {
        try {
          fileIo.renameSync(backupPath, path);
        } catch (_) {
        }
      }
      throw new Error('手机转写文件替换失败，已保留可恢复副本');
    }
    if (movedCurrentToBackup) {
      try {
        fileIo.unlinkSync(backupPath);
      } catch (_) {
      }
    }
  }

  private static writeTextFile(path: string, text: string): void {
    const file = fileIo.openSync(
      path,
      fileIo.OpenMode.CREATE | fileIo.OpenMode.WRITE_ONLY | fileIo.OpenMode.TRUNC
    );
    try {
      const encoder = new util.TextEncoder();
      const bytes = encoder.encodeInto(text);
      const writtenBytes = fileIo.writeSync(file.fd, bytes.buffer);
      if (writtenBytes !== bytes.length) {
        throw new Error('手机转写缓存未能完整写入');
      }
      fileIo.fsyncSync(file.fd);
    } finally {
      fileIo.closeSync(file);
    }
  }

  private static partitionDirectory(partition: CompanionTranscriptPartition, root: string): string {
    const origin = CompanionTranscriptStore.normalizeBridgeOrigin(partition.bridgeUrl);
    const assistantId = String(partition.assistantId ?? '').trim();
    const roomId = String(partition.roomId ?? '').trim();
    if (assistantId.length === 0 || roomId.length === 0) {
      throw new Error('个人助手或房间身份缺失，无法访问手机转写缓存');
    }
    const segments: string[] = [
      'origin',
      ...CompanionTranscriptStore.encodePathSegments(origin),
      'assistant',
      ...CompanionTranscriptStore.encodePathSegments(assistantId),
      'room',
      ...CompanionTranscriptStore.encodePathSegments(roomId)
    ];
    const prefix = root.length > 0 ? `${root}/${TRANSCRIPT_DIRECTORY}` : TRANSCRIPT_DIRECTORY;
    return `${prefix}/${segments.join('/')}`;
  }

  private static encodePathSegments(value: string): string[] {
    let encoded: string = '';
    for (let index = 0; index < value.length; index += 1) {
      encoded += value.charCodeAt(index).toString(16).padStart(4, '0');
    }
    if (encoded.length === 0) {
      encoded = 'empty';
    }
    const segments: string[] = [];
    for (let index = 0; index < encoded.length; index += 120) {
      segments.push(encoded.substring(index, Math.min(encoded.length, index + 120)));
    }
    return segments;
  }

  private static documentPath(context: common.Context, partition: CompanionTranscriptPartition): string {
    return `${CompanionTranscriptStore.partitionDirectory(partition, context.filesDir)}/${DOCUMENT_FILE}`;
  }

  private static siblingPath(path: string, name: string): string {
    const separator = path.lastIndexOf('/');
    return separator >= 0 ? `${path.substring(0, separator + 1)}${name}` : name;
  }

  private static isMissingFile(error: Error | Object | string): boolean {
    const message = typeof error === 'string' ? error : String((error as Error).message ?? error);
    const code = typeof error === 'object' && error !== null
      ? String((error as Record<string, Object>).code ?? '') : '';
    return code === 'ENOENT' || code === '13900002'
      || /no such file|does not exist|not found/i.test(message);
  }
}
