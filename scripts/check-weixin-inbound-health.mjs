import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {ProtectedAuthStore} from '../src/auth-store.mjs';
import {
  RealWeixinTransport,buildGetUpdatesRequest,normalizeGetUpdatesResponse,
  protocolInternalsForTest,validateApiBaseUrl
} from '../src/transports/real-weixin.mjs';
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
  const req=buildGetUpdatesRequest(auth.cursor||'');
  let normalized;
  try{
    const body=await protocolInternalsForTest.fetchJson(
      fetch,new URL(req.path,validateApiBaseUrl(auth.baseUrl)+'/'),{
        method:req.method,
        headers:protocolInternalsForTest.commonHeaders({token:auth.botToken}),
        body:JSON.stringify(req.body)
      },35_000,'HEALTH_GETUPDATES'
    );
    normalized=normalizeGetUpdatesResponse(body);
  }catch(error){
    if(error?.message==='HEALTH_GETUPDATES_TIMEOUT')normalized={messages:[],nextCursor:null};
    else throw error;
  }
  const summary=summarizeInboundHealth(normalized.messages,{accountId:auth.accountId,peer});
  console.log(summary.state);
  console.log('received='+summary.received+
    ' paired_accepted='+summary.pairedAccepted+
    ' envelope_accepted='+summary.envelopeAccepted+
    ' cursor_committed=false outbound_sent=false');
  if(summary.state==='WEIXIN_UPSTREAM_BLOCKED'){
    console.log('Meaning: lifecycle is reachable, but getUpdates returned no inbound messages in this check.');
  }else if(summary.state==='WEIXIN_INBOUND_AVAILABLE'){
    console.log('Meaning: paired-DM inbound traffic is visible. Resume one-shot acceptance testing.');
  }else{
    console.log('Meaning: inbound traffic exists, but no accepted message from the paired DM was visible.');
  }
}finally{
  if(lifecycleStarted){
    try{await transport.notifyStop();console.log('notify_stop=ok');}
    catch{console.log('notify_stop=failed');}
  }
}
