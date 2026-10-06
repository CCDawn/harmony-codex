import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../HarmonyCodexRemote/entry/src/main/resources/rawfile/computer/protocol.js', import.meta.url),'utf8'), context);
const protocol = context.ComputerProtocol;
test('mouse wire packet uses little-endian coordinates and clamps edges', () => {
  assert.deepEqual([...new Uint8Array(protocol.move(1025,513))], [1,4,0,1,4,1,2]);
  const v=new DataView(protocol.move(-5,70000));assert.equal(v.getUint16(3,true),0);assert.equal(v.getUint16(5,true),65535);
});
test('wheel direction is inverted and bounded like the desktop viewer', () => {
  assert.deepEqual([...new Uint8Array(protocol.scroll(50,-4))],[2,4,0,246,255,4,0]);
});
test('mouse buttons and Unicode keys have distinct uint64 keysym encoding', () => {
  const mouse=new DataView(protocol.key('Pointer_Button1',true));
  assert.equal(mouse.getUint8(0),3);assert.equal(mouse.getUint16(1,true),8);assert.equal(mouse.getBigUint64(3,true),1n);
  const up=new DataView(protocol.key('中',false));
  assert.equal(up.getUint8(0),4);assert.equal(up.getBigUint64(3,true),BigInt(0x01004e2d));
  assert.equal(protocol.keysym('Return'),0xff0d);
  assert.equal(protocol.keyName({key:'Enter',location:0}),'Return');
  assert.equal(protocol.keyName({key:'Control',location:2}),'ControlRight');
  assert.equal(protocol.keyName({key:'Unidentified',location:0}),null);
});
