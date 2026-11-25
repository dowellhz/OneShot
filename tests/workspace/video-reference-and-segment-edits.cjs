"use strict";

module.exports = async function videoReferenceAndSegmentEdits(workspace, scenarioState) {
 const { assert, equal, evaluate, jobs, ready, w } = workspace;
 await evaluate(`const soundNode=addNode("audio",140,140);
   uploadInto(soundNode,new File(["fixture"],"旁白.wav",{type:"audio/wav"}));`);
 equal(evaluate('[$("audio",els.get(soundNode.id)).getAttribute("src"),soundNode.name,curV(soundNode).seconds]'),
   ['/media?ref=input%3Ah3studio%2Ffx.wav','旁白',1],'upload creates a playable named audio node');
 evaluate(`CAPS_LIST.audio_reference=[{id:"fixture-ark",name:"声音参考服务",model:"doubao-seedance-2-5-fixture"}];
   const audioVideo=addNode("video",520,120,{prompt:"跟随声音节奏"});
   openAddMenu(80,90,{to:audioVideo});$("#addMenu [data-audio-menu] button").click();selectOnly(audioVideo.id);`);
 equal(evaluate('[videoReq(audioVideo,audioVideo.data.prompt).audio_refs[0].ref,audioVideo.data.provider,$("#refs [data-tok=\\\"@音1\\\"]").textContent.includes("版本 1")]'),
   ['input:h3studio/fx.wav','fixture-ark',true],'pinned audio appears as the numbered sound reference');
 evaluate(`addVersion(soundNode,{ref:"input:h3studio/other.wav",url:"/media?ref=input%3Ah3studio%2Fother.wav",seconds:3,source:"upload",prompt:""});`);
 equal(evaluate('videoReq(audioVideo,"").audio_refs[0].version'),1,'editing the source audio keeps the existing reference');
 evaluate('$("[data-audio-update]").click()');
 equal(evaluate('videoReq(audioVideo,"").audio_refs[0].version'),2,'the reference switches only on explicit adoption');
 evaluate(`selectOnly(audioVideo.id);
   for(const [point,value] of [["start",.5],["end",2.5]]){
    const input=$('[data-audio-point="'+point+'"]');input.value=value;input.dispatchEvent(new Event("change"));
   }`);
 equal(evaluate('videoReq(audioVideo,"").audio_refs.map(({start,end})=>[start,end])'),[[.5,2.5]]);
 evaluate(`openFilm([node("n1")]);const picked=$("#fmCanvasAudio");picked.value=soundNode.id;picked.dispatchEvent(new Event("change"));`);
 equal(evaluate('FILM.spec.audio_clips.map(({name,ref,node,start,out})=>[name,ref,node===soundNode.id,start,out])'),
   [['旁白','input:h3studio/other.wav',true,0,3]],'the actual audio can be placed on the editing timeline');
 evaluate('$("#fmV").pause=$("#fmOriginal").pause=()=>{};closeFilm()');
 console.log('Audio DOM passed: upload, playback, reference, version pin and adoption, plus timeline reuse.');
 evaluate(`CAPS_LIST.previs=[{id:"fixture-ark",name:"视频参考服务",model:"doubao-seedance-2-5-fixture"}];
   const clipSource=addNode("video",240,150);
   addVersion(clipSource,{ref:"input:h3studio/reference1.mp4",url:"/media?ref=input%3Ah3studio%2Freference1.mp4",seconds:12,w:720,h:1280});
   selectOnly(audioVideo.id);openAddMenu(80,90,{to:audioVideo});
   $$("#addMenu [data-video-menu] button").find(b=>b.textContent.startsWith(clipSource.name+" ")).click();
   const setClipPoint=(point,value)=>{const f=$('[data-clip-point="'+point+'"]');f.value=value;f.dispatchEvent(new Event("change"));};
   setClipPoint("start",2);setClipPoint("end",6);`);
 equal(evaluate('videoReq(audioVideo,"").video_refs.map(({ref,start,end,version})=>[ref,start,end,version])'),
   [['input:h3studio/reference1.mp4',2,6,1]],'reference stores the selected video version and trim');
 equal(evaluate('videoReq(audioVideo,"").ar'),9/16,'source display framing is inherited in auto mode');
 evaluate(`addVersion(clipSource,{ref:"input:h3studio/reference2.mp4",url:"/media?ref=input%3Ah3studio%2Freference2.mp4",seconds:8,w:720,h:1280});`);
 equal(evaluate('videoReq(audioVideo,"").video_refs[0].version'),1,'source tab changes do not alter the selected reference');
 evaluate('$("[data-video-update]").click()');
 equal(evaluate('videoReq(audioVideo,"").video_refs.map(({ref,start,end,version})=>[ref,start,end,version])'),
   [['input:h3studio/reference2.mp4',0,8,2]],'adopting a new version resets the trim');
 const ordinaryReferenceFetch=w.fetch;
 let automaticReference;
 w.fetch=async(url,options)=>{
  if(String(url)!=="/api/generate")return ordinaryReferenceFetch(url,options);
  automaticReference=JSON.parse(options.body);
  return {ok:false,text:async()=>JSON.stringify({error:"测试拦截"})};
 };
 evaluate(`CAPS_LIST.previs[0].models=[{id:"long-reference",durations:[5,15,20,30],qualities:{std:"720p",hd:"1080p","4k":"4k"}}];
   const autoService=$("#ctl [data-k=provider]");
   autoService.value="";autoService.dispatchEvent(new Event("change"));
   const autoDuration=$("#ctl [data-k=duration]");autoDuration.value="20";autoDuration.dispatchEvent(new Event("change"));
   const mixedFrameEdge={from:"n1",to:audioVideo.id,role:"first"};
   B.edges.push(mixedFrameEdge);drawEdges();showPanel();
   const mixedRole=$("#refs select[data-edge='"+B.edges.indexOf(mixedFrameEdge)+"']");
   mixedRole.value="keyframe";mixedRole.dispatchEvent(new Event("change"));
   const mixedTime=$("#refs input[data-time]");
   mixedTime.value="3.2";mixedTime.dispatchEvent(new Event("change"));`);
 await evaluate('generate(audioVideo)');
 assert(!Object.hasOwn(automaticReference,"provider"),'the canvas leaves automatic routes unpinned before the server checks every input');
 assert.equal(automaticReference.duration,20);
 assert.equal(automaticReference.audio_refs[0].start,.5);
 assert.equal(automaticReference.images[0].role,"frame");
 assert.equal(automaticReference.images[0].time,3.2);
 evaluate('renderPreviewInputs([{ref:curV(node("n1")).ref,role:"image_ref",image_role:"frame",time:3.2,prompt_reference:"@图片1"}],20)');
 assert.match(evaluate('$("#pvInputs li small").textContent'),/关键帧 · @图片1 · 3.2 秒 · 构图参考/);
 evaluate('B.edges.splice(B.edges.indexOf(mixedFrameEdge),1);drawEdges()');
 w.fetch=ordinaryReferenceFetch;
 evaluate(`audioVideo.data.provider="fixture-ark";audioVideo.data.duration=5;delete CAPS_LIST.previs[0].models;showPanel();`);
 console.log('Video reference DOM passed: attach to existing video, trim, frame ratio, version pin and explicit adoption.');
 evaluate(`openVideoExtension(clipSource);const extForm=$("#videoExtension form");
   extForm.elements.direction.value="before";extForm.elements.direction.dispatchEvent(new Event("change"));
   extForm.elements.prompt.value="站台还空着";extForm.elements.duration.value=6;
   extForm.dispatchEvent(new Event("submit",{cancelable:true}));const extensionNode=node([...sel][0]);
   const sourceAtCreation=curV(clipSource).ref;`);
 equal(evaluate(`[extensionNode.x<clipSource.x,videoReq(extensionNode,extensionNode.data.prompt).extension,
   videoReq(extensionNode,"").video_refs[0].start,videoReq(extensionNode,"").video_refs[0].end,$("[data-clip-point=start]").disabled]`),
   [true,'before',0,4,true],'a prologue uses the original opening and is placed before the original');
 evaluate(`addVersion(extensionNode,{ref:"output:h3studio/prologue.mp4",url:"/media?ref=output%3Ah3studio%2Fprologue.mp4",seconds:6,w:720,h:1280,
   video_recipe:videoReq(extensionNode,extensionNode.data.prompt)});switchVersion(clipSource,0);
   nodeAction(extensionNode,"extension-film");`);
 equal(evaluate('FILM.spec.clips.map(c=>c.ref)'),['output:h3studio/prologue.mp4',evaluate('sourceAtCreation')],
   'the timeline opens the prologue before the exact original version');
 evaluate('$("#fmV").pause=$("#fmOriginal").pause=()=>{};closeFilm();openVideoExtension(clipSource);$("#videoExtension form").dispatchEvent(new Event("submit",{cancelable:true}));const nextScene=node([...sel][0]);');
 equal(evaluate('[nextScene.x>clipSource.x,videoReq(nextScene,"").extension,videoReq(nextScene,"").video_refs[0].start,videoReq(nextScene,"").video_refs[0].end]'),
   [true,'after',8,12],'the sequel uses the tail boundary and is placed after the original');
 evaluate(`const tailAnchor=addNode("image",600,500,{}, {name:"本地续拍接点",versions:[
   {ref:"output:h3studio/local-tail.png",capture:{source_node:clipSource.id,source_ref:sourceAtCreation,position:"last"}},
   {ref:"output:h3studio/local-older-anchor.png",capture:{source_node:clipSource.id,source_ref:curV(clipSource).ref,position:"last"}}],cur:1});
   const localTail=addNode("video",1000,500,{}, {name:"本地续拍结果",versions:[
   {ref:"output:h3studio/local-sequel.mp4",url:"/media?ref=output%3Ah3studio%2Flocal-sequel.mp4",seconds:5.17,
    video_recipe:{images:[{node_id:tailAnchor.id,ref:tailAnchor.versions[0].ref,time:0,role:"frame"}]}},
   {ref:"output:h3studio/local-other.mp4",seconds:6}],cur:0});
   ctxMenu({target:els.get(localTail.id),clientX:140,clientY:120});
   $("#ctxMenu [data-a=extension-film]").click();`);
 equal(evaluate('FILM.spec.clips.map(c=>c.ref)'),
   [evaluate('sourceAtCreation'),'output:h3studio/local-sequel.mp4'],'local continuation uses the capture referenced by the recipe, not the current frame');
 evaluate(`closeFilm();AC.board=boardId;
   $("#acMessages").insertAdjacentHTML("beforeend",acResultCards({nodes:[{id:localTail.id,type:"video",ref:curV(localTail).ref}]}));
   switchVersion(localTail,1);
   const continuationButton=$("#acMessages [data-extension-clip]");continuationButton.click();`);
 equal(evaluate('[localTail.cur,FILM.spec.clips[1].ref]'),[1,'output:h3studio/local-sequel.mp4'],
   'the assistant result opens that result version without changing the selected canvas Tab');
 evaluate(`selectClip(1);$("#fmV").onloadedmetadata?.();
   const editAt=(key,time)=>{$("#fmV").currentTime=time;
    $("#fmTime").dispatchEvent(new KeyboardEvent("keydown",{key,bubbles:true,cancelable:true}));};
   editAt("q",1);editAt("e",4);editAt("c",2);`);
 equal(evaluate('FILM.spec.clips.slice(1).map(c=>[c.in,c.out])'),[[1,2],[2,4]],
   'trim and split shortcuts work in a continuation timeline from the focused playhead control');
 evaluate(`closeFilm();continuationButton.closest(".ac-results").remove();
   const prologueInput={source_node:clipSource.id,source_ref:sourceAtCreation,position:"first"};
   tailAnchor.versions[0].capture=prologueInput;
   const localPrologue={video_recipe:{planned:true,duration:124/24,images:[
      {node_id:tailAnchor.id,ref:tailAnchor.versions[0].ref,time:5,role:"frame"}]}};
 `);
 equal(evaluate('extensionInput(localPrologue)?.direction'),'before','a locally generated tail anchor is recognized as a prologue');
 equal(evaluate('extensionInput({video_recipe:{images:[{...localPrologue.video_recipe.images[0],role:"subject"}]}})'),
   null,'a captured image used as an appearance reference does not create a continuation');
 evaluate('B.nodes=B.nodes.filter(n=>n!==localTail&&n!==tailAnchor);rebuild();updateSel();');
 const frameExtensionFetch=w.fetch, frameExtensionReads=[];
 w.fetch=async(url,options)=>{
  if(String(url)!=="/api/lastframe")return frameExtensionFetch(url,options);
  frameExtensionReads.push(JSON.parse(options.body));
  return {ok:true,text:async()=>JSON.stringify({ref:"output:h3studio/local-pin.png",url:"/media?ref=output%3Ah3studio%2Flocal-pin.png",w:720,h:1280,at:0})};
 };
 evaluate(`const previousExtensionServices=CAPS_LIST.video;
   CAPS_LIST.video=[{id:"cloud-default",kind:"ark",name:"云端服务",default:true},
                   {id:"local_h3",kind:"local_h3",name:"本地 H3",local:true}];
   openVideoExtension(clipSource);extForm.elements.method.value="frame";
   extForm.elements.method.dispatchEvent(new Event("change"));
   extForm.elements.direction.value="before";extForm.elements.prompt.value="补上空站台";
   extForm.dispatchEvent(new Event("submit",{cancelable:true}));`);
 await ready('node([...sel][0])?.name.endsWith("补拍片头")','the frame capture creates and selects the continuation');
 equal(frameExtensionReads,[{ref:evaluate('curV(clipSource).ref'),position:"first"}]);
 evaluate(`const frameExtensionDraft=node([...sel][0]);
   const frameExtensionAnchor=imageInputs(frameExtensionDraft)[0].source;
   addVersion(frameExtensionAnchor,{ref:"output:h3studio/unrelated-version.png",w:1280,h:720});`);
 equal(evaluate(`[frameExtensionDraft.data.provider,extForm.elements.duration.min,videoReq(frameExtensionDraft,"").ar,
   imageInputs(frameExtensionDraft)[0].edge.role,videoReq(frameExtensionDraft,"").images[0].ref]`),
   ["local_h3","5",9/16,"last","output:h3studio/local-pin.png"],'local continuation keeps the pinned anchor, actual aspect and local service after switching versions');
 evaluate('CAPS_LIST.video=previousExtensionServices;removeNodes([frameExtensionAnchor.id,frameExtensionDraft.id]);');
 w.fetch=frameExtensionFetch;
 console.log('Extension DOM passed: head/tail mode, pinned boundary, directional placement and ordered timeline.');
 evaluate(`CAPS_LIST.segment_edit=[{id:"fixture-edit",name:"片段编辑服务",model:"doubao-seedance-2-5-fixture"}];
   openSegmentEditor(clipSource);const segForm=$("#videoSegment form");
   $("video",segForm).pause=()=>{};segForm.elements.start.value=.25;segForm.elements.end.value=4.25;segForm.elements.prompt.value="改成夜景";
   segForm.elements.end.dispatchEvent(new Event("input"));segForm.dispatchEvent(new Event("submit",{cancelable:true}));
   const segmentNode=node([...sel][0]), segmentRecipe=videoReq(segmentNode,segmentNode.data.prompt);`);
 equal(evaluate('[segmentRecipe.segment_edit,segmentRecipe.video_refs[0].start,segmentRecipe.video_refs[0].end,segmentNode.data.provider]'),
   [true,.25,4.25,'fixture-edit'],'the dialog binds the edited range to its original source and service');
 evaluate(`addVersion(segmentNode,{ref:"output:h3studio/revised-segment.mp4",url:"/media?ref=output%3Ah3studio%2Frevised-segment.mp4",seconds:4,w:720,h:1280,video_recipe:segmentRecipe});
   nodeAction(segmentNode,"segment-film");`);
 equal(evaluate('FILM.spec.clips.map(c=>[c.ref,c.in,c.out,c.tight])'),
   [['input:h3studio/reference1.mp4',0,.25,true],['output:h3studio/revised-segment.mp4',0,4,true],['input:h3studio/reference1.mp4',4.25,12,true]],
   'the original prefix and suffix surround the replacement without rounding the short prefix away');
 evaluate('$("#fmV").pause=$("#fmOriginal").pause=()=>{};closeFilm()');
 console.log('Segment edit DOM passed: dedicated picker, editable range, pinned result and assembled timeline.');
 evaluate(`nodeAction(clipSource,"camera-retake");
   const retakeForm=$("#videoSegment form");
   $("video",retakeForm).pause=()=>{};
   const setRetakeMode=value=>{
     retakeForm.elements.cameraMode.value=value;
     retakeForm.elements.cameraMode.dispatchEvent(new Event("change"));
   };
   setRetakeMode("move");
   $("[data-vs-view=end] select",retakeForm).value="rear";
   retakeForm.dispatchEvent(new Event("submit",{cancelable:true}));
   const retakeDraft=node([...sel][0]);
   const savedCameraRequest=videoReq(retakeDraft,"");`);
 equal(evaluate('[savedCameraRequest.prompt,savedCameraRequest.mode,savedCameraRequest.camera_plan,savedCameraRequest.video_refs[0].ref]'),
   ['', 'camera_retake',{mode:'move',start:{angle:'front',scale:'medium'},end:{angle:'rear',scale:'medium'}},'input:h3studio/reference1.mp4'],
   'a retake may use its structured plan without extra text and keeps the exact source video');
 evaluate(`addVersion(retakeDraft,{ref:"output:h3studio/camera-retake.mp4",seconds:5,video_recipe:savedCameraRequest});
   selectOnly(retakeDraft.id);$("#retakeSettings").click();setRetakeMode("fixed");
   $("[data-vs-view=start] select",retakeForm).value="overhead";
   retakeForm.dispatchEvent(new Event("submit",{cancelable:true}));`);
 equal(evaluate('[node([...sel][0]).id===retakeDraft.id,retakeDraft.data.camera_plan,curV(retakeDraft).node_data.camera_plan]'),
   [true,{mode:'fixed',start:{angle:'overhead',scale:'medium'}},{mode:'move',start:{angle:'front',scale:'medium'},end:{angle:'rear',scale:'medium'}}],
   'adjusting a take uses its existing node and preserves the historical plan');
 evaluate('removeNodes([retakeDraft.id])');
 console.log('Camera retake DOM passed: structured source settings, optional text, and preserved node version.');
 const batchFetch=w.fetch, batchRequests=[];
 w.fetch=async(url,options)=>{
  if(String(url)!=="/api/generate") return batchFetch(url,options);
  const request=JSON.parse(options.body);batchRequests.push(request);
  const id="retake-batch-"+batchRequests.length;
  jobs.set(id,{state:"running",meta:{}});
  return {ok:true,text:async()=>JSON.stringify({ids:[id]})};
 };
 evaluate(`nodeAction(clipSource,"camera-retake");
   const retakePlayer=$("video",retakeForm);
   Object.defineProperty(retakePlayer,"readyState",{value:1,configurable:true});
   const setRetakeRange=(start,end)=>{retakeForm.elements.start.value=start;retakeForm.elements.end.value=end;
     retakeForm.elements.end.dispatchEvent(new Event("input"));};
   setRetakeRange(0,12);retakePlayer.currentTime=4;
   retakePlayer.dispatchEvent(new Event("timeupdate"));$("[data-retake-split]").click();
   $("[data-retake-remove]").click();$("[data-retake-add]").click();
   setRetakeRange(6,11);setRetakeMode("move");
   $("[data-vs-view=end] select",retakeForm).value="rear";
   retakeForm.elements.prompt.value="人物回头";
   const batchButtons=()=>$$("[data-retake-tabs] button");
   batchButtons()[0].click();
   $("[data-vs-view=start] select",retakeForm).value="overhead";
   setRetakeRange(0,7);`);
 equal(evaluate('[$("[data-vs-status]").textContent,$("[data-retake-generate]").disabled]'),
   ['重拍区间重叠，请调整入出点。',true],'overlap blocks the entire batch');
 evaluate('setRetakeRange(0,4);batchButtons()[1].click()');
 equal(evaluate('[retakeForm.elements.cameraMode.value,retakeForm.elements.prompt.value,$("[data-vs-view=end] select").value]'),
   ['move','人物回头','rear'],'switching intervals keeps the independent camera and notes');
 evaluate('$("[data-retake-generate]").click()');
 await ready('!$("#videoSegment").open && !queueing','retake batch submitted');
 equal(batchRequests.map(request=>[request.video_refs[0].ref,request.video_refs[0].start,request.video_refs[0].end,
   request.camera_plan.mode,request.camera_plan.start.angle,request.prompt]),[
   ['input:h3studio/reference1.mp4',0,4,'fixed','overhead',''],
   ['input:h3studio/reference1.mp4',6,11,'move','front','人物回头'],
 ],'batch creates and queues the selected source intervals in chronological order without filling gaps');
 evaluate('const batchIds=[...sel];removeNodes(batchIds);');
 delete w.document.querySelector('#videoSegment video').readyState;
 w.fetch=batchFetch;
 console.log('Multi-range retake DOM passed: split, add, remove, reject overlap, and submit each preserved plan.');
 evaluate(`nodeAction(clipSource,"object-replace");
   const objectPlayer=$("#videoSegment video"), overlay=$("[data-object-overlay]");
   Object.defineProperty(objectPlayer,"readyState",{value:1,configurable:true});
   objectPlayer.getBoundingClientRect=()=>({left:0,top:0,width:200,height:200});
   objectPlayer.currentTime=1;
   $("[data-object-mark]").click();
   overlay.onpointerdown({button:0,clientX:80,clientY:50,preventDefault:()=>{}});
   overlay.onpointermove({clientX:120,clientY:150});overlay.onpointerup({clientX:120,clientY:150});
   const objectForm=$("#videoSegment form");
   const replaceOption=[...$("[data-object-ref]").options].find(option=>option.value);
   $("[data-object-ref]").value=replaceOption.value;$("[data-object-ref]").dispatchEvent(new Event("change"));
   objectForm.dispatchEvent(new Event("submit",{cancelable:true}));
   const objectDraft=node([...sel][0]), objectRequest=videoReq(objectDraft,"");`);
 equal(evaluate('[objectRequest.mode,objectRequest.object_edit.action,objectRequest.object_edit.at,objectRequest.object_edit.replacement_ref===replaceOption.value]'),
   ['object_edit','replace',1,true],'the new node pins both the marked frame and the selected replacement reference');
 const objectBox=evaluate('objectRequest.object_edit.box');
 equal(objectBox.map(value=>+value.toFixed(3)),[.322,.25,.678,.75],'box coordinates are relative to the displayed video, not letterbox bars');
 const objectFetch=w.fetch, uploads=[];
 w.fetch=async(url,options)=>{
  if(String(url).startsWith('/api/library?board='))return {ok:true,text:async()=>JSON.stringify([
    {ref:'input:h3studio/library-prop.png',name:'蓝色花瓶'},{ref:'input:h3studio/library-video.mp4',name:'原片'}
  ])};
  if(String(url)!=='/api/upload')return objectFetch(url,options);
  return new Promise(resolve=>uploads.push({file:options.body.get('image'),resolve}));
 };
 evaluate('$("#objectSettings").click();');
 equal(evaluate('$("[data-object-ref]").value===replaceOption.value'),true,'reopening keeps the pinned replacement version');
 await ready('[...$("[data-object-ref]").options].some(option=>option.value==="input:h3studio/library-prop.png" && option.text==="蓝色花瓶")',
   'visible asset appears in the replacement picker');
 evaluate(`const chooseReplacement=ref=>{const el=$("[data-object-ref]");el.value=ref;el.dispatchEvent(new Event("change"));};
   const uploadReplacement=name=>{const field=$("[data-object-file]");
     Object.defineProperty(field,"files",{value:[new File(["fixture"],name,{type:"image/png"})],configurable:true});
     field.dispatchEvent(new Event("change"));};
   chooseReplacement("input:h3studio/library-prop.png");objectPlayer.currentTime=3;
   $("[data-object-locate]").click();uploadReplacement("candidate.png");`);
 equal(evaluate('[objectPlayer.currentTime,$("#videoSegment [type=submit]").disabled,$("[data-object-preview]").hidden]'),
   [1,true,false],'jumping back seeks to the marked frame, and an in-flight upload blocks submission');
 equal(uploads[0].file.name,'candidate.png','a replacement file is sent directly as a multipart image');
 uploads[0].resolve({ok:false,json:async()=>({error:'读不了这张图片'})});
 await ready('!$("[data-object-upload]").disabled','failed upload restored its picker');
 equal(evaluate('$("[data-object-ref]").value'),'input:h3studio/library-prop.png','failed upload preserves the selected asset');
 evaluate('uploadReplacement("orange-vase.webp");');
 uploads[1].resolve({ok:true,json:async()=>({ref:'input:h3studio/uploaded-vase.webp'})});
 await ready('$("[data-object-ref]").value==="input:h3studio/uploaded-vase.webp"','uploaded image is selected');
 evaluate('objectForm.dispatchEvent(new Event("submit",{cancelable:true}));$("#objectSettings").click();');
 equal(evaluate('[objectDraft.data.object_edit.replacement_ref,$("[data-object-ref]").selectedOptions[0].text,$("[data-object-preview]").hidden]'),
   ['input:h3studio/uploaded-vase.webp','orange-vase.webp',false],'upload saves the pinned reference and preview without adding a separate node');
 evaluate('uploadReplacement("late.png");closeSegmentEditor();$("#objectSettings").click();');
 uploads[2].resolve({ok:true,json:async()=>({ref:'input:h3studio/late.png'})});
 await new Promise(resolve=>setImmediate(resolve));
 equal(evaluate('$("[data-object-ref]").value'),'input:h3studio/uploaded-vase.webp','an upload from a closed editor cannot change a reopened draft');
 w.fetch=objectFetch;
 evaluate('closeSegmentEditor();removeNodes([objectDraft.id]);');
 delete w.document.querySelector('#videoSegment video').readyState;
 evaluate(`const addReviewCandidate=(target,name,start,end)=>{
   const ref="output:h3studio/"+name+".mp4";
   const recipe={...segmentRecipe,video_refs:[{...segmentRecipe.video_refs[0],start,end}]};
   addVersion(target,{ref,url:"/media?ref="+encodeURIComponent(ref),seconds:end-start,w:720,h:1280,video_recipe:recipe});
 };
 addReviewCandidate(segmentNode,"review-alternate",.25,4.25);
 addReviewCandidate(addNode("video",800,120),"review-overlap",3,7);
 addReviewCandidate(addNode("video",880,120),"review-later",6,10);
 $("#segmentReview video").pause=()=>{};
 nodeAction(clipSource,"segment-review");
 const reviewRows=()=>$$("#segmentReview [data-sr-list] select");
 const chooseReview=(row,index)=>{
   const select=reviewRows()[row];select.selectedIndex=index;select.dispatchEvent(new Event("change"));
 };
 chooseReview(0,2);chooseReview(2,1);chooseReview(1,1);`);
 equal(evaluate('[$("[data-sr-send]").disabled,$("[data-sr-status]").textContent.includes("重叠")]'),
   [true,true],'overlapping decisions cannot be saved or sent');
 evaluate('chooseReview(1,0);$("[data-sr-save]").click();nodeAction(segmentNode,"segment-review-parent");');
 equal(evaluate('reviewRows().map(select=>select.selectedIndex)'),[2,0,1],
   'the original version reopens with the saved decisions');
 evaluate('$("[data-sr-send]").click();');
 equal(evaluate('FILM.spec.clips.map(c=>[c.ref,c.in,c.out,c.tight])'),[
   ['input:h3studio/reference1.mp4',0,.25,true],
   ['output:h3studio/review-alternate.mp4',0,4,true],
   ['input:h3studio/reference1.mp4',4.25,6,true],
   ['output:h3studio/review-later.mp4',0,4,true],
   ['input:h3studio/reference1.mp4',10,12,true],
 ],'review builds a continuous timeline from exact source and selected versions');
 evaluate('$("#fmV").pause=$("#fmOriginal").pause=()=>{};closeFilm()');
 console.log('Segment review DOM passed: alternatives, overlap validation, saved decisions and continuous timeline.');
 evaluate(`nodeAction(clipSource,"segment-review");$("[data-sr-original-audio]").checked=true;
   $("[data-sr-save]").click();nodeAction(segmentNode,"segment-review-parent");`);
 equal(evaluate('$("[data-sr-original-audio]").checked'),true,'original audio choice stays with the pinned source version');
 evaluate('$("[data-sr-send]").click();');
 equal(evaluate('FILM.spec.clips.map(c=>[c.audio_ref,c.audio_start])'),[
   ['input:h3studio/reference1.mp4',0],
   ['input:h3studio/reference1.mp4',.25],
   ['input:h3studio/reference1.mp4',0],
   ['input:h3studio/reference1.mp4',6],
   ['input:h3studio/reference1.mp4',0],
 ],'the separate draft keeps the exact original audio offsets even when another audio choice already has a draft');
 evaluate('selectClip(1);$("#fmV").onloadedmetadata?.();');
 equal(evaluate('[$("#fmV").muted,$("#fmOriginal").currentTime]'),[true,.25],
   'preview mutes the replacement soundtrack and seeks the original audio to the edited interval');
 evaluate(`const setFilmRate=rate=>{const field=$("[data-clip-speed]");field.value=rate;field.dispatchEvent(new Event("change"));};
   setFilmRate(2);seekTimeline(1.25);$("#fmV").onloadedmetadata?.();`);
 equal(evaluate('[FILM.spec.clips[1].speed,filmTotal(FILM.spec),$("#fmV").playbackRate,$("#fmV").currentTime,$("#fmOriginal").playbackRate,$("#fmOriginal").currentTime]'),
   [2,10,2,2,2,2.25],'retimed film playhead and preserved source audio follow the same source position');
 evaluate('setFilmRate(3)');
 equal(evaluate('[$("[data-clip-speed]").value,FILM.spec.clips[1].speed]'),['2',2],'out-of-range retiming leaves the valid rate intact');
 evaluate(`FILM.spec.clips[1].subs=["前半段","后半段"];FILM.spec.clips[1].trans="fade";
   const durationBeforeSplit=filmTotal(FILM.spec);
   $("#fmV").currentTime=3.75;$("[data-split-clip]").click();
   if(FILM.spec.clips.length!==5)throw new Error("Split shortened an existing dissolve");
   $("#fmV").currentTime=2;$("[data-split-clip]").click();$("#fmV").onloadedmetadata?.();`);
 equal(evaluate(`[FILM.sel,filmTotal(FILM.spec)===durationBeforeSplit,
   FILM.spec.clips.slice(1,3).map(c=>[c.in,c.out,c.speed,c.audio_start,c.trans,c.subs]),
   $("#fmOriginal").currentTime]`),[2,true,[[0,2,2,.25,'cut',['前半段']],[2,4,2,.25,'fade',['后半段']]],2.25],
   'splitting on the sped-up playhead preserves the output duration, audio alignment and outgoing transition');
 evaluate('selectClip(0);$("#fmV").onloadedmetadata?.();');
 equal(evaluate('[$("#fmV").muted,$("#fmV").playbackRate]'),[false,1],'untouched clips use their own audio and normal speed');
 evaluate('closeFilm()');
 const captureFetch=w.fetch, frameRequests=[];
 w.fetch=async(url,options)=>{
  if(String(url)!=='/api/lastframe')return captureFetch(url,options);
  const request=JSON.parse(options.body);frameRequests.push(request);
  const ref='input:h3studio/frame-'+frameRequests.length+'.png';
  return {ok:true,text:async()=>JSON.stringify({ref,url:'/media?ref='+encodeURIComponent(ref),w:64,h:64,
    at:request.position==='first'?0:1.5,position:request.position})};
 };
 evaluate(`nodeAction(clipSource,"capture");$("#frameCapture video").pause=()=>{};
   $("[data-capture-position=first]").click();`);
 await ready('!$("#frameCapture").open','first frame capture closes picker');
 equal(evaluate('curV(node([...sel][0])).capture'),{
   source_node:evaluate('clipSource.id'),source_ref:'input:h3studio/reference1.mp4',position:'first',at:0
 },'camera modal preserves the exact capture source and timestamp');
 evaluate(`const standaloneCapture=newSpec([clipSource]);
   Object.assign(standaloneCapture.clips[0],{in:1,out:4,speed:.5});
   showFilm(standaloneCapture,null,filmDraftPrefix()+"capture-test");
   const filmCapturePlayer=$("#fmV");filmCapturePlayer.onloadedmetadata?.();
   Object.defineProperty(filmCapturePlayer,"readyState",{value:1,configurable:true});
   seekTimeline(1);$("[data-film-capture]").click();`);
 await ready('!FILM','playhead capture returns to the canvas');
 equal(frameRequests,[{ref:'input:h3studio/reference1.mp4',position:'first'},
   {ref:'input:h3studio/reference1.mp4',position:'time',at:1.5}],
   'the film capture submits the source clock of the retimed clip');
 equal(evaluate(`const captured=B.edges.find(e=>e.to===[...sel][0]);
   [captured.relation,captured.source_ref,captured.at]`),['capture','input:h3studio/reference1.mp4',1.5],
   'the inserted frame is connected to its source');
 delete w.document.querySelector('#fmV').readyState;
 w.fetch=captureFetch;
 console.log('Video capture DOM passed: choose the first frame or capture the retimed timeline playhead.');
 scenarioState.trimFetch = w.fetch;
 const trimCalls=[];
 w.fetch=async(url,options)=>{
  if (String(url)!=='/api/video/trim')return scenarioState.trimFetch(url,options);
  const request=JSON.parse(options.body);trimCalls.push(request);
  const result=request.action==='detect'?{cuts:[48,96]}:{clips:[
    {ref:'output:h3studio/trim1.mp4',url:'/media?ref=output%3Ah3studio%2Ftrim1.mp4',start:1,end:2,seconds:1,w:720,h:1280},
    {ref:'output:h3studio/trim2.mp4',url:'/media?ref=output%3Ah3studio%2Ftrim2.mp4',start:2,end:6,seconds:4,w:720,h:1280}
  ]};
  return {ok:true,text:async()=>JSON.stringify(result)};
 };
 evaluate(`nodeAction(clipSource,"trim-video");
   const trimForm=$("#videoTrim form"),trimPlayer=$("#videoTrim video");
   trimPlayer.pause=()=>{};
   trimForm.elements.start.value=1;trimForm.elements.end.value=6;
   trimForm.elements.end.dispatchEvent(new Event("input"));
   $("[data-trim-detect]").click();`);
 await ready('$$("[data-trim-cuts] button").length===2','detected cut points');
 evaluate(`$$("[data-trim-cuts] button")[1].click();
   Object.defineProperty(trimPlayer,"readyState",{value:1,configurable:true});
   trimPlayer.currentTime=3;$("[data-trim-split]").click();
   if($$("[data-trim-cuts] button")[1].textContent!=="3.00 秒 ×")throw new Error("Missing manual cut");
   $$("[data-trim-cuts] button")[1].click();
   trimForm.dispatchEvent(new Event("submit",{cancelable:true}));`);
 await ready('!$("#videoTrim").open','trim results placed on the canvas');
 equal(trimCalls.map(call=>[call.action,call.points]),[['detect',[24,144]],['render',[24,48,144]]],
   'trimming submits only the adopted cut points');
 equal(evaluate(`[...sel].map(id=>{const out=node(id), edge=B.edges.find(e=>e.to===id);
   return [curV(out).ref,edge.from===clipSource.id,edge.relation,edge.source_ref,edge.start,edge.end];})`),[
   ['output:h3studio/trim1.mp4',true,'trim','input:h3studio/reference1.mp4',1,2],
   ['output:h3studio/trim2.mp4',true,'trim','input:h3studio/reference1.mp4',2,6],
 ],'both outputs are related to the original media version');
 console.log('Video trim DOM passed: detected and manual cuts, selective export and pinned source links.');
};
