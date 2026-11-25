"use strict";

module.exports = async function shotRunAndContinuity(workspace, scenarioState) {
 const { assert, equal, evaluate, jobs, ready, w } = workspace;
 const storyCaptureFetch=w.fetch, storyTailRequests=[];
 let releaseOlderTail;
 w.fetch=async(url,options)=>{
  if(String(url)!=='/api/lastframe')return storyCaptureFetch(url,options);
  storyTailRequests.push(JSON.parse(options.body));
  if(storyTailRequests.length===2)await new Promise(resolve=>{releaseOlderTail=resolve;});
  const ref='input:h3studio/story-tail-'+storyTailRequests.length+'.png';
  return {ok:true,text:async()=>JSON.stringify({ref,url:'/media?ref='+encodeURIComponent(ref),w:64,h:64,at:4.9})};
 };
 await evaluate(`legacyStoryVideo.versions=["older","newer"].map(label=>({ref:"input:h3studio/"+label+".mp4",
  url:"/media?ref=input:h3studio/"+label+".mp4",w:640,h:480,seconds:5}));legacyStoryVideo.cur=0;
  const picture=node(newStoryPair.img), tailButton=$("[data-call=next-shot] [data-link-previous-shot]");
  $("#acMessages").onclick({target:tailButton});`);
 const tailEdge=evaluate('B.edges.find(edge=>edge.to===picture.id&&edge.story_continuity)');
 assert.match(evaluate('picture.data.prompt'),/@图\{1\}/);
 equal(evaluate('curV(node(B.edges.find(edge=>edge.to===picture.id&&edge.story_continuity).from)).capture.source_ref'),
  'input:h3studio/older.mp4','the tail capture records the precise prior video version');
 const tailBadge=`$('[data-script-tail-status="1"]',els.get(storyNode.id))`;
 assert.match(evaluate(tailBadge+'.textContent'),/已对齐 · 上一镜版本 1/);
 await evaluate('linkPreviousShotFrame(storyNode,1)');
 assert.equal(storyTailRequests.length,1,'repeat clicks reuse the exact existing tail frame');
 const staleTail=evaluate('legacyStoryVideo.cur=1;drawEdges();linkPreviousShotFrame(storyNode,1)');
 assert.match(evaluate(tailBadge+'.textContent'),/不一致/);
 evaluate('legacyStoryVideo.cur=0');
 releaseOlderTail();
 await staleTail;
 assert.equal(evaluate('B.nodes.length'),evaluate('storyBefore+3'),'switching versions during capture leaves the graph intact');
 await evaluate('legacyStoryVideo.cur=1;linkPreviousShotFrame(storyNode,1)');
 const updatedTail=evaluate('B.edges.find(edge=>edge.to===picture.id&&edge.story_continuity)');
 assert.equal(updatedTail.prompt_slot,1,'renewing the tail retains its prompt index');
 assert.notEqual(updatedTail.ref,'input:h3studio/story-tail-1.png');
 assert.equal(tailEdge.prompt_slot,1);
 evaluate(`picture.versions=[{...rerunMedia("story-result"),generation_record:{inputs:[{ref:"input:h3studio/story-tail-1.png"}]}}];picture.cur=0;drawEdges();`);
 assert.match(evaluate(tailBadge+'.textContent'),/当前分镜图尚未使用/);
 evaluate(`curV(picture).generation_record.inputs[0].ref=B.edges.find(edge=>edge.to===picture.id&&edge.story_continuity).ref;drawEdges();`);
 assert.match(evaluate(tailBadge+'.textContent'),/已对齐 · 上一镜版本 2/);
 evaluate(`newestStoryVideo.versions=[{ref:"output:h3studio/shot-two.mp4",url:"/media?ref=output:h3studio/shot-two.mp4",seconds:5,w:640,h:480}];
  newestStoryVideo.cur=0;
  const comparisonBoardSnapshot=JSON.stringify([B.nodes,B.edges]);
  $("[data-script-review='1']",els.get(storyNode.id)).click();
  const compare=$('#shotContinuityReview');
  const compareSources=()=>$$("img",compare).map(img=>new URL(img.getAttribute("src"),location.href));
  const leftCompare=$("[data-left-frame] select",compare),rightCompare=$("[data-right-frame] select",compare);`);
 equal(evaluate('[compare.open,...compareSources().map(url=>url.searchParams.get("position"))]'),
  [true,"last","first"],'shot review compares the actual final and first frames by default');
 evaluate(`leftCompare.value="0";leftCompare.dispatchEvent(new Event("change"));
  rightCompare.value="1";rightCompare.dispatchEvent(new Event("change"));`);
 equal(evaluate(`[...compareSources().map(url=>[url.pathname,url.searchParams.get("ref")]),
  JSON.stringify([B.nodes,B.edges])===comparisonBoardSnapshot]`),[
  ["/api/video/frame-preview","input:h3studio/older.mp4"],["/media","output:h3studio/story-result.png"],true],
  'selecting alternate review versions only changes the dialog');
 evaluate('closeShotContinuityReview()');
 evaluate(`acAppendEvent({kind:"tool_start",data:{name:"storyboard_visual_review",call_id:"visual-shot-review"}});
  acAppendEvent({kind:"tool_end",data:{name:"storyboard_visual_review",call_id:"visual-shot-review",result:{text:"核对木盒位置",shot_review:{
    board:boardId,script:storyNode.id,shot:2,
    left:{node:legacyStoryVideo.id,version:1,ref:legacyStoryVideo.versions[0].ref,kind:"video"},
    right:{node:picture.id,version:1,ref:curV(picture).ref,kind:"image"}}}}});
  $("[data-call=visual-shot-review] [data-shot-review]").click();`);
 equal(evaluate(`[compare.open,leftCompare.value,rightCompare.value,legacyStoryVideo.cur,newestStoryVideo.cur]`),
  [true,"0","1",1,0],'assistant review reopens the precise old tail and still without switching canvas versions');
 evaluate('closeShotContinuityReview()');
 evaluate(`openShotContinuityReview(storyNode,1,{
   left:{node:legacyStoryVideo.id,version:1,ref:legacyStoryVideo.versions[0].ref},
   right:{node:newestStoryVideo.id,version:1,ref:curV(newestStoryVideo).ref},
   samples:{left:[{position:"time",at:2.4,seconds:2.38},{position:"last",seconds:2.8}],
     right:[{position:"first",seconds:0},{position:"time",at:.4,seconds:.4}]}});
  const motionButtons=$$("[data-left-frame] [data-samples] button",compare);
  motionButtons[0].click();`);
 equal(evaluate(`[motionButtons[0].textContent,motionButtons[0].getAttribute("aria-pressed"),
   compareSources()[0].searchParams.get("position"),compareSources()[0].searchParams.get("at"),
   compareSources()[0].searchParams.get("ref"),legacyStoryVideo.cur]`),
   ["2.38s","true","time","2.4","input:h3studio/older.mp4",1],
   'motion review selects the analyzed timestamp on its pinned historical video');
 evaluate('leftCompare.value="1";leftCompare.dispatchEvent(new Event("change"))');
 assert.equal(evaluate('$("[data-left-frame] [data-samples]",compare).hidden'),true);
 const shotReviewTestFetch=w.fetch, shotReviewRequests=[];
 w.fetch=(url,options)=>{
  if(String(url)==='/api/chat/sessions/shot-review-ui/messages'){
   shotReviewRequests.push(JSON.parse(options.body));
   const failed=shotReviewRequests.length===1;
   return Promise.resolve({ok:!failed,json:async()=>failed?{error:'请重试'}:{id:'review-queued',state:'queued'}});
  }
  return shotReviewTestFetch(url,options);
 };
 evaluate(`const savedReviewAssistant={open:acOpen,poll:acPoll,session:AC.session,draft:$("#acInput").value};
  acOpen=async()=>{};acPoll=async()=>{};AC.session="shot-review-ui";$("#acInput").value="未发送的草稿";
  leftCompare.value="0";leftCompare.dispatchEvent(new Event("change"));
  const requestMotion=$("[data-request-review]",compare);`);
 await evaluate('requestMotion.onclick()');
 assert.match(evaluate('$("footer [role=status]",compare).textContent'),/请重试/);
 await evaluate('requestMotion.onclick()');
 assert.equal(shotReviewRequests.length,2);
 assert.equal(shotReviewRequests[0].request_key,shotReviewRequests[1].request_key);
 equal(shotReviewRequests[1].shot_review,{node_id:evaluate('storyNode.id'),shot:2,current_type:"video",
  left:{node:evaluate('legacyStoryVideo.id'),ref:"input:h3studio/older.mp4",version:1},
  right:{node:evaluate('newestStoryVideo.id'),ref:"output:h3studio/shot-two.mp4",version:1}},'direct review sends the chosen historical version and current video');
 equal(evaluate('[compare.open,$("#acInput").value,legacyStoryVideo.cur]'),[false,"未发送的草稿",1]);
 evaluate('const reviewRevisionRequest=$("[data-call=visual-shot-review] [data-plan-review-revision]")');
 await evaluate('$("#acMessages").onclick({target:reviewRevisionRequest})');
 assert.equal(shotReviewRequests[2].review_revision_call,'visual-shot-review');
 equal(evaluate('[reviewRevisionRequest.disabled,$("#acInput").value,JSON.stringify([B.nodes,B.edges])===comparisonBoardSnapshot]'),
  [true,"未发送的草稿",true],'requesting a revision uses the review card and preserves the existing draft and board');
 evaluate(`acOpen=savedReviewAssistant.open;acPoll=savedReviewAssistant.poll;AC.session=savedReviewAssistant.session;
   $("#acInput").value=savedReviewAssistant.draft;`);
 w.fetch=shotReviewTestFetch;
 evaluate(`const savedRangeShots=storyNode.data.shots.slice(), savedRangeLinks=storyNode.data.made.slice();
  const savedLatestFilm=localStorage.getItem(filmDraftPrefix()+"latest"), savedRangeSelection=new Set(sel);
  storyNode.data.shots.push({...storyLast,id:"range-missing"},{...storyLast,id:"range-fourth"});
  storyNode.data.made.push({shot_id:"range-fourth",vid:legacyStoryVideo.id});
  selectOnly(storyNode.id);$("#shotListBtn").click();
  const shotTimeline=$("#shotList"), rangeFrom=$("[data-film-from]",shotTimeline), rangeTo=$("[data-film-to]",shotTimeline);
  const sendRange=$("[data-film]",shotTimeline);`);
 equal(evaluate(`[[...rangeFrom.options].map(option=>option.disabled),[...rangeTo.options].map(option=>option.textContent),
   $$("[data-clip-range]",shotTimeline).length,sendRange.disabled]`),[[false,false,true,false],["镜头 1","镜头 2"],2,false],
  'completed consecutive shots can be cut before a later shot has generated');
 evaluate(`const savedWizard=W;
  W={step:5,script:storyNode.id};
  const unrelatedFilm={id:"unrelated-film",type:"video",data:{film:{clips:[{node:"other-video"}]}},versions:[],cur:-1};
  B.nodes.push(unrelatedFilm);`);
 assert.match(evaluate('stepFilm()'),/镜头 3 还缺少视频/);
 assert.equal(evaluate(`stepFilm().includes('data-go="quick"')`),false);
 await evaluate('wizGo("quick")');
 assert.equal(evaluate('FILM'),null,'the wizard cannot submit a partial storyboard from a stale button');
 evaluate(`sendRange.click();const firstRangeDraft=FILM.key;
  FILM.spec.clips[0].volume=.3;closeFilm();`);
 equal(evaluate('JSON.parse(localStorage.getItem(firstRangeDraft)).spec.clips.map(clip=>[clip.node,clip.ref])'),[
  [evaluate('legacyStoryVideo.id'),evaluate('legacyStoryVideo.versions[1].ref')],
  [evaluate('newestStoryVideo.id'),'output:h3studio/shot-two.mp4']],'the selected range enters the timeline in storyboard order with pinned references');
 evaluate('legacyStoryVideo.cur=0;sendRange.click();const secondRangeDraft=FILM.key');
 equal(evaluate('[firstRangeDraft!==secondRangeDraft,FILM.spec.clips[0].ref,FILM.spec.clips[0].volume]'),
  [true,"input:h3studio/older.mp4",1],'a new version opens its own timeline draft instead of reusing the old cut');
 evaluate(`closeFilm();legacyStoryVideo.cur=1;sendRange.click();`);
 equal(evaluate('[FILM.key===firstRangeDraft,FILM.spec.clips[0].volume]'),[true,.3],'returning to the same versions restores the edited range draft');
 evaluate(`const clipForSwap=FILM.spec.clips[0], canvasTakeBeforeSwap=legacyStoryVideo.cur;
  Object.assign(clipForSwap,{in:1,out:4,speed:2,trans:"fade",subs:["手写字幕"],captions:[{start:1.2,end:2.2,text:"原字幕"}]});
  legacyStoryVideo.versions[0].seconds=8;
  legacyStoryVideo.versions.push({ref:"input:h3studio/too-short.mp4",seconds:.8});
  $("#fmV").onloadedmetadata?.();$('[data-update-version]',$('#fmClip')).click();
  const swapForm=$('.fm-version-picker'), swapPicker=$("select",swapForm), swapApply=$("button",swapForm);
  swapPicker.value="1";swapPicker.dispatchEvent(new Event("change"));`);
 equal(evaluate('[swapApply.disabled,clipForSwap.ref]'),[true,'input:h3studio/newer.mp4'],'a version that ends before the cut cannot replace the source');
 evaluate('legacyStoryVideo.versions[2].seconds=3;swapPicker.dispatchEvent(new Event("change"))');
 assert.match(evaluate('$(`[role=status]`,swapForm).textContent'),/缩短 0.50 秒/);
 evaluate(`swapPicker.value="0";swapPicker.dispatchEvent(new Event("change"));
  $("[data-keep-captions]",swapForm).checked=true;
  swapForm.dispatchEvent(new Event("submit",{cancelable:true}));`);
 equal(evaluate(`[clipForSwap.ref,clipForSwap.in,clipForSwap.out,clipForSwap.speed,clipForSwap.trans,clipForSwap.volume,
  clipForSwap.subs,clipForSwap.captions[0].text,legacyStoryVideo.cur===canvasTakeBeforeSwap]`),
  ['input:h3studio/older.mp4',1,4,2,'fade',.3,['手写字幕'],'原字幕',true],
  'applying a historical version keeps the edited range and the selected subtitles without switching the canvas version');
 evaluate('legacyStoryVideo.versions.pop();legacyStoryVideo.versions[0].seconds=5');
 evaluate(`closeFilm();rangeFrom.value="range-fourth";rangeFrom.dispatchEvent(new Event("change"));`);
 equal(evaluate('[...rangeTo.options].map(option=>option.textContent)'),['镜头 4'],'choosing a later shot starts its own contiguous interval');
 evaluate(`$("#shotList [data-close]").click();storyNode.data.shots=savedRangeShots;storyNode.data.made=savedRangeLinks;
  for(const key of [firstRangeDraft,secondRangeDraft])localStorage.removeItem(key);
  openStoryFilm(storyNode);const fullStoryDraft=FILM.key;
  Object.assign(FILM.spec.clips[0],{in:1,out:4,trans:"black",volume:.4,speed:1.5,subs:["保留的字幕"],
    captions:[{start:1.1,end:1.8,text:"校正的字幕"}]});
  Object.assign(FILM.spec.clips[1],{in:2,out:4});
  FILM.spec.clips.push({...newFilmClip(legacyStoryVideo),name:"手动补画面"});
  FILM.spec.aspect="9:16";FILM.spec.titles=[{text:"片头",start:0,end:1,position:"center",style:"plain"}];
  closeFilm();`);
 await evaluate('wizGo("edit")');
 equal(evaluate('[FILM.key===fullStoryDraft,FILM.spec.story_script,FILM.spec.clips[0].trans,FILM.spec.aspect,FILM.n]'),
  [true,evaluate('storyNode.id'),'black','9:16',null],'the wizard opens the same storyboard draft and keeps its adjustments');
 evaluate(`closeFilm();unrelatedFilm.data.film.story_script=storyNode.id;
  legacyStoryVideo.cur=0;
  newestStoryVideo.versions.push({ref:"output:h3studio/short-take.mp4",seconds:1.5});
  newestStoryVideo.cur=1;`);
 await evaluate('wizGo("current-cut")');
 equal(evaluate('[wizardFilm(storyNode)===unrelatedFilm,FILM.key!==fullStoryDraft,FILM.spec.clips[0].ref,FILM.n]'),
  [true,true,'input:h3studio/older.mp4',null],'a finished film can be kept while opening a cut from newly selected shot versions');
 assert.equal(evaluate('$("#fmStoryReuse").hidden'),false);
 evaluate(`const newFullStoryDraft=FILM.key, oldStoryState=localStorage.getItem(fullStoryDraft);
  $("#fmStoryReuse").click();const storyReuseDialog=$("#fmStoryDialog");
  const storyReuseSubmit=()=>$("form",storyReuseDialog).dispatchEvent(new Event("submit",{cancelable:true}));`);
 equal(evaluate('$$("li",storyReuseDialog).map(li=>li.textContent)'),[
  '镜头 1 · 1 段改用版本 1','镜头 2 · 1 段因新版本过短保留原素材'],
  'the preview identifies changed and too-short shots before applying');
 evaluate('$("[data-close]",storyReuseDialog).click()');
 equal(evaluate('[FILM.spec.aspect,FILM.spec.clips.length,storyReuseDialog.open]'),['source',2,false]);
 evaluate('$("#fmStoryReuse").click();newestStoryVideo.cur=0;storyReuseSubmit()');
 equal(evaluate('[FILM.spec.aspect,FILM.spec.clips.length]'),['source',2],'a canvas version change invalidates the preview');
 evaluate('newestStoryVideo.cur=1;$("#fmStoryReuse").click();storyReuseSubmit()');
 equal(evaluate(`[FILM.spec.aspect,FILM.spec.titles[0].text,FILM.n,$("#fmStoryReuse").hidden,
  FILM.spec.clips.map(clip=>[clip.ref,clip.in,clip.out,clip.trans,clip.speed??1,clip.volume]),
  FILM.spec.clips[0].captions[0].text, localStorage.getItem(fullStoryDraft)===oldStoryState]`),
  ['9:16','片头',null,true,[
    ['input:h3studio/older.mp4',1,4,'black',1.5,.4],
    ['output:h3studio/shot-two.mp4',2,4,'cut',1,1],
    ['input:h3studio/newer.mp4',0,null,'cut',1,1]],'校正的字幕',true],
  'the new draft preserves editing, manual duplicates, and the original draft without claiming a finished film');
 evaluate(`closeFilm();openStoryFilm(storyNode);`);
 equal(evaluate('[FILM.key===newFullStoryDraft,FILM.spec.clips.length,FILM.spec.aspect,$("#fmStoryReuse").hidden]'),
  [true,3,'9:16',true],'reopening the new versions restores the saved imported draft');
 evaluate(`closeFilm();
  newestStoryVideo.versions.push({ref:"output:h3studio/long-take.mp4",seconds:6});newestStoryVideo.cur=2;
  openStoryFilm(storyNode);const longStoryDraft=FILM.key;
  $("#fmStoryReuse").click();const priorStoryDraft=$("select",storyReuseDialog);
  priorStoryDraft.selectedIndex=[...priorStoryDraft.options].findIndex(option=>option.textContent.endsWith("V1 / V2"));
  priorStoryDraft.dispatchEvent(new Event("change"));storyReuseSubmit();`);
 equal(evaluate('FILM.spec.clips.map(clip=>clip.ref)'),[
  'input:h3studio/older.mp4','output:h3studio/long-take.mp4','input:h3studio/newer.mp4'],
  'a later version can replace a linked shot that was previously too short');
 evaluate(`closeFilm();legacyStoryVideo.cur=1;newestStoryVideo.versions.splice(1);newestStoryVideo.cur=0;
  W=savedWizard;B.nodes.splice(B.nodes.indexOf(unrelatedFilm),1);
  sel=savedRangeSelection;updateSel();
  for(const key of [fullStoryDraft,newFullStoryDraft,longStoryDraft])localStorage.removeItem(key);
  if(savedLatestFilm)localStorage.setItem(filmDraftPrefix()+"latest",savedLatestFilm);else localStorage.removeItem(filmDraftPrefix()+"latest");`);
 evaluate(`const revisionShot=storyNode.data.shots[1], revisionEdges=JSON.stringify(B.edges);
  const oldAction=newestStoryVideo.data.fields.action;
  const oldDialogue=newestStoryVideo.data.fields.dialogue;
  newestStoryVideo.data.fields.dialogue="人工调整的对白";
  const revisionPlan={board:boardId,node:storyNode.id,shot:2,shot_id:revisionShot.id,
    before:{keyframe:revisionShot.keyframe,action:revisionShot.action,dialogue:revisionShot.dialogue??null,asset_refs:revisionShot.asset_refs},
    changes:{keyframe:"木盒在左手",action:["抬起木盒"],dialogue:["方案对白"],asset_refs:[]}};
  const continuitySuffix=picture.data.prompt.slice(scriptShotSettings(storyNode,revisionShot).image.prompt.length);
  acAppendEvent({kind:"tool_start",data:{name:"storyboard_revision_plan",call_id:"revise-shot"}});
  acAppendEvent({kind:"tool_end",data:{name:"storyboard_revision_plan",call_id:"revise-shot",result:{shot_revision:revisionPlan}}});
  const revisionCard=$("[data-call=revise-shot]"), revisionApply=$("[data-apply-shot-revision]",revisionCard);
  revisionShot.keyframe="先手动改了首帧";revisionApply.click();`);
 assert.match(evaluate(`$('[role=status]',revisionCard).textContent`),/重新准备/);
 assert.match(evaluate('revisionCard.textContent'),/参考资产.*林森（正面头肩）.*清空/s);
 evaluate('revisionShot.keyframe=revisionPlan.before.keyframe;revisionApply.click()');
 equal(evaluate(`[revisionShot.keyframe,picture.data.prompt.includes("木盒在左手"),picture.data.prompt.endsWith(continuitySuffix),
   newestStoryVideo.data.fields.action,newestStoryVideo.data.fields.dialogue,curV(newestStoryVideo).node_data.fields.action===oldAction,
   JSON.stringify(B.edges)===revisionEdges,$("[data-run-shot-revision]",revisionCard).dataset.mode]`),
   ["木盒在左手",true,true,"抬起木盒","人工调整的对白",true,true,"all"],
   'confirmed shot revision updates the linked prompts while retaining manual changes, history and continuity links');
 equal(evaluate('[revisionShot.asset_refs,picture.data.prompt.includes("next-hero"),newestStoryVideo.data.fields.scene.includes("next-hero")]'),
  [[],false,false],'clearing references in the revision removes them from both linked generation nodes');
 evaluate('newestStoryVideo.data.fields.dialogue=oldDialogue;undo()');
 w.fetch=storyCaptureFetch;
 evaluate('AC.board=groupPlanBoard;undo();undo()');
 evaluate('const liveStory=node(storyNode.id);checkpoint();liveStory.data.shots.reverse();refresh(liveStory)');
 equal(evaluate('scriptShotLinks(liveStory).map(pair=>pair.vid)'),[evaluate('newStoryPair.vid'),evaluate('legacyStoryVideo.id')],
  'editing shot order keeps each generated pair attached to its own shot');
 evaluate('undo();undo()');
 assert.equal(evaluate('B.nodes.length'),evaluate('storyBefore'));
 evaluate('undo()');
 assert.equal(evaluate('node(storyNode.id).data.shots.length'),1);
 evaluate('$("#groupRunProgress [data-dismiss]").click();restore(groupRunBase);delete B.batch_layout;save()');
 assert.equal(evaluate('sessionStorage.getItem(groupRunStorageKey(boardId))'),null,'dismissing progress removes the saved receipt');
 scenarioState.groupBatchFetch = w.fetch;
 const selectionBatchStart=scenarioState.submittedBatches.length;
 let selectionAudio;
 w.fetch=async(url,options)=>{
  if(String(url)!=="/api/audio/generate")return scenarioState.groupBatchFetch(url,options);
  selectionAudio=JSON.parse(options.body);
  jobs.set("selection-audio-job",{state:"running"});
  return {ok:true,text:async()=>JSON.stringify({ids:["selection-audio-job"],recipe:selectionAudio})};
 };
 evaluate(`const selectionBatchBase=snap(), oldBatchAudio=CAPS_LIST.audio_generation;
  CAPS_LIST.audio_generation={tts:[{id:"selection-voice",name:"旁白服务",voices:[{id:"v1",name:"旁白"}]}]};
  const selectedImage=addNode("image",1100,450,{prompt:"批量首帧",count:1},{name:"选区首帧"});
  const selectedVideo=addNode("video",1600,450,{prompt:"批量镜头",count:1},{name:"选区视频"});
  const selectedAudio=addNode("audio",2100,450,{mode:"tts",prompt:"选区旁白"},{name:"选区旁白"});
  link(selectedImage,selectedVideo,true);
  sel=new Set([selectedImage.id,selectedVideo.id,selectedAudio.id]);updateSel();
  $("#selectionTools [data-action=generate]").click();`);
 equal(evaluate('[$("#groupRunConfirm select").value,$$("#groupRunConfirm li strong").map(el=>el.textContent)]'),
  ['all',['选区首帧','选区视频','选区旁白']]);
 assert.equal(scenarioState.submittedBatches.length,selectionBatchStart);
 assert.equal(selectionAudio,undefined);
 evaluate('approveWorkflow()');
 await ready('selectedImage.job&&selectedAudio.job&&!selectedVideo.job','independent image and audio submit before the dependent video',350);
 assert.equal(selectionAudio.prompt,"选区旁白");
 scenarioState.finishBatch(selectionBatchStart,1);
 await ready('selectedVideo.job&&selectedAudio.job','the dependent video starts once its image finishes without waiting for the independent audio',350);
 assert.equal(scenarioState.submittedBatches[selectionBatchStart+1].req.images[0].ref,`output:h3studio/layout-job-${selectionBatchStart}-0.png`);
 scenarioState.finishBatch(selectionBatchStart+1,1);
 jobs.set("selection-audio-job",{state:"done",outputs:[{ref:"output:h3studio/selection-voice.wav",url:"/media?ref=output:h3studio/selection-voice.wav",meta:{duration:2}}]});
 await ready('!groupRun.active','selected nodes reach a terminal state',350);
 equal(evaluate('[groupRun.name,groupRun.steps.map(step=>step.status),B.groups.length]'),
  ['选中节点',['done','done','done'],evaluate('JSON.parse(selectionBatchBase).groups.length')]);
 evaluate('$("#groupRunProgress [data-dismiss]").click();restore(selectionBatchBase);CAPS_LIST.audio_generation=oldBatchAudio;');
 console.log('Selection batch generation passed: no persistent group, parallel image and audio, pinned dependent video and completion.');
};
