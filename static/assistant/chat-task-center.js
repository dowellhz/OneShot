"use strict";

const acTaskStops = new Set();
const acQueueRemovals = new Set();

function acTaskDirectory(){
 return AC.nodeDirectory?.board===boardId ? AC.nodeDirectory.rows : [];
}

function acTaskSeenKey(){
 return "h3.chat.taskSeen."+JSON.stringify([ME_USER?.id??null,boardId]);
}

function acTaskSeen(){
 try{
  const ids=JSON.parse(localStorage.getItem(acTaskSeenKey())||"[]");
  return new Set(Array.isArray(ids)?ids:[]);
 }catch{return new Set();}
}

function acTaskMarkSeen(runId){
 const ids=acTaskSeen();
 if(ids.has(runId))return;
 ids.add(runId);
 try{localStorage.setItem(acTaskSeenKey(),JSON.stringify([...ids].slice(-80)));}catch{}
}

function acTaskResultElement(runId){
 return [...$("#acMessages").children].findLast(el=>el.dataset.taskRun===runId);
}

function acJumpToTaskResult(){
 const target=AC.taskResult;
 if(!target||target.board!==boardId||target.session!==AC.session||!AC.open)return;
 const request=[...$("#acMessages").children].find(message=>message.dataset.taskRequest===target.run);
 const el=target.queued
  ? $$("[data-queued-task]",$("#acQueue")).find(item=>item.dataset.queuedTask===target.run)||request
  : AC.moreEvents?null:acTaskResultElement(target.run)||request;
 if(!el)return;
 AC.taskResult=null;
 if(el.matches("details"))el.open=true;
 el.tabIndex=-1;
 el.scrollIntoView?.({block:"nearest"});
 el.focus();
 if(!target.queued)acTaskMarkSeen(target.run);
 acRenderTaskCenter();
}

async function acStopTaskRow(sessionId,runId,onError=toast){
 const board=boardId, session=acTaskDirectory().find(item=>item.id===sessionId);
 if(!canvasCanEdit()||session?.active_task_id!==runId||!session.run_state||
    session.run_state==="stopping"||acTaskStops.has(runId))return;
 acTaskStops.add(runId);
 acRenderTaskCenter();
 try{
  await acApi(`/api/chat/runs/${encodeURIComponent(runId)}/stop`,{});
  if(board===boardId){
   await acRefreshNodeDirectory(true);
   if(sessionId===AC.session&&AC.open)await acPoll();
  }
 }catch(error){if(board===boardId)onError(error.message);}
 finally{acTaskStops.delete(runId);acRenderTaskCenter();}
}

async function acRemoveQueuedTask(sid,runId){
 const board=boardId;
 const task=acTaskDirectory().find(row=>row.id===sid)?.queued_tasks?.find(item=>item.id===runId)||
  (sid===AC.session&&AC.board===board?AC.queue.find(item=>item.id===runId):null);
 if(!canvasCanEdit()||!task||task.removable===0||acQueueRemovals.has(runId))return;
 acQueueRemovals.add(runId);
 acRenderState();
 try{
  await boardRequest(`/api/chat/runs/${encodeURIComponent(runId)}/queue`,"DELETE");
  if(board!==boardId)return;
  if(sid===AC.session&&AC.board===board)AC.queue=AC.queue.filter(item=>item.id!==runId);
  const row=acTaskDirectory().find(item=>item.id===sid);
  if(row?.queued_tasks?.some(item=>item.id===runId)){
   row.queued_tasks=row.queued_tasks.filter(item=>item.id!==runId);
   row.queued_count=row.queued_tasks.length;
  }
 }catch(error){if(board===boardId)toast(error.message);}
 finally{
  acQueueRemovals.delete(runId);
  if(board===boardId){
   acRenderState();
   await acRefreshNodeDirectory(true);
   if(sid===AC.session&&AC.open)await acPoll();
  }
 }
}

function acCloseTaskCenter(){
 const dialog=$("#acTaskCenter");
 if(dialog.close)dialog.close();
 else dialog.removeAttribute("open");
}

async function acLoadTaskHistory(){
 const history=AC.taskHistory;
 if(history.board!==boardId||history.loading||history.before===null)return;
 history.loading=true;
 history.error="";
 acRenderTaskHistory();
 const query=new URLSearchParams({board:history.board,before:history.before});
 try{
  const data=await acApi("/api/chat/task-history?"+query);
  if(history!==AC.taskHistory||history.board!==boardId)return;
  history.tasks.push(...data.tasks);
  history.before=data.before;
 }catch(error){history.error=error.message;}
 finally{
  history.loading=false;
  if(history===AC.taskHistory&&history.board===boardId)acRenderTaskCenter();
 }
}

function acRenderTaskHistory(){
 const history=AC.taskHistory;
 const status=$("#acTaskHistoryStatus"), more=$("#acTaskHistoryMore"), list=$("#acTaskHistoryRows");
 if(!history||history.board!==boardId)return;
 status.textContent=history.loading?OneShotI18n.t("正在读取任务历史…"):history.error||
  (history.before===null&&!history.tasks.length?OneShotI18n.t("当前画布还没有已结束的助手任务。"):"");
 more.hidden=history.before===null;
 more.disabled=history.loading;
 more.textContent=history.tasks.length?OneShotI18n.t("加载更早的任务"):OneShotI18n.t("查看任务历史");
 const disabled=AC.sending||AC.documentUpload||AC.loadingSessions;
 const markup=history.tasks.map(task=>{
  const label=task.text||task.title;
  const state=(AC_STATES[task.state]||"").replace(/[….]+$/u,"");
  return `<li><button type="button" class="ac-task-open" data-task-session="${esc(task.session_id)}"
    data-task-result="${esc(task.id)}"${disabled?" disabled":""}>
    <strong>${esc(label)}</strong><small>${esc(task.title===label?state:task.title+" · "+state)}</small></button>
    ${acContinueTaskButton(task.session_id,task.id,task.state,disabled)}</li>`;
 }).join("");
 if(list._items!==markup){list._items=markup;list.innerHTML=markup;}
}

function acContinueTaskButton(session,run,state,disabled){
 if(state!=="done")return "";
 return OneShotI18n.html`<button type="button" data-task-continue="${esc(session)}" data-task-continue-run="${esc(run)}"
  ${disabled?" disabled":""}>继续创作</button>`;
}

function acRenderTaskCenter(){
 acRenderNodeTask();
 const button=$("#acTaskCenterBtn"), body=$("#acTaskCenterRows");
 const editable=!!B && canvasCanEdit();
 button.hidden=!editable;
 if(!editable){if($("#acTaskCenter").open)acCloseTaskCenter();return;}
 const rows=acTaskDirectory();
 const pending=rows.filter(acTaskNeedsInput);
 const running=rows.filter(session=>session.run_state&&!acTaskNeedsInput(session));
 const queued=rows.flatMap(session=>(session.queued_tasks||[]).map(task=>({session,task})))
  .sort((a,b)=>a.task.position-b.task.position);
 const recent=rows.filter(session=>session.recent_task)
  .sort((a,b)=>b.recent_task.updated-a.recent_task.updated).slice(0,12);
 const seen=acTaskSeen(), newResult=session=>session.recent_task?.state==="done"&&!seen.has(session.recent_task.id);
 const unread=recent.filter(newResult).length;
 const count=$("[data-task-attention]",button);
 count.textContent=pending.length?pending.length+" 待处理":"";
 count.hidden=!pending.length;
 const active=$("[data-task-running]",button);
 active.textContent=running.length?running.length+" 执行中":"";
 active.hidden=!running.length;
 const results=$("[data-task-results]",button);
 results.textContent=unread?unread+" 新结果":"";
 results.hidden=!unread;
 if(!$("#acTaskCenter").open)return;
 const disabled=AC.sending||AC.documentUpload||AC.loadingSessions;
 const section=(title,entries,terminal=false)=>entries.length?`<section><h3>${title}</h3><ul>${entries.map(session=>{
  const phase=terminal?session.recent_task.state:session.run_state;
  const state=terminal&&newResult(session)?"新结果":phase?(AC_STATES[phase]||"等待执行").replace(/[….]+$/u,""):"等待执行";
  const located=!terminal&&session.node_activity?.nodes?.some(id=>els.has(id));
  const text=terminal?session.title:session.active_task_text||session.title;
  return `<li><button type="button" class="ac-task-open" data-task-session="${esc(session.id)}"${terminal?` data-task-result="${esc(session.recent_task.id)}"`:""}${disabled?" disabled":""}>
    <strong>${esc(text)}${text!==session.title?`<small>${esc(session.title)}</small>`:""}</strong><small>${esc(state)}</small></button>
    ${located?OneShotI18n.html`<button type="button" data-task-locate="${esc(session.id)}"${disabled?" disabled":""}>定位节点</button>`:""}
    ${terminal?acContinueTaskButton(session.id,session.recent_task.id,phase,disabled):""}
    ${!terminal&&session.active_task_id&&session.run_state?OneShotI18n.html`<button type="button" data-task-stop="${esc(session.active_task_id)}" data-task-owner="${esc(session.id)}"
       aria-label="停止 ${esc(session.title)} 的当前任务"${session.run_state==="stopping"||acTaskStops.has(session.active_task_id)?" disabled":""}>停止</button>`:""}</li>`;
 }).join("")}</ul></section>`:"";
 const queueSection=queued.length?OneShotI18n.html`<section><h3>排队指令</h3><ul>${queued.map(({session,task})=>`
  <li><button type="button" class="ac-task-open" data-task-session="${esc(session.id)}" data-task-queued="${esc(task.id)}"${disabled?" disabled":""}>
  <strong>${esc(task.text||session.title)}<small>${esc(session.title)}</small></strong></button>
  ${task.removable===0?"":OneShotI18n.html`<button type="button" data-task-remove="${esc(task.id)}" data-task-owner="${esc(session.id)}"
   aria-label="移除排队指令 ${esc(task.text||session.title)}"${acQueueRemovals.has(task.id)?" disabled":""}>移除</button>`}</li>`).join("")}</ul></section>`:"";
 const status=AC.nodeDirectory?.board===boardId&&AC.nodeDirectory.error;
 const markup=(status?OneShotI18n.markup('<p role="status">任务列表更新失败，稍后将重试。</p>'):"")+
  (section("待处理",pending)+section("执行中",running)+queueSection+section("近期结果",recent,true)||
   (AC.nodeDirectoryRequest?.board===boardId?OneShotI18n.markup('<p role="status">正在读取任务…</p>'):OneShotI18n.markup("<p>当前画布还没有助手任务。</p>")));
 if(body._items!==markup){body._items=markup;body.innerHTML=markup;}
 acRenderTaskHistory();
}

function acInitTaskCenter(){
 $("#tr").insertAdjacentHTML("afterbegin",OneShotI18n.html`<button type="button" id="acTaskCenterBtn" aria-haspopup="dialog" aria-controls="acTaskCenter" hidden>
   助手任务 <span data-task-attention hidden></span><span data-task-running hidden></span><span data-task-results hidden></span></button>`);
 document.body.insertAdjacentHTML("beforeend",OneShotI18n.html`<dialog id="acTaskCenter" aria-labelledby="acTaskCenterTitle">
   <header><strong id="acTaskCenterTitle">当前画布的助手任务</strong><button type="button" data-task-close aria-label="关闭助手任务">×</button></header>
   <div id="acTaskCenterRows"></div>
   <div id="acTaskHistory"><ul id="acTaskHistoryRows" aria-label="任务历史"></ul>
   <p id="acTaskHistoryStatus" role="status"></p><button type="button" id="acTaskHistoryMore">查看任务历史</button></div>
   <footer class="ac-task-preferences">
   <label><input type="checkbox" id="acTaskSound">任务提示音</label>
   <label>节点上的任务标记 <select id="acTaskBadge"><option value="label">状态文字</option><option value="dot">圆点</option></select></label>
   </footer></dialog>`);
 const taskCenter=$("#acTaskCenter");
 document.body.insertAdjacentHTML("beforeend",OneShotI18n.html`<dialog id="acNodeTask" aria-labelledby="acNodeTaskTitle">
  <header><strong id="acNodeTaskTitle"></strong><button type="button" data-node-task-close aria-label="关闭任务详情">×</button></header>
  <p id="acNodeTaskPrompt"></p><p id="acNodeTaskStatus" role="status"></p>
  <footer><button type="button" id="acNodeTaskOpen">打开对话</button><button type="button" id="acNodeTaskStop">停止本轮</button></footer>
 </dialog>`);
 const nodeTask=$("#acNodeTask");
 $("[data-node-task-close]",nodeTask).onclick=acCloseNodeTask;
 nodeTask.oncancel=event=>{event.preventDefault();acCloseNodeTask();};
 nodeTask.onkeydown=event=>{
  event.stopPropagation();
  if(event.key==="Escape"&&!nodeTask.close)acCloseNodeTask();
 };
 $("#acNodeTaskOpen").onclick=()=>{
  const target=AC.nodeTask;
  if(!target)return;
  const active=acTaskDirectory().find(row=>row.id===target.session)?.active_task_id===target.run;
  acCloseNodeTask();
  void acOpenNodeSession(target.session,{attention:active,result:active?null:target.run}).catch(error=>toast(error.message));
 };
 $("#acNodeTaskStop").onclick=()=>{
  const target=AC.nodeTask;
  if(!target)return;
  target.error="";
  void acStopTaskRow(target.session,target.run,message=>{
   if(AC.nodeTask===target){target.error=message;acRenderNodeTask();}
  });
 };
 const sound=$("#acTaskSound"), badge=$("#acTaskBadge");
 sound.parentElement.hidden=!acTaskAudio;
 sound.onchange=()=>{
  acSetTaskPreference("taskSound",sound.checked?"on":"off");
  AC.taskSoundSnapshot=null;
  if(sound.checked){
   acUnlockTaskSound();
   void acRefreshNodeDirectory();
  }else if(acTaskSoundContext){
   void acTaskSoundContext.close().catch(()=>{});
   acTaskSoundContext=null;
  }
 };
 badge.onchange=()=>{
  acSetTaskPreference("taskBadge",badge.value);
  acRenderNodeActivity();
 };
 if(acTaskAudio){
  document.addEventListener("click",acUnlockTaskSound,true);
  document.addEventListener("keydown",acUnlockTaskSound,true);
 }
 $("#acTaskCenterBtn").onclick=()=>{
  if(taskCenter.open)return;
  sound.checked=acTaskPreference("taskSound")==="on";
  badge.value=acTaskPreference("taskBadge")==="dot"?"dot":"label";
  AC.taskHistory={board:boardId,before:0,tasks:[]};
  if(taskCenter.showModal)taskCenter.showModal();
  else taskCenter.setAttribute("open","");
  void acRefreshNodeDirectory();
  acRenderTaskCenter();
 };
 $("#acTaskHistoryMore").onclick=acLoadTaskHistory;
 $("[data-task-close]",taskCenter).onclick=acCloseTaskCenter;
 taskCenter.onkeydown=event=>{
  event.stopPropagation();
  if(event.key==="Escape"&&!taskCenter.close)acCloseTaskCenter();
 };
 taskCenter.onclick=event=>{
  const next=event.target.closest("[data-task-continue]");
  if(next&&!next.disabled){
   const sid=next.dataset.taskContinue, run=next.dataset.taskContinueRun;
   const fromHistory=!!next.closest("#acTaskHistoryRows")&&AC.taskHistory?.board===boardId;
   const entry=fromHistory
    ? AC.taskHistory.tasks.find(task=>task.session_id===sid&&task.id===run&&task.state==="done")
    : acTaskDirectory().find(session=>session.id===sid&&session.recent_task?.id===run&&session.recent_task.state==="done");
   if(entry){
    acCloseTaskCenter();
    void acContinueTask(sid,entry.title,fromHistory).catch(error=>toast(error.message));
   }
   return;
  }
  const remove=event.target.closest("[data-task-remove]");
  if(remove&&!remove.disabled){
   void acRemoveQueuedTask(remove.dataset.taskOwner,remove.dataset.taskRemove);
   return;
  }
  const stop=event.target.closest("[data-task-stop]");
  if(stop&&!stop.disabled){
   void acStopTaskRow(stop.dataset.taskOwner,stop.dataset.taskStop);
   return;
  }
  const action=event.target.closest("[data-task-session],[data-task-locate]");
  const id=action&&(action.dataset.taskSession||action.dataset.taskLocate);
  if(!id||action.disabled)return;
  const result=action.dataset.taskResult;
  const history=!!action.closest("#acTaskHistoryRows")&&AC.taskHistory?.board===boardId&&
   AC.taskHistory.tasks.some(task=>task.session_id===id&&task.id===result);
  if(!history&&!acTaskDirectory().some(session=>session.id===id))return;
  acCloseTaskCenter();
  acOpenNodeSession(id,{attention:true,locate:!!action.dataset.taskLocate,result,queued:action.dataset.taskQueued,history}).catch(error=>toast(error.message));
 };
}
