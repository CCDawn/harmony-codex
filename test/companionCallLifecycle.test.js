import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CompanionCallJournal, CompanionCallLifecycle } from '../src/companionCallLifecycle.js';
import { CompanionDesktopClient } from '../src/companionDesktopClient.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-calls-'));
  t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  const journal = new CompanionCallJournal(dir);
  const events = [];
  const client = {
    profile: {id:'assistant-a',roomId:'room-a'}, callId:null,
    async discover() { return this.profile; },
    async start() { events.push('start');this.callId='rtc_new';return {callId:this.callId,sdp:'v=0'}; },
    async stop() { events.push(`stop:${this.callId}`);if(this.failStop)throw Object.assign(new Error('upstream'),{status:502});this.callId=null;return {ok:true}; }
  };
  const lifecycle = new CompanionCallLifecycle(client,journal,{pid:100,isAlive:()=>false});
  return {dir,journal,client,lifecycle,events};
}
const old = {version:1,profileId:'assistant-a',roomId:'room-a',callId:'rtc_old',ownerPid:99};

test('creation receipt is durable before returning and contains no audio or conversation', async t => {
 const {journal,lifecycle}=fixture(t);await lifecycle.start({sdp:'private-offer'});
 const [receipt]=journal.list();assert.equal(receipt.callId,'rtc_new');
 assert.equal(receipt.ownerPid,100);assert.ok(!JSON.stringify(receipt).includes('private-offer'));
 await lifecycle.stop();assert.deepEqual(journal.list(),[]);
});

test('failed stop survives a new lifecycle, and recovery precedes another creation', async t => {
 const {journal,lifecycle,client,events}=fixture(t);await lifecycle.start({});client.failStop=true;
 await assert.rejects(lifecycle.stop(),{status:502});assert.equal(journal.list().length,1);
 const restartedClient={...client,callId:null,failStop:false};
 const restarted=new CompanionCallLifecycle(restartedClient,journal,{pid:101,isAlive:()=>false});
 await restarted.start({});assert.deepEqual(events,['start','stop:rtc_new','stop:rtc_new','start']);
 assert.equal(journal.list()[0].ownerPid,101);
});

test('failed orphan cleanup preserves receipt without blocking or owning the new call', async t => {
 const {journal,lifecycle,client,events}=fixture(t);journal.put(old);client.failStop=true;
 await lifecycle.start({});
 assert.deepEqual(events,['stop:rtc_old','start']);
 assert.ok(journal.list().find(r=>r.callId==='rtc_old').cleanupDeferredAt);
 client.failStop=false;await lifecycle.stop();
 assert.deepEqual(events,['stop:rtc_old','start','stop:rtc_new']);
 assert.equal(journal.list().length,1);
 await lifecycle.start({});
 assert.deepEqual(events,['stop:rtc_old','start','stop:rtc_new','start']);
 await lifecycle.stop();
});

test('multiple orphans are retained and a live owner is checked before cleanup', async t => {
 const {journal,client,events}=fixture(t);
 journal.put(old);journal.put({...old,callId:'rtc_other',ownerPid:98});
 const live=new CompanionCallLifecycle(client,journal,{pid:100,isAlive:pid=>pid===98});
 await assert.rejects(live.start({}),/still owns/);assert.deepEqual(events,[]);
 const restarted=new CompanionCallLifecycle(client,journal,{pid:100,isAlive:()=>false});
 client.failStop=true;await restarted.start({});
 assert.equal(events.filter(e=>e.startsWith('stop:')).length,2);
 client.failStop=false;await restarted.stop();
 assert.equal(journal.list().length,2);
 assert.ok(journal.list().every(r=>r.cleanupDeferredAt));
});

test('calls belonging to a live helper or another assistant are never stopped', async t => {
 const {journal,client,events}=fixture(t);journal.put(old);
 const live=new CompanionCallLifecycle(client,journal,{pid:100,isAlive:()=>true});
 await assert.rejects(live.start({}),/still owns/);assert.deepEqual(events,[]);
 client.profile={id:'assistant-b',roomId:'room-b'};
 await live.start({});assert.deepEqual(events,['start']);assert.equal(journal.list().length,2);
});

test('reuses the discovered profile for recovery but refreshes identity immediately before call creation', async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'companion-calls-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const journal=new CompanionCallJournal(dir);
 const profileA={id:'assistant-a',name:'Assistant A',roomId:'room-a'};
 const profileB={id:'assistant-b',name:'Assistant B',roomId:'room-b'};
 journal.put({...old,profileId:profileB.id,roomId:profileB.roomId,callId:'rtc_other'});
 let discoverCalls=0, startCalls=0;
 const expressions=[];
 const client=new CompanionDesktopClient({ensureConnected:async()=>{},evaluate:async expression=>{
  expressions.push(expression);
  if(expression.includes("const result = await api.safeGet('/tbo/primary'")){
   discoverCalls++;return profileB;
  }
  throw new Error('Unexpected Companion request');
 },close(){}});
 client.profile=profileA;
 const start=client.start.bind(client);
 client.start=async params=>{startCalls++;return start(params);};
 const lifecycle=new CompanionCallLifecycle(client,journal,{pid:100,isAlive:()=>false});

 await assert.rejects(lifecycle.start({sdp:'v=0'}),/selection changed/);
 assert.equal(startCalls,1,'cached profile should pass recovery and reach client.start');
 assert.equal(discoverCalls,1,'client.start must independently fetch the latest assistant profile');
 assert.equal(client.callId,null,'a changed profile must not create a call');
 assert.equal(expressions.some(expression=>expression.includes('/voice/calls')),false);
 assert.deepEqual(journal.list().map(receipt=>receipt.callId),['rtc_other'],
  'recovery for the cached profile must not stop another profile receipt');
});

test('corrupted receipt prevents creation rather than being silently dropped', async t => {
 const {journal,lifecycle,events}=fixture(t);journal.put(old);
 fs.writeFileSync(journal.filename('rtc_old'),'broken');
 await assert.rejects(lifecycle.start({}));assert.deepEqual(events,[]);
});

test('receipt storage failure stops the new call and never returns it as ready', async t => {
 const {journal,lifecycle,events}=fixture(t);journal.put=()=>{throw Error('disk full');};
 await assert.rejects(lifecycle.start({}),/disk full/);assert.deepEqual(events,['start','stop:rtc_new']);
});

test('no call ownership means no stop request', async t => {
 const {lifecycle,events}=fixture(t);await lifecycle.stop();assert.deepEqual(events,[]);
});
