import test from 'node:test';
import assert from 'node:assert/strict';
import {checkWebSmokeReadiness,judgeWebSmokeReply,MULTILINE_PROMPT,runLiveWebSmoke} from '../scripts/web-smoke-once.mjs';

test('web smoke refuses offline, unarmed, or outstanding ambiguous events',()=>{
 assert.equal(checkWebSmokeReadiness(null),'WEB_HOST_UNAVAILABLE');
 assert.equal(checkWebSmokeReadiness({ok:true,host:'HOST_UNVERIFIED',queue:{}}),'WEB_HOST_NOT_ARMED');
 assert.equal(checkWebSmokeReadiness({ok:true,host:'HOST_READY',queue:{ASSIGNED_UNKNOWN:1}}),'UNRESOLVED_WEB_EVENTS');
 assert.equal(checkWebSmokeReadiness({ok:true,host:'HOST_READY',queue:{DELIVERY_UNKNOWN:1}}),'UNRESOLVED_WEB_EVENTS');
 assert.equal(checkWebSmokeReadiness({ok:true,host:'HOST_READY',queue:{QUEUED:1}}),'UNRESOLVED_WEB_EVENTS');
 assert.equal(checkWebSmokeReadiness({ok:true,host:'HOST_READY',queue:{SUCCEEDED:2},weixinDeliveryVerified:false}),'READY');
 assert.equal(checkWebSmokeReadiness({ok:true,host:'HOST_READY',queue:{REVIEWED_NO_REPLAY:1},weixinDeliveryVerified:false}),'READY');
});
test('web smoke accepts only one exact success marker and never claims success for pending or unknown',()=>{
 assert.equal(judgeWebSmokeReply('SUCCEEDED','RIVEN_WEB_SMOKE_OK'),'PASS');
 assert.equal(judgeWebSmokeReply('SUCCEEDED',' RIVEN_WEB_SMOKE_OK\n'),'PASS');
 assert.equal(judgeWebSmokeReply('SUCCEEDED','RIVEN_WEB_SMOKE_OK and extra text'),'REPLY_MISMATCH');
 assert.equal(judgeWebSmokeReply('DISPATCHED',null),'PENDING');
 assert.equal(judgeWebSmokeReply('TIMED_OUT_UNKNOWN',null),'DELIVERY_UNKNOWN');
});

test('browser-only multiline probe exactly mirrors two-line envelope and requests one exact marker',()=>{
 const lines=MULTILINE_PROMPT.split('\n');
 assert.equal(lines.length,2);
 assert.match(lines[0],/^\[WeChat authorized text \| adapter_event=00000000-0000-4000-8000-000000000000\]$/);
 assert.match(lines[1],/LOCAL SYNTHETIC browser-only test, NOT a Weixin message/);
 assert.match(lines[1],/Reply with exactly RIVEN_WEB_SMOKE_OK/);
 assert.ok(MULTILINE_PROMPT.length>100 && MULTILINE_PROMPT.length<2000);
});
test('unsupported browser smoke mode is rejected before any network side effect',async()=>{
 await assert.rejects(()=>runLiveWebSmoke({mode:'weixin',ask:async()=>{throw Error('should not prompt');}}),/INVALID_SMOKE_MODE/);
});
