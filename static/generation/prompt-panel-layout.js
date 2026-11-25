"use strict";

// the prompt panel can be dragged by its grip and parked; double-click (or ↺) puts it back under the node
let ppPin = JSON.parse(localStorage.getItem("h3.ppPin") || "null");
let ppSize=null, ppResizeDrag=null;
try {
  const saved=JSON.parse(localStorage.getItem("h3.ppSize"));
  if(saved&&Number.isFinite(saved.width)&&Number.isFinite(saved.height))ppSize=saved;
} catch {}
function applyPPSize() {
  const panel=$("#pp");
  panel.classList.toggle("resized",!!ppSize);
  if(!ppSize)return;
  panel.style.setProperty("--pp-width",ppSize.width+"px");
  panel.style.setProperty("--pp-height",ppSize.height+"px");
}
function setPPSize(size,remember=false) {
  ppSize=size&&{width:Math.round(Math.max(320,size.width)),height:Math.round(Math.max(180,size.height))};
  if(remember){
    try {
      if(ppSize)localStorage.setItem("h3.ppSize",JSON.stringify(ppSize));
      else localStorage.removeItem("h3.ppSize");
    } catch {}
  }
  applyPPSize();placeOverlays();
}
applyPPSize();
const ppResize=$("#ppResize");
ppResize.onpointerdown=event=>{
  if(event.button!==0||ppResizeDrag)return;
  event.preventDefault();event.stopPropagation();
  ppResizeDrag={id:event.pointerId,x:event.clientX,y:event.clientY,rect:$("#pp").getBoundingClientRect(),previous:ppSize,moved:false};
  $("#pp").classList.add("resizing");
  addEventListener("pointermove",movePPResize);
  addEventListener("pointerup",endPPResize);
  addEventListener("pointercancel",endPPResize);
};
function movePPResize(event) {
  const drag=ppResizeDrag;
  if(!drag||event.pointerId!==drag.id)return;
  const dx=event.clientX-drag.x,dy=event.clientY-drag.y;
  if(!drag.moved&&Math.hypot(dx,dy)<3)return;
  drag.moved=true;
  setPPSize({width:Math.min(innerWidth-16,drag.rect.width+dx),height:Math.min(innerHeight-16,drag.rect.height+dy)});
}
function endPPResize(event) {
  const drag=ppResizeDrag;
  if(!drag||event.pointerId!==drag.id)return;
  removeEventListener("pointermove",movePPResize);
  removeEventListener("pointerup",endPPResize);
  removeEventListener("pointercancel",endPPResize);
  if(event.type==="pointerup")movePPResize(event);
  ppResizeDrag=null;
  $("#pp").classList.remove("resizing");
  if(event.type==="pointercancel")setPPSize(drag.previous);
  else if(drag.moved)setPPSize(ppSize,true);
}
ppResize.ondblclick=event=>{event.preventDefault();setPPSize(null,true);};
ppResize.onkeydown=event=>{
  const direction={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
  if(!direction&&event.key!=="Home")return;
  event.preventDefault();event.stopPropagation();
  if(!direction){setPPSize(null,true);return;}
  const rect=$("#pp").getBoundingClientRect(), step=event.shiftKey?48:16;
  setPPSize({width:Math.min(innerWidth-16,rect.width+direction[0]*step),
    height:Math.min(innerHeight-16,rect.height+direction[1]*step)},true);
};
function setPPPin(p) { ppPin = p; if (p) localStorage.setItem("h3.ppPin", JSON.stringify(p)); else localStorage.removeItem("h3.ppPin"); placeOverlays(); }
$("#pp .pgrip").addEventListener("pointerdown", e => {
  if (e.button !== 0 || e.target.closest(".rs")) return;
  e.preventDefault(); e.stopPropagation();
  const pp = $("#pp"), r = pp.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top; let moved = false;
  const mv = ev => { if (!moved && Math.abs(ev.clientX - e.clientX) + Math.abs(ev.clientY - e.clientY) < 3) return; moved = true; pp.classList.add("dragging");
    ppPin = { x: ev.clientX - dx, y: ev.clientY - dy }; placeOverlays(); };
  const up = () => { pp.classList.remove("dragging"); removeEventListener("pointermove", mv); removeEventListener("pointerup", up); if (moved) setPPPin(ppPin); };
  addEventListener("pointermove", mv); addEventListener("pointerup", up);
});
$("#pp .pgrip").addEventListener("dblclick", () => setPPPin(null));
$("#pp .pgrip .rs").onclick = e => { e.stopPropagation(); setPPPin(null); };
