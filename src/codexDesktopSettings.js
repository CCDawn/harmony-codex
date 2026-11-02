import { CodexDesktopCdpClient } from './codexDesktopCdpClient.js';
import { readCodexDefaultModel, readCodexDefaultReasoningEffort, readCodexDefaultServiceTier } from './codexUserConfig.js';
import { normalizeModelId, normalizeReasoningEffort, normalizeServiceTier } from './sessionSettingsStore.js';

export async function readDesktopCodexSettings(options = {}) {
  const fallback = await readConfigFileDefaults(options);
  const client = options.client ?? new CodexDesktopCdpClient({
    timeoutMs: options.timeoutMs ?? Number.parseInt(process.env.CODEX_DESKTOP_SETTINGS_TIMEOUT_MS ?? '4500', 10)
  });
  const closeClient = options.client ? false : true;
  try {
    return await readCodexSettingsFromClient(client, fallback, {
      cwd: options.cwd ?? null,
      source: 'desktop_cdp'
    });
  } catch {
    return fallback;
  } finally {
    if (closeClient && client?.close) {
      client.close();
    }
  }
}

export async function readAppServerCodexSettings(threadService, options = {}) {
  if (!threadService || typeof threadService.requestAppServer !== 'function') {
    throw new Error('Managed Codex App Server settings are unavailable');
  }
  const fallback = await readConfigFileDefaults(options);
  const client = {
    request(method, params) {
      return threadService.requestAppServer(method, params);
    }
  };
  return await readCodexSettingsFromClient(client, fallback, {
    cwd: options.cwd ?? null,
    source: 'app_server'
  });
}

async function readConfigFileDefaults(options) {
  const [model, reasoningEffort, serviceTier] = await Promise.all([
    readCodexDefaultModel(options),
    readCodexDefaultReasoningEffort(options),
    readCodexDefaultServiceTier(options)
  ]);
  return {
    model,
    reasoningEffort,
    serviceTier,
    source: 'config_file',
    models: model ? [{
      id: model,
      model,
      displayName: model,
      description: '当前 Codex 配置模型',
      isDefault: true
    }] : []
  };
}

async function readCodexSettingsFromClient(client, fallback, options) {
  const configResult = await client.request('config/read', {
    cwd: options.cwd,
    includeLayers: false
  });
  const config = configResult?.config ?? {};
  const modelResult = await client.request('model/list', {
    cursor: null,
    includeHidden: false,
    limit: 100
  });
  return {
    model: safeNormalizeModelId(config.model ?? fallback.model),
    reasoningEffort: safeNormalizeReasoningEffort(config.model_reasoning_effort ?? fallback.reasoningEffort),
    serviceTier: normalizeServiceTier(config.service_tier) || 'default',
    source: options.source,
    models: Array.isArray(modelResult?.data) ? modelResult.data : []
  };
}

function safeNormalizeModelId(value) {
  try {
    return normalizeModelId(value);
  } catch {
    return '';
  }
}

function safeNormalizeReasoningEffort(value) {
  try {
    return normalizeReasoningEffort(value);
  } catch {
    return '';
  }
}
