"use strict";

module.exports = async function remakeReviewAndLocalization(workspace, scenarioState) {
 const { assert, equal, evaluate, ready, w } = workspace;
 scenarioState.previousFetch = w.fetch;
 w.__memories.find(a=>a.id==='char').character_views.face='input:h3studio/headshot.png';
 scenarioState.remakeSession = null;
 let remakeSelection;
 let remakeOptions;
 let remakeMotion;
 let beforeSplit;
 let remakeBatches=0;
 const reviewedMotion='第一秒回头\n固定机位\n镜头内 1.00 秒，抬起右手';
 w.fetch=async(url,options={})=>{
  if(String(url).startsWith('/api/jobs?') && String(url).includes('playback-job')){
   Object.assign(scenarioState.remakeSession.playback,{state:'done',ref:'output:h3studio/browser-playback.mp4'});
   return {ok:true,json:async()=>({'playback-job':{state:'done'}})};
  }
  if(String(url).startsWith('/api/jobs?') && String(url).includes('tracked-shot')){
   return {ok:true,json:async()=>({'tracked-shot':{state:'running',phase:'sampling',value:2,max:4}})};
  }
  if(String(url)==='/api/cancel'){
   assert.deepEqual(JSON.parse(options.body).ids,['tracked-shot']);
   const task=scenarioState.remakeSession.shots[0].videos.find(v=>v.job==='tracked-shot');
   Object.assign(task,{state:'error',error:'已取消'});
   return {ok:true,text:async()=>'{"ok":true}'};
  }
  if(!String(url).startsWith('/api/video-remake/'))return scenarioState.previousFetch(url,options);
  const operation=options.body&&JSON.parse(options.body);
  if(operation?.action==='prepare_playback'){
   scenarioState.remakeSession={shots:[],playback:{job:'playback-job',state:'queued'}};
  }
  if(operation?.action==='analyze'){
   const frame={ref:'input:h3studio/remake-frame.png',w:640,h:480,previews:[]};
   scenarioState.remakeSession={...scenarioState.remakeSession,session_node:'pendingVideo',depth_available:true,
    motion_providers:[{id:'depth-provider',name:'测试视频服务',model:'Seedance'}],warning:'镜头已切分，视觉分析暂不可用。',
    shots:[{start:.5,end:3.5,analysis_missing:true,summary:{},frames:{first:frame,middle:structuredClone(frame)}}]};
  }
  if(operation?.action==='retry_analysis'){
   assert.equal(operation.cut_revision,0);
   scenarioState.remakeSession.warning='';
   Object.assign(scenarioState.remakeSession.shots[0],{analysis_missing:false,summary:{action:['缓慢转身'],characters:['人物 A'],shot_size:'面部特写'}});
  }
  const frame=scenarioState.remakeSession?.shots[0]?.frames.first;
  if(operation?.action==='map_person'){
   scenarioState.remakeSession.mapping={source:operation.person,asset:operation.asset,asset_name:'林森新版',shots:operation.shots};
  }
  if(operation?.action==='apply_plan'){
   assert.deepEqual(operation.shots,[0]);
   assert.equal(operation.reference,'input:h3studio/headshot.png');
   scenarioState.remakeSession.apply_plan={submitted:[],failed:[],skipped:[],needs_selection:[0],jobs:[]};
  }
  if(operation?.action==='batch_locate_people'){
   assert.deepEqual({person:operation.person,asset:operation.asset,look:operation.look,shots:operation.shots},
    {person:'人物 A',asset:'char',look:'',shots:[0]});
   frame.person_hint={source:operation.person,look:'',point:[.35,.45]};
   scenarioState.remakeSession.batch_locate_people={located:[0],skipped:[],failed:[]};
  }
  if(operation?.action==='apply_person_hint'){
   assert.equal(operation.person,'人物 A');
   scenarioState.remakeSession.shots[0].frames[operation.frame].selection={
    mask:'input:h3studio/remake-mask.png',overlay:'input:h3studio/remake-overlay.png',
   };
  }
  if(operation?.action==='select'){
   remakeSelection=operation.rect;
   scenarioState.remakeSession.shots[0].frames[operation.frame][operation.layer]={
    mask:'input:h3studio/remake-mask.png',overlay:'input:h3studio/remake-overlay.png',
   };
  }
  if(operation?.action==='capture_correction'){
   const key='correction-24';
   scenarioState.remakeSession.shots[0].frames[key]={ref:frame.ref,w:frame.w,h:frame.h,correction_tick:24,at:1,previews:[]};
   return {ok:true,json:async()=>({...structuredClone(scenarioState.remakeSession),captured_frame:key}),text:async()=>JSON.stringify({...scenarioState.remakeSession,captured_frame:key})};
  }
  if(operation?.action==='suggest_entry'){
   assert.equal(operation.person,'人物 A');
   scenarioState.remakeSession.shots[0].frames.entry={ref:frame.ref,w:640,h:480,at:.75,correction_tick:18,previews:[],
    person_hint:{source:'人物 A',look:'',point:[.35,.45]}};
   return {ok:true,text:async()=>JSON.stringify({...scenarioState.remakeSession,captured_frame:'entry'})};
  }
  if(operation?.action==='clear_protection'){
   scenarioState.remakeSession.shots[0].frames[operation.frame].protection={mask:null};
  }
  if(operation?.action==='set_absence'){
   const target=scenarioState.remakeSession.shots[0].frames[operation.frame];
   if(operation.absent)target.person_absent={source:scenarioState.remakeSession.mapping.source};
   else delete target.person_absent;
  }
  if(operation?.action==='preview'){
   remakeOptions=operation;
   const selected=scenarioState.remakeSession.shots[0].frames[operation.frame];
   selected.previews.push({
    job:'remake-'+operation.frame,state:'done',ref:'output:h3studio/remake.png',asset:{id:'char',name:'林森'},source_person:'人物 A',
    mask:selected.selection.mask,protection:selected.protection?.mask,
   });
  }
  if(operation?.action==='batch_previews'){
   assert.equal(operation.person,'人物 A');
   const target=frame.person_absent ? 'entry' : 'first';
   const view=target==='first' ? 'face' : 'main', note=target==='first' ? '保留茶杯' : '尚未提交的修改要求';
   const asset=w.__memories.find(a=>a.id==='char');
   const reference=asset.character_views[view] || asset.ref;
   assert.deepEqual(operation.shots,[{shot:0,frame:target,view,reference,note}]);
   remakeOptions={asset:operation.asset,view};
   const selected=scenarioState.remakeSession.shots[0].frames[target];
   selected.previews.push({job:'remake-'+target,state:'done',ref:'output:h3studio/remake.png',asset:{id:'char',name:'林森',view,ref:reference},
    source_person:'人物 A',mask:selected.selection.mask,protection:selected.protection?.mask,note});
   scenarioState.remakeSession.batch_previews={submitted:[0],skipped:[],failed:[]};
  }
  if(operation?.action==='approve')scenarioState.remakeSession.shots[0].frames[operation.frame].approved=operation.job;
  if(operation?.action==='clear_guide')delete scenarioState.remakeSession.shots[0].frames[operation.frame].approved;
  if(operation?.action==='analyze_motion'){
   scenarioState.remakeSession.shots[0].motion_analysis={source_person:'人物 A',camera:'固定机位',beats:[{tick:24,action:'抬起右手'}]};
  }
  if(operation?.action==='prepare_depth'){
   const shot=scenarioState.remakeSession.shots[operation.shot];
   shot.depth={job:'depth-job',state:'done',ref:'output:h3studio/shot-depth.mp4',start:shot.start,end:shot.end,w:640,h:480};
  }
  if(operation?.action==='generate_depth_video'){
   assert.equal(operation.provider,'depth-provider');
   assert.equal(operation.first_job,'remake-first');
   assert.equal(operation.motion,reviewedMotion);
   const shot=scenarioState.remakeSession.shots[operation.shot];
   (shot.videos ||= []).push({job:'depth-version',state:'done',mode:'depth',depth_ref:shot.depth.ref,
    ref:'output:h3studio/depth-version.mp4',motion:operation.motion,first_frame:shot.frames.first.previews[0].ref,
    asset:{id:'char'},source_person:'人物 A'});
  }
  if(operation?.action==='batch_videos'){
   assert.deepEqual(operation.shots,[{shot:0,first_job:'remake-first',motion:reviewedMotion}]);
   remakeMotion=operation.shots[0].motion;
   const versions=scenarioState.remakeSession.shots[0].videos ||= [];
   const task=++remakeBatches===1 ? {job:'tracked-shot',state:'running'}
    : {job:'shot-video',state:'done',ref:'output:h3studio/shot-remake.mp4'};
   versions.push({...task,first_frame:frame.previews[0].ref,motion:remakeMotion,asset:{id:'char'},source_person:'人物 A'});
   scenarioState.remakeSession.batch_videos={submitted:[0],skipped:[],failed:[]};
  }
  if(operation?.action==='localize'){
   assert.equal(operation.job,'shot-video');
   scenarioState.remakeSession.shots[0].videos.push({job:'shot-local',mode:'local',state:'done',ref:'output:h3studio/shot-local.mp4',
    asset:{id:'char'},source_person:'人物 A',first_frame:frame.previews[0].ref,
    guides:[{ref:'output:h3studio/shot-guide.png',tick:12}],w:640,h:480,duration:3});
  }
  if(['approve_video','keep'].includes(operation?.action)){
   if(operation.cut_revision!==(scenarioState.remakeSession.cut_revision||0)){
    const error={error:'剪辑点已更新，请重新打开视频重制界面'};
    return {ok:false,status:409,text:async()=>JSON.stringify(error),json:async()=>error};
   }
   const shot=scenarioState.remakeSession.shots[operation.shot];
   shot.keep_original=operation.action==='keep';
   if(!shot.keep_original)shot.adopted_video=operation.job;
  }
  if(operation?.action==='export')scenarioState.remakeSession.export={job:'export-job',state:'done',ref:'output:h3studio/assembled.mp4',
   w:640,h:480,duration:3,clips:[{ref:'output:h3studio/shot-local.mp4',in:0,out:3,frames:72}]};
  if(operation?.action==='split_shot'){
   assert.equal(operation.cut_revision,0);
   assert.equal(operation.at,1.25);
   beforeSplit=structuredClone(scenarioState.remakeSession);
   const shot=scenarioState.remakeSession.shots[0];
   const splitFrame={ref:frame.ref,w:frame.w,h:frame.h,previews:[]};
   scenarioState.remakeSession.shots=[{...shot,end:operation.at,videos:[]},
    {start:operation.at,end:shot.end,summary:{},frames:{first:splitFrame,middle:splitFrame}}];
   scenarioState.remakeSession.mapping.shots=[0,1];
   Object.assign(scenarioState.remakeSession,{cut_revision:1,can_undo_cut:true,selected_shot:1});
   scenarioState.remakeSession.export.stale=true;
  }
  if(operation?.action==='undo_cut'){
   assert.equal(operation.cut_revision,1);
   scenarioState.remakeSession={...beforeSplit,cut_revision:2,can_undo_cut:false,selected_shot:0};
  }
  if(operation?.action==='split_long_shot'){
   const shot=scenarioState.remakeSession.shots[0], span=(shot.end-shot.start)/3;
   scenarioState.remakeSession.shots=Array.from({length:3},(_,i)=>({
    ...shot,start:shot.start+i*span,end:shot.start+(i+1)*span,
    videos:[],frames:{first:{ref:frame.ref,w:frame.w,h:frame.h,previews:[]}},
   }));
   scenarioState.remakeSession.mapping.shots=[0,1,2];
   Object.assign(scenarioState.remakeSession,{cut_revision:scenarioState.remakeSession.cut_revision+1,can_undo_cut:true,selected_shot:0});
  }
  if(scenarioState.remakeSession){
   const review={adopted:0,remaining:[]};
   for (const shot of scenarioState.remakeSession.mapping?.shots || []){
    const item=scenarioState.remakeSession.shots[shot];
    if(item.videos?.some(video=>video.job===item.adopted_video))review.adopted++;
    else review.remaining.push({shot,error:'待审核，请采用视频或选择保留原镜头'});
   }
   scenarioState.remakeSession.export_review=review;
  }
  return {ok:true,json:async()=>structuredClone(scenarioState.remakeSession),text:async()=>JSON.stringify(scenarioState.remakeSession)};
 };
 evaluate('ctxMenu({target:els.get("pendingVideo"),clientX:140,clientY:120})');
 evaluate(`document.querySelector('#ctxMenu [data-a="remake"]').click()`);
 await ready('$("#videoRemake [data-analyze]")?.disabled===false','remake workspace opens from video menu');
 evaluate('$(".rm-source video").dispatchEvent(new Event("error"))');
 equal(evaluate('!$("[data-playback]").hidden && !$("[data-prepare-playback]").disabled'),true,
  'a browser decode error exposes the compatible playback action before analysis');
 evaluate('$("[data-prepare-playback]").click()');
 await ready('$("[data-task-summary]").textContent.includes("原片播放预览")','playback preview uses the task queue');
 await ready('$(".rm-source video").src.includes("browser-playback.mp4")','finished playback preview replaces the player source',350);
 evaluate('$(".rm-source video").dispatchEvent(new Event("loadedmetadata"))');
 equal(evaluate('$("[data-playback]").hidden'),true,'loading the compatible video clears the playback error');
 evaluate('$("#videoRemake [data-analyze]").click()');
 await ready('!!$("#videoRemake .rm-shots button")','analyzed shot visible');
 equal(evaluate('$("[data-analyze]").textContent==="重试视觉分析" && !$("[data-analyze]").hidden'),true,
  'missing visual analysis can be retried in the same workspace');
 evaluate('$("[data-analyze]").click()');
 await ready('$("[data-analyze]").hidden && $(".rm-summary").textContent.includes("缓慢转身")',
  'retry fills the existing shot summary and removes the retry button');
 evaluate(`const sourcePersonCheck=$("#videoRemake [data-person]");sourcePersonCheck.value="人物 A";sourcePersonCheck.dispatchEvent(new Event("change"));
   $("#videoRemake [data-map-asset]").value="char";$("#videoRemake [data-map-shots] input").checked=true;
   $("#videoRemake [data-save-mapping]").click()`);
 await ready('$("#videoRemake [data-role]").disabled && $(".rm-mapping-status").textContent.includes("人物 A → 林森")','confirmed cross-shot mapping binds role');
 equal(evaluate('$("[data-review-next]").textContent==="1 个镜头待审核" && $("[data-export]").disabled'),true,
  'an unresolved mapped shot is listed before submitting export');
 evaluate('$("[data-absence]").click()');
 await ready('$(".rm-motion-hint").textContent.includes("首次入画的位置") && !$("[data-absence]").disabled','absent first frame prompts for an entry keyframe');
 equal(evaluate('$("[data-batch-locate]").disabled'),true,'batch localization skips an absent first frame');
 evaluate('$("[data-absence]").click()');
 await ready('!$("[data-batch-locate]").disabled','cancelling absence makes the frame eligible for batching');
 evaluate('$("[data-batch-locate]").click()');
 await ready('!$(".rm-person-point").hidden && $("[data-locate-person]").textContent==="按此位置选中"','model hint is visible before selection');
 equal(evaluate('$(".rm-shots button").textContent.includes("人物位置待确认") && $("[data-batch-locate]").disabled'),true,
  'a located shot is marked for review and excluded from repeat batches');
 assert.equal(evaluate('$(".rm-mask").hidden'),true);
 evaluate('$("[data-locate-person]").click()');
 await ready('$(".rm-person-point").hidden && !$(".rm-mask").hidden','confirmed location becomes a selection');

 evaluate(`$("#videoRemake [data-mode=box]").click();
  let rmSurface=$(".rm-surface");
  rmSurface.dispatchEvent(new MouseEvent("pointerdown",{button:0,clientX:60,clientY:15}));
  rmSurface.dispatchEvent(new MouseEvent("pointerup",{button:0,clientX:180,clientY:37}));`);
 await ready('!$("[data-frame]").disabled && $(".rm-mask").hidden===false','manual selection can adjust the suggested mask');
 assert.equal(remakeSelection.length,4);
 evaluate(`let remakeLayer=$("#videoRemake [data-layer]");remakeLayer.value="protection";remakeLayer.dispatchEvent(new Event("change"));
  rmSurface.dispatchEvent(new MouseEvent("pointerdown",{button:0,clientX:80,clientY:18}));
  rmSurface.dispatchEvent(new MouseEvent("pointerup",{button:0,clientX:120,clientY:28}));`);
 await ready('!$(".rm-protection").hidden && !$(".rm-mask").hidden','foreground and replacement selections are shown separately');
 evaluate('const rmNote=$("#videoRemake .rm-note input");rmNote.value="保留茶杯";rmNote.dispatchEvent(new Event("input"));$("[data-batch-previews]").click()');
 await ready('!!$("#videoRemake .rm-output img")','role preview displays in workspace');
 equal(evaluate('$("[data-batch-previews]").disabled'),true,'a finished matching first-frame preview removes the shot from the batch');
 assert.equal(remakeOptions.asset,'char');
 assert.equal(remakeOptions.view,'face','close-up suggests an approved headshot');
 evaluate('$$(".rm-review button").find(b=>b.textContent==="采用此预览").click()');
 await ready('$$(".rm-review button").some(b=>b.textContent==="用作视频首帧")','approve exposes first-frame action');
 evaluate(`const motionField=$("#videoRemake [data-motion]");motionField.value="第一秒回头";motionField.dispatchEvent(new Event("input"));$("[data-analyze-motion]").click()`);
 await ready('!!$("[data-motion-beats] button") && !$("[data-use-motion]").disabled','motion analysis exposes an actionable sampled timeline');
 equal(evaluate('motionField.value'),'第一秒回头','analysis does not change the edited draft');
 evaluate('$("[data-motion-beats] button").click()');
 equal(evaluate('$("#videoRemake .rm-source video").currentTime'),1.5,'motion time seeks relative to the current shot');
 evaluate('$("[data-use-motion]").click();$("[data-use-motion]").click()');
 equal(evaluate('motionField.value'),reviewedMotion,'applying motion notes preserves existing text and skips duplicate lines');
 evaluate('$("[data-prepare-depth]").click()');
 await ready('!$("[data-depth-player]").hidden && !$("[data-download-depth]").hidden','depth output can be played and downloaded');
 equal(evaluate('$("[data-depth-player]").getAttribute("src")'),'/media?ref=output%3Ah3studio%2Fshot-depth.mp4','preview pins the selected shot’s depth guide');
 evaluate('$("[data-insert-depth]").click()');
 equal(evaluate('B.nodes.at(-1).versions[0].remake.kind'),'depth','inserting depth creates a guide instead of an approved video');
 equal(evaluate('B.edges.find(e=>e.to===B.nodes.at(-1).id).from'),'pendingVideo','depth remains connected to the source');
 await evaluate('openVideoRemake(node("pendingVideo"))');
 await ready('!$("[data-depth-player]").hidden','depth result survives reopening the workspace');
 evaluate('$("[data-insert-depth]").click()');
 equal(evaluate('B.nodes.filter(n=>n.versions.some(v=>v.remake?.kind==="depth")).length'),1,'reinserting the same depth guide selects the existing node');
 await evaluate('openVideoRemake(node("pendingVideo"))');
 await ready('!$("[data-batch-videos]").disabled','first-frame review remains available after generating depth');
 evaluate('rmSurface=$(".rm-surface");remakeLayer=$("#videoRemake [data-layer]")');
 equal(evaluate('$("[data-depth-provider]").value'),'depth-provider','depth offers only available generation services');
 evaluate('$("[data-generate-depth-video]").click()');
 await ready('$("#videoRemake [data-result]").getAttribute("src")?.includes("depth-version.mp4")','depth-guided video joins the usual review list');
 assert.match(evaluate('$(".rm-video-review select").selectedOptions[0].textContent'),/深度参考重制/);
 assert.equal(evaluate('$("[data-batch-videos]").disabled'),false,'regular generation remains available after a depth-guided result');
 evaluate('$("[data-batch-videos]").click()');
 await ready('$("[data-task-summary]").textContent.includes("50%") && $("[data-task-list] progress")?.value===50',
  'remake header reflects the engine’s actual progress',350);
 evaluate('$("[data-task-list] button").click()');
 await ready('$(".rm-tasks").hidden && $(".rm-video-status").textContent==="已取消" && !$("[data-batch-videos]").disabled',
  'cancelling an active shot updates its version and enables retry');
 evaluate('$("[data-batch-videos]").click()');
 await ready('!!$("#videoRemake [data-result]").getAttribute("src")','remade video can be reviewed in workspace');
 assert.equal(remakeMotion,reviewedMotion);
 equal(evaluate('$("[data-batch-videos]").disabled'),true,'completed recipe is skipped by the video batch');
 evaluate(`const comparedSource=$("#videoRemake .rm-source video"), comparedResult=$("#videoRemake [data-result]");
  for(const media of [comparedSource, comparedResult]) {
   let paused=true;
   Object.defineProperty(media,"paused",{get:()=>paused});
   media.play=()=>{paused=false;return Promise.resolve()};
   media.pause=()=>{paused=true};
  }
  $("#videoRemake [data-compare]").click();`);
 equal(evaluate('[comparedSource.currentTime, comparedSource.muted, comparedResult.muted]'),[.5,false,true],'compare begins at shot start and uses only the original soundtrack');
 evaluate('comparedResult.currentTime=1.25;comparedResult.dispatchEvent(new Event("seeking"));comparedResult.dispatchEvent(new Event("seeked"))');
 equal(evaluate('[comparedSource.currentTime, comparedSource.paused]'),[1.75,false],'seeking the remake seeks the corresponding original timestamp');
 evaluate('comparedResult.currentTime=3;comparedResult.dispatchEvent(new Event("timeupdate"))');
 equal(evaluate('[comparedSource.paused,comparedResult.paused]'),[true,true],'comparison stops at the original cut');
 evaluate('$("#videoRemake video").currentTime=1;$("#videoRemake [data-capture-correction]").click()');
 await ready('$("#videoRemake [data-frame]").value==="correction-24" && !$("#videoRemake .rm-role").hidden','correction frame offers role preview generation');
 evaluate('remakeLayer.value="selection";remakeLayer.dispatchEvent(new Event("change"));$("[data-absence]").click()');
 await ready('$(".rm-selection-status").textContent.includes("从此帧保留原片") && !$("[data-absence]").disabled','absence starts preserving original frames');
 evaluate('$("[data-absence]").click()');
 await ready('$("[data-absence]").textContent==="标记人物从此帧出画" && !$("[data-absence]").disabled','absence can be undone without deleting the correction frame');
 evaluate('remakeLayer.value="protection";remakeLayer.dispatchEvent(new Event("change"))');
 evaluate('$("#videoRemake [data-clear-protection]").click()');
 await ready('$(".rm-selection-status").textContent.includes("从此帧停止保护")','stop marker can terminate foreground tracking on correction frame');
 evaluate('remakeLayer.value="selection";remakeLayer.dispatchEvent(new Event("change"))');
 evaluate(`rmSurface.dispatchEvent(new MouseEvent("pointerdown",{button:0,clientX:80,clientY:15}));
  rmSurface.dispatchEvent(new MouseEvent("pointerup",{button:0,clientX:200,clientY:37}));`);
 await ready('!$(".rm-mask").hidden && $$(".rm-video-review button").some(b=>!b.disabled && b.textContent.includes("1 张校正帧"))','correction counted by local render control');
 evaluate('$("#videoRemake [data-generate]").click()');
 await ready('$$(".rm-review button").some(b=>!b.disabled && b.textContent==="用作动作关键帧")','correction preview can be reviewed as a timed guide');
 evaluate('$$(".rm-review button").find(b=>b.textContent==="用作动作关键帧").click()');
 await ready('$(".rm-motion-hint").textContent.includes("1 张动作关键帧") && !$("#videoRemake [data-generate-video]").disabled','guide and first frame remain adopted together');
 evaluate('$$(".rm-review button").find(b=>b.textContent==="取消动作关键帧").click()');
 await ready('!$(".rm-motion-hint").textContent.includes("1 张动作关键帧") && !$("#videoRemake [data-generate-video]").disabled','guide removal preserves the adopted first frame');
 evaluate('$$(".rm-video-review button").find(b=>b.textContent.startsWith("跟踪人物并局部合成")).click()');
 await ready('$("#videoRemake [data-result]").getAttribute("src")?.includes("shot-local.mp4")','local result is selectable alongside original generation');
 evaluate('$$(".rm-video-review button").find(b=>b.textContent==="采用此视频").click()');
 await ready('!$("[data-export]").disabled && $("[data-review-next]").hidden','review unlocks export');
 evaluate('$("#videoRemake [data-export]").click()');
 await ready('$("#videoRemake [data-download]").hidden===false','finished export can be downloaded');
 equal(evaluate('$("#videoRemake [data-download]").download'),'assembled.mp4','export download uses assembled file');
 evaluate('$("[data-close]").click()');
 Object.assign(scenarioState.remakeSession.export,{state:'error',ref:null,error:'成片文件暂不可用，请重新合成'});
 await evaluate('openVideoRemake(node("pendingVideo"))');
 equal(evaluate('$("[data-download]").hidden && $("[data-watch]").hidden && $("[data-insert-export]").hidden'),true,
  'an unavailable export cannot be downloaded, watched, or placed on the canvas');
 equal(evaluate('$("[data-export]").textContent==="重新合成" && !$("[data-export]").disabled'),true,
  'the reviewed shots can be exported again');
 evaluate('$("[data-export]").click()');
 await ready('!$("[data-download]").hidden','a replacement export restores the download');
 evaluate(`$(".rm-cuts").open=true;const reopenedSource=$("#videoRemake .rm-source video");
  reopenedSource.currentTime=1.25;reopenedSource.dispatchEvent(new Event("timeupdate"));
  $("[data-cut=split_shot]").click();`);
 await ready('$$(".rm-shots button").length===2 && $(".rm-shot").textContent==="镜头 2" && $("[data-download]").hidden','split updates the active shot and hides the stale export');
 equal(evaluate('$("[data-review-next]").textContent==="2 个镜头待审核" && $("[data-export]").disabled'),true,
  'editing the cut exposes both unresolved shots and disables export');
 evaluate('$("[data-review-next]").click()');
 equal(evaluate('$(".rm-shot").textContent'),'镜头 1','the review shortcut takes the user to the next unresolved shot');
 evaluate('$("[data-cut=undo_cut]").click()');
 await ready('$$(".rm-shots button").length===1 && $(".rm-shot").textContent==="镜头 1"','undo restores the earlier shot');
 evaluate('$("#videoRemake [data-send-film]").click()');
 equal(evaluate('FILM.spec.clips.map(c=>[c.name,c.ref,c.in,c.out,c.audio_start])'),
  [['镜头 1','output:h3studio/shot-local.mp4',0,3,.5]],'editable handoff pins the approved clip and its original audio location');
 evaluate('FILM.spec.clips[0].subs=["剪辑草稿字幕"];FILM.pendingOffset=1.25;$("#fmV").pause=$("#fmOriginal").pause=()=>{};closeFilm();resumeFilmDraft()');
 equal(evaluate('[FILM.spec.clips[0].subs,FILM.pendingOffset]'),[['剪辑草稿字幕'],1.25],'closing and resuming restores edits and playhead');
 evaluate('$("#fmV").pause=$("#fmOriginal").pause=()=>{}; closeFilm(); selectOnly("pendingVideo"); $("#shotListBtn").click()');
 await ready('$("#shotList li")?.textContent.includes("已采用")','shot list shows the reviewed version');
 equal(evaluate(`filmTotal({clips:[
  {in:0,out:.125,remake_shot:{},trans:"fade"},
  {in:0,out:.125,remake_shot:{},trans:"cut"}
 ]})`),5/24,'short clips cap the fade to half the shorter clip in frames');
 evaluate(`const mixedRef=curV(node("n1")).ref;
   sel=new Set(["n1","pendingVideo"]);updateSel();
   ctxMenu({target:els.get("n1"),clientX:80,clientY:100});
   $("#ctxMenu [data-a=concat]").click();`);
 equal(evaluate('FILM.spec.clips.map(c=>c.kind)'),['image','video'],'images and videos share a timeline');
 equal(evaluate('[$("#fmStill").hidden, $("#fmV").hidden, $("#fmTl .fc img").src.includes(encodeURIComponent(mixedRef))]'),[false,true,true],'still shows in the viewer and timeline');
 evaluate('const stillDuration=$("#fmClip .still-duration input");stillDuration.value=".8";stillDuration.dispatchEvent(new Event("change"))');
 equal(evaluate('FILM.spec.clips[0].duration'),.8,'still duration is editable');
 evaluate('$("#fmStillSeek").value=".5";$("#fmStillSeek").dispatchEvent(new Event("input"));closeFilm();resumeFilmDraft()');
 equal(evaluate('[FILM.spec.clips[0].ref,FILM.spec.clips[0].duration,FILM.still.offset]'),[evaluate('mixedRef'),.8,.5],'draft restores still version and playhead');
 evaluate('$("#fmAll").click();FILM.still.started=performance.now()-1000;previewTick()');
 equal(evaluate('[FILM.sel,$("#fmStill").hidden,$("#fmV").hidden]'),[1,true,false],'continuous preview advances from still to video');
 evaluate('$("#fmTl .fadd").click();$("#fmAdd [data-id=n1]").click()');
 equal(evaluate('FILM.spec.clips.map(c=>c.kind)'),['image','video','image'],'add-media menu can append an image');
 evaluate(`$("#fmTime").value=".25";$("#fmTime").dispatchEvent(new Event("input"));const originalPickAudio=pickAudio;
  pickAudio=callback=>callback(new File(["audio"],"fx.wav",{type:"audio/wav"}));
  $("#fmSet [data-b=audio]").click();`);
 await ready('FILM.spec.audio_clips?.length===1 && !$("#fmAudioLanes").hidden','upload timed audio and display a lane');
 equal(evaluate('FILM.spec.audio_clips[0].start'),.25,'upload uses the actual playhead');
 evaluate(`pickAudio=originalPickAudio;
  const setAudio=(key,value)=>{const input=$("#fmAudioSettings [data-audio-key="+key+"]");input.value=value;input.dispatchEvent(new Event("change"));};
  setAudio("start",.4);setAudio("in",.2);setAudio("out",.6);setAudio("volume",.5);
  closeFilm();resumeFilmDraft();`);
 equal(evaluate('(()=>{const {start,in:i,out,volume}=FILM.spec.audio_clips[0];return [start,i,out,volume];})()'),
  [.4,.2,.6,.5],'source trims, gain and timeline position persist');
 evaluate(`const originalAudio=window.Audio;
  window.Audio=function(url){Object.assign(this,{url,paused:true,currentTime:0,play(){this.paused=false;return Promise.resolve();},pause(){this.paused=true;}});};
  $("#fmAudioLanes button").click();$("#fmStillPlay").click();FILM.still.offset=.55;previewTick();`);
 equal(evaluate('(()=>{const a=[...FILM.audioPlayers.values()][0].media;return [Math.round(a.currentTime*100),a.volume,a.paused];})()'),
  [35,.5,false],'preview seeks to the trimmed source time and applies its gain');
 evaluate('FILM.still.offset=.85;previewTick();window.Audio=originalAudio');
 equal(evaluate('FILM.audioPlayers.size'),0,'preview pauses when the audio fragment ends');
 evaluate('closeFilm()');
 evaluate('$("#shotList li button").click()');
 await ready('$("#videoRemake .rm-shot")?.textContent==="镜头 1"','shot list locates the original remake shot');
 evaluate('$("#shotList [data-close]").click()');
 evaluate(`const planHost=document.createElement("div");$("#acMessages").append(planHost);
  planHost.innerHTML=acResultCards({remake:{node_id:"pendingVideo",source_ref:curV(node("pendingVideo")).ref},
   remake_plan:{board:boardId,cut_revision:2,asset:"char",asset_name:"林森",person:"人物 A",
   reference:"input:h3studio/headshot.png",look:"",shots:[{shot:1,selection_ready:false},{shot:2,selection_ready:true}]}});
  const planChecks=$$("input",planHost);planChecks[1].checked=false;
  $("[data-apply-plan]",planHost).click()`);
 await ready('$("output",planHost).textContent.includes("请确认镜头 1")','plan submits only the checked shot and flags manual selection');
 evaluate('planHost.remove()');
 evaluate(`const rmFrameSelect=$("#videoRemake [data-frame]");rmFrameSelect.value="first";rmFrameSelect.dispatchEvent(new Event("change"))`);
};
