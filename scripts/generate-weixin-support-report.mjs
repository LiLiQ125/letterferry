import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {ProtectedAuthStore} from '../src/auth-store.mjs';
import {RealWeixinTransport,getUpdatesSnapshot,validateApiBaseUrl} from '../src/transports/real-weixin.mjs';
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

let notifyStart='not_run',notifyStop='not_run';
let snapshot={
  outcome:'not_run',elapsedMs:0,httpStatus:null,ret:null,errcode:null,
  errmsgCategory:'absent',nextCursor:null,cursorPresent:false,cursorChanged:false,messages:[]
};
try{
  await transport.notifyStart();
  notifyStart='ok';
  snapshot=await getUpdatesSnapshot({
    fetchImpl:fetch,
    baseUrl:auth.baseUrl,
    token:auth.botToken,
    cursor:auth.cursor||'',
    timeoutMs:45_000
  });
}finally{
  if(notifyStart==='ok'){
    try{await transport.notifyStop();notifyStop='ok';}
    catch{notifyStop='failed';}
  }
}

const summary=summarizeInboundHealth(snapshot.outcome==='server_messages'?snapshot.messages:[],{
  accountId:auth.accountId,peer
});
const report={
  schema:'letterferry-weixin-support-report-v2',
  generated_at:new Date().toISOString(),
  letterferry_version:pkg.version,
  classification:'DIAGNOSTIC_SNAPSHOT_ONLY',
  safety:{
    local_cursor_committed:false,
    server_replay_effect_known:false,
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
    polling_host_matches_saved_baseurl:true,
    stored_cursor_present:Boolean(auth.cursor),
    stored_cursor_length:typeof auth.cursor==='string'?auth.cursor.length:0,
    outcome:snapshot.outcome,
    elapsed_ms:snapshot.elapsedMs,
    http_status:snapshot.httpStatus,
    ret:snapshot.ret,
    errcode:snapshot.errcode,
    errmsg_category:snapshot.errmsgCategory,
    next_cursor_present:snapshot.cursorPresent,
    next_cursor_would_change:snapshot.cursorChanged,
    notify_start:notifyStart,
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
console.log('Local cursor is unchanged by this diagnostic; server-side replay/consumption behavior remains unknown.');