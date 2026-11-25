"use strict";

module.exports = async function assistantTaskCenter(workspace, scenarioState) {
 const { assert, equal, evaluate, ready, w } = workspace;
 const stemFetch=w.fetch;
 const stemRequests=[];
 const stems=['vocals','no_vocals'].map(stem=>({
  ref:'output:h3studio/stem-'+stem+'.wav',url:'/media?test='+stem,meta:{duration:2},extra:{stem}
 }));
 let stemStarted=false, finishedStems=false;
 w.fetch=async(url,options={})=>{
  const link=new URL(String(url),'http://oneshot.test');
  if(link.pathname==='/api/audio/separate'){
   if(options.method==='POST'){
    stemRequests.push(JSON.parse(options.body));
    stemStarted=true;
    return {ok:true,json:async()=>({id:'stems-qa',range:{start:1,end:3}})};
   }
   return {ok:true,json:async()=>({available:true,latest:stemStarted?{id:'stems-qa',range:{start:1,end:3}}:null})};
  }
  if(link.pathname==='/api/jobs' && link.searchParams.get('ids')==='stems-qa'){
   const state=finishedStems?{state:'done',outputs:stems}:{state:'running',phase:'sampling'};
   return {ok:true,json:async()=>({'stems-qa':state})};
  }
  return stemFetch(url,options);
 };
 evaluate(`const stemTestVideo=addNode("video",76000,76000,{}, {name:"分离原片",versions:[
   copyAsset("stem-video-old.mp4",{seconds:6}),copyAsset("stem-video-new.mp4",{seconds:7})],cur:1});
   lightbox(stemTestVideo.versions[0],stemTestVideo);$("[data-light-separate]").click();`);
 await ready('$("#audioSeparation").open&&!$("[data-stem-start]").disabled','stem dialog for historical video');
 assert.equal(evaluate('$("[data-stem-source]").textContent'),'分离原片 · 版本 1');
 evaluate('const stemForm=$("#audioSeparation form");stemForm.elements.start.value="1";stemForm.elements.end.value="3";stemForm.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));');
 await ready('$("#audioSeparation [role=status]").textContent==="正在分离人声"','background phase display');
 equal(stemRequests.map(({ref,start,end})=>[ref,start,end]),[['output:h3studio/stem-video-old.mp4',1,3]]);
 evaluate('closeAudioSeparation()');
 finishedStems=true;
 await evaluate('openAudioSeparation(stemTestVideo,stemTestVideo.versions[0])');
 equal(evaluate('[$$("[data-stem-results] audio").length,$$("[data-stem-results] a").map(x=>x.download),stemTestVideo.cur]'),
  [2,['人声.wav','伴奏与环境声.wav'],1]);
 evaluate('$("[data-stem-add]").click();$("[data-stem-add]").click()');
 equal(evaluate(`B.nodes.filter(n=>curV(n)?.audio_separation?.job==="stems-qa").map(n=>[n.type,curV(n).audio_separation.stem])`),
  [['audio','vocals'],['audio','no_vocals']]);
 equal(evaluate(`B.edges.filter(e=>e.from===stemTestVideo.id&&e.relation==="audio_separation").map(e=>e.source_ref)`),
  ['output:h3studio/stem-video-old.mp4','output:h3studio/stem-video-old.mp4']);
 evaluate('$("[data-stem-edit]").click()');
 equal(evaluate(`[FILM.target.ref,FILM.spec.clips.map(c=>[c.in,c.out,c.volume,c.tight]),
   FILM.spec.audio_clips.map(c=>[c.ref,c.start,c.out]),$("#audioSeparation").open]`),
  ['output:h3studio/stem-video-old.mp4',[[1,3,0,true]],stems.map(s=>[s.ref,0,2]),false]);
 evaluate('closeFilm()');
 w.fetch=stemFetch;
 console.log('Audio separation passed: historical version, background receipt recovery, duplicate-safe placement and aligned film tracks.');

 scenarioState.parallelFetch = w.fetch;
 scenarioState.parallelCalls = [];
 scenarioState.scopedMessages = [];
 const dashboardRemovals=[];
 const parallelSessions=[
  {id:'parallel-ui-a',title:'写分镜',run_state:'waiting_approval',active_task_id:'parallel-run-a',active_task_text:'画三个夜景镜头',
   queued_count:2,queued_tasks:[{id:'parallel-queue-a',text:'继续',position:4},{id:'parallel-queue-remove',text:'生成封面',position:5}],
   node_activity:{nodes:['n1'],calls:[]}},
  {id:'parallel-ui-b',title:'剪旁白',run_state:'thinking',active_task_id:'parallel-run-b',queued_count:0,node_activity:{nodes:[evaluate('stemTestVideo.id')],calls:['badge-pending']}},
  {id:'parallel-ui-ready',title:'导出海报',run_state:null,queued_count:0,recent_task:{id:'ready-run',state:'done',updated:7}},
 ];
 scenarioState.releaseParallelPoll = undefined;
 scenarioState.holdParallel = false;
 scenarioState.parallelCreates = 0;
 let taskClock=10;
 w.fetch=async(url,options={})=>{
  const request=new URL(String(url),'http://oneshot.test');
  if(request.pathname==='/api/chat/task-history'){
   const older=request.searchParams.get('before')==='8';
   return {ok:true,json:async()=>older?{tasks:[
    {id:'history-older',session_id:'parallel-ui-old',title:'旧对话',state:'stopped',text:'整理第一版'}
   ],before:null}:{tasks:[
    {id:'ready-run',session_id:'parallel-ui-ready',title:'导出海报',state:'done',text:'保存海报'}
   ],before:8}};
  }
  if(request.pathname==='/api/chat/sessions'){
   if(options.method==='POST'){
    const session={id:'parallel-ui-'+['c','d','e','f'][scenarioState.parallelCreates++],title:'新对话',run_state:null,queued_count:0};
    parallelSessions.unshift(session);
    return {ok:true,json:async()=>({id:session.id})};
   }
   return {ok:true,json:async()=>({sessions:structuredClone(parallelSessions),task_snapshot_at:taskClock})};
  }
  if(request.pathname==='/api/chat/sessions/parallel-ui-e/messages'){
   scenarioState.scopedMessages.push(JSON.parse(options.body));
   return {ok:true,json:async()=>({id:'scope-run',state:'done'})};
  }
  if(request.pathname==='/api/chat/sessions/parallel-ui-old'){
   return {ok:true,json:async()=>({session:{id:'parallel-ui-old',title:'旧对话'},sessions:structuredClone(parallelSessions),runs:[],
    events:request.searchParams.get('after')==='0'?[{id:490,kind:'user',run_id:'history-older',data:{text:'整理第一版'}}]:[]})};
  }
  const match=request.pathname.match(/^\/api\/chat\/sessions\/(parallel-ui-(?:[abcdef]|ready))$/);
  if(match){
   const session=parallelSessions.find(s=>s.id===match[1]);
   const id=session.id.slice(-1);
   if(scenarioState.holdParallel&&id==='a'){
    scenarioState.holdParallel=false;
    await new Promise(resolve=>{scenarioState.releaseParallelPoll=resolve;});
   }
   return {ok:true,json:async()=>({
    session,sessions:structuredClone(parallelSessions),runs:session.run_state?[{id:'parallel-run-'+id,state:session.run_state}]:[],
    queue:structuredClone(session.queued_tasks||[]),
    approvals:session.run_state==="waiting_approval"?[{id:"task-center-approval",name:"image_generate",plan:{kind:"image",count:1}}]:[],
    events:request.searchParams.get('after')==='0'?[{id:820,kind:'assistant',run_id:session.recent_task?.id,
      data:{text:id==='y'?'海报已完成':'助手 '+id+' 的回复'}}]:[]
   })};
  }
  if(request.pathname==='/api/chat/runs/parallel-queue-remove/queue'&&options.method==='DELETE'){
   dashboardRemovals.push(request.pathname);
   parallelSessions[0].queued_tasks.pop();
   parallelSessions[0].queued_count--;
   return {ok:true,text:async()=>'{"ok":true}',json:async()=>({ok:true})};
  }
  if(request.pathname.startsWith('/api/chat/runs/parallel-run-')&&request.pathname.endsWith('/stop')){
   scenarioState.parallelCalls.push(request.pathname);
   parallelSessions.find(s=>s.id.endsWith(request.pathname.split('/')[4].slice(-1))).run_state=null;
   return {ok:true,json:async()=>({ok:true})};
  }
  return scenarioState.parallelFetch(url,options);
 };
 evaluate('AC.open=false;AC.board=null;$("#agentChat").hidden=true');
 await evaluate('acRefreshNodeDirectory()');
 assert.equal(evaluate('$("[data-node-agent-session=parallel-ui-a] span",els.get("n1")).textContent'),'待确认');
 equal(evaluate('[$("#agentChat").hidden,$("#acTaskCenterBtn").hidden,$("#acTaskCenterBtn [data-task-attention]").textContent]'),
   [true,false,"1 待处理"]);
 evaluate('$("#acTaskCenterBtn").click();$("#acTaskSound").click();$("#acTaskBadge").value="dot";$("#acTaskBadge").onchange()');
 await ready('AC.taskSoundSnapshot?.observedAt===10','sound starts from the current directory state');
 assert.deepEqual(workspace.taskNotes,[]);
 assert.equal(evaluate('$("[data-node-agent-session=parallel-ui-a] .ac-task-dot.needs-input").closest("button").getAttribute("aria-label")'),
  '查看任务 写分镜 · 待确认');
 evaluate('acCloseTaskCenter();$("#acTaskCenterBtn").click()');
 equal(evaluate('[$("#acTaskSound").checked,$("#acTaskBadge").value]'),[true,'dot']);
 await ready('!AC.nodeDirectoryRequest','reopened task center has refreshed its baseline');
 evaluate('acCloseTaskCenter()');
 Object.assign(parallelSessions[1],{run_state:'waiting_input',active_task_updated:11});
 taskClock=12;
 await evaluate('acRefreshNodeDirectory()');
 await ready('AC.taskSoundSnapshot.observedAt===12','the waiting state reaches the task directory');
 assert.deepEqual(workspace.taskNotes,[587,440]);
 await evaluate('acRefreshNodeDirectory()');
 assert.deepEqual(workspace.taskNotes,[587,440],'repeated observations do not replay the alert');
 Object.assign(parallelSessions[1],{run_state:'thinking',recent_task:{id:'sound-preview',state:'done',updated:13}});
 taskClock=14;
 await evaluate('acRefreshNodeDirectory()');
 assert.deepEqual(workspace.taskNotes,[587,440,523,659]);
 taskClock=12;
 await evaluate('acRefreshNodeDirectory()');
 assert.equal(evaluate('AC.taskSoundSnapshot.observedAt'),14,'an older response cannot replay alerts');
 evaluate('$("#acTaskCenterBtn").click();$("#acTaskSound").click();$("#acTaskBadge").value="label";$("#acTaskBadge").onchange();acCloseTaskCenter()');
 await ready('!AC.nodeDirectoryRequest','task center refresh has settled after disabling audio');
 parallelSessions[1].recent_task.updated=15;
 taskClock=16;
 await evaluate('acRefreshNodeDirectory()');
 assert.deepEqual(workspace.taskNotes,[587,440,523,659],'disabling audio silences subsequent changes');
 delete parallelSessions[1].recent_task;
 delete parallelSessions[1].active_task_updated;
 await evaluate('acRefreshNodeDirectory()');
 console.log('Assistant task preferences passed: opt-in alerts for new transitions, silence after disabling, and accessible compact markers.');
 evaluate('$("#acTaskCenterBtn").click()');
 equal(evaluate(`$$("#acTaskCenterRows section").map(section=>[$("h3",section).textContent,
   $$("[data-task-session]",section).map(button=>button.dataset.taskSession)])`),
   [["待处理",["parallel-ui-a"]],["执行中",["parallel-ui-b"]],["排队指令",["parallel-ui-a","parallel-ui-a"]],
    ["近期结果",["parallel-ui-ready"]]]);
 assert.equal(evaluate('$("[data-task-running]").textContent'),'1 执行中');
 assert.match(evaluate('$("[data-task-session=parallel-ui-a]").textContent'),/画三个夜景镜头/);
 evaluate('$("[data-task-queued=parallel-queue-remove]").click()');
 await ready('AC.session==="parallel-ui-a"&&document.activeElement.dataset.queuedTask==="parallel-queue-remove"',
  'an individual queued request opens its conversation and focuses the exact queue entry');
 await evaluate('acLoadSession("parallel-ui-b")');
 evaluate('$("#acTaskCenterBtn").click();$("[data-task-remove=parallel-queue-remove]").click()');
 await ready('!$("[data-task-queued=parallel-queue-remove]")&&!!$("[data-task-queued=parallel-queue-a]")',
  'removing a queued request leaves the other instruction in place');
 assert.deepEqual(dashboardRemovals,["/api/chat/runs/parallel-queue-remove/queue"]);
 equal(evaluate('[AC.session,$("[data-task-stop=parallel-run-a]").disabled]'),['parallel-ui-b',false]);
 console.log('Assistant task queue passed: running count, active prompt, exact queue focus and scoped queue removal.');
 evaluate('$("[data-task-session=parallel-ui-a]").click()');
 await ready('!$("#acTaskCenter").open&&AC.session==="parallel-ui-a"&&document.activeElement.id==="acApprovals"',
   'task center opens the correct waiting approval');
 evaluate('$("#acTaskCenterBtn").click();$("[data-task-locate=parallel-ui-b]").click()');
 await ready('AC.session==="parallel-ui-b"&&sel.has(stemTestVideo.id)','task center can locate an offscreen source node');
 assert.equal(evaluate('$("#acTaskCenter").open'),false);
 assert.equal(evaluate('$("[data-task-results]").textContent'),"1 新结果");
 evaluate('$("#acTaskCenterBtn").click();$("[data-task-result=ready-run]").click()');
 await ready('AC.session==="parallel-ui-ready"&&document.activeElement.dataset.taskRun==="ready-run"',
   'opening the finished task navigates to the exact result');
 equal(evaluate('[$("[data-task-results]").hidden,acTaskSeen().has("ready-run")]'),[true,true]);
 evaluate(`const reopenCompleted=()=>{$("#acTaskCenterBtn").click();$("[data-task-continue-run=ready-run]").click();};
  $("#acInput").value="继续原来的设计";reopenCompleted()`);
 await ready('!$("#acContinuation").hidden&&AC.session==="parallel-ui-ready"','continue in the completed task conversation');
 evaluate(`const continuationClick=(target,x,y)=>target.dispatchEvent(new MouseEvent("pointerdown",
  {bubbles:true,cancelable:true,button:0,clientX:x,clientY:y}));
  continuationClick($(".card",els.get("n1")),200,150)`);
 equal(evaluate('[$("#acContinuation").hidden,document.activeElement.id,$("#acInput").value,AC.referencePins.get("n1").ref===curV(node("n1")).ref]'),
  [true,'acInput','继续原来的设计',true]);
 evaluate('reopenCompleted()');
 await ready('!$("#acContinuation").hidden','completed task can be targeted again');
 evaluate(`const nextDropCoords=toW(300,200), transferredContinuation=new Map();
  const continuationData={setData:(type,value)=>transferredContinuation.set(type,value),
   getData:type=>transferredContinuation.get(type),get types(){return [...transferredContinuation.keys()];}};
  const continuationDrag=(target,type)=>{
   const event=new MouseEvent(type,{bubbles:true,cancelable:true,clientX:300,clientY:200});
   Object.defineProperty(event,"dataTransfer",{value:continuationData});return target.dispatchEvent(event);
  };
  continuationDrag($("#acContinuationDrag"),"dragstart");
  continuationDrag(vp,"dragover");
  continuationDrag(vp,"drop");`);
 equal(evaluate('[AC.session,$("#acContinuation").hidden,AC.placement,$("#acInput").value]'),
  ['parallel-ui-ready',true,JSON.parse(evaluate('JSON.stringify(acPlacementPoint(nextDropCoords))')),'继续原来的设计']);
 evaluate('reopenCompleted()');
 await ready('!$("#acContinuation").hidden','targeting mode can be cancelled');
 evaluate('$("#acContinuationCancel").click()');
 equal(evaluate('[$("#acContinuation").hidden,document.activeElement.id,$("#acInput").value]'),[true,'acInput','继续原来的设计']);
 console.log('Assistant continuation passed: same conversation and draft, exact version pin, drag placement and cancel.');
 parallelSessions.push({id:"parallel-ui-x",title:"测试配音",run_state:"running",active_task_id:"parallel-run-x",queued_count:1,
  active_task_text:"保留背景，只替换旁白",node_activity:{nodes:["n1"],calls:[]}});
 await evaluate('acRefreshNodeDirectory()');
 await evaluate('acStopTaskRow("parallel-ui-x","previous-run")');
 assert.equal(scenarioState.parallelCalls.length,0);
 evaluate('$("#acTaskCenterBtn").click();$("[data-task-stop=parallel-run-x]").click()');
 await ready('!$("[data-task-stop=parallel-run-x]")&&$("#acTaskCenter").open','scoped stop refreshes directly in the task center');
 assert.deepEqual(scenarioState.parallelCalls.splice(0),["/api/chat/runs/parallel-run-x/stop"]);
 equal(evaluate('[AC.session,acTaskDirectory().find(row=>row.id==="parallel-ui-x").queued_count]'),["parallel-ui-ready",1]);
 evaluate('acCloseTaskCenter()');
 Object.assign(parallelSessions.at(-1),{run_state:"running",active_task_id:"parallel-run-next-x"});
 await evaluate('acRefreshNodeDirectory()');
 evaluate('$("[data-node-agent-session=parallel-ui-x]",els.get("n1")).click()');
 equal(evaluate('[$("#acNodeTask").open,$("#acNodeTaskPrompt").textContent,$("#acNodeTaskStatus").textContent,AC.session]'),
  [true,"保留背景，只替换旁白","正在执行…","parallel-ui-ready"]);
 Object.assign(parallelSessions.at(-1),{active_task_id:"parallel-run-later-x",
  recent_task:{id:"parallel-run-next-x",state:"done",updated:23}});
 await evaluate('acRefreshNodeDirectory()');
 equal(evaluate('[$("#acNodeTaskStop").disabled,$("#acNodeTaskStatus").textContent]'),[true,"本轮已结束"]);
 evaluate('$("#acNodeTaskStop").click()');
 assert.deepEqual(scenarioState.parallelCalls,[],'the open node task card cannot stop its replacement run');
 evaluate('$("[data-node-task-close]").click();$("[data-node-agent-session=parallel-ui-x]",els.get("n1")).click();$("#acNodeTaskStop").click()');
 await ready('$("#acNodeTask").open&&$("#acNodeTaskStop").hidden','node task stop refreshes the selected run in place');
 assert.deepEqual(scenarioState.parallelCalls.splice(0),["/api/chat/runs/parallel-run-later-x/stop"]);
 equal(evaluate('AC.session'),"parallel-ui-ready");
 evaluate('acCloseNodeTask()');
 parallelSessions.pop();
 await evaluate('acRefreshNodeDirectory()');
 console.log('Assistant node task card passed: live instruction, exact-run stop and replacement-race protection.');
 console.log('Assistant task actions DOM passed: completion badge, exact result focus, read receipt and scoped stop.');
 console.log('Assistant task center DOM passed: closed-panel updates, grouping, approval focus and node location.');
 evaluate('$("#acTaskCenterBtn").click()');
 await evaluate('$("#acTaskHistoryMore").onclick()');
 equal(evaluate('[$("#acTaskHistoryRows strong").textContent,$("#acTaskHistoryMore").textContent]'),
  ['保存海报','加载更早的任务']);
 await evaluate('$("#acTaskHistoryMore").onclick()');
 equal(evaluate('[$$("#acTaskHistoryRows strong").map(node=>node.textContent),$("#acTaskHistoryMore").hidden]'),
  [['保存海报','整理第一版'],true]);
 evaluate('$("#acTaskHistoryRows [data-task-result=history-older]").click()');
 await ready('AC.session==="parallel-ui-old"&&document.activeElement.dataset.taskRequest==="history-older"',
  'task history opens an older session and focuses the originating request if the run produced no output');
 console.log('Assistant task history passed: pagination and navigation outside the session directory.');
};
