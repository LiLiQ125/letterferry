import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {ProtectedAuthStore} from '../src/auth-store.mjs';
import {AdapterStore} from '../src/store.mjs';
import {AllowlistPolicy} from '../src/policy.mjs';
import {ExistingBridgeClient} from '../src/bridge-client.mjs';
import {RealWeixinTransport} from '../src/transports/real-weixin.mjs';
import {WeixinBridgeAdapter} from '../src/adapter.mjs';
import {loadEncryptionKey} from '../src/secrets.mjs';

async function main(){
  if(process.env.RIVEN_WEIXIN_FLUSH_ONCE!=='OWNER_APPROVED_SINGLE_READY_REPLY')throw Error('FLUSH_NOT_APPROVED');
  const cfg=JSON.parse(readFileSync(resolve('data/weixin-runtime.json'),'utf8'));
  if(!cfg.allowedPeer?.userId||cfg.allowedPeer.userId!==cfg.allowedPeer.chatId||
    cfg.inboundEnabled!==false||cfg.outboundEnabled!==false)throw Error('FLUSH_FLAGS_OR_PEER_INVALID');
  const authStore=new ProtectedAuthStore();
  const auth=await authStore.load();
  const key=loadEncryptionKey();
  let store;
  try{
    store=new AdapterStore(resolve('data/adapter.sqlite'));
    const incomplete=store.list().filter(row=>row.status!=='SUCCEEDED');
    if(incomplete.length!==1||incomplete[0].status!=='BRIDGE_QUEUED'||
      incomplete[0].user_id!==cfg.allowedPeer.userId||
      incomplete[0].chat_id!==cfg.allowedPeer.chatId||
      typeof incomplete[0].bridge_event_id!=='string')throw Error('FLUSH_EXACT_ONE_QUEUED_EVENT_REQUIRED');
    const bridge=new ExistingBridgeClient({origin:process.env.CHATGPT_BRIDGE_ORIGIN});
    const remote=await bridge.getEvent(incomplete[0].bridge_event_id);
    if(remote.status!=='SUCCEEDED'||typeof remote.replyText!=='string'||
      !remote.replyText.trim()||remote.replyText.length>2000)throw Error('FLUSH_REPLY_NOT_CONFIRMED');
    const policy=new AllowlistPolicy({accountId:auth.accountId,allowedPeers:[cfg.allowedPeer]});
    const transport=new RealWeixinTransport({authStore,allowedPeer:cfg.allowedPeer,inboundEnabled:false,outboundEnabled:true});
    const adapter=new WeixinBridgeAdapter({accountId:auth.accountId,policy,store,transport,bridge,encryptionKey:key});
    const collected=await adapter.collectOneReply();
    if(collected?.id!==incomplete[0].id||collected.status!=='REPLY_READY')throw Error('FLUSH_COLLECT_MISMATCH');
    const sent=await adapter.sendOneReply();
    if(sent?.id!==incomplete[0].id||sent.status!=='SUCCEEDED')throw Error('FLUSH_NOT_SUCCEEDED');
    console.log(JSON.stringify({singleWechatApiCallAccepted:true,localStatus:'SUCCEEDED',otherEventsUnchanged:true,persistentFlagsChanged:false}));
  }finally{store?.close();key.fill(0)}
}
try{await main()}catch(e){const s=e instanceof Error?e.message:'';console.error(/^[A-Z0-9_:-]{1,120}$/.test(s)?s:'FLUSH_FAILED');process.exitCode=1}
