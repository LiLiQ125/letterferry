import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ProtectedAuthStore } from '../src/auth-store.mjs';
import { AdapterStore } from '../src/store.mjs';
import { AllowlistPolicy } from '../src/policy.mjs';
import { ExistingBridgeClient } from '../src/bridge-client.mjs';
import { RealWeixinTransport } from '../src/transports/real-weixin.mjs';
import { WeixinBridgeAdapter } from '../src/adapter.mjs';
import { loadEncryptionKey } from '../src/secrets.mjs';

const adapterEvent = 'dd4c60de-ad0e-4283-8236-4e66291f3438';
const bridgeEvent = '4a0c61fa-fe67-4ea1-94f7-217d36361dec';
async function main() {
  if (process.env.RIVEN_WEIXIN_SEND_ONCE !== 'OWNER_APPROVED_EXACT_REPLY_20261016') throw new Error('SEND_ONCE_APPROVAL_REQUIRED');
  const cfg=JSON.parse(readFileSync(resolve('data/weixin-runtime.json'),'utf8'));
  if (!cfg.allowedPeer?.userId || cfg.allowedPeer.userId !== cfg.allowedPeer.chatId
      || cfg.inboundEnabled !== false || cfg.outboundEnabled !== false) throw new Error('PERSISTENT_CAPABILITIES_MUST_REMAIN_DISABLED');
  const authStore=new ProtectedAuthStore();
  const auth=await authStore.load();
  const key=loadEncryptionKey();
  let store;
  try {
    store=new AdapterStore(resolve('data/adapter.sqlite'));
    const rows=store.list();
    if (rows.some(r=>['OUTBOUND_UNKNOWN','OUTBOUND_SENDING','REPLY_READY','RECEIVED'].includes(r.status))) throw new Error('UNEXPECTED_PENDING_STATE');
    const target=rows.find(r=>r.id===adapterEvent);
    if (!target || target.status!=='BRIDGE_QUEUED' || target.bridge_event_id!==bridgeEvent
        || target.user_id!==cfg.allowedPeer.userId || target.chat_id!==cfg.allowedPeer.chatId) throw new Error('EXACT_REPLY_NOT_PENDING');
    if (rows.filter(r=>r.status==='BRIDGE_QUEUED'&&r.id!==adapterEvent).length>1) throw new Error('TOO_MANY_PENDING_EVENTS');
    const bridge=new ExistingBridgeClient({origin:process.env.CHATGPT_BRIDGE_ORIGIN});
    const remote=await bridge.getEvent(bridgeEvent);
    if (remote.status!=='SUCCEEDED' || typeof remote.replyText!=='string'
      || !remote.replyText.trim() || remote.replyText.length>2000) throw new Error('BRIDGE_REPLY_NOT_READY');
    const policy=new AllowlistPolicy({accountId:auth.accountId,allowedPeers:[cfg.allowedPeer]});
    const transport=new RealWeixinTransport({authStore,allowedPeer:cfg.allowedPeer,inboundEnabled:false,outboundEnabled:true});
    const adapter=new WeixinBridgeAdapter({accountId:auth.accountId,policy,store,bridge,transport,encryptionKey:key});
    const collected=await adapter.collectOneReply();
    if (collected?.id!==adapterEvent || collected.status!=='REPLY_READY') throw new Error('REPLY_COLLECT_MISMATCH');
    const sent=await adapter.sendOneReply();
    if(sent?.id!==adapterEvent || sent.status!=='SUCCEEDED') throw new Error('SEND_DID_NOT_COMPLETE');
    console.log(JSON.stringify({outboundCallCount:1,apiAccepted:true,exactEvent:true,otherPendingEventsUntouched:true,persistentFlagsChanged:false}));
  }finally{store?.close();key.fill(0)}
}
try{await main()}catch(e){const m=e instanceof Error?e.message:'';console.error(/^[A-Z0-9_:-]{1,120}$/.test(m)?m:'SEND_ONCE_FAILED');process.exitCode=1}
