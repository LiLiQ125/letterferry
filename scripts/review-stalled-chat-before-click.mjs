import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {stdin,stdout} from 'node:process';
import {createInterface} from 'node:readline/promises';
import {AdapterStore} from '../src/store.mjs';
import {WebHostStore} from '../src/web-host-store.mjs';
import {readAlwaysOn} from '../src/always-on-policy.mjs';

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const TERMINAL_ADAPTER=new Set(['SUCCEEDED','REVIEWED_NO_REPLAY','DEFERRED_BACKLOG']);
const TERMINAL_WEB=new Set(['SUCCEEDED','REVIEWED_NO_REPLAY']);

export function assessUnsentBrowserClick({adapterRows,webRows,web,diagnostic,adapterId,webId}){
 if(!UUID.test(adapterId||'')||!UUID.test(webId||''))throw Error('REVIEW_EXACT_IDS_REQUIRED');
 const aa=adapterRows.filter(row=>!TERMINAL_ADAPTER.has(row.status));
 const ww=webRows.filter(row=>!TERMINAL_WEB.has(row.status));
 if(aa.length!==1||aa[0].id!==adapterId||ww.length!==1||ww[0].id!==webId)
  throw Error('REVIEW_NOT_SOLE_LINKED_BLOCKER');
 const a=aa[0];
 if(a.status!=='BRIDGE_QUEUED'||a.bridge_submit_attempts!==1||a.bridge_event_id!==webId)
  throw Error('REVIEW_ADAPTER_STATUS_MISMATCH');
 if(web?.id!==webId||web.status!=='DELIVERY_UNKNOWN'||web.reply_text!==null||
    web.idempotency_key!=='weixin:'+a.id)
  throw Error('REVIEW_WEB_STATUS_MISMATCH');
 const expected='[WeChat authorized text | adapter_event='+a.id+']\n'+a.text;
 if(web.text!==expected)throw Error('REVIEW_WEB_ENVELOPE_MISMATCH');
 if(diagnostic?.stage!=='BROWSER_DELIVERY'||diagnostic?.code!=='SEND_BUTTON_NOT_FOUND')
  throw Error('REVIEW_NOT_PRECLICK_SEND_FAILURE');
 return {adapterId:a.id,webId:web.id};
}

export async function reviewUnsentBrowserClick({
 adapterId,webId,adapterPath=resolve('data/adapter.sqlite'),
 webPath=resolve('data/web-host.sqlite'),
 ask,print=console.log,
 checkPaused=()=>readAlwaysOn().paused===true,
 hostOnline=async()=>{
  try{await fetch('http://127.0.0.1:8799/health',{signal:AbortSignal.timeout(1200)});return true;}
  catch{return false;}
 }
}={}){
 if(!UUID.test(adapterId||'')||!UUID.test(webId||''))throw Error('REVIEW_EXACT_IDS_REQUIRED');
 if(!checkPaused())throw Error('REVIEW_PAUSE_BRIDGE_FIRST');
 if(await hostOnline())throw Error('REVIEW_STOP_WEB_HOST_FIRST');
 const a=new AdapterStore(adapterPath),w=new WebHostStore(webPath);
 try{
  const selected=assessUnsentBrowserClick({
   adapterRows:a.list(),
   webRows:w.db.prepare('SELECT id,status FROM web_host_events').all(),
   web:w.get(webId),diagnostic:w.diagnostic(webId),adapterId,webId
  });
  print('READ_ONLY_EVIDENCE_VERIFIED: Browser send button was never found before click.');
  print('Check the exact pinned ChatGPT tab: no submitted user turn for this event and no unfinished draft.');
  print('This action closes ONE pair of ambiguous task records, sends nothing, and retains history.');
  const typed=await ask('To mark the exact pair REVIEWED_NO_REPLAY, type REVIEW '+webId+' NO REPLAY: ');
  if(typed?.trim()!=='REVIEW '+webId+' NO REPLAY'){
   print('CANCELLED_NO_DB_CHANGE');return 'CANCELLED';
  }
  // Recheck immediately after human confirmation to avoid stale preflight.
  if(!checkPaused()||await hostOnline())throw Error('REVIEW_STATE_CHANGED');
  assessUnsentBrowserClick({
   adapterRows:a.list(),
   webRows:w.db.prepare('SELECT id,status FROM web_host_events').all(),
   web:w.get(webId),diagnostic:w.diagnostic(webId),adapterId,webId
  });
  const updatedWeb=w.reviewUnknownWithoutReplay(selected.webId);
  const updatedAdapter=a.reviewBridgeWithoutReplay(selected.adapterId,selected.webId);
  if(updatedWeb.status!=='REVIEWED_NO_REPLAY'||updatedAdapter.status!=='REVIEWED_NO_REPLAY')
   throw Error('REVIEW_INCOMPLETE_CHECK_BOTH_STORES');
  print('REVIEWED_NO_REPLAY both linked records; outbound calls=0; history preserved.');
  return 'REVIEWED_NO_REPLAY';
 }finally{w.close();a.close();}
}

const entry=process.argv[1]&&resolve(process.argv[1])===resolve(fileURLToPath(import.meta.url));
if(entry){
 const rl=createInterface({input:stdin,output:stdout});
 try{
  if(!stdin.isTTY||!stdout.isTTY)throw Error('REVIEW_INTERACTIVE_TERMINAL_REQUIRED');
  await reviewUnsentBrowserClick({
   adapterId:process.argv[2],webId:process.argv[3],
   ask:question=>rl.question(question)
  });
 }catch(error){
  const code=error?.message||'';
  console.error(/^[A-Z0-9_]{3,90}$/.test(code)?code:'REVIEW_FAILED');process.exitCode=1;
 }finally{rl.close();}
}
