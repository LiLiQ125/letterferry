import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {stdin,stdout} from 'node:process';
import {createInterface} from 'node:readline/promises';
import {ProtectedAuthStore} from '../src/auth-store.mjs';
import {RealWeixinTransport} from '../src/transports/real-weixin.mjs';
import {AllowlistPolicy} from '../src/policy.mjs';
import {AdapterStore} from '../src/store.mjs';
import {WeixinBridgeAdapter} from '../src/adapter.mjs';
import {loadEncryptionKey} from '../src/secrets.mjs';
import {APPROVAL_SEND,requireDisabledBinding,selectOneReviewedReply} from '../src/web-weixin-once-policy.mjs';

async function main(){
  if(!stdin.isTTY||!stdout.isTTY)throw Error('FOREGROUND_TTY_REQUIRED');
  const binding=requireDisabledBinding(JSON.parse(readFileSync(resolve('data/weixin-runtime.json'),'utf8')));
  const cryptoKey=loadEncryptionKey();
  const authStore=new ProtectedAuthStore();
  let store;
  const rl=createInterface({input:stdin,output:stdout});
  try{
    const auth=await authStore.load();
    store=new AdapterStore(resolve('data/adapter.sqlite'));
    const target=selectOneReviewedReply(store.list(),binding);
    const privateRow=store.getPrivate(target.id);
    if(typeof privateRow?.reply_text!=='string'||!privateRow.reply_text.trim()||
       privateRow.reply_text.length>2000)throw Error('ONE_SHOT_REPLY_NOT_SAFE');
    stdout.write('ONE-SHOT WEIXIN OUTBOUND REVIEW. There is exactly ONE locally saved reply for the paired private DM.\n');
    stdout.write('First inspect the actual ChatGPT assistant response in the selected browser tab.\n');
    stdout.write('This will send exactly ONE message to the previously paired Weixin DM. No retry if the Weixin API result is ambiguous.\n');
    const answer=await rl.question('ONLY after reviewing that reply, type '+APPROVAL_SEND+' (anything else cancels): ');
    if(answer!==APPROVAL_SEND){stdout.write('CANCELLED_NO_WEIXIN_SEND\n');return;}
    const fresh=selectOneReviewedReply(store.list(),binding);
    if(fresh.id!==target.id)throw Error('ONE_SHOT_EVENT_CHANGED');
    const transport=new RealWeixinTransport({authStore,allowedPeer:binding,
      inboundEnabled:false,outboundEnabled:true});
    const adapter=new WeixinBridgeAdapter({accountId:auth.accountId,
      policy:new AllowlistPolicy({accountId:auth.accountId,allowedPeers:[binding]}),
      store,transport,bridge:null,encryptionKey:cryptoKey});
    const sent=await adapter.sendOneReply();
    if(sent?.id!==target.id||sent.status!=='SUCCEEDED')throw Error('ONE_SHOT_WEIXIN_SEND_UNVERIFIED');
    stdout.write('ONE_SHOT_WEIXIN_API_ACCEPTED. Outbound calls=1. Verify phone delivery yourself. Persistent permission flags unchanged.\n');
  }finally{rl.close();store?.close();cryptoKey.fill(0);}
}
try{await main();}catch(e){const s=e?.message||'';console.error(/^[A-Z0-9_:-]{1,140}$/.test(s)?s:'ONE_SHOT_WEIXIN_SEND_FAILED');process.exitCode=1;}
