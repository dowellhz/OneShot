"use strict";

// ---- help
$("#helpBtn").onclick = () => $("#help").classList.add("on");
$("#help").addEventListener("click", e => { if (e.target.id === "help") $("#help").classList.remove("on"); });
vp.addEventListener("dblclick", e => {
  if (e.target !== vp && e.target !== world && e.target !== svg) return;
  openAddMenu(e.clientX, e.clientY, { at: toW(e.clientX, e.clientY) });
});

// add menu: at a canvas point, downstream of a node (from), or upstream of a node (to)
let addCtx = null;
function openAddMenu(x, y, ctx) {
  if (!canvasCanEdit()) return;
  closeMenus(); addCtx = ctx; const m = $("#addMenu");
  $$('[data-arrange-entry]', m).forEach(el => { el.hidden = !ctx.arrange; });
  $('button[data-arrange-entry]', m).onclick = () => ctOpenArrangeMenu(x, y);
  const comment = $("[data-comment-entry]",m);
  comment.hidden = !ctx.arrange;
  comment.onclick = () => { closeMenus(); ccPoint(ctx.at); };
  $$("button[data-add]", m).forEach(b => {
    const t = b.dataset.add; let ok = true;
    if (ctx.from) ok = t !== "upload" && t !== "previs" && t !== "playlist" && canLink(ctx.from, { id: "?", type: t });
    if (ctx.to) ok = t === "text" || t === "image" || t === "upload";
    b.style.display = ok ? "" : "none";
  });
  $("[data-previs-menu]",m)?.remove();
  $("[data-audio-menu]",m)?.remove();
  $("[data-video-menu]",m)?.remove();
  $("[data-reference-library-menu]",m)?.remove();
  if (ctx.to?.type === "video" && !ctx.to.data.previs && !ctx.to.data.film && !ctx.to.job && !prepping.has(ctx.to.id)) {
    const sources = B.nodes.filter(n => n.id !== ctx.to.id && n.type === "video" && pvGuideAvailable(curV(n)));
    if (sources.length) {
      const list = document.createElement("div");
      list.dataset.previsMenu = "";
      list.innerHTML = OneShotI18n.html`<div class="sep"></div><div class="mt">选用白模动作参考</div>`;
      for (const source of sources) {
        const b = document.createElement("button");
        b.innerHTML = ico("video");
        const span=curV(source).previs_span;
        b.append(`${source.name} · 版本 ${source.cur + 1}${Array.isArray(span)?" · "+pvSpanLabel(span):""}`);
        b.onclick = () => {
          closeMenus();
          if (!canvasCanEdit() || node(ctx.to.id) !== ctx.to || ctx.to.job || prepping.has(ctx.to.id) || !pvGuideAvailable(curV(source))) return;
          checkpoint(); rememberVideoVersion(ctx.to); attachPrevis(source, ctx.to);
        };
        list.append(b);
      }
      m.append(list);
    }
    for (const [type,label] of [["video","选用参考视频"],["audio","选用画布音频"]]) {
      const candidates=B.nodes.filter(n=>n.type===type && canLink(n,ctx.to));
      if (!candidates.length) continue;
      const list=document.createElement("div");
      list.dataset[type+"Menu"]="";
      list.innerHTML=`<div class="sep"></div><div class="mt">${label}</div>`;
      for (const source of candidates) {
        const button=document.createElement("button");
        button.innerHTML=ico(type);
        button.append(`${source.name} · 版本 ${source.cur+1}`);
        button.onclick=()=>{closeMenus(); if(canvasCanEdit()&&node(ctx.to.id)===ctx.to&&node(source.id)===source&&!ctx.to.job&&!prepping.has(ctx.to.id))link(source,ctx.to);};
        list.append(button);
      }
      m.append(list);
    }
    const library=document.createElement("div");
    library.dataset.referenceLibraryMenu="";
    library.innerHTML='<div class="sep"></div>';
    for (const kind of ["video","audio"]) {
      const button=document.createElement("button");
      button.dataset.libraryReference=kind;
      button.innerHTML=ico(kind);
      button.append(OneShotI18n.t("从资产库选用{kind}", {kind:OneShotI18n.t(TYPE_CN[kind])}));
      button.onclick=()=>{closeMenus();openReferenceLibrary(ctx.to,kind);};
      library.append(button);
    }
    m.append(library);
  }
  $(".mt", m).textContent = ctx.from ? OneShotI18n.t("连接到新节点") : ctx.to ? OneShotI18n.t("添加上游输入") : OneShotI18n.t("添加到画布");
  m.classList.add("on");
  m.style.left = Math.max(8, Math.min(x, innerWidth - m.offsetWidth - 8)) + "px"; m.style.top = Math.max(8, Math.min(y, innerHeight - m.offsetHeight - 8)) + "px";
}
// first spot at (x, y) or below it where a new node of this type does not overlap an existing one
function freeSpot(x, y, type, dimensions) {
  const {w,h}=dimensions || (type==="text"?{w:300,h:220}:{w:320,h:400});
  const gap=dimensions?85:50;
  const rects = ctCanvasRects();
  for (let i = 0; i < 40; i++) {
    const hit = rects.find(n => x < n.x + n.w + gap && x + w + gap > n.x && y < n.y + n.h + gap && y + h + gap > n.y);
    if (!hit) return { x, y };
    y = hit.y + hit.h + gap;
  }
  return { x, y };
}
function closeMenus() {
  closeSlash();
  $$(".menu").forEach(m => m.classList.remove("on"));
  nodePinTrigger = null;
  $("#canvasLayoutBtn").setAttribute("aria-expanded","false");
}
function addFromMenu(type) {
  const ctx = addCtx || {}; closeMenus();
  let at = ctx.at;
  if (!at && ctx.from) { const s = size(ctx.from); at = freeSpot(ctx.from.x + s.w + 110, ctx.from.y, type); }
  if (!at && ctx.to) at = freeSpot(ctx.to.x - 420, ctx.to.y, type);
  if (!at) at = toW(innerWidth / 2 - 150, innerHeight / 2 - 180);
  if (type === "previs") return addPrevisNode(at);
  if (type === "playlist") return createFilmPlaylist([],at);
  if (type === "upload") {
    const board=B;
    pickFiles(files => {if(B===board)void importCanvasFiles(files,at,ctx.to);});
    return;
  }
  checkpoint();
  const n = addNode(type, at.x, at.y);
  if (ctx.from) link(ctx.from, n, true);
  if (ctx.to) link(n, ctx.to, true);
  selectOnly(n.id);
  if (type === "text") setTimeout(() => $("textarea", els.get(n.id))?.focus(), 30); else setTimeout(() => $("#prompt").focus(), 30);
}
$$("#addMenu button[data-add]").forEach(b => b.onclick = () => addFromMenu(b.dataset.add));
$$("#empty [data-add]").forEach(b => b.onclick = () => { addCtx = null; addFromMenu(b.dataset.add); });
$("#addBtn").onclick = e => { const r = e.currentTarget.getBoundingClientRect(); openAddMenu(r.right + 10, r.top - 6, { at: toW(innerWidth / 2 - 150, innerHeight / 2 - 180) }); };
$("#upBtn").onclick = () => { addCtx = null; addFromMenu("upload"); };
$("#undoBtn").onclick = undo; $("#redoBtn").onclick = redo;
$("#zIn").onclick = () => zoomAt(innerWidth / 2, innerHeight / 2, 1.2);
$("#zOut").onclick = () => zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.2);
$("#zPct").onclick = () => zoomAt(innerWidth / 2, innerHeight / 2, 1 / B.view.k);
$("#zFit").onclick = () => fit();
initCanvasAlignmentSettings();
