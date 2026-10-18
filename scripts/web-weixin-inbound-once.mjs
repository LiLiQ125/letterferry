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
import {CHALLENGE_PREFIX,APPROVAL_RECEIVE,verifyWebHostHealth,requireDisabledBinding,assertOnlySucceeded,oneShotWindowAction,persistOneShotBatch} from '../src/web-weixin-once-policy.mjs';
import {durableStartupBatch} from '../src/always-on-policy.mjs';
import {acquireWebSessionLock} from '../src/web-session-lock.mjs';
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
  const releaseOneShotLock=acquireWebSessionLock(resolve('data/weixin-one-shot.lock'));
  let store,lifecycleTransport=null,lifecycleStarted=false;
  const rl=createInterface({input:stdin,output:stdout});
  try{
    const auth=await authStore.load();
    store=new AdapterStore(resolve('data/adapter.sqlite'));
    assertOnlySucceeded(store.list());
    const challenge=(natural?NATURAL_PREFIX:CHALLENGE_PREFIX)+randomBytes(12).toString('hex').toUpperCase();
    stdout.write('ONE-SHOT WEB WEIXIN INBOUND ONLY. This will arm a bounded 90-second receive window before you send the fresh challenge.\n');
    stdout.write('NO Weixin outbound will be sent. Do NOT send the challenge until the terminal prints WEIXIN_LISTENER_ARMED.\n');
    const approval=await rl.question('Type '+APPROVAL_RECEIVE+' to arm the listener (anything else cancels): ');
    if(approval!==APPROVAL_RECEIVE){stdout.write('CANCELLED_BEFORE_WEIXIN_POLL\n');return;}
    await webReady();
    assertOnlySucceeded(store.list());
    lifecycleTransport=new RealWeixinTransport({
      authStore,allowedPeer:binding,inboundEnabled:true,outboundEnabled:false
    });
    await lifecycleTransport.notifyStart();
    lifecycleStarted=true;
    stdout.write('WEIXIN_NOTIFY_START_OK\n');

    let shadowCursor=auth.cursor||'';
    const shadowAuthStore={
      async load(){return {...auth,cursor:shadowCursor};},
      async updateCursor(cursor){
        if(typeof cursor!=='string'||!cursor)throw Error('ONE_SHOT_SHADOW_CURSOR_INVALID');
        shadowCursor=cursor;
      }
    };
    const transport=new RealWeixinTransport({
      authStore:shadowAuthStore,allowedPeer:binding,inboundEnabled:true,outboundEnabled:false
    });
    const bridge=new ExistingBridgeClient({origin:process.env.CHATGPT_BRIDGE_ORIGIN,
      fetchImpl:(url,options)=>fetch(url,{...options,signal:AbortSignal.timeout(8000)})});
    const adapter=new WeixinBridgeAdapter({accountId:auth.accountId,
      policy:new AllowlistPolicy({accountId:auth.accountId,allowedPeers:[binding]}),
      store,bridge,transport,encryptionKey:key});

    const receiveDeadline=Date.now()+90_000;
    const maxPolls=6;
    let pollCount=0,challengeShown=false,persisted=null;
    while(!persisted && pollCount<maxPolls && Date.now()<receiveDeadline){
      pollCount++;
      const remaining=Math.max(1,receiveDeadline-Date.now());
      const pollTimeout=Math.min(45_000,remaining);
      let markArmed;
      const armed=new Promise(resolveArmed=>{markArmed=resolveArmed;});
      const pollPromise=transport.pollDetailed({
        timeoutMs:pollTimeout,
        onRequestStarted:()=>markArmed()
      });
      await Promise.race([
        armed,
        pollPromise.then(()=>{throw Error('WEIXIN_LISTENER_ENDED_BEFORE_ARM');})
      ]);

      if(!challengeShown){
        challengeShown=true;
        stdout.write('WEIXIN_LISTENER_ARMED. A bounded receive window is active; clean server_empty responses will re-arm automatically.\n');
        if(natural){
          stdout.write('Send ONE new paired Weixin DM starting with this prefix, one space, then your real question (up to '+NATURAL_MAX_LENGTH+' characters):\n');
          stdout.write(challenge+'\n');
          stdout.write('Only the question content (not the prefix) will be forwarded to the bound ChatGPT conversation.\n');
        }else{
          stdout.write('Send this exact test text in the ALREADY PAIRED Weixin Bot DM NOW:\n'+challenge+'\n');
        }
      }else{
        stdout.write('WEIXIN_LISTENER_REARMED poll='+pollCount+'\n');
      }

      const detailed=await pollPromise;
      stdout.write('GETUPDATES_OUTCOME='+detailed.outcome+
        ' poll='+pollCount+
        ' elapsed_ms='+detailed.elapsedMs+
        ' http_status='+(detailed.httpStatus??'none')+
        ' ret='+(detailed.ret??'none')+
        ' errcode='+(detailed.errcode??'none')+
        ' errmsg_category='+detailed.errmsgCategory+
        ' cursor_present='+detailed.cursorPresent+
        ' cursor_changed='+detailed.cursorChanged+
        ' raw_messages='+detailed.rawReceivedCount+
        ' paired_messages='+detailed.messages.length+'\n');

      const action=oneShotWindowAction(detailed);
      if(action==='REARM_AFTER_SERVER_EMPTY'){
        await transport.commitPoll();
        if(pollCount<maxPolls && Date.now()<receiveDeadline){
          stdout.write('SERVER_EMPTY_REARMING_WITHIN_AUTHORIZED_WINDOW local_persisted_cursor_unchanged=true\n');
          continue;
        }
        break;
      }
      if(action==='STOP_CLIENT_TIMEOUT')throw Error('ONE_SHOT_GETUPDATES_CLIENT_TIMEOUT_NO_LOCAL_CURSOR_COMMIT');
      if(action==='STOP_ERROR')throw Error('ONE_SHOT_GETUPDATES_ERROR_'+String(detailed.errorCategory||'UNKNOWN').toUpperCase());
      if(action==='STOP_UNEXPECTED')throw Error('ONE_SHOT_GETUPDATES_UNEXPECTED_OUTCOME');
      if(detailed.rawReceivedCount>0 && detailed.messages.length===0)
        throw Error('ONE_SHOT_RAW_MESSAGES_WITHOUT_PAIRED_DM_NO_LOCAL_CURSOR_COMMIT');

      try{
        persisted=persistOneShotBatch({
          store,adapter,updates:detailed.messages,challenge,accountId:auth.accountId,peer:binding
        });
      }catch(error){
        if(['CHALLENGE_NOT_RECEIVED_NO_CURSOR_CHANGE','CHALLENGE_NOT_IN_BATCH_WITH_BACKLOG_NO_CURSOR_CHANGE'].includes(error?.message)){
          const archived=durableStartupBatch({
            store,adapter,updates:detailed.messages,accountId:auth.accountId,peer:binding
          });
          await transport.commitPoll();
          if(detailed.nextCursor)await authStore.updateCursor(detailed.nextCursor);
          stdout.write('PAIRED_DMS_DURABLY_DEFERRED_BEFORE_REARM total='+archived.total+
            ' newly_deferred='+archived.newlyDeferred+' existing='+archived.alreadyStored+'\n');
          if(!detailed.nextCursor)throw Error('ONE_SHOT_BACKLOG_STAGED_WITHOUT_CURSOR_STOP');
          if(pollCount<maxPolls && Date.now()<receiveDeadline)continue;
          break;
        }
        throw error;
      }

      await transport.commitPoll();
      if(detailed.nextCursor)await authStore.updateCursor(detailed.nextCursor);
      stdout.write('ONE_SHOT_BATCH_DURABLY_PERSISTED total='+persisted.total+
        ' backlog_deferred='+persisted.deferredNew+
        ' backlog_existing='+persisted.existingSafe+
        ' local_cursor_commit_attempted='+detailed.cursorPresent+'\n');
    }
    if(!persisted)throw Error('ONE_SHOT_RECEIVE_WINDOW_EXPIRED_NO_CHALLENGE');
    const queued=await adapter.submitOneToBridge();
    if(queued?.id!==persisted.challengeEvent.id||queued?.status!=='BRIDGE_QUEUED')throw Error('ONE_SHOT_BRIDGE_NOT_QUEUED');
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
    try{releaseOneShotLock();}catch{}
    key.fill(0);
  }
}
try{await main();}catch(e){const s=e?.message||'';console.error(/^[A-Z0-9_:-]{1,140}$/.test(s)?s:'ONE_SHOT_INBOUND_FAILED');process.exitCode=1;}