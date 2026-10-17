import { resolve } from 'node:path';
import { WebHostStore } from '../src/web-host-store.mjs';
import {readAlwaysOn} from '../src/always-on-policy.mjs';
import { createWebHostServer, getWebHostKey } from '../src/web-host-server.mjs';

const key=getWebHostKey();
const store=new WebHostStore(resolve('data/web-host.sqlite'));
const service=createWebHostServer({store,key,autoState:()=>{
 try{const config=readAlwaysOn();return {enabled:config.enabled===true&&!config.paused,chatUrl:config.chatUrl};}
 catch{return {enabled:false};}
}});
try {
  const address=await service.start();
  process.stdout.write('WEB_HOST_LISTENING http://127.0.0.1:'+address.port+'\n');
  process.stdout.write('HOST_UNVERIFIED until the Edge extension is explicitly bound and armed.\n');
  process.stdout.write('Close this terminal or press Ctrl+C to stop. No automatic Weixin sending.\n');
} catch(error) {
  store.close();
  process.stderr.write('WEB_HOST_START_FAILED\n');
  process.exitCode=1;
}
for(const signal of ['SIGINT','SIGTERM']) process.once(signal, async()=>{await service.stop();store.close();process.exit(0);});
