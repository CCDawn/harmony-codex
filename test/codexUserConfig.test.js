import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveCodexSettings, effectiveReasoningSettings, extractServiceTierFromConfig, extractModelFromConfig, extractReasoningEffortFromConfig } from '../src/codexUserConfig.js';
import { readAppServerCodexSettings } from '../src/codexDesktopSettings.js';

test('extractReasoningEffortFromConfig reads Codex model_reasoning_effort', () => {
  assert.equal(extractReasoningEffortFromConfig('model_reasoning_effort = "xhigh"\n'), 'xhigh');
  assert.equal(extractReasoningEffortFromConfig("model_reasoning_effort = 'high'\n"), 'high');
  assert.equal(extractReasoningEffortFromConfig('model_reasoning_effort = medium\n'), 'medium');
});

test('extractReasoningEffortFromConfig ignores invalid values', () => {
  assert.equal(extractReasoningEffortFromConfig('model_reasoning_effort = "turbo"\n'), '');
  assert.equal(extractReasoningEffortFromConfig('model = "gpt-5.5"\n'), '');
});

test('extractModelFromConfig reads Codex model', () => {
  assert.equal(extractModelFromConfig('model = "gpt-5.5"\n'), 'gpt-5.5');
  assert.equal(extractModelFromConfig("model = 'gpt-5.4-mini'\n"), 'gpt-5.4-mini');
  assert.equal(extractModelFromConfig('model = gpt-5.4\n'), 'gpt-5.4');
});

test('extractModelFromConfig ignores invalid model values', () => {
  assert.equal(extractModelFromConfig('model = "bad model"\n'), '');
  assert.equal(extractModelFromConfig('model_reasoning_effort = "xhigh"\n'), '');
});

test('effectiveReasoningSettings reports desktop default for automatic mode', () => {
  assert.deepEqual(effectiveReasoningSettings({ reasoningEffort: '', updatedAt: '' }, 'xhigh'), {
    reasoningEffort: '',
    updatedAt: '',
    defaultReasoningEffort: 'xhigh',
    effectiveReasoningEffort: 'xhigh',
    reasoningEffortSource: 'desktop'
  });
  assert.deepEqual(effectiveReasoningSettings({ reasoningEffort: 'high', updatedAt: 'now' }, 'xhigh'), {
    reasoningEffort: 'high',
    updatedAt: 'now',
    defaultReasoningEffort: 'xhigh',
    effectiveReasoningEffort: 'high',
    reasoningEffortSource: 'session'
  });
});

test('effectiveCodexSettings reports model and reasoning defaults', () => {
  const settings = effectiveCodexSettings(
    { model: '', reasoningEffort: '', updatedAt: '' },
    {
      model: 'gpt-5.5',
      reasoningEffort: 'xhigh',
      models: [{ id: 'gpt-5.5', displayName: 'GPT-5.5', isDefault: true }]
    }
  );
  assert.equal(settings.model, '');
  assert.equal(settings.defaultModel, 'gpt-5.5');
  assert.equal(settings.effectiveModel, 'gpt-5.5');
  assert.equal(settings.modelSource, 'desktop');
  assert.equal(settings.defaultReasoningEffort, 'xhigh');
  assert.equal(settings.effectiveReasoningEffort, 'xhigh');
  assert.equal(settings.modelOptions[0].displayName, 'GPT-5.5');
  assert.equal(settings.modelCatalogRevision, 'gpt-5.5|gpt-5.5');

  const recoveredRevision = effectiveCodexSettings(
    { model: '', reasoningEffort: '', updatedAt: '' },
    {
      model: 'gpt-5.6-terra',
      modelCatalogRevision: '',
      models: [
        { id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', isDefault: true },
        { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' }
      ]
    }
  );
  assert.equal(recoveredRevision.modelCatalogRevision, 'gpt-5.6-terra|gpt-5.6-terra|gpt-5.6-sol');

  const overridden = effectiveCodexSettings(
    { model: 'gpt-5.4-mini', reasoningEffort: 'high', updatedAt: 'now' },
    { model: 'gpt-5.5', reasoningEffort: 'xhigh', models: [] }
  );
  assert.equal(overridden.effectiveModel, 'gpt-5.4-mini');
  assert.equal(overridden.modelSource, 'session');
  assert.equal(overridden.effectiveReasoningEffort, 'high');
});

test('managed App Server is the primary model catalog and includes all selectable models', async () => {
  const calls = [];
  const settings = await readAppServerCodexSettings({
    async requestAppServer(method, params) {
      calls.push({ method, params });
      if (method === 'config/read') {
        return {
          config: {
            model: 'gpt-5.6-terra',
            model_reasoning_effort: 'high'
          }
        };
      }
      if (method === 'model/list') {
        return {
          data: [
            { id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra' },
            { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' },
            { id: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna' }
          ]
        };
      }
      throw new Error(`unexpected ${method}`);
    }
  });

  assert.equal(settings.source, 'app_server');
  assert.equal(settings.model, 'gpt-5.6-terra');
  assert.equal(settings.reasoningEffort, 'high');
  assert.deepEqual(settings.models.map((model) => model.id), [
    'gpt-5.6-terra',
    'gpt-5.6-sol',
    'gpt-5.6-luna'
  ]);
  assert.deepEqual(calls.map((call) => call.method), ['config/read', 'model/list']);
});


test('service tier config reads root defaults without leaking a profile or losing explicit standard', () => {
  assert.equal(extractServiceTierFromConfig('service_tier = "priority"\n[profiles.other]\nservice_tier = "default"'), 'priority');
  assert.equal(extractServiceTierFromConfig('[profiles.other]\nservice_tier = "priority"'), 'default');
  assert.equal(extractServiceTierFromConfig('service_tier = "default"'), 'default');
  assert.equal(extractServiceTierFromConfig('service_tier = "bad tier"'), 'default');
});

test('official config/read service_tier and future model serviceTiers survive normalization and catalog revisions', async () => {
  const tiers = [{ id: 'priority', name: 'Fast', description: 'Fast inference', futureFlag: 'retained' }];
  const source = await readAppServerCodexSettings({ async requestAppServer(method) {
    return method === 'config/read' ? { config: { model: 'gpt-test', service_tier: 'priority' } }
      : { data: [{ id: 'gpt-test', serviceTiers: tiers }] };
  } }, { configPath: 'unused-test-config.toml' });
  assert.equal(source.serviceTier, 'priority');
  const settings = effectiveCodexSettings({}, source);
  assert.equal(settings.effectiveServiceTier, 'priority');
  assert.equal(settings.serviceTierSource, 'desktop');
  assert.deepEqual(settings.serviceTierOptions, tiers);
  const next = effectiveCodexSettings({}, { ...source, models: [{ id: 'gpt-test', serviceTiers: [{ id: 'future-tier', name: 'Future' }] }] });
  assert.notEqual(settings.modelCatalogRevision, next.modelCatalogRevision);
  assert.equal(next.serviceTierOptions[0].id, 'future-tier');
});
