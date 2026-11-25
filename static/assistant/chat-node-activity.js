"use strict";

function acCloseNodeTask(){
 const panel=$("#acNodeTask"), target=AC.nodeTask;
 AC.nodeTask=null;
 if(panel.close)panel.close();
 else panel.removeAttribute("open");
 if(target?.board!==boardId)return;
 const element=els.get(target.node);
 const launcher=element&&$$("[data-node-agent-session]",element).find(button=>button.dataset.nodeAgentSession===target.session);
 (launcher||$("#acTaskCenterBtn")).focus({preventScroll:true});
}

function acShowNodeTask(nodeId,sessionId){
 const session=acTaskDirectory().find(row=>row.id===sessionId);
 if(!B||!canvasCanEdit()||!session?.active_task_id||!session.run_state)return;
 const panel=$("#acNodeTask");
 AC.nodeTask={board:boardId,node:nodeId,session:sessionId,run:session.active_task_id,
  title:session.title,text:session.active_task_text};
 if(!panel.open){
  if(panel.showModal)panel.showModal();
  else panel.setAttribute("open","");
 }
 acRenderNodeTask();
 $("[data-node-task-close]",panel).focus();
}

function acRenderNodeTask(){
 const target=AC.nodeTask;
 if(!target)return;
 if(target.board!==boardId||!B||!canvasCanEdit()||!els.has(target.node)){acCloseNodeTask();return;}
 const session=acTaskDirectory().find(row=>row.id===target.session);
 const active=session?.active_task_id===target.run&&!!session.run_state;
 const recent=session?.recent_task?.id===target.run?session.recent_task:null;
 const status=active?(AC_STATES[session.run_state]||"正在执行…"):
  recent?(AC_STATES[recent.state]||"本轮已结束"):"本轮已离开执行列表";
 $("#acNodeTaskTitle").textContent=session?.title||target.title;
 $("#acNodeTaskPrompt").textContent=session?.active_task_id===target.run?session.active_task_text||"":target.text||"";
 const state=$("#acNodeTaskStatus"), message=target.error||status;
 if(state.textContent!==message)state.textContent=message;
 const stop=$("#acNodeTaskStop"), open=$("#acNodeTaskOpen");
 stop.hidden=!active;
 stop.disabled=!active||session.run_state==="stopping"||acTaskStops.has(target.run);
 open.disabled=!!(AC.sending||AC.documentUpload||AC.loadingSessions);
 open.textContent=active&&session.run_state==="waiting_approval"?OneShotI18n.t("去确认"):
  active&&session.run_state==="waiting_input"?OneShotI18n.t("去补充"):OneShotI18n.t("打开对话");
}

function acRenderNodeActivity(){
 const directory=acTaskDirectory();
 const sessions=directory.filter(session=>session.run_state&&session.node_activity&&session.active_task_id);
 const calls=new Map(sessions.flatMap(session=>session.node_activity.calls.map(id=>[id,session])));
 const active=new Map();
 const attach=(id,session)=>{
  if(els.has(id)){
   if(!active.has(id))active.set(id,new Set());
   active.get(id).add(session);
  }
 };
 for(const session of sessions)for(const id of session.node_activity.nodes)attach(id,session);
 if(calls.size)for(const n of B.nodes){
  const session=calls.get(n.job?.agent_call);
  if(session)attach(n.id,session);
 }
 for(const box of $$(".node-agent-activity",world))if(!active.has(box.dataset.nodeId))box.remove();
 const disabled=AC.sending||AC.documentUpload||AC.loadingSessions;
 const compact=acTaskPreference("taskBadge")==="dot";
 for(const [id,relevant] of active){
  const element=els.get(id);
  let box=$(".node-agent-activity",element);
  if(!box){
   box=document.createElement("div");box.className="node-agent-activity";box.dataset.nodeId=id;
   box.addEventListener("pointerdown",event=>event.stopPropagation());
   box.addEventListener("dblclick",event=>event.stopPropagation());
   box.onclick=event=>{
    const btn=event.target.closest("[data-node-agent-session]");
    if(!btn||btn.disabled)return;
    event.stopPropagation();
    acShowNodeTask(id,btn.dataset.nodeAgentSession);
   };
   $(".card",element).append(box);
  }
  const labels={thinking:"规划中",running:"执行中",waiting_approval:"待确认",waiting_input:"待补充",stopping:"正在停止"};
  const markup=[...relevant].map(session=>{
   const label=session.title+" · "+(labels[session.run_state]||"助手");
   return `<button type="button" data-node-agent-session="${esc(session.id)}"${disabled?" disabled":""}
   title="${esc(label)}" aria-haspopup="dialog" aria-controls="acNodeTask" aria-label="查看任务 ${esc(label)}">${compact
    ?`<span class="ac-task-dot${acTaskNeedsInput(session)?" needs-input":""}" aria-hidden="true"></span>`
    :ico("script")+"<span>"+esc(labels[session.run_state]||"助手")+"</span>"}</button>`;
  }).join("");
  if(box._items!==markup){box._items=markup;box.innerHTML=markup;}
 }
}

async function acRefreshNodeDirectory(fresh=false){
 const board=boardId;
 if(!board||!fresh&&AC.nodeDirectoryRequest?.board===board)return;
 const request=AC.nodeDirectoryRequest={board};
 acRenderTaskCenter();
 try {
  const data=await acApi("/api/chat/sessions?board="+encodeURIComponent(board));
  if(board!==boardId||AC.nodeDirectoryRequest!==request)return;
  AC.nodeDirectory={board,rows:Array.isArray(data.sessions)?data.sessions:[]};
  acObserveTaskSounds(AC.nodeDirectory.rows,data.task_snapshot_at);
  acRenderNodeActivity();
 }catch{
  if(board===boardId&&AC.nodeDirectoryRequest===request)AC.nodeDirectory={board,rows:acTaskDirectory(),error:true};
 }finally{
  if(AC.nodeDirectoryRequest===request){AC.nodeDirectoryRequest=null;acRenderTaskCenter();}
 }
}

async function acOpenNodeSession(id, {attention=false, locate=false, result=null, queued=null, history=false}={}){
 if(AC.sending||AC.documentUpload||AC.loadingSessions)return;
 const board=boardId;
 await acOpen({focus:false});
 if(board!==boardId || AC.board!==board || (!history&&!AC.sessions.some(session=>session.id===id)))return;
 if(id!==AC.session)await acLoadSession(id);
 if(board!==boardId || id!==AC.session)return;
 if(result||queued){AC.taskResult={session:id,board,run:result||queued,queued:!!queued};acJumpToTaskResult();return;}
 if(locate){
  const session=AC.sessions.find(row=>row.id===id);
  if(session?.node_activity?.nodes.length)await acFocus(session.node_activity.nodes);
 }
 if(attention){
  const card=$("#acQuestions:not([hidden]),#acApprovals:not([hidden]),#acInputRequest:not([hidden])");
  if(card){card.tabIndex=-1;card.scrollIntoView?.({block:"nearest"});card.focus();return;}
 }
 $("#acInput").focus();
}

async function acContinueTask(session,title,history){
 const board=boardId;
 await acOpenNodeSession(session,{history});
 if(board!==boardId||AC.board!==board||AC.session!==session||!AC.open||!canvasCanEdit())return;
 acVoiceCancel();
 acPickPlacement(true,{board,session,title});
 $("#acContinuationCancel").focus();
}
