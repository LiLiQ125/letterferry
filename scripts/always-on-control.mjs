import {readAlwaysOn,writeAlwaysOn,validPinnedChatUrl,AUTO_VERSION} from '../src/always-on-policy.mjs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export function controlMode(mode,oldConfig,chatUrl){
 const now=new Date().toISOString();
 if(mode==='enable'){
  if(!validPinnedChatUrl(chatUrl))throw Error('ALWAYS_ON_PINNED_CHAT_URL_REQUIRED');
  return {version:AUTO_VERSION,enabled:true,paused:false,
    approvedAt:now,scope:'ONE_PAIRED_PRIVATE_CHATGPT_TAB',chatUrl};
 }
 if(!validPinnedChatUrl(oldConfig?.chatUrl))throw Error('ALWAYS_ON_NOT_CONFIGURED');
 if(mode==='pause')return {...oldConfig,paused:true};
 if(mode==='resume')return {...oldConfig,paused:false,enabled:true};
 if(mode==='disable')return {...oldConfig,paused:true,enabled:false};
 throw Error('UNKNOWN_ALWAYS_ON_CONTROL_MODE');
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const mode=process.argv[2];
  const config=readAlwaysOn();
  const updated=controlMode(mode,config,process.argv[3]);
  writeAlwaysOn(updated);
  process.stdout.write('ALWAYS_ON_CONFIG '+(updated.enabled?(updated.paused?'PAUSED':'ENABLED'):'DISABLED')+'\n');
 }catch(error){
  process.stderr.write(/^[A-Z0-9_]{1,120}$/.test(error.message)?error.message:'ALWAYS_ON_CONTROL_FAILED');
  process.exitCode=1;
 }
}
