"use strict";

// keyboard
let clip = null;
let hoveredVersionNode = null;
vp.addEventListener("pointerover",event=>{
  if(event.pointerType!=="touch")hoveredVersionNode=event.target.closest(".node");
});
vp.addEventListener("pointerleave",()=>{hoveredVersionNode=null;});
addEventListener("blur",()=>{hoveredVersionNode=null;});

function navigateHoveredVersion(event) {
  const direction={ArrowLeft:-1,ArrowRight:1}[event.key];
  if(!direction||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||event.isComposing||
     !hoveredVersionNode||document.querySelector("dialog[open],#imageEditor.on,#assetLibrary:not([hidden]),#help.on,.playlist-picking"))return false;
  const id=hoveredVersionNode.dataset.id;
  if(els.get(id)!==hoveredVersionNode||ctFolded(id))return false;
  const n=node(id);
  if(!n||!$(".vtabs",hoveredVersionNode))return false;
  event.preventDefault();
  if(!event.repeat)switchVersion(n,vtAdjacentIndex(n,n.cur,direction),{recordUndo:canvasCanEdit()});
  return true;
}

addEventListener("keydown", e => {
  if (e.key === "Escape" && nodePinTrigger) {
    const button = nodePinTrigger;
    e.preventDefault(); closeMenus(); button.focus(); hideNodeToolTip(); return;
  }
  if (e.key === "Escape" && $("#canvasLayoutMenu.on")) {
    e.preventDefault(); closeMenus(); $("#canvasLayoutBtn").focus(); return;
  }
  if ($("#groupRunConfirm")?.open || $("#groupGallery")?.open || $("#alCanvasImport")?.open || $("#videoExtension").open || $("#videoSegment").open || $("#segmentReview").open || $("#videoTrim").open || $("#videoGif").open || $("#frameCapture").open || $("#videoDraftFinal").open || $("#videoCompare").open) return;
  if (lightState) {
    const dialog = e.target.closest?.("dialog");
    if (dialog && dialog.id !== "light") return;
    if (e.key === "Escape") { e.preventDefault(); closeLightbox(); }
    if (e.target.closest?.("input,textarea,select,video,audio,[contenteditable=true],#agentChat") || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    if (e.code === "Backslash" && !e.repeat && $(".light-view")?._peekPrevious) {
      e.preventDefault(); $(".light-view")._peekPrevious(true); return;
    }
    if (e.target.closest?.(".light-version-grid")) return;
    if (["ArrowLeft","ArrowRight"].includes(e.key)) {
      e.preventDefault(); lightNavigate(e.key === "ArrowLeft" ? -1 : 1);
    }
    if (e.key.toLowerCase() === "e" && !e.repeat && !e.isComposing) $("[data-light-edit]")?.click();
    if (e.key.toLowerCase() === "a" && !e.repeat && !e.isComposing && !e.shiftKey) {
      const mark = $("[data-light-mark-region]") || $("[data-light-comment]");
      if (mark && !mark.hidden) { e.preventDefault(); mark.click(); }
    }
    return;
  }
  if (document.querySelector("#wiz.on, #film.on, #wzSample.on, #pv.on, #settings.on")) return;   // the canvas is hidden behind these
  if (e.target.closest("audio,.audio-preview")) return;
  if (e.code === "Space" && !e.target.closest("input, textarea, select, button, [contenteditable=true]")) { if (!spaceDown) { spaceDown = true; vp.classList.add("space"); } e.preventDefault(); return; }
  if (e.target.closest("input, textarea, select, [contenteditable=true]")) return;
  if(navigateHoveredVersion(e))return;
  const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
  if (!canvasCanEdit() && (mod || !["h","v","m","f","a","c","l","?","=","+","-","_","0","escape"].includes(k))) return;
  if (mod && k === "g" && sel.size) { e.preventDefault(); e.shiftKey ? ctUngroup() : ctGroup(); return; }
  if (!mod && !e.altKey) {
    const ar = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (ar && sel.size) {
      e.preventDefault();
      const moving = [...sel].map(node).filter(n => n && !nodeLocked(n));
      if (!moving.length) return;
      if (!e.repeat) checkpoint();
      const step = e.shiftKey ? 50 : 10;
      for (const n of moving) { n.x += ar[0] * step; n.y += ar[1] * step; render(n); }
      drawEdges(); placeOverlays(); drawMini(); save(); return;
    }
    if (k === "h") { setTool("pan"); toast("抓手：拖空白处移动画布", 1200); return; }
    if (k === "v") { setTool("select"); toast("框选：拖空白处框选", 1200); return; }
    if (k === "m") { setMini(!mmOn); return; }
    if (k === "l" && !e.repeat) { e.preventDefault(); if(AL.open)alClose();else void alOpen(); return; }
    if ((k === "c" || k === "a" && !e.shiftKey) && B && !e.repeat && !e.isComposing) { e.preventDefault(); ccShortcut(); return; }
    if (k === "f") { fit(sel.size ? [...sel].map(node).filter(Boolean) : B.nodes); return; }
    if (e.key === "?" ) { $("#help").classList.toggle("on"); return; }
    if (e.key === "=" || e.key === "+") { zoomAt(innerWidth / 2, innerHeight / 2, 1.2); return; }
    if (e.key === "-" || e.key === "_") { zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.2); return; }
    if (e.key === "0") { zoomAt(innerWidth / 2, innerHeight / 2, 1 / B.view.k); return; }
  }
  if (e.key === "Delete" || e.key === "Backspace") { if (selEdge) cutEdge(selEdge); else removeNodes([...sel]); e.preventDefault(); }
  else if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
  else if (mod && e.key.toLowerCase() === "c" && sel.size) { clip = [...sel].map(id => JSON.parse(JSON.stringify(node(id)))); toast(`已复制 ${clip.length} 个节点`, 1200); }
  else if (mod && e.key.toLowerCase() === "v" && clip) { e.preventDefault(); paste(clip); }
  else if (mod && e.key.toLowerCase() === "d" && sel.size) { e.preventDefault(); duplicate([...sel]); }
  else if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); sel = new Set(B.nodes.filter(n=>!ctFolded(n.id)).map(n => n.id)); updateSel(); }
  else if (e.key === "Escape") { sel.clear(); selEdge = null; updateSel(); drawEdges(); closeMenus(); $("#drawer").classList.remove("on"); $("#help").classList.remove("on"); }
  else if (e.shiftKey && (e.key === "!" || e.code === "Digit1")) fit();
});
addEventListener("keyup", e => {
  if (e.code === "Space") { spaceDown = false; vp.classList.remove("space"); }
  if (e.code === "Backslash") $(".light-view")?._peekPrevious?.(false);
});
addEventListener("blur", () => {
  spaceDown = false; vp.classList.remove("space");
  $(".light-view")?._peekPrevious?.(false);
});
