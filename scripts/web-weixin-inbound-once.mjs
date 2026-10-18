import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import {stdin,stdout} from 'node:process';
import {createInterface} from 'node:readline/promises';
import {ProtectedAuthStore} from '../src/auth-store.mjs';
import {RealWeixinTransport} from '../src/transports/real-weixin.mjs';
import {AllowlistPolicy} from '../src/policy.mjs';
import {AdapterStore} from '../src/store.mjs';
import {ExistingBridgeClient} from '../src/bridge-client.mjs';
import {WeixinBridgeAdapter} from '../src/adapter.mjs';
import {loadEncryptionKey} from '../src/secrets.mjs';
import {CHALLENGE_PREFIX,APPROVAL_RECEIVE,verifyWebHostHealth,requireDisabledBinding,assertOnlySucceeded,pollChallengeWithGrace,commitKnownSafeCursor} from '../src/web-weixin-once-policy.mjs';
import {hasVerifiedBrowserSmoke} from './verify-web-smoke-history.mjs';
import {NATURAL_PREFIX,NATURAL_MAX_LENGTH} from '../src/natural-once.mjs';

const INTERVAL_MS=2000,REPLY_WAIT_MS=210000;
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
async function webReady(){
  const resp=await fetch('http://127.0.0.1:8799/health',{signal:AbortSignal.timeout(4000)});
  if(!resp.ok)throw Error('WEB_HOST_UNAVAILABLE');
  verifyWebHostHealth(await resp.json());
}
async function main(){
  if(!stdin.isTTY||!stdout.isTTY)throw Error('FOREGROUND_TTY_REQUIRED');
  const natural=process.argv.includes('--natural');
  const binding=requireDisabledBinding(JSON.parse(readFileSync(resolve('data/weixin-runtime.json'),'utf8')));
  if(!hasVerifiedBrowserSmoke())throw Error('WEB_SMOKE_VERIFICATION_REQUIRED');
  await webReady();
  const key=loadEncryptionKey();
  const authStore=new ProtectedAuthStore();
  let store,lifecycleTransport=null,lifecycleStarted=false;
  const rl=createInterface({input:stdin,output:stdout});
  try{
    const auth=await authStore.load();
    store=new AdapterStore(resolve('data/adapter.sqlite'));
    assertOnlySucceeded(store.list());
    const challenge=(natural?NATURAL_PREFIX:CHALLENGE_PREFIX)+randomBytes(12).toString('hex').toUpperCase();
    stdout.write('ONE-SHOT WEB WEIXIN INBOUND ONLY. This will contact Weixin once and send exactly one authorized test input to your bound ChatGPT tab.\n');
    stdout.write('NO Weixin outbound will be sent. Other unprocessed DM messages will be preserved; they will not be sent to ChatGPT.\n');
    if(natural){
      stdout.write('Send ONE new paired Weixin DM starting with the following verification prefix, a SINGLE SPACE, then your real question (up to '+NATURAL_MAX_LENGTH+' characters).\n');
      stdout.write('Paste prefix only as the beginning of the message; append one space and your own question: '+challenge+'\n');
      stdout.write('Only the question content (not the prefix) will be forwarded to the bound ChatGPT conversation.\n');
    }else stdout.write('Send this exact test text in the ALREADY PAIRED Weixin Bot DM, then come back to the terminal:\n'+challenge+'\n');
    const approval=await rl.question('After sending that one DM, type '+APPROVAL_RECEIVE+' (anything else cancels): ');
    if(approval!==APPROVAL_RECEIVE){stdout.write('CANCELLED_BEFORE_WEIXIN_POLL\n');return;}
    await webReady();
    assertOnlySucceeded(store.list());
    lifecycleTransport=new RealWeixinTransport({
      authStore,allowedPeer:binding,inboundEnabled:true,outboundEnabled:false
    });
    await lifecycleTransport.notifyStart();
    lifecycleStarted=true;
    stdout.write('WEIXIN_NOTIFY_START_OK\n');
    // The newly sent DM can take a few seconds to become visible to getupdates.
    // Retry only a completely empty/foreign-only miss. Each failed attempt uses
    // a fresh transport from the original durable cursor and is discarded
    // without commit, so no upstream cursor or unread DM can be consumed.
    const polled=await pollChallengeWithGrace({
      transportFactory:()=>new RealWeixinTransport({
        authStore,allowedPeer:binding,inboundEnabled:true,outboundEnabled:false
      }),
      challenge,accountId:auth.accountId,peer:binding,
      findStoredInbound:inboundKey=>store.getByInboundKey(inboundKey),
      attempts:3,delayMs:1500,
      sleep:async ms=>{stdout.write('CHALLENGE_NOT_VISIBLE_YET. Waiting '+ms+'ms without cursor commit.\n');await sleep(ms);}
    });
    const {transport,plan}=polled;
    stdout.write('CHALLENGE_POLL_ATTEMPTS='+polled.attempt+'\n');
    stdout.write('SAFE_BATCH_COUNTS other_allowed='+plan.additionalAllowedCount+
      ' still_unrecorded='+plan.unrecordedAllowedCount+
      ' cursor_commit_allowed='+plan.canAdvanceCursor+'\n');
    const raw=plan.challengeRaw;
    const bridge=new ExistingBridgeClient({origin:process.env.CHATGPT_BRIDGE_ORIGIN,
      fetchImpl:(url,options)=>fetch(url,{...options,signal:AbortSignal.timeout(8000)})});
    const adapter=new WeixinBridgeAdapter({accountId:auth.accountId,
      policy:new AllowlistPolicy({accountId:auth.accountId,allowedPeers:[binding]}),
      store,bridge,transport,encryptionKey:key});
    const ingested=adapter.ingestRaw(raw);
    if(!ingested.accepted||ingested.event.status!=='RECEIVED')throw Error('NEW_CHALLENGE_WAS_NOT_INGESTED');
    await commitKnownSafeCursor(transport,plan);
    if(!plan.canAdvanceCursor) stdout.write('CURSOR_WITHHELD_TO_PRESERVE_UNREAD_WEIXIN_DMS. Future polling may encounter this challenge again; SQLite deduplication applies.\n');
    const queued=await adapter.submitOneToBridge();
    if(queued?.id!==ingested.event.id||queued?.status!=='BRIDGE_QUEUED')throw Error('ONE_SHOT_BRIDGE_NOT_QUEUED');
    stdout.write('WEIXIN_ONE_INBOUND_ACCEPTED_AND_CHATGPT_QUEUED. Waiting for the browser reply (no Weixin outbound).\n');
    const deadline=Date.now()+REPLY_WAIT_MS;
    while(Date.now()<deadline){
      const found=await adapter.collectOneReply();
      if(found?.status==='REPLY_READY'){
        if(typeof store.getPrivate(found.id)?.reply_text!=='string' || !store.getPrivate(found.id).reply_text.trim())
          throw Error('ONE_SHOT_EMPTY_REPLY');
        if(store.getPrivate(found.id).reply_text.length>2000)throw Error('ONE_SHOT_REPLY_TOO_LONG');
        stdout.write('ONE_SHOT_READY_FOR_OWNER_REVIEW. Reply held locally; Weixin outbound calls=0.\n');
        return;
      }
      await sleep(INTERVAL_MS);
    }
    throw Error('CHATGPT_REPLY_NOT_CONFIRMED_REVIEW_BEFORE_RETRY');
  }finally{
    if(lifecycleStarted){
      try{await lifecycleTransport.notifyStop();stdout.write('WEIXIN_NOTIFY_STOP_OK\n');}
      catch{stdout.write('WEIXIN_NOTIFY_STOP_FAILED_IGNORED\n');}
    }
    rl.close();
    store?.close();
    key.fill(0);
  }
}
try{await main();}catch(e){const s=e?.message||'';console.error(/^[A-Z0-9_:-]{1,140}$/.test(s)?s:'ONE_SHOT_INBOUND_FAILED');process.exitCode=1;}
