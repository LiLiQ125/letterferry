import {mkdirSync,openSync,writeSync,closeSync,unlinkSync} from 'node:fs';
import {dirname,resolve} from 'node:path';

export function acquireWebSessionLock(file=resolve('data/web-session.lock')){
 mkdirSync(dirname(file),{recursive:true});
 let fd;
 try{
   fd=openSync(file,'wx',0o600);
 }catch(error){
   if(error?.code==='EEXIST')throw Error('WEB_SESSION_LOCK_EXISTS_MANUAL_REVIEW');
   throw Error('WEB_SESSION_LOCK_FAILED');
 }
 try{
   writeSync(fd,JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()}));
 }catch(error){
   try{closeSync(fd);}catch{}
   try{unlinkSync(file);}catch{}
   throw Error('WEB_SESSION_LOCK_WRITE_FAILED');
 }
 closeSync(fd);
 let released=false;
 return ()=>{
   if(released)return;
   released=true;
   try{unlinkSync(file);}catch{throw Error('WEB_SESSION_LOCK_RELEASE_FAILED');}
 };
}
