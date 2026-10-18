import {directEnvelopeRejection} from './policy.mjs';

export function summarizeInboundHealth(messages,{accountId,peer}={}){
  if(!Array.isArray(messages))throw Error('HEALTH_MESSAGES_REQUIRED');
  if(!accountId||!peer?.userId||peer.userId!==peer.chatId)throw Error('HEALTH_BINDING_REQUIRED');
  const rejected={};
  let envelopeAccepted=0,fromPaired=0,pairedAccepted=0;
  for(const message of messages){
    const reason=directEnvelopeRejection(message,accountId);
    if(reason)rejected[reason]=(rejected[reason]||0)+1;
    else envelopeAccepted++;
    if(message?.from_user_id===peer.userId){
      fromPaired++;
      if(!reason)pairedAccepted++;
    }
  }
  const state=pairedAccepted>0
    ? 'WEIXIN_INBOUND_AVAILABLE'
    : messages.length>0
      ? 'WEIXIN_INBOUND_TRAFFIC_PRESENT_PAIRED_DM_NOT_SEEN'
      : 'WEIXIN_UPSTREAM_BLOCKED';
  return {state,received:messages.length,envelopeAccepted,fromPaired,pairedAccepted,rejected};
}
