import {createCipheriv,createDecipheriv,createHash,createHmac,hkdfSync,randomBytes,randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {imageMime,MAX_WEIXIN_IMAGE_BYTES} from './media-inbound-image.mjs';

const ID=/^[A-Za-z0-9@._:-]{1,256}$/;
const MIME_EXTENSIONS=Object.freeze({
  'image/jpeg':new Set(['.jpg','.jpeg']),
  'image/png':new Set(['.png']),
  'image/gif':new Set(['.gif']),
  'image/webp':new Set(['.webp'])
});
const PUBLIC_COLUMNS=`id,inbound_key,account_id,sender_id,chat_id,message_id,digest_hex,
  mime_type,size_bytes,file_name,status,created_ms,updated_ms,expires_ms,claimed_ms,last_error`;
const MAX_TTL_MS=7*24*60*60_000;

function fail(code){throw new Error(code);}
function validId(value){return typeof value==='string'&&ID.test(value);}
function inboundKey(senderId,messageId){return JSON.stringify([senderId,messageId]);}
function hash(value){return createHash('sha256').update(value).digest('hex');}
function safeCode(value){
  if(typeof value!=='string'||!/^[A-Z][A-Z0-9_]{2,80}$/.test(value))fail('IMAGE_FAILURE_CODE_INVALID');
  return value;
}
function publicReceipt(row){
  if(!row)return null;
  return {
    id:row.id,accountId:row.account_id,fromUserId:row.sender_id,chatId:row.chat_id,
    messageId:row.message_id,digest:row.digest_hex,mimeType:row.mime_type,
    size:row.size_bytes,fileName:row.file_name,status:row.status,
    createdMs:row.created_ms,updatedMs:row.updated_ms,expiresMs:row.expires_ms,
    claimedMs:row.claimed_ms??null,lastError:row.last_error??null
  };
}
function checkedImage({bytes,mimeType,fileName}){
  if(!(bytes instanceof Uint8Array))fail('IMAGE_BYTES_INVALID');
  if(bytes.byteLength===0)fail('IMAGE_BYTES_EMPTY');
  if(bytes.byteLength>MAX_WEIXIN_IMAGE_BYTES)fail('IMAGE_TOO_LARGE');
  if(typeof mimeType!=='string'||!MIME_EXTENSIONS[mimeType])fail('IMAGE_MIME_UNSUPPORTED');
  const plain=Buffer.from(bytes);
  let detected;
  try{detected=imageMime(plain);}catch{fail('IMAGE_MIME_UNSUPPORTED');}
  if(detected!==mimeType)fail('IMAGE_MIME_MISMATCH');
  if(typeof fileName!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(fileName))
    fail('IMAGE_FILENAME_INVALID');
  const lower=fileName.toLowerCase();
  if(![...MIME_EXTENSIONS[mimeType]].some(ext=>lower.endsWith(ext)))fail('IMAGE_FILENAME_MISMATCH');
  return {plain,mimeType,fileName,digest:hash(plain)};
}
function aad(row){
  return Buffer.from(JSON.stringify({v:1,id:row.id,accountId:row.account_id,
    senderId:row.sender_id,chatId:row.chat_id,messageId:row.message_id,
    digest:row.digest_hex,mimeType:row.mime_type,size:row.size_bytes,
    fileName:row.file_name,expiresMs:row.expires_ms}),'utf8');
}

export class ImageReceiptStore{
  constructor({filename,secretKey,accountId,allowedPeer,ttlMs,now=()=>Date.now()}={}){
    if(typeof filename!=='string'||!filename.trim())fail('IMAGE_RECEIPT_FILENAME_REQUIRED');
    if(!(secretKey instanceof Uint8Array)||secretKey.byteLength!==32)fail('IMAGE_RECEIPT_KEY_REQUIRED_32_BYTES');
    if(!validId(accountId))fail('INVALID_ACCOUNT_ID');
    if(!allowedPeer||!validId(allowedPeer.userId)||allowedPeer.chatId!==allowedPeer.userId)
      fail('INVALID_ALLOWED_PEER');
    if(!Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>MAX_TTL_MS)fail('IMAGE_RECEIPT_TTL_INVALID');
    this.accountId=accountId;
    this.allowedUserId=allowedPeer.userId;
    this.allowedChatId=allowedPeer.chatId;
    this.ttlMs=ttlMs;
    this.now=now;
    const master=Buffer.from(secretKey);
    const salt=Buffer.from('riven-weixin-image-receipt-v1','utf8');
    this.encryptionKey=Buffer.from(hkdfSync('sha256',master,salt,Buffer.from('aes-256-gcm'),32));
    this.handleKey=Buffer.from(hkdfSync('sha256',master,salt,Buffer.from('one-use-handle'),32));
    master.fill(0);
    mkdirSync(dirname(filename),{recursive:true});
    this.db=new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS image_receipts(
        id TEXT PRIMARY KEY,
        inbound_key TEXT UNIQUE NOT NULL,
        account_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        digest_hex TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        file_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('RECEIVED','CLAIMED','EXPIRED','FAILED')),
        nonce BLOB,
        ciphertext BLOB,
        auth_tag BLOB,
        handle_hash TEXT UNIQUE NOT NULL,
        created_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL,
        expires_ms INTEGER NOT NULL,
        claimed_ms INTEGER,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS image_receipt_status ON image_receipts(status,created_ms);`);
  }

  #authorize(value){
    if(!value||value.accountId!==this.accountId||value.fromUserId!==this.allowedUserId||
      value.chatId!==this.allowedChatId||!validId(value.messageId))fail('IMAGE_SENDER_UNAUTHORIZED');
  }
  #transaction(work){
    this.db.exec('BEGIN IMMEDIATE');
    try{const result=work();this.db.exec('COMMIT');return result;}
    catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
  }
  #time(){
    const ms=this.now();
    if(!Number.isSafeInteger(ms)||ms<0)fail('IMAGE_RECEIPT_CLOCK_INVALID');
    return ms;
  }
  #handle(key,digest){
    return createHmac('sha256',this.handleKey).update('v1\0').update(key).update('\0').update(digest).digest('base64url');
  }
  #getByInbound(key,privateColumns=false){
    return this.db.prepare(`SELECT ${privateColumns?'*':PUBLIC_COLUMNS} FROM image_receipts WHERE inbound_key=?`).get(key);
  }
  #expireDue(ms){
    this.db.prepare(`UPDATE image_receipts SET status='EXPIRED',ciphertext=NULL,nonce=NULL,auth_tag=NULL,
      updated_ms=?,last_error='IMAGE_RECEIPT_EXPIRED'
      WHERE status='RECEIVED' AND expires_ms<=?`).run(ms,ms);
  }
  #result(row,created=false){
    const current=publicReceipt(row);
    return {created,receipt:current,
      handle:row.status==='RECEIVED'?this.#handle(row.inbound_key,row.digest_hex):null};
  }

  ingest(value){
    this.#authorize(value);
    const image=checkedImage(value);
    const key=inboundKey(value.fromUserId,value.messageId);
    const ms=this.#time();
    const expiresMs=ms+this.ttlMs;
    if(!Number.isSafeInteger(expiresMs))fail('IMAGE_RECEIPT_CLOCK_INVALID');
    return this.#transaction(()=>{
      this.#expireDue(ms);
      const prior=this.#getByInbound(key,true);
      if(prior){
        if(prior.account_id!==value.accountId||prior.sender_id!==value.fromUserId||
          prior.chat_id!==value.chatId||prior.message_id!==value.messageId||
          prior.digest_hex!==image.digest||prior.mime_type!==image.mimeType||
          prior.size_bytes!==image.plain.byteLength||prior.file_name!==image.fileName)
          fail('IMAGE_RECEIPT_IDEMPOTENCY_CONFLICT');
        return this.#result(prior,false);
      }
      const row={id:randomUUID(),inbound_key:key,account_id:value.accountId,
        sender_id:value.fromUserId,chat_id:value.chatId,message_id:value.messageId,
        digest_hex:image.digest,mime_type:image.mimeType,size_bytes:image.plain.byteLength,
        file_name:image.fileName,expires_ms:expiresMs};
      const nonce=randomBytes(12);
      const cipher=createCipheriv('aes-256-gcm',this.encryptionKey,nonce);
      cipher.setAAD(aad(row));
      const ciphertext=Buffer.concat([cipher.update(image.plain),cipher.final()]);
      const tag=cipher.getAuthTag();
      const handle=this.#handle(key,image.digest);
      this.db.prepare(`INSERT INTO image_receipts
        (id,inbound_key,account_id,sender_id,chat_id,message_id,digest_hex,mime_type,size_bytes,
         file_name,status,nonce,ciphertext,auth_tag,handle_hash,created_ms,updated_ms,expires_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?,'RECEIVED',?,?,?,?,?,?,?)`)
        .run(row.id,key,row.account_id,row.sender_id,row.chat_id,row.message_id,row.digest_hex,
          row.mime_type,row.size_bytes,row.file_name,nonce,ciphertext,tag,hash(handle),ms,ms,expiresMs);
      return {created:true,receipt:publicReceipt({...row,status:'RECEIVED',created_ms:ms,updated_ms:ms,
        claimed_ms:null,last_error:null}),handle};
    });
  }

  claimOnce(handle){
    if(typeof handle!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(handle))fail('IMAGE_HANDLE_INVALID');
    const ms=this.#time();
    const outcome=this.#transaction(()=>{
      this.#expireDue(ms);
      const row=this.db.prepare('SELECT * FROM image_receipts WHERE handle_hash=?').get(hash(handle));
      if(!row)fail('IMAGE_HANDLE_NOT_FOUND');
      if(row.status==='EXPIRED')return {expired:true};
      if(row.status!=='RECEIVED')fail('IMAGE_HANDLE_NOT_AVAILABLE');
      const changed=this.db.prepare(`UPDATE image_receipts SET status='CLAIMED',claimed_ms=?,updated_ms=?,
        ciphertext=NULL,nonce=NULL,auth_tag=NULL,last_error=NULL WHERE id=? AND status='RECEIVED'`)
        .run(ms,ms,row.id);
      if(changed.changes!==1)fail('IMAGE_HANDLE_CLAIM_CONFLICT');
      let bytes;
      try{
        const decipher=createDecipheriv('aes-256-gcm',this.encryptionKey,row.nonce);
        decipher.setAAD(aad(row));
        decipher.setAuthTag(row.auth_tag);
        bytes=Buffer.concat([decipher.update(row.ciphertext),decipher.final()]);
      }catch{fail('IMAGE_RECEIPT_DECRYPT_FAILED');}
      if(hash(bytes)!==row.digest_hex||bytes.byteLength!==row.size_bytes)fail('IMAGE_RECEIPT_INTEGRITY_FAILED');
      return {bytes,receipt:publicReceipt({...row,status:'CLAIMED',claimed_ms:ms,updated_ms:ms,last_error:null})};
    });
    if(outcome.expired)fail('IMAGE_HANDLE_EXPIRED');
    return outcome;
  }

  archiveFailure(identity,code){
    this.#authorize(identity);
    const error=safeCode(code);
    const key=inboundKey(identity.fromUserId,identity.messageId);
    const ms=this.#time();
    return this.#transaction(()=>{
      this.#expireDue(ms);
      const changed=this.db.prepare(`UPDATE image_receipts SET status='FAILED',ciphertext=NULL,nonce=NULL,
        auth_tag=NULL,updated_ms=?,last_error=? WHERE inbound_key=? AND status IN ('RECEIVED','EXPIRED')`)
        .run(ms,error,key);
      if(changed.changes!==1)fail('IMAGE_RECEIPT_NOT_ARCHIVABLE');
      return publicReceipt(this.#getByInbound(key));
    });
  }

  getReceipt(identity){
    this.#authorize(identity);
    const key=inboundKey(identity.fromUserId,identity.messageId);
    return this.#transaction(()=>{this.#expireDue(this.#time());return publicReceipt(this.#getByInbound(key));});
  }
  listReceipts(){
    return this.#transaction(()=>{
      this.#expireDue(this.#time());
      return this.db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM image_receipts ORDER BY created_ms,rowid`).all().map(publicReceipt);
    });
  }
  nextAvailable(){
    return this.#transaction(()=>{
      this.#expireDue(this.#time());
      const row=this.db.prepare("SELECT * FROM image_receipts WHERE status='RECEIVED' ORDER BY created_ms,rowid LIMIT 1").get();
      return row?this.#result(row,false):null;
    });
  }
  close(){
    this.db.close();
    this.encryptionKey.fill(0);
    this.handleKey.fill(0);
  }
}
