const MAX_BYTES=12*1024*1024;
const LABEL='\u6dfb\u52a0\u7167\u7247';
function fail(code){throw new Error(code);}
function loopback(value){try{const url=new URL(value);return url.protocol==='http:'&&url.hostname==='127.0.0.1'&&!url.username&&!url.password&&!url.search&&!url.hash;}
  catch{return false;}}
function extension(value){return typeof value==='string'&&/^chrome-extension:\/\/[a-p]{32}$/.test(value);}

export function createMediaTaskClient({enabled=false,baseUrl,authToken,extensionOrigin,fetchImpl=globalThis.fetch}={}){
  if(enabled!==true)return Object.freeze({enabled:false,claim:async()=>{throw Error('MEDIA_TASK_CLIENT_DISABLED');},submitEnabled:false});
  if(!loopback(baseUrl)||typeof authToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(authToken)||
    !extension(extensionOrigin)||typeof fetchImpl!=='function')fail('MEDIA_TASK_CLIENT_CONFIGURATION_INVALID');
  const request=async(path,packet)=>{
    const response=await fetchImpl(baseUrl+path,{method:'POST',headers:{authorization:'Bearer '+authToken,
      'content-type':'application/json'},body:JSON.stringify(packet),credentials:'omit',cache:'no-store',redirect:'error',
      referrerPolicy:'no-referrer',mode:'cors'});
    if(response.headers.get('access-control-allow-origin')!==extensionOrigin||response.headers.get('cache-control')!=='no-store'||
      response.headers.get('x-content-type-options')!=='nosniff')fail('MEDIA_TASK_RESPONSE_POLICY_INVALID');
    if(!response.ok)fail('MEDIA_TASK_REQUEST_REJECTED');
    return response;
  };
  return Object.freeze({enabled:true,submitEnabled:false,
    async claim(packet){const response=await request('/v1/media-task/claim',packet);const type=(response.headers.get('content-type')||'').split(';')[0];
      if(!['image/jpeg','image/png','image/gif','image/webp'].includes(type))fail('MEDIA_TASK_RESPONSE_MIME_INVALID');
      const declared=Number(response.headers.get('content-length'));if(!Number.isSafeInteger(declared)||declared<1||declared>MAX_BYTES)
        fail('MEDIA_TASK_RESPONSE_SIZE_INVALID');
      const disposition=response.headers.get('content-disposition')||'';
      const filenameMatch=/^attachment; filename="([A-Za-z0-9][A-Za-z0-9._-]{0,119})"$/.exec(disposition);
      if(!filenameMatch)fail('MEDIA_TASK_RESPONSE_FILENAME_INVALID');
      const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.byteLength!==declared)fail('MEDIA_TASK_RESPONSE_SIZE_INVALID');
      return {bytes,mimeType:type,size:bytes.byteLength,fileName:filenameMatch[1],readyForAttachmentTest:true,sendClicked:false};},
    async recordPreview({binding,evidence}){if(evidence?.inputLabel!==LABEL||evidence?.readyForSubmit!==true||
      evidence?.sendClicked!==false||evidence?.previewChecks!==2)fail('MEDIA_TASK_PREVIEW_EVIDENCE_INVALID');
      await request('/v1/media-task/preview',{tabId:binding.tabId,boundUrl:binding.boundUrl,
        browserSessionId:binding.browserSessionId,binding,evidence});return {recorded:true,sendClicked:false};}
  });
}

export const mediaTaskClientPolicy=Object.freeze({preferredInputLabel:LABEL,maxBytes:MAX_BYTES,
  performsDomMutation:false,performsSubmit:false,authoritativeDelivery:false});
