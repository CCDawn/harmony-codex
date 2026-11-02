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

// These layout checks predate reference-parameter builders. Normalize only the
// access syntax; sessionRepeatReactive20261031.test.js checks the raw reference chain.
function uiBuilderBody(name) {
  return methodBody(name).replaceAll('$$.blockItem.item', 'block').replaceAll('$$.toolItem.item', 'item').replaceAll('$$.entry', 'entry')
    .replaceAll('$$.rowKey', 'rowKey').replaceAll('$$.isUser', 'isUser').replaceAll('$$.text', 'text')
    .replaceAll('$$.block', 'block').replaceAll('$$.message', 'message').replaceAll('$$.item', 'item')
    .replaceAll('toolItem.item', 'item').replaceAll('segment.item', 'segment').replaceAll('agent.item', 'agent')
    .replaceAll('item.item.entry', 'row.entry');
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
  const settings = read(path.resolve('HarmonyCodexRemote/entry/src/main/ets/components/SettingsPanel.ets'));
  assert.match(index, /SettingsPanel\(/);
  assert.match(settings, /FontOption\('small', '小字体'\)/);
  assert.match(settings, /FontOption\('standard', '标准字体'\)/);
  assert.match(settings, /FontOption\('large', '大字体'\)/);
  assert.match(settings, /FontOption\('extra_large', '特大字体'\)/);
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
    for (let index = lineIndex; index >= Math.max(0, lineIndex - 14); index -= 1) {
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

test('assistant messages stay borderless with compact author and progress labels', () => {
  const body = uiBuilderBody('SessionEntryCard(entry: CodexSessionEntry, rowKey: string)');
  const assistantStart = body.lastIndexOf('} else {');
  assert.ok(assistantStart >= 0, 'missing assistant message branch');
  const assistantBody = body.slice(assistantStart);

  assert.match(assistantBody, /this\.sessionAssistantHeaderStatus\(entry\)/);
  assert.match(assistantBody, /\.width\('100%'\)/);
  assert.match(assistantBody, /\.padding\(\{ left: 0, right: 0, top: 4, bottom: 12 \}\)/);
  assert.doesNotMatch(assistantBody, /\.backgroundColor\([^)]*\)[\s\S]{0,100}\.border\(/);
});

test('tool and status rows share the assistant text indentation', () => {
  const body = uiBuilderBody('SessionEntryCard(entry: CodexSessionEntry, rowKey: string)');
  const userStart = body.indexOf("} else if (entry.role === 'user')");
  assert.ok(userStart >= 0, 'missing user message branch');
  const systemBody = body.slice(0, userStart);

  assert.equal((systemBody.match(/\.width\('88%'\)/g) ?? []).length, 0);
  assert.equal(
    (systemBody.match(/\.padding\(\{ left: 0, right: 0, top: [01], bottom: [045] \}\)/g) ?? []).length,
    2
  );
  assert.doesNotMatch(systemBody, /\.width\('100%'\)\s*\.padding\(\{ left: [48], right: [48]/);
});

test('user bubbles shrink for short prompts and remain capped for long prompts', () => {
  const textWidthBody = methodBody('userTextBubbleWidth(text: string): number');
  const widthBody = methodBody('userSessionEntryWidth(entry: CodexSessionEntry): string | number');
  const entryBody = uiBuilderBody('SessionEntryCard(entry: CodexSessionEntry, rowKey: string)');
  const optimisticBody = uiBuilderBody('OptimisticSessionMessageCard(message: OptimisticSessionMessage)');

  assert.match(textWidthBody, /longestLineLength/);
  assert.match(textWidthBody, /Math\.max\(112, Math\.min\(620, 32 \+ longestLineLength \* 13\)\)/);
  assert.match(widthBody, /this\.userTextBubbleWidth\(this\.sessionEntryVisibleText\(entry\)\)/);
  assert.match(entryBody, /\.width\(this\.userSessionEntryWidth\(entry\)\)/);
  assert.match(entryBody, /\.constraintSize\(\{ maxWidth: '88%' \}\)/);
  assert.match(optimisticBody, /\.width\(message\.files\.length > 0 \|\| message\.images\.length > 0 \? '78%' : this\.userTextBubbleWidth\(message\.text\)\)/);
  assert.match(optimisticBody, /\.constraintSize\(\{ maxWidth: '88%' \}\)/);
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

test('conversation typography is explicit without overriding the app font scale or code family', () => {
  const typography = read(path.resolve('HarmonyCodexRemote/entry/src/main/ets/theme/ConversationTypography.ets'));
  assert.match(typography, /CONVERSATION_FONT_FAMILY: string = 'HarmonyOS Sans'/);
  assert.match(typography, /CONVERSATION_MONOSPACE_FONT_FAMILY: string = 'monospace'/);
  for (const name of ['SessionEntryCard', 'OptimisticSessionMessageCard', 'FailedSessionMessageCard',
    'SessionUserReplyContent', 'SessionSystemNoticeView', 'SessionAgentEventItemView',
    'SessionAgentAvatar', 'SessionAgentEventDetailView', 'SessionToolEntryView',
    'SessionMarkdownBlockView', 'SessionMarkdownInlineText', 'StructuredFieldView']) {
    assert.match(methodBody(name), /\.fontFamily\(CONVERSATION_FONT_FAMILY\)/, `${name} must not inherit a decorative phone font`);
  }
  const inline = uiBuilderBody('SessionMarkdownInlineText');
  assert.match(inline, /segment\.kind === 'code'[\s\S]*?\.fontFamily\(CONVERSATION_MONOSPACE_FONT_FAMILY\)/);
  assert.match(inline, /\.fontSize\(this\.scaledFontSize\(\$\$\.fontSize\)\)/);
  assert.match(inline, /\.lineHeight\(this\.scaledLineHeight\(\$\$\.lineHeight\)\)/);
  assert.doesNotMatch(methodBody('SessionPanel'), /CONVERSATION_FONT_FAMILY/);
  assert.match(methodBody('SessionPanel'), /\.backgroundColor\(this\.theme\(\)\.canvas\)/);
});

test('tool rows retain abnormal states and expansion while removing completed row chrome', () => {
  const body = uiBuilderBody('SessionToolEntryView').replaceAll('toolItem', 'item');
  assert.match(body, /app\.media\.conversation_terminal/);
  assert.doesNotMatch(body, /width: \{ top: 1 \}/);
  assert.doesNotMatch(body, /\? '✓' :/);
  assert.match(body, /item\.status === 'failed' \|\| item\.status === 'stopped' \|\| \(item\.retryCount/);
  assert.match(body, /LoadingProgress\(\)/);
  assert.match(body, /\.constraintSize\(\{ minHeight: 32 \}\)/);
  assert.match(body, /scaledLineHeight\(22\.5\)/);
  assert.match(body, /padding\(\{ left: 8, right: 8, top: 8, bottom: 8 \}\)/);
  assert.match(body, /app\.media\.action_copy/);
  assert.match(body, /copySessionPresentationText\(item\.args \|\| item\.target/);
  assert.match(body, /\? '✓ 成功'/);
});

test('code, tables and list markers follow the readable desktop conversation metrics', () => {
  const block = uiBuilderBody('SessionMarkdownBlockView').replaceAll('blockItem', 'block');
  const code = block.slice(block.indexOf("block.kind === 'code'"), block.indexOf("block.kind === 'quote'"));
  assert.match(code, /scaledFontSize\(15\)/);
  assert.match(code, /scaledLineHeight\(22\.5\)/);
  assert.match(code, /CONVERSATION_MONOSPACE_FONT_FAMILY/);
  assert.match(code, /scaledFontSize\(13\)/);
  const list = block.slice(block.indexOf("block.kind === 'list'"), block.indexOf("block.kind === 'table'"));
  assert.match(list, /block\.ordered \? `\$\{block\.level\}\.` : '•'/);
  assert.equal((list.match(/scaledLineHeight\(26\)/g) ?? []).length, 2);
  assert.equal((uiBuilderBody('SessionMarkdownTableView').match(/fontSize: 14, lineHeight: 22/g) ?? []).length, 2);
  const actions = methodBody('SessionContentActionRow');
  assert.equal((actions.match(/\.width\(16\)\.height\(16\)/g) ?? []).length, 2);
  assert.match(actions, /Row\(\{ space: 0 \}\)/);
  assert.match(actions, /copySessionImage/);
  assert.match(actions, /shareSessionText/);
});
