import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const component = fs.readFileSync('HarmonyCodexRemote/entry/src/main/ets/components/MermaidDiagram.ets', 'utf8');
const html = fs.readFileSync('HarmonyCodexRemote/entry/src/main/resources/rawfile/mermaid/mermaid_renderer.html', 'utf8');
const sample = 'flowchart LR\n  subgraph 输入\n    A[中文<br/>入口] --> B[处理]\n  end\n  subgraph 输出\n    C[结果]\n  end\n  B --> C';
function method(name) {
  const start = component.search(new RegExp(`^  (?:private )?(?:async )?${name}\\(`, 'm'));
  assert.ok(start >= 0, `component method ${name}`);
  return component.slice(start, component.indexOf('\n  }', start) + 4);
}

test('ArkWeb empty synchronous result waits for the revisioned native callback', async () => {
  const methods = ['renderDiagram', 'onRenderCompleted', 'readRendererError', 'invalidateRenderer'];
  const context = vm.createContext({ MarkdownDocumentService: { normalizeMermaidSource: x => x } });
  vm.runInContext(stripTypeScriptTypes('class Diagram {' + methods.map(method).join('\n') + '}\nglobalThis.Diagram=Diagram;'), context);
  const page = Object.assign(new context.Diagram(), { source: sample, darkMode: false, componentActive: true,
    rendererVisible: true, rendererReady: true, renderError: '', renderRevision: 7, rendererGeneration: 1,
    webController: { runJavaScript: async () => '' } });
  await page.renderDiagram(7);
  assert.equal(page.renderError, '');
  page.onRenderCompleted(7, 'MERMAID_RENDERED');
  assert.equal(page.renderError, '');
  page.onRenderCompleted(6, 'MERMAID_ERROR:old source');
  assert.equal(page.renderError, '');
  page.onRenderCompleted(7, 'MERMAID_ERROR:syntax');
  assert.match(page.renderError, /syntax/);
});

test('renderer callbacks follow awaited completion and older renders cannot overwrite newer SVG', async () => {
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  const root = { innerHTML: '' }, calls = [], pending = [];
  const window = { MermaidNative: { completed: (revision, status) => calls.push([revision, status]) }, mermaid: {
    initialize() {}, render(id, text) { const deferred = Promise.withResolvers(); pending.push({ id, text, ...deferred }); return deferred.promise; }
  } };
  const document = { body: { className: '' }, getElementById: () => root };
  vm.runInNewContext(inline, { window, document, Date });
  const first = window.renderMermaid(JSON.stringify({ source: sample, revision: 1, darkMode: false }));
  const second = window.renderMermaid(JSON.stringify({ source: sample, revision: 2, darkMode: true }));
  assert.deepEqual(calls, []);
  pending[1].resolve({ svg: '<svg id="new"></svg>' });
  assert.equal(await second, 'MERMAID_RENDERED');
  pending[0].resolve({ svg: '<svg id="old"></svg>' });
  assert.equal(await first, 'MERMAID_RENDERED');
  assert.equal(root.innerHTML, '<svg id="new"></svg>');
  assert.ok(calls.some(([revision, status]) => revision === 2 && status === 'MERMAID_RENDERED'));
});

test('an older render failure cannot erase the latest successful diagram', async () => {
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  const root = { innerHTML: '' }, calls = [], pending = [];
  const window = { MermaidNative: { completed: (revision, status) => calls.push([revision, status]) }, mermaid: {
    initialize() {}, render() { const deferred = Promise.withResolvers(); pending.push(deferred); return deferred.promise; }
  } };
  vm.runInNewContext(inline, { window, document: { body: { className: '' }, getElementById: () => root }, Date });
  const old = window.renderMermaid(JSON.stringify({ source: sample, revision: 4 }));
  const current = window.renderMermaid(JSON.stringify({ source: sample, revision: 5 }));
  pending[1].resolve({ svg: '<svg id="current"></svg>' });
  await current;
  pending[0].reject(new Error('old error'));
  assert.match(await old, /^MERMAID_ERROR:/);
  assert.equal(root.innerHTML, '<svg id="current"></svg>');
  assert.ok(calls.some(([revision, status]) => revision === 4 && status.startsWith('MERMAID_ERROR:')));
});
