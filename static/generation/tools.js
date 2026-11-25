"use strict";
// Shared canvas tool state and initialization.
// Loaded before the main script; only declarations here. The main script calls initTools() before it boots.

const KIND_CN = { character: "角色", scene: "场景", prop: "道具", style: "风格", document: "资料", world: "世界观" };
const toolBusy = new Map();          // node id -> { label, t0 } while a Qwen / media tool runs on it

function setToolBusy(n, label) {
  if (label) toolBusy.set(n.id, { label, t0: Date.now() }); else toolBusy.delete(n.id);
  const el = els.get(n.id); if (!el) return;
  const g = $(".gen", el), on = !!label;
  if (!n.job) { g.classList.toggle("on", on); if (on) { $(".pct", g).textContent = ""; $(".bar i", g).style.width = "0"; } }
  if (on) $(".s", g).textContent = label;
}
setInterval(() => toolBusy.forEach((b, id) => {
  const el = els.get(id); if (el && !node(id)?.job) $(".gen .s", el).textContent = `${b.label} ${Math.round((Date.now() - b.t0) / 1000)}s`;
}), 1000);
async function withBusy(n, label, fn) {
  if (toolBusy.has(n.id)) { toast("这个节点正在处理中"); return; }
  setToolBusy(n, label);
  try { return await fn(); }
  catch (e) { toast(e.message, 4500); }
  finally { setToolBusy(n, null); if (sel.has(n.id)) showPanel(); }
}
const llmNote = r => r && r.device === "CPU" ? "（引擎正忙，用 CPU 跑的，较慢）" : r && r.device && r.device !== "GPU" ? `（${r.device}）` : "";
const mediaVersion = (r, extra = {}) => ({ ref: r.ref, url: r.url, w: r.w, h: r.h, seconds: r.seconds, prompt: "", ...extra });
function placeRight(n, type, dy = 0) { const s = size(n); return freeSpot(n.x + s.w + 110, n.y + dy, type); }

// ================================================================= wiring (called by the main script)
function initTools() {
  cmInit();
  // "/" in an image node's prompt opens the tool menu
  $("#prompt").addEventListener("input", e => {
    const n = node(e.target._node); if (!n || n.type !== "image") return;
    const ta = e.target, i = ta.selectionStart;
    if (e.isComposing) return;
    if (e.inputType === "insertText" && e.data === "/" && (i === 1 || /\s/.test(ta.value[i - 2]))) openSlash(n, true);
    else if (slashState) renderSlash();
  });
  $("#prompt").addEventListener("keydown",slashKeys,true);
  document.addEventListener("pointerdown",event=>{
    if(slashState && !event.target.closest("#prompt,#slashBtn,#slashMenu"))closeSlash();
  });
  document.addEventListener("pointerdown", e => { if (!e.target.closest("#anglePop, [data-sa], #slashBtn")) $("#anglePop").classList.remove("on"); });
  // drop a library asset on the canvas
  vp.addEventListener("drop", e => { const a = e.dataTransfer.getData("application/x-h3-lib"); if (a) { e.stopImmediatePropagation(); e.preventDefault(); placeLibraryAsset(JSON.parse(a), toW(e.clientX, e.clientY)); } }, true);
}
