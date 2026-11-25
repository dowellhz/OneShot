"use strict";

module.exports = async function storyFilmTiming(workspace) {
 const { assert, equal, evaluate } = workspace;
 evaluate(`closeImageEditor();
  const timingVideos=[6,2.25,null].map((seconds,index)=>addNode("video",1000+index*520,830,{duration:5},{
   versions:[{ref:"output:h3studio/timing-shot-"+index+".mp4",w:640,h:360,...(seconds?{seconds}:{})}],cur:0
  }));
  const timingScript=addNode("script",450,800,{shots:[3.5,4.5,3].map((duration,index)=>({
   id:"timing-shot-"+index,duration,action:["移动"],dialogue:[],shot_size:"中景",camera:"固定"
  })),made:timingVideos.map((video,index)=>({shot_id:"timing-shot-"+index,vid:video.id}))});
  openStoryFilm(timingScript,0,2,"fade");`);
 equal(evaluate('FILM.spec.clips.map(c=>[c.story_frames,c.out,c.trans,!!c.story_pending_length])'),
  [[84,3.5,'fade',false],[108,2.25,'fade',false],[72,null,'fade',true]],
  'regular storyboards use actual generated footage against planned length while keeping the chosen transitions');
 evaluate('selectClip(1);$("#fmV").onloadedmetadata?.()');
 assert.match(evaluate('$("#fmClip").textContent'),/素材时长不足，缺 2\.25 秒/);
 evaluate(`selectClip(2);
  const timingPlayer=$("#fmV");
  Object.defineProperty(timingPlayer,"duration",{value:5.2,configurable:true});
  timingPlayer.onloadedmetadata?.();
  delete timingPlayer.duration;`);
 equal(evaluate('[FILM.spec.clips[2].out,!!FILM.spec.clips[2].story_pending_length]'),[3,false],
  'previously unknown duration is measured from this clip before trimming');
 evaluate(`delete FILM.spec.clips[0].story_frames;
  Object.assign(FILM.spec.clips[0],{in:.75,out:2.5,speed:1.25});
  closeFilm();openStoryFilm(timingScript);`);
 equal(evaluate('[FILM.spec.clips[0].story_frames,FILM.spec.clips[0].in,FILM.spec.clips[0].out,FILM.spec.clips[0].speed]'),
  [84,.75,2.5,1.25],'old drafts recover the planned length without replacing manual edits');
 console.log('Story film timing passed: normal shot durations, measured sources, real shortage and saved manual cuts.');

 evaluate(`delete FILM.spec.clips[2].src_len;
  const timingReview=$("#fmTimingDialog");
  const openTiming=()=>$("#fmTiming").click();
  const applyTiming=()=>$("#fmTimingDialog form").dispatchEvent(new Event("submit",{cancelable:true}));
  openTiming();`);
 assert.match(evaluate('$("[data-timing-summary]",timingReview).textContent'),/3 段有镜长计划 · 1 段素材不足 · 1 段待核实/);
 assert.match(evaluate('$("[data-timing-list]",timingReview).textContent'),/素材缺 2\.25 秒/);
 equal(evaluate('$$("[data-timing-check]",timingReview).map(input=>input.dataset.timingCheck)'),['0'],
  'only clips with enough verified footage and mismatched timing can be selected');
 evaluate('$$("[data-timing-locate]",timingReview).find(button=>button.dataset.timingLocate==="1").click();$("#fmV").onloadedmetadata?.()');
 equal(evaluate('[timingReview.open,FILM.sel]'),[false,1],'the short shot can be located directly');
 evaluate(`openTiming();$("[data-timing-check]",timingReview).click();
  const reviewedClip=FILM.spec.clips[0];
  reviewedClip.out=2.75;applyTiming();`);
 equal(evaluate('[timingReview.open,reviewedClip.out,$("[data-timing-check]",timingReview).checked]'),[true,2.75,false],
  'a timeline change invalidates the selected proposal');
 evaluate('$("[data-timing-check]",timingReview).click();applyTiming()');
 equal(evaluate('[timingReview.open,reviewedClip.in,reviewedClip.out,reviewedClip.speed,FILM.spec.clips[1].out]'),
  [false,.75,5.125,1.25,2.25],'applying uses the selected starting point and playback rate while leaving a short clip alone');
 evaluate('FILM.spec.remake_audio=true;reviewedClip.out=2;openTiming()');
 assert.equal(evaluate('$$("[data-timing-check]",timingReview).length'),0,'synchronized originals cannot be batch-retimed');
 evaluate('closeFilmStoryTiming();delete FILM.spec.remake_audio');
 console.log('Story timing review passed: short and unknown coverage, locate, stale proposal and selective adjustment.');

 evaluate(`const shortTimelineClip=FILM.spec.clips[1], timingCandidates=timingVideos[1];
  shortTimelineClip.in=.25;
  timingCandidates.versions.push({ref:"output:h3studio/timing-alt-almost.mp4",seconds:4.5},
   {ref:"output:h3studio/timing-alt-usable.mp4",seconds:6.2},
   {ref:"output:h3studio/timing-alt-latest.mp4",seconds:7.2});
  timingCandidates.cur=1;
  openTiming();`);
 assert.match(evaluate('$("[data-timing-list]",timingReview).textContent'),/2 个备选版本原速够长/);
 evaluate('timingCandidates.versions[3].seconds=3;$("[data-timing-preview]",timingReview).click()');
 assert(evaluate('timingReview.open'),'an outdated recommendation keeps the review open');
 assert.match(evaluate('$("[data-timing-list]",timingReview).textContent'),/1 个备选版本原速够长/);
 evaluate(`$("[data-timing-preview]",timingReview).click();$("#fmV").onloadedmetadata?.();
  const recommendedPicker=$(".fm-version-picker"), recommendedPreview=$("video",recommendedPicker);
  recommendedPreview.onloadedmetadata?.();`);
 equal(evaluate('[shortTimelineClip.ref,shortTimelineClip.out,timingCandidates.cur,$("[data-fit-story]",recommendedPicker).checked,recommendedPreview.currentTime]'),
  ['output:h3studio/timing-shot-1.mp4',2.25,1,true,.25],'preview pins an eligible candidate without changing the draft or canvas');
 assert.match(evaluate('recommendedPreview.src'),/timing-alt-usable\.mp4/);
 evaluate('recommendedPicker.dispatchEvent(new Event("submit",{cancelable:true}))');
 equal(evaluate('[shortTimelineClip.ref,shortTimelineClip.in,shortTimelineClip.out,shortTimelineClip.speed,timingCandidates.cur]'),
  ['output:h3studio/timing-alt-usable.mp4',.25,4.75,1,1],'confirmed candidate fills the requested length at original speed');
 console.log('Story timing alternatives passed: available versions, stale recommendation, preview and explicit application.');

 evaluate(`const timingRetakeDraftKey=FILM.key;
  Object.assign(shortTimelineClip,{ref:timingCandidates.versions[0].ref,out:2.25,speed:1,
   story_shot:"timing-shot-1",media_seconds:2.25});
  timingCandidates.versions[2].seconds=4;
  timingCandidates.data.duration=3;timingCandidates.data.prompt="补拍动作";
  openTiming();$("[data-timing-retake]",timingReview).click();`);
 equal(evaluate('[!FILM,$("#groupRunConfirm").open,$("#groupRunConfirm [name=mode]").value,sel.has(timingCandidates.id)]'),
  [true,true,'video',true],'shortage links to the existing same-shot video plan without launching jobs');
 assert.match(evaluate('$("#groupRunConfirm [data-summary]").textContent'),/至少需要 4\.75 秒素材.*当前生成时长设为 3 秒/);
 equal(evaluate('JSON.parse(localStorage.getItem(timingRetakeDraftKey)).spec.clips[1].out'),2.25,'opening the plan preserves the existing edit');
 console.log('Story timing retake passed: matched source, required length, video-only confirmation and draft preservation.');
 assert.equal(evaluate('$("#groupRunConfirm [data-set-retake-length]").textContent'),'将视频节点设为 5 秒');
 evaluate('$("#groupRunConfirm [data-set-retake-length]").click()');
 equal(evaluate('[timingCandidates.data.duration,$("#groupRunConfirm").open,$("#groupRunConfirm [data-set-retake-length]").hidden,!!timingCandidates.job]'),
  [5,true,true,false],'the smallest eligible preset is applied without submitting the generation');
 evaluate(`const originalTimingExecution=executeCanvasGroup;
  const timingTakeRef="output:h3studio/timing-fresh-take.mp4";
  executeCanvasGroup=async run=>{
    timingCandidates.versions.push({ref:timingTakeRef,seconds:6.5,w:640,h:360});
    groupRun={...run,active:false};
    groupRunSetResult(groupRun.steps[0],{refs:[timingTakeRef],errors:[]});
    preserveCanvasGroupRun(groupRun);
  };
  $("#groupRunConfirm form").dispatchEvent(new Event("submit",{cancelable:true}));
  executeCanvasGroup=originalTimingExecution;
  restoreCanvasGroupRun();
  localStorage.setItem(filmDraftPrefix()+"latest","unrelated-draft");`);
 assert.equal(evaluate('$("#groupRunProgress [data-film-return]").hidden'),false,'the return action survives restoring the finished run');
 evaluate('$("#groupRunProgress [data-film-return]").click();$("#fmV").onloadedmetadata?.()');
 equal(evaluate('[FILM.key,FILM.sel,FILM.spec.clips[1].ref,FILM.spec.clips[1].out]'),
  [evaluate('timingRetakeDraftKey'),1,'output:h3studio/timing-shot-1.mp4',2.25],
  'returning locates the original edited clip without adopting the new take');
 assert.match(evaluate('$(".fm-version-picker video").src'),/timing-fresh-take\.mp4/);
 console.log('Story take return passed: persistent run receipt, exact draft, new-version preview and retained edit.');
 evaluate('closeFilm();openScriptShotRun(timingScript,1,{mode:"video",requiredSeconds:17})');
 assert.match(evaluate('$("#groupRunConfirm [data-summary]").textContent'),/最长 14 秒/);
 assert.equal(evaluate('$("#groupRunConfirm [data-set-retake-length]").hidden'),true,'the plan does not suggest inaccessible duration presets');
 evaluate('closeCanvasGroupRunDialog()');
 evaluate(`const newStoryboardReference=addNode("image",600,280,{},{
  name:"角色参考",versions:[copyAsset("story-first.png"),copyAsset("story-second.png")],cur:1
 });
 AC.board=boardId;
 acAppendEvent({kind:"tool_start",data:{call_id:"new-storyboard-candidate",name:"storyboard_create_plan"}});
 acAppendEvent({kind:"tool_end",data:{call_id:"new-storyboard-candidate",name:"storyboard_create_plan",
  result:{storyboard_create:{id:"n-new-storyboard-candidate",board:boardId,title:"雨夜",aspect:"9:16",style:"写实",
   story:"走出门",planned_seconds:20,characters:[],refs:[{node:newStoryboardReference.id,
    ref:newStoryboardReference.versions[0].ref,name:newStoryboardReference.name}],
   shots:[{duration:10,scene:"走廊",shot_size:"中景",action:["靠近门"],dialogue:[],keyframe:"门边",
    asset_refs:[{id:"hero-asset",name:"林森",kind:"character",view:"face"}]},
    {duration:10,scene:"街道",shot_size:"远景",action:["走出门"],dialogue:[],keyframe:"街灯"}]}}}});
 const confirmNewStoryboard=$("[data-call=new-storyboard-candidate] [data-create-storyboard]");
 const adoptNewStoryboard=()=>$("#acMessages").onclick({target:confirmNewStoryboard});`);
 assert.equal(evaluate('!!node("n-new-storyboard-candidate")'),false,'planning leaves the canvas intact');
 assert.match(evaluate('$("[data-storyboard-create]").textContent'),/林森（正面头肩）/);
 await evaluate('adoptNewStoryboard()');
 equal(evaluate(`const createdStory=node("n-new-storyboard-candidate");
  [createdStory.type,createdStory.data.aspect,createdStory.data.shots.map(s=>s.duration),scriptRefs(createdStory)[0].ref]`),
  ['script','9:16',[10,10],'output:h3studio/story-first.png'],'confirmation creates an editable script with its exact reference version');
 await evaluate('adoptNewStoryboard()');
 equal(evaluate('B.nodes.filter(n=>n.id==="n-new-storyboard-candidate").length'),1,'repeated confirmation locates the same script');
 evaluate('expandScript(createdStory)');
 equal(evaluate(`const ownedShots=scriptShotLinks(createdStory), exactAsset="@{hero-asset#face|林森}";
  [node(ownedShots[0].img).data.prompt.includes(exactAsset), node(ownedShots[0].vid).data.fields.scene.includes(exactAsset),
   node(ownedShots[1].img).data.prompt.includes(exactAsset), node(ownedShots[1].vid).data.fields.scene.includes(exactAsset)]`),
  [true,true,false,false],'only the shot using the asset sends its exact identity and view to both generation nodes');
 evaluate('undo()');
 evaluate('undo()');
 assert.equal(evaluate('!!node("n-new-storyboard-candidate")'),false,'one undo removes the script and its reference connection');
 console.log('Assistant storyboard creation passed: review, pinned assets, duplicate protection and undo.');
};
