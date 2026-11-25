"use strict";

// ---- minimap
let mmOn = localStorage.getItem("h3.mm") !== "0", mmT = 0, mmMap = null;
function setMini(on) { mmOn = on; localStorage.setItem("h3.mm", on ? "1" : "0"); $("#mmBtn").classList.toggle("on", on); drawMini(); }
$("#mmBtn").onclick = () => setMini(!mmOn);
$("#mmBtn").classList.toggle("on", mmOn);
function drawMini() {
  if (mmT) return;
  mmT = requestAnimationFrame(() => {
    mmT = 0; const box = $("#mm"), show = mmOn && B && B.nodes.length > 0;
    box.classList.toggle("on", show); if (!show) return;
    const c = $("#mmc"), g = c.getContext("2d"), W = c.width, H = c.height, v = B.view;
    const vw = { x0: -v.x / v.k, y0: -v.y / v.k, x1: (innerWidth - v.x) / v.k, y1: (innerHeight - v.y) / v.k };
    let x0 = vw.x0, y0 = vw.y0, x1 = vw.x1, y1 = vw.y1;
    const rects=ctCanvasRects();
    for (const n of rects) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h); }
    const pad = 80; x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    const sc = Math.min(W / (x1 - x0), H / (y1 - y0)), ox = (W - (x1 - x0) * sc) / 2 - x0 * sc, oy = (H - (y1 - y0) * sc) / 2 - y0 * sc;
    mmMap = { sc, ox, oy };
    g.clearRect(0, 0, W, H); g.globalAlpha = 1; g.fillStyle = "#101012"; g.fillRect(0, 0, W, H);
    // Put the viewport tint behind nodes so it cannot change their shared colors.
    g.fillStyle = "rgba(255,255,255,.06)";
    g.fillRect(vw.x0 * sc + ox, vw.y0 * sc + oy, (vw.x1 - vw.x0) * sc, (vw.y1 - vw.y0) * sc);
    const css = getComputedStyle(document.documentElement), col = { text: css.getPropertyValue("--c-text"), image: `rgb(${css.getPropertyValue("--node-image-rgb").trim()})`, video: `rgb(${css.getPropertyValue("--node-video-rgb").trim()})` };
    g.strokeStyle = "rgba(255,255,255,.14)"; g.lineWidth = 1.5;
    for (const e of B.edges) { const a = node(e.from), b = node(e.to); if (!a || !b || (ctFolded(a.id)&&ctFolded(a.id)===ctFolded(b.id))) continue; const p = port(a, "out"), q = port(b, "in"); g.beginPath(); g.moveTo(p.x * sc + ox, p.y * sc + oy); g.lineTo(q.x * sc + ox, q.y * sc + oy); g.stroke(); }
    for (const n of rects) {
      g.globalAlpha = n.type === "image" || n.type === "video" || n.type === "group" || sel.has(n.id) ? 1 : 0.7; g.fillStyle = (col[n.type] || "#888").trim() || "#888";
      g.beginPath(); g.roundRect(n.x * sc + ox, n.y * sc + oy, Math.max(3, n.w * sc), Math.max(3, n.h * sc), 3); g.fill();
      if (sel.has(n.id)) { g.strokeStyle = "#fff"; g.lineWidth = 2; g.stroke(); g.strokeStyle = "rgba(255,255,255,.14)"; g.lineWidth = 1.5; }
    }
    g.globalAlpha = 1; g.strokeStyle = "rgba(255,255,255,.9)"; g.lineWidth = 2;
    g.beginPath(); g.rect(vw.x0 * sc + ox, vw.y0 * sc + oy, (vw.x1 - vw.x0) * sc, (vw.y1 - vw.y0) * sc); g.stroke();
  });
}
$("#mmc").addEventListener("pointerdown", e => {
  e.preventDefault(); e.stopPropagation(); if (!mmMap) return;
  liveStopFollow(false);
  const c = $("#mmc"), m = { ...mmMap }, k = B.view.k, scale = c.width / c.getBoundingClientRect().width;
  const go = ev => { const r = c.getBoundingClientRect(); const wx = ((ev.clientX - r.left) * scale - m.ox) / m.sc, wy = ((ev.clientY - r.top) * scale - m.oy) / m.sc;
    B.view.x = innerWidth / 2 - wx * k; B.view.y = innerHeight / 2 - wy * k; applyView(); };
  go(e);
  const up = () => { removeEventListener("pointermove", go); removeEventListener("pointerup", up); save(); };
  addEventListener("pointermove", go); addEventListener("pointerup", up);
});
$("#mmc").addEventListener("wheel", e => { e.preventDefault(); zoomAt(innerWidth / 2, innerHeight / 2, Math.exp(-Math.sign(e.deltaY) * 0.15)); }, { passive: false });
