import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ImageDeliveryJournal,createExperimentalBrowserAckAdapter} from '../src/image-delivery-journal.mjs';

const ACCOUNT='owner-account';
const USER='authorized-peer';
const URL='https://chatgpt.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DIGEST='a'.repeat(64);
const EMPTY_DIGEST='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const RESPONSE_DIGEST='b'.repeat(64);
const PRIVATE='PRIVATE_IMAGE_BYTES_MUST_NOT_APPEAR';

function fixture({file,clock}={}){
  const dir=file?null:mkdtempSync(join(tmpdir(),'riven-image-delivery-'));
  const filename=file||join(dir,'journal.sqlite');
  const state=clock||{now:10_000};
  const journal=new ImageDeliveryJournal({filename,accountId:ACCOUNT,
    allowedPeer:{userId:USER,chatId:USER},boundUrl:URL,attemptTtlMs:60_000,now:()=>state.now});
  return {dir,filename,state,journal,cleanup(){journal.close();if(dir)rmSync(dir,{recursive:true,force:true});}};
}

function claim(messageId='message-1'){
  return {accountId:ACCOUNT,fromUserId:USER,chatId:USER,messageId,
    receiptId:'receipt-'+messageId,digest:DIGEST,mimeType:'image/png',size:37,fileName:'wechat-image.png',
    boundUrl:URL,browserEventId:'browser-event-'+messageId,
    claimEvidence:{claimId:'claim-'+messageId,claimedMs:9000,receiptStatus:'CLAIMED'},
    composerEvidence:{snapshotId:'composer-'+messageId,capturedMs:9500,textLength:0,textDigest:EMPTY_DIGEST},
    conversationEvidence:{snapshotId:'conversation-'+messageId,capturedMs:9500,
      lastUserTurnId:'prior-user-'+messageId,lastAssistantTurnId:'prior-assistant-'+messageId}};
}

function packet(issued,evidence,overrides={}){
  const a=issued.attempt;
  return {attemptId:a.attemptId,proofNonce:issued.proofNonce,accountId:a.accountId,fromUserId:a.fromUserId,
    chatId:a.chatId,messageId:a.messageId,receiptId:a.receiptId,digest:a.digest,boundUrl:a.boundUrl,
    browserEventId:a.browserEventId,evidence,...overrides};
}
function httpEvidence(a){return {httpRequestId:'http-request-001',responseEndedMs:10_500,receiptId:a.receiptId,
  messageId:a.messageId,boundUrl:a.boundUrl,browserEventId:a.browserEventId,mimeType:a.mimeType,size:a.size,fileName:a.fileName};}
function previewEvidence(a){return {previewId:'preview-identity-001',firstObservedMs:10_600,secondObservedMs:10_900,
  receiptId:a.receiptId,messageId:a.messageId,boundUrl:a.boundUrl,browserEventId:a.browserEventId,
  composerSnapshotId:'composer-'+a.messageId,uploadState:'READY_STABLE',mimeType:a.mimeType,size:a.size,fileName:a.fileName};}
function submissionEvidence(a){return {submissionId:'submission-identity-001',submittedMs:11_000,receiptId:a.receiptId,
  messageId:a.messageId,boundUrl:a.boundUrl,browserEventId:a.browserEventId,previewId:'preview-identity-001',
  composerSnapshotId:'composer-'+a.messageId,submitControlId:'send-control-001',action:'ONE_TIME_IMAGE_SUBMIT'};}
function finalEvidence(a){return {submissionId:'submission-identity-001',receiptId:a.receiptId,messageId:a.messageId,
  boundUrl:a.boundUrl,browserEventId:a.browserEventId,userTurnId:'new-user-turn-001',userTurnObservedMs:11_100,
  imageReceiptId:a.receiptId,assistantTurnId:'new-assistant-turn-001',assistantResponseDigest:RESPONSE_DIGEST,
  assistantFirstObservedMs:11_200,assistantSecondObservedMs:12_300,responseState:'STABLE_COMPLETE'};}
function advanceToSubmission(f,issued){
  const adapter=createExperimentalBrowserAckAdapter(f.journal),a=issued.attempt;
  f.state.now=10_500;adapter.recordHttpResponse(packet(issued,httpEvidence(a)));
  f.state.now=10_900;adapter.recordStablePreview(packet(issued,previewEvidence(a)));
  f.state.now=11_000;adapter.recordSubmission(packet(issued,submissionEvidence(a)));
  return adapter;
}

test('fake evidence progresses through every layer but final ACK remains explicitly non-authoritative',()=>{
  const f=fixture();
  try{
    const issued=f.journal.beginClaim(claim());
    assert.match(issued.attempt.attemptId,/^[A-Za-z0-9_-]{32}$/);
    assert.match(issued.proofNonce,/^[A-Za-z0-9_-]{43}$/);
    const adapter=advanceToSubmission(f,issued);
    f.state.now=12_300;
    const result=adapter.recordFinalAck(packet(issued,finalEvidence(issued.attempt)));
    assert.equal(result.status,'FINAL_ACK_RECORDED_EXPERIMENTAL');
    assert.equal(result.authority,'EXPERIMENTAL_CALLER_ASSERTED_ONLY');
    assert.equal(result.authoritativeDelivery,false);
    assert.equal(result.cursorEligible,false);
    assert.equal(result.automaticRetryAllowed,false);
    assert.deepEqual(f.journal.listEvidence(result.attemptId).map(item=>item.kind),
      ['CLAIM','HTTP_RESPONSE','PREVIEW','SUBMISSION','FINAL_ACK']);
  }finally{f.cleanup();}
});

test('account, peer, conversation, event and proof bindings cannot cross attempts',()=>{
  const f=fixture();
  try{
    assert.throws(()=>f.journal.beginClaim({...claim(),accountId:'other'}),/IMAGE_DELIVERY_UNAUTHORIZED/);
    assert.throws(()=>f.journal.beginClaim({...claim(),fromUserId:'other',chatId:'other'}),/IMAGE_DELIVERY_UNAUTHORIZED/);
    assert.throws(()=>f.journal.beginClaim({...claim(),boundUrl:'https:\/\/chatgpt.com\/c\/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}),/BINDING_INVALID/);
    const issued=f.journal.beginClaim(claim());
    f.state.now=10_500;
    for(const [change,code] of [
      [{accountId:'other'},'IDENTITY_MISMATCH'],[{boundUrl:'https://chatgpt.com/c/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'},'CONVERSATION_MISMATCH'],
      [{browserEventId:'other-event'},'EVENT_MISMATCH'],[{proofNonce:'x'.repeat(43)},'PROOF_INVALID']])
      assert.throws(()=>f.journal.recordHttpResponse(packet(issued,httpEvidence(issued.attempt),change)),new RegExp(code));
    assert.equal(f.journal.getAttempt(issued.attempt.attemptId).status,'CLAIM_RECORDED');
  }finally{f.cleanup();}
});

test('human drafts and vague boolean success evidence fail before journal creation',()=>{
  const f=fixture();
  try{
    const draft=claim();draft.composerEvidence={...draft.composerEvidence,textLength:7,textDigest:'c'.repeat(64)};
    assert.throws(()=>f.journal.beginClaim(draft),/IMAGE_DELIVERY_HUMAN_DRAFT_PRESENT/);
    const issued=f.journal.beginClaim(claim());
    f.state.now=10_500;
    assert.throws(()=>f.journal.recordHttpResponse(packet(issued,{success:true})),/IMAGE_DELIVERY_EVIDENCE_INVALID/);
    assert.equal(f.journal.listEvidence(issued.attempt.attemptId).length,1);
  }finally{f.cleanup();}
});

test('out-of-order, duplicate and unstable preview evidence fail closed without final promotion',()=>{
  const f=fixture();
  try{
    const issued=f.journal.beginClaim(claim()),a=issued.attempt;
    f.state.now=10_900;
    assert.throws(()=>f.journal.recordStablePreview(packet(issued,previewEvidence(a))),/STATE_CONFLICT/);
    f.state.now=10_500;f.journal.recordHttpResponse(packet(issued,httpEvidence(a)));
    assert.throws(()=>f.journal.recordHttpResponse(packet(issued,httpEvidence(a))),/STATE_CONFLICT/);
    f.state.now=10_900;
    assert.throws(()=>f.journal.recordStablePreview(packet(issued,{...previewEvidence(a),secondObservedMs:10_700})),/PREVIEW_NOT_STABLE/);
    const preview=f.journal.recordStablePreview(packet(issued,previewEvidence(a)));
    assert.equal(preview.status,'PREVIEW_RECORDED');
    assert.equal(preview.authoritativeDelivery,false);
  }finally{f.cleanup();}
});

test('wrong receipt, turn, submission or weak assistant stability cannot create a final ACK',()=>{
  const f=fixture();
  try{
    const issued=f.journal.beginClaim(claim());advanceToSubmission(f,issued);f.state.now=12_300;
    const a=issued.attempt;
    for(const change of [{imageReceiptId:'receipt-other'},{submissionId:'submission-other'},
      {userTurnId:'prior-user-message-1'},{assistantTurnId:'prior-assistant-message-1'},
      {assistantSecondObservedMs:11_500}])
      assert.throws(()=>f.journal.recordFinalAck(packet(issued,{...finalEvidence(a),...change})),
        /IMAGE_DELIVERY_(EVIDENCE_MISMATCH|FINAL_ACK_NOT_STABLE)/);
    assert.equal(f.journal.getAttempt(a.attemptId).status,'SUBMISSION_RECORDED');
  }finally{f.cleanup();}
});

test('restart seals every unfinished attempt as uncertain and forbids replay or a second receipt attempt',()=>{
  const dir=mkdtempSync(join(tmpdir(),'riven-image-delivery-restart-')),file=join(dir,'journal.sqlite');
  const state={now:10_000};
  let f=fixture({file,clock:state});
  const issued=f.journal.beginClaim(claim());
  f.journal.close();state.now=10_100;f=fixture({file,clock:state});
  try{
    const recovered=f.journal.getAttempt(issued.attempt.attemptId);
    assert.equal(recovered.status,'DELIVERY_UNKNOWN');
    assert.equal(recovered.lastError,'IMAGE_DELIVERY_RESTART_UNCERTAIN');
    state.now=10_500;
    assert.throws(()=>f.journal.recordHttpResponse(packet(issued,httpEvidence(issued.attempt))),/STATE_CONFLICT/);
    assert.throws(()=>f.journal.beginClaim(claim()),/IMAGE_DELIVERY_ATTEMPT_CONFLICT/);
  }finally{f.journal.close();rmSync(dir,{recursive:true,force:true});}
});

test('lost browser ACK after one-time submission becomes durable unknown after restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'riven-image-delivery-lost-')),file=join(dir,'journal.sqlite');
  const state={now:10_000};let f=fixture({file,clock:state});
  const issued=f.journal.beginClaim(claim());advanceToSubmission(f,issued);f.journal.close();
  state.now=11_100;f=fixture({file,clock:state});
  try{
    assert.equal(f.journal.getAttempt(issued.attempt.attemptId).status,'DELIVERY_UNKNOWN');
    assert.throws(()=>f.journal.recordFinalAck(packet(issued,finalEvidence(issued.attempt))),/STATE_CONFLICT/);
  }finally{f.journal.close();rmSync(dir,{recursive:true,force:true});}
});

test('timeout and explicit interrupted response are visible unknown states with no replay path',()=>{
  const f=fixture();
  try{
    const first=f.journal.beginClaim(claim('timeout-message'));
    f.state.now=70_000;assert.equal(f.journal.markTimedOut(),1);
    assert.equal(f.journal.getAttempt(first.attempt.attemptId).lastError,'IMAGE_DELIVERY_TIMEOUT_UNCERTAIN');
    f.state.now=71_000;
    const second=f.journal.beginClaim({...claim('unknown-message'),
      claimEvidence:{claimId:'claim-unknown-message',claimedMs:70_500,receiptStatus:'CLAIMED'},
      composerEvidence:{snapshotId:'composer-unknown-message',capturedMs:70_500,textLength:0,textDigest:EMPTY_DIGEST},
      conversationEvidence:{snapshotId:'conversation-unknown-message',capturedMs:70_500,lastUserTurnId:null,lastAssistantTurnId:null}});
    const a=second.attempt;
    const unknown=f.journal.recordUnknown(packet(second,{reason:'HTTP_RESPONSE_RESULT_UNKNOWN',observedMs:71_000,
      receiptId:a.receiptId,messageId:a.messageId,boundUrl:a.boundUrl,browserEventId:a.browserEventId}));
    assert.equal(unknown.status,'DELIVERY_UNKNOWN');
    assert.equal(unknown.automaticRetryAllowed,false);
  }finally{f.cleanup();}
});

test('two already-open journal instances permit exactly one competing final ACK',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'riven-image-delivery-race-')),file=join(dir,'journal.sqlite'),state={now:10_000};
  const a=fixture({file,clock:state}),b=fixture({file,clock:state});
  try{
    const issued=a.journal.beginClaim(claim());advanceToSubmission(a,issued);state.now=12_300;
    const p=packet(issued,finalEvidence(issued.attempt));
    const outcomes=await Promise.allSettled([Promise.resolve().then(()=>a.journal.recordFinalAck(p)),
      Promise.resolve().then(()=>b.journal.recordFinalAck(p))]);
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
    assert.equal(a.journal.getAttempt(issued.attempt.attemptId).status,'FINAL_ACK_RECORDED_EXPERIMENTAL');
  }finally{a.journal.close();b.journal.close();rmSync(dir,{recursive:true,force:true});}
});

test('evidence insert failure rolls the state transition back atomically with a fixed error',()=>{
  const f=fixture();
  try{
    const issued=f.journal.beginClaim(claim());
    const db=new DatabaseSync(f.filename);
    db.exec(`CREATE TRIGGER reject_http BEFORE INSERT ON image_delivery_evidence
      WHEN NEW.kind='HTTP_RESPONSE' BEGIN SELECT RAISE(ABORT,'private sqlite detail'); END;`);
    db.close();f.state.now=10_500;
    assert.throws(()=>f.journal.recordHttpResponse(packet(issued,httpEvidence(issued.attempt))),
      /^Error: IMAGE_DELIVERY_STORAGE_FAILED$/);
    assert.equal(f.journal.getAttempt(issued.attempt.attemptId).status,'CLAIM_RECORDED');
    assert.deepEqual(f.journal.listEvidence(issued.attempt.attemptId).map(item=>item.kind),['CLAIM']);
  }finally{f.cleanup();}
});

test('journal files and public results contain no image bytes, secret key, proof nonce or cursor authority',()=>{
  const f=fixture();
  try{
    const issued=f.journal.beginClaim(claim());
    const publicJson=JSON.stringify(issued.attempt);
    assert.equal(publicJson.includes(PRIVATE),false);
    assert.equal(publicJson.includes(issued.proofNonce),false);
    assert.equal('cursor' in issued.attempt,false);
    f.journal.close();
    for(const name of readdirSync(f.dir)){
      const text=readFileSync(join(f.dir,name)).toString('utf8');
      assert.equal(text.includes(PRIVATE),false,name);
      assert.equal(text.includes(issued.proofNonce),false,name);
    }
  }finally{rmSync(f.dir,{recursive:true,force:true});}
});
