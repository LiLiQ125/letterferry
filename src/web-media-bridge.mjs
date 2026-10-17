import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {webMediaTaskLimits} from './web-media-task-store.mjs';

const CLAIM_ROUTE='/v1/media-task/claim';
const PREVIEW_ROUTE='/v1/media-task/preview';
const MAX_BODY=4096;
const MAX_HEADER=4096;
const MIME=new Set(['image/jpeg','image/png','image/gif','image/webp']);

function fail(code){throw new Error(code);}
function fixedEqual(value,expected){const supplied=Buffer.from(typeof value==='string'?value:'');const padded=Buffer.alloc(expected.length);
  supplied.copy(padded,0,0,Math.min(supplied.length,padded.length));return supplied.length===expected.length&&timingSafeEqual(padded,expected);}
function json(res,status,code,origin){
  const bytes=Buffer.from(JSON.stringify(code?{error:code}:{ok:true}));
  const headers={'content-type':'application/json; charset=utf-8','content-length':String(bytes.length),
    'cache-control':'no-store','x-content-type-options':'nosniff'};
  if(origin){headers['access-control-allow-origin']=origin;headers.vary='Origin';}
  res.writeHead(status,headers);res.end(bytes);
}
async function body(req){
  if(String(req.headers['content-type']||'').toLowerCase()!=='application/json')fail('CONTENT_TYPE_REQUIRED');
  if(String(req.headers['content-encoding']||'identity').toLowerCase()!=='identity')fail('CONTENT_ENCODING_FORBIDDEN');
  const declared=req.headers['content-length'];
  if(declared!==undefined&&(!/^\d+$/.test(declared)||Number(declared)>MAX_BODY))fail('REQUEST_BODY_TOO_LARGE');
  const chunks=[];let size=0,large=false;
  for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY){large=true;continue;}chunks.push(chunk);}
  if(large)fail('REQUEST_BODY_TOO_LARGE');
  try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw 0;return value;}
  catch{fail('REQUEST_JSON_INVALID');}
}
function validHost(req){return req.headers.host==='127.0.0.1:'+req.socket.localPort;}
function validClaim(result){return result?.bytes instanceof Uint8Array&&result.bytes.byteLength>0&&
  result.bytes.byteLength<=webMediaTaskLimits.maxBytes&&result.receipt?.status==='CLAIMED'&&
  result.receipt.size===result.bytes.byteLength&&MIME.has(result.receipt.mimeType)&&
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(result.receipt.fileName||'');}
function defaultSend(res,result,origin){const bytes=Buffer.from(result.bytes);res.writeHead(200,{
  'content-type':result.receipt.mimeType,'content-length':String(bytes.length),
  'content-disposition':'attachment; filename="'+result.receipt.fileName+'"','cache-control':'no-store',
  'x-content-type-options':'nosniff','access-control-allow-origin':origin,'vary':'Origin'});res.end(bytes);}

export function createWebMediaBridge({enabled=false,taskStore,receiptStore,authToken,extensionOrigin,
  authorizeBrowser,host='127.0.0.1',port,rateLimit,now=()=>Date.now(),logger=()=>{},sendBinary=defaultSend}={}){
  if(enabled!==true)return Object.freeze({enabled:false,start:async()=>{throw Error('WEB_MEDIA_BRIDGE_DISABLED');},stop:async()=>{}});
  if(!taskStore||typeof taskStore.beginClaim!=='function'||typeof taskStore.recordUnknown!=='function'||
    !receiptStore||typeof receiptStore.claimOnce!=='function')fail('WEB_MEDIA_BRIDGE_STORE_REQUIRED');
  if(!(authToken instanceof Uint8Array)||authToken.byteLength!==32)fail('WEB_MEDIA_AUTH_TOKEN_REQUIRED_32_BYTES');
  if(typeof extensionOrigin!=='string'||!/^chrome-extension:\/\/[a-p]{32}$/.test(extensionOrigin))fail('WEB_MEDIA_EXTENSION_ORIGIN_INVALID');
  if(typeof authorizeBrowser!=='function'||host!=='127.0.0.1'||!Number.isInteger(port)||port<0||port>65535)
    fail('WEB_MEDIA_BRIDGE_CONFIGURATION_INVALID');
  if(!rateLimit||!Number.isInteger(rateLimit.maxRequests)||rateLimit.maxRequests<1||rateLimit.maxRequests>100||
    !Number.isInteger(rateLimit.windowMs)||rateLimit.windowMs<100||rateLimit.windowMs>60_000)fail('WEB_MEDIA_RATE_LIMIT_REQUIRED');
  const expected=Buffer.from('Bearer '+Buffer.from(authToken).toString('base64url'));
  let windowStart=0,count=0,started=false,closed=false;
  const safeLog=value=>{try{logger(value);}catch{}};
  function rate(){const ms=now();if(!Number.isSafeInteger(ms)||ms<0)fail('WEB_MEDIA_CLOCK_INVALID');
    if(ms<windowStart||ms-windowStart>=rateLimit.windowMs){windowStart=ms;count=0;}return ++count<=rateLimit.maxRequests;}
  const server=http.createServer({maxHeaderSize:MAX_HEADER,requestTimeout:5000,headersTimeout:5000},async(req,res)=>{
    res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
    let taskId=null,claimed=false;
    try{
      if(!['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||!validHost(req))return json(res,404,'NOT_FOUND');
      let url;try{url=new URL(req.url,'http://127.0.0.1');}catch{return json(res,404,'NOT_FOUND');}
      if(![CLAIM_ROUTE,PREVIEW_ROUTE].includes(url.pathname)||url.search||url.hash)return json(res,404,'NOT_FOUND');
      if(req.headers.origin!==extensionOrigin)return json(res,403,'ORIGIN_FORBIDDEN');
      if(req.method==='OPTIONS'){
        if(String(req.headers['access-control-request-method']||'').toUpperCase()!=='POST'||
          String(req.headers['access-control-request-headers']||'').toLowerCase().split(',').map(x=>x.trim()).sort().join(',')!=='authorization,content-type')
          return json(res,403,'PREFLIGHT_FORBIDDEN');
        res.writeHead(204,{'access-control-allow-origin':extensionOrigin,'access-control-allow-methods':'POST',
          'access-control-allow-headers':'authorization, content-type','access-control-max-age':'0','cache-control':'no-store','vary':'Origin'});return res.end();
      }
      if(req.method!=='POST')return json(res,405,'METHOD_NOT_ALLOWED',extensionOrigin);
      if(!rate())return json(res,429,'RATE_LIMITED',extensionOrigin);
      if(!fixedEqual(req.headers.authorization,expected))return json(res,404,'NOT_FOUND',extensionOrigin);
      let data;try{data=await body(req);}catch(error){const code=error.message;
        return json(res,code==='REQUEST_BODY_TOO_LARGE'?413:code==='CONTENT_TYPE_REQUIRED'||code==='CONTENT_ENCODING_FORBIDDEN'?415:400,
          ['REQUEST_BODY_TOO_LARGE','CONTENT_TYPE_REQUIRED','CONTENT_ENCODING_FORBIDDEN'].includes(code)?code:'REQUEST_JSON_INVALID',extensionOrigin);}
      if(await authorizeBrowser({tabId:data.tabId,boundUrl:data.boundUrl,browserSessionId:data.browserSessionId})!==true)
        return json(res,409,'BROWSER_SESSION_UNAUTHORIZED',extensionOrigin);
      if(url.pathname===PREVIEW_ROUTE){
        try{const task=taskStore.recordPreview({binding:data.binding,evidence:data.evidence});
          safeLog({event:'media_preview_recorded',taskId:task.taskId,status:task.status});return json(res,200,null,extensionOrigin);}
        catch{return json(res,409,'PREVIEW_EVIDENCE_REJECTED',extensionOrigin);}
      }
      let startedClaim;
      try{startedClaim=taskStore.beginClaim(data);taskId=startedClaim.task.taskId;}
      catch{return json(res,409,'MEDIA_TASK_UNAVAILABLE',extensionOrigin);}
      let result;
      try{result=await receiptStore.claimOnce(startedClaim.handle);claimed=true;}
      catch{taskStore.recordUnknown(taskId,'MEDIA_RECEIPT_CLAIM_UNCERTAIN');return json(res,409,'MEDIA_CLAIM_FAILED',extensionOrigin);}
      if(!validClaim(result)){taskStore.recordUnknown(taskId,'MEDIA_CLAIM_RESULT_INVALID');return json(res,409,'MEDIA_CLAIM_FAILED',extensionOrigin);}
      try{taskStore.recordClaimed(taskId,result.receipt);}catch{taskStore.recordUnknown(taskId,'MEDIA_CLAIM_BINDING_UNKNOWN');
        return json(res,409,'MEDIA_CLAIM_FAILED',extensionOrigin);}
      safeLog({event:'media_claimed_response_unknown',taskId,receiptId:result.receipt.id,status:'CLAIMED_RESPONSE_UNKNOWN'});
      res.once('finish',()=>{try{const task=taskStore.recordHttpFinished(taskId);safeLog({event:'media_http_finished',taskId,status:task.status});}catch{}});
      res.once('close',()=>{if(!res.writableFinished){try{taskStore.recordUnknown(taskId,'MEDIA_HTTP_RESPONSE_INTERRUPTED');}catch{}
        safeLog({event:'media_http_interrupted',taskId,status:'DELIVERY_UNKNOWN'});}});
      try{await sendBinary(res,result,extensionOrigin);}catch{try{taskStore.recordUnknown(taskId,'MEDIA_HTTP_RESPONSE_INTERRUPTED');}catch{}
        if(!res.destroyed)res.destroy();}
    }catch{
      if(taskId&&claimed){try{taskStore.recordUnknown(taskId,'MEDIA_BRIDGE_EXCEPTION');}catch{}}
      if(!res.headersSent&&!res.destroyed)return json(res,500,'REQUEST_FAILED',req.headers.origin===extensionOrigin?extensionOrigin:null);
      if(!res.destroyed)res.destroy();
    }
  });
  return {enabled:true,start(){if(started||closed)return Promise.reject(Error(started?'WEB_MEDIA_ALREADY_STARTED':'WEB_MEDIA_CLOSED'));
    started=true;return new Promise((resolve,reject)=>{const bad=e=>{started=false;reject(e);};server.once('error',bad);server.listen(port,host,()=>{
      server.off('error',bad);const address=server.address();resolve({host,port:address.port});});});},
  stop(){if(closed)return Promise.resolve();if(!started){closed=true;expected.fill(0);return Promise.resolve();}
    return new Promise(resolve=>server.close(()=>{started=false;closed=true;expected.fill(0);resolve();}));}};
}

export const webMediaBridgeProtocol=Object.freeze({claimRoute:CLAIM_ROUTE,previewRoute:PREVIEW_ROUTE,
  maxBodyBytes:MAX_BODY,maxHeaderBytes:MAX_HEADER,maxResponseBytes:webMediaTaskLimits.maxBytes});
