import { common, wantConstant } from '@kit.AbilityKit';
import { fileIo, fileUri } from '@kit.CoreFileKit';
import { image } from '@kit.ImageKit';
import { http } from '@kit.NetworkKit';
import { systemShare } from '@kit.ShareKit';
import pasteboard from '@ohos.pasteboard';
import { RemoteSessionFile } from '../model/BridgeModels';
import { CredentialRuntime } from '../config/CredentialRuntime';
import { TotpGenerator } from '../utils/TotpGenerator';

interface DownloadedImage {
  bytes: ArrayBuffer;
  extension: string;
  utd: string;
}

export interface DownloadedRemoteFile {
  fileName: string;
  filePath: string;
  uri: string;
  bytes: number;
  mimeType: string;
  openType: string;
}

export class ContentActionService {
  static async copyText(text: string): Promise<void> {
    const value = text.trim();
    if (value.length === 0) {
      throw new Error('没有可复制的文本');
    }
    const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, value);
    await pasteboard.getSystemPasteboard().setData(data);
  }

  static async shareText(context: common.UIAbilityContext, text: string, title: string): Promise<void> {
    const value = text.trim();
    if (value.length === 0) {
      throw new Error('没有可分享的文本');
    }
    const data = new systemShare.SharedData({
      utd: 'general.plain-text',
      content: value,
      title
    });
    await new systemShare.ShareController(data).show(context, {
      selectionMode: systemShare.SelectionMode.SINGLE,
      previewMode: systemShare.SharePreviewMode.DEFAULT
    });
  }

  static async copyImage(imageUrl: string, bridgeToken: string): Promise<void> {
    const downloaded = await ContentActionService.downloadImage(imageUrl, bridgeToken);
    const source = image.createImageSource(downloaded.bytes);
    let pixelMap: image.PixelMap | null = null;
    try {
      pixelMap = await source.createPixelMap();
      const data = pasteboard.createData(pasteboard.MIMETYPE_PIXELMAP, pixelMap);
      await pasteboard.getSystemPasteboard().setData(data);
    } finally {
      if (pixelMap !== null) {
        await pixelMap.release();
      }
      await source.release();
    }
  }

  static async shareImage(
    context: common.UIAbilityContext,
    imageUrl: string,
    bridgeToken: string,
    title: string
  ): Promise<void> {
    const downloaded = await ContentActionService.downloadImage(imageUrl, bridgeToken);
    const shareDir = `${context.cacheDir}/shared-content`;
    try {
      fileIo.mkdirSync(shareDir, true);
    } catch {
    }
    const filePath = `${shareDir}/codex-${Date.now()}.${downloaded.extension}`;
    const file = fileIo.openSync(
      filePath,
      fileIo.OpenMode.CREATE | fileIo.OpenMode.WRITE_ONLY | fileIo.OpenMode.TRUNC
    );
    try {
      fileIo.writeSync(file.fd, downloaded.bytes);
    } finally {
      fileIo.closeSync(file);
    }
    const data = new systemShare.SharedData({
      utd: downloaded.utd,
      uri: fileUri.getUriFromPath(filePath),
      title
    });
    await new systemShare.ShareController(data).show(context, {
      selectionMode: systemShare.SelectionMode.SINGLE,
      previewMode: systemShare.SharePreviewMode.DEFAULT
    });
  }

  static async downloadRemoteFile(
    context: common.UIAbilityContext,
    downloadUrl: string,
    bridgeToken: string,
    metadata: RemoteSessionFile
  ): Promise<DownloadedRemoteFile> {
    if (!downloadUrl.startsWith('http://') && !downloadUrl.startsWith('https://')) {
      throw new Error('电脑端文件下载地址无效');
    }
    const request = http.createHttp();
    const headers: Record<string, string> = {};
    if (bridgeToken.length > 0) {
      headers['X-Codex-Bridge-Token'] = bridgeToken;
    }
    const bridgeOtp = await TotpGenerator.currentCode(CredentialRuntime.getRuntimeTotpSecret());
    if (bridgeOtp.length > 0) {
      headers['X-Codex-Bridge-OTP'] = bridgeOtp;
    }
    try {
      const response = await request.request(downloadUrl, {
        method: http.RequestMethod.GET,
        header: headers,
        connectTimeout: 15000,
        readTimeout: 120000,
        expectDataType: http.HttpDataType.ARRAY_BUFFER
      });
      if (response.responseCode < 200 || response.responseCode >= 300) {
        throw new Error(`下载文件失败：HTTP ${response.responseCode}`);
      }
      if (!(response.result instanceof ArrayBuffer)) {
        throw new Error('下载文件失败：响应不是二进制文件');
      }
      if (response.result.byteLength !== metadata.bytes) {
        throw new Error('电脑端文件在确认后发生变化，请重新点击链接');
      }

      const downloadDir = `${context.filesDir}/remote-downloads`;
      try {
        fileIo.mkdirSync(downloadDir, true);
      } catch {
      }
      const fileName = ContentActionService.safeLocalFileName(metadata.fileName);
      const filePath = `${downloadDir}/${fileName}`;
      const file = fileIo.openSync(
        filePath,
        fileIo.OpenMode.CREATE | fileIo.OpenMode.WRITE_ONLY | fileIo.OpenMode.TRUNC
      );
      try {
        fileIo.writeSync(file.fd, response.result);
      } finally {
        fileIo.closeSync(file);
      }
      return {
        fileName,
        filePath,
        uri: fileUri.getUriFromPath(filePath),
        bytes: response.result.byteLength,
        mimeType: metadata.mimeType,
        openType: metadata.openType
      };
    } finally {
      request.destroy();
    }
  }

  static async openRemoteFile(
    context: common.UIAbilityContext,
    file: DownloadedRemoteFile
  ): Promise<void> {
    await context.startAbility({
      action: 'ohos.want.action.viewData',
      uri: file.uri,
      type: file.openType || file.mimeType,
      flags: wantConstant.Flags.FLAG_AUTH_READ_URI_PERMISSION,
      parameters: {
        'ohos.ability.params.showDefaultPicker': true
      }
    });
  }

  static async shareRemoteFile(
    context: common.UIAbilityContext,
    file: DownloadedRemoteFile,
    title: string
  ): Promise<void> {
    const data = new systemShare.SharedData({
      utd: file.openType || 'general.plain-text',
      uri: file.uri,
      title
    });
    await new systemShare.ShareController(data).show(context, {
      selectionMode: systemShare.SelectionMode.SINGLE,
      previewMode: systemShare.SharePreviewMode.DEFAULT
    });
  }

  static async openExternalLink(context: common.UIAbilityContext, url: string): Promise<void> {
    const normalized = String(url ?? '').trim();
    if (!normalized.startsWith('https://') && !normalized.startsWith('http://')) {
      throw new Error('为保护设备，只允许打开 HTTP 或 HTTPS 链接');
    }
    await context.startAbility({
      action: 'ohos.want.action.viewData',
      uri: normalized,
      type: 'text/html'
    });
  }

  private static async downloadImage(imageUrl: string, bridgeToken: string): Promise<DownloadedImage> {
    if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
      throw new Error('图片地址不可分享');
    }
    const request = http.createHttp();
    const headers: Record<string, string> = {};
    if (bridgeToken.length > 0) {
      headers['X-Codex-Bridge-Token'] = bridgeToken;
    }
    const bridgeOtp = await TotpGenerator.currentCode(CredentialRuntime.getRuntimeTotpSecret());
    if (bridgeOtp.length > 0) {
      headers['X-Codex-Bridge-OTP'] = bridgeOtp;
    }
    try {
      const response = await request.request(imageUrl, {
        method: http.RequestMethod.GET,
        header: headers,
        connectTimeout: 15000,
        readTimeout: 30000,
        expectDataType: http.HttpDataType.ARRAY_BUFFER
      });
      if (response.responseCode < 200 || response.responseCode >= 300) {
        throw new Error(`读取图片失败：HTTP ${response.responseCode}`);
      }
      if (!(response.result instanceof ArrayBuffer)) {
        throw new Error('读取图片失败：响应不是二进制图片');
      }
      const format = ContentActionService.imageFormat(imageUrl);
      return {
        bytes: response.result,
        extension: format === 'png' ? 'png' : 'jpg',
        utd: format === 'png' ? 'general.png' : 'general.jpeg'
      };
    } finally {
      request.destroy();
    }
  }

  private static imageFormat(imageUrl: string): string {
    const path = imageUrl.split('?')[0].toLowerCase();
    return path.endsWith('.png') ? 'png' : 'jpeg';
  }

  private static safeLocalFileName(value: string): string {
    const safe = String(value ?? 'download')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120);
    return safe || `download-${Date.now()}`;
  }
}
