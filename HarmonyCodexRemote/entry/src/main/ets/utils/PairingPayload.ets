/**
 * 配对二维码 payload（v1）解析：
 *   codexharmony://pair?v=1&u=<encodeURIComponent(bridgeUrl)>&c=<pairingCode>
 * 纯函数、零 Kit 依赖：非法输入返回 null，不抛异常，便于 node 测试真跑。
 * 配对码为 10 字符去混淆 base32，展示格式 XXXXX-XXXXX。
 */
const PAIRING_SCHEME: string = 'codexharmony';
const PAIRING_HOST: string = 'pair';
const PAIRING_VERSION: string = '1';
const PAIRING_CODE_ALPHABET: string = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PAIRING_CODE_LENGTH: number = 10;
const PAIRING_MAX_RAW_LENGTH: number = 2048;

export interface PairingPayloadInfo {
  bridgeUrl: string;
  pairingCode: string;
}

export class PairingPayload {
  static parse(raw: string): PairingPayloadInfo | null {
    const text = String(raw ?? '').trim();
    if (text.length === 0 || text.length > PAIRING_MAX_RAW_LENGTH) {
      return null;
    }
    const questionIndex = text.indexOf('?');
    if (questionIndex < 0) {
      return null;
    }
    if (text.slice(0, questionIndex).toLowerCase() !== `${PAIRING_SCHEME}://${PAIRING_HOST}`) {
      return null;
    }
    const params = PairingPayload.queryParams(text.slice(questionIndex + 1));
    if (params.get('v') !== PAIRING_VERSION) {
      return null;
    }
    const bridgeUrlRaw = params.get('u') ?? '';
    const codeRaw = params.get('c') ?? '';
    if (bridgeUrlRaw.length === 0 || codeRaw.length === 0) {
      return null;
    }
    let bridgeUrl = '';
    try {
      bridgeUrl = decodeURIComponent(bridgeUrlRaw).trim();
    } catch (_) {
      return null;
    }
    if (!bridgeUrl.startsWith('https://') && !bridgeUrl.startsWith('http://')) {
      return null;
    }
    const pairingCode = PairingPayload.normalizeCode(codeRaw);
    if (pairingCode.length === 0) {
      return null;
    }
    const info: PairingPayloadInfo = {
      bridgeUrl,
      pairingCode
    };
    return info;
  }

  static normalizeCode(value: string): string {
    const normalized = String(value ?? '').trim().toUpperCase().replace(/-/g, '');
    if (normalized.length !== PAIRING_CODE_LENGTH) {
      return '';
    }
    for (let i = 0; i < normalized.length; i += 1) {
      if (PAIRING_CODE_ALPHABET.indexOf(normalized.charAt(i)) < 0) {
        return '';
      }
    }
    return normalized;
  }

  static formatCodeDisplay(code: string): string {
    const normalized = PairingPayload.normalizeCode(code);
    if (normalized.length === 0) {
      return '';
    }
    return `${normalized.slice(0, 5)}-${normalized.slice(5, PAIRING_CODE_LENGTH)}`;
  }

  private static queryParams(query: string): Map<string, string> {
    const params = new Map<string, string>();
    const parts = query.split('&');
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (part.length === 0) {
        continue;
      }
      const eq = part.indexOf('=');
      const key = eq >= 0 ? part.slice(0, eq) : part;
      const value = eq >= 0 ? part.slice(eq + 1) : '';
      if (key.length > 0 && !params.has(key)) {
        params.set(key, value);
      }
    }
    return params;
  }
}
