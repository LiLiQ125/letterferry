import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WebMediaTaskStore} from '../src/web-media-task-store.mjs';
import {createWebMediaBridge} from '../src/web-media-bridge.mjs';
import {createMediaTaskClient} from '../web-extension/media-task-client.mjs';
import {ImageReceiptStore} from '../src/image-receipt-store.mjs';

const ACCOUNT='owner-account', PEER='paired-peer', URL='https://chatgpt.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORIGIN='chrome-extension://'+'a'.repeat(32);
const PNG=Buffer.from([137,80,78,71,13,10,26,10,65,66,67]);
const SECRET=Buffer.from('91'.repeat(32),'hex'), DIGEST='b'.repeat(64);
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'riven-media-boundary-'));
  const file=join(dir,'media.sqlite');
  const config={filename:file,secretKey:SECRET,accountId:ACCOUNT,allowedPeer:{userId:PEER,chatId:PEER},
    boundTabId:42,boundUrl:URL,browserSessionId:'browser-session-12345',now:()=>1000};
  const store=new WebMediaTaskStore(config);
  const value=id=>({eventId:'event-'+id+'-12345678',accountId:ACCOUNT,fromUserId:PEER,chatId:PEER,
    messageId:'message-'+id,receiptId:'receipt-'+id+'-12345678',digest:DIGEST,mimeType:'image/png',
    size:PNG.length,fileName:'wechat-image.png',handle:'A'.repeat(43)});
  const binding=created=>({taskId:created.task.taskId,taskNonce:created.taskNonce,accountId:ACCOUNT,
    fromUserId:PEER,chatId:PEER,eventId:created.task.eventId,receiptId:created.task.receiptId,
    digest:created.task.digest,tabId:42,boundUrl:URL,browserSessionId:'browser-session-12345'});
  return {dir,file,config,store,value,binding,cleanup(){try{this.store.close();}catch{}rmSync(dir,{recursive:true,force:true});}};
}
function claimed(task){return {id:task.receiptId,messageId:task.messageId,digest:task.digest,
  mimeType:task.mimeType,size:task.size,fileName:task.fileName,status:'CLAIMED'};}
function preview(){return {inputLabel:'添加照片',previewChecks:2,readyForSubmit:true,sendClicked:false,
  mimeType:'image/png',size:PNG.length,fileName:'wechat-image.png'};}
function err(fn,code){assert.throws(fn,e=>e.message===code);}

test('one image remains exclusive through HTTP finish and preview, and is never proof of delivery',()=>{
  const f=fixture();try{
    const a=f.store.create(f.value('one')),b=f.store.create(f.value('two'));
    assert.equal(a.created,true);assert.equal(f.store.create(f.value('one')).taskNonce,null);
    const packet=f.binding(a),result=f.store.beginClaim(packet);
    assert.equal(result.handle,'A'.repeat(43));
    err(()=>f.store.beginClaim(f.binding(b)),'MEDIA_TASK_UNRESOLVED_REQUIRES_REVIEW');
    f.store.recordClaimed(packet.taskId,claimed(a.task));
    f.store.recordHttpFinished(packet.taskId);
    err(()=>f.store.beginClaim(f.binding(b)),'MEDIA_TASK_UNRESOLVED_REQUIRES_REVIEW');
    const visible=f.store.recordPreview({binding:packet,evidence:preview()});
    assert.equal(visible.status,'PREVIEW_VERIFIED_EXPERIMENTAL');
    assert.equal(visible.uploadProven,false);assert.equal(visible.cursorEligible,false);
    err(()=>f.store.beginClaim(f.binding(b)),'MEDIA_TASK_UNRESOLVED_REQUIRES_REVIEW');
    f.store.recordUnknown(packet.taskId,'MEDIA_PREVIEW_NOT_DELIVERED');
    err(()=>f.store.beginClaim(f.binding(b)),'MEDIA_TASK_UNRESOLVED_REQUIRES_REVIEW');
    f.store.reviewUnknownWithoutReplay(packet.taskId);
    assert.equal(f.store.beginClaim(f.binding(b)).task.status,'CLAIMING');
  }finally{f.cleanup();}
});

test('restart seals unproven image as unknown and blocks any new claim until reviewed',()=>{
  const f=fixture();try{
    const a=f.store.create(f.value('one')),b=f.store.create(f.value('two'));
    f.store.beginClaim(f.binding(a));f.store.recordClaimed(a.task.taskId,claimed(a.task));
    f.store.recordHttpFinished(a.task.taskId);f.store.close();
    f.store=new WebMediaTaskStore(f.config);
    assert.equal(f.store.get(a.task.taskId).status,'DELIVERY_UNKNOWN');
    err(()=>f.store.beginClaim(f.binding(b)),'MEDIA_TASK_UNRESOLVED_REQUIRES_REVIEW');
    f.store.reviewUnknownWithoutReplay(a.task.taskId);
    assert.equal(f.store.beginClaim(f.binding(b)).task.status,'CLAIMING');
  }finally{f.cleanup();}
});

test('wrong tab, nonce, account, browser session and duplicate claims fail before reading handle',()=>{
  const f=fixture();try{
    const a=f.store.create(f.value('one')),p=f.binding(a);
    for(const wrong of [{tabId:99},{taskNonce:'Z'.repeat(43)},{accountId:'other'},
      {browserSessionId:'other-session-12345'},{boundUrl:'https://chatgpt.com/c/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}]){
      err(()=>f.store.beginClaim({...p,...wrong}),wrong.tabId||wrong.browserSessionId||wrong.boundUrl?
        'MEDIA_TASK_BROWSER_BINDING_MISMATCH':wrong.taskNonce?'MEDIA_TASK_NONCE_INVALID':'MEDIA_TASK_IDENTITY_MISMATCH');
    }
    assert.equal(f.store.beginClaim(p).task.status,'CLAIMING');
    err(()=>f.store.beginClaim(p),'MEDIA_TASK_NOT_CLAIMABLE');
  }finally{f.cleanup();}
});

test('DB stores encrypted handle, never its raw bearer-like value',()=>{
  const f=fixture();try{
    f.store.create(f.value('one'));f.store.close();
    assert.equal(readFileSync(f.file).includes(Buffer.from('A'.repeat(43))),false);
  }finally{f.cleanup();}
});

test('extension client handles binary filename and no-store policy without DOM mutations or send',async()=>{
  const token=randomBytes(32).toString('base64url'),calls=[];
  const client=createMediaTaskClient({enabled:true,baseUrl:'http://127.0.0.1:5555',authToken:token,
    extensionOrigin:ORIGIN,fetchImpl:async(url,options)=>{
      calls.push({url,options});
      return new Response(PNG,{status:200,headers:{
        'content-type':'image/png','content-length':String(PNG.length),
        'content-disposition':'attachment; filename="wechat-image.png"',
        'access-control-allow-origin':ORIGIN,'cache-control':'no-store','x-content-type-options':'nosniff'}});
    }});
  const image=await client.claim({taskId:'anything'});
  assert.equal(image.fileName,'wechat-image.png');
  assert.deepEqual(Buffer.from(image.bytes),PNG);
  assert.equal(image.sendClicked,false);assert.equal(client.submitEnabled,false);
  assert.equal(calls[0].options.credentials,'omit');
  assert.equal(calls[0].options.headers.authorization,'Bearer '+token);
});

test('extension client rejects missing filename or insecure response policy',async()=>{
  for(const headers of [
    {'content-type':'image/png','content-length':String(PNG.length),'access-control-allow-origin':ORIGIN,
      'cache-control':'no-store','x-content-type-options':'nosniff'},
    {'content-type':'image/png','content-length':String(PNG.length),'content-disposition':'attachment; filename="p.png"',
      'access-control-allow-origin':'*','cache-control':'no-store','x-content-type-options':'nosniff'}
  ]){
    const client=createMediaTaskClient({enabled:true,baseUrl:'http://127.0.0.1:5555',
      authToken:randomBytes(32).toString('base64url'),extensionOrigin:ORIGIN,
      fetchImpl:async()=>new Response(PNG,{status:200,headers})});
    await assert.rejects(client.claim({taskId:'x'}));
  }
});

test('actual isolated HTTP bridge accepts exact extension Origin/token and never proves upload',async()=>{
  const f=fixture(),dir2=mkdtempSync(join(tmpdir(),'riven-media-receipt-'));
  const receipt=new ImageReceiptStore({filename:join(dir2,'receipts.sqlite'),
    secretKey:Buffer.from('27'.repeat(32),'hex'),accountId:ACCOUNT,
    allowedPeer:{userId:PEER,chatId:PEER},ttlMs:10000,now:()=>1000});
  let server;try{
    const stored=receipt.ingest({accountId:ACCOUNT,fromUserId:PEER,chatId:PEER,
      messageId:'message-one',bytes:PNG,mimeType:'image/png',fileName:'wechat-image.png'});
    const value=f.value('one');value.handle=stored.handle;value.receiptId=stored.receipt.id;
    value.digest=stored.receipt.digest;
    const task=f.store.create(value),packet=f.binding(task),token=randomBytes(32);
    server=createWebMediaBridge({enabled:true,taskStore:f.store,receiptStore:receipt,authToken:token,
      extensionOrigin:ORIGIN,host:'127.0.0.1',port:0,
      authorizeBrowser:({tabId,boundUrl,browserSessionId})=>
        tabId===42&&boundUrl===URL&&browserSessionId==='browser-session-12345',
      rateLimit:{maxRequests:20,windowMs:1000},now:()=>1000});
    const address=await server.start(),base='http://127.0.0.1:'+address.port;
    const request=(url,options)=>fetch(url,{...options,headers:{...options.headers,origin:ORIGIN}});
    const client=createMediaTaskClient({enabled:true,baseUrl:base,authToken:token.toString('base64url'),
      extensionOrigin:ORIGIN,fetchImpl:request});
    const result=await client.claim(packet);
    assert.equal(result.fileName,'wechat-image.png');
    assert.deepEqual(Buffer.from(result.bytes),PNG);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.store.get(task.task.taskId).status,'HTTP_RESPONSE_FINISHED_NOT_UPLOAD_PROOF');
    await client.recordPreview({binding:packet,evidence:{...preview(),size:PNG.length}});
    assert.equal(f.store.get(task.task.taskId).status,'PREVIEW_VERIFIED_EXPERIMENTAL');
    await assert.rejects(client.claim(packet));
    assert.equal(receipt.getReceipt({accountId:ACCOUNT,fromUserId:PEER,chatId:PEER,
      messageId:'message-one'}).status,'CLAIMED');
  }finally{if(server)await server.stop();receipt.close();rmSync(dir2,{recursive:true,force:true});f.cleanup();}
});

test('non-extension Origin and invalid credentials never consume encrypted image',async()=>{
  const f=fixture();let server;try{
    const task=f.store.create(f.value('one')),token=randomBytes(32);
    server=createWebMediaBridge({enabled:true,taskStore:f.store,
      receiptStore:{claimOnce(){throw Error('MUST_NOT_CALL');}},authToken:token,
      extensionOrigin:ORIGIN,host:'127.0.0.1',port:0,
      authorizeBrowser:()=>true,rateLimit:{maxRequests:20,windowMs:1000},now:()=>1000});
    const address=await server.start(),url='http://127.0.0.1:'+address.port+'/v1/media-task/claim';
    const badOrigin=await fetch(url,{method:'POST',headers:{origin:'https://evil.example',
      authorization:'Bearer '+token.toString('base64url'),'content-type':'application/json'},body:JSON.stringify(f.binding(task))});
    assert.equal(badOrigin.status,403);
    const badToken=await fetch(url,{method:'POST',headers:{origin:ORIGIN,
      authorization:'Bearer wrong','content-type':'application/json'},body:JSON.stringify(f.binding(task))});
    assert.equal(badToken.status,404);
    assert.equal(f.store.get(task.task.taskId).status,'QUEUED');
  }finally{if(server)await server.stop();f.cleanup();}
});
