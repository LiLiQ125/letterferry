import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebHostStore} from '../src/web-host-store.mjs';
import {AdapterStore} from '../src/store.mjs';
import {identifyManualInputFailure,closeReviewedInputFailure} from '../scripts/review-one-shot-browser-input-failure.mjs';

const challenge='RWX_WEB_ONCE_'+'A'.repeat(24);
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'rwb-web-no-replay-'));
 const adapterPath=join(dir,'adapter.sqlite'),webPath=join(dir,'web.sqlite');
 const a=new AdapterStore(adapterPath),w=new WebHostStore(webPath);
 const row=a.ingest({accountId:'bot',fromUserId:'paired',chatId:'paired',
   messageId:'incoming-1',text:challenge},'private-context-stub');
 a.noteBridgeAttempt(row.id);
 const event=w.enqueue({text:'[WeChat authorized text | adapter_event='+row.id+']\n'+challenge,
   idempotencyKey:'weixin:'+row.id});
 a.bridgeQueued(row.id,event.id);
 w.claim();
 w.unknown(event.id,{stage:'BROWSER_DELIVERY',code:'INPUT_NOT_CONFIRMED'});
 a.close();w.close();
 return {dir,adapterPath,webPath,rowId:row.id,eventId:event.id,
   cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}
test('exact input-not-confirmed failure can be manually reviewed but only with explicit typed consent',async()=>{
 const f=fixture();
 try{
   const prints=[];
   assert.equal(await closeReviewedInputFailure({adapterPath:f.adapterPath,webPath:f.webPath,
     isHostOnline:async()=>false,ask:async()=> 'wrong approval',
     print:x=>prints.push(x)}),'CANCELLED');
   assert.match(prints.join(' '),/CANCELLED_WITHOUT_DB_CHANGE/);
   const a=new AdapterStore(f.adapterPath),w=new WebHostStore(f.webPath);
   assert.equal(a.get(f.rowId).status,'BRIDGE_QUEUED');
   assert.equal(w.get(f.eventId).status,'DELIVERY_UNKNOWN');
   a.close();w.close();
   const result=await closeReviewedInputFailure({adapterPath:f.adapterPath,webPath:f.webPath,
     isHostOnline:async()=>false,
     ask:async()=> 'REVIEW '+f.eventId+' NO REPLAY',
     print:()=>{}});
   assert.equal(result,'REVIEWED_NO_REPLAY');
   const a2=new AdapterStore(f.adapterPath),w2=new WebHostStore(f.webPath);
   assert.equal(a2.get(f.rowId).status,'REVIEWED_NO_REPLAY');
   assert.equal(w2.get(f.eventId).status,'REVIEWED_NO_REPLAY');
   assert.equal(w2.get(f.eventId).reply_text,null);
   assert.equal(a2.get(f.rowId).bridge_event_id,f.eventId);
   assert.equal(a2.next('BRIDGE_QUEUED'),undefined);
   a2.close();w2.close();
 }finally{f.cleanup();}
});
test('host must be offline before irreversible no-replay review',async()=>{
 const f=fixture();
 try{
  await assert.rejects(()=>closeReviewedInputFailure({
    adapterPath:f.adapterPath,webPath:f.webPath,isHostOnline:async()=>true,
    ask:async()=>{throw Error('PROMPT_MUST_NOT_HAPPEN');}}),/STOP_LOCAL_WEB_HOST/);
 }finally{f.cleanup();}
});
test('wrong browser diagnostic or mismatched Web Host input cannot be reviewed as input failure',()=>{
 const row={id:'adapter',status:'BRIDGE_QUEUED',bridge_event_id:'web',
  bridge_submit_attempts:1,text:challenge};
 const web={id:'web',status:'DELIVERY_UNKNOWN',
  text:'[WeChat authorized text | adapter_event=adapter]\n'+challenge,reply_text:null};
 assert.deepEqual(identifyManualInputFailure([row],web,
  {stage:'BROWSER_DELIVERY',code:'INPUT_NOT_CONFIRMED'}),row);
 assert.throws(()=>identifyManualInputFailure([row],web,
  {stage:'BROWSER_DELIVERY',code:'ASSISTANT_TURN_NOT_FOUND'}),/UNEXPECTED_FAILURE/);
 assert.throws(()=>identifyManualInputFailure([row],{...web,text:'other text'},
  {stage:'BROWSER_DELIVERY',code:'INPUT_NOT_CONFIRMED'}),/PAYLOAD_MISMATCH/);
 assert.throws(()=>identifyManualInputFailure([{...row,bridge_submit_attempts:2}],web,
  {stage:'BROWSER_DELIVERY',code:'INPUT_NOT_CONFIRMED'}),/MISMATCHED_ONE_SHOT/);
});
