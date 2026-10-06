export const DEFAULT_BRIDGE_URL: string = 'http://127.0.0.1:8787';
export const DEFAULT_BRIDGE_TOKEN: string = '';
// TOTP 动态验证码密钥（RFC 6238，HMAC-SHA1，6 位数字，30 秒步长）。
// 与电脑端 CODEX_BRIDGE_TOTP_SECRET 保持一致；留空 = 不发送动态验证码（与未启用时行为一致）。
// 生成方式示例：openssl rand -hex 20，或任意随机字符串；App 端优先按 Base32（A-Z、2-7）解码，否则按 UTF-8 字节处理。
// 部署注入：tools/harmony/deploy.ps1 -BridgeTotpSecret 或环境变量 CODEX_BRIDGE_TOTP_SECRET。
export const DEFAULT_BRIDGE_TOTP_SECRET: string = '';
export const DEFAULT_LOG_UPLOAD_INTERVAL_MS: number = 5000;
export const DEFAULT_SESSION_REFRESH_INTERVAL_MS: number = 2500;
export const DEFAULT_TASK_REFRESH_INTERVAL_MS: number = 1200;
export const DEFAULT_LINK_STATUS_INTERVAL_MS: number = 5000;
export const DEFAULT_SCREENSHOT_MAX_WIDTH: number = 3840;
