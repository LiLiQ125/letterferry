import test from 'node:test';
import assert from 'node:assert/strict';
import {CHATGPT_IMAGE_INPUT_LABELS} from '../web-extension/image-attachment-preflight.mjs';
import {inspectChatGptImageSurface} from '../web-extension/image-readonly-qualification.mjs';

const URL='https://chatgpt.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRIVATE_DRAFT='unfinished private draft 7f81';
const PRIVATE_REPLY='private model response 8a92';
const PRIVATE_ID='private-full-message-id-09fa';

function node({tagName='DIV',attrs={},text='',disabled=false,readOnly=false,bodyCount=0,mutations}={}){
  const bodies=Array.from({length:bodyCount},()=>({}));
  const value={tagName,disabled,readOnly,isContentEditable:attrs.contenteditable==='true',
    innerText:text,textContent:text,value:tagName==='TEXTAREA'?text:undefined,
    getAttribute(name){return attrs[name]??null;},
    contains(other){return bodies.includes(other);},
    querySelectorAll(selector){return selector.includes('[data-testid="message-text"]')?bodies:[];},
    click(){mutations.count++;},dispatchEvent(){mutations.count++;},focus(){mutations.count++;}};
  Object.defineProperty(value,'files',{get(){mutations.fileReads++;throw Error('FILES_MUST_NOT_BE_READ');}});
  return value;
}

function setup({href=URL,draft='',inputCount=1,inputLabels=null,label=CHATGPT_IMAGE_INPUT_LABELS[2],accept='image/*',
  disabled=false,knownPreview=0,unknownPreview=0,uploading=false,uploadError=false,
  layout='grouped',roleLabels=0,missingIds=false,duplicateIds=false,assistantBodyCount=1,
  throwSelector=null}={}){
  const mutations={count:0,fileReads:0};
  const composer=node({attrs:{contenteditable:'true'},text:draft,mutations});
  const inputs=Array.from({length:inputLabels?.length??inputCount},(_unused,index)=>node({tagName:'INPUT',disabled,
    attrs:{type:'file','aria-label':inputLabels?.[index]??label,accept},mutations}));
  const id=(role,index)=>missingIds?{}:{'data-content-search-unit-key':duplicateIds?'thread:'+PRIVATE_ID:
    'thread:'+index+':'+role,'data-message-id':duplicateIds?PRIVATE_ID:role+'-'+index};
  const groupedUser=[node({attrs:id('user',1),text:'private user text',mutations})];
  const groupedAssistant=[node({attrs:id('assistant',1),text:PRIVATE_REPLY,bodyCount:assistantBodyCount,mutations})];
  const legacyUser=[node({attrs:{'data-message-author-role':'user','data-message-id':'legacy-user'},mutations})];
  const legacyAssistant=[node({attrs:{'data-message-author-role':'assistant','data-message-id':'legacy-assistant'},
    text:PRIVATE_REPLY,bodyCount:assistantBodyCount,mutations})];
  const speakerLabels=Array.from({length:roleLabels},()=>node({attrs:{'data-role':'assistant'},text:'ChatGPT',mutations}));
  const previews=Array.from({length:knownPreview},()=>node({attrs:{'data-testid':'attachment-preview'},mutations}));
  const unknown=Array.from({length:unknownPreview},()=>node({attrs:{'data-testid':'new-attachment-layout'},mutations}));
  const uploadNodes=uploading?[node({attrs:{'data-upload-state':'uploading'},mutations})]:[];
  const errorNodes=uploadError?[node({attrs:{'data-upload-state':'error'},mutations})]:[];
  const document={
    querySelectorAll(selector){
      if(selector===throwSelector)throw Error('private DOM failure '+PRIVATE_REPLY);
      if(selector==='#prompt-textarea')return [composer];
      if(selector==='input[type="file"]')return inputs;
      if(selector.startsWith('label[for='))return [];
      if(selector==='[data-testid="attachment-preview"]')return previews;
      if(selector==='[data-testid*="attachment"], [data-testid*="file-preview"], [data-upload-state]')
        return [...previews,...unknown,...uploadNodes,...errorNodes];
      if(selector.includes('[data-upload-state="uploading"]'))return uploadNodes;
      if(selector.includes('[data-upload-state="error"]'))return errorNodes;
      if(selector==='[data-content-search-unit-key$=":user"]')return layout==='grouped'?groupedUser:[];
      if(selector==='[data-content-search-unit-key$=":assistant"]')return layout==='grouped'?groupedAssistant:[];
      if(selector==='[data-message-author-role="user"]')return layout==='legacy'?legacyUser:[];
      if(selector==='[data-message-author-role="assistant"]')return layout==='legacy'?legacyAssistant:[];
      if(selector==='[data-role="assistant"]')return speakerLabels;
      return [];
    },
    execCommand(){mutations.count++;throw Error('WRITE_FORBIDDEN');}
  };
  Object.defineProperty(document,'cookie',{get(){throw Error('COOKIE_FORBIDDEN');}});
  return {document,location:{href},mutations,composer,inputs};
}

function inspect(fake,boundUrl=URL){return inspectChatGptImageSurface({document:fake.document,
  location:fake.location,boundUrl});}
function assertReadOnly(fake,result){
  assert.equal(fake.mutations.count,0);
  assert.equal(fake.mutations.fileReads,0);
  const output=JSON.stringify(result);
  for(const secret of [PRIVATE_DRAFT,PRIVATE_REPLY,PRIVATE_ID,'private user text'])assert.equal(output.includes(secret),false);
}

test('clean grouped fake DOM is only a controlled-test candidate with fixed non-sensitive schema',()=>{
  const fake=setup(),result=inspect(fake);
  assert.equal(result.eligibleForControlledTest,true);
  assert.equal(result.reason,'READY_FOR_CONTROLLED_TEST_CANDIDATE');
  assert.equal(result.capabilities.readOnlyCandidateOnly,true);
  assert.equal(result.turns.canonicalUserCount,1);
  assert.equal(result.turns.canonicalAssistantCount,1);
  assert.equal(result.turns.assistantWithBodyCount,1);
  assert.deepEqual(Object.keys(result).sort(),
    ['attachment','capabilities','composer','eligibleForControlledTest','fileInput','qualificationVersion','reason','turns']);
  assertReadOnly(fake,result);
});

test('invalid binding and navigation mismatch return bounded reports without reading DOM content',()=>{
  const fake=setup();
  for(const [bound,reason] of [['https://chatgpt.com/c/not-a-conversation','BOUND_URL_INVALID'],
    [URL+'?leak=1','BOUND_URL_INVALID'],['https://chatgpt.com/c/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','BOUND_TAB_CHANGED']]){
    const result=inspect(fake,bound);
    assert.equal(result.eligibleForControlledTest,false);
    assert.equal(result.reason,reason);
    assert.equal(result.composer.candidateCount,0);
    assertReadOnly(fake,result);
  }
});

test('all four surveyed labels are counted, while missing, multiple, disabled and unsafe inputs fail closed',()=>{
  for(const label of CHATGPT_IMAGE_INPUT_LABELS){
    const fake=setup({label}),result=inspect(fake);
    assert.equal(result.eligibleForControlledTest,true);
    assert.equal(result.fileInput.knownLabelCount,1);
    assert.equal(result.fileInput.labelMatchCounts.reduce((a,b)=>a+b,0),1);
    assertReadOnly(fake,result);
  }
  for(const [options,reason] of [[{inputCount:0},'IMAGE_FILE_INPUT_NOT_FOUND'],
    [{inputCount:2},'IMAGE_FILE_INPUT_AMBIGUOUS'],[{disabled:true},'IMAGE_FILE_INPUT_UNSAFE'],
    [{accept:'application/pdf'},'IMAGE_FILE_INPUT_UNSAFE'],[{label:'unknown private label'},'IMAGE_FILE_INPUT_NOT_FOUND']]){
    const fake=setup(options),result=inspect(fake);
    assert.equal(result.reason,reason);assert.equal(result.eligibleForControlledTest,false);assertReadOnly(fake,result);
  }
});

test('four distinct image inputs on current page are not inherently ambiguous',()=>{
  const fake=setup({inputLabels:[...CHATGPT_IMAGE_INPUT_LABELS]});
  const result=inspect(fake);
  assert.equal(result.fileInput.totalCount,4);
  assert.equal(result.fileInput.knownLabelCount,4);
  assert.equal(result.capabilities.uniqueSafeImageInput,true);
  assert.equal(result.eligibleForControlledTest,true);
  assertReadOnly(fake,result);
});

test('human draft is detected only as a boolean/count and never returned or changed',()=>{
  const fake=setup({draft:PRIVATE_DRAFT}),before=fake.composer.textContent,result=inspect(fake);
  assert.equal(result.reason,'HUMAN_DRAFT_PRESENT');
  assert.equal(result.composer.draftCount,1);
  assert.equal(fake.composer.textContent,before);
  assertReadOnly(fake,result);
});

test('existing preview, uploading, error and unknown preview selector states are distinct fail-closed results',()=>{
  for(const [options,reason] of [[{knownPreview:1},'ATTACHMENT_PREVIEW_PRESENT'],
    [{uploading:true},'ATTACHMENT_UPLOAD_IN_PROGRESS'],[{uploadError:true},'ATTACHMENT_UPLOAD_ERROR'],
    [{unknownPreview:1},'PREVIEW_SELECTOR_UNKNOWN']]){
    const fake=setup(options),result=inspect(fake);
    assert.equal(result.reason,reason);assert.equal(result.eligibleForControlledTest,false);assertReadOnly(fake,result);
  }
});

test('grouped canonical turns never count generic role speaker labels as assistant responses',()=>{
  const fake=setup({roleLabels:4}),result=inspect(fake);
  assert.equal(result.turns.groupedAssistantCount,1);
  assert.equal(result.turns.canonicalAssistantCount,1);
  assert.equal(result.turns.roleOnlyAssistantCount,4);
  assert.equal(result.turns.selectorMultiplicityRisk,true);
  assert.equal(result.reason,'TURN_LAYOUT_AMBIGUOUS');
  assert.equal(result.eligibleForControlledTest,false);
  assertReadOnly(fake,result);
});

test('one legacy wrapper family can qualify, but missing and competing layouts cannot',()=>{
  const legacy=setup({layout:'legacy'}),legacyResult=inspect(legacy);
  assert.equal(legacyResult.eligibleForControlledTest,true);
  assert.equal(legacyResult.turns.legacyFamilyCount,1);
  assertReadOnly(legacy,legacyResult);

  const missing=setup({layout:'none'}),missingResult=inspect(missing);
  assert.equal(missingResult.reason,'TURN_LAYOUT_UNKNOWN');
  assertReadOnly(missing,missingResult);

  const competing=setup({layout:'legacy',roleLabels:1}),competingResult=inspect(competing);
  assert.equal(competingResult.reason,'TURN_LAYOUT_AMBIGUOUS');
  assertReadOnly(competing,competingResult);
});

test('missing or duplicate turn IDs and unknown or ambiguous assistant bodies remain ineligible',()=>{
  for(const [options,reason] of [[{missingIds:true},'TURN_ID_UNAVAILABLE'],
    [{duplicateIds:true},'TURN_ID_DUPLICATE'],[{assistantBodyCount:0},'ASSISTANT_BODY_STRUCTURE_UNKNOWN'],
    [{assistantBodyCount:2},'ASSISTANT_BODY_STRUCTURE_AMBIGUOUS']]){
    const fake=setup(options),result=inspect(fake);
    assert.equal(result.reason,reason);assert.equal(result.eligibleForControlledTest,false);assertReadOnly(fake,result);
  }
});

test('DOM exceptions are sanitized and no page text, Files, cookies, events or mutations escape',()=>{
  const fake=setup({throwSelector:'input[type="file"]'}),result=inspect(fake);
  assert.equal(result.reason,'DOM_READ_FAILED');
  assert.equal(result.eligibleForControlledTest,false);
  assertReadOnly(fake,result);
});
