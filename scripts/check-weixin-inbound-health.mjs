import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {ProtectedAuthStore} from '../src/auth-store.mjs';
import {RealWeixinTransport,getUpdatesSnapshot,validateApiBaseUrl} from '../src/transports/real-weixin.mjs';
import {summarizeInboundHealth} from '../src/weixin-inbound-health.mjs';

const config=JSON.parse(readFileSync(resolve('data/weixin-runtime.json'),'utf8'));
const peer=config.allowedPeer;
if(!peer?.userId||peer.userId!==peer.chatId)throw Error('EXACT_PAIRED_WEIXIN_DM_REQUIRED');
if(config.inboundEnabled!==false||config.outboundEnabled!==false)throw Error('PERSISTENT_WEIXIN_FLAGS_MUST_BE_OFF');

const authStore=new ProtectedAuthStore();
const auth=await authStore.load();
const transport=new RealWeixinTransport({
  authStore,allowedPeer:peer,inboundEnabled:true,outboundEnabled:false
});

let lifecycleStarted=false;
try{
  await transport.notifyStart();
  lifecycleStarted=true;
  const snapshot=await getUpdatesSnapshot({
    fetchImpl:fetch,
    baseUrl:auth.baseUrl,
    token:auth.botToken,
    cursor:auth.cursor||'',
    timeoutMs:45_000
  });
  const messages=snapshot.outcome==='server_messages'?snapshot.messages:[];
  const summary=summarizeInboundHealth(messages,{accountId:auth.accountId,peer});
  const state=snapshot.outcome==='client_timeout'
    ? 'WEIXIN_INBOUND_CLIENT_TIMEOUT'
    : snapshot.outcome==='error'
      ? 'WEIXIN_INBOUND_DIAGNOSTIC_ERROR'
      : summary.state;

  console.log(state);
  console.log('outcome='+snapshot.outcome+
    ' elapsed_ms='+snapshot.elapsedMs+
    ' http_status='+(snapshot.httpStatus??'none')+
    ' ret='+(snapshot.ret??'none')+
    ' errcode='+(snapshot.errcode??'none')+
    ' errmsg_category='+snapshot.errmsgCategory+
    ' cursor_present='+snapshot.cursorPresent+
    ' cursor_changed='+snapshot.cursorChanged+
    ' received='+summary.received+
    ' paired_accepted='+summary.pairedAccepted+
    ' local_cursor_committed=false server_replay_effect=unknown outbound_sent=false');

  if(snapshot.outcome==='client_timeout'){
    console.log('Meaning: the client-side 45s deadline fired before a complete server response was obtained.');
  }else if(snapshot.outcome==='server_empty'){
    console.log('Meaning: the server completed the request but returned no inbound messages in this snapshot.');
    console.log('This is inconclusive by itself: an idle healthy account can also return zero messages.');
  }else if(snapshot.outcome==='server_messages' && summary.state==='WEIXIN_INBOUND_AVAILABLE'){
    console.log('Meaning: paired-DM inbound traffic is visible. Resume controlled one-shot acceptance.');
  }else if(snapshot.outcome==='server_messages'){
    console.log('Meaning: inbound traffic was returned, but no accepted message from the paired DM was visible.');
  }else{
    console.log('Meaning: the diagnostic request ended in a fixed error category; inspect the fields above.');
  }
  console.log('Important: this diagnostic does not modify the local persisted cursor, but iLink server replay/consumption semantics are not guaranteed by LetterFerry.');
}finally{
  if(lifecycleStarted){
    try{await transport.notifyStop();console.log('notify_stop=ok');}
    catch{console.log('notify_stop=failed');}
  }
}
