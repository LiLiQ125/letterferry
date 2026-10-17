import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AdapterStore} from '../src/store.mjs';
import {WebHostStore} from '../src/web-host-store.mjs';
import {assessUnsentBrowserClick,reviewUnsentBrowserClick} from '../scripts/review-stalled-chat-before-click.mjs';

function fixture({code='SEND_BUTTON_NOT_FOUND'}={}){
 const root=mkdtempSync(join(tmpdir(),'review-preclick-'));
 const adapterPath=join(root,'adapter.sqlite'),webPath=join(root,'web.sqlite');
 const a=new AdapterStore(adapterPath),w=new WebHostStore(webPath);
 const row=a.ingest({accountId:'test-account',fromUserId:'peer',chatId:'peer',messageId:'message-one',text:'a normal chat'},'sealed-test-only');
 a.noteBridgeAttempt(row.id);
 const web=w.enqueue({text:'[WeChat authorized text | adapter_event='+row.id+']\na normal chat',idempotencyKey:'weixin:'+row.id});
 a.bridgeQueued(row.id,web.id);
 assert.equal(w.claim().id,web.id);
 w.unknown(web.id,{stage:'BROWSER_DELIVERY',code});
 a.close();w.close();
 return {adapterPath,webPath,adapterId:row.id,webId:web.id};
}
function inspect(f){
 const a=new AdapterStore(f.adapterPath),w=new WebHostStore(f.webPath);
 try{return {adapter:a.get(f.adapterId).status,web:w.get(f.webId).status};}
 finally{a.close();w.close();}
}
const run=(f,ask)=>reviewUnsentBrowserClick({...f,ask,print:()=>{},checkPaused:()=>true,hostOnline:async()=>false});

test('exact matched single send-button-not-found failure can be assessed',()=>{
 const f=fixture();
 const a=new AdapterStore(f.adapterPath),w=new WebHostStore(f.webPath);
 try{
  const result=assessUnsentBrowserClick({
   adapterRows:a.list(),webRows:w.db.prepare('SELECT id,status FROM web_host_events').all(),
   web:w.get(f.webId),diagnostic:w.diagnostic(f.webId),adapterId:f.adapterId,webId:f.webId
  });
  assert.deepEqual(result,{adapterId:f.adapterId,webId:f.webId});
 }finally{a.close();w.close();}
});
test('no human confirmation performs no changes',async()=>{
 const f=fixture();
 assert.equal(await run(f,async()=>''),'CANCELLED');
 assert.deepEqual(inspect(f),{adapter:'BRIDGE_QUEUED',web:'DELIVERY_UNKNOWN'});
});
test('human-exact-confirmed review marks both linked rows without any send',async()=>{
 const f=fixture();
 assert.equal(await run(f,async()=> 'REVIEW '+f.webId+' NO REPLAY'),'REVIEWED_NO_REPLAY');
 assert.deepEqual(inspect(f),{adapter:'REVIEWED_NO_REPLAY',web:'REVIEWED_NO_REPLAY'});
});
test('wrong failure code cannot be reviewed by preclick helper',async()=>{
 const f=fixture({code:'ASSISTANT_TURN_NOT_FOUND'});
 await assert.rejects(run(f,async()=>{throw Error('SHOULD_NOT_ASK');}),/REVIEW_NOT_PRECLICK_SEND_FAILURE/);
 assert.deepEqual(inspect(f),{adapter:'BRIDGE_QUEUED',web:'DELIVERY_UNKNOWN'});
});
test('host online or bridge not paused blocks review before opening writable DB',async()=>{
 const f=fixture();
 await assert.rejects(reviewUnsentBrowserClick({...f,checkPaused:()=>false,hostOnline:async()=>false,ask:async()=>''}),/REVIEW_PAUSE_BRIDGE_FIRST/);
 await assert.rejects(reviewUnsentBrowserClick({...f,checkPaused:()=>true,hostOnline:async()=>true,ask:async()=>''}),/REVIEW_STOP_WEB_HOST_FIRST/);
 assert.deepEqual(inspect(f),{adapter:'BRIDGE_QUEUED',web:'DELIVERY_UNKNOWN'});
});
