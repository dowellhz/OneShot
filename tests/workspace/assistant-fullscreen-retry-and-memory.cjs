"use strict";

module.exports = async function assistantFullscreenRetryAndMemory(workspace, scenarioState) {
 const { assert, equal, evaluate, ready, w } = workspace;
 evaluate(`AC.approvals=[{id:"set-review",name:"image_generate_set",plan:{kind:"image",count:2,items:[
   {name:"远景",prompt:"站台",aspect:"auto",assets:["林森（标准主图）","车站 <img src=x>"]},
   {name:"特写",prompt:"头肩",aspect:"auto",assets:["林森（正面头肩）"]}]}}];acRenderApprovals();`);
 equal(evaluate('$$("#acApprovals .ac-approval-items li small").map(row=>row.textContent)'),
  ['参考资产 · 林森（标准主图）、车站 <img src=x>','参考资产 · 林森（正面头肩）']);
 assert.equal(evaluate('$("#acApprovals img")'),null);
 evaluate('AC.approvals=previousApprovals;acRenderApprovals()');
 evaluate(`AC.approvals=[{id:"image-review",name:"image_generate",plan:{kind:"image",count:1,reference_review:{
    assets:["林森（正面头肩）"],counts:[["图",2,9]],inputs:[{name:"画布参考",version:2},{name:"林森 · 正面头肩",role:"subject"}]}}}];
  acRenderApprovals();`);
 assert.match(evaluate('$("#acApprovals").textContent'),/画布参考 · 图片 · 版本 2.*林森 · 正面头肩.*林森（正面头肩）/s);
 evaluate('AC.approvals=previousApprovals;acRenderApprovals()');

 const fullscreenFetch=w.fetch;
 let fullscreenRequest;
 w.fetch=async(url,options={})=>{
  if(String(url)===`/api/chat/sessions/${scenarioState.approvalSid}/messages`){
   fullscreenRequest=JSON.parse(options.body);
   return {ok:true,json:async()=>({id:'fullscreen-run',state:'done'})};
  }
  return fullscreenFetch(url,options);
 };
 evaluate(`const previewChatPane=$("#agentChat"), previewWindowLayout=localStorage.getItem("h3.chat.window");
   AC.refs=[];AC.referencePins.clear();$("#acInput").value="比较这个版本的构图";
   switchVersion(previewImage,1);
   lightbox(previewImage.versions[0],previewImage);
   $("[data-light-agent]").click();`);
 await ready('document.activeElement===$("#acInput")','assistant opens and focuses within the preview');
 equal(evaluate(`[$("#light > #agentChat")===previewChatPane,$$("#agentChat").length,AC.session,
   $("#acInput").value,AC.referencePins.get(previewImage.id).ref,previewImage.cur]`),
  [true,1,scenarioState.approvalSid,'比较这个版本的构图','output:h3studio/preview-first.png',1]);
 evaluate('acStoreWindow();$("[data-light-version]").value="1";$("[data-light-version]").dispatchEvent(new Event("change"))');
 equal(evaluate(`[$("#light > #agentChat")===previewChatPane,document.activeElement===$("#acInput"),
   localStorage.getItem("h3.chat.window")===previewWindowLayout,AC.referencePins.get(previewImage.id).ref]`),
  [true,true,true,'output:h3studio/preview-first.png']);
 evaluate('$("#acInput").value="@预览音频";$("#acInput").setSelectionRange(5,5)');
 await evaluate('cmSuggest($("#acInput"))');
 assert.equal(evaluate('$("#light > #memoryMention [data-canvas-node]").dataset.canvasNode===previewAudio.id'),true);
 evaluate('$("#acInput").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');
 equal(evaluate('[$("#light").open,!!$("#light > #agentChat"),$("#memoryMention").hidden]'),[true,true,true]);
 evaluate('$("#acInput").value="比较这个版本的构图";$("#acInput").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');
 equal(evaluate('[$("#light").open,$("#agentChat").hidden,document.activeElement===$("[data-light-agent]")]'),[true,true,true]);
 evaluate('$("[data-light-agent]").click()');
 await ready('AC.referencePins.get(previewImage.id)?.ref===previewImage.versions[1].ref','explicitly reattaching updates the pinned version');
 evaluate(`const historicalMention=$("#acInput");
  historicalMention.value="@"+previewImage.id+"#1";
  historicalMention.setSelectionRange(historicalMention.value.length,historicalMention.value.length);`);
 await evaluate('cmSuggest(historicalMention)');
 equal(evaluate('CM.matches.map(item=>item.version)'),[1]);
 evaluate('historicalMention.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))');
 assert.match(evaluate('historicalMention.value'),/版本 1/);
 await ready('AC.referencePins.get(previewImage.id)?.ref===previewImage.versions[0].ref','historical completion pins the version for the assistant');
 await evaluate('acSend()');
 equal(fullscreenRequest.selected_versions,[{node_id:evaluate('previewImage.id'),ref:'output:h3studio/preview-first.png'}]);
 evaluate('$("#acInput").value="继续分析";closeLightbox()');
 equal(evaluate('[$("#light").open,previewChatPane.parentElement===document.body,!previewChatPane.hidden,$("#acInput").value]'),
  [false,true,true,'继续分析']);
 evaluate('const fullscreenAccess=B.access;B.access="reviewer";lightbox(previewImage.versions[0],previewImage)');
 assert.equal(evaluate('!!$("[data-light-agent]")'),false);
 evaluate('closeLightbox();B.access=fullscreenAccess;$("#acInput").value=""');
 evaluate('lightbox(previewImage.versions[0],previewImage);$("[data-light-agent]").click()');
 await ready('document.activeElement===$("#acInput")','assistant reopens inside the preview');
 await evaluate('acFocus([previewImage.id],true)');
 equal(evaluate('[$("#light").open,IMAGE_EDITOR?.n.id===previewImage.id,!$("#agentChat").hidden]'),[false,true,true]);
 evaluate('closeImageEditor()');
 w.fetch=fullscreenFetch;
 console.log('Fullscreen assistant passed: shared session and draft, explicit version pins, mention picker, keyboard and review permissions.');

 evaluate(`const assistantKey=(target,key,options={})=>target.dispatchEvent(new KeyboardEvent("keydown",
   {key,bubbles:true,cancelable:true,...options}));
   $("#acInput").value="保留键盘草稿";$("#acInput").focus()`);
 assert.equal(evaluate('assistantKey($("#acInput"),"/")'),true,'the slash works as text in the composer');
 equal(evaluate('[assistantKey($("#acInput"),"j",{metaKey:true}),$("#agentChat").hidden,document.activeElement.id]'),
  [false,true,'chatLaunch']);
 assert.equal(evaluate('assistantKey($("#chatLaunch"),"j",{ctrlKey:true,repeat:true})'),false);
 assert.equal(evaluate('$("#agentChat").hidden'),true,'holding the shortcut does not reopen the pane');
 evaluate('$("#acTaskCenterBtn").click()');
 assert.equal(evaluate('assistantKey($("[data-task-close]"),"/")'),true,'an open modal owns keyboard focus');
 assert.equal(evaluate('$("#agentChat").hidden'),true);
 evaluate('acCloseTaskCenter()');
 assert.equal(evaluate('assistantKey($("#prompt"),"/")'),true,'the node prompt retains its slash tools');
 assert.equal(evaluate('assistantKey($("#chatLaunch"),"/",{isComposing:true})'),true,'composition keeps its keystrokes');
 assert.equal(evaluate('assistantKey($("#chatLaunch"),"/")'),false);
 await ready('document.activeElement.id==="acInput"','canvas shortcut focuses the composer');
 equal(evaluate('[$("#acInput").value,AC.session]'),['保留键盘草稿',scenarioState.approvalSid]);
 evaluate('lightbox(previewImage.versions[0],previewImage);assistantKey($("[data-light-close]"),"j",{ctrlKey:true})');
 await ready('document.activeElement.id==="acInput"&&$("#agentChat").parentElement.id==="light"','toggle opens the assistant inside the preview');
 equal(evaluate('[$("#acInput").value,AC.referencePins.get(previewImage.id).ref]'),
  ['保留键盘草稿','output:h3studio/preview-first.png']);
 evaluate('assistantKey($("#acInput"),"j",{metaKey:true})');
 equal(evaluate('[$("#light").open,$("#agentChat").hidden,document.activeElement.hasAttribute("data-light-agent")]'),
  [true,true,true]);
 evaluate('assistantKey($("[data-light-agent]"),"a")');
 assert.equal(evaluate('$(".light-region-drawing")!==null&&$("#light").open'),true);
 evaluate('closeLightbox();assistantKey($("#chatLaunch"),"a")');
 equal(evaluate('[$("#canvasComments").hidden,document.activeElement.id]'),[false,'ccBody']);
 evaluate('$("#ccClose").click();AC.open=true;$("#agentChat").hidden=false;$("#chatLaunch").hidden=true');
 console.log('Assistant keyboard shortcuts passed: composition and modal isolation, preserved drafts, media version pins and annotation.');

 const retryFetch=w.fetch, retryRequests=[];
 let replyRetry=false;
 w.fetch=async(url,options={})=>{
  const path=String(url).split('?')[0];
  if(path===`/api/chat/sessions/${scenarioState.approvalSid}/calls/retry-demo/retry`){
   retryRequests.push(options.method);
   if(!replyRetry)return {ok:false,json:async()=>({error:'参考素材已丢失'})};
   return {ok:true,json:async()=>({id:'retry-new-run',state:'running'})};
  }
  return retryFetch(url,options);
 };
 evaluate(`AC.runs=[];AC.queue=[];$("#acInput").value="保留这条草稿";
   const failedBatch=[{kind:"tool_start",data:{call_id:"retry-demo",name:"image_generate"}},
     {kind:"tool_end",data:{call_id:"retry-demo",name:"image_generate",retry_count:2,
       result:{nodes:[],errors:["<b>模型错误</b>"]}}}];
   failedBatch.forEach(event=>acAppendEvent(event));acRenderState();`);
 equal(evaluate(`[$("[data-call=retry-demo]").open,$("[data-call=retry-demo] summary").textContent,
   $("[data-retry-call=retry-demo]").textContent,$$("[data-call=retry-demo] b").length]`),
  [true,'生成图片 · 部分失败','按原参数重试 2 个失败结果',0]);
 await evaluate('$("[data-retry-call=retry-demo]").onclick()');
 equal(evaluate('[$(".ac-retry [role=status]").textContent,$("[data-retry-call=retry-demo]").disabled]'),['参考素材已丢失',false]);
 replyRetry=true;
 await evaluate(`Promise.all([$("[data-retry-call=retry-demo]").onclick(),$("[data-retry-call=retry-demo]").onclick()])`);
 equal(retryRequests,['POST','POST']);
 equal(evaluate('[$("[data-retry-call=retry-demo]").disabled,$("[data-retry-call=retry-demo]").textContent,$("#acInput").value]'),
  [true,'已提交重试','保留这条草稿']);
 evaluate(`$("[data-call=retry-demo]").remove();failedBatch.forEach(event=>acAppendEvent(event,true));
   acAppendEvent({kind:"retry_queued",data:{call_id:"retry-demo"}},true);
   acAppendEvent({kind:"tool_start",data:{call_id:"retry-new",name:"image_generate",retry:true}},true);acRenderState();`);
 equal(evaluate('[$("[data-retry-call=retry-demo]").disabled,$("[data-call=retry-new] summary").textContent]'),
  [true,'重试 · 生成图片 · 执行中']);
 w.fetch=retryFetch;
 console.log('Assistant job retry passed: partial failure, recovery, duplicate clicks, replay and draft preservation.');

 const profileFetch=w.fetch, profileWrites=[], profileDecisions=[];
 let profileSettingsMock={personal:{text:'字幕用简体',revision:2},project:{id:'profile-project',name:'海报项目',text:'使用暖色',revision:1}};
 w.fetch=async(url,options={})=>{
  const path=String(url).split('?')[0];
  if(path==='/api/chat/profile'){
   if(options.method==='PUT'){
    const request=JSON.parse(options.body);
    profileWrites.push(request);
    for(const [scope,update] of Object.entries(request.changes)){
     profileSettingsMock[scope]={...profileSettingsMock[scope],text:update.text,revision:update.revision+1};
    }
   }
   return {ok:true,json:async()=>structuredClone(profileSettingsMock)};
  }
  if(path===`/api/chat/sessions/${scenarioState.approvalSid}/profile/profile-demo`){
   const payload=JSON.parse(options.body);
   profileDecisions.push(payload.decision);
   return {ok:true,json:async()=>payload};
  }
  return profileFetch(url,options);
 };
 const profileBoard=evaluate('boardId');
 await evaluate('$("#acProfile").onclick()');
 equal(evaluate('[$("#creativeProfile").open,$("#cpPersonal").value,$("#cpProject").value,$("#cpProjectName").textContent]'),
  [true,'字幕用简体','使用暖色','项目规则 · 海报项目']);
 evaluate('$("#cpPersonal").value="";$("#cpProject").value="保留已定稿人物参考"');
 await evaluate('$("#creativeProfile form").onsubmit({preventDefault(){},currentTarget:$("#creativeProfile form")})');
 equal(profileWrites,[{board:profileBoard,changes:{personal:{text:'',revision:2},project:{id:'profile-project',text:'保留已定稿人物参考',revision:1}}}]);
 assert.match(evaluate('$("#cpStatus").textContent'),/已保存/);
 evaluate('$("#cpClose").click()');
 profileSettingsMock.project=null;
 await evaluate('$("#acProfile").onclick()');
 assert.equal(evaluate('$("#cpProjectScope").hidden'),true);
 evaluate('$("#cpClose").click()');
 evaluate(`const memoryEvents=[{kind:"tool_start",data:{call_id:"profile-demo",name:"creative_profile_suggest"}},
   {kind:"tool_end",data:{call_id:"profile-demo",name:"creative_profile_suggest",
     result:{text:"等待确认",profile_suggestion:{id:"profile-demo",scope:"personal",text:"保留 <img src=x> 字样"}}}}];
   memoryEvents.forEach(event=>acAppendEvent(event));`);
 equal(evaluate('[$("[data-call=profile-demo] summary").textContent,$(".ac-profile-suggestion p").textContent,$$(".ac-profile-suggestion img").length]'),
  ['建议保存创作记忆 · 等待确认','保留 <img src=x> 字样',0]);
 await evaluate(`Promise.all([$("[data-profile-decision=save]").onclick(),$("[data-profile-decision=dismiss]").onclick()])`);
 equal(profileDecisions,['save']);
 equal(evaluate('[$("[data-profile-decision=save]").hidden,$(".ac-profile-suggestion [role=status]").textContent,$("#acInput").value]'),
  [true,'已保存到记忆','保留这条草稿']);
 evaluate(`$("[data-call=profile-demo]").remove();memoryEvents.forEach(event=>acAppendEvent(event,true));
   acAppendEvent({kind:"profile_decision",data:{id:"profile-demo",decision:"save"}},true);`);
 assert.equal(evaluate('$("[data-call=profile-demo] summary").textContent'),'建议保存创作记忆 · 已保存');
 await evaluate('$("#acProfile").onclick()');
 evaluate('$("#acClose").click()');
 equal(evaluate('[$("#creativeProfile").open,$("#agentChat").hidden]'),[false,true]);
 w.fetch=profileFetch;
 console.log('Assistant memory passed: scoped settings, clearing, safe suggestion display, explicit confirmation and replay.');
};
