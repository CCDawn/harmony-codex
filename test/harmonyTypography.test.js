import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const indexPath = path.resolve('HarmonyCodexRemote/entry/src/main/ets/pages/Index.ets');
const typographyPath = path.resolve('HarmonyCodexRemote/entry/src/main/ets/theme/AppTypography.ets');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function methodBody(name) {
  const text = read(indexPath);
  const methodName = name.split('(')[0];
  const start = text.search(new RegExp(`^\\s*(?:private\\s+(?:async\\s+)?|@Builder\\s+)?${methodName}\\s*\\(`, 'm'));
  assert.notEqual(start, -1, `missing method ${name}`);
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') {
      depth += 1;
    } else if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(open + 1, index);
      }
    }
  }
  assert.fail(`unterminated method ${name}`);
}

test('font scale offers four persisted app-wide modes', () => {
  const typography = read(typographyPath);
  const index = read(indexPath);

  assert.match(typography, /DEFAULT_FONT_SCALE_MODE: string = 'standard'/);
  assert.match(typography, /FONT_SCALE_STORAGE_KEY: string = 'codexRemoteFontScaleMode'/);
  assert.match(typography, /normalized === 'small'/);
  assert.match(typography, /normalized === 'large'/);
  assert.match(typography, /normalized === 'extra_large'/);
  assert.match(typography, /return 90/);
  assert.match(typography, /return 115/);
  assert.match(typography, /return 130/);
  assert.match(index, /PersistentStorage\.persistProp\(FONT_SCALE_STORAGE_KEY, DEFAULT_FONT_SCALE_MODE\)/);
  assert.match(index, /@StorageLink\('codexRemoteFontScaleMode'\) fontScaleMode: string = DEFAULT_FONT_SCALE_MODE/);
  assert.match(index, /HomeActionMenuItem\(\s*'font_size'/);
  assert.match(index, /FontScaleButton\('small', '小'\)/);
  assert.match(index, /FontScaleButton\('standard', '标准'\)/);
  assert.match(index, /FontScaleButton\('large', '大'\)/);
  assert.match(index, /FontScaleButton\('extra_large', '特大'\)/);
});

test('text sizes and line heights use the global scale while icons stay fixed', () => {
  const index = read(indexPath);
  const scaledFontCalls = (index.match(/this\.scaledFontSize\(/g) ?? []).length;
  const scaledLineHeightCalls = (index.match(/this\.scaledLineHeight\(/g) ?? []).length;
  const lines = index.split(/\r?\n/);
  const textKinds = new Set(['Text', 'Button', 'TextArea', 'TextInput', 'Search', 'RichText']);
  const boundaries = new Set([...textKinds, 'SymbolGlyph', 'Row', 'Column', 'Stack', 'Image', 'LoadingProgress', 'Blank']);
  let fixedIconCount = 0;

  assert.ok(scaledFontCalls > 130, `expected broad font coverage, got ${scaledFontCalls}`);
  assert.ok(scaledLineHeightCalls >= 10, `expected line-height coverage, got ${scaledLineHeightCalls}`);
  lines.forEach((line, lineIndex) => {
    if (!line.includes('.fontSize(')) {
      return;
    }
    let kind = '';
    for (let index = lineIndex - 1; index >= Math.max(0, lineIndex - 14); index -= 1) {
      const match = lines[index].match(/^\s*(Text|Button|TextArea|TextInput|Search|RichText|SymbolGlyph|Row|Column|Stack|Image|LoadingProgress|Blank)\b/);
      if (match && boundaries.has(match[1])) {
        kind = match[1];
        break;
      }
    }
    if (kind === 'SymbolGlyph') {
      fixedIconCount += 1;
      assert.doesNotMatch(line, /scaledFontSize/, `icon should stay fixed at line ${lineIndex + 1}`);
    } else if (textKinds.has(kind)) {
      assert.match(line, /this\.scaledFontSize/, `text should scale at line ${lineIndex + 1}`);
    }
  });
  assert.ok(fixedIconCount > 20, `expected fixed icon sizes, got ${fixedIconCount}`);
});

test('assistant messages stay borderless but gain a readable inset and visual anchor', () => {
  const body = methodBody('SessionEntryCard(entry: CodexSessionEntry)');
  const assistantStart = body.lastIndexOf('} else {');
  assert.ok(assistantStart >= 0, 'missing assistant message branch');
  const assistantBody = body.slice(assistantStart);

  assert.match(assistantBody, /\.width\(6\)[\s\S]*\.backgroundColor\(this\.theme\(\)\.accent\)/);
  assert.match(assistantBody, /\.width\('88%'\)/);
  assert.match(assistantBody, /\.padding\(\{ left: 12, right: 0, top: 2, bottom: 4 \}\)/);
  assert.doesNotMatch(assistantBody, /\.backgroundColor\([^)]*\)[\s\S]{0,100}\.border\(/);
});

test('tool and status rows share the assistant text indentation', () => {
  const body = methodBody('SessionEntryCard(entry: CodexSessionEntry)');
  const userStart = body.indexOf("} else if (entry.role === 'user')");
  assert.ok(userStart >= 0, 'missing user message branch');
  const systemBody = body.slice(0, userStart);

  assert.equal((systemBody.match(/\.width\('88%'\)/g) ?? []).length, 3);
  assert.equal(
    (systemBody.match(/\.padding\(\{ left: 12, right: 0, top: [01], bottom: [045] \}\)/g) ?? []).length,
    3
  );
  assert.doesNotMatch(systemBody, /\.width\('100%'\)\s*\.padding\(\{ left: [48], right: [48]/);
});

test('user bubbles shrink for short prompts and remain capped for long prompts', () => {
  const textWidthBody = methodBody('userTextBubbleWidth(text: string): number');
  const widthBody = methodBody('userSessionEntryWidth(entry: CodexSessionEntry): string | number');
  const entryBody = methodBody('SessionEntryCard(entry: CodexSessionEntry)');
  const optimisticBody = methodBody('OptimisticSessionMessageCard(message: OptimisticSessionMessage)');

  assert.match(textWidthBody, /longestLineLength/);
  assert.match(textWidthBody, /Math\.max\(112, Math\.min\(620, 32 \+ longestLineLength \* 13\)\)/);
  assert.match(widthBody, /this\.userTextBubbleWidth\(this\.sessionEntryVisibleText\(entry\)\)/);
  assert.match(entryBody, /\.width\(this\.userSessionEntryWidth\(entry\)\)/);
  assert.match(entryBody, /\.constraintSize\(\{ maxWidth: '82%' \}\)/);
  assert.match(optimisticBody, /\.width\(this\.userTextBubbleWidth\(message\.text\)\)/);
  assert.match(optimisticBody, /\.constraintSize\(\{ maxWidth: '82%' \}\)/);
});

test('header shows effective model and reasoning without duplicate automatic labels', () => {
  const headerBody = methodBody('ReasoningEffortHeaderButton()');
  const modelBody = methodBody('modelShortLabel(value: string): string');
  const effortBody = methodBody('reasoningEffortShortLabel(value: string): string');

  assert.match(headerBody, /Text\(`· \$\{this\.reasoningEffortShortLabel/);
  assert.doesNotMatch(headerBody, /思考·/);
  assert.doesNotMatch(modelBody, /自动·/);
  assert.doesNotMatch(effortBody, /自动·/);
  assert.match(effortBody, /this\.desktopDefaultReasoningEffort/);
});
