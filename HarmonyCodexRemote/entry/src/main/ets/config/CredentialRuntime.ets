import { BridgeCredential } from '../services/BridgeCredentialStore';
import { DEFAULT_BRIDGE_TOKEN, DEFAULT_BRIDGE_TOTP_SECRET, DEFAULT_BRIDGE_URL } from './BridgeConfig';

/**
 * 运行时密钥访问器：配对凭证的进程内单例读点。
 * 原先直接 import 烘焙常量的消费方（BridgeClient / ContentActionService / Index / 桌面卡片）
 * 一律改走这里；未配对或对应字段为空时回落烘焙常量，保持旧行为。
 */
export class CredentialRuntime {
  private static credential: BridgeCredential | null = null;

  static setRuntimeCredential(credential: BridgeCredential | null): void {
    CredentialRuntime.credential = credential;
  }

  static getRuntimeCredential(): BridgeCredential | null {
    return CredentialRuntime.credential;
  }

  static getRuntimeTotpSecret(): string {
    const credential = CredentialRuntime.credential;
    if (credential !== null && credential.totpSecret.trim().length > 0) {
      return credential.totpSecret;
    }
    return DEFAULT_BRIDGE_TOTP_SECRET;
  }

  static getRuntimeToken(): string {
    const credential = CredentialRuntime.credential;
    if (credential !== null && credential.token.trim().length > 0) {
      return credential.token;
    }
    return DEFAULT_BRIDGE_TOKEN;
  }

  static getRuntimeBridgeUrl(): string {
    const credential = CredentialRuntime.credential;
    if (credential !== null && credential.bridgeUrl.trim().length > 0) {
      return credential.bridgeUrl;
    }
    return DEFAULT_BRIDGE_URL;
  }
}
