import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeInboundHealth} from '../src/weixin-inbound-health.mjs';

const accountId='bot-1';
const peer={userId:'paired-user',chatId:'paired-user'};
const msg=(from_user_id=peer.userId,extra={})=>({
  message_id:'m1',from_user_id,to_user_id:accountId,
  message_type:1,message_state:2,context_token:'ctx',
  item_list:[{type:1,text_item:{text:'sensitive body must not appear in summary'}}],
  ...extra
});

test('empty raw getUpdates batch reports upstream blocked without content',()=>{
  assert.deepEqual(summarizeInboundHealth([],{accountId,peer}),{
    state:'WEIXIN_UPSTREAM_BLOCKED',received:0,envelopeAccepted:0,
    fromPaired:0,pairedAccepted:0,rejected:{}
  });
});

test('accepted paired DM reports inbound available and summary excludes message content',()=>{
  const summary=summarizeInboundHealth([msg()],{accountId,peer});
  assert.equal(summary.state,'WEIXIN_INBOUND_AVAILABLE');
  assert.equal(summary.received,1);
  assert.equal(summary.pairedAccepted,1);
  assert.doesNotMatch(JSON.stringify(summary),/sensitive body/);
});

test('unrelated or rejected traffic never claims paired inbound availability',()=>{
  const summary=summarizeInboundHealth([
    msg('stranger',{message_id:'m2'}),
    msg(peer.userId,{message_id:'m3',group_id:'group'})
  ],{accountId,peer});
  assert.equal(summary.state,'WEIXIN_INBOUND_TRAFFIC_PRESENT_PAIRED_DM_NOT_SEEN');
  assert.equal(summary.received,2);
  assert.equal(summary.pairedAccepted,0);
  assert.equal(summary.rejected.group_message,1);
});

test('invalid binding or message container fails closed',()=>{
  assert.throws(()=>summarizeInboundHealth(null,{accountId,peer}),/HEALTH_MESSAGES_REQUIRED/);
  assert.throws(()=>summarizeInboundHealth([],{accountId,peer:{userId:'a',chatId:'b'}}),/HEALTH_BINDING_REQUIRED/);
});
