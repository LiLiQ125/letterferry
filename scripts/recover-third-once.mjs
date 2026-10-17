import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AdapterStore } from '../src/store.mjs';
import { ExistingBridgeClient } from '../src/bridge-client.mjs';
const OLD_ID='6ad5033b-ce85-43ff-a486-4145af498aed';
const ADAPTER_ID='cdd4a070-51c7-464e-9263-6a8d47b1a9eb';
const CLAIM='OWNER_CONFIRMED_NO_HOST_DELIVERY_FOR_EXACT_EVENT';
const RECOVERY_KEY='weixin:owner-recovery-once:'+ADAPTER_ID;
async function main(){
  if(process.env.RIVEN_WEIXIN_RECOVER_ONCE!==CLAIM)throw new Error('RECOVERY_APPROVAL_REQUIRED');
  const cfg=JSON.parse(readFileSync(resolve('data/weixin-runtime.json'),'utf8'));
  if(!cfg.allowedPeer?.userId||cfg.allowedPeer.userId!==cfg.allowedPeer.chatId
    ||cfg.inboundEnabled!==false||cfg.outboundEnabled!==false)throw new Error('RECOVERY_CAPABILITIES_NOT_DISABLED');
  const bridge=new ExistingBridgeClient({origin:process.env.CHATGPT_BRIDGE_ORIGIN});
  const old=await bridge.getEvent(OLD_ID);
  if(old.status!=='CANCELLED'||old.replyText)throw new Error('ORIGINAL_NOT_CANCELLED');
  const store=new AdapterStore(resolve('data/adapter.sqlite'));
  try{
    const events=store.list();
    const target=events.find(e=>e.id===ADAPTER_ID);
    if(!target||target.status!=='BRIDGE_QUEUED'||target.bridge_event_id!==OLD_ID
      ||target.bridge_submit_attempts!==1||target.last_error!==null
      ||target.user_id!==cfg.allowedPeer.userId||target.chat_id!==cfg.allowedPeer.chatId)
      throw new Error('EXACT_PENDING_ADAPTER_NOT_FOUND');
    const other=events.filter(e=>e.id!==ADAPTER_ID&&e.status!=='SUCCEEDED');
    if(other.length)throw new Error('UNRELATED_PENDING_EVENTS_PRESENT');
    const body=`[WeChat authorized text | adapter_event=${target.id}]\n${target.text}`;
    if(body.length>2000)throw new Error('RECOVERY_TEXT_TOO_LONG');
    const queued=await bridge.enqueue({text:body,idempotencyKey:RECOVERY_KEY});
    if(!queued?.eventId)throw new Error('RECOVERY_ENQUEUE_FAILED');
    const result=store.db.prepare(`UPDATE adapter_events SET bridge_event_id=?, bridge_submit_attempts=bridge_submit_attempts+1,
      updated_ms=?, last_error='MANUAL_RECOVERY_AFTER_HOST_CONFIRMATION'
      WHERE id=? AND status='BRIDGE_QUEUED' AND bridge_event_id=? AND bridge_submit_attempts=1 AND last_error IS NULL`)
      .run(queued.eventId,Date.now(),ADAPTER_ID,OLD_ID);
    if(result.changes!==1)throw new Error('RECOVERY_COMMIT_CONFLICT_REVIEW_QUEUE');
    console.log(JSON.stringify({manualRecoveryQueued:true,originalPreservedCancelled:true,
      adapterBoundToOneNewBridgeEvent:true,weixinOutboundAttempted:false,flagsChanged:false}));
  }finally{store.close()}
}
try{await main()}catch(e){const s=e instanceof Error?e.message:'';console.error(/^[A-Z0-9_:-]{1,140}$/.test(s)?s:'RECOVERY_FAILED');process.exitCode=1}
