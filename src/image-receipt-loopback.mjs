import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {MAX_WEIXIN_IMAGE_BYTES} from './media-inbound-image.mjs';

const ROUTE='/v1/image/claim';
const MAX_BODY_BYTES=1024;
const MAX_HEADER_BYTES=4096;
const ALLOWED_MIME=new Set(['image/jpeg','image/png','image/gif','image/webp']);
const SAFE_FILE=/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

function fail(code){throw new Error(code);}
function json(res,status,error){
  const value=Buffer.from(JSON.stringify({error}),'utf8');
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':String(value.length),
    'cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(value);
}
function fixedAuthEqual(header,expected){
  const provided=Buffer.from(typeof header==='string'?header:'','utf8');
  const padded=Buffer.alloc(expected.length);
  provided.copy(padded,0,0,Math.min(provided.length,padded.length));
  return timingSafeEqual(expected,padded)&&provided.length===expected.length;
}
function validHostHeader(req){
  const expected='127.0.0.1:'+req.socket.localPort;
  return req.headers.host===expected;
}
async function strictBody(req){
  const contentType=String(req.headers['content-type']||'').toLowerCase();
  if(contentType!=='application/json')fail('CONTENT_TYPE_REQUIRED');
  const encoding=String(req.headers['content-encoding']||'identity').toLowerCase();
  if(encoding!=='identity')fail('CONTENT_ENCODING_FORBIDDEN');
  const declared=req.headers['content-length'];
  if(declared!==undefined&&(!/^\d+$/.test(declared)||Number(declared)>MAX_BODY_BYTES))
    fail('REQUEST_BODY_TOO_LARGE');
  let size=0,tooLarge=false;
  const chunks=[];
  for await(const chunk of req){
    size+=chunk.length;
    if(size>MAX_BODY_BYTES){tooLarge=true;continue;}
    chunks.push(chunk);
  }
  if(tooLarge)fail('REQUEST_BODY_TOO_LARGE');
  const raw=Buffer.concat(chunks,size).toString('utf8');
  let value;
  try{value=JSON.parse(raw);}catch{fail('REQUEST_JSON_INVALID');}
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||
    typeof value.handle!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.handle)||
    (raw.match(/"handle"\s*:/g)||[]).length!==1)fail('REQUEST_JSON_INVALID');
  return value;
}
function claimError(error){
  const code=error?.message||'';
  if(code==='IMAGE_HANDLE_EXPIRED')return [410,'HANDLE_EXPIRED'];
  if(['IMAGE_HANDLE_INVALID','IMAGE_HANDLE_NOT_FOUND','IMAGE_HANDLE_NOT_AVAILABLE',
    'IMAGE_HANDLE_CLAIM_CONFLICT'].includes(code))return [409,'HANDLE_UNAVAILABLE'];
  return [409,'CLAIM_FAILED'];
}
function validClaim(result){
  const bytes=result?.bytes;
  const receipt=result?.receipt;
  return bytes instanceof Uint8Array&&bytes.byteLength>0&&bytes.byteLength<=MAX_WEIXIN_IMAGE_BYTES&&
    receipt?.status==='CLAIMED'&&receipt.size===bytes.byteLength&&ALLOWED_MIME.has(receipt.mimeType)&&
    SAFE_FILE.test(receipt.fileName||'');
}
function defaultSendBinary(res,result){
  const bytes=Buffer.from(result.bytes);
  res.writeHead(200,{'content-type':result.receipt.mimeType,'content-length':String(bytes.length),
    'content-disposition':'attachment; filename="'+result.receipt.fileName+'"',
    'cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(bytes);
}

export function createImageReceiptLoopbackServer({receiptStore,authToken,host='127.0.0.1',port,
  rateLimit,now=()=>Date.now(),logger=()=>{},sendBinary=defaultSendBinary}={}){
  if(!receiptStore||typeof receiptStore.claimOnce!=='function')fail('IMAGE_RECEIPT_STORE_REQUIRED');
  if(!(authToken instanceof Uint8Array)||authToken.byteLength!==32)fail('LOOPBACK_AUTH_TOKEN_REQUIRED_32_BYTES');
  if(host!=='127.0.0.1')fail('LOOPBACK_HOST_FORBIDDEN');
  if(!Number.isInteger(port)||port<0||port>65535)fail('LOOPBACK_PORT_REQUIRED');
  if(!rateLimit||!Number.isInteger(rateLimit.maxRequests)||rateLimit.maxRequests<1||rateLimit.maxRequests>100||
    !Number.isInteger(rateLimit.windowMs)||rateLimit.windowMs<100||rateLimit.windowMs>60_000)
    fail('LOOPBACK_RATE_LIMIT_REQUIRED');
  if(typeof now!=='function'||typeof logger!=='function'||typeof sendBinary!=='function')
    fail('LOOPBACK_CONFIGURATION_INVALID');
  const expectedAuth=Buffer.from('Bearer '+Buffer.from(authToken).toString('base64url'),'utf8');
  const attempts=[];
  let windowStart=0,requestCount=0,started=false,closed=false;
  const safeLog=value=>{try{logger(value);}catch{}};
  function consumeRate(){
    const ms=now();
    if(!Number.isSafeInteger(ms)||ms<0)fail('LOOPBACK_CLOCK_INVALID');
    if(ms-windowStart>=rateLimit.windowMs||ms<windowStart){windowStart=ms;requestCount=0;}
    requestCount++;
    return requestCount<=rateLimit.maxRequests;
  }
  function addAttempt(receipt){
    const item={attemptId:attempts.length+1,receiptId:typeof receipt?.id==='string'?receipt.id:null,
      state:'CLAIMED_RESPONSE_UNCERTAIN'};
    attempts.push(item);
    safeLog({event:'image_receipt_http_claim',attemptId:item.attemptId,receiptId:item.receiptId,
      state:item.state});
    return item;
  }
  const server=http.createServer({maxHeaderSize:MAX_HEADER_BYTES,requestTimeout:5000,headersTimeout:5000},async(req,res)=>{
    res.setHeader('cache-control','no-store');
    res.setHeader('x-content-type-options','nosniff');
    try{
      const remote=req.socket.remoteAddress;
      if(remote!=='127.0.0.1'&&remote!=='::ffff:127.0.0.1')return json(res,404,'NOT_FOUND');
      if(!validHostHeader(req))return json(res,404,'NOT_FOUND');
      let url;
      try{url=new URL(req.url,'http://127.0.0.1');}catch{return json(res,404,'NOT_FOUND');}
      if(url.pathname!==ROUTE||url.search||url.hash)return json(res,404,'NOT_FOUND');
      if(req.headers.origin!==undefined)return json(res,403,'ORIGIN_FORBIDDEN');
      if(req.method!=='POST')return json(res,405,'METHOD_NOT_ALLOWED');
      if(!consumeRate())return json(res,429,'RATE_LIMITED');
      if(!fixedAuthEqual(req.headers.authorization,expectedAuth))return json(res,404,'NOT_FOUND');
      let data;
      try{data=await strictBody(req);}
      catch(error){
        const code=error?.message;
        if(code==='REQUEST_BODY_TOO_LARGE')return json(res,413,'REQUEST_BODY_TOO_LARGE');
        if(code==='CONTENT_TYPE_REQUIRED'||code==='CONTENT_ENCODING_FORBIDDEN')return json(res,415,code);
        return json(res,400,'REQUEST_JSON_INVALID');
      }
      let claimed;
      try{claimed=await receiptStore.claimOnce(data.handle);}
      catch(error){const [status,code]=claimError(error);return json(res,status,code);}
      const attempt=addAttempt(claimed?.receipt);
      if(!validClaim(claimed))return json(res,409,'CLAIM_RESULT_INVALID');
      res.once('finish',()=>{
        attempt.state='HTTP_RESPONSE_FINISHED_NOT_UPLOAD_PROOF';
        safeLog({event:'image_receipt_http_finish',attemptId:attempt.attemptId,
          receiptId:attempt.receiptId,state:attempt.state});
      });
      res.once('close',()=>{
        if(!res.writableFinished)safeLog({event:'image_receipt_http_close',attemptId:attempt.attemptId,
          receiptId:attempt.receiptId,state:'CLAIMED_RESPONSE_UNCERTAIN'});
      });
      try{await sendBinary(res,claimed);}
      catch{
        attempt.state='CLAIMED_RESPONSE_UNCERTAIN';
        safeLog({event:'image_receipt_http_write_failed',attemptId:attempt.attemptId,
          receiptId:attempt.receiptId,state:attempt.state});
        if(!res.headersSent&&!res.destroyed)return json(res,409,'RESPONSE_DELIVERY_UNCERTAIN');
        if(!res.destroyed)res.destroy();
      }
    }catch{
      if(!res.headersSent&&!res.destroyed)return json(res,500,'REQUEST_FAILED');
      if(!res.destroyed)res.destroy();
    }
  });
  return {
    start(){
      if(started)return Promise.reject(new Error('LOOPBACK_ALREADY_STARTED'));
      if(closed)return Promise.reject(new Error('LOOPBACK_CLOSED'));
      started=true;
      return new Promise((resolve,reject)=>{
        const failed=error=>{started=false;reject(error);};
        server.once('error',failed);
        server.listen(port,host,()=>{
          server.off('error',failed);
          const address=server.address();
          resolve({host,port:address.port});
        });
      });
    },
    stop(){
      if(closed)return Promise.resolve();
      if(!started){closed=true;expectedAuth.fill(0);return Promise.resolve();}
      return new Promise(resolve=>server.close(()=>{started=false;closed=true;expectedAuth.fill(0);resolve();}));
    },
    attempts:()=>attempts.map(item=>({...item}))
  };
}

export const imageReceiptLoopbackLimits=Object.freeze({route:ROUTE,maxBodyBytes:MAX_BODY_BYTES,
  maxHeaderBytes:MAX_HEADER_BYTES,maxResponseBytes:MAX_WEIXIN_IMAGE_BYTES});
