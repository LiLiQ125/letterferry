import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv} from 'node:crypto';
import {
 MAX_WEIXIN_IMAGE_BYTES,pickInboundImage,decodeImageAesKey,imageCdnUrl,imageMime,downloadInboundImage
} from '../src/media-inbound-image.mjs';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLytQAAAABJRU5ErkJggg==','base64');
const KEY=Buffer.from('00112233445566778899aabbccddeeff','hex');
const PARAM='cdn-encrypted+query==';
const item=(key=KEY.toString('hex'))=>({
 type:2,image_item:{aeskey:key,media:{encrypt_query_param:PARAM}}
});
const raw=(img=item())=>({item_list:[img]});
function ciphertext(plain=PNG){
 const cipher=createCipheriv('aes-128-ecb',KEY,null);
 return Buffer.concat([cipher.update(plain),cipher.final()]);
}
const fakeFetch=(bytes,seen=[])=>async(url,options)=>{
 seen.push({url,options});
 return new Response(bytes,{status:200,headers:{'content-length':String(bytes.length)}});
};

test('one image item extracted, multiple images and no image fail closed',()=>{
 assert.deepEqual(pickInboundImage(raw()),item().image_item);
 assert.equal(pickInboundImage({item_list:[{type:1,text_item:{text:'hi'}}]}),null);
 assert.equal(pickInboundImage({item_list:[item(),item()]}),null);
});
test('image aes key formats from official Tencent examples match',()=>{
 assert.deepEqual(decodeImageAesKey(item().image_item),KEY);
 assert.deepEqual(decodeImageAesKey({media:{aes_key:KEY.toString('base64')}}),KEY);
 assert.deepEqual(decodeImageAesKey({media:{aes_key:Buffer.from(KEY.toString('hex'),'ascii').toString('base64')}}),KEY);
 assert.equal(decodeImageAesKey({media:{}}),null);
 for(const key of ['almost-key','1234','Z'.repeat(24)])assert.throws(()=>decodeImageAesKey({media:{aes_key:key}}),/AES_KEY_INVALID/);
});
test('only exact secure known Weixin CDN host/path may be downloaded',()=>{
 const url=imageCdnUrl(item().image_item);
 assert.equal(new URL(url).hostname,'novac2c.cdn.weixin.qq.com');
 assert.equal(new URL(url).searchParams.get('encrypted_query_param'),PARAM);
 assert.equal(imageCdnUrl({media:{full_url:url}}),url);
 for(const bad of [
  'http://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=x',
  'https://private.example.com/c2c/download?encrypted_query_param=x',
  'https://novac2c.cdn.weixin.qq.com.evil.com/c2c/download?encrypted_query_param=x',
  'https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=x',
  'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=x&foo=1'
 ])assert.throws(()=>imageCdnUrl({media:{full_url:bad}}),/URL_FORBIDDEN/);
});
test('encrypted PNG end-to-end download and decrypt returns exact bytes and mime',async()=>{
 const seen=[];
 const output=await downloadInboundImage(raw(),{fetchImpl:fakeFetch(ciphertext(),seen)});
 assert.deepEqual(output.bytes,PNG);
 assert.equal(output.mimeType,'image/png');
 assert.equal(output.fileName,'wechat-image.png');
 assert.equal(seen.length,1);
 assert.equal(seen[0].options.redirect,'error');
});
test('unencrypted image and media AES formats work without extra calls',async()=>{
 const plain={type:2,image_item:{media:{encrypt_query_param:PARAM}}};
 assert.deepEqual((await downloadInboundImage(raw(plain),{fetchImpl:fakeFetch(PNG)})).bytes,PNG);
 const mediaKey={type:2,image_item:{media:{encrypt_query_param:PARAM,aes_key:KEY.toString('base64')}}};
 assert.deepEqual((await downloadInboundImage(raw(mediaKey),{fetchImpl:fakeFetch(ciphertext())})).bytes,PNG);
});
test('unsupported image formats and encrypted garbage rejected, not forwarded',async()=>{
 assert.throws(()=>imageMime(Buffer.from('<svg>alert(1)</svg>')),/FORMAT_UNSUPPORTED/);
 await assert.rejects(downloadInboundImage(raw(),{fetchImpl:fakeFetch(Buffer.from('bad'))}),/CIPHERTEXT_INVALID/);
 await assert.rejects(downloadInboundImage(raw(),{fetchImpl:fakeFetch(Buffer.alloc(32))}),/DECRYPT_FAILED/);
 await assert.rejects(downloadInboundImage(raw(),{fetchImpl:fakeFetch(ciphertext(Buffer.from('hello')))}),/FORMAT_UNSUPPORTED/);
});
test('oversize CDNs and unsupported multi-image events cause no unsafe transfers',async()=>{
 let count=0;
 await assert.rejects(downloadInboundImage(raw(),{maxBytes:80,fetchImpl:fakeFetch(Buffer.alloc(128))}),/TOO_LARGE/);
 await assert.rejects(downloadInboundImage(raw(),{maxBytes:Infinity,fetchImpl:async()=>{count++;}}),/LIMIT_INVALID/);
 await assert.rejects(downloadInboundImage({item_list:[item(),item()]},{fetchImpl:async()=>{count++;}}),/NOT_SINGLE/);
 assert.equal(count,0);
 assert.equal(MAX_WEIXIN_IMAGE_BYTES,12*1024*1024);
});
