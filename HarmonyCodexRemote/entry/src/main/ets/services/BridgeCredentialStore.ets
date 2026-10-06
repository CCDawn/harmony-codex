import { common } from '@kit.AbilityKit';
import { asset } from '@kit.AssetStoreKit';
import { util } from '@kit.ArkTS';

const CREDENTIAL_ALIAS: string = 'codex_bridge_credential';

/**
 * 设备配对凭证：扫码配对成功后由电脑端 /pair/enroll 返回。
 */
export interface BridgeCredential {
  deviceId: string;
  deviceName: string;
  bridgeUrl: string;
  token: string;
  totpSecret: string;
  pairedAt: string;
}

interface CredentialJson {
  deviceId?: string;
  deviceName?: string;
  bridgeUrl?: string;
  token?: string;
  totpSecret?: string;
  pairedAt?: string;
}

/**
 * 凭证仓库：凭证 JSON 整体作为 SECRET 存入系统 Asset Store Kit。
 * 设计红线：凭证本体不进 preferences 明文；不设持久化标记（卸载即清除是设计决策）；
 * 任何日志与错误信息不得输出 token / totpSecret 值。
 */
export class BridgeCredentialStore {
  static async loadCredential(context: common.Context): Promise<BridgeCredential | null> {
    const query: asset.AssetMap = new Map<asset.Tag, asset.Value>();
    query.set(asset.Tag.ALIAS, BridgeCredentialStore.textToBytes(CREDENTIAL_ALIAS));
    query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
    let results: asset.AssetMap[] = [];
    try {
      results = await asset.query(query);
    } catch (error) {
      // 查无此条（未配对）与其它错误码统一容错为 null，不影响启动与配对引导流程
      const err = error as Error;
      console.warn(`bridge credential load failed: message=${err.message}`);
      return null;
    }
    if (results.length === 0) {
      return null;
    }
    const secret = results[0].get(asset.Tag.SECRET);
    if (!(secret instanceof Uint8Array)) {
      return null;
    }
    return BridgeCredentialStore.credentialFromBytes(secret);
  }

  static async saveCredential(context: common.Context, credential: BridgeCredential): Promise<void> {
    await BridgeCredentialStore.removeCredentialQuietly();
    const attributes: asset.AssetMap = new Map<asset.Tag, asset.Value>();
    attributes.set(asset.Tag.ALIAS, BridgeCredentialStore.textToBytes(CREDENTIAL_ALIAS));
    attributes.set(asset.Tag.SECRET, BridgeCredentialStore.credentialToBytes(credential));
    attributes.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_FIRST_UNLOCKED);
    try {
      await asset.add(attributes);
    } catch (_) {
      // 极端竞态下别名已存在则覆盖写入，保证保存幂等
      const query: asset.AssetMap = new Map<asset.Tag, asset.Value>();
      query.set(asset.Tag.ALIAS, BridgeCredentialStore.textToBytes(CREDENTIAL_ALIAS));
      await asset.update(query, attributes);
    }
  }

  static async clearCredential(context: common.Context): Promise<void> {
    await BridgeCredentialStore.removeCredentialQuietly();
  }

  private static async removeCredentialQuietly(): Promise<void> {
    const query: asset.AssetMap = new Map<asset.Tag, asset.Value>();
    query.set(asset.Tag.ALIAS, BridgeCredentialStore.textToBytes(CREDENTIAL_ALIAS));
    try {
      await asset.remove(query);
    } catch (_) {
      // 别名不存在（未配对）视为已删除
    }
  }

  private static textToBytes(value: string): Uint8Array {
    const encoder = new util.TextEncoder();
    return encoder.encodeInto(value);
  }

  private static credentialToBytes(credential: BridgeCredential): Uint8Array {
    const encoder = new util.TextEncoder();
    return encoder.encodeInto(JSON.stringify(credential));
  }

  private static credentialFromBytes(bytes: Uint8Array): BridgeCredential | null {
    try {
      const decoder = new util.TextDecoder();
      const parsed = JSON.parse(decoder.decodeToString(bytes)) as CredentialJson;
      const deviceId = String(parsed.deviceId ?? '').trim();
      const token = String(parsed.token ?? '').trim();
      const totpSecret = String(parsed.totpSecret ?? '').trim();
      if (deviceId.length === 0 || token.length === 0 || totpSecret.length === 0) {
        return null;
      }
      const credential: BridgeCredential = {
        deviceId,
        deviceName: String(parsed.deviceName ?? '').trim(),
        bridgeUrl: String(parsed.bridgeUrl ?? '').trim(),
        token,
        totpSecret,
        pairedAt: String(parsed.pairedAt ?? '').trim()
      };
      return credential;
    } catch (_) {
      return null;
    }
  }
}
