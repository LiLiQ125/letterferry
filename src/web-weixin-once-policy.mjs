import { normalizeInbound, directEnvelopeRejection } from './policy.mjs';
import {isVerificationChallenge,isNaturalChallenge,matchesOneShotChallenge,isOneShotReplyOrigin} from './natural-once.mjs';

export const CHALLENGE_PREFIX='RWX_WEB_ONCE_';
export const APPROVAL_RECEIVE='POLL WEIXIN ONCE';
export const APPROVAL_SEND='SEND EXACT WEIXIN REPLY';

export function verifyWebHostHealth(health) {
  if(health?.ok!==true || health.host!=='HOST_READY') throw Error('WEB_HOST_NOT_READY');
  const counts=health.queue||{};
  if(Object.entries(counts).some(([status,count])=>!['SUCCEEDED','REVIEWED_NO_REPLAY'].includes(status) && Number(count)>0))
    throw Error('WEB_HOST_HAS_UNRESOLVED_TASK');
  return true;
}
export function requireDisabledBinding(config) {
  if(!config?.allowedPeer?.userId || config.allowedPeer.userId!==config.allowedPeer.chatId)
    throw Error('EXACT_PAIRED_WEIXIN_DM_REQUIRED');
  if(config.inboundEnabled!==false || config.outboundEnabled!==false ||
     config.liveApproval==='I_APPROVE_ONE_LOCAL_LIVE_CYCLE')
    throw Error('PERSISTENT_WEIXIN_FLAGS_MUST_BE_OFF');
  return config.allowedPeer;
}
export function assertOnlySucceeded(rows) {
  if(!Array.isArray(rows) || rows.some(row=>!['SUCCEEDED','REVIEWED_NO_REPLAY','DEFERRED_BACKLOG'].includes(row.status)))
    throw Error('WEIXIN_INCOMPLETE_EVENTS_REQUIRE_REVIEW');
}
export function selectOneExactChallenge(updates,{challenge,accountId,peer}) {
  if(typeof challenge!=='string'||!/^RWX_WEB_ONCE_[A-F0-9]{24}$/.test(challenge))
    throw Error('INVALID_ONE_SHOT_CHALLENGE');
  if(!Array.isArray(updates)) throw Error('INVALID_WEIXIN_UPDATES');
  const matched=[];
  for(const raw of updates) {
    if(directEnvelopeRejection(raw,accountId)!==null || raw.from_user_id!==peer.userId)
      continue;
    // A batch containing another allowed DM is not safe to cursor-commit and discard.
    if(raw.item_list?.length!==1 || raw.item_list[0]?.type!==1 ||
       raw.item_list[0]?.text_item?.text!==challenge)
      throw Error('UNEXPECTED_ALLOWED_DM_DONT_ADVANCE_CURSOR');
    const normalized=normalizeInbound(raw,accountId);
    if(normalized.chatId!==peer.chatId) throw Error('WEIXIN_TARGET_MISMATCH');
    matched.push(raw);
  }
  if(matched.length===0) throw Error('CHALLENGE_NOT_RECEIVED_NO_CURSOR_CHANGE');
  if(matched.length!==1) throw Error('MULTIPLE_CHALLENGES_NO_CURSOR_CHANGE');
  return matched[0];
}
// Unlike strict pairing, a one-shot follow-up may encounter a backlog in the
// SAME allowlisted DM. We may accept the fresh challenge while retaining every
// other unread message by deliberately withholding the upstream cursor commit.
// Only already-stored, fully completed duplicate DMs can be safely skipped.
export function planChallengeWithPreservedBacklog(updates,{
  challenge,accountId,peer,findStoredInbound=()=>null
}) {
  if(!isVerificationChallenge(challenge)&&!isNaturalChallenge(challenge))
    throw Error('INVALID_ONE_SHOT_CHALLENGE');
  if(!Array.isArray(updates))throw Error('INVALID_WEIXIN_UPDATES');
  if(!peer?.userId || peer.chatId!==peer.userId)throw Error('EXACT_PAIRED_WEIXIN_DM_REQUIRED');
  const matches=[],others=[];
  for(const raw of updates){
    if(directEnvelopeRejection(raw,accountId)!==null || raw.from_user_id!==peer.userId)continue;
    const isExact=raw.item_list?.length===1 && raw.item_list[0]?.type===1 &&
      matchesOneShotChallenge(raw.item_list[0]?.text_item?.text,challenge);
    if(isExact){
      const inbound=normalizeInbound(raw,accountId);
      if(inbound.chatId!==peer.chatId)throw Error('WEIXIN_TARGET_MISMATCH');
      matches.push(raw);
    }else others.push(raw);
  }
  // A page containing only old/unrelated DMs cannot provide evidence that the
  // newly submitted challenge arrived. Never read it as an implicit approval.
  if(matches.length===0)throw Error(others.length
    ? 'CHALLENGE_NOT_IN_BATCH_WITH_BACKLOG_NO_CURSOR_CHANGE'
    : 'CHALLENGE_NOT_RECEIVED_NO_CURSOR_CHANGE');
  if(matches.length!==1)throw Error('MULTIPLE_CHALLENGES_NO_CURSOR_CHANGE');
  let unrecorded=0;
  for(const raw of others){
    let safelyStored=false;
    try{
      const inbound=normalizeInbound(raw,accountId);
      const row=findStoredInbound(`${accountId}:${inbound.messageId}`);
      safelyStored=Boolean(row && row.status==='SUCCEEDED' &&
        row.account_id===accountId && row.user_id===peer.userId &&
        row.chat_id===peer.chatId && row.message_id===inbound.messageId &&
        row.text===inbound.text);
    }catch{}
    if(!safelyStored)unrecorded++;
  }
  return {
    challengeRaw:matches[0],
    additionalAllowedCount:others.length,
    unrecordedAllowedCount:unrecorded,
    canAdvanceCursor:unrecorded===0
  };
}
// Cursor advancement is itself a data-loss boundary: only commit when the
// entire allowlisted batch was either this challenge or previously persisted.
export async function pollChallengeWithGrace({
  transportFactory,challenge,accountId,peer,findStoredInbound=()=>null,
  attempts=3,delayMs=1500,sleep=ms=>new Promise(done=>setTimeout(done,ms))
}) {
  if(typeof transportFactory!=='function'||!Number.isInteger(attempts)||attempts<1||attempts>5||
     !Number.isInteger(delayMs)||delayMs<0||delayMs>10_000||typeof sleep!=='function')
    throw Error('INVALID_CHALLENGE_POLL_CONFIG');
  let lastError=null;
  for(let attempt=1;attempt<=attempts;attempt++){
    const transport=transportFactory();
    if(!transport||typeof transport.poll!=='function')throw Error('INVALID_CHALLENGE_TRANSPORT');
    const updates=await transport.poll();
    try{
      const plan=planChallengeWithPreservedBacklog(updates,{
        challenge,accountId,peer,findStoredInbound
      });
      return {transport,plan,attempt};
    }catch(error){
      lastError=error;
      const retryableMiss=error?.message==='CHALLENGE_NOT_RECEIVED_NO_CURSOR_CHANGE' ||
        error?.message==='CHALLENGE_NOT_IN_BATCH_WITH_BACKLOG_NO_CURSOR_CHANGE';
      if(!retryableMiss||attempt===attempts)throw error;
      await sleep(delayMs);
    }
  }
  throw lastError||Error('CHALLENGE_NOT_RECEIVED_NO_CURSOR_CHANGE');
}
export function persistOneShotBatch({store,adapter,updates,challenge,accountId,peer}) {
  if(!store?.db || typeof adapter?.ingestRaw!=='function')throw Error('ONE_SHOT_PERSIST_DEPENDENCIES_REQUIRED');
  const plan=planChallengeWithPreservedBacklog(updates,{challenge,accountId,peer,
    findStoredInbound:key=>store.getByInboundKey(key)});
  let challengeEvent=null,deferredNew=0,existingSafe=0;
  store.db.exec('BEGIN IMMEDIATE');
  try{
    for(const raw of updates){
      const accepted=adapter.ingestRaw(raw);
      if(!accepted?.accepted || !accepted.event)throw Error('ONE_SHOT_PERSIST_INGEST_REJECTED');
      if(accepted.event.account_id!==accountId || accepted.event.user_id!==peer.userId ||
         accepted.event.chat_id!==peer.chatId)throw Error('ONE_SHOT_PERSIST_BINDING_CONFLICT');
      if(raw===plan.challengeRaw){
        if(accepted.event.status!=='RECEIVED')throw Error('ONE_SHOT_CHALLENGE_PREEXISTING_OR_UNSAFE');
        challengeEvent=accepted.event;
        continue;
      }
      if(accepted.event.status==='RECEIVED'){
        store.deferBacklog(accepted.event.id);
        deferredNew++;
      }else if(['SUCCEEDED','REVIEWED_NO_REPLAY','DEFERRED_BACKLOG'].includes(accepted.event.status)){
        existingSafe++;
      }else throw Error('ONE_SHOT_BACKLOG_PREEXISTING_PENDING');
    }
    if(!challengeEvent)throw Error('ONE_SHOT_CHALLENGE_NOT_PERSISTED');
    store.db.exec('COMMIT');
  }catch(error){
    store.db.exec('ROLLBACK');
    throw error;
  }
  return {plan,challengeEvent,deferredNew,existingSafe,total:updates.length};
}

export async function commitKnownSafeCursor(transport,plan) {
  if(!plan || typeof plan.canAdvanceCursor!=='boolean' ||
    typeof transport?.commitPoll!=='function') throw Error('INVALID_CURSOR_PLAN');
  if(!plan.canAdvanceCursor)return false;
  await transport.commitPoll();
  return true;
}
export function selectOneReviewedReply(rows,peer) {
  if(!Array.isArray(rows))throw Error('INVALID_ADAPTER_ROWS');
  const waiting=rows.filter(row=>!['SUCCEEDED','REVIEWED_NO_REPLAY','DEFERRED_BACKLOG'].includes(row.status));
  if(waiting.length!==1 || waiting[0]?.status!=='REPLY_READY')
    throw Error('EXACT_SINGLE_READY_REPLY_REQUIRED');
  const row=waiting[0];
  if(row.user_id!==peer.userId || row.chat_id!==peer.chatId ||
    typeof row.text!=='string' || !isOneShotReplyOrigin(row.text) ||
    !row.bridge_event_id || row.bridge_submit_attempts!==1)
    throw Error('ONE_SHOT_IDENTITY_OR_ORIGIN_MISMATCH');
  return row;
}
