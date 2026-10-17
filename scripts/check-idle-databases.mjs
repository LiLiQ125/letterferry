import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
export function terminalDbStatus(adapterPath=resolve('data/adapter.sqlite'),webPath=resolve('data/web-host.sqlite')){
 let a=null,w=null;
 try{
  a=new DatabaseSync(adapterPath,{readOnly:true});
  w=new DatabaseSync(webPath,{readOnly:true});
  const adapterUnsafe=a.prepare('SELECT COUNT(*) n FROM adapter_events WHERE status NOT IN (?,?,?)')
   .get('SUCCEEDED','DEFERRED_BACKLOG','REVIEWED_NO_REPLAY').n;
  const webUnsafe=w.prepare('SELECT COUNT(*) n FROM web_host_events WHERE status NOT IN (?,?)')
   .get('SUCCEEDED','REVIEWED_NO_REPLAY').n;
  return {adapterUnsafe,webUnsafe,safe:adapterUnsafe===0&&webUnsafe===0};
 }finally{a?.close();w?.close();}
}
if(process.argv[1]?.endsWith('check-idle-databases.mjs')){
 try{
  const result=terminalDbStatus();
  process.stdout.write('WEIXIN_IDLE_DB_CHECK '+JSON.stringify(result)+'\n');
  if(!result.safe)process.exitCode=31;
 }catch{process.stderr.write('WEIXIN_IDLE_DB_UNAVAILABLE\n');process.exitCode=31;}
}
