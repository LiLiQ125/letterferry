import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ImageReceiptStore} from '../src/image-receipt-store.mjs';
import {stageBatchImages} from '../src/image-inbound-batch-stage.mjs';

const ACCOUNT='owner-account',PEER='authorized-peer';
const KEY=Buffer.from('9a'.repeat(32),'hex');
const PNG=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.from('image-one')]);
const PNG2=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.from('image-two')]);
const imageResult=(bytes=PNG)=>({bytes,mimeType:'image/png',fileName:'wechat-image.png'});
const peer={userId:PEER,chatId:PEER};
function raw(id,{from=PEER,to=ACCOUNT,type=1,state=2,items}={}){
  return {message_id:id,from_user_id:from,to_user_id:to,message_type:type,message_state:state,
    item_list:items??[{type:2,msg_id:id,image_item:{media:{encrypt_query_param:'fake-'+id}}}]};
}
function fixture({now=()=>1000,ttlMs=10_000}={}){
  const dir=mkdtempSync(join(tmpdir(),'riven-image-batch-'));
  const store=new ImageReceiptStore({filename:join(dir,'receipts.sqlite'),secretKey:KEY,
    accountId:ACCOUNT,allowedPeer:peer,ttlMs,now});
  return {dir,store,cleanup(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
async function stage(f,messages,downloadAndDecrypt=async()=>imageResult(),nextCursor='cursor-next'){
  return stageBatchImages({batch:{messages,nextCursor},accountId:ACCOUNT,allowedPeer:peer,
    receiptStore:f.store,downloadAndDecrypt});
}

test('single image is durably staged before an explicit one-use cursor record capability exists',async()=>{
  const f=fixture();let downloads=0,records=0,recorded;
  try{
    const result=await stage(f,[raw('m1')],async()=>{downloads++;return imageResult();});
    assert.equal(result.readyForCursorAcknowledgement,true);
    assert.equal(downloads,1);
    assert.equal(result.stagedReceipts[0].receipt.status,'RECEIVED');
    assert.equal('bytes' in result.stagedReceipts[0],false);
    assert.equal(records,0);
    const ack=await result.acknowledgement.record({async recordStagedCursor(value){records++;recorded=value;return {recorded:true};}});
    assert.equal(ack.recorded,true);assert.equal(records,1);assert.equal(recorded.receiptCount,1);
    assert.equal(result.acknowledgement.status,'RECORDED');
    await assert.rejects(result.acknowledgement.record({recordStagedCursor(){}}),/CAPABILITY_ALREADY_USED/);
  }finally{f.cleanup();}
});

test('multiple image messages must all reach durable receipts before cursor acknowledgement',async()=>{
  const f=fixture();
  try{
    const result=await stage(f,[raw('m1'),raw('m2')],async message=>imageResult(message.message_id==='m1'?PNG:PNG2));
    assert.equal(result.readyForCursorAcknowledgement,true);
    assert.equal(result.stagedReceipts.length,2);
    assert.deepEqual(f.store.listReceipts().map(item=>item.messageId),['m1','m2']);
  }finally{f.cleanup();}
});

test('foreign peers, including malformed foreign envelopes, never download, persist or block',async()=>{
  const f=fixture();let downloads=0;
  const ignored=[raw('foreign',{from:'someone-else'}),
    {...raw('group',{from:'someone-else'}),group_id:'group-1'},
    raw('wrong-target',{from:'someone-else',to:'different-account'}),
    raw('bot',{from:'someone-else',type:2}),raw('generating',{from:'someone-else',state:1})];
  try{
    const result=await stage(f,ignored,async()=>{downloads++;return imageResult();});
    assert.equal(result.readyForCursorAcknowledgement,true);
    assert.equal(result.ignoredCount,5);assert.equal(downloads,0);
    assert.deepEqual(f.store.listReceipts(),[]);
  }finally{f.cleanup();}
});

test('group, wrong-target, bot-outbound and nonterminal envelopes naming the allowed peer block the batch',async()=>{
  const cases=[{...raw('group'),group_id:'group-1'},raw('wrong-target',{to:'different-account'}),
    raw('bot',{type:2}),raw('generating',{state:1})];
  for(const message of cases){
    const f=fixture();let downloads=0;
    try{
      const result=await stage(f,[raw('first'),message],async()=>{downloads++;return imageResult();});
      assert.equal(result.readyForCursorAcknowledgement,false);
      assert.match(result.failure.code,/^IMAGE_BATCH_ENVELOPE_/);
      assert.equal(downloads,0);assert.deepEqual(f.store.listReceipts(),[]);
    }finally{f.cleanup();}
  }
});

test('all allowed-message structures are validated before the first download',async()=>{
  const f=fixture();let downloads=0;
  const text={type:1,msg_id:'m2',text_item:{text:'do not swallow me'}};
  try{
    const result=await stage(f,[raw('m1'),raw('m2',{items:[text]})],async()=>{downloads++;return imageResult();});
    assert.equal(result.readyForCursorAcknowledgement,false);
    assert.equal(result.failure.code,'IMAGE_BATCH_UNSUPPORTED_ALLOWED_CONTENT');
    assert.equal(result.acknowledgement,null);assert.equal(downloads,0);
    assert.deepEqual(f.store.listReceipts(),[]);
  }finally{f.cleanup();}
});

test('mixed text plus image, unknown media shape, nonterminal state and missing ID fail closed before download',async()=>{
  const cases=[
    raw('mixed',{items:[raw('mixed').item_list[0],{type:1,msg_id:'mixed',text_item:{text:'caption'}}]}),
    raw('unknown',{items:[{type:3,msg_id:'unknown',file_item:{}}]}),
    {...raw('no-state'),message_state:undefined},
    {...raw('missing'),message_id:undefined,item_list:[{type:2,image_item:{media:{encrypt_query_param:'x'}}}]}
  ];
  for(const message of cases){
    const f=fixture();let downloads=0;
    try{
      const result=await stage(f,[message],async()=>{downloads++;return imageResult();});
      assert.equal(result.readyForCursorAcknowledgement,false);
      assert.equal(downloads,0);assert.equal(result.acknowledgement,null);
    }finally{f.cleanup();}
  }
});

test('download failure exposes a bounded failure and withholds acknowledgement',async()=>{
  const f=fixture();
  try{
    const result=await stage(f,[raw('m1')],async()=>{throw new Error('WEIXIN_IMAGE_TOO_LARGE');});
    assert.equal(result.readyForCursorAcknowledgement,false);
    assert.deepEqual(result.failure,{code:'WEIXIN_IMAGE_TOO_LARGE',index:0,messageId:'m1',receipt:null});
    assert.equal(result.acknowledgement,null);assert.deepEqual(f.store.listReceipts(),[]);
  }finally{f.cleanup();}
});

test('invalid decrypted image format is rejected by receipt validation and never opens cursor gate',async()=>{
  const f=fixture();
  try{
    const result=await stage(f,[raw('m1')],async()=>imageResult(Buffer.from('not-an-image')));
    assert.equal(result.readyForCursorAcknowledgement,false);
    assert.equal(result.failure.code,'IMAGE_MIME_UNSUPPORTED');
    assert.equal(result.acknowledgement,null);assert.deepEqual(f.store.listReceipts(),[]);
  }finally{f.cleanup();}
});

test('second download failure leaves first receipt; repeated batch resumes idempotently then opens gate',async()=>{
  const f=fixture();let failSecond=true;
  try{
    const downloader=async message=>{
      if(message.message_id==='m2'&&failSecond)throw new Error('WEIXIN_IMAGE_DECRYPT_FAILED');
      return imageResult(message.message_id==='m1'?PNG:PNG2);
    };
    const first=await stage(f,[raw('m1'),raw('m2')],downloader);
    assert.equal(first.readyForCursorAcknowledgement,false);
    assert.equal(first.stagedReceipts.length,1);
    assert.equal(f.store.listReceipts().length,1);
    failSecond=false;
    const retry=await stage(f,[raw('m1'),raw('m2')],downloader);
    assert.equal(retry.readyForCursorAcknowledgement,true);
    assert.equal(retry.stagedReceipts[0].created,false);
    assert.equal(retry.stagedReceipts[1].created,true);
    assert.equal(f.store.listReceipts().length,2);
  }finally{f.cleanup();}
});

test('exact duplicate event is downloaded and stored once; same photo under distinct IDs gets distinct receipts',async()=>{
  const f=fixture();let downloads=0;
  try{
    const duplicate=raw('m1');
    const result=await stage(f,[duplicate,duplicate,raw('m2')],async()=>{downloads++;return imageResult(PNG);});
    assert.equal(result.readyForCursorAcknowledgement,true);
    assert.equal(result.duplicateCount,1);assert.equal(downloads,2);
    assert.equal(f.store.listReceipts().length,2);
  }finally{f.cleanup();}
});

test('duplicate ID with different source or persisted plaintext digest conflict fails closed',async()=>{
  const f=fixture();let downloads=0;
  try{
    const changed=raw('m1');changed.item_list[0].image_item.media.encrypt_query_param='different';
    const inBatch=await stage(f,[raw('m1'),changed],async()=>{downloads++;return imageResult();});
    assert.equal(inBatch.failure.code,'IMAGE_BATCH_DUPLICATE_ID_CONFLICT');assert.equal(downloads,0);
    const initial=await stage(f,[raw('m1')],async()=>imageResult(PNG));
    assert.equal(initial.readyForCursorAcknowledgement,true);
    const conflict=await stage(f,[raw('m1')],async()=>imageResult(PNG2));
    assert.equal(conflict.failure.code,'IMAGE_RECEIPT_IDEMPOTENCY_CONFLICT');
    assert.equal(conflict.acknowledgement,null);
  }finally{f.cleanup();}
});

test('empty, typed, control-character and oversized cursors fail before authorization or download',async()=>{
  for(const cursor of ['',null,'bad\nvalue','x'.repeat(16_385)]){
    const f=fixture();let downloads=0;
    try{
      const result=await stage(f,[raw('m1')],async()=>{downloads++;return imageResult();},cursor);
      assert.equal(result.failure.code,'IMAGE_BATCH_CURSOR_INVALID');assert.equal(downloads,0);
    }finally{f.cleanup();}
  }
});

test('cursor recording exception is visible uncertain and capability is never retried',async()=>{
  const f=fixture();let calls=0;
  try{
    const result=await stage(f,[raw('m1')]);
    await assert.rejects(result.acknowledgement.record({async recordStagedCursor(){calls++;throw Error('private detail');}}),
      /CURSOR_ACK_OUTCOME_UNCERTAIN/);
    assert.equal(calls,1);assert.equal(result.acknowledgement.status,'UNCERTAIN');
    await assert.rejects(result.acknowledgement.record({async recordStagedCursor(){calls++;}}),/CAPABILITY_ALREADY_USED/);
    assert.equal(calls,1);
  }finally{f.cleanup();}
});

test('CLAIMED without durable downstream upload proof blocks cursor acknowledgement and never redownloads',async()=>{
  const f=fixture();let downloads=0;
  try{
    const staged=await stage(f,[raw('m1')]);
    assert.equal(staged.readyForCursorAcknowledgement,true);
    const handle=staged.stagedReceipts[0].handle;
    const claim=f.store.claimOnce(handle);
    assert.equal(claim.receipt.status,'CLAIMED');
    const retried=await stage(f,[raw('m1')],async()=>{downloads++;return imageResult();});
    assert.equal(retried.readyForCursorAcknowledgement,false);
    assert.equal(retried.acknowledgement,null);
    assert.equal(retried.failure.code,'IMAGE_RECEIPT_CLAIMED_REQUIRES_REVIEW');
    assert.equal(retried.failure.receipt.status,'CLAIMED');
    assert.equal(downloads,0);
  }finally{f.cleanup();}
});

test('visible FAILED receipt blocks cursor gate without another download',async()=>{
  const f=fixture();let downloads=0;
  try{
    const first=await stage(f,[raw('m1')]);
    assert.equal(first.readyForCursorAcknowledgement,true);
    f.store.archiveFailure({accountId:ACCOUNT,fromUserId:PEER,chatId:PEER,messageId:'m1'},'MANUAL_MEDIA_REJECTED');
    const retried=await stage(f,[raw('m1')],async()=>{downloads++;return imageResult();});
    assert.equal(retried.readyForCursorAcknowledgement,false);
    assert.equal(retried.failure.code,'IMAGE_RECEIPT_TERMINAL_NOT_ACKABLE');
    assert.equal(retried.failure.receipt.status,'FAILED');
    assert.equal(retried.failure.receipt.lastError,'MANUAL_MEDIA_REJECTED');
    assert.equal(downloads,0);
  }finally{f.cleanup();}
});
