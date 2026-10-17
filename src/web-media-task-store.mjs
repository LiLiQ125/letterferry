import {createCipheriv,createDecipheriv,createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const ID=/^[A-Za-z0-9@._:-]{1,256}$/;
const OPAQUE=/^[A-Za-z0-9_-]{8,256}$/;
const HANDLE=/^[A-Za-z0-9_-]{43}$/;
const DIGEST=/^[0-9a-f]{64}$/;
const MIME=new Set(['image/jpeg','image/png','image/gif','image/webp']);
const MAX_BYTES=12*1024*1024;
const ACTIVE=new Set(['CLAIMING','CLAIMED_RESPONSE_UNKNOWN','HTTP_RESPONSE_FINISHED_NOT_UPLOAD_PROOF','PREVIEW_VERIFIED_EXPERIMENTAL']);

function fail(code){const error=new Error(code);error.mediaTaskCode=code;throw error;}
function hash(value){return createHash('sha256').update(value).digest('hex');}
function validUrl(value){
  try{const url=new URL(value);return url.protocol==='https:'&&url.hostname==='chatgpt.com'&&
    !url.username&&!url.password&&!url.search&&!url.hash&&
    /^(?:\/c\/|\/g\/[^/]+\/c\/)[0-9a-f-]{36}\/?$/i.test(url.pathname);}catch{return false;}
}
function exact(value,keys,code='MEDIA_TASK_PACKET_INVALID'){
  if(!value||typeof value!=='object'||Array.isArray(value))fail(code);
  const actual=Object.keys(value).sort(),expected=[...keys].sort();
  if(actual.length!==expected.length||actual.some((key,index)=>key!==expected[index]))fail(code);
}
function publicTask(row){
  if(!row)return null;
  return {taskId:row.task_id,eventId:row.event_id,accountId:row.account_id,fromUserId:row.sender_id,
    chatId:row.chat_id,messageId:row.message_id,receiptId:row.receipt_id,digest:row.digest_hex,
    mimeType:row.mime_type,size:row.size_bytes,fileName:row.file_name,boundTabId:row.bound_tab_id,
    boundUrl:row.bound_url,browserSessionId:row.browser_session_id,status:row.status,
    createdMs:row.created_ms,updatedMs:row.updated_ms,lastError:row.last_error??null,
    authority:'EXPERIMENTAL_LOCAL_MEDIA_TASK',uploadProven:false,modelReceiptProven:false,
    cursorEligible:false,automaticRetryAllowed:false};
}
function aad(row){return Buffer.from(JSON.stringify({v:1,taskId:row.task_id,eventId:row.event_id,
  receiptId:row.receipt_id,digest:row.digest_hex,boundTabId:row.bound_tab_id,boundUrl:row.bound_url}));}

export class WebMediaTaskStore{
  constructor({filename,secretKey,accountId,allowedPeer,boundTabId,boundUrl,browserSessionId,now=()=>Date.now()}={}){
    if(typeof filename!=='string'||!filename.trim())fail('MEDIA_TASK_FILENAME_REQUIRED');
    if(!(secretKey instanceof Uint8Array)||secretKey.byteLength!==32)fail('MEDIA_TASK_KEY_REQUIRED_32_BYTES');
    if(!ID.test(accountId||'')||!allowedPeer||!ID.test(allowedPeer.userId||'')||allowedPeer.chatId!==allowedPeer.userId)
      fail('MEDIA_TASK_IDENTITY_INVALID');
    if(!Number.isSafeInteger(boundTabId)||boundTabId<1||!validUrl(boundUrl)||!OPAQUE.test(browserSessionId||''))
      fail('MEDIA_TASK_BROWSER_BINDING_INVALID');
    this.accountId=accountId;this.allowedPeer=allowedPeer;this.boundTabId=boundTabId;
    this.boundUrl=boundUrl;this.browserSessionId=browserSessionId;this.now=now;
    this.key=Buffer.from(secretKey);
    mkdirSync(dirname(filename),{recursive:true});
    this.db=new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS web_media_tasks(
        task_id TEXT PRIMARY KEY,event_id TEXT UNIQUE NOT NULL,nonce_hash TEXT UNIQUE NOT NULL,
        account_id TEXT NOT NULL,sender_id TEXT NOT NULL,chat_id TEXT NOT NULL,message_id TEXT NOT NULL,
        receipt_id TEXT UNIQUE NOT NULL,digest_hex TEXT NOT NULL,mime_type TEXT NOT NULL,size_bytes INTEGER NOT NULL,
        file_name TEXT NOT NULL,bound_tab_id INTEGER NOT NULL,bound_url TEXT NOT NULL,browser_session_id TEXT NOT NULL,
        handle_nonce BLOB NOT NULL,handle_ciphertext BLOB NOT NULL,handle_tag BLOB NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('QUEUED','CLAIMING','CLAIMED_RESPONSE_UNKNOWN',
          'HTTP_RESPONSE_FINISHED_NOT_UPLOAD_PROOF','PREVIEW_VERIFIED_EXPERIMENTAL','DELIVERY_UNKNOWN','REVIEWED_NO_REPLAY')),
        active_slot INTEGER,created_ms INTEGER NOT NULL,updated_ms INTEGER NOT NULL,last_error TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS web_media_single_inflight ON web_media_tasks(active_slot) WHERE active_slot=1;
      CREATE INDEX IF NOT EXISTS web_media_status ON web_media_tasks(status,created_ms);`);
    const ms=this.#time();
    this.db.prepare(`UPDATE web_media_tasks SET status='DELIVERY_UNKNOWN',active_slot=NULL,updated_ms=?,
      last_error='MEDIA_TASK_RESTART_UNCERTAIN' WHERE status IN ('CLAIMING','CLAIMED_RESPONSE_UNKNOWN',
        'HTTP_RESPONSE_FINISHED_NOT_UPLOAD_PROOF','PREVIEW_VERIFIED_EXPERIMENTAL')`).run(ms);
  }
  #time(){const ms=this.now();if(!Number.isSafeInteger(ms)||ms<0)fail('MEDIA_TASK_CLOCK_INVALID');return ms;}
  #tx(work){this.db.exec('BEGIN IMMEDIATE');try{const value=work();this.db.exec('COMMIT');return value;}
    catch(error){try{this.db.exec('ROLLBACK');}catch{}if(error?.mediaTaskCode)throw error;fail('MEDIA_TASK_STORAGE_FAILED');}}
  #row(id){if(!OPAQUE.test(id||''))fail('MEDIA_TASK_ID_INVALID');const row=this.db.prepare('SELECT * FROM web_media_tasks WHERE task_id=?').get(id);
    if(!row)fail('MEDIA_TASK_NOT_FOUND');return row;}
  #bound(packet){
    exact(packet,['taskId','taskNonce','accountId','fromUserId','chatId','eventId','receiptId','digest','tabId','boundUrl','browserSessionId']);
    const row=this.#row(packet.taskId);
    const supplied=Buffer.from(hash(typeof packet.taskNonce==='string'?packet.taskNonce:''),'hex');
    const expected=Buffer.from(row.nonce_hash,'hex');
    if(typeof packet.taskNonce!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(packet.taskNonce)||
      supplied.length!==expected.length||!timingSafeEqual(supplied,expected))
      fail('MEDIA_TASK_NONCE_INVALID');
    if(packet.accountId!==row.account_id||packet.fromUserId!==row.sender_id||packet.chatId!==row.chat_id)
      fail('MEDIA_TASK_IDENTITY_MISMATCH');
    if(packet.eventId!==row.event_id||packet.receiptId!==row.receipt_id||packet.digest!==row.digest_hex)
      fail('MEDIA_TASK_EVENT_MISMATCH');
    if(packet.tabId!==row.bound_tab_id||packet.boundUrl!==row.bound_url||packet.browserSessionId!==row.browser_session_id)
      fail('MEDIA_TASK_BROWSER_BINDING_MISMATCH');
    return row;
  }
  create(value){
    exact(value,['eventId','accountId','fromUserId','chatId','messageId','receiptId','digest','mimeType','size','fileName','handle']);
    if(value.accountId!==this.accountId||value.fromUserId!==this.allowedPeer.userId||value.chatId!==this.allowedPeer.chatId)
      fail('MEDIA_TASK_UNAUTHORIZED');
    if(!ID.test(value.messageId||'')||!OPAQUE.test(value.eventId||'')||!OPAQUE.test(value.receiptId||'')||
      !DIGEST.test(value.digest||'')||!MIME.has(value.mimeType)||!Number.isSafeInteger(value.size)||value.size<1||
      value.size>MAX_BYTES||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value.fileName||'')||!HANDLE.test(value.handle||''))
      fail('MEDIA_TASK_INPUT_INVALID');
    const existing=this.db.prepare('SELECT * FROM web_media_tasks WHERE event_id=?').get(value.eventId);
    if(existing){
      const same=existing.account_id===value.accountId&&existing.sender_id===value.fromUserId&&existing.chat_id===value.chatId&&
        existing.message_id===value.messageId&&existing.receipt_id===value.receiptId&&existing.digest_hex===value.digest&&
        existing.mime_type===value.mimeType&&existing.size_bytes===value.size&&existing.file_name===value.fileName;
      if(!same)fail('MEDIA_TASK_IDEMPOTENCY_CONFLICT');
      return {created:false,task:publicTask(existing),taskNonce:null};
    }
    const ms=this.#time(),taskId=randomBytes(24).toString('base64url'),taskNonce=randomBytes(32).toString('base64url');
    const row={task_id:taskId,event_id:value.eventId,receipt_id:value.receiptId,digest_hex:value.digest,
      bound_tab_id:this.boundTabId,bound_url:this.boundUrl};
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,nonce);cipher.setAAD(aad(row));
    const encrypted=Buffer.concat([cipher.update(value.handle,'utf8'),cipher.final()]),tag=cipher.getAuthTag();
    return this.#tx(()=>{
      this.db.prepare(`INSERT INTO web_media_tasks
        (task_id,event_id,nonce_hash,account_id,sender_id,chat_id,message_id,receipt_id,digest_hex,mime_type,
         size_bytes,file_name,bound_tab_id,bound_url,browser_session_id,handle_nonce,handle_ciphertext,handle_tag,
         status,active_slot,created_ms,updated_ms,last_error)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'QUEUED',NULL,?,?,NULL)`).run(
        taskId,value.eventId,hash(taskNonce),value.accountId,value.fromUserId,value.chatId,value.messageId,value.receiptId,
        value.digest,value.mimeType,value.size,value.fileName,this.boundTabId,this.boundUrl,this.browserSessionId,
        nonce,encrypted,tag,ms,ms);
      return {created:true,task:publicTask(this.#row(taskId)),taskNonce};
    });
  }
  beginClaim(packet){
    return this.#tx(()=>{const row=this.#bound(packet);if(row.status!=='QUEUED')fail('MEDIA_TASK_NOT_CLAIMABLE');
      // A prior media handoff may already have caused irreversible browser effects.
      // Do not claim even a *different* task until manual review resolves it.
      const unresolved=this.db.prepare(`SELECT COUNT(*) AS n FROM web_media_tasks WHERE status IN
        ('CLAIMING','CLAIMED_RESPONSE_UNKNOWN','HTTP_RESPONSE_FINISHED_NOT_UPLOAD_PROOF',
         'PREVIEW_VERIFIED_EXPERIMENTAL','DELIVERY_UNKNOWN')`).get().n;
      if(unresolved)fail('MEDIA_TASK_UNRESOLVED_REQUIRES_REVIEW');
      try{this.db.prepare("UPDATE web_media_tasks SET status='CLAIMING',active_slot=1,updated_ms=? WHERE task_id=? AND status='QUEUED'").run(this.#time(),row.task_id);}
      catch{fail('MEDIA_TASK_INFLIGHT_CONFLICT');}
      let handle;try{const decipher=createDecipheriv('aes-256-gcm',this.key,row.handle_nonce);decipher.setAAD(aad(row));decipher.setAuthTag(row.handle_tag);
        handle=Buffer.concat([decipher.update(row.handle_ciphertext),decipher.final()]).toString('utf8');}catch{fail('MEDIA_TASK_HANDLE_DECRYPT_FAILED');}
      if(!HANDLE.test(handle))fail('MEDIA_TASK_HANDLE_INVALID');
      return {task:publicTask(this.#row(row.task_id)),handle};});
  }
  recordClaimed(taskId,receipt){
    return this.#tx(()=>{const row=this.#row(taskId);if(row.status!=='CLAIMING')fail('MEDIA_TASK_STATE_CONFLICT');
      if(receipt?.id!==row.receipt_id||receipt?.messageId!==row.message_id||receipt?.digest!==row.digest_hex||
        receipt?.mimeType!==row.mime_type||receipt?.size!==row.size_bytes||receipt?.fileName!==row.file_name||receipt?.status!=='CLAIMED')
        fail('MEDIA_TASK_RECEIPT_MISMATCH');
      this.db.prepare("UPDATE web_media_tasks SET status='CLAIMED_RESPONSE_UNKNOWN',updated_ms=? WHERE task_id=? AND status='CLAIMING'").run(this.#time(),taskId);
      return publicTask(this.#row(taskId));});
  }
  recordHttpFinished(taskId){return this.#tx(()=>{
    const row=this.#row(taskId);
    if(row.status!=='CLAIMED_RESPONSE_UNKNOWN')fail('MEDIA_TASK_STATE_CONFLICT');
    this.db.prepare(`UPDATE web_media_tasks SET status='HTTP_RESPONSE_FINISHED_NOT_UPLOAD_PROOF',
      updated_ms=? WHERE task_id=? AND status='CLAIMED_RESPONSE_UNKNOWN'`).run(this.#time(),taskId);
    // Keep the exclusive slot: HTTP 200 is NOT durable browser upload proof.
    return publicTask(this.#row(taskId));
  });}
  recordUnknown(taskId,code='MEDIA_TASK_DELIVERY_UNKNOWN'){
    if(!/^[A-Z][A-Z0-9_]{2,80}$/.test(code))fail('MEDIA_TASK_ERROR_CODE_INVALID');
    return this.#tx(()=>{const row=this.#row(taskId);if(!ACTIVE.has(row.status))fail('MEDIA_TASK_STATE_CONFLICT');
      this.db.prepare("UPDATE web_media_tasks SET status='DELIVERY_UNKNOWN',active_slot=NULL,updated_ms=?,last_error=? WHERE task_id=? AND status=?")
        .run(this.#time(),code,taskId,row.status);return publicTask(this.#row(taskId));});
  }
  recordPreview(packet){
    exact(packet,['binding','evidence']);
    return this.#tx(()=>{const row=this.#bound(packet.binding);if(row.status!=='HTTP_RESPONSE_FINISHED_NOT_UPLOAD_PROOF')fail('MEDIA_TASK_STATE_CONFLICT');
      exact(packet.evidence,['inputLabel','previewChecks','readyForSubmit','sendClicked','mimeType','size','fileName']);
      if(packet.evidence.inputLabel!=='\u6dfb\u52a0\u7167\u7247'||packet.evidence.previewChecks!==2||
        packet.evidence.readyForSubmit!==true||packet.evidence.sendClicked!==false||packet.evidence.mimeType!==row.mime_type||
        packet.evidence.size!==row.size_bytes||packet.evidence.fileName!==row.file_name)fail('MEDIA_TASK_PREVIEW_EVIDENCE_INVALID');
      this.db.prepare("UPDATE web_media_tasks SET status='PREVIEW_VERIFIED_EXPERIMENTAL',updated_ms=? WHERE task_id=? AND status='HTTP_RESPONSE_FINISHED_NOT_UPLOAD_PROOF'")
        .run(this.#time(),row.task_id);return publicTask(this.#row(row.task_id));});
  }
  #move(taskId,from,to,error){return this.#tx(()=>{this.#row(taskId);const changed=this.db.prepare(
    'UPDATE web_media_tasks SET status=?,active_slot=NULL,updated_ms=?,last_error=? WHERE task_id=? AND status=?')
    .run(to,this.#time(),error,taskId,from);if(changed.changes!==1)fail('MEDIA_TASK_STATE_CONFLICT');return publicTask(this.#row(taskId));});}
  reviewUnknownWithoutReplay(taskId){return this.#tx(()=>{
    const row=this.#row(taskId);
    if(row.status!=='DELIVERY_UNKNOWN')fail('MEDIA_TASK_NOT_REVIEWABLE');
    const changed=this.db.prepare(`UPDATE web_media_tasks SET status='REVIEWED_NO_REPLAY',active_slot=NULL,
      updated_ms=? WHERE task_id=? AND status='DELIVERY_UNKNOWN'`).run(this.#time(),taskId);
    if(changed.changes!==1)fail('MEDIA_TASK_STATE_CONFLICT');
    return publicTask(this.#row(taskId));
  });}
  get(taskId){return publicTask(this.#row(taskId));}
  list(){return this.db.prepare('SELECT * FROM web_media_tasks ORDER BY created_ms,rowid').all().map(publicTask);}
  close(){this.db.close();this.key.fill(0);}
}

export const webMediaTaskLimits=Object.freeze({maxBytes:MAX_BYTES,preferredInputLabel:'\u6dfb\u52a0\u7167\u7247'});
