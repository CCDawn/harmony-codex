import { http } from '@kit.NetworkKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import { BridgeCredential } from './BridgeCredentialStore';
import { PairingPayload } from '../utils/PairingPayload';

const PAIRING_APP_VERSION: string = '1.0.14';
const PAIRING_DEVICE_NAME_MAX_LENGTH: number = 64;

interface PairEnrollSuccess {
  deviceId?: string;
  deviceName?: string;
  pairedAt?: string;
  token?: string;
  totpSecret?: string;
}

interface PairEnrollFailure {
  error?: string;
  reason?: string;
}

/**
 * 配对服务：POST {bridgeUrl}/pair/enroll。
 * 契约红线：此端点不带任何鉴权头（无 X-Codex-Bridge-Token / X-Codex-Bridge-OTP）；
 * 错误提示与日志不得输出 token / totpSecret 值。
 */
export class BridgePairingService {
  static async enroll(bridgeUrl: string, pairingCode: string, deviceName: string): Promise<BridgeCredential> {
    const base = BridgePairingService.normalizeBaseUrl(bridgeUrl);
    if (base.length === 0) {
      throw new Error('配对地址无效：请填写 http:// 或 https:// 开头的桥接地址');
    }
    const code = PairingPayload.normalizeCode(pairingCode);
    if (code.length === 0) {
      throw new Error('配对码格式不正确：应为 10 位字母数字（可含连字符）');
    }
    const client = http.createHttp();
    try {
      const response = await client.request(`${base}/pair/enroll`, {
        method: http.RequestMethod.POST,
        header: {
          'Content-Type': 'application/json; charset=utf-8'
        },
        extraData: JSON.stringify({
          pairingCode: code,
          deviceName: BridgePairingService.safeDeviceName(deviceName),
          appVersion: PAIRING_APP_VERSION
        }),
        connectTimeout: 8000,
        readTimeout: 15000
      });
      const raw = typeof response.result === 'string' ? response.result : String(response.result ?? '');
      if (response.responseCode < 200 || response.responseCode >= 300) {
        throw new Error(BridgePairingService.failureMessage(
          response.responseCode,
          raw,
          BridgePairingService.headerValue(response.header, 'retry-after')
        ));
      }
      return BridgePairingService.credentialFromEnroll(raw, base);
    } finally {
      try {
        client.destroy();
      } catch (_) {
      }
    }
  }

  static normalizeBaseUrl(value: string): string {
    const trimmed = String(value ?? '').trim().replace(/\/+$/, '');
    return /^https?:\/\//.test(trimmed) ? trimmed : '';
  }

  static localDeviceName(): string {
    try {
      const marketName = String(deviceInfo.marketName ?? '').trim();
      if (marketName.length > 0) {
        return marketName.slice(0, PAIRING_DEVICE_NAME_MAX_LENGTH);
      }
    } catch (_) {
    }
    return 'HarmonyOS 设备';
  }

  static safeDeviceName(value: string): string {
    const name = String(value ?? '').trim();
    const effective = name.length > 0 ? name : 'HarmonyOS 设备';
    return effective.slice(0, PAIRING_DEVICE_NAME_MAX_LENGTH);
  }

  static failureMessage(responseCode: number, rawBody: string, retryAfterSeconds: string = ''): string {
    if (responseCode === 401) {
      return BridgePairingService.pairingFailureMessage(rawBody);
    }
    if (responseCode === 429) {
      const seconds = Number(retryAfterSeconds);
      if (Number.isFinite(seconds) && seconds > 0) {
        return `配对尝试过于频繁，请约 ${Math.ceil(seconds)} 秒后再试`;
      }
      return '配对尝试过于频繁，请稍后再试';
    }
    if (responseCode === 400) {
      return '配对请求无效：请重新扫码或检查配对码与桥接地址';
    }
    return `配对失败：HTTP ${responseCode}`;
  }

  private static pairingFailureMessage(rawBody: string): string {
    let reason = '';
    try {
      const parsed = JSON.parse(rawBody) as PairEnrollFailure;
      reason = String(parsed.reason ?? '').trim();
    } catch (_) {
    }
    if (reason === 'code_expired') {
      return '配对码已过期，请在电脑端重新生成后再试';
    }
    if (reason === 'code_consumed') {
      return '配对码已被使用，请在电脑端重新生成后再试';
    }
    return '配对码不正确，请核对后重新输入';
  }

  private static credentialFromEnroll(rawBody: string, bridgeUrl: string): BridgeCredential {
    const parsed = JSON.parse(rawBody) as PairEnrollSuccess;
    const deviceId = String(parsed.deviceId ?? '').trim();
    const token = String(parsed.token ?? '').trim();
    const totpSecret = String(parsed.totpSecret ?? '').trim();
    if (deviceId.length === 0 || token.length === 0 || totpSecret.length === 0) {
      throw new Error('配对响应不完整：缺少设备凭证字段');
    }
    const credential: BridgeCredential = {
      deviceId,
      deviceName: BridgePairingService.safeDeviceName(String(parsed.deviceName ?? '')),
      bridgeUrl,
      token,
      totpSecret,
      pairedAt: String(parsed.pairedAt ?? '').trim()
    };
    return credential;
  }

  private static headerValue(header: Object | undefined, needle: string): string {
    if (!header) {
      return '';
    }
    try {
      const headers = header as Record<string, string>;
      const keys = Object.keys(headers);
      for (let i = 0; i < keys.length; i += 1) {
        if (keys[i].toLowerCase() === needle) {
          return String(headers[keys[i]] ?? '').trim();
        }
      }
    } catch (_) {
    }
    return '';
  }
}
