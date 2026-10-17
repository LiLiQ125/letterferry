import test from 'node:test';
import assert from 'node:assert/strict';
import {seal} from '../src/secrets.mjs';
import {NativeTypingIndicator} from '../src/native-typing.mjs';
import {RealWeixinTransport,buildGetTypingTicketRequest,buildSendTypingRequest} from '../src/transports/real-weixin.mjs';

test('iLink typing requests use exact documented endpoints without message bodies',()=>{
 const c=buildGetTypingTicketRequest({toUserId:'one-peer',contextToken:'ctx'});
 const s=buildSendTypingRequest({toUserId:'one-peer',typingTicket:'ticket',status:1});
 assert.equal(c.path,'/ilink/bot/getconfig');
 assert.equal(c.body.ilink_user_id,'one-peer');
 assert.equal(c.body.context_token,'ctx');
 assert.equal(s.path,'/ilink/bot/sendtyping');
 assert.equal(s.body.status,1);
 assert.equal(buildSendTypingRequest({toUserId:'one-peer',typingTicket:'ticket',status:2}).body.status,2);
 assert.throws(()=>buildSendTypingRequest({toUserId:'one-peer',typingTicket:'ticket',status:3}),/TYPING_REQUEST_INVALID/);
 assert.throws(()=>buildGetTypingTicketRequest({toUserId:'',contextToken:'ctx'}),/TYPING_CONFIG_REQUEST_INVALID/);
});

test('typing transport is isolated to the paired peer with authenticated calls',async()=>{
 const calls=[];
 const t=new RealWeixinTransport({
  authStore:{load:async()=>({baseUrl:'https://ilinkai.weixin.qq.com',botToken:'test'}),updateCursor:async()=>{}},
  allowedPeer:{userId:'one-peer',chatId:'one-peer'},outboundEnabled:true,
  fetchImpl:async(url,opts)=>{
   calls.push({path:new URL(url).pathname,body:JSON.parse(opts.body)});
   return {ok:true,text:async()=>JSON.stringify(calls.length===1?{ret:0,typing_ticket:'t'}:{ret:0})};
  }
 });
 assert.equal(await t.getTypingTicket({toUserId:'one-peer',contextToken:'ctx'}),'t');
 await t.sendTyping({toUserId:'one-peer',typingTicket:'t',status:1});
 await t.sendTyping({toUserId:'one-peer',typingTicket:'t',status:2});
 assert.equal(calls.length,3);
 assert.deepEqual(calls.map(x=>x.path),[
  '/ilink/bot/getconfig','/ilink/bot/sendtyping','/ilink/bot/sendtyping']);
 assert.deepEqual(calls.slice(1).map(x=>x.body.status),[1,2]);
 await assert.rejects(t.sendTyping({toUserId:'other-peer',typingTicket:'t',status:1}),/PEER_NOT_ALLOWED/);
 await assert.rejects(t.getTypingTicket({toUserId:'other-peer',contextToken:'ctx'}),/PEER_NOT_ALLOWED/);
 assert.equal(calls.length,3);
 const disabled=new RealWeixinTransport({authStore:t.authStore,allowedPeer:t.allowedPeer,outboundEnabled:false,fetchImpl:t.fetch});
 await assert.rejects(disabled.sendTyping({toUserId:'one-peer',typingTicket:'t',status:1}),/CAPABILITY_DISABLED/);
});

function fixture({failed=false}={}){
 let ms=1000,canRun=true;
 const key=Buffer.alloc(32,7);
 const row={id:'event',status:'BRIDGE_QUEUED',bridge_submit_attempts:1,user_id:'peer',chat_id:'peer',context_cipher:seal('ctx',key)};
 const calls=[];
 const transport={allowedPeer:{userId:'peer',chatId:'peer'},getTypingTicket:async({toUserId,contextToken})=>{
  calls.push(['config',toUserId,contextToken]);return 'ticket';
 },sendTyping:async({toUserId,status})=>{
  calls.push(['typing',toUserId,status]);if(failed&&status===1)throw Error('TIMEOUT');
 }};
 const indicator=new NativeTypingIndicator({store:{getPrivate:id=>id==='event'?row:null,get:id=>id==='event'?row:null},
  transport,key,allowed:async()=>{if(!canRun)throw Error('PAUSED');},clock:()=>ms});
 return {indicator,row,calls,step:n=>ms+=n,pause:()=>canRun=false};
}
test('normal chat produces native status 1, throttled heartbeat, and status 2 on completion',async()=>{
 const f=fixture();
 assert.equal(await f.indicator.pulse(f.row),true);
 assert.equal(await f.indicator.pulse(f.row),false);
 f.step(5001);
 assert.equal(await f.indicator.pulse(f.row),true);
 assert.equal(await f.indicator.stop(),true);
 assert.deepEqual(f.calls,[['config','peer','ctx'],['typing','peer',1],['typing','peer',1],['typing','peer',2]]);
 assert.equal(await f.indicator.stop(),false);
});
test('paused service, stale event, wrong chat and API errors never break normal reply flow',async()=>{
 const f=fixture();
 assert.equal(await f.indicator.pulse({...f.row,id:'other'}),false);
 f.row.status='SUCCEEDED';
 assert.equal(await f.indicator.pulse(f.row),false);
 f.row.status='BRIDGE_QUEUED';
 f.pause();
 assert.equal(await f.indicator.pulse(f.row),false);
 assert.deepEqual(f.calls,[]);
 const broken=fixture({failed:true});
 assert.equal(await broken.indicator.pulse(broken.row),false);
 broken.step(5000);
 assert.equal(await broken.indicator.pulse(broken.row),false);
 assert.equal(await broken.indicator.stop(),true);
 assert.deepEqual(broken.calls,[['config','peer','ctx'],['typing','peer',1],['typing','peer',2]]);
});
