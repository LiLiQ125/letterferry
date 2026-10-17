import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { WebHostStore } from '../src/web-host-store.mjs';

const path=resolve('data/web-host.sqlite');
const localHostUrl='http://127.0.0.1:8799/health';
async function hostStillOnline() {
  try {
    await fetch(localHostUrl,{signal:AbortSignal.timeout(1200)});
    return true;
  }catch{return false;}
}
export function getSafeSummary(file) {
  if(!existsSync(file)) return [];
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    // SQL deliberately excludes message bodies, replies, idempotency keys and credentials.
    const hasDiagnosticTable=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='web_host_failure_diagnostics'").get();
    return hasDiagnosticTable
      ? db.prepare(`SELECT e.id,e.status,d.stage,d.code
          FROM web_host_events e LEFT JOIN web_host_failure_diagnostics d ON e.id=d.event_id
          WHERE e.status IN ('DELIVERY_UNKNOWN','REVIEWED_NO_REPLAY')
          ORDER BY e.created_ms DESC LIMIT 15`).all()
      : db.prepare(`SELECT id,status,NULL AS stage,NULL AS code
          FROM web_host_events WHERE status='DELIVERY_UNKNOWN'
          ORDER BY created_ms DESC LIMIT 15`).all();
  }finally{db.close();}
}
export async function runReview({review=false,ask,print=console.log}={}) {
  const rows=getSafeSummary(path);
  if(!rows.length){print('NO_AMBIGUOUS_EVENTS');return 'NONE';}
  for(const r of rows)print('id='+r.id+' status='+r.status+' stage='+(r.stage||'UNKNOWN_STAGE')+' code='+(r.code||'LEGACY_UNKNOWN'));
  if(!review) {print('READ_ONLY: no state changed.');return 'READ_ONLY';}
  if(await hostStillOnline())throw Error('STOP_LOCAL_WEB_HOST_BEFORE_MANUAL_REVIEW');
  const pending=rows.filter(r=>r.status==='DELIVERY_UNKNOWN');
  if(pending.length!==1) throw Error('REQUIRES_EXACTLY_ONE_UNKNOWN_EVENT');
  const event=pending[0];
  print('Manually inspect the chosen ChatGPT conversation. This action will NOT resend the unknown event.');
  const answer=await ask('Only after inspection, type REVIEW '+event.id+' NO REPLAY: ');
  if(answer?.trim()!=='REVIEW '+event.id+' NO REPLAY') {print('CANCELLED');return 'CANCELLED';}
  const store=new WebHostStore(path);
  try {
    const updated=store.reviewUnknownWithoutReplay(event.id);
    print('REVIEWED_NO_REPLAY id='+updated.id+' (message was NOT resent)');
    return 'REVIEWED_NO_REPLAY';
  }finally{store.close();}
}
if(process.argv[1] && resolve(process.argv[1])===resolve(fileURLToPath(import.meta.url))){
 const rl=readline.createInterface({input,output});
 try{await runReview({review:process.argv.includes('--review'),ask:prompt=>rl.question(prompt)});}
 catch(error){console.error('MANUAL_REVIEW_NOT_COMPLETED '+(error?.message||'UNKNOWN'));process.exitCode=1;}
 finally{rl.close();}
}
