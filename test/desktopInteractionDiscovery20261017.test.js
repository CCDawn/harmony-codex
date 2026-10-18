import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DesktopInteractionClient } from '../src/desktopInteractionClient.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function harness({ asset = 'initial', exportSpacing = '', includeFamily = true } = {}) {
  const family = {};
  const reads = [], fetches = [], imports = [];
  const manager = { getHostId: () => 'local', async getConversation(id) {
    reads.push(id);
    return { requests: [], turns: [] };
  } };
  for (const name of ['replyWithCommandExecutionApprovalDecision', 'replyWithFileChangeApprovalDecision',
    'replyWithPermissionsRequestApprovalResponse', 'replyWithUserInputResponse', 'sendFollowUpMessage']) {
    manager[name] = () => { throw new Error('Read-only discovery must not respond'); };
  }
  const owner = { familyBindings: new Map([[family, new Map([['local', { value: { get: () => manager } }]])]]) };
  const window = { __codexRoot: { _internalRoot: { current: {
    tag: 10, memoizedProps: { value: new Map([['app', owner]]) }
  } } } };
  const document = { scripts: [{ type: 'module', src: 'app://-/assets/index.js' }] };
  // A same-named import alias must never override the actual export mapping.
  const managerSource = 'import{family$ as wrongAlias}from"./other.js";'
    + 'class Registry{getForHostId(h){return this.scope.get(hosts).includes(h)?this.scope.get(family$,h):null}};'
    + 'function native(){return nativeService?.appServerManagers};'
    + (includeFamily ? `export${exportSpacing}{family$ as liveFamily}` : 'export{other as unused}');
  const client = { hostId: 'local', async ensureConnected() {}, async evaluate(expression) {
    const run = new AsyncFunction('window', 'document', 'fetch', 'importModule', 'URL', 'crypto',
      'return ' + expression.replaceAll('await import(assetUrl)', 'await importModule(assetUrl)'));
    return run(window, document, async url => {
      fetches.push(url);
      return { text: async () => url.endsWith('index.js')
        ? `import "./app-shared-123abc.js";import "./app-${asset}-456def.js";import "./app-${asset}-456def.js";`
        : url.includes(`app-${asset}-456def.js`) ? managerSource : 'export{unrelated as unused}' };
    }, async url => {
      imports.push(url);
      return { liveFamily: family, wrongAlias: {}, unused: {} };
    }, URL, { randomUUID });
  } };
  return { api: new DesktopInteractionClient(client), reads, fetches, imports };
}

for (const asset of ['initial', 'primary']) {
  for (const exportSpacing of ['', ' ']) {
    test(`existing local manager discovery follows ${asset} and the actual export block (${JSON.stringify(exportSpacing)})`, async () => {
      const h = harness({ asset, exportSpacing });
      assert.deepEqual(await h.api.listRequests('thread-1'), []);
      assert.deepEqual(await h.api.listRequests('thread-1'), []);
      assert.deepEqual(h.reads, ['thread-1', 'thread-1']);
      assert.equal(h.fetches.length, 3, 'entry and two unique assets are fetched once');
      assert.equal(h.imports.length, 1, 'unrelated shared chunk is not imported');
      assert.match(h.imports[0], new RegExp(`app-${asset}-456def\\.js$`));
    });
  }
}

test('an import alias cannot stand in for a missing manager family export', async () => {
  const h = harness({ includeFamily: false });
  await assert.rejects(h.api.listRequests('thread-1'), {
    code: 'DESKTOP_INTERACTIONS_UNAVAILABLE', statusCode: 503
  });
  assert.deepEqual(h.reads, []);
  assert.deepEqual(h.imports, []);
});
