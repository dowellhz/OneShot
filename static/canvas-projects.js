"use strict";

// ================================================================= boards
async function openBoard(id) {
  await flushSave();
  boardId = id; localStorage.setItem("h3.board", id);
  let b = {}; try { b = await (await fetch("/api/board/" + id)).json(); } catch {}
  B = Object.assign(emptyBoard(), b && b.nodes ? b : {});
  B.groups = Array.isArray(B.groups) ? B.groups.filter(g => g && typeof g.id === "string" && Array.isArray(g.nodes)).map(g => ({...g,name:String(g.name || "分组"),nodes:g.nodes.filter(id => B.nodes.some(n => n.id === id))})) : [];
  const cnt = {};   // boards from the first version: names, defaults
  B.nodes.forEach(n => { cnt[n.type] = (cnt[n.type] || 0) + 1; n.name = n.name || `${TYPE_CN[n.type]} ${cnt[n.type]}`; n.data = { ...defaults(n.type), ...n.data }; n.versions = n.versions || []; delete n.w;
    if (n.type === "image" && !["4mp", "16mp"].includes(n.data.quality)) n.data.quality = "4mp"; });
  undoStack.length = redoStack.length = 0; sel.clear(); selEdge = null;
  $("#bname").textContent = B.name || "我的画布";
  rebuild();
  if (!b.nodes) fit(); else applyView();
  poll(); schedulePrewarm(3000);
  if (typeof acRememberBoard === "function") acRememberBoard(id, B);
  if (typeof acBoardChanged === "function") acBoardChanged();
  if (typeof alBoardChanged === "function") alBoardChanged();
  $("#shotList [data-close]")?.click();
}
$("#bname").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } });
$("#bname").addEventListener("blur", e => { const t = e.target.textContent.trim() || "未命名画布"; e.target.textContent = t; B.name = t; save(); });
$("#bmenuBtn").onclick = async e => {
  e.stopPropagation(); const m = $("#boards");
  if (m.classList.contains("on")) { m.classList.remove("on"); return; }
  const list = await (await fetch("/api/boards")).json();
  m.innerHTML = `<div class="mt">我的画布</div>` + list.map(b => `<button data-id="${b.id}">${esc(b.name)}<span class="k">${b.nodes} 个节点</span></button>`).join("") +
    `<div class="sep"></div><button data-qnew>${ico("video")}排队生成：还没生成的视频</button><button data-qall>${ico("video")}排队生成：全部视频（每段多一个新版本）</button>` +
    `<div class="sep"></div><button data-new>${ico("plus")}新建画布</button><button data-export>${ico("dl")}导出当前画布</button><button data-import>${ico("upload")}导入画布 JSON</button><button data-del style="color:#ff8a8a">${ico("trash")}删除当前画布</button>`;
  closeMenus(); m.classList.add("on");
  $$("button[data-id]", m).forEach(b => b.onclick = () => { m.classList.remove("on"); openBoard(b.dataset.id); });
  $("[data-new]", m).onclick = async () => { m.classList.remove("on"); await flushSave(); const id = "b" + Date.now().toString(36); boardId = id; B = emptyBoard("新画布 " + new Date().toLocaleDateString()); fetch("/api/board/" + id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(B) }).then(() => openBoard(id)); };
  const vidsOnBoard = () => B.nodes.filter(x => x.type === "video" && !x.data.film && !x.job);
  $("[data-qnew]", m).onclick = () => { m.classList.remove("on"); queueVideos(vidsOnBoard().filter(x => !x.versions.length)); };
  $("[data-qall]", m).onclick = () => { m.classList.remove("on"); queueVideos(vidsOnBoard()); };
  $("[data-export]", m).onclick = () => { m.classList.remove("on"); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(B, null, 1)], { type: "application/json" })); a.download = (B.name || "board") + ".json"; a.click(); };
  $("[data-import]", m).onclick = () => { m.classList.remove("on"); const i = document.createElement("input"); i.type = "file"; i.accept = ".json"; i.onchange = async () => { const o = JSON.parse(await i.files[0].text()); const id = "b" + Date.now().toString(36); o.nodes?.forEach(n => n.job = null); await fetch("/api/board/" + id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) }); openBoard(id); }; i.click(); };
  $("[data-del]", m).onclick = async () => { m.classList.remove("on"); clearTimeout(saveT); savePending = null; await fetch("/api/board/" + boardId, { method: "DELETE" }); const l = await (await fetch("/api/boards")).json(); openBoard(l[0]?.id || "default"); };
};
document.addEventListener("pointerdown", e => { if (!e.target.closest(".menu, #bmenuBtn, #addBtn, .plus")) closeMenus(); });

// ================================================================= status, boot
async function status() {
  try {
    const s = await (await fetch("/api/status")).json(), q = (s.running || 0) + (s.pending || 0);
    $("#sd").className = "sd " + (!s.comfy ? "bad" : q ? "busy" : "ok");
    let qt = "";
    if (q || B?.nodes.some(n => n.job)) { try { const Q = await (await fetch("/api/queue")).json(); if (Q.jobs.length) qt = `${Q.jobs.length} 个任务 · 约 ${fmtT(Q.total)}`; } catch {} }
    $("#stt").textContent = (!s.comfy ? (s.loading ? "H3 引擎启动中…" : "生成引擎未启动") : qt ? `生成中 · ${qt}` : q ? `生成中 · 队列 ${q}` : "H3 引擎就绪") + (s.llm_running ? ` · 改写模型(${s.llm_device})` : "") + (s.remote ? ` · 文本：${s.remote}` : "") + (qt || q ? " ▾" : "");
  } catch { $("#sd").className = "sd bad"; $("#stt").textContent = "画布服务断开"; }
}
function updateEmpty() { $("#empty").classList.toggle("on", !B.nodes.length); }
addEventListener("resize", placeOverlays);
setInterval(() => B && B.nodes.forEach(n => n.job && renderJob(n)), 1000);
initTools();
initImageEditor();
initCanvasTools();
initAgentChat();
initFilm();
if (typeof initShotList === "function") initShotList();
initWizard();
initSettings();
initAccount();
initAssetLibrary();
(async () => {
  const qs = new URLSearchParams(location.search);
  if (qs.get("board")) boardId = qs.get("board");
  const list = await (await fetch("/api/boards")).json().catch(() => []);
  if (!list.find(b => b.id === boardId)) {
    boardId = list[0]?.id;
    if (!boardId) {   // a new member: start with an empty board of their own
      boardId = "b" + Date.now().toString(36);
      await fetch("/api/board/" + boardId, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(emptyBoard()) });
    }
  }
  await loadCaps();
  await openBoard(boardId);
  if (qs.get("board") || qs.get("wizard") || qs.get("samples")) history.replaceState(null, "", "/");
  if (qs.get("wizard")) openWizard();
  if (qs.get("samples")) showGallery();
  status(); setInterval(status, 4000);
})();
