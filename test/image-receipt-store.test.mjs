import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {ImageReceiptStore} from '../src/image-receipt-store.mjs';
import {MAX_WEIXIN_IMAGE_BYTES} from '../src/media-inbound-image.mjs';

const KEY=Buffer.from('8f'.repeat(32),'hex');
const ACCOUNT='owner-account';
const USER='authorized-peer';
const PNG=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
  Buffer.from('RIVEN_PRIVATE_IMAGE_BYTES_7d31f8c2','ascii')]);
const identity=(messageId='message-1')=>({accountId:ACCOUNT,fromUserId:USER,chatId:USER,messageId});
const image=(messageId='message-1',bytes=PNG)=>({...identity(messageId),bytes,mimeType:'image/png',fileName:'wechat-image.png'});

function fixture({now=()=>1000,ttlMs=10_000,file}={}){
  const dir=file?null:mkdtempSync(join(tmpdir(),'riven-image-receipt-'));
  const filename=file||join(dir,'receipts.sqlite');
  const store=new ImageReceiptStore({filename,secretKey:KEY,accountId:ACCOUNT,
    allowedPeer:{userId:USER,chatId:USER},ttlMs,now});
  return {dir,filename,store,cleanup(){store.close();if(dir)rmSync(dir,{recursive:true,force:true});}};
}
test('authorized image creates metadata plus an opaque handle and can be claimed exactly once',()=>{
  const f=fixture();
  try{
    const accepted=f.store.ingest(image());
    assert.equal(accepted.created,true);
    assert.match(accepted.handle,/^[A-Za-z0-9_-]{43}$/);
    assert.equal(accepted.receipt.status,'RECEIVED');
    assert.equal(accepted.receipt.size,PNG.length);
    assert.equal('bytes' in accepted.receipt,false);
    assert.equal(JSON.stringify(accepted).includes(KEY.toString('hex')),false);
    const claimed=f.store.claimOnce(accepted.handle);
    assert.deepEqual(claimed.bytes,PNG);
    assert.equal(claimed.receipt.status,'CLAIMED');
    assert.throws(()=>f.store.claimOnce(accepted.handle),/IMAGE_HANDLE_NOT_AVAILABLE/);
    assert.equal(f.store.nextAvailable(),null);
  }finally{f.cleanup();}
});

test('duplicate ingest is idempotent but same sender/message digest conflict fails closed',()=>{
  const f=fixture();
  try{
    const first=f.store.ingest(image());
    const duplicate=f.store.ingest(image());
    assert.equal(duplicate.created,false);
    assert.equal(duplicate.receipt.id,first.receipt.id);
    assert.equal(duplicate.handle,first.handle);
    const changed=Buffer.concat([PNG,Buffer.from('changed')]);
    assert.throws(()=>f.store.ingest(image('message-1',changed)),/IMAGE_RECEIPT_IDEMPOTENCY_CONFLICT/);
    assert.equal(f.store.listReceipts().length,1);
  }finally{f.cleanup();}
});

test('wrong account, sender or chat is rejected before a receipt is written',()=>{
  const f=fixture();
  try{
    for(const change of [{accountId:'other'},{fromUserId:'intruder'},{chatId:'other-chat'}])
      assert.throws(()=>f.store.ingest({...image(),...change}),/IMAGE_SENDER_UNAUTHORIZED/);
    assert.deepEqual(f.store.listReceipts(),[]);
  }finally{f.cleanup();}
});

test('SQLite files contain ciphertext, never the plaintext image sequence or secret key',()=>{
  const f=fixture();
  const needle=PNG.toString('hex'),keyNeedle=KEY.toString('hex');
  try{f.store.ingest(image());f.store.close();
    for(const name of readdirSync(f.dir)){
      const raw=readFileSync(join(f.dir,name));
      assert.equal(raw.toString('hex').includes(needle),false,name+' leaked plaintext image');
      assert.equal(raw.toString('hex').includes(keyNeedle),false,name+' leaked secret key');
    }
  }finally{rmSync(f.dir,{recursive:true,force:true});}
});

test('unclaimed handle survives restart; CLAIMED persists and is never redistributed',()=>{
  const dir=mkdtempSync(join(tmpdir(),'riven-image-restart-'));
  const file=join(dir,'receipts.sqlite');
  let first=fixture({file});
  const issued=first.store.ingest(image());
  first.store.close();
  let reopened=fixture({file});
  try{
    assert.equal(reopened.store.nextAvailable().handle,issued.handle);
    assert.deepEqual(reopened.store.claimOnce(issued.handle).bytes,PNG);
    reopened.store.close();
    reopened=fixture({file});
    assert.equal(reopened.store.getReceipt(identity()).status,'CLAIMED');
    assert.equal(reopened.store.nextAvailable(),null);
    const duplicate=reopened.store.ingest(image());
    assert.equal(duplicate.receipt.status,'CLAIMED');
    assert.equal(duplicate.handle,null);
    assert.throws(()=>reopened.store.claimOnce(issued.handle),/IMAGE_HANDLE_NOT_AVAILABLE/);
  }finally{reopened.store.close();rmSync(dir,{recursive:true,force:true});}
});

test('TTL expiry purges availability and never returns image bytes',()=>{
  let now=1000;
  const f=fixture({now:()=>now,ttlMs:100});
  try{
    const issued=f.store.ingest(image());
    now=1100;
    assert.throws(()=>f.store.claimOnce(issued.handle),/IMAGE_HANDLE_EXPIRED/);
    const receipt=f.store.getReceipt(identity());
    assert.equal(receipt.status,'EXPIRED');
    assert.equal(receipt.lastError,'IMAGE_RECEIPT_EXPIRED');
    assert.equal(f.store.nextAvailable(),null);
  }finally{f.cleanup();}
});

test('JPEG, PNG, GIF and WebP pass while size, MIME and filename errors fail before persistence',()=>{
  const f=fixture();
  const cases=[
    ['jpg',Buffer.from([0xff,0xd8,0xff,1]),'image/jpeg'],
    ['png',Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),'image/png'],
    ['gif',Buffer.from('GIF89a-tail','ascii'),'image/gif'],
    ['webp',Buffer.from('RIFFxxxxWEBPtail','ascii'),'image/webp']
  ];
  try{
    for(const [ext,bytes,mimeType] of cases)f.store.ingest({...image('m-'+ext,bytes),mimeType,fileName:'photo.'+ext});
    const boundary=Buffer.alloc(MAX_WEIXIN_IMAGE_BYTES);
    PNG.subarray(0,8).copy(boundary);
    const max=f.store.ingest(image('exactly-12mib',boundary));
    assert.equal(max.receipt.size,MAX_WEIXIN_IMAGE_BYTES);
    assert.equal(f.store.listReceipts().length,5);
    assert.throws(()=>f.store.ingest({...image('too-large',Buffer.alloc(MAX_WEIXIN_IMAGE_BYTES+1)),
      mimeType:'image/png'}),/IMAGE_TOO_LARGE/);
    assert.throws(()=>f.store.ingest({...image('wrong-mime'),mimeType:'image/jpeg',fileName:'photo.jpg'}),
      /IMAGE_MIME_MISMATCH/);
    assert.throws(()=>f.store.ingest({...image('svg'),mimeType:'image\/svg\+xml',fileName:'photo.svg'}),
      /IMAGE_MIME_UNSUPPORTED/);
    assert.throws(()=>f.store.ingest({...image('bad-name'),fileName:'photo.jpg'}),/IMAGE_FILENAME_MISMATCH/);
    assert.equal(f.store.listReceipts().length,5);
  }finally{f.cleanup();}
});

test('authenticated-decryption exception rolls back CLAIMED and failure can be archived visibly',()=>{
  const dir=mkdtempSync(join(tmpdir(),'riven-image-rollback-'));
  const file=join(dir,'receipts.sqlite');
  let f=fixture({file});
  const issued=f.store.ingest(image());
  f.store.close();
  const db=new DatabaseSync(file);
  db.prepare('UPDATE image_receipts SET auth_tag=? WHERE id=?').run(Buffer.alloc(16),issued.receipt.id);
  db.close();
  f=fixture({file});
  try{
    assert.throws(()=>f.store.claimOnce(issued.handle),/IMAGE_RECEIPT_DECRYPT_FAILED/);
    assert.equal(f.store.getReceipt(identity()).status,'RECEIVED');
    const failed=f.store.archiveFailure(identity(),'AUTHENTICATED_DECRYPT_FAILED');
    assert.equal(failed.status,'FAILED');
    assert.equal(failed.lastError,'AUTHENTICATED_DECRYPT_FAILED');
    assert.equal(f.store.listReceipts()[0].status,'FAILED');
    assert.throws(()=>f.store.claimOnce(issued.handle),/IMAGE_HANDLE_NOT_AVAILABLE/);
  }finally{f.store.close();rmSync(dir,{recursive:true,force:true});}
});

test('two store instances cannot claim the same durable handle twice',()=>{
  const dir=mkdtempSync(join(tmpdir(),'riven-image-concurrent-'));
  const file=join(dir,'receipts.sqlite');
  const a=fixture({file}),b=fixture({file});
  try{
    const issued=a.store.ingest(image());
    assert.deepEqual(a.store.claimOnce(issued.handle).bytes,PNG);
    assert.throws(()=>b.store.claimOnce(issued.handle),/IMAGE_HANDLE_NOT_AVAILABLE/);
    assert.equal(b.store.getReceipt(identity()).status,'CLAIMED');
  }finally{a.store.close();b.store.close();rmSync(dir,{recursive:true,force:true});}
});

test('configuration requires explicit DB path, exact 32-byte secret and bounded TTL',()=>{
  const base={filename:join(tmpdir(),'not-created.sqlite'),secretKey:KEY,accountId:ACCOUNT,
    allowedPeer:{userId:USER,chatId:USER},ttlMs:100};
  assert.throws(()=>new ImageReceiptStore({...base,filename:''}),/FILENAME_REQUIRED/);
  assert.throws(()=>new ImageReceiptStore({...base,secretKey:Buffer.alloc(31)}),/KEY_REQUIRED_32_BYTES/);
  assert.throws(()=>new ImageReceiptStore({...base,ttlMs:0}),/TTL_INVALID/);
});
