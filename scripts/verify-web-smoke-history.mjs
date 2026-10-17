import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export function hasVerifiedBrowserSmoke(filename=resolve('data/web-host.sqlite')){
 let db;
 try {
  db=new DatabaseSync(filename,{readOnly:true});
  const row=db.prepare("SELECT 1 AS verified FROM web_host_events WHERE status='SUCCEEDED' AND reply_text=? LIMIT 1").get('RIVEN_WEB_SMOKE_OK');
  return row?.verified===1;
 }catch{return false;}
 finally{db?.close();}
}
if(process.argv[1] && resolve(fileURLToPath(import.meta.url))===resolve(process.argv[1])){
 process.stdout.write(hasVerifiedBrowserSmoke()?'VERIFIED\n':'UNVERIFIED\n');
}
