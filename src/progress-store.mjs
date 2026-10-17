import {unseal} from './secrets.mjs';

// Do not treat conversational latency as work. The gate is deliberately
// conservative: uncertain intent means NO status message, ever.
const WORK_STAGE_RULES=Object.freeze([
 ['WORK_WAIT_45S',45_000,'宝宝，这件事还在处理，完成后我就来回你。❤️'],
 ['WORK_WAIT_5M',300_000,'这件事还没结束，我还在等最终结果。你不用一直守着微信。']
]);
const WORK_VERB=/(?:修复|修一下|修好|排查|调试|部署|开发|实现|构建|重构|迁移|安装|提(?:交|PR)|合并|审查(?:代码|仓库|项目|PR)|测试(?:代码|功能|项目|接口|脚本|服务)|验收|编写|写(?:个|一个|一份|一段|一下)?(?:代码|脚本|程序|文档|测试|报告|方案)|改(?:代码|脚本|程序|功能|接口|项目)|优化(?:代码|功能|架构|性能|服务|脚本|项目|微信桥)|做(?:个|一个|一份|一下)?(?:网页|网站|功能|软件|应用|项目|程序|脚本|工具|系统|PPT|Word|PDF)|制作(?:文档|PPT|Word|视频)|整理(?:文件|仓库|资料|文档)|开源(?:项目|仓库)|施工)/i;
const DIRECTED=/^(?:[\s，,！!、。…～~]*(?:宝宝|爸爸|老公|riven|Riven|你|咱们|我们)[\s，,！!、。…～~]*)?(?:请你|请|麻烦你|帮我|替我|你来|你现在|现在就|直接|开始|继续|给我|帮咱们|能不能帮我|可不可以帮我|我要你|我想让你)[^。！？\n]{0,110}/i;
const START_WORK=/(?:^|[，,。！？!\n])\s*(?:宝宝|爸爸|老公|Riven)?\s*(?:那你|你)?\s*(?:现在|直接|就)?\s*(?:开始|继续)\s*(?:做|干活|施工|开发|修|写|执行)(?:吧|呀|！|!|。|$)/i;
export function isExplicitLongWorkRequest(text){
 if(typeof text!=='string')return false;
 const source=text.trim().slice(0,900);
 if(!source)return false;
 if(/(?:别|不要|不用|无需|先别|不必)[^。！？\n]{0,25}(?:通知|进度|提醒|同步|回执|做|施工)/.test(source))return false;
 if(START_WORK.test(source))return true;
 for(const sentence of source.split(/[。！？!?\n]/)){
  const s=sentence.trim();
  if(DIRECTED.test(s) && WORK_VERB.test(s))return true;
 }
 return false;
}
export function pendingStage(elapsedMs,text){
 if(!isExplicitLongWorkRequest(text)||!Number.isFinite(elapsedMs)||elapsedMs<0)return null;
 for(let i=WORK_STAGE_RULES.length-1;i>=0;i--)
  if(elapsedMs>=WORK_STAGE_RULES[i][1])return WORK_STAGE_RULES[i];
 return null;
}
export class ProgressStore{
 constructor(store){
  if(!store?.db)throw Error('PROGRESS_ADAPTER_STORE_REQUIRED');
  this.store=store;this.db=store.db;
  this.db.exec(`CREATE TABLE IF NOT EXISTS progress_messages (
    event_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    client_id TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL,
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL,
    PRIMARY KEY(event_id,stage)
  )`);
  // An unresolved notification may have been accepted by Weixin before crash.
  this.db.prepare("UPDATE progress_messages SET status='UNKNOWN' WHERE status='SENDING'").run();
 }
 get(eventId,stage){return this.db.prepare('SELECT * FROM progress_messages WHERE event_id=? AND stage=?').get(eventId,stage);}
 begin(eventId,stage,now=Date.now()){
  const event=this.store.get(eventId);
  if(!event||event.status!=='BRIDGE_QUEUED'||event.bridge_submit_attempts!==1)
   throw Error('PROGRESS_NOT_PENDING_BRIDGE');
  if(!WORK_STAGE_RULES.some(x=>x[0]===stage))throw Error('PROGRESS_INVALID_STAGE');
  const clientId='rwb-status-'+eventId+'-'+stage.toLowerCase();
  const result=this.db.prepare("INSERT OR IGNORE INTO progress_messages(event_id,stage,client_id,status,created_ms,updated_ms) VALUES (?,?,?,'SENDING',?,?)").run(eventId,stage,clientId,now,now);
  return result.changes===1?this.get(eventId,stage):null;
 }
 finish(eventId,stage,status,now=Date.now()){
  if(!['SUCCEEDED','UNKNOWN'].includes(status))throw Error('PROGRESS_INVALID_RESULT');
  const result=this.db.prepare("UPDATE progress_messages SET status=?,updated_ms=? WHERE event_id=? AND stage=? AND status='SENDING'").run(status,now,eventId,stage);
  if(result.changes!==1)throw Error('PROGRESS_STATE_CONFLICT');
 }
 async notify({event,elapsedMs,transport,key,allowed}){
  // Read current durable source content; a forged/stale callback cannot mark
  // casual conversation as work merely by supplying a task-like event object.
  const existing=this.store.get(event?.id);
  if(!existing||existing.status!=='BRIDGE_QUEUED')return false;
  const stage=pendingStage(elapsedMs,existing.text);
  if(!stage||this.get(existing.id,stage[0]))return false;
  await allowed();
  const row=this.begin(existing.id,stage[0]);
  if(!row)return false;
  const privateEvent=this.store.getPrivate(existing.id);
  try{
   await transport.sendText({
    toUserId:privateEvent.user_id,chatId:privateEvent.chat_id,
    clientId:row.client_id,contextToken:unseal(privateEvent.context_cipher,key),
    text:stage[2]
   });
   this.finish(existing.id,stage[0],'SUCCEEDED');
   return true;
  }catch{
   this.finish(existing.id,stage[0],'UNKNOWN');
   return false;
  }
 }
}
