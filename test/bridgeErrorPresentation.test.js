import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
const source=fs.readFileSync('HarmonyCodexRemote/entry/src/main/ets/services/BridgeClient.ets','utf8');
const start=source.indexOf('  private static formatErrorBody(');
const end=source.indexOf('  private static isTransientBridgeError(',start);
assert.ok(start>=0 && end>start);
const format=new Function(stripTypeScriptTypes(`class BridgeClient {${source.slice(start,end)}}`)+ '; return BridgeClient.formatErrorBody;')();
const transientEnd=source.indexOf('  private static delay(',end);
const transient=new Function(stripTypeScriptTypes(`class BridgeClient {${source.slice(end,transientEnd)}}`)+ '; return BridgeClient.isTransientBridgeError;')();
test('proxy HTML is a short readable transport error rather than page markup',()=>{
 for(const body of ['<html>\n<head><title>502 Bad Gateway</title></head><body>nginx</body></html>', '\uFEFF  <!DOCTYPE html><html><body>unavailable</body></html>']){
  const value=format(body);assert.ok(value.length<80);assert.doesNotMatch(value,/<|>|nginx|DOCTYPE/);
 }
});
test('structured desktop errors retain their diagnostic fields',()=>{
 const value=format(JSON.stringify({error:'Desktop unavailable',desktop:{status:'offline',currentSessionId:'current',targetSessionId:'target',reason:'CDP unavailable'}}));
 for(const part of ['Desktop unavailable','offline','current','target','CDP unavailable'])assert.ok(value.includes(part));
});
test('plain error text remains readable while unusually large bodies are bounded',()=>{
 assert.equal(format('  Service unavailable  '),'Service unavailable');
 assert.ok(format('failure '.repeat(1000)).length<=241);
});

test('proxy HTTP 413 describes an upload size limit instead of a temporary connection fault',()=>{
 for(const body of ['<html><head><title>413 Request Entity Too Large</title></head></html>', '']){
  const value=format(body,413);
  assert.match(value,/上传内容.*大小限制/);
  assert.doesNotMatch(value,/暂时不可用|稍后重试|<|>/);
 }
});

test('structured HTTP 413 preserves the bridge attachment limit explanation',()=>{
 assert.equal(format(JSON.stringify({error:'图片超过 15MB，请先压缩后再发送。'}),413),'图片超过 15MB，请先压缩后再发送。');
});

test('an HTTP 413 is never classified as transient because its body mentions timeout',()=>{
 assert.equal(transient('桥接返回异常 HTTP 413：upstream upload timeout'),false);
 assert.equal(transient('桥接请求失败：operation timeout'),true);
});

test('the native HTTP request supplies status 413 to safe error formatting',async()=>{
 const requestStart=source.indexOf('  private static async requestOnce(');
 const requestEnd=source.indexOf('  private static is2faRequired(',requestStart);
 let destroyed=0;
 const http={createHttp(){return {async request(){return {responseCode:413,result:'<html><body>413 Request Entity Too Large</body></html>'};},destroy(){destroyed++;}};}};
 const request=new Function('http','TotpGenerator','CredentialRuntime',stripTypeScriptTypes(
  `class BridgeClient {${source.slice(requestStart,requestEnd)} ${source.slice(start,end)}}`)+ '; return BridgeClient.requestOnce;')(
   http,{async currentCode(){return '';}},{getRuntimeTotpSecret(){return '';}});
 await assert.rejects(request('POST','https://bridge.example/mobile/images','{}',''),error=>{
  assert.match(error.message,/HTTP 413/); assert.match(error.message,/上传内容.*大小限制/);
  assert.doesNotMatch(error.message,/暂时不可用|<html>/); return true;
 });
 assert.equal(destroyed,1);
});
