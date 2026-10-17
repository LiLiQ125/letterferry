// Offline, synchronous, read-only qualification candidate. This module is not
// loaded by manifest.json and deliberately exposes no browser mutation method.
import {CHATGPT_IMAGE_INPUT_LABELS} from './image-attachment-preflight.mjs';

// Match the same fixed label preference as the attachment preflight. Multiple
// distinct named inputs exist on the observed ChatGPT page and are normal.
const IMAGE_INPUT_PRIORITY=Object.freeze(['添加照片','附加照片或视频','附加文件','拍照']);
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
const PREVIEW_SELECTORS=Object.freeze([
  '[data-testid="attachment-preview"]',
  '[data-testid="file-preview"]',
  '[data-testid="composer-attachment"]',
  '[data-testid="composer-file-preview"]'
]);
const GENERIC_ATTACHMENT_SELECTOR='[data-testid*="attachment"], [data-testid*="file-preview"], [data-upload-state]';
const UPLOADING_SELECTOR='[data-upload-state="uploading"], [data-testid="upload-progress"], [aria-label="Uploading"]';
const ERROR_SELECTOR='[data-upload-state="error"], [data-testid="upload-error"], [aria-label="Upload failed"]';
const GROUPED=Object.freeze({
  user:'[data-content-search-unit-key$=":user"]',
  assistant:'[data-content-search-unit-key$=":assistant"]'
});
const LEGACY=Object.freeze([
  Object.freeze({user:'[data-message-author-role="user"]',assistant:'[data-message-author-role="assistant"]'}),
  Object.freeze({user:'[data-conversation-role="user"]',assistant:'[data-conversation-role="assistant"]'}),
  Object.freeze({user:'article[data-turn="user"]',assistant:'article[data-turn="assistant"]'}),
  Object.freeze({user:'[data-testid^="conversation-turn-"][data-turn="user"]',assistant:'[data-testid^="conversation-turn-"][data-turn="assistant"]'}),
  Object.freeze({user:'[data-message-author="user"]',assistant:'[data-message-author="assistant"]'}),
  Object.freeze({user:'[data-role="user"]',assistant:'[data-role="assistant"]'})
]);
const TURN_ID_ATTRIBUTES=Object.freeze([
  'data-content-search-unit-key','data-message-id','data-turn-id','data-turn-key'
]);
const ASSISTANT_BODY_SELECTOR='[data-testid="message-text"], [data-testid="message-content"], [data-message-content], .markdown, .prose';

function unique(nodes){return [...new Set((nodes||[]).filter(Boolean))];}
function validBoundUrl(value){
  try{
    const url=new URL(value);
    return url.protocol==='https:'&&url.hostname==='chatgpt.com'&&!url.username&&!url.password&&
      !url.search&&!url.hash&&/^(?:\/c\/|\/g\/[^/]+\/c\/)[0-9a-f-]{36}\/?$/i.test(url.pathname);
  }catch{return false;}
}
function zeroReport(reason){
  return {
    qualificationVersion:1,eligibleForControlledTest:false,reason,
    capabilities:{exactBoundTarget:false,uniqueEmptyComposer:false,uniqueSafeImageInput:false,
      cleanAttachmentState:false,canonicalTurnStructure:false,stableTurnIds:false,
      unambiguousAssistantBodies:false,readOnlyCandidateOnly:true},
    composer:{candidateCount:0,usableCount:0,emptyCount:0,draftCount:0},
    fileInput:{totalCount:0,knownLabelCount:0,usableCount:0,acceptsAllSupportedCount:0,
      disabledCount:0,unknownLabelCount:0,labelMatchCounts:[0,0,0,0]},
    attachment:{knownPreviewCount:0,unknownCandidateCount:0,uploadingCount:0,errorCount:0,
      selectorOverlapCount:0},
    turns:{groupedUserCount:0,groupedAssistantCount:0,legacyFamilyCount:0,
      canonicalUserCount:0,canonicalAssistantCount:0,readableTurnIdCount:0,
      missingTurnIdCount:0,duplicateTurnIdCount:0,assistantWithBodyCount:0,
      ambiguousAssistantBodyCount:0,roleOnlyAssistantCount:0,selectorMultiplicityRisk:false}
  };
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
  if(typeof direct==='string'&&direct.trim())return direct.trim();
  const id=node.getAttribute?.('id');
  if(typeof id!=='string'||!id)return '';
  const safe=id.replace(/["\\]/g,'\\$&');
  const labels=unique([...(document.querySelectorAll?.('label[for="'+safe+'"]')||[])]);
  return labels.length===1?nodeText(labels[0]).trim():'';
}
function acceptCapabilities(node){
  const values=String(node.getAttribute?.('accept')||'').toLowerCase().split(',').map(value=>value.trim()).filter(Boolean);
  const accepts=mime=>values.includes('image/*')||values.includes(mime)||
    (mime==='image/jpeg'&&(values.includes('.jpg')||values.includes('.jpeg')))||
    (mime==='image/png'&&values.includes('.png'))||(mime==='image/gif'&&values.includes('.gif'))||
    (mime==='image/webp'&&values.includes('.webp'));
  return ['image/jpeg','image/png','image/gif','image/webp'].every(accepts);
}
function turnId(node){
  for(const name of TURN_ID_ATTRIBUTES){
    const value=node.getAttribute?.(name);
    if(typeof value==='string'&&value.trim())return name+'\0'+value;
  }
  return null;
}
function outsideCanonical(nodes,canonical){
  return nodes.filter(node=>!canonical.some(turn=>turn===node||turn.contains?.(node))).length;
}
function setReason(report,reason){report.reason=reason;return report;}

export function inspectChatGptImageSurface({document,location,boundUrl}={}){
  const report=zeroReport('QUALIFICATION_ARGUMENT_INVALID');
  if(!document||typeof document.querySelectorAll!=='function'||!location)return report;
  if(!validBoundUrl(boundUrl))return setReason(report,'BOUND_URL_INVALID');
  let currentUrl;
  try{currentUrl=String(location.href||'');}catch{return setReason(report,'DOM_READ_FAILED');}
  if(currentUrl!==boundUrl)return setReason(report,'BOUND_TAB_CHANGED');
  report.capabilities.exactBoundTarget=true;

  try{
    const query=selector=>unique([...(document.querySelectorAll(selector)||[])]);

    const composers=unique(COMPOSER_SELECTORS.flatMap(query));
    const usable=composers.filter(usableComposer);
    const empty=usable.filter(node=>!nodeText(node).trim());
    report.composer={candidateCount:composers.length,usableCount:usable.length,
      emptyCount:empty.length,draftCount:usable.length-empty.length};
    report.capabilities.uniqueEmptyComposer=composers.length===1&&usable.length===1&&empty.length===1;

    const inputs=query('input[type="file"]');
    const names=inputs.map(node=>accessibleName(node,document));
    const known=inputs.filter((_node,index)=>CHATGPT_IMAGE_INPUT_LABELS.includes(names[index]));
    const disabled=known.filter(node=>node.disabled||node.getAttribute?.('aria-disabled')==='true');
    const usableInputs=known.filter(node=>!node.disabled&&node.getAttribute?.('aria-disabled')!=='true'&&
      String(node.getAttribute?.('type')||node.type||'').toLowerCase()==='file');
    const acceptsAll=usableInputs.filter(acceptCapabilities);
    let chosenInput=null,ambiguousNamedInput=false;
    for(const label of IMAGE_INPUT_PRIORITY){
      const matched=inputs.filter((_node,index)=>names[index]===label);
      if(matched.length>1){ambiguousNamedInput=true;break;}
      if(matched.length===1&&acceptsAll.includes(matched[0])){chosenInput=matched[0];break;}
    }
    report.fileInput={totalCount:inputs.length,knownLabelCount:known.length,usableCount:usableInputs.length,
      acceptsAllSupportedCount:acceptsAll.length,disabledCount:disabled.length,
      unknownLabelCount:inputs.length-known.length,
      labelMatchCounts:CHATGPT_IMAGE_INPUT_LABELS.map(label=>names.filter(name=>name===label).length)};
    report.capabilities.uniqueSafeImageInput=Boolean(chosenInput)&&!ambiguousNamedInput;

    const previewLists=PREVIEW_SELECTORS.map(query);
    const previews=unique(previewLists.flat());
    const generic=query(GENERIC_ATTACHMENT_SELECTOR);
    const unknown=generic.filter(node=>!previews.includes(node));
    const overlap=previews.filter(node=>previewLists.filter(list=>list.includes(node)).length>1);
    const uploading=query(UPLOADING_SELECTOR),errors=query(ERROR_SELECTOR);
    report.attachment={knownPreviewCount:previews.length,unknownCandidateCount:unknown.length,
      uploadingCount:uploading.length,errorCount:errors.length,selectorOverlapCount:overlap.length};
    report.capabilities.cleanAttachmentState=previews.length===0&&unknown.length===0&&
      uploading.length===0&&errors.length===0&&overlap.length===0;

    const groupedUser=query(GROUPED.user),groupedAssistant=query(GROUPED.assistant);
    const legacyFamilies=LEGACY.map(family=>({user:query(family.user),assistant:query(family.assistant)}));
    const nonemptyLegacy=legacyFamilies.filter(family=>family.user.length||family.assistant.length);
    let canonicalUser=[],canonicalAssistant=[];
    const groupedPresent=groupedUser.length>0||groupedAssistant.length>0;
    if(groupedPresent){canonicalUser=groupedUser;canonicalAssistant=groupedAssistant;}
    else if(nonemptyLegacy.length===1){canonicalUser=nonemptyLegacy[0].user;canonicalAssistant=nonemptyLegacy[0].assistant;}
    const roleOnlyAssistant=legacyFamilies.length?outsideCanonical(legacyFamilies.at(-1).assistant,canonicalAssistant):0;
    const selectorMultiplicityRisk=(groupedPresent&&nonemptyLegacy.some(family=>
      outsideCanonical([...family.user,...family.assistant],[...canonicalUser,...canonicalAssistant])>0))||
      (!groupedPresent&&nonemptyLegacy.length>1);
    const ids=[...canonicalUser,...canonicalAssistant].map(turnId);
    const readable=ids.filter(Boolean);
    const duplicates=readable.length-new Set(readable).size;
    let assistantWithBody=0,ambiguousBodies=0;
    for(const turn of canonicalAssistant){
      const bodies=unique([...(turn.querySelectorAll?.(ASSISTANT_BODY_SELECTOR)||[])]);
      if(bodies.length===1)assistantWithBody++;
      if(bodies.length>1)ambiguousBodies++;
    }
    report.turns={groupedUserCount:groupedUser.length,groupedAssistantCount:groupedAssistant.length,
      legacyFamilyCount:nonemptyLegacy.length,canonicalUserCount:canonicalUser.length,
      canonicalAssistantCount:canonicalAssistant.length,readableTurnIdCount:readable.length,
      missingTurnIdCount:ids.length-readable.length,duplicateTurnIdCount:duplicates,
      assistantWithBodyCount:assistantWithBody,ambiguousAssistantBodyCount:ambiguousBodies,
      roleOnlyAssistantCount:roleOnlyAssistant,selectorMultiplicityRisk};
    report.capabilities.canonicalTurnStructure=canonicalUser.length>0&&canonicalAssistant.length>0&&
      !selectorMultiplicityRisk;
    report.capabilities.stableTurnIds=ids.length>0&&readable.length===ids.length&&duplicates===0;
    report.capabilities.unambiguousAssistantBodies=canonicalAssistant.length>0&&
      assistantWithBody===canonicalAssistant.length&&ambiguousBodies===0;

    if(composers.length===0)return setReason(report,'COMPOSER_NOT_FOUND');
    if(composers.length!==1)return setReason(report,'COMPOSER_AMBIGUOUS');
    if(usable.length!==1)return setReason(report,'COMPOSER_DISABLED');
    if(empty.length!==1)return setReason(report,'HUMAN_DRAFT_PRESENT');
    if(known.length===0)return setReason(report,'IMAGE_FILE_INPUT_NOT_FOUND');
    if(ambiguousNamedInput)return setReason(report,'IMAGE_FILE_INPUT_AMBIGUOUS');
    if(!chosenInput)return setReason(report,'IMAGE_FILE_INPUT_UNSAFE');
    if(uploading.length)return setReason(report,'ATTACHMENT_UPLOAD_IN_PROGRESS');
    if(errors.length)return setReason(report,'ATTACHMENT_UPLOAD_ERROR');
    if(previews.length)return setReason(report,'ATTACHMENT_PREVIEW_PRESENT');
    if(unknown.length||overlap.length)return setReason(report,'PREVIEW_SELECTOR_UNKNOWN');
    if(selectorMultiplicityRisk)return setReason(report,'TURN_LAYOUT_AMBIGUOUS');
    if(!canonicalUser.length||!canonicalAssistant.length)return setReason(report,'TURN_LAYOUT_UNKNOWN');
    if(readable.length!==ids.length)return setReason(report,'TURN_ID_UNAVAILABLE');
    if(duplicates)return setReason(report,'TURN_ID_DUPLICATE');
    if(ambiguousBodies)return setReason(report,'ASSISTANT_BODY_STRUCTURE_AMBIGUOUS');
    if(assistantWithBody!==canonicalAssistant.length)return setReason(report,'ASSISTANT_BODY_STRUCTURE_UNKNOWN');

    report.eligibleForControlledTest=true;
    return setReason(report,'READY_FOR_CONTROLLED_TEST_CANDIDATE');
  }catch{
    return setReason(zeroReport('DOM_READ_FAILED'),'DOM_READ_FAILED');
  }
}
