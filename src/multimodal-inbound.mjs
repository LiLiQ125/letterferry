import {createHash} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {AllowlistPolicy,canonicalDirectChatId,directEnvelopeRejection,normalizeInbound} from './policy.mjs';
import {decodeImageAesKey,imageCdnUrl,pickInboundImage} from './media-inbound-image.mjs';
import {seal,unseal} from './secrets.mjs';

const ID=/^[A-Za-z0-9@._:-]{1,256}$/;
const MAX_CURSOR_LENGTH=16_384;
const MAX_BATCH_MESSAGES=100;

function digest(value){return createHash('sha256').update(value).digest('hex');}
function safeCode(error,fallback='MULTIMODAL_STAGE_FAILED'){
  const value=error instanceof Error?error.message:String(error);
  return /^[A-Z][A-Z0-9_]{2,120}$/.test(value)?value:fallback;
}
function fail(code){const error=new Error(code);error.multimodalCode=code;throw error;}
function validCursor(value){return typeof value==='string'&&value.length>0&&value.length<=MAX_CURSOR_LENGTH&&
  !/[\u0000-\u001f\u007f]/.test(value);}
function validId(value){return typeof value==='string'&&ID.test(value);}
function rawDigest(raw){
  try{return digest(JSON.stringify(raw));}catch{fail('MULTIMODAL_MESSAGE_NOT_SERIALIZABLE');}
}
function uniqueMessageId(raw){
  const values=[raw?.message_id,...(Array.isArray(raw?.item_list)?raw.item_list.map(item=>item?.msg_id):[])]
    .filter(value=>value!==undefined&&value!==null);
  if(values.length===0)fail('MULTIMODAL_MESSAGE_ID_REQUIRED');
  const ids=values.map(value=>{
    if(typeof value!=='string'||!validId(value.trim()))fail('MULTIMODAL_MESSAGE_ID_INVALID');
    return value.trim();
  });
  if(new Set(ids).size!==1)fail('MULTIMODAL_MESSAGE_ID_CONFLICT');
  return ids[0];
}
function publicBatch(row){
  if(!row)return null;
  return {batchKey:row.batch_key,status:row.status,textCount:row.text_count,imageCount:row.image_count,
    ignoredCount:row.ignored_count,duplicateCount:row.duplicate_count,createdMs:row.created_ms,
    updatedMs:row.updated_ms,lastError:row.last_error??null,cursorEligible:row.status==='READY',
    automaticRetryAllowed:row.status==='STAGING'};
}

export class MultimodalBatchJournal{
  constructor({filename,accountId,allowedPeer,now=()=>Date.now()}={}){
    if(typeof filename!=='string'||!filename.trim())fail('MULTIMODAL_JOURNAL_FILENAME_REQUIRED');
    if(!validId(accountId)||!allowedPeer||!validId(allowedPeer.userId)||allowedPeer.chatId!==allowedPeer.userId)
      fail('MULTIMODAL_JOURNAL_BINDING_INVALID');
    this.accountId=accountId;this.peer=allowedPeer.userId;this.now=now;
    mkdirSync(dirname(filename),{recursive:true});
    this.db=new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS multimodal_batches(
        batch_key TEXT PRIMARY KEY,cursor_digest TEXT UNIQUE NOT NULL,manifest_digest TEXT NOT NULL,
        account_id TEXT NOT NULL,peer_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('STAGING','READY','CURSOR_RECORDING','CURSOR_RECORDED','CURSOR_UNCERTAIN')),
        text_count INTEGER NOT NULL,image_count INTEGER NOT NULL,ignored_count INTEGER NOT NULL,
        duplicate_count INTEGER NOT NULL,created_ms INTEGER NOT NULL,updated_ms INTEGER NOT NULL,last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS multimodal_batch_events(
        batch_key TEXT NOT NULL REFERENCES multimodal_batches(batch_key),event_index INTEGER NOT NULL,
        message_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('TEXT','IMAGE')),
        fingerprint TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('PENDING','DURABLE')),
        durable_ref TEXT,durable_digest TEXT,
        PRIMARY KEY(batch_key,message_id),UNIQUE(batch_key,event_index)
      );
      CREATE INDEX IF NOT EXISTS multimodal_batch_status ON multimodal_batches(status,created_ms);`);
    const ms=this.#time();
    this.db.prepare(`UPDATE multimodal_batches SET status='CURSOR_UNCERTAIN',updated_ms=?,
      last_error='MULTIMODAL_CURSOR_RESTART_UNCERTAIN' WHERE status='CURSOR_RECORDING'`).run(ms);
  }
  #time(){const value=this.now();if(!Number.isSafeInteger(value)||value<0)fail('MULTIMODAL_CLOCK_INVALID');return value;}
  #transaction(work){
    this.db.exec('BEGIN IMMEDIATE');
    try{const result=work();this.db.exec('COMMIT');return result;}
    catch(error){try{this.db.exec('ROLLBACK');}catch{}if(error?.multimodalCode)throw error;fail('MULTIMODAL_JOURNAL_STORAGE_FAILED');}
  }
  begin(manifest){
    const ms=this.#time();
    return this.#transaction(()=>{
      const cursorDigest=digest(manifest.cursor);
      const byCursor=this.db.prepare('SELECT * FROM multimodal_batches WHERE cursor_digest=?').get(cursorDigest);
      if(byCursor){
        if(byCursor.batch_key!==manifest.batchKey||byCursor.manifest_digest!==manifest.manifestDigest||
          byCursor.account_id!==this.accountId||byCursor.peer_id!==this.peer)
          fail('MULTIMODAL_BATCH_CONFLICT');
        return publicBatch(byCursor);
      }
      this.db.prepare(`INSERT INTO multimodal_batches(batch_key,cursor_digest,manifest_digest,account_id,peer_id,status,
        text_count,image_count,ignored_count,duplicate_count,created_ms,updated_ms)
        VALUES (?,?,?,?,?,'STAGING',?,?,?,?,?,?)`).run(manifest.batchKey,cursorDigest,manifest.manifestDigest,
          this.accountId,this.peer,manifest.textCount,manifest.imageCount,manifest.ignoredCount,
          manifest.duplicateCount,ms,ms);
      const insert=this.db.prepare(`INSERT INTO multimodal_batch_events
        (batch_key,event_index,message_id,kind,fingerprint,status) VALUES (?,?,?,?,?,'PENDING')`);
      for(const event of manifest.events)insert.run(manifest.batchKey,event.index,event.messageId,event.kind,event.fingerprint);
      return publicBatch(this.db.prepare('SELECT * FROM multimodal_batches WHERE batch_key=?').get(manifest.batchKey));
    });
  }
  event(batchKey,messageId){
    return this.db.prepare(`SELECT event_index AS eventIndex,message_id AS messageId,kind,fingerprint,status,
      durable_ref AS durableRef,durable_digest AS durableDigest FROM multimodal_batch_events
      WHERE batch_key=? AND message_id=?`).get(batchKey,messageId)||null;
  }
  markDurable(batchKey,messageId,{durableRef,durableDigest}){
    if(!validId(durableRef)||typeof durableDigest!=='string'||!/^[0-9a-f]{64}$/.test(durableDigest))
      fail('MULTIMODAL_DURABLE_PROOF_INVALID');
    const ms=this.#time();
    return this.#transaction(()=>{
      const batch=this.db.prepare('SELECT status FROM multimodal_batches WHERE batch_key=?').get(batchKey);
      if(!batch||batch.status!=='STAGING')fail('MULTIMODAL_BATCH_NOT_STAGING');
      const prior=this.event(batchKey,messageId);
      if(!prior)fail('MULTIMODAL_EVENT_NOT_FOUND');
      if(prior.status==='DURABLE'){
        if(prior.durableRef!==durableRef||prior.durableDigest!==durableDigest)fail('MULTIMODAL_DURABLE_PROOF_CONFLICT');
        return prior;
      }
      const changed=this.db.prepare(`UPDATE multimodal_batch_events SET status='DURABLE',durable_ref=?,durable_digest=?
        WHERE batch_key=? AND message_id=? AND status='PENDING'`).run(durableRef,durableDigest,batchKey,messageId);
      if(changed.changes!==1)fail('MULTIMODAL_DURABLE_PROOF_CONFLICT');
      this.db.prepare('UPDATE multimodal_batches SET updated_ms=?,last_error=NULL WHERE batch_key=?').run(ms,batchKey);
      return this.event(batchKey,messageId);
    });
  }
  markReady(batchKey){
    const ms=this.#time();
    return this.#transaction(()=>{
      const row=this.db.prepare('SELECT * FROM multimodal_batches WHERE batch_key=?').get(batchKey);
      if(!row)fail('MULTIMODAL_BATCH_NOT_FOUND');
      if(row.status==='READY'||row.status==='CURSOR_RECORDED')return publicBatch(row);
      if(row.status!=='STAGING')fail('MULTIMODAL_BATCH_REQUIRES_REVIEW');
      const pending=this.db.prepare("SELECT COUNT(*) AS n FROM multimodal_batch_events WHERE batch_key=? AND status!='DURABLE'").get(batchKey);
      if(pending.n!==0)fail('MULTIMODAL_BATCH_NOT_DURABLE');
      this.db.prepare("UPDATE multimodal_batches SET status='READY',updated_ms=?,last_error=NULL WHERE batch_key=? AND status='STAGING'")
        .run(ms,batchKey);
      return publicBatch(this.db.prepare('SELECT * FROM multimodal_batches WHERE batch_key=?').get(batchKey));
    });
  }
  get(batchKey){return publicBatch(this.db.prepare('SELECT * FROM multimodal_batches WHERE batch_key=?').get(batchKey));}
  beginCursorRecord(batchKey,cursor){
    const ms=this.#time();
    return this.#transaction(()=>{
      const row=this.db.prepare('SELECT cursor_digest FROM multimodal_batches WHERE batch_key=?').get(batchKey);
      if(!row||row.cursor_digest!==digest(cursor))fail('MULTIMODAL_CURSOR_PROOF_MISMATCH');
      const changed=this.db.prepare("UPDATE multimodal_batches SET status='CURSOR_RECORDING',updated_ms=?,last_error=NULL WHERE batch_key=? AND status='READY'")
        .run(ms,batchKey);
      if(changed.changes!==1)fail('MULTIMODAL_CURSOR_GATE_ALREADY_USED');
      return cursor;
    });
  }
  finishCursorRecord(batchKey){
    const ms=this.#time();
    return this.#transaction(()=>{
      const changed=this.db.prepare("UPDATE multimodal_batches SET status='CURSOR_RECORDED',updated_ms=?,last_error=NULL WHERE batch_key=? AND status='CURSOR_RECORDING'")
        .run(ms,batchKey);
      if(changed.changes!==1)fail('MULTIMODAL_CURSOR_STATE_CONFLICT');
      return this.get(batchKey);
    });
  }
  markCursorUncertain(batchKey,code='MULTIMODAL_CURSOR_OUTCOME_UNCERTAIN'){
    const ms=this.#time(),safe=safeCode(new Error(code),'MULTIMODAL_CURSOR_OUTCOME_UNCERTAIN');
    return this.#transaction(()=>{
      const changed=this.db.prepare("UPDATE multimodal_batches SET status='CURSOR_UNCERTAIN',updated_ms=?,last_error=? WHERE batch_key=? AND status='CURSOR_RECORDING'")
        .run(ms,safe,batchKey);
      if(changed.changes!==1)fail('MULTIMODAL_CURSOR_STATE_CONFLICT');
      return this.get(batchKey);
    });
  }
  close(){this.db.close();}
}

class DurableCursorGate{
  #journal;#batchKey;#cursor;#used=false;
  constructor(journal,batchKey,cursor){this.#journal=journal;this.#batchKey=batchKey;this.#cursor=cursor;}
  async record(cursorStore){
    if(this.#used)throw Error('MULTIMODAL_CURSOR_GATE_ALREADY_USED');
    if(!cursorStore||typeof cursorStore.recordStagedCursor!=='function')throw Error('MULTIMODAL_CURSOR_STORE_REQUIRED');
    this.#used=true;
    const cursor=this.#journal.beginCursorRecord(this.#batchKey,this.#cursor);
    try{
      const result=await cursorStore.recordStagedCursor({cursor,batchKey:this.#batchKey});
      if(result?.recorded!==true)throw Error('MULTIMODAL_CURSOR_NOT_RECORDED');
    }catch(error){
      try{this.#journal.markCursorUncertain(this.#batchKey,safeCode(error,'MULTIMODAL_CURSOR_OUTCOME_UNCERTAIN'));}catch{}
      throw Error('MULTIMODAL_CURSOR_OUTCOME_UNCERTAIN');
    }
    this.#journal.finishCursorRecord(this.#batchKey);
    return {recorded:true,batchKey:this.#batchKey};
  }
}

function analyzeBatch({batch,accountId,allowedPeer,policy}){
  if(!batch||!Array.isArray(batch.messages)||batch.messages.length>MAX_BATCH_MESSAGES)
    fail('MULTIMODAL_BATCH_INVALID');
  if(!validCursor(batch.nextCursor))fail('MULTIMODAL_CURSOR_INVALID');
  const events=[],seen=new Map();let ignoredCount=0,duplicateCount=0;
  for(let index=0;index<batch.messages.length;index++){
    const raw=batch.messages[index];
    if(raw?.from_user_id!==allowedPeer.userId){ignoredCount++;continue;}
    const rejection=directEnvelopeRejection(raw,accountId);
    if(rejection!==null)fail('MULTIMODAL_ENVELOPE_'+rejection.toUpperCase());
    if(raw.message_type!==1||(raw.message_state!==0&&raw.message_state!==2))
      fail('MULTIMODAL_EXPLICIT_INBOUND_TERMINAL_REQUIRED');
    const messageId=uniqueMessageId(raw),fingerprint=rawDigest(raw);
    const prior=seen.get(messageId);
    if(prior){if(prior!==fingerprint)fail('MULTIMODAL_DUPLICATE_ID_CONFLICT');duplicateCount++;continue;}
    seen.set(messageId,fingerprint);
    const identity={accountId,fromUserId:raw.from_user_id,chatId:canonicalDirectChatId(raw.from_user_id),messageId};
    if(!policy.authorize(identity))fail('MULTIMODAL_PEER_NOT_AUTHORIZED');
    if(!Array.isArray(raw.item_list)||raw.item_list.length!==1)fail('MULTIMODAL_EXACTLY_ONE_ITEM_REQUIRED');
    const item=raw.item_list[0];
    if(item?.type===1){
      const update=normalizeInbound(raw,accountId);
      if(update.messageId!==messageId)fail('MULTIMODAL_MESSAGE_ID_CONFLICT');
      events.push({index,messageId,kind:'TEXT',fingerprint,raw,identity,update});
    }else if(item?.type===2){
      const image=pickInboundImage(raw);
      if(!image)fail('MULTIMODAL_IMAGE_STRUCTURE_INVALID');
      decodeImageAesKey(image);imageCdnUrl(image);
      events.push({index,messageId,kind:'IMAGE',fingerprint,raw,identity});
    }else fail('MULTIMODAL_CONTENT_UNSUPPORTED');
  }
  const manifestBody={v:1,accountId,peer:allowedPeer.userId,cursor:batch.nextCursor,ignoredCount,duplicateCount,
    events:events.map(({index,messageId,kind,fingerprint})=>({index,messageId,kind,fingerprint}))};
  const manifestDigest=digest(JSON.stringify(manifestBody));
  return {...manifestBody,candidates:events,cursor:batch.nextCursor,manifestDigest,batchKey:digest('multimodal-batch\0'+manifestDigest),
    textCount:events.filter(event=>event.kind==='TEXT').length,
    imageCount:events.filter(event=>event.kind==='IMAGE').length};
}

function failureResult(error,journalBatch=null){
  return {readyForCursorAcknowledgement:false,acknowledgement:null,batch:journalBatch,
    textEvents:[],imageReceipts:[],failure:{code:safeCode(error)}};
}
function textDigest(update){return digest(JSON.stringify({accountId:update.accountId,fromUserId:update.fromUserId,
  chatId:update.chatId,messageId:update.messageId,text:update.text,contextToken:update.contextToken}));}
function verifyTextRow(textStore,row,update,encryptionKey){
  if(!row||row.account_id!==update.accountId||row.user_id!==update.fromUserId||row.chat_id!==update.chatId||
    row.message_id!==update.messageId||row.text!==update.text)fail('MULTIMODAL_TEXT_IDEMPOTENCY_CONFLICT');
  let token;
  try{token=unseal(row.context_cipher,encryptionKey);}catch{fail('MULTIMODAL_TEXT_CONTEXT_INVALID');}
  if(token!==update.contextToken)fail('MULTIMODAL_TEXT_CONTEXT_CONFLICT');
}

export function createMultimodalInboundCoordinator(options={}){
  if(options.enabled!==true){
    return Object.freeze({enabled:false,
      async stageBatch(){return {enabled:false,readyForCursorAcknowledgement:false,reason:'MULTIMODAL_INBOUND_DISABLED'};},
      async pollAndStageOnce(){return {enabled:false,readyForCursorAcknowledgement:false,reason:'MULTIMODAL_INBOUND_DISABLED'};}});
  }
  const {accountId,allowedPeer,textStore,receiptStore,batchJournal,encryptionKey,pollTransport}=options;
  const imageDownloader=typeof options.imageDownloader==='function'?options.imageDownloader:options.imageDownloader?.download;
  if(!textStore||typeof textStore.ingest!=='function'||typeof textStore.getByInboundKey!=='function'||
    !receiptStore||typeof receiptStore.ingest!=='function'||typeof receiptStore.getReceipt!=='function'||
    !batchJournal||typeof batchJournal.begin!=='function'||typeof imageDownloader!=='function'||
    !(encryptionKey instanceof Uint8Array)||encryptionKey.byteLength!==32)
    fail('MULTIMODAL_COORDINATOR_DEPENDENCIES_REQUIRED');
  const policy=new AllowlistPolicy({accountId,allowedPeers:[allowedPeer]});

  async function stageBatch(batch){
    let manifest,journalBatch;
    try{manifest=analyzeBatch({batch,accountId,allowedPeer,policy});journalBatch=batchJournal.begin(manifest);}
    catch(error){return failureResult(error);}
    if(journalBatch.status==='CURSOR_UNCERTAIN')return failureResult(new Error('MULTIMODAL_CURSOR_REQUIRES_REVIEW'),journalBatch);
    if(journalBatch.status==='CURSOR_RECORDING')return failureResult(new Error('MULTIMODAL_CURSOR_REQUIRES_REVIEW'),journalBatch);
    if(journalBatch.status==='CURSOR_RECORDED')return {readyForCursorAcknowledgement:false,
      acknowledgement:null,batch:journalBatch,textEvents:[],imageReceipts:[],failure:null,alreadyRecorded:true};
    const textEvents=[],imageReceipts=[];
    for(const candidate of manifest.candidates){
      try{
        const proof=batchJournal.event(manifest.batchKey,candidate.messageId);
        if(proof?.status==='DURABLE'){
          if(candidate.kind==='TEXT'){
            const row=textStore.getByInboundKey(`${accountId}:${candidate.messageId}`,true);
            verifyTextRow(textStore,row,candidate.update,encryptionKey);
            if(proof.durableRef!==row.id||proof.durableDigest!==textDigest(candidate.update))
              fail('MULTIMODAL_DURABLE_PROOF_CONFLICT');
            textEvents.push({id:row.id,messageId:candidate.messageId,created:false});
          }else{
            const receipt=receiptStore.getReceipt(candidate.identity);
            if(!receipt||receipt.status!=='RECEIVED'||receipt.id!==proof.durableRef||receipt.digest!==proof.durableDigest)
              fail(receipt?.status==='CLAIMED'?'IMAGE_RECEIPT_CLAIMED_REQUIRES_REVIEW':'MULTIMODAL_DURABLE_PROOF_CONFLICT');
            imageReceipts.push({receipt,handle:null,created:false});
          }
          continue;
        }
        if(candidate.kind==='TEXT'){
          let row=textStore.getByInboundKey(`${accountId}:${candidate.messageId}`,true);
          let created=false;
          if(!row){row=textStore.ingest(candidate.update,seal(candidate.update.contextToken,encryptionKey));created=true;
            row=textStore.getByInboundKey(`${accountId}:${candidate.messageId}`,true);}
          verifyTextRow(textStore,row,candidate.update,encryptionKey);
          batchJournal.markDurable(manifest.batchKey,candidate.messageId,
            {durableRef:row.id,durableDigest:textDigest(candidate.update)});
          textEvents.push({id:row.id,messageId:candidate.messageId,created});
        }else{
          const existing=receiptStore.getReceipt(candidate.identity);
          if(existing&&existing.status!=='RECEIVED')
            fail(existing.status==='CLAIMED'?'IMAGE_RECEIPT_CLAIMED_REQUIRES_REVIEW':'IMAGE_RECEIPT_TERMINAL_NOT_ACKABLE');
          const image=await imageDownloader(candidate.raw,candidate.identity);
          const stored=receiptStore.ingest({...candidate.identity,...image});
          if(stored.receipt.status!=='RECEIVED')fail('IMAGE_RECEIPT_NOT_ACKABLE');
          batchJournal.markDurable(manifest.batchKey,candidate.messageId,
            {durableRef:stored.receipt.id,durableDigest:stored.receipt.digest});
          imageReceipts.push({receipt:stored.receipt,handle:stored.handle,created:stored.created});
        }
      }catch(error){
        return {readyForCursorAcknowledgement:false,acknowledgement:null,batch:batchJournal.get(manifest.batchKey),
          textEvents,imageReceipts,failure:{code:safeCode(error)}};
      }
    }
    try{journalBatch=batchJournal.markReady(manifest.batchKey);}
    catch(error){return failureResult(error,batchJournal.get(manifest.batchKey));}
    return {readyForCursorAcknowledgement:true,failure:null,batch:journalBatch,textEvents,imageReceipts,
      acknowledgement:new DurableCursorGate(batchJournal,manifest.batchKey,manifest.cursor),alreadyRecorded:false};
  }

  return Object.freeze({enabled:true,stageBatch,async pollAndStageOnce(){
    if(!pollTransport||typeof pollTransport.pollBatch!=='function')fail('MULTIMODAL_POLL_TRANSPORT_REQUIRED');
    return stageBatch(await pollTransport.pollBatch());
  }});
}
