import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
const source = fs.readFileSync('HarmonyCodexRemote/entry/src/main/ets/services/SseParser.ets', 'utf8');
const context = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(source.replaceAll('export ', '') + '\nglobalThis.Parser = SseParser;'), context);
const plain = value => JSON.parse(JSON.stringify(value));

test('SSE frames survive every possible transport split including CRLF and BOM', () => {
  const input = '\uFEFF: ready\r\nid: 7\r\nevent: delta\r\ndata: 第一行\r\ndata: 第二行\r\n\r\nid: 8\ndata: done\n\n';
  for (let i = 0; i <= input.length; i++) {
    const parser = new context.Parser();
    assert.deepEqual(plain([...parser.push(input.slice(0, i)), ...parser.push(input.slice(i))]), [
      {event: 'delta', data: '第一行\n第二行', id: '7'}, {event: 'message', data: 'done', id: '8'}
    ]);
  }
});

test('incomplete frame is retained, comments and unknown fields cannot emit business events', () => {
  const parser = new context.Parser();
  assert.deepEqual(plain(parser.push(': heartbeat\n\nretry: 1000\n\ndata: {"text":"半')), []);
  assert.deepEqual(plain(parser.push('句"}\n')), []);
  assert.deepEqual(plain(parser.push('\n')), [{event:'message', data:'{"text":"半句"}', id:''}]);
});

test('unterminated oversized payload is bounded', () => {
  const parser = new context.Parser();
  assert.throws(() => parser.push('data: ' + 'x'.repeat(1024 * 1024)), /上限/);
});
