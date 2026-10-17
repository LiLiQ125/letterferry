import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {WebHostStore} from '../src/web-host-store.mjs';
import {normalizeWebFailure,classifyBrowserFailure} from '../src/web-host-diagnostics.mjs';
import {createWebHostServer} from '../src/web-host-server.mjs';
import {ExistingBridgeClient} from '../src/bridge-client.mjs';

function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'rwb-diagnostic-'));
 const path=join(dir,'events.sqlite');
 const store=new WebHostStore(path);
 const key='e'.repeat(64);
 const owner={tabId:7,url:'https://chatgpt.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};
 return {dir,path,store,key,owner,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
const message=()=>({text:'safe simulated payload',idempotencyKey:'weixin:'+randomUUID()});

test('fixed diagnostic allowlist redacts browser exception data',()=>{
 assert.deepEqual(normalizeWebFailure({stage:'BROWSER_DELIVERY',code:'PAGE_NOT_READY'}),{stage:'BROWSER_DELIVERY',code:'PAGE_NOT_READY'});
 assert.deepEqual(normalizeWebFailure({stage:'private url',code:'secret cookie'}),{stage:'UNKNOWN_STAGE',code:'UNKNOWN_ERROR'});
 assert.equal(classifyBrowserFailure(new Error('Could not establish connection. Receiving end does not exist.')),'BROWSER_RECEIVER_MISSING');
 assert.equal(classifyBrowserFailure(new Error('https://private.example/?token=secret')),'BROWSER_MESSAGE_REJECTED');
});

test('durable diagnosis never modifies or requeues ambiguous browser delivery',()=>{
 const f=fixture();
 try{
  const event=f.store.enqueue(message());
  assert.equal(f.store.claim().id,event.id);
  f.store.unknown(event.id,{stage:'BROWSER_DELIVERY',code:'PAGE_NOT_READY'});
  const diag=f.store.diagnostic(event.id);
  assert.equal(diag.stage,'BROWSER_DELIVERY');
  assert.equal(diag.code,'PAGE_NOT_READY');
  assert.equal(f.store.get(event.id).status,'DELIVERY_UNKNOWN');
  assert.equal(f.store.claim(),null);
  const reopened=new WebHostStore(f.path);
  assert.equal(reopened.diagnostic(event.id).code,'PAGE_NOT_READY');
  assert.equal(reopened.get(event.id).status,'DELIVERY_UNKNOWN');
  assert.equal(reopened.enqueue({text:'safe simulated payload',idempotencyKey:event.idempotency_key}).id,event.id);
  reopened.close();
 }finally{f.close();}
});

test('unknown failures and succeeded events never overwrite an existing diagnosis',()=>{
 const f=fixture();
 try{
  const a=f.store.enqueue(message());
  f.store.claim();
  f.store.unknown(a.id,{stage:'host-local-secret',code:'token=value'});
  assert.deepEqual({stage:f.store.diagnostic(a.id).stage,code:f.store.diagnostic(a.id).code},{stage:'UNKNOWN_STAGE',code:'UNKNOWN_ERROR'});
  f.store.unknown(a.id,{stage:'BROKER_ACK',code:'BROKER_ACK_FAILED'});
  assert.equal(f.store.diagnostic(a.id).code,'UNKNOWN_ERROR');
  assert.equal(f.store.get(a.id).status,'DELIVERY_UNKNOWN');
 }finally{f.close();}
});

test('loopback API returns only controlled diagnostic and rejects wrong Host owner',async()=>{
 const f=fixture();
 const service=createWebHostServer({store:f.store,key:f.key,port:0});
 try{
  const address=await service.start(),root='http://127.0.0.1:'+address.port;
  const browser=new ExistingBridgeClient({origin:root+'/bridge-'+f.key});
  const event=await browser.enqueue(message());
  async function api(path,data){
   const res=await fetch(root+path,{method:'POST',headers:{authorization:'Bearer '+f.key,'content-type':'application/json'},body:JSON.stringify(data)});
   return {status:res.status,body:await res.json()};
  }
  assert.equal((await api('/extension/heartbeat',{...f.owner,ready:true})).status,200);
  assert.equal((await api('/extension/poll',f.owner)).body.event.id,event.eventId);
  assert.equal((await api('/extension/unknown',{id:event.eventId,tabId:99,url:f.owner.url,stage:'BROWSER_DELIVERY',code:'PAGE_NOT_READY'})).status,409);
  assert.equal(f.store.get(event.eventId).status,'ASSIGNED_UNKNOWN');
  assert.equal((await api('/extension/unknown',{...f.owner,id:event.eventId,stage:'BROWSER_DELIVERY',code:'PAGE_NOT_READY'})).status,200);
  const got=await browser.getEvent(event.eventId);
  assert.equal(got.status,'TIMED_OUT_UNKNOWN');
  assert.deepEqual(got.diagnostic,{stage:'BROWSER_DELIVERY',code:'PAGE_NOT_READY'});
  assert.equal(JSON.stringify(got).includes('safe simulated payload'),false);
 }finally{await service.stop();f.close();}
});

test('manual review archives an unknown event without replay and preserves its diagnostic',()=>{
 const f=fixture();
 try{
  const first=f.store.enqueue(message());
  const queued=f.store.enqueue(message());
  f.store.claim();
  f.store.unknown(first.id,{stage:'BROWSER_DELIVERY',code:'BROWSER_RECEIVER_MISSING'});
  assert.equal(f.store.claim(),null);
  assert.equal(f.store.reviewUnknownWithoutReplay(first.id).status,'REVIEWED_NO_REPLAY');
  assert.equal(f.store.get(first.id).status,'REVIEWED_NO_REPLAY');
  assert.equal(f.store.diagnostic(first.id).code,'BROWSER_RECEIVER_MISSING');
  assert.equal(f.store.enqueue({text:'safe simulated payload',idempotencyKey:first.idempotency_key}).status,'REVIEWED_NO_REPLAY');
  assert.equal(f.store.claim().id,queued.id);
  assert.throws(()=>f.store.reviewUnknownWithoutReplay(first.id),/EVENT_NOT_REVIEWABLE/);
  assert.throws(()=>f.store.reviewUnknownWithoutReplay('not-an-id'),/INVALID_EVENT_ID/);
 }finally{f.close();}
});
