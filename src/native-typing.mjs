import {unseal} from './secrets.mjs';

// A best-effort ephemeral presence signal. Never commit, dequeue, retry a chat
// submission, or change an outbound-message status because of typing failures.
export class NativeTypingIndicator {
  constructor({store,transport,key,allowed,clock=()=>Date.now(),intervalMs=5_000}){
    if(!store||!transport||!key||typeof allowed!=='function')throw Error('TYPING_DEPENDENCIES_REQUIRED');
    this.store=store;
    this.transport=transport;
    this.key=key;
    this.allowed=allowed;
    this.clock=clock;
    this.intervalMs=intervalMs;
    this.ticket=null;
    this.ticketExpires=0;
    this.activeId=null;
    this.nextAt=0;
    this.backoffUntil=0;
  }
  async pulse(event){
    const now=this.clock();
    if(now<this.nextAt||now<this.backoffUntil)return false;
    const row=event?.id?this.store.getPrivate(event.id):null;
    if(!row||row.status!=='BRIDGE_QUEUED'||row.bridge_submit_attempts!==1||
      row.user_id!==this.transport.allowedPeer?.userId||row.chat_id!==this.transport.allowedPeer?.chatId)
      return false;
    if(this.activeId&&this.activeId!==row.id)return false;
    this.nextAt=now+this.intervalMs;
    try{
      await this.allowed();
      if(!this.ticket||now>=this.ticketExpires){
        this.ticket=await this.transport.getTypingTicket({
          toUserId:row.user_id,contextToken:unseal(row.context_cipher,this.key)
        });
        this.ticketExpires=this.clock()+12*60*60_000;
      }
      await this.allowed();
      // Mark active BEFORE a network side effect that could have an unknown ACK.
      this.activeId=row.id;
      await this.transport.sendTyping({toUserId:row.user_id,typingTicket:this.ticket,status:1});
      return true;
    }catch{
      this.backoffUntil=this.clock()+30_000;
      return false;
    }
  }
  async stop(){
    const id=this.activeId;
    this.activeId=null;
    this.nextAt=0;
    if(!id||!this.ticket)return false;
    const row=this.store.get(id);
    if(!row||row.user_id!==this.transport.allowedPeer?.userId)return false;
    try{
      await this.transport.sendTyping({toUserId:row.user_id,typingTicket:this.ticket,status:2});
      return true;
    }catch{return false;}
  }
}
