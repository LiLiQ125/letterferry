import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {stdin,stdout} from 'node:process';
import {createInterface} from 'node:readline/promises';
import {AdapterStore} from '../src/store.mjs';
import {WebHostStore} from '../src/web-host-store.mjs';

export function identifyManualInputFailure(adapterRows,webRow,diagnostic){
 const pending=adapterRows.filter(r=>!['SUCCEEDED','REVIEWED_NO_REPLAY'].includes(r.status));
 if(pending.length!==1)throw Error('REVIEW_REQUIRES_ONE_PENDING_WEIXIN_TASK');
 const row=pending[0];
 if(row.status!=='BRIDGE_QUEUED'||row.bridge_submit_attempts!==1||
    typeof row.bridge_event_id!=='string'||row.bridge_event_id!==webRow?.id ||
    !/^RWX_WEB_ONCE_[A-F0-9]{24}$/.test(row.text||''))
   throw Error('REVIEW_MISMATCHED_ONE_SHOT_TASK');
 const expected='[WeChat authorized text | adapter_event='+row.id+']\n'+row.text;
 if(webRow.text!==expected||webRow.reply_text!==null)
   throw Error('REVIEW_WEB_PAYLOAD_MISMATCH');
 const safePreSendCodes=new Set(['INPUT_NOT_CONFIRMED','COMPOSER_NOT_EMPTY']);
 if(webRow.status==='DELIVERY_UNKNOWN'&&
    (diagnostic?.stage!=='BROWSER_DELIVERY'||!safePreSendCodes.has(diagnostic?.code)))
   throw Error('REVIEW_UNEXPECTED_FAILURE_CODE');
 if(!['DELIVERY_UNKNOWN','REVIEWED_NO_REPLAY'].includes(webRow.status))
   throw Error('REVIEW_WEB_STATUS_NOT_UNKNOWN');
 return row;
}
export async function closeReviewedInputFailure({
 adapterPath=resolve('data/adapter.sqlite'),
 webPath=resolve('data/web-host.sqlite'),
 ask,print=console.log,
 isHostOnline=async()=>{
   try{await fetch('http://127.0.0.1:8799/health',{signal:AbortSignal.timeout(1200)});return true;}
   catch{return false;}
 }
}={}){
 if(await isHostOnline())throw Error('STOP_LOCAL_WEB_HOST_BEFORE_REVIEW');
 const a=new AdapterStore(adapterPath);
 const w=new WebHostStore(webPath);
 try{
   const rows=a.list();
   const nonterminal=rows.filter(r=>!['SUCCEEDED','REVIEWED_NO_REPLAY'].includes(r.status));
   if(nonterminal.length!==1)throw Error('REVIEW_REQUIRES_ONE_PENDING_WEIXIN_TASK');
   const web=w.get(nonterminal[0].bridge_event_id);
   const row=identifyManualInputFailure(rows,web,w.diagnostic(web?.id));
   const diagnostic=w.diagnostic(web?.id);
   print((diagnostic?.code||'PRE_SEND_INPUT_FAILURE')+' confirmed before browser send click. Weixin outbound was not attempted by this one-shot stage.');
   print('This review NEVER resends the browser task or any Weixin message. It retains both task records.');
   const confirmation=await ask('After inspecting the bound chat and confirming manual-only sending, type REVIEW '+web.id+' NO REPLAY: ');
   if(confirmation?.trim()!=='REVIEW '+web.id+' NO REPLAY'){
     print('CANCELLED_WITHOUT_DB_CHANGE');return 'CANCELLED';
   }
   if(web.status==='DELIVERY_UNKNOWN')w.reviewUnknownWithoutReplay(web.id);
   const result=a.reviewBridgeWithoutReplay(row.id,web.id);
   if(result.status!=='REVIEWED_NO_REPLAY')throw Error('REVIEW_ADAPTER_UPDATE_FAILED');
   print('REVIEWED_NO_REPLAY both linked tasks; no messages sent; original rows preserved.');
   return 'REVIEWED_NO_REPLAY';
 }finally{w.close();a.close();}
}
if(process.argv[1]&&resolve(fileURLToPath(import.meta.url))===resolve(process.argv[1])){
 const rl=createInterface({input:stdin,output:stdout});
 try{await closeReviewedInputFailure({ask:prompt=>rl.question(prompt)});}
 catch(e){
   const code=e?.message||'';
   console.error(/^[A-Z0-9_]{3,90}$/.test(code)?code:'REVIEW_FAILED');
   process.exitCode=1;
 }finally{rl.close();}
}