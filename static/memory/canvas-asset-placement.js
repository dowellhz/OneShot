"use strict";

// ================================================================= asset library (characters / scenes / props)
let libCache = null;
async function loadLibrary() { return cmList(); }
async function renderLibrary(kind) { return cmRenderLibrary(kind); }

const libraryPlacementRequests = new Set();
function placeLibraryAsset(asset, at, onPlaced, onError=message=>toast(message)) {
  const bid = boardId, board = B;
  const place = current => {
    if (B !== board || !canvasCanEdit()) return;
    try { const placed = placeLibAsset(current,at); onPlaced?.(); return placed; }
    catch (error) { onError(error.message); }
  };
  if (!asset.team && (asset.ref || !asset.document || typeof asset.document.text === "string")) return place(asset);
  const path = "/api/memory/" + encodeURIComponent(asset.id) + "?board=" + encodeURIComponent(bid);
  if (libraryPlacementRequests.has(path)) return;
  libraryPlacementRequests.add(path);
  return boardRequest(path).then(detail=>{
    if (!detail.ref && detail.document && typeof detail.document.text !== "string") throw new Error("资产正文已变更，请刷新资产库");
    return place(detail);
  }).catch(error=>{if (B === board) onError(error.message);})
    .finally(()=>libraryPlacementRequests.delete(path));
}

function libraryPrimary(a) {
  return a.ref ? a : (a.media || []).find(m=>["video","audio"].includes(cmMediaType(m.ref,m)));
}

function libraryNodeSpec(a, media=libraryPrimary(a)) {
  const ref=media?.ref;
  const asset={id:a.id,kind:a.kind};
  if (!ref) {
    const sourceDoc = a.document;
    const content = sourceDoc?.format ? sourceDoc.text : [a.desc, sourceDoc?.text, a.constraints && "使用约束：" + a.constraints].filter(Boolean).join("\n\n");
    if (content.length > 20_000) throw new Error("正文超过单个画布文档的 20,000 字符上限，可在资产库查看全文");
    const data={text:content,...(sourceDoc?.format==="markdown"?{text_format:"markdown"}:{}),asset};
    return {type:"text",name:a.name,data,versions:[],cur:-1};
  }
  const type=a.ref===ref?"image":cmMediaType(ref,media);
  const data={caption:a.desc||"",aspect:"auto",asset};
  const version={ref,url:"/media?ref="+encodeURIComponent(ref),w:media.w,h:media.h,seconds:media.seconds,source:"asset",prompt:""};
  return {type,name:a.name,data,versions:[version],cur:0};
}

function buildCanvasMediaNode(spec, at) {
  const {type,data,name,versions,cur,id}=spec;
  const n=addNode(type,at.x,at.y,data,{name,versions,cur,...(id?{id}:{})});
  const version=curV(n);
  if (type==="video" && (!version.w || !version.h || !version.seconds)
    || type==="audio" && !version.seconds) {
    const probe = document.createElement(type), bid = boardId;
    probe.preload = "metadata";
    probe.onloadedmetadata = () => {
      if (boardId === bid && node(n.id) === n) {
        if(probe.videoWidth && probe.videoHeight){version.w=probe.videoWidth;version.h=probe.videoHeight;}
        if(Number.isFinite(probe.duration) && probe.duration>0)version.seconds=probe.duration;
        render(n);save();
      }
      probe.onloadedmetadata = probe.onerror = null; probe.removeAttribute("src");
    };
    probe.onerror = () => { probe.onloadedmetadata = probe.onerror = null; probe.removeAttribute("src"); };
    probe.src = version.url;
  }
  return n;
}

function placeLibAsset(a, at) {
  const spec=libraryNodeSpec(a);
  checkpoint();
  const n=buildCanvasMediaNode(spec,at);
  selectOnly(n.id);
  return n;
}

function placeLibraryBatch(items, at) {
  return placeCanvasNodeBatch(items.map(libraryNodeSpec),at);
}
function placeCanvasNodeBatch(specs, at) {
  if(!specs.length)return [];
  checkpoint();
  const made=[];
  let x=at.x,y=at.y,rowEnd=y;
  for(const spec of specs){
    const version=spec.versions[spec.cur];
    const dims=spec.type==="video" && (!version?.w || !version?.h)
      ? {w:520,h:970}:size({...spec,data:{...defaults(spec.type),...spec.data}});
    const spot=freeSpot(x,y,spec.type,dims);
    made.push(buildCanvasMediaNode(spec,spot));
    x=spot.x+dims.w+100;
    rowEnd=Math.max(rowEnd,spot.y+dims.h+90);
    if(made.length%3===0){x=at.x;y=rowEnd;}
  }
  sel=new Set(made.map(n=>n.id));
  updateSel();drawEdges();save();
  return made;
}
