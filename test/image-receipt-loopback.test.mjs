import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ImageReceiptStore} from '../src/image-receipt-store.mjs';
import {createImageReceiptLoopbackServer,imageReceiptLoopbackLimits} from '../src/image-receipt-loopback.mjs';
import {MAX_WEIXIN_IMAGE_BYTES} from '../src/media-inbound-image.mjs';

const ACCOUNT='owner-account',USER='authorized-peer';
const KEY=Buffer.from('6c'.repeat(32),'hex');
const PNG=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
  Buffer.from('PRIVATE_LOOPBACK_IMAGE_51c8d921')]);
const identity=(messageId='m1')=>({accountId:ACCOUNT,fromUserId:USER,chatId:USER,messageId});
function setup({now=()=>1000,ttlMs=10_000,token=randomBytes(32),logger=()=>{},sendBinary}={}){
  const dir=mkdtempSync(join(tmpdir(),'riven-image-loopback-'));
  const file=join(dir,'receipts.sqlite');
  const store=new ImageReceiptStore({filename:file,secretKey:KEY,accountId:ACCOUNT,
    allowedPeer:{userId:USER,chatId:USER},ttlMs,now});
  const server=createImageReceiptLoopbackServer({receiptStore:store,authToken:token,host:'127.0.0.1',port:0,
    rateLimit:{maxRequests:20,windowMs:1000},now,logger,...(sendBinary?{sendBinary}:{})});
  return {dir,file,store,server,token,async start(){const address=await server.start();
    return 'http://127.0.0.1:'+address.port;},async cleanup(){await server.stop();store.close();rmSync(dir,{recursive:true,force:true});}};
}
function auth(token){return 'Bearer '+Buffer.from(token).toString('base64url');}
function image(messageId='m1'){return {...identity(messageId),bytes:PNG,mimeType:'image/png',fileName:'wechat-image.png'};}
async function claim(base,token,handle,extra={}){
  return fetch(base+'/v1/image/claim',{method:'POST',headers:{authorization:auth(token),'content-type':'application/json',
    ...(extra.headers||{})},body:extra.body??JSON.stringify({handle})});
}

test('success returns exact bytes, MIME and safe filename with no-store/nosniff and no CORS',async()=>{
  const f=setup();
  try{
    const issued=f.store.ingest(image());const base=await f.start();
    const response=await claim(base,f.token,issued.handle);
    assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');
    assert.equal(response.headers.get('content-disposition'),'attachment; filename="wechat-image.png"');
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    assert.equal(response.headers.get('access-control-allow-origin'),null);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),PNG);
    assert.equal(f.server.attempts()[0].state,'HTTP_RESPONSE_FINISHED_NOT_UPLOAD_PROOF');
    assert.equal(f.store.getReceipt(identity()).status,'CLAIMED');
  }finally{await f.cleanup();}
});

test('missing and wrong credentials reveal only NOT_FOUND and never claim',async()=>{
  const f=setup();
  try{
    const issued=f.store.ingest(image());const base=await f.start();
    for(const authorization of [undefined,auth(randomBytes(32))]){
      const headers={'content-type':'application/json'};if(authorization)headers.authorization=authorization;
      const response=await fetch(base+'/v1/image/claim',{method:'POST',headers,body:JSON.stringify({handle:issued.handle})});
      assert.equal(response.status,404);assert.deepEqual(await response.json(),{error:'NOT_FOUND'});
    }
    assert.equal(f.store.getReceipt(identity()).status,'RECEIVED');assert.deepEqual(f.server.attempts(),[]);
  }finally{await f.cleanup();}
});

test('only exact POST route is accepted; query, GET, OPTIONS and browser Origin are rejected without CORS',async()=>{
  const f=setup();
  try{
    const issued=f.store.ingest(image());const base=await f.start();
    const cases=[
      [base+'/wrong','POST',{},404],[base+'/v1/image/claim?handle='+issued.handle,'POST',{},404],
      [base+'/v1/image/claim','GET',{},405],[base+'/v1/image/claim','OPTIONS',{'origin':'https://evil.example'},403],
      [base+'/v1/image/claim','POST',{'origin':'https://evil.example'},403]
    ];
    for(const [url,method,headers,status] of cases){
      const response=await fetch(url,{method,headers:{authorization:auth(f.token),'content-type':'application/json',...headers},
        ...(method==='POST'?{body:JSON.stringify({handle:issued.handle})}:{})});
      assert.equal(response.status,status);assert.equal(response.headers.get('access-control-allow-origin'),null);
    }
    assert.equal(f.store.getReceipt(identity()).status,'RECEIVED');
  }finally{await f.cleanup();}
});

test('strict JSON, content type, encoding and bounded body reject malformed requests before claim',async()=>{
  const f=setup();
  try{
    const issued=f.store.ingest(image());const base=await f.start();
    const cases=[
      [{body:'{',headers:{}},400],[{body:JSON.stringify({handle:issued.handle,extra:true}),headers:{}},400],
      [{body:'{"handle":"'+issued.handle+'","handle":"'+issued.handle+'"}',headers:{}},400],
      [{body:JSON.stringify({handle:issued.handle}),headers:{'content-type':'text/plain'}},415],
      [{body:JSON.stringify({handle:issued.handle}),headers:{'content-encoding':'gzip'}},415],
      [{body:'x'.repeat(imageReceiptLoopbackLimits.maxBodyBytes+1),headers:{}},413]
    ];
    for(const [options,status] of cases){
      const response=await fetch(base+'/v1/image/claim',{method:'POST',headers:{authorization:auth(f.token),
        'content-type':'application/json',...options.headers},body:options.body});
      assert.equal(response.status,status);
    }
    assert.equal(f.store.getReceipt(identity()).status,'RECEIVED');
  }finally{await f.cleanup();}
});

test('oversized HTTP headers are rejected by the parser and service remains usable',async()=>{
  const f=setup();
  try{
    const issued=f.store.ingest(image());const base=await f.start();const target=new URL(base);
    const status=await new Promise(resolve=>{
      const request=http.request({host:'127.0.0.1',port:Number(target.port),path:'/v1/image/claim',method:'POST',
        headers:{authorization:auth(f.token),'content-type':'application/json','x-padding':'x'.repeat(5000)}},
        response=>{response.resume();resolve(response.statusCode);});
      request.on('error',()=>resolve('closed'));request.end(JSON.stringify({handle:issued.handle}));
    });
    assert.ok(status===431||status==='closed');
    const success=await claim(base,f.token,issued.handle);assert.equal(success.status,200);
  }finally{await f.cleanup();}
});

test('rate limit is explicit and includes failed authentication attempts',async()=>{
  let now=1000;const token=randomBytes(32);let claims=0;
  const receiptStore={claimOnce(){claims++;throw Error('IMAGE_HANDLE_NOT_FOUND');}};
  const server=createImageReceiptLoopbackServer({receiptStore,authToken:token,host:'127.0.0.1',port:0,
    rateLimit:{maxRequests:2,windowMs:1000},now:()=>now});
  const address=await server.start();const base='http://127.0.0.1:'+address.port;
  try{
    for(const expected of [404,404,429]){
      const response=await fetch(base+'/v1/image/claim',{method:'POST',headers:{authorization:'Bearer wrong',
        'content-type':'application/json'},body:'{}'});assert.equal(response.status,expected);
    }
    assert.equal(claims,0);now=2000;
    const response=await fetch(base+'/v1/image/claim',{method:'POST',headers:{authorization:auth(token),
      'content-type':'application/json'},body:JSON.stringify({handle:'A'.repeat(43)})});
    assert.equal(response.status,409);assert.equal(claims,1);
  }finally{await server.stop();}
});

test('repeated handle and restart remain unavailable after the first durable claim',async()=>{
  const f=setup();
  try{
    const issued=f.store.ingest(image());let base=await f.start();
    assert.equal((await claim(base,f.token,issued.handle)).status,200);
    assert.equal((await claim(base,f.token,issued.handle)).status,409);
    await f.server.stop();f.store.close();
    const store=new ImageReceiptStore({filename:f.file,secretKey:KEY,accountId:ACCOUNT,
      allowedPeer:{userId:USER,chatId:USER},ttlMs:10_000,now:()=>1000});
    const token=randomBytes(32);
    const server2=createImageReceiptLoopbackServer({receiptStore:store,authToken:token,host:'127.0.0.1',port:0,
      rateLimit:{maxRequests:5,windowMs:1000},now:()=>1000});
    const address=await server2.start();base='http://127.0.0.1:'+address.port;
    try{assert.equal((await claim(base,token,issued.handle)).status,409);}
    finally{await server2.stop();store.close();}
    rmSync(f.dir,{recursive:true,force:true});
  }finally{
    // The primary resources were closed before the restart; cleanup is idempotent.
    await f.server.stop().catch(()=>{});
    try{f.store.close();}catch{}
    rmSync(f.dir,{recursive:true,force:true});
  }
});

test('expired handle returns fixed error without bytes or sensitive metadata',async()=>{
  let now=1000;const f=setup({now:()=>now,ttlMs:10});
  try{
    const issued=f.store.ingest(image());const base=await f.start();now=1010;
    const response=await claim(base,f.token,issued.handle);
    assert.equal(response.status,410);assert.deepEqual(await response.json(),{error:'HANDLE_EXPIRED'});
    assert.deepEqual(f.server.attempts(),[]);
  }finally{await f.cleanup();}
});

test('invalid claimed MIME or oversized result is consumed but never emitted',async()=>{
  for(const bad of [
    {bytes:PNG,receipt:{id:'r1',status:'CLAIMED',size:PNG.length,mimeType:'text/html',fileName:'x.png'}},
    {bytes:Buffer.alloc(MAX_WEIXIN_IMAGE_BYTES+1),receipt:{id:'r2',status:'CLAIMED',
      size:MAX_WEIXIN_IMAGE_BYTES+1,mimeType:'image/png',fileName:'x.png'}}
  ]){
    let calls=0;const token=randomBytes(32);
    const server=createImageReceiptLoopbackServer({receiptStore:{claimOnce(){calls++;return bad;}},authToken:token,
      host:'127.0.0.1',port:0,rateLimit:{maxRequests:5,windowMs:1000},now:()=>1000});
    const address=await server.start();const base='http://127.0.0.1:'+address.port;
    try{
      const response=await claim(base,token,'A'.repeat(43));
      assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:'CLAIM_RESULT_INVALID'});
      assert.equal(calls,1);assert.equal(server.attempts()[0].state,'CLAIMED_RESPONSE_UNCERTAIN');
    }finally{await server.stop();}
  }
});

test('socket interruption after claim stays uncertain and never reclaims the handle',async()=>{
  const logs=[];const f=setup({logger:event=>logs.push(event),sendBinary(res){res.destroy();}});
  try{
    const issued=f.store.ingest(image());const base=await f.start();
    await assert.rejects(claim(base,f.token,issued.handle));
    assert.equal(f.store.getReceipt(identity()).status,'CLAIMED');
    const retry=await claim(base,f.token,issued.handle);assert.equal(retry.status,409);
    assert.equal(f.server.attempts().length,1);
    assert.equal(f.server.attempts()[0].state,'CLAIMED_RESPONSE_UNCERTAIN');
    assert.ok(logs.some(event=>event.state==='CLAIMED_RESPONSE_UNCERTAIN'));
  }finally{await f.cleanup();}
});

test('errors and logs never contain handle, token, auth key or plaintext image bytes',async()=>{
  const logs=[];const f=setup({logger:event=>logs.push(event)});
  try{
    const issued=f.store.ingest(image());const base=await f.start();
    const response=await claim(base,f.token,issued.handle);await response.arrayBuffer();
    const observable=JSON.stringify(logs);
    for(const secret of [issued.handle,auth(f.token),KEY.toString('hex'),PNG.toString('base64')])
      assert.equal(observable.includes(secret),false);
  }finally{await f.cleanup();}
});

test('factory never auto-listens, rejects non-loopback/missing port, and stop releases the ephemeral port',async()=>{
  const token=randomBytes(32),store={claimOnce(){}};
  assert.throws(()=>createImageReceiptLoopbackServer({receiptStore:store,authToken:token,host:'0.0.0.0',port:0,
    rateLimit:{maxRequests:1,windowMs:1000}}),/LOOPBACK_HOST_FORBIDDEN/);
  assert.throws(()=>createImageReceiptLoopbackServer({receiptStore:store,authToken:token,host:'127.0.0.1',
    rateLimit:{maxRequests:1,windowMs:1000}}),/LOOPBACK_PORT_REQUIRED/);
  const server=createImageReceiptLoopbackServer({receiptStore:store,authToken:token,host:'127.0.0.1',port:0,
    rateLimit:{maxRequests:1,windowMs:1000}});
  assert.deepEqual(server.attempts(),[]);
  const address=await server.start();await server.stop();
  await assert.rejects(fetch('http://127.0.0.1:'+address.port+'/v1/image/claim'));
});
