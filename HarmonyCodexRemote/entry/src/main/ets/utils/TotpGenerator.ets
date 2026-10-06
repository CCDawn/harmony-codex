import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { util } from '@kit.ArkTS';

const BASE32_ALPHABET: string = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_TIME_STEP_SECONDS: number = 30;
const TOTP_DIGITS: number = 6;

/**
 * RFC 6238 TOTP 动态验证码生成器（HMAC-SHA1，6 位数字，30 秒步长）。
 * 密钥默认按 RFC 4648 Base32 解码（A-Z、2-7，忽略空格/连字符与结尾 =），
 * 若密钥不是合法 Base32 则回退为 UTF-8 字节，便于直接使用任意随机字符串密钥。
 * 红线：本模块任何日志与错误信息不得输出 OTP 明文与 secret。
 */
export class TotpGenerator {
  private static cachedSecret: string = '';
  private static cachedCounter: number = -1;
  private static cachedCode: string = '';

  static async currentCode(secret: string): Promise<string> {
    const trimmed = String(secret ?? '').trim();
    if (trimmed.length === 0) {
      return '';
    }
    const counter = Math.floor(Date.now() / 1000 / TOTP_TIME_STEP_SECONDS);
    if (trimmed === TotpGenerator.cachedSecret && counter === TotpGenerator.cachedCounter
      && TotpGenerator.cachedCode.length > 0) {
      return TotpGenerator.cachedCode;
    }
    const code = await TotpGenerator.generateCode(trimmed, counter);
    TotpGenerator.cachedSecret = trimmed;
    TotpGenerator.cachedCounter = counter;
    TotpGenerator.cachedCode = code;
    return code;
  }

  private static async generateCode(secret: string, counter: number): Promise<string> {
    const keyBytes = TotpGenerator.decodeSecret(secret);
    if (keyBytes.length === 0) {
      throw new Error('动态验证码密钥为空，无法生成验证码');
    }
    try {
      const keyGenerator = cryptoFramework.createSymKeyGenerator('HMAC');
      const symKey = await keyGenerator.convertKey({ data: keyBytes });
      const mac = cryptoFramework.createMac('SHA1');
      await mac.init(symKey);
      await mac.update({ data: TotpGenerator.counterBytes(counter) });
      const digest = await mac.doFinal();
      return TotpGenerator.truncateToCode(digest.data);
    } catch (error) {
      const err = error as Error;
      throw new Error(`动态验证码生成失败：${err.message}`);
    }
  }

  private static decodeSecret(secret: string): Uint8Array {
    const base32 = TotpGenerator.decodeBase32(secret);
    if (base32 !== null) {
      return base32;
    }
    const encoder = new util.TextEncoder();
    return encoder.encodeInto(secret);
  }

  private static decodeBase32(value: string): Uint8Array | null {
    const normalized = String(value ?? '').toUpperCase().replace(/[\s-]/g, '');
    const stripped = normalized.replace(/=+$/g, '');
    if (stripped.length === 0) {
      return null;
    }
    let buffer = 0;
    let bitCount = 0;
    const bytes: number[] = [];
    for (let i = 0; i < stripped.length; i += 1) {
      const index = BASE32_ALPHABET.indexOf(stripped.charAt(i));
      if (index < 0) {
        return null;
      }
      buffer = (buffer << 5) | index;
      bitCount += 5;
      if (bitCount >= 8) {
        bytes.push((buffer >>> (bitCount - 8)) & 0xff);
        bitCount -= 8;
      }
    }
    return new Uint8Array(bytes);
  }

  private static counterBytes(counter: number): Uint8Array {
    const bytes = new Uint8Array(8);
    let value = Math.max(0, Math.floor(counter));
    for (let i = 7; i >= 0; i -= 1) {
      bytes[i] = value & 0xff;
      value = Math.floor(value / 256);
    }
    return bytes;
  }

  private static truncateToCode(digest: Uint8Array): string {
    if (digest.length < 20) {
      throw new Error('动态验证码摘要长度异常');
    }
    const offset = digest[19] & 0x0f;
    const binary = ((digest[offset] & 0x7f) << 24)
      | ((digest[offset + 1] & 0xff) << 16)
      | ((digest[offset + 2] & 0xff) << 8)
      | (digest[offset + 3] & 0xff);
    const code = binary % 1000000;
    return code.toString().padStart(TOTP_DIGITS, '0');
  }
}
