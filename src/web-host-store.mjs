import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeWebFailure } from './web-host-diagnostics.mjs';

export class WebHostStore {
  constructor(file, now = () => Date.now()) {
    this.now = now;
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS web_host_events(
        id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL,
        text TEXT NOT NULL, status TEXT NOT NULL,
        reply_text TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS web_host_failure_diagnostics(
        event_id TEXT PRIMARY KEY,
        stage TEXT NOT NULL,
        code TEXT NOT NULL,
        recorded_ms INTEGER NOT NULL
      );`);
    this.db.prepare("UPDATE web_host_events SET status='DELIVERY_UNKNOWN', updated_ms=? WHERE status IN ('ASSIGNED_UNKNOWN','BROWSER_SUBMITTED')").run(this.now());
  }
  enqueue({text,idempotencyKey}) {
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('INVALID_BRIDGE_TEXT');
    if (typeof idempotencyKey !== 'string' || !/^weixin:[a-f0-9-]{36}$/.test(idempotencyKey)) throw new Error('INVALID_IDEMPOTENCY_KEY');
    const prior = this.db.prepare('SELECT * FROM web_host_events WHERE idempotency_key=?').get(idempotencyKey);
    if (prior) {
      if (prior.text !== text) throw new Error('IDEMPOTENCY_CONFLICT');
      return prior;
    }
    const pending = this.db.prepare("SELECT COUNT(*) AS n FROM web_host_events WHERE status NOT IN ('SUCCEEDED','REVIEWED_NO_REPLAY')").get().n;
    if (pending >= 20) throw new Error('WEB_QUEUE_FULL');
    const id = randomUUID(), ms = this.now();
    this.db.prepare("INSERT INTO web_host_events VALUES (?,?,?,'QUEUED',NULL,?,?)").run(id,idempotencyKey,text,ms,ms);
    return this.get(id);
  }
  get(id) { return this.db.prepare('SELECT * FROM web_host_events WHERE id=?').get(id); }
  counts() {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM web_host_events GROUP BY status').all();
    return Object.fromEntries(rows.map(({status,n}) => [status,n]));
  }
  claim() {
    // Assigning a job is potentially irreversible. If the ACK is lost, never replay it.
    if (this.db.prepare("SELECT COUNT(*) AS n FROM web_host_events WHERE status IN ('ASSIGNED_UNKNOWN','BROWSER_SUBMITTED','DELIVERY_UNKNOWN')").get().n) return null;
    const row = this.db.prepare("SELECT * FROM web_host_events WHERE status='QUEUED' ORDER BY created_ms,rowid LIMIT 1").get();
    if (!row) return null;
    const result = this.db.prepare("UPDATE web_host_events SET status='ASSIGNED_UNKNOWN',updated_ms=? WHERE id=? AND status='QUEUED'").run(this.now(),row.id);
    return result.changes ? this.get(row.id) : null;
  }
  submitted(id) {
    const result = this.db.prepare("UPDATE web_host_events SET status='BROWSER_SUBMITTED',updated_ms=? WHERE id=? AND status='ASSIGNED_UNKNOWN'").run(this.now(),id);
    if (!result.changes) throw new Error('INVALID_SUBMITTED_TRANSITION');
    return this.get(id);
  }
  complete(id, reply) {
    if (typeof reply !== 'string' || !reply.trim() || reply.length > 2000) throw new Error('INVALID_BROWSER_REPLY');
    const result = this.db.prepare("UPDATE web_host_events SET status='SUCCEEDED',reply_text=?,updated_ms=? WHERE id=? AND status IN ('ASSIGNED_UNKNOWN','BROWSER_SUBMITTED')").run(reply.trim(),this.now(),id);
    if (!result.changes) throw new Error('INVALID_COMPLETE_TRANSITION');
    return this.get(id);
  }
  unknown(id, failure) {
    const diagnostic=normalizeWebFailure(failure);
    const ms=this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result=this.db.prepare("UPDATE web_host_events SET status='DELIVERY_UNKNOWN',updated_ms=? WHERE id=? AND status IN ('ASSIGNED_UNKNOWN','BROWSER_SUBMITTED')").run(ms,id);
      if(result.changes) this.db.prepare('INSERT INTO web_host_failure_diagnostics (event_id,stage,code,recorded_ms) VALUES (?,?,?,?)').run(id,diagnostic.stage,diagnostic.code,ms);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    return this.get(id);
  }
  diagnostic(id) {
    return this.db.prepare('SELECT stage,code,recorded_ms FROM web_host_failure_diagnostics WHERE event_id=?').get(id) ?? null;
  }
  reviewUnknownWithoutReplay(id) {
    if(typeof id!=='string'||!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('INVALID_EVENT_ID');
    const result=this.db.prepare("UPDATE web_host_events SET status='REVIEWED_NO_REPLAY',updated_ms=? WHERE id=? AND status='DELIVERY_UNKNOWN'").run(this.now(),id);
    if(!result.changes) throw new Error('EVENT_NOT_REVIEWABLE');
    return this.get(id);
  }
  close() { this.db.close(); }
}
