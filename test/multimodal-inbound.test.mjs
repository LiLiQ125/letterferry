import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AdapterStore} from '../src/store.mjs';
import {ImageReceiptStore} from '../src/image-receipt-store.mjs';
import {MultimodalBatchJournal,createMultimodalInboundCoordinator} from '../src/multimodal-inbound.mjs';
import {ExplicitMultimodalWeixinTransport,createExplicitWeixinImageDownloader} from '../src/transports/multimodal-weixin.mjs';

const ACCOUNT='owner-account',PEER='authorized-peer',peer={userId:PEER,chatId:PEER};
const CONTEXT_KEY=Buffer.from('31'.repeat(32),'hex'),RECEIPT_KEY=Buffer.from('42'.repeat(32),'hex');
const AES_KEY=Buffer.from('53'.repeat(16),'hex');
const PNG=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.from('offline-multimodal-image')]);
const PNG2=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.from('offline-second-image')]);

function encrypt(bytes,key=AES_KEY){const cipher=createCipheriv('aes-128-ecb',key,null);return Buffer.concat([cipher.update(bytes),cipher.final()]);}
function textMessage(id='text-1',text='hello mixed batch'){
  return {message_id:id,from_user_id:PEER,to_user_id:ACCOUNT,message_type:1,message_state:2,
    context_token:'context-'+id,item_list:[{type:1,msg_id:id,text_item:{text}}]};
}
function imageMessage(id='image-1',overrides={}){
  return {message_id:id,from_user_id:PEER,to_user_id:ACCOUNT,message_type:1,message_state:2,
    context_token:'context-'+id,item_list:[{type:2,msg_id:id,image_item:{aeskey:AES_KEY.toString('hex'),
      media:{full_url:'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=signed-'+id}}}],...overrides};
}
function byteResponse(bytes){
  let delivered=false;
  return {ok:true,headers:{get(name){return name==='content-length'?String(bytes.length):null;}},body:{getReader(){return {
    async read(){if(delivered)return {done:true};delivered=true;return {done:false,value:new Uint8Array(bytes)};},releaseLock(){}};}}};
}
function fixture({imageDownload,textStore}={}){
  const dir=mkdtempSync(join(tmpdir(),'riven-multimodal-'));
  const actualTextStore=textStore||new AdapterStore(join(dir,'text.sqlite'));
  const receiptStore=new ImageReceiptStore({filename:join(dir,'receipts.sqlite'),secretKey:RECEIPT_KEY,
    accountId:ACCOUNT,allowedPeer:peer,ttlMs:60_000,now:()=>10_000});
  const journalFile=join(dir,'batches.sqlite');
  const journal=new MultimodalBatchJournal({filename:journalFile,accountId:ACCOUNT,allowedPeer:peer,now:()=>10_000});
  let downloads=0;
  const downloader=imageDownload|| (async raw=>{downloads++;return {bytes:raw.message_id==='image-2'?PNG2:PNG,
    mimeType:'image/png',fileName:'wechat-image.png'};});
  const coordinator=createMultimodalInboundCoordinator({enabled:true,accountId:ACCOUNT,allowedPeer:peer,
    textStore:actualTextStore,receiptStore,batchJournal:journal,encryptionKey:CONTEXT_KEY,imageDownloader:downloader});
  return {dir,journalFile,textStore:actualTextStore,receiptStore,journal,coordinator,
    downloads:()=>downloads,cleanup(){try{journal.close();}catch{}try{receiptStore.close();}catch{}
      try{actualTextStore.close();}catch{}rmSync(dir,{recursive:true,force:true});}};
}
const batch=(messages,nextCursor='cursor-next')=>({messages,nextCursor});

test('default-disabled coordinator and transport perform no startup filesystem, auth or network mutation',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'riven-multimodal-disabled-')),candidate=join(dir,'must-not-exist.sqlite');
  let loads=0,fetches=0,commits=0;
  try{
    const coordinator=createMultimodalInboundCoordinator({enabled:false,filename:candidate,
      get textStore(){throw Error('must not inspect');}});
    assert.deepEqual(await coordinator.pollAndStageOnce(),{enabled:false,readyForCursorAcknowledgement:false,
      reason:'MULTIMODAL_INBOUND_DISABLED'});
    const transport=new ExplicitMultimodalWeixinTransport({enabled:false,
      authStore:{async load(){loads++;},async updateCursor(){commits++;}},fetchImpl:async()=>{fetches++;}});
    await assert.rejects(()=>transport.pollBatch(),/MULTIMODAL_INBOUND_DISABLED/);
    assert.equal(existsSync(candidate),false);assert.equal(loads,0);assert.equal(fetches,0);assert.equal(commits,0);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('offline E2E fake getupdates plus fake encrypted CDN stages mixed text/image before one cursor record',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'riven-multimodal-e2e-'));
  const textStore=new AdapterStore(join(dir,'text.sqlite'));
  const receiptStore=new ImageReceiptStore({filename:join(dir,'receipts.sqlite'),secretKey:RECEIPT_KEY,
    accountId:ACCOUNT,allowedPeer:peer,ttlMs:60_000,now:()=>10_000});
  const journal=new MultimodalBatchJournal({filename:join(dir,'batches.sqlite'),accountId:ACCOUNT,allowedPeer:peer,now:()=>10_000});
  let cursor='',cursorWrites=0,getupdates=0,cdn=0;
  const authStore={async load(){return {baseUrl:'https://ilinkai.weixin.qq.com',botToken:'fake-token',accountId:ACCOUNT,cursor};},
    async updateCursor(value){cursorWrites++;cursor=value;}};
  const pollTransport=new ExplicitMultimodalWeixinTransport({enabled:true,accountId:ACCOUNT,allowedPeer:peer,authStore,fetchImpl:async url=>{
    getupdates++;assert.equal(new URL(url).pathname,'/ilink/bot/getupdates');
    return {ok:true,async text(){return JSON.stringify({ret:0,msgs:[textMessage(),imageMessage()],get_updates_buf:'cursor-e2e'});}};
  }});
  const imageDownloader=createExplicitWeixinImageDownloader({enabled:true,accountId:ACCOUNT,allowedPeer:peer,
    fetchImpl:async url=>{cdn++;assert.equal(new URL(url).hostname,'novac2c.cdn.weixin.qq.com');return byteResponse(encrypt(PNG));}});
  const coordinator=createMultimodalInboundCoordinator({enabled:true,accountId:ACCOUNT,allowedPeer:peer,textStore,
    receiptStore,batchJournal:journal,encryptionKey:CONTEXT_KEY,imageDownloader,pollTransport});
  try{
    const result=await coordinator.pollAndStageOnce();
    assert.equal(result.readyForCursorAcknowledgement,true);assert.equal(getupdates,1);assert.equal(cdn,1);
    assert.equal(textStore.list().length,1);assert.equal(textStore.list()[0].status,'RECEIVED');
    assert.equal(receiptStore.listReceipts().length,1);assert.equal(receiptStore.listReceipts()[0].status,'RECEIVED');
    assert.equal(cursorWrites,0);assert.equal(cursor,'');
    assert.deepEqual(await result.acknowledgement.record(pollTransport),{recorded:true,batchKey:result.batch.batchKey});
    assert.equal(cursorWrites,1);assert.equal(cursor,'cursor-e2e');
  }finally{journal.close();receiptStore.close();textStore.close();rmSync(dir,{recursive:true,force:true});}
});

test('explicit raw transport validates account/token and never silently filters foreign media before coordination',async()=>{
  let fetches=0;
  const invalid=new ExplicitMultimodalWeixinTransport({enabled:true,accountId:ACCOUNT,allowedPeer:peer,
    authStore:{async load(){return {baseUrl:'https://ilinkai.weixin.qq.com',botToken:'',accountId:ACCOUNT,cursor:''};},
      async updateCursor(){}},fetchImpl:async()=>{fetches++;}});
  await assert.rejects(()=>invalid.pollBatch(),/MULTIMODAL_AUTH_INVALID/);
  assert.equal(fetches,0);

  const foreign=imageMessage('foreign-raw',{from_user_id:'intruder'});
  const valid=new ExplicitMultimodalWeixinTransport({enabled:true,accountId:ACCOUNT,allowedPeer:peer,
    authStore:{async load(){return {baseUrl:'https://ilinkai.weixin.qq.com',botToken:'fake-token',accountId:ACCOUNT,cursor:''};},
      async updateCursor(){}},fetchImpl:async()=>({ok:true,async text(){return JSON.stringify({ret:0,
        msgs:[foreign,textMessage()],get_updates_buf:'cursor-raw'});}})});
  const raw=await valid.pollBatch();
  assert.equal(raw.messages.length,2);
  assert.equal(raw.messages[0].from_user_id,'intruder');
});

test('image-only batch persists only an encrypted receipt and opens a staged gate',async()=>{
  const f=fixture();
  try{
    const result=await f.coordinator.stageBatch(batch([imageMessage()]));
    assert.equal(result.readyForCursorAcknowledgement,true);assert.equal(result.imageReceipts.length,1);
    assert.equal(f.textStore.list().length,0);assert.equal(f.receiptStore.listReceipts().length,1);
  }finally{f.cleanup();}
});

test('text-only batch uses AdapterStore encrypted context and never invokes media download',async()=>{
  const f=fixture();
  try{
    const result=await f.coordinator.stageBatch(batch([textMessage()]));
    assert.equal(result.readyForCursorAcknowledgement,true);assert.equal(result.textEvents.length,1);
    assert.equal(f.downloads(),0);assert.equal(f.receiptStore.listReceipts().length,0);
    assert.notEqual(f.textStore.getPrivate(result.textEvents[0].id).context_cipher,'context-text-1');
  }finally{f.cleanup();}
});

test('exact duplicates and repeated whole batch are idempotent without another download',async()=>{
  const f=fixture();const img=imageMessage();
  try{
    const first=await f.coordinator.stageBatch(batch([textMessage(),textMessage(),img,img]));
    assert.equal(first.readyForCursorAcknowledgement,true);assert.equal(first.batch.duplicateCount,2);
    assert.equal(f.downloads(),1);
    const repeated=await f.coordinator.stageBatch(batch([textMessage(),textMessage(),img,img]));
    assert.equal(repeated.readyForCursorAcknowledgement,true);assert.equal(f.downloads(),1);
    assert.equal(f.textStore.list().length,1);assert.equal(f.receiptStore.listReceipts().length,1);
  }finally{f.cleanup();}
});

test('transient second image failure leaves durable prefix and same-batch replay resumes safely',async()=>{
  let fail=true,calls=[];
  const f=fixture({imageDownload:async raw=>{calls.push(raw.message_id);if(raw.message_id==='image-2'&&fail)
    throw Error('WEIXIN_IMAGE_CDN_HTTP_FAILED');return {bytes:raw.message_id==='image-2'?PNG2:PNG,mimeType:'image/png',fileName:'wechat-image.png'};}});
  try{
    const messages=[imageMessage('image-1'),imageMessage('image-2')];
    const first=await f.coordinator.stageBatch(batch(messages));
    assert.equal(first.readyForCursorAcknowledgement,false);assert.equal(first.failure.code,'WEIXIN_IMAGE_CDN_HTTP_FAILED');
    assert.equal(f.receiptStore.listReceipts().length,1);
    fail=false;
    const replay=await f.coordinator.stageBatch(batch(messages));
    assert.equal(replay.readyForCursorAcknowledgement,true);
    assert.deepEqual(calls,['image-1','image-2','image-2']);
    assert.equal(f.receiptStore.listReceipts().length,2);
  }finally{f.cleanup();}
});

test('STAGING journal survives restart and resumes only the missing suffix',async()=>{
  let fail=true,calls=[];const messages=[imageMessage('image-1'),imageMessage('image-2')];
  const f=fixture({imageDownload:async raw=>{calls.push(raw.message_id);if(raw.message_id==='image-2'&&fail)
    throw Error('WEIXIN_IMAGE_CDN_HTTP_FAILED');return {bytes:raw.message_id==='image-2'?PNG2:PNG,
      mimeType:'image/png',fileName:'wechat-image.png'};}});let reopened;
  try{
    assert.equal((await f.coordinator.stageBatch(batch(messages,'cursor-restart'))).failure.code,'WEIXIN_IMAGE_CDN_HTTP_FAILED');
    f.journal.close();fail=false;
    reopened=new MultimodalBatchJournal({filename:f.journalFile,accountId:ACCOUNT,allowedPeer:peer,now:()=>11_000});
    const coordinator=createMultimodalInboundCoordinator({enabled:true,accountId:ACCOUNT,allowedPeer:peer,
      textStore:f.textStore,receiptStore:f.receiptStore,batchJournal:reopened,encryptionKey:CONTEXT_KEY,
      imageDownloader:async raw=>{calls.push(raw.message_id);return {bytes:raw.message_id==='image-2'?PNG2:PNG,
        mimeType:'image/png',fileName:'wechat-image.png'};}});
    const replay=await coordinator.stageBatch(batch(messages,'cursor-restart'));
    assert.equal(replay.readyForCursorAcknowledgement,true);
    assert.deepEqual(calls,['image-1','image-2','image-2']);
  }finally{try{reopened?.close();}catch{}f.cleanup();}
});

test('text-store failure after an image write is replayable without duplicating the image',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'riven-multimodal-text-fail-'));
  const real=new AdapterStore(join(dir,'text.sqlite'));let fail=true,downloads=0;
  const wrapper={getByInboundKey:(...args)=>real.getByInboundKey(...args),ingest(...args){if(fail){fail=false;throw Error('TEXT_STORE_TRANSIENT');}return real.ingest(...args);}};
  const receiptStore=new ImageReceiptStore({filename:join(dir,'receipts.sqlite'),secretKey:RECEIPT_KEY,
    accountId:ACCOUNT,allowedPeer:peer,ttlMs:60_000,now:()=>10_000});
  const journal=new MultimodalBatchJournal({filename:join(dir,'batches.sqlite'),accountId:ACCOUNT,allowedPeer:peer,now:()=>10_000});
  const coordinator=createMultimodalInboundCoordinator({enabled:true,accountId:ACCOUNT,allowedPeer:peer,textStore:wrapper,
    receiptStore,batchJournal:journal,encryptionKey:CONTEXT_KEY,imageDownloader:async()=>{downloads++;return {bytes:PNG,mimeType:'image/png',fileName:'wechat-image.png'};}});
  try{
    const messages=[imageMessage(),textMessage()];
    const first=await coordinator.stageBatch(batch(messages));
    assert.equal(first.failure.code,'TEXT_STORE_TRANSIENT');assert.equal(receiptStore.listReceipts().length,1);
    const replay=await coordinator.stageBatch(batch(messages));
    assert.equal(replay.readyForCursorAcknowledgement,true);assert.equal(downloads,1);
    assert.equal(real.list().length,1);assert.equal(receiptStore.listReceipts().length,1);
  }finally{journal.close();receiptStore.close();real.close();rmSync(dir,{recursive:true,force:true});}
});

test('same cursor with changed content is a durable batch conflict and causes no second write',async()=>{
  const f=fixture();
  try{
    assert.equal((await f.coordinator.stageBatch(batch([textMessage()]))).readyForCursorAcknowledgement,true);
    const changed=await f.coordinator.stageBatch(batch([textMessage('text-1','changed secret text')]));
    assert.equal(changed.failure.code,'MULTIMODAL_BATCH_CONFLICT');assert.equal(f.textStore.list().length,1);
  }finally{f.cleanup();}
});

test('foreign sender media is ignored before signed-media inspection, download or persistence',async()=>{
  let downloads=0;const f=fixture({imageDownload:async()=>{downloads++;throw Error('must not run');}});
  try{
    const foreign=imageMessage('foreign',{from_user_id:'intruder',group_id:'evil-group'});
    foreign.item_list[0].image_item.aeskey='private-invalid-key';
    const result=await f.coordinator.stageBatch(batch([foreign]));
    assert.equal(result.readyForCursorAcknowledgement,true);assert.equal(result.batch.ignoredCount,1);
    assert.equal(downloads,0);assert.equal(f.textStore.list().length,0);assert.equal(f.receiptStore.listReceipts().length,0);
  }finally{f.cleanup();}
});

test('allowed-peer group, generating and unknown content reject the complete batch before any write or download',async()=>{
  for(const invalid of [{...imageMessage(),group_id:'group-1'},imageMessage('gen',{message_state:1}),
    {...imageMessage('unknown'),item_list:[{type:3,msg_id:'unknown',file_item:{}}]}]){
    let downloads=0;const f=fixture({imageDownload:async()=>{downloads++;return {bytes:PNG,mimeType:'image/png',fileName:'x.png'};}});
    try{
      const result=await f.coordinator.stageBatch(batch([textMessage(),invalid]));
      assert.equal(result.readyForCursorAcknowledgement,false);assert.equal(downloads,0);
      assert.equal(f.textStore.list().length,0);assert.equal(f.receiptStore.listReceipts().length,0);
    }finally{f.cleanup();}
  }
});

test('invalid signed media key or forbidden CDN URL fails during scan before fetch or journal staging',async()=>{
  for(const bad of [imageMessage('bad-key'),imageMessage('bad-url')]){
    if(bad.message_id==='bad-key')bad.item_list[0].image_item.aeskey='not-a-key';
    else bad.item_list[0].image_item.media.full_url='https://evil.example/c2c/download?encrypted_query_param=secret';
    let fetches=0;
    const downloader=createExplicitWeixinImageDownloader({enabled:true,accountId:ACCOUNT,allowedPeer:peer,
      fetchImpl:async()=>{fetches++;return byteResponse(encrypt(PNG));}});
    const f=fixture({imageDownload:downloader});
    try{
      const result=await f.coordinator.stageBatch(batch([bad]));
      assert.match(result.failure.code,/^WEIXIN_IMAGE_/);assert.equal(fetches,0);
      assert.equal(f.receiptStore.listReceipts().length,0);
    }finally{f.cleanup();}
  }
});

test('cursor callback uncertainty is durable across restart and same batch requires manual review',async()=>{
  const f=fixture();let reopened;
  try{
    const messages=[textMessage()],result=await f.coordinator.stageBatch(batch(messages,'cursor-uncertain'));
    await assert.rejects(result.acknowledgement.record({async recordStagedCursor(){f.journal.close();throw Error('lost ack');}}),
      /MULTIMODAL_CURSOR_OUTCOME_UNCERTAIN/);
    reopened=new MultimodalBatchJournal({filename:f.journalFile,accountId:ACCOUNT,allowedPeer:peer,now:()=>11_000});
    assert.equal(reopened.get(result.batch.batchKey).status,'CURSOR_UNCERTAIN');
    const coordinator=createMultimodalInboundCoordinator({enabled:true,accountId:ACCOUNT,allowedPeer:peer,
      textStore:f.textStore,receiptStore:f.receiptStore,batchJournal:reopened,encryptionKey:CONTEXT_KEY,
      imageDownloader:async()=>{throw Error('must not download');}});
    const replay=await coordinator.stageBatch(batch(messages,'cursor-uncertain'));
    assert.equal(replay.failure.code,'MULTIMODAL_CURSOR_REQUIRES_REVIEW');
  }finally{try{reopened?.close();}catch{}f.cleanup();}
});

test('two cursor gates for one READY batch serialize to exactly one recorder',async()=>{
  const f=fixture();let calls=0;
  try{
    const messages=[textMessage()],first=await f.coordinator.stageBatch(batch(messages,'cursor-race'));
    const second=await f.coordinator.stageBatch(batch(messages,'cursor-race'));
    const store={async recordStagedCursor(){calls++;await Promise.resolve();return {recorded:true};}};
    const outcomes=await Promise.allSettled([first.acknowledgement.record(store),second.acknowledgement.record(store)]);
    assert.equal(outcomes.filter(item=>item.status==='fulfilled').length,1);
    assert.equal(outcomes.filter(item=>item.status==='rejected').length,1);
    assert.equal(calls,1);assert.equal(f.journal.get(first.batch.batchKey).status,'CURSOR_RECORDED');
  }finally{f.cleanup();}
});

test('CLAIMED image receipt is never treated as delivered or cursor-ackable on replay',async()=>{
  const f=fixture();
  try{
    const messages=[imageMessage()],first=await f.coordinator.stageBatch(batch(messages));
    f.receiptStore.claimOnce(first.imageReceipts[0].handle);
    const replay=await f.coordinator.stageBatch(batch(messages));
    assert.equal(replay.failure.code,'IMAGE_RECEIPT_CLAIMED_REQUIRES_REVIEW');
    assert.equal(replay.acknowledgement,null);
  }finally{f.cleanup();}
});

test('staging never invokes a bridge, sends a reply or creates an image text placeholder',async()=>{
  const f=fixture();let bridgeCalls=0,replyCalls=0;
  const bridge={enqueue(){bridgeCalls++;}},transport={sendText(){replyCalls++;}};
  try{
    const result=await f.coordinator.stageBatch(batch([textMessage(),imageMessage()]));
    assert.equal(result.readyForCursorAcknowledgement,true);assert.equal(bridgeCalls,0);assert.equal(replyCalls,0);
    assert.equal(f.textStore.list().length,1);
    assert.equal(f.textStore.list().some(row=>/image|attachment|photo/i.test(row.text)),false);
    assert.equal('bridge' in f.coordinator,false);assert.equal('transport' in f.coordinator,false);
    void bridge;void transport;
  }finally{f.cleanup();}
});

test('batch journal stores hashes and proofs without cursor, context, text or image bytes',async()=>{
  const f=fixture();
  const secretText='private journal text 2c4f',secretCursor='private-cursor-5d8a';
  try{
    const message=textMessage('private-text',secretText);
    message.context_token='private-context-token-9e7b';
    const result=await f.coordinator.stageBatch(batch([message,imageMessage()],secretCursor));
    assert.equal(result.readyForCursorAcknowledgement,true);
    f.journal.close();
    const needles=[secretText,secretCursor,message.context_token,PNG.toString('hex')];
    for(const name of readdirSync(f.dir).filter(name=>name.startsWith('batches.sqlite'))){
      const raw=readFileSync(join(f.dir,name)),utf8=raw.toString('utf8'),hex=raw.toString('hex');
      for(const needle of needles)assert.equal(utf8.includes(needle)||hex.includes(needle),false,name+' leaked '+needle);
    }
  }finally{f.cleanup();}
});
