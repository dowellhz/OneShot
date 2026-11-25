"use strict";

module.exports = async function imageLayerWorkspace(workspace) {
 const { assert, equal, evaluate, ready, w } = workspace;
 const historyFetch=w.fetch;
 const recoveryItems=[
  {id:'qa-history-image',type:'image',label:'找回海报',width:480,height:800,seed:24,ref:'output:h3studio/recovery-image.png',source:'edit',
   image_edit:{source:'input:h3studio/recovery-source.png',recipe:{ref:'input:h3studio/recovery-source.png',mode:'whole',relight:{depth:-75}},
    layer:{ref:'output:h3studio/recovery-layer.png',w:480,h:800}}},
  {id:'qa-history-video',type:'video',label:'找回镜头',width:640,height:360,seconds:3,ref:'output:h3studio/recovery-video.mp4'},
  {id:'qa-history-audio',type:'audio',label:'找回旁白',seconds:4,ref:'output:h3studio/recovery-audio.wav'},
 ].map(item=>({...item,available:true,url:'/media?ref='+encodeURIComponent(item.ref)}));
 w.fetch=async(url,options)=>{
  const path=new URL(String(url),'http://oneshot.test');
  if(path.pathname!=='/api/generation-history')return historyFetch(url,options);
  const items=recoveryItems.filter(item=>['all',item.type].includes(path.searchParams.get('kind')));
  return {ok:true,json:async()=>({items, next:null})};
 };
 evaluate('ghOpen();const historyCanvasSize=B.nodes.length;');
 await ready('ghCards().length===3','history restores usable results');
 evaluate(`const historyKind=kind=>{const picker=gh("[data-gh-kind]");picker.value=kind;picker.dispatchEvent(new Event("change"));};
  historyKind("image");`);
 await ready('ghCards().length===1 && ghCards()[0]._historyItem.type==="image"','history image filter loads');
 assert.match(evaluate('ghCards()[0].textContent'),/可复用编辑参数和图层/);
 evaluate('gh("[data-gh-select-visible]").click();historyKind("video");');
 await ready('ghCards().length===1 && ghCards()[0]._historyItem.type==="video"','history video filter loads');
 equal(evaluate('gh("[data-gh-count]").textContent'),'已选 1 · 筛选外 1','selection survives media filters');
 evaluate('gh("[data-gh-select-visible]").click();historyKind("audio");');
 await ready('ghCards().length===1 && ghCards()[0]._historyItem.type==="audio"','history audio filter loads');
 evaluate('gh("[data-gh-select-visible]").click();gh("[data-gh-apply]").click();');
 equal(evaluate('B.nodes.slice(-3).map(n=>[n.type,n.versions[0].seed??null,n.versions[0].seconds??null])'),
  [['image',24,null],['video',null,3],['audio',null,4]],'mixed history restore keeps generation settings and media metadata');
 equal(evaluate('curV(B.nodes.at(-3)).edit'),recoveryItems[0].image_edit,'restored image keeps both its lighting recipe and editable layer');
 evaluate('undo()');
 equal(evaluate('B.nodes.length'),evaluate('historyCanvasSize'),'mixed history restore uses one undo step');
 const recoveredSound=recoveryItems[2];
 recoveredSound.audio_recipe={mode:'seed_audio',prompt:'跟随 @音频2',references:[
  {node_id:'prior-voice',ref:'output:h3studio/recovery-ref-a.wav',kind:'audio'},
  {node_id:'removed-voice',ref:'output:h3studio/recovery-ref-b.wav',kind:'audio'},
 ]};
 evaluate(`const reusableHistoryVoice=addNode("audio",700,850,{}, {versions:[
  {ref:"output:h3studio/recovery-ref-a.wav",url:"/media?ref=output:h3studio/recovery-ref-a.wav"},
  {ref:"output:h3studio/new-voice.wav",url:"/media?ref=output:h3studio/new-voice.wav"}],cur:1});
  const seedHistorySize=B.nodes.length;ghOpen();historyKind("audio");`);
 await ready('ghCards().length===1 && ghCards()[0]._historyItem.audio_recipe?.mode==="seed_audio"','history lists a reference generation');
 evaluate('$(".gh-card-actions [data-gh-card-apply]",ghCards()[0]).click()');
 equal(evaluate(`[B.nodes.length-seedHistorySize,reusableHistoryVoice.cur,sel.size,
  B.edges.filter(e=>e.relation==="seed_audio_ref"&&sel.has(e.to)).map(e=>[e.ref,e.from===reusableHistoryVoice.id]),
  curV(node([...sel][0])).audio_recipe.references.map(r=>r.ref)]`),
 [2,1,1,[['output:h3studio/recovery-ref-a.wav',true],['output:h3studio/recovery-ref-b.wav',false]],
  ['output:h3studio/recovery-ref-a.wav','output:h3studio/recovery-ref-b.wav']],
 'history restores both reference pins, reusing an existing version and creating just one missing source');
 evaluate('undo()');
 equal(evaluate('B.nodes.length'),evaluate('seedHistorySize'),'restoring history with inputs uses one undo step');
 w.fetch=historyFetch;
 evaluate(`const historySearchNode=addNode("image",420,80,{}, {name:"重复名称",versions:[
  {ref:"output:h3studio/search-old.png",url:"/media?ref=output%3Ah3studio%2Fsearch-old.png",prompt:"旧版港口灯光"},
  {ref:"output:h3studio/search-new.png",url:"/media?ref=output%3Ah3studio%2Fsearch-new.png",prompt:"当前空白站台"}],cur:1});
  const nsGroup=ctNewGroup("验收镜头组",[historySearchNode.id,"n1"]);ctSetFold(nsGroup,true);
  document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"f",ctrlKey:true,bubbles:true,cancelable:true}));
  const historySearchInput=$("#nodeSearch input[type=search]");
  const searchFor=value=>{historySearchInput.value=value;historySearchInput.dispatchEvent(new Event("input",{bubbles:true}));};
  searchFor("旧版港口灯光");`);
 assert.equal(evaluate('$("#nodeSearch").open'),true,'Ctrl+F opens application search');
 assert.match(evaluate('$("#nodeSearch ol").textContent'),/匹配版本 1/);
 evaluate('$("#nodeSearch .ns-preview").click()');
 equal(evaluate('[$("#light img").getAttribute("src"),historySearchNode.cur]'),
   ['/media?ref=output%3Ah3studio%2Fsearch-old.png',1],'history search previews the exact matching version');
 evaluate(`closeLightbox();$("#nodeSearchBtn").click();searchFor("验收镜头组");
  $$(".ns-filters button").find(x=>x.textContent.startsWith("分组")).click();
  historySearchInput.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true,cancelable:true}));`);
 assert.match(evaluate('document.activeElement.textContent'),/验收镜头组/);
 evaluate('document.activeElement.click()');
 equal(evaluate('[nsGroup.collapsed,CT_GROUPS.get(nsGroup.id).classList.contains("ns-located")]'),[true,true],
   'group search locates the folded group without expanding it');
 evaluate(`const exportLayerNode=addNode("image",320,120,{}, {name:"分层测试",versions:[
  {...copyAsset("layer-composite.png"),layer_stack:{base_ref:"output:h3studio/layer-composite.png",layers:[
   {id:"base",name:"主体",ref:"output:h3studio/layer-smoke.png",x:8,y:12,w:200,h:160,opacity:.5,visible:true}]}},
  copyAsset("layer-other-version.png")],cur:0});`);
 await evaluate('openImageEditor(exportLayerNode)');
 await ready('!!IMAGE_EDITOR?.image && !IMAGE_EDITOR.loading && !IMAGE_EDITOR.restoring','layered source is open');
 evaluate(`ieMode("layers");
  $('#ieLayerList [data-layer="base"] button').click();
  const exportLayerAccess=B.access, exportLayerStack=JSON.stringify(IMAGE_EDITOR.layers),
   exportLayerSource=curV(node(exportLayerNode.id)).ref, exportLayerRef="output:h3studio/layer-smoke.png";
  B.access="reviewer";ieSync();`);
 assert(w.document.getElementById('ieExportLayer').disabled,'reviewers cannot create a layer node');
 evaluate('B.access=exportLayerAccess;ieSync();$("#ieExportLayer").click()');
 await ready('!!IMAGE_EDITOR?.layerExportIds?.length && !IMAGE_EDITOR.busy','selected layer is available on the canvas');
 equal(evaluate(`[curV(node(IMAGE_EDITOR.layerExportIds[0])).ref,curV(node(exportLayerNode.id)).ref,
  JSON.stringify(IMAGE_EDITOR.layers)===exportLayerStack]`),
 [evaluate('exportLayerRef'),evaluate('exportLayerSource'),true],'layer export reuses its own media and preserves the source stack');
 evaluate('const exportedLayerId=IMAGE_EDITOR.layerExportIds[0];$("#ieLocateLayer").click()');
 assert(evaluate('!IMAGE_EDITOR && sel.has(exportedLayerId)'),'locating the export selects its canvas node');
 evaluate('undo()');
 assert(evaluate('!node(exportedLayerId) && curV(node(exportLayerNode.id)).ref===exportLayerSource'),'one undo removes only the layer node');
 console.log('Layer reuse passed: permissions, independent media reference, source stack, locate and undo.');

 evaluate(`const batchLayerNode=addNode("image",480,160,{}, {name:"物件拆分",versions:[{
  ...copyAsset("batch-layer-composite.png", {w:512,h:384}),layer_stack:{layers:[
   {id:"object-0",name:"背景",ref:"output:h3studio/batch-layer-background.png",x:0,y:0,w:512,h:384,opacity:1,visible:true},
   {id:"object-1",name:"灯",ref:"output:h3studio/batch-layer-light.png",x:24,y:40,w:200,h:300,opacity:1,visible:true},
   {id:"object-2",name:"花瓶",ref:"output:h3studio/batch-layer-vase.png",x:210,y:220,w:60,h:120,opacity:.6,visible:false},
   {id:"object-3",name:"桌子",ref:"output:h3studio/batch-layer-table.png",x:0,y:160,w:430,h:160,opacity:1,visible:true}
  ]}}],cur:0});`);
 await evaluate('openImageEditor(batchLayerNode)');
 evaluate('ieMode("layers")');
 const layerDownloadFetch=w.fetch, layerDownloadURL=w.URL.createObjectURL, layerRevokeURL=w.URL.revokeObjectURL;
 const layerAnchorClick=w.HTMLAnchorElement.prototype.click;
 let layerDownloadRequest, layerDownloadName;
 w.URL.createObjectURL=()=> 'blob:layer-download';
 w.URL.revokeObjectURL=()=>{};
 w.HTMLAnchorElement.prototype.click=function(){layerDownloadName=this.download;};
 w.fetch=async(url,options)=>{
  if(String(url)!=='/api/image-edit/openraster')return layerDownloadFetch(url,options);
  layerDownloadRequest=JSON.parse(options.body);
  return {ok:true,headers:new Headers({"Content-Disposition":"attachment; filename*=UTF-8''"+encodeURIComponent("物件拆分.ora")}),
   blob:async()=>new w.Blob(['openraster'],{type:'image/openraster'})};
 };
 await evaluate('$("#ieDownloadLayers").onclick()');
 assert.equal(layerDownloadName,'物件拆分.ora');
 assert.equal(layerDownloadRequest.layers.length,4,'the editable file includes hidden layers and the background');
 assert.equal(layerDownloadRequest.layers[2].visible,false);
 assert.equal(layerDownloadRequest.layers[2].opacity,.6);
 w.fetch=layerDownloadFetch;
 w.URL.createObjectURL=layerDownloadURL;
 w.URL.revokeObjectURL=layerRevokeURL || (()=>{});
 w.HTMLAnchorElement.prototype.click=layerAnchorClick;
 evaluate('$("#ieOpenLayerBatch").click()');
 equal(evaluate('$$("#ieLayerBatchList input:checked").map(input=>input.value)'),['object-3','object-1'],
  'background and hidden layers require an explicit choice');
 evaluate(`const batchLayerPick=id=>$$("#ieLayerBatchList input").find(input=>input.value===id);
  batchLayerPick("object-3").click();batchLayerPick("object-2").click();
  const batchSourceStack=ewLayerState(IMAGE_EDITOR);
  $("#ieConfirmLayerBatch").click();`);
 await ready('!IMAGE_EDITOR?.busy && IMAGE_EDITOR?.layerExportIds?.length===2','selected layers are exported as a batch');
 equal(evaluate(`IMAGE_EDITOR.layerExportIds.map(id=>[node(id).name,curV(node(id)).ref])`),[
  ['物件拆分 · 花瓶','output:h3studio/batch-layer-vase.png'],['物件拆分 · 灯','output:h3studio/batch-layer-light.png']]);
 assert(evaluate('ewLayerState(IMAGE_EDITOR)===batchSourceStack'),'batch export preserves the editable stack');
 assert(evaluate(`const batchExportIds=[...IMAGE_EDITOR.layerExportIds];
  const [firstLayerExport,secondLayerExport]=batchExportIds.map(node);
  firstLayerExport.x+size(firstLayerExport).w<secondLayerExport.x`),'batch cards have room between them');
 evaluate('$("#ieLocateLayer").click()');
 assert(evaluate('!IMAGE_EDITOR && batchExportIds.every(id=>sel.has(id))'),'locate selects all exported nodes');
 evaluate('undo()');
 assert(evaluate('batchExportIds.every(id=>!node(id)) && !!node(batchLayerNode.id)'),'one undo removes the whole batch');

 const backgroundFetch=w.fetch;
 let backgroundRequest;
 w.fetch=async(url,options)=>{
  if(String(url)!=='/api/image-edit/fill-background')return backgroundFetch(url,options);
  backgroundRequest=JSON.parse(options.body);
  return {ok:true,text:async()=>JSON.stringify({...evaluate('copyAsset("filled-background.png")'),w:512,h:384})};
 };
 evaluate(`const layeredBackground=addNode("image",360,160,{}, {versions:[{
  ...copyAsset("split-result.png"),edit:{mode:"layers"},
  layer_stack:{base_ref:"output:h3studio/layered-source.png",layers:[
   {id:"object-0",name:"背景",ref:"output:h3studio/split-background.png",x:36,y:32,w:496,h:368,opacity:1,visible:true,
    decomposition_bounds:{x:8,y:12,w:496,h:368}},
   {id:"object-1",name:"物体 1",ref:"output:h3studio/layer-smoke.png",x:40,y:50,w:100,h:90,opacity:1,visible:true}
  ]}}],cur:0});`);
 await evaluate('openImageEditor(layeredBackground)');
 evaluate(`ieMode("layers");IMAGE_EDITOR.layers[1].x=110;$("#ieFillBackground").click();`);
 await ready('!IMAGE_EDITOR?.busy && IMAGE_EDITOR?.layers[0]?.name==="补全背景"','background is replaced in the current draft');
 equal(backgroundRequest,{ref:'output:h3studio/layered-source.png',background:'output:h3studio/split-background.png',x:8,y:12});
 equal(evaluate('[...IMAGE_EDITOR.layers.map(({ref,x,y})=>[ref,x,y]),layeredBackground.versions.length]'),[
  ['output:h3studio/filled-background.png',28,20],['output:h3studio/layer-smoke.png',110,50],1]);
 assert(w.document.getElementById('ieFillBackground').hidden,'the completed background cannot be filled again');
 evaluate(`const layerKey=(key,shiftKey=false)=>$("#ieLayerOpacity").dispatchEvent(new KeyboardEvent("keydown",
  {key,ctrlKey:true,shiftKey,bubbles:true,cancelable:true}));
  layerKey("z");`);
 assert(evaluate('!$("#ieFillBackground").hidden && IMAGE_EDITOR.layers[1].x===110'),
  'undo restores the original background without moving the subject');
 evaluate('layerKey("z",true)');
 assert(evaluate('$("#ieFillBackground").hidden && IMAGE_EDITOR.layers[0].name==="补全背景"'),'redo restores the filled layer');
 evaluate(`const layerCanvas=$(".ie-canvas"), layerPointer=(type,dx)=>{
  const view=IMAGE_EDITOR.view, rect=layerCanvas.getBoundingClientRect();
  layerCanvas.dispatchEvent(new MouseEvent(type,{button:0,bubbles:true,cancelable:true,
   clientX:rect.left+view.tx+(120+dx)*view.scale,clientY:rect.top+view.ty+100*view.scale}));
 };
 layerPointer("pointerdown",0);layerPointer("pointermove",15);layerPointer("pointercancel",15);
 const layerHistoryBeforeMove=IMAGE_EDITOR.layerUndo.length;`);
 equal(evaluate('IMAGE_EDITOR.layers[1].x'),110,'cancelled movement restores the original position');
 evaluate('layerPointer("pointerdown",0);layerPointer("pointermove",8);layerPointer("pointerup",16)');
 equal(evaluate('[IMAGE_EDITOR.layers[1].x,IMAGE_EDITOR.layerUndo.length-layerHistoryBeforeMove]'),[126,1],
  'a complete drag records one step');
 evaluate('$("#ieUndoLayer").click()');
 equal(evaluate('IMAGE_EDITOR.layers[1].x'),110,'one undo reverts the complete drag');
 evaluate(`const layerOpacity=$('#ieLayerOpacity');
  for(const value of [85,65,40]){layerOpacity.value=value;layerOpacity.dispatchEvent(new Event("input",{bubbles:true}));}
  layerOpacity.dispatchEvent(new Event("change",{bubbles:true}));`);
 equal(evaluate('[IMAGE_EDITOR.layers[1].opacity,$("#ieRedoLayer").disabled]'),[.4,true],
  'committing opacity creates a new history branch');
 evaluate('layerKey("z");$("#ieLayerDelete").click()');
 equal(evaluate('IMAGE_EDITOR.layers.length'),1,'the selected layer is deleted');
 evaluate('$("#ieUndoLayer").click()');
 equal(evaluate('[IMAGE_EDITOR.layers[1].opacity,IMAGE_EDITOR.activeLayer]'),[1,'object-1'],
  'one undo restores deletion and another restores the entire opacity adjustment');
 await evaluate('ewCommitLayers()');
 await ready('!IMAGE_EDITOR?.loading && !IMAGE_EDITOR?.restoring','filled layers are committed');
 equal(evaluate('curV(layeredBackground).layer_stack.layers[0].ref'),'output:h3studio/filled-background.png');
 assert(w.document.getElementById('ieUndoLayer').disabled,'the new version begins a separate edit history');
 w.fetch=backgroundFetch;
 console.log('Layer background fill passed: original geometry, retained movement, draft and version save.');

 evaluate('closeImageEditor()');
 const oraUploadFetch=w.fetch;
 let oraUploadedFile;
 w.fetch=async(url,options)=>{
  if(String(url)!=='/api/upload')return oraUploadFetch(url,options);
  oraUploadedFile=options.body.get('image').name;
  return {ok:true,json:async()=>({ref:'input:h3studio/ora-preview.png',url:'/media?ref=input:h3studio/ora-preview.png',
   w:600,h:450,layer_stack:{layers:[{id:'ora-1',name:'导入前景',ref:'input:h3studio/ora-layer.png',
    x:-3,y:16,w:100,h:120,opacity:.55,visible:false}]}})};
 };
 const oraFile=new w.File(['openraster'],'编辑稿.ora',{type:'application/octet-stream'});
 await evaluate('importCanvasFiles')([oraFile],{x:850,y:350});
 assert.equal(oraUploadedFile,'编辑稿.ora','the normal canvas import accepts .ora files');
 evaluate('const oraNode=B.nodes.at(-1)');
 equal(evaluate('[oraNode.type,oraNode.name,curV(oraNode).w,curV(oraNode).h]'),['image','编辑稿',600,450]);
 await evaluate('openImageEditor(oraNode)');
 evaluate('ieMode("layers")');
 equal(evaluate('IMAGE_EDITOR.layers.map(({name,x,y,opacity,visible})=>[name,x,y,opacity,visible])'),
  [['导入前景',-3,16,.55,false]],'the image editor restores independent imported layers');
 w.fetch=oraUploadFetch;
 console.log('OpenRaster import passed: normal canvas entry, document size and editable layer restoration.');

 evaluate(`const pickLayerNode=addNode("image",460,360,{}, {versions:[{
  ...copyAsset("pick-composite.png"),layer_stack:{layers:[
   {id:"lower",name:"底图",ref:"output:h3studio/pick-lower.png",x:0,y:0,w:240,h:220,opacity:1,visible:true},
   {id:"upper",name:"主体",ref:"output:h3studio/pick-upper.png",x:40,y:50,w:100,h:100,opacity:.7,visible:true},
   {id:"hidden",name:"隐藏图层",ref:"output:h3studio/pick-hidden.png",x:40,y:50,w:100,h:100,opacity:1,visible:false}
  ]}}],cur:0});`);
 await evaluate('openImageEditor(pickLayerNode)');
 evaluate(`ieMode("layers");
  const pickSamples=[], hitProbe=document.createElement("canvas");
  const hitContext=hitProbe.getContext("2d");
  hitContext.drawImage=(image,x,y)=>pickSamples.push([decodeURIComponent(image.src),x,y]);
  hitContext.getImageData=()=>{
   const [src,x]=pickSamples.at(-1);
   return {data:[0,0,0,src.includes("pick-upper") && x<100 ? 0 : 255]};
  };
  IMAGE_EDITOR.layerHitCanvas=hitProbe;
  const directPick=(type,x,y,altKey=false,shiftKey=false)=>{
   const view=IMAGE_EDITOR.view, rect=layerCanvas.getBoundingClientRect();
   layerCanvas.dispatchEvent(new MouseEvent(type,{button:0,altKey,shiftKey,bubbles:true,cancelable:true,
    clientX:rect.left+view.tx+x*view.scale,clientY:rect.top+view.ty+y*view.scale}));
  };
  directPick("pointerdown",50,65);directPick("pointerup",50,65);`);
 equal(evaluate('[IMAGE_EDITOR.activeLayer,IMAGE_EDITOR.layerUndo.length]'),['lower',0],
  'clicking through a transparent pixel selects the layer below without an undo entry');
 assert(evaluate('pickSamples[0][1]>=50 && pickSamples[0][1]<=51 && pickSamples.every(([src])=>!src.includes("pick-hidden"))'),
  'picking uses the scaled source pixel and skips hidden layers');
 evaluate('directPick("pointerdown",70,65);directPick("pointerup",70,65)');
 equal(evaluate('IMAGE_EDITOR.activeLayer'),'upper','opaque overlapping pixels select the highest visible layer');
 evaluate(`$('#ieLayerList [data-layer="lower"] button').click();
  directPick("pointerdown",70,65,true);directPick("pointerup",90,65,true);
  directPick("pointerdown",450,350);directPick("pointerup",470,350);`);
 equal(evaluate('[IMAGE_EDITOR.activeLayer,IMAGE_EDITOR.layers.map(l=>l.x),IMAGE_EDITOR.layerUndo.length]'),
  ['lower',[20,40,40],1],'Alt drag moves the explicit layer and empty space moves nothing');
 console.log('Layer picking passed: topmost visible pixel, transparent click-through, transforms and explicit drag.');

 evaluate(`$('#ieLayerList [data-layer="upper"] button').click();
  directPick("pointermove",40,50);
  const resizeDepth=IMAGE_EDITOR.layerUndo.length;
  const layerBox=()=>{const {x,y,w,h}=IMAGE_EDITOR.layers.find(layer=>layer.id==="upper");return [x,y,w,h];};`);
 equal(evaluate('layerCanvas.dataset.layerResize'),'nwse','hovering the corner shows a resize cursor');
 evaluate('directPick("pointerdown",40,50);directPick("pointermove",30,35);directPick("pointerup",20,20)');
 equal(evaluate('[layerBox(),$("#ieLayerWidth").value,$("#ieLayerHeight").value,IMAGE_EDITOR.layerUndo.length-resizeDepth]'),
  [[20,20,120,130],'120','130',1],'free resize keeps the opposite corner fixed and updates the panel in one step');
 evaluate('$("#ieUndoLayer").click()');
 equal(evaluate('layerBox()'),[40,50,100,100],'undo restores coordinates and dimensions');
 evaluate('directPick("pointerdown",140,150,false,true);directPick("pointerup",170,160,false,true)');
 equal(evaluate('layerBox()'),[40,50,120,120],'Shift keeps the original layer aspect ratio');
 evaluate(`directPick("pointerdown",160,170);directPick("pointermove",180,200);
  layerCanvas.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));`);
 equal(evaluate('[layerBox(),!IMAGE_EDITOR.layerDrag]'),[[40,50,120,120],true],
  'Escape cancels resizing in place');
 console.log('Layer resize passed: corner hit testing, fixed anchor, Shift ratio, panel sync, undo and cancel.');
};
