import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {WebHostStore} from '../src/web-host-store.mjs';
import {createWebHostServer,getWebHostKey} from '../src/web-host-server.mjs';

const key=getWebHostKey();
const store=new WebHostStore(resolve('data/web-host.sqlite'));
const blocked=['DELIVERY_UNKNOWN','ASSIGNED_UNKNOWN','BROWSER_SUBMITTED'];
const counts=store.counts();
if(blocked.some(status=>counts[status])||counts.QUEUED){
  process.stderr.write('PREEXISTING_WEB_EVENTS_REQUIRE_REVIEW. Nothing was sent.\n');
  store.close();
  process.exit(1);
}
const service=createWebHostServer({store,key});
let stopped=false;
let child=null;
async function stop(){
  if(stopped)return;
  stopped=true;
  if(child && child.exitCode===null){
    // Windows powershell.exe launches a nested Node listener; kill the whole tree.
    // If a Weixin send was in progress, the existing SQLite recovery gate records UNKNOWN.
    if(process.platform==='win32' && child.pid){
      await new Promise(resolveStop=>{
        const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
        killer.once('error',resolveStop);
        killer.once('exit',resolveStop);
      });
    }else child.kill();
  }
  await service.stop().catch(()=>{});
  store.close();
}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{stop().then(()=>process.exit(0));});
try {
  await service.start();
  process.stdout.write('RIVEN_WEB_HOST_LISTENING / Edge extension required\n');
  process.stdout.write('Local setup: Copy Web Bridge Key.cmd -> Edge load unpacked web-extension -> bind selected ChatGPT tab -> Arm.\n');
  process.stdout.write('Do not close this terminal. Weixin has NOT started yet.\n');
  const until=Date.now()+5*60_000;
  let ready=false;
  while(Date.now()<until&&!stopped){
    if(service.hostState()==='HOST_READY'){ready=true;break;}
    process.stdout.write('WAITING_FOR_EXPLICIT_CHATGPT_TAB_BINDING\n');
    await new Promise(ok=>setTimeout(ok,5000));
  }
  if(!ready||stopped)throw Error('WEB_HOST_NOT_READY_WITHIN_5_MIN');
  process.stdout.write('CHATGPT_EDITOR_CONNECTED (reply delivery not yet verified).\n');
  process.stdout.write('Starting capped 60-minute Weixin foreground session. It still requires local typed confirmation.\n');
  const exit=await new Promise(ok=>{
    child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts\\weixin-session.ps1','-BridgeMode','web','-Minutes','60'],{cwd:process.cwd(),stdio:'inherit'});
    child.once('error',()=>ok(1));child.once('exit',code=>ok(code??1));
  });
  process.stdout.write('WEIXIN_SESSION_STOPPED code='+exit+'\n');
  process.exitCode=exit;
}catch(error){
  process.stderr.write(/^[A-Z0-9_]{3,70}$/.test(error.message)?error.message+'\n':'WEB_CHAT_START_FAILED\n');
  process.exitCode=1;
}finally{await stop();}
