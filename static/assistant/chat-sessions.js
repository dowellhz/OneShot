"use strict";

function acSessionDirectory(sessions, selected=AC.session, observedAt){
 AC.sessions=sessions;
 if(AC.board===boardId){
  AC.nodeDirectory={board:boardId,rows:sessions};
  acObserveTaskSounds(sessions,observedAt);
  if(AC.nodeDirectoryRequest?.board===boardId)AC.nodeDirectoryRequest=null;
 }
 const select=$("#acSessions");
 const options=AC.sessions.map(s=>`<option value="${esc(s.id)}">${esc(s.title==="新对话"?OneShotI18n.t("新对话"):s.title)}</option>`).join("");
 if(select._items!==options){select._items=options;select.innerHTML=options;}
 if(selected)select.value=selected;
}

function acRenderReplyPreview(box,replies){
 const reply=replies?.at(-1);
 let preview=$("[data-ac-reply-preview]",box);
 if(!reply?.text){preview?.remove();return;}
 if(!preview){
  preview=document.createElement("div");
  preview.className="ac-msg assistant";
  preview.dataset.acReplyPreview="";
 }
 if(preview.textContent!==reply.text)preview.textContent=reply.text;
 if(box.lastElementChild!==preview)box.append(preview);
}
async function acPoll(background=false){
 if(AC.polling?.epoch===AC.epoch||(!AC.open&&!background)||!AC.session)return;
 const sid=AC.session,epoch=AC.epoch,polling={epoch};
 AC.polling=polling;
 try{const j=await acApi(`/api/chat/sessions/${sid}?after=${AC.cursor}`);if(epoch!==AC.epoch||sid!==AC.session)return;await acSyncBoard(j.board_rev);if(epoch!==AC.epoch)return;
  AC.runs=Array.isArray(j.runs)?j.runs:[];AC.queue=j.queue||[];AC.inputs=j.inputs||[];AC.approvals=j.approvals||[];AC.questionnaires=j.questionnaires||[];const box=$("#acMessages"),bottom=box.scrollHeight-box.scrollTop-box.clientHeight<90;
  if(Array.isArray(j.model_options))AC.models=j.model_options;
  if(j.chat_model!==undefined){
   AC.modelSelection.locked=j.chat_model;
   AC.modelSelection.level??=j.thinking_level??"off";
  }
  if(Array.isArray(j.sessions)){
   const listed=j.sessions;
   if(j.session&&!listed.some(item=>item.id===sid))listed.push(j.session);
   acSessionDirectory(listed,AC.session,j.task_snapshot_at);
  }
  AC.moreEvents=j.events.length===300;
  for(const e of j.events){AC.cursor=e.id;AC.events.push(e);acAppendEvent(e,AC.replaying||!AC.open);}
  acRenderReplyPreview(box,j.reply_previews);
  const current=AC.sessions.find(item=>item.id===sid)?.recent_task;
  if(AC.open&&bottom&&!$("#acTaskCenter").open&&current?.state==="done"&&acTaskResultElement(current.id))acTaskMarkSeen(current.id);
  AC.replaying=false;acRenderState();if(bottom)box.scrollTop=box.scrollHeight;$("#acError").hidden=true;
  acJumpToTaskResult();
 }catch(e){if(epoch===AC.epoch){$("#acError").textContent=OneShotI18n.t("连接中断，将自动重连：")+" "+e.message;$("#acError").hidden=false;}}finally{if(AC.polling===polling)AC.polling=false;}
}
function acResetSession(id){
 acVoiceCancel();
 AC.taskResult=null;
 AC.moreEvents=false;
 AC.approvals=[];acDecidedApprovals.clear();
 AC.questionnaires=[];
 acPickPlacement(false);AC.placement=null;
 AC.emptyMediaNode=null;
 csClose();csChoose(null);cmClose();
 AC.epoch++;AC.session=id;AC.cursor=0;AC.events=[];AC.runs=[];AC.queue=[];AC.documents=[];AC.documentUpload=null;AC.inputs=[];AC.refs=null;AC.selection=null;AC.reviews=[];AC.calls.clear();AC.replaying=true;
 AC.referencePins.clear();
 AC.modelSelection={};
 AC.executionScope="full";
 $("#acMessages").replaceChildren();$("#acInput").value="";
 $("#acModel").textContent=OneShotI18n.t("使用平台配置的文本模型");
}
async function acLoadSession(id){
 acRememberDraft();
 acResetSession(id);
 const draft=AC.drafts.get(id), epoch=AC.epoch;
 if(draft)acRestoreDraft(draft);
 $("#acSessions").value=id;
 localStorage.setItem("h3.chat.session."+boardId,id);
 try{
  const outbox=JSON.parse(localStorage.getItem("h3.chat.outbox."+id));
  if(outbox?.payload){
   const {text,selected,skill_id,selected_versions,placement,chat_model,thinking_level,execution_scope}=outbox.payload;
   if(!draft){
    $("#acInput").value=outbox.draft??text;AC.refs=selected;
    AC.emptyMediaNode=outbox.payload.empty_media_node||null;
    AC.selection=outbox.selection||null;AC.reviews=outbox.reviews||(outbox.review?[outbox.review]:[]);
    AC.placement=placement||null;
    for(const {node_id,ref} of selected_versions||[])AC.referencePins.set(node_id,{ref,name:node(node_id)?.name||node_id});
    AC.documents=outbox.documents||[];
    AC.modelSelection.choice=chat_model;
    AC.modelSelection.level=thinking_level;
    AC.executionScope=Object.hasOwn(AC_EXECUTION_SCOPES,execution_scope)?execution_scope:"full";
    if(skill_id)csChoose(outbox.skill||{id:skill_id,name:"已选技能"});
   }
   const key=acMessageKey(boardId,id,outbox.payload);
   AC.pending.set(key,outbox.payload);
   AC.delivery.set(id,{board:boardId,sid:id,key,payload:outbox.payload,draft:outbox.draft??text,
    state:"failed",message:"上一条消息的送达状态待确认"});
  }
 }catch{}
 acRenderRefs();acRenderState();await acPoll();
 if(AC.epoch===epoch)acRenderEmpty();
}
async function acSessions(fresh=false){
 const id=boardId;
 if(AC.loadingSessions?.board===id)return;
 const loading={board:id};
 AC.loadingSessions=loading;
 if(AC.board!==id){
  acRememberDraft();acResetSession(null);AC.board=id;acSessionDirectory([]);
  acRenderRefs();
 }
 const epoch=AC.epoch;
 const current=()=>id===boardId&&epoch===AC.epoch&&AC.loadingSessions===loading;
 acRenderState();
 try{
  const j=await acApi("/api/chat/sessions?board="+encodeURIComponent(id));
  if(!current())return;
  AC.models=(j.models||[]).filter(model=>model.id);
  let chosen=!fresh&&(j.sessions.find(s=>s.id===localStorage.getItem("h3.chat.session."+id))?.id||j.sessions[0]?.id);
  if(!chosen){
   const made=await acApi("/api/chat/sessions",{board:id});
   if(!current())return;
   chosen=made.id;j.sessions.unshift({id:chosen,title:"新对话"});
  }
  acSessionDirectory(j.sessions,chosen,j.task_snapshot_at);
  await acLoadSession(chosen);
  if(id===boardId&&chosen===AC.session)return chosen;
 }finally{
  if(AC.loadingSessions===loading){AC.loadingSessions=null;acRenderState();}
 }
}
function acRenderEmpty(){const box=$("#acMessages");if(box.children.length)return;box.innerHTML=OneShotI18n.html`<div class="ac-empty"><b>告诉我你想怎么创作</b><div>引用画布素材，我可以生成、编辑和整理结果。</div><button data-example="描述一下选中的图片">理解这张图片</button><button data-example="以选中图片为参考生成三个暖色版本，横向排列在原图右边">生成三个暖色版本</button><button data-example="把选中的节点横向排齐">整理选中的节点</button></div>`;$$("[data-example]",box).forEach(b=>b.onclick=()=>{$("#acInput").value=b.dataset.example;acRenderState();$("#acInput").focus();});}
