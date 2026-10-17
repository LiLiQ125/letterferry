import {
  buildGetUpdatesRequest,normalizeGetUpdatesResponse,protocolInternalsForTest,validateApiBaseUrl
} from './real-weixin.mjs';
import {directEnvelopeRejection} from '../policy.mjs';
import {decodeImageAesKey,downloadInboundImage,imageCdnUrl,pickInboundImage} from '../media-inbound-image.mjs';

const MAX_CURSOR_LENGTH=16_384;
const ID=/^[A-Za-z0-9@._:-]{1,256}$/;

function validCursor(value){
  return typeof value==='string'&&value.length>0&&value.length<=MAX_CURSOR_LENGTH&&
    !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Explicit opt-in raw getupdates adapter for the isolated multimodal path.
 * Unlike RealWeixinTransport.poll(), this intentionally returns the unfiltered
 * batch so the coordinator can validate every allowed-peer item before cursor
 * acknowledgement. It never sends replies and never commits automatically.
 */
export class ExplicitMultimodalWeixinTransport{
  constructor({enabled=false,accountId,allowedPeer,authStore,fetchImpl}={}){
    this.enabled=enabled===true;
    this.accountId=accountId;
    this.allowedPeer=allowedPeer;
    this.authStore=authStore;
    this.fetch=fetchImpl;
    this.pending=null;
    this.ackState='IDLE';
  }

  #requireEnabled(){
    if(!this.enabled)throw Error('MULTIMODAL_INBOUND_DISABLED');
    if(!this.authStore||typeof this.authStore.load!=='function'||
      typeof this.authStore.updateCursor!=='function')throw Error('MULTIMODAL_AUTH_STORE_REQUIRED');
    if(typeof this.fetch!=='function')throw Error('MULTIMODAL_FETCH_IMPL_REQUIRED');
    if(!ID.test(this.accountId||'')||!this.allowedPeer||!ID.test(this.allowedPeer.userId||'')||
      this.allowedPeer.chatId!==this.allowedPeer.userId)throw Error('MULTIMODAL_EXACT_BINDING_REQUIRED');
  }

  async pollBatch(){
    this.#requireEnabled();
    if(this.pending||this.ackState==='UNCERTAIN')throw Error('MULTIMODAL_CURSOR_PENDING');
    const auth=await this.authStore.load();
    if(auth?.accountId!==this.accountId||typeof auth.botToken!=='string'||!auth.botToken||auth.botToken.length>4096||
      (auth.cursor!==undefined&&typeof auth.cursor!=='string'))throw Error('MULTIMODAL_AUTH_INVALID');
    const baseUrl=validateApiBaseUrl(auth.baseUrl);
    const request=buildGetUpdatesRequest(auth.cursor||'');
    const body=await protocolInternalsForTest.fetchJson(this.fetch,
      new URL(request.path,baseUrl+'/'),{
        method:request.method,
        headers:protocolInternalsForTest.commonHeaders({token:auth.botToken}),
        body:JSON.stringify(request.body)
      },35_000,'GETUPDATES');
    const normalized=normalizeGetUpdatesResponse(body);
    if(!validCursor(normalized.nextCursor))throw Error('MULTIMODAL_NEXT_CURSOR_REQUIRED');
    this.pending={previousCursor:auth.cursor||'',nextCursor:normalized.nextCursor};
    this.ackState='PENDING';
    return {messages:normalized.messages,nextCursor:normalized.nextCursor};
  }

  async recordStagedCursor({cursor,batchKey}={}){
    this.#requireEnabled();
    if(typeof batchKey!=='string'||!/^[0-9a-f]{64}$/.test(batchKey)||
      this.ackState!=='PENDING'||!this.pending||cursor!==this.pending.nextCursor)
      throw Error('MULTIMODAL_CURSOR_PROOF_MISMATCH');
    this.ackState='RECORDING';
    try{
      const current=await this.authStore.load();
      if(current?.accountId!==this.accountId||(current.cursor||'')!==this.pending.previousCursor)
        throw Error('MULTIMODAL_CURSOR_BASE_CHANGED');
      await this.authStore.updateCursor(cursor);
    }
    catch{
      this.ackState='UNCERTAIN';
      throw Error('MULTIMODAL_CURSOR_COMMIT_UNCERTAIN');
    }
    this.pending=null;
    this.ackState='RECORDED';
    return {recorded:true};
  }
}

export function createExplicitWeixinImageDownloader({enabled=false,accountId,allowedPeer,fetchImpl,maxBytes}={}){
  return async function download(raw,identity){
    if(enabled!==true)throw Error('MULTIMODAL_MEDIA_DOWNLOAD_DISABLED');
    if(typeof fetchImpl!=='function')throw Error('MULTIMODAL_MEDIA_FETCH_REQUIRED');
    if(!allowedPeer||identity?.accountId!==accountId||identity?.fromUserId!==allowedPeer.userId||
      identity?.chatId!==allowedPeer.chatId||raw?.from_user_id!==allowedPeer.userId)
      throw Error('MULTIMODAL_MEDIA_IDENTITY_MISMATCH');
    if(directEnvelopeRejection(raw,accountId)!==null)throw Error('MULTIMODAL_MEDIA_ENVELOPE_INVALID');
    const messageIds=[raw?.message_id,...(Array.isArray(raw?.item_list)?raw.item_list.map(item=>item?.msg_id):[])]
      .filter(value=>value!==undefined&&value!==null);
    if(!ID.test(identity?.messageId||'')||messageIds.length===0||
      messageIds.some(value=>typeof value!=='string'||value.trim()!==identity.messageId))
      throw Error('MULTIMODAL_MEDIA_MESSAGE_ID_MISMATCH');
    const image=pickInboundImage(raw);
    if(!image)throw Error('WEIXIN_IMAGE_NOT_SINGLE');
    // Validate signed media material before the injected client can be called.
    decodeImageAesKey(image);
    imageCdnUrl(image);
    return downloadInboundImage(raw,{fetchImpl,maxBytes});
  };
}
