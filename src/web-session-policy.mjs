import {normalizeInbound} from './policy.mjs';

export const START_PREFIX='RWX_SESSION_START_';
export const START_APPROVAL='START WEB WEIXIN 30 MIN';
const SAFE_PRIOR=new Set(['SUCCEEDED','REVIEWED_NO_REPLAY','DEFERRED_BACKLOG']);

export function exactStartMarker(value){
  return typeof value==='string' && /^RWX_SESSION_START_[A-F0-9]{24}$/.test(value);
}

export function auditWebSessionStart(rows){
  if(!Array.isArray(rows)||rows.some(row=>!SAFE_PRIOR.has(row.status)))
    throw Error('WEB_SESSION_PREEXISTING_EVENT_REQUIRES_REVIEW');
  return true;
}

export function selectActivationBatch(updates,{marker,accountId,peer}){
  if(!exactStartMarker(marker))throw Error('INVALID_WEB_SESSION_MARKER');
  if(!peer?.userId || peer.userId!==peer.chatId)throw Error('SESSION_EXACT_PAIRED_DM_REQUIRED');
  if(!Array.isArray(updates))throw Error('INVALID_ACTIVATION_BATCH');
  let matches=0;
  for(const raw of updates){
    // Transport already allows only the paired peer's supported direct-message envelope.
    // Malformed content must stop the cursor, not disappear as processed.
    if(raw?.from_user_id!==peer.userId)throw Error('UNEXPECTED_ACTIVATION_SENDER');
    const parsed=normalizeInbound(raw,accountId);
    if(parsed.chatId!==peer.chatId)throw Error('ACTIVATION_PEER_MISMATCH');
    if(raw.item_list?.[0]?.text_item?.text===marker)matches++;
  }
  if(matches>1)throw Error('MULTIPLE_START_MARKERS_NO_CURSOR_CHANGE');
  if(matches===0)return {found:false,count:updates.length,updates:[]};
  return {found:true,count:updates.length,updates};
}

export function archiveActivationBatch({store,adapter,updates,marker,accountId,peer}){
  const selected=selectActivationBatch(updates,{marker,accountId,peer});
  if(!selected.found)throw Error('WEB_SESSION_MARKER_NOT_IN_BATCH');
  if(!store?.db || !adapter?.ingestRaw)throw Error('ARCHIVE_DEPENDENCIES_REQUIRED');
  let newDeferred=0,existingSafe=0;
  store.db.exec('BEGIN IMMEDIATE');
  try{
    for(const raw of selected.updates){
      const parsed=normalizeInbound(raw,accountId);
      const prior=store.getByInboundKey(accountId+':'+parsed.messageId);
      if(raw.item_list?.[0]?.text_item?.text===marker && prior)throw Error('SESSION_MARKER_ALREADY_STORED');
      if(prior && !SAFE_PRIOR.has(prior.status))throw Error('ARCHIVE_PREEXISTING_EVENT_NOT_TERMINAL');
      const accepted=adapter.ingestRaw(raw);
      if(!accepted?.accepted || !accepted.event)throw Error('ARCHIVE_INBOUND_REJECTED');
      if(prior){existingSafe++;continue;}
      store.deferBacklog(accepted.event.id);
      newDeferred++;
    }
    store.db.exec('COMMIT');
  }catch(error){
    store.db.exec('ROLLBACK');
    throw error;
  }
  return {deferredNew:newDeferred,existingSafe,total:selected.count};
}

export function assertPostFenceBatch(updates,accountId,peer){
  if(!Array.isArray(updates))throw Error('INVALID_SESSION_BATCH');
  for(const raw of updates){
    if(raw?.from_user_id!==peer.userId)throw Error('UNEXPECTED_SESSION_SENDER');
    const parsed=normalizeInbound(raw,accountId);
    if(parsed.chatId!==peer.chatId)throw Error('SESSION_PEER_MISMATCH');
  }
  return true;
}
