"use strict";

function ewLayersHTML() { return OneShotI18n.html`<div class="ie-section" data-section="layers"><div class="ie-row"><button id="ieImportLayer">导入图片</button><button id="ieCutout">智能抠图</button><button id="ieDecompose" disabled>自动分层</button></div><button id="ieFillBackground" hidden>补全分层背景</button><p class="ie-note">拖动图层调整位置，或修改坐标与尺寸。图层从上到下显示；隐藏背景可导出透明 PNG。</p><div id="ieLayerList"></div><div class="ie-row"><button id="ieUndoLayer" disabled>撤销图层编辑</button><button id="ieRedoLayer" disabled>重做图层编辑</button></div><div class="ie-row"><button id="ieLayerUp">上移</button><button id="ieLayerDown">下移</button><button id="ieLayerDelete">删除</button></div><div class="ie-padding">${[["X","X"],["Y","Y"],["Width","宽度"],["Height","高度"]].map(([k,t])=>`<label>${t}<input id="ieLayer${k}" type="number" step="1"></label>`).join("")}</div><label class="ie-label" for="ieLayerOpacity">图层不透明度<output id="ieLayerOpacityValue">100%</output></label><input id="ieLayerOpacity" type="range" min="0" max="100" value="100"><div class="ie-row"><button id="ieSelectionLayer">选区转图层</button><button id="ieResultLayer">提取生成图层</button></div><div class="ie-row"><button id="ieExportLayer" disabled title="以图层原始尺寸和透明通道创建独立图片">将选中图层放入画布</button><button id="ieOpenLayerBatch" disabled>批量放入画布</button></div><fieldset id="ieLayerBatch" hidden><legend>选择要放入画布的图层</legend><div id="ieLayerBatchList"></div><div class="ie-row"><button id="ieCloseLayerBatch">收起</button><button id="ieConfirmLayerBatch">放入画布</button></div></fieldset><button id="ieLocateLayer" hidden>定位导出图</button><div class="ie-row"><button id="ieDownloadLayers" disabled>下载可编辑图层（.ora）</button></div><button id="ieSaveLayers" class="ie-primary">合并保存为新版本</button></div>`; }

function ewRenderLayers() {
  const E=IMAGE_EDITOR;if(!E)return;const box=$("#ieLayerList");if(!E.layers.some(x=>x.id===E.activeLayer))E.activeLayer=E.layers[E.layers.length-1]?.id;
  box.innerHTML=[...E.layers].reverse().map(l=>`<div class="ie-layer ${l.id===E.activeLayer ? "on" : ""}" data-layer="${esc(l.id)}"><input type="checkbox" aria-label="显示 ${esc(l.name)}" ${l.visible!==false ? "checked" : ""}><img src="${ewRefUrl(l.ref)}" alt=""><button title="选择图层">${esc(l.name)}</button></div>`).join("");
  $$(".ie-layer",box).forEach(row=>{const l=E.layers.find(x=>x.id===row.dataset.layer);$("button",row).onclick=()=>{E.activeLayer=l.id;ewRenderLayers();ieDraw();ewScheduleDraft();};$("input",row).onchange=ev=>{if(E.busy || E.n.job){ev.target.checked=l.visible!==false;return;}const before=ewLayerState(E);l.visible=ev.target.checked;ewRecordLayers(E,before);ieDraw();ewScheduleDraft();};});
  const l=E.layers.find(x=>x.id===E.activeLayer);for(const [k,key]of [["X","x"],["Y","y"],["Width","w"],["Height","h"]])$("#ieLayer"+k).value=l?.[key] ?? 0;
  $("#ieLayerOpacity").value=Math.round((l?.opacity ?? 1)*100);$("#ieLayerOpacityValue").textContent=$("#ieLayerOpacity").value+"%";
  ewLayerExportControls(E);
  ewLayerHistoryControls(E);
  ewBackgroundControls(E);
}

function ewLayerState(E) {
  return JSON.stringify({layers:E.layers,activeLayer:E.activeLayer});
}

function ewLayerHistoryControls(E) {
  const locked=E.busy || E.loading || E.restoring || !E.image || E.n.job || E.agentSelection || !canvasCanEdit();
  $("#ieUndoLayer").disabled=!!locked || !E.layerUndo?.length;
  $("#ieRedoLayer").disabled=!!locked || !E.layerRedo?.length;
}

function ewRecordLayers(E,before) {
  if (before===ewLayerState(E)) return;
  E.layerUndo.push(before);
  if (E.layerUndo.length>32) E.layerUndo.shift();
  E.layerRedo.length=0;
  ewLayerHistoryControls(E);
}

function ewFinishLayerOpacity(E) {
  if (!E?.layerOpacityBefore) return;
  const before=E.layerOpacityBefore;
  E.layerOpacityBefore=null;
  ewRecordLayers(E,before);
}

function ewStepLayerHistory(redo=false) {
  const E=IMAGE_EDITOR;
  if (!E?.image || E.busy || E.loading || E.restoring || E.n.job || E.layerDrag || E.agentSelection || !canvasCanEdit()) return;
  ewFinishLayerOpacity(E);
  const from=redo?E.layerRedo:E.layerUndo, to=redo?E.layerUndo:E.layerRedo;
  if (!from.length) return;
  const state=JSON.parse(from.pop());
  to.push(ewLayerState(E));
  E.layers=state.layers;
  E.activeLayer=state.activeLayer;
  ewRenderLayers();
  ieDraw();
  ewScheduleDraft(true);
}

function ewCancelLayerDrag(E) {
  $(".ie-canvas").dataset.layerResize="";
  if (!E?.layerDrag) return;
  const {layer,rect}=E.layerDrag;
  E.layerDrag=null;
  Object.assign(layer,rect);
  ewRenderLayers();
  ieDraw();
}

function ewLayerExportControls(E) {
  const busy=E.busy || E.loading || E.restoring || !E.image || E.agentSelection;
  const versionIndex=E.n.versions.findIndex(version=>version.ref===E.ref);
  const disabled=!!busy || !vtCanCopyVersion(E.n,versionIndex);
  $("#ieExportLayer").disabled=disabled || !E.layers.some(layer=>layer.id===E.activeLayer && layer.ref);
  $("#ieDownloadLayers").disabled=!!busy || !E.layers.length;
  $("#ieOpenLayerBatch").disabled=disabled || E.layers.filter(layer=>layer.ref).length<2;
  $("#ieLayerBatch").disabled=disabled;
  $("#ieConfirmLayerBatch").disabled=disabled || !$("#ieLayerBatchList input:checked");
  const locate=$("#ieLocateLayer");
  const count=(E.layerExportIds || []).filter(id=>node(id)).length;
  locate.hidden=!count;
  locate.disabled=!!busy;
  locate.textContent=count>1?"定位这批图片":"定位导出图";
}

function ewOpenLayerBatch(E) {
  const layers=E.layers.filter(layer=>layer.ref).reverse();
  $("#ieLayerBatchList").innerHTML=layers.map(layer=>`<label><input type="checkbox"
    value="${esc(layer.id)}" data-ref="${esc(layer.ref)}" ${layer.visible!==false && layer.id!=="object-0" ? "checked" : ""}>
    <span>${esc(layer.name)}</span></label>`).join("");
  $("#ieLayerBatch").hidden=false;
  ewLayerExportControls(E);
  $("#ieLayerBatchList input")?.focus();
}

function ewConfirmLayerBatch(E) {
  const selected=$$("#ieLayerBatchList input:checked");
  const layers=selected.map(input=>E.layers.find(layer=>layer.id===input.value && layer.ref===input.dataset.ref));
  if (layers.some(layer=>!layer)) {
    ewOpenLayerBatch(E);
    ieStatus("图层已更新，请重新核对要放入画布的图片");
    return;
  }
  void ewExportLayers(E,layers);
}

async function ewExportLayers(E,layers) {
  if (E?.mode!=="layers" || !layers.length) return;
  const board=B, epoch=boardOpenEpoch, source=E.ref;
  const entries=layers.map(({id,name,ref})=>({id,name,ref}));
  E.busy=true;
  ieSync();
  try {
    const images=await Promise.all(entries.map(layer=>ewAsset(E,layer.ref)));
    if (IMAGE_EDITOR!==E || B!==board || boardOpenEpoch!==epoch) return;
    const versionIndex=E.n.versions.findIndex(version=>version.ref===source);
    if (E.ref!==source || !vtCanCopyVersion(E.n,versionIndex) ||
        entries.some(item=>!E.layers.some(layer=>layer.id===item.id && layer.ref===item.ref))) {
      throw new Error("来源图片或图层已更新，请重新选择");
    }
    const x=E.n.x+size(E.n).w+CT_LAYOUT_GAP.x;
    const targets=entries.map((layer,index)=>{
      const image=images[index];
      const version=mediaVersion({ref:layer.ref,url:ewRefUrl(layer.ref),w:image.naturalWidth,h:image.naturalHeight},
        {source:"edit",mode:"提取图层"});
      const dimensions=size({...E.n,versions:[version],cur:0});
      return {id:layer.id, name:E.n.name+" · "+layer.name, version,x,y:E.n.y+index,...dimensions};
    });
    const spots=targets.length>1 ? ctGridPositions(targets,ctCanvasRects(),item=>({w:item.w,h:item.h})) :
      [freeSpot(x,E.n.y,"image",targets[0])];
    checkpoint();
    E.layerExportIds=targets.map((target,index)=>addNode("image",spots[index].x,spots[index].y,{},
      {name:target.name,versions:[target.version],cur:0}).id);
    $("#ieLayerBatch").hidden=true;
    ieStatus(`已将 ${targets.length} 个图层放入画布`);
  } catch (error) {
    if (IMAGE_EDITOR===E) ieStatus(error.message,true);
  } finally {
    E.busy=false;
    if (IMAGE_EDITOR===E) ieSync();
  }
}
async function ewDownloadLayers() {
  const E=IMAGE_EDITOR;
  if (E?.mode!=="layers" || $("#ieDownloadLayers").disabled) return;
  const body=JSON.stringify({name:E.n.name,ref:E.ref,layers:E.layers});
  E.busy=true;
  ieSync();
  ieStatus("正在打包可编辑图层…");
  try {
    const response=await fetchOk("/api/image-edit/openraster",{
      method:"POST",headers:{"Content-Type":"application/json"},body
    });
    const blob=await response.blob();
    const encodedName=response.headers.get("Content-Disposition")?.match(/filename\*=UTF-8''([^;]+)/)?.[1];
    const link=document.createElement("a");
    link.download=encodedName ? decodeURIComponent(encodedName) : "OneShot.ora";
    link.href=URL.createObjectURL(blob);
    link.click();
    setTimeout(()=>URL.revokeObjectURL(link.href),1000);
    if (IMAGE_EDITOR===E) ieStatus("图层文件已交给浏览器下载");
  } catch (error) {
    if (IMAGE_EDITOR===E) ieStatus(error.message,true);
  } finally {
    E.busy=false;
    if (IMAGE_EDITOR===E) ieSync();
  }
}

async function ewAddLayer(E,result,name,hideOthers=false,base=null) {
  if(!base && E.layers.length>=16)throw new Error("最多保留 16 个图层，请先合并部分图层");
  const im=await ewAsset(E,result.ref);if(IMAGE_EDITOR!==E)return;
  const before=ewLayerState(E);
  if(base) E.layers=[base];
  if(hideOthers)E.layers.forEach(x=>x.visible=false);
  const layer={id:ewId(),name,ref:result.ref,x:0,y:0,w:result.w || im.naturalWidth,h:result.h || im.naturalHeight,opacity:1,visible:true};
  if(layer.w>E.image.naturalWidth || layer.h>E.image.naturalHeight) {const s=Math.min(E.image.naturalWidth/layer.w,E.image.naturalHeight/layer.h);layer.w=Math.round(layer.w*s);layer.h=Math.round(layer.h*s);}
  E.layers.push(layer);E.activeLayer=layer.id;ewRecordLayers(E,before);ewRenderLayers();ieMode("layers",true);ieDraw();ewScheduleDraft(true);
}
async function ewUtility(tool) {
  const E=IMAGE_EDITOR;if(!E?.image || E.busy || E.n.job)return;E.busy=true;ieSync();ieStatus(tool==="cutout" ? "正在智能抠图…" : "正在提取选区图层…");
  try {const ref=await ewFlatten(E);let result;if(tool==="cutout")result=await api("/api/image-edit/cutout",{ref});else {const mask=await ewExportMask(E);result=await api("/api/image-edit/selection-cutout",{ref,mask:mask.ref});}if(IMAGE_EDITOR!==E)return;await ewAddLayer(E,result,tool==="cutout" ? "智能抠图" : "选区图层",tool==="cutout");ieStatus("已添加透明图层，可调整后合并保存");}
  catch(err){ieStatus(err.message,true);}finally{E.busy=false;ieSync();}
}
function ewDecomposeControl(E) {
  const button=$("#ieDecompose");
  button.disabled=!E.capabilities?.decompose || E.busy || E.loading || E.restoring || !E.image ||
    !!E.agentSelection || !vtCanCopyVersion(E.n,E.n.cur);
  button.title=E.capabilities?.decompose?"将当前画面拆成可独立编辑的图层":"服务端未启用自动分层";
}

async function ewDecompose() {
  const E=IMAGE_EDITOR;
  if (!E || E.mode!=="layers" || $("#ieDecompose").disabled) return;
  const board=B, source=E.ref;
  const current=()=>IMAGE_EDITOR===E && B===board && vtCanCopyVersion(E.n,E.n.cur) && curV(E.n)?.ref===source;
  E.busy=true;
  ieSync();
  ieStatus("正在识别可分离的物体…");
  try {
    const ref=await ewFlatten(E);
    if (!current()) throw new Error("来源图片已更新，请重新选择版本");
    const result=await api("/api/image-edit/decompose",{ref});
    if (!current()) throw new Error("来源图片已更新，请重新选择版本");
    addVersion(E.n,mediaVersion(result,{source:"edit",mode:"自动分层",layer_stack:result.layer_stack,
      edit:{source,mode:"decompose"}}));
    await ieLoad(curV(E.n));
    if (IMAGE_EDITOR===E) {
      ieMode("layers",true);
      ieStatus("分层已保存为新版本，可移动或隐藏单独图层");
    }
    loadAssets();
  } catch(error) {
    if (IMAGE_EDITOR===E) ieStatus(error.message,true);
  } finally {
    E.busy=false;
    ieSync();
  }
}

function ewBackgroundSource(E) {
  const layer=E.layers.find(item=>item.id==="object-0");
  if (!layer) return null;
  if (layer.decomposition_bounds && E.layerBaseRef) {
    return {layer,original:layer.decomposition_bounds,ref:E.layerBaseRef};
  }
  const version=E.n.versions.find(item=>item.edit?.mode==="decompose" && item.layer_stack?.base_ref &&
    item.layer_stack.layers?.some(original=>original.id===layer.id && original.ref===layer.ref));
  if (!version) return null;
  return {layer,original:version.layer_stack.layers.find(item=>item.id===layer.id),ref:version.layer_stack.base_ref};
}

function ewBackgroundControls(E) {
  const button=$("#ieFillBackground"), source=ewBackgroundSource(E);
  button.hidden=!source;
  button.disabled=!source || E.busy || !!E.loading || E.restoring || !E.image || !!E.agentSelection ||
    !vtCanCopyVersion(E.n,E.n.cur) || E.ref!==curV(E.n)?.ref;
}

async function ewFillBackground() {
  const E=IMAGE_EDITOR;
  if (E?.mode!=="layers" || $("#ieFillBackground").disabled) return;
  const {layer,original,ref}=ewBackgroundSource(E);
  const board=B, epoch=boardOpenEpoch, version=curV(E.n).ref;
  const current=()=>IMAGE_EDITOR===E && B===board && boardOpenEpoch===epoch &&
    vtCanCopyVersion(E.n,E.n.cur) && curV(E.n)?.ref===version && E.layers.includes(layer);
  const scaleX=layer.w/original.w, scaleY=layer.h/original.h;
  E.busy=true;
  ieSync();
  ieStatus("正在补全物体原来占据的背景…");
  try {
    const result=await api("/api/image-edit/fill-background",{ref,background:layer.ref,x:original.x,y:original.y});
    if (!current()) return;
    const geometry={x:Math.round(layer.x-original.x*scaleX),y:Math.round(layer.y-original.y*scaleY),
      w:Math.max(1,Math.round(result.w*scaleX)),h:Math.max(1,Math.round(result.h*scaleY))};
    if (Object.values(geometry).some(value=>Math.abs(value)>8192) || geometry.w*geometry.h>32*1024*1024) {
      throw new Error("补全后的图层尺寸超出范围，请先缩小背景图层");
    }
    await ewAsset(E,result.ref);
    if (!current()) return;
    const before=ewLayerState(E);
    Object.assign(layer,geometry,{ref:result.ref,name:"补全背景"});
    delete layer.decomposition_bounds;
    ewRecordLayers(E,before);
    ewRenderLayers();
    ieDraw();
    ewScheduleDraft(true);
    ieStatus("背景已补全，可继续移动物体或合并保存");
  } catch (error) {
    if (IMAGE_EDITOR===E) ieStatus(error.message,true);
  } finally {
    E.busy=false;
    if (IMAGE_EDITOR===E) ieSync();
  }
}

async function ewCommitLayers() {const E=IMAGE_EDITOR;if(!E?.image || E.busy || E.n.job)return;E.busy=true;ieSync();ieStatus("正在合并图层…");try{const r=await api("/api/image-edit/layers",{ref:E.ref,layers:E.layers});ewScheduleDraft(true);addVersion(E.n,mediaVersion(r,{source:"edit",mode:"图层合并",layer_stack:{base_ref:E.layerBaseRef||E.ref,layers:JSON.parse(JSON.stringify(E.layers))},edit:{source:E.ref,mode:"layers"}}));ieLoad(curV(E.n));ieHistory();loadAssets();ieStatus("已保存为新的 PNG 版本，透明通道已保留");}catch(err){ieStatus(err.message,true);}finally{E.busy=false;ieSync();}}
