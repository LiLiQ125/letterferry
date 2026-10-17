import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AdapterStore} from '../src/store.mjs';
import {AllowlistPolicy} from '../src/policy.mjs';
import {WeixinBridgeAdapter} from '../src/adapter.mjs';
import {readAlwaysOn,writeAlwaysOn,assertAutoBinding,classifyRecovery,
 durableStartupBatch,validPinnedChatUrl,AUTO_VERSION} from '../src/always-on-policy.mjs';
import {controlMode} from '../scripts/always-on-control.mjs';
const chatUrl='https://chatgpt.com/g/g-p-6a9e46e6f7988191829ae0887ef75f9d-riven/c/6ad2235a-48cc-83eb-bbe3-60fdc12412ae';
const peer={userId:'one-user',chatId:'one-user'},accountId='bot';
const raw=(msg,text,extra={})=>({
 message_id:msg,from_user_id:peer.userId,to_user_id:accountId,message_type:1,message_state:2,
 context_token:'token-'+msg,item_list:[{type:1,text_item:{text}}],...extra
});
function fixture(){
 const path=join(mkdtempSync(join(tmpdir(),'rwx-always-')),'adapter.sqlite');
 const store=new AdapterStore(path);
 const adapter=new WeixinBridgeAdapter({
  accountId,policy:new AllowlistPolicy({accountId,allowedPeers:[peer]}),
  store,encryptionKey:Buffer.alloc(32,7),transport:{},bridge:{}
 });
 return {store,adapter};
}
test('pinned URL and durable owner authorization are exact and reversible',()=>{
 assert.equal(validPinnedChatUrl(chatUrl),true);
 for(const bad of ['https://example.com/c/6ad2235a-48cc-83eb-bbe3-60fdc12412ae',
  chatUrl+'#other',chatUrl+'?hello=true','http://chatgpt.com/c/6ad2235a-48cc-83eb-bbe3-60fdc12412ae']){
  assert.equal(validPinnedChatUrl(bad),false);
 }
 const dir=mkdtempSync(join(tmpdir(),'rwx-config-')),path=join(dir,'always-on.json');
 assert.equal(readAlwaysOn(path).enabled,false);
 const enabled=controlMode('enable',null,chatUrl);
 assert.equal(enabled.version,AUTO_VERSION);
 writeAlwaysOn(enabled,path);
 assert.equal(readAlwaysOn(path).chatUrl,chatUrl);
 assert.equal(readAlwaysOn(path).enabled,true);
 assert.equal(controlMode('pause',enabled).paused,true);
 assert.equal(controlMode('resume',controlMode('pause',enabled)).paused,false);
 assert.equal(controlMode('disable',enabled).enabled,false);
 assert.throws(()=>controlMode('enable',null,'https://another.example.com'),/PINNED_CHAT/);
 assert.deepEqual(assertAutoBinding({allowedPeer:peer,inboundEnabled:false,outboundEnabled:false},enabled),peer);
 assert.throws(()=>assertAutoBinding({allowedPeer:peer,inboundEnabled:true,outboundEnabled:false},enabled),/PERSISTENT_FLAGS/);
 assert.throws(()=>assertAutoBinding({allowedPeer:peer,inboundEnabled:false,outboundEnabled:false},controlMode('pause',enabled)),/NOT_ENABLED/);
});
test('startup backlog is atomically saved as deferred and never sent or bridged',()=>{
 const f=fixture(),batch=[raw('a','old DM'),raw('b','startup DM')];
 const result=durableStartupBatch({store:f.store,adapter:f.adapter,updates:batch,accountId,peer});
 assert.deepEqual(result,{newlyDeferred:2,alreadyStored:0,total:2});
 assert.deepEqual(f.store.list().map(x=>x.status),['DEFERRED_BACKLOG','DEFERRED_BACKLOG']);
 assert.equal(f.store.next('RECEIVED'),undefined);
 const duplicated=durableStartupBatch({store:f.store,adapter:f.adapter,updates:batch,accountId,peer});
 assert.deepEqual(duplicated,{newlyDeferred:0,alreadyStored:2,total:2});
 f.store.close();
});
test('malformed startup batch is rolled back without cursor success or partial archive',()=>{
 const f=fixture();
 assert.throws(()=>durableStartupBatch({
  store:f.store,adapter:f.adapter,
  updates:[raw('a','good'),raw('b','invalid',{context_token:''})],
  accountId,peer
 }),/ALWAYS_ON_BATCH_UNSAFE/);
 assert.equal(f.store.list().length,0);
 f.store.close();
});
test('no restart/replay of uncertain outbound, unknown bridge submit, or incomplete origin',()=>{
 const safe=[
  {status:'DEFERRED_BACKLOG'},
  {status:'SUCCEEDED'},
  {status:'REVIEWED_NO_REPLAY'},
  {status:'REPLY_READY',bridge_submit_attempts:1,bridge_event_id:'web1'},
  {status:'BRIDGE_QUEUED',bridge_submit_attempts:1,bridge_event_id:'web2'},
  {status:'RECEIVED',bridge_submit_attempts:0}
 ];
 assert.equal(classifyRecovery(safe).active,3);
 for(const unsafe of [
  {status:'OUTBOUND_UNKNOWN'},
  {status:'OUTBOUND_SENDING'},
  {status:'RECEIVED',bridge_submit_attempts:1},
  {status:'BRIDGE_QUEUED',bridge_submit_attempts:0},
  {status:'REPLY_READY',bridge_submit_attempts:1,bridge_event_id:null}
 ])assert.throws(()=>classifyRecovery([...safe,unsafe]),/REQUIRES_REVIEW|UNKNOWN/);
});
