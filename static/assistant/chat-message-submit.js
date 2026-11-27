"use strict";

function acMessageKey(board,sid,payload){
 const {text,selected,selection_id,review_id,review_ids,skill_id,document_ids,selected_versions,
  placement,generation_mode,chat_model,thinking_level,execution_scope,enqueue,empty_media_node}=payload;
 return JSON.stringify([board,sid,text,selected,selection_id,review_ids||(review_id?[review_id]:[]),skill_id,
  document_ids||[],selected_versions||[],placement||null,generation_mode||"auto",chat_model||"",thinking_level||"off",execution_scope||"full",enqueue,empty_media_node]);
}

function acComposeMessage(choiceText){
 const choice=typeof choiceText==="string", draft=$("#acInput").value;
 const reviews=AC.reviews, reviewIds=reviews.map(review=>review.id);
 const documents=choice?[]:AC.documents.slice(), documentIds=documents.map(doc=>doc.id);
 const text=choice?choiceText:draft.trim()||(reviewIds.length
  ? documentIds.length ? "请阅读引用的审阅评论和附件，汇总修改建议。" : "请汇总这些审阅评论并给出修改建议。"
  : documentIds.length?"请阅读我上传的文档":"");
 const board=boardId, sid=AC.session, selection=AC.selection, selected=acRefs().map(n=>n.id);
 const skill=choice?null:AC.skill, placement=choice?null:AC.placement;
 const selectedVersions=[...AC.referencePins].filter(([nid])=>AC.refs?.includes(nid))
  .map(([node_id,{ref}])=>({node_id,ref}));
 const modelChoice=$("#acModelChoice").value, thinking=$("#acThinkingLevel").value||"off";
 const scope=choice?(AC.events.findLast(event=>event.kind==="user")?.data.execution_scope||"full"):AC.executionScope;
 const generation=scope==="full"?acGenerationMode:"auto";
 const payload={text,selected,enqueue:!choice};
 if(!choice&&selected.includes(AC.emptyMediaNode))payload.empty_media_node=AC.emptyMediaNode;
 if(selection)payload.selection_id=selection.selection_id;
 if(reviewIds.length===1)payload.review_id=reviewIds[0];
 if(reviewIds.length>1)payload.review_ids=reviewIds;
 if(skill)payload.skill_id=skill.id;
 if(documentIds.length)payload.document_ids=documentIds;
 if(selectedVersions.length)payload.selected_versions=selectedVersions;
 if(placement)payload.placement=placement;
 if(generation!=="auto")payload.generation_mode=generation;
 if(scope!=="full")payload.execution_scope=scope;
 if(modelChoice)payload.chat_model=modelChoice;
 if(thinking!=="off")payload.thinking_level=thinking;
 return {board,sid,draft,payload,key:acMessageKey(board,sid,payload),selection,reviews,documents,skill};
}

async function acSend(choiceText){
 if(AC.sending||AC.documentUpload||AC.loadingSessions||!AC.session||AC.board!==boardId||
    (typeof choiceText==="string"&&(acActive()||AC.queue.length)))return;
 const submission=acComposeMessage(choiceText);
 const {payload,key,selection,reviews,documents,skill,draft,sid}=submission;
 if(!payload.text)return;
 if(payload.selected.length>30){toast(OneShotI18n.t("每条消息最多引用 30 个画布节点"));return;}
 if(payload.selected_versions?.some(({node_id,ref})=>!node(node_id)?.versions.some(v=>v.ref===ref))){
  toast(OneShotI18n.t("引用的节点或版本已移除，请重新选择"));return;
 }
 if(selection&&(!payload.selected.includes(selection.node_id)||!node(selection.node_id)?.versions.some(v=>v.ref===selection.source_ref))){
  toast("选区源图已失效，请移除选区或重新圈选");return;
 }
 const reviewConflict=acCheckReviews(reviews);
 if(reviewConflict){toast(reviewConflict);return;}
 submission.payload=AC.pending.get(key)||{...payload,request_key:crypto.randomUUID?.()||("req"+Date.now()+Math.random())};
 AC.pending.set(key,submission.payload);
 try{localStorage.setItem("h3.chat.outbox."+sid,JSON.stringify({payload:submission.payload,draft,selection,reviews,skill,documents}));}catch{}
 await acSubmitMessage(submission);
}

async function acSubmitMessage(submission){
 const {key,payload,board,sid,draft}=submission;
 if(AC.sending||AC.documentUpload||AC.loadingSessions||sid!==AC.session||AC.board!==board||boardId!==board)return;
 const current=()=>board===boardId&&sid===AC.session;
 AC.delivery.set(sid,{...submission,state:"sending",message:"正在发送…"});
 if(payload.enqueue){acPickPlacement(false);acVoiceCancel();}
 AC.sending=true;acRenderState();
 try{
  await flushSave();
  if(!current())throw new Error("画布已切换，请重新发送");
  if(AC.pending.has(board))throw new Error("请先处理画布保存冲突");
  const sent=await acApi(`/api/chat/sessions/${sid}/messages`,payload);
  AC.pending.delete(key);
  AC.delivery.delete(sid);
  try{
   const outbox="h3.chat.outbox."+sid;
   if(JSON.parse(localStorage.getItem(outbox))?.payload?.request_key===payload.request_key)localStorage.removeItem(outbox);
  }catch{}
  if(!current())return;
  const option=$("#acSessions").selectedOptions[0];
  if(option?.textContent===OneShotI18n.t("新对话"))option.textContent=payload.text.slice(0,30);
  const input=$("#acInput");
  const sameDraft=input.value===draft&&acComposeMessage(payload.enqueue?undefined:payload.text).key===key;
  AC.modelSelection.locked??=AC.models.find(model=>model.id===payload.chat_model)||{id:""};
  if(sent.state==="queued"){
   if(!AC.queue.some(item=>item.id===sent.id))AC.queue.push({id:sent.id,text:payload.text});
   toast(OneShotI18n.t("已加入创作助手队列"));
  }else if(!AC.runs.some(r=>r.id===sent.id))AC.runs.unshift(sent);
  const consumedDocuments=payload.document_ids||[];
  AC.documents=AC.documents.filter(doc=>!consumedDocuments.includes(doc.id));
  if(sameDraft){
   if(payload.enqueue)input.value="";
   AC.referencePins.clear();
   AC.refs=null;AC.selection=null;AC.reviews=[];
   if(payload.enqueue){AC.placement=null;AC.emptyMediaNode=null;if(AC.skill)csChoose(null);}
  }
  await acPoll();acRenderRefs();
 }catch(error){
  AC.delivery.set(sid,{...submission,state:"failed",message:error.message||"消息未能确认送达"});
  if(current())toast(error.message,6000);
 }finally{AC.sending=false;acRenderState();}
}

async function acSendShotRequest(board, payload, expectedSession=null){
 if(board!==boardId || !canvasCanEdit())throw new Error("请回到对应的可编辑画布");
 await acOpen({focus:false});
 if(board!==boardId || AC.board!==board || !AC.session || AC.loadingSessions)throw new Error("对话尚未准备好，请重试");
 const session=AC.session;
 if(expectedSession && session!==expectedSession)throw new Error("请回到审阅所属对话");
 await flushSave();
 if(board!==boardId || session!==AC.session || AC.pending.has(board))throw new Error("画布或对话已变化，请重试");
 const sent=await acApi(`/api/chat/sessions/${session}/messages`,payload);
 if(board===boardId && session===AC.session){
  if(sent.state==="queued")toast(OneShotI18n.t("已加入创作助手队列"));
  await acPoll();
 }
}
