"use strict";

module.exports = async function imageEditingAndFullscreenMedia(workspace) {
 const { assert, equal, evaluate, jobs, ready, w } = workspace;
 equal(evaluate(`(()=>{
  const lightSample={width:3,height:1,data:new Uint8ClampedArray([100,100,100,255,100,100,100,140,100,100,100,255])};
  const neutral={x:-100,y:0,key:0,exposure:0,temperature:0,rim:0};
  const unchanged=structuredClone(lightSample);
  relightApply(unchanged,relightMap(lightSample,neutral),0);
  const left=structuredClone(lightSample), right=structuredClone(lightSample);
  relightApply(left,relightMap(lightSample,{...neutral,key:80}),60);
  relightApply(right,relightMap(lightSample,{...neutral,key:80,x:100}),-60);
  const front=relightMap(lightSample,{...neutral,key:80,depth:100});
  const back=relightMap(lightSample,{...neutral,key:80,depth:-100});
  return [unchanged.data.every((v,i)=>v===lightSample.data[i]),left.data[0]>left.data[8],right.data[0]<right.data[8],
   left.data[0]>left.data[2],right.data[0]<right.data[2],left.data[7],right.data[7],front.field[1]>back.field[1]];
 })()`),[true,true,true,true,true,140,140,true],'relighting changes position, depth and temperature while retaining alpha');
 await evaluate(`const sourcePortrait=addNode("image",200,300,{}, {name:"布光原图",versions:[copyAsset("portrait.png",{w:512,h:384})],cur:0});
  nodeAction(sourcePortrait,"relight")`);
 assert.equal(evaluate('IMAGE_EDITOR.mode'),'relight');
 evaluate(`(()=>{const c=$(".ie-canvas"),{tx,ty,scale}=IMAGE_EDITOR.view,r=c.getBoundingClientRect();
  const pointer=(type,x,y)=>c.dispatchEvent(new MouseEvent(type,{button:0,clientX:r.left+tx+x*scale,clientY:r.top+ty+y*scale}));
  pointer("pointerdown",256,192);pointer("pointermove",384,96);pointer("pointerup",384,96);
 })()`);
 equal(evaluate('[$("#ieLightX").value,$("#ieLightY").value]'),['50','-50'],'dragging the light uses image coordinates');
 evaluate(`$("#ieLightX").value="65";$("#ieLightX").dispatchEvent(new Event("input",{bubbles:true}));
   $("#ieLightTemperature").value="-50";$("#ieLightTemperature").dispatchEvent(new Event("input",{bubbles:true}));
   $("#ieLightDepth").value="-75";$("#ieLightDepth").dispatchEvent(new Event("input",{bubbles:true}));`);
 assert.equal(evaluate('$("#ieLightXValue").textContent'),'65');
 equal(evaluate('[$("#ieLightTemperatureValue").textContent,$("#ieLightDepthValue").textContent]'),['7550 K','后方 75%']);
 evaluate('$("#ieSaveLight").click()');
 await ready('sourcePortrait.versions.length===2 && !IMAGE_EDITOR.loading && !IMAGE_EDITOR.busy','the adjusted image is saved on the source node');
 equal(evaluate('[sourcePortrait.cur,curV(sourcePortrait).w,curV(sourcePortrait).h,curV(sourcePortrait).edit.source,curV(sourcePortrait).edit.light.x]'),
  [1,512,384,'output:h3studio/portrait.png',65]);
 await evaluate('$("#ieReuse").onclick()');
 equal(evaluate('[IMAGE_EDITOR.mode,sourcePortrait.cur,$("#ieLightX").value,$("#ieLightTemperature").value,$("#ieLightDepth").value]'),
  ['relight',0,'65','-50','-75']);
 evaluate('$("#ieRelightAI").click()');
 equal(evaluate('[IMAGE_EDITOR.mode,$("#ieAI").hidden,$("#ieSaveLight").hidden,$("#ieExportLight").hidden]'),['relight_ai',false,true,true]);
 assert.equal(evaluate('sourcePortrait.versions.length'),2,'preparing AI guidance does not submit a generation');
 const relightFetch=w.fetch;
 let modelLightRequest;
 w.fetch=async(url,options={})=>{
  if(String(url)!=='/api/image-edit/generate')return relightFetch(url,options);
  modelLightRequest=JSON.parse(options.body);
  const id='model-relight-qa', output=copyOutputForRelight(modelLightRequest);
  jobs.set(id,{state:'done',meta:{mode_name:'图片重新布光'},outputs:[output]});
  return {ok:true,text:async()=>JSON.stringify({ids:[id]})};
 };
 const copyOutputForRelight=recipe=>({ref:'output:h3studio/model-relight.png',url:'/media?ref=output:h3studio/model-relight.png',
  meta:{width:512,height:384},extra:{source:'edit',edit:{mode:'whole',source:recipe.ref,recipe}}});
 evaluate('$("#iePrompt").value=""');
 await evaluate('ieGenerate()');
 await ready('sourcePortrait.versions.length===3 && !IMAGE_EDITOR.loading && !sourcePortrait.job','structured model lighting saves a version');
 assert.deepEqual([modelLightRequest.mode,modelLightRequest.backend,modelLightRequest.relight.depth,modelLightRequest.relight.temperature],
  ['whole','h3',-75,-50]);
 await evaluate('$("#ieReuse").onclick()');
 equal(evaluate('[IMAGE_EDITOR.mode,relightSettings().depth,relightSettings().temperature]'),['relight_ai',-75,-50]);
 evaluate(`$("#ieRelightAI").click();
   const portraitBeforeExport=JSON.stringify(sourcePortrait), nodeCountBeforeRelight=B.nodes.length;
   $("#ieExportLight").click();`);
 await ready('B.nodes.length===nodeCountBeforeRelight+1 && !IMAGE_EDITOR.busy && !$("#ieLocateLight").hidden',
  'manual relighting exports a new canvas node from the editor');
 equal(evaluate(`(()=>{
   const exported=node(IMAGE_EDITOR.lightExportId), version=curV(exported);
   return [JSON.stringify(sourcePortrait)===portraitBeforeExport,IMAGE_EDITOR.mode,exported.type,
     version.w,version.h,version.edit.source,version.edit.light.depth,version.edit.light.temperature];
 })()`),[true,'relight','image',512,384,'output:h3studio/portrait.png',-75,-50]);
 evaluate(`const lightExportId=IMAGE_EDITOR.lightExportId;$("#ieLocateLight").click();`);
 equal(evaluate('[IMAGE_EDITOR===null,[...sel]]'),[true,[evaluate('lightExportId')]]);
 evaluate('undo()');
 equal(evaluate('[!node(lightExportId),B.nodes.length===nodeCountBeforeRelight]'),[true,true]);
 w.fetch=relightFetch;
 console.log('Image relighting passed: alpha, in-place save, separate export, canvas location, undo and AI handoff.');
 const originalCameraFetch=w.fetch;
 let cameraRequest;
 w.fetch=async(url,options={})=>{
  if(String(url)!=='/api/image-edit/generate')return originalCameraFetch(url,options);
  cameraRequest=JSON.parse(options.body);
  const id='camera-view-qa', results=Array.from({length:cameraRequest.count},(_,i)=>({
   ref:`output:h3studio/angle-${i}.png`,url:`/media?ref=output:h3studio/angle-${i}.png`,meta:{width:512,height:384},
   extra:{source:'edit',edit:{mode:'whole',source:cameraRequest.ref,recipe:cameraRequest}},
  }));
  jobs.set(id,{state:'done',meta:{mode_name:'图片换机位',seed:24},outputs:results});
  return {ok:true,text:async()=>JSON.stringify({ids:[id]})};
 };
 await evaluate(`const cameraPortrait=addNode("image",200,600,{}, {name:"机位原图",versions:[copyAsset("original-angle.png",{w:512,h:384})],cur:0});
  nodeAction(cameraPortrait,"image-camera")`);
 equal(evaluate('[IMAGE_EDITOR.mode,$("#ieBlend").hidden,$("#ieBackend").hidden]'),['camera',true,true]);
 evaluate(`const orbit=$(".ie-camera-orbit");
  const orbitPointer=(type,x,y)=>orbit.dispatchEvent(new MouseEvent(type,{clientX:x,clientY:y,button:0,bubbles:true}));
  orbitPointer("pointerdown",120,120);orbitPointer("pointermove",140,100);orbitPointer("pointerup",140,100);`);
 equal(evaluate('[imageCameraSettings().yaw,imageCameraSettings().pitch,$(".ie-camera-height").hidden]'),[75,20,false]);
 evaluate('orbitPointer("pointerdown",140,100);orbitPointer("pointermove",100,140);orbitPointer("pointercancel",100,140)');
 equal(evaluate('[imageCameraSettings().yaw,imageCameraSettings().pitch]'),[75,20],'cancelled orbit drag restores the starting pose');
 evaluate(`$("[data-camera-preset='2']").click();orbitPointer("pointerdown",120,120);orbitPointer("pointermove",120,100);orbitPointer("pointerup",120,100);`);
 equal(evaluate('[imageCameraSettings().yaw,imageCameraSettings().pitch]'),[180,20],'vertical drag preserves the rear heading');
 evaluate(`$("#ieCamSensor").value="s35";$("#ieCamOptics").value="anamorphic";$("#ieCamAperture").value="2.8";
  $("[data-camera-preset='0']").click();$("#ieCamPitch").value="25";$("#ieCamPitch").dispatchEvent(new Event("input"));
  $("#ieCamDistance").value="-40";$("#ieCamLens").value="18";$("#ieCamCount").value="3";`);
 assert.match(evaluate('$(".ie-camera-orbit").getAttribute("aria-label")'),/左环绕 90°.*俯拍 25°/);
 await evaluate('ieGenerate()');
 await ready('cameraPortrait.versions.length===4 && !IMAGE_EDITOR.loading && !cameraPortrait.job','three generated views appear on the same image node',300);
 equal([cameraRequest.mode,cameraRequest.backend,cameraRequest.count,cameraRequest.prompt,cameraRequest.camera_view],
  ['whole','h3',3,'',{yaw:-90,pitch:25,distance:-40,framing:'中景',lens:18,sensor:'s35',optics:'anamorphic',aperture:'2.8'}]);
 assert.equal(evaluate('cameraPortrait.versions[0].ref'),cameraRequest.ref);
 await evaluate('$("#ieReuse").onclick()');
 equal(evaluate('[IMAGE_EDITOR.mode,curV(cameraPortrait).ref,imageCameraSettings(),$("#ieCamCount").value]'),
  ['camera',cameraRequest.ref,cameraRequest.camera_view,'3']);
 evaluate('closeImageEditor();selectOnly(cameraPortrait.id);openAngle(cameraPortrait);$("#agLens").value="135";$("#agLens").dispatchEvent(new Event("input"));$("#agOk").click()');
 assert.match(evaluate('cameraPortrait.data.prompt'),/135 mm/);
 w.fetch=originalCameraFetch;
 console.log('Image camera tools passed: presets, camera preview controls, candidate versions, saved recipes and legacy prompts.');
 const opticFetch=w.fetch;
 let opticRequest;
 w.fetch=(url,options)=>{
  if(String(url)!=="/api/generate")return opticFetch(url,options);
  opticRequest=JSON.parse(options.body);
  const ref="output:h3studio/new-lens.mp4";
  jobs.set("video-optics-job",{state:"done",outputs:[{ref,url:"/media?ref="+encodeURIComponent(ref),meta:{width:640,height:480,duration:5}}]});
  return Promise.resolve({ok:true,text:async()=>JSON.stringify({ids:["video-optics-job"]})});
 };
 evaluate(`const opticalNode=addNode("video",2600,100,{prompt:"列车靠站"},{versions:[
    copyAsset("old-lens.mp4",{seconds:5}),copyAsset("older-no-snapshot.mp4",{seconds:5})],cur:0});
  selectOnly(opticalNode.id);$("#videoOpticsBtn").click();
  $('[data-video-optics-preset="1"]').click();$("#videoOptics [name=optics]").value="anamorphic";
  $("#videoOptics [type=submit]").click();`);
 equal(evaluate('[opticalNode.data.video_optics,opticalNode.data.prompt,$("#videoOptics").open]'),
  [{lens:85,sensor:'full-frame',optics:'anamorphic',aperture:'2'},'列车靠站',false]);
 await evaluate('generate(opticalNode)');
 await ready('opticalNode.versions.length===3 && !opticalNode.job','video optics request produces a new canvas version',350);
 assert.deepEqual(opticRequest.video_optics,{lens:85,sensor:'full-frame',optics:'anamorphic',aperture:'2'});
 equal(evaluate('[curV(opticalNode).video_recipe.video_optics,curV(opticalNode).generation_record.video_optics]'),
  [opticRequest.video_optics,opticRequest.video_optics]);
 evaluate('switchVersion(opticalNode,0)');
 assert.equal(evaluate('!!opticalNode.data.video_optics'),false,'selecting a legacy version restores its original settings');
 evaluate('switchVersion(opticalNode,2);switchVersion(opticalNode,1)');
 assert.equal(evaluate('!!opticalNode.data.video_optics'),false,'an older version without a snapshot does not inherit optics from another take');
 evaluate('switchVersion(opticalNode,2);$("#videoOpticsBtn").click()');
 equal(evaluate('$$("select",$("#videoOptics")).map(select=>select.value)'),['85','full-frame','anamorphic','2']);
 evaluate('$("#videoOptics [data-reset]").click();$("#videoOptics [type=submit]").click()');
 assert.equal(evaluate('!!videoReq(opticalNode,fullPrompt(opticalNode)).video_optics'),false,'clearing does not carry optics into the next submission');
 w.fetch=opticFetch;
 console.log('Video optics DOM passed: presets, request capture, legacy version switching and reset.');
 const oldSizeFetch=w.fetch;
 let pixelExport;
 w.fetch=async(url,options={})=>{
  if(String(url)!=='/api/image-edit/transform')return oldSizeFetch(url,options);
  pixelExport=JSON.parse(options.body);
  const {width:w,height:h}=pixelExport.resize;
  return {ok:true,text:async()=>JSON.stringify({ref:'output:h3studio/resized.png',url:'/media?ref=output:h3studio/resized.png',w,h,resize:pixelExport.resize})};
 };
 await evaluate(`const pixelInput=addNode("image",200,700,{}, {name:"尺寸原图",versions:[copyAsset("pixel-original.png",{w:512,h:384})],cur:0});
  nodeAction(pixelInput,"image-pixels")`);
 equal(evaluate('[IMAGE_EDITOR.mode,$("#iePixelSize").open,pixelSizeSettings()]'),['local',true,{width:512,height:384,fit:'contain'}]);
 evaluate('$("#iePixelWidth").value="100";$("#iePixelWidth").dispatchEvent(new Event("input",{bubbles:true}))');
 assert.equal(evaluate('$("#iePixelHeight").value'),'75');
 evaluate('IMAGE_EDITOR.crop={x:8,y:12,w:256,h:128};ieDraw()');
 assert.equal(evaluate('$("#iePixelHeight").value'),'50','the aspect lock uses the active crop');
 evaluate('$("#iePixelLock").click();$("#iePixelHeight").value="144";$("#iePixelFit").value="cover";$("#iePixelFit").dispatchEvent(new Event("change",{bubbles:true}))');
 equal(evaluate('[pixelSizeSettings(),$("#iePixelPreview").width,$("#iePixelPreview").height]'),[{width:100,height:144,fit:'cover'},100,144]);
 await evaluate('closeImageEditor();openImageEditor(pixelInput)');
 equal(evaluate('[$("#iePixelSize").open,$("#iePixelLock").checked,pixelSizeSettings()]'),[true,false,{width:100,height:144,fit:'cover'}]);
 await evaluate('$("#iePixelSave").onclick()');
 await ready('pixelInput.versions.length===2 && !IMAGE_EDITOR.loading','exact dimensions save into the original node');
 equal([pixelExport.ref,pixelExport.crop,pixelExport.resize],['output:h3studio/pixel-original.png',{x:8,y:12,w:256,h:128},{width:100,height:144,fit:'cover'}]);
 equal(evaluate('[curV(pixelInput).w,curV(pixelInput).h,curV(pixelInput).edit.resize]'),[100,144,{width:100,height:144,fit:'cover'}]);
 evaluate('closeImageEditor()');
 w.fetch=oldSizeFetch;
 console.log('Exact image sizing passed: crop-aware aspect lock, fit preview, draft restore and same-node save.');
 const oldUpscaleFetch=w.fetch;
 let upscaleRequest;
 w.fetch=async(url,options={})=>{
  if(String(url)!=='/api/image-edit/upscale')return oldUpscaleFetch(url,options);
  upscaleRequest=JSON.parse(options.body);
  const ref="output:h3studio/super-resolution.png";
  return {ok:true,text:async()=>JSON.stringify({ref,url:"/media?ref="+encodeURIComponent(ref),w:1024,h:768})};
 };
 await evaluate('switchVersion(pixelInput,0);nodeAction(pixelInput,"image-upscale")');
 await ready(`!$('[data-upscale="2"]').disabled`,'upscale becomes available on the selected historical image');
 equal(evaluate('[IMAGE_EDITOR.mode,$("#ieAI").hidden,$$("[data-upscale]").map(b=>b.textContent)]'),
  ['upscale',true,['2× · 1024 × 768','4× · 2048 × 1536']]);
 await evaluate(`$('[data-upscale="2"]').onclick()`);
 await ready('pixelInput.versions.length===3 && !IMAGE_EDITOR.loading','model upscale is saved as a new image version');
 equal(upscaleRequest,{ref:"output:h3studio/pixel-original.png",scale:2});
 equal(evaluate('[curV(pixelInput).w,curV(pixelInput).h,curV(pixelInput).edit,pixelInput.versions[0].ref]'),
  [1024,768,{source:"output:h3studio/pixel-original.png",mode:"upscale",scale:2,model:"FSRCNN"},"output:h3studio/pixel-original.png"]);
 evaluate('closeImageEditor()');
 w.fetch=oldUpscaleFetch;
 console.log('Model upscale DOM passed: historical source, dimensions, request and non-destructive version save.');
 const decomposeFetch=w.fetch;
 let decomposeRequest;
 w.fetch=async(url,options={})=>{
  if(String(url)!=="/api/image-edit/decompose")return decomposeFetch(url,options);
  decomposeRequest=JSON.parse(options.body);
  const layer=(id,name,x,y,w,h)=>({id,name,x,y,w,h,ref:"output:h3studio/"+id+".png",visible:true,opacity:1});
  const ref="output:h3studio/decomposed.png";
  return {ok:true,text:async()=>JSON.stringify({ref,url:"/media?ref="+encodeURIComponent(ref),w:512,h:384,
    layer_stack:{base_ref:decomposeRequest.ref,layers:[layer("background","背景",0,0,512,384),
      layer("object-1","物体 1",12,14,100,144),layer("object-2","物体 2",170,100,200,150)]}})};
 };
 await evaluate(`const decomposeSource=addNode("image",300,700,{}, {versions:[copyAsset("objects.png",{w:512,h:384})],cur:0});
   nodeAction(decomposeSource,"image-decompose")`);
 await ready('!$("#ieDecompose").disabled','automatic decomposition is available');
 await evaluate('$("#ieDecompose").onclick()');
 equal(decomposeRequest,{ref:"output:h3studio/objects.png"});
 equal(evaluate('[IMAGE_EDITOR.mode,decomposeSource.versions.length,IMAGE_EDITOR.layers.map(layer=>[layer.name,layer.x,layer.y])]'),
   ["layers",2,[["背景",0,0],["物体 1",12,14],["物体 2",170,100]]]);
 evaluate(`$("#ieLayerX").value="188";$("#ieLayerX").dispatchEvent(new Event("change"));closeImageEditor();`);
 await evaluate('openImageEditor(decomposeSource)');
 equal(evaluate('[IMAGE_EDITOR.layers.at(-1).x,curV(decomposeSource).layer_stack.layers.at(-1).x,decomposeSource.versions[0].ref]'),
   [188,170,"output:h3studio/objects.png"]);
 evaluate('closeImageEditor()');
 w.fetch=decomposeFetch;
 console.log('Image decomposition DOM passed: separate layers, source retention and movement draft restore.');
 evaluate(`const previewImage=addNode("image",0,100000,{}, {name:"预览图片",versions:[
   copyAsset("preview-first.png",{generation_record:{prompt:"历史版本 <img src=x>",effective_prompt:"生成时实际使用"},
    memory_used:[{name:"林森 <img src=x>",references:[{view:"face",ref:"input:h3studio/past-face.png"}]}]}),
   copyAsset("preview-current.png",{prompt:"当前版本提示词"})],cur:1});
   const previewAudio=addNode("audio",500,100000,{}, {name:"预览音频",versions:[
   copyAsset("preview-track.wav",{seconds:8}),copyAsset("preview-track-later.wav")],cur:1});
   addNode("text",1000,100000,{text:"历史音轨转写",transcript:{source_node:previewAudio.id,source_ref:previewAudio.versions[0].ref}},{name:"原始旁白"});
   addNode("text",1500,100000,{text:"其他版本转写",transcript:{source_node:previewAudio.id,source_ref:previewAudio.versions[1].ref}},{name:"后续旁白"});
   nodeAction(previewImage,"full");const previewBefore=snap();
   $("[data-light-version]").value="0";$("[data-light-version]").dispatchEvent(new Event("change"));`);
 equal(evaluate('[$("#lightTitle").textContent,$("#light [download]").download,$("#light img").src.includes("preview-first"),snap()===previewBefore]'),
  ['预览图片','preview-first.png',true,true]);
 evaluate('$("[data-light-overview]").click()');
 equal(evaluate('[$$("[data-light-tile]").length,document.activeElement.dataset.lightTile,$("[data-light-tile] img").src.endsWith("preview-first.png")]'),[2,"0",true]);
 evaluate('$$("[data-light-tile]")[1].click();$("[data-light-peek]").dispatchEvent(new KeyboardEvent("keydown",{code:"Backslash",bubbles:true,cancelable:true}))');
 equal(evaluate('[$("#light img.light-peek").src.endsWith("preview-first.png"),$("#light img.light-peek").hidden,previewImage.cur]'),[true,false,1]);
 evaluate('$("[data-light-peek]").dispatchEvent(new KeyboardEvent("keyup",{code:"Backslash",bubbles:true}))');
 assert.equal(evaluate('$("#light img.light-peek").hidden'),true);
 evaluate('$("[data-light-overview]").click();$$("[data-light-tile]")[0].click()');
 evaluate('$("[data-light-compare]").click()');
 equal(evaluate('[$$("#light figure").map(el=>el.textContent.trim()),previewImage.cur]'),[['画布当前版本','预览版本 1'],1]);
 evaluate('$("[data-light-details]").click()');
 equal(evaluate('[$("#lightDetails").hidden,$("#lightDetails pre").textContent,$$("#lightDetails img").length]'),
  [false,'历史版本 <img src=x>',0]);
 equal(evaluate('[$("#lightDetails li").textContent,$("#lightDetails li a").getAttribute("href")]'),
  ['林森 <img src=x> · 正面头肩','/media?ref=input%3Ah3studio%2Fpast-face.png'],
  'generation details link to the exact character angle used by the selected version');
 let copiedPreviewPrompt;
 Object.defineProperty(w.navigator,'clipboard',{configurable:true,value:{writeText:async value=>{copiedPreviewPrompt=value;}}});
 await evaluate('$("[data-light-copy-prompt]").onclick()');
 assert.equal(copiedPreviewPrompt,'历史版本 <img src=x>');
 delete w.navigator.clipboard;
 evaluate('$("[data-light-copy]").click()');
 equal(evaluate('[curV(node([...sel][0])).copied_from.version,previewImage.cur,$(".light-status").textContent]'),[1,1,'已放入画布']);
 assert.equal(evaluate('$("[data-light-locate]").hidden'),false);
 evaluate('const placedPreview=node([...sel][0]);$("[data-light-locate]").click()');
 equal(evaluate('[$("#light").open,sel.has(placedPreview.id),curV(placedPreview).ref]'),[false,true,'output:h3studio/preview-first.png']);
 evaluate('lightbox(previewImage.versions[0],previewImage)');
 evaluate('$("[data-light-close]").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true,cancelable:true}))');
 assert.equal(evaluate('lightState.nodeId'),evaluate('placedPreview.id'));
 evaluate('$("[data-light-close]").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true,cancelable:true}))');
 equal(evaluate('[$("#lightTitle").textContent,!!$("#light audio"),!!$("#light.on")]'),['预览音频',true,true]);
 evaluate('$("[data-light-close]").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');
 assert.equal(evaluate('$("#light").open'),false);
 evaluate('const lightPreviousAccess=B.access;B.access="reviewer";lightbox(previewImage.versions[0],previewImage)');
 equal(evaluate('[!!$("[data-light-copy]"),!!$("#light [download]"),!!$("[data-light-compare]"),!!$("[data-light-edit]")]'),[false,true,true,false]);
 evaluate('lightbox(previewAudio.versions[0],previewAudio);$("[data-light-details]").click()');
 equal(evaluate('[$("#lightDetails").hidden,$$("#lightDetails pre").map(el=>el.textContent),!!$("[data-light-edit]")]'),[false,['历史音轨转写'],false]);
 evaluate('closeLightbox();B.access=lightPreviousAccess;lightbox(previewAudio.versions[0],previewAudio);$("[data-light-edit]").click()');
 equal(evaluate('[$("#audioTranscript").open,$("#audioTranscript audio").src.endsWith("preview-track.wav"),previewAudio.cur]'),[true,true,1]);
 evaluate(`closeAudioTranscript();const previewVideo=addNode("video",1000,100500,{fields:{dialogue:"角色：新版台词"}},{name:"预览视频",versions:[
   copyAsset("preview-video-first.mp4",{seconds:8,w:720,h:1280,prompt:"旧版视频提示词",node_data:{fields:{dialogue:"角色：旧版台词"}},
    memory_used:[{name:"动作设定",references:[{ref:"input:h3studio/source-motion.mp4",type:"video",start:1,end:5},
     {ref:"input:h3studio/source-sound.wav",type:"audio"}]}]}),
   copyAsset("preview-video-current.mp4",{seconds:5,w:720,h:1280})],cur:1});
   lightbox(previewVideo.versions[0],previewVideo);$("[data-light-details]").click()`);
 equal(evaluate('$$("aside#lightDetails li a").map(a=>[a.textContent,a.getAttribute("href")])'),[
  ['参考视频 1–5 秒','/media?ref=input%3Ah3studio%2Fsource-motion.mp4#t=1,5'],
  ['参考音频','/media?ref=input%3Ah3studio%2Fsource-sound.wav'],
 ]);
 evaluate('$("[data-light-edit]").click()');
 equal(evaluate('[FILM.target.ref,FILM.spec.clips[0].ref,FILM.spec.clips[0].media_seconds,FILM.spec.clips[0].subs,previewVideo.cur]'),
  ['output:h3studio/preview-video-first.mp4','output:h3studio/preview-video-first.mp4',8,['旧版台词'],1]);
 const previewRenderFetch=w.fetch;
 let previewRender;
 w.fetch=async (url,options) => {
  const route=String(url);
  if(route==='/api/render/check')return {ok:true,text:async()=>JSON.stringify({ok:true,dimensions:[720,1280]})};
  if(route!=='/api/render')return previewRenderFetch(url,options);
  previewRender=JSON.parse(options.body);
  const id='preview-timeline-result',ref='output:h3studio/preview-timeline.mp4';
  jobs.set(id,{state:'done',outputs:[{ref,url:'/media?ref='+encodeURIComponent(ref),meta:{width:720,height:1280,duration:8}}]});
  return {ok:true,text:async()=>JSON.stringify({ids:[id]})};
 };
 evaluate('$("#fmGo").click()');
 await ready('previewVideo.versions.length===3','export from the historical preview adds a version to the same node',300);
 assert.equal(previewRender.target.ref,'output:h3studio/preview-video-first.mp4');
 assert.equal(previewRender.spec.clips[0].ref,previewRender.target.ref);
 equal(evaluate('[curV(previewVideo).prompt,previewVideo.versions[1].ref]'),
  ['旧版视频提示词','output:h3studio/preview-video-current.mp4']);
 w.fetch=previewRenderFetch;
 evaluate(`closeFilm();lightbox(previewImage.versions[0],previewImage);
   $("[data-light-close]").dispatchEvent(new KeyboardEvent("keydown",{key:"e",bubbles:true}))`);
 await ready('IMAGE_EDITOR?.ref===previewImage.versions[0].ref','image editor loads the explicitly selected version');
 equal(evaluate('[$("#light").open,previewImage.cur]'),[false,0]);
 evaluate('closeImageEditor()');
 console.log('Fullscreen media passed: historical download, still comparison, independent copy, keyboard navigation and reviewer permissions.');
 console.log('Media version details passed: prompt display and copy, source-specific transcript, historical video timeline and image edit handoff.');
};
