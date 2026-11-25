"use strict";

module.exports = async function previsLightingAndExport(workspace, scenarioState) {
 const { assert, equal, evaluate, jobs, ready, w } = workspace;
 const litGlb=evaluate('pvGlb(lightProof,0,"灯光验证")');
 const lightingBytes=Buffer.from(await new Promise((resolve,reject)=>{
  const reader=new w.FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);
  reader.readAsArrayBuffer(litGlb);
 }));
 const lightingJsonLength=lightingBytes.readUInt32LE(12);
 const lightingJson=JSON.parse(lightingBytes.toString("utf8",20,20+lightingJsonLength));
 const lightingAccessor=lightingJson.accessors[lightingJson.meshes[0].primitives[0].attributes.COLOR_0];
 const lightingView=lightingJson.bufferViews[lightingAccessor.bufferView];
 const faceStart=28+lightingJsonLength+(lightingView.byteOffset||0)+6*3*4;
 for(const [i,channel] of [182,152,125].entries()){
  const linear=((channel/255+.055)/1.055)**2.4;
  assert.ok(Math.abs(lightingBytes.readFloatLE(faceStart+i*4)-linear)<1e-6,'GLB preserves the lit face at the exported frame');
 }
 evaluate('chooseLight("off")');
 equal(evaluate('[PV.editor.scene.lighting,$("[data-pv-light-fields]").hidden]'),[null,true]);
 evaluate('chooseLight("back");updatePvLight("azimuth",0);updatePvLight("elevation",0);updatePvLight("key",.6);updatePvLight("ambient",.2)');
 evaluate('pvHeight.value="7";pvHeight.dispatchEvent(new Event("change"));$("[data-pv-render]").click()');
 await ready('previsNode.versions.length===2','re-render remains on the same node',300);
 equal(evaluate('previsNode.versions[1].previs_recipe.lighting'),{azimuth:0,elevation:0,key:.6,ambient:.2,tone:"warm"});
 evaluate('$("[data-pv-close]").click();switchVersion(previsNode,0);openPrevis(previsNode)');
 assert.equal(evaluate('PV.editor.scene.lighting'),undefined,'the old render tab uses its original default lighting');
 equal(evaluate('PV.editor.scene.camera.find(x=>x.t===48).y'),5,'opening a prior tab restores the scene used for that render');
 evaluate(`CAPS_LIST.previs=[{id:"test-ark",name:"方舟测试",model:"ep-test"}];$("[data-pv-use]").click();
   const formal=[...sel].map(node)[0]; formal.data.prompt="跟拍人物走进花园";link(node("n1"),formal);`);
 equal(evaluate('videoReq(formal,formal.data.prompt).previs_guide.ref'), 'output:h3studio/previs1.mp4','formal video uses the displayed render');
 equal(evaluate('[formal.data.aspect,formal.data.provider,videoReq(formal,formal.data.prompt).images[0].role]'),['9:16','test-ark','subject'],'inherits framing and uses pictures as visual references');
 evaluate('switchVersion(previsNode,1)');
 equal(evaluate('videoReq(formal,formal.data.prompt).previs_guide.ref'), 'output:h3studio/previs1.mp4','upstream tab switch keeps the pinned version');
 evaluate('$("[data-previs-update]").click()');
 equal(evaluate('videoReq(formal,formal.data.prompt).previs_guide.ref'), 'output:h3studio/previs2.mp4','explicit update selects the current upstream version');
 const beforeFormalFetch=w.fetch;
 let formalRequest;
 w.fetch=async(url,opts)=>{
  if(String(url)!=='/api/generate')return beforeFormalFetch(url,opts);
  formalRequest=JSON.parse(opts.body);
  jobs.set('formal-test',{state:'done',meta:{model:'ep-test'},outputs:[{ref:'output:h3studio/formal.mp4',url:'/media?ref=output:h3studio/formal.mp4'}]});
  return {ok:true,text:async()=>JSON.stringify({ids:['formal-test']})};
 };
 evaluate('$("#send").click()');
 await ready('formal.versions.length===1','formal video is appended to the downstream node',300);
 w.fetch=beforeFormalFetch;
 equal([formalRequest.provider,formalRequest.previs_guide.version],['test-ark',2],'generation submits the pinned reference and selected model service');
 equal(evaluate('formal.versions[0].generation_record.inputs.at(-1).role'),'previs','generation receipt identifies the whitebox guide');
 equal(evaluate('formal.versions[0].input_edges.find(e=>e.relation==="previs").ref'), 'output:h3studio/previs2.mp4','version retains the guide connection');
 evaluate(`const reuse=addNode("video",1800,100,{prompt:"复用原来的设置",duration:8});openAddMenu(80,90,{to:reuse});$("#addMenu [data-previs-menu] button").click();`);
 equal(evaluate('[reuse.data.prompt,reuse.data.duration,previsInput(reuse).edge.ref]'),['复用原来的设置',8,'output:h3studio/previs2.mp4'],'an existing video can receive a guide with its settings intact');
 assert.equal(evaluate('vtSplit(previsNode.id,1)'),true);
 equal(evaluate('[previsInput(formal).version.ref,previsInput(formal).source.id===previsNode.id,formal.versions[0].video_recipe.previs_guide.node_id===previsInput(formal).source.id]'),
   ['output:h3studio/previs2.mp4',false,true],'splitting the source tab retargets the guide and preserves its exact media');
 evaluate(`const sceneOwner=previsInput(formal).source;AC.board=boardId;
   $("#acMessages").insertAdjacentHTML("beforeend",acResultCards({previs_node:sceneOwner.id,nodes:[{id:sceneOwner.id,type:"video",ref:curV(sceneOwner).ref}]}));
   $("#acMessages [data-previs-open]").click();`);
 equal(evaluate('PV.editor.n.id===sceneOwner.id && PV.editor.scene.camera.find(k=>k.t===48).y===7'),true,'assistant result opens the rendered scene version');
 evaluate(`const remoteBoard=acClone(B);remoteBoard.nodes.find(n=>n.id===sceneOwner.id).data.previs.camera[0].y=4;acApplyBoard(remoteBoard);`);
 equal(evaluate('PV.editor.scene.camera[0].y'),4,'untouched scene follows a remote edit');
 evaluate(`PV.editor.scene.camera[0].y=5;const advancedBoard=acClone(B);
   advancedBoard.nodes.find(n=>n.id===sceneOwner.id).data.previs.camera[0].y=6;acApplyBoard(advancedBoard);
   $("[data-pv-close]").click();`);
 equal(evaluate('[$("#previsEditor").open,$("[data-pv-discard]").hidden,sceneOwner.data.previs.camera[0].y]'),[true,false,6],'conflicting manual edits cannot overwrite the assistant result');
 evaluate('$("[data-pv-discard]").click()');
 const previsStoryFetch=w.fetch, previsStoryUploads=[];
 let failPrevisStoryUpload=true;
 w.fetch=(url,options)=>{
  const name=String(url)==='/api/upload' && options?.body?.get('image')?.name;
  if(name?.startsWith?.('白模镜头-')){
   previsStoryUploads.push(name);
   if(failPrevisStoryUpload && name.endsWith('-02.png')){
    return Promise.resolve({ok:false,json:async()=>({error:'上传暂时失败'})});
   }
  }
  return previsStoryFetch(url,options);
 };
 equal(evaluate('pvStoryboardBoundaries(pvInitialScene())'),[0,96],'a continuous preview still produces one shot');
 evaluate(`openPrevis(sceneOwner);
   const pvStoryScene=PV.editor.scene,pvStoryEnd=pvStoryScene.duration*PV_FPS;
   pvStoryScene.camera[0].ease="cut";
   pvStoryScene.camera.splice(1,0,{...pvStoryScene.camera[0],t:31,x:3});
   pvStoryScene.camera.push({...pvStoryScene.camera.at(-1),t:pvStoryEnd,ease:"cut"});
   pvCommit(PV.editor);
   closePrevis();
   const pvChatCard={board:boardId,node:sceneOwner.id,name:sceneOwner.name,aspect:pvStoryScene.aspect,fps:PV_FPS,boundaries:[0,31,pvStoryEnd]};
   $("#acMessages").insertAdjacentHTML("beforeend",acResultCards({previs_storyboard_plan:pvChatCard}));
   const pvChatButton=$("[data-open-previs-storyboard]",$("#acMessages"));
   pvChatButton.dataset.openPrevisStoryboard=JSON.stringify({...pvChatCard,boundaries:[0,35,pvStoryEnd]});
   pvChatButton.click();`);
 equal(evaluate('!!PV.editor'),false,'an old assistant plan does not open after the cuts change');
 assert.match(evaluate('pvChatButton.closest("section").textContent'),/0–1\.29 秒 · 1\.29 秒/);
 evaluate('pvChatButton.dataset.openPrevisStoryboard=JSON.stringify(pvChatCard);pvChatButton.click()');
 equal(evaluate('PV.editor.n.id'),evaluate('sceneOwner.id'),'the current assistant plan opens the source editor');
 assert.equal(previsStoryUploads.length,0,'opening the plan submits no work');
 evaluate(`
   const pvStoryBefore=[B.nodes.length,B.edges.length,undoStack.length];
   const pvStoryPainter=pvPaint,pvCapturedPoses=[];
   pvPaint=(canvas,scene,tick,...rest)=>{
    if(canvas!==$("#previsEditor canvas"))pvCapturedPoses.push([tick,pvSample(scene.camera,tick).x]);
    pvStoryPainter(canvas,scene,tick,...rest);
   };
   const pvStoryView=$("[data-pv-view]");pvStoryView.value="plan";pvStoryView.dispatchEvent(new Event("change"));
   $("[data-pv-storyboard]").click();`);
 await ready('!PV.editor.sending && $("[data-pv-status]").textContent==="上传暂时失败"','failed upload leaves the storyboard retryable');
 scenarioState.beforePrevisStory = Array.from(evaluate('pvStoryBefore'));
 equal(evaluate('[B.nodes.length,B.edges.length,undoStack.length]'),scenarioState.beforePrevisStory,'failed upload creates no partial canvas nodes');
 failPrevisStoryUpload=false;
 evaluate('$("[data-pv-storyboard]").click()');
 await ready('!PV.editor.sending && B.nodes.some(n=>n.data.previs_source===sceneOwner.id)','cut export creates an editable storyboard');
 equal(previsStoryUploads,['白模镜头-01.png','白模镜头-02.png','白模镜头-02.png'],'retry reuses successfully uploaded stills');
 equal(evaluate('pvCapturedPoses'),[[0,5],[31,3],[31,3]],'stills use each new camera pose even from overhead layout');
 evaluate('pvPaint=pvStoryPainter');
 w.fetch=previsStoryFetch;
 equal(evaluate(`const pvStoryboard=B.nodes.find(n=>n.data.previs_source===sceneOwner.id);
   [pvStoryboard.data.shots.map(s=>s.previs_range),$$(".du",els.get(pvStoryboard.id)).map(e=>e.textContent),
   pvStoryboard.data.made.map(({img,vid},i)=>{const first=videoReq(node(vid),"").images[0];return [
     curV(node(img)).source,first.ref===pvStoryboard.data.shots[i].frame.ref,first.time,
     B.edges.find(e=>e.from===img&&e.to===vid).role,node(vid).data.duration];}),
   undoStack.length-pvStoryBefore[2]]`),
   [[[0,31],[31,96]],['1.29s','2.71s'],[['previs-frame',true,0,'first',5],['previs-frame',true,0,'first',5]],1],
   'each shot retains its original preview timing, generation duration, and first-frame connection');
 evaluate(`$("[data-pv-close]").click();openScriptShotRangeRun(pvStoryboard,0,1,"missing_video");`);
 assert.match(evaluate('$("#groupRunConfirm ol").textContent'),/白模 1\.29 秒 · 视频设定 5 秒/);
 assert.match(evaluate('$("#groupRunConfirm ol").textContent'),/首帧仍为白模/);
 assert.match(evaluate('$("#groupRunConfirm ol").textContent'),/首帧 · 版本 1（当前） · 白模草稿/);
 evaluate(`closeCanvasGroupRunDialog();
  const pvLayoutImage=node(pvStoryboard.data.made[0].img),pvLayoutVideo=node(pvStoryboard.data.made[0].vid);
  const pvWhitebox=curV(pvLayoutImage).ref;
  pvLayoutImage.data.prompt="以 @图{3} 的角色为主角，写实夜景";
  pvLayoutVideo.data.fields.action="角色走进画面";
  B.edges.push({from:"n1",to:pvLayoutImage.id,prompt_slot:3});
  selectOnly(pvLayoutImage.id);`);
 assert.equal(evaluate('$("[data-previs-composition]").getAttribute("aria-pressed")'),'true');
 equal(evaluate(`const occupiedRefs=Array.from({length:9},(_,i)=>"ref-"+i), pvGuide=previsComposition(pvLayoutImage);
  [previsCompositionHasRoom(pvLayoutImage,pvGuide,occupiedRefs),
   previsCompositionHasRoom(pvLayoutImage,pvGuide,[...occupiedRefs.slice(0,8),pvGuide.ref])]`),
  [false,true],'a local recipe must leave space for the composition unless it is already one of the inputs');
 evaluate('$("[data-previs-composition]").click()');
 assert.equal(evaluate('storyboardFrameReady(pvLayoutImage)'),true,'the whitebox can be adopted directly by disabling replacement');
 evaluate(`undo();
  const pvLayoutImageId=pvLayoutImage.id,pvLayoutVideoId=pvLayoutVideo.id;
  openScriptShotRun(node(pvStoryboard.id),0);`);
 assert.match(evaluate('$("#groupRunConfirm ol").textContent'),/白模构图固定参考/);
 assert.match(evaluate('$("#groupRunConfirm ol").textContent'),/首帧 · 本轮生成/);
 const previsGenerationFetch=w.fetch, previsGenerated=[];
 w.fetch=(url,options)=>{
  if(String(url)!=='/api/generate')return previsGenerationFetch(url,options);
  const request=JSON.parse(options.body), id='previs-composition-'+request.kind;
  const ref='output:h3studio/'+id+(request.kind==='image'?'.png':'.mp4');
  previsGenerated.push(request);
  jobs.set(id,{state:'done',meta:{seed:42},outputs:[{ref,url:'/media?ref='+encodeURIComponent(ref),meta:{width:405,height:720}}]});
  return Promise.resolve({ok:true,text:async()=>JSON.stringify({ids:[id]})});
 };
 evaluate('$("#groupRunConfirm [type=submit]").click()');
 await ready('groupRun?.steps.length===2 && !groupRun.active','the storyboard converts the whitebox then submits the video',1000);
 w.fetch=previsGenerationFetch;
 assert.equal(previsGenerated.length,2);
 assert.deepEqual(previsGenerated[0].images.map(item=>item.ref),Array.from(evaluate('[curV(node("n1")).ref,pvWhitebox]')));
 assert.match(previsGenerated[0].prompt,/以 @图1 的角色/);
 assert.match(previsGenerated[0].prompt,/按 @图2 的机位/);
 assert.equal(previsGenerated[1].images[0].ref,'output:h3studio/previs-composition-image.png');
 equal(evaluate(`const pvFinalImage=node(pvLayoutImageId);
  [pvFinalImage.versions.map(version=>version.source),previsComposition(pvFinalImage).ref,
   curV(pvFinalImage).generation_record.inputs.at(-1).version,storyboardFrameReady(pvFinalImage)]`),
  [['previs-frame','gen'],evaluate('pvWhitebox'),1,true],'the finished picture preserves the original whitebox tab and generation receipt');
 evaluate(`$("#groupRunProgress [data-dismiss]").click();
  const pvEditScript=node(pvStoryboard.id), pvEditVideo=node(pvEditScript.data.made[1].vid);
  curV(node(pvLayoutVideoId)).seconds=5.2;
  pvEditVideo.versions=[{ref:"output:h3studio/short-whitebox-take.mp4",seconds:2.25,w:405,h:720}];pvEditVideo.cur=0;
  openStoryFilm(pvEditScript,0,1,"fade");$("#fmV").onloadedmetadata?.();`);
 equal(evaluate(`[FILM.spec.clips.map(c=>[c.out*FILM_FPS,c.story_frames,c.trans,c.tight]),$("#fmTotal").textContent]`),
  [[[31,31,"cut",true],[54,65,"cut",true]],"2 段 · 3.54 秒"],'the new cut preserves planned frames and clamps a short original');
 evaluate('$("[data-a=reset]",$("#fmClip")).click()');
 assert.equal(evaluate('FILM.spec.clips[0].out'),null,'full-length playback is still available');
 evaluate('$("[data-a=story-length]",$("#fmClip")).click();selectClip(1);$("#fmV").onloadedmetadata?.()');
 assert.equal(evaluate('FILM.spec.clips[0].out*FILM_FPS'),31);
 assert.match(evaluate('$("#fmClip").textContent'),/素材时长不足/);
 evaluate(`const slowPreview=$("#fmSlowdownDialog"), slowClip=FILM.spec.clips[1];
  const slowOriginal=JSON.stringify(slowClip), openSlow=()=>$("[data-story-slowdown]",$("#fmClip")).click();
  const applySlow=()=>$("form",slowPreview).dispatchEvent(new Event("submit",{cancelable:true}));
  openSlow();$("video",slowPreview).onloadedmetadata();`);
 assert.match(evaluate('$("[data-slowdown-result]",slowPreview).textContent'),/2\.25 秒素材，以 0\.831 倍速播放 2\.71 秒/);
};
