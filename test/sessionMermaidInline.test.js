import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const root = 'HarmonyCodexRemote/entry/src/main/ets/';
const source = fs.readFileSync(root + 'pages/Index.ets', 'utf8');
const sample = 'flowchart LR\n  L["Launcher: 唯一个人助理<br/>面板、形象、偏好、会话"] <--> G["受控调用与任务回执"]\n  G <--> P["平台: 通用 API 与执行器<br/>Agent、团队、项目"]';
function method(name) {
  const start = source.search(new RegExp(`^  private ${name}\\(`, 'm'));
  return start < 0 ? '' : source.slice(start, source.indexOf('\n  }', start) + 4);
}
function setup() {
  const methods = new Map();
  function include(name) {
    if (methods.has(name)) return;
    const body = method(name);
    if (!body) return;
    methods.set(name, body);
    for (const match of body.matchAll(/this\.(\w+)\(/g)) include(match[1]);
  }
  ['parseSessionMarkdown', 'isSessionMermaidBlock', 'shouldDeferSessionMermaid'].forEach(include);
  const service = fs.readFileSync(root + 'services/SessionPresentationService.ets', 'utf8')
    .replace(/^import .*;\s*$/gm, '').replaceAll('export ', '');
  const context = vm.createContext({});
  vm.runInContext(stripTypeScriptTypes(service + '\nclass Page {' + [...methods.values()].join('\n') + '}\nglobalThis.Page=Page;'), context);
  return new context.Page();
}

test('the screenshot flowchart remains intact through inline Markdown parsing and routes to a diagram', () => {
  const page = setup();
  const blocks = page.parseSessionMarkdown(['说明', '```mermaid', sample, '```', '后文'].join('\n'));
  const block = blocks.find(item => item.kind === 'code');
  assert.equal(block.text, sample);
  assert.equal(typeof page.isSessionMermaidBlock, 'function');
  assert.equal(page.isSessionMermaidBlock(block), true);
  assert.equal(page.isSessionMermaidBlock({ ...block, language: ' MERMAID ' }), true);
  assert.equal(page.isSessionMermaidBlock({ ...block, language: 'javascript' }), false);
  assert.equal(page.isSessionMermaidBlock({ ...block, kind: 'paragraph' }), false);
});

test('partial live diagrams do not create a Web renderer for each streamed text update', () => {
  const page = setup();
  assert.equal(typeof page.shouldDeferSessionMermaid, 'function');
  for (const entry of [{ type: 'live_agent_streaming' }, { type: 'response_item', liveKind: 'streaming' }]) {
    assert.equal(page.shouldDeferSessionMermaid(entry), true);
  }
  assert.equal(page.shouldDeferSessionMermaid({ type: 'response_item', liveKind: 'completed' }), false);
  assert.equal(page.shouldDeferSessionMermaid({ type: 'response_item' }), false);
  const start = source.indexOf('  SessionMarkdownBlockView(');
  const body = source.slice(start, source.indexOf('\n  @Builder', start));
  assert.match(body, /this\.isSessionMermaidBlock\(\$\$\.blockItem\)/);
  assert.match(body, /if \(this\.shouldDeferSessionMermaid\(\$\$\.entry\)\)/);
  assert.match(body, /图表生成中/);
  assert.match(body, /else \{\s*MermaidDiagram\(/);
  assert.match(body, /source: \$\$\.blockItem\.text/);
});

test('ordinary code fences and surrounding prose keep their existing rendering route', () => {
  const page = setup();
  const blocks = page.parseSessionMarkdown(['前文', '```js', 'const value = 1;', '```', '后文'].join('\n'));
  assert.deepEqual(Array.from(blocks, item => item.kind), ['paragraph', 'code', 'paragraph']);
  assert.equal(blocks[1].text, 'const value = 1;');
  assert.equal(typeof page.isSessionMermaidBlock, 'function');
  assert.equal(page.isSessionMermaidBlock(blocks[1]), false);
});

test('native diagram validation accepts the screenshot labels and keeps external interaction disabled', () => {
  const document = fs.readFileSync(root + 'services/MarkdownDocumentService.ets', 'utf8');
  const names = ['mermaidSourceError', 'normalizeMermaidSource'];
  const methods = names.map(name => {
    const start = document.indexOf(`  static ${name}(`);
    assert.ok(start >= 0);
    return document.slice(start, document.indexOf('\n  }', start) + 4);
  });
  const context = vm.createContext({ MAX_MERMAID_SOURCE_CHARS: 24 * 1024 });
  vm.runInContext(stripTypeScriptTypes('class MarkdownDocumentService {' + methods.join('\n')
    + '}\nglobalThis.validate=MarkdownDocumentService.mermaidSourceError;'), context);
  assert.equal(context.validate(sample), '');
  assert.notEqual(context.validate('flowchart LR\n A-->B\n click A href "https://example.test"'), '');
  assert.notEqual(context.validate('flowchart LR\n' + 'A'.repeat(25 * 1024)), '');
});
