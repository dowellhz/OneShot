"use strict";

module.exports = async function assistantQueueDocumentsAndMentions(workspace) {
 const { assert, equal, evaluate, ready, w } = workspace;
 const queueFetch=w.fetch, queueSends=[], queueDeletes=[];
 const uiQueue=[];
 w.fetch=async(url,options={})=>{
  const path=new URL(url,'http://oneshot.test').pathname;
  let result;
  if(path==='/api/chat/sessions/queue-ui'){
   result={events:[],runs:[{id:'ongoing-run',state:'running'}],queue:uiQueue,board_rev:evaluate('B.rev||0')};
  }else if(path==='/api/chat/sessions/queue-ui/messages'){
   const body=JSON.parse(options.body);
   queueSends.push(body);
   result={id:'queued-'+queueSends.length,state:'queued'};
   uiQueue.push({id:result.id,text:body.text});
  }else if(path==='/api/chat/runs/queued-1/queue' && options.method==='DELETE'){
   queueDeletes.push(path);uiQueue.splice(0,1);result={ok:true};
  }else return queueFetch(url,options);
  return {ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(result))};
 };
 evaluate('AC.open=true;AC.board=boardId');
 await evaluate('acLoadSession("queue-ui")');
 evaluate('$("#acInput").value="完成后再做下一幕";$("#acInput").dispatchEvent(new Event("input"))');
 equal(evaluate('[$("#acSend").textContent,$("#acSend").disabled,$("#acStop").hidden]'),
 ["加入队列",false,false],"a running turn keeps the composer usable and offers an explicit queue action");
 evaluate('$("#acSend").click()');
 await ready('!!$("#acQueue [data-remove-queued=queued-1]") && !AC.sending','accepted follow-up appears as waiting');
 equal([queueSends.length,queueSends[0].enqueue,evaluate('$("#acInput").value'),evaluate('acActive().id')],
 [1,true,"","ongoing-run"],"queue admission clears the submitted draft and leaves the active turn alone");
 await evaluate('acLoadSession("queue-ui")');
 assert.match(evaluate('$("#acQueue ol").textContent'),/完成后再做下一幕/);
 evaluate('$("#acQueue [data-remove-queued]").click()');
 await ready('$("#acQueue").hidden','a waiting message can be removed after reopening');
 assert.equal(queueDeletes.length,1);
 w.fetch=queueFetch;
 console.log('Assistant queue DOM passed: active composer, durable pending list, active-turn controls and removal.');
 const attachmentFetch=w.fetch, attachmentUploads=[], attachmentDeletes=[];
 let attachmentMessage;
 w.fetch=async(url,options={})=>{
  const path=new URL(url,'http://oneshot.test').pathname;
  let result;
  if(path==='/api/chat/sessions/attachment-ui/documents'&&options.method==='POST'){
   const file=options.body.get('file');attachmentUploads.push(file.name);
   result={id:'document-'+attachmentUploads.length,name:file.name,length:123,truncated:false};
  }else if(path==='/api/chat/sessions/attachment-ui/documents/document-2'&&options.method==='DELETE'){
   attachmentDeletes.push(path);result={ok:true};
  }else if(path==='/api/chat/sessions/attachment-ui/messages'){
   attachmentMessage=JSON.parse(options.body);result={id:'attachment-run',state:'done'};
  }else if(path==='/api/chat/sessions/attachment-ui'){
   result={events:attachmentMessage?[{id:1,run_id:'attachment-run',kind:'user',data:{text:attachmentMessage.text,documents:[{name:attachmentUploads[0]}]}}]:[],
    runs:[],queue:[],board_rev:evaluate('B.rev||0')};
  }else return attachmentFetch(url,options);
  return {ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(result))};
 };
 await evaluate('acLoadSession("attachment-ui")');
 evaluate(`const docPicker=$("#acDocumentFile");
   Object.defineProperty(docPicker,"files",{value:[new File(["# 灯光"],"<剧本>.md")],configurable:true});
   docPicker.dispatchEvent(new Event("change"));`);
 await ready('AC.documents.length===1 && !AC.documentUpload','file picker attaches a parsed document');
 assert.equal(evaluate('$("#acSend").disabled'),false,'an attachment by itself can be sent');
 evaluate(`const dropDocument=new Event("drop",{cancelable:true,bubbles:true});
  Object.defineProperty(dropDocument,"dataTransfer",{value:{files:[new File(["参考"],"参考资料.txt")]}});
  $(".ac-composer").dispatchEvent(dropDocument);`);
 await ready('AC.documents.length===2 && !AC.documentUpload','drop adds an attachment to the composer');
 evaluate('$("[data-remove-document=document-2]").click();$("#acSend").click()');
 await ready('!!$("#acMessages .ac-sent-skill") && !AC.sending','sent user message shows its attachment');
 equal(attachmentMessage.document_ids,['document-1'],'only the attachment left in the composer is sent');
 assert.equal(attachmentDeletes.length,1);
 assert.equal(evaluate('$("#acDocumentFile").hidden'),true);
 assert.equal(evaluate('$("#acDocuments").hidden'),true);
 assert.match(evaluate('$("#acMessages .ac-sent-skill").textContent'),/<剧本>\.md/);
 w.fetch=attachmentFetch;
 console.log('Assistant documents DOM passed: picker, drop, remove, attachment-only send, safe filename and message history.');
 const mentionFetch=w.fetch;
 let pinnedReferenceMessage;
 w.fetch=async(url,options={})=>{
  const path=new URL(url,'http://oneshot.test').pathname;
  let result;
  if(path==='/api/chat/sessions/reference-ui/messages'){
   pinnedReferenceMessage=JSON.parse(options.body);result={id:'ref-run',state:'done'};
  }else if(path==='/api/chat/sessions/reference-ui'){
   result={events:[],runs:[],queue:[],board_rev:evaluate('B.rev||0')};
  }else return mentionFetch(url,options);
  return {ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(result))};
 };
 await evaluate('acLoadSession("reference-ui")');
 await evaluate('acOpen()');
 evaluate(`const mentionFixture=snap();sel.clear();updateSel();
  const exactMentionNode=addNode("image",1700,720,{}, {name:"对齐引用首帧",versions:[
   copyAsset("mention-v1.png",{w:512,h:512}),copyAsset("mention-v2.png",{w:512,h:512})],cur:0});
  const duplicateMentionNode=addNode("image",2130,720,{}, {name:"对齐引用首帧"});
  const mentionInput=$("#acInput");mentionInput.value="分析@对齐引用";mentionInput.focus();mentionInput.setSelectionRange(mentionInput.value.length,mentionInput.value.length);
  mentionInput.dispatchEvent(new Event("input",{bubbles:true}));`);
 await ready('CM.matches.filter(item=>item.canvasNode).length===2 && !CM.popup.hidden','typing @ finds both same-name canvas nodes');
 evaluate('mentionInput.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));switchVersion(exactMentionNode,1);acRenderRefs()');
 assert.equal(pinnedReferenceMessage,undefined,'Enter chooses the suggestion before submitting');
 const mentionNodeId=evaluate('exactMentionNode.id');
 assert.ok(evaluate('mentionInput.value').includes(`「对齐引用首帧」（${mentionNodeId}）`));
 assert.match(evaluate('$("#acRefs").textContent'),/版本 1 · 已指定/);
 assert.match(evaluate('$("#acRefs img").src'),/mention-v1\.png$/);
 evaluate(`const setReferenceVersion=value=>{
  const picker=$("#acRefs [data-reference-version]");picker.focus();picker.value=value;
  picker.dispatchEvent(new Event("change",{bubbles:true}));
 };setReferenceVersion("");`);
 equal(evaluate('[AC.referencePins.has(exactMentionNode.id),$("#acRefs [data-reference-version]").value]'),
  [false,''],'version selector can return to the current canvas version');
 assert.match(evaluate('$("#acRefs img").src'),/mention-v2\.png$/);
 evaluate('switchVersion(exactMentionNode,0)');
 assert.match(evaluate('$("#acRefs img").src'),/mention-v1\.png$/,'following the canvas refreshes the thumbnail immediately');
 evaluate('switchVersion(exactMentionNode,1)');
 evaluate('setReferenceVersion("0")');
 equal(evaluate('[exactMentionNode.cur,document.activeElement.dataset.referenceVersion]'),
  [1,mentionNodeId],'explicit reference changes preserve the canvas version and picker focus');
 evaluate('$("#acSend").click()');
 await ready('!AC.sending && !AC.referencePins.size','the sent draft clears its pinned version');
 equal(pinnedReferenceMessage.selected,[mentionNodeId],'same-name nodes remain unambiguous');
 equal(pinnedReferenceMessage.selected_versions,[{node_id:mentionNodeId,ref:'output:h3studio/mention-v1.png'}],'switching canvas versions does not change the payload');
 evaluate('restore(mentionFixture)');
 w.fetch=mentionFetch;
 console.log('Canvas mention DOM passed: mixed completion, duplicate labels, keyboard selection, version pin and payload.');
};
