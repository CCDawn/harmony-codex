import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const themePath = path.resolve('HarmonyCodexRemote/entry/src/main/ets/theme/AppTheme.ets');
const indexPath = path.resolve('HarmonyCodexRemote/entry/src/main/ets/pages/Index.ets');
const entryAbilityPath = path.resolve('HarmonyCodexRemote/entry/src/main/ets/entryability/EntryAbility.ets');
const colorPath = path.resolve('HarmonyCodexRemote/entry/src/main/resources/base/element/color.json');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

test('night theme is the persisted default and preserves all three appearance modes', () => {
  const theme = read(themePath);
  const index = read(indexPath);

  assert.match(theme, /DEFAULT_THEME_MODE: string = 'dark'/);
  assert.match(theme, /THEME_MODE_STORAGE_KEY: string = 'codexRemoteThemeMode'/);
  assert.match(theme, /normalized === 'light' \|\| normalized === 'system'/);
  assert.match(theme, /canvas: '#080A0D'/);
  assert.match(theme, /textPrimary: '#F7F9FC'/);
  assert.match(theme, /if \(!dark\) \{\s*return lightColor;/);
  assert.match(index, /PersistentStorage\.persistProp\(THEME_MODE_STORAGE_KEY, DEFAULT_THEME_MODE\)/);
  assert.match(index, /@StorageLink\('codexRemoteThemeMode'\) themeMode: string = DEFAULT_THEME_MODE/);
  assert.match(index, /@StorageLink\('codexRemoteSystemDarkMode'\) systemDarkMode: boolean = false/);
});

test('home action menu switches night, light, and system themes without restart', () => {
  const index = read(indexPath);

  const settings = read(path.resolve('HarmonyCodexRemote/entry/src/main/ets/components/SettingsPanel.ets'));
  assert.match(index, /SettingsPanel\(/);
  assert.match(settings, /ThemeOption\('dark', '夜晚'\)/);
  assert.match(settings, /ThemeOption\('light', '浅色'\)/);
  assert.match(settings, /ThemeOption\('system', '跟随系统'\)/);
  assert.match(index, /context\.setColorMode\(colorMode\)/);
  assert.match(index, /COLOR_MODE_DARK/);
  assert.match(index, /COLOR_MODE_LIGHT/);
  assert.match(index, /COLOR_MODE_NOT_SET/);
  assert.doesNotMatch(index, /changeThemeMode[\s\S]{0,500}(restart|重启)/i);
});

test('system appearance changes flow into the app theme state', () => {
  const entryAbility = read(entryAbilityPath);

  assert.match(entryAbility, /onConfigurationUpdate\(newConfig: Configuration\)/);
  assert.match(entryAbility, /syncSystemDarkMode\(newConfig\.colorMode\)/);
  assert.match(entryAbility, /AppStorage\.setOrCreate\(\s*'codexRemoteSystemDarkMode'/);
  assert.match(entryAbility, /COLOR_MODE_DARK/);
});

test('whole app color consumers use theme resolution and dark startup avoids a white flash', () => {
  const index = read(indexPath);
  const colors = JSON.parse(read(colorPath));
  const resolvedColorCount = (index.match(/this\.themeColor\('/g) ?? []).length;

  assert.ok(resolvedColorCount > 250, `expected broad theme coverage, got ${resolvedColorCount}`);
  assert.doesNotMatch(index, /\.backgroundColor\('#FFFFFF'\)/);
  assert.doesNotMatch(index, /\.fontColor\('#17202A'\)/);
  assert.doesNotMatch(index, /\.fontColor\('#68717D'\)/);
  assert.equal(colors.color.find((item) => item.name === 'start_window_background')?.value, '#080A0D');
});
