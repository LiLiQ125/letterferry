import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebHostStore} from '../src/web-host-store.mjs';
import {createWebHostServer} from '../src/web-host-server.mjs';
import {AdapterStore} from '../src/store.mjs';
import {AllowlistPolicy} from '../src/policy.mjs';
import {ExistingBridgeClient} from '../src/bridge-client.mjs';
import {WeixinBridgeAdapter} from '../src/adapter.mjs';

const key='b'.repeat(64);
const who={tabId:19,url:'https://chatgpt.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};
const accountId='paired-weixin-bot',userId='paired-user';

test('real local HTTP + existing Weixin adapter completes simulated browser full roundtrip',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rwb-end-to-end-'));
  let web,adapterStore,service;
  try{
    web=new WebHostStore(join(dir,'web.sqlite'));
    adapterStore=new AdapterStore(join(dir,'weixin.sqlite'));
    service=createWebHostServer({store:web,key,port:0});
    const address=await service.start();
    const origin='http://127.0.0.1:'+address.port;
    const sends=[]; let batches=0;
    const transport={
      async poll(){ batches++;return batches===1?[{
        message_id:'9007199254740993',from_user_id:userId,to_user_id:accountId,
        message_type:1,message_state:2,context_token:'context-secret',
        item_list:[{type:1,text_item:{text:'宝宝，下课啦'}}]
      }]:[];},
      async commitPoll(){},
      async sendText(message){ sends.push(structuredClone(message));return {accepted:true};}
    };
    const adapter=new WeixinBridgeAdapter({
      accountId,policy:new AllowlistPolicy({accountId,allowedPeers:[{userId,chatId:userId}]}),
      store:adapterStore,transport,
      bridge:new ExistingBridgeClient({origin:origin+'/bridge-'+key}),
      encryptionKey:Buffer.alloc(32,7)
    });
    const api=async(path,data)=>{
      const response=await fetch(origin+path,{
        method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},
        body:JSON.stringify(data)
      });
      assert.equal(response.status,200,'Browser test API should accept '+path);
      return response.json();
    };
    const ingress=await adapter.pollInbound();
    assert.equal(ingress.filter(x=>x.accepted).length,1);
    const queued=await adapter.submitOneToBridge();
    assert.equal(queued.status,'BRIDGE_QUEUED');
    assert.equal((await adapter.collectOneReply()).status,'BRIDGE_QUEUED');
    await api('/extension/heartbeat',{...who,ready:true});
    const {event}=await api('/extension/poll',who);
    assert.match(event.text,/宝宝，下课啦/);
    await api('/extension/submitted',{...who,id:event.id});
    // This was broken: the internal BROWSER_SUBMITTED state must look pending to the Weixin adapter.
    assert.equal((await adapter.collectOneReply()).status,'BRIDGE_QUEUED');
    await api('/extension/complete',{...who,id:event.id,reply:'下课啦，先吃饭。'});
    assert.equal((await adapter.collectOneReply()).status,'REPLY_READY');
    const result=await adapter.sendOneReply();
    assert.equal(result.status,'SUCCEEDED');
    assert.equal(sends.length,1);
    assert.equal(sends[0].toUserId,userId);
    assert.equal(sends[0].text,'下课啦，先吃饭。');
    assert.equal(sends[0].contextToken,'context-secret');
    assert.equal((await adapter.sendOneReply()),null);
  }finally{
    if(service)await service.stop();
    web?.close();adapterStore?.close();
    rmSync(dir,{recursive:true,force:true});
  }
});
