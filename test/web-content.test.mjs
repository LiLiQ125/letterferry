import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';

const script=readFileSync(join(dirname(fileURLToPath(import.meta.url)),'../web-extension/content.js'),'utf8');
const url='https://chatgpt.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function setup({composerText='',assistantText='ready',editorMode='default',generating=false,
  sendMode='testid',renderer='classic',newUser=true,newAssistant=true,reuseNodes=false,
  assistantWrapper=false,bodyDelayed=false,bodyNeverReady=false,extraRoleLabels=0,priorTurnCount=1,
  paragraphFallback=false,includeChromeParagraph=false,toolbarOnly=false,
  richNewlines='normal',assistantDelayMs=0,requiresSelection=false,emptyInnerTextNewline=false,currentUrl=url}={}){
 const userTurns=[],assistantTurns=[];
 let listener,clicks=0,wasSubmitted=false,sendChecks=0,virtualTime=1000,sequence=0;
 let caretAnchored=false;
 const notifications=[];
 let deferredAssistant=null;
 function makeTurn(role,text,id) {
   const attrs=renderer==='new'
     ? {'data-content-search-unit-key':'thread:'+id+':'+role}
     : {'data-message-author-role':role,'data-message-id':id};
   const plainBody={innerText:text,textContent:text,contains(){return false;},closest(){return null;}};
   return {innerText:text,textContent:text,querySelector(){return null;},
     querySelectorAll(selector){
       // Modern grouped ChatGPT turns are wrappers that contain block elements,
       // unlike legacy bare-text assistant containers.
       return role==='assistant' && renderer==='new' &&
         selector.includes('p, pre, blockquote') ? [plainBody] : [];
     },
     getAttribute(name){return attrs[name]||null;},contains(){return false;}};
 }
 for(let i=0;i<priorTurnCount;i++){
   userTurns.push(makeTurn('user','prior harmless input','u'+i));
   assistantTurns.push(makeTurn('assistant','prior unrelated answer','a'+i));
 }
 const roleLabels=Array.from({length:extraRoleLabels},(_,i)=>({
   innerText:'ChatGPT 说：',textContent:'ChatGPT 说：',
   contains(){return false;},querySelector(){return null;},querySelectorAll(){return [];},
   getAttribute(name){return name==='data-role'?'assistant':name==='data-message-id'?'extra-label-'+i:null;}
 }));
 const button={
   tagName:'BUTTON',disabled:sendMode==='disabled',
   getAttribute(name){
     if(name==='data-testid')return ['testid','delayed','disabled'].includes(sendMode)?'send-button':null;
     if(name==='aria-label')return sendMode==='zh'?'发送消息':sendMode==='unrelated'?'添加附件':null;
     if(name==='type')return sendMode==='submit'?'submit':'button';
     return null;
   },
   click(){
     clicks++;
     const sent=textarea.textContent;
     if(newUser){
       const node=makeTurn('user',sent,'u'+(++sequence));
       if(reuseNodes) userTurns.splice(0,userTurns.length,node); else userTurns.push(node);
     }
     if(newAssistant){
       const node=makeTurn('assistant',assistantWrapper?'ChatGPT 说：':assistantText,'a'+(++sequence));
       if(assistantWrapper){
         const body={innerText:assistantText,textContent:assistantText,contains(){return false;},closest(){return null;}};
         const chromeLabel={innerText:'ChatGPT 说：',textContent:'ChatGPT 说：',contains(){return false;},closest(){return null;}};
         const toolbar={innerText:'复制',textContent:'复制',contains(){return false;},closest(){return {};}};
         let checks=0;
         node.querySelectorAll=selector=>{
           if(selector.includes('.markdown')){
             checks++;
             if(paragraphFallback||bodyNeverReady)return [];
             return bodyDelayed && checks<3 ? [] : [body];
           }
           if(selector.includes('p, pre, blockquote')){
             if(toolbarOnly)return [toolbar];
             if(paragraphFallback)return includeChromeParagraph?[chromeLabel,body]:[body];
           }
           return [];
         };
       }
       if(assistantDelayMs>0)deferredAssistant={node,at:virtualTime+assistantDelayMs};
       else if(reuseNodes) assistantTurns.splice(0,assistantTurns.length,node); else assistantTurns.push(node);
     }
     textarea.textContent='';
     textarea.innerText='';
   }
 };
 const form={querySelectorAll(selector){return selector==='button'?[button]:[];}};
 const textarea={tagName:'DIV',isContentEditable:true,textContent:composerText,
   focus(){},dispatchEvent(){},
   closest(selector){return selector==='form'&&['submit','unrelated'].includes(sendMode)?form:null;}
 };
 if(emptyInnerTextNewline){
   Object.defineProperty(textarea,'innerText',{
     get(){return textarea.textContent ? textarea.textContent : '\n';},
     set(value){textarea.textContent=value;}
   });
 }
 if(richNewlines!=='normal'){
   let stored=composerText;
   Object.defineProperty(textarea,'textContent',{
     get(){return stored;},
     set(next){
       const shown=String(next);
       stored=richNewlines==='truncated' ? shown.slice(0,-1).split('\n').join('') :
         richNewlines==='trailing-block-break' ? shown+'\n' : shown.split('\n').join('');
       textarea.innerText=richNewlines==='visual' ? shown :
         richNewlines==='trailing-block-break' ? shown+'\n' : undefined;
     }
   });
 }
 const document={
   querySelector(sel){
     if(sel.startsWith('#prompt-textarea'))return editorMode==='default'?textarea:null;
     if(sel.startsWith('[data-testid="composer-input"'))return editorMode==='alternate'?textarea:null;
     if(sel.startsWith('form [contenteditable="true"][role="textbox"]'))return editorMode==='form'?textarea:null;
     if(sel.startsWith('button[data-testid="stop-button"],'))return generating?{}:null;
     if(sel.startsWith('button[data-testid="send-button"')){
       if(sendMode==='delayed'){sendChecks++;return sendChecks>=3?button:null;}
       return ['testid','disabled'].includes(sendMode)?button:null;
     }
     if(sel.startsWith('button[aria-label="发送消息"]'))return sendMode==='zh'?button:null;
     return null;
   },
   querySelectorAll(sel){
     if(deferredAssistant&&virtualTime>=deferredAssistant.at){
       assistantTurns.push(deferredAssistant.node);deferredAssistant=null;
     }
     // Exact queries are used by the read-only inspector.
     if(sel==='[data-message-author-role="assistant"]')return renderer==='classic'?assistantTurns:[];
     if(sel==='[data-content-search-unit-key$=":assistant"]')return renderer==='new'?assistantTurns:[];
     if(sel==='[data-content-search-unit-key$=":user"]')return renderer==='new'?userTurns:[];
     // Role aggregation selects either renderer without inspecting message text.
     if(sel.includes('[data-message-author-role="assistant"]'))return [...assistantTurns,...roleLabels];
     if(sel.includes('[data-message-author-role="user"]'))return userTurns;
     return [];
   },
   createRange(){
     return {
       selectNodeContents(node){ if(node===textarea) caretAnchored=true; },
       collapse(){}
     };
   },
   execCommand(cmd,_ui,text){
     if(cmd!=='insertText')return false;
     if(requiresSelection&&!caretAnchored)return false;
     textarea.textContent+=text;
     return true;
   }
 };
 const chrome={runtime:{
   onMessage:{addListener(fn){listener=fn;}},
   async sendMessage(data){
     if(data.command==='submitted')wasSubmitted=true;
     notifications.push(data);
     return {ok:true};
   }
 }};
 const selection={removeAllRanges(){},addRange(){caretAnchored=true;}};
 const getSelection=()=>selection;
 const FakeDate=class extends Date {static now(){return virtualTime;}};
 const tick=(done,ms=0)=>{virtualTime+=ms;queueMicrotask(done);};
 vm.runInNewContext(script,{chrome,document,getSelection,URL,location:{href:currentUrl},setTimeout:tick,Date:FakeDate,Event:class{}});
 function invoke(data){return new Promise(resolve=>listener(data,{},resolve));}
 return {invoke,clicks:()=>clicks,wasSubmitted:()=>wasSubmitted,notifications,wait:()=>new Promise(ok=>setImmediate(ok)),
   sendChecks:()=>sendChecks,assistantTurns,userTurns};
}

test('preflight stays bound to the same conversation id across harmless ChatGPT route normalization',async()=>{
 const sameId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 const normalized='https://chatgpt.com/g/g-p-project/c/'+sameId+'?view=compact#latest';
 const f=setup({currentUrl:normalized});
 assert.equal((await f.invoke({action:'preflight',boundUrl:url})).ready,true);
 assert.equal((await f.invoke({action:'preflight',boundUrl:'https://chatgpt.com/c/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'})).ready,false);
 assert.equal((await f.invoke({action:'preflight',boundUrl:'https://example.org/c/'+sameId})).ready,false);
});
test('human draft is never overwritten',async()=>{
 const f=setup({composerText:'unfinished private draft'});
 const result=await f.invoke({action:'deliver',id:'fake',text:'hello',boundUrl:url});
 assert.equal(result.ok,false);assert.equal(result.error,'COMPOSER_NOT_EMPTY');assert.equal(f.clicks(),0);
});
test('classic DOM: one browser submit and stable assistant reply anchored to new user',async()=>{
 const f=setup({assistantText:'hello from fake page'});
 const result=await f.invoke({action:'deliver',id:'fake',text:'hello',boundUrl:url});
 assert.equal(result.ok,true);assert.equal(result.reply,'hello from fake page');
 assert.equal(f.clicks(),1);assert.equal(f.wasSubmitted(),true);
});
test('2026 grouped DOM: no legacy role attribute, but conversation search units work',async()=>{
 const f=setup({renderer:'new',assistantText:'RIVEN_WEB_SMOKE_OK'});
 assert.equal(f.assistantTurns[0].getAttribute('data-message-author-role'),null);
 const result=await f.invoke({action:'deliver',id:'fake',text:'new layout prompt',boundUrl:url});
 assert.equal(result.ok,true);assert.equal(result.reply,'RIVEN_WEB_SMOKE_OK');
 assert.equal(f.clicks(),1);
});
test('rich editor retries once after anchoring a collapsed selection when focus alone cannot insert',async()=>{
 const f=setup({renderer:'new',assistantText:'RIVEN_WEB_SMOKE_OK',requiresSelection:true});
 const result=await f.invoke({action:'deliver',id:'selection-fallback',text:'one-shot prompt',boundUrl:url});
 assert.equal(result.ok,true);
 assert.equal(result.reply,'RIVEN_WEB_SMOKE_OK');
 assert.equal(f.clicks(),1);
 assert.equal(f.wasSubmitted(),true);
});
test('empty rich editor newline sentinel does not block the safe selection retry',async()=>{
 const f=setup({renderer:'new',assistantText:'RIVEN_WEB_SMOKE_OK',requiresSelection:true,emptyInnerTextNewline:true});
 const result=await f.invoke({action:'deliver',id:'newline-empty-fallback',text:'one-shot prompt',boundUrl:url});
 assert.equal(result.ok,true);
 assert.equal(result.reply,'RIVEN_WEB_SMOKE_OK');
 assert.equal(f.clicks(),1);
 assert.equal(f.wasSubmitted(),true);
});
test('virtualized history replaces nodes with same count: new turn is still captured',async()=>{
 const f=setup({renderer:'new',assistantText:'new reply',reuseNodes:true});
 const result=await f.invoke({action:'deliver',id:'fake',text:'unique new question',boundUrl:url});
 assert.equal(result.ok,true);assert.equal(result.reply,'new reply');
 assert.equal(f.assistantTurns.length,1);
});
test('never mistake old assistant response for the reply when only user posted',async()=>{
 const f=setup({renderer:'new',newAssistant:false});
 const result=await f.invoke({action:'deliver',id:'fake',text:'new question',boundUrl:url});
 assert.equal(result.ok,false);assert.equal(result.error,'ASSISTANT_TURN_NOT_FOUND');
});
test('never return a new assistant without observable matching new user turn',async()=>{
 const f=setup({renderer:'new',newUser:false,assistantText:'unrelated answer'});
 const result=await f.invoke({action:'deliver',id:'fake',text:'not confirmed',boundUrl:url});
 assert.equal(result.ok,false);assert.equal(result.error,'SUBMITTED_USER_TURN_NOT_FOUND');
});
test('Chinese send control works and never clicks an unrelated attachment',async()=>{
 const chinese=setup({sendMode:'zh'});
 assert.equal((await chinese.invoke({action:'deliver',id:'f',text:'hello',boundUrl:url})).ok,true);
 assert.equal(chinese.clicks(),1);
 const unrelated=setup({sendMode:'unrelated'});
 const failure=await unrelated.invoke({action:'deliver',id:'f',text:'hello',boundUrl:url});
 assert.equal(failure.error,'SEND_BUTTON_NOT_FOUND');assert.equal(unrelated.clicks(),0);
});
test('send button async mount and composer form submit are supported',async()=>{
 const delayed=setup({sendMode:'delayed'});
 assert.equal((await delayed.invoke({action:'deliver',id:'f',text:'hello',boundUrl:url})).ok,true);
 assert.ok(delayed.sendChecks()>=3);
 const submit=setup({sendMode:'submit'});
 assert.equal((await submit.invoke({action:'deliver',id:'f',text:'hello',boundUrl:url})).ok,true);
 assert.equal(submit.clicks(),1);
});
test('disabled send control stays untouched',async()=>{
 const f=setup({sendMode:'disabled'});
 const result=await f.invoke({action:'deliver',id:'fake',text:'hello',boundUrl:url});
 assert.equal(result.error,'SEND_BUTTON_DISABLED');assert.equal(f.clicks(),0);
});
test('alternate editor detection and generating status do not send',async()=>{
 for(const editorMode of ['alternate','form']){
  const f=setup({editorMode});
  const check=await f.invoke({action:'preflight',boundUrl:url});
  assert.equal(check.receiverVersion,7);assert.equal(check.ready,true);assert.equal(f.clicks(),0);
 }
 const absent=setup({editorMode:'none'});
 assert.equal((await absent.invoke({action:'preflight',boundUrl:url})).reason,'EDITOR_NOT_FOUND');
 const generating=setup({generating:true});
 assert.equal((await generating.invoke({action:'preflight',boundUrl:url})).reason,'ASSISTANT_GENERATING');
});

test('read-only survey distinguishes classic and 2026 grouped layouts without text',async()=>{
 for(const renderer of ['classic','new']){
  const f=setup({renderer,composerText:'private draft is not sent'});
  const diag=await f.invoke({action:'survey',boundUrl:url});
  assert.equal(diag.receiverVersion,7);
  assert.equal(diag.roleAssistant,1);
  assert.equal(diag.roleUser,1);
  assert.equal(diag.classicAssistant,renderer==='classic'?1:0);
  assert.equal(diag.groupedAssistant,renderer==='new'?1:0);
  assert.equal(diag.groupedUser,renderer==='new'?1:0);
  assert.equal(JSON.stringify(diag).includes('private'),false);
  assert.equal(f.clicks(),0);
 }
});

test('UI speaker label must never be mistaken for the model reply',async()=>{
 const f=setup({renderer:'new',assistantWrapper:true,bodyNeverReady:true,assistantText:'RIVEN_WEB_SMOKE_OK'});
 const result=await f.invoke({action:'deliver',id:'fake',text:'unique prompt',boundUrl:url});
 assert.equal(result.ok,false);
 assert.equal(result.error,'ASSISTANT_BODY_NOT_FOUND');
 assert.equal(f.clicks(),1);
});
test('assistant reply is extracted from nested markdown, not the ChatGPT speaker label',async()=>{
 const f=setup({renderer:'new',assistantWrapper:true,assistantText:'RIVEN_WEB_SMOKE_OK'});
 const result=await f.invoke({action:'deliver',id:'fake',text:'unique prompt',boundUrl:url});
 assert.equal(result.ok,true);
 assert.equal(result.reply,'RIVEN_WEB_SMOKE_OK');
 assert.equal(f.clicks(),1);
});
test('a late-mounted message body is collected after the speaker label already exists',async()=>{
 const f=setup({renderer:'new',assistantWrapper:true,bodyDelayed:true,assistantText:'RIVEN_WEB_SMOKE_OK'});
 const result=await f.invoke({action:'deliver',id:'fake',text:'unique prompt',boundUrl:url});
 assert.equal(result.ok,true);
 assert.equal(result.reply,'RIVEN_WEB_SMOKE_OK');
});
test('read-only inspector reports assistant body presence without message contents',async()=>{
 const f=setup({renderer:'new',assistantWrapper:true,assistantText:'private model content'});
 await f.invoke({action:'deliver',id:'fake',text:'unique prompt',boundUrl:url});
 const diag=await f.invoke({action:'survey',boundUrl:url});
 assert.equal(diag.lastAssistantBodyNodes,1);
 assert.equal(diag.lastAssistantRecognizedBody,1);
 assert.equal(JSON.stringify(diag).includes('private model content'),false);
});

test('grouped turns outrank four extra UI speaker-label role nodes',async()=>{
 const f=setup({renderer:'new',extraRoleLabels:4,assistantWrapper:true,assistantText:'RIVEN_WEB_SMOKE_OK'});
 const survey=await f.invoke({action:'survey',boundUrl:url});
 assert.equal(survey.groupedAssistant,1);
 assert.equal(survey.roleAssistant,1);
 assert.equal(survey.lastAssistantBodyNodes,0);
 const result=await f.invoke({action:'deliver',id:'fake',text:'unique prompt',boundUrl:url});
 assert.equal(result.ok,true);
 assert.equal(result.reply,'RIVEN_WEB_SMOKE_OK');
 assert.equal(f.clicks(),1);
});
test('speaker labels cannot override the canonical assistant body after a grouped reply',async()=>{
 const f=setup({renderer:'new',extraRoleLabels:4,assistantWrapper:true,assistantText:'RIVEN_WEB_SMOKE_OK'});
 const result=await f.invoke({action:'deliver',id:'fake',text:'new prompt',boundUrl:url});
 assert.equal(result.reply,'RIVEN_WEB_SMOKE_OK');
 assert.notEqual(result.reply,'ChatGPT 说：');
});

test('exact live pattern: 5 canonical turns plus 4 role-label nodes are counted as 5',async()=>{
 const f=setup({renderer:'new',priorTurnCount:5,extraRoleLabels:4,assistantWrapper:true,assistantText:'RIVEN_WEB_SMOKE_OK'});
 const before=await f.invoke({action:'survey',boundUrl:url});
 assert.equal(before.groupedAssistant,5);
 assert.equal(before.groupedUser,5);
 assert.equal(before.roleAssistant,5);
 assert.equal(before.roleUser,5);
 assert.equal(before.lastAssistantBodyNodes,0);
 assert.equal(before.assistantsWithBody,5);
 assert.equal(JSON.stringify(before).includes('prior harmless input'),false);
 const result=await f.invoke({action:'deliver',id:'fake',text:'unique prompt',boundUrl:url});
 assert.equal(result.ok,true);
 assert.equal(result.reply,'RIVEN_WEB_SMOKE_OK');
 assert.equal(f.clicks(),1);
});
test('legacy message wrappers take priority over generic role-only labels',async()=>{
 const f=setup({renderer:'classic',priorTurnCount:5,extraRoleLabels:4});
 const diag=await f.invoke({action:'survey',boundUrl:url});
 assert.equal(diag.classicAssistant,5);
 assert.equal(diag.roleAssistant,5);
 assert.equal(diag.roleUser,5);
 assert.equal(diag.assistantsWithBody,5);
 assert.equal(f.clicks(),0);
});

test('2026 grouped assistant paragraph fallback extracts a reply without markdown wrapper',async()=>{
 const f=setup({renderer:'new',assistantWrapper:true,paragraphFallback:true,assistantText:'RIVEN_WEB_SMOKE_OK'});
 const result=await f.invoke({action:'deliver',id:'fake',text:'one-shot prompt',boundUrl:url});
 assert.equal(result.ok,true);
 assert.equal(result.reply,'RIVEN_WEB_SMOKE_OK');
 assert.equal(f.clicks(),1);
});
test('speaker label among fallback paragraphs is never returned as reply',async()=>{
 const f=setup({renderer:'new',assistantWrapper:true,paragraphFallback:true,includeChromeParagraph:true,assistantText:'RIVEN_WEB_SMOKE_OK'});
 const result=await f.invoke({action:'deliver',id:'fake',text:'one-shot prompt',boundUrl:url});
 assert.equal(result.ok,true);
 assert.equal(result.reply,'RIVEN_WEB_SMOKE_OK');
});
test('toolbar-only fallback fails closed even if there are many DOM descendants',async()=>{
 const f=setup({renderer:'new',assistantWrapper:true,paragraphFallback:true,toolbarOnly:true});
 const result=await f.invoke({action:'deliver',id:'fake',text:'one-shot prompt',boundUrl:url});
 assert.equal(result.ok,false);
 assert.equal(result.error,'ASSISTANT_BODY_NOT_FOUND');
 assert.equal(f.clicks(),1);
});

test('read-only survey reports usable fallback blocks but never returns reply text',async()=>{
 const f=setup({renderer:'new',assistantWrapper:true,paragraphFallback:true,assistantText:'secret model output'});
 const result=await f.invoke({action:'deliver',id:'fake',text:'test input',boundUrl:url});
 assert.equal(result.ok,true);
 const report=await f.invoke({action:'survey',boundUrl:url});
 assert.equal(report.receiverVersion,7);
 assert.equal(report.lastAssistantBodyNodes,0);
 assert.equal(report.lastAssistantFallbackBlocks,1);
 assert.equal(report.lastAssistantRecognizedBody,1);
 assert.equal(JSON.stringify(report).includes('secret model output'),false);
});

test('two-line Weixin bridge envelope survives rich composer textContent dropping line breaks',async()=>{
 const f=setup({renderer:'new',richNewlines:'flattened',assistantText:'ACK'});
 const payload='[WeChat authorized text | adapter_event=222e366a-2db2-414f-8a3c-14a7e1be39bc]\nRWX_WEB_ONCE_D3FD94B443EA76F00620A636';
 const reply=await f.invoke({action:'deliver',id:'local-once',text:payload,boundUrl:url});
 assert.equal(reply.ok,true);
 assert.equal(reply.reply,'ACK');
 assert.equal(f.clicks(),1);
 assert.equal(f.wasSubmitted(),true);
});
test('two-line browser draft with visible innerText line breaks is verified',async()=>{
 const f=setup({renderer:'new',richNewlines:'visual',assistantText:'ACK'});
 const payload='First authorized line\nSecond authorized line';
 const reply=await f.invoke({action:'deliver',id:'once',text:payload,boundUrl:url});
 assert.equal(reply.ok,true);
 assert.equal(f.clicks(),1);
});
test('single-line rich editor trailing block break is accepted without loosening content match',async()=>{
 const f=setup({renderer:'new',richNewlines:'trailing-block-break',assistantText:'ACK'});
 const reply=await f.invoke({action:'deliver',id:'once',text:'one-shot prompt',boundUrl:url});
 assert.equal(reply.ok,true);
 assert.equal(f.clicks(),1);
});
test('corrupted multiline editor content fails before click and never marks submitted',async()=>{
 const f=setup({renderer:'new',richNewlines:'truncated'});
 const payload='First authorized line\nSecond authorized line';
 const reply=await f.invoke({action:'deliver',id:'once',text:payload,boundUrl:url});
 assert.equal(reply.ok,false);
 assert.equal(reply.error,'INPUT_NOT_CONFIRMED');
 assert.equal(f.clicks(),0);
 assert.equal(f.wasSubmitted(),false);
});

test('detached browser job acknowledges immediately and later completes after 180 seconds',async()=>{
 const f=setup({renderer:'new',assistantText:'LATE_REPLY_OK',assistantDelayMs:190_000});
 const first=await f.invoke({action:'start-delivery',id:'long-1',text:'do long work',boundUrl:url});
 assert.equal(first.accepted,true);
 assert.equal(f.clicks(),0);
 // Browser turn continues independently after the one-off extension callback.
 for(let i=0;i<30 && !f.notifications.some(m=>m.command==='completed');i++)await f.wait();
 assert.equal(f.clicks(),1);
 assert.equal(f.notifications.filter(m=>m.command==='submitted').length,1);
 const completed=f.notifications.find(m=>m.command==='completed');
 assert.equal(completed?.id,'long-1');
 assert.equal(completed?.reply,'LATE_REPLY_OK');
 assert.equal(f.notifications.filter(m=>m.command==='delivery-unknown').length,0);
});
test('second detached job is rejected while first is active; no second submission',async()=>{
 const f=setup({renderer:'new',assistantText:'LATE_REPLY_OK',assistantDelayMs:190_000});
 assert.equal((await f.invoke({action:'start-delivery',id:'a',text:'first',boundUrl:url})).accepted,true);
 assert.deepEqual((await f.invoke({action:'start-delivery',id:'b',text:'second',boundUrl:url})).accepted,false);
 for(let i=0;i<30&&!f.notifications.some(m=>m.command==='completed');i++)await f.wait();
 assert.equal(f.clicks(),1);
});
