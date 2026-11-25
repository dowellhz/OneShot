"use strict";

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
