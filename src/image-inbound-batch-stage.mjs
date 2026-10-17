import {createHash} from 'node:crypto';
import {AllowlistPolicy,canonicalDirectChatId,directEnvelopeRejection} from './policy.mjs';

const ID=/^[A-Za-z0-9@._:-]{1,256}$/;
const MAX_CURSOR_LENGTH=16_384;
const MAX_BATCH_MESSAGES=100;

function digest(value){return createHash('sha256').update(value).digest('hex');}
function safeFailure(error,fallback){
  const code=error instanceof Error?error.message:String(error);
  return /^[A-Z][A-Z0-9_]{2,100}$/.test(code)?code:fallback;
}
class BatchRejection extends Error{
  constructor(code,{index=null,messageId=null,receipt=null}={}){
    super(code);this.index=index;this.messageId=messageId;this.receipt=receipt;
  }
}
function reject(code,details){throw new BatchRejection(code,details);}
function failureResult(error,{stagedReceipts=[],ignoredCount=0,duplicateCount=0}={}){
  return {readyForCursorAcknowledgement:false,acknowledgement:null,stagedReceipts,
    ignoredCount,duplicateCount,failure:{code:safeFailure(error,'IMAGE_BATCH_STAGE_FAILED'),
      index:error instanceof BatchRejection?error.index:null,
      messageId:error instanceof BatchRejection?error.messageId:null,
      receipt:error instanceof BatchRejection?error.receipt:null}};
}
function cursorValid(value){
  return typeof value==='string'&&value.length>0&&value.length<=MAX_CURSOR_LENGTH&&
    !/[\u0000-\u001f\u007f]/.test(value);
}
function uniqueMessageId(raw,index){
  const values=[raw?.message_id,...(Array.isArray(raw?.item_list)?raw.item_list.map(item=>item?.msg_id):[])]
    .filter(value=>value!==undefined&&value!==null);
  if(values.length===0)reject('IMAGE_BATCH_MESSAGE_ID_REQUIRED',{index});
  const ids=values.map(value=>{
    if(typeof value!=='string')reject('IMAGE_BATCH_MESSAGE_ID_INVALID',{index});
    const normalized=value.trim();
    if(!ID.test(normalized))reject('IMAGE_BATCH_MESSAGE_ID_INVALID',{index});
    return normalized;
  });
  const distinct=[...new Set(ids)];
  if(distinct.length!==1)reject('IMAGE_BATCH_MESSAGE_ID_CONFLICT',{index});
  return distinct[0];
}
function rawFingerprint(raw,index,messageId){
  try{return digest(JSON.stringify(raw));}
  catch{reject('IMAGE_BATCH_MESSAGE_NOT_SERIALIZABLE',{index,messageId});}
}
function validateAllowedImage(raw,index,accountId,policy){
  if(raw.message_type!==1)reject('IMAGE_BATCH_INBOUND_TYPE_REQUIRED',{index});
  if(raw.message_state!==0&&raw.message_state!==2)reject('IMAGE_BATCH_TERMINAL_STATE_REQUIRED',{index});
  const fromUserId=raw.from_user_id;
  const chatId=canonicalDirectChatId(fromUserId);
  const messageId=uniqueMessageId(raw,index);
  const identity={accountId,fromUserId,chatId,messageId};
  if(!policy.authorize(identity))reject('IMAGE_BATCH_PEER_NOT_AUTHORIZED',{index,messageId});
  if(!Array.isArray(raw.item_list)||raw.item_list.length!==1)
    reject('IMAGE_BATCH_EXACTLY_ONE_IMAGE_ITEM_REQUIRED',{index,messageId});
  const item=raw.item_list[0];
  if(item?.type!==2||!item.image_item||typeof item.image_item!=='object'||
    !item.image_item.media||typeof item.image_item.media!=='object')
    reject('IMAGE_BATCH_UNSUPPORTED_ALLOWED_CONTENT',{index,messageId});
  return {raw,index,identity,messageId,fingerprint:rawFingerprint(raw,index,messageId)};
}
function proofFor(cursor,receipts,ignoredCount,duplicateCount){
  return digest(JSON.stringify({v:1,cursor,ignoredCount,duplicateCount,receipts:receipts.map(item=>({
    id:item.receipt.id,messageId:item.receipt.messageId,digest:item.receipt.digest,status:item.receipt.status
  }))}));
}

export class CursorAcknowledgement{
  #cursor;#proof;#summary;#state='READY';
  constructor({cursor,proof,summary}){this.#cursor=cursor;this.#proof=proof;this.#summary=summary;}
  get status(){return this.#state;}
  describe(){return {...this.#summary,proof:this.#proof,status:this.#state};}
  async record(cursorStore){
    if(this.#state!=='READY')throw new Error('CURSOR_ACK_CAPABILITY_ALREADY_USED');
    if(!cursorStore||typeof cursorStore.recordStagedCursor!=='function')
      throw new Error('CURSOR_ACK_STORE_REQUIRED');
    this.#state='RECORDING';
    let result;
    try{result=await cursorStore.recordStagedCursor({cursor:this.#cursor,proof:this.#proof,...this.#summary});}
    catch{this.#state='UNCERTAIN';throw new Error('CURSOR_ACK_OUTCOME_UNCERTAIN');}
    if(result?.recorded!==true){this.#state='REFUSED';throw new Error('CURSOR_ACK_NOT_RECORDED');}
    this.#state='RECORDED';
    return {recorded:true,proof:this.#proof};
  }
}

export async function stageBatchImages({batch,accountId,allowedPeer,receiptStore,downloadAndDecrypt}={}){
  if(!receiptStore||typeof receiptStore.ingest!=='function'||typeof receiptStore.getReceipt!=='function')
    throw new Error('IMAGE_RECEIPT_STORE_REQUIRED');
  if(typeof downloadAndDecrypt!=='function')throw new Error('IMAGE_DOWNLOADER_REQUIRED');
  let policy;
  try{policy=new AllowlistPolicy({accountId,allowedPeers:[allowedPeer]});}
  catch(error){throw new Error(safeFailure(error,'IMAGE_BATCH_CONFIGURATION_INVALID'));}
  if(!batch||!Array.isArray(batch.messages)||batch.messages.length>MAX_BATCH_MESSAGES)
    return failureResult(new BatchRejection('IMAGE_BATCH_INVALID'));
  if(!cursorValid(batch.nextCursor))return failureResult(new BatchRejection('IMAGE_BATCH_CURSOR_INVALID'));

  const candidates=[];
  const seen=new Map();
  let ignoredCount=0,duplicateCount=0;
  try{
    // Match RealWeixinTransport's peer boundary for other senders: they are
    // external noise and never enter storage or invoke the media downloader.
    // An envelope claiming to be from the allowed peer is stricter: malformed,
    // outbound, group, wrong-target or nonterminal content blocks the cursor.
    for(let index=0;index<batch.messages.length;index++){
      const raw=batch.messages[index];
      if(raw?.from_user_id!==allowedPeer.userId){
        ignoredCount++;continue;
      }
      const envelopeRejection=directEnvelopeRejection(raw,accountId);
      if(envelopeRejection!==null)
        reject('IMAGE_BATCH_ENVELOPE_'+envelopeRejection.toUpperCase(),{index});
      if(canonicalDirectChatId(raw.from_user_id)!==allowedPeer.chatId)
        reject('IMAGE_BATCH_PEER_NOT_AUTHORIZED',{index});
      const candidate=validateAllowedImage(raw,index,accountId,policy);
      const prior=seen.get(candidate.messageId);
      if(prior){
        if(prior.fingerprint!==candidate.fingerprint)
          reject('IMAGE_BATCH_DUPLICATE_ID_CONFLICT',{index,messageId:candidate.messageId});
        duplicateCount++;continue;
      }
      seen.set(candidate.messageId,candidate);
      candidates.push(candidate);
    }
  }catch(error){return failureResult(error,{ignoredCount,duplicateCount});}

  const stagedReceipts=[];
  for(const candidate of candidates){
    let existing;
    try{existing=receiptStore.getReceipt(candidate.identity);}
    catch(error){
      return failureResult(new BatchRejection(safeFailure(error,'IMAGE_BATCH_RECEIPT_FAILED'),{
        index:candidate.index,messageId:candidate.messageId
      }),{stagedReceipts,ignoredCount,duplicateCount});
    }
    if(existing&&existing.status!=='RECEIVED'){
      // CLAIMED means bytes may have left the encrypted receipt DB, but a
      // downstream upload is NOT durably confirmed. Never ack from it alone.
      const code=existing.status==='CLAIMED'
        ? 'IMAGE_RECEIPT_CLAIMED_REQUIRES_REVIEW' : 'IMAGE_RECEIPT_TERMINAL_NOT_ACKABLE';
      return failureResult(new BatchRejection(code,{
        index:candidate.index,messageId:candidate.messageId,receipt:existing
      }),{stagedReceipts,ignoredCount,duplicateCount});
    }
    let image;
    try{image=await downloadAndDecrypt(candidate.raw,{...candidate.identity});}
    catch(error){
      return failureResult(new BatchRejection(safeFailure(error,'IMAGE_BATCH_DOWNLOAD_FAILED'),{
        index:candidate.index,messageId:candidate.messageId
      }),{stagedReceipts,ignoredCount,duplicateCount});
    }
    let stored;
    try{stored=receiptStore.ingest({...candidate.identity,...image});}
    catch(error){
      return failureResult(new BatchRejection(safeFailure(error,'IMAGE_BATCH_RECEIPT_FAILED'),{
        index:candidate.index,messageId:candidate.messageId
      }),{stagedReceipts,ignoredCount,duplicateCount});
    }
    if(stored.receipt.status!=='RECEIVED'){
      return failureResult(new BatchRejection('IMAGE_RECEIPT_NOT_ACKABLE',{
        index:candidate.index,messageId:candidate.messageId,receipt:stored.receipt
      }),{stagedReceipts,ignoredCount,duplicateCount});
    }
    stagedReceipts.push({receipt:stored.receipt,handle:stored.handle,created:stored.created});
  }

  const proof=proofFor(batch.nextCursor,stagedReceipts,ignoredCount,duplicateCount);
  const summary={receiptCount:stagedReceipts.length,ignoredCount,duplicateCount};
  return {readyForCursorAcknowledgement:true,failure:null,stagedReceipts,ignoredCount,duplicateCount,
    acknowledgement:new CursorAcknowledgement({cursor:batch.nextCursor,proof,summary})};
}
