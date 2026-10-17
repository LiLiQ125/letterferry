import test from 'node:test';
import assert from 'node:assert/strict';
import {soleOutstanding,verifiedStoredWebReply} from '../src/web-session-recovery.mjs';
const id='199e13ce-c81c-4a59-9bb8-48cef52db66f';
const peer={userId:'paired',chatId:'paired'};
const row={id,status:'BRIDGE_QUEUED',text:'宝宝！测试',user_id:'paired',chat_id:'paired',bridge_event_id:'b1',bridge_submit_attempts:1};
const web={id:'b1',status:'SUCCEEDED',idempotency_key:'weixin:'+id,text:'[WeChat authorized text | adapter_event='+id+']\n宝宝！测试',reply_text:'我在呀宝宝'};
test('stalled reply may be staged only from the exact successful Web event and bound peer',()=>{
 assert.equal(verifiedStoredWebReply(row,web,peer),'我在呀宝宝');
 for(const invalid of [
  {...web,status:'BROWSER_SUBMITTED'},
  {...web,idempotency_key:'weixin:someone-else'},
  {...web,text:'other content'},
  {...web,reply_text:''}
 ])assert.throws(()=>verifiedStoredWebReply(row,invalid,peer),/NOT_VERIFIED/);
 assert.throws(()=>verifiedStoredWebReply(row,web,{userId:'other',chatId:'other'}),/ORIGIN_NOT_VERIFIED/);
 assert.throws(()=>verifiedStoredWebReply({...row,bridge_submit_attempts:2},web,peer),/ORIGIN_NOT_VERIFIED/);
});
test('only one pending event can be staged or sent; already completed or unknown states are blocked',()=>{
 const rows=[{status:'SUCCEEDED'},{status:'DEFERRED_BACKLOG'},row];
 assert.equal(soleOutstanding(rows,id,'BRIDGE_QUEUED'),row);
 for(const value of [
  [...rows,{...row,id:'other',status:'REPLY_READY'}],
  [{...row,status:'OUTBOUND_UNKNOWN'}],
  [{...row,status:'SUCCEEDED'}]
 ])assert.throws(()=>soleOutstanding(value,id,'BRIDGE_QUEUED'),/EXACT_SINGLE_EVENT_REQUIRED/);
});
test('manual send verification requires exactly the saved response',()=>{
 const prepared={...row,status:'REPLY_READY',reply_text:'我在呀宝宝'};
 assert.equal(verifiedStoredWebReply(prepared,web,peer,{expectedStatus:'REPLY_READY'}),'我在呀宝宝');
 assert.throws(()=>verifiedStoredWebReply({...prepared,reply_text:'changed'},web,peer,{expectedStatus:'REPLY_READY'}),/RECOVERY_REPLY_CHANGED/);
});
