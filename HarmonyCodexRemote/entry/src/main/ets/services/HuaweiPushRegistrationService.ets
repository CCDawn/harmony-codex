import { UIAbility, common } from '@kit.AbilityKit';
import { pushService } from '@kit.PushKit';
import { preferences } from '@kit.ArkData';
import { util } from '@kit.ArkTS';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { BridgeClient } from './BridgeClient';
import { AppNotificationService } from './AppNotificationService';

interface PushBridgeTarget {
  url: string;
  token: string;
  threadIds: string[];
}

const PREFERENCES_NAME = 'codex_remote_push';
const STATE_KEY = 'codexRemotePushState';

/** All native, preference and server mutations share one operation queue. */
class PushRegistrationLifecycle {
  private ability: UIAbility | null = null;
  private settings: preferences.Preferences | null = null;
  private operations: Promise<void> = Promise.resolve();
  private installationId: string = '';
  private enabled: boolean = true;
  private enabledIntent: boolean | null = null;
  private listening: boolean = false;
  private token: string = '';
  private tokenRevision: number = 0;
  private nativeAttempted: boolean = false;
  private revoking: boolean = false;
  private refreshAfterRotation: boolean = false;
  private authorityHash: string = '';
  private blockedAuthority: string = '';
  private configurationKnown: boolean = false;
  private target: PushBridgeTarget | null = null;
  // At most one attempted registration retains credentials, only in memory.
  private knownTarget: PushBridgeTarget | null = null;
  private registeredKey: string = '';
  private remoteReady: boolean = false;
  private readyThreadIds: string[] = [];

  private readonly tokenUpdated = (value: string): void => {
    if (!this.enabled || this.revoking || value.length === 0 || value === this.token) return;
    this.tokenRevision += 1;
    this.token = value;
    this.nativeAttempted = true;
    this.refreshAfterRotation = false;
    this.registeredKey = '';
    this.publish('connecting');
    void this.enqueue(async (): Promise<void> => { await this.reconcile(); });
  };

  attach(ability: UIAbility): Promise<void> {
    if (this.ability !== ability) this.detach();
    this.ability = ability;
    return this.enqueue(async (): Promise<void> => {
      await this.initialize(ability.context);
      if (this.ability !== ability) return;
      // Disabled cold starts still listen, so a later enable has a listener.
      this.ensureListening();
      if (!this.enabled) { this.publish('disabled'); return; }
      if (!this.token && !this.nativeAttempted) this.publish('connecting');
      await this.acquireToken();
      await this.reconcile();
    });
  }

  configure(url: string, token: string, threadIds: string[]): void {
    this.configurationKnown = true;
    const ids = Array.from(new Set<string>(threadIds.map((id: string) => id.toLowerCase()))).filter((id: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)).slice(0, 100).sort();
    const nextUrl = url.replace(/\/+$/, '');
    const previous = this.target;
    if (previous?.url !== nextUrl || previous?.token !== token
      || JSON.stringify(previous?.threadIds) !== JSON.stringify(ids)) {
      this.target = nextUrl && token ? { url: nextUrl, token, threadIds: ids } : null;
      if (previous?.url !== this.target?.url || previous?.token !== this.target?.token) {
        this.registeredKey = '';
        if (!this.enabled) this.publish('disabled');
        else if (this.token || !this.nativeAttempted) this.publish('connecting');
        else {
          // A late dashboard configuration must preserve native failure copy.
          this.remoteReady = false;
          this.readyThreadIds = [];
          AppNotificationService.setRemotePushEnabled(false);
        }
      } else {
        // A replacement may reach the server even if its acknowledgement is lost.
        this.readyThreadIds = this.readyThreadIds.filter((id: string) => ids.includes(id));
        AppNotificationService.setRemotePushEnabled(this.remoteReady, this.readyThreadIds);
      }
    }
    // Dashboard refresh retries bridge I/O with a cached token only.
    void this.enqueue(async (): Promise<void> => { await this.reconcile(); });
  }

  enable(context: common.UIAbilityContext): Promise<void> {
    this.enabledIntent = true;
    this.enabled = true;
    const cachedRegistrationKey = this.registeredKey;
    return this.enqueue(async (): Promise<void> => {
      await this.initialize(context);
      await this.save('enabled', true);
      this.ensureListening();
      if (!this.enabled) return;
      // Reuse a registration completed after this request; otherwise refresh it.
      if (this.registeredKey === cachedRegistrationKey) this.registeredKey = '';
      this.blockedAuthority = '';
      if (!this.token) { this.nativeAttempted = false; this.publish('connecting'); }
      await this.acquireToken();
      await this.reconcile();
    });
  }

  disable(context: common.UIAbilityContext): Promise<void> {
    this.enabledIntent = false;
    this.enabled = false;
    this.publish('disabled');
    return this.enqueue(async (): Promise<void> => {
      // This runs after every already-issued POST; its DELETE is final.
      try {
        await this.initialize(context);
        await this.save('enabled', false);
      } finally {
        await this.removeKnownTarget();
        if (this.target && !this.knownTarget) await this.removeTarget(this.target);
        // A failed/offline server DELETE must never skip native revocation.
        await this.revokeToken(false);
        if (!this.enabled) this.publish('disabled');
      }
    });
  }

  detach(): void {
    if (this.listening) {
      try { pushService.off('tokenUpdate', this.tokenUpdated); } catch (_) {}
      this.listening = false;
    }
    this.ability = null;
    // Cloud delivery must survive ability/process destruction.
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.operations.then(operation);
    this.operations = pending.catch((): void => {
      if (this.enabled) this.publish('unavailable');
    });
    return pending;
  }

  private async initialize(context: common.UIAbilityContext): Promise<void> {
    if (this.settings) return;
    const settings = await preferences.getPreferences(context, { name: PREFERENCES_NAME });
    const savedEnabled = (await settings.get('enabled', true)) === true;
    let id = String(await settings.get('installationId', ''));
    if (!id) {
      id = util.generateRandomUUID();
      await settings.put('installationId', id);
      await settings.flush();
    }
    this.installationId = id;
    this.authorityHash = String(await settings.get('authorityHash', ''));
    this.enabled = this.enabledIntent === null ? savedEnabled : this.enabledIntent;
    this.settings = settings;
  }

  private ensureListening(): void {
    if (!this.listening && this.ability) {
      pushService.on('tokenUpdate', this.ability, this.tokenUpdated);
      this.listening = true;
    }
  }

  private async save(key: string, value: preferences.ValueType): Promise<void> {
    if (!this.settings) return;
    await this.settings.put(key, value);
    await this.settings.flush();
  }

  private async acquireToken(): Promise<void> {
    if (!this.enabled || this.token || this.nativeAttempted) return;
    this.nativeAttempted = true;
    this.refreshAfterRotation = false;
    const revision = this.tokenRevision;
    try {
      const value = await pushService.getToken();
      if (!this.enabled || revision !== this.tokenRevision) return;
      if (!value) { this.publish('unavailable'); return; }
      this.token = value;
    } catch (error) {
      if (!this.enabled || revision !== this.tokenRevision) return;
      const code = (error as BusinessError).code;
      this.publish(code === 1000900012 ? 'activation_required'
        : code === 1000900010 ? 'profile_required' : 'unavailable');
    }
  }

  private async hashAuthority(target: PushBridgeTarget): Promise<string> {
    const digest = cryptoFramework.createMd('SHA256');
    await digest.update({ data: new util.TextEncoder().encodeInto(JSON.stringify([target.url, target.token])) });
    const result = await digest.digest();
    let hex = '';
    for (let index = 0; index < result.data.length; index += 1) {
      hex += result.data[index].toString(16).padStart(2, '0');
    }
    return hex;
  }

  private async removeTarget(target: PushBridgeTarget): Promise<void> {
    if (!this.installationId) return;
    try { await BridgeClient.unregisterMobilePush(target.url, target.token, this.installationId); } catch (_) {}
  }

  private async removeKnownTarget(): Promise<void> {
    if (this.knownTarget) await this.removeTarget(this.knownTarget);
  }

  private async revokeToken(refresh: boolean): Promise<void> {
    this.revoking = true;
    this.tokenRevision += 1;
    this.token = '';
    this.registeredKey = '';
    this.remoteReady = false;
    this.readyThreadIds = [];
    AppNotificationService.setRemotePushEnabled(false);
    try {
      await pushService.deleteToken();
      this.knownTarget = null;
      // An empty durable hash means the previous token is already revoked.
      this.authorityHash = '';
      await this.save('authorityHash', '');
      this.nativeAttempted = !refresh;
      this.refreshAfterRotation = refresh;
    } finally { this.revoking = false; }
  }

  private async reconcile(): Promise<void> {
    if (!this.settings || !this.enabled) return;
    const target = this.target;
    if (!target) {
      // A cold start waits for the first trusted host/session configuration.
      if (!this.configurationKnown) return;
      if ((this.knownTarget || this.authorityHash) && this.blockedAuthority !== 'unconfigured') {
        this.blockedAuthority = 'unconfigured';
        await this.removeKnownTarget();
        await this.revokeToken(true);
        this.blockedAuthority = '';
      }
      return;
    }
    const hash = await this.hashAuthority(target);
    if (!this.enabled || target !== this.target) return;
    if (this.authorityHash && this.authorityHash !== hash) {
      if (this.blockedAuthority === hash) return;
      this.blockedAuthority = hash;
      await this.removeKnownTarget();
      await this.revokeToken(true);
      this.blockedAuthority = '';
      if (!this.enabled || target !== this.target) return;
    }
    if (!this.authorityHash) {
      this.authorityHash = hash;
      await this.save('authorityHash', hash);
    }
    if (!this.enabled || target !== this.target) return;
    if (this.refreshAfterRotation) await this.acquireToken();
    if (!this.enabled || target !== this.target || !this.token || !this.installationId) return;
    const token = this.token;
    const key = JSON.stringify([target.url, target.token, token, target.threadIds]);
    if (key === this.registeredKey) return;
    // Keep credentials even when POST fails: the server may have accepted it.
    this.knownTarget = target;
    try {
      const result = await BridgeClient.registerMobilePush(target.url, target.token,
        this.installationId, token, target.threadIds);
      if (!this.enabled || target !== this.target || token !== this.token) return;
      const ready = result.registration?.ready === true && result.configured === true;
      // A setup-only acknowledgement must not block later configuration recovery.
      this.registeredKey = ready ? key : '';
      if (ready) this.readyThreadIds = [...target.threadIds];
      this.publish(ready ? 'ready' : 'server_setup_required');
    } catch (_) {
      if (this.enabled && target === this.target && token === this.token) this.publish('reconnecting', true);
    }
  }

  private publish(state: string, preserveReady: boolean = false): void {
    this.remoteReady = state === 'ready' || (preserveReady && this.remoteReady);
    if (!this.remoteReady) this.readyThreadIds = [];
    AppStorage.setOrCreate<string>(STATE_KEY, state);
    AppNotificationService.setRemotePushEnabled(this.remoteReady, this.readyThreadIds);
  }
}

export class HuaweiPushRegistrationService {
  private static readonly lifecycle: PushRegistrationLifecycle = new PushRegistrationLifecycle();

  static attach(ability: UIAbility): Promise<void> { return HuaweiPushRegistrationService.lifecycle.attach(ability); }
  static configure(url: string, authToken: string, threadIds: string[]): void {
    HuaweiPushRegistrationService.lifecycle.configure(url, authToken, threadIds);
  }
  static enable(context: common.UIAbilityContext): Promise<void> { return HuaweiPushRegistrationService.lifecycle.enable(context); }
  static disable(context: common.UIAbilityContext): Promise<void> { return HuaweiPushRegistrationService.lifecycle.disable(context); }
  static detach(): void { HuaweiPushRegistrationService.lifecycle.detach(); }
}

