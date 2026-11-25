"use strict";
const AC={session:null,board:null,events:[],runs:[],queue:[],documents:[],documentUpload:null,cursor:0,open:false,polling:false,sending:false,refs:null,referencePins:new Map(),reviews:[],placement:null,skill:null,base:new Map(),pending:new Map(),calls:new Map(),epoch:0};
AC.sessions=[];
AC.questionnaires=[];
const acQuestionDrafts=new Map();
AC.models=[];
AC.modelSelection={};
const AC_THINKING_LEVELS={off:"关闭",low:"轻量",high:"标准",max:"深度"};
AC.drafts=new Map();
AC.delivery=new Map();
const AC_REVIEW_LIMIT=8;
const AC_GENERATION_MODES={auto:"自动生成",smart:"智能确认",manual:"每次确认"};
const AC_EXECUTION_SCOPES={full:"正常执行",analysis:"仅分析",plan:"仅拟方案",brainstorm:"头脑风暴"};
AC.executionScope="full";
let acGenerationMode=localStorage.getItem("h3.chat.generationMode") || "auto";
if(!Object.hasOwn(AC_GENERATION_MODES,acGenerationMode))acGenerationMode="auto";
const AC_LABELS={video_models:"读取视频模型",audio_separate:"人声分离",video_remake_plan:"确认换角计划",video_remake_status:"读取视频重制进度",video_remake_analyze:"分析重制原片",video_remake_split_long:"按时长拆分镜头",video_remake_map:"保存角色映射",video_remake_preview:"提交换角预览",video_remake_generate:"提交重制镜头视频",video_remake_export:"合成并保留原声",video_remake_review:"保存镜头审核决定",video_remake_locate:"定位原片人物",canvas_context:"读取画布",canvas_create_text:"创建文本",canvas_update:"更新节点",canvas_arrange:"整理排列",canvas_focus:"定位节点",media_describe:"理解图片",image_generate:"生成图片",image_edit:"编辑图片",image_cutout:"去除背景",image_segment:"识别选区",image_transform:"调整图片",image_upscale:"智能放大",image_decompose:"自动分层",memory_search:"检索创作记忆",memory_get:"读取创作记忆",memory_use:"采用记忆素材",memory_save:"保存创作记忆"};
const AC_STATES={thinking:"正在理解与规划…",running:"正在执行…",stopping:"正在停止，保留已完成结果…",stopped:"本轮已停止",done:"本轮已结束",error:"本轮执行中断"};
const AC_PHASES={queued:"排队",loading:"加载模型",encoding:"处理提示词与图片",sampling:"生成",decoding:"解码",compositing:"合成",watermark:"写入 AI 水印",done:"完成",error:"失败"};
AC_LABELS.creative_skill_load="加载创作技能";
AC_LABELS.image_generate_set="生成图片套图";
AC_LABELS.canvas_replace_passage="替换批注段落";
AC_STATES.waiting_approval="等待确认生成方案…";
AC.approvals=[];
const acDecidedApprovals=new Set();
AC_LABELS.canvas_workflow_review="读取制作复盘";
AC_LABELS.canvas_reference_plan="准备参考素材替换";
AC_LABELS.canvas_group_run_plan="准备分组运行";
AC_LABELS.workflow_template_search="查找工作流模板";
AC_LABELS.workflow_template_inputs="读取模板填写项";
AC_LABELS.workflow_template_plan="准备模板填写草稿";
AC_LABELS.storyboard_context="读取分镜脚本";
AC_LABELS.storyboard_create_plan="准备分镜脚本";
AC_LABELS.storyboard_visual_review="审阅镜头衔接";
AC_LABELS.storyboard_next_shot_plan="准备下一镜";
AC_LABELS.storyboard_revision_plan="准备镜头修改";
AC_LABELS.storyboard_range_run_plan="准备批量生成镜头";
AC_LABELS.image_previs_frame="生成白模分镜图";
AC_LABELS.creative_directions="比较创意方向";
AC_LABELS.image_camera="图片换机位";
AC_LABELS.image_relight="图片重新布光";
AC_LABELS.web_search="搜索公开资料";
AC_LABELS.web_save_references="保存公开资料";

Object.assign(AC_LABELS,{video_generate:"生成视频",video_regenerate:"重新生成视频",
 video_extend:"续拍视频",video_edit_segment:"修改视频片段",video_object_settings:"读取物体编辑设置",video_capture_frame:"截取视频帧",video_export_gif:"导出循环 GIF",
 image_export_gif:"宫格生成 GIF",
 video_draft_status:"查询样片版本",video_draft_finalize:"生成样片定稿",
 video_titles_get:"读取画面标题",video_titles_edit:"编辑画面标题",
 video_cutaways_get:"读取补画面",video_cutaways_edit:"编辑补画面",
 video_broll_generate:"制作 B-roll 动态画面",
 video_playlist_create:"创建播放列表",video_playlist_read:"读取播放列表",video_playlist_edit:"调整播放列表",video_playlist_export:"导出播放列表",
 video_previs_get:"读取白模场景",video_previs_save:"保存白模场景",video_previs_render:"渲染白模预演",
 video_previs_storyboard_plan:"准备白模分镜",
 video_previs_camera_motion:"应用白模运镜",video_previs_object_motion:"设置白模走位",
 audio_services:"读取配音与音乐服务",audio_generate:"生成音频"});
const acClone=v=>JSON.parse(JSON.stringify(v));
function acActive(){return AC.runs.find(r=>!["done","error","stopped"].includes(r.state));}
async function acStopCurrent(expectedId=acActive()?.id){
 const run=acActive();
 if(!run || run.id!==expectedId || run.state==="stopping")return false;
 await acApi(`/api/chat/runs/${run.id}/stop`,{});
 await acPoll();
 return true;
}
async function acApi(url,body){const r=await fetch(url,body===undefined?{}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});let j;try{j=await r.json();}catch{throw new Error("服务返回异常，请稍后重试");}if(!r.ok)throw new Error(j.error||"请求失败");return j;}
function acRenderState(){
 if(AC.open)acRenderRefs();
 acRenderDocuments();
 acRenderApprovals();
 acRenderQuestions();
 const active=acActive(),latest=AC.runs[0];
 for(const button of $$("[data-retry-call]",$("#acMessages"))) {
  button.disabled=!!(button.dataset.attempted||button.dataset.sending||active||AC.queue.length||AC.sending);
 }
 $("#acStatus").textContent=active?AC_STATES[active.state]:(latest?.error||AC_STATES[latest?.state]||OneShotI18n.t("可以讨论，也可以直接操作当前画布"));
 if(AC.questionnaires.length)$("#acStatus").textContent="请完成创作确认后继续";
 const queue=$("#acQueue");
 const queueMarkup=AC.queue.map((item,index)=>`<li data-queued-task="${esc(item.id)}" tabindex="-1"><span title="${esc(item.text)}">${esc(item.text)}</span>
  ${item.removable===0?"":OneShotI18n.html`<button type="button" data-remove-queued="${esc(item.id)}" aria-label="移除第 ${index+1} 条排队消息"${acQueueRemovals.has(item.id)?" disabled":""}>移除</button>`}</li>`).join("");
 if(queue._items!==queueMarkup){queue._items=queueMarkup;$("ol",queue).innerHTML=queueMarkup;}
 queue.hidden=!AC.queue.length;
 $("[data-queued-count]",queue).textContent="待执行 · "+AC.queue.length;
 if(!active&&AC.queue.length)$("#acStatus").textContent=OneShotI18n.t("指令已入队，等待并行位置");
 const lastMessage = AC.events.findLast(e => ["assistant","user","question_answer"].includes(e.kind));
 let choosing = false;
 for (const card of $$("#acMessages .ac-choices")) {
  const current = AC.session && lastMessage?.kind === "assistant" && card.dataset.event === String(lastMessage.id);
  for (const button of card.querySelectorAll("button")) button.disabled = !current || !!active || !!AC.queue.length || AC.sending;
  choosing ||= !!current && !active && !AC.queue.length && !AC.sending;
 }
 if (choosing) $("#acStatus").textContent = OneShotI18n.t("请选择上方的方案，或输入你的回复");
 $("#acStop").hidden=!active;$("#acStop").disabled=active?.state==="stopping";
 $("#acSend").disabled=AC.sending||!!AC.documentUpload||!!AC.loadingSessions||!AC.session||(!$("#acInput").value.trim()&&!AC.documents.length&&!AC.reviews.length);
 $("#acSend").textContent=active||AC.queue.length?OneShotI18n.t("加入队列"):OneShotI18n.t("发送");
 const delivery=AC.delivery.get(AC.session);
 $("#acDelivery").hidden=!delivery;
 const status=$("#acDeliveryStatus");
 if(status.textContent!==(delivery?.message||""))status.textContent=delivery?.message||"";
 const resend=$("#acResend");
 resend.hidden=delivery?.state!=="failed";
 resend.disabled=!!(AC.sending||AC.documentUpload||AC.loadingSessions);
 $("#acUndo").hidden=!latest||!!active||!!AC.queue.length;
 $("#acNew").disabled=$("#acSessions").disabled=!!(AC.sending||AC.documentUpload||AC.loadingSessions);
 $("#acSaveMemory").disabled=!AC.session||AC.loadingSessions||acMemorySaves.has(AC.session)||
   !AC.events.some(({kind,data})=>["user","assistant"].includes(kind)&&typeof data?.text==="string"&&data.text.trim());
 $("#acExecutionScope").value=AC.executionScope;
 $("#acExecutionScope").disabled=AC.sending||!!AC.loadingSessions;
 $("#acInput").placeholder=AC.executionScope==="brainstorm"?OneShotI18n.t("描述创作目标，输入 @ 引用素材，一起探索不同方向…"):OneShotI18n.t("描述你想做什么，输入 @ 引用素材…");
 $("#acGenerationMode").disabled=AC.executionScope!=="full"||AC.sending||!!AC.loadingSessions;
 acRenderParallel();
 acRenderTaskCenter();
 acRenderNodeActivity();
 $("#acModel").textContent=latest?.model?latest.model.provider+" · "+latest.model.model:"";
 acRenderModelPicker();
 if(typeof aeRenderInputs==="function")aeRenderInputs();
}

function acShowPane(){AC.open=true;$("#agentChat").hidden=false;$("#chatLaunch").hidden=true;acRenderPlacement();acVoiceRefresh();}
async function acOpen({focus=true}={}){if(!B)return;acShowPane();try{await flushSave();if(AC.board!==boardId||!AC.session)await acSessions();else await acPoll();}catch(e){$("#acError").textContent=e.message;$("#acError").hidden=false;}if(focus&&AC.open)$("#acInput").focus();}
function acClosePane(){
 const pane=$("#agentChat"), launch=$("#chatLaunch");
 const restoreFocus=pane.contains(document.activeElement)&&pane.parentElement.id!=="light";
 cpClose();lightDockAssistant(false);acVoiceCancel();acPickPlacement(false);csClose();
 AC.open=false;acRenderPlacement();pane.hidden=true;launch.hidden=false;
 if(restoreFocus)launch.focus();
}

function acKeyboardShortcut(event){
 if(event.defaultPrevented||event.isComposing||event.altKey||!B||!canvasCanEdit())return;
 const mod=event.metaKey||event.ctrlKey;
 const toggle=mod&&!event.shiftKey&&event.key.toLowerCase()==="j";
 const compose=!mod&&event.key==="/";
 if(!toggle&&!compose)return;
 const inChat=!!event.target.closest?.("#agentChat");
 const editing=event.target.closest?.("input,textarea,select,[contenteditable]:not([contenteditable=false]),video,audio");
 if(editing&&(!toggle||!inChat))return;
 if(document.querySelector("dialog[open]:not(#light),#film.on,#wiz.on,#wzSample.on,#pv.on,#settings.on,#help.on,#assetLibrary:not([hidden]),#imageEditor.on,#videoRemake,.playlist-picking"))return;
 const preview=$("#light").open;
 const previewButton=preview?$("#light [data-light-agent]"):null;
 if(preview&&!previewButton)return;
 event.preventDefault();
 event.stopPropagation();
 if(event.repeat)return;
 const visible=AC.open&&(!preview||$("#agentChat").parentElement.id==="light");
 if(toggle&&visible)acClosePane();
 else if(preview&&!visible)previewButton.click();
 else void acOpen();
}

function acBoardChanged(){
 cpClose();
 if(AC.continuation&&(AC.continuation.board!==boardId||!canvasCanEdit()))acPickPlacement(false);
 if(AC.taskSoundSnapshot?.board!==boardId||!canvasCanEdit())AC.taskSoundSnapshot=null;
 acRenderTaskCenter();
 if(!AC.open){void acRefreshNodeDirectory();return;}
 acSessions().catch(e=>toast(e.message));
}
function initAgentChat(){
 const launch=document.createElement("button");launch.id="chatLaunch";launch.innerHTML=OneShotI18n.html`${ico("script")}<span>创作助手</span>`;launch.setAttribute("aria-controls","agentChat");launch.setAttribute("aria-keyshortcuts","Meta+J Control+J /");launch.onclick=acOpen;document.body.append(launch);
 acInitTaskCenter();
 const pane=document.createElement("section");pane.id="agentChat";pane.hidden=true;pane.setAttribute("role","region");pane.setAttribute("aria-label",OneShotI18n.t("创作助手"));pane.innerHTML=OneShotI18n.html`<header class="ac-head"><strong>创作助手</strong><button id="acDock" title="切换停靠 / 浮动" aria-label="切换停靠 / 浮动">${ico("full")}</button><button id="acClose" title="收起，任务继续运行" aria-label="收起助手">×</button></header><div class="ac-subhead"><select id="acSessions" aria-label="对话历史"></select><button id="acNew">新对话</button></div><div id="acModel" class="ac-model">使用平台配置的文本模型</div><div id="acMessages" class="ac-messages" role="log" aria-label="对话与操作记录"></div><div id="acError" class="ac-status" hidden></div><div id="acStatus" class="ac-status" role="status"></div><div class="ac-composer"><div id="acRefs" class="ac-refs"></div><div id="acPicker" class="ac-picker" hidden></div><textarea id="acInput" aria-label="告诉助手要做什么" placeholder="描述你想做什么，输入 @ 引用素材…" maxlength="8000"></textarea><div class="ac-actions"><button id="acReference" title="引用画布节点">@ 引用</button><button id="acUndo" hidden>撤销本轮</button><span class="ac-hint">Enter 发送</span><button id="acStop" hidden>停止</button><button id="acSend" disabled>发送</button></div></div>`;document.body.append(pane);
 acInitMemorySave();
 $("#acInput").insertAdjacentHTML("beforebegin",OneShotI18n.markup('<div id="acDelivery" hidden><span id="acDeliveryStatus" role="status"></span><button type="button" id="acResend" hidden>重新发送</button></div>'));
 $("#acInput").insertAdjacentHTML("beforebegin",OneShotI18n.html`<div id="acContinuation" hidden>
  <strong id="acContinuationDrag" draggable="true"></strong>
  <span role="status">点击节点或空白处，也可拖动任务名称到目标位置。</span>
  <button type="button" id="acContinuationCancel">取消</button>
 </div>`);
 $("#acContinuationCancel").onclick=()=>{acPickPlacement(false);$("#acInput").focus();};
 $("#acContinuationDrag").ondragstart=event=>{
  if(!AC.continuation||!event.dataTransfer){event.preventDefault();return;}
  event.dataTransfer.setData(AC_CONTINUATION_DRAG,AC.continuation.session);
  event.dataTransfer.effectAllowed="copy";
 };
 $("#acResend").onclick=()=>{
  const delivery=AC.delivery.get(AC.session);
  if(delivery?.state==="failed")void acSubmitMessage(delivery);
 };
 acInitModelControls();
 acVoiceInit();
 initCreativeSkills();
 initCreativeProfile();
 acInitExecutionControls(pane);
 $("#acStatus").insertAdjacentHTML("afterend",OneShotI18n.html`<section id="acQueue" aria-label="待执行指令" hidden><strong data-queued-count></strong><ol></ol></section>`);
 acInitDocumentControls(pane);
 $("#acQueue").onclick=event=>{
  const button=event.target.closest("[data-remove-queued]");
  if(button&&!button.disabled)void acRemoveQueuedTask(AC.session,button.dataset.removeQueued);
 };
 $("#acClose").onclick=acClosePane;$("#acDock").onclick=()=>{pane.classList.toggle("floating");pane.style.left=pane.style.top=pane.style.height=pane.style.width="";acStoreWindow();};
 acInitPlacementControls();
 $("#acNew").onclick=()=>acSessions(true).catch(e=>toast(e.message));$("#acSessions").onchange=e=>acLoadSession(e.target.value).catch(e=>toast(e.message));$("#acReference").onclick=acPick;$("#acSend").onclick=acSend;
 $("#acStop").title=OneShotI18n.t("停止此对话的当前任务，队列继续执行");
 $("#acInput").oninput=event=>{
  acRenderState();
  if(event.inputType==="insertText"&&event.data==="/"&&!event.isComposing&&event.target.value==="/"&&
    AC.session&&!AC.sending&&!AC.loadingSessions&&canvasCanEdit())void csOpen(true);
 };
 $("#acInput").onkeydown=e=>{e.stopPropagation();if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing){e.preventDefault();acSend();}};
 $("#acStop").onclick=async()=>{try{await acStopCurrent();}catch(e){toast(e.message);}};
 $("#acUndo").onclick=async()=>{const rid=AC.runs[0]?.id;if(!rid)return;try{await flushSave();await acApi(`/api/chat/runs/${rid}/undo`,{});await acPoll();toast(OneShotI18n.t("已撤销本轮画布改动，生成文件仍保留"));}catch(e){toast(e.message,5000);}};
 acInitResultActions();
 pane.addEventListener("keydown",e=>{
  if(e.key==="Escape"&&!e.isComposing&&!e.defaultPrevented&&pane.parentElement.id==="light"){
   e.preventDefault();$("#acClose").click();
  }
 },true);
 pane.addEventListener("pointerdown",e=>e.stopPropagation());pane.addEventListener("wheel",e=>e.stopPropagation(),{passive:true});pane.addEventListener("keydown",e=>e.stopPropagation());
 $(".ac-head",pane).addEventListener("pointerdown",e=>{if(pane.parentElement.id==="light"||e.button!==0||e.target.closest("button"))return;e.preventDefault();const r=pane.getBoundingClientRect(),start={x:e.clientX,y:e.clientY};pane.classList.add("floating");pane.style.height=r.height+"px";pane.style.width=r.width+"px";pane.style.left=r.left+"px";pane.style.top=r.top+"px";const move=ev=>{pane.style.left=Math.max(0,Math.min(innerWidth-r.width, r.left+ev.clientX-start.x))+"px";pane.style.top=Math.max(8,Math.min(innerHeight-150,r.top+ev.clientY-start.y))+"px";};const end=()=>{removeEventListener("pointermove",move);removeEventListener("pointerup",end);removeEventListener("pointercancel",end);acStoreWindow();};addEventListener("pointermove",move);addEventListener("pointerup",end);addEventListener("pointercancel",end);});
 try{const layout=JSON.parse(localStorage.getItem("h3.chat.window"));if(layout?.floating){pane.classList.add("floating");for(const k of ["left","top","width","height"])if(Number.isFinite(layout[k]))pane.style[k]=Math.max(k==="width"?300:k==="height"?300:8,Math.min(layout[k],k==="left"?innerWidth-300:k==="top"?innerHeight-150:k==="width"?innerWidth-16:innerHeight-24))+"px";}}catch{}
 if(typeof aeInit==="function")aeInit();
 const resize=new ResizeObserver(()=>{if(pane.classList.contains("floating")&&!pane.hidden)acStoreWindow();});resize.observe(pane);
 let nextPoll=0, nextDirectory=0;
 setInterval(()=>{
  const now=performance.now();
  if(now<nextPoll)return;
  nextPoll=now+(AC.open&&acActive()?.state==="thinking"?400:1000);
  if(AC.open){
   if(AC.board!==boardId||!AC.session)acBoardChanged();
   else acPoll();
   acRenderRefs();
  }else if(AC.board===boardId&&(acActive()||AC.queue.length||AC.sessions.some(s=>s.run_state||s.queued_count)))acPoll(true);
  else if(B&&canvasCanEdit()&&(acTaskDirectory().some(session=>session.run_state||session.queued_count)||now>=nextDirectory)){
   nextDirectory=now+8000;
   void acRefreshNodeDirectory();
  }
 },200);
}
function acStoreWindow(){const p=$("#agentChat");if(p.parentElement.id==="light")return;const r=p.getBoundingClientRect();try{localStorage.setItem("h3.chat.window",JSON.stringify({floating:p.classList.contains("floating"),left:r.left,top:r.top,width:r.width,height:r.height}));}catch{}}
