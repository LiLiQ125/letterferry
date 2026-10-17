import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const PUBLIC_COLUMNS = `id,inbound_key,account_id,user_id,chat_id,message_id,text,status,created_ms,updated_ms,
bridge_event_id,bridge_submit_attempts,outbound_client_id,last_error`;

export class AdapterStore {
  constructor(filename = resolve('data/adapter.sqlite'), clock = () => Date.now()) {
    mkdirSync(dirname(filename), { recursive: true });
    this.filename = filename;
    this.clock = clock;
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS adapter_events (
        id TEXT PRIMARY KEY,
        inbound_key TEXT UNIQUE NOT NULL,
        account_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        text TEXT NOT NULL,
        context_cipher TEXT NOT NULL,
        status TEXT NOT NULL,
        created_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL,
        bridge_event_id TEXT UNIQUE,
        bridge_submit_attempts INTEGER NOT NULL DEFAULT 0,
        reply_text TEXT,
        outbound_client_id TEXT UNIQUE NOT NULL,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS adapter_status ON adapter_events(status,created_ms);`);
    this.db.prepare("UPDATE adapter_events SET status='OUTBOUND_UNKNOWN',last_error='RECOVERED_AMBIGUOUS_OUTBOUND',updated_ms=? WHERE status='OUTBOUND_SENDING'").run(this.clock());
  }

  ingest(update, contextCipher) {
    const inboundKey = `${update.accountId}:${update.messageId}`;
    const id = randomUUID();
    const now = this.clock();
    const outboundClientId = `rwb-${id}`;
    this.db.prepare(`INSERT OR IGNORE INTO adapter_events
      (id,inbound_key,account_id,user_id,chat_id,message_id,text,context_cipher,status,created_ms,updated_ms,outbound_client_id)
      VALUES (?,?,?,?,?,?,?,?,'RECEIVED',?,?,?)`)
      .run(id,inboundKey,update.accountId,update.fromUserId,update.chatId,update.messageId,update.text,contextCipher,now,now,outboundClientId);
    const row = this.getByInboundKey(inboundKey, true);
    if (row.user_id !== update.fromUserId || row.chat_id !== update.chatId || row.text !== update.text) throw new Error('IDEMPOTENCY_CONFLICT');
    return this.get(row.id);
  }

  get(id, includePrivate = false) {
    return this.db.prepare(`SELECT ${includePrivate ? '*' : PUBLIC_COLUMNS} FROM adapter_events WHERE id=?`).get(id);
  }
  getPrivate(id) { return this.get(id, true); }
  getByInboundKey(key, includePrivate = false) {
    return this.db.prepare(`SELECT ${includePrivate ? '*' : PUBLIC_COLUMNS} FROM adapter_events WHERE inbound_key=?`).get(key);
  }
  next(status) {
    return this.db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM adapter_events WHERE status=? ORDER BY created_ms,rowid LIMIT 1`).get(status);
  }
  list() { return this.db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM adapter_events ORDER BY created_ms,rowid`).all(); }

  noteBridgeAttempt(id) {
    const result = this.db.prepare("UPDATE adapter_events SET bridge_submit_attempts=bridge_submit_attempts+1,updated_ms=?,last_error=NULL WHERE id=? AND status='RECEIVED'").run(this.clock(),id);
    if (result.changes !== 1) throw new Error('STALE_EVENT');
  }
  deferBacklog(id) {
    const changed=this.db.prepare("UPDATE adapter_events SET status='DEFERRED_BACKLOG',updated_ms=?,last_error=NULL WHERE id=? AND status='RECEIVED'").run(this.clock(),id);
    if(changed.changes!==1) throw new Error('BACKLOG_STATE_CONFLICT');
    return this.get(id);
  }
  bridgeQueued(id, bridgeEventId) {
    const result = this.db.prepare("UPDATE adapter_events SET status='BRIDGE_QUEUED',bridge_event_id=?,updated_ms=?,last_error=NULL WHERE id=? AND status='RECEIVED'").run(bridgeEventId,this.clock(),id);
    if (result.changes !== 1) throw new Error('STALE_EVENT');
    return this.get(id);
  }
  bridgeError(id, code) {
    this.db.prepare("UPDATE adapter_events SET updated_ms=?,last_error=? WHERE id=? AND status='RECEIVED'").run(this.clock(),code,id);
  }
  replyReady(id, replyText) {
    if (typeof replyText !== 'string' || !replyText.trim() || replyText.length > 8000) throw new Error('INVALID_REPLY');
    const result = this.db.prepare("UPDATE adapter_events SET status='REPLY_READY',reply_text=?,updated_ms=?,last_error=NULL WHERE id=? AND status='BRIDGE_QUEUED'").run(replyText.trim(),this.clock(),id);
    if (result.changes !== 1) throw new Error('STALE_EVENT');
    return this.get(id);
  }
  beginOutbound(id) {
    const result = this.db.prepare("UPDATE adapter_events SET status='OUTBOUND_SENDING',updated_ms=?,last_error=NULL WHERE id=? AND status='REPLY_READY'").run(this.clock(),id);
    if (result.changes !== 1) throw new Error('STALE_EVENT');
    return this.getPrivate(id);
  }
  outboundSucceeded(id) {
    const result = this.db.prepare("UPDATE adapter_events SET status='SUCCEEDED',updated_ms=? WHERE id=? AND status='OUTBOUND_SENDING'").run(this.clock(),id);
    if (result.changes !== 1) throw new Error('STALE_EVENT');
    return this.get(id);
  }
  outboundUnknown(id, code = 'OUTBOUND_RESULT_UNKNOWN') {
    const result = this.db.prepare("UPDATE adapter_events SET status='OUTBOUND_UNKNOWN',updated_ms=?,last_error=? WHERE id=? AND status='OUTBOUND_SENDING'").run(this.clock(),code,id);
    if (result.changes !== 1) throw new Error('STALE_EVENT');
    return this.get(id);
  }
  reviewBridgeWithoutReplay(id,bridgeEventId){
    if(typeof id!=='string'||typeof bridgeEventId!=='string')throw Error('REVIEW_IDS_REQUIRED');
    const row=this.get(id);
    if(row?.bridge_event_id!==bridgeEventId||row?.bridge_submit_attempts!==1||
      row?.status!=='BRIDGE_QUEUED')throw Error('REVIEW_EXACT_PENDING_BRIDGE_REQUIRED');
    const result=this.db.prepare(`UPDATE adapter_events
      SET status='REVIEWED_NO_REPLAY',last_error='HUMAN_REVIEW_BROWSER_INPUT_NOT_CONFIRMED',updated_ms=?
      WHERE id=? AND bridge_event_id=? AND status='BRIDGE_QUEUED' AND bridge_submit_attempts=1`)
      .run(this.clock(),id,bridgeEventId);
    if(result.changes!==1)throw Error('REVIEW_COMMIT_CONFLICT');
    return this.get(id);
  }
  close() { this.db.close(); }
}
