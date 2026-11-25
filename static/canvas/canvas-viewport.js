"use strict";

// ================================================================= view
function applyView() {
  const v = B.view;
  world.style.setProperty("--cc-inverse", 1 / v.k);
  world.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.k})`;
  vp.style.backgroundPosition = `${v.x}px ${v.y}px`;
  vp.style.backgroundSize = `${CANVAS_GRID_STEP * v.k}px ${CANVAS_GRID_STEP * v.k}px`;
  $("#zPct").textContent = Math.round(v.k * 100) + "%";
  acRenderPlacement();
  placeOverlays();drawMini();liveDrawCursors();
}
// scroll the canvas while something is dragged near the window edge
function autoPan(tick) {
  let p = null, raf = 0;
  const loop = () => {
    raf = requestAnimationFrame(loop); if (!p) return;
    const m = 56, f = d => d < m ? (m - d) / m * 18 : 0;
    const dx = f(p.x) - f(innerWidth - p.x), dy = f(p.y) - f(innerHeight - p.y);
    if (dx || dy) { liveStopFollow(false);B.view.x += dx; B.view.y += dy; applyView(); tick(); }
  };
  raf = requestAnimationFrame(loop);
  return { move(ev) { p = { x: ev.clientX, y: ev.clientY }; }, stop() { cancelAnimationFrame(raf); save(); } };
}
const toW = (cx, cy) => ({ x: (cx - B.view.x) / B.view.k, y: (cy - B.view.y) / B.view.k });
function zoomAt(cx, cy, f) {
  liveStopFollow(false);
  const v = B.view, k = Math.min(3, Math.max(0.15, v.k * f));
  v.x = cx - (cx - v.x) * k / v.k; v.y = cy - (cy - v.y) * k / v.k; v.k = k; applyView(); save();
}
function fit(nodes = B.nodes, persist = true) {
  liveStopFollow(false);
  if (!nodes.length) { B.view = { x: innerWidth / 2 - 160, y: innerHeight / 2 - 200, k: 1 }; applyView(); return; }
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const n of ctCanvasRects(nodes)) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y - 30); x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h); }
  const pad = 140, vw = innerWidth, vh = innerHeight;
  const k = Math.min(1.1, Math.max(0.15, Math.min((vw - pad * 2) / (x1 - x0), (vh - pad * 2) / (y1 - y0))));
  B.view = { k, x: (vw - (x1 - x0) * k) / 2 - x0 * k, y: (vh - (y1 - y0) * k) / 2 - y0 * k }; applyView(); if (persist) save();
}
