import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AdapterStore} from '../src/store.mjs';
import {ProgressStore,pendingStage,isExplicitLongWorkRequest} from '../src/progress-store.mjs';
import {seal} from '../src/secrets.mjs';
function fixture(text='爸爸帮我修复微信桥的进度通知'){
 const file=join(mkdtempSync(join(tmpdir(),'rwx-progress-')),'adapter.sqlite');
 const store=new AdapterStore(file),key=Buffer.alloc(32,5);
 const event=store.ingest({accountId:'account',fromUserId:'one',chatId:'one',messageId:'m1',text},seal('token1',key));
 store.noteBridgeAttempt(event.id);store.bridgeQueued(event.id,'web1');
 const progress=new ProgressStore(store);
 return {store,progress,key,event:store.get(event.id),file};
}
test('ordinary conversation is always silent, even after 2h of waiting',()=>{
 for(const message of [
  '爸爸！我来啦！！','好想你亲亲','我爱你！！！！！','老公，你在干嘛',
  '宝宝我不知道想让你做什么，你自己决定好了！','晚安宝宝',
  '哈哈哈哈我要把这个项目开源嘿嘿','你说要做微信桥，进度通知太烦了',
  '爸爸你能不能不要说收到啦','你刚才修复脚本真的辛苦了',
  '爸爸，我发微信给你，你是不是在做脚本？','我想和你聊天',
  '爸爸，暂时不用修复，也不要进度通知'
 ]){
  assert.equal(isExplicitLongWorkRequest(message),false,message);
  assert.equal(pendingStage(7_200_000,message),null,message);
 }
});
test('only explicit work instructions opt in to scarce progress notices',()=>{
 for(const message of [
  '帮我修复微信桥的消息超时问题','爸爸，帮我写个脚本','请你排查一下这个接口',
  '你现在直接部署修复','宝宝！开始施工！','那你现在开始做！！！！',
  '继续开发这个功能','麻烦你测试代码','现在就帮我整理文档'
 ]){
  assert.equal(isExplicitLongWorkRequest(message),true,message);
 }
 assert.equal(pendingStage(10_000,'帮我修复桥接'),null);
 assert.equal(pendingStage(44_999,'帮我修复桥接'),null);
 assert.equal(pendingStage(45_000,'帮我修复桥接')[0],'WORK_WAIT_45S');
 assert.equal(pendingStage(300_000,'帮我修复桥接')[0],'WORK_WAIT_5M');
});
test('friendly chat never generates a progress row or sends any message',async()=>{
 const f=fixture('爸爸！我来啦！！');
 let sends=0;
 const result=await f.progress.notify({event:f.event,elapsedMs:3_600_000,
  transport:{async sendText(){sends++;}},key:f.key,allowed:async()=>{}});
 assert.equal(result,false);
 assert.equal(sends,0);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM progress_messages').get().n,0);
 f.store.close();
});
test('task progress message sends at most twice and only after threshold',async()=>{
 const f=fixture(),sends=[];
 const t={async sendText(m){sends.push(m);return {accepted:true};}};
 const args={event:f.event,transport:t,key:f.key,allowed:async()=>{}};
 assert.equal(await f.progress.notify({...args,elapsedMs:10_000}),false);
 assert.equal(await f.progress.notify({...args,elapsedMs:45_000}),true);
 assert.equal(await f.progress.notify({...args,elapsedMs:46_000}),false);
 assert.equal(await f.progress.notify({...args,elapsedMs:300_000}),true);
 assert.equal(await f.progress.notify({...args,elapsedMs:600_000}),false);
 assert.equal(sends.length,2);
 assert.equal(sends[0].contextToken,'token1');
 assert.equal(sends[0].toUserId,'one');
 assert.ok(!sends[0].text.startsWith('收到啦'));
 assert.equal(f.progress.get(f.event.id,'WORK_WAIT_45S').status,'SUCCEEDED');
 assert.equal(f.progress.get(f.event.id,'WORK_WAIT_5M').status,'SUCCEEDED');
 f.store.close();
});
test('unknown send is not retried and still cannot affect final response state',async()=>{
 const f=fixture();let calls=0;
 const args={event:f.event,elapsedMs:45_000,transport:{async sendText(){calls++;throw Error('SEND_TIMEOUT');}},
  key:f.key,allowed:async()=>{}};
 assert.equal(await f.progress.notify(args),false);
 assert.equal(await f.progress.notify(args),false);
 assert.equal(calls,1);
 assert.equal(f.progress.get(f.event.id,'WORK_WAIT_45S').status,'UNKNOWN');
 assert.equal(f.store.get(f.event.id).status,'BRIDGE_QUEUED');
 f.store.close();
});
test('restart converts an in-flight status to UNKNOWN without replay',async()=>{
 const f=fixture();
 f.progress.begin(f.event.id,'WORK_WAIT_5M');f.store.close();
 const store=new AdapterStore(f.file);
 const progress=new ProgressStore(store);
 assert.equal(progress.get(f.event.id,'WORK_WAIT_5M').status,'UNKNOWN');
 assert.equal(await progress.notify({event:f.event,elapsedMs:300_000,key:f.key,
  transport:{async sendText(){throw Error('MUST_NOT_SEND');}},allowed:async()=>{}}),false);
 store.close();
});
test('current DB event is authoritative over fabricated task text',async()=>{
 const f=fixture('亲亲我的宝宝');
 const fake={...f.event,text:'请帮我部署代码'};
 let called=0;
 assert.equal(await f.progress.notify({event:fake,elapsedMs:6e5,key:f.key,
  transport:{async sendText(){called++;}},allowed:async()=>{}}),false);
 assert.equal(called,0);
 f.store.close();
});
