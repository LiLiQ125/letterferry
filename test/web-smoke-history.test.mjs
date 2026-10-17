import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {hasVerifiedBrowserSmoke} from '../scripts/verify-web-smoke-history.mjs';

test('read-only browser acceptance marker must match exact successful reply',()=>{
 const dir=mkdtempSync(join(tmpdir(),'rwb-browser-proof-'));
 const file=join(dir,'web.sqlite');
 try{
  assert.equal(hasVerifiedBrowserSmoke(file),false);
  const db=new DatabaseSync(file);
  db.exec('CREATE TABLE web_host_events (status TEXT NOT NULL,reply_text TEXT)');
  db.prepare('INSERT INTO web_host_events VALUES (?,?)').run('SUCCEEDED','ChatGPT 说：');
  db.prepare('INSERT INTO web_host_events VALUES (?,?)').run('DELIVERY_UNKNOWN','RIVEN_WEB_SMOKE_OK');
  assert.equal(hasVerifiedBrowserSmoke(file),false);
  db.prepare('INSERT INTO web_host_events VALUES (?,?)').run('SUCCEEDED','RIVEN_WEB_SMOKE_OK');
  db.close();
  assert.equal(hasVerifiedBrowserSmoke(file),true);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
