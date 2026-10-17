import {naturalContentFromText} from './natural-once.mjs';

const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE=new Set(['SUCCEEDED','REVIEWED_NO_REPLAY','DEFERRED_BACKLOG']);
export function soleOutstanding(rows,id,expectedStatus){
 if(!ID.test(id||''))throw Error('RECOVERY_INVALID_EVENT_ID');
 const open=rows.filter(r=>!SAFE.has(r.status));
 if(open.length!==1||open[0]?.id!==id||open[0].status!==expectedStatus)
   throw Error('RECOVERY_EXACT_SINGLE_EVENT_REQUIRED');
 return open[0];
}
export function verifiedStoredWebReply(event,web,peer,{expectedStatus='BRIDGE_QUEUED'}={}){
 if(!event || event.status!==expectedStatus || event.bridge_submit_attempts!==1 ||
    !event.bridge_event_id || event.user_id!==peer?.userId || event.chat_id!==peer?.chatId)
   throw Error('RECOVERY_ADAPTER_ORIGIN_NOT_VERIFIED');
 const expected='[WeChat authorized text | adapter_event='+event.id+']\n'+
   (naturalContentFromText(event.text)??event.text);
 if(!web||web.id!==event.bridge_event_id||web.status!=='SUCCEEDED'||
    web.idempotency_key!=='weixin:'+event.id||web.text!==expected||
    typeof web.reply_text!=='string'||!web.reply_text.trim()||web.reply_text.length>2000)
   throw Error('RECOVERY_WEB_REPLY_NOT_VERIFIED');
 if(expectedStatus==='REPLY_READY' && event.reply_text!==web.reply_text.trim())
   throw Error('RECOVERY_REPLY_CHANGED');
 return web.reply_text.trim();
}
