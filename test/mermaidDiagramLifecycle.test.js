import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = fs.readFileSync('HarmonyCodexRemote/entry/src/main/ets/components/MermaidDiagram.ets', 'utf8');
function method(name) {
  const start = source.search(new RegExp(`^  (?:private )?(?:async )?${name}\\(`, 'm'));
  assert.ok(start >= 0, `real component method ${name}`);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}
function setup() {
  const requests = [];
  let controllers = 0;
  class Controller {
    constructor() { this.id = ++controllers; }
    runJavaScript(script) { return new Promise((resolve, reject) => requests.push({ controller: this, script, resolve, reject })); }
  }
  const context = vm.createContext({ webview: { WebviewController: Controller }, MarkdownDocumentService: {
    mermaidSourceError: value => value === 'invalid' ? 'invalid source' : '', normalizeMermaidSource: value => value.trim()
  } });
  const names = ['aboutToAppear', 'aboutToDisappear', 'onSourceChanged', 'onThemeChanged', 'invalidateRenderer',
    'onVisibilityChanged', 'onRendererPageEnd', 'requestRender', 'renderDiagram', 'onRenderCompleted', 'readRendererError'];
  vm.runInContext(stripTypeScriptTypes('class Diagram {' + names.map(method).join('\n') + '}\nglobalThis.Diagram=Diagram;'), context);
  const page = Object.assign(new context.Diagram(), { source: 'flowchart LR\n A-->B', darkMode: false,
    rendererReady: false, renderError: '', renderRevision: 0, rendererVisible: false,
    rendererGeneration: 0, componentActive: false, webController: new Controller(), renderBridge: {} });
  page.aboutToAppear();
  const visible = () => { page.onVisibilityChanged(true, 1); page.onRendererPageEnd(page.rendererGeneration); };
  return { page, requests, visible };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('offscreen diagrams do not run the renderer; becoming visible starts the current Web generation', () => {
  const h = setup();
  h.page.requestRender(); h.page.onThemeChanged(); h.page.onSourceChanged();
  assert.equal(h.requests.length, 0);
  h.page.onVisibilityChanged(true, 0); assert.equal(h.page.rendererVisible, false);
  h.visible(); assert.equal(h.requests.length, 1); assert.equal(h.page.rendererReady, true);
  assert.match(h.requests[0].script, /window\.renderMermaid/);
});

test('leaving and reentering ignores old pageEnd and JavaScript completion callbacks', async () => {
  const h = setup(); h.visible();
  const oldGeneration = h.page.rendererGeneration, oldController = h.page.webController;
  h.page.onVisibilityChanged(false, 0);
  assert.equal(h.page.rendererReady, false);
  h.page.onRendererPageEnd(oldGeneration); assert.equal(h.requests.length, 1);
  h.requests[0].resolve('MERMAID_ERROR:obsolete page'); await flush();
  h.page.renderBridge.onCompleted(h.page.renderRevision - 1, 'MERMAID_ERROR:obsolete page');
  assert.equal(h.page.renderError, '');
  h.page.onVisibilityChanged(true, 1);
  assert.notEqual(h.page.webController, oldController);
  h.page.onRendererPageEnd(oldGeneration); assert.equal(h.page.rendererReady, false);
  h.page.onRendererPageEnd(h.page.rendererGeneration); assert.equal(h.requests.length, 2);
  h.requests[1].resolve('MERMAID_RENDERED'); await flush(); assert.equal(h.page.renderError, '');
});

test('destroyed diagrams cannot be revived by pending render results or visibility callbacks', async () => {
  const h = setup(); h.visible(); const generation = h.page.rendererGeneration;
  const revision = h.page.renderRevision;
  h.page.aboutToDisappear();
  h.page.renderBridge.onCompleted(revision, 'MERMAID_ERROR:old page');
  h.requests[0].reject(new Error('old page closed')); await flush();
  h.page.onRendererPageEnd(generation); h.page.onVisibilityChanged(true, 1); h.page.onThemeChanged();
  assert.equal(h.page.rendererVisible, false); assert.equal(h.page.rendererReady, false);
  assert.equal(h.page.renderError, ''); assert.equal(h.requests.length, 1);
});

test('new source and theme supersede older render errors, while current errors retain a source fallback', async () => {
  const h = setup(); h.visible();
  h.page.source = 'flowchart TB\n A-->C'; h.page.onSourceChanged();
  h.page.darkMode = true; h.page.onThemeChanged(); assert.equal(h.requests.length, 3);
  const current = h.page.renderRevision;
  h.requests[0].resolve('MERMAID_ERROR:old source'); h.requests[1].reject(new Error('old theme')); await flush();
  h.page.renderBridge.onCompleted(current - 2, 'MERMAID_ERROR:old source');
  h.page.renderBridge.onCompleted(current - 1, 'MERMAID_ERROR:old theme');
  assert.equal(h.page.renderError, '');
  h.requests[2].resolve(''); await flush();
  assert.equal(h.page.renderError, '');
  h.page.renderBridge.onCompleted(current, 'MERMAID_ERROR:current syntax');
  assert.match(h.page.renderError, /current syntax/); assert.equal(h.page.rendererReady, false);
  h.page.source = 'flowchart LR\n C-->D'; h.page.onSourceChanged();
  assert.equal(h.page.renderError, '');
  h.page.onRendererPageEnd(h.page.rendererGeneration); assert.equal(h.requests.length, 4);
});

test('invalid source invalidates pending work and a corrected source gets a fresh renderer', async () => {
  const h = setup(); h.visible(); const oldController = h.page.webController;
  h.page.source = 'invalid'; h.page.onSourceChanged();
  assert.equal(h.page.rendererReady, false); assert.equal(h.requests.length, 1);
  h.requests[0].resolve('MERMAID_RENDERED'); await flush(); assert.equal(h.page.renderError, 'invalid source');
  h.page.source = 'flowchart LR\n D-->E'; h.page.onSourceChanged();
  assert.notEqual(h.page.webController, oldController); assert.equal(h.page.renderError, '');
  h.page.onRendererPageEnd(h.page.rendererGeneration); assert.equal(h.requests.length, 2);
});

test('lazy loading reserves diagram height and retains offline boundaries and selectable source', () => {
  assert.match(source, /else if \(this\.rendererVisible\)\s*\{\s*this\.Renderer\(this\.rendererGeneration\)/);
  assert.match(source, /\.onVisibleAreaChange\(/);
  assert.ok((source.match(/\.height\(this\.diagramHeight\(\)\)/g) ?? []).length >= 2);
  assert.match(source, /\.blockNetwork\(true\)/); assert.match(source, /\.fileAccess\(false\)/);
  assert.match(source, /Text\(this\.source\)\s*\.copyOption\(CopyOptions\.LocalDevice\)/);
});
