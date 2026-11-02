import { constants, createPrivateKey, sign } from 'node:crypto';

const PUSH_ORIGIN = 'https://push-api.cloud.huawei.com';
const JWT_AUDIENCE = 'https://oauth-login.cloud.huawei.com/oauth2/v3/token';
const SUCCESS_CODE = '80000000';
const KNOWN_REJECTION_CODES = new Set(['80200005', '80300002', '80300007']);
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;
const STATUS_COPY = Object.freeze({
  completed: '本轮任务已完成，点击查看。',
  failed: '本轮任务执行失败，点击查看状态。',
  user_input_required: '有一项输入需要你处理，点击查看。',
  approval_required: '有一项操作需要你审批，点击查看。'
});

// This client sends no chat content and deliberately retains no public account
// object. Serializing it cannot accidentally disclose a key or sub-account.
export class HuaweiPushClient {
  #account;
  #key;
  #fetch;
  #now;
  #category;
  #testMessage;

  constructor({ serviceAccount, category = 'WORK', testMessage = true, fetchImpl = globalThis.fetch,
    now = () => Date.now() } = {}) {
    try {
      if (!serviceAccount || typeof serviceAccount !== 'object'
        || !/^[A-Za-z0-9_.-]{1,128}$/.test(serviceAccount.project_id)
        || typeof serviceAccount.project_id !== 'string'
        || !validText(serviceAccount.key_id, 1024) || !validText(serviceAccount.sub_account, 1024)
        || typeof serviceAccount.private_key !== 'string') throw new Error('Invalid account');
      const key = createPrivateKey(serviceAccount.private_key);
      if (!['rsa', 'rsa-pss'].includes(key.asymmetricKeyType)) throw new Error('Invalid signing algorithm');
      this.#account = { projectId: serviceAccount.project_id, keyId: serviceAccount.key_id,
        issuer: serviceAccount.sub_account };
      this.#key = key;
    } catch {
      // crypto errors may contain PEM/input details. Never retain their cause.
      throw clientError('Huawei push service account is invalid', 'HUAWEI_PUSH_ACCOUNT_INVALID', false, 503);
    }
    if (!validText(category, 128) || typeof testMessage !== 'boolean'
      || typeof fetchImpl !== 'function' || typeof now !== 'function') {
      throw clientError('Huawei push client configuration is invalid', 'HUAWEI_PUSH_CONFIG_INVALID', false, 503);
    }
    this.#category = category;
    this.#testMessage = testMessage;
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  async send({ token, event } = {}) {
    if (!validText(token, 8192) || !event || !Object.hasOwn(STATUS_COPY, event.type)
      || !validText(event.threadId, 256) || !validText(event.turnId, 256)
      || typeof event.eventId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(event.eventId)) {
      throw clientError('Invalid mobile push notification input', 'HUAWEI_PUSH_INPUT_INVALID', false, 400);
    }
    const body = {
      payload: {
        notification: {
          title: 'Codex 远程', body: STATUS_COPY[event.type], category: this.#category,
          foregroundShow: false, appMessageId: event.eventId,
          clickAction: {
            actionType: 0,
            data: {
              codexRemoteNotificationSessionId: event.threadId,
              codexRemoteNotificationEventType: event.type,
              codexRemoteNotificationEventId: event.eventId,
              codexRemoteNotificationRevision: event.eventId
            }
          }
        }
      },
      target: { token: [token] },
      pushOptions: { testMessage: this.#testMessage, ttl: 86400 }
    };
    const authorization = this.#createAuthorization();
    let response;
    let result;
    try {
      response = await this.#fetch(`${PUSH_ORIGIN}/v3/${this.#account.projectId}/messages:send`, {
        method: 'POST',
        headers: { 'push-type': '0', 'Content-Type': 'application/json', Authorization: authorization },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error'
      });
      result = await response.json();
    } catch {
      // A lost HTTP acknowledgement cannot prove that Huawei did not accept it.
      throw clientError('Huawei push delivery result is uncertain', 'HUAWEI_PUSH_TRANSPORT_UNCERTAIN', true);
    }
    const code = typeof result?.code === 'string' && /^[0-9]{8}$/.test(result.code) ? result.code : null;
    const httpSuccess = response.ok === true && response.status >= 200 && response.status < 300;
    if (httpSuccess && code === SUCCESS_CODE) return { accepted: true, code };
    const knownRejection = KNOWN_REJECTION_CODES.has(code) && response.status < 500;
    // msg can include illegalTokens with full device tokens; never expose it,
    // raw responses, headers, requestId, or the underlying exception.
    throw clientError(knownRejection ? 'Huawei push request was rejected' : 'Huawei push delivery result is uncertain',
      code ?? 'HUAWEI_PUSH_RESPONSE_INVALID', !knownRejection);
  }

  #createAuthorization() {
    try {
      const issuedAt = Math.floor(Number(this.#now()) / 1000);
      if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error('Invalid clock');
      const header = base64url({ alg: 'PS256', typ: 'JWT', kid: this.#account.keyId });
      const payload = base64url({ iss: this.#account.issuer, aud: JWT_AUDIENCE, iat: issuedAt, exp: issuedAt + 3600 });
      const input = `${header}.${payload}`;
      const signature = sign('sha256', Buffer.from(input), {
        key: this.#key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32
      }).toString('base64url');
      return `Bearer ${input}.${signature}`;
    } catch {
      throw clientError('Huawei push authorization could not be created', 'HUAWEI_PUSH_AUTH_INVALID', false, 503);
    }
  }
}

function validText(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength && !CONTROLS.test(value);
}

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function clientError(message, code, deliveryUncertain, statusCode = 502) {
  return Object.assign(new Error(message), { code, statusCode, deliveryUncertain, retryable: false });
}
