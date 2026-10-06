import assert from 'node:assert/strict';
import test from 'node:test';
import { CompanionDesktopClient, historyEntries } from '../src/companionDesktopClient.js';

test('older messages follow prev_cursor and keep the verified room identity', async () => {
  const expressions=[];
  const c=new CompanionDesktopClient({ensureConnected:async()=>{},evaluate:async expression=>{
    expressions.push(expression);
    return {items:[{id:'m',role:'user',account_user_id:'u',content:{text:'hello'}}],prev_cursor:'older',next_cursor:'newer'};
  },close(){}});
  c.profile={id:'a',roomId:'room-a'};
  c.roomMetadata={authors:[{accountUserId:'u',role:'user'}]};
  const page=await c.messages({before:'cursor-1'});
  assert.equal(page.nextCursor,'older');
  assert.equal(page.entries[0].text,'hello');
  assert.match(expressions[0],/room-a/);
  assert.match(expressions[0],/cursor-1/);
  assert.match(expressions[0],/limit:32/);
  await assert.rejects(c.messages({before:{unexpected:true}}),/Invalid/);
});

test('avatar comes only from the unique Companion member of the discovered room', async () => {
  const expressions=[];
  const c=new CompanionDesktopClient({ensureConnected:async()=>{},evaluate:async expression=>{
    expressions.push(expression);
    return expressions.length===1 ? {id:'p',name:'Bear',roomId:'r'} : {avatarUrl:'https://example.com/real-avatar.png',authors:[{accountUserId:'bot',role:'assistant'}]};
  },close(){}});
  const profile=await c.profileDetails();
  assert.equal(profile.avatarUrl,'https://example.com/real-avatar.png');
  assert.match(expressions[1],/member.aeon_id === room.aeon_id/);
  assert.match(expressions[1],/members.length !== 1/);
  assert.match(expressions[1],/"roomId":"r"/);
});

test('room membership separates Bear from self even when the API labels both roles user', () => {
  const entries=historyEntries([
    {id:'1',role:'user',account_user_id:'self',content:{text:'question'}},
    {id:'2',role:'user',account_user_id:'bear',content:{text:'answer'}},
    {id:'3',role:'user',account_user_id:'unknown',content:{text:'do not misattribute'}}
  ],[{accountUserId:'self',role:'user'},{accountUserId:'bear',role:'assistant'}]);
  assert.deepEqual(entries.map(entry=>entry.role),['user','assistant']);
  assert.equal(entries[1].text,'answer');
});

test('null cursors on a full page fall back to the oldest raw message id, including call-only messages', async () => {
  const items=Array.from({length:32},(_,i)=>({id:`m-${i}`,created_at:String(1000+i),role:'user',account_user_id:'u',content:{text:i===0?null:`message ${i}`}}));
  const c=new CompanionDesktopClient({ensureConnected:async()=>{},evaluate:async()=>({items:items.reverse(),prev_cursor:null,next_cursor:null}),close(){}});
  c.profile={id:'p',roomId:'r'};
  c.roomMetadata={authors:[{accountUserId:'u',role:'user'}]};
  const page=await c.messages();
  assert.equal(page.nextCursor,'m-0');
  assert.equal(page.entries.length,31);
});

test('room history preserves full text, orders messages, and excludes deleted and call-only entries', () => {
  assert.deepEqual(historyEntries([
    {id:'b',role:'assistant',created_at:'2026-10-04T01:00:02Z',content:{text:'second'}},
    {id:'removed',deleted_at:'now',content:{text:'private deleted'}},
    {id:'call',content:{text:null,attachments:[{type:'call'}]}},
    {id:'a',role:'user',created_at:'2026-10-04T01:00:01Z',content:{text:'first\nline'}}
  ]), [
    {itemId:'room:a',role:'user',text:'first\nline',final:true},
    {itemId:'room:b',role:'assistant',text:'second',final:true}
  ]);
});

test('a desktop account or selected assistant change cannot silently retarget a call', async () => {
  let profile = {id:'a',name:'assistant',roomId:'r1'};
  const c = new CompanionDesktopClient({ensureConnected:async()=>{},evaluate:async()=>profile,close(){}});
  await c.discover();
  profile = {id:'b',name:'different',roomId:'r2'};
  await assert.rejects(c.start({sdp:'v=0\r\n'}), /selection changed/);
  assert.equal(c.profile.id,'a');
  assert.equal(c.callId,null);
});

test('attach and stop require an owned call, and creation is not silently retried', async () => {
  const expressions=[];
  const c = new CompanionDesktopClient({ensureConnected:async()=>{},evaluate:async expression=>{
    expressions.push(expression);
    if(expression.includes('const result = await api.safeGet')) return {id:'a',name:'assistant',roomId:'r'};
    if(expression.includes('const response = await api.postResponse')) return {callId:'rtc_test',sdp:'v=0\r\n'};
    return {ok:true};
  },close(){}});
  await assert.rejects(c.attach(),/No owned/);
  assert.deepEqual(await c.stop(),{ok:true});
  assert.equal(expressions.length,0);
  await c.start({sdp:'v=0\r\n'});
  await assert.rejects(c.start({sdp:'v=0\r\n'}),/already allocated/);
  await c.attach();
  await c.stop();
  assert.equal(c.callId,null);
  assert.equal(expressions.filter(e=>e.includes('const response = await api.postResponse')).length,1);
  assert.ok(expressions.at(-1).includes('rtc_test'));
});
