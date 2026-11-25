"use strict";

// ================================================================= selection, overlays
function updateSel() {
  ctRevealSelected();
  els.forEach((el, id) => el.classList.toggle("sel", sel.has(id)));
  if (sel.size) { selEdge = null; drawEdges(); }
  showPanel(); placeOverlays(); drawMini();
  if (typeof acRenderRefs === "function") acRenderRefs();
}
function placeOverlays() {
  hideNodeToolTip();
  ctPlaceSelectionTools();
  nodeVoiceSync();
  const tools = $("#ntools"), pp = $("#pp");
  if (sel.size !== 1) { tools.classList.remove("on"); pp.classList.remove("on"); return; }
  const n = node([...sel][0]); if (!n) return;
  const r = $(".card", els.get(n.id)).getBoundingClientRect();
  tools.classList.add("on");
  const tw = tools.offsetWidth;
  tools.style.left = Math.max(8, Math.min(innerWidth - tw - 8, r.right - tw)) + "px";
  tools.style.top = Math.max(8, r.top - tools.offsetHeight - 30) + "px";
  if (!canvasCanEdit() || n.type==="text" || n.data.film || n.data.previs) { pp.classList.remove("on"); return; }
  pp.classList.add("on");
  const pw = pp.offsetWidth, ph = pp.offsetHeight;
  pp.classList.toggle("pinned", !!ppPin);
  if (ppResizeDrag) {
    pp.style.left = Math.max(8, Math.min(innerWidth - pw - 8, ppResizeDrag.rect.left)) + "px";
    pp.style.top = Math.max(8, Math.min(innerHeight - ph - 8, ppResizeDrag.rect.top)) + "px";
    return;
  }
  if (ppPin) {   // the user parked the panel somewhere: keep it there (inside the window)
    pp.style.left = Math.max(8, Math.min(innerWidth - pw - 8, ppPin.x)) + "px";
    pp.style.top = Math.max(8, Math.min(innerHeight - ph - 8, ppPin.y)) + "px";
    return;
  }
  let top = r.bottom + 14; if (top + ph > innerHeight - 8) top = Math.max(8, innerHeight - ph - 8);
  pp.style.left = Math.max(8, Math.min(innerWidth - pw - 8, r.left + r.width / 2 - pw / 2)) + "px";
  pp.style.top = top + "px";
}

function selectOnly(id) { sel = new Set([id]); updateSel(); }
