import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHATGPT_IMAGE_INPUT_LABELS,MAX_CHATGPT_IMAGE_BYTES,createDomImageAttachmentAdapter,
  preflightAndAttachChatGptImage,validateImageForAttachment
} from '../web-extension/image-attachment-preflight.mjs';

const url='https://chatgpt.com/g/riven/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const png=()=>({
  bytes:new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3,4]),
  mimeType:'image/png',fileName:'wechat-image.png'
});

class FakeFile{
  constructor(parts,name,{type,lastModified}){
    this.name=name;this.type=type;this.lastModified=lastModified;
    this.size=parts.reduce((sum,part)=>sum+part.byteLength,0);
  }
}
class FakeDataTransfer{
  constructor(){
    const files=[];
    this.items={add:file=>files.push(file)};
    Object.defineProperty(this,'files',{get:()=>files});
  }
}
class FakeEvent{constructor(type,options){this.type=type;this.bubbles=options?.bubbles===true;}}

function node({tagName='DIV',attrs={},text='',disabled=false,files=[]}={}){
  return {tagName,disabled,readOnly:false,isContentEditable:tagName==='DIV',textContent:text,innerText:text,
    value:tagName==='TEXTAREA'?text:undefined,files,events:[],
    getAttribute(name){return attrs[name]??null;},
    dispatchEvent(event){this.events.push(event.type);this.onDispatch?.(event);}
  };
}

function setup({label='添加照片',inputLabels=null,accept='image/*',draft='',inputCount=1,disabled=false,
  preexistingPreview=false,initialUploading=false,onChange='preview',throwOnDispatch=false,
  changeUrlAfterAttach=false}={}){
  let time=1000,uploading=initialUploading,uploadError=false,location={href:url};
  let previews=preexistingPreview?[node({attrs:{'data-file-name':'prior.png'},text:'prior.png'})]:[];
  const composer=node({tagName:'DIV',attrs:{contenteditable:'true'},text:draft});
  const inputs=Array.from({length:inputLabels?.length??inputCount},(_unused,index)=>node({tagName:'INPUT',disabled,attrs:{
    type:'file','aria-label':inputLabels?.[index]??label,accept
  }}));
  for(const input of inputs)input.onDispatch=event=>{
    if(event.type!=='change')return;
    if(throwOnDispatch)throw Error('private exception with image bytes');
    if(changeUrlAfterAttach)location.href='https://chatgpt.com/c/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    if(onChange==='preview')previews=[node({attrs:{'data-file-name':'wechat-image.png'},text:'wechat-image.png'})];
    if(onChange==='uploading'){uploading=true;previews=[node({text:'wechat-image.png'})];}
    if(onChange==='error')uploadError=true;
  };
  const document={
    querySelectorAll(selector){
      if(selector==='#prompt-textarea')return [composer];
      if(selector==='input[type="file"]')return inputs;
      if(selector.startsWith('label[for='))return [];
      if(selector.includes('[data-testid="attachment-preview"]'))return previews;
      return [];
    },
    querySelector(selector){
      if(selector.includes('[data-upload-state="uploading"]'))return uploading?{}:null;
      if(selector.includes('[data-upload-state="error"]'))return uploadError?{}:null;
      return null;
    }
  };
  const adapter=createDomImageAttachmentAdapter({document,location,FileCtor:FakeFile,
    DataTransferCtor:FakeDataTransfer,EventCtor:FakeEvent,now:()=>time,
    sleep:async ms=>{time+=ms;if(onChange==='uploading'&&time>=1200)uploading=false;
      if(onChange==='vanish'&&time>=1100)previews=[];}}
  );
  return {adapter,composer,inputs,previews:()=>previews,setPreviews:value=>{previews=value;},location};
}

async function code(promise,expected){
  await assert.rejects(promise,error=>error.message===expected&&error.code===expected);
}

test('all four observed Chinese accessibility labels attach and receive two preview checks',async()=>{
  assert.deepEqual(CHATGPT_IMAGE_INPUT_LABELS,['拍照','附加照片或视频','添加照片','附加文件']);
  for(const label of CHATGPT_IMAGE_INPUT_LABELS){
    const fake=setup({label});
    const result=await preflightAndAttachChatGptImage({boundUrl:url,image:png(),adapter:fake.adapter,
      timeoutMs:500,pollMs:100});
    assert.deepEqual(result,{readyForSubmit:true,sendClicked:false,previewChecks:2,
      file:{name:'wechat-image.png',type:'image/png',size:12},inputLabel:label});
    assert.deepEqual(fake.inputs[0].events,['input','change']);
    assert.equal(fake.composer.textContent,'');
    assert.equal(JSON.stringify(result).includes('89504e47'),false);
  }
});

test('four distinct real-page labels select the one named 添加照片, not arbitrary first input',async()=>{
  const fake=setup({inputLabels:[...CHATGPT_IMAGE_INPUT_LABELS]});
  const result=await preflightAndAttachChatGptImage({boundUrl:url,image:png(),adapter:fake.adapter,
    timeoutMs:500,pollMs:100});
  assert.equal(result.readyForSubmit,true);
  assert.equal(result.inputLabel,'添加照片');
  assert.deepEqual(fake.inputs.map(input=>input.events),[[],[],['input','change'],[]]);
});

test('exact bound conversation is required before any file mutation',async()=>{
  for(const boundUrl of ['https://chatgpt.com/c/other',
    'https://evil.example/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'https://chatgpt.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa#wrong']){
    const fake=setup();
    await code(preflightAndAttachChatGptImage({boundUrl,image:png(),adapter:fake.adapter}),'BOUND_URL_INVALID');
    assert.deepEqual(fake.inputs[0].events,[]);
  }
  const fake=setup();
  fake.location.href='https://chatgpt.com/c/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await code(preflightAndAttachChatGptImage({boundUrl:url,image:png(),adapter:fake.adapter}),'BOUND_TAB_CHANGED');
  assert.deepEqual(fake.inputs[0].events,[]);
});

test('MIME magic, allowlist, size, filename and extension are validated before DOM access',()=>{
  assert.equal(validateImageForAttachment(png()).size,12);
  assert.throws(()=>validateImageForAttachment({...png(),mimeType:'image/jpeg'}),/IMAGE_MIME_MISMATCH/);
  assert.throws(()=>validateImageForAttachment({...png(),mimeType:'image/svg+xml'}),/IMAGE_MIME_UNSUPPORTED/);
  assert.throws(()=>validateImageForAttachment({...png(),fileName:'photo.jpg'}),/IMAGE_FILENAME_MISMATCH/);
  assert.throws(()=>validateImageForAttachment({...png(),fileName:'..\\secret.png'}),/IMAGE_FILENAME_INVALID/);
  assert.throws(()=>validateImageForAttachment({...png(),bytes:new Uint8Array(MAX_CHATGPT_IMAGE_BYTES+1)}),/IMAGE_TOO_LARGE/);
});

test('missing, disabled, ambiguous, unsafe and occupied file inputs fail closed',async()=>{
  const cases=[
    [{inputCount:0},'IMAGE_FILE_INPUT_NOT_FOUND'],
    [{disabled:true},'IMAGE_FILE_INPUT_DISABLED'],
    [{inputCount:2},'IMAGE_FILE_INPUT_AMBIGUOUS'],
    [{accept:''},'IMAGE_FILE_INPUT_UNSAFE'],
    [{accept:'application/pdf'},'IMAGE_FILE_INPUT_UNSAFE']
  ];
  for(const [options,expected] of cases){
    const fake=setup(options);
    await code(preflightAndAttachChatGptImage({boundUrl:url,image:png(),adapter:fake.adapter}),expected);
    assert.equal(fake.inputs.flatMap(input=>input.events).length,0);
  }
  const fake=setup();
  fake.inputs[0].files=[new FakeFile([png().bytes],'prior.png',{type:'image/png'})];
  await code(preflightAndAttachChatGptImage({boundUrl:url,image:png(),adapter:fake.adapter}),'IMAGE_FILE_INPUT_OCCUPIED');
});

test('human draft, existing preview and preexisting upload state are never overwritten',async()=>{
  for(const [options,expected] of [
    [{draft:'unfinished private draft'},'COMPOSER_NOT_EMPTY'],
    [{preexistingPreview:true},'ATTACHMENT_STATE_NOT_EMPTY'],
    [{initialUploading:true},'ATTACHMENT_UPLOAD_IN_PROGRESS']
  ]){
    const fake=setup(options);
    await code(preflightAndAttachChatGptImage({boundUrl:url,image:png(),adapter:fake.adapter}),expected);
    assert.deepEqual(fake.inputs[0].events,[]);
  }
});

test('a preview must become visible and remain valid for a second observation',async()=>{
  const missing=setup({onChange:'none'});
  await code(preflightAndAttachChatGptImage({boundUrl:url,image:png(),adapter:missing.adapter,
    timeoutMs:300,pollMs:100}),'ATTACHMENT_PREVIEW_TIMEOUT');

  const vanish=setup({onChange:'preview'});
  let sleeps=0;
  const originalSleep=vanish.adapter.sleep;
  vanish.adapter.sleep=async ms=>{await originalSleep(ms);if(++sleeps===1)vanish.setPreviews([]);};
  await code(preflightAndAttachChatGptImage({boundUrl:url,image:png(),adapter:vanish.adapter,
    timeoutMs:300,pollMs:100}),'ATTACHMENT_PREVIEW_RECHECK_FAILED');
});

test('uploading preview is not accepted until upload clears, then is checked twice',async()=>{
  const fake=setup({onChange:'uploading'});
  const result=await preflightAndAttachChatGptImage({boundUrl:url,image:png(),adapter:fake.adapter,
    timeoutMs:500,pollMs:100});
  assert.equal(result.readyForSubmit,true);
  assert.equal(result.previewChecks,2);
  assert.equal(result.sendClicked,false);
});

test('upload errors, ambiguous previews, navigation and DOM exceptions are sanitized',async()=>{
  const failed=setup({onChange:'error'});
  await code(preflightAndAttachChatGptImage({boundUrl:url,image:png(),adapter:failed.adapter}),
    'ATTACHMENT_UPLOAD_ERROR');

  const ambiguous=setup({onChange:'preview'});
  const second=node({text:'wechat-image.png'});
  const original=ambiguous.adapter.sleep;
  ambiguous.adapter.sleep=async ms=>{await original(ms);ambiguous.setPreviews([...ambiguous.previews(),second]);};
  await code(preflightAndAttachChatGptImage({boundUrl:url,image:png(),adapter:ambiguous.adapter}),
    'ATTACHMENT_PREVIEW_AMBIGUOUS');

  const navigated=setup({changeUrlAfterAttach:true});
  await code(preflightAndAttachChatGptImage({boundUrl:url,image:png(),adapter:navigated.adapter}),
    'BOUND_TAB_CHANGED');

  const exceptional=setup({throwOnDispatch:true});
  await code(preflightAndAttachChatGptImage({boundUrl:url,image:png(),adapter:exceptional.adapter}),
    'ATTACHMENT_DOM_ERROR');
});

test('the module exposes no submit action and never writes image bytes into composer text',async()=>{
  const fake=setup();
  const before=fake.composer.textContent;
  const result=await preflightAndAttachChatGptImage({boundUrl:url,image:png(),adapter:fake.adapter,
    timeoutMs:500,pollMs:100});
  assert.equal(fake.composer.textContent,before);
  assert.equal('click' in fake.inputs[0],false);
  assert.equal(result.sendClicked,false);
  assert.equal(JSON.stringify(result).includes('137,80,78,71'),false);
});
