"use strict";
// Editing workspace: viewport, recoverable drafts, selections, layers and reusable recipes.
const EW_PHASES={loading:"加载模型",encoding:"处理提示词与参考图",sampling:"生成画面",decoding:"解码图像",compositing:"合成选区",watermark:"写入 AI 水印",done:"已完成"};
const ewRefUrl=ref=>"/media?ref="+encodeURIComponent(ref);
const ewId=()=>"l"+Date.now().toString(36)+Math.random().toString(36).slice(2,7);
function ewNewState(n) { return {board:boardId,zoom:1,pan:{x:0,y:0},fitScale:1,redo:[],assets:new Map(),samPoints:[],layers:[],activeLayer:null,compareMode:"off",split:50,restoring:false,draftChain:Promise.resolve(),draftTimer:0,space:false,capabilities:{}}; }
function ewToolbarHTML() { return `<div class="ie-viewtools"><button id="ieZoomOut" title="缩小">−</button><span id="ieZoomValue" class="num">100%</span><button id="ieZoomIn" title="放大">＋</button><button id="ieActualSize">100%</button><button id="ieFit">适应窗口</button><span class="ie-spacer"></span><select id="ieCompareMode" aria-label="原图对比方式"><option value="off">编辑视图</option><option value="wipe">滑杆对比</option><option value="split">并排对比</option></select><input id="ieWipe" type="range" min="0" max="100" value="50" aria-label="原图对比分界" hidden></div>`; }
function ewLayersHTML() { return `<div class="ie-section" data-section="layers"><div class="ie-row"><button id="ieImportLayer">导入图片</button><button id="ieCutout">智能抠图</button></div><p class="ie-note">拖动图层调整位置，或修改坐标与尺寸。图层从上到下显示；隐藏背景可导出透明 PNG。</p><div id="ieLayerList"></div><div class="ie-row"><button id="ieLayerUp">上移</button><button id="ieLayerDown">下移</button><button id="ieLayerDelete">删除</button></div><div class="ie-padding">${[["X","X"],["Y","Y"],["Width","宽度"],["Height","高度"]].map(([k,t])=>`<label>${t}<input id="ieLayer${k}" type="number" step="1"></label>`).join("")}</div><label class="ie-label" for="ieLayerOpacity">图层不透明度<output id="ieLayerOpacityValue">100%</output></label><input id="ieLayerOpacity" type="range" min="0" max="100" value="100"><div class="ie-row"><button id="ieSelectionLayer">选区转图层</button><button id="ieResultLayer">提取生成图层</button></div><button id="ieSaveLayers" class="ie-primary">合并保存为新版本</button></div>`; }
function ewDraftUrl(E,ref) { return `/api/image-edit/drafts/${encodeURIComponent(E.board)}/${encodeURIComponent(E.n.id)}`+(ref ? "?ref="+encodeURIComponent(ref) : ""); }
function ewDraftKey(E,ref) { return `oneshot.draft.${ME_USER?.id || "current"}.${E.board}.${E.n.id}.${ref}`; }
function ewSnapshot(E) {
  if (!E.ref || !E.image || E.restoring) return null;
  const values={}; for(const id of ["iePrompt","ieProvider","ieBrush","ieFeather","ieStrength","ieBrightness","ieContrast","ieSaturation","iePadLeft","iePadRight","iePadTop","iePadBottom","ieBackend","ieDenoise","ieSteps","ieSeed",...relightInputIds,...imageCameraDraftIds,...pixelSizeFields]) values[id]=$("#"+id).value;
  return {ref:E.ref,mode:E.mode,tool:E.tool,strokes:E.strokes,redo:E.redo,crop:E.crop,values,layers:E.layers,activeLayer:E.activeLayer,samPoints:E.samPoints,zoom:E.zoom,pan:E.pan,
    pixelSize:{open:$("#iePixelSize").open,locked:$("#iePixelLock").checked,anchor:E.pixelAnchor},updated:Date.now()};
}
function ewScheduleDraft(immediate=false) {
  const E=IMAGE_EDITOR; if(!E || E.restoring) return;
  const snapshot=ewSnapshot(E); if(!snapshot) return;
  E.pendingDraft=JSON.stringify(snapshot); clearTimeout(E.draftTimer);
  if(immediate) ewFlushDraft(E); else E.draftTimer=setTimeout(()=>ewFlushDraft(E),500);
}
function ewFlushDraft(E) {
  clearTimeout(E.draftTimer); const body=E.pendingDraft; E.pendingDraft=null; if(!body) return E.draftChain;
  const ref=JSON.parse(body).ref;
  let localSaved=false;try { localStorage.setItem(ewDraftKey(E,ref),body);localSaved=true; } catch {}
  E.draftChain=E.draftChain.catch(()=>{}).then(async()=>{
    const r=await fetch(ewDraftUrl(E),{method:"PUT",headers:{"Content-Type":"application/json"},body});
    if(!r.ok) throw new Error(localSaved ? "草稿已暂存到当前浏览器" : "草稿保存失败，请保留编辑窗口后重试");
    if(IMAGE_EDITOR===E) $("#ieDraftState").textContent="草稿已保存";
  }).catch(err=>{ if(IMAGE_EDITOR===E) $("#ieDraftState").textContent=err.message || "草稿已保留在当前浏览器"; });
  return E.draftChain;
}
async function ewRestoreDraft(E) {
  const ref=E.ref; E.restoring=true; $("#ieDraftState").textContent="正在恢复草稿…";
  let remote=null,local=null;
  try { const r=await fetch(ewDraftUrl(E,ref)); if(r.ok) remote=await r.json(); } catch {}
  try { local=JSON.parse(localStorage.getItem(ewDraftKey(E,ref))); } catch {}
  const draft=local && (!remote || local.updated>remote.updated) ? local : remote;
  try {
    if(IMAGE_EDITOR!==E || E.ref!==ref) return;
    if(draft?.ref===ref) {
      E.strokes=Array.isArray(draft.strokes) ? draft.strokes : []; E.redo=Array.isArray(draft.redo) ? draft.redo : []; E.crop=draft.crop || null;
      E.layers=Array.isArray(draft.layers) && draft.layers.length ? draft.layers.slice(0,16) : E.layers; E.activeLayer=draft.activeLayer;
      E.samPoints=draft.samPoints || []; E.zoom=Number.isFinite(draft.zoom) ? Math.max(.02,Math.min(100,draft.zoom)) : 1;
      E.pan=draft.pan && Number.isFinite(draft.pan.x) && Number.isFinite(draft.pan.y) ? draft.pan : {x:0,y:0};
      for(const [id,value] of Object.entries(draft.values || {})) { const el=document.getElementById(id); if(el && ["INPUT","SELECT","TEXTAREA"].includes(el.tagName)) el.value=String(value); }
      if(draft.pixelSize){
        $("#iePixelSize").open=draft.pixelSize.open===true;$("#iePixelLock").checked=draft.pixelSize.locked!==false;
        E.pixelAnchor=draft.pixelSize.anchor;E.pixelBasis=null;
      }
      E.tool=["brush","rect","erase","smart"].includes(draft.tool) ? draft.tool : "brush";
      ieMode(["region","whole","outpaint","local","layers","relight","relight_ai","camera"].includes(draft.mode) ? draft.mode : "region");
      await ewPreload(E,[...E.layers.map(x=>x.ref),...[...E.strokes,...E.redo].filter(x=>x.tool==="mask").map(x=>x.ref)]);
      ieRebuildMask(); $("#ieDraftState").textContent="已恢复编辑草稿";
    } else $("#ieDraftState").textContent="草稿自动保存";
    await ewPreload(E,E.layers.map(l=>l.ref));ewRefreshControls(); relightRefresh(); imageCameraRefresh(); ewRenderLayers();
  } finally { E.restoring=false; ieSync(); ieDraw(); }
}
function ewResetImage(E) {
  E.lightPreview=null;E.lightPreviewError=false;relightSet();
  imageCameraSet();
  resetPixelSize(E);
  E.zoom=1; E.pan={x:0,y:0}; E.redo=[]; E.samPoints=[]; E.compareMode="off"; $("#ieCompareMode").value="off"; $("#ieWipe").hidden=true;
  E.layers=[{id:ewId(),name:"原图",ref:E.ref,x:0,y:0,w:E.image.naturalWidth,h:E.image.naturalHeight,opacity:1,visible:true}]; E.activeLayer=E.layers[0].id;
  E.layerBaseRef=E.ref;const version=E.n.versions.find(v=>v.ref===E.ref);if(version?.layer_stack?.layers?.length){E.layers=JSON.parse(JSON.stringify(version.layer_stack.layers));E.layerBaseRef=version.layer_stack.base_ref||E.ref;E.activeLayer=E.layers[E.layers.length-1].id;}
  E.layerBaseline=JSON.stringify(E.layers);E.assets.set(E.ref,E.image);
}
async function ewPreload(E,refs) {
  await Promise.all([...new Set(refs)].filter(Boolean).map(ref=>ewAsset(E,ref)));
}
function ewAsset(E,ref) {
  const cached=E.assets.get(ref); if(cached) return cached instanceof Promise ? cached : Promise.resolve(cached);
  const promise=new Promise((resolve,reject)=>{ const im=new Image();im.onload=()=>{ E.assets.set(ref,im);E.lightPreview=null;E.pixelPreviewKey=null;resolve(im);if(IMAGE_EDITOR===E) ieDraw(); };im.onerror=()=>{ E.assets.delete(ref);reject(new Error("图片加载失败")); };im.src=ewRefUrl(ref); });
  E.assets.set(ref,promise); return promise;
}
function ewLayerDirty(E) { if(E.layerBaseline===JSON.stringify(E.layers))return false;const l=E.layers;return l.length!==1 || l[0].ref!==E.ref || l[0].x || l[0].y || l[0].visible===false || l[0].opacity!==1 || l[0].w!==E.image.naturalWidth || l[0].h!==E.image.naturalHeight; }
async function ewFlatten(E) { if(!ewLayerDirty(E)) return E.ref; await ewPreload(E,E.layers.map(x=>x.ref)); const r=await api("/api/image-edit/layers",{ref:E.ref,layers:E.layers});return r.ref; }
function ewDrawLayers(E,ctx) {
  for(const layer of E.layers) { if(layer.visible===false) continue; const im=E.assets.get(layer.ref);if(!(im instanceof HTMLImageElement)) continue;
    ctx.save();ctx.globalAlpha=layer.opacity ?? 1;ctx.drawImage(im,layer.x||0,layer.y||0,layer.w||im.naturalWidth,layer.h||im.naturalHeight);ctx.restore(); }
}
function ewDrawEditor() {
  const E=IMAGE_EDITOR;if(!E || IE_WINDOW.collapsed || !$("#imageEditor").classList.contains("on")) return;
  const canvas=$(".ie-canvas",$("#imageEditor")),stage=canvas.parentElement,im=E.compare ? E.original : E.image;if(!im) {canvas.width=1;canvas.height=1;return;}
  const vw=Math.max(1,stage.clientWidth-32),vh=Math.max(1,stage.clientHeight-32);canvas.width=vw;canvas.height=vh;
  const pads=E.mode==="outpaint" && !E.compare ? iePadding() : {left:0,right:0,top:0,bottom:0};
  const split=!E.compare && E.compareMode!=="off" && (E.compareMode==="split" || E.original?.naturalWidth!==im.naturalWidth || E.original?.naturalHeight!==im.naturalHeight);
  const w=im.naturalWidth+pads.left+pads.right,h=im.naturalHeight+pads.top+pads.bottom,totalW=split ? w*2+32 : w;
  E.fitScale=Math.min(vw/totalW,vh/h,1);const scale=E.fitScale*E.zoom,tx=(vw-totalW*scale)/2+E.pan.x,ty=(vh-h*scale)/2+E.pan.y;
  E.view={scale,canvasTx:tx,canvasTy:ty,tx:tx+(split ? (w+32)*scale : 0)+pads.left*scale,ty:ty+pads.top*scale,totalW,h};
  const c=canvas.getContext("2d");c.save();c.translate(tx,ty);c.scale(scale,scale);
  if(split) { c.drawImage(E.original,0,0,w,h); c.translate(w+32,0); }
  if(E.mode==="outpaint" && !E.compare) {c.fillStyle="#d6d6dc29";c.fillRect(0,0,w,h);}
  c.translate(pads.left,pads.top);
  if(E.compare) c.drawImage(im,0,0);
  else {
    if(E.mode==="local") c.filter=`brightness(${$("#ieBrightness").value}%) contrast(${$("#ieContrast").value}%) saturate(${$("#ieSaturation").value}%)`;
    if(E.mode==="relight"||E.mode==="relight_ai") {
      try { c.drawImage(relightPreview(E),0,0,im.naturalWidth,im.naturalHeight); }
      catch {
        ewDrawLayers(E,c);
        if(!E.lightPreviewError)ieStatus("当前设备无法显示布光预览，可交给模型重打光",true);
        E.lightPreviewError=true;
      }
    } else ewDrawLayers(E,c);
    c.filter="none";
    if(E.compareMode==="wipe" && !split && E.original) {c.save();c.beginPath();c.rect(0,0,im.naturalWidth*E.split/100,im.naturalHeight);c.clip();c.drawImage(E.original,0,0);c.restore();c.strokeStyle="#fff";c.lineWidth=2/scale;c.beginPath();c.moveTo(im.naturalWidth*E.split/100,0);c.lineTo(im.naturalWidth*E.split/100,im.naturalHeight);c.stroke();}
    if(E.compareMode==="off") {
      if(E.mode==="relight"||E.mode==="relight_ai") {
        const {x,y}=relightSettings();
        c.beginPath();c.arc(im.naturalWidth*(x+100)/200,im.naturalHeight*(y+100)/200,8/scale,0,2*Math.PI);
        c.fillStyle="#f3e6c8";c.fill();c.strokeStyle="#19191c";c.lineWidth=2/scale;c.stroke();
      }
      if(E.mode==="region" && E.mask) { const tint=document.createElement("canvas");tint.width=Math.max(1,Math.round(im.naturalWidth*E.fitScale));tint.height=Math.max(1,Math.round(im.naturalHeight*E.fitScale));const tc=tint.getContext("2d");tc.drawImage(E.mask,0,0,tint.width,tint.height);tc.globalCompositeOperation="source-in";tc.fillStyle="#ef4acb77";tc.fillRect(0,0,tint.width,tint.height);c.drawImage(tint,0,0,im.naturalWidth,im.naturalHeight); }
      const rect=E.drawing?.tool==="rect" ? ieRect(E.drawing.points) : E.mode==="local" ? E.crop : null;
      if(rect) {c.strokeStyle="#ededf0";c.lineWidth=2/scale;c.setLineDash([6/scale,4/scale]);c.strokeRect(rect.x,rect.y,rect.w,rect.h);c.setLineDash([]);}
      const active=E.mode==="layers" ? E.layers.find(x=>x.id===E.activeLayer && x.visible!==false) : null;
      if(active) {c.strokeStyle="#5b8cff";c.lineWidth=2/scale;c.strokeRect(active.x,active.y,active.w,active.h);}
      if(E.tool==="smart" && E.mode==="region") for(const p of E.samPoints) {c.fillStyle=p.label ? "#d6d6dc" : "#ff5d5d";c.beginPath();c.arc(p.x,p.y,4/scale,0,Math.PI*2);c.fill();}
    }
  }
  c.restore();
  $("#ieZoomValue").textContent=Math.round(scale*100)+"%";
  if(E.image)updatePixelPreview(E);
  $(".ie-meta",$("#imageEditor")).textContent=`${w} × ${h}`;
  $(".ie-stage-note",$("#imageEditor")).textContent=E.compare ? "原图" : E.compareMode!=="off" ? (split ? "左：原图 · 右：当前结果" : "拖动上方滑杆对比原图") : E.mode==="layers" ? "拖动选中图层 · 背景可设为透明" : E.mode==="local" ? (E.crop ? `裁剪 ${E.crop.w} × ${E.crop.h}` : "拖动裁剪 · 空格拖动平移") : E.mode==="region" ? (E.tool==="smart" ? "点击选物 · Shift 点击排除 · B 画笔 / E 擦除" : "粉色为选区 · 滚轮缩放 · 空格拖动平移") : E.mode==="outpaint" ? "浅绿色区域将扩展生成" : "滚轮缩放 · 空格拖动平移";
}
function ewZoom(factor,anchor) {
  const E=IMAGE_EDITOR;if(!E?.view) return;
  const canvas=$(".ie-canvas",$("#imageEditor")); const x=anchor?.x ?? canvas.width/2,y=anchor?.y ?? canvas.height/2, old=E.view;
  const next=Math.max(.02,Math.min(8,old.scale*factor));
  E.pan.x=x-(x-old.canvasTx)*next/old.scale-(canvas.width-old.totalW*next)/2;
  E.pan.y=y-(y-old.canvasTy)*next/old.scale-(canvas.height-old.h*next)/2;
  E.zoom=next/E.fitScale;ieDraw();ewScheduleDraft();
}
function ewCursor(e,show=true) {
  const E=IMAGE_EDITOR,el=$("#ieBrushCursor");if(!E || !el) return;
  const visible=show && E.image && E.mode==="region" && ["brush","erase"].includes(E.tool) && !E.space && !E.busy && E.compareMode==="off";
  el.hidden=!visible;if(!visible) return;
  const parent=$(".ie-stage",$("#imageEditor")).getBoundingClientRect(),d=+$("#ieBrush").value*E.view.scale;
  Object.assign(el.style,{left:(e.clientX-parent.left)+"px",top:(e.clientY-parent.top)+"px",width:d+"px",height:d+"px"});
}
function ewPoint(E,e) {const r=e.currentTarget.getBoundingClientRect();return {x:(e.clientX-r.left-E.view.tx)/E.view.scale,y:(e.clientY-r.top-E.view.ty)/E.view.scale};}
function ewPointer(e,phase) {
  const E=IMAGE_EDITOR;if(!E?.image || E.restoring) return;
  ewCursor(e,phase!=="up");
  if(phase==="down" && (e.button===1 || E.space)) {e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);E.panning={x:e.clientX,y:e.clientY,pan:{...E.pan}};return;}
  if(E.panning) {E.pan={x:E.panning.pan.x+e.clientX-E.panning.x,y:E.panning.pan.y+e.clientY-E.panning.y};if(phase==="up") {E.panning=null;ewScheduleDraft();}ieDraw();return;}
  if(E.busy || E.n.job || E.compare || E.compareMode!=="off") return;
  if(phase==="down" && e.button!==0) return;
  const p=ewPoint(E,e),inside=p.x>=0 && p.y>=0 && p.x<E.image.naturalWidth && p.y<E.image.naturalHeight;
  if(phase==="down" && !inside) return;
  if(E.mode==="relight"||E.mode==="relight_ai") { relightPointer(E,e,phase,p);return; }
  if(phase==="down" && E.mode==="region" && E.tool==="smart") {e.preventDefault();ewSmartPoint(E,p,e.shiftKey ? 0 : 1);return;}
  if(E.mode==="layers") {
    if(phase==="down") {const l=E.layers.find(x=>x.id===E.activeLayer);if(!l)return;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);E.layerDrag={p,layer:l,x:l.x,y:l.y};}
    else if(E.layerDrag) {const d=E.layerDrag;d.layer.x=Math.round(d.x+p.x-d.p.x);d.layer.y=Math.round(d.y+p.y-d.p.y);if(phase==="up"){E.layerDrag=null;ewScheduleDraft(true);ewRenderLayers();}ieDraw();}
    return;
  }
  if(!["region","local"].includes(E.mode) || (phase!=="down" && !E.drawing)) return;
  e.preventDefault();p.x=Math.max(0,Math.min(E.image.naturalWidth-1,p.x));p.y=Math.max(0,Math.min(E.image.naturalHeight-1,p.y));
  if(phase==="down") {e.currentTarget.setPointerCapture(e.pointerId);E.drawing={tool:E.mode==="local" ? "rect" : E.tool,width:+$("#ieBrush").value,points:[p]};}
  else E.drawing.points.push(p);
  if(E.mode==="region" && E.drawing.tool!=="rect") iePaint(E.drawing,true);
  if(phase==="up") {if(E.mode==="local") E.crop=ieRect(E.drawing.points);else {ewPushStroke(E,E.drawing);if(E.drawing.tool==="rect") iePaint(E.drawing);}E.drawing=null;ewScheduleDraft(true);}
  ieDraw();
}
function ewPushStroke(E,stroke) {E.strokes.push(stroke);E.redo=[];}
function ewUndoMask(redo=false) {const E=IMAGE_EDITOR;if(!E || E.busy || E.n.job)return;const from=redo ? E.redo : E.strokes,to=redo ? E.strokes : E.redo;if(from.length)to.push(from.pop());ieRebuildMask();ewScheduleDraft(true);}
async function ewExportMask(E) {
  const mask=document.createElement("canvas");mask.width=E.mask.width;mask.height=E.mask.height;const c=mask.getContext("2d");c.fillStyle="black";c.fillRect(0,0,mask.width,mask.height);c.drawImage(E.mask,0,0);
  const blob=await new Promise(resolve=>mask.toBlob(resolve,"image/png"));if(!blob)throw new Error("无法导出选区");return ewUpload(blob,"selection.png");
}
async function ewUpload(file,name) {const form=new FormData();form.append("image",file,name || file.name || "layer.png");const r=await fetch("/api/upload",{method:"POST",body:form}),data=await r.json();if(!r.ok)throw new Error(data.error || "上传失败");return data;}
async function ewSmartPoint(E,p,label) {
  const old=[...E.samPoints];E.samPoints.push({...p,label});if(E.samPoints.length>32)E.samPoints.shift();E.busy=true;ieSync();ieStatus("正在识别选中物体…");
  try {const ref=await ewFlatten(E),r=await api("/api/image-edit/segment",{ref,points:E.samPoints});await ewAsset(E,r.ref);if(IMAGE_EDITOR!==E)return;ewPushStroke(E,{tool:"mask",ref:r.ref,replace:true});ieRebuildMask();ewScheduleDraft(true);ieStatus("已选中物体，可继续点击完善选区");}
  catch(err){E.samPoints=old;ieStatus(err.message,true);}finally{E.busy=false;ieSync();}
}
function ewRenderLayers() {
  const E=IMAGE_EDITOR;if(!E)return;const box=$("#ieLayerList");if(!E.layers.some(x=>x.id===E.activeLayer))E.activeLayer=E.layers[E.layers.length-1]?.id;
  box.innerHTML=[...E.layers].reverse().map(l=>`<div class="ie-layer ${l.id===E.activeLayer ? "on" : ""}" data-layer="${esc(l.id)}"><input type="checkbox" aria-label="显示 ${esc(l.name)}" ${l.visible!==false ? "checked" : ""}><img src="${ewRefUrl(l.ref)}" alt=""><button title="选择图层">${esc(l.name)}</button></div>`).join("");
  $$(".ie-layer",box).forEach(row=>{const l=E.layers.find(x=>x.id===row.dataset.layer);$("button",row).onclick=()=>{E.activeLayer=l.id;ewRenderLayers();ieDraw();ewScheduleDraft();};$("input",row).onchange=ev=>{if(E.busy || E.n.job){ev.target.checked=l.visible!==false;return;}l.visible=ev.target.checked;ieDraw();ewScheduleDraft();};});
  const l=E.layers.find(x=>x.id===E.activeLayer);for(const [k,key]of [["X","x"],["Y","y"],["Width","w"],["Height","h"]])$("#ieLayer"+k).value=l?.[key] ?? 0;
  $("#ieLayerOpacity").value=Math.round((l?.opacity ?? 1)*100);$("#ieLayerOpacityValue").textContent=$("#ieLayerOpacity").value+"%";
}
async function ewAddLayer(E,result,name,hideOthers=false) {
  if(E.layers.length>=16)throw new Error("最多保留 16 个图层，请先合并部分图层");
  const im=await ewAsset(E,result.ref);if(hideOthers)E.layers.forEach(x=>x.visible=false);
  const layer={id:ewId(),name,ref:result.ref,x:0,y:0,w:result.w || im.naturalWidth,h:result.h || im.naturalHeight,opacity:1,visible:true};
  if(layer.w>E.image.naturalWidth || layer.h>E.image.naturalHeight) {const s=Math.min(E.image.naturalWidth/layer.w,E.image.naturalHeight/layer.h);layer.w=Math.round(layer.w*s);layer.h=Math.round(layer.h*s);}
  E.layers.push(layer);E.activeLayer=layer.id;ewRenderLayers();ieMode("layers",true);ieDraw();ewScheduleDraft(true);
}
async function ewUtility(tool) {
  const E=IMAGE_EDITOR;if(!E?.image || E.busy || E.n.job)return;E.busy=true;ieSync();ieStatus(tool==="cutout" ? "正在智能抠图…" : "正在提取选区图层…");
  try {const ref=await ewFlatten(E);let result;if(tool==="cutout")result=await api("/api/image-edit/cutout",{ref});else {const mask=await ewExportMask(E);result=await api("/api/image-edit/selection-cutout",{ref,mask:mask.ref});}if(IMAGE_EDITOR!==E)return;await ewAddLayer(E,result,tool==="cutout" ? "智能抠图" : "选区图层",tool==="cutout");ieStatus("已添加透明图层，可调整后合并保存");}
  catch(err){ieStatus(err.message,true);}finally{E.busy=false;ieSync();}
}
async function ewCommitLayers() {const E=IMAGE_EDITOR;if(!E?.image || E.busy || E.n.job)return;E.busy=true;ieSync();ieStatus("正在合并图层…");try{const r=await api("/api/image-edit/layers",{ref:E.ref,layers:E.layers});ewScheduleDraft(true);addVersion(E.n,mediaVersion(r,{source:"edit",mode:"图层合并",layer_stack:{base_ref:E.layerBaseRef||E.ref,layers:JSON.parse(JSON.stringify(E.layers))},edit:{source:E.ref,mode:"layers"}}));ieLoad(curV(E.n));ieHistory();loadAssets();ieStatus("已保存为新的 PNG 版本，透明通道已保留");}catch(err){ieStatus(err.message,true);}finally{E.busy=false;ieSync();}}
function ewRefreshControls() {for(const [key,unit]of [["Brush"," px"],["Feather"," px"],["Strength","%"],["Brightness","%"],["Contrast","%"],["Saturation","%"],["Denoise","%"]])$("#ie"+key+"Value").textContent=$("#ie"+key).value+unit;ewBackend();$$("[data-tool]",$("#imageEditor")).forEach(b=>b.classList.toggle("on",b.dataset.tool===IMAGE_EDITOR?.tool));}
function ewBackend() {const native=!["camera","relight_ai"].includes(IMAGE_EDITOR?.mode) && $("#ieBackend").value==="native";$("#ieNativeSettings").hidden=!native;$("#ieProvider").disabled=native;}
function ewUpdateHistoryActions() {const E=IMAGE_EDITOR;if(!E)return;const edit=curV(E.n)?.edit;$("#ieReuse").disabled=!(edit?.recipe||edit?.light);$("#ieRetry").hidden=!E.n.data.lastImageEdit || !!E.n.job;$("#ieResultLayer").disabled=!edit?.layer;}
async function ewApplyRecipe(recipe) {
  const E=IMAGE_EDITOR;if(!E || !recipe || E.busy || E.n.job || E.agentSelection)return;ewScheduleDraft(true);await ewFlushDraft(E);
  let index=E.n.versions.findIndex(v=>v.ref===recipe.ref);
  if(index<0) {const im=await ewAsset(E,recipe.ref);E.n.versions.push({ref:recipe.ref,url:ewRefUrl(recipe.ref),w:im.naturalWidth,h:im.naturalHeight,source:"edit",mode:"参数原图",prompt:""});index=E.n.versions.length-1;}
  E.n.cur=index;save();render(E.n);refreshDownstream(E.n);drawEdges();await ieLoad(curV(E.n));
  if(IMAGE_EDITOR!==E)return;
  $("#iePrompt").value=recipe.prompt || "";$("#ieProvider").value=recipe.provider || "";$("#ieBackend").value=recipe.backend || "h3";
  for(const [id,key,d]of [["ieStrength","strength",1],["ieFeather","feather",8],["ieDenoise","denoise",.95],["ieSteps","steps",25],["ieSeed","seed",-1]])$("#"+id).value=(recipe[key] ?? d)*(id==="ieStrength" || id==="ieDenoise" ? 100 : 1);
  for(const side of ["left","right","top","bottom"])$("#iePad"+side[0].toUpperCase()+side.slice(1)).value=recipe.padding?.[side] || 0;
  E.strokes=[];E.redo=[];if(recipe.mask){await ewAsset(E,recipe.mask);E.strokes=[{tool:"mask",ref:recipe.mask,replace:true,luminance:true}];}
  if(recipe.camera_view)imageCameraSet(recipe.camera_view,recipe.count);
  if(recipe.relight)relightSet(recipe.relight);
  ieMode(recipe.camera_view ? "camera" : recipe.relight ? "relight_ai" : recipe.mode || "region");ieRebuildMask();ewRefreshControls();ewScheduleDraft(true);ieStatus("已复用原图、选区和生成参数");
}
function ewInitEditor(host) {
  $("#ieZoomIn").onclick=()=>ewZoom(1.25);$("#ieZoomOut").onclick=()=>ewZoom(.8);$("#ieActualSize").onclick=()=>{const E=IMAGE_EDITOR;if(E?.view)ewZoom(1/E.view.scale);};
  $("#ieFit").onclick=()=>{if(IMAGE_EDITOR){IMAGE_EDITOR.zoom=1;IMAGE_EDITOR.pan={x:0,y:0};ieDraw();ewScheduleDraft();}};
  $("#ieCompareMode").onchange=e=>{if(IMAGE_EDITOR){IMAGE_EDITOR.compareMode=e.target.value;$("#ieWipe").hidden=e.target.value!=="wipe";ieDraw();}};$("#ieWipe").oninput=e=>{if(IMAGE_EDITOR){IMAGE_EDITOR.split=+e.target.value;ieDraw();}};
  $("#ieRedoMask").onclick=()=>ewUndoMask(true);$("#ieUndoMask").onclick=()=>ewUndoMask();
  $("#ieClearMask").onclick=()=>{const E=IMAGE_EDITOR;if(E && !E.busy && !E.n.job){ewPushStroke(E,{tool:"clear"});E.samPoints=[];ieRebuildMask();ewScheduleDraft(true);}};
  $("#ieInvertMask").onclick=()=>{const E=IMAGE_EDITOR;if(E && !E.busy && !E.n.job){ewPushStroke(E,{tool:"invert"});ieRebuildMask();ewScheduleDraft(true);}};
  $("#ieCutout").onclick=()=>ewUtility("cutout");$("#ieSelectionLayer").onclick=()=>ewUtility("selection");$("#ieCutSelection").onclick=()=>ewUtility("selection");$("#ieSaveLayers").onclick=ewCommitLayers;
  $("#ieImportLayer").onclick=()=>{const E=IMAGE_EDITOR;if(!E || E.busy || E.n.job)return;pickFiles(async files=>{E.busy=true;ieSync();try{for(const f of files.filter(x=>x.type.startsWith("image/")))await ewAddLayer(E,await ewUpload(f),f.name.replace(/\.[^.]+$/,""));}catch(err){ieStatus(err.message,true);}finally{E.busy=false;ieSync();}});};
  for(const [id,delta]of [["ieLayerUp",1],["ieLayerDown",-1]])$("#"+id).onclick=()=>{const E=IMAGE_EDITOR;if(!E || E.busy || E.n.job)return;const i=E.layers.findIndex(x=>x.id===E.activeLayer),j=i+delta;if(j>=0 && j<E.layers.length){[E.layers[i],E.layers[j]]=[E.layers[j],E.layers[i]];ewRenderLayers();ieDraw();ewScheduleDraft();}};
  $("#ieLayerDelete").onclick=()=>{const E=IMAGE_EDITOR;if(!E || E.busy || E.n.job)return;if(E.layers.length<2)return ieStatus("至少保留一个图层",true);E.layers=E.layers.filter(x=>x.id!==E.activeLayer);ewRenderLayers();ieDraw();ewScheduleDraft();};
  for(const [id,key]of [["X","x"],["Y","y"],["Width","w"],["Height","h"]])$("#ieLayer"+id).onchange=e=>{const E=IMAGE_EDITOR;if(!E || E.busy || E.n.job)return;const l=E.layers.find(x=>x.id===E.activeLayer),v=+e.target.value;if(l && Number.isFinite(v))l[key]=Math.round(Math.max(key==="w" || key==="h" ? 1 : -8192,Math.min(8192,v)));ewRenderLayers();ieDraw();ewScheduleDraft();};
  $("#ieLayerOpacity").oninput=e=>{const E=IMAGE_EDITOR;if(!E || E.busy || E.n.job)return;const l=E.layers.find(x=>x.id===E.activeLayer);if(l)l.opacity=+e.target.value/100;$("#ieLayerOpacityValue").textContent=e.target.value+"%";ieDraw();ewScheduleDraft();};
  $("#ieResultLayer").onclick=async()=>{const E=IMAGE_EDITOR,edit=curV(E?.n)?.edit,r=edit?.layer;if(!E || !r || E.busy || E.n.job)return;try{ewScheduleDraft(true);const ref=edit.base || edit.source,im=await ewAsset(E,ref);E.layers=[{id:ewId(),name:"编辑前原图",ref,x:0,y:0,w:im.naturalWidth,h:im.naturalHeight,opacity:1,visible:true}];await ewAddLayer(E,r,"生成选区图层");}catch(err){ieStatus(err.message,true);}};
  $("#ieReuse").onclick=async()=>{
    const E=IMAGE_EDITOR,edit=curV(E?.n)?.edit;
    if(!edit?.light)return ewApplyRecipe(edit?.recipe);
    if(E.busy || E.n.job || E.agentSelection)return;
    try {
      await ewApplyRecipe({ref:edit.source,mode:"relight"});
      if(IMAGE_EDITOR===E){relightSet(edit.light);ieDraw();ewScheduleDraft(true);ieStatus("已恢复原图和布光参数");}
    }catch(error){if(IMAGE_EDITOR===E)ieStatus(error.message,true);}
  };
  $("#ieRetry").onclick=async()=>{const E=IMAGE_EDITOR;if(!E?.n.data.lastImageEdit || E.busy || E.n.job)return;try{await ewApplyRecipe(E.n.data.lastImageEdit);await ieGenerate();}catch(err){ieStatus(err.message,true);}};
  $("#ieBackend").onchange=()=>{ewBackend();ewScheduleDraft();};$("#ieDenoise").oninput=e=>$("#ieDenoiseValue").textContent=e.target.value+"%";
  for(const event of ["input","change"])host.addEventListener(event,e=>{if(e.target.closest(".ie-side"))ewScheduleDraft();});
  const canvas=$(".ie-canvas",host);canvas.addEventListener("wheel",e=>{e.preventDefault();const r=canvas.getBoundingClientRect();ewZoom(Math.exp(-e.deltaY*.0015),{x:e.clientX-r.left,y:e.clientY-r.top});},{passive:false});
  canvas.addEventListener("pointerleave",e=>ewCursor(e,false));canvas.addEventListener("contextmenu",e=>e.preventDefault());
  host.addEventListener("keyup",e=>{if(e.code==="Space" && IMAGE_EDITOR){IMAGE_EDITOR.space=false;canvas.classList.remove("pan");}});
  addEventListener("blur",()=>{if(IMAGE_EDITOR){IMAGE_EDITOR.space=false;IMAGE_EDITOR.panning=null;$("#ieBrushCursor").hidden=true;}});
  addEventListener("pagehide",()=>{const E=IMAGE_EDITOR;if(!E)return;const snapshot=ewSnapshot(E);if(!snapshot)return;const body=JSON.stringify(snapshot);try{localStorage.setItem(ewDraftKey(E,E.ref),body);}catch{}if(body.length<60000)navigator.sendBeacon(ewDraftUrl(E),new Blob([body],{type:"application/json"}));});
}
async function ewCapabilities(E) {try{const r=await fetch("/api/image-edit/capabilities");E.capabilities=await r.json();if(IMAGE_EDITOR!==E)return;$("[data-tool=smart]",$("#imageEditor")).disabled=!E.capabilities.segment;$("#ieCutout").disabled=!E.capabilities.cutout;$("#ieBackend option[value=native]").disabled=!E.capabilities.native;}catch{} }
function ewKey(e) {
  const E=IMAGE_EDITOR;if(!E || e.target.closest("input,textarea,select"))return false;
  const mod=e.metaKey || e.ctrlKey,k=e.key.toLowerCase();
  if(mod && k==="z"){e.preventDefault();ewUndoMask(e.shiftKey);return true;}if(mod && k==="y"){e.preventDefault();ewUndoMask(true);return true;}
  if(e.code==="Space"){e.preventDefault();E.space=true;$(".ie-canvas",$("#imageEditor")).classList.add("pan");return true;}
  if(!mod && !e.altKey){const tools={b:"brush",e:"erase",r:"rect",w:"smart"};if(tools[k]){$("[data-tool="+tools[k]+"]",$("#imageEditor")).click();return true;}if(k==="[" || k==="]"){$("#ieBrush").value=Math.max(4,Math.min(512,+$("#ieBrush").value+(k==="[" ? -8 : 8)));ewRefreshControls();ewScheduleDraft();return true;}if(k==="0"){$("#ieFit").click();return true;}}
  return false;
}
