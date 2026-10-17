import {createDecipheriv} from 'node:crypto';

export const MAX_WEIXIN_IMAGE_BYTES=12*1024*1024;
const CDN_HOST='novac2c.cdn.weixin.qq.com';
const CDN_PATH='/c2c/download';

export function pickInboundImage(raw){
 if(!Array.isArray(raw?.item_list))return null;
 const images=raw.item_list.filter(item=>item?.type===2&&item.image_item?.media);
 if(images.length!==1)return null; // Multiple image references need an explicit policy.
 const img=images[0].image_item;
 if(typeof img.media.encrypt_query_param!=='string'&&typeof img.media.full_url!=='string')return null;
 return img;
}

export function decodeImageAesKey(image){
 const hex=image?.aeskey;
 if(hex!==undefined&&hex!==null&&hex!==''){
  if(typeof hex!=='string'||!/^[0-9a-fA-F]{32}$/.test(hex))throw Error('WEIXIN_IMAGE_AES_KEY_INVALID');
  return Buffer.from(hex,'hex');
 }
 const encoded=image?.media?.aes_key;
 if(encoded===undefined||encoded===null||encoded==='')return null;
 if(typeof encoded!=='string'||!/^[a-zA-Z0-9+/]{22}==?$|^[a-zA-Z0-9+/]{43}=?$/.test(encoded))
  throw Error('WEIXIN_IMAGE_AES_KEY_INVALID');
 const decoded=Buffer.from(encoded,'base64');
 if(decoded.length===16)return decoded;
 if(decoded.length===32&&/^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii')))
  return Buffer.from(decoded.toString('ascii'),'hex');
 throw Error('WEIXIN_IMAGE_AES_KEY_INVALID');
}

export function imageCdnUrl(image){
 const media=image?.media;
 if(!media)throw Error('WEIXIN_IMAGE_MEDIA_MISSING');
 let url;
 if(media.full_url){
  try{url=new URL(media.full_url);}catch{throw Error('WEIXIN_IMAGE_CDN_URL_INVALID');}
 }else{
  const query=media.encrypt_query_param;
  if(typeof query!=='string'||!query||query.length>4096)throw Error('WEIXIN_IMAGE_CDN_QUERY_INVALID');
  url=new URL('https://'+CDN_HOST+CDN_PATH);
  url.searchParams.set('encrypted_query_param',query);
 }
 if(url.protocol!=='https:'||url.hostname!==CDN_HOST||url.pathname!==CDN_PATH||
    url.port||url.username||url.password||url.hash||
    url.searchParams.size!==1||!url.searchParams.has('encrypted_query_param')||
    !url.searchParams.get('encrypted_query_param')||
    url.searchParams.get('encrypted_query_param').length>4096)
  throw Error('WEIXIN_IMAGE_CDN_URL_FORBIDDEN');
 return url.href;
}

async function boundedBytes(response,limit){
 if(!response?.ok)throw Error('WEIXIN_IMAGE_CDN_HTTP_FAILED');
 const declared=response.headers?.get?.('content-length');
 if(declared!==null&&declared!==undefined&&Number(declared)>limit)throw Error('WEIXIN_IMAGE_TOO_LARGE');
 if(!response.body?.getReader)throw Error('WEIXIN_IMAGE_STREAM_REQUIRED');
 const reader=response.body.getReader();
 const chunks=[];
 let total=0;
 try{
  while(true){
   const {value,done}=await reader.read();
   if(done)break;
   if(!(value instanceof Uint8Array))throw Error('WEIXIN_IMAGE_STREAM_INVALID');
   total+=value.byteLength;
   if(total>limit)throw Error('WEIXIN_IMAGE_TOO_LARGE');
   chunks.push(Buffer.from(value));
  }
 }finally{reader.releaseLock();}
 return Buffer.concat(chunks,total);
}

export function imageMime(bytes){
 if(bytes.length>=3&&bytes.subarray(0,3).equals(Buffer.from([255,216,255])))return 'image/jpeg';
 if(bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
 if(bytes.length>=6&&['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString('ascii')))return 'image/gif';
 if(bytes.length>=12&&bytes.subarray(0,4).toString('ascii')==='RIFF'&&bytes.subarray(8,12).toString('ascii')==='WEBP')return 'image/webp';
 throw Error('WEIXIN_IMAGE_FORMAT_UNSUPPORTED');
}

export async function downloadInboundImage(raw,{fetchImpl=fetch,maxBytes=MAX_WEIXIN_IMAGE_BYTES}={}){
 const image=pickInboundImage(raw);
 if(!image)throw Error('WEIXIN_IMAGE_NOT_SINGLE');
 if(!Number.isSafeInteger(maxBytes)||maxBytes<64||maxBytes>MAX_WEIXIN_IMAGE_BYTES)throw Error('WEIXIN_IMAGE_LIMIT_INVALID');
 const key=decodeImageAesKey(image);
 const response=await fetchImpl(imageCdnUrl(image),{
  method:'GET',redirect:'error',signal:AbortSignal.timeout(15000),
  headers:{accept:'application/octet-stream'}
 });
 const encrypted=await boundedBytes(response,maxBytes+16);
 let bytes=encrypted;
 if(key){
  if(encrypted.length===0||encrypted.length%16!==0)throw Error('WEIXIN_IMAGE_CIPHERTEXT_INVALID');
  try{
   const decryptor=createDecipheriv('aes-128-ecb',key,null);
   bytes=Buffer.concat([decryptor.update(encrypted),decryptor.final()]);
  }catch{throw Error('WEIXIN_IMAGE_DECRYPT_FAILED');}
 }
 if(bytes.length>maxBytes)throw Error('WEIXIN_IMAGE_TOO_LARGE');
 const mimeType=imageMime(bytes);
 const ext={'image/jpeg':'jpg','image/png':'png','image/gif':'gif','image/webp':'webp'}[mimeType];
 return {bytes,mimeType,fileName:'wechat-image.'+ext};
}
