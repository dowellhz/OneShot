"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ico = (n, cls = "i") => `<svg class="${cls}"><use href="#i-${n}"/></svg>`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const AR = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:3": 4 / 3, "3:4": 3 / 4, "21:9": 21 / 9 };
const TYPE_CN = { text: "文本", image: "图片", video: "视频", script: "分镜" };

const vp = $("#vp"), world = $("#world"), svg = $("#edges");
let boardId = localStorage.getItem("h3.board") || "default";
let B = null;                         // board
const els = new Map();
let sel = new Set();
let selEdge = null;

function emptyBoard(name = "我的画布") { return { name, nodes: [], edges: [], groups: [], view: { x: 0, y: 0, k: 1 }, seq: 1 }; }
function toast(m, ms = 2400) { const t = $("#toast"); t.textContent = m; t.classList.add("on"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("on"), ms); }

// ================================================================= persistence & history
let saveT = null, savePending = null;
// a save belongs to the board it was made on, even if the user switches boards before it is sent
function save() { if (typeof acGuardSave === "function" && acGuardSave()) return; clearTimeout(saveT); savePending = { id: boardId, b: B }; saveT = setTimeout(flushSave, 500); schedulePrewarm(); }
let prewarmT = null, prewarming = false;
const prewarmed = new Set();
function schedulePrewarm(ms = 5000) { clearTimeout(prewarmT); prewarmT = setTimeout(prewarm, ms); }
async function prewarm() {
  if (prewarming) return schedulePrewarm();
  prewarming = true;
  try {
    for (const n of B.nodes.filter(x => x.type === "video" && !x.data.film && !x.job && !prepping.has(x.id))) {
      if (!usesFields(n) || !fieldsFilled(n)) continue;
      const p = plan(n); if (!p.imgs.every(m => curV(m))) continue;
      const req = videoReq(n, fullPrompt(n)); if (!req) continue;
      const key = JSON.stringify(req); if (prewarmed.has(key)) continue;
      try { const r = await fetch("/api/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) }); if (r.ok) prewarmed.add(key); } catch {}
    }
  } finally { prewarming = false; }
}
let saveChain = Promise.resolve();
// saves run one after another, each carrying the board revision it is based on (B.rev); the server refuses a stale one
function flushSave(keepalive) {
  clearTimeout(saveT); const p = savePending; savePending = null; if (!p) return saveChain;
  if (keepalive) { sendSave(p, true); return saveChain; }
  return saveChain = saveChain.then(() => sendSave(p, false));
}
async function sendSave(p, keepalive) {
  const body = JSON.stringify(p.b, (k, v) => k === "st" ? undefined : v);   // live job status is not board data
  try {
    const r = await fetch("/api/board/" + p.id, { method: "PUT", headers: { "Content-Type": "application/json" }, body, keepalive: !!keepalive && body.length < 60000 });
    if (r.ok) { const j = await r.json().catch(() => ({})); if (j.rev != null && p.b === B) B.rev = j.rev; if (typeof acRememberBoard === "function") acRememberBoard(p.id, {...JSON.parse(body),rev:j.rev}); return; }
    if (r.status === 409 && !keepalive) {
      if (typeof acRecoverSave === "function" && await acRecoverSave(p)) return;
      if (p.id === boardId) { toast("画布已在别处更新（另一个窗口或后台修改），已载入最新版本", 5000); setTimeout(() => openBoard(boardId), 0); }
      return;
    }
    if (r.status !== 401) { let m = r.statusText; try { m = (await r.json()).error || m; } catch {} toast("保存失败：" + m, 5000); }
  } catch { if (!keepalive) { toast("保存失败：网络断开，稍后会再试", 4000); if (!savePending) { savePending = p; saveT = setTimeout(flushSave, 3000); } } }
}
addEventListener("pagehide", () => flushSave(true));
const undoStack = [], redoStack = [];
function snap() { return JSON.stringify({ nodes: B.nodes.map(n => ({ ...n, job: null })), edges: B.edges, groups: B.groups || [], seq: B.seq }); }
function checkpoint() { undoStack.push(snap()); if (undoStack.length > 80) undoStack.shift(); redoStack.length = 0; }
function restore(s) {
  const o = JSON.parse(s), jobs = new Map(B.nodes.filter(n => n.job).map(n => [n.id, n.job]));
  clearDeletedAssetBindings(o.nodes);
  B.nodes = o.nodes; B.edges = o.edges; B.groups = o.groups || []; B.seq = Math.max(B.seq, o.seq);
  B.nodes.forEach(n => { if (jobs.has(n.id)) n.job = jobs.get(n.id); });
  rebuild(); save();
}
function undo() { if (!undoStack.length) return; redoStack.push(snap()); restore(undoStack.pop()); }
function redo() { if (!redoStack.length) return; undoStack.push(snap()); restore(redoStack.pop()); }

// ================================================================= view
function applyView() {
  const v = B.view;
  world.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.k})`;
  vp.style.backgroundPosition = `${v.x}px ${v.y}px`;
  vp.style.backgroundSize = `${22 * v.k}px ${22 * v.k}px`;
  $("#zPct").textContent = Math.round(v.k * 100) + "%";
  placeOverlays(); drawMini();
}
// scroll the canvas while something is dragged near the window edge
function autoPan(tick) {
  let p = null, raf = 0;
  const loop = () => {
    raf = requestAnimationFrame(loop); if (!p) return;
    const m = 56, f = d => d < m ? (m - d) / m * 18 : 0;
    const dx = f(p.x) - f(innerWidth - p.x), dy = f(p.y) - f(innerHeight - p.y);
    if (dx || dy) { B.view.x += dx; B.view.y += dy; applyView(); tick(); }
  };
  raf = requestAnimationFrame(loop);
  return { move(ev) { p = { x: ev.clientX, y: ev.clientY }; }, stop() { cancelAnimationFrame(raf); save(); } };
}
const toW = (cx, cy) => ({ x: (cx - B.view.x) / B.view.k, y: (cy - B.view.y) / B.view.k });
function zoomAt(cx, cy, f) {
  const v = B.view, k = Math.min(3, Math.max(0.15, v.k * f));
  v.x = cx - (cx - v.x) * k / v.k; v.y = cy - (cy - v.y) * k / v.k; v.k = k; applyView(); save();
}
function fit(nodes = B.nodes) {
  if (!nodes.length) { B.view = { x: innerWidth / 2 - 160, y: innerHeight / 2 - 200, k: 1 }; applyView(); return; }
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const n of nodes) { const s = size(n); x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y - 30); x1 = Math.max(x1, n.x + s.w); y1 = Math.max(y1, n.y + s.h); }
  const pad = 140, vw = innerWidth, vh = innerHeight;
  const k = Math.min(1.1, Math.max(0.15, Math.min((vw - pad * 2) / (x1 - x0), (vh - pad * 2) / (y1 - y0))));
  B.view = { k, x: (vw - (x1 - x0) * k) / 2 - x0 * k, y: (vh - (y1 - y0) * k) / 2 - y0 * k }; applyView(); save();
}

// ================================================================= model
const node = id => B.nodes.find(n => n.id === id);
const curV = n => (n && n.versions[n.cur]) || null;
function defaults(type) {
  if (type === "text") return { text: "" };
  if (type === "script") return { prompt: "", nshots: "auto", shotlen: "auto", aspect: "16:9", quality: "hd", title: "", style: "", characters: [], shots: [], made: [] };
  if (type === "image") return { prompt: "", model: "h3img", expand: false, aspect: "3:4", quality: "4mp", count: 1, turbo: true, seed: -1, caption: "" };
  return { prompt: "", duration: 5, aspect: "auto", quality: "hd", mode: "auto", turbo: true, seed: -1, sound: "", music: "", pmode: "free", fields: {}, count: 1 };
}
function nextName(type) { const c = B.nodes.filter(n => n.type === type).length + 1; return `${TYPE_CN[type]} ${c}`; }
function addNode(type, x, y, data = {}, extra = {}) {
  const n = { id: "n" + (B.seq++), type, name: nextName(type), x: Math.round(x), y: Math.round(y), data: { ...defaults(type), ...data }, versions: [], cur: -1, job: null, ...extra };
  B.nodes.push(n); build(n); save(); updateEmpty(); return n;
}
function size(n) {
  if (n.type === "text") return { w: 300, h: 220 };
  if (n.type === "script") { const k = (n.data.shots || []).length; return { w: 440, h: k ? Math.min(620, Math.max(300, 96 + k * 92)) : 300 }; }
  const v = curV(n);
  let ar = v && v.w ? v.w / v.h : (n.data.aspect !== "auto" ? AR[n.data.aspect] : (() => {
    let f = imgInputs(n)[0];
    if (n.type === "video") { const p = plan(n); f = p.ordered.length ? p.imgs[p.ordered[0]] : null; }
    const fv = curV(f); return fv && fv.w ? fv.w / fv.h : (n.type === "image" ? 1 : 16 / 9); })());
  if (n.type === "image") { const area = 300 * 380; let w = Math.sqrt(area * ar); w = Math.max(220, Math.min(460, w)); return { w: Math.round(w), h: Math.round(w / ar) }; }
  const area = 440 * 250; let w = Math.sqrt(area * ar); w = Math.max(240, Math.min(520, w)); return { w: Math.round(w), h: Math.round(w / ar) };
}
function canLink(a, b) {
  if (!a || !b || a.id === b.id) return false;
  if (B.edges.some(e => (e.from === a.id && e.to === b.id) || (e.from === b.id && e.to === a.id))) return false;
  return (a.type === "text" && b.type !== "text") || (a.type === "image" && (b.type === "video" || b.type === "image" || b.type === "script"));
}
function why(a, b) {
  if (a.type === "video") return "视频不能作为输入；可以用「续拍」取最后一帧";
  if (b.type === "text") return "文本节点不接收输入";
  return "这两个节点不能这样连接";
}
function link(a, b, quiet) {
  if (!canLink(a, b)) { if (!quiet && a && b && a.id !== b.id) toast(why(a, b)); return false; }
  if (!quiet) checkpoint();   // quiet callers checkpoint before creating the node
  const e = { from: a.id, to: b.id };
  if (a.data.asset?.kind === "character" && b.type === "video") e.role = "subject";   // new links from a library character default to 人物设定
  B.edges.push(e); drawEdges(); refresh(b); save(); return true;
}
function inputs(n, type) { return B.edges.filter(e => e.to === n.id).map(e => node(e.from)).filter(m => m && (!type || m.type === type)); }
const imgInputs = n => inputs(n, "image");
function removeNodes(ids) {
  if (!ids.length) return;
  checkpoint();
  for (const id of ids) { const n = node(id); if (n?.job) cancel(n); els.get(id)?.remove(); els.delete(id); }
  B.nodes = B.nodes.filter(n => !ids.includes(n.id));
  const touched = B.edges.filter(e => ids.includes(e.from)).map(e => e.to);
  B.edges = B.edges.filter(e => !ids.includes(e.from) && !ids.includes(e.to));
  sel = new Set([...sel].filter(i => !ids.includes(i)));
  touched.forEach(id => node(id) && refresh(node(id)));
  drawEdges(); save(); updateEmpty(); placeOverlays();
}
const ROLE_CN = { auto: "自动", subject: "人物设定", first: "首帧", last: "尾帧", keyframe: "关键帧" };
function vidFrames(sec) { let f = Math.max(5, Math.round(sec * 24)); return f + (5 - f % 17 + 17) % 17; }
// how a video node uses its images: per edge role (auto / subject / first / last / keyframe) -> labels, times, model path
function plan(n) {
  const d = n.data, es = B.edges.filter(e => e.to === n.id && node(e.from)?.type === "image");
  const imgs = es.map(e => node(e.from));
  let roles = es.map(e => e.role || "auto");
  if (d.mode === "reference") roles = roles.map(r => r === "auto" ? "subject" : r);
  const subj = [], fr = [];
  roles.forEach((r, i) => (r === "subject" ? subj : fr).push(i));
  const ordered = [...fr.filter(i => roles[i] === "first"), ...fr.filter(i => roles[i] === "auto" || roles[i] === "keyframe"), ...fr.filter(i => roles[i] === "last")];
  const end = (vidFrames(d.duration) - 4) / 24;
  const useRef = subj.length > 0 || d.mode === "keyframes" || ordered.length > 2 || roles.includes("keyframe") || (ordered.length === 1 && roles[ordered[0]] === "last");
  const times = {}, labels = [];
  if (!useRef) { if (ordered.length >= 1) labels[ordered[0]] = "首帧"; if (ordered.length === 2) labels[ordered[1]] = "尾帧"; }
  else ordered.forEach((i, j) => {
    let t = ordered.length === 1 ? 0 : end * j / (ordered.length - 1);
    if (roles[i] === "first") t = 0; else if (roles[i] === "last") t = end;
    else if (es[i].time != null && isFinite(+es[i].time)) t = Math.min(end, Math.max(0, +es[i].time));   // a time the user typed in
    times[i] = t; labels[i] = t <= 0.01 ? "首帧" : t >= end - 0.05 ? "尾帧" : t.toFixed(1) + "s";
  });
  subj.forEach(i => labels[i] = "人物设定");
  const name = !useRef ? ["文生视频", "首帧生视频", "首尾帧生视频"][Math.min(ordered.length, 2)]
    : (subj.length ? "人物设定" : "") + (subj.length && ordered.length ? " + " : "") + (ordered.length === 1 ? labels[ordered[0]] : ordered.length ? "关键帧" : "");
  return { imgs, es, roles, labels, times, useRef, ordered, subj, mode: useRef ? "ref" : "fl2v", name };
}

// ================================================================= node DOM
function build(n) {
  const el = document.createElement("div");
  el.className = "node " + n.type; el.dataset.id = n.id;
  el.innerHTML = `<div class="lbl">${ico(n.type)}<span class="nm"></span><span class="meta"></span><span class="gr" title="按住拖动">${ico("grip")}</span></div>
    <div class="card"><div class="grip" title="按住拖动">${ico("grip")}</div><div class="body"></div><div class="gen"><div class="pct"></div><div class="bar"><i></i></div><div class="s"></div></div><div class="errbox"></div></div>
    <div class="plus l" title="添加上游节点">${ico("plus")}</div>${n.type !== "video" ? `<div class="plus r" title="拖动连线 / 点击新建下游节点">${ico("plus")}</div>` : `<div class="plus r" title="续拍：取最后一帧接着生成">${ico("plus")}</div>`}`;
  world.appendChild(el); els.set(n.id, el);
  wire(n, el); render(n);
}
function rebuild() {
  els.forEach(e => e.remove()); els.clear();
  B.nodes.forEach(build); drawEdges(); updateEmpty(); placeOverlays();
}
function render(n) {
  const el = els.get(n.id); if (!el) return;
  const s = size(n), v = curV(n), card = $(".card", el), body = $(".body", el);
  el.style.left = n.x + "px"; el.style.top = n.y + "px";
  card.style.width = s.w + "px"; card.style.height = s.h + "px";
  $(".nm", el).textContent = n.name; $(".nm", el).title = n.name;
  let meta = "";
  if (n.type === "text") {
    if (!body.querySelector("textarea")) {
      body.innerHTML = `<textarea placeholder="输入文本：脚本、画面描述、风格、镜头语言……&#10;&#10;连到图片或视频节点后，会并入它们的提示词"></textarea>`;
      const ta = $("textarea", body); ta.value = n.data.text;
      ta.addEventListener("input", () => { n.data.text = ta.value; save(); B.edges.filter(e => e.from === n.id).forEach(e => refresh(node(e.to))); });
      ta.addEventListener("focus", () => { ta._before = snap(); });
      ta.addEventListener("blur", () => { if (ta._before && ta._before !== snap()) { undoStack.push(ta._before); redoStack.length = 0; } });
    }
  } else if (n.type === "script") {
    renderScript(n, body);
    meta = (n.data.shots || []).length ? `${n.data.shots.length} 镜` : "";
  } else if (v) {
    body.innerHTML = n.type === "image" ? `<img class="m" src="${v.url}" draggable="false">` : `<video class="m" src="${v.url}" controls playsinline preload="metadata"></video>`;
    meta = `${v.w}×${v.h}` + (v.seconds ? ` · ${v.seconds.toFixed(1)}s` : "") + (n.versions.length > 1 ? ` · ${n.cur + 1}/${n.versions.length}` : "");
    if (n.type === "video" && v.mode) body.insertAdjacentHTML("beforeend", `<span class="badge">${esc(v.mode)}</span>`);
  } else {
    const hint = n.type === "image" ? (imgInputs(n).length ? `以图改图 · ${imgInputs(n).length} 张参考图<br>选中后写下修改要求，用 @图1 指代原图` : "选中后在下方输入提示词生成<br>或把图片拖到这里") : (() => { const p = plan(n); return p.imgs.length ? `${p.name} · ${p.imgs.length} 张图<br>点连线上的标签可设为人物设定 / 首帧 / 尾帧` : "选中后输入提示词生成<br>连入图片可做人物设定 / 首帧 / 尾帧 / 关键帧"; })();
    body.innerHTML = `<div class="ph">${ico(n.type)}<div class="t">${hint}</div></div>`;
  }
  renderVTabs(n, el);
  $(".meta", el).textContent = meta;
  el.classList.toggle("sel", sel.has(n.id));
  renderJob(n);
  if(n.agent_error)showErr(n,n.agent_error);
}
// put several videos in the generation queue, in name order (视频 2 before 视频 10); each one is sent like a click on 生成
let queueing = false;
async function queueVideos(list) {
  if (queueing) return toast("正在排队，请稍等上一批提交完");
  list = list.filter(x => x && !x.job).sort((a, b) => a.name.localeCompare(b.name, "zh", { numeric: true }) || a.y - b.y || a.x - b.x);
  if (!list.length) return toast("没有需要排队的视频（正在生成的会跳过）");
  queueing = true;
  let ok = 0;
  try {
    for (const [i, v] of list.entries()) {
      toast(`正在提交 ${i + 1}/${list.length}：${v.name}`, 60000);
      await generate(v);
      if (v.job) ok++;
    }
  } finally { queueing = false; }
  const bad = list.length - ok;
  toast(`已排队 ${ok} 段视频，会按顺序依次生成${bad ? `；${bad} 段没提交成功，看节点上的提示` : ""}`, 6000);
}
// Media versions stay in one node; video versions also retain their input graph and settings.
function rememberVideoVersion(n) {
  const v = curV(n); if (n.type !== "video" || !v) return;
  if (!Array.isArray(v.input_edges)) v.input_edges = JSON.parse(JSON.stringify(B.edges.filter(e => e.to === n.id)));
  if (!v.node_data) v.node_data = JSON.parse(JSON.stringify(n.data));
}
function validVideoInput(edge) {
  const type = node(edge.from)?.type;
  return type === "image" || type === "text" || (type === "video" && edge.relation === "remake");
}
function switchVersion(n, i, {recordUndo = true} = {}) {
  if (!Number.isInteger(i) || !n.versions[i] || i === n.cur) return false;
  if (n.job || prepping.has(n.id) || (IMAGE_EDITOR?.n === n && (IMAGE_EDITOR.busy || IMAGE_EDITOR.agentSelection))) { toast("请等待当前任务完成后再切换版本"); return false; }
  if (recordUndo) checkpoint();
  rememberVideoVersion(n);
  const v = n.versions[i];
  if (n.type === "video") {
    if (Array.isArray(v.input_edges)) {
      const edges = v.input_edges.filter(e => e.to === n.id && e.from !== n.id && validVideoInput(e));
      B.edges = B.edges.filter(e => e.to !== n.id).concat(JSON.parse(JSON.stringify(edges)));
      if (edges.length !== v.input_edges.length) toast("部分历史输入节点已删除，已恢复仍存在的连线");
    }
    if (v.node_data) n.data = JSON.parse(JSON.stringify(v.node_data));
  }
  n.cur = i; save(); render(n); refreshDownstream(n); if (sel.size === 1 && sel.has(n.id)) showPanel(); drawEdges();
  return true;
}
function renderVTabs(n, el) {
  let t = $(".vtabs", el);
  if (!["image", "video"].includes(n.type) || n.versions.length < 2) { t?.remove(); return; }
  if (!t) {
    t = document.createElement("div"); t.className = "vtabs"; el.appendChild(t);
    t.setAttribute("role", "tablist"); t.setAttribute("aria-label", "历史版本"); t.setAttribute("aria-orientation", "vertical");
    t.addEventListener("pointerdown", e => e.stopPropagation());
    t.addEventListener("dblclick", e => e.stopPropagation());
  }
  t.innerHTML = n.versions.map((v, i) => {
    const tip = [`版本 ${i + 1}`, v.label || v.mode, v.seconds ? v.seconds.toFixed(1) + "s" : "", v.seed != null ? "seed " + v.seed : ""].filter(Boolean).join(" · ");
    return `<button role="tab" aria-selected="${i === n.cur}" aria-label="版本 ${i + 1}" data-i="${i}" class="${i === n.cur ? "on" : ""}" title="${esc(tip)}" ${n.job ? "disabled" : ""}>${i + 1}</button>`;
  }).join("");
  $$("button", t).forEach(b => b.onclick = e => {
    e.stopPropagation();
    switchVersion(n, +b.dataset.i);
  });
  if(n.type==="video")$$("button",t).forEach(b=>b.oncontextmenu=e=>{e.preventDefault();e.stopPropagation();vtTabMenu(n,+b.dataset.i,e.clientX,e.clientY);});
}
function refresh(n) { if (!n) return; render(n); if (sel.size === 1 && sel.has(n.id)) showPanel(); drawEdges(); }

function wire(n, el) {
  // drag the node (card or label); click selects
  const startDrag = e => {
    if (e.button !== 0 || spaceDown || e.target.closest(".plus, [contenteditable=true]")) return;
    const vid = e.target.closest("video");
    // typing in a text node, or the video's control bar: select only, leave the element alone
    if (e.target.closest("textarea") || (vid && e.clientY > vid.getBoundingClientRect().bottom - 52 * B.view.k)) {
      if (!sel.has(n.id) || sel.size > 1) { sel = new Set([n.id]); updateSel(); }
      return;
    }
    e.stopPropagation();
    if (vid) e.preventDefault();
    if (!sel.has(n.id)) { if (!e.shiftKey) sel.clear(); sel.add(n.id); updateSel(); }
    else if (e.shiftKey) { sel.delete(n.id); updateSel(); return; }
    const moving = [...sel].map(node).filter(Boolean), w0 = toW(e.clientX, e.clientY);
    const starts = moving.map(m => [m.x, m.y]); let moved = false, before = snap(), last = e;
    const ap = autoPan(() => mv(last));
    const mv = ev => {
      last = ev;
      const w = toW(ev.clientX, ev.clientY), dx = w.x - w0.x, dy = w.y - w0.y;
      if (!moved && Math.abs(ev.clientX - e.clientX) + Math.abs(ev.clientY - e.clientY) < 4) return;
      if (!moved) { moved = true; moving.forEach(m => els.get(m.id)?.classList.add("dragging")); }
      ap.move(ev);
      moving.forEach((m, i) => { m.x = Math.round(starts[i][0] + dx); m.y = Math.round(starts[i][1] + dy); const me = els.get(m.id); me.style.left = m.x + "px"; me.style.top = m.y + "px"; });
      vtMarkDrop(vtDropTarget(moving));
      drawEdges(); placeOverlays(); drawMini();
    };
    const up = ev => {
      ap.stop(); removeEventListener("pointermove", mv); removeEventListener("pointerup", up);removeEventListener("pointercancel",up);
      moving.forEach(m => els.get(m.id)?.classList.remove("dragging"));
      const mergeTarget=moved&&ev?.type!=="pointercancel"?vtDropTarget(moving):null;vtMarkDrop(null);
      if(mergeTarget&&vtMerge([...moving.map(m=>m.id),mergeTarget.id],mergeTarget.id,before)){
        for(const id of sel){const me=els.get(id);if(me){me._dragged=true;setTimeout(()=>me._dragged=false,0);}}return;
      }
      if (moved) { el._dragged = true; setTimeout(() => el._dragged = false, 0); undoStack.push(before); redoStack.length = 0; save(); }
    };
    addEventListener("pointermove", mv); addEventListener("pointerup", up);addEventListener("pointercancel",up);
  };
  // a drag that started on a video must not also toggle play/pause
  el.addEventListener("click", ev => { if (el._dragged) { ev.preventDefault(); ev.stopPropagation(); } }, true);
  $(".card", el).addEventListener("pointerdown", startDrag);
  $(".lbl", el).addEventListener("pointerdown", startDrag);
  $(".card", el).addEventListener("dblclick", e => {
    const v = curV(n); if (!v || n.type !== "image") return; e.stopPropagation(); lightbox(v);
  });
  // rename
  const nm = $(".nm", el);
  nm.addEventListener("dblclick", e => { e.stopPropagation(); nm.contentEditable = "true"; nm.focus(); document.getSelection().selectAllChildren(nm); });
  nm.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); nm.blur(); } });
  nm.addEventListener("blur", () => { if (nm.contentEditable !== "true") return; nm.contentEditable = "false"; const t = nm.textContent.trim(); if (t && t !== n.name) { checkpoint(); n.name = t; save(); refreshDownstream(n); } else nm.textContent = n.name; });
  // + handles
  const pr = $(".plus.r", el), pl = $(".plus.l", el);
  pr.addEventListener("pointerdown", e => {
    e.stopPropagation(); e.preventDefault();
    if (n.type === "video") return;
    dragLink(n, e, () => { // click without drag: pick a downstream node type
      openAddMenu(pr.getBoundingClientRect().right + 8, pr.getBoundingClientRect().top - 10, { from: n });
    });
  });
  pr.addEventListener("click", e => { if (n.type === "video") { e.stopPropagation(); continueFrom(n); } });
  pl.addEventListener("pointerdown", e => { e.stopPropagation(); e.preventDefault(); const r = pl.getBoundingClientRect(); openAddMenu(r.left - 200, r.top - 10, { to: n }); });
  // drop an image file onto an image node
  if (n.type === "image") {
    el.addEventListener("dragover", e => { e.preventDefault(); e.stopPropagation(); el.classList.add("ok-target"); });
    el.addEventListener("dragleave", () => el.classList.remove("ok-target"));
    el.addEventListener("drop", e => {
      e.preventDefault(); e.stopPropagation(); el.classList.remove("ok-target");
      const a = e.dataTransfer.getData("application/x-h3-asset"); if (a) { addVersion(n, JSON.parse(a)); return; }
      const f = [...e.dataTransfer.files].find(f => f.type.startsWith("image/")); if (f) uploadInto(n, f);
    });
  }
}
function refreshDownstream(n) { B.edges.filter(e => e.from === n.id).forEach(e => refresh(node(e.to))); }

function dragLink(a, e, onClick) {
  const tmp = document.createElementNS("http://www.w3.org/2000/svg", "path"); tmp.setAttribute("class", "tmp"); svg.appendChild(tmp);
  const p0 = port(a, "out"), sx = e.clientX, sy = e.clientY; let moved = false;
  const targets = B.nodes.filter(m => m.id !== a.id);
  let last = e; const ap = autoPan(() => mv(last));
  const mv = ev => {
    last = ev;
    if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 4) return;
    if (!moved) { moved = true; targets.forEach(m => els.get(m.id).classList.add(canLink(a, m) ? "ok-target" : "bad-target")); }
    ap.move(ev);
    tmp.setAttribute("d", curve(p0, toW(ev.clientX, ev.clientY)));
  };
  const up = ev => {
    ap.stop(); removeEventListener("pointermove", mv); removeEventListener("pointerup", up); tmp.remove();
    targets.forEach(m => els.get(m.id)?.classList.remove("ok-target", "bad-target"));
    if (!moved) { onClick && onClick(); return; }
    const t = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".node");
    if (t) link(a, node(t.dataset.id));
    else { const w = toW(ev.clientX, ev.clientY); openAddMenu(ev.clientX, ev.clientY, { from: a, at: w }); }
  };
  addEventListener("pointermove", mv); addEventListener("pointerup", up);
}

// ================================================================= edges
function port(n, side) {
  const s = size(n);
  return side === "out" ? { x: n.x + s.w, y: n.y + s.h / 2 } : { x: n.x, y: n.y + s.h / 2 };
}
function curve(a, b) { const dx = Math.max(50, Math.abs(b.x - a.x) * 0.45); return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`; }
function drawEdges() {
  ctRenderGroups();
  drawMini();
  $$("g", svg).forEach(g => g.remove());
  $$(".elabel", world).forEach(x => x.remove());
  const plans = {};
  B.edges.forEach((e, i) => {
    const a = node(e.from), b = node(e.to); if (!a || !b) return;
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    const d = curve(port(a, "out"), port(b, "in"));
    g.innerHTML = `<path class="hit" d="${d}"></path><path class="vis" d="${d}"></path>`;
    if (selEdge === e) g.classList.add("sel");
    if (e.relation === "remake") {
      g.classList.add("remake-edge");
      const pa = port(a, "out"), pb = port(b, "in"), label = document.createElement("div");
      label.className = "elabel remake-label";
      label.style.left = (pa.x + pb.x) / 2 + "px"; label.style.top = (pa.y + pb.y) / 2 + "px";
      label.textContent = "原片";
      world.appendChild(label);
    } else if (a.type === "image" && b.type === "video") {
      const p = plans[b.id] || (plans[b.id] = plan(b)), k = p.es.indexOf(e);
      const pa = port(a, "out"), pb = port(b, "in"), lb = document.createElement("div");
      lb.className = "elabel" + (p.roles[k] === "subject" ? " subj" : "");
      lb.style.left = (pa.x + pb.x) / 2 + "px"; lb.style.top = (pa.y + pb.y) / 2 + "px";
      lb.innerHTML = `${esc(p.labels[k] || "未使用")} ▾${roleSelect(e)}`;
      world.appendChild(lb); wireRoleSelects(lb);
    }
    g.querySelector(".hit").addEventListener("pointerdown", ev => { ev.stopPropagation(); selEdge = e; sel.clear(); updateSel(); drawEdges(); toast("已选中连线，按 Delete 删除（或双击）", 1600); });
    g.querySelector(".hit").addEventListener("dblclick", ev => { ev.stopPropagation(); cutEdge(e); });
    svg.appendChild(g);
  });
}
function cutEdge(e) { checkpoint(); B.edges = B.edges.filter(x => x !== e); if (selEdge === e) selEdge = null; drawEdges(); refresh(node(e.to)); save(); }

// ================================================================= selection, overlays
function updateSel() {
  els.forEach((el, id) => el.classList.toggle("sel", sel.has(id)));
  if (sel.size) { selEdge = null; drawEdges(); }
  showPanel(); placeOverlays(); drawMini();
}
function placeOverlays() {
  hideNodeToolTip();
  ctPlaceSelectionTools();
  const tools = $("#ntools"), pp = $("#pp");
  if (sel.size !== 1) { tools.classList.remove("on"); pp.classList.remove("on"); return; }
  const n = node([...sel][0]); if (!n) return;
  const r = $(".card", els.get(n.id)).getBoundingClientRect();
  tools.classList.add("on");
  const tw = tools.offsetWidth;
  tools.style.left = Math.max(8, Math.min(innerWidth - tw - 8, r.right - tw)) + "px";
  tools.style.top = Math.max(8, r.top - tools.offsetHeight - 30) + "px";
  if (n.type === "text" || n.data.film) { pp.classList.remove("on"); return; }   // a finished film is edited in 剪辑台, not prompted
  pp.classList.add("on");
  const pw = pp.offsetWidth, ph = pp.offsetHeight;
  pp.classList.toggle("pinned", !!ppPin);
  if (ppPin) {   // the user parked the panel somewhere: keep it there (inside the window)
    pp.style.left = Math.max(8, Math.min(innerWidth - pw - 8, ppPin.x)) + "px";
    pp.style.top = Math.max(8, Math.min(innerHeight - Math.min(ph, 120), ppPin.y)) + "px";
    return;
  }
  let top = r.bottom + 14; if (top + ph > innerHeight - 8) top = Math.max(8, innerHeight - ph - 8);
  pp.style.left = Math.max(8, Math.min(innerWidth - pw - 8, r.left + r.width / 2 - pw / 2)) + "px";
  pp.style.top = top + "px";
}

// the prompt panel can be dragged by its grip and parked; double-click (or ↺) puts it back under the node
let ppPin = JSON.parse(localStorage.getItem("h3.ppPin") || "null");
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
function hideNodeToolTip() {
  const tip = $("#nodeToolTip"); tip.hidden = true;
  tip._button?.removeAttribute("aria-describedby"); tip._button = null;
}
function showNodeToolTip(button) {
  hideNodeToolTip();
  const tip = $("#nodeToolTip"), r = button.getBoundingClientRect();
  tip.textContent = button.dataset.tip; tip.hidden = false; tip._button = button;
  button.setAttribute("aria-describedby", "nodeToolTip");
  tip.style.left = Math.max(8, Math.min(innerWidth - tip.offsetWidth - 8, r.left + (r.width - tip.offsetWidth) / 2)) + "px";
  const below = r.bottom + 8;
  tip.style.top = Math.max(8, below + tip.offsetHeight <= innerHeight - 8 ? below : r.top - tip.offsetHeight - 8) + "px";
}
function showPanel() {
  hideNodeToolTip();
  ctRenderSelectionTools();
  const tools = $("#ntools");
  if (sel.size !== 1) { placeOverlays(); return; }
  const n = node([...sel][0]); if (!n) return;
  const v = curV(n);
  // ---- toolbar
  const b = [];
  const tool = (action, icon, label, hint = label) => `<button type="button" data-a="${action}" aria-label="${esc(label)}" data-tip="${esc(hint)}">${ico(icon)}</button>`;
  if (n.versions.length > 1) b.push(tool("prev", "left", "上一个版本") + `<span class="pg">${n.cur + 1}/${n.versions.length}</span>` + tool("next", "right", "下一个版本") + `<span class="sep"></span>`);
  if (v) {
    if (n.type === "image") b.push(tool("edit", "edit", "编辑图片", "编辑图片 · 局部重绘、扩图、裁剪与调色") + tool("tovideo", "video", "生成视频") + tool("hd", "hd", "高清重绘") + tool("describe", "text", "反推提示词"));
    if (n.type === "video" && n.data.film) b.push(tool("film", "scissors", "编辑成片"));
    else if (n.type === "video") b.push(tool("cont", "next", "续拍") + tool("frame", "image", "截取末帧") + tool("film", "scissors", "剪辑", "剪辑 · 裁剪、字幕、配乐与旁白") + tool("analyze", "script", "拉片", "拉片 · 拆分镜头并分析"));
    b.push(tool("full", "full", "全屏查看") + tool("dl", "dl", "下载"));
  }
  b.push(tool("dup", "copy", "创建副本") + tool("del", "trash", "删除节点") + tool("more", "more", "更多操作"));
  tools.innerHTML = b.join("");
  $$("button", tools).forEach(x => {
    x.onmouseenter = x.onfocus = () => showNodeToolTip(x);
    x.onmouseleave = x.onblur = hideNodeToolTip;
    x.onclick = ev => { hideNodeToolTip(); x.dataset.a === "more" ? (ev.stopPropagation(), ctxMenu({ target: els.get(n.id), clientX: x.getBoundingClientRect().left, clientY: x.getBoundingClientRect().bottom + 6 })) : nodeAction(n, x.dataset.a); };
  });
  if (n.type === "text") { placeOverlays(); return; }
  // ---- refs
  const refs = $("#refs"), items = [];
  if (n.type === "script") imgInputs(n).forEach(m => { const mv = curV(m); items.push(`<span class="ref" title="${esc(m.name)}">${mv ? `<img src="${mv.url}">` : `<span class="tx">${ico("image")}</span>`}${esc(m.name)}<span class="role">${KIND_CN[m.data.asset?.kind] || "参考"}</span></span>`); });
  if (n.type === "image") imgInputs(n).forEach((m, i) => { const mv = curV(m); items.push(`<span class="ref" data-tok="@图${i + 1}" title="点击在提示词中引用 · ${esc(m.name)}">${mv ? `<img src="${mv.url}">` : `<span class="tx">${ico("image")}</span>`}图${i + 1}<span class="role">${i === 0 ? "原图" : "参考"}</span></span>`); });
  if (n.type === "video") {
    const p = plan(n);
    const end = (vidFrames(n.data.duration) - 4) / 24;
    p.imgs.forEach((m, i) => { const mv = curV(m), r = p.roles[i];
      // keyframes get a seconds box: where in the video this picture should be reached
      const tbox = p.useRef && r !== "subject" && r !== "first" && r !== "last" && p.times[i] != null
        ? `<input class="tsec" type="number" min="0" max="${end.toFixed(1)}" step="0.1" value="${(+p.times[i]).toFixed(1)}" data-time="${B.edges.indexOf(p.es[i])}" title="第几秒到达这张图">s` : "";
      items.push(`<span class="ref" data-tok="@图${i + 1}" title="点击在提示词中引用 · ${esc(m.name)}">${mv ? `<img src="${mv.url}">` : `<span class="tx">${ico("image")}</span>`}图${i + 1}<span class="role rsel">${p.labels[i]} ▾${roleSelect(p.es[i])}</span>${tbox}</span>`); });
  }
  inputs(n, "text").forEach(t => items.push(`<span class="ref" title="${esc(t.data.text.slice(0, 200))}"><span class="tx">${ico("text")}</span>${esc(t.name)}<span class="role">已并入</span></span>`));
  refs.innerHTML = items.join(""); refs.style.display = items.length ? "" : "none";
  $$(".ref[data-tok]", refs).forEach(r => r.onclick = e => { if (!e.target.closest("select, input")) insertTok(r.dataset.tok); });
  $$("input[data-time]", refs).forEach(inp => {
    ["pointerdown", "click", "keydown"].forEach(ev => inp.addEventListener(ev, e => e.stopPropagation()));
    inp.onchange = () => {
      const e = B.edges[+inp.dataset.time]; if (!e) return;
      const v = parseFloat(inp.value); checkpoint();
      if (isFinite(v)) { e.time = Math.round(v * 10) / 10; if (!e.role) e.role = "keyframe"; } else delete e.time;
      save(); const vn = node(e.to); render(vn); drawEdges(); if (sel.has(vn.id)) showPanel();
    };
  });
  wireRoleSelects(refs);
  // ---- prompt
  const ta = $("#prompt");
  ta.placeholder = n.type === "script" ? "写剧情，例如：深夜书房，裴照在灯下写字，突然有人敲门。河神抱着一碗汤进来，衣摆滴水，把碗放在桌上。裴照低头察看，碗里映出河神的脸……\n\n可以连入角色 / 场景图片，Qwen 会按图里的样子安排人物" : n.type === "image" ? (imgInputs(n).length ? "写修改要求，例如：把 @图1 里的橘猫换成穿校服的样子，背景改成樱花校园，保持猫的长相不变" : "描述你想生成的画面，例如：秋日校园里，一只背着书包的橘猫站在红砖教学楼前，电影感，暖色逆光") :
    (imgInputs(n).length ? "描述视频中的动作、镜头和声音；点上方的图可以用 @图1 引用它" : "描述视频内容、动作、镜头运动和声音，例如：雪地森林里一只红狐狸小跑后回头看向镜头，镜头缓慢推近；风声和踩雪声");
  if (ta._node !== n.id) { ta.value = n.data.prompt; ta._node = n.id; }
  const fm = n.type === "video" && n.data.pmode === "fields";
  $("#pmode").innerHTML = n.type === "video" ? `<button data-m="free" class="${fm ? "" : "on"}" title="一段话自由描述">自由描述</button><button data-m="fields" class="${fm ? "on" : ""}" title="按场景 / 人物 / 动作 / 对话分开填写，系统合成官方格式">分栏填写</button>` : "";
  $$("#pmode button").forEach(b => b.onclick = () => setPMode(n, b.dataset.m));
  ta.style.display = fm ? "none" : ""; $("#pp").classList.toggle("wide", fm);
  renderFields(n, fm);
  if (!fm) autoGrow(ta);
  // ---- controls
  const d = n.data, ctl = $("#ctl");
  const pill = (k, opts, label, extra = "") => `<span class="pill ${extra}">${label}<select data-k="${k}">${Object.entries(opts).map(([a, t]) => `<option value="${a}" ${String(a) === String(d[k]) ? "selected" : ""}>${t}</option>`).join("")}</select></span>`;
  const arIcon = a => { const r = AR[a] || 1.6; const w = r >= 1 ? 13 : Math.round(13 * r), h = r >= 1 ? Math.round(13 / r) : 13; return `<span class="ar" style="width:${w}px;height:${h}px"></span>`; };
  let h;
  if (n.type === "script") h = scriptCtl(n);
  else if (n.type === "image") {
    const rem = isRemote(n), hi = rem || d.model !== "h3video", ins = imgInputs(n).length, fa = d.aspect === "auto";
    h = provPill(n, pill);
    if (!rem) {
      h += pill("model", { h3img: "H3-Image（推荐，支持以图改图）", h3video: "H3 视频模型 · 快速出图" }, `<span class="dot"></span>${hi ? "H3-Image" : "H3 快速"}${ico("down")}`, "model");
      if (hi) h += pill("expand", { false: "智能扩写：关", true: "智能扩写：开（按官方格式扩写，理解更准）" }, d.expand ? "扩写 开" : "扩写 关");
      else h += pill("turbo", { true: "极速 8 步", false: "高质量 30 步" }, d.turbo ? "极速" : "高质量");
    }
    h += pill("aspect", { ...(ins ? { auto: "跟随原图" } : {}), "1:1": "1:1", "3:4": "3:4", "4:3": "4:3", "9:16": "9:16", "16:9": "16:9", "21:9": "21:9" }, fa ? `${arIcon(ins ? "4:3" : "1:1")}${ins ? "原图比例" : "1:1"}` : `${arIcon(d.aspect)}${d.aspect}`);
    h += pill("quality", hi ? { "4mp": "4MP（约 2K）", "16mp": "16MP（约 4K，最佳画质，慢）" } : { "4mp": "1K", "16mp": "2K" }, hi ? (d.quality === "16mp" ? "16MP" : "4MP") : (d.quality === "16mp" ? "2K" : "1K"));
    h += pill("count", { 1: "1 张", 2: "2 张", 4: "4 张" }, `${ico("stack")}${d.count}`);
    if (hi) h += `<button class="pill" id="slashBtn" title="三视图、九宫格、换角度、打光……（也可以在提示词里输入 /）">/ 工具</button>`;
  } else {
    const rem = isRemote(n);
    h = provPill(n, pill);
    if (!rem) h += pill("turbo", { true: "MiniMax H3 · 极速", false: "MiniMax H3 · 高质量" }, `<span class="dot"></span>${d.turbo ? "H3 极速" : "H3 高质量"}${ico("down")}`, "model");
    const fa = d.aspect === "auto";
    h += pill("aspect", { auto: "跟随首图", "16:9": "16:9", "9:16": "9:16", "1:1": "1:1", "4:3": "4:3", "3:4": "3:4" }, `${arIcon(fa ? "16:9" : d.aspect)}${fa ? "自动" : d.aspect}`);
    h += pill("quality", { hd: "高清 768P", std: "标准 480P" }, d.quality === "hd" ? "768P" : "480P");
    h += pill("duration", { 5: "5 秒", 8: "8 秒", 10: "10 秒", 14: "14 秒（最长）" }, `${ico("clock")}${Math.min(14, Math.max(5, d.duration))}s`);
    if (imgInputs(n).length) h += pill("mode", { auto: "按每张图的设置", keyframes: "全部当关键帧", reference: "全部当人物设定" }, plan(n).name);
    if (!d.film) h += pill("count", { 1: "出 1 个", 2: "抽 2 个版本，挑最好的", 3: "抽 3 个版本，挑最好的" }, `${ico("stack")}${d.count > 1 ? "抽 " + d.count : "1 个"}`);
  }
  if (n.type !== "script") h += `<button class="pill" id="moreBtn" title="更多设置">${ico("more")}</button>`;
  if (n.type === "video" && d.pmode === "fields") h += `<button class="pill" id="fillBtn" title="Qwen 看连入的首帧 / 人物图，填写风格、场景、人物、镜头（只填空着的栏）">看图填写</button>`;
  if (n.type === "video") {
    h += `<button class="pill" id="pvBtn" title="查看系统合成后、实际发给模型的完整提示词">预览</button>`;
    h += `<button class="pill" id="rwBtn" title="用本地 Qwen3.5 把描述改写成 H3 官方英文结构化提示词（可看到连入的图片）">✨ 改写</button>`;
    if (d.prompt_src) h += `<button class="pill" id="rsBtn" title="还原改写前的原文">还原原文</button>`;
  }
  h += `<span class="grow"></span><span class="est">${estimate(n)}</span>`;
  h += `<button id="send" class="${n.job ? "stop" : ""}" title="${n.job ? "取消" : "生成 (⌘↩)"}">${ico(n.job ? "stop" : "send")}</button>`;
  ctl.innerHTML = h;
  $$("select", ctl).forEach(s => s.onchange = () => {
    checkpoint();
    let val = s.value; if (s.dataset.k === "turbo" || s.dataset.k === "expand") val = val === "true"; else if (["count", "duration"].includes(s.dataset.k)) val = Number(val);
    n.data[s.dataset.k] = val; save(); render(n); refreshDownstream(n); showPanel();
  });
  $("#send").onclick = () => n.job ? cancel(n) : generate(n);
  if ($("#moreBtn")) $("#moreBtn").onclick = e => { e.stopPropagation(); $("#more").classList.toggle("on"); };
  if ($("#slashBtn")) $("#slashBtn").onclick = e => { e.stopPropagation(); openSlash(n, false); };
  if ($("#fillBtn")) $("#fillBtn").onclick = () => fillFieldsFromImages(n);
  if (n.type === "script") { wireScriptCtl(n, ctl); $("#more").classList.remove("on"); placeOverlays(); return; }
  if ($("#rwBtn")) $("#rwBtn").onclick = () => rewritePrompt(n);
  if ($("#pvBtn")) $("#pvBtn").onclick = () => previewPrompt(n);
  if ($("#rsBtn")) $("#rsBtn").onclick = () => {
    checkpoint(); n.data.prompt = n.data.prompt_src; delete n.data.prompt_src;
    if (n.data.rw_from === "fields") n.data.pmode = "fields"; delete n.data.rw_from;
    save(); $("#prompt").value = n.data.prompt; showPanel();
  };
  // ---- more
  const more = $("#more");
  more.innerHTML = `<label>随机种子<input type="number" id="mSeed" value="${d.seed}"></label><div class="h">-1 为每次随机；固定数字可复现同一结果</div>` +
    (n.type === "image" ? `<label>画面描述<input type="text" id="mCap" value="${esc(d.caption)}" placeholder="供多图视频使用"></label><div class="h">上传的图片建议填写；生成的图片自动使用提示词</div>` :
      (d.pmode === "fields" ? `<div class="h">分栏模式：声音、配乐在上方填写。<br>极速：4~8 步，约 1~2.5 分钟；高质量 20 步，慢约 4 倍</div>` :
      `<label>声音<input type="text" id="mSound" value="${esc(d.sound)}" placeholder="环境音、动作音效"></label>
       <label>配乐<input type="text" id="mMusic" value="${esc(d.music)}" placeholder="留空 = 无配乐"></label>
       <div class="h">会写进官方格式的 overall_soundscape / non_diegetic_music。台词直接写进提示词，如：裴照低声问："谁？"<br>极速：4~8 步，约 1~2.5 分钟；高质量 20 步，慢约 4 倍</div>`));
  $("#mSeed").onchange = e => { n.data.seed = Number(e.target.value); save(); };
  const mc = $("#mCap"); if (mc) mc.oninput = e => { n.data.caption = e.target.value; save(); };
  const ms = $("#mSound"); if (ms) ms.oninput = e => { n.data.sound = e.target.value; save(); };
  const mm = $("#mMusic"); if (mm) mm.oninput = e => { n.data.music = e.target.value; save(); };
  placeOverlays();
}
function roleSelect(e) {
  const i = B.edges.indexOf(e);
  return `<select data-edge="${i}" title="这张图在视频里的作用">${Object.entries(ROLE_CN).map(([k, t]) => `<option value="${k}" ${(e.role || "auto") === k ? "selected" : ""}>${t}</option>`).join("")}</select>`;
}
function wireRoleSelects(root) {
  $$("select[data-edge]", root).forEach(sl => {
    sl.addEventListener("pointerdown", e => e.stopPropagation());
    sl.addEventListener("click", e => e.stopPropagation());
    sl.onchange = () => {
      const e = B.edges[+sl.dataset.edge]; if (!e) return;
      checkpoint(); e.role = sl.value === "auto" ? undefined : sl.value; save();
      const v = node(e.to); render(v); drawEdges(); if (sel.has(v.id)) showPanel();
      if (sl.value === "subject") toast("人物设定：保持这张图里人物的长相和服装，用 Ref2VA 生成", 2600);
    };
  });
}
function estimate(n) {
  const d = n.data;
  if (n.type === "script") return (d.shots || []).length ? `${d.shots.length} 镜 · 重新拆约 20 秒` : "≈ 10~30 秒";
  if (n.type === "image") {
    const s = d.model === "h3video" ? (d.turbo ? 32 : 110) * (d.quality === "16mp" ? 2 : 1) * d.count
      : ((d.quality === "16mp" ? IMG_T.mp16 : IMG_T.mp4) + (d.expand ? IMG_T.pe : 0)) * d.count;
    return "≈ " + fmtT(s);
  }
  const p = plan(n), hd = d.quality === "hd";
  const s = (p.mode === "fl2v" ? (hd ? 120 : 60) : (hd ? 150 : 65)) * (d.duration / 5) * (d.turbo ? 1 : 4) * (d.count || 1);  // measured
  return "≈ " + fmtT(s);
}
const IMG_T = { mp4: 30, mp16: 50, pe: 25 };   // seconds, measured on the 4090
const fmtT = s => s >= 90 ? (Math.round(s / 30) / 2) + " 分钟" : Math.round(s) + " 秒";
function autoGrow(ta) { ta.style.height = "auto"; ta.style.height = Math.min(320, Math.max(70, ta.scrollHeight)) + "px"; }
// ---- field-by-field video prompt
const FIELDS = [
  { k: "style", t: "风格", ph: "画面风格、质感、色调，如：写实电影感，暖色烛光，浅景深" },
  { k: "scene", t: "场景", sub: "背景", ph: "地点、时间、环境、光线，如：古代书房，深夜，窗外下着雨，油灯昏黄" },
  { k: "people", t: "人物", ph: "一行一个「名字：外貌穿着」，如：\n裴照：二十多岁的书生，青色长衫\n河神：白衣男子，长发湿漉漉" },
  { k: "camera", t: "镜头", ph: "景别与运镜，如：中景固定机位，最后缓慢推近到桌上的碗" },
  { k: "action", t: "动作", sub: "按顺序", ph: "一行一个动作，按发生顺序，如：\n门外突然传来敲门声，裴照在灯下停笔抬头\n河神抱着碗推门进来，衣摆滴水\n河神把碗放到桌上，裴照低头察看" },
  { k: "dialogue", t: "对话", sub: "原文保留", ph: "一行一句「名字：台词」，可加语气，如：\n裴照（低声）：谁？\n河神：给你送碗汤。" },
  { k: "sound", t: "声音", ph: "环境音和动作音效，如：雨声、敲门声、木门吱呀、衣摆滴水声（留空自动匹配）" },
  { k: "music", t: "配乐", ph: "留空 = 无配乐；如：低沉的古琴，节奏缓慢" },
];
let lastField = null;
function renderFields(n, on) {
  const box = $("#pfields"); box.classList.toggle("on", on);
  if (!on) { box._node = null; return; }
  if (box._node === n.id) return;          // keep focus / caret while typing
  box._node = n.id; const f = n.data.fields || (n.data.fields = {});
  box.innerHTML = FIELDS.map(x => `<label class="f"><span>${x.t}${x.sub ? `<small>${x.sub}</small>` : ""}</span><textarea rows="1" data-k="${x.k}" placeholder="${esc(x.ph)}"></textarea></label>`).join("");
  $$("textarea", box).forEach(t => {
    t.value = f[t.dataset.k] || ""; fieldGrow(t);
    t.addEventListener("input", () => { f[t.dataset.k] = t.value; fieldGrow(t); save(); placeOverlays(); });
    t.addEventListener("focus", () => { lastField = t; t._before = snap(); });
    t.addEventListener("blur", () => { if (t._before && t._before !== snap()) { undoStack.push(t._before); redoStack.length = 0; } });
    t.addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (!n.job) generate(n); } });
  });
  requestAnimationFrame(() => { $$("textarea", box).forEach(fieldGrow); placeOverlays(); });   // measure once the panel is visible
}
function fieldGrow(t) { t.style.height = "auto"; t.style.height = Math.min(160, Math.max(28, t.scrollHeight)) + "px"; }
function setPMode(n, m) {
  if (n.data.pmode === m) return;
  checkpoint(); const f = n.data.fields || (n.data.fields = {});
  if (m === "fields" && !Object.values(f).some(v => (v || "").trim())) {   // carry the free text over once
    const p = (n.data.prompt || "").trim();
    if (p && !/integrated_multimodal_description:|subject_definitions:/.test(p)) f.action = p;
    if (n.data.sound) f.sound = n.data.sound;
    if (n.data.music) f.music = n.data.music;
  }
  n.data.pmode = m; save(); $("#pfields")._node = null; showPanel();
  if (m === "fields") setTimeout(() => $(`#pfields textarea[data-k="${f.action ? "action" : "scene"}"]`)?.focus(), 30);
}
async function previewPrompt(n) {
  const req = videoReq(n, fullPrompt(n)); if (!req) return;
  try {
    const r = await api("/api/preview", req);
    $("#pvt").textContent = r.prompt; $("#pvm").textContent = r.mode ? "· " + r.mode : ""; $("#pv").classList.add("on");
  } catch (e) { toast("预览失败：" + e.message, 3500); }
}
$("#pvClose").onclick = () => $("#pv").classList.remove("on");
$("#pv").addEventListener("click", e => { if (e.target.id === "pv") $("#pv").classList.remove("on"); });
$("#pvCopy").onclick = () => { navigator.clipboard?.writeText($("#pvt").textContent).then(() => toast("已复制", 1000), () => toast("复制失败")); };
function insertTok(tok) {
  const ta = (usesFields(node($("#prompt")._node)) && lastField && document.contains(lastField)) ? lastField : $("#prompt"), s = ta.selectionStart ?? ta.value.length;
  ta.value = ta.value.slice(0, s) + tok + " " + ta.value.slice(ta.selectionEnd ?? s); ta.focus(); ta.selectionStart = ta.selectionEnd = s + tok.length + 1;
  ta.dispatchEvent(new Event("input"));
}
$("#prompt").addEventListener("input", e => {
  const n = node(e.target._node); if (!n) return; n.data.prompt = e.target.value; autoGrow(e.target); save(); placeOverlays();
});
$("#prompt").addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); const n = node(e.target._node); if (n && !n.job) generate(n); } });
$("#prompt").addEventListener("focus", e => { e.target._before = snap(); });
$("#prompt").addEventListener("blur", e => { if (e.target._before && e.target._before !== snap()) { undoStack.push(e.target._before); redoStack.length = 0; } });
document.addEventListener("pointerdown", e => { if (!e.target.closest("#more, #moreBtn")) $("#more").classList.remove("on"); });

function nodeAction(n, a) {
  const v = curV(n);
  if (a === "prev" || a === "next") { switchVersion(n, (n.cur + (a === "next" ? 1 : -1) + n.versions.length) % n.versions.length); }
  else if (a === "dl") { const x = document.createElement("a"); x.href = v.url; x.download = v.ref.split("/").pop(); x.click(); }
  else if (a === "full") lightbox(v);
  else if (a === "del") removeNodes([n.id]);
  else if (a === "dup") duplicate([n.id]);
  else if (a === "tovideo") { checkpoint(); const s = size(n); const at = freeSpot(n.x + s.w + 110, n.y, "video"); const m = addNode("video", at.x, at.y); link(n, m, true); selectOnly(m.id); }
  else if (a === "cont") continueFrom(n);
  else if (a === "frame") continueFrom(n, true);
  else if (a === "hd") hdRedraw(n);
  else if (a === "edit") openImageEditor(n);
  else if (a === "describe") describeImage(n);
  else if (a === "analyze") analyzeVideo(n);
  else if (a === "remake") openVideoRemake(n);
  else if (a === "film") n.data.film ? openFilm(n) : openFilm([n]);
  else if (a.startsWith("split")) { const [r, c] = a.slice(5).split("x").map(Number); splitGrid(n, r, c); }
  else if (a.startsWith("asset:")) saveAsset(n, a.slice(6));
}
function selectOnly(id) { sel = new Set([id]); updateSel(); }
function lightbox(v) {
  if (!v) return; const l = $("#light");
  l.innerHTML = v.ref.endsWith(".mp4") ? `<video src="${v.url}" controls autoplay></video>` : `<img src="${v.url}">`; l.classList.add("on");
}
$("#light").addEventListener("click", e => { if (e.target.tagName !== "VIDEO") { $("#light").classList.remove("on"); $("#light").innerHTML = ""; } });

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
  const sb = e.target.closest(".sb"); if (sb && sb.scrollHeight > sb.clientHeight && !(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  const zoom = e.ctrlKey || e.metaKey || (wheelMode === "zoom" && !e.shiftKey) || (wheelMode === "auto" && !e.shiftKey && isMouseWheel(e));
  if (zoom) {
    const d = e.ctrlKey && !e.metaKey && !e.deltaMode && Math.abs(e.deltaY) < 50 ? e.deltaY * 0.0105 : Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaMode ? e.deltaY * 33 : e.deltaY), 120) * 0.0022;
    zoomAt(e.clientX, e.clientY, Math.exp(-d));
  } else {
    const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX, dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
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
      if (!moved) { moved = true; vp.classList.add("pan"); }
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
    if (!active && x1 - x0 + y1 - y0 < 6) return; active = true;
    Object.assign(mq.style, { display: "block", left: x0 + "px", top: y0 + "px", width: x1 - x0 + "px", height: y1 - y0 + "px" });
    sel = new Set(base);
    els.forEach((el, id) => {   // a card counts once the box covers at least half of it
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

// ---- right-click menu
function ctxMenu(e) {
  const el = e.target.closest?.(".node");
  if (!el) { openAddMenu(e.clientX, e.clientY, { at: toW(e.clientX, e.clientY), arrange: true }); return; }
  const n = node(el.dataset.id); if (!n) return;
  if (!sel.has(n.id)) selectOnly(n.id);
  const many = sel.size > 1, v = curV(n), it = [];
  const add = (a, icon, label, k = "") => it.push(`<button data-a="${a}">${ico(icon)}${label}${k ? `<span class="k">${k}</span>` : ""}</button>`);
  it.push(`<div class="mt">${many ? `已选 ${sel.size} 个节点` : esc(n.name)}</div>`);
  if (!many && v) {
    if (n.type === "image") {
      add("edit", "image", "编辑图片（局部重绘 / 扩图 / 裁剪）");
      add("tovideo", "video", "生成视频"); add("hd", "full", "高清重绘"); add("describe", "text", "反推提示词");
      it.push(`<div class="sep"></div>`);
      add("split2x2", "assets", "拆分宫格 2×2"); add("split3x3", "assets", "拆分宫格 3×3"); add("split5x5", "assets", "拆分宫格 5×5");
      it.push(`<div class="sep"></div>`);
      add("asset:character", "image", n.data.asset?.kind === "character" ? "更新资产库角色" : "存为角色"); add("asset:scene", "image", "存为场景"); add("asset:prop", "image", "存为道具");
      it.push(`<div class="sep"></div>`);
    }
    if (n.type === "video" && n.data.film) add("film", "scissors", "编辑成片");
    else if (n.type === "video") { add("cont", "next", "续拍"); add("frame", "image", "截取末帧"); add("film", "scissors", "剪辑 / 加字幕配乐"); add("analyze", "script", "拉片（拆镜头复刻）"); }
    if (n.type === "video") add("remake", "video", "视频重制 · 替换角色");
    add("full", "full", "全屏查看"); add("dl", "dl", "下载");
    it.push(`<div class="sep"></div>`);
  }
  if (many) {
    add("ct:left", "fit", "左对齐"); add("ct:top", "fit", "顶部对齐");
    add("ct:distributeX", "assets", "水平等距排列"); add("ct:distributeY", "assets", "垂直等距排列");
    add("ct:group", "assets", "编组", "⌘G"); add("ct:ungroup", "assets", "取消编组", "⇧⌘G");
    add("ct:download", "dl", "批量下载素材"); it.push(`<div class="sep"></div>`);
  }
  add("arrange", "assets", "整理图片与视频…");
  const vids = [...sel].map(node).filter(m => m && m.type === "video" && curV(m));
  if(vids.length>=2){const info=vtMergeInfo(vids.map(m=>m.id));it.push(`<button data-a="merge-tabs" ${info.error?`disabled title="${esc(info.error)}"`:""}>${ico("stack")}合并为 Tab（${vids.length} 个视频）</button>`);}
  if(!many&&n.type==="video"&&n.versions.length>1){add("split-tab","copy","拆出当前 Tab");add("split-tabs","assets","拆开所有 Tab");}
  const qv = [...sel].map(node).filter(m => m && m.type === "video" && !m.job && !m.data.film);
  if (many && qv.length) { add("queuegen", "video", `排队生成（${qv.length} 段视频，按名称顺序）`); if (!(vids.length >= 2)) it.push(`<div class="sep"></div>`); }
  if (many && vids.length >= 2) { add("concat", "scissors", `剪辑成片（${vids.length} 段，按位置顺序）`); it.push(`<div class="sep"></div>`); }
  add("focus", "fit", many ? "聚焦选中" : "聚焦此节点", "F");
  if (!many) add("rename", "text", "重命名");
  add("dup", "copy", "创建副本", "⌘D");
  it.push(`<div class="sep"></div>`);
  add("del", "trash", "删除", "Del");
  const m = $("#ctxMenu"); m.innerHTML = it.join(""); m.classList.add("on");
  m.style.left = Math.min(e.clientX, innerWidth - m.offsetWidth - 8) + "px"; m.style.top = Math.min(e.clientY, innerHeight - m.offsetHeight - 8) + "px";
  $$("button", m).forEach(b => b.onclick = () => {
    closeMenus(); const a = b.dataset.a;
    if (a === "arrange") ctOpenArrangeMenu(e.clientX, e.clientY);
    else if(a==="merge-tabs")vtMerge(vids.map(m=>m.id),n.id);
    else if(a==="split-tab"||a==="split-tabs")vtSplit(n.id,n.cur,a==="split-tabs");
    else if (a.startsWith("ct:")) ctAction(a.slice(3));
    else if (a === "focus") fit([...sel].map(node).filter(Boolean));
    else if (a === "rename") { const nm = $(".nm", els.get(n.id)); nm.dispatchEvent(new MouseEvent("dblclick", { bubbles: false })); }
    else if (a === "dup") duplicate([...sel]);
    else if (a === "del") removeNodes([...sel]);
    else if (a === "concat") concatVideos(byPosition([...sel]));
    else if (a === "queuegen") queueVideos([...sel].map(node).filter(m => m && m.type === "video" && !m.job && !m.data.film));
    else nodeAction(n, a);
  });
}

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
    for (const n of B.nodes) { const s = size(n); x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + s.w); y1 = Math.max(y1, n.y + s.h); }
    const pad = 80; x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    const sc = Math.min(W / (x1 - x0), H / (y1 - y0)), ox = (W - (x1 - x0) * sc) / 2 - x0 * sc, oy = (H - (y1 - y0) * sc) / 2 - y0 * sc;
    mmMap = { sc, ox, oy };
    g.clearRect(0, 0, W, H); g.globalAlpha = 1; g.fillStyle = "#101012"; g.fillRect(0, 0, W, H);
    // Put the viewport tint behind nodes so it cannot change their shared colors.
    g.fillStyle = "rgba(255,255,255,.06)";
    g.fillRect(vw.x0 * sc + ox, vw.y0 * sc + oy, (vw.x1 - vw.x0) * sc, (vw.y1 - vw.y0) * sc);
    const css = getComputedStyle(document.documentElement), col = { text: css.getPropertyValue("--c-text"), image: `rgb(${css.getPropertyValue("--node-image-rgb").trim()})`, video: `rgb(${css.getPropertyValue("--node-video-rgb").trim()})` };
    g.strokeStyle = "rgba(255,255,255,.14)"; g.lineWidth = 1.5;
    for (const e of B.edges) { const a = node(e.from), b = node(e.to); if (!a || !b) continue; const p = port(a, "out"), q = port(b, "in"); g.beginPath(); g.moveTo(p.x * sc + ox, p.y * sc + oy); g.lineTo(q.x * sc + ox, q.y * sc + oy); g.stroke(); }
    for (const n of B.nodes) {
      const s = size(n); g.globalAlpha = n.type === "image" || n.type === "video" ? 1 : sel.has(n.id) ? 1 : 0.7; g.fillStyle = (col[n.type] || "#888").trim() || "#888";
      g.beginPath(); g.roundRect(n.x * sc + ox, n.y * sc + oy, Math.max(3, s.w * sc), Math.max(3, s.h * sc), 3); g.fill();
      if (sel.has(n.id)) { g.strokeStyle = "#fff"; g.lineWidth = 2; g.stroke(); g.strokeStyle = "rgba(255,255,255,.14)"; g.lineWidth = 1.5; }
    }
    g.globalAlpha = 1; g.strokeStyle = "rgba(255,255,255,.9)"; g.lineWidth = 2;
    g.beginPath(); g.rect(vw.x0 * sc + ox, vw.y0 * sc + oy, (vw.x1 - vw.x0) * sc, (vw.y1 - vw.y0) * sc); g.stroke();
  });
}
$("#mmc").addEventListener("pointerdown", e => {
  e.preventDefault(); e.stopPropagation(); if (!mmMap) return;
  const c = $("#mmc"), m = { ...mmMap }, k = B.view.k, scale = c.width / c.getBoundingClientRect().width;
  const go = ev => { const r = c.getBoundingClientRect(); const wx = ((ev.clientX - r.left) * scale - m.ox) / m.sc, wy = ((ev.clientY - r.top) * scale - m.oy) / m.sc;
    B.view.x = innerWidth / 2 - wx * k; B.view.y = innerHeight / 2 - wy * k; applyView(); };
  go(e);
  const up = () => { removeEventListener("pointermove", go); removeEventListener("pointerup", up); save(); };
  addEventListener("pointermove", go); addEventListener("pointerup", up);
});
$("#mmc").addEventListener("wheel", e => { e.preventDefault(); zoomAt(innerWidth / 2, innerHeight / 2, Math.exp(-Math.sign(e.deltaY) * 0.15)); }, { passive: false });

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
  closeMenus(); addCtx = ctx; const m = $("#addMenu");
  $$('[data-arrange-entry]', m).forEach(el => { el.hidden = !ctx.arrange; });
  $('button[data-arrange-entry]', m).onclick = () => ctOpenArrangeMenu(x, y);
  $$("button[data-add]", m).forEach(b => {
    const t = b.dataset.add; let ok = true;
    if (ctx.from) ok = t !== "upload" && canLink(ctx.from, { id: "?", type: t });
    if (ctx.to) ok = t === "text" || t === "image" || t === "upload";
    b.style.display = ok ? "" : "none";
  });
  $(".mt", m).textContent = ctx.from ? "连接到新节点" : ctx.to ? "添加上游输入" : "添加到画布";
  m.classList.add("on");
  m.style.left = Math.max(8, Math.min(x, innerWidth - m.offsetWidth - 8)) + "px"; m.style.top = Math.max(8, Math.min(y, innerHeight - m.offsetHeight - 8)) + "px";
}
// first spot at (x, y) or below it where a new node of this type does not overlap an existing one
function freeSpot(x, y, type) {
  const w = type === "text" ? 300 : 320, h = type === "text" ? 220 : 400, gap = 50;
  for (let i = 0; i < 40; i++) {
    const hit = B.nodes.find(n => { const s = size(n); return x < n.x + s.w + gap && x + w + gap > n.x && y < n.y + s.h + gap && y + h + gap > n.y; });
    if (!hit) return { x, y };
    y = hit.y + size(hit).h + gap;
  }
  return { x, y };
}
function closeMenus() { $$(".menu").forEach(m => m.classList.remove("on")); }
function addFromMenu(type) {
  const ctx = addCtx || {}; closeMenus();
  let at = ctx.at;
  if (!at && ctx.from) { const s = size(ctx.from); at = freeSpot(ctx.from.x + s.w + 110, ctx.from.y, type); }
  if (!at && ctx.to) at = freeSpot(ctx.to.x - 420, ctx.to.y, type);
  if (!at) at = toW(innerWidth / 2 - 150, innerHeight / 2 - 180);
  if (type === "upload") { pickFiles(f => { checkpoint(); const kind = x => x.type.startsWith("video/") ? "video" : "image";
    // every uploaded image is wired into the node the menu was opened from, in the order the files were picked
    f.forEach((x, i) => { const n = addNode(kind(x), at.x, at.y + i * 420); uploadInto(n, x); if (ctx.to && n.type === "image") link(n, ctx.to, true); }); }); return; }
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

// keyboard
let clip = null;
addEventListener("keydown", e => {
  if (document.querySelector("#wiz.on, #film.on, #wzSample.on, #pv.on, #settings.on")) return;   // the canvas is hidden behind these
  if (e.code === "Space" && !e.target.closest("input, textarea, select, button, [contenteditable=true]")) { if (!spaceDown) { spaceDown = true; vp.classList.add("space"); } e.preventDefault(); return; }
  if (e.target.closest("input, textarea, select, [contenteditable=true]")) return;
  const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
  if (mod && k === "g" && sel.size) { e.preventDefault(); e.shiftKey ? ctUngroup() : ctGroup(); return; }
  if (!mod && !e.altKey) {
    const ar = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (ar && sel.size) { e.preventDefault(); if (!e.repeat) checkpoint(); const st = e.shiftKey ? 50 : 10; [...sel].map(node).filter(Boolean).forEach(n => { n.x += ar[0] * st; n.y += ar[1] * st; render(n); }); drawEdges(); placeOverlays(); drawMini(); save(); return; }
    if (k === "h") { setTool("pan"); toast("抓手：拖空白处移动画布", 1200); return; }
    if (k === "v") { setTool("select"); toast("框选：拖空白处框选", 1200); return; }
    if (k === "m") { setMini(!mmOn); return; }
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
  else if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); sel = new Set(B.nodes.map(n => n.id)); updateSel(); }
  else if (e.key === "Escape") { sel.clear(); selEdge = null; updateSel(); drawEdges(); closeMenus(); $("#drawer").classList.remove("on"); $("#help").classList.remove("on"); }
  else if (e.shiftKey && (e.key === "!" || e.code === "Digit1")) fit();
});
addEventListener("keyup", e => { if (e.code === "Space") { spaceDown = false; vp.classList.remove("space"); } });
addEventListener("blur", () => { spaceDown = false; vp.classList.remove("space"); });
function paste(items, dx = 40, dy = 40) {
  checkpoint(); const map = {}; const made = [];
  for (const o of items) { const n = addNode(o.type, o.x + dx, o.y + dy, o.data); n.versions = JSON.parse(JSON.stringify(o.versions)); n.cur = o.cur; n.name = o.name + " 副本"; map[o.id] = n.id; render(n); made.push(n.id); }
  for (const id of made) for (const v of node(id).versions) {
    if (v.input_edges) v.input_edges = v.input_edges.map(e=>({...e,from:map[e.from]||e.from,to:id}));
    if (v.video_recipe?.images) v.video_recipe.images.forEach(im=>{if(map[im.node_id])im.node_id=map[im.node_id];});
    if(v.tab_nodes)v.tab_nodes=[id];delete v.tab_origin;
  }
  for (const e of B.edges.slice()) if (map[e.from] && map[e.to]) B.edges.push({ ...e, from: map[e.from], to: map[e.to] });
  for (const group of [...(B.groups || [])]) if(group.nodes.every(id => map[id])) B.groups.push({...group,id:"g"+Date.now().toString(36)+Math.random().toString(36).slice(2,6),name:group.name+" 副本",nodes:group.nodes.map(id=>map[id])});
  drawEdges(); sel = new Set(made); updateSel(); save();
}
function duplicate(ids) { paste(ids.map(id => JSON.parse(JSON.stringify(node(id)))), 60, 60); }
