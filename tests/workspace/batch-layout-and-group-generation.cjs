"use strict";

module.exports = async function batchLayoutAndGroupGeneration(workspace, scenarioState) {
 const { assert, equal, evaluate, jobs, ready, w } = workspace;
 scenarioState.generationFetch = w.fetch;
 scenarioState.submittedBatches = [];
 const quotedGeneration=[];
 let persistedLayout;
 w.fetch=async(url,options)=>{
  if(String(url)==="/api/generation-cost"){
   const {requests}=JSON.parse(options.body);
   quotedGeneration.push(requests);
   return {ok:true,text:async()=>JSON.stringify({amounts:requests.map(r=>
    r.kind==="image" ? .125*r.count : r.board==="btest"&&r.prompt?.includes("@报价素材") ? 1.25*r.count : null)})};
  }
  if(String(url)!=="/api/generate"){
   if(String(url)==="/api/board/btest"&&options?.method==="PUT")persistedLayout=JSON.parse(options.body).batch_layout;
   return scenarioState.generationFetch(url,options);
  }
  const req=JSON.parse(options.body),jobId="layout-job-"+scenarioState.submittedBatches.length;
  scenarioState.submittedBatches.push({jobId,req});
  jobs.set(jobId,{state:"running"});
  return {ok:true,text:async()=>JSON.stringify({ids:[jobId]})};
 };
 scenarioState.finishBatch = (index,total=2)=>{
  const {jobId,req}=scenarioState.submittedBatches[index],ext=req.kind==="video"?".mp4":".png";
  jobs.set(jobId,{state:"done",meta:{model:"layout-fixture"},outputs:Array.from({length:total},(_,i)=>{
   const ref="output:h3studio/"+jobId+"-"+i+ext;
   return {ref,url:"/media?ref="+encodeURIComponent(ref),meta:{width:720,height:1280,duration:5}};
  })});
 };
 evaluate(`const beforeBatchLayout=snap();
  const layoutSource=addNode("text",2200,100,{text:"保持构图"});
  const batchImage=addNode("image",2600,100,{prompt:"不同光线",count:2});
  link(layoutSource,batchImage,true);
  const setBatchLayout=value=>{renderBoardMenu();const select=$("[data-batch-layout]");select.value=value;select.dispatchEvent(new Event("change"));};`);
 equal(evaluate('canvasBatchLayout()'),'tabs','old canvases default to version tabs');
 await evaluate('generate(batchImage)');
 scenarioState.finishBatch(0);
 await ready('batchImage.versions.length===2','default keeps two generated images on the same node',350);
 evaluate('setBatchLayout("fold")');
 await evaluate('generate(batchImage)');
 await evaluate('flushSave()');
 assert.equal(persistedLayout,'fold');
 evaluate('setBatchLayout("spread")');
 scenarioState.finishBatch(1);
 await ready('B.groups.some(g=>g.name.endsWith("批量结果"))','submitted fold mode stays fixed after a setting change',350);
 equal(evaluate(`(()=>{const g=B.groups.find(g=>g.name.endsWith("批量结果"));return [
  g.collapsed,g.nodes.map(id=>node(id).versions.length),g.nodes.map(id=>B.edges.find(e=>e.to===id).from===layoutSource.id),
  batchImage.versions.length,curV(batchImage).ref];})()`),[true,[1,1],[true,true],2,'output:h3studio/layout-job-0-1.png'],
 'fold creates a group of independent results and leaves earlier image versions intact');
 evaluate('undo()');
 assert.equal(evaluate('B.groups.some(g=>g.name.endsWith("批量结果"))'),false);
 evaluate(`const batchVideo=addNode("video",2700,950,{prompt:"向前",count:2});link(layoutSource,batchVideo,true);`);
 await evaluate('generate(batchVideo)');
 scenarioState.finishBatch(2);
 await ready('B.nodes.some(n=>curV(n)?.ref==="output:h3studio/layout-job-2-1.mp4")','second video appears on the canvas',350);
 equal(evaluate(`(()=>{const v=B.nodes.find(n=>curV(n)?.ref==="output:h3studio/layout-job-2-1.mp4");return [
  curV(batchVideo).ref,v.x>batchVideo.x+size(batchVideo).w,!ctFolded(v.id),v.data.count,curV(v).node_data.count,
  curV(v).input_edges[0].to===v.id,curV(v).input_edges[0].from===layoutSource.id,
  curV(v).generation_record.settings.count];})()`),
 ['output:h3studio/layout-job-2-0.mp4',true,true,1,1,true,true,2],
 'spread reuses an empty video node then adds a sibling with working pinned video inputs');
 evaluate('const batchNodeTotal=B.nodes.length;setBatchLayout("fold");');
 await evaluate('generate(batchVideo)');
 scenarioState.finishBatch(3,1);
 await ready('curV(batchVideo)?.ref==="output:h3studio/layout-job-3-0.mp4"','a single successful result remains a version',350);
 assert(evaluate('B.nodes.length===batchNodeTotal && batchVideo.versions.length===2'));
 evaluate('restore(beforeBatchLayout);delete B.batch_layout;save()');
 console.log('Batch layout DOM passed: setting persistence, submission snapshot, legacy tabs, folded results and undo, spread video and one-result fallback.');
 evaluate(`const quoteBase=snap();
  const quoteVideo=addNode("video",1500,100,{prompt:"空镜头",count:2},{name:"报价视频"});
  const quoteImage=addNode("image",2100,700,{prompt:"海报",count:1},{name:"报价图片"});
  const quoteGroup=ctNewGroup("参考报价",[quoteVideo.id,quoteImage.id]);drawEdges();
  selectOnly(quoteVideo.id);
  $("#prompt").value="使用 @报价素材";$("#prompt").dispatchEvent(new Event("input"));`);
 await ready('$("[data-generation-cost]")?.textContent.includes("¥2.50")','editing an asset mention refreshes the node quote');
 evaluate('$("[data-group-run]",CT_GROUPS.get(quoteGroup.id)).click()');
 await ready('$("#groupRunConfirm [data-group-cost]").textContent.includes("¥2.625")','group quote includes the asset video and image');
 assert(quotedGeneration.some(batch=>batch.length===2&&batch.some(request=>request.prompt==="使用 @报价素材"&&request.count===2)));
 evaluate('$("#groupRunConfirm footer [data-close]").click();restore(quoteBase)');
 evaluate(`const groupRunBase=snap();setBatchLayout("fold");
  const workflowImage=addNode("image",1500,100,{prompt:"起始构图",count:2},{name:"分镜首帧"});
  const workflowVideo=addNode("video",2100,100,{prompt:"镜头慢慢推进",count:1},{name:"分镜视频"});
  const independentImage=addNode("image",1500,850,{prompt:"另一处场景",count:1},{name:"场景参考"});
  link(workflowImage,workflowVideo,true);
  const workflowGroup=ctNewGroup("场景制作",[workflowVideo.id,workflowImage.id,independentImage.id]);drawEdges();
  const workflowButton=$("[data-group-run]",CT_GROUPS.get(workflowGroup.id));
  const approveWorkflow=()=>$("#groupRunConfirm form").dispatchEvent(new Event("submit",{cancelable:true}));
  selectOnly(workflowImage.id);
  workflowButton.click();`);
 await ready('$("#groupRunConfirm [data-group-cost]").textContent.includes("¥0.375")','batch quotes retain known subtotal');
 assert.match(evaluate('$("#groupRunConfirm [data-group-cost]").textContent'),/1 个节点无法估算/);
 await ready('$("[data-generation-cost]")?.textContent.includes("¥0.25")','node generation quotes include the selected result count');
 equal(evaluate('$$("#groupRunConfirm li strong").map(el=>el.textContent)'),['分镜首帧','分镜视频','场景参考'],'confirmation shows dependency order before submission');
 assert.match(evaluate('$("#groupRunConfirm [data-summary]").textContent'),/3 个节点.*4 项/);
 equal(evaluate(`workflowVideo.data.count=4;
   workflowVideo.data.prompt+=" @图{123}";
   const batchCountQuote=canvasCostRequest(workflowVideo);
   workflowVideo.data.count=1;workflowVideo.data.prompt="镜头慢慢推进";
   [batchCountQuote.count,batchCountQuote.has_asset,batchCountQuote.images]`),
   [3,false,[{role:"frame"}]],'video quotes count all results and include the role of each connected reference');
 assert.match(evaluate('$("#groupRunConfirm .group-run-refs").textContent'),/分镜首帧\s*首帧 · 本轮生成/);
 assert.equal(evaluate('$("#groupRunConfirm .group-run-refs img")'),null,'a live dependency preview does not show a stale thumbnail');
 evaluate('$("#groupRunConfirm footer [data-close]").click()');
 assert.equal(scenarioState.submittedBatches.length,4,'cancelling confirmation submits nothing');
 evaluate('workflowButton.click();approveWorkflow()');
 await ready('workflowImage.job && groupRun.active','group submits the first upstream node');
 assert.equal(scenarioState.submittedBatches.length,5,'downstream waits for the upstream result');
 scenarioState.finishBatch(4);
 await ready('workflowVideo.job','group submits video only after image success',350);
 assert.equal(scenarioState.submittedBatches[5].req.images[0].ref,'output:h3studio/layout-job-4-1.png');
 assert.equal(evaluate('workflowImage.versions.length'),2,'group execution keeps generated images on the linked node under fold preference');
 scenarioState.finishBatch(5,1);
 await ready('independentImage.job','group moves on to the final independent branch',350);
 scenarioState.finishBatch(6,1);
 await ready('!groupRun.active','workflow reaches a terminal state',350);
 equal(evaluate('groupRun.steps.map(step=>step.status)'),['done','done','done'],'completed generation stays visible in the progress panel');
 evaluate('workflowButton.click();const mode=$("#groupRunConfirm select");mode.value="all";mode.dispatchEvent(new Event("change"));approveWorkflow()');
 await ready('workflowImage.job','rerun includes nodes that have results',350);
 const failedUpstream=scenarioState.submittedBatches[7].jobId;
 jobs.set(failedUpstream,{state:"error",error:"上游服务失败"});
 await ready('independentImage.job','an independent branch still runs after upstream failure',350);
 assert.equal(scenarioState.submittedBatches.length,9,'dependent video was not resubmitted with its stale frame');
 scenarioState.finishBatch(8,1);
 await ready('!groupRun.active','failure workflow finishes with independent outputs',350);
 equal(evaluate('groupRun.steps.map(step=>step.status)'),['error','skipped','done'],'progress distinguishes errors from skipped dependents');
 evaluate('workflowButton.click();mode.value="all";mode.dispatchEvent(new Event("change"));approveWorkflow()');
 await ready('workflowImage.job','stop test starts its first generation',350);
 evaluate('$("#groupRunProgress [data-stop]").click()');
 scenarioState.finishBatch(9);
 await ready('!groupRun.active','stop waits for the submitted node without launching more',350);
 assert.equal(scenarioState.submittedBatches.length,10);
 equal(evaluate('groupRun.steps.map(step=>step.status)'),['done','skipped','skipped'],'stop preserves the first result');
 evaluate(`const stoppedOutput=curV(workflowImage).ref;
  switchVersion(workflowImage,0);
  const retryGroup=$("#groupRunProgress [data-retry]");
  retryGroup.click();`);
 assert.match(evaluate('$("#groupRunConfirm ol").textContent'),/已切换版本/);
 assert.match(evaluate('$("#groupRunConfirm [data-summary]").textContent'),/将重试 1 个节点.*保留 1 个完成节点/);
 evaluate(`$("#groupRunConfirm footer [data-close]").click();
  switchVersion(workflowImage,workflowImage.versions.findIndex(v=>v.ref===stoppedOutput));
  retryGroup.click();`);
 assert.match(evaluate('$("#groupRunConfirm [data-summary]").textContent'),/将重试 2 个节点/);
 assert.equal(scenarioState.submittedBatches.length,10,'opening retry submits no work');
 evaluate('approveWorkflow()');
 await ready('workflowVideo.job','retry starts from the unfinished video',350);
 assert.equal(scenarioState.submittedBatches[10].req.images[0].ref,evaluate('stoppedOutput'),'retry reuses the completed upstream output');
 jobs.set(scenarioState.submittedBatches[10].jobId,{state:"error",error:"模拟视频失败"});
 await ready('independentImage.job','failed retry leaves the other branch runnable',350);
 scenarioState.finishBatch(11,1);
 await ready('!groupRun.active','retry completes with one remaining failure',350);
 evaluate('retryGroup.click()');
 equal(evaluate('$$("#groupRunConfirm li strong").map(el=>el.textContent)'),['分镜视频'],
  'the second retry keeps both successful nodes and only offers the remaining failure');
 evaluate('approveWorkflow()');
 await ready('workflowVideo.job','second retry launches only the failed video',350);
 assert.equal(scenarioState.submittedBatches[12].req.images[0].ref,evaluate('stoppedOutput'));
 scenarioState.finishBatch(12,1);
 await ready('!groupRun.active','second retry completes',350);
 equal(evaluate('groupRun.steps.map(step=>step.status)'),['done','done','done'],'all earlier successes remain visible after the retry');
 assert(evaluate('$("#groupRunProgress [data-retry]").hidden'));
 const targetedStart=scenarioState.submittedBatches.length;
 evaluate(`const rerunMedia=name=>({ref:"output:h3studio/"+name+".png",url:"/media?ref=output:h3studio/"+name+".png",w:512,h:512});
  const rerunSource=addNode("image",900,100,{}, {name:"原始素材",versions:[rerunMedia("previous")],cur:0});
  const rerunReplacement=addNode("image",900,480,{}, {name:"更新素材",versions:[rerunMedia("replacement")],cur:0});
  const pinnedScene=addNode("image",2150,850,{prompt:"引用旧版本",count:1},{name:"固定旧分镜"});
  workflowImage.data.count=1;
  link(rerunSource,workflowImage,true);
  link(workflowImage,pinnedScene,true,{ref:curV(workflowImage).ref});
  workflowGroup.nodes.push(pinnedScene.id);
  drawEdges();
  $("[data-group-replace]",CT_GROUPS.get(workflowGroup.id)).click();
  const currentOriginal=$("#versionRefUpdate [name=original]");
  currentOriginal.value=rerunSource.id;currentOriginal.dispatchEvent(new Event("change"));
  const currentReplacement=$("#versionRefUpdate [name=replacement]");
  currentReplacement.value=rerunReplacement.id;currentReplacement.dispatchEvent(new Event("change"));
  $("#versionRefUpdate [data-review-run]").click();`);
 equal(evaluate('[$("#groupRunConfirm select").value,$$("#groupRunConfirm li strong").map(el=>el.textContent)]'),
   ["affected",["分镜首帧","分镜视频"]],'targeted run follows live downstream images and skips independent or pinned branches');
 assert.equal(scenarioState.submittedBatches.length,targetedStart,'showing the targeted plan does not submit generation');
 evaluate('approveWorkflow()');
 await ready('workflowImage.job','targeted rerun starts with the changed image reference',350);
 assert.equal(scenarioState.submittedBatches[targetedStart].req.images[0].ref,'output:h3studio/replacement.png');
 scenarioState.finishBatch(targetedStart,1);
 await ready('workflowVideo.job','dependent video uses the new upstream image',350);
 assert.equal(scenarioState.submittedBatches[targetedStart+1].req.images[0].ref,`output:h3studio/layout-job-${targetedStart}-0.png`);
 scenarioState.finishBatch(targetedStart+1,1);
 await ready('!groupRun.active','targeted rerun finished',350);
 assert.equal(scenarioState.submittedBatches.length,targetedStart+2,'no independent or pinned shots were resubmitted');
 evaluate(`const recoveryId=groupRun.id;
  const runReceipt=JSON.parse(sessionStorage.getItem(groupRunStorageKey(boardId)));
  runReceipt.steps[0].status="running";runReceipt.steps[1].status="waiting";
  sessionStorage.setItem(groupRunStorageKey(boardId),JSON.stringify(runReceipt));
  restoreCanvasGroupRun();`);
 equal(evaluate(`[groupRun.id===recoveryId,groupRun.active,groupRun.steps.map(step=>step.status),
  curV(workflowImage).group_run_id===recoveryId,groupRun.steps[0].outputRef===curV(workflowImage).ref]`),
  [true,false,["done","skipped"],true,true],'restoring progress recognizes the exact saved output and leaves unsubmitted steps for confirmation');
 assert.equal(scenarioState.submittedBatches.length,targetedStart+2,'restoring the receipt submits no additional generation');
 evaluate(`$("#groupRunProgress [data-dismiss]").click();
  const groupPlanBoard=AC.board;AC.board=boardId;
  acAppendEvent({kind:"tool_start",data:{name:"canvas_group_run_plan",call_id:"scoped-group-run"}});
  acAppendEvent({kind:"tool_end",data:{name:"canvas_group_run_plan",call_id:"scoped-group-run",result:{group_run_plan:{
   board:boardId,group:workflowGroup.id,name:workflowGroup.name,targets:[workflowVideo.id],mode:"all"}}}});
  const extraMember=addNode("video",2200,1300,{prompt:"新加入的镜头"});
  workflowGroup.nodes.push(extraMember.id);
  $("[data-call=scoped-group-run] [data-group-run-plan]").click();AC.board=groupPlanBoard;`);
 equal(evaluate('$$("#groupRunConfirm li strong").map(el=>el.textContent)'),['分镜视频'],
  'the assistant card retains its original scope when a new node joins the group');
 assert.match(evaluate('$("#groupRunConfirm .group-run-refs small").textContent'),/首帧 · 版本 \d+（当前）/);
 assert.equal(evaluate('new URL($("#groupRunConfirm .group-run-refs img").src,location.href).searchParams.get("ref")'),evaluate('curV(workflowImage).ref'));
 assert.equal(scenarioState.submittedBatches.length,targetedStart+2,'opening the assistant preview does not submit');
 evaluate('approveWorkflow()');
 await ready('workflowVideo.job','assistant group confirmation starts the specified video',350);
 assert.equal(scenarioState.submittedBatches[targetedStart+2].req.images[0].ref,evaluate('curV(workflowImage).ref'));
 scenarioState.finishBatch(targetedStart+2,1);
 await ready('!groupRun.active','assistant planned run completes',350);
 assert.equal(scenarioState.submittedBatches.length,targetedStart+3);
 evaluate(`const storyLast={duration:5,shot_size:"中景",camera:"缓推",scene:"窗边暖光",characters:["林森"],
   action:["右手握木盒"],dialogue:[],sound:"风声",keyframe:"木盒在窗台",
   asset_refs:[{id:"prior-room",name:"旧房",kind:"scene"}]};
  const storyNext={...storyLast,shot_size:"近景",keyframe:"林森右手握木盒",action:["左手打开盒盖"],
   asset_refs:[{id:"next-hero",name:"林森",kind:"character",view:"face"}]};
  const storyCast=[{name:"林森",look:"深蓝外套"}];
  const storyNode=addNode("script",4000,100,{style:"写实暖光",characters:storyCast,shots:[storyLast],made:[]});
  const legacyStoryImage=addNode("image",4450,100,{}, {name:"以前的首帧"});
  const legacyStoryVideo=addNode("video",4450,600,{}, {name:"以前的镜头"});
  storyNode.data.made=[{img:legacyStoryImage.id,vid:legacyStoryVideo.id}];
  const storyReference=addNode("image",3570,100,{}, {name:"林森",versions:[rerunMedia("cast-previous"),rerunMedia("cast-current")],cur:1});
  B.edges.push({from:storyReference.id,to:storyNode.id,ref:storyReference.versions[0].ref});
  const storyBefore=B.nodes.length;
  AC.board=boardId;
  acAppendEvent({kind:"tool_start",data:{name:"storyboard_next_shot_plan",call_id:"next-shot"}});
  acAppendEvent({kind:"tool_end",data:{name:"storyboard_next_shot_plan",call_id:"next-shot",result:{storyboard_plan:{
   board:boardId,node:storyNode.id,name:storyNode.name,anchor:{count:1,last:storyLast,style:"写实暖光",characters:storyCast},shot:storyNext}}}});
  const adoptShot=$("[data-call=next-shot] [data-adopt-storyboard]");
  storyNode.data.style="冷光";adoptShot.click();`);
 assert.match(evaluate('$("[data-call=next-shot] [role=status]").textContent'),/重新准备/);
 assert.equal(evaluate('storyNode.data.shots.length'),1);
 assert.match(evaluate('$("[data-call=next-shot]").textContent'),/林森（正面头肩）/);
 evaluate('storyNode.data.style="写实暖光";const priorShotAssets=storyLast.asset_refs;storyLast.asset_refs=[];adoptShot.click()');
 assert.match(evaluate('$("[data-call=next-shot] [role=status]").textContent'),/重新准备/);
 assert.equal(evaluate('storyNode.data.shots.length'),1,'changing prior assets invalidates the continuation preview');
 evaluate('storyLast.asset_refs=priorShotAssets;adoptShot.click()');
 equal(evaluate('[storyNode.data.shots.length,storyNode.data.shots.at(-1).keyframe,storyNode.data.made.length,B.nodes.length===storyBefore,adoptShot.disabled]'),
  [2,"林森右手握木盒",1,true,true],'confirmed continuation appends one script shot without generating or expanding the canvas');
 evaluate(`const openNewShot=$("[data-call=next-shot] [data-open-approved-shot]");
  openNewShot.click();
  const newStoryPair=scriptShotLinks(storyNode)[1], newestStoryVideo=node(newStoryPair.vid);
  openNewShot.click();`);
 equal(evaluate(`[B.nodes.length===storyBefore+2,scriptShotLinks(storyNode)[0].vid===legacyStoryVideo.id,
  newestStoryVideo.name,plan(newestStoryVideo).inputs.map(({edge,version})=>[edge.role,version?.ref??null])]`),
  [true,true,"镜2",[["first",null],["subject","output:h3studio/cast-previous.png"]]],
  'the new shot can be expanded once and located without duplicating the prior pair or switching the pinned cast');
 equal(evaluate('[newestStoryVideo.data.fields.scene.includes("@{next-hero#face|林森}"),newestStoryVideo.data.fields.scene.includes("prior-room")]'),
  [true,false],'continuation only attaches the approved references for the new shot');
 evaluate('$("[data-call=next-shot] [data-run-approved-shot]").click()');
 equal(evaluate('$$("#groupRunConfirm li strong").map(el=>el.textContent)'),["镜2 · 分镜图","镜2"],
  'the single-shot plan only includes its two nodes in dependency order');
 assert.match(evaluate('$$("#groupRunConfirm .group-run-refs").at(-1).textContent'),/首帧 · 本轮生成/);
 evaluate(`const storyRunMode=$("#groupRunConfirm select");
  storyRunMode.value="video";storyRunMode.dispatchEvent(new Event("change"));`);
 assert.match(evaluate('$("#groupRunConfirm ol").textContent'),/参考素材不可用/);
 assert(evaluate('$("#groupRunConfirm [type=submit]").disabled'));
 evaluate('$("#groupRunConfirm footer [data-close]").click()');
};
