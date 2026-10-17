import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import {stdin,stdout} from 'node:process';
import {createInterface} from 'node:readline/promises';
import {AdapterStore} from '../src/store.mjs';
import {ProtectedAuthStore} from '../src/auth-store.mjs';
import {AllowlistPolicy} from '../src/policy.mjs';
import {RealWeixinTransport} from '../src/transports/real-weixin.mjs';
import {WeixinBridgeAdapter} from '../src/adapter.mjs';
import {loadEncryptionKey} from '../src/secrets.mjs';
import {requireDisabledBinding} from '../src/web-weixin-once-policy.mjs';
import {soleOutstanding,verifiedStoredWebReply} from '../src/web-session-recovery.mjs';
const ID=process.argv[3];
const mode=process.argv[2];
async function main(){
 if(mode!=='collect'&&mode!=='send')throw Error('RECOVERY_MODE_REQUIRED');
 const peer=requireDisabledBinding(JSON.parse(readFileSync(resolve('data/weixin-runtime.json'),'utf8')));
 const store=new AdapterStore(resolve('data/adapter.sqlite'));
 const web=new DatabaseSync(resolve('data/web-host.sqlite'),{readOnly:true});
 let secret=null,rl=null;
 try{
  const status=mode==='collect'?'BRIDGE_QUEUED':'REPLY_READY';
  const row=soleOutstanding(store.list(),ID,status);
  const verified=verifiedStoredWebReply({...row,reply_text:store.getPrivate(ID)?.reply_text},
   web.prepare('SELECT * FROM web_host_events WHERE id=?').get(row.bridge_event_id),peer,{expectedStatus:status});
  if(mode==='collect'){
    const result=store.replyReady(ID,verified);
    stdout.write('RECOVERY_LOCAL_ONLY status='+result.status+' reply_length='+verified.length+' weixin_outbound_calls=0\n');
    return;
  }
  if(!stdin.isTTY||!stdout.isTTY)throw Error('RECOVERY_FOREGROUND_TTY_REQUIRED');
  rl=createInterface({input:stdin,output:stdout});
  stdout.write('A previous Web ChatGPT reply is saved, checked against the one real paired DM and the Web Host idempotency record.\n');
  stdout.write('Inspect the exact assistant reply in the original bound ChatGPT tab. Nothing is transmitted until your confirmation.\n');
  const answer=await rl.question('To send exactly this ONE saved reply to Weixin, type SEND STALLED WEIXIN REPLY (anything else cancels): ');
  if(answer!=='SEND STALLED WEIXIN REPLY'){stdout.write('CANCELLED_NO_WEIXIN_SEND\n');return;}
  soleOutstanding(store.list(),ID,'REPLY_READY');
  const authStore=new ProtectedAuthStore();
  const auth=await authStore.load();
  if(row.account_id!==auth.accountId)throw Error('RECOVERY_ACCOUNT_ID_MISMATCH');
  secret=loadEncryptionKey();
  const transport=new RealWeixinTransport({authStore,allowedPeer:peer,inboundEnabled:false,outboundEnabled:true});
  const adapter=new WeixinBridgeAdapter({accountId:auth.accountId,policy:new AllowlistPolicy({
    accountId:auth.accountId,allowedPeers:[peer]}),store,transport,bridge:null,encryptionKey:secret});
  const sent=await adapter.sendOneReply();
  if(sent?.id!==ID||sent.status!=='SUCCEEDED')throw Error('RECOVERY_SEND_NOT_VERIFIED');
  stdout.write('RECOVERY_WEIXIN_API_ACCEPTED calls=1. Confirm receipt on the phone; no auto retry.\n');
 }finally{rl?.close();secret?.fill(0);web.close();store.close();}
}
try{await main();}catch(err){
 const code=err?.message||'RECOVERY_FAILED';
 console.error(/^[A-Z0-9_:-]{1,140}$/.test(code)?code:'RECOVERY_FAILED');
 process.exitCode=1;
}
