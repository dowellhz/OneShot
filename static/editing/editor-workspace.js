"use strict";
// Editing workspace: viewport, recoverable drafts, selections, layers and reusable recipes.
const EW_PHASES={loading:"加载模型",encoding:"处理提示词与参考图",sampling:"生成画面",decoding:"解码图像",compositing:"合成选区",watermark:"写入 AI 水印",done:"已完成"};
const ewRefUrl=ref=>"/media?ref="+encodeURIComponent(ref);
const ewId=()=>"l"+Date.now().toString(36)+Math.random().toString(36).slice(2,7);
function ewNewState(n) { return {board:boardId,zoom:1,pan:{x:0,y:0},fitScale:1,redo:[],assets:new Map(),samPoints:[],layers:[],activeLayer:null,compareMode:"off",split:50,restoring:false,draftChain:Promise.resolve(),draftTimer:0,space:false,capabilities:{}}; }
function ewToolbarHTML() { return OneShotI18n.html`<div class="ie-viewtools"><button id="ieZoomOut" title="缩小">−</button><span id="ieZoomValue" class="num">100%</span><button id="ieZoomIn" title="放大">＋</button><button id="ieActualSize">100%</button><button id="ieFit">适应窗口</button><span class="ie-spacer"></span><select id="ieCompareMode" aria-label="原图对比方式"><option value="off">编辑视图</option><option value="wipe">滑杆对比</option><option value="split">并排对比</option></select><input id="ieWipe" type="range" min="0" max="100" value="50" aria-label="原图对比分界" hidden></div>`; }
function ewLayersHTML() { return OneShotI18n.html`<div class="ie-section" data-section="layers"><div class="ie-row"><button id="ieImportLayer">导入图片</button><button id="ieCutout">智能抠图</button><button id="ieDecompose" disabled>自动分层</button></div><button id="ieFillBackground" hidden>补全分层背景</button><p class="ie-note">拖动图层调整位置，或修改坐标与尺寸。图层从上到下显示；隐藏背景可导出透明 PNG。</p><div id="ieLayerList"></div><div class="ie-row"><button id="ieUndoLayer" disabled>撤销图层编辑</button><button id="ieRedoLayer" disabled>重做图层编辑</button></div><div class="ie-row"><button id="ieLayerUp">上移</button><button id="ieLayerDown">下移</button><button id="ieLayerDelete">删除</button></div><div class="ie-padding">${[["X","X"],["Y","Y"],["Width","宽度"],["Height","高度"]].map(([k,t])=>`<label>${t}<input id="ieLayer${k}" type="number" step="1"></label>`).join("")}</div><label class="ie-label" for="ieLayerOpacity">图层不透明度<output id="ieLayerOpacityValue">100%</output></label><input id="ieLayerOpacity" type="range" min="0" max="100" value="100"><div class="ie-row"><button id="ieSelectionLayer">选区转图层</button><button id="ieResultLayer">提取生成图层</button></div><div class="ie-row"><button id="ieExportLayer" disabled title="以图层原始尺寸和透明通道创建独立图片">将选中图层放入画布</button><button id="ieOpenLayerBatch" disabled>批量放入画布</button></div><fieldset id="ieLayerBatch" hidden><legend>选择要放入画布的图层</legend><div id="ieLayerBatchList"></div><div class="ie-row"><button id="ieCloseLayerBatch">收起</button><button id="ieConfirmLayerBatch">放入画布</button></div></fieldset><button id="ieLocateLayer" hidden>定位导出图</button><div class="ie-row"><button id="ieDownloadLayers" disabled>下载可编辑图层（.ora）</button></div><button id="ieSaveLayers" class="ie-primary">合并保存为新版本</button></div>`; }
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
      ieMode(["region","whole","outpaint","local","layers","relight","relight_ai","camera","upscale"].includes(draft.mode) ? draft.mode : "region");
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
  E.layerUndo=[]; E.layerRedo=[]; E.layerOpacityBefore=null; E.layerDrag=null;
  $("#ieLayerBatch").hidden=true;
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
      if(active) {
        c.strokeStyle="#5b8cff";
        c.lineWidth=2/scale;
        c.strokeRect(active.x,active.y,active.w,active.h);
        if (canvasCanEdit() && !E.busy && !E.n.job) {
          c.fillStyle="#ededf0";
          const radius=4/scale;
          for (const corner of ewLayerCorners(active)) {
            c.fillRect(corner.x-radius,corner.y-radius,2*radius,2*radius);
            c.strokeRect(corner.x-radius,corner.y-radius,2*radius,2*radius);
          }
        }
      }
      if(E.tool==="smart" && E.mode==="region") for(const p of E.samPoints) {c.fillStyle=p.label ? "#d6d6dc" : "#ff5d5d";c.beginPath();c.arc(p.x,p.y,4/scale,0,Math.PI*2);c.fill();}
    }
  }
  c.restore();
  $("#ieZoomValue").textContent=Math.round(scale*100)+"%";
  if(E.image)updatePixelPreview(E);
  $(".ie-meta",$("#imageEditor")).textContent=`${w} × ${h}`;
  $(".ie-stage-note",$("#imageEditor")).textContent=E.compare ? "原图" : E.compareMode!=="off" ? (split ? "左：原图 · 右：当前结果" : "拖动上方滑杆对比原图") : E.mode==="layers" ? "拖角点调整大小 · Shift 等比 · Alt / Option 拖动当前图层" : E.mode==="local" ? (E.crop ? `裁剪 ${E.crop.w} × ${E.crop.h}` : "拖动裁剪 · 空格拖动平移") : E.mode==="region" ? (E.tool==="smart" ? "点击选物 · Shift 点击排除 · B 画笔 / E 擦除" : "粉色为选区 · 滚轮缩放 · 空格拖动平移") : E.mode==="outpaint" ? "浅绿色区域将扩展生成" : "滚轮缩放 · 空格拖动平移";
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

const EW_LAYER_SIDES=[[-1,-1],[1,-1],[-1,1],[1,1]];
function ewLayerCorners(layer) {
  return EW_LAYER_SIDES.map(([dx,dy])=>({
    x:layer.x+(dx>0?layer.w:0), y:layer.y+(dy>0?layer.h:0), dx, dy
  }));
}

function ewLayerCornerAt(E, layer, point) {
  const radius=8/E.view.scale;
  let nearest=null, distance=radius*radius;
  for (const corner of ewLayerCorners(layer)) {
    const candidate=(point.x-corner.x)**2+(point.y-corner.y)**2;
    if (candidate<=distance) { nearest=corner; distance=candidate; }
  }
  return nearest;
}

function ewResizeLayer(drag, point, proportional) {
  const {corner,rect,p}=drag, maxSide=8192, maxPixels=32*1024*1024;
  const anchorX=rect.x+(corner.dx<0?rect.w:0), anchorY=rect.y+(corner.dy<0?rect.h:0);
  const maxW=corner.dx<0?Math.min(maxSide,anchorX+maxSide):maxSide;
  const maxH=corner.dy<0?Math.min(maxSide,anchorY+maxSide):maxSide;
  const minW=corner.dx<0?Math.max(1,anchorX-maxSide):1;
  const minH=corner.dy<0?Math.max(1,anchorY-maxSide):1;
  let w=rect.w+(point.x-p.x)*corner.dx, h=rect.h+(point.y-p.y)*corner.dy;
  if (proportional) {
    const scale=(w*rect.w+h*rect.h)/(rect.w**2+rect.h**2);
    const minScale=Math.max(minW/rect.w,minH/rect.h);
    const maxScale=Math.min(maxW/rect.w,maxH/rect.h,Math.sqrt(maxPixels/(rect.w*rect.h)));
    if (maxScale<minScale) return rect;
    const bounded=Math.min(maxScale,Math.max(minScale,scale));
    w=rect.w*bounded;h=rect.h*bounded;
  } else {
    w=Math.min(maxW,Math.max(minW,w));
    h=Math.min(maxH,Math.max(minH,h));
    const factor=Math.min(1,Math.sqrt(maxPixels/(w*h)));
    w=Math.max(minW,w*factor);h=Math.max(minH,h*factor);
  }
  const round=Math.round(w)*Math.round(h)<=maxPixels ? Math.round : Math.floor;
  w=Math.max(minW,round(w));h=Math.max(minH,round(h));
  if (w*h>maxPixels) h=Math.floor(maxPixels/w);
  if (h<minH) return rect;
  return {x:corner.dx<0?anchorX-w:rect.x,y:corner.dy<0?anchorY-h:rect.y,w,h};
}

function ewLayerAtPoint(E, point) {
  for (let index=E.layers.length-1; index>=0; index--) {
    const layer=E.layers[index], opacity=layer.opacity ?? 1;
    if (layer.visible===false || opacity<=0) continue;
    const image=E.assets.get(layer.ref);
    if (!(image instanceof HTMLImageElement)) continue;
    const width=layer.w || image.naturalWidth, height=layer.h || image.naturalHeight;
    const x=point.x-(layer.x || 0), y=point.y-(layer.y || 0);
    if (x<0 || y<0 || x>=width || y>=height) continue;
    const sx=Math.floor(x*image.naturalWidth/width), sy=Math.floor(y*image.naturalHeight/height);
    if (!E.layerHitCanvas) {
      E.layerHitCanvas=document.createElement("canvas");
      E.layerHitCanvas.width=E.layerHitCanvas.height=1;
    }
    const context=E.layerHitCanvas.getContext("2d",{willReadFrequently:true});
    context.clearRect(0,0,1,1);
    context.drawImage(image,sx,sy,1,1,0,0,1,1);
    try {
      if (context.getImageData(0,0,1,1).data[3]*opacity>=1) return layer;
    } catch (error) {
      if (error.name!=="SecurityError") throw error;
      E.layerHitCanvas=null;
      return layer;
    }
  }
  return null;
}

function ewLayerPointer(E, event, phase, point, inside) {
  const active=E.layers.find(item=>item.id===E.activeLayer && item.visible!==false);
  const corner=E.layerDrag?.corner || (!E.layerDrag && active && !event.altKey && ewLayerCornerAt(E,active,point));
  event.currentTarget.dataset.layerResize=corner ? (corner.dx===corner.dy?"nwse":"nesw") : "";
  if (phase==="down") {
    if (E.layerDrag || (!inside && !corner)) return;
    const layer=corner || event.altKey ? active : ewLayerAtPoint(E,point);
    if (!layer) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    E.activeLayer=layer.id;
    const rect={x:layer.x || 0,y:layer.y || 0,w:layer.w,h:layer.h};
    E.layerDrag={p:point,layer,rect,corner,before:ewLayerState(E)};
    ewRenderLayers();
  } else if (E.layerDrag) {
    const drag=E.layerDrag;
    if (drag.corner) Object.assign(drag.layer,ewResizeLayer(drag,point,event.shiftKey));
    else {
      drag.layer.x=Math.round(drag.rect.x+point.x-drag.p.x);
      drag.layer.y=Math.round(drag.rect.y+point.y-drag.p.y);
    }
    if (phase==="up") {
      E.layerDrag=null;
      ewRecordLayers(E,drag.before);
      ewRenderLayers();
      ewScheduleDraft(true);
    }
  }
  ieDraw();
}

function ewPointer(e,phase) {
  const E=IMAGE_EDITOR;if(!E?.image || E.restoring) return;
  ewCursor(e,phase!=="up");
  if(phase==="down" && (e.button===1 || E.space)) {e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);E.panning={x:e.clientX,y:e.clientY,pan:{...E.pan}};return;}
  if(E.panning) {E.pan={x:E.panning.pan.x+e.clientX-E.panning.x,y:E.panning.pan.y+e.clientY-E.panning.y};if(phase==="up") {E.panning=null;ewScheduleDraft();}ieDraw();return;}
  if(E.busy || E.n.job || E.compare || E.compareMode!=="off") return;
  if(phase==="down" && e.button!==0) return;
  const p=ewPoint(E,e),inside=p.x>=0 && p.y>=0 && p.x<E.image.naturalWidth && p.y<E.image.naturalHeight;
  if(E.mode==="layers") {
    if (canvasCanEdit()) ewLayerPointer(E,e,phase,p,inside);
    return;
  }
  if(phase==="down" && !inside) return;
  if(E.mode==="relight"||E.mode==="relight_ai") { relightPointer(E,e,phase,p);return; }
  if(phase==="down" && E.mode==="region" && E.tool==="smart") {e.preventDefault();ewSmartPoint(E,p,e.shiftKey ? 0 : 1);return;}
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
  $("#ieCutout").onclick=()=>ewUtility("cutout");$("#ieDecompose").onclick=ewDecompose;$("#ieSelectionLayer").onclick=()=>ewUtility("selection");$("#ieCutSelection").onclick=()=>ewUtility("selection");$("#ieSaveLayers").onclick=ewCommitLayers;
  $("#ieUndoLayer").onclick=()=>ewStepLayerHistory();
  $("#ieRedoLayer").onclick=()=>ewStepLayerHistory(true);
  $("#ieExportLayer").onclick=()=>{
    const E=IMAGE_EDITOR;
    if (!E || $("#ieExportLayer").disabled) return;
    void ewExportLayers(E,E.layers.filter(layer=>layer.id===E.activeLayer));
  };
  $("#ieDownloadLayers").onclick=ewDownloadLayers;
  $("#ieOpenLayerBatch").onclick=()=>ewOpenLayerBatch(IMAGE_EDITOR);
  $("#ieCloseLayerBatch").onclick=()=>{$("#ieLayerBatch").hidden=true;$("#ieOpenLayerBatch").focus();};
  $("#ieLayerBatchList").onchange=()=>ewLayerExportControls(IMAGE_EDITOR);
  $("#ieConfirmLayerBatch").onclick=()=>ewConfirmLayerBatch(IMAGE_EDITOR);
  $("#ieFillBackground").onclick=ewFillBackground;
  $("#ieLocateLayer").onclick=()=>{
    const E=IMAGE_EDITOR;
    const images=(E?.layerExportIds || []).map(node).filter(Boolean);
    if (!images.length || E.busy) return;
    closeImageEditor(false);
    sel=new Set(images.map(image=>image.id));
    updateSel();fit(images);
  };
  $("#ieImportLayer").onclick=()=>{
    const E=IMAGE_EDITOR;
    if (!E || E.busy || E.n.job) return;
    pickFiles(async files=>{
      if (IMAGE_EDITOR!==E) return;
      if (files.some(file=>/\.ora$/i.test(file.name))) {
        ieStatus("请把 .ora 文件拖到画布，或从图片节点上传为新版本，以保留全部图层");
        return;
      }
      E.busy=true;
      ieSync();
      try {
        for (const file of files.filter(item=>item.type.startsWith("image/"))) {
          await ewAddLayer(E,await ewUpload(file),file.name.replace(/\.[^.]+$/,""));
        }
      } catch (error) {
        ieStatus(error.message,true);
      } finally {
        E.busy=false;
        ieSync();
      }
    });
  };
  for (const [id,delta] of [["ieLayerUp",1],["ieLayerDown",-1]]) $("#"+id).onclick=()=>{
    const E=IMAGE_EDITOR;
    if (!E || E.busy || E.n.job) return;
    const index=E.layers.findIndex(layer=>layer.id===E.activeLayer), next=index+delta;
    if (index<0 || next<0 || next>=E.layers.length) return;
    const before=ewLayerState(E);
    [E.layers[index],E.layers[next]]=[E.layers[next],E.layers[index]];
    ewRecordLayers(E,before);
    ewRenderLayers();ieDraw();ewScheduleDraft();
  };
  $("#ieLayerDelete").onclick=()=>{
    const E=IMAGE_EDITOR;
    if (!E || E.busy || E.n.job) return;
    if (E.layers.length<2) return ieStatus("至少保留一个图层",true);
    const before=ewLayerState(E);
    E.layers=E.layers.filter(layer=>layer.id!==E.activeLayer);
    ewRenderLayers();
    ewRecordLayers(E,before);
    ieDraw();ewScheduleDraft();
  };
  for (const [id,key] of [["X","x"],["Y","y"],["Width","w"],["Height","h"]]) $("#ieLayer"+id).onchange=e=>{
    const E=IMAGE_EDITOR;
    if (!E || E.busy || E.n.job) return;
    const layer=E.layers.find(item=>item.id===E.activeLayer), value=+e.target.value;
    if (layer && Number.isFinite(value)) {
      const before=ewLayerState(E), min=key==="w" || key==="h" ? 1 : -8192;
      layer[key]=Math.round(Math.max(min,Math.min(8192,value)));
      ewRecordLayers(E,before);
    }
    ewRenderLayers();ieDraw();ewScheduleDraft();
  };
  $("#ieLayerOpacity").oninput=e=>{
    const E=IMAGE_EDITOR;
    if (!E || E.busy || E.n.job) return;
    const layer=E.layers.find(item=>item.id===E.activeLayer);
    if (!layer) return;
    E.layerOpacityBefore??=ewLayerState(E);
    layer.opacity=+e.target.value/100;
    $("#ieLayerOpacityValue").textContent=e.target.value+"%";
    ieDraw();ewScheduleDraft();
  };
  $("#ieLayerOpacity").onchange=$("#ieLayerOpacity").onblur=()=>ewFinishLayerOpacity(IMAGE_EDITOR);
  $("#ieResultLayer").onclick=async()=>{const E=IMAGE_EDITOR,edit=curV(E?.n)?.edit,r=edit?.layer;if(!E || !r || E.busy || E.n.job)return;E.busy=true;ieSync();try{const ref=edit.base || edit.source,im=await ewAsset(E,ref);await ewAddLayer(E,r,"生成选区图层",false,{id:ewId(),name:"编辑前原图",ref,x:0,y:0,w:im.naturalWidth,h:im.naturalHeight,opacity:1,visible:true});}catch(err){ieStatus(err.message,true);}finally{E.busy=false;ieSync();}};
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
  addEventListener("blur",()=>{if(IMAGE_EDITOR){IMAGE_EDITOR.space=false;IMAGE_EDITOR.panning=null;ewCancelLayerDrag(IMAGE_EDITOR);$("#ieBrushCursor").hidden=true;}});
  addEventListener("pagehide",()=>{const E=IMAGE_EDITOR;if(!E)return;const snapshot=ewSnapshot(E);if(!snapshot)return;const body=JSON.stringify(snapshot);try{localStorage.setItem(ewDraftKey(E,E.ref),body);}catch{}if(body.length<60000)navigator.sendBeacon(ewDraftUrl(E),new Blob([body],{type:"application/json"}));});
}
async function ewCapabilities(E) {try{const r=await fetch("/api/image-edit/capabilities");E.capabilities=await r.json();if(IMAGE_EDITOR!==E)return;ieUpscaleControls(E);ewDecomposeControl(E);$("[data-tool=smart]",$("#imageEditor")).disabled=!E.capabilities.segment;$("#ieCutout").disabled=!E.capabilities.cutout;$("#ieBackend option[value=native]").disabled=!E.capabilities.native;}catch{} }
function ewKey(e) {
  const E=IMAGE_EDITOR;if(!E)return false;
  const mod=e.metaKey || e.ctrlKey,k=e.key.toLowerCase();
  const historyKey=mod && (k==="z" || k==="y");
  const form=e.target.closest("input,textarea,select");
  if (form && !(E.mode==="layers" && historyKey && form.matches("input[type=range],input[type=checkbox]"))) return false;
  if(historyKey){
    e.preventDefault();
    const redo=k==="y" || e.shiftKey;
    if (E.mode==="layers") ewStepLayerHistory(redo);
    else ewUndoMask(redo);
    return true;
  }
  if(e.code==="Space"){e.preventDefault();E.space=true;$(".ie-canvas",$("#imageEditor")).classList.add("pan");return true;}
  if(!mod && !e.altKey){const tools={b:"brush",e:"erase",r:"rect",w:"smart"};if(tools[k]){$("[data-tool="+tools[k]+"]",$("#imageEditor")).click();return true;}if(k==="[" || k==="]"){$("#ieBrush").value=Math.max(4,Math.min(512,+$("#ieBrush").value+(k==="[" ? -8 : 8)));ewRefreshControls();ewScheduleDraft();return true;}if(k==="0"){$("#ieFit").click();return true;}}
  return false;
}
