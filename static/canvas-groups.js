"use strict";

const CT_GROUPS = new Map(), CT_FOLDED_NODES = new Map(), CT_FOLD_BOXES = new Map();

function ctGroupBounds(nodes) {
  const rects = nodes.map(n => ({...n,...size(n)}));
  return {x:Math.min(...rects.map(n=>n.x))-20,y:Math.min(...rects.map(n=>n.y))-64,
    right:Math.max(...rects.map(n=>n.x+n.w))+20,bottom:Math.max(...rects.map(n=>n.y+n.h))+20};
}

function ctFolded(id) { return CT_FOLDED_NODES.get(id); }
function ctCanvasRects(nodes=B.nodes) {
  const rects = new Map();
  for (const n of nodes) {
    const group = ctFolded(n.id);
    if (group) rects.set("group:"+group.id,CT_FOLD_BOXES.get(group.id));
    else rects.set(n.id,{id:n.id,type:n.type,x:n.x,y:n.y,...size(n)});
  }
  return [...rects.values()];
}

function ctNewGroup(name, ids) {
  const group={id:"g"+Date.now().toString(36)+Math.random().toString(36).slice(2,6),name,nodes:ids};
  (B.groups ||= []).push(group);
  return group;
}

function ctGroup(fold=false) {
  if (!canvasCanEdit()) return;
  const members = ctSelected();
  if (members.length < 2) return toast("至少选择两个节点");
  const ids = members.map(n=>n.id), chosen = new Set(ids);
  const existing = (B.groups || []).find(g=>g.nodes.length===ids.length && g.nodes.every(id=>chosen.has(id)));
  if (fold && existing) return ctSetFold(existing,true);
  checkpoint();
  B.groups = (B.groups || []).map(g=>({...g,nodes:g.nodes.filter(id=>!chosen.has(id))})).filter(g=>g.nodes.length);
  const group = ctNewGroup("分组 "+(B.groups.length+1),ids);
  if (fold) ctSetFold(group,true,{recordUndo:false});
  else { drawEdges(); save(); toast("已编组，拖动分组标题可整体移动"); }
}

function ctUngroup(ids=sel) {
  if (!canvasCanEdit()) return;
  const chosen = new Set(ids), groups = (B.groups || []).filter(g=>g.nodes.some(id=>chosen.has(id)));
  if (!groups.length) return toast("选中的节点没有编组");
  checkpoint();
  const remove = new Set(groups.map(g=>g.id));
  B.groups = B.groups.filter(g=>!remove.has(g.id));
  drawEdges(); updateSel(); save(); toast("已取消编组");
}

function ctSetFold(group, folded, {recordUndo=true,anchor}={}) {
  const members = group.nodes.map(node).filter(Boolean);
  if (members.length < 2 || !!group.collapsed===folded) return;
  if (recordUndo && canvasCanEdit()) checkpoint();
  if (folded) {
    const {x,y} = anchor || ctGroupBounds(members);
    group.collapsed = true;
    group.fold = {x,y};
    members.forEach(n=>sel.delete(n.id));
    selEdge = null;
  } else {
    delete group.collapsed;
    delete group.fold;
  }
  drawEdges(); updateSel(); save();
}

function ctRevealSelected() {
  const groups = new Set([...sel].map(ctFolded).filter(Boolean));
  if (!groups.size) return;
  for (const group of groups) { delete group.collapsed; delete group.fold; }
  drawEdges();
  save();
}

let ctGroupDropElement = null;
function ctGroupDropTarget(event, source=null) {
  const p=toW(event.clientX,event.clientY);
  for(const group of B.groups || []) {
    if(group===source)continue;
    const box=CT_FOLD_BOXES.get(group.id);
    if(box && p.x>=box.x && p.x<=box.x+box.w && p.y>=box.y && p.y<=box.y+box.h)return group;
  }
  return null;
}

function ctMarkGroupDrop(group) {
  ctGroupDropElement?.classList.remove("cg-drop-target");
  ctGroupDropElement=CT_GROUPS.get(group?.id);
  ctGroupDropElement?.classList.add("cg-drop-target");
}

function ctJoinFoldedGroup(target, members, before) {
  const ids=new Set(members.map(n=>n.id));
  for(const group of B.groups) {
    if(group===target || !group.nodes.some(id=>ids.has(id)))continue;
    group.nodes=group.nodes.filter(id=>!ids.has(id) && node(id));
    if(group.nodes.length<2)group.nodes=[];
  }
  B.groups=B.groups.filter(group=>group.nodes.length);
  target.nodes=[...new Set([...target.nodes,...ids])];
  undoStack.push(before);
  redoStack.length=0;
  drawEdges(); updateSel(); save();
  toast("已加入「"+target.name+"」");
}

function ctDragGroup(event, group) {
  if (!canvasCanEdit() || event.button!==0 || event.target.closest("button,input")) return;
  event.preventDefault(); event.stopPropagation();
  const members = group.nodes.map(node).filter(Boolean);
  if (!members.length) return;
  if (!CT_FOLD_BOXES.has(group.id)) { sel=new Set(members.map(n=>n.id)); updateSel(); }
  if (members.some(nodeLocked)) return toast("分组含有锁定节点，解锁后可整体移动");
  const before = snap(), start = {x:event.clientX,y:event.clientY}, anchor = CT_FOLD_BOXES.get(group.id);
  const original = members.map(n=>({n,x:n.x,y:n.y}));
  const bounds = ctGroupBounds(members);
  const frame = anchor || {x:bounds.x,y:bounds.y,w:bounds.right-bounds.x,h:bounds.bottom-bounds.y};
  const place = canvasDragPlacement(members,frame,group.id);
  let moved = false;
  const board = B;
  const canMove = () => B === board && canvasCanEdit() && CT_GROUPS.get(group.id)?._group === group &&
    members.every(n=>els.has(n.id) && !nodeLocked(n));
  const startPoint = toW(start.x,start.y);
  let last = event;
  const move = e => {
    if (!canMove()) { clearCanvasGuides(); return; }
    const point = toW(e.clientX,e.clientY);
    if (!moved && Math.abs(e.clientX-start.x)+Math.abs(e.clientY-start.y)<3) return;
    if(!moved)liveStopFollow(false);
    moved = true;
    last = e;
    const target = anchor ? ctGroupDropTarget(e,group) : null;
    const delta = place(point.x-startPoint.x,point.y-startPoint.y,e.altKey || !!target);
    for (const {n,x,y} of original) { n.x=Math.round(x+delta.x); n.y=Math.round(y+delta.y); render(n); }
    if (anchor) group.fold = {x:Math.round(anchor.x+delta.x),y:Math.round(anchor.y+delta.y)};
    drawEdges(); placeOverlays();
    if (anchor) ctMarkGroupDrop(target);
  };
  const end = e => {
    if (moved && e.type === "pointerup" && e.altKey !== last.altKey) move(e);
    removeEventListener("pointermove",move); removeEventListener("pointerup",end); removeEventListener("pointercancel",end);
    removeEventListener("blur",end);
    clearCanvasGuides();
    const valid = canMove();
    const drop = moved && valid && e.type === "pointerup";
    const target = drop && anchor ? ctGroupDropTarget(e,group) : null;
    ctMarkGroupDrop(null);
    if (moved && valid && (target || !drop)) {
      for(const {n,x,y} of original){ Object.assign(n,{x,y}); render(n); }
      if (target) ctJoinFoldedGroup(target,members,before);
      else {
        if (anchor) group.fold = {x:anchor.x,y:anchor.y};
        drawEdges(); placeOverlays(); drawMini();
      }
      return;
    }
    if (moved && valid && original.some(({n,x,y}) => n.x !== x || n.y !== y)) {
      undoStack.push(before); redoStack.length=0; save();
    }
  };
  addEventListener("pointermove",move); addEventListener("pointerup",end); addEventListener("pointercancel",end);
  addEventListener("blur",end);
}

function ctCreateGroupElement(group) {
  const el = document.createElement("div");
  el.className = "canvas-group";
  el._group = group;
  el.innerHTML = `<div class="cg-head"><span class="cg-grip" aria-hidden="true" title="拖动分组">${ico("grip")}</span><input aria-label="分组名称">
    <button type="button" data-group-select aria-label="选择分组" title="选中整组">${ico("select")}</button>
    <button type="button" data-group-run aria-label="运行分组" title="运行分组">${ico("send")}</button>
    <button type="button" data-group-template aria-label="存为工作流模板" title="存为工作流模板">${ico("stack")}</button>
    <button type="button" data-group-archive aria-label="下载分组素材" title="下载分组素材">${ico("dl")}</button>
    <button type="button" data-group-fold aria-label="收起分组" title="收起分组"></button>
    <button type="button" data-group-dissolve aria-label="取消编组" title="取消编组">${ico("minus")}</button></div>
    <button type="button" class="cg-items" data-group-items>${ico("stack")}<span></span></button>`;
  const input = $("input",el);
  input.onpointerdown = e => e.stopPropagation();
  input.onblur = () => {
    if (canvasCanEdit() && input.value.trim() && input.value!==group.name) {
      checkpoint(); group.name=input.value.trim().slice(0,60); save();
    }
    input.value=group.name;
  };
  input.onkeydown = e => { e.stopPropagation(); if(e.key==="Enter")input.blur(); };
  $("[data-group-select]",el).onclick = () => { sel=new Set(group.nodes.filter(id=>node(id))); updateSel(); };
  $("[data-group-run]",el).onclick = () => openCanvasGroupRun(group);
  $("[data-group-template]",el).onclick = () => openWorkflowTemplates(true, group);
  $("[data-group-archive]",el).onclick = async e => {
    const button=e.currentTarget;
    button.disabled=true;
    try{await ctDownload(group.nodes.map(node).filter(Boolean));}
    finally{button.disabled=!ctDownloadable(group.nodes.map(node).filter(Boolean)).length;}
  };
  $("[data-group-fold]",el).onclick = () => ctSetFold(group,!group.collapsed);
  $("[data-group-dissolve]",el).onclick = () => ctUngroup(group.nodes);
  $("[data-group-items]",el).onclick = () => ctOpenGroupGallery(group);
  $(".cg-head",el).onpointerdown = e => ctDragGroup(e,group);
  world.insertBefore(el,world.firstChild);
  CT_GROUPS.set(group.id,el);
  return el;
}

function ctRenderGroups() {
  if (!B || !world) return;
  CT_FOLDED_NODES.clear(); CT_FOLD_BOXES.clear();
  const keep = new Set();
  for (const group of B.groups || []) {
    const members = group.nodes.map(node).filter(Boolean);
    if (!members.length) continue;
    keep.add(group.id);
    let el = CT_GROUPS.get(group.id);
    if (el && (!el.isConnected || el._group!==group)) { el.remove(); el=null; }
    if (!el) el=ctCreateGroupElement(group);
    const bounds = ctGroupBounds(members), folded = group.collapsed===true && members.length>1;
    const {x,y,w,h} = folded
      ? {x:Number.isFinite(group.fold?.x)?group.fold.x:bounds.x,y:Number.isFinite(group.fold?.y)?group.fold.y:bounds.y,w:270,h:96}
      : {...bounds,w:bounds.right-bounds.x,h:bounds.bottom-bounds.y};
    if (folded) {
      CT_FOLD_BOXES.set(group.id,{id:group.id,type:"group",x,y,w,h});
      for (const n of members) CT_FOLDED_NODES.set(n.id,group);
    }
    el.classList.toggle("is-folded",folded);
    Object.assign(el.style,{left:x+"px",top:y+"px",width:w+"px",height:h+"px"});
    const input = $("input",el), toggle = $("[data-group-fold]",el);
    if (document.activeElement!==input) input.value=group.name;
    input.readOnly=!canvasCanEdit();
    $("[data-group-select]",el).hidden=folded;
    $("[data-group-run]",el).hidden=!canvasCanEdit() || !members.some(n=>["image","video","audio"].includes(n.type)&&!n.data.previs&&!n.data.film);
    $("[data-group-template]",el).hidden=!(B.access==="owner" || !B.access && B.owner===ME_USER?.id) || members.length<2;
    $("[data-group-archive]",el).hidden=!ctDownloadable(members).length;
    $("[data-group-dissolve]",el).hidden=!canvasCanEdit();
    $("[data-group-items]",el).hidden=!folded;
    $("[data-group-items] span",el).textContent=`查看 ${members.length} 个节点`;
    toggle.hidden=members.length<2;
    toggle.setAttribute("aria-expanded",String(!folded));
    toggle.title=folded?"展开分组":"收起分组";
    toggle.setAttribute("aria-label",toggle.title);
    const glyph=folded?"open":"close";
    if (toggle.dataset.glyph!==glyph) { toggle.dataset.glyph=glyph; toggle.innerHTML=ico(folded?"full":"stack"); }
  }
  for (const [id,el] of CT_GROUPS) if(!keep.has(id)){el.remove(); CT_GROUPS.delete(id);}
  els.forEach((el,id)=>{
    const hidden=CT_FOLDED_NODES.has(id);
    if (hidden && !el.hidden) $$('video,audio',el).forEach(media=>{if(!media.paused)media.pause();});
    if (el.hidden!==hidden) el.hidden=hidden;
    if(hidden){sel.delete(id);el.classList.remove("sel");}
  });
}

function ctCloseGroupGallery() {
  const dialog=$("#groupGallery");
  if(!dialog?.open)return;
  if(dialog.close)dialog.close();else dialog.removeAttribute("open");
  $("#groupGalleryItems").replaceChildren();
  $("#groupGalleryImport").replaceChildren();
}

function ctGroupPreview(n) {
  const url=esc(curV(n)?.url);
  if(url && n.type==="image")return `<img src="${url}" loading="lazy" alt="">`;
  if(url && n.type==="video")return `<video src="${url}" controls preload="none" playsinline aria-label="${esc(n.name)}"></video>`;
  if(url && n.type==="audio")return `<audio src="${url}" controls preload="none" aria-label="${esc(n.name)}"></audio>`;
  if(n.type==="text" && n.data?.text)return `<p>${esc(n.data.text.slice(0,140))}</p>`;
  const icon=["image","video","audio","text","script"].includes(n.type)?n.type:"stack";
  return ico(icon);
}

function ctOpenGroupGallery(group) {
  const dialog=$("#groupGallery"), members=group.nodes.map(node).filter(Boolean);
  if (!members.length) return;
  $("#groupGalleryTitle").textContent=group.name;
  const grid=$("#groupGalleryItems");
  grid.replaceChildren();
  for (const n of members) {
    const item=document.createElement("article");
    item.innerHTML=`<div class="cg-preview">${ctGroupPreview(n)}</div>
      <strong>${esc(n.name)}</strong><div><button type="button" data-member-open>展开并定位</button>
      ${canvasCanEdit()?'<button type="button" data-member-extract>移出分组</button>':""}</div>`;
    $("[data-member-open]",item).onclick=()=>{
      const target=node(n.id);
      if(!target)return toast("该节点已移除");
      ctCloseGroupGallery();selectOnly(target.id);fit([target]);
    };
    const extract=$("[data-member-extract]",item);
    if(extract)extract.onclick=()=>{
      if(!canvasCanEdit()||!(B.groups||[]).includes(group)||node(n.id)!==n||!group.nodes.includes(n.id))return;
      checkpoint();
      const box=CT_FOLD_BOXES.get(group.id);
      if(box)Object.assign(n,freeSpot(box.x+box.w+90,box.y,n.type));
      group.nodes=group.nodes.filter(id=>id!==n.id);
      if(group.nodes.filter(id=>node(id)).length<2)B.groups=B.groups.filter(candidate=>candidate!==group);
      ctCloseGroupGallery();render(n);drawEdges();selectOnly(n.id);fit([n]);save();
    };
    grid.append(item);
  }
  const download=$("[data-group-download]",dialog);
  download.disabled=!ctDownloadable(members).length;
  download.onclick=async()=>{
    download.disabled=true;
    try{await ctDownload(members);}
    finally{download.disabled=!ctDownloadable(members).length;}
  };
  const chat=$("[data-group-chat]",dialog);
  const media=members.filter(n=>["image","video","audio"].includes(n.type)&&curV(n)?.ref);
  const collect=$("[data-group-collect]",dialog);
  const assets=members.filter(n=>media.includes(n)||n.type==="text"&&n.data?.text?.trim());
  collect.hidden=!canvasCanEdit();
  collect.disabled=!assets.length;
  collect.onclick=()=>{
    if(!canvasCanEdit())return;
    const host=$("#groupGalleryImport");
    if(host.childElementCount)return;
    if(assets.length>100)return toast("每次最多收录 100 项资产");
    void alImportCanvasAssets(host,assets,ctCloseGroupGallery);
  };
  chat.hidden=!canvasCanEdit();
  chat.disabled=!media.length;
  chat.onclick=()=>{
    if(!canvasCanEdit())return;
    ctCloseGroupGallery();
    void acUseNodes(media);
  };
  if(!dialog.open){if(dialog.showModal)dialog.showModal();else dialog.setAttribute("open","");}
}

function initCanvasGroups() {
  initCanvasGroupRun();
  document.body.insertAdjacentHTML("beforeend",`<dialog id="groupGallery" aria-labelledby="groupGalleryTitle">
    <header><strong id="groupGalleryTitle"></strong><button type="button" data-group-close aria-label="关闭">×</button></header>
    <div id="groupGalleryItems"></div><div id="groupGalleryImport"></div>
    <footer><button type="button" data-group-chat>引用到创作助手</button><button type="button" data-group-collect>收录到资产库</button><button type="button" data-group-download>下载组内素材</button></footer></dialog>`);
  const dialog=$("#groupGallery");
  $("[data-group-close]",dialog).onclick=ctCloseGroupGallery;
  dialog.addEventListener("click",event=>{
    if($(".al-group-import[aria-busy=true]",dialog)){event.preventDefault();event.stopImmediatePropagation();}
  },true);
  dialog.oncancel=event=>{event.preventDefault();if(!$(".al-group-import[aria-busy=true]",dialog))ctCloseGroupGallery();};
}
