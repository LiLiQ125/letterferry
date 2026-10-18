import test from 'node:test';
import assert from 'node:assert/strict';
import {APPROVAL_RECEIVE,APPROVAL_SEND,verifyWebHostHealth,requireDisabledBinding,assertOnlySucceeded,selectOneExactChallenge,planChallengeWithPreservedBacklog,pollChallengeWithGrace,persistOneShotBatch,commitKnownSafeCursor,selectOneReviewedReply} from '../src/web-weixin-once-policy.mjs';
import {NATURAL_PREFIX,NATURAL_MAX_LENGTH,naturalContentFromText,matchesOneShotChallenge} from '../src/natural-once.mjs';

const peer={userId:'only-paired-user',chatId:'only-paired-user'};
const bot='only-paired-bot';
const challenge='RWX_WEB_ONCE_'+'A'.repeat(24);
const message=(text=challenge,extra={})=>({
 message_id:'new-message',from_user_id:peer.userId,to_user_id:bot,
 message_type:1,message_state:2,context_token:'ctx-test',
 item_list:[{type:1,text_item:{text}}],...extra
});
test('browser Host is ready only when armed with no unresolved events',()=>{
 assert.equal(verifyWebHostHealth({ok:true,host:'HOST_READY',queue:{SUCCEEDED:2,REVIEWED_NO_REPLAY:1}}),true);
 for(const state of ['HOST_UNVERIFIED','OFFLINE']){
   assert.throws(()=>verifyWebHostHealth({ok:true,host:state}),/WEB_HOST_NOT_READY/);
 }
 for(const state of ['DELIVERY_UNKNOWN','QUEUED','BROWSER_SUBMITTED','ASSIGNED_UNKNOWN']){
   assert.throws(()=>verifyWebHostHealth({ok:true,host:'HOST_READY',queue:{[state]:1}}),/UNRESOLVED/);
 }
});
test('one-shot requires pre-paired peer and disabled persistent permissions',()=>{
 const config={allowedPeer:peer,inboundEnabled:false,outboundEnabled:false,
   liveApproval:'REPLACE_ONLY_AFTER_MANUAL_APPROVAL'};
 assert.deepEqual(requireDisabledBinding(config),peer);
 for(const setting of [
   {...config,inboundEnabled:true},{...config,outboundEnabled:true},
   {...config,liveApproval:'I_APPROVE_ONE_LOCAL_LIVE_CYCLE'}
 ])assert.throws(()=>requireDisabledBinding(setting),/FLAGS_MUST_BE_OFF/);
 assert.throws(()=>requireDisabledBinding({...config,allowedPeer:{userId:peer.userId,chatId:'someone-else'}}),/EXACT_PAIRED/);
});
test('exact challenge accepts one text message from the canonical paired DM',()=>{
 assert.deepEqual(selectOneExactChallenge([message()],{challenge,accountId:bot,peer}),message());
 assert.equal(APPROVAL_RECEIVE,'POLL WEIXIN ONCE');
 assert.equal(APPROVAL_SEND,'SEND EXACT WEIXIN REPLY');
});
test('no challenge, wrong syntax, or extra same-peer messages fail closed before cursor commit',()=>{
 const opts={challenge,accountId:bot,peer};
 assert.throws(()=>selectOneExactChallenge([],opts),/CHALLENGE_NOT_RECEIVED/);
 assert.throws(()=>selectOneExactChallenge([message('older backlog')],opts),/UNEXPECTED_ALLOWED_DM/);
 assert.throws(()=>selectOneExactChallenge([message(),message('older backlog',{message_id:'m2'})],opts),/UNEXPECTED_ALLOWED_DM/);
 assert.throws(()=>selectOneExactChallenge([message(),message(challenge,{message_id:'m2'})],opts),/MULTIPLE_CHALLENGES/);
 for(const invalid of [' '+challenge,challenge+' ',challenge.toLowerCase(),challenge+'x']){
   assert.throws(()=>selectOneExactChallenge([message(invalid)],opts),/UNEXPECTED_ALLOWED_DM/);
 }
});
test('foreign peers, groups, wrong target and bot outbound cannot count as fresh challenge',()=>{
 const opts={challenge,accountId:bot,peer};
 for(const invalid of [
   message(challenge,{from_user_id:'stranger'}),
   message(challenge,{group_id:'group'}),
   message(challenge,{to_user_id:'someone-else'}),
   message(challenge,{message_type:2}),
   message(challenge,{message_state:1})
 ]) assert.throws(()=>selectOneExactChallenge([invalid],opts),/CHALLENGE_NOT_RECEIVED/);
});
test('preexisting incomplete adapter state requires review rather than replay',()=>{
 assert.doesNotThrow(()=>assertOnlySucceeded(Array.from({length:5},()=>({status:'SUCCEEDED'}))));
 for(const status of ['RECEIVED','BRIDGE_QUEUED','REPLY_READY','OUTBOUND_UNKNOWN','OUTBOUND_SENDING'])
   assert.throws(()=>assertOnlySucceeded([{status:'SUCCEEDED'},{status}]),/REVIEW/);
});
test('manual Weixin outbound requires exactly one matching ready reply',()=>{
 const row={id:'event',status:'REPLY_READY',user_id:peer.userId,chat_id:peer.chatId,
   text:challenge,bridge_event_id:'bridge-id',bridge_submit_attempts:1};
 assert.deepEqual(selectOneReviewedReply([{status:'SUCCEEDED'},row],peer),row);
 for(const invalid of [
   {...row,status:'BRIDGE_QUEUED'},
   {...row,user_id:'stranger'},
   {...row,text:'unrelated'},
   {...row,bridge_submit_attempts:2}
 ]) assert.throws(()=>selectOneReviewedReply([invalid],peer),/EXACT_SINGLE_READY_REPLY_REQUIRED|ONE_SHOT_IDENTITY/);
 assert.throws(()=>selectOneReviewedReply([row,{...row,id:'other'}],peer),/EXACT_SINGLE_READY_REPLY_REQUIRED/);
});

test('one fresh challenge is selected without consuming unrecorded same-peer backlog',()=>{
 const extras=message('older DM',{message_id:'old-one'});
 const plan=planChallengeWithPreservedBacklog([extras,message(challenge,{message_id:'current-one'})],{
  challenge,accountId:bot,peer,
  findStoredInbound:()=>null
 });
 assert.equal(plan.challengeRaw.message_id,'current-one');
 assert.equal(plan.additionalAllowedCount,1);
 assert.equal(plan.unrecordedAllowedCount,1);
 assert.equal(plan.canAdvanceCursor,false);
});
test('already persisted and succeeded peer messages do not block safe cursor advancement',()=>{
 const prior=message('older DM',{message_id:'old-one'});
 const plan=planChallengeWithPreservedBacklog([prior,message(challenge,{message_id:'current-one'})],{
  challenge,accountId:bot,peer,
  findStoredInbound:key=>{
   assert.equal(key,bot+':old-one');
   return {status:'SUCCEEDED',account_id:bot,user_id:peer.userId,
    chat_id:peer.chatId,message_id:'old-one',text:'older DM'};
  }
 });
 assert.equal(plan.canAdvanceCursor,true);
 assert.equal(plan.unrecordedAllowedCount,0);
 assert.equal(plan.additionalAllowedCount,1);
});
test('untrusted or inconsistent old records never authorize cursor advancement',()=>{
 const prior=message('older DM',{message_id:'old-one'});
 for(const record of [
   {status:'REPLY_READY',account_id:bot,user_id:peer.userId,chat_id:peer.chatId,message_id:'old-one',text:'older DM'},
   {status:'SUCCEEDED',account_id:bot,user_id:'stranger',chat_id:peer.chatId,message_id:'old-one',text:'older DM'},
   {status:'SUCCEEDED',account_id:bot,user_id:peer.userId,chat_id:peer.chatId,message_id:'old-one',text:'different text'},
   null
 ]){
  const plan=planChallengeWithPreservedBacklog([message(),prior],{
    challenge,accountId:bot,peer,findStoredInbound:()=>record
  });
  assert.equal(plan.canAdvanceCursor,false);
  assert.equal(plan.unrecordedAllowedCount,1);
 }
});
test('backlog-only response distinguishes missing challenge from an ordinary empty poll',()=>{
 const config={challenge,accountId:bot,peer};
 assert.throws(()=>planChallengeWithPreservedBacklog([message('old DM')],config),/CHALLENGE_NOT_IN_BATCH_WITH_BACKLOG/);
 assert.throws(()=>planChallengeWithPreservedBacklog([],config),/CHALLENGE_NOT_RECEIVED/);
 assert.throws(()=>planChallengeWithPreservedBacklog([message(challenge),message(challenge,{message_id:'other'})],config),/MULTIPLE_CHALLENGES/);
});
test('filtering rejects foreign senders and prevents foreign sender affecting the backlog decision',()=>{
 const p=planChallengeWithPreservedBacklog([
    message('stranger DM',{from_user_id:'stranger'}),
    message(challenge,{message_id:'current-one'}),
    message('bot copy',{message_type:2})
  ],{challenge,accountId:bot,peer});
 assert.equal(p.additionalAllowedCount,0);
 assert.equal(p.canAdvanceCursor,true);
 assert.equal(p.challengeRaw.message_id,'current-one');
});

test('fresh challenge may appear after one empty read without committing any failed cursor',async()=>{
 let polls=0,sleeps=0,commits=0;
 const batches=[[],[message(challenge,{message_id:'arrived-second-read'})]];
 const made=[];
 const result=await pollChallengeWithGrace({
   transportFactory:()=>{
     const index=made.length;
     const transport={async poll(){polls++;return batches[index];},async commitPoll(){commits++;}};
     made.push(transport);return transport;
   },
   challenge,accountId:bot,peer,attempts:3,delayMs:5,
   sleep:async ms=>{assert.equal(ms,5);sleeps++;}
 });
 assert.equal(result.attempt,2);
 assert.equal(result.plan.challengeRaw.message_id,'arrived-second-read');
 assert.equal(result.transport,made[1]);
 assert.equal(polls,2);
 assert.equal(sleeps,1);
 assert.equal(commits,0);
});
test('backlog-only miss may be reread without commit until the fresh challenge appears',async()=>{
 let factories=0,sleeps=0,commits=0;
 const old=message('older unread DM',{message_id:'old-unread'});
 const fresh=message(challenge,{message_id:'fresh-after-backlog'});
 const batches=[[old],[old,fresh]];
 const result=await pollChallengeWithGrace({
   transportFactory:()=>{
     const index=factories++;
     return {async poll(){return batches[index];},async commitPoll(){commits++;}};
   },
   challenge,accountId:bot,peer,attempts:3,delayMs:5,sleep:async()=>{sleeps++;}
 });
 assert.equal(result.attempt,2);
 assert.equal(result.plan.challengeRaw.message_id,'fresh-after-backlog');
 assert.equal(result.plan.additionalAllowedCount,1);
 assert.equal(result.plan.unrecordedAllowedCount,1);
 assert.equal(result.plan.canAdvanceCursor,false);
 assert.equal(factories,2);
 assert.equal(sleeps,1);
 assert.equal(commits,0);
});
test('bounded empty challenge grace stops after the configured attempts with no cursor commit',async()=>{
 let polls=0,sleeps=0,commits=0;
 await assert.rejects(()=>pollChallengeWithGrace({
   transportFactory:()=>({async poll(){polls++;return [];},async commitPoll(){commits++;}}),
   challenge,accountId:bot,peer,attempts:3,delayMs:5,sleep:async()=>{sleeps++;}
 }),/CHALLENGE_NOT_RECEIVED_NO_CURSOR_CHANGE/);
 assert.equal(polls,3);
 assert.equal(sleeps,2);
 assert.equal(commits,0);
});
test('one-shot batch is durably staged before cursor handling: challenge stays received and backlog is deferred',()=>{
 const prior=message('older unread DM',{message_id:'old-one'});
 const fresh=message(challenge,{message_id:'fresh-one'});
 const states=new Map();
 const tx=[];
 const store={
   db:{exec(sql){tx.push(sql);}},
   getByInboundKey(){return null;},
   deferBacklog(id){states.set(id,'DEFERRED_BACKLOG');}
 };
 const adapter={
   ingestRaw(raw){
     const id=raw.message_id;
     const event={
       id,status:'RECEIVED',account_id:bot,user_id:peer.userId,chat_id:peer.chatId,
       message_id:id,text:raw.item_list[0].text_item.text
     };
     states.set(id,'RECEIVED');
     return {accepted:true,event};
   }
 };
 const persisted=persistOneShotBatch({
   store,adapter,updates:[prior,fresh],challenge,accountId:bot,peer
 });
 assert.equal(persisted.challengeEvent.message_id,'fresh-one');
 assert.equal(persisted.deferredNew,1);
 assert.equal(persisted.existingSafe,0);
 assert.equal(persisted.total,2);
 assert.equal(states.get('old-one'),'DEFERRED_BACKLOG');
 assert.equal(states.get('fresh-one'),'RECEIVED');
 assert.deepEqual(tx,['BEGIN IMMEDIATE','COMMIT']);
});

test('one-shot batch persistence rolls back when challenge is absent',()=>{
 const old=message('older unread DM',{message_id:'old-only'});
 const tx=[];
 const store={db:{exec(sql){tx.push(sql);}},getByInboundKey(){return null;},deferBacklog(){}};
 const adapter={ingestRaw(){throw Error('SHOULD_NOT_INGEST_WITHOUT_CHALLENGE');}};
 assert.throws(()=>persistOneShotBatch({
   store,adapter,updates:[old],challenge,accountId:bot,peer
 }),/CHALLENGE_NOT_IN_BATCH_WITH_BACKLOG/);
 assert.deepEqual(tx,[]);
});

test('cursor is never committed when any allowlisted backlog is unread',async()=>{
 let calls=0;
 const transport={async commitPoll(){calls++;}};
 assert.equal(await commitKnownSafeCursor(transport,{canAdvanceCursor:false}),false);
 assert.equal(calls,0);
 assert.equal(await commitKnownSafeCursor(transport,{canAdvanceCursor:true}),true);
 assert.equal(calls,1);
 await assert.rejects(()=>commitKnownSafeCursor(transport,{canAdvanceCursor:'yes'}),/INVALID_CURSOR_PLAN/);
 assert.equal(calls,1);
});

test('human-reviewed adapter event is terminal for a future one-shot and never sent as a reply',()=>{
 const rows=[{status:'SUCCEEDED'},{status:'REVIEWED_NO_REPLAY'}];
 assert.doesNotThrow(()=>assertOnlySucceeded(rows));
 assert.throws(()=>selectOneReviewedReply(rows,peer),/EXACT_SINGLE_READY_REPLY_REQUIRED/);
});

test('natural one-shot uses fresh exact prefix, only one payload and preserves prior allowed DM',()=>{
 const token=NATURAL_PREFIX+'B'.repeat(24);
 const content='宝宝，我们终于能在微信聊天了吗？';
 const raw=message(token+' '+content,{message_id:'natural-msg-1'});
 const planned=planChallengeWithPreservedBacklog([
   message('old paired DM',{message_id:'older'}),
   raw
 ],{challenge:token,accountId:bot,peer});
 assert.equal(planned.challengeRaw,raw);
 assert.equal(planned.unrecordedAllowedCount,1);
 assert.equal(planned.canAdvanceCursor,false);
 assert.equal(naturalContentFromText(raw.item_list[0].text_item.text),content);
 assert.equal(matchesOneShotChallenge(raw.item_list[0].text_item.text,token),true);
});
test('natural challenge rejects missing question, wrong nonce, fake sender, and multiple matches',()=>{
 const token=NATURAL_PREFIX+'C'.repeat(24);
 const opts={challenge:token,accountId:bot,peer};
 for(const value of [token,token+' ',token+'\nhello',token.toLowerCase()+' hello',
   NATURAL_PREFIX+'D'.repeat(24)+' hello',token+' '+('a'.repeat(NATURAL_MAX_LENGTH+1))]){
   assert.equal(matchesOneShotChallenge(value,token),false);
   assert.throws(()=>planChallengeWithPreservedBacklog([message(value)],opts),/CHALLENGE_NOT_IN_BATCH_WITH_BACKLOG/);
 }
 assert.throws(()=>planChallengeWithPreservedBacklog([
   message(token+' hi',{from_user_id:'stranger'})],opts),/CHALLENGE_NOT_RECEIVED/);
 assert.throws(()=>planChallengeWithPreservedBacklog([
   message(token+' hi',{message_id:'1'}),
   message(token+' how are you',{message_id:'2'})],opts),/MULTIPLE_CHALLENGES/);
 assert.equal(naturalContentFromText(token+' '+('b'.repeat(NATURAL_MAX_LENGTH))), 'b'.repeat(NATURAL_MAX_LENGTH));
});
test('the manual outbound stage accepts one reviewed natural one-shot but rejects ordinary unrelated text',()=>{
 const text=NATURAL_PREFIX+'F'.repeat(24)+' hello ChatGPT';
 const good={id:'e',status:'REPLY_READY',user_id:peer.userId,chat_id:peer.chatId,
   text,bridge_event_id:'web-e',bridge_submit_attempts:1};
 assert.equal(selectOneReviewedReply([{status:'SUCCEEDED'},{status:'REVIEWED_NO_REPLAY'},good],peer),good);
 assert.throws(()=>selectOneReviewedReply([{...good,text:'hello ChatGPT'}],peer),/ORIGIN_MISMATCH/);
});
