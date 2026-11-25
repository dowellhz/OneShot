"use strict";

module.exports = async function selectionBatchesAndWizardMotion(workspace, scenarioState) {
 const { assert, equal, evaluate, jobs, ready, w } = workspace;
 const reviewedBatchStart=scenarioState.submittedBatches.length;
 w.__groupAssetReview=entry=>entry.prompt.includes("lost-asset")?{error:"参考资产已移除"}:{
  key:'c'.repeat(64),assets:[{id:'batch-hero',name:'批次角色',kind:'character',ref:'input:h3studio/batch-face.png',
   references:[{view:'face',ref:'input:h3studio/batch-face.png'}]}]};
 evaluate(`const reviewBatchBase=snap();
  const validAssetFrame=addNode("image",1600,150,{prompt:"用 @{batch-hero#face|批次角色} 生成"});
  const removedAssetFrame=addNode("image",1600,450,{prompt:"用 @{lost-asset|已删除} 生成"});
  const removedAssetVideo=addNode("video",2100,450,{prompt:"使用本轮画面"});
  link(removedAssetFrame,removedAssetVideo,true);
  openCanvasSelectionRun([validAssetFrame,removedAssetFrame,removedAssetVideo]);`);
 assert.equal(evaluate('$("#groupRunConfirm [type=submit]").disabled'),true,'confirm waits for the asset review');
 await ready('!$("#groupRunConfirm [type=submit]").disabled','batch confirms only after reference review');
 assert.match(evaluate('$("#groupRunConfirm ol").textContent'),/批次角色.*正面头肩.*参考资产已移除.*上游节点无法生成/s);
 evaluate('approveWorkflow()');
 await ready('validAssetFrame.job','confirmed asset dependencies leave the independent valid step runnable',350);
 assert.equal(scenarioState.submittedBatches[reviewedBatchStart].req.asset_review_key,'c'.repeat(64));
 assert.equal(scenarioState.submittedBatches.length,reviewedBatchStart+1);
 scenarioState.finishBatch(reviewedBatchStart,1);
 await ready('!groupRun.active','reviewed batch completes',350);
 equal(evaluate('groupRun.steps.map(step=>step.status)'),['done','skipped','skipped']);
 evaluate('$("#groupRunProgress [data-dismiss]").click();restore(reviewBatchBase)');
 delete w.__groupAssetReview;
 const branchFetch=w.fetch;
 let branchPreview;
 w.fetch=async(url,options)=>{
  if(String(url)!=="/api/preview")return branchFetch(url,options);
  branchPreview=JSON.parse(options.body);
  return {ok:true,text:async()=>JSON.stringify({prompt:branchPreview.prompt,mode:"参考预览",inputs:[]})};
 };
 const branchIndex=scenarioState.submittedBatches.length;
 evaluate(`const branchTestBase=snap();
  const branchUpstream=addNode("image",1150,330,{}, {versions:[
    {ref:"input:h3studio/branch-first.png",url:"/media?ref=input:h3studio/branch-first.png",w:640,h:480},
    {ref:"input:h3studio/branch-next.png",url:"/media?ref=input:h3studio/branch-next.png",w:640,h:480}],cur:0});
  const branchVideo=addNode("video",1550,330,{prompt:"原地转身",count:3,duration:2.5},{versions:[
    {ref:"output:h3studio/branch-original.mp4",url:"/media?ref=output:h3studio/branch-original.mp4",w:640,h:480}],cur:0});
  const branchEnding=addNode("image",1150,610,{},{versions:[
    {ref:"input:h3studio/branch-ending.png",url:"/media?ref=input:h3studio/branch-ending.png",w:640,h:480}],cur:0});
  link(branchUpstream,branchVideo,true,{role:"keyframe",time:2.5});
  link(branchEnding,branchVideo,true,{role:"last"});
  selectOnly(branchVideo.id);
  $("#moreBtn").click();$("#generationBranch").click();`);
 await ready('$("#pv").classList.contains("on") && !$("#pvBranchCommit").hidden','video branch opens a review');
 assert.equal(branchPreview.count,1);
 assert.equal(branchPreview.duration,5,'local preview uses the visible minimum for a legacy short duration');
 equal(branchPreview.images.map(image=>image.time),[2.5,5],'legacy nodes use the current duration for the last keyframe');
 evaluate('branchVideo.data.prompt="已更改动作";$("#pvBranchCommit").click()');
 assert.equal(scenarioState.submittedBatches.length,branchIndex,'review becomes stale when generation settings change');
 evaluate('closePromptPreview();$("#generationBranch").click()');
 await ready('$("#pv").classList.contains("on")','edited branch can be reviewed again');
 evaluate('$("#pvBranchCommit").click()');
 await ready('!!branchVideo.job?.batch','confirmed branch is submitted');
 assert.equal(scenarioState.submittedBatches[branchIndex].req.count,1);
 assert.equal(scenarioState.submittedBatches[branchIndex].req.duration,5,'local generation uses the same duration as its preview');
 evaluate('switchVersion(branchUpstream,1);');
 scenarioState.finishBatch(branchIndex,1);
 const branchOutput="output:h3studio/layout-job-"+branchIndex+"-0.mp4";
 await ready(`B.nodes.some(n=>curV(n)?.ref===${JSON.stringify(branchOutput)})`,'branch result appears on an independent node',350);
 equal(evaluate(`(()=>{const output=B.nodes.find(n=>curV(n)?.ref===${JSON.stringify(branchOutput)});
   const input=imageInputs(output)[0];
   return [curV(branchVideo).ref,branchVideo.versions.length,branchVideo.data.count,output.data.count,
           input.edge.ref,input.edge.from===branchUpstream.id,sel.has(output.id)];
 })()`),["output:h3studio/branch-original.mp4",1,3,1,"input:h3studio/branch-first.png",true,true]);
 evaluate('undo()');
 assert.equal(evaluate(`B.nodes.some(n=>curV(n)?.ref===${JSON.stringify(branchOutput)})`),false,'undo removes the branch result');
 assert.equal(evaluate('curV(node(branchVideo.id)).ref'),"output:h3studio/branch-original.mp4");
 evaluate('restore(branchTestBase)');
 console.log('Generation to a new node passed: preview count, stale review, preserved source and pinned input, undo.');
 const motionStart=scenarioState.submittedBatches.length;
 evaluate(`const beforeMotionWizard=snap(), oldMotionWizard=W;
   const motionShot={duration:5,shot_size:"中景",camera:"固定机位",scene:"空走廊",characters:[],action:["走出门"],dialogue:[],
     keyframe:"门里",motion_frames:{middle:"一脚跨门槛",end:"停在门外"}};
   const motionScript=addNode("script",4500,200,{style:"写实",shots:[motionShot,{...motionShot,
     keyframe:"停在门外",action:["举画"],motion_frames:{middle:"举到胸口",end:"举到眼前"},continues_previous:true}]});
   expandScript(motionScript);
   const motionPairs=scriptShotLinks(motionScript);
   const motionFirst=node(motionPairs[0].img), motionMiddle=node(motionPairs[0].motion_frames.middle), motionTail=node(motionPairs[0].motion_frames.end);
   W={step:3,script:motionScript.id,takes:1,quality:"std"};
   renderWiz();`);
 equal(evaluate(`[motionPairs[1].img===motionTail.id,imageInputs(motionMiddle)[0].source.id===motionFirst.id,
   imageInputs(motionTail)[0].source.id===motionMiddle.id,
   Object.values(plan(node(motionPairs[0].vid)).times),
   $$("#wzBody .bc").length,$('#wzBody [data-go=videos]').disabled]`),[true,true,true,[0,2,5],6,true]);
 evaluate('batchImages(motionScript)');
 await ready('!$("#groupRunConfirm [type=submit]").disabled','the animation frames are ready for batch confirmation');
 evaluate('approveWorkflow()');
 for(let i=0;i<5;i++){
   await ready(`groupRun.steps[${i}]?.status==="running"`,'animation frame waits for its visual reference',350);
   assert.equal(scenarioState.submittedBatches.length,motionStart+i+1);
   if(i)assert.equal(scenarioState.submittedBatches[motionStart+i].req.images[0].ref,
     `output:h3studio/layout-job-${motionStart+i-1}-0.png`);
   scenarioState.finishBatch(motionStart+i,1);
 }
 await ready('!groupRun.active && motionTail.versions.length===1','all animation frames complete',350);
 evaluate('renderWiz()');
 assert.equal(evaluate('$("#wzBody [data-go=videos]").disabled'),false);
 evaluate(`const middleTime=$('[data-middle-time="0"]');
   middleTime.value="2.25";middleTime.dispatchEvent(new Event("change"));`);
 equal(evaluate('Object.values(plan(node(motionPairs[0].vid)).times)'),[0,2.25,5]);
 const beforeFailedVideoFetch=w.fetch;
 w.fetch=async(url,options)=>String(url)==="/api/generate"
   ? {ok:false,status:503,text:async()=>JSON.stringify({error:"视频服务暂不可用"})}
   : beforeFailedVideoFetch(url,options);
 await evaluate('goStep(4);batchVideos(motionScript)');
 evaluate('renderWiz()');
 assert.match(evaluate('$("#toast").textContent'),/2 段未提交/);
 assert.equal(evaluate('$$(".wz-shot-error",$("#wzBody")).length'),2);
 w.fetch=beforeFailedVideoFetch;
 await evaluate('batchVideos(motionScript)');
 assert.equal(scenarioState.submittedBatches[motionStart+5].req.images.length,3);
 assert.equal(scenarioState.submittedBatches[motionStart+5].req.images[1].time,2.25);
 assert.equal(scenarioState.submittedBatches[motionStart+6].req.images[0].ref,scenarioState.submittedBatches[motionStart+5].req.images[2].ref);
 scenarioState.finishBatch(motionStart+5,1);scenarioState.finishBatch(motionStart+6,1);
 await ready('motionPairs.every(pair=>!node(pair.vid).job && curV(node(pair.vid)))','the wizard generates separate videos from their keyframes',350);
 const motionCaptureFetch=w.fetch;
 w.fetch=async(url,options)=>String(url)==="/api/lastframe"
   ? {ok:true,text:async()=>JSON.stringify({ref:"input:h3studio/actual-motion-tail.png",url:"/media?ref=actual-motion-tail",w:720,h:1280})}
   : motionCaptureFetch(url,options);
 await evaluate('useRenderedMotionTail(motionScript,1)');
 w.fetch=motionCaptureFetch;
 equal(evaluate(`[imageInputs(node(motionPairs[1].vid)).find(input=>input.edge.role==="first").version.ref,
                  curV(motionTail).ref,node(motionPairs[0].vid).versions.length]`),
   ["input:h3studio/actual-motion-tail.png",`output:h3studio/layout-job-${motionStart+2}-0.png`,1]);
 evaluate(`goStep(1);
   const editWizard=(selector,value)=>{
     const field=$('#wzBody .sh[data-i="0"] '+selector);
     field.value=value;field.dispatchEvent(new Event("change"));
   };
   editWizard("[data-f=action]","0–1 秒 向右走");
   editWizard("[data-f=duration]","8");
   editWizard("[data-motion-frame=middle]","她站在门外");
   const wizardVideo=node(motionPairs[0].vid);`);
 equal(evaluate(`[videoReq(wizardVideo,fullPrompt(wizardVideo)).fields.action,videoReq(wizardVideo,fullPrompt(wizardVideo)).duration,
   motionMiddle.data.caption,storyboardFrameReady(motionMiddle),storyboardFrameReady(motionTail),node(motionPairs[0].vid).versions.length]`),
   ["0–1 秒 向右走",8,"她站在门外",false,false,1]);
 evaluate('$("#groupRunProgress [data-dismiss]").click();restore(beforeMotionWizard);W=oldMotionWizard');
 console.log('Wizard animation passed: dependent keyframes, a shared boundary, and the actual rendered tail for reruns.');
 w.fetch=scenarioState.generationFetch;
 console.log('Group run DOM passed: confirmation, dependency order, pinned result reuse, failure isolation and stopping later submissions.');
 evaluate(`const runRangeBase=snap();
  const runRangeScript=addNode("script",4500,100,{style:"写实",characters:[],shots:[0,1,2,3].map(i=>({...storyLast,id:"range-"+i,characters:[]})),made:[]});
  const runRangeCount=B.nodes.length;selectOnly(runRangeScript.id);$("#shotListBtn").click();
  $("#shotList [data-run-range]").click();
  const runRangePicker=$("#shotRangePicker"), generationFirst=$("[name=first]",runRangePicker), generationLast=$("[name=last]",runRangePicker);
  generationFirst.value="1";generationFirst.dispatchEvent(new Event("change"));
  generationLast.value="2";generationLast.dispatchEvent(new Event("change"));`);
 assert.match(evaluate('$("#shotRangePicker [role=status]").textContent'),/已选 2 镜，其中 2 镜待展开/);
 assert.equal(evaluate('B.nodes.length===runRangeCount'),true);
 evaluate('$("#shotRangePicker [type=submit]").click()');
 equal(evaluate(`[runRangePicker.open,$("#groupRunConfirm").open,scriptShotLinks(runRangeScript).map(pair=>!!pair),
   $$("#groupRunConfirm li strong").map(item=>item.textContent),B.nodes.length-runRangeCount,B.nodes.some(n=>n.job)]`),
  [false,true,[false,true,true,false],["镜2 · 分镜图","镜2","镜3 · 分镜图","镜3"],4,false],
  'shot range expands only the requested shots in order and previews their work before any generation');
 evaluate('const scopedRunMode=$("#groupRunConfirm [name=mode]");scopedRunMode.value="frame";scopedRunMode.dispatchEvent(new Event("change"))');
 equal(evaluate('$$("#groupRunConfirm li strong").map(item=>item.textContent)'),['镜2 · 分镜图','镜3 · 分镜图']);
 evaluate(`closeCanvasGroupRunDialog();const previouslyGeneratedFrame=node(scriptShotLinks(runRangeScript)[1].img);
  previouslyGeneratedFrame.versions=[rerunMedia("range-already-generated")];previouslyGeneratedFrame.cur=0;
  const rangeAssistantBoard=AC.board;AC.board=boardId;
  acAppendEvent({kind:"tool_start",data:{name:"storyboard_range_run_plan",call_id:"scoped-shot-chat"}});
  acAppendEvent({kind:"tool_end",data:{name:"storyboard_range_run_plan",call_id:"scoped-shot-chat",result:{shot_range_plan:{
    board:boardId,script:runRangeScript.id,name:runRangeScript.name,first:2,last:3,
    anchors:[{id:"range-1"},{id:"range-2"}],mode:"missing_frame"}}}});
  $("[data-call=scoped-shot-chat] [data-open-shot-range]").click();`);
 equal(evaluate('[generationFirst.value,generationLast.value]'),['1','2'],'the assistant card opens with the planned range');
 evaluate('$("#shotRangePicker [type=submit]").click()');
 equal(evaluate('[scopedRunMode.value,$$("#groupRunConfirm li strong").map(item=>item.textContent)]'),
  ['missing_frame',['镜3 · 分镜图']],'a plan to fill missing frames keeps existing results and skips video generation');
 evaluate(`closeCanvasGroupRunDialog();
  const rangePriorVideo=node(scriptShotLinks(runRangeScript)[1].vid),rangeFollowingFrame=node(scriptShotLinks(runRangeScript)[2].img);
  const rangeFollowingVideo=node(scriptShotLinks(runRangeScript)[2].vid);
  const rangeGuide=addNode("image",4100,200,{}, {versions:[rerunMedia("range-guide")],cur:0});
  B.edges.push({from:rangeGuide.id,to:rangeFollowingFrame.id,ref:curV(rangeGuide).ref,prompt_slot:2});
  rangeFollowingFrame.data.image_ref_seq=2;rangeFollowingFrame.data.prompt+="\\n角色参考 @图{2}";
  const rangeFramePrompt=rangeFollowingFrame.data.prompt;
  const originalRangeTail=()=>B.edges.find(edge=>edge.to===rangeFollowingFrame.id&&edge.story_continuity);`);
 const batchTailRequests=[];
 w.fetch=(url,options)=>{
  if(String(url)!=="/api/lastframe")return scenarioState.groupBatchFetch(url,options);
  batchTailRequests.push(JSON.parse(options.body));
  const ref="input:h3studio/range-tail-"+batchTailRequests.length+".png";
  return Promise.resolve({ok:true,text:async()=>JSON.stringify({ref,url:'/media?ref='+encodeURIComponent(ref),w:64,h:64,at:4.9})});
 };
 const newChainStart=scenarioState.submittedBatches.length;
 evaluate(`acAppendEvent({kind:"tool_start",data:{name:"storyboard_range_run_plan",call_id:"continuous-shot-chat"}});
  acAppendEvent({kind:"tool_end",data:{name:"storyboard_range_run_plan",call_id:"continuous-shot-chat",result:{shot_range_plan:{
    board:boardId,script:runRangeScript.id,name:runRangeScript.name,first:2,last:3,
    anchors:[{id:"range-1"},{id:"range-2"}],mode:"missing",tail_mode:"connect"}}}});
  const continuityCard=$("[data-call=continuous-shot-chat]");
  $("[data-open-shot-range]",continuityCard).click();
  $("#shotRangePicker [type=submit]").click();
  const connectTailOption=$("#groupRunConfirm [name=connect-tails]");
  const tailRefreshOption=$("#groupRunConfirm [name=refresh-tails]"), rangeRunSubmit=$("#groupRunConfirm [type=submit]");`);
 assert.match(evaluate('continuityCard.textContent'),/连接缺失的上一镜尾帧/);
 equal(evaluate('[connectTailOption.closest("label").hidden,connectTailOption.checked,tailRefreshOption.closest("label").hidden]'),
  [false,true,true],'the assistant preselects new tail connections in the existing run dialog');
 assert.match(evaluate('$("#groupRunConfirm ol").textContent'),/连接上一镜尾帧 · 取本轮生成视频/);
 assert.match(evaluate('$("#groupRunConfirm [data-summary]").textContent'),/为 1 张分镜图连接上一镜尾帧/);
 evaluate('connectTailOption.click()');
 assert.doesNotMatch(evaluate('$("#groupRunConfirm ol").textContent'),/连接上一镜尾帧/);
 evaluate('connectTailOption.click()');
 assert.equal(evaluate('!!originalRangeTail() || rangeFollowingFrame.data.prompt!==rangeFramePrompt'),false);
 assert.equal(batchTailRequests.length,0,'preview does not capture a frame or alter the prompt');
 assert.equal(scenarioState.submittedBatches.length,newChainStart,'the assistant plan and opening its preview submit no work');
 await ready('!rangeRunSubmit.disabled','tail chain references finish review');
 evaluate('rangeRunSubmit.click()');
 await ready('rangePriorVideo.job','the prior missing video is submitted first',1000);
 assert.equal(scenarioState.submittedBatches.length,newChainStart+1);
 scenarioState.finishBatch(newChainStart,1);
 await ready('rangeFollowingFrame.job','a new tail is connected before submitting the following frame',1000);
 assert.equal(batchTailRequests[0].ref,`output:h3studio/layout-job-${newChainStart}-0.mp4`);
 equal(evaluate('[originalRangeTail().ref,originalRangeTail().prompt_slot,rangeFollowingFrame.data.prompt.startsWith(rangeFramePrompt)]'),
  ['input:h3studio/range-tail-1.png',3,true]);
 assert.match(evaluate('rangeFollowingFrame.data.prompt'),/参考上一镜尾帧 @图\{3\}/);
 assert.deepEqual(scenarioState.submittedBatches[newChainStart+1].req.images.map(input=>input.prompt_slot),[2,3]);
 scenarioState.finishBatch(newChainStart+1,1);
 await ready('rangeFollowingVideo.job','the new video waits for its new frame',1000);
 scenarioState.finishBatch(newChainStart+2,1);
 await ready('!groupRun.active','the new chain completes',1000);
 equal(evaluate('groupRun.steps.map(step=>step.status)'),['done','done','done']);
 const rangeBatchStart=scenarioState.submittedBatches.length;
 evaluate(`openScriptShotRangeRun(runRangeScript,1,2,"all");
  const oldRangeTailRef=originalRangeTail().ref, oldRangeTailSlot=originalRangeTail().prompt_slot;`);
 assert.match(evaluate('$("#groupRunConfirm [data-summary]").textContent'),/第 3 镜会沿用已固定的尾帧/);
 assert.equal(evaluate('tailRefreshOption.checked'),false);
 evaluate('tailRefreshOption.checked=true;tailRefreshOption.dispatchEvent(new Event("change"))');
 assert.match(evaluate('$("#groupRunConfirm ol").textContent'),/上一镜尾帧 · 取本轮生成视频/);
 assert.equal(batchTailRequests.length,1,'checking the option makes no media request');
 assert.equal(scenarioState.submittedBatches.length,rangeBatchStart);
 await ready('!rangeRunSubmit.disabled','refreshed tail references finish asset review');
 evaluate('rangeRunSubmit.click()');
 await ready('groupRun.steps[0]?.status==="running" && node(groupRun.steps[0].id).job','first frame is running',1000);
 scenarioState.finishBatch(rangeBatchStart,1);
 await ready('rangePriorVideo.job','the prior video runs after its own frame',1000);
 assert.equal(batchTailRequests.length,1,'capture waits for the prior video result');
 scenarioState.finishBatch(rangeBatchStart+1,1);
 await ready('rangeFollowingFrame.job','next frame is submitted after capture',1000);
 assert.equal(batchTailRequests[1].ref,`output:h3studio/layout-job-${rangeBatchStart+1}-0.mp4`);
 assert.equal(batchTailRequests[1].position,'last');
 assert.equal(scenarioState.submittedBatches[rangeBatchStart+2].req.images.find(input=>input.prompt_slot===evaluate('oldRangeTailSlot')).ref,
  'input:h3studio/range-tail-2.png','the next frame sends the new tail at the existing prompt slot');
 equal(evaluate('[originalRangeTail().ref,originalRangeTail().prompt_slot]'),['input:h3studio/range-tail-2.png',evaluate('oldRangeTailSlot')]);
 assert.equal(evaluate('B.nodes.some(n=>n.type==="image"&&n.versions.some(v=>v.ref===oldRangeTailRef))'),true);
 scenarioState.finishBatch(rangeBatchStart+2,1);
 await ready('node(scriptShotLinks(runRangeScript)[2].vid).job','next shot video follows its new frame',1000);
 scenarioState.finishBatch(rangeBatchStart+3,1);
 await ready('!groupRun.active','tail refresh batch completes',1000);
 equal(evaluate('groupRun.steps.map(step=>step.status)'),['done','done','done','done']);
 evaluate(`openScriptShotRangeRun(runRangeScript,1,2,"all");
  tailRefreshOption.checked=true;tailRefreshOption.dispatchEvent(new Event("change"));`);
 await ready('!rangeRunSubmit.disabled','retry references finish asset review');
 evaluate('rangeRunSubmit.click()');
 await ready('groupRun.steps[0]?.status==="running" && node(groupRun.steps[0].id).job','first frame is retried',1000);
 scenarioState.finishBatch(rangeBatchStart+4,1);
 await ready('rangePriorVideo.job','the prior video is retried',1000);
 jobs.set(scenarioState.submittedBatches[rangeBatchStart+5].jobId,{state:"error",error:"模拟上一镜失败"});
 await ready('!groupRun.active','dependent shots are skipped when the prior video fails',1000);
 equal(evaluate('groupRun.steps.map(step=>step.status)'),['done','error','skipped','skipped']);
 assert.equal(batchTailRequests.length,2);
 assert.equal(scenarioState.submittedBatches.length,rangeBatchStart+6,'failure does not fall back to the old tail or submit its dependent video');
 evaluate('$("#groupRunProgress [data-dismiss]").click()');
 w.fetch=scenarioState.generationFetch;
 console.log('Storyboard batch continuity DOM passed: explicit preview, new and refreshed tail references, stable prompt slots and upstream failure isolation.');
 evaluate(`const sortShotsButton=$("#shotList [data-sort-shots]");
  const sortBeforeEdges=JSON.stringify(B.edges), sortBeforeMedia=JSON.stringify([rangePriorVideo,rangeFollowingVideo]);
  const rangeShotOrder=()=>node(runRangeScript.id).data.shots.map(shot=>shot.id);
  sortShotsButton.click();
  $('[data-shot-order="2"] [data-step="-1"]').click();`);
 equal(evaluate('rangeShotOrder()'),['range-0','range-2','range-1','range-3'],'the arrow moves the chosen shot one position');
 evaluate(`const sortRows=$$("#shotList ol li");
  const shotDrag=(type,input)=>Object.assign(new Event(type,{cancelable:true}),input);
  const shotDragData={setData(){},dropEffect:"",effectAllowed:""};
  $(".sl-sort-grip",sortRows[1]).ondragstart(shotDrag("dragstart",{dataTransfer:shotDragData}));
  sortRows[0].ondragover(shotDrag("dragover",{clientY:-1,dataTransfer:shotDragData}));`);
 assert.equal(evaluate('sortRows[0].dataset.shotDrop'),'before');
 evaluate('sortRows[0].ondrop(shotDrag("drop",{clientY:-1,dataTransfer:shotDragData}))');
 equal(evaluate('rangeShotOrder()'),['range-2','range-0','range-1','range-3'],'dragging a shot before the first row moves it across the list');
 equal(evaluate(`[JSON.stringify(B.edges)===sortBeforeEdges,JSON.stringify([rangePriorVideo,rangeFollowingVideo])===sortBeforeMedia,
  scriptShotLinks(runRangeScript)[0].vid===rangeFollowingVideo.id,madeShots(runRangeScript)[0].vid===rangeFollowingVideo.id]`),
  [true,true,true,true],'versions and pinned edges remain unchanged while subsequent tools use the new order');
 assert.match(evaluate('$("[data-script-tail-status=\'0\']",$("#shotList")).textContent'),/首镜仍引用旧的上一镜尾帧/);
 evaluate(`sortShotsButton.dispatchEvent(new KeyboardEvent("keydown",{key:"z",ctrlKey:true,bubbles:true,cancelable:true}));`);
 equal(evaluate('rangeShotOrder()'),['range-0','range-2','range-1','range-3'],'undo works with focus inside the shot list');
 equal(evaluate('$$("#shotList [data-shot-order]").length'),4,'undo refreshes the open list');
 evaluate(`sortShotsButton.dispatchEvent(new KeyboardEvent("keydown",{key:"z",ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}));`);
 equal(evaluate('rangeShotOrder()'),['range-2','range-0','range-1','range-3'],'redo restores the new ordering');
 console.log('Storyboard ordering DOM passed: arrows, drag, stable references, continuity warnings and undo/redo.');
};
