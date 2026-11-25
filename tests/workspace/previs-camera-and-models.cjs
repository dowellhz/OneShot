"use strict";

module.exports = async function previsCameraAndModels(workspace, scenarioState) {
 const { assert, equal, evaluate, ready, w } = workspace;
 evaluate(`const qaFrom=addNode("image",100,200),qaTo=addNode("video",500,200,{prompt:"沿河移动"});
  qaFrom.versions=[{...curV(node("n1"))}];qaFrom.cur=0;
  qaTo.versions=[{ref:"output:h3studio/trace.mp4",w:640,h:360,generation_record:{inputs:[{node_id:qaFrom.id,ref:curV(qaFrom).ref,version:1}]}}];qaTo.cur=0;
  B.edges.push({from:qaFrom.id,to:qaTo.id,role:"first"});
  sel=new Set([qaFrom.id,qaTo.id]);updateSel();ctGroup();
  ctxMenu({target:els.get(qaFrom.id),clientX:150,clientY:150});$("#ctxMenu [data-a=template]").click();`);
 await ready('!$("#workflowTemplates").hidden && $("#templateScope").value==="selection" && !$("#templateStatus").textContent','right-click opens a selection template');
 evaluate('$("#templateScope").value="upstream";$("#templateName").value="可复用镜头";$("#templateSave").click()');
 await ready('$("#templateRows strong")?.textContent==="可复用镜头"','selection is saved as a private template');
 assert.equal(scenarioState.workflow.row.nodes,2);
 assert.equal(scenarioState.workflow.includeUpstream,true);
 evaluate('$("#templateRows [data-template-action=preview]").click()');
 await ready('!!$("#templatePreview [data-template-action=confirm]")','private preview opens before sharing');
 assert.equal(evaluate('$("#templatePreview .template-preview-nodes p").textContent'),'沿河移动');
 assert.equal(evaluate('$("#templatePreview video").getAttribute("src")'),'/api/canvas-templates/qa-template/preview/media/1');
 assert.match(evaluate('$("#templatePreview .template-preview-edges summary").textContent'),/首帧 · 版本 1/);
 assert.equal(evaluate('$("#templatePreview .template-preview-edges img").getAttribute("src")'),'/api/canvas-templates/qa-template/preview/media/2');
 evaluate('$("#templatePreview [data-template-action=confirm]").click()');
 assert.equal(evaluate('$("#templatePublishConfirm").hidden'),false);
 assert.equal(scenarioState.workflow.row.published,undefined);
 evaluate('$("#templatePublishConfirm [data-template-action=publish]").click()');
 await ready('$("#templateStatus").textContent==="已加入共享模板库"','explicit sharing adds a saved template to the catalog');
 evaluate('$("#templateRows [data-template-action=replace]").click()');
 equal(evaluate('[$("#templateReplaceShared").hidden,$("#templateForm").checkValidity()]'),[false,false],
  'replacing a shared template requires acknowledging that existing links use the update');
 evaluate('$("#templateReplaceShared input").checked=true;$("#templateSave").click()');
 await ready('$("#templateStatus").textContent==="原模板内容已更新"','the template is updated in place');
 equal(scenarioState.workflow.replacePayload.selected,[evaluate('qaFrom.id'),evaluate('qaTo.id')],'the update uses the selected source nodes');
 assert.equal(scenarioState.workflow.replacePayload.template_updated,1);
 assert.equal(scenarioState.workflow.replacePayload.confirmed_shared,true);
 evaluate('$("#templateRows [data-template-action=history]").click()');
 await ready('!!$(".template-history details")','the author can open template history');
 await evaluate('const oldTemplateDetails=$(".template-history details");oldTemplateDetails.open=true;oldTemplateDetails.ontoggle()');
 assert.match(evaluate('$("[data-version-preview]",oldTemplateDetails).textContent'),/前一版提示词/);
 assert.equal(evaluate('$("form",oldTemplateDetails).checkValidity()'),false);
 evaluate('$("[name=confirm]",oldTemplateDetails).checked=true;$("form button",oldTemplateDetails).click()');
 await ready('$("#templateStatus").textContent==="已还原模板版本"','restoring a shared template uses its current revision and explicit confirmation');
 equal(scenarioState.workflow.restorePayload,{template_updated:2,confirmed_shared:true});
 evaluate('$("#templateScopes [data-scope=catalog]").click()');
 await ready('$("#templateRows article span")?.textContent.includes("创作者")','catalog lists the creator');
 evaluate('$("#templateSearch").value="无匹配";$("#templateSearch").dispatchEvent(new Event("input"))');
 assert.equal(evaluate('$("#templateRows").textContent.includes("没有匹配的模板")'),true);
 evaluate('$("#templateSearch").value="创作者";$("#templateSearch").dispatchEvent(new Event("input"));$("#templateRows [data-template-action=preview]").click()');
 await ready('!!$("#templatePreview [data-template-action=insert]")','matching shared template can be inserted after preview');
 evaluate('$("#templatePreview [data-template-action=favorite]").click()');
 await ready('$("#templatePreview [data-template-action=favorite]")?.getAttribute("aria-pressed")==="true"','template can be favorited from preview');
 evaluate('$("#templateScopes [data-scope=favorites]").click()');
 await ready('$("#templateRows strong")?.textContent==="可复用镜头"','favorites list includes the saved shared template');
 evaluate('$("#templateRows [data-template-action=favorite]").click()');
 await ready('$("#templateRows").textContent.includes("还没有收藏模板")','unfavoriting removes the item from the favorites list');
 evaluate('$("#templateScopes [data-scope=catalog]").click()');
 await ready('!!$("#templateRows [data-template-action=favorite]")','return to the shared template listing');
 evaluate('$("#templateRows [data-template-action=favorite]").click()');
 await ready('$("#templateStatus").textContent==="已收藏模板"','template can also be favorited directly');
 evaluate(`closeWorkflowTemplates();
  const beforeSearchBoard=AC.board;AC.board=boardId;
  acAppendEvent({kind:"tool_start",data:{name:"workflow_template_search",call_id:"template-lookup"}});
  acAppendEvent({kind:"tool_end",data:{name:"workflow_template_search",call_id:"template-lookup",result:{
    workflow_templates:[{id:"qa-template",name:"可复用镜头",scope:"favorites",nodes:2,description:"<雨夜说明>"}]}}});
  const lookup=$('[data-call="template-lookup"] [data-open-workflow-template]');`);
 assert.equal(evaluate('lookup.closest("article").querySelector("p").textContent'),'<雨夜说明>');
 await evaluate('$("#acMessages").onclick({target:lookup})');
 assert.equal(evaluate('$("#templatePreview strong").textContent'),'可复用镜头');
 evaluate(`const fillDraft={id:"qa-template",name:"可复用镜头",scope:"favorites",board:boardId,
   inputs:[{node:qaTo.id,field:"prompt",before:"沿河移动",value:"雨夜沿河推近"}]};
  const appendFill=(id,plan)=>{
   acAppendEvent({kind:"tool_start",data:{name:"workflow_template_plan",call_id:id}});
   acAppendEvent({kind:"tool_end",data:{name:"workflow_template_plan",call_id:id,result:{template_fill_plan:plan}}});
   return $("[data-template-fill-plan]",AC.calls.get(id));
  };
  const outdatedFill=appendFill("stale-template-draft",{...fillDraft,inputs:[{...fillDraft.inputs[0],before:"旧内容"}]});
  const proposedFill=appendFill("template-draft",fillDraft);`);
 await evaluate('$("#acMessages").onclick({target:outdatedFill})');
 assert.match(evaluate('$("#templateStatus").textContent'),/原草稿未填入/);
 await evaluate('$("#acMessages").onclick({target:proposedFill})');
 equal(evaluate(`[ $("#templatePreview .template-inputs").open,
   $$("#templatePreview [data-template-input]").find(input=>input.dataset.templateInput===qaTo.id).value]`),
   [true,'雨夜沿河推近'],'a matching assistant draft opens with editable values prefilled');
 evaluate('AC.board=beforeSearchBoard');
 await ready('!!$("#templateRows [data-template-action=insert]")','favorites can be reused without opening a preview');
 const beforeInsert=evaluate('B.nodes.length');
 evaluate(`const templateEditedPrompt=$$('#templatePreview [data-template-input]').find(input=>input.dataset.templateInput===qaTo.id);
  templateEditedPrompt.value='夜晚沿河移动';
  $('#templatePreview [data-template-action=insert-run]').click();`);
 await ready(`$("#workflowTemplates").hidden && B.nodes.length===${beforeInsert+2}`,'inserting a template creates new nodes');
 equal(evaluate('B.edges.filter(e=>sel.has(e.from)&&sel.has(e.to)).map(e=>e.role)'),['first'],'template edges remap to the inserted nodes');
 equal(evaluate('[...sel].map(node).find(n=>n.type==="video").data.prompt'),'夜晚沿河移动','configured prompt reaches the copied node');
 assert.equal(scenarioState.workflow.copyInputs.length,1);
 assert.equal(scenarioState.workflow.fragment.nodes.find(n=>n.type==='video').data.prompt,'沿河移动','the original saved template keeps its prompt');
 equal(evaluate('sel.has([...sel].map(node).find(n=>n.type==="video").versions[0].generation_record.inputs[0].node_id)'),true,'template remaps the receipts to the copied inputs');
 equal(evaluate('B.groups.some(g=>g.nodes.length===2&&g.nodes.every(id=>sel.has(id)))'),true,'template group remaps to the inserted nodes');
 equal(evaluate(`[$("#groupRunConfirm").open,$("#groupRunConfirm [name=mode]").value,
   $$("#groupRunConfirm li strong").map(item=>item.textContent),B.nodes.some(n=>sel.has(n.id)&&n.job)]`),
   [true,"affected",[evaluate('node([...sel].find(id=>node(id).type==="video")).name')],false],
   'template plan defaults to changed copied nodes and waits for generation approval');
 evaluate('const templateRunMode=$("#groupRunConfirm [name=mode]");templateRunMode.value="all";templateRunMode.dispatchEvent(new Event("change"))');
 equal(evaluate('$$("#groupRunConfirm li strong").map(item=>item.textContent).sort()'),
   [...evaluate('[...sel].map(id=>node(id).name).sort()')],'the all-mode plan cannot pull in original canvas nodes');
 evaluate('closeCanvasGroupRunDialog()');
 evaluate('undo()');
 assert.equal(evaluate('B.nodes.length'),beforeInsert);
 evaluate('openAddMenu(160,120,{at:{x:120,y:100}});$("#addMenu [data-add=previs]").click()');
 assert.equal(evaluate('$("#previsEditor").open'),true);
 const previsMotionFetch=w.fetch, motionRequests=[], routeRequests=[];
 w.fetch=async(url,opts)=>{
  if(String(url)==='/api/previs/object-motion'){
   const request=JSON.parse(opts.body);routeRequests.push(request);
   const [first,last]=request.scene.objects[0].keys;
   return {ok:true,text:async()=>JSON.stringify({keys:[
    first,{...first,t:16,...request.plan.points[0]},
    {...first,t:48,...request.plan.points[1]},last]})};
  }
  if(String(url)!=='/api/previs/camera-motion')return previsMotionFetch(url,opts);
  const request=JSON.parse(opts.body);motionRequests.push(request);
  const start=request.scene.camera[0];
  return {ok:true,text:async()=>JSON.stringify({camera:[start,{...start,t:request.plan.end,x:4,z:6,ease:"smooth"}]})};
 };
 evaluate(`$("[data-pv-motion]").open=true;
  const motionEnd=$("[data-pv-motion-end]");motionEnd.value="2";motionEnd.dispatchEvent(new Event("input"));
  $("[data-pv-motion-apply]").click();`);
 await ready('PV.editor.scene.camera.length===2','the camera motion preset adds editable keyframes');
 equal(motionRequests.map(request=>request.plan),[{mode:'push',start:0,end:48,amount:1,target:'actor'}],
  'camera motion uses the playhead, end time and selected amount');
 assert.match(evaluate('$("[data-pv-status]").textContent'),/已应用推进/);
 equal(evaluate('PV.editor.scene.camera.map(k=>k.t)'),[0,48]);
 evaluate('$("[data-pv-motion-undo]").click()');
 equal(evaluate('PV.editor.scene.camera.map(k=>k.t)'),[0]);
 evaluate(`const routeTrack=$("[data-pv-track]"), routeView=$("[data-pv-view]");
  routeTrack.value="actor";routeTrack.dispatchEvent(new Event("change"));
  $("[data-pv-route-start]").click();
  const routeEnd=$("[data-pv-route-end]");routeEnd.value="2";routeEnd.dispatchEvent(new Event("input"));
  const routeCanvas=$("#previsEditor canvas");
  const routeClick=(x,z)=>{
    const E=PV.editor, box=routeCanvas.getBoundingClientRect();
    const [px,py]=pvPlan(E.scene,E.tick,routeCanvas.width,routeCanvas.height,E.active).point(x,z);
    routeCanvas.onpointerdown({button:0,pointerId:10,clientX:box.left+px*box.width/routeCanvas.width,
      clientY:box.top+py*box.height/routeCanvas.height});
  };
  routeClick(0,1);routeClick(1,1);$("[data-pv-route-pop]").click();routeClick(3,1);
  $("[data-pv-route-apply]").click();`);
 await ready('PV.editor.scene.objects[0].keys.length===4','clicking a route writes editable object keyframes');
 equal(routeRequests.map(request=>request.plan),[{target:'actor',start:0,end:48,points:[{x:0,z:1},{x:3,z:1}]}]);
 equal(evaluate('PV.editor.scene.objects[0].keys.map(k=>[k.t,k.x,k.z])'),
   [[0,-1.7,0],[16,0,1],[48,3,1],[96,1.5,0]]);
 evaluate(`$("[data-pv-route-undo]").click();routeTrack.value="camera";routeTrack.dispatchEvent(new Event("change"));
  routeView.value="camera";routeView.dispatchEvent(new Event("change"));`);
 equal(evaluate('PV.editor.scene.objects[0].keys.map(k=>k.t)'),[0,96]);
 w.fetch=previsMotionFetch;
 evaluate(`const cameraBeforeCut=structuredClone(PV.editor.scene.camera), cutScrub=$("[data-pv-scrub]");
  cutScrub.value=24;cutScrub.dispatchEvent(new Event("input"));
  const cutX=$("[data-owner=camera][data-pv-param=x]");cutX.value=2;cutX.dispatchEvent(new Event("change"));
  cutScrub.value=48;cutScrub.dispatchEvent(new Event("input"));
  $("[data-pv-cut-source]").value="0";$("[data-pv-add-cut]").click();
  const cutFov=$("[data-owner=camera][data-pv-param=fov]");cutFov.value=24;cutFov.dispatchEvent(new Event("change"));`);
 equal(evaluate(`[pvSample(PV.editor.scene.camera,47).x,pvSample(PV.editor.scene.camera,48).x,
  pvSample(PV.editor.scene.camera,47).fov,pvSample(PV.editor.scene.camera,48).fov,
  $("[data-pv-at='48']").textContent]`),[2,5,42,24,"2.00 秒 · 硬切"],"the camera holds the old framing up to the cut");
 w.TextEncoder=TextEncoder;
 const cutBlob=evaluate('pvGlb(PV.editor.scene,48,"切镜验证")');
 const cutBinary=Buffer.from(await new Promise((resolve,reject)=>{
  const reader=new w.FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);
  reader.readAsArrayBuffer(cutBlob);
 }));
 const cutJsonLength=cutBinary.readUInt32LE(12);
 const cutGlb=JSON.parse(cutBinary.toString("utf8",20,20+cutJsonLength));
 const cameraAnimation=cutGlb.animations[0];
 const cameraTrack=cameraAnimation.channels.find(channel=>channel.target.node===0&&channel.target.path==="translation");
 const cameraSampler=cameraAnimation.samplers[cameraTrack.sampler];
 const cameraAccessor=cutGlb.accessors[cameraSampler.output], cameraBuffer=cutGlb.bufferViews[cameraAccessor.bufferView];
 const offsets=28+cutJsonLength+(cameraBuffer.byteOffset||0)+(cameraAccessor.byteOffset||0);
 equal([cameraSampler.interpolation,cutBinary.readFloatLE(offsets+47*12),cutBinary.readFloatLE(offsets+48*12)],
  ['STEP',2,5],'GLB camera animation uses the same cutoff at 24 FPS');
 const objectTrack=cameraAnimation.channels.find(channel=>channel.target.node===1&&channel.target.path==="translation");
 const fovTrack=cameraAnimation.channels.find(channel=>channel.target.path==="pointer");
 equal([cameraAnimation.samplers[objectTrack.sampler].interpolation,cameraAnimation.samplers[fovTrack.sampler].interpolation],
  ['LINEAR','STEP'],'glTF export keeps object motion smooth and applies the cut to focal length too');
 evaluate('PV.editor.scene.camera=cameraBeforeCut;PV.editor.tick=0;pvRefreshTrack(PV.editor)');
 evaluate(`const previsNode=PV.editor.n;const pvScrub=$("[data-pv-scrub]");pvScrub.value=48;pvScrub.dispatchEvent(new Event("input"));
  const pvHeight=$("[data-owner=camera][data-pv-param=y]");pvHeight.value="5";pvHeight.dispatchEvent(new Event("change"));
  const pvAspect=$("[data-pv-aspect]");pvAspect.value="9:16";pvAspect.dispatchEvent(new Event("change"));
  $("[data-pv-render]").click();`);
 await ready('previsNode.versions.length===1','previs job appends a version to the scene node',300);
 assert.equal(w.__previsRequests[0].node,evaluate('previsNode.id'));
 equal(evaluate('previsNode.versions[0].previs_recipe.camera.map(x=>[x.t,x.y])'),[[0,3.2],[48,5]],'scene snapshot stores the camera keyframes');
 equal(evaluate('[$("#previsEditor canvas").width,$("#previsEditor canvas").height]'),[405,720],'portrait preview preserves framing');
 evaluate(`const pvPlanSelect=$("[data-pv-view]");pvPlanSelect.value="plan";pvPlanSelect.dispatchEvent(new Event("change"));
   const pvEncode=HTMLCanvasElement.prototype.toBlob;
   let pvFrameDimensions;
   HTMLCanvasElement.prototype.toBlob=function(callback,mime){pvFrameDimensions=[this.width,this.height,this!==$("#previsEditor canvas"),mime];pvEncode.call(this,callback,mime);};
   $("[data-pv-frame-canvas]").click();`);
 await ready('!PV.editor.sending && [...sel].some(id=>curV(node(id))?.source==="previs-frame")','previs frame creates a selected image node');
 equal(evaluate('[pvFrameDimensions,curV(node([...sel][0])).w,curV(node([...sel][0])).h,PV.editor.tick,previsNode.versions.length]'),
  [[405,720,true,'image/png'],405,720,48,1],'export uses the shot framing and keeps the original timeline and video');
 evaluate('HTMLCanvasElement.prototype.toBlob=pvEncode');
 evaluate(`const pvFreeBefore=structuredClone(PV.editor.scene.camera), pvFreeCanvas=$("#previsEditor canvas");
  const setPvView=value=>{pvPlanSelect.value=value;pvPlanSelect.dispatchEvent(new Event("change"));};
  setPvView("free");
  const freeStart=structuredClone(PV.editor.freeView);
  const freeKey=key=>pvFreeCanvas.dispatchEvent(new KeyboardEvent("keydown",{key,bubbles:true,cancelable:true}));
  const freeDrag=(handler,x,y)=>pvFreeCanvas[handler]({button:0,pointerId:17,clientX:x,clientY:y});
  freeKey("w");freeKey("e");
  freeDrag("onpointerdown",80,90);freeDrag("onpointermove",120,105);freeDrag("onpointerup",120,105);
  const freeShot=structuredClone(PV.editor.freeView);
  const paintBeforeFree=pvPaint;
  let freeCapturePose;
  pvPaint=(canvas,scene,tick,...rest)=>{
    if(canvas!==pvFreeCanvas)freeCapturePose=pvSample(scene.camera,tick);
    paintBeforeFree(canvas,scene,tick,...rest);
  };
  $("[data-pv-free-capture]").click();`);
 assert.equal(evaluate('freeShot.y===freeStart.y+.25 && freeShot.x!==freeStart.x && freeShot.tx!==freeStart.tx && !PV.editor.look'),true);
 await ready('!PV.editor.sending && curV(node([...sel][0]))?.mode==="白模自由视图"','free view saves a separate camera still');
 equal(evaluate(`[JSON.stringify(freeCapturePose)===JSON.stringify(freeShot),
   JSON.stringify(PV.editor.scene.camera)===JSON.stringify(pvFreeBefore),
   JSON.stringify(previsNode.data.previs.camera)===JSON.stringify(pvFreeBefore),PV.editor.tick]`),
  [true,true,true,48],'free view capture does not change authored camera keys or move the playhead');
 evaluate(`pvPaint=paintBeforeFree;
  $("[data-pv-free-reset]").click();
  const freeWasReset=JSON.stringify(PV.editor.freeView)===JSON.stringify(freeStart);
  freeKey("d");freeKey("ArrowLeft");
  const adoptedX=PV.editor.freeView.x,adoptedTarget=PV.editor.freeView.tz;
  $("[data-pv-free-adopt]").click();`);
 equal(evaluate(`[freeWasReset,PV.editor.view,$("[data-pv-free-controls]").hidden,
  PV.editor.scene.camera.find(k=>k.t===48).x===adoptedX,PV.editor.scene.camera.find(k=>k.t===48).tz===adoptedTarget,
  PV.editor.scene.camera[0].x===pvFreeBefore[0].x]`),
  [true,"camera",true,true,true,true],'only explicit adoption writes the free pose into the current camera key');
 evaluate('PV.editor.scene.camera=pvFreeBefore;pvRefreshTrack(PV.editor)');
 evaluate(`const lightPreset=$("[data-pv-light-preset]");
  const chooseLight=value=>{lightPreset.value=value;lightPreset.dispatchEvent(new Event("change"));};
  chooseLight("back");
  const updatePvLight=(field,value)=>{
    const input=$('[data-pv-light-value="'+field+'"]');
    input.value=String(value);input.dispatchEvent(new Event("change"));
  };
  updatePvLight("azimuth",0);updatePvLight("elevation",0);updatePvLight("key",.6);updatePvLight("ambient",.2);
  const expectedPrevisLight={azimuth:0,elevation:0,key:.6,ambient:.2,tone:"warm"};
  const lightProof={duration:2,aspect:"1:1",lighting:expectedPrevisLight,
    camera:[{t:0,x:0,y:1,z:5,tx:0,ty:1,tz:0,fov:42,ease:"linear"}],
    objects:[{id:"box",label:"方块",shape:"box",width:2,height:2,depth:1,
      keys:[{t:0,x:0,y:0,z:0,yaw:0,ease:"linear"}]}]};
  const lightColors=[], polygonBeforeLight=pvPolygon;
  pvPolygon=(_ctx,_points,color)=>lightColors.push(color);
  pvPaint(pvFreeCanvas,lightProof,0);pvPolygon=polygonBeforeLight;`);
 equal(evaluate('[lightPreset.value,$("[data-pv-light-fields]").hidden,PV.editor.scene.lighting,lightColors.includes("rgb(182 152 125)")]'),
  ["custom",false,{azimuth:0,elevation:0,key:.6,ambient:.2,tone:"warm"},true],
  'lighting controls update the actual browser renderer');
};
