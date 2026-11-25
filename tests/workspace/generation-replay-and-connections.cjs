"use strict";

module.exports = async function generationReplayAndConnections(workspace) {
 const { assert, equal, evaluate, jobs, ready, w } = workspace;
 const promptFetch=w.fetch, wiredPrompts=[];
 w.fetch=async(url,options={})=>{
  if(String(url)!=="/api/generate")return promptFetch(url,options);
  const request=JSON.parse(options.body);
  wiredPrompts.push(request);
  const id="prompt-wired-job-"+wiredPrompts.length,ref="output:h3studio/prompt-wired-"+wiredPrompts.length+(request.kind==="video"?".mp4":".png");
  jobs.set(id,{state:"done",outputs:[{ref,url:"/media?ref="+encodeURIComponent(ref),meta:{width:640,height:360}}]});
  const reference_context=request.audio_refs?{audio_refs:[{...request.audio_refs[0],start:.75,end:4.125}]}:undefined;
  return {ok:true,text:async()=>JSON.stringify({ids:[id],reference_context})};
 };
 evaluate(`const wirePromptBase=snap();
  const promptReference=addNode("image",100,550,{}, {name:"画布专用参考图",versions:[
   copyAsset("prompt-old.png",{w:512,h:384}),copyAsset("prompt-new.png",{w:512,h:512})],cur:0});
  const legacyReference=addNode("image",400,550,{},{versions:[copyAsset("legacy-ref.png",{w:512,h:512})],cur:0});
  const wiredImage=addNode("image",720,550);
  link(legacyReference,wiredImage,true);selectOnly(wiredImage.id);
  const enterMention=(field,value)=>{field.value=value;field.focus();field.setSelectionRange(value.length,value.length);
   field.dispatchEvent(new Event("input",{bubbles:true}));};
  enterMention($("#prompt"),"对照@画布专用");`);
 await ready('!CM.popup.hidden && CM.matches.some(m=>m.id===promptReference.id)','the image composer offers compatible canvas images');
 evaluate('$("[data-canvas-node]",CM.popup).click();');
 equal(evaluate('[node(wiredImage.id).data.prompt,imageInputs(wiredImage)[1].edge.ref]'),["对照@图{1} ","output:h3studio/prompt-old.png"],'choosing the image creates a pinned input edge and stable token');
 evaluate('undo()');
 equal(evaluate('[node(wiredImage.id).data.prompt,$("#prompt").value,imageInputs(node(wiredImage.id)).length]'),["对照@画布专用","对照@画布专用",1],'undo restores both the prompt and graph');
 evaluate('redo();switchVersion(node(promptReference.id),1);selectOnly(wiredImage.id)');
 await evaluate('generate(node(wiredImage.id))');
 await ready('node(wiredImage.id).versions.length===1','the pinned image request creates a version',350);
 equal([wiredPrompts[0].prompt,wiredPrompts[0].images[1].ref],["对照@图2","output:h3studio/prompt-old.png"],'submission uses the selected older image and correct position');
 evaluate(`const beforeRegeneration=curV(node(wiredImage.id)).ref;
   const legacyImageNode=node(legacyReference.id);
   legacyImageNode.versions.push(copyAsset("legacy-new.png",{w:512,h:512}));
   switchVersion(legacyImageNode,1);
   selectOnly(legacyImageNode.id);
   $("[data-node-prompt]",els.get(wiredImage.id)).click();
   enterMention($("#prompt"),"未提交的草稿");
   lightbox(curV(node(wiredImage.id)),node(wiredImage.id));
   $("[data-light-generation-draft]").click();`);
 equal(evaluate('[$("#light").open,$("#prompt").value,document.activeElement.id,imageInputs(node(wiredImage.id)).map(input=>input.edge.ref)]'),
 [false,"对照@图{1} ","prompt",["output:h3studio/legacy-ref.png","output:h3studio/prompt-old.png"]],
 'continuing a result restores editable tokens and both historical source versions');
 evaluate('undo()');
 assert.equal(evaluate('node(wiredImage.id).data.prompt'),"未提交的草稿",'undo restores the unsent draft');
 evaluate('vtTabMenu(node(wiredImage.id),0,100,100);$("[data-version-draft]").click();');
 assert.equal(evaluate('$("#send").getAttribute("aria-label")'),"重新生成");
 await evaluate('generate(node(wiredImage.id))');
 await ready('node(wiredImage.id).versions.length===2','regeneration appends a version to the original node',350);
 equal(evaluate('[node(wiredImage.id).versions[0].ref,curV(node(wiredImage.id)).ref]'),
 [evaluate('beforeRegeneration'),"output:h3studio/prompt-wired-2.png"],'the generated result and the source version stay on the node');
 equal(wiredPrompts[1].images.map(input=>input.ref),["output:h3studio/legacy-ref.png","output:h3studio/prompt-old.png"]);
 evaluate(`const removedHistoryImage=node(legacyReference.id).versions.shift();
   node(legacyReference.id).cur=0;
   const beforeMissingHistory=snap();
   lightbox(node(wiredImage.id).versions[0],node(wiredImage.id));
   $("[data-light-generation-draft]").click();`);
 assert.match(evaluate('$(".light-status").textContent'),/历史素材版本已移除/);
 assert.equal(evaluate('snap()===beforeMissingHistory'),true,'a missing input leaves the active draft and graph untouched');
 evaluate('closeLightbox();node(legacyReference.id).versions.unshift(removedHistoryImage);node(legacyReference.id).cur=1;');
 evaluate(`node(wiredImage.id).versions[0].memory_used=[{id:"historical-asset",name:"旧版设定"}];
   vtTabMenu(node(wiredImage.id),0,100,100);$("[data-version-replay-assets]").click();`);
 equal(evaluate('[node(wiredImage.id).data.replay_memory_ref,!!$("[data-replay-assets-clear]")]'),
  [evaluate("beforeRegeneration"),true],"the reviewed version pins the original asset snapshot");
 evaluate('$("[data-replay-assets-clear]").click()');
 assert.equal(evaluate("node(wiredImage.id).data.replay_memory_ref"),undefined);
 evaluate("undo();selectOnly(wiredImage.id)");
 await evaluate("generate(node(wiredImage.id))");
 await ready('node(wiredImage.id).versions.length===3','asset snapshot replay completes',350);
 assert.equal(wiredPrompts[2].replay_memory_ref,evaluate("beforeRegeneration"));
 evaluate(`const recipeDraftAudio=addNode("audio",650,930,{prompt:"当前文案"},{versions:[
   copyAsset("historical-voice.wav",{seconds:5,audio_recipe:{mode:"tts",prompt:"此前的文案",speed:.9}}),
   copyAsset("latest-voice.wav",{seconds:4})],cur:1});
   render(recipeDraftAudio);render(recipeDraftAudio);lightbox(recipeDraftAudio.versions[0],recipeDraftAudio);
   $("[data-light-generation-draft]").click();
   const inheritedVideo=addNode("video",850,930,{prompt:"更新后"},{versions:[
     copyAsset("historical-video.mp4",{seconds:5,video_recipe:{
       kind:"video",duration:5,ar:4/3,planned:true,prompt:"参考 @音1",provider:"legacy-route",
       images:[{node_id:promptReference.id,ref:node(promptReference.id).versions[0].ref,role:"subject"}],
       audio_refs:[{node_id:recipeDraftAudio.id,ref:recipeDraftAudio.versions[0].ref}]}}),
     copyAsset("latest-video.mp4",{seconds:5})],cur:1});
   lightbox(inheritedVideo.versions[0],inheritedVideo);
   $("[data-light-generation-draft]").click();`);
 equal(evaluate(`[recipeDraftAudio.cur,recipeDraftAudio.data.prompt,recipeDraftAudio.data.speed,
   $$("[data-node-prompt]",els.get(recipeDraftAudio.id)).length,
   inheritedVideo.cur,inheritedVideo.data.prompt,inheritedVideo.data.aspect,
   imageInputs(inheritedVideo)[0].edge.ref,audioInputs(inheritedVideo)[0].edge.ref]`),
 [0,"此前的文案",.9,1,0,"参考 @音1","4:3","output:h3studio/prompt-old.png","output:h3studio/historical-voice.wav"],
 'old audio and video recipe shapes restore their own selected version and saved inputs');
 evaluate(`const oldRangeVersion=inheritedVideo.versions[0], savedAudioServices=CAPS_LIST.audio_reference;
  CAPS_LIST.audio_reference=[{id:"legacy-route",name:"历史服务",model:"new-default",
   models:[{id:"old-model",durations:[5],qualities:{hd:"1080p"}},{id:"new-default"}]}];
  oldRangeVersion.input_edges=structuredClone(B.edges.filter(e=>e.to===inheritedVideo.id));
  oldRangeVersion.node_data={...inheritedVideo.data,provider:"different-service",selected_model:"different-model"};
  oldRangeVersion.generation_record={settings:{provider:"legacy-route",provider_model:"old-model"}};
  Object.assign(oldRangeVersion.video_recipe.audio_refs[0],{start:.25,end:3.75});
  switchVersion(inheritedVideo,1);switchVersion(inheritedVideo,0);selectOnly(inheritedVideo.id);`);
 equal(evaluate('videoReq(inheritedVideo,"").audio_refs.map(({start,end})=>[start,end])'),[[.25,3.75]],
   'an older snapshot recovers its canonical audio range from the recipe');
 await evaluate('generate(inheritedVideo)');
 await ready('inheritedVideo.versions.length===3','mixed reference regeneration writes a new version',350);
 equal([wiredPrompts[3].provider,wiredPrompts[3].selected_model],["legacy-route","old-model"],
   'the recorded model is submitted when the old draft and current default differ');
 equal(evaluate(`[curV(inheritedVideo).input_edges.find(e=>e.relation==="audio_ref"),
   curV(inheritedVideo).generation_record.inputs.find(e=>e.role==="audio_ref")].map(({start,end})=>[start,end])`),
   [[.75,4.125],[.75,4.125]],'the saved edge and receipt both use the resolved audio range');
 evaluate('loadGenerationDraft(inheritedVideo,oldRangeVersion);CAPS_LIST.audio_reference=[];showPanel()');
 equal(evaluate('[$("#ctl select[data-k=provider]").selectedOptions[0].textContent,videoPreviewRequest(inheritedVideo).selected_model]'),
   ["legacy-route（不可用）","old-model"],'an unavailable service stays explicit so the preview cannot silently fall back');
 evaluate('CAPS_LIST.audio_reference=savedAudioServices');
 console.log('Historical generation drafts passed: prompt shortcut, pinned image references, undo, same-node regeneration and missing inputs.');
 evaluate(`const wiredVideo=addNode("video",1100,550,{pmode:"fields",fields:{action:""}});selectOnly(wiredVideo.id);
   enterMention($("#pfields [data-k=action]"),"沿用＠画布专用");`);
 await ready('!CM.popup.hidden && CM.matches.some(m=>m.id===promptReference.id)','structured video field supports name completion');
 evaluate('$("[data-canvas-node]",CM.popup).click();switchVersion(node(promptReference.id),0);selectOnly(wiredVideo.id)');
 equal(evaluate(`[wiredVideo.data.fields.action,videoReq(wiredVideo,"").fields.action,videoReq(wiredVideo,"").images[0].ref]`),
 ["沿用@图{1} ","沿用@图1 ","output:h3studio/prompt-new.png"],'video field resolves the pinned reference without following the source tab');
 evaluate('$("[data-image-update]").click();');
 equal(evaluate('videoReq(wiredVideo,"").images[0].ref'),"output:h3studio/prompt-old.png",'an explicit action adopts the current source version');
 const beforePreviewFetch=w.fetch;
 let recordedPreview;
 w.fetch=async (path,options)=>{
  if(path!=="/api/preview")return beforePreviewFetch(path,options);
  recordedPreview=JSON.parse(options.body);
  return {ok:true,text:async()=>JSON.stringify({prompt:"Follow <Picture 1>.",mode:"人物设定",
   inputs:[{...recordedPreview.images[0],name:"乔纳 <参考图>",role:"subject"}]})};
 };
 evaluate('$("#pvBtn").click()');
 await ready('$("#pv").classList.contains("on")','the preview opens for the selected video');
 assert.equal(recordedPreview.fields.action,"沿用@图1 ");
 assert.equal(recordedPreview.images[0].ref,"output:h3studio/prompt-old.png");
 equal(evaluate('[$("#pvt").textContent,$("#pvInputs strong").textContent,$("#pvInputs small").textContent]'),
 ["Follow <Picture 1>.","乔纳 <参考图>","人物设定 · 版本 1"],'the preview shows the resolved prompt and the pinned source');
 evaluate('$("#pvClose").click()');
 w.fetch=beforePreviewFetch;
 evaluate(`const promptReferenceLine=()=>$$('#edges .hit').find(hit=>hit.getAttribute("aria-label")?.includes(
   promptReference.name+" · 固定版本 1 → "+wiredVideo.name));
  const edgeKey=key=>promptReferenceLine().dispatchEvent(new KeyboardEvent("keydown",{key,bubbles:true,cancelable:true}));
  const edgeAccess=B.access;B.access="reviewer";edgeKey("Enter");`);
 equal(evaluate('[!!$(".edge-inspector"),!!$("[data-edge-cut]")]'),[true,false]);
 evaluate('B.access=edgeAccess;drawEdges();edgeKey("Enter")');
 assert.match(evaluate('$("title",promptReferenceLine()).textContent'),/固定版本 1/);
 assert.equal(evaluate('document.activeElement.hasAttribute("data-edge-cut")'),true);
 evaluate(`const edgeGesture=(type,x,y)=>$("[data-edge-cut]").dispatchEvent(new MouseEvent(type,
  {button:0,bubbles:true,cancelable:true,clientX:x,clientY:y,detail:1}));
  edgeGesture("pointerdown",100,100);edgeGesture("pointermove",100,68);edgeGesture("pointerup",100,68);
  edgeGesture("click",100,68);`);
 assert.equal(evaluate('imageInputs(wiredVideo).length'),1,'dragging upwards cannot cut a connection');
 evaluate('edgeGesture("pointerdown",100,100);edgeGesture("pointermove",100,131);edgeGesture("pointercancel",100,131)');
 assert.equal(evaluate('imageInputs(wiredVideo).length'),1,'cancelling the gesture leaves the connection intact');
 evaluate('edgeGesture("pointerdown",100,100);edgeGesture("pointermove",100,131);edgeGesture("pointerup",100,131)');
 equal(evaluate('videoReq(wiredVideo,"")'),null,'an orphaned prompt token stops submission');
 assert.match(evaluate('$(".errbox",els.get(wiredVideo.id)).textContent'),/图片引用已断开/);
 evaluate('undo()');
 assert.equal(evaluate('imageInputs(node(wiredVideo.id))[0].edge.ref'),"output:h3studio/prompt-old.png");
 console.log('Connection inspection passed: exact source version, reviewer access, directed scissors gesture and undo.');
 evaluate('restore(wirePromptBase)');
 w.fetch=promptFetch;
 console.log('Generation mention DOM passed: image and structured video, pinned edges, undo, version adoption and missing reference validation.');
 evaluate(`const modelPickerBase=snap(),previousImageServices=CAPS_LIST.image;
  CAPS_LIST.image=[{id:"model-qa",name:"图像服务",model:"model-standard",default:true,default_route_model:"model-fast",
    models:[{id:"model-standard"},{id:"model-fast"}]}];
  const modelImage=addNode("image",900,600,{prompt:"走廊"});
  selectOnly(modelImage.id);`);
 const beforeModelFetch=w.fetch;
 let selectedModelRequest;
 w.fetch=async (path,options)=>{
  if(path!=="/api/generate")return beforeModelFetch(path,options);
  selectedModelRequest=JSON.parse(options.body);
  const ref="output:h3studio/chosen-model.png";
  jobs.set("chosen-model",{state:"done",outputs:[{ref,url:"/media?ref="+encodeURIComponent(ref)}]});
  return {ok:true,text:async()=>JSON.stringify({ids:["chosen-model"]})};
 };
 assert.match(evaluate('$("[data-k=selected_model]").parentElement.textContent'),/model-fast/);
 evaluate(`const selectCanvasModel=id=>{
   const option=$("[data-k=selected_model]");option.value=id;option.dispatchEvent(new Event("change"));
  };
  selectCanvasModel("model-standard");`);
 await evaluate('generate(modelImage)');
 equal([selectedModelRequest.provider,selectedModelRequest.selected_model],["model-qa","model-standard"]);
 await ready('modelImage.versions.length===1','chosen image model returns a new version');
 assert.equal(evaluate('curV(modelImage).generation_record.settings.provider_model'),"model-standard");
 evaluate('$("[data-k=provider]").value="";$("[data-k=provider]").dispatchEvent(new Event("change"))');
 assert.equal(evaluate('modelImage.data.selected_model'),undefined,'switching back to the default service clears the model override');
 w.fetch=beforeModelFetch;
 evaluate('CAPS_LIST.image=previousImageServices;restore(modelPickerBase)');
 console.log('Canvas model picker passed: a single service exposes alternate models and records the selected model.');

 evaluate(`const avPromptBase=snap(),capsBeforeAV={audio:CAPS_LIST.audio_reference,video:CAPS_LIST.previs};
  CAPS_LIST.audio_reference=[{id:"audio-qa",name:"仅声音参考",model:"seedance-2"}];
  CAPS_LIST.previs=[{id:"multimodal-qa",name:"视频参考服务",model:"seedance-2-5",
    models:[{id:"seedance-2-5",draft:true},{id:"seedance-2",draft:false}]}];
  window.__capabilities={...CAPS_LIST};
  const avTarget=addNode("video",1200,650,{prompt:""}, {name:"成片"});
  const avVideo=addNode("video",600,650,{}, {name:"画布运镜实拍",versions:[
   copyAsset("move-old.mp4",{seconds:12,w:640,h:480}),copyAsset("move-now.mp4",{seconds:12,w:640,h:480})],cur:0});
  const avAudio=addNode("audio",100,650,{}, {name:"画布现场铃声",versions:[
   copyAsset("bell-old.wav",{seconds:4}),copyAsset("bell-now.wav",{seconds:4})],cur:0});
  selectOnly(avTarget.id);enterMention($("#prompt"),"按@画布现场");`);
 await ready('CM.matches.some(m=>m.id===avAudio.id) && !CM.popup.hidden','video composer offers audio nodes');
 evaluate('$("[data-canvas-node]",CM.popup).click();');
 equal(evaluate('[avTarget.data.prompt,avTarget.data.provider,videoReq(avTarget,fullPrompt(avTarget)).audio_refs[0].ref]'),
 ["按@音{1} ","audio-qa","output:h3studio/bell-old.wav"],'audio reference uses the audio-capable route');
 evaluate('enterMention($("#prompt"),avTarget.data.prompt+"与@画布运镜")');
 await ready('CM.matches.some(m=>m.id===avVideo.id) && !CM.popup.hidden','video composer offers video references');
 evaluate(`$("[data-canvas-node]",CM.popup).click();
  const inPoint=$("[data-clip-point=start]");
  inPoint.value="2";inPoint.dispatchEvent(new Event("change"));
  const currentOut=$("[data-clip-point=end]");currentOut.value="7";currentOut.dispatchEvent(new Event("change"));
  switchVersion(avVideo,1);switchVersion(avAudio,1);selectOnly(avTarget.id);
  const avRequest=videoReq(avTarget,fullPrompt(avTarget));`);
 equal(evaluate('[avRequest.prompt,avTarget.data.provider,avRequest.video_refs[0].ref,avRequest.video_refs[0].start,avRequest.video_refs[0].end,avRequest.audio_refs[0].ref]'),
 ["按@音1 与@视频1","multimodal-qa","output:h3studio/move-old.mp4",2,7,"output:h3studio/bell-old.wav"],
 'combined references keep the chosen versions, clip range and compatible service');
 evaluate('selectCanvasModel("seedance-2")');
 equal(evaluate('[referenceDuration(avTarget),videoDraftAvailable(avTarget)]'),[15,false],
  'reference model drives duration and draft availability');
 evaluate(`const avGuide=addNode("video",100,850,{}, {name:"白模动作",versions:[copyAsset("guide.mp4",{source:"previs",seconds:4,w:640,h:480})],cur:0});
  B.edges.push({from:avGuide.id,to:avTarget.id,relation:"previs",ref:curV(avGuide).ref});drawEdges();`);
 equal(evaluate('videoReq(avTarget,fullPrompt(avTarget)).prompt'),"按@音1 与@视频2",'video reference numbering accounts for a whitebox guide');
 evaluate('cutEdge(audioInputs(avTarget)[0].edge)');
 equal(evaluate('videoReq(avTarget,fullPrompt(avTarget))'),null,'a removed audio edge cannot silently change the reference');
 evaluate('delete window.__capabilities;CAPS_LIST.audio_reference=capsBeforeAV.audio;CAPS_LIST.previs=capsBeforeAV.video;restore(avPromptBase)');
 console.log('Multimodal mention DOM passed: clip and sound selection, pinned media, trimming, routing, guide numbering and detached tokens.');
};
