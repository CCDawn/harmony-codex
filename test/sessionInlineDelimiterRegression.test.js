import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const servicePath = new URL('../HarmonyCodexRemote/entry/src/main/ets/services/SessionPresentationService.ets', import.meta.url);
const serviceSource = fs.readFileSync(servicePath, 'utf8')
  .replace(/^import .*;\s*$/gm, '')
  .replaceAll('export ', '');
const context = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(`${serviceSource}\nglobalThis.parse = parseSessionMarkdownInline;`), context);
const parse = text => JSON.parse(JSON.stringify(context.parse(text)))
  .map(({ kind, text: segmentText, href }) => ({ kind, text: segmentText, href }));

test('keeps underscores inside identifiers and filenames as plain text', () => {
  for (const text of ['QA_READY_01', 'foo_bar_baz.txt']) {
    assert.deepEqual(parse(text), [{ kind: 'plain', text, href: '' }]);
  }
});

test('retains emphasis and strong markdown delimiters', () => {
  assert.deepEqual(parse('prefix _emphasis_ and **strong** suffix'), [
    { kind: 'plain', text: 'prefix ', href: '' },
    { kind: 'emphasis', text: 'emphasis', href: '' },
    { kind: 'plain', text: ' and ', href: '' },
    { kind: 'strong', text: 'strong', href: '' },
    { kind: 'plain', text: ' suffix', href: '' }
  ]);
});

test('leaves links, code spans, and escaped underscores intact', () => {
  const escapedUnderscore = String.raw`\_literal\_`;
  assert.deepEqual(parse(`[file_name](https://example.test/a_b) \`literal_name\` ${escapedUnderscore}`), [
    { kind: 'link', text: 'file_name', href: 'https://example.test/a_b' },
    { kind: 'plain', text: ' ', href: '' },
    { kind: 'code', text: 'literal_name', href: '' },
    { kind: 'plain', text: ` ${escapedUnderscore}`, href: '' }
  ]);
});
