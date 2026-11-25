"use strict";

// ================================================================= canvas input
// ---- tools: "pan" = drag empty canvas to move it (shift/⌘ + drag = marquee); "select" = drag = marquee
let tool = localStorage.getItem("h3.tool") || "pan";
function setTool(t) { tool = t; localStorage.setItem("h3.tool", t); vp.classList.toggle("tool-pan", t === "pan"); $("#toolPan").classList.toggle("on", t === "pan"); $("#toolSel").classList.toggle("on", t === "select"); }
$("#toolPan").onclick = () => setTool("pan"); $("#toolSel").onclick = () => setTool("select");
setTool(tool);

// ---- wheel: trackpad scroll pans, pinch (ctrlKey) zooms; a mouse wheel zooms or pans per setting
const WM = { auto: "滚轮：自动", zoom: "滚轮：缩放", pan: "滚轮：平移" };
let wheelMode = localStorage.getItem("h3.wheel") || "auto";
function setWheel(m) { wheelMode = m; localStorage.setItem("h3.wheel", m); $("#wmBtn").textContent = WM[m]; }
$("#wmBtn").onclick = () => { setWheel({ auto: "zoom", zoom: "pan", pan: "auto" }[wheelMode]); toast(wheelMode === "auto" ? "自动：鼠标滚轮缩放，触控板滑动平移" : wheelMode === "zoom" ? "鼠标滚轮 = 缩放（⇧+滚轮横向平移）" : "鼠标滚轮 = 平移（⌘+滚轮缩放）", 2200); };
setWheel(wheelMode);
let lastTrackpad = 0;
function isMouseWheel(e) {
  if (e.deltaMode) return true;                                   // line/page deltas: a wheel
  if (e.deltaX) { lastTrackpad = e.timeStamp; return false; }     // sideways motion: trackpad
  if (e.timeStamp - lastTrackpad < 400) return false;             // inside a trackpad gesture
  const wd = e.wheelDeltaY;
  if (wd !== undefined && wd === -3 * e.deltaY) { lastTrackpad = e.timeStamp; return false; } // Chrome/macOS trackpad signature
  return Math.abs(e.deltaY) >= 40 || (wd !== undefined && wd % 120 === 0);
}
vp.addEventListener("wheel", e => {
  if (e.target.closest("textarea, #pp, #drawer, .menu, #anglePop")) return;
  const scrollable = e.target.closest(".sb, .vtabs");
  if (scrollable && scrollable.scrollHeight > scrollable.clientHeight && !(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  const zoom = e.ctrlKey || e.metaKey || (wheelMode === "zoom" && !e.shiftKey) || (wheelMode === "auto" && !e.shiftKey && isMouseWheel(e));
  if (zoom) {
    const d = e.ctrlKey && !e.metaKey && !e.deltaMode && Math.abs(e.deltaY) < 50 ? e.deltaY * 0.0105 : Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaMode ? e.deltaY * 33 : e.deltaY), 120) * 0.0022;
    zoomAt(e.clientX, e.clientY, Math.exp(-d));
  } else {
    const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX, dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
    liveStopFollow(false);
    B.view.x -= dx; B.view.y -= dy; applyView(); save();
  }
}, { passive: false });

// ---- pointer on the canvas
let spaceDown = false;
vp.addEventListener("pointerdown", e => {
  closeMenus();
  const onBg = e.target === vp || e.target === world || e.target === svg;
  const marquee = e.button === 0 && onBg && !spaceDown && (tool === "select" || e.shiftKey || e.metaKey || e.ctrlKey);
  if (e.button === 1 || e.button === 2 || (e.button === 0 && (spaceDown || (onBg && !marquee)))) { // pan
    e.preventDefault(); const sx = e.clientX, sy = e.clientY, vx = B.view.x, vy = B.view.y; let moved = false;
    const mv = ev => {
      if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 4) return;
      if (!moved) { moved = true;vp.classList.add("pan");liveStopFollow(false); }
      B.view.x = vx + ev.clientX - sx; B.view.y = vy + ev.clientY - sy; applyView();
    };
    const up = () => {
      vp.classList.remove("pan"); removeEventListener("pointermove", mv); removeEventListener("pointerup", up);
      if (moved) { save(); return; }
      if (e.button === 2) ctxMenu(e);                                       // plain right click
      else if (e.button === 0 && onBg) { sel.clear(); selEdge = null; updateSel(); drawEdges(); } // plain click on empty canvas
    };
    addEventListener("pointermove", mv); addEventListener("pointerup", up); return;
  }
  if (!marquee) return;
  // pan tool: Shift/⌘ only *starts* the marquee, so adding to the selection needs ⇧⌘; select tool: Shift adds
  const additive = tool === "select" ? e.shiftKey : (e.shiftKey && (e.metaKey || e.ctrlKey));
  if (!additive) sel.clear(); selEdge = null; updateSel(); drawEdges();
  const sx = e.clientX, sy = e.clientY, mq = $("#marquee"), base = new Set(sel); let active = false;
  const mv = ev => {
    const x0 = Math.min(sx, ev.clientX), y0 = Math.min(sy, ev.clientY), x1 = Math.max(sx, ev.clientX), y1 = Math.max(sy, ev.clientY);
    if (!active && x1 - x0 + y1 - y0 < 6) return;
    if(!active)liveStopFollow(false);
    active = true;
    Object.assign(mq.style, { display: "block", left: x0 + "px", top: y0 + "px", width: x1 - x0 + "px", height: y1 - y0 + "px" });
    sel = new Set(base);
    els.forEach((el, id) => {   // a card counts once the box covers at least half of it
      if (el.hidden) return;
      const r = $(".card", el).getBoundingClientRect();
      const ow = Math.min(r.right, x1) - Math.max(r.left, x0), oh = Math.min(r.bottom, y1) - Math.max(r.top, y0);
      if (ow > 0 && oh > 0 && ow * oh >= 0.5 * r.width * r.height) sel.add(id);
    });
    els.forEach((el, id) => el.classList.toggle("sel", sel.has(id)));
  };
  const up = () => { mq.style.display = "none"; removeEventListener("pointermove", mv); removeEventListener("pointerup", up); if (active) updateSel(); };
  addEventListener("pointermove", mv); addEventListener("pointerup", up);
});
vp.addEventListener("contextmenu", e => e.preventDefault());
