import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const ID=/^[A-Za-z0-9@._:-]{1,256}$/;
const OPAQUE_ID=/^[A-Za-z0-9_-]{8,256}$/;
const DIGEST=/^[0-9a-f]{64}$/;
const MIME=new Set(['image/jpeg','image/png','image/gif','image/webp']);
const ACTIVE=new Set(['CLAIM_RECORDED','HTTP_RESPONSE_RECORDED','PREVIEW_RECORDED','SUBMISSION_RECORDED']);
const FINAL='FINAL_ACK_RECORDED_EXPERIMENTAL';
const UNKNOWN='DELIVERY_UNKNOWN';
const REVIEWED='REVIEWED_NO_REPLAY';
const EMPTY_DIGEST=createHash('sha256').update('').digest('hex');
const MAX_BYTES=12*1024*1024;
const MIN_PREVIEW_STABLE_MS=250;
const MIN_ASSISTANT_STABLE_MS=1000;

function failure(code){const error=new Error(code);error.journalCode=code;throw error;}
function hash(value){return createHash('sha256').update(value).digest('hex');}
function validId(value){return typeof value==='string'&&ID.test(value);}
function validOpaque(value){return typeof value==='string'&&OPAQUE_ID.test(value);}
function integer(value){return Number.isSafeInteger(value)&&value>=0;}
function exact(value,keys,code='IMAGE_DELIVERY_EVIDENCE_INVALID'){
  if(!value||typeof value!=='object'||Array.isArray(value))failure(code);
  const actual=Object.keys(value).sort(),expected=[...keys].sort();
  if(actual.length!==expected.length||actual.some((key,index)=>key!==expected[index]))failure(code);
}
function validUrl(value){
  try{
    const url=new URL(value);
    return url.protocol==='https:'&&url.hostname==='chatgpt.com'&&!url.username&&!url.password&&
      !url.hash&&!url.search&&/^(?:\/c\/|\/g\/[^/]+\/c\/)[0-9a-f-]{36}\/?$/i.test(url.pathname);
  }catch{return false;}
}
function checkedTime(value,code='IMAGE_DELIVERY_EVIDENCE_INVALID'){
  if(!integer(value))failure(code);
  return value;
}
function checkedDigest(value,code='IMAGE_DELIVERY_EVIDENCE_INVALID'){
  if(typeof value!=='string'||!DIGEST.test(value))failure(code);
  return value;
}
function checkedName(value){
  if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value))
    failure('IMAGE_DELIVERY_EVIDENCE_INVALID');
  return value;
}
function checkedMetadata(value){
  if(!MIME.has(value.mimeType)||!Number.isSafeInteger(value.size)||value.size<1||value.size>MAX_BYTES)
    failure('IMAGE_DELIVERY_EVIDENCE_INVALID');
  checkedName(value.fileName);
}
function publicAttempt(row){
  if(!row)return null;
  return {
    attemptId:row.attempt_id,accountId:row.account_id,fromUserId:row.sender_id,chatId:row.chat_id,
    messageId:row.message_id,receiptId:row.receipt_id,digest:row.digest_hex,mimeType:row.mime_type,
    size:row.size_bytes,fileName:row.file_name,boundUrl:row.bound_url,browserEventId:row.browser_event_id,
    claimId:row.claim_id,status:row.status,createdMs:row.created_ms,updatedMs:row.updated_ms,
    deadlineMs:row.deadline_ms,lastError:row.last_error??null,
    authority:'EXPERIMENTAL_CALLER_ASSERTED_ONLY',authoritativeDelivery:false,cursorEligible:false,
    automaticRetryAllowed:false
  };
}

export class ImageDeliveryJournal{
  constructor({filename,accountId,allowedPeer,boundUrl,attemptTtlMs,now=()=>Date.now()}={}){
    if(typeof filename!=='string'||!filename.trim())failure('IMAGE_DELIVERY_FILENAME_REQUIRED');
    if(!validId(accountId))failure('IMAGE_DELIVERY_ACCOUNT_INVALID');
    if(!allowedPeer||!validId(allowedPeer.userId)||allowedPeer.chatId!==allowedPeer.userId)
      failure('IMAGE_DELIVERY_PEER_INVALID');
    if(!validUrl(boundUrl))failure('IMAGE_DELIVERY_BOUND_URL_INVALID');
    if(!Number.isSafeInteger(attemptTtlMs)||attemptTtlMs<1000||attemptTtlMs>24*60*60_000)
      failure('IMAGE_DELIVERY_TTL_INVALID');
    this.accountId=accountId;
    this.allowedUserId=allowedPeer.userId;
    this.allowedChatId=allowedPeer.chatId;
    this.boundUrl=boundUrl;
    this.attemptTtlMs=attemptTtlMs;
    this.now=now;
    mkdirSync(dirname(filename),{recursive:true});
    this.db=new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS image_delivery_attempts(
        attempt_id TEXT PRIMARY KEY,
        proof_hash TEXT UNIQUE NOT NULL,
        account_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_id TEXT UNIQUE NOT NULL,
        receipt_id TEXT UNIQUE NOT NULL,
        digest_hex TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        file_name TEXT NOT NULL,
        bound_url TEXT NOT NULL,
        browser_event_id TEXT UNIQUE NOT NULL,
        claim_id TEXT UNIQUE NOT NULL,
        composer_snapshot_id TEXT NOT NULL,
        conversation_snapshot_id TEXT NOT NULL,
        prior_user_turn_id TEXT,
        prior_assistant_turn_id TEXT,
        preview_id TEXT UNIQUE,
        submission_id TEXT UNIQUE,
        user_turn_id TEXT UNIQUE,
        assistant_turn_id TEXT UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('CLAIM_RECORDED','HTTP_RESPONSE_RECORDED','PREVIEW_RECORDED',
          'SUBMISSION_RECORDED','FINAL_ACK_RECORDED_EXPERIMENTAL','DELIVERY_UNKNOWN','REVIEWED_NO_REPLAY')),
        created_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL,
        deadline_ms INTEGER NOT NULL,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS image_delivery_evidence(
        attempt_id TEXT NOT NULL REFERENCES image_delivery_attempts(attempt_id),
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        recorded_ms INTEGER NOT NULL,
        PRIMARY KEY(attempt_id,sequence),
        UNIQUE(attempt_id,kind)
      );
      CREATE INDEX IF NOT EXISTS image_delivery_status ON image_delivery_attempts(status,deadline_ms);`);
    const ms=this.#time();
    this.#transaction(()=>{
      const rows=this.db.prepare(`SELECT attempt_id,status FROM image_delivery_attempts
        WHERE status IN ('CLAIM_RECORDED','HTTP_RESPONSE_RECORDED','PREVIEW_RECORDED','SUBMISSION_RECORDED')`).all();
      for(const row of rows){
        this.db.prepare(`UPDATE image_delivery_attempts SET status=?,updated_ms=?,last_error=?
          WHERE attempt_id=? AND status=?`).run(UNKNOWN,ms,'IMAGE_DELIVERY_RESTART_UNCERTAIN',row.attempt_id,row.status);
        this.#insertEvidence(row.attempt_id,'UNCERTAIN',{reason:'IMAGE_DELIVERY_RESTART_UNCERTAIN',fromStatus:row.status},ms);
      }
    });
  }

  #time(){const ms=this.now();if(!integer(ms))failure('IMAGE_DELIVERY_CLOCK_INVALID');return ms;}
  #transaction(work){
    this.db.exec('BEGIN IMMEDIATE');
    try{const result=work();this.db.exec('COMMIT');return result;}
    catch(error){
      try{this.db.exec('ROLLBACK');}catch{}
      if(error?.journalCode)throw error;
      failure('IMAGE_DELIVERY_STORAGE_FAILED');
    }
  }
  #insertEvidence(attemptId,kind,evidence,ms){
    const prior=this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM image_delivery_evidence WHERE attempt_id=?').get(attemptId);
    this.db.prepare(`INSERT INTO image_delivery_evidence(attempt_id,sequence,kind,evidence_json,recorded_ms)
      VALUES (?,?,?,?,?)`).run(attemptId,prior.n+1,kind,JSON.stringify(evidence),ms);
  }
  #evidence(attemptId,kind){
    const row=this.db.prepare('SELECT evidence_json FROM image_delivery_evidence WHERE attempt_id=? AND kind=?').get(attemptId,kind);
    if(!row)failure('IMAGE_DELIVERY_EVIDENCE_MISSING');
    return JSON.parse(row.evidence_json);
  }
  #row(attemptId){
    if(!validOpaque(attemptId))failure('IMAGE_DELIVERY_ATTEMPT_INVALID');
    const row=this.db.prepare('SELECT * FROM image_delivery_attempts WHERE attempt_id=?').get(attemptId);
    if(!row)failure('IMAGE_DELIVERY_ATTEMPT_NOT_FOUND');
    return row;
  }
  #bound(packet){
    exact(packet,['attemptId','proofNonce','accountId','fromUserId','chatId','messageId','receiptId','digest','boundUrl','browserEventId','evidence']);
    const row=this.#row(packet.attemptId);
    if(typeof packet.proofNonce!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(packet.proofNonce))
      failure('IMAGE_DELIVERY_PROOF_INVALID');
    const supplied=Buffer.from(hash(packet.proofNonce),'hex'),stored=Buffer.from(row.proof_hash,'hex');
    if(supplied.length!==stored.length||!timingSafeEqual(supplied,stored))failure('IMAGE_DELIVERY_PROOF_INVALID');
    if(packet.accountId!==row.account_id||packet.fromUserId!==row.sender_id||packet.chatId!==row.chat_id)
      failure('IMAGE_DELIVERY_IDENTITY_MISMATCH');
    if(packet.messageId!==row.message_id||packet.receiptId!==row.receipt_id||packet.digest!==row.digest_hex||
      packet.browserEventId!==row.browser_event_id)failure('IMAGE_DELIVERY_EVENT_MISMATCH');
    if(packet.boundUrl!==row.bound_url)failure('IMAGE_DELIVERY_CONVERSATION_MISMATCH');
    return row;
  }
  #transition(packet,expected,next,kind,validate,columns={}){
    const ms=this.#time();
    return this.#transaction(()=>{
      const row=this.#bound(packet);
      if(row.status!==expected)failure('IMAGE_DELIVERY_STATE_CONFLICT');
      if(ms>=row.deadline_ms)failure('IMAGE_DELIVERY_ATTEMPT_TIMED_OUT');
      const evidence=validate(packet.evidence,row,ms);
      const assignments=['status=?','updated_ms=?','last_error=NULL'];
      const values=[next,ms];
      for(const [column,value] of Object.entries(columns)){assignments.push(`${column}=?`);values.push(value(evidence));}
      values.push(row.attempt_id,expected);
      const changed=this.db.prepare(`UPDATE image_delivery_attempts SET ${assignments.join(',')}
        WHERE attempt_id=? AND status=?`).run(...values);
      if(changed.changes!==1)failure('IMAGE_DELIVERY_STATE_CONFLICT');
      this.#insertEvidence(row.attempt_id,kind,evidence,ms);
      return publicAttempt(this.db.prepare('SELECT * FROM image_delivery_attempts WHERE attempt_id=?').get(row.attempt_id));
    });
  }

  beginClaim(value){
    exact(value,['accountId','fromUserId','chatId','messageId','receiptId','digest','mimeType','size','fileName',
      'boundUrl','browserEventId','claimEvidence','composerEvidence','conversationEvidence']);
    if(value.accountId!==this.accountId||value.fromUserId!==this.allowedUserId||value.chatId!==this.allowedChatId)
      failure('IMAGE_DELIVERY_UNAUTHORIZED');
    if(!validId(value.messageId)||!validOpaque(value.receiptId)||!DIGEST.test(value.digest)||
      value.boundUrl!==this.boundUrl||!validOpaque(value.browserEventId))failure('IMAGE_DELIVERY_BINDING_INVALID');
    checkedMetadata(value);
    exact(value.claimEvidence,['claimId','claimedMs','receiptStatus']);
    if(!validOpaque(value.claimEvidence.claimId)||value.claimEvidence.receiptStatus!=='CLAIMED')
      failure('IMAGE_DELIVERY_CLAIM_EVIDENCE_INVALID');
    checkedTime(value.claimEvidence.claimedMs,'IMAGE_DELIVERY_CLAIM_EVIDENCE_INVALID');
    exact(value.composerEvidence,['snapshotId','capturedMs','textLength','textDigest']);
    if(!validOpaque(value.composerEvidence.snapshotId)||value.composerEvidence.textLength!==0||
      value.composerEvidence.textDigest!==EMPTY_DIGEST)failure('IMAGE_DELIVERY_HUMAN_DRAFT_PRESENT');
    checkedTime(value.composerEvidence.capturedMs);
    exact(value.conversationEvidence,['snapshotId','capturedMs','lastUserTurnId','lastAssistantTurnId']);
    if(!validOpaque(value.conversationEvidence.snapshotId)||
      (value.conversationEvidence.lastUserTurnId!==null&&!validOpaque(value.conversationEvidence.lastUserTurnId))||
      (value.conversationEvidence.lastAssistantTurnId!==null&&!validOpaque(value.conversationEvidence.lastAssistantTurnId)))
      failure('IMAGE_DELIVERY_CONVERSATION_EVIDENCE_INVALID');
    checkedTime(value.conversationEvidence.capturedMs,'IMAGE_DELIVERY_CONVERSATION_EVIDENCE_INVALID');
    const ms=this.#time(),deadlineMs=ms+this.attemptTtlMs;
    if(!Number.isSafeInteger(deadlineMs)||value.claimEvidence.claimedMs>ms||
      value.composerEvidence.capturedMs>ms||value.conversationEvidence.capturedMs>ms)
      failure('IMAGE_DELIVERY_EVIDENCE_INVALID');
    const attemptId=randomBytes(24).toString('base64url');
    const proofNonce=randomBytes(32).toString('base64url');
    const evidence={claimId:value.claimEvidence.claimId,claimedMs:value.claimEvidence.claimedMs,
      receiptStatus:'CLAIMED',receiptId:value.receiptId,messageId:value.messageId,boundUrl:value.boundUrl,
      browserEventId:value.browserEventId,composerSnapshotId:value.composerEvidence.snapshotId,
      conversationSnapshotId:value.conversationEvidence.snapshotId};
    try{
      return this.#transaction(()=>{
        this.db.prepare(`INSERT INTO image_delivery_attempts(
          attempt_id,proof_hash,account_id,sender_id,chat_id,message_id,receipt_id,digest_hex,mime_type,
          size_bytes,file_name,bound_url,browser_event_id,claim_id,composer_snapshot_id,conversation_snapshot_id,
          prior_user_turn_id,prior_assistant_turn_id,status,created_ms,updated_ms,deadline_ms)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'CLAIM_RECORDED',?,?,?)`).run(
          attemptId,hash(proofNonce),value.accountId,value.fromUserId,value.chatId,value.messageId,value.receiptId,
          value.digest,value.mimeType,value.size,value.fileName,value.boundUrl,value.browserEventId,
          value.claimEvidence.claimId,value.composerEvidence.snapshotId,value.conversationEvidence.snapshotId,
          value.conversationEvidence.lastUserTurnId,value.conversationEvidence.lastAssistantTurnId,ms,ms,deadlineMs);
        this.#insertEvidence(attemptId,'CLAIM',evidence,ms);
        return {attempt:publicAttempt(this.db.prepare('SELECT * FROM image_delivery_attempts WHERE attempt_id=?').get(attemptId)),proofNonce};
      });
    }catch(error){
      if(error.message==='IMAGE_DELIVERY_STORAGE_FAILED')failure('IMAGE_DELIVERY_ATTEMPT_CONFLICT');
      throw error;
    }
  }

  recordHttpResponse(packet){
    return this.#transition(packet,'CLAIM_RECORDED','HTTP_RESPONSE_RECORDED','HTTP_RESPONSE',(e,row,ms)=>{
      exact(e,['httpRequestId','responseEndedMs','receiptId','messageId','boundUrl','browserEventId','mimeType','size','fileName']);
      if(!validOpaque(e.httpRequestId)||e.receiptId!==row.receipt_id||e.messageId!==row.message_id||
        e.boundUrl!==row.bound_url||e.browserEventId!==row.browser_event_id||e.mimeType!==row.mime_type||
        e.size!==row.size_bytes||e.fileName!==row.file_name)failure('IMAGE_DELIVERY_EVIDENCE_MISMATCH');
      checkedTime(e.responseEndedMs);
      const claim=this.#evidence(row.attempt_id,'CLAIM');
      if(e.responseEndedMs<claim.claimedMs||e.responseEndedMs>ms)failure('IMAGE_DELIVERY_EVIDENCE_INVALID');
      return e;
    });
  }

  recordStablePreview(packet){
    return this.#transition(packet,'HTTP_RESPONSE_RECORDED','PREVIEW_RECORDED','PREVIEW',(e,row,ms)=>{
      exact(e,['previewId','firstObservedMs','secondObservedMs','receiptId','messageId','boundUrl','browserEventId',
        'composerSnapshotId','uploadState','mimeType','size','fileName']);
      if(!validOpaque(e.previewId)||e.receiptId!==row.receipt_id||e.messageId!==row.message_id||
        e.boundUrl!==row.bound_url||e.browserEventId!==row.browser_event_id||
        e.composerSnapshotId!==row.composer_snapshot_id||e.uploadState!=='READY_STABLE'||
        e.mimeType!==row.mime_type||e.size!==row.size_bytes||e.fileName!==row.file_name)
        failure('IMAGE_DELIVERY_EVIDENCE_MISMATCH');
      checkedTime(e.firstObservedMs);checkedTime(e.secondObservedMs);
      const response=this.#evidence(row.attempt_id,'HTTP_RESPONSE');
      if(e.firstObservedMs<response.responseEndedMs||e.secondObservedMs>ms||
        e.secondObservedMs-e.firstObservedMs<MIN_PREVIEW_STABLE_MS)failure('IMAGE_DELIVERY_PREVIEW_NOT_STABLE');
      return e;
    },{preview_id:e=>e.previewId});
  }

  recordSubmission(packet){
    return this.#transition(packet,'PREVIEW_RECORDED','SUBMISSION_RECORDED','SUBMISSION',(e,row,ms)=>{
      exact(e,['submissionId','submittedMs','receiptId','messageId','boundUrl','browserEventId','previewId',
        'composerSnapshotId','submitControlId','action']);
      if(!validOpaque(e.submissionId)||!validOpaque(e.submitControlId)||e.action!=='ONE_TIME_IMAGE_SUBMIT'||
        e.receiptId!==row.receipt_id||e.messageId!==row.message_id||e.boundUrl!==row.bound_url||
        e.browserEventId!==row.browser_event_id||e.previewId!==row.preview_id||
        e.composerSnapshotId!==row.composer_snapshot_id)failure('IMAGE_DELIVERY_EVIDENCE_MISMATCH');
      checkedTime(e.submittedMs);
      const preview=this.#evidence(row.attempt_id,'PREVIEW');
      if(e.submittedMs<preview.secondObservedMs||e.submittedMs>ms)failure('IMAGE_DELIVERY_EVIDENCE_INVALID');
      return e;
    },{submission_id:e=>e.submissionId});
  }

  recordFinalAck(packet){
    return this.#transition(packet,'SUBMISSION_RECORDED',FINAL,'FINAL_ACK',(e,row,ms)=>{
      exact(e,['submissionId','receiptId','messageId','boundUrl','browserEventId','userTurnId','userTurnObservedMs',
        'imageReceiptId','assistantTurnId','assistantResponseDigest','assistantFirstObservedMs','assistantSecondObservedMs',
        'responseState']);
      if(e.submissionId!==row.submission_id||e.receiptId!==row.receipt_id||e.imageReceiptId!==row.receipt_id||
        e.messageId!==row.message_id||e.boundUrl!==row.bound_url||e.browserEventId!==row.browser_event_id||
        !validOpaque(e.userTurnId)||!validOpaque(e.assistantTurnId)||e.userTurnId===row.prior_user_turn_id||
        e.assistantTurnId===row.prior_assistant_turn_id||e.responseState!=='STABLE_COMPLETE')
        failure('IMAGE_DELIVERY_EVIDENCE_MISMATCH');
      checkedDigest(e.assistantResponseDigest);checkedTime(e.userTurnObservedMs);
      checkedTime(e.assistantFirstObservedMs);checkedTime(e.assistantSecondObservedMs);
      const submission=this.#evidence(row.attempt_id,'SUBMISSION');
      if(e.userTurnObservedMs<submission.submittedMs||e.assistantFirstObservedMs<e.userTurnObservedMs||
        e.assistantSecondObservedMs>ms||
        e.assistantSecondObservedMs-e.assistantFirstObservedMs<MIN_ASSISTANT_STABLE_MS)
        failure('IMAGE_DELIVERY_FINAL_ACK_NOT_STABLE');
      return e;
    },{user_turn_id:e=>e.userTurnId,assistant_turn_id:e=>e.assistantTurnId});
  }

  recordUnknown(packet){
    const ms=this.#time();
    return this.#transaction(()=>{
      const row=this.#bound(packet);
      exact(packet.evidence,['reason','observedMs','receiptId','messageId','boundUrl','browserEventId']);
      const reasons=new Set(['HTTP_RESPONSE_INTERRUPTED','HTTP_RESPONSE_RESULT_UNKNOWN','BROWSER_ACK_LOST',
        'BROWSER_EXCEPTION','BROWSER_TIMEOUT','CALLER_ABORTED']);
      if(!ACTIVE.has(row.status)||!reasons.has(packet.evidence.reason)||
        packet.evidence.receiptId!==row.receipt_id||packet.evidence.messageId!==row.message_id||
        packet.evidence.boundUrl!==row.bound_url||packet.evidence.browserEventId!==row.browser_event_id)
        failure('IMAGE_DELIVERY_EVIDENCE_MISMATCH');
      checkedTime(packet.evidence.observedMs);
      const changed=this.db.prepare(`UPDATE image_delivery_attempts SET status=?,updated_ms=?,last_error=?
        WHERE attempt_id=? AND status=?`).run(UNKNOWN,ms,packet.evidence.reason,row.attempt_id,row.status);
      if(changed.changes!==1)failure('IMAGE_DELIVERY_STATE_CONFLICT');
      this.#insertEvidence(row.attempt_id,'UNCERTAIN',packet.evidence,ms);
      return publicAttempt(this.db.prepare('SELECT * FROM image_delivery_attempts WHERE attempt_id=?').get(row.attempt_id));
    });
  }

  markTimedOut(){
    const ms=this.#time();
    return this.#transaction(()=>{
      const rows=this.db.prepare(`SELECT attempt_id,status FROM image_delivery_attempts WHERE
        status IN ('CLAIM_RECORDED','HTTP_RESPONSE_RECORDED','PREVIEW_RECORDED','SUBMISSION_RECORDED') AND deadline_ms<=?`).all(ms);
      for(const row of rows){
        this.db.prepare('UPDATE image_delivery_attempts SET status=?,updated_ms=?,last_error=? WHERE attempt_id=? AND status=?')
          .run(UNKNOWN,ms,'IMAGE_DELIVERY_TIMEOUT_UNCERTAIN',row.attempt_id,row.status);
        this.#insertEvidence(row.attempt_id,'UNCERTAIN',{reason:'IMAGE_DELIVERY_TIMEOUT_UNCERTAIN',fromStatus:row.status},ms);
      }
      return rows.length;
    });
  }

  getAttempt(attemptId){return publicAttempt(this.#row(attemptId));}
  listEvidence(attemptId){
    this.#row(attemptId);
    return this.db.prepare(`SELECT sequence,kind,evidence_json,recorded_ms FROM image_delivery_evidence
      WHERE attempt_id=? ORDER BY sequence`).all(attemptId).map(row=>({sequence:row.sequence,kind:row.kind,
        evidence:JSON.parse(row.evidence_json),recordedMs:row.recorded_ms}));
  }
  close(){this.db.close();}
}

export function createExperimentalBrowserAckAdapter(journal){
  if(!journal||typeof journal.recordHttpResponse!=='function'||typeof journal.recordFinalAck!=='function')
    failure('IMAGE_DELIVERY_ADAPTER_INVALID');
  return Object.freeze({
    authority:'EXPERIMENTAL_CALLER_ASSERTED_ONLY',
    recordHttpResponse:packet=>journal.recordHttpResponse(packet),
    recordStablePreview:packet=>journal.recordStablePreview(packet),
    recordSubmission:packet=>journal.recordSubmission(packet),
    recordFinalAck:packet=>journal.recordFinalAck(packet),
    recordUnknown:packet=>journal.recordUnknown(packet)
  });
}
