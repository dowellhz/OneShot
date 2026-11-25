"use strict";

module.exports = async function creativeAppsAndAssistantContext(workspace, scenarioState) {
 const { assert, equal, evaluate, jobs, ready, w } = workspace;
 evaluate('AC.open=true;AC.board=boardId;$("#agentChat").hidden=false');
 await evaluate('acLoadSession("parallel-ui-a")');
 equal(evaluate(`[$("#acNew").disabled,$("#acParallel").hidden,$$("[data-parallel-session]").map(b=>[...b.children].map(e=>e.textContent))]`),
  [false,false,[['写分镜','等待确认生成方案 · 排队 1'],['剪旁白','正在理解与规划']]]);
 equal(evaluate(`[$("[data-node-agent-session=parallel-ui-a] span",els.get("n1")).textContent,
   $("[data-node-agent-session=parallel-ui-b] span",els.get(stemTestVideo.id)).textContent]`),['待确认','规划中']);
 evaluate('const oldNodeJob=node("n1").job;node("n1").job={agent_call:"badge-pending"};acRenderNodeActivity()');
 assert.ok(evaluate('$("[data-node-agent-session=parallel-ui-b]",els.get("n1"))'));
 evaluate('node("n1").job=oldNodeJob;acRenderNodeActivity()');
 evaluate('$("#acInput").value="甲的草稿";AC.refs=[];AC.referencePins.clear();acAttachNodeReference(stemTestVideo,stemTestVideo.versions[0].ref)');
 scenarioState.holdParallel=true;
 const oldParallelPoll=evaluate('acPoll()');
 await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(typeof scenarioState.releaseParallelPoll,'function');
 evaluate('$("[data-node-agent-session=parallel-ui-b]",els.get(stemTestVideo.id)).click();$("#acNodeTaskOpen").click()');
 await ready('AC.session==="parallel-ui-b"&&$("#acMessages").textContent.includes("助手 b")','second session loads before an older poll returns');
 scenarioState.releaseParallelPoll();
 await oldParallelPoll;
 equal(evaluate('[$("#acInput").value,AC.referencePins.size,$("#acMessages").textContent.includes("助手 a")]'),['',0,false]);
 evaluate('$("#acInput").value="乙的草稿"');
 await evaluate('$("#acStop").onclick()');
 equal(scenarioState.parallelCalls,['/api/chat/runs/parallel-run-b/stop']);
 assert.equal(evaluate('!!$("[data-node-agent-session=parallel-ui-b]")'),false);
 await evaluate('acLoadSession("parallel-ui-a")');
 equal(evaluate('[$("#acInput").value,AC.referencePins.get(stemTestVideo.id).ref,acActive().state]'),
  ['甲的草稿','output:h3studio/stem-video-old.mp4','waiting_approval']);
 await evaluate('$("#acNew").onclick()');
 equal(evaluate('[AC.session,$("#acInput").value,$("#acParallel").hidden]'),['parallel-ui-c','',false]);
 await evaluate('acLoadSession("parallel-ui-b")');
 assert.equal(evaluate('$("#acInput").value'),'乙的草稿');
 evaluate('acAttachNodeReference(stemTestVideo,stemTestVideo.versions[0].ref);$("#creativeAppsBtn").click()');
 assert.equal(evaluate('$("#creativeApps").open'),true);
 evaluate('$("#creativeApps [data-app-category]").value="视频";$("#creativeApps [data-app-category]").dispatchEvent(new Event("change"))');
 equal(evaluate(' $$("#creativeApps [data-app-list] button").map(button=>button.dataset.appId)'),['previs','broll','loop-gif','remake']);
 evaluate('$("#creativeApps [data-app-id=broll]").click()');
 assert.equal(evaluate('$("#creativeApps video").getAttribute("src")'),'/static/creative-examples/broll.mp4');
 await evaluate('$("#creativeApps [data-app-example]").onclick()');
 equal(evaluate('[AC.session,AC.referencePins.get(stemTestVideo.id).ref,$("#creativeApps").open]'),['parallel-ui-b','output:h3studio/stem-video-old.mp4',false]);
 assert.match(evaluate('$("#acInput").value'),/^乙的草稿\n\n创作任务 · 动态字幕与图表/);
 assert.match(evaluate('$("#acInput").value'),/三月 10，四月 20，五月 30/);
 evaluate(`$("#creativeAppsBtn").click();
  $('[data-app-id="broll"]',$("#creativeApps")).click();
  $('[name="app-0"]',$("#creativeApps")).value="结尾显示订单增长";
  $('[name="app-1"]',$("#creativeApps")).value="保留原声";
  $("[data-app-source]",$("#creativeApps")).value=stemTestVideo.id;
  $("[data-app-source]",$("#creativeApps")).dispatchEvent(new Event("change"));`);
 await evaluate('$("[data-app-workspace]",$("#creativeApps")).onclick()');
 equal(evaluate(`[$("#brollDialog").open,brollSession.ref,stemTestVideo.cur,$("#brollDialog [name=brief]").value]`),
  [true,'output:h3studio/stem-video-old.mp4',1,'画面内容和图表数据 · 结尾显示订单增长\n显示时段和样式 · 保留原声'],
  'opening the native workspace carries the form brief and uses the pinned historical media without switching tabs');
 evaluate('closeBroll()');
 evaluate('$("#creativeAppsBtn").click();$("#creativeApps [data-app-id=loop-gif]").click()');
 await evaluate('$("#creativeApps [data-app-example]").onclick()');
 const gifAppDraft=evaluate('$("#acInput").value');
 assert.ok(gifAppDraft.includes("创作任务 · 循环动图") && gifAppDraft.includes("再导出 GIF"));
 assert.equal(evaluate('AC.referencePins.get(stemTestVideo.id).ref'),'output:h3studio/stem-video-old.mp4');
 const appPreviewFetch=w.fetch;
 w.fetch=(url,options)=>{
  const path=new URL(String(url),'http://oneshot.test').pathname;
  const row={id:'starter-storyboard',name:'三镜头分镜模板',category:'分镜',builtin:true,nodes:2};
  const result=path==='/api/canvas-templates/presets'?[row]:path==='/api/canvas-templates/starter-storyboard/preview'?
   {name:row.name,nodes:[{id:'n1',name:'故事简报',type:'text',inputs:{text:'旧故事'}},
    {id:'n2',name:'分镜',type:'script',inputs:{prompt:'',nshots:'3',shotlen:'5',aspect:'16:9'}}],edges:[]}:null;
  return result?Promise.resolve({ok:true,json:async()=>result}):appPreviewFetch(url,options);
 };
 const appBoardNodes=evaluate('B.nodes.length');
 evaluate(`$("#creativeAppsBtn").click();
  $('[name="app-0"]',$("#creativeApps")).value="深夜末班列车";
  $('[name="app-1"]',$("#creativeApps")).value="20 秒，5 镜";
  $('[name="app-2"]',$("#creativeApps")).value="9:16，纪实风";`);
 await evaluate('$("[data-app-template]",$("#creativeApps")).onclick()');
 assert.match(evaluate('$("[data-field=text]",$("#templatePreview")).value'),/深夜末班列车[\s\S]*20 秒，5 镜/);
 equal(evaluate(`[$("[data-field=nshots]",$("#templatePreview")).value,$("[data-field=shotlen]",$("#templatePreview")).value,
  $("[data-field=aspect]",$("#templatePreview")).value,B.nodes.length,$("#templatePreview .template-inputs").open]`),
  ['auto','auto','9:16',appBoardNodes,true],'template launch pre-fills only the editable copy preview, including script controls');
 equal(evaluate('templateCopyPayload($("[data-template-action=insert]",$("#templatePreview"))).inputs.map(input=>[input.node,input.field,input.before]).slice(-3)'),
  [['n2','nshots','3'],['n2','shotlen','5'],['n2','aspect','16:9']]);
 evaluate('closeWorkflowTemplates()');
 w.fetch=appPreviewFetch;
 console.log('Creative apps passed: category, example and insertion preserve the running session, draft and pinned version.');
 console.log('Creative app launch DOM passed: prefilled templates and historical-version workspace handoff.');
 evaluate(`const previousAgentDraft=$("#acInput").value, liveStemVersion=stemTestVideo.cur;
   vtTabMenu(stemTestVideo,0,70,100);`);
 await evaluate('$("[data-version-new-session]").onclick()');
 equal(evaluate(`[AC.session,$("#acInput").value,AC.refs,AC.referencePins.get(stemTestVideo.id).ref,stemTestVideo.cur===liveStemVersion]`),
  ['parallel-ui-d','',[evaluate('stemTestVideo.id')],'output:h3studio/stem-video-old.mp4',true],
  'opening a new conversation from a historical version preserves the visible version and pins the selected source');
 await evaluate('acLoadSession("parallel-ui-b")');
 assert.equal(evaluate('$("#acInput").value===previousAgentDraft'),true);
 evaluate(`sel=new Set(["n1",stemTestVideo.id]);updateSel();
   ctxMenu({target:els.get(stemTestVideo.id),clientX:80,clientY:110});$("#ctxMenu [data-a=agent-new]").click();`);
 await ready('AC.session==="parallel-ui-e"&&AC.refs?.length===2','context menu opens a separate conversation with the full selection');
 equal(evaluate('[AC.refs,AC.referencePins.get(stemTestVideo.id).ref,$("#acInput").value]'),
  [['n1',evaluate('stemTestVideo.id')],evaluate('curV(stemTestVideo).ref'),'']);
 assert.equal(scenarioState.parallelCreates,3);
 evaluate(`$("#acExecutionScope").value="plan";$("#acExecutionScope").dispatchEvent(new Event("change"));
   $("#acInput").value="给我一个方案";`);
 assert.equal(evaluate('$("#acGenerationMode").disabled'),true);
 await evaluate('acSend()');
 assert.equal(scenarioState.scopedMessages[0].execution_scope,'plan');
 assert.equal(scenarioState.scopedMessages[0].generation_mode,undefined);
 await evaluate('acLoadSession("parallel-ui-b")');
 assert.equal(evaluate('$("#acExecutionScope").value'),'full');
 await evaluate('acLoadSession("parallel-ui-e")');
 assert.equal(evaluate('$("#acExecutionScope").value'),'plan');
 evaluate(`$("#acExecutionScope").value="brainstorm";$("#acExecutionScope").dispatchEvent(new Event("change"));
  const directionIds=["雨夜悬疑","站台重逢","误车喜剧"];
  acAppendEvent({kind:"tool_start",data:{name:"creative_directions",call_id:"idea-comparison"}});
  acAppendEvent({kind:"tool_end",data:{name:"creative_directions",call_id:"idea-comparison",result:{creative_directions:directionIds.map(title=>(
   {title,premise:"<img onerror=alert(1)> 空站台",approach:"试写场景",tradeoff:"需要夜景素材",first_step:"五秒开场"}))}}});
  const ideaCard=$("[data-call=idea-comparison]");`);
 equal(evaluate('[ideaCard.open,$$(".ac-direction",ideaCard).length,!!$("img",ideaCard),$("#acGenerationMode").disabled]'),
  [true,3,false,true],'brainstorm displays comparison cards as text and disables generation settings');
 evaluate(`$("#acInput").value="以及保留现有主角";
  $$("[data-explore-direction]",ideaCard)[1].click();`);
 assert.match(evaluate('$("#acInput").value'),/^以及保留现有主角\n\n继续讨论「站台重逢」/);
 assert.equal(scenarioState.scopedMessages.length,1,'choosing a direction populates the draft without sending it');
 await evaluate('acSend()');
 assert.equal(scenarioState.scopedMessages[1].execution_scope,'brainstorm');
 assert.equal(scenarioState.scopedMessages[1].generation_mode,undefined);
 evaluate(`acAttachNodeReference(stemTestVideo,stemTestVideo.versions[0].ref);
  $("#acInput").value="先控制在十五秒";
  $$("[data-plan-direction]",ideaCard)[0].click();`);
 assert.equal(evaluate('$("#acExecutionScope").value'),'plan');
 assert.match(evaluate('$("#acInput").value'),/^先控制在十五秒\n\n把「雨夜悬疑」拟成制作方案[\s\S]*需要夜景素材[\s\S]*五秒开场/);
 assert.equal(scenarioState.scopedMessages.length,2,'planning loads the selected direction without submitting it');
 await evaluate('acSend()');
 assert.equal(scenarioState.scopedMessages[2].execution_scope,'plan');
 assert.equal(scenarioState.scopedMessages[2].generation_mode,undefined);
 assert(scenarioState.scopedMessages[2].selected_versions.some(item=>item.ref==='output:h3studio/stem-video-old.mp4'));
 console.log('Brainstorm assistant passed: comparison cards, scoped discussion and planning, pinned references and draft preservation.');
 evaluate(`const blankStarts=["image","video","audio"].map(type=>addNode(type,2400,1000,{prompt:"夜景草稿"}));
  const startButton=(n,action)=>$('[data-node-start="'+action+'"]',els.get(n.id));
  startButton(blankStarts[0],"prompt").click()`);
 equal(evaluate('[blankStarts.map(n=>!!startButton(n,"agent")),document.activeElement.id,sel.has(blankStarts[0].id)]'),
  [[true,true,true],'prompt',true]);
 evaluate('startButton(blankStarts[0],"agent").click()');
 await ready('AC.session==="parallel-ui-f"&&AC.refs?.[0]===blankStarts[0].id','empty node assistant opens with the selected target');
 equal(evaluate('[$("#acInput").value,document.activeElement.id,AC.referencePins.size]'),['夜景草稿','acInput',0]);
 equal(evaluate('[acComposeMessage().payload.empty_media_node,$("#acRefs").textContent.includes("接收生成结果")]'),
  [evaluate('blankStarts[0].id'),true]);
 assert.equal(scenarioState.scopedMessages.length,3,'opening the assistant does not submit the draft');
 evaluate('removeNodes(blankStarts.map(n=>n.id))');
 console.log('Empty media node starts passed: prompt focus, separate assistant conversation and preserved node draft.');
 w.fetch=scenarioState.parallelFetch;
 console.log('Parallel assistant passed: live switcher, late-poll isolation, session drafts, new chat during approval and scoped stop.');

 const gridFetch=w.fetch, gridCalls=[];
 w.fetch=async(url,options={})=>{
  if(String(url)==='/api/generate'){
   gridCalls.push(JSON.parse(options.body));
   const ref='output:h3studio/grid-shortcut.png';
   jobs.set('shortcut-grid-job',{state:'done',outputs:[{ref,url:'/media?ref='+encodeURIComponent(ref),meta:{width:900,height:600}}]});
   return {ok:true,text:async()=>JSON.stringify({ids:['shortcut-grid-job']})};
  }
  if(String(url)==='/api/split'){
   gridCalls.push(JSON.parse(options.body));
   const tiles=Array.from({length:9},(_,i)=>({...evaluate('copyAsset("shortcut-tile.png")'),row:Math.floor(i/3),col:i%3,w:300,h:200}));
   return {ok:true,text:async()=>JSON.stringify({tiles})};
  }
  return gridFetch(url,options);
 };
 evaluate('const gridFixture=snap();const gridBase=addNode("image",0,800,{},{versions:[copyAsset("shortcut-ref.png")],cur:0});const gridTarget=addNode("image",440,800,{aspect:"3:4",seed:912});selectOnly(gridTarget.id)');
 evaluate('const shortcutInput=$("#prompt");shortcutInput.focus();shortcutInput.value="/";shortcutInput.setSelectionRange(1,1);shortcutInput.dispatchEvent(new InputEvent("input",{inputType:"insertText",data:"/",bubbles:true}))');
 assert.equal(evaluate('$("#slash-grid9").disabled'),true);
 evaluate('shortcutInput.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));link(gridBase,gridTarget,true);const gridOther=addNode("image",0,1150,{},{versions:[copyAsset("shortcut-ref-extra.png")],cur:0});link(gridOther,gridTarget,true);');
 evaluate('shortcutInput.value="原创草稿\\n/";shortcutInput.setSelectionRange(shortcutInput.value.length,shortcutInput.value.length);shortcutInput.dispatchEvent(new InputEvent("input",{inputType:"insertText",data:"/",bubbles:true}));');
 evaluate('shortcutInput.setRangeText("grid9",shortcutInput.selectionStart,shortcutInput.selectionEnd,"end");shortcutInput.dispatchEvent(new InputEvent("input",{inputType:"insertText",data:"grid9",bubbles:true}))');
 equal(evaluate('[$$("#slashMenu button").length,shortcutInput.getAttribute("aria-activedescendant")]'),[1,"slash-grid9"]);
 evaluate('shortcutInput.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",bubbles:true,cancelable:true}))');
 await ready('gridTarget.versions.length===1 && !gridTarget.job','grid shortcut generation completes',300);
 assert.match(gridCalls[0].prompt,/左前中景/);
 equal([gridCalls[0].ar,gridCalls[0].seed,gridCalls[0].images.map(image=>image.ref)],[.75,912,["output:h3studio/shortcut-ref.png"]]);
 equal(evaluate('[gridTarget.data.prompt,curV(gridTarget).image_grid,curV(gridTarget).input_edges.length]'),['原创草稿\n',true,1]);
 evaluate('$("[data-a=split3x3]",$("#ntools")).click()');
 await ready('B.nodes.some(n=>n.name.endsWith("主体细节特写"))','grid tiles appear',150);
 equal(gridCalls[1],{ref:"output:h3studio/grid-shortcut.png",rows:3,cols:3});
 equal(evaluate('Array.from(sel,id=>node(id).name.split(" · ").at(-1))'),Array.from(evaluate('GRID9_ANGLES')));
 evaluate('restore(gridFixture)');
 w.fetch=gridFetch;
 console.log('Image shortcuts passed: required reference, filtering, Tab activation, preserved draft and ordered grid splits.');
};
