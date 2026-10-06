import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexDesktopCdpClient } from '../src/codexDesktopCdpClient.js';
import { DesktopScriptBridge } from '../src/desktopScriptBridge.js';

for (const Client of [CodexDesktopCdpClient, DesktopScriptBridge]) {
  test(`${Client.name} requests full paginated items when checking inserted messages`, async () => {
    const client = new Client();
    const inserted = { type: 'userMessage', content: [{ type: 'text', text: 'inserted message' }] };
    client.request = async (method, params) => {
      if (method === 'thread/read') {
        assert.equal(params.includeTurns, false);
        return { thread: { id: 'target' } };
      }
      assert.equal(method, 'thread/turns/list');
      assert.equal(params.itemsView, 'full');
      assert.equal(params.limit, 10);
      return { data: [{ id: 'current', status: 'completed', items: [inserted] }] };
    };
    const detail = await client.readRecentThread('target', { itemsView: 'full' });
    assert.deepEqual(detail.thread.turns[0].items, [inserted]);
  });
}
