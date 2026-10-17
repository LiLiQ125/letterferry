// Offline candidate only. This module is deliberately not loaded by manifest.json
// and has no capability to find or click a ChatGPT send button.
export const CHATGPT_IMAGE_INPUT_LABELS=Object.freeze([
  '拍照',
  '附加照片或视频',
  '添加照片',
  '附加文件'
]);

export const MAX_CHATGPT_IMAGE_BYTES=12*1024*1024;
const ALLOWED_MIME=Object.freeze(new Set(['image/jpeg','image/png','image/gif','image/webp']));
const EXTENSION_BY_MIME=Object.freeze({
  'image/jpeg':new Set(['.jpg','.jpeg']),
  'image/png':new Set(['.png']),
  'image/gif':new Set(['.gif']),
  'image/webp':new Set(['.webp'])
});

const COMPOSER_SELECTORS=Object.freeze([
  '#prompt-textarea',
  '[data-testid="composer-input"]',
  '[data-testid="prompt-textarea"]',
  '#prompt-textarea [contenteditable="true"]',
  '[data-testid="composer-input"] [contenteditable="true"]',
  '[data-testid="composer"] [contenteditable="true"]',
  'form [contenteditable="true"][role="textbox"]',
  'form [contenteditable="true"].ProseMirror',
  'form textarea'
]);
const PREVIEW_SELECTOR=[
  '[data-testid="attachment-preview"]',
  '[data-testid="file-preview"]',
  '[data-testid="composer-attachment"]',
  '[data-testid="composer-file-preview"]'
].join(', ');
const UPLOADING_SELECTOR=[
  '[data-upload-state="uploading"]',
  '[data-testid="upload-progress"]',
  '[aria-label="正在上传"]',
  '[aria-label="Uploading"]'
].join(', ');
const UPLOAD_ERROR_SELECTOR=[
  '[data-upload-state="error"]',
  '[data-testid="upload-error"]',
  '[aria-label="上传失败"]',
  '[aria-label="Upload failed"]'
].join(', ');

function failure(code){const error=new Error(code);error.code=code;return error;}
function checkedCode(error){
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.code||error?.message||'')
    ? (error.code||error.message) : 'ATTACHMENT_DOM_ERROR';
}
function unique(nodes){return [...new Set(nodes.filter(Boolean))];}

export function validBoundChatUrl(value){
  try{
    const url=new URL(value);
    return url.protocol==='https:'&&url.hostname==='chatgpt.com'&&!url.username&&!url.password&&
      !url.hash&&/^(?:\/c\/|\/g\/[^/]+\/c\/)[0-9a-f-]{36}\/?$/i.test(url.pathname);
  }catch{return false;}
}

function detectedMime(bytes){
  if(bytes.length>=3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return 'image/jpeg';
  if(bytes.length>=8&&[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a].every((v,i)=>bytes[i]===v))return 'image/png';
  if(bytes.length>=6){
    const head=String.fromCharCode(...bytes.subarray(0,6));
    if(head==='GIF87a'||head==='GIF89a')return 'image/gif';
  }
  if(bytes.length>=12&&String.fromCharCode(...bytes.subarray(0,4))==='RIFF'&&
    String.fromCharCode(...bytes.subarray(8,12))==='WEBP')return 'image/webp';
  return null;
}

export function validateImageForAttachment(image,{maxBytes=MAX_CHATGPT_IMAGE_BYTES}={}){
  if(!Number.isSafeInteger(maxBytes)||maxBytes<64||maxBytes>MAX_CHATGPT_IMAGE_BYTES)
    throw failure('IMAGE_LIMIT_INVALID');
  if(!image||!(image.bytes instanceof Uint8Array))throw failure('IMAGE_BYTES_INVALID');
  if(image.bytes.byteLength===0)throw failure('IMAGE_BYTES_EMPTY');
  if(image.bytes.byteLength>maxBytes)throw failure('IMAGE_TOO_LARGE');
  if(typeof image.mimeType!=='string'||!ALLOWED_MIME.has(image.mimeType))
    throw failure('IMAGE_MIME_UNSUPPORTED');
  if(detectedMime(image.bytes)!==image.mimeType)throw failure('IMAGE_MIME_MISMATCH');
  if(typeof image.fileName!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(image.fileName))
    throw failure('IMAGE_FILENAME_INVALID');
  const lower=image.fileName.toLowerCase();
  if(![...EXTENSION_BY_MIME[image.mimeType]].some(ext=>lower.endsWith(ext)))
    throw failure('IMAGE_FILENAME_MISMATCH');
  return {bytes:image.bytes,mimeType:image.mimeType,fileName:image.fileName,size:image.bytes.byteLength};
}

function nodeText(node){
  if(node?.tagName==='TEXTAREA')return String(node.value??'');
  return String(node?.innerText??node?.textContent??'');
}
function usableComposer(node){
  if(!node||node.disabled||node.readOnly||node.getAttribute?.('aria-disabled')==='true')return false;
  return node.tagName==='TEXTAREA'||node.isContentEditable===true||node.getAttribute?.('contenteditable')==='true';
}
function accessibleName(node,document){
  const direct=node.getAttribute?.('aria-label');
  if(typeof direct==='string'&&direct)return direct.trim();
  const id=node.getAttribute?.('id');
  if(!id)return '';
  const labels=[...(document.querySelectorAll?.('label[for="'+String(id).replace(/["\\]/g,'\\$&')+'"]')||[])];
  return labels.length===1?nodeText(labels[0]).trim():'';
}
function acceptAllows(input,mimeType){
  const accept=String(input.getAttribute?.('accept')||'').toLowerCase();
  if(!accept.trim())return false;
  const values=accept.split(',').map(value=>value.trim()).filter(Boolean);
  return values.includes('image/*')||values.includes(mimeType)||
    [...EXTENSION_BY_MIME[mimeType]].some(ext=>values.includes(ext));
}
function previewName(node){
  const values=[nodeText(node),'aria-label','title','alt','data-file-name','data-filename']
    .map(value=>typeof value==='string'&&value.includes('data-')?node.getAttribute?.(value):
      typeof value==='string'&&['aria-label','title','alt'].includes(value)?node.getAttribute?.(value):value)
    .filter(value=>typeof value==='string');
  return values.join('\n');
}

export function createDomImageAttachmentAdapter({
  document,location,FileCtor=globalThis.File,DataTransferCtor=globalThis.DataTransfer,
  EventCtor=globalThis.Event,now=()=>Date.now(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
}={}){
  if(!document||!location)throw failure('ATTACHMENT_ADAPTER_INVALID');
  return {
    now,sleep,
    currentUrl:()=>String(location.href||''),
    composerCandidates:()=>unique(COMPOSER_SELECTORS.flatMap(selector=>
      [...(document.querySelectorAll?.(selector)||[])])),
    composerUsable:usableComposer,
    composerText:nodeText,
    attachmentInputs:()=>[...(document.querySelectorAll?.('input[type="file"]')||[])]
      .filter(node=>CHATGPT_IMAGE_INPUT_LABELS.includes(accessibleName(node,document))),
    inputLabel:node=>accessibleName(node,document),
    inputUsable:(node,mimeType)=>Boolean(node&&!node.disabled&&node.getAttribute?.('aria-disabled')!=='true'&&
      String(node.getAttribute?.('type')||node.type||'').toLowerCase()==='file'&&acceptAllows(node,mimeType)),
    inputFiles:node=>[...(node?.files||[])],
    previewNodes:()=>unique([...(document.querySelectorAll?.(PREVIEW_SELECTOR)||[])]),
    previewMatches:(node,file)=>previewName(node).includes(file.name),
    uploading:()=>Boolean(document.querySelector?.(UPLOADING_SELECTOR)),
    uploadError:()=>Boolean(document.querySelector?.(UPLOAD_ERROR_SELECTOR)),
    makeFile(image){
      if(typeof FileCtor!=='function')throw failure('FILE_CONSTRUCTOR_UNAVAILABLE');
      return new FileCtor([image.bytes],image.fileName,{type:image.mimeType,lastModified:0});
    },
    attach(input,file){
      if(typeof DataTransferCtor!=='function'||typeof EventCtor!=='function')
        throw failure('FILE_INJECTION_UNAVAILABLE');
      const transfer=new DataTransferCtor();
      if(!transfer.items?.add)throw failure('FILE_INJECTION_UNAVAILABLE');
      transfer.items.add(file);
      input.files=transfer.files;
      input.dispatchEvent(new EventCtor('input',{bubbles:true}));
      input.dispatchEvent(new EventCtor('change',{bubbles:true}));
    }
  };
}

function requireBoundTarget(boundUrl,adapter){
  if(!validBoundChatUrl(boundUrl))throw failure('BOUND_URL_INVALID');
  if(adapter.currentUrl()!==boundUrl)throw failure('BOUND_TAB_CHANGED');
}
function requireComposer(adapter){
  const nodes=unique(adapter.composerCandidates());
  if(nodes.length===0)throw failure('COMPOSER_NOT_FOUND');
  if(nodes.length!==1)throw failure('COMPOSER_AMBIGUOUS');
  if(!adapter.composerUsable(nodes[0]))throw failure('COMPOSER_DISABLED');
  if(adapter.composerText(nodes[0]).trim())throw failure('COMPOSER_NOT_EMPTY');
  return nodes[0];
}
// Current ChatGPT commonly renders four different named file inputs at once.
// Choose only by a fixed, image-specific label priority; never choose by DOM
// order or match an arbitrary generic file control. Duplicate labels fail closed.
const IMAGE_INPUT_PRIORITY=Object.freeze(['添加照片','附加照片或视频','附加文件','拍照']);
function requireInput(adapter,mimeType,{allowSelected=false}={}){
  const inputs=unique(adapter.attachmentInputs());
  if(inputs.length===0)throw failure('IMAGE_FILE_INPUT_NOT_FOUND');
  let selected=null;
  for(const label of IMAGE_INPUT_PRIORITY){
    const same=inputs.filter(input=>adapter.inputLabel(input)===label);
    if(same.length>1)throw failure('IMAGE_FILE_INPUT_AMBIGUOUS');
    if(same.length===1&&adapter.inputUsable(same[0],mimeType)){
      selected=same[0];break;
    }
  }
  if(!selected){
    if(inputs.length===1&&(inputs[0].disabled||inputs[0].getAttribute?.('aria-disabled')==='true'))
      throw failure('IMAGE_FILE_INPUT_DISABLED');
    throw failure('IMAGE_FILE_INPUT_UNSAFE');
  }
  if(!allowSelected&&adapter.inputFiles(selected).length)throw failure('IMAGE_FILE_INPUT_OCCUPIED');
  return selected;
}
function fileStillSelected(adapter,input,file){
  const files=adapter.inputFiles(input);
  return files.length===1&&files[0]?.name===file.name&&files[0]?.type===file.type&&files[0]?.size===file.size;
}
function matchingNewPreviews(adapter,before,file){
  return unique(adapter.previewNodes()).filter(node=>!before.has(node)&&adapter.previewMatches(node,file));
}

export async function preflightAndAttachChatGptImage({
  boundUrl,image,adapter,timeoutMs=4500,pollMs=100,maxBytes=MAX_CHATGPT_IMAGE_BYTES
}={}){
  if(!adapter||typeof adapter.currentUrl!=='function')throw failure('ATTACHMENT_ADAPTER_INVALID');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>15_000||
    !Number.isSafeInteger(pollMs)||pollMs<10||pollMs>timeoutMs)throw failure('ATTACHMENT_TIMEOUT_INVALID');
  const checked=validateImageForAttachment(image,{maxBytes});
  try{
    requireBoundTarget(boundUrl,adapter);
    requireComposer(adapter);
    const input=requireInput(adapter,checked.mimeType);
    if(adapter.uploadError())throw failure('ATTACHMENT_UPLOAD_ERROR');
    if(adapter.uploading())throw failure('ATTACHMENT_UPLOAD_IN_PROGRESS');
    const beforeNodes=unique(adapter.previewNodes());
    if(beforeNodes.length)throw failure('ATTACHMENT_STATE_NOT_EMPTY');
    const before=new Set(beforeNodes);
    const file=adapter.makeFile(checked);

    // Recheck immediately before the only mutation in this module.
    requireBoundTarget(boundUrl,adapter);
    requireComposer(adapter);
    if(requireInput(adapter,checked.mimeType)!==input)throw failure('IMAGE_FILE_INPUT_CHANGED');
    adapter.attach(input,file);

    const deadline=adapter.now()+timeoutMs;
    let firstPreview=null;
    while(adapter.now()<deadline){
      requireBoundTarget(boundUrl,adapter);
      requireComposer(adapter);
      if(requireInput(adapter,checked.mimeType,{allowSelected:true})!==input)
        throw failure('IMAGE_FILE_INPUT_CHANGED');
      if(!fileStillSelected(adapter,input,file))throw failure('ATTACHED_FILE_NOT_CONFIRMED');
      if(adapter.uploadError())throw failure('ATTACHMENT_UPLOAD_ERROR');
      const matches=matchingNewPreviews(adapter,before,file);
      const allNew=unique(adapter.previewNodes()).filter(node=>!before.has(node));
      if(matches.length>1||allNew.length>1)throw failure('ATTACHMENT_PREVIEW_AMBIGUOUS');
      if(matches.length===1&&!adapter.uploading()){
        if(firstPreview===matches[0]){
          // A second independent DOM observation is required before a caller may
          // proceed. No image bytes or chat text are returned.
          return {readyForSubmit:true,sendClicked:false,previewChecks:2,
            file:{name:file.name,type:file.type,size:file.size},inputLabel:adapter.inputLabel(input)};
        }
        firstPreview=matches[0];
      }else if(firstPreview){
        throw failure('ATTACHMENT_PREVIEW_RECHECK_FAILED');
      }
      await adapter.sleep(pollMs);
    }
    throw failure(firstPreview?'ATTACHMENT_PREVIEW_RECHECK_TIMEOUT':'ATTACHMENT_PREVIEW_TIMEOUT');
  }catch(error){throw failure(checkedCode(error));}
}
