import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {ProtectedAuthStore} from '../src/auth-store.mjs';
import {
  RealWeixinTransport,buildGetUpdatesRequest,normalizeGetUpdatesResponse,
  protocolInternalsForTest,validateApiBaseUrl
} from '../src/transports/real-weixin.mjs';
import {summarizeInboundHealth} from '../src/weixin-inbound-health.mjs';

const fingerprint=value=>createHash('sha256').update(String(value)).digest('hex').slice(0,16);
const pkg=JSON.parse(readFileSync(resolve('package.json'),'utf8'));
const config=JSON.parse(readFileSync(resolve('data/weixin-runtime.json'),'utf8'));
const peer=config.allowedPeer;
if(!peer?.userId||peer.userId!==peer.chatId)throw Error('EXACT_PAIRED_WEIXIN_DM_REQUIRED');
if(config.inboundEnabled!==false||config.outboundEnabled!==false)throw Error('PERSISTENT_WEIXIN_FLAGS_MUST_BE_OFF');

const authStore=new ProtectedAuthStore();
const auth=await authStore.load();
const transport=new RealWeixinTransport({
  authStore,allowedPeer:peer,inboundEnabled:true,outboundEnabled:false
});

let notifyStart='not_run',notifyStop='not_run',normalized={messages:[],nextCursor:null},pollError=null;
try{
  await transport.notifyStart();
  notifyStart='ok';
  const req=buildGetUpdatesRequest(auth.cursor||'');
  try{
    const body=await protocolInternalsForTest.fetchJson(
      fetch,new URL(req.path,validateApiBaseUrl(auth.baseUrl)+'/'),{
        method:req.method,
        headers:protocolInternalsForTest.commonHeaders({token:auth.botToken}),
        body:JSON.stringify(req.body)
      },35_000,'SUPPORT_GETUPDATES'
    );
    normalized=normalizeGetUpdatesResponse(body);
  }catch(error){
    if(error?.message==='SUPPORT_GETUPDATES_TIMEOUT')pollError='timeout';
    else pollError=error?.message||'poll_failed';
  }
}finally{
  if(notifyStart==='ok'){
    try{await transport.notifyStop();notifyStop='ok';}
    catch{notifyStop='failed';}
  }
}

const summary=summarizeInboundHealth(normalized.messages,{accountId:auth.accountId,peer});
const report={
  schema:'letterferry-weixin-support-report-v1',
  generated_at:new Date().toISOString(),
  letterferry_version:pkg.version,
  safety:{
    cursor_committed:false,
    outbound_sent:false,
    chat_bodies_included:false,
    raw_tokens_included:false,
    raw_ids_included:false
  },
  identity:{
    account_fingerprint:fingerprint(auth.accountId),
    paired_peer_fingerprint:fingerprint(peer.userId)
  },
  transport:{
    api_host:new URL(validateApiBaseUrl(auth.baseUrl)).hostname,
    stored_cursor_present:Boolean(auth.cursor),
    stored_cursor_length:typeof auth.cursor==='string'?auth.cursor.length:0,
    next_cursor_present:Boolean(normalized.nextCursor),
    next_cursor_would_change:Boolean(normalized.nextCursor&&normalized.nextCursor!==(auth.cursor||'')),
    notify_start:notifyStart,
    poll_error:pollError,
    notify_stop:notifyStop
  },
  inbound:summary,
  runtime_flags:{
    inboundEnabled:config.inboundEnabled,
    outboundEnabled:config.outboundEnabled
  }
};

mkdirSync(resolve('reports-local'),{recursive:true});
const out=resolve('reports-local','weixin-support-report.json');
writeFileSync(out,JSON.stringify(report,null,2)+'\n','utf8');
console.log('SUPPORT_REPORT_CREATED');
console.log(out);
console.log('Safe summary only: no chat bodies, raw tokens, context tokens, full account IDs, or full peer IDs.');
