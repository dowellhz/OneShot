"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ico = (n, cls = "i") => `<svg class="${cls}"><use href="#i-${n}"/></svg>`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const AR = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:3": 4 / 3, "3:4": 3 / 4, "21:9": 21 / 9 };
const TYPE_CN = { text: "文本", image: "图片", video: "视频", audio: "音频", script: "分镜" };
const NODE_PINS = new Map([["blue","雾蓝"],["lilac","淡紫"],["amber","琥珀"],["rose","玫瑰"]]);
function nodePins(n) { return [...new Set((Array.isArray(n.pins)?n.pins:[n.pin]).filter(color=>NODE_PINS.has(color)))]; }
function renderNodePinBar() {
  const bar=$("#nodePinBar");
  if(!bar || !B)return;
  const counts=new Map();
  for(const n of B.nodes)for(const color of nodePins(n))counts.set(color,(counts.get(color)||0)+1);
  const markup=[...NODE_PINS].filter(([color])=>counts.has(color)).map(([color,label])=>
    `<button type="button" data-pin-color="${color}" aria-controls="nodeSearch" aria-label="${label}标记 · ${counts.get(color)} 个节点" title="${label}标记 · ${counts.get(color)} 个节点"><span class="node-pin" data-color="${color}" aria-hidden="true"></span><span aria-hidden="true">${counts.get(color)}</span></button>`).join("");
  if(bar._markup!==markup){bar._markup=markup;bar.innerHTML=markup;}
  bar.hidden=!markup;
}
const nodeLocked = n => n?.locked === true;

const vp = $("#vp"), world = $("#world"), svg = $("#edges");
let boardId = localStorage.getItem("h3.board") || "default";
let B = null;                         // board
const els = new Map();
let sel = new Set();
let selEdge = null;
const canvasCanEdit = () => B?.access !== "reviewer";
function canvasApplyAccess() {
  const readOnly = !canvasCanEdit();
  document.body.classList.toggle("review-only",readOnly);
  $("#bname").contentEditable = String(!readOnly);
  $("#boardAccessBadge").hidden = !readOnly;
  if (readOnly && AC.open) $("#acClose").click();
}

function emptyBoard(name = "我的画布") { return { name, nodes: [], edges: [], groups: [], view: { x: 0, y: 0, k: 1 }, seq: 1 }; }
function toast(m, ms = 2400) { const t = $("#toast"); t.textContent = m; t.classList.add("on"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("on"), ms); }

// ================================================================= persistence & history
let saveT = null, savePending = null;
const boardSaveRetry = $("#boardSaveRetry");
function showBoardSaveFailure(message = "") {
  boardSaveRetry.hidden = !message;
  boardSaveRetry.title = message;
}
boardSaveRetry.onclick = async () => {
  boardSaveRetry.disabled = true;
  try { await flushSave(); }
  finally { boardSaveRetry.disabled = false; }
};
// a save belongs to the board it was made on, even if the user switches boards before it is sent
function save() { if (!canvasCanEdit() || typeof acGuardSave === "function" && acGuardSave()) return; clearTimeout(saveT); savePending = { id: boardId, b: B }; saveT = setTimeout(flushSave, 500); schedulePrewarm(); }
let prewarmT = null, prewarming = false;
const prewarmed = new Set();
function schedulePrewarm(ms = 5000) { clearTimeout(prewarmT); if (canvasCanEdit()) prewarmT = setTimeout(prewarm, ms); }
async function prewarm() {
  if (prewarming) return schedulePrewarm();
  prewarming = true;
  try {
    for (const n of B.nodes.filter(x => x.type === "video" && !x.data.film && !x.job && !prepping.has(x.id))) {
      if (!usesFields(n) || !fieldsFilled(n)) continue;
      if (n.data.previs || hasMediaReferences(n)) continue;
      const p = plan(n); if (!p.imgs.every(m => curV(m))) continue;
      const req = videoReq(n, fullPrompt(n)); if (!req) continue;
      const key = JSON.stringify(req); if (prewarmed.has(key)) continue;
      try { const r = await fetch("/api/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) }); if (r.ok) prewarmed.add(key); } catch {}
    }
  } finally { prewarming = false; }
}
let saveChain = Promise.resolve(), saveSequence = 0;
// saves run one after another, each carrying the board revision it is based on (B.rev); the server refuses a stale one
function flushSave(keepalive) {
  clearTimeout(saveT); const p = savePending; savePending = null; if (!p) return saveChain;
  if (keepalive) { sendSave(p, true); return saveChain; }
  const sequence = ++saveSequence;
  return saveChain = saveChain.then(() => sendSave(p, false, sequence));
}
async function sendSave(p, keepalive, sequence) {
  if (AC.pending.has(p.id)) return;  // Queued saves yield to the conflict review.
  const isCurrent = () => p.id === boardId && p.b === B;
  const failed = (message, retryDelay) => {
    if (keepalive || !isCurrent()) return;
    showBoardSaveFailure(message);
    if (savePending || sequence !== saveSequence) return;
    savePending = p;
    if (retryDelay) saveT = setTimeout(flushSave,retryDelay);
  };
  const body = JSON.stringify(liveBoardData(p.b), (k, v) => k === "st" ? undefined : v);   // live job status is not board data
  try {
    const r = await fetch("/api/board/" + p.id, { method: "PUT", headers: { "Content-Type": "application/json" }, body, keepalive: !!keepalive && body.length < 60000 });
    if (r.ok) { const j = await r.json().catch(() => ({})); if (j.rev != null && p.b === B) B.rev = j.rev; if (typeof acRememberBoard === "function") acRememberBoard(p.id, {...JSON.parse(body),rev:j.rev}); if (isCurrent()) showBoardSaveFailure(); return; }
    if (r.status === 409 && !keepalive) {
      if (typeof acRecoverSave === "function" && await acRecoverSave(p)) {
        if (isCurrent() && (AC.pending.has(p.id) || savePending !== p)) showBoardSaveFailure();
        return;
      }
      if (p.id === boardId) { toast("画布已在别处更新（另一个窗口或后台修改），已载入最新版本", 5000); setTimeout(() => openBoard(boardId), 0); }
      return;
    }
    let reason = r.status === 401 ? "登录已过期" : r.statusText;
    try { reason = (await r.json()).error || reason; } catch {}
    failed(reason || "服务器未能保存画布");
  } catch { failed("连接失败，稍后会自动重试",3000); }
}
addEventListener("pagehide", () => flushSave(true));
const undoStack = [], redoStack = [];
let historyEpoch = 0;
function canvasHistoryState(board) {
  return { nodes: board.nodes.map(n => ({ ...n, job: null })), edges: board.edges || [], groups: board.groups || [] };
}
function snap() {
  return JSON.stringify({ ...canvasHistoryState(B), seq: B.seq, epoch: historyEpoch });
}
function rebaseCanvasHistory(incoming) {
  const base = JSON.parse(JSON.stringify(canvasHistoryState(B)));
  const remote = canvasHistoryState({ ...B, ...incoming });
  if (JSON.stringify(base) === JSON.stringify(remote)) return;
  const previousEpoch = historyEpoch++;
  const dangling = state => {
    const ids = new Set(state.nodes.map(n => n.id));
    const references = state.edges.flatMap(e => [e?.from, e?.to]);
    references.push(...state.groups.flatMap(g => Array.isArray(g?.nodes) ? g.nodes : []));
    return new Set(references.filter(id => id && !ids.has(id)));
  };
  const existingDangling = dangling(remote);
  for (const stack of [undoStack, redoStack]) {
    for (let i = stack.length - 1; i >= 0; i--) {
      const { seq, epoch, ...snapshot } = JSON.parse(stack[i]);
      if (epoch !== previousEpoch) { stack.splice(i, 1); continue; }
      try {
        const merged = acMerge(base, snapshot, remote);
        if ([...dangling(merged)].some(id => !existingDangling.has(id))) throw new Error("节点有新的引用");
        stack[i] = JSON.stringify({ ...merged, seq, epoch: historyEpoch });
      } catch {
        stack.splice(0, i + 1);
        break;
      }
    }
  }
}
function checkpoint(before) {
  if (before && JSON.parse(before).epoch !== historyEpoch) return;
  undoStack.push(before || snap());
  if (undoStack.length > 80) undoStack.shift();
  redoStack.length = 0;
}
function restore(s) {
  const o = typeof s === "string" ? JSON.parse(s) : s;
  const jobs = new Map(B.nodes.filter(n => n.job).map(n => [n.id, n.job]));
  if(document.activeElement?.matches("#prompt,#pfields textarea"))document.activeElement._before=null;
  clearDeletedAssetBindings(o.nodes);
  B.nodes = o.nodes; B.edges = o.edges; B.groups = o.groups || []; B.seq = Math.max(B.seq, o.seq);
  B.nodes.forEach(n => { if (jobs.has(n.id)) n.job = jobs.get(n.id); });
  $("#prompt")._node=null; $("#pfields")._node=null;
  rebuild(); showPanel(); save();
  $("#shotList")?.dispatchEvent(new Event("canvas-restored"));
  if(document.activeElement?.matches("#prompt,#pfields textarea"))document.activeElement._before=snap();
}
function stepCanvasHistory(source, destination) {
  while (source.length) {
    const saved = JSON.parse(source.pop());
    if (saved.epoch !== historyEpoch) continue;
    destination.push(snap());
    restore(saved);
    return;
  }
}
function undo() { stepCanvasHistory(undoStack, redoStack); }
function redo() { stepCanvasHistory(redoStack, undoStack); }

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

// ================================================================= model
const node = id => B.nodes.find(n => n.id === id);
const curV = n => (n && n.versions[n.cur]) || null;
function defaults(type) {
  if (type === "audio") return {prompt:"",mode:"tts",provider:"",voice:"",speed:1,lyrics:"",duration_seconds:null,
    prompt_influence:.3,loop:false,subtitles:false,audio_format:"source",sample_rate:null,pitch_semitones:0,gain:1,references:[]};
  if (type === "text") return { text: "" };
  if (type === "script") return { prompt: "", nshots: "auto", shotlen: "auto", aspect: "16:9", quality: "hd", title: "", style: "", characters: [], shots: [], made: [] };
  if (type === "image") return { prompt: "", model: "h3img", expand: false, aspect: "3:4", quality: "4mp", count: 1, turbo: true, seed: -1, caption: "" };
  return { prompt: "", duration: 5, aspect: "auto", quality: "hd", mode: "auto", turbo: true, seed: -1, sound: "", music: "", pmode: "free", fields: {}, count: 1 };
}
function nextName(type) { const c = B.nodes.filter(n => n.type === type).length + 1; return `${TYPE_CN[type]} ${c}`; }
function newCanvasNodeId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return "n" + Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
function addNode(type, x, y, data = {}, extra = {}) {
  const n = { id: newCanvasNodeId(), type, name: nextName(type), x: Math.round(x), y: Math.round(y), data: { ...defaults(type), ...data }, versions: [], cur: -1, job: null, ...extra };
  B.nodes.push(n); build(n); save(); updateEmpty(); if(nodePins(n).length)renderNodePinBar(); return n;
}
function size(n) {
  if (n.type === "group") return {w:n.w,h:n.h};
  if (n.type === "text") return { w: 300, h: 220 };
  if (n.type === "audio") return { w: 320, h: 120 };
  if (n.type === "script") { const k = (n.data.shots || []).length; return { w: 440, h: k ? Math.min(620, Math.max(300, 96 + k * 92)) : 300 }; }
  const v = curV(n);
  let ar = v && v.w ? v.w / v.h : (n.data.aspect !== "auto" ? AR[n.data.aspect] : (() => {
    const p=n.type==="video"?plan(n):null;
    const input=p?(p.ordered.length?p.inputs[p.ordered[0]]:audioInputs(n).length?p.inputs[0]:null):imageInputs(n)[0];
    const fv = (p && (previsInput(n)?.version || videoInputs(n)[0]?.version)) || input?.version;
    return fv && fv.w ? fv.w / fv.h : (n.type === "image" ? 1 : 16 / 9); })());
  if (n.type === "image") { const area = 300 * 380; let w = Math.sqrt(area * ar); w = Math.max(220, Math.min(460, w)); return { w: Math.round(w), h: Math.round(w / ar) }; }
  const area = 440 * 250; let w = Math.sqrt(area * ar); w = Math.max(240, Math.min(520, w)); return { w: Math.round(w), h: Math.round(w / ar) };
}
function canLink(a, b, version=curV(a)) {
  if (!a || !b || a.id === b.id) return false;
  if (b.data?.previs) return false;
  if (isSeedAudio(b)) return canSeedAudioReference(b,a,version);
  if (B.edges.some(e => (e.from === a.id && e.to === b.id) || (e.from === b.id && e.to === a.id))) return false;
  if (a.type === "audio") return b.type === "video" && !b.data?.film && !!version;
  if (a.type === "video") return b.type === "video" && !b.data?.film && !!version && version.source !== "previs";
  return (a.type === "text" && b.type !== "text" && b.type !== "audio") || (a.type === "image" && (b.type === "video" || b.type === "image" || b.type === "script"));
}
function why(a, b) {
  if (b.data?.previs) return "白模的素材在场景编辑器中添加";
  if (isSeedAudio(b)) return "参考生成可连入最多 3 段不同的音频版本或 1 张图片";
  if (a.type === "video") return "参考视频可连到普通视频节点，每个来源只连一次";
  if (a.type === "audio") return "音频可连接到支持全模态参考的视频节点";
  if (b.type === "text") return "文本节点不接收输入";
  return "这两个节点不能这样连接";
}
function link(a, b, quiet, binding) {
  const version=binding?.ref?a?.versions.find(v=>v.ref===binding.ref):curV(a);
  if (isSeedAudio(b)) {
    if (addSeedAudioReference(b,a,version,!quiet)) return true;
    if (!quiet && a && a!==b) toast(why(a,b));
    return false;
  }
  if ((binding?.ref&&!version) || !canLink(a, b, version)) { if (!quiet && a && b && a.id !== b.id) toast(why(a, b)); return false; }
  if (!quiet) checkpoint();   // quiet callers checkpoint before creating the node
  const e = { from: a.id, to: b.id, ...binding };
  if (a.data.asset?.kind === "character" && b.type === "video") e.role = "subject";   // new links from a library character default to 人物设定
  if (a.type === "audio" || a.type === "video") {
    Object.assign(e,{relation:a.type+"_ref",ref:version.ref});
    rememberVideoVersion(b);
    B.edges.push(e);
    const routes=referenceServices(b);
    if (!routes.some(service=>service.id===b.data.provider)) b.data.provider=routes[0]?.id || "";
  } else B.edges.push(e);
  refresh(b); save(); return true;
}
function inputs(n, type) { return B.edges.filter(e => e.to === n.id).map(e => node(e.from)).filter(m => m && (!type || m.type === type)); }
const imgInputs = n => inputs(n, "image");
function imageInputs(n) {
  return B.edges.filter(edge=>edge.to===n.id && node(edge.from)?.type==="image").map(edge=>{
    const source=node(edge.from);
    const index=edge.ref?source.versions.findIndex(v=>v.ref===edge.ref):source.cur;
    return {edge,source,index,version:source.versions[index]};
  });
}
function canvasPromptNode(ta) {
  return node(ta.id==="prompt"?ta._node:$("#pfields")._node);
}
const PROMPT_MEDIA_TAG={image:"图",video:"视频",audio:"音"};
const promptSlot=value=>Number.isSafeInteger(value)&&value>0?value:0;
function promptMediaInputs(type,target){
  if(type==="image")return imageInputs(target);
  return type==="audio"?audioInputs(target):videoInputs(target);
}
function canPromptMedia(source,target,ref=curV(source)?.ref) {
  if(!canvasCanEdit()||!ref||!Object.hasOwn(PROMPT_MEDIA_TAG,source?.type))return false;
  const version=source.versions.find(v=>v.ref===ref);
  if(!version || source.type==="video"&&version.source==="previs")return false;
  if(isSeedAudio(target))return canSeedAudioReference(target,source,version);
  if(!["image","video"].includes(target?.type)||target.data.previs||target.data.film)return false;
  if(target.type==="image"&&(source.type!=="image"||target.data.model==="h3video"))return false;
  const prior=promptMediaInputs(source.type,target).find(input=>input.source===source)?.edge;
  return prior?(!(prior.segment_edit||prior.extension)||prior.ref===ref):canLink(source,target,version);
}
function attachPromptMedia(ta,source,ref) {
  const target=canvasPromptNode(ta);
  if(!canPromptMedia(source,target,ref) || !sel.has(target.id) || sel.size!==1)return "";
  if(target.job||prepping.has(target.id)){toast("请等当前生成完成后再修改参考素材");return "";}
  if(isSeedAudio(target)){
    const version=source.versions.find(v=>v.ref===ref);
    if(!addSeedAudioReference(target,source,version))return "";
    return source.type==="audio"?"@音频"+seedAudioRefs(target).length:"参考图";
  }
  return bindPromptMedia(source,target,ref);
}
function bindPromptMedia(source,target,ref,recordUndo=true) {
  const list=promptMediaInputs(source.type,target), prior=list.find(input=>input.source===source)?.edge;
  const sequence=source.type+"_ref_seq";
  const slot=promptSlot(prior?.prompt_slot) || 1+Math.max(promptSlot(target.data[sequence]),...list.map(input=>promptSlot(input.edge.prompt_slot)));
  if (recordUndo) checkpoint();
  rememberVideoVersion(target);
  target.data[sequence]=Math.max(promptSlot(target.data[sequence]),slot);
  if(prior){
    if(source.type==="video"&&prior.ref!==ref){delete prior.start;delete prior.end;}
    Object.assign(prior,{ref,prompt_slot:slot});refresh(target);save();
  }
  else link(source,target,true,{ref,prompt_slot:slot});
  return promptMediaToken(source.type,slot);
}
function promptMediaToken(type,slot,position){
  return "@"+PROMPT_MEDIA_TAG[type]+(promptSlot(slot)?"{"+slot+"}":position);
}
function mediaInputs(n, relation) {
  return B.edges.filter(e=>e.to===n.id && e.relation===relation).map(edge=>{
    const source=node(edge.from), index=source?.versions.findIndex(v=>v.ref===edge.ref) ?? -1;
    return {edge,source,index,version:source?.versions[index]};
  });
}
const audioInputs=n=>mediaInputs(n,"audio_ref");
function videoInputs(n) { return mediaInputs(n,"video_ref").sort((a,b)=>Number(!!(b.edge.extension||b.edge.segment_edit))-Number(!!(a.edge.extension||a.edge.segment_edit))); }
const promptVideoIndex=(i,guide,special)=>i+1+(guide&&(!special||i>0)?1:0);
function needsReferenceVideo(n) { return !!previsInput(n) || videoInputs(n).length > 0; }
function hasMediaReferences(n) { return needsReferenceVideo(n) || audioInputs(n).length > 0; }
function referenceServices(n) {
  const edge=videoInputs(n)[0]?.edge;
  if (edge?.segment_edit) return CAPS_LIST.segment_edit || [];
  if (edge?.extension) return CAPS_LIST.video_extension || CAPS_LIST.previs || [];
  return (needsReferenceVideo(n) ? CAPS_LIST.previs : CAPS_LIST.audio_reference) || [];
}
function referenceService(n) { return referenceServices(n).find(service => service.id === n.data.provider); }
function videoOutputModel(n) {
  return hasMediaReferences(n)?canvasNodeModel(n,referenceService(n),true):canvasNodeModel(n,nodeProvider(n));
}
function referenceDuration(n) {
  const model=videoOutputModel(n);
  return model?.durations?.at(-1) || (model?.id?.includes("2-5") ? 30 : 15);
}
function canvasVideoDurationChoices(n) {
  const clip=videoInputs(n)[0], guide=previsInput(n);
  if (clip?.edge.segment_edit) return [];
  const configured=videoOutputModel(n)?.durations;
  if (!guide && !clip && !audioInputs(n).length) return configured || SCRIPT_VIDEO_DURATIONS;
  const max=guide && !clip?.edge.extension ? 14 : referenceDuration(n);
  if (configured) return configured.filter(seconds=>seconds<=max);
  return Array.from({length:max-3},(_,index)=>index+4);
}
function canvasVideoDuration(n) {
  const seconds=Number(n.data.duration) || 5;
  const options=canvasVideoDurationChoices(n);
  if (!(hasMediaReferences(n) || isRemote(n)) || !videoOutputModel(n)?.durations || !options.length) return seconds;
  const rounded=Math.round(seconds);
  return options.reduce((best,value)=>Math.abs(rounded-value)<Math.abs(rounded-best)?value:best);
}
function canvasVideoQuality(n) {
  const quality=n.data.quality || "hd", options=videoOutputModel(n)?.qualities;
  return options && !Object.hasOwn(options,quality) ? "std" : quality;
}
function removeNodes(ids) {
  if (!canvasCanEdit()) return;
  const targets = [...new Set(ids)].map(node).filter(Boolean);
  const removable = new Set(targets.filter(n => !nodeLocked(n)).map(n => n.id));
  const protectedCount = targets.length - removable.size;
  if (protectedCount) toast(`已保留 ${protectedCount} 个锁定节点，解锁后可删除`);
  if (!removable.size) return;
  checkpoint();
  for (const id of removable) { const n = node(id); if (n.job) cancel(n); els.get(id)?.remove(); els.delete(id); }
  B.nodes = B.nodes.filter(n => !removable.has(n.id));
  const touched = B.edges.filter(e => removable.has(e.from)).map(e => e.to);
  B.edges = B.edges.filter(e => !removable.has(e.from) && !removable.has(e.to));
  sel = new Set([...sel].filter(i => !removable.has(i)));
  touched.forEach(id => node(id) && refresh(node(id)));
  drawEdges(); save(); updateEmpty(); updateSel();renderNodePinBar();
}
function markCanvasNodes(ids, value, {lock = false} = {}) {
  if (!canvasCanEdit() || !lock && value && !NODE_PINS.has(value)) return;
  const nodes=[...new Set(ids)].map(node).filter(Boolean);
  const removeColor=!lock&&value&&nodes.every(n=>nodePins(n).includes(value));
  const changed=nodes.filter(n=>lock?nodeLocked(n)!==!!value:
    value?nodePins(n).includes(value)===!!removeColor:nodePins(n).length>0);
  if (!changed.length) return;
  checkpoint();
  for (const n of changed) {
    if(lock){
      if(value)n.locked=true;
      else delete n.locked;
    }else{
      const colors=!value?[]:removeColor?nodePins(n).filter(color=>color!==value):[...nodePins(n),value];
      if(colors.length){
        n.pins=colors;
        n.pin=colors[0];
      }else{
        delete n.pins; delete n.pin;
      }
    }
    render(n);
  }
  if(!lock)renderNodePinBar();
  showPanel();
  save();
}
const ROLE_CN = { auto: "自动", subject: "人物设定", first: "首帧", last: "尾帧", keyframe: "关键帧" };
function vidFrames(sec) { let f = Math.max(5, Math.round(sec * 24)); return f + (5 - f % 17 + 17) % 17; }
// how a video node uses its images: per edge role (auto / subject / first / last / keyframe) -> labels, times, model path
function plan(n) {
  const d = n.data, inputs=imageInputs(n), es=inputs.map(input=>input.edge);
  const imgs=inputs.map(input=>input.source);
  const guide = hasMediaReferences(n);
  let roles = es.map(e => e.role || "auto");
  if (guide) roles = roles.map(() => "subject");
  else if (d.mode === "reference") roles = roles.map(r => r === "auto" ? "subject" : r);
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
  subj.forEach(i => labels[i] = guide ? "参考图" : "人物设定");
  const name = !useRef ? ["文生视频", "首帧生视频", "首尾帧生视频"][Math.min(ordered.length, 2)]
    : (subj.length ? "人物设定" : "") + (subj.length && ordered.length ? " + " : "") + (ordered.length === 1 ? labels[ordered[0]] : ordered.length ? "关键帧" : "");
  return { imgs, es, inputs, roles, labels, times, useRef, ordered, subj, mode: useRef ? "ref" : "fl2v", name };
}

// ================================================================= node DOM
function build(n) {
  const el = document.createElement("div");
  el.className = "node " + n.type; el.dataset.id = n.id;
  el.innerHTML = `<div class="lbl">${ico(n.type)}<span class="nm"></span><span class="meta"></span><span class="node-pins" hidden></span><span class="node-lock" title="已锁定位置和删除" aria-label="已锁定位置和删除" hidden>${ico("lock")}</span><span class="gr" title="按住拖动">${ico("grip")}</span></div>
    <div class="card"><div class="grip" title="按住拖动">${ico("grip")}</div><div class="body"></div><div class="gen"><div class="pct"></div><div class="bar"><i></i></div><div class="s"></div></div><div class="errbox"></div></div>
    <div class="plus l" title="添加上游节点">${ico("plus")}</div><div class="plus r" title="拖动连线 / 点击新建下游节点">${ico("plus")}</div>`;
  world.appendChild(el); els.set(n.id, el);
  wire(n, el); render(n);
}
function rebuild() {
  els.forEach(e => e.remove()); els.clear();
  B.nodes.forEach(build); drawEdges(); updateEmpty(); placeOverlays();
  renderNodePinBar();
  acRenderNodeActivity();
  if (filmPlaylistPicker) paintFilmPlaylistPicker();
}
function render(n) {
  const el = els.get(n.id); if (!el) return;
  const s = size(n), v = curV(n), card = $(".card", el), body = $(".body", el);
  el.classList.toggle("ac-voice-reference",!!acVoicePointing() && acVoiceActive.refs.has(n.id));
  el.style.left = n.x + "px"; el.style.top = n.y + "px";
  card.style.width = s.w + "px"; card.style.height = s.h + "px";
  if (n.type === "text") card.dataset.documentBackground = documentBackground(n.data.text_background);
  $(".nm", el).textContent = n.name; $(".nm", el).title = n.name;
  const pinGroup=$(".node-pins",el),colors=nodePins(n),colorKey=colors.join(",");
  if(pinGroup.dataset.colors!==colorKey){
    pinGroup.dataset.colors=colorKey;
    pinGroup.hidden=!colors.length;
    pinGroup.innerHTML=colors.map(color=>`<span class="node-pin" data-color="${color}" title="${NODE_PINS.get(color)}标记"></span>`).join("");
  }
  el.classList.toggle("node-locked",nodeLocked(n));
  $(".node-lock",el).hidden = !nodeLocked(n);
  let meta = "";
  if (n.type === "text" && n.data.text_format === "markdown") {
    let article = $(".node-document",body);
    if (!article) {
      article = document.createElement("article");
      article.className = "node-document";
      body.replaceChildren(article);
    }
    if (article._text !== n.data.text) {
      article._text = n.data.text;
      renderDocumentPreview(article,documentText(n));
    }
  } else if (n.type === "text") {
    if (!body.querySelector("textarea")) {
      body.innerHTML = `<textarea placeholder="输入文本：脚本、画面描述、风格、镜头语言……&#10;&#10;连到图片或视频节点后，会并入它们的提示词"></textarea>`;
      const ta = $("textarea", body); ta.value = n.data.text;
      ta.addEventListener("input", () => { n.data.text = ta.value; save(); B.edges.filter(e => e.from === n.id).forEach(e => refresh(node(e.to))); });
      ta.addEventListener("focus", () => { ta._before = snap(); });
      ta.addEventListener("blur", () => { if (ta._before && ta._before !== snap()) checkpoint(ta._before); });
    }
    const ta = $("textarea", body);
    if (ta.value !== (n.data.text ?? "")) ta.value = n.data.text ?? "";
    ta.readOnly = !canvasCanEdit();
  } else if (n.type === "script") {
    renderScript(n, body);
    meta = (n.data.shots || []).length ? `${n.data.shots.length} 镜` : "";
  } else if (n.type === "audio") {
    if(v){
      const player=$("audio",body);
      if(!player||player.getAttribute("src")!==(v.url||"")){
        if(player&&!player.paused)player.pause();
        body.innerHTML=audioPreviewMarkup(v);
        bindAudioPreview(body,v);
      }
    }else body.innerHTML=`<div class="ph">${ico("audio")}<div class="t">输入文案生成配音或音乐<br>也可拖入音频文件</div></div>`;
    meta = v?.seconds ? `${v.seconds.toFixed(1)}s` : "";
  } else if (n.data.playlist && !v) {
    const clips = n.data.film?.clips || [];
    meta = clips.length ? `${clips.length} 段 · ${filmTotal(n.data.film).toFixed(1)}s` : "空播放列表";
    body.innerHTML = `<div class="ph">${ico("stack")}<button class="pill" type="button" data-open-playlist>打开播放列表</button></div>`;
    $("[data-open-playlist]",body).onclick = event => { event.stopPropagation(); openFilm(n); };
  } else if (v) {
    body.innerHTML = n.type === "image" ? `<img class="m" src="${v.url}" draggable="false">` : `<video class="m" src="${v.url}" controls playsinline preload="metadata"></video>`;
    meta = `${v.w}×${v.h}` + (v.seconds ? ` · ${v.seconds.toFixed(1)}s` : "") + (n.versions.length > 1 ? ` · ${n.cur + 1}/${n.versions.length}` : "");
    const badge=v.draft_final?.resolution ? `${String(v.draft_final.resolution).toUpperCase()} 定稿` : v.draft_expires ? "480p 样片" : v.mode;
    if (n.type === "video" && badge) body.insertAdjacentHTML("beforeend", `<span class="badge">${esc(badge)}</span>`);
  } else {
    const hint = n.data.previs ? "双击编辑白模场景<br>设置机位与走位，渲染预演视频" :
      n.type === "image" ? (imgInputs(n).length ? `以图改图 · ${imgInputs(n).length} 张参考图<br>选中后写下修改要求，用 @图1 指代原图` : "选中后在下方输入提示词生成<br>或把图片拖到这里") : (() => { const p = plan(n); return p.imgs.length ? `${p.name} · ${p.imgs.length} 张图<br>点连线上的标签可设为人物设定 / 首帧 / 尾帧` : "选中后输入提示词生成<br>或把视频拖到这里"; })();
    body.innerHTML = `<div class="ph">${ico(n.type)}<div class="t">${hint}</div></div>`;
  }
  if(!v&&canvasCanEdit()&&canvasMediaUploadTarget(n)&&!n.job){
    const placeholder=$(".ph",body);
    placeholder.insertAdjacentHTML("beforeend",`<div class="node-start-actions">
      <button type="button" class="pill" data-node-start="agent">交给助手</button>
      <button type="button" class="pill" data-node-start="prompt">填写提示词</button>
    </div>`);
  }
  const promptAction = $("[data-node-prompt]",body);
  if (v && canvasCanEdit() && canvasMediaUploadTarget(n)) {
    if (!promptAction) body.insertAdjacentHTML("beforeend",'<button type="button" class="pill node-prompt-action" data-node-prompt>提示词</button>');
  } else {
    promptAction?.remove();
  }
  renderVTabs(n, el);
  $(".meta", el).textContent = meta;
  el.classList.toggle("sel", sel.has(n.id));
  renderJob(n);
  if(n.agent_error)showErr(n,n.agent_error);
  if (n.type==="video") $(".plus.r",el).title=v&&v.source!=="previs"?"拖动连线用作视频参考 · 点击续拍":"续拍：取最后一帧接着生成";
}
// put several videos in the generation queue, in name order (视频 2 before 视频 10); each one is sent like a click on 生成
let queueing = false;
async function queueVideos(list) {
  if (queueing) return toast("正在排队，请稍等上一批提交完");
  list = list.filter(x => x && !x.job && !x.data.previs).sort((a, b) => a.name.localeCompare(b.name, "zh", { numeric: true }) || a.y - b.y || a.x - b.x);
  if (!list.length) return toast("没有需要排队的视频（正在生成的会跳过）");
  const board=boardId, epoch=boardOpenEpoch;
  queueing = true;
  let ok = 0;
  try {
    for (const [i, v] of list.entries()) {
      if (boardId!==board || boardOpenEpoch!==epoch) break;
      if (node(v.id)!==v) continue;
      toast(`正在提交 ${i + 1}/${list.length}：${v.name}`, 60000);
      await generate(v);
      if (v.job) ok++;
    }
  } finally { queueing = false; }
  const bad = list.length - ok;
  if (boardId!==board || boardOpenEpoch!==epoch) return;
  toast(`已提交 ${ok} 段视频${bad ? `，${bad} 段未提交成功，可查看节点提示` : ""}`, 6000);
}
// Media versions stay in one node; video versions also retain their input graph and settings.
function rememberVideoVersion(n) {
  const v = curV(n); if (n.type !== "video" || !v) return;
  if (!Array.isArray(v.input_edges)) v.input_edges = JSON.parse(JSON.stringify(B.edges.filter(e => e.to === n.id)));
  if (!v.node_data) v.node_data = JSON.parse(JSON.stringify(n.data));
}
function validVideoInput(edge) {
  const type = node(edge.from)?.type;
  return type === "image" || type === "text" || (type === "audio" && edge.relation === "audio_ref") ||
    (type === "video" && ["remake", "previs", "video_ref", "trim", "draft_final"].includes(edge.relation));
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
    else if(v.video_recipe?.video_optics)n.data.video_optics=structuredClone(v.video_recipe.video_optics);
    else delete n.data.video_optics;
  }
  if (n.type === "audio") {
    if (v.audio_recipe) Object.assign(n.data,{...defaults("audio"),...v.audio_recipe});
    else if (isSeedAudio(n)) n.data.references=[];
  }
  n.cur = i; save(); render(n); refreshDownstream(n); if (sel.size === 1 && sel.has(n.id)) showPanel(); drawEdges();
  if (AC.open) acRenderRefs();
  return true;
}
function renderVTabs(n, el) {
  let t = $(".vtabs", el);
  if (!["image", "video", "audio"].includes(n.type) || n.versions.length < 2) { t?.remove(); return; }
  if (!t) {
    t = document.createElement("div"); t.className = "vtabs"; el.appendChild(t);
    t.setAttribute("role", "tablist"); t.setAttribute("aria-label", "历史版本"); t.setAttribute("aria-orientation", "vertical");
    t.addEventListener("pointerdown", e => e.stopPropagation());
    t.addEventListener("dblclick", e => e.stopPropagation());
  }
  const previousTab=$(".on",t)?.dataset.i, scrollTop=t.scrollTop;
  const focusedTab=t.contains(document.activeElement)?document.activeElement.dataset.i:null;
  t.innerHTML = n.versions.map((v, i) => {
    const tip = [`版本 ${i + 1}`, v.label || v.mode, v.seconds ? v.seconds.toFixed(1) + "s" : "", v.seed != null ? "seed " + v.seed : ""].filter(Boolean).join(" · ");
    const thumbnail=n.type==="image"&&v.url
      ? `<img src="${esc(v.url)}" alt="" loading="lazy" draggable="false">`
      : ico(n.type);
    return `<button role="tab" aria-selected="${i === n.cur}" aria-label="版本 ${i + 1}" data-i="${i}" tabindex="${i===n.cur?0:-1}" class="${i === n.cur ? "on" : ""}" title="${esc(tip)}" ${n.job ? "disabled" : ""}>
      <span class="vt-thumb" aria-hidden="true">${thumbnail}</span><span class="vt-number">${i + 1}</span></button>`;
  }).join("");
  $$("button",t).forEach(button=>vtWireTab(button,n));
  const active=$(".on",t);
  t.scrollTop=scrollTop;
  if(active && previousTab!==active.dataset.i){
    const top=active.offsetTop,bottom=top+active.offsetHeight;
    if(top<t.scrollTop)t.scrollTop=top;
    else if(bottom>t.scrollTop+t.clientHeight)t.scrollTop=bottom-t.clientHeight;
  }
  if(focusedTab!=null){
    const focus=previousTab===active?.dataset.i?$('[data-i="'+focusedTab+'"]',t):active;
    focus?.focus({preventScroll:true});
  }
}
function refresh(n) { if (!n) return; render(n); if (sel.size === 1 && sel.has(n.id)) showPanel(); drawEdges(); }

function canEditNodePrompt(n) {
  return !!n && canvasCanEdit() && canvasMediaUploadTarget(n) && !n.job && !prepping.has(n.id);
}

function focusNodePrompt(n) {
  if (!canEditNodePrompt(n) || node(n.id)!==n) return;
  selectOnly(n.id);
  const field = usesFields(n) ? $('#pfields textarea[data-k="action"]') : $("#prompt");
  field?.focus();
}

function hasGenerationDraft(n,v) {
  return canEditNodePrompt(n) && !!v?.ref && !v.image_grid &&
    (n.type==="audio" ? typeof v.audio_recipe?.prompt==="string" :
      !!(v.node_data && Array.isArray(v.input_edges) && (v.generation_record || v.video_recipe)) ||
      n.type==="video" && hasVideoRecipeInputs(v.video_recipe) ||
      n.type==="image" && typeof v.generation_record?.prompt==="string" && Array.isArray(v.generation_record.inputs));
}

function generationDraft(n,v) {
  if (!hasGenerationDraft(n,v) || node(n.id)!==n || !n.versions.includes(v)) throw new Error("此版本的生成草稿不可用");
  if (n.type==="video" && (!v.node_data || !Array.isArray(v.input_edges))) v=vtSnapshot(n,n.versions.indexOf(v));
  const receipt = v.generation_record;
  const saved = n.type==="audio" ? v.audio_recipe : v.node_data;
  const data = {...defaults(n.type),...structuredClone(saved || {})};
  // Library identity belongs to the node, even when its generation settings change.
  for (const key of ["asset","caption"]) if (Object.hasOwn(n.data,key)) data[key] = structuredClone(n.data[key]);
  delete data.character_draft;
  const inputs = Array.isArray(receipt?.inputs) ? receipt.inputs : [];
  const legacyImage = n.type==="image" && (!v.node_data || !Array.isArray(v.input_edges));
  let links = n.type==="audio" ? [] : v.input_edges;
  if (legacyImage) {
    const {model,provider,provider_model,quality,seed,count,ar} = receipt.settings || {};
    data.prompt=receipt.prompt;
    for (const [key,value] of Object.entries({model,provider,quality,seed,count})) if (value != null) data[key]=value;
    if (provider && provider_model && provider!=="local_h3") data.selected_model=provider_model;
    if (Number.isFinite(ar)) data.aspect=Object.keys(AR).find(key=>Math.abs(AR[key]-ar)<.001) || "auto";
    links=inputs.filter(input=>input.role!=="text" && input.node_id).map(input=>({from:input.node_id,to:n.id,ref:input.ref}));
  }
  const recordedRefs = new Map((v.video_recipe?.images || []).concat(inputs)
    .filter(input=>input.node_id && input.ref).map(input=>[input.node_id,input.ref]));
  const savedText = new Map(inputs.filter(input=>input.role==="text").map(input=>[input.node_id,input.text]));
  const edges = links.map(edge => {
    const source = node(edge.from);
    if (!source || vtReferenceAncestors(source).has(n.id)) throw new Error("历史引用已移除或会形成循环连线");
    if (source.type==="text") {
      if (savedText.has(source.id) && (source.data.text || "").slice(0,5000)!==savedText.get(source.id))
        throw new Error("历史文本引用已修改，无法恢复原草稿");
      return {...edge,to:n.id};
    }
    const ref = edge.ref || edge.source_ref || recordedRefs.get(source.id);
    if (!ref || !source.versions.some(item=>item.ref===ref)) throw new Error("历史素材版本已移除");
    return {...edge,to:n.id,...(edge.source_ref ? {} : {ref})};
  });
  for (const item of (n.type==="audio" && Array.isArray(data.references) ? data.references : [])) {
    const source = node(item.node_id);
    if (!source?.versions.some(version=>version.ref===item.ref) || vtReferenceAncestors(source).has(n.id))
      throw new Error("历史音频参考版本已移除或会形成循环连线");
  }
  return {data,edges};
}

function canReuseGenerationAssets(n,v) {
  return ["image","video"].includes(n.type) && hasGenerationDraft(n,v) && !!v.memory_used?.length;
}

function loadGenerationDraft(n,v,report=toast,{reuseAssets=false}={}) {
  let draft;
  try { draft=generationDraft(n,v); }
  catch (error) { report(error.message);return false; }
  checkpoint();
  rememberVideoVersion(n);
  n.data=draft.data;
  if (reuseAssets) n.data.replay_memory_ref=v.ref;
  else delete n.data.replay_memory_ref;
  n.cur=n.versions.indexOf(v);
  B.edges=B.edges.filter(edge=>edge.to!==n.id).concat(draft.edges);
  if (n.type==="audio") syncSeedAudioEdges();
  $("#prompt")._node=null;
  $("#pfields")._node=null;
  render(n);
  refreshDownstream(n);
  drawEdges();
  save();
  return true;
}

function wire(n, el) {
  // drag the node (card or label); click selects
  const startDrag = e => {
    if (e.button !== 0 || spaceDown || e.target.closest(".plus, [contenteditable=true], [data-open-playlist], [data-node-start], [data-node-prompt], .node-document a, .node-document button")) return;
    const vid = e.target.closest("video");
    if (!canvasCanEdit()) { selectOnly(n.id); return; }
    // typing in a text node, or the video's control bar: select only, leave the element alone
    if (e.target.closest("textarea,audio") || (vid && e.clientY > vid.getBoundingClientRect().bottom - 52 * B.view.k)) {
      if (!sel.has(n.id) || sel.size > 1) { sel = new Set([n.id]); updateSel(); }
      return;
    }
    e.stopPropagation();
    if (vid) e.preventDefault();
    if (!sel.has(n.id)) { if (!e.shiftKey) sel.clear(); sel.add(n.id); updateSel(); }
    else if (e.shiftKey) { sel.delete(n.id); updateSel(); return; }
    if (nodeLocked(n)) return;
    const moving = [...sel].map(node).filter(m => m && !nodeLocked(m)), w0 = toW(e.clientX, e.clientY);
    const board = B;
    const validMove = () => B === board && canvasCanEdit() && moving.every(m=>els.has(m.id) && !nodeLocked(m));
    const starts = moving.map(m => [m.x, m.y]); let moved = false, before = snap(), last = e;
    const place = canvasDragPlacement(moving);
    const ap = autoPan(() => mv(last));
    const mv = ev => {
      if (!validMove()) { ap.stop(); clearCanvasGuides(); return; }
      last = ev;
      if (!moved && Math.abs(ev.clientX - e.clientX) + Math.abs(ev.clientY - e.clientY) < 4) return;
      if (!moved) { moved = true;liveStopFollow(false);moving.forEach(m => els.get(m.id)?.classList.add("dragging")); }
      ap.move(ev);
      const w = toW(ev.clientX, ev.clientY), groupTarget = ctGroupDropTarget(ev);
      const delta = place(w.x - w0.x,w.y - w0.y,ev.altKey || !!groupTarget);
      moving.forEach((m, i) => { m.x = Math.round(starts[i][0] + delta.x); m.y = Math.round(starts[i][1] + delta.y); const me = els.get(m.id); me.style.left = m.x + "px"; me.style.top = m.y + "px"; });
      drawEdges(); placeOverlays();
      ctMarkGroupDrop(groupTarget);
      const tabTarget = groupTarget ? null : vtDropTarget(moving);
      if (tabTarget) clearCanvasGuides();
      vtMarkDrop(tabTarget);
    };
    const up = ev => {
      if (moved && ev.type === "pointerup" && ev.altKey !== last.altKey) mv(ev);
      ap.stop(); removeEventListener("pointermove", mv); removeEventListener("pointerup", up);removeEventListener("pointercancel",up);
      removeEventListener("blur",up);
      clearCanvasGuides();
      moving.forEach(m => els.get(m.id)?.classList.remove("dragging"));
      const valid = validMove();
      const dropped=moved&&ev?.type==="pointerup"&&valid, groupTarget=dropped?ctGroupDropTarget(ev):null;
      ctMarkGroupDrop(null);vtMarkDrop(null);
      if (moved && valid && (groupTarget || !dropped)) {
        moving.forEach((m,i)=>{ [m.x,m.y]=starts[i]; render(m); });
        if (groupTarget) ctJoinFoldedGroup(groupTarget,moving,before);
        else { drawEdges(); placeOverlays(); drawMini(); }
        el._dragged=true;setTimeout(()=>el._dragged=false,0);return;
      }
      const mergeTarget=dropped?vtDropTarget(moving):null;
      if (mergeTarget?.data.playlist && appendFilmPlaylist(mergeTarget,moving,starts,before)) {
        el._dragged=true;setTimeout(()=>el._dragged=false,0);return;
      }
      if(mergeTarget&&vtMerge([...moving.map(m=>m.id),mergeTarget.id],mergeTarget.id,before)){
        for(const id of sel){const me=els.get(id);if(me){me._dragged=true;setTimeout(()=>me._dragged=false,0);}}return;
      }
      if (moved && valid) {
        el._dragged = true; setTimeout(() => el._dragged = false, 0);
        if (moving.some((m,i) => m.x !== starts[i][0] || m.y !== starts[i][1])) {
          undoStack.push(before); redoStack.length = 0; save();
        }
      }
    };
    addEventListener("pointermove", mv); addEventListener("pointerup", up);addEventListener("pointercancel",up);
    addEventListener("blur",up);
  };
  // a drag that started on a video must not also toggle play/pause
  el.addEventListener("click", ev => { if (el._dragged) { ev.preventDefault(); ev.stopPropagation(); } }, true);
  $(".card", el).addEventListener("pointerdown", startDrag);
  $(".lbl", el).addEventListener("pointerdown", startDrag);
  $(".card", el).addEventListener("dblclick", e => {
    if (n.type === "text" && e.target.closest(".node-document") && !e.target.closest("a,button")) {
      e.stopPropagation(); openTextDocument(n); return;
    }
    if (n.data.playlist && !e.target.closest("video")) { e.stopPropagation(); openFilm(n); return; }
    if (n.data.previs && !e.target.closest("video")) { e.stopPropagation(); openPrevis(n); return; }
    const v = curV(n);
    if (!v || !["image","video","audio"].includes(n.type) || e.target.closest("audio")) return;
    e.stopPropagation(); lightbox(v,n);
  });
  // rename
  const nm = $(".nm", el);
  nm.addEventListener("dblclick", e => { if (!canvasCanEdit()) return; e.stopPropagation(); nm.contentEditable = "true"; nm.focus(); document.getSelection().selectAllChildren(nm); });
  nm.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); nm.blur(); } });
  nm.addEventListener("blur", () => { if (nm.contentEditable !== "true") return; nm.contentEditable = "false"; const t = nm.textContent.trim(); if (t && t !== n.name) { checkpoint(); n.name = t; save(); refreshDownstream(n); } else nm.textContent = n.name; });
  // + handles
  const pr = $(".plus.r", el), pl = $(".plus.l", el);
  pr.addEventListener("pointerdown", e => {
    e.stopPropagation(); e.preventDefault();
    if (n.type === "video" && (!curV(n) || curV(n).source === "previs")) return;
    dragLink(n, e, () => { // click without drag: pick a downstream node type
      if (n.type==="video") {openVideoExtension(n);return;}
      openAddMenu(pr.getBoundingClientRect().right + 8, pr.getBoundingClientRect().top - 10, { from: n });
    });
  });
  pr.addEventListener("click", e => { if (n.type === "video" && (!curV(n) || curV(n).source === "previs")) { e.stopPropagation(); openVideoExtension(n); } });
  pl.addEventListener("pointerdown", e => { e.stopPropagation(); e.preventDefault(); const r = pl.getBoundingClientRect(); openAddMenu(r.left - 200, r.top - 10, { to: n }); });
  if (canvasMediaUploadTarget(n)) {
    el.addEventListener("click",e=>{
      if (e.target.closest("[data-node-prompt]")) {
        e.stopPropagation();
        focusNodePrompt(n);
        return;
      }
      const button=e.target.closest("[data-node-start]");
      if(!button)return;
      e.stopPropagation();
      if(node(n.id)!==n||!canvasCanEdit()||curV(n)||n.job||prepping.has(n.id))return;
      if(button.dataset.nodeStart==="agent"){
        void acNewNodeSession([{id:n.id}],{draft:n.data.prompt||"",emptyMediaNode:n.id}).catch(error=>toast(error.message));
      }else{
        focusNodePrompt(n);
      }
    });
    el.addEventListener("dragover", e => {
      const types=Array.from(e.dataTransfer?.types||[]);
      if(!canvasCanUploadInto(n)||!types.some(type=>type==="Files"||type==="application/x-h3-asset"))return;
      e.preventDefault();e.stopPropagation();el.classList.add("ok-target");
    });
    el.addEventListener("dragleave", e => {if(!el.contains(e.relatedTarget))el.classList.remove("ok-target");});
    el.addEventListener("drop", e => {
      el.classList.remove("ok-target");
      if (!canvasCanEdit()) return;
      const a=e.dataTransfer.getData("application/x-h3-asset"), files=e.dataTransfer.files;
      const asset=a?JSON.parse(a):null;
      const file=files.length===1&&canvasUploadKind(files[0])===n.type?files[0]:null;
      if(asset?.type!==n.type&&!file)return;
      e.preventDefault();e.stopPropagation();
      if(!canvasCanUploadInto(n)){toast("当前节点暂时无法接收文件");return;}
      if(file)void uploadInto(n,file);
      else addVersion(n,asset);
    });
  }
}
function refreshDownstream(n) { B.edges.filter(e => e.from === n.id).forEach(e => refresh(node(e.to))); }

function dragLink(a, e, onClick) {
  e.currentTarget.setPointerCapture(e.pointerId);
  const tmp = document.createElementNS("http://www.w3.org/2000/svg", "path"); tmp.setAttribute("class", "tmp"); svg.appendChild(tmp);
  const p0 = port(a, "out"), sx = e.clientX, sy = e.clientY; let moved = false;
  const targets = B.nodes.filter(m => m.id !== a.id && !ctFolded(m.id));
  let last = e; const ap = autoPan(() => mv(last));
  const mv = ev => {
    last = ev;
    if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 4) return;
    if (!moved) { moved = true; targets.forEach(m => els.get(m.id).classList.add(canLink(a, m) ? "ok-target" : "bad-target")); }
    ap.move(ev);
    tmp.setAttribute("d", curve(p0, toW(ev.clientX, ev.clientY)));
  };
  const stop = () => {
    ap.stop(); removeEventListener("pointermove", mv); removeEventListener("pointerup", up); tmp.remove();
    removeEventListener("pointercancel", stop);
    targets.forEach(m => els.get(m.id)?.classList.remove("ok-target", "bad-target"));
  };
  const up = ev => {
    stop();
    if (!moved) { onClick && onClick(); return; }
    const t = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".node");
    if (t) link(a, node(t.dataset.id));
    else { const w = toW(ev.clientX, ev.clientY); openAddMenu(ev.clientX, ev.clientY, { from: a, at: w }); }
  };
  addEventListener("pointermove", mv); addEventListener("pointerup", up); addEventListener("pointercancel", stop);
}

// ================================================================= edges
function port(n, side) {
  const group = ctFolded(n.id), folded = group && CT_FOLD_BOXES.get(group.id);
  const {x,y,w,h} = folded || {x:n.x,y:n.y,...size(n)};
  return {x:side === "out" ? x+w : x,y:y+h/2};
}
function curve(a, b) { const dx = Math.max(50, Math.abs(b.x - a.x) * 0.45); return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`; }

function edgeDescription(edge,source,target,relation) {
  const ref=edge.source_ref||edge.ref;
  const version=ref?source.versions.findIndex(item=>item.ref===ref):-1;
  const binding=ref?(version<0?" · 引用版本已移除":" · 固定版本 "+(version+1)):"";
  return source.name+binding+" → "+target.name+" · "+relation;
}

function edgeInspector(edge,description,a,b) {
  const panel=document.createElement("div");
  panel.className="elabel edge-inspector";
  panel.style.left=(a.x+b.x)/2+"px";
  panel.style.top=(a.y+b.y)/2+28+"px";
  panel.innerHTML=`<span>${esc(description)}</span>`;
  world.appendChild(panel);
  if(!canvasCanEdit())return panel;
  panel.insertAdjacentHTML("beforeend",`<button type="button" data-edge-cut title="点击或向下拖动以断开连线" aria-label="断开所选连线">${ico("scissors")}</button>`);
  const scissors=$("[data-edge-cut]",panel);
  let drag, moved=false;
  panel.onpointerdown=event=>event.stopPropagation();
  scissors.onpointerdown=event=>{
    if(event.button!==0)return;
    drag={id:event.pointerId,x:event.clientX,y:event.clientY};
    moved=false;
    if(Number.isInteger(event.pointerId))scissors.setPointerCapture?.(event.pointerId);
  };
  scissors.onpointermove=event=>{
    if(!drag||event.pointerId!==drag.id)return;
    moved||=Math.hypot(event.clientX-drag.x,event.clientY-drag.y)>6;
    if(moved)scissors.style.transform=`translateY(${Math.max(0,Math.min(38,event.clientY-drag.y))}px)`;
  };
  scissors.onpointerup=scissors.onpointercancel=event=>{
    if(!drag||event.pointerId!==drag.id)return;
    const distance=event.clientY-drag.y, sideways=event.clientX-drag.x;
    moved||=Math.hypot(sideways,distance)>6||event.type==="pointercancel";
    drag=null;
    scissors.style.transform="";
    if(event.type==="pointerup"&&distance>=24&&distance>=Math.abs(sideways))cutEdge(edge);
  };
  scissors.onclick=event=>{
    if(!moved||event.detail===0)cutEdge(edge);
    moved=false;
  };
  return panel;
}

function drawEdges() {
  syncSeedAudioEdges();
  ctRenderGroups();
  drawMini();
  $$("g", svg).forEach(g => g.remove());
  $$(".elabel", world).forEach(x => x.remove());
  const plans = {};
  const foldedEdges = new Map();
  B.edges.forEach(e => {
    const a = node(e.from), b = node(e.to); if (!a || !b) return;
    const fromGroup = ctFolded(a.id), toGroup = ctFolded(b.id);
    if (fromGroup || toGroup) {
      if (fromGroup === toGroup) return;
      const key = JSON.stringify([fromGroup?.id || a.id,toGroup?.id || b.id,!!fromGroup,!!toGroup]);
      if (!foldedEdges.has(key)) foldedEdges.set(key,{a:port(a,"out"),b:port(b,"in"),count:0});
      foldedEdges.get(key).count++;
      return;
    }
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    const pa=port(a,"out"),pb=port(b,"in");
    if (e.relation==="seed_audio_ref") { pa.y+=(e.slot-2)*26; pb.y+=(e.slot-2)*26; }
    const d = curve(pa,pb);
    g.innerHTML = `<path class="hit" d="${d}"></path><path class="vis" d="${d}"></path>`;
    if (selEdge === e) g.classList.add("sel");
    let relation="输入素材";
    if (e.story_continuity || ["remake","previs","audio_ref","video_ref","trim","capture","transcript","audio_cut","broll","seed_audio_ref","draft_final"].includes(e.relation)) {
      g.classList.add("remake-edge");
      const label = document.createElement("div");
      label.className = "elabel remake-label";
      label.style.left = (pa.x + pb.x) / 2 + "px"; label.style.top = (pa.y + pb.y) / 2 + "px";
      const seedLabel = e.relation==="seed_audio_ref" ? (a.type==="image"?"参考图":`@音频${e.slot}`) +
        ` · 版本 ${a.versions.findIndex(v=>v.ref===e.ref)+1}` : "";
      label.textContent = e.story_continuity?"上一镜尾帧":seedLabel || (e.segment_edit ? "修改片段" : e.extension ? extensionLabel(e.extension) : {previs:"白模动作参考",audio_ref:"音频参考",video_ref:"视频参考",remake:"原片",trim:"裁剪自原片",capture:"视频截帧",transcript:"音频转写",audio_cut:"台词剪辑",broll:"B-roll 来源",draft_final:"定稿样片"}[e.relation]);
      relation=label.textContent;
      world.appendChild(label);
    } else if (a.type === "image" && b.type === "video") {
      const p = plans[b.id] || (plans[b.id] = plan(b)), k = p.es.indexOf(e);
      const pa = port(a, "out"), pb = port(b, "in"), lb = document.createElement("div");
      lb.className = "elabel" + (p.roles[k] === "subject" ? " subj" : "");
      lb.style.left = (pa.x + pb.x) / 2 + "px"; lb.style.top = (pa.y + pb.y) / 2 + "px";
      lb.innerHTML = esc(p.labels[k] || "未使用") + (hasMediaReferences(b) ? "" : ` ▾${roleSelect(e)}`);
      relation=p.labels[k]||"未使用";
      world.appendChild(lb); wireRoleSelects(lb);
    }
    const description=edgeDescription(e,a,b,relation), hit=$(".hit",g);
    const title=document.createElementNS("http://www.w3.org/2000/svg","title");
    title.textContent=description;
    hit.appendChild(title);
    hit.setAttribute("role","button");
    hit.setAttribute("aria-label",description);
    hit.setAttribute("tabindex","0");
    if(selEdge===e)edgeInspector(e,description,pa,pb);
    const select=ev=>{
      ev.stopPropagation();selEdge=e;sel.clear();updateSel();drawEdges();
    };
    hit.addEventListener("pointerdown",select);
    hit.addEventListener("keydown",ev=>{
      if(!["Enter"," "].includes(ev.key))return;
      ev.preventDefault();select(ev);
      ($("[data-edge-cut]",world)||$("#edges .sel .hit"))?.focus({preventScroll:true});
    });
    hit.addEventListener("dblclick",ev=>{ev.stopPropagation();cutEdge(e);});
    svg.appendChild(g);
  });
  for (const {a,b,count} of foldedEdges.values()) {
    const g=document.createElementNS("http://www.w3.org/2000/svg","g");
    g.classList.add("folded-edge");
    g.innerHTML=`<path class="vis" d="${curve(a,b)}"></path>`;
    svg.appendChild(g);
    if (count>1) {
      const label=document.createElement("div");
      label.className="elabel folded-edge-count";
      Object.assign(label.style,{left:(a.x+b.x)/2+"px",top:(a.y+b.y)/2+"px"});
      label.textContent=`${count} 条连线`;
      world.appendChild(label);
    }
  }
  refreshScriptContinuity();
}
function cutEdge(e) {
  if (!canvasCanEdit() || !B.edges.includes(e)) return;
  const target=node(e.to);
  if (e.relation==="seed_audio_ref") {
    if (target) removeSeedAudioReference(target,seedAudioRefs(target).findIndex(ref=>ref.node_id===e.from&&ref.ref===e.ref));
    return;
  }
  if(e.story_continuity&&target&&(nodeLocked(target)||target.job||prepping.has(target.id)||scriptContinuityPending.has(target))){
    return toast("请等分镜图任务结束，或解锁节点后再移除尾帧");
  }
  checkpoint();
  if(e.story_continuity&&target)removeScriptTailPrompt(target,e);
  B.edges=B.edges.filter(x=>x!==e);
  if(selEdge===e)selEdge=null;
  refresh(target);
  if(!target)drawEdges();
  save();
  return true;
}

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
  if(Number.isInteger(event.pointerId))ppResize.setPointerCapture?.(event.pointerId);
  $("#pp").classList.add("resizing");
};
ppResize.onpointermove=event=>{
  const drag=ppResizeDrag;
  if(!drag||event.pointerId!==drag.id)return;
  const dx=event.clientX-drag.x,dy=event.clientY-drag.y;
  if(!drag.moved&&Math.hypot(dx,dy)<3)return;
  drag.moved=true;
  setPPSize({width:Math.min(innerWidth-16,drag.rect.width+dx),height:Math.min(innerHeight-16,drag.rect.height+dy)});
};
ppResize.onpointerup=ppResize.onpointercancel=ppResize.onlostpointercapture=event=>{
  const drag=ppResizeDrag;
  if(!drag||event.pointerId!==drag.id)return;
  if(event.type==="pointerup")ppResize.onpointermove(event);
  ppResizeDrag=null;
  $("#pp").classList.remove("resizing");
  if(event.type==="pointercancel")setPPSize(drag.previous);
  else if(drag.moved)setPPSize(ppSize,true);
};
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
  if (n.type === "text") b.push(tool("text-document", "script", canvasCanEdit() ? "编辑文档" : "查看文档"));
  if (n.type === "text" && n.data.transcript?.cues?.length && canvasCanEdit()) b.push(tool("saved-transcript", "scissors", "按台词剪辑音频"));
  if (n.data.previs) b.push(tool("previs", "video", "编辑白模"));
  if (pvGuideAvailable(v)) b.push(tool("previsvideo", "next", "用作动作参考"));
  if (n.type === "audio") b.push(tool("audio-upload","upload","上传音频版本"));
  if (n.type === "audio" && v?.ref && canvasCanEdit()) b.push(tool("transcript","text","音频转写"));
  if (["video","audio"].includes(n.type) && v?.ref && canvasCanEdit()) b.push(tool("separate-audio","audio","人声分离"));
  if (n.data.playlist) b.push(tool("playlist-open","stack","打开播放列表"));
  if (n.versions.length > 1) b.push(tool("prev", "left", "上一个版本") + `<span class="pg">${n.cur + 1}/${n.versions.length}</span>` + tool("next", "right", "下一个版本") + `<span class="sep"></span>`);
  if (v) {
    if (n.type === "image") b.push(tool("edit", "edit", "编辑图片", "编辑图片 · 局部重绘、扩图、裁剪与调色") + tool("tovideo", "video", "生成视频") + tool("hd", "hd", "高清重绘") + tool("describe", "text", "反推提示词"));
    if (n.type==="image" && v.image_grid && canvasCanEdit()) b.push(tool("split3x3","assets","拆成九张机位图"));
    if (n.type==="image" && panoramaVersion(v)) b.push(tool("panorama","panorama","360° 全景预览"));
    if (n.type === "video" && n.data.film && !n.data.playlist) b.push(tool("film", "scissors", "编辑成片"));
    else if (n.type === "video" && !n.data.film) b.push(tool("cont", "next", "续拍") + tool("film", "scissors", "剪辑视频", "剪辑视频 · 导出为原节点的新版本") + tool("analyze", "script", "拉片", "拉片 · 拆分镜头并分析"));
    if (n.type === "video" && canvasCanEdit()) b.push(tool("capture", "image", "视频截帧", "截取首帧、当前帧或末帧") + tool("trim-video", "scissors", "裁剪视频", "裁剪视频 · 保留区间、手动分割或智能切镜头"));
    if (n.type==="video" && v.draft_expires && canvasCanEdit()) b.push(tool("draft-final","hd","生成定稿"));
    if (n.type === "video" && n.versions.filter(v=>v.url).length > 1) b.push(tool("compare-video", "stack", "对比视频版本"));
    if (canvasCanEdit() && v.ref && ["image","video"].includes(n.type)) b.push(tool("broll","motion","B-roll 动态画面"));
    b.push(tool("full", "full", "全屏查看"));
    b.push(tool("dl", "dl", "下载"));
    if (v.ref && ["image","video","audio"].includes(n.type)) b.push(tool("favorite", "star", "收藏此版本"));
  }
  b.push(tool("agent", "script", "交给创作助手") + tool("dup", "copy", "创建副本") +
    (nodeLocked(n) ? tool("unlock-node", "lock", "解锁节点") : tool("del", "trash", "删除节点")) +
    (canvasCanEdit() ? tool("pin", "tag", "颜色标记") : "") + tool("more", "more", "更多操作"));
  tools.innerHTML = b.join("");
  $$("button", tools).forEach(x => {
    x.onmouseenter = x.onfocus = () => showNodeToolTip(x);
    x.onmouseleave = x.onblur = hideNodeToolTip;
    if (x.dataset.a === "favorite") nodeMediaFavorite(x,n,v);
    else x.onclick = ev => {
      hideNodeToolTip();
      if (x.dataset.a === "pin") return openNodePinMenu(x);
      if (x.dataset.a !== "more") return nodeAction(n, x.dataset.a);
      ev.stopPropagation();
      const rect = x.getBoundingClientRect();
      ctxMenu({ target: els.get(n.id), clientX: rect.left, clientY: rect.bottom + 6 });
    };
  });
  if (n.type === "audio") { renderAudioPanel(n); placeOverlays(); return; }
  if (n.type === "text" || n.data.previs) { placeOverlays(); return; }
  // ---- refs
  const refs = $("#refs"), items = [];
  const guide = n.type === "video" ? previsInput(n) : null;
  const sounds = n.type === "video" ? audioInputs(n) : [];
  const clips = n.type === "video" ? videoInputs(n) : [];
  const extension = clips[0]?.edge.extension;
  const segment = clips[0]?.edge.segment_edit;
  const reference = guide || sounds.length || clips.length;
  if (n.type === "script") imgInputs(n).forEach(m => { const mv = curV(m); items.push(`<span class="ref" title="${esc(m.name)}">${mv ? `<img src="${mv.url}">` : `<span class="tx">${ico("image")}</span>`}${esc(m.name)}<span class="role">${KIND_CN[m.data.asset?.kind] || "参考"}</span></span>`); });
  if (n.type === "image") {
    imageInputs(n).forEach((input,i)=>items.push(imagePromptChip(input,i,`<span class="role">${i===0?"原图":"参考"}</span>`)));
    const composition=previsComposition(n);
    if(composition){
      const label=composition.enabled?"使用中":"已关闭";
      const picture=composition.version ? `<img src="/media?ref=${encodeURIComponent(composition.ref)}" alt="">` : "";
      const button=canvasCanEdit()&&!nodeLocked(n) ? `<button type="button" data-previs-composition aria-label="使用白模构图参考" aria-pressed="${composition.enabled}">${composition.enabled?"关闭":"启用"}</button>` : "";
      items.push(`<span class="ref">${picture}白模构图<span class="role">${composition.version?label:composition.enabled?"版本已移除":label}</span>${button}</span>`);
    }
  }
  if (n.type === "video") {
    const p = plan(n);
    if (!n.data.replay_memory_ref) inheritedVideoAssets(n).forEach(asset=>{
      const name = asset.name || "资产";
      items.push(`<span class="ref"><span class="tx">${ico("assets")}</span>${esc(name)}<span class="role">沿用资产</span>
        ${canvasCanEdit() ? `<button type="button" data-memory-ignore="${esc(asset.id)}" aria-label="取消沿用 ${esc(name)}" title="取消沿用此资产">×</button>` : ""}</span>`);
    });
    if (guide) {
      const latest = curV(guide.source);
      const update = pvGuideAvailable(latest) && latest.ref !== guide.edge.ref;
      const span=guide.version?.previs_span;
      items.push(`<span class="ref" data-tok="@视频${extension||segment?2:1}" title="${esc(guide.source?.name || "白模预演")}"><span class="tx">${ico("video")}</span>白模动作参考<span class="role">${guide.version ? `版本 ${guide.index + 1}${Array.isArray(span)?" · "+pvSpanLabel(span):""}` : "版本已移除"}</span>${update ? '<button type="button" data-previs-update>改用当前版本</button>' : ""}</span>`);
    }
    clips.forEach(({edge,source,version,index},i)=>{
      const number=promptVideoIndex(i,guide,extension||segment);
      const {start,end:finish}=videoReferenceRange(edge,version,referenceDuration(n));
      const settings=version ? `<label>入 <input class="tsec" type="number" min="0" step=".01" value="${start ?? ""}" data-clip-index="${i}" data-clip-point="start" aria-label="视频 ${number} 入点（秒）" ${edge.extension==="before"?"disabled":""}></label>
        <label>出 <input class="tsec" type="number" min="0" step=".01" value="${finish ?? ""}" data-clip-index="${i}" data-clip-point="end" aria-label="视频 ${number} 出点（秒）" ${edge.extension==="after"?"disabled":""}></label>` : "";
      const change=curV(source) && curV(source)!==version;
      const role=version ? `${edge.segment_edit?"待修改片段 · ":edge.extension?extensionLabel(edge.extension)+" · ":""}视频 ${number} · 版本 ${index+1}` : "版本已移除";
      items.push(`<span class="ref" data-tok="${promptMediaToken("video",edge.prompt_slot,number)}" title="${esc(source?.name || "视频参考")}"><span class="tx">${ico("video")}</span>${esc(source?.name || "视频参考")}<span class="role">${role}</span>${settings}${change ? `<button type="button" data-video-update="${i}">改用当前版本</button>` : ""}</span>`);
    });
    const end = (vidFrames(n.data.duration) - 4) / 24;
    sounds.forEach(({edge,source,version,index},i)=>{
      const change = curV(source) && curV(source) !== version;
      items.push(`<span class="ref" data-tok="${promptMediaToken("audio",edge.prompt_slot,i+1)}" title="${esc(source?.name || "音频参考")}"><span class="tx">${ico("audio")}</span>${esc(source?.name || "音频参考")}<span class="role">${version ? `音频 ${i+1} · 版本 ${index+1}` : "版本已移除"}</span>${change ? `<button type="button" data-audio-update="${i}">改用当前版本</button>` : ""}</span>`);
    });
    p.inputs.forEach((input, i) => { const r = p.roles[i];
      // keyframes get a seconds box: where in the video this picture should be reached
      const tbox = p.useRef && r !== "subject" && r !== "first" && r !== "last" && p.times[i] != null
        ? `<input class="tsec" type="number" min="0" max="${end.toFixed(1)}" step="0.1" value="${(+p.times[i]).toFixed(1)}" data-time="${B.edges.indexOf(p.es[i])}" title="第几秒到达这张图">s` : "";
      const label = reference ? '<span class="role">参考图</span>' : `<span class="role rsel">${p.labels[i]} ▾${roleSelect(p.es[i])}</span>`;
      items.push(imagePromptChip(input,i,label+tbox)); });
  }
  inputs(n, "text").forEach(t => items.push(`<span class="ref" title="${esc(t.data.text.slice(0, 200))}"><span class="tx">${ico("text")}</span>${esc(t.name)}<span class="role">已并入</span></span>`));
  if (n.data.replay_memory_ref) items.push(`<span class="ref"><span class="tx">${ico("assets")}</span>沿用原资产
    <button type="button" data-replay-assets-clear aria-label="取消沿用原资产" title="取消沿用原资产" ${n.job||nodeLocked(n)||!canvasCanEdit()?"disabled":""}>×</button></span>`);
  refs.innerHTML = items.join(""); refs.style.display = items.length ? "" : "none";
  const replayClear=$("[data-replay-assets-clear]",refs);
  if (replayClear) replayClear.onclick=()=>{
    if (!canvasCanEdit() || nodeLocked(n) || n.job || prepping.has(n.id)) return;
    checkpoint(); delete n.data.replay_memory_ref; save(); showPanel();
  };
  const compositionButton=$("[data-previs-composition]",refs);
  if(compositionButton)compositionButton.onclick=()=>{
    if(!canvasCanEdit()||nodeLocked(n)||n.job||prepping.has(n.id))return;
    const composition=previsComposition(n);
    if(!composition)return;
    checkpoint();
    n.data.previs_composition.enabled=!composition.enabled;
    save();showPanel();
  };
  $$("[data-memory-ignore]",refs).forEach(button=>button.onclick=()=>{
    if(!canvasCanEdit()||n.job||prepping.has(n.id))return;
    checkpoint(); rememberVideoVersion(n);
    const ignored = Array.isArray(n.data.ignored_memory_ids) ? n.data.ignored_memory_ids : [];
    n.data.ignored_memory_ids = [...ignored,button.dataset.memoryIgnore];
    save(); showPanel();
  });
  $$(".ref[data-tok]", refs).forEach(r => r.onclick = e => { if (!e.target.closest("button, select, input, label")) insertTok(r.dataset.tok); });
  $$("[data-image-update]",refs).forEach(button=>button.onclick=()=>{
    if(!canvasCanEdit()||n.job||prepping.has(n.id))return;
    const input=imageInputs(n)[Number(button.dataset.imageUpdate)], latest=curV(input?.source);
    if(latest?.ref && latest.ref!==input.edge.ref){
      checkpoint();rememberVideoVersion(n);input.edge.ref=latest.ref;refresh(n);save();
    }
  });
  const guideUpdate = $("[data-previs-update]", refs);
  if (guideUpdate) guideUpdate.onclick = () => updatePrevisInput(n);
  $$("[data-audio-update]",refs).forEach(button=>button.onclick=()=>{
    if (!canvasCanEdit() || n.job || prepping.has(n.id)) return;
    const input=audioInputs(n)[Number(button.dataset.audioUpdate)], picked=curV(input?.source);
    if (!picked || picked.ref===input.edge.ref) return;
    checkpoint(); rememberVideoVersion(n); input.edge.ref=picked.ref; save(); refresh(n);
  });
  $$("[data-video-update]",refs).forEach(button=>button.onclick=()=>{
    if (!canvasCanEdit() || n.job || prepping.has(n.id)) return;
    const input=videoInputs(n)[Number(button.dataset.videoUpdate)], picked=curV(input?.source);
    if (!picked || picked.ref===input.edge.ref) return;
    if (input.edge.segment_edit && picked.seconds>0 && picked.seconds<4) return toast("当前版本短于 4 秒，无法作为片段编辑来源");
    checkpoint(); rememberVideoVersion(n); input.edge.ref=picked.ref;
    if (!input.edge.segment_edit) {delete input.edge.start; delete input.edge.end;}
    else if (picked.seconds>0) {
      input.edge.start=Math.min(input.edge.start??0,Math.max(0,picked.seconds-4));
      input.edge.end=Math.min(picked.seconds,Math.max(input.edge.start+4,input.edge.end??input.edge.start+4));
    }
    save(); refresh(n);
  });
  $$("[data-clip-point]",refs).forEach(input=>input.onchange=()=>{
    if (!canvasCanEdit() || n.job || prepping.has(n.id)) {showPanel();return;}
    const clip=videoInputs(n)[Number(input.dataset.clipIndex)], value=input.valueAsNumber;
    if (!clip) return;
    if (input.value!=="" && (!Number.isFinite(value) || value<0 || value>(clip.version?.seconds || Infinity))) {
      toast("参考入点与出点须在视频时长内"); showPanel(); return;
    }
    checkpoint(); rememberVideoVersion(n);
    if (input.value==="") delete clip.edge[input.dataset.clipPoint];
    else clip.edge[input.dataset.clipPoint]=value;
    save(); showPanel();
  });
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
  ta.removeAttribute("maxlength");
  ta.placeholder = n.type === "script" ? "写剧情，例如：深夜书房，裴照在灯下写字，突然有人敲门。河神抱着一碗汤进来，衣摆滴水，把碗放在桌上。裴照低头察看，碗里映出河神的脸……\n\n可以连入角色 / 场景图片，Qwen 会按图里的样子安排人物" : n.type === "image" ? (imgInputs(n).length ? "写修改要求，例如：把 @图1 里的橘猫换成穿校服的样子，背景改成樱花校园，保持猫的长相不变" : "描述你想生成的画面，例如：秋日校园里，一只背着书包的橘猫站在红砖教学楼前，电影感，暖色逆光") :
    (imgInputs(n).length ? "描述视频中的动作、镜头和声音；点上方的图可以用 @图1 引用它" : "描述视频内容、动作、镜头运动和声音，例如：雪地森林里一只红狐狸小跑后回头看向镜头，镜头缓慢推近；风声和踩雪声");
  if (segment) ta.placeholder = n.data.camera_plan ? "选填补充要求。机位和景别可在「重拍设置」修改。" :
    n.data.object_edit ? "选填补充要求。目标选区可在「物体编辑设置」修改。" : "描述这段视频要改的内容，例如把窗外改成雨天，保留人物和镜头节奏。";
  else if (extension) ta.placeholder = extension==="before"?"描述原视频开头之前发生的事。":"描述原视频结尾之后发生的事。";
  else if (guide) ta.placeholder = "描述正式画面的人物、环境和风格。已连接的白模负责参考运镜和走位。";
  else if (clips.length) ta.placeholder = "描述新画面。用 @视频1 指定要复用的动作、运镜或构图。";
  else if (sounds.length) ta.placeholder = "描述画面和声音，点击上方音频可引用它的节奏、语调或环境声。";
  if (n.type === "image" || n.type === "video") ta.placeholder = "输入 @ 搜索并引用素材。\n" + ta.placeholder;
  if (ta._node !== n.id) { ta.value = n.data.prompt; ta._node = n.id; }
  const fm = n.type === "video" && n.data.pmode === "fields";
  $("#pmode").innerHTML = n.type === "video" ? `<button data-m="free" class="${fm ? "" : "on"}" title="一段话自由描述">自由描述</button><button data-m="fields" class="${fm ? "on" : ""}" title="按场景 / 人物 / 动作 / 对话分开填写，系统合成官方格式">分栏填写</button>` : "";
  $$("#pmode button").forEach(b => b.onclick = () => setPMode(n, b.dataset.m));
  ta.style.display = fm ? "none" : ""; $("#pp").classList.toggle("wide", fm);
  renderFields(n, fm);
  if (!fm) autoGrow(ta);
  // ---- controls
  const d = n.data, ctl = $("#ctl");
  const pill = (k, opts, label, extra = "", current=d[k]) => `<span class="pill ${extra}">${label}<select data-k="${k}"${k==="selected_model"?' aria-label="生成模型"':""}>${Object.entries(opts).map(([a, t]) => `<option value="${esc(a)}" ${String(a) === String(current) ? "selected" : ""}>${t}</option>`).join("")}</select></span>`;
  const arIcon = a => { const r = AR[a] || 1.6; const w = r >= 1 ? 13 : Math.round(13 * r), h = r >= 1 ? Math.round(13 / r) : 13; return `<span class="ar" style="width:${w}px;height:${h}px"></span>`; };
  let h;
  if (n.type === "script") h = scriptCtl(n);
  else if (n.type === "image") {
    const rem = isRemote(n), hi = rem || d.model !== "h3video", ins = imgInputs(n).length || previsComposition(n)?.enabled, fa = d.aspect === "auto";
    h = provPill(n, pill) + nodeModelPill(n,pill);
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
    if (reference) {
      const services = referenceServices(n), selected = referenceService(n);
      const opts = {"":"选择参考服务", ...Object.fromEntries(services.map(s => [s.id, esc(s.name)]))};
      h = services.length ? pill("provider", opts, `${esc(selected?.name || "选择参考服务")}${ico("down")}`, "model")
        : `<span class="pill" title="在控制台配置视频生成服务">待配置${guide || clips.length ? "视频参考" : "音频参考"}服务</span>`;
      if (selected) h += nodeModelPill(n,pill,selected,true);
    } else {
      h = provPill(n, pill) + nodeModelPill(n,pill);
      if (!rem) h += pill("turbo", { true: "MiniMax H3 · 极速", false: "MiniMax H3 · 高质量" }, `<span class="dot"></span>${d.turbo ? "H3 极速" : "H3 高质量"}${ico("down")}`, "model");
    }
    const fa = d.aspect === "auto";
    const followSource=extension && /(?:seedance-2-5|^ep-)/.test(canvasNodeModel(n,referenceService(n),true)?.id || "");
    h += followSource || segment ? '<span class="pill">跟随原视频画幅</span>' :
      pill("aspect", { auto: extension ? "跟随原视频" : guide ? "跟随白模" : "跟随首图", "16:9": "16:9", "9:16": "9:16", "1:1": "1:1", "4:3": "4:3", "3:4": "3:4" }, `${arIcon(fa ? "16:9" : d.aspect)}${fa ? "自动" : d.aspect}`);
    const canDraft=videoDraftAvailable(n);
    if (canDraft) h += pill("draft",{false:"正式生成",true:"480p 样片"},d.draft?"480p 样片":"正式生成");
    if (!(canDraft && d.draft)) {
      const qualities=videoOutputModel(n)?.qualities;
      if (qualities) {
        const options=Object.fromEntries(Object.entries(qualities).map(([key,label])=>[key,label==="4k"?"4K":esc(label)]));
        const quality=canvasVideoQuality(n), label=options[quality];
        h += Object.keys(qualities).length===1 ? `<span class="pill">${label}</span>` : pill("quality",options,label,"",quality);
      } else if (canDraft) h += pill("quality",{hd:"1080p",std:"720p"},d.quality==="hd"?"1080p":"720p");
      else h += pill("quality", reference ? {hd:"高清",std:"720P"} : {hd:"高清 768P",std:"标准 480P"},
        reference ? (d.quality==="hd"?"高清":"720P") : (d.quality==="hd"?"768P":"480P"));
    }
    const durationChoices=canvasVideoDurationChoices(n);
    const durations=Object.fromEntries(durationChoices.map(seconds=>
      [seconds,`${seconds} 秒${!reference && seconds===durationChoices.at(-1)?"（最长）":""}`]));
    const max=durationChoices.at(-1), seconds=canvasVideoDuration(n);
    const range=segment ? videoReferenceRange(clips[0].edge,clips[0].version,referenceDuration(n)) : null;
    h += segment ? `<span class="pill">${range.end>range.start?`${(range.end-range.start).toFixed(2)} 秒`:"跟随修改区间"}</span>`
      : pill("duration",durations,`${ico("clock")}${Math.min(max,Math.max(durationChoices[0],seconds))}s`,"",seconds);
    if (!reference && imgInputs(n).length) h += pill("mode", { auto: "按每张图的设置", keyframes: "全部当关键帧", reference: "全部当人物设定" }, plan(n).name);
    if (reference) h += '<span class="pill">全模态参考</span>';
    if(!d.film&&!d.previs)h += `<button type="button" class="pill" id="videoOpticsBtn"${n.job||nodeLocked(n)?" disabled":""}>镜头参数${Number.isFinite(d.video_optics?.lens)?` · ${d.video_optics.lens} mm`:d.video_optics?" · 已设置":""}</button>`;
    if (segment && d.camera_plan) h += `<button type="button" class="pill" id="retakeSettings" title="重拍设置">重拍设置 · ${esc(cameraModeLabel[d.camera_plan.mode] || "机位")}</button>`;
    if (segment && d.object_edit) h += '<button type="button" class="pill" id="objectSettings">物体编辑设置</button>';
    if (!d.film) h += pill("count", { 1: "出 1 个", 2: "抽 2 个版本，挑最好的", 3: "抽 3 个版本，挑最好的" }, `${ico("stack")}${d.count > 1 ? "抽 " + d.count : "1 个"}`);
  }
  if (n.type !== "script") h += `<button class="pill" id="moreBtn" title="更多设置">${ico("more")}</button>`;
  if (n.type === "video" && d.pmode === "fields") h += `<button class="pill" id="fillBtn" title="Qwen 看连入的首帧 / 人物图，填写风格、场景、人物、镜头（只填空着的栏）">看图填写</button>`;
  if (n.type === "video") {
    h += '<button class="pill" id="pvBtn" title="核对生成用的提示词和参考素材">预览</button>';
    if (!reference) h += `<button class="pill" id="rwBtn" title="用本地 Qwen3.5 把描述改写成 H3 官方英文结构化提示词（可看到连入的图片）">✨ 改写</button>`;
    if (d.prompt_src) h += `<button class="pill" id="rsBtn" title="还原改写前的原文">还原原文</button>`;
  }
  h += `<span class="grow"></span>${reference ? "" : `<span class="est">${estimate(n)}</span>`}`;
  if (!n.job && n.type !== "script" && !d.film) h += '<span class="est" data-generation-cost title="仅估算生成服务费用，实际费用以服务账单为准">正在估算费用…</span>';
  const sendLabel = n.job ? "取消" : curV(n) && n.type!=="script" ? "重新生成" : "生成";
  h += `<button id="send" class="${n.job ? "stop" : ""}" aria-label="${sendLabel}" title="${sendLabel}${n.job?"":" (⌘↩)"}">${ico(n.job ? "stop" : "send")}</button>`;
  ctl.innerHTML = h;
  renderCanvasCost(n,$("[data-generation-cost]",ctl));
  $$("select", ctl).forEach(s => s.onchange = () => {
    checkpoint();
    const key = s.dataset.k;
    let val = s.value; if (["turbo","expand","draft"].includes(key)) val = val === "true"; else if (["count", "duration"].includes(key)) val = Number(val);
    if (key === "provider") delete d.selected_model;
    if (key === "selected_model" && val && !d.provider) d.provider = nodeProvider(n)?.id;
    d[key] = val; save(); render(n); refreshDownstream(n); showPanel();
  });
  $("#send").onclick = () => n.job ? cancel(n) : generate(n);
  if ($("#moreBtn")) $("#moreBtn").onclick = e => { e.stopPropagation(); $("#more").classList.toggle("on"); };
  if ($("#slashBtn")) $("#slashBtn").onclick = e => { e.stopPropagation(); openSlash(n, false); };
  if ($("#fillBtn")) $("#fillBtn").onclick = () => fillFieldsFromImages(n);
  if (n.type === "script") { wireScriptCtl(n, ctl); $("#more").classList.remove("on"); placeOverlays(); return; }
  if ($("#rwBtn")) $("#rwBtn").onclick = () => rewritePrompt(n);
  if ($("#pvBtn")) $("#pvBtn").onclick = () => previewPrompt(n);
  if ($("#videoOpticsBtn")) $("#videoOpticsBtn").onclick = () => openVideoOptics(n);
  if ($("#retakeSettings")) $("#retakeSettings").onclick = () => openRetakeSettings(n);
  if ($("#objectSettings")) $("#objectSettings").onclick = () => openObjectSettings(n);
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
function imagePromptChip({edge,source,version,index},i,role) {
  const slot=promptSlot(edge.prompt_slot), token=promptMediaToken("image",slot,i+1);
  const pinned=edge.ref?`<span class="role">${version?`版本 ${index+1}`:"版本已移除"}</span>`:"";
  const latest=curV(source);
  const update=edge.ref&&latest?.ref&&latest.ref!==edge.ref?`<button type="button" data-image-update="${i}">改用当前版本</button>`:"";
  return `<span class="ref" data-tok="${token}" title="点击在提示词中引用 · ${esc(source.name)}">${version?.url?`<img src="${esc(version.url)}">`:`<span class="tx">${ico("image")}</span>`}${slot?esc(source.name):"图"+(i+1)}${role}${pinned}${update}</span>`;
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
  box.innerHTML = FIELDS.map(x => `<label class="f"><span>${x.t}${x.sub ? `<small>${x.sub}</small>` : ""}</span><textarea rows="1" data-k="${x.k}" placeholder="${esc(x.k === "action" ? "输入 @ 引用素材。"+x.ph : x.ph)}"></textarea></label>`).join("");
  $$("textarea", box).forEach(t => {
    t.value = f[t.dataset.k] || ""; fieldGrow(t);
    t.addEventListener("input", () => { f[t.dataset.k] = t.value; fieldGrow(t); save(); placeOverlays(); });
    t.addEventListener("focus", () => { lastField = t; t._before = snap(); });
    t.addEventListener("blur", () => { if (t._before && t._before !== snap()) checkpoint(t._before); });
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
let previewSequence = 0;
function renderPreviewInputs(items, duration) {
  const list = $("#pvInputs");
  list.replaceChildren();
  const labels = {
    subject:"人物设定", image_ref:"参考图", first_frame:"首帧", last_frame:"尾帧",
    previs:"白模参考", video_ref:"视频参考", audio_ref:"音频参考", unused_image:"当前服务未采用"
  };
  for (const item of items) {
    const {role, ref, time, start, end} = item;
    if (!ref) continue;
    const label = labels[role] || (time > 0.01 ? time >= (vidFrames(duration)-4)/24-.05 ? "尾帧" : "关键帧" : "首帧");
    const details = [];
    const version = item.version ?? (node(item.node_id)?.versions.findIndex(v => v.ref === ref) ?? -1)+1;
    if (version > 0) details.push("版本 "+version);
    if (label === "关键帧") details.push(Number(time.toFixed(2))+" 秒");
    if (Number.isFinite(start) && Number.isFinite(end)) details.push(start+"–"+end+" 秒");
    const row = document.createElement("li");
    if (role === "audio_ref" || role === "video_ref" || role === "previs") {
      row.insertAdjacentHTML("afterbegin",ico(role === "audio_ref" ? "audio" : "video"));
    } else {
      const picture = document.createElement("img");
      picture.src = "/media?ref="+encodeURIComponent(ref);
      picture.loading = "lazy";
      picture.alt = "";
      row.append(picture);
    }
    const description = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = item.name || "素材";
    const meta = document.createElement("small");
    meta.textContent = [label,...details].join(" · ");
    description.append(name, meta);
    row.append(description);
    list.append(row);
  }
  list.hidden = !list.childElementCount;
}
async function previewPrompt(n) {
  const req = videoReq(n, fullPrompt(n)); if (!req) return;
  req.board = boardId;
  applyVideoMemory(n, req);
  const services = req.previs_guide || req.audio_refs || req.video_refs ? referenceServices(n) : CAPS_LIST.video;
  if (services?.some(service => service.id === n.data.provider)) req.provider = n.data.provider;
  if (n.data.selected_model) Object.assign(req,{provider:n.data.provider,selected_model:n.data.selected_model});
  const board = B, sequence = ++previewSequence;
  const current = () => sequence === previewSequence && B === board && node(n.id) === n && sel.has(n.id);
  try {
    const r = await api("/api/preview", req);
    if (!current()) return;
    if (r.reference_preview) videoReferencePreviews.set(n,{key:r.reference_preview,signature:videoPreviewSignature(req)});
    else videoReferencePreviews.delete(n);
    renderPreviewInputs(r.inputs || [], req.duration);
    $("#pvt").textContent = r.prompt;
    $("#pvm").textContent = r.mode || "";
    $("#pv").classList.add("on");
    $("#pvClose").focus();
  } catch (e) { if (current()) toast("预览失败：" + e.message, 3500); }
}
function closePromptPreview() {
  previewSequence++;
  $("#pv").classList.remove("on");
  $("#pvBtn")?.focus();
}
$("#pvClose").onclick = closePromptPreview;
$("#pv").addEventListener("click", e => { if (e.target.id === "pv") closePromptPreview(); });
$("#pv").addEventListener("keydown", e => {
  if (e.key === "Escape") { e.stopPropagation(); closePromptPreview(); }
});
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
$("#prompt").addEventListener("blur", e => { if (e.target._before && e.target._before !== snap()) checkpoint(e.target._before); });
document.addEventListener("pointerdown", e => { if (!e.target.closest("#more, #moreBtn")) $("#more").classList.remove("on"); });

function nodeAction(n, a) {
  if (a === "text-document") return openTextDocument(n);
  if (a === "panorama") return openPanorama(n);
  if (!canvasCanEdit() && !["prev","next","full","compare-video","dl","gif-export","playlist-open"].includes(a)) return;
  const v = curV(n);
  if (a === "prev" || a === "next") { switchVersion(n, (n.cur + (a === "next" ? 1 : -1) + n.versions.length) % n.versions.length); }
  else if (a === "dl") { const x = document.createElement("a"); x.href = v.url; x.download = v.ref.split("/").pop(); x.click(); }
  else if (a === "full") lightbox(v,n);
  else if (a === "compare-video") openVideoCompare(n);
  else if (a === "broll") openBroll(n);
  else if (a === "unlock-node") markCanvasNodes([n.id],false,{lock:true});
  else if (a === "del") removeNodes([n.id]);
  else if (a === "dup") duplicate([n.id]);
  else if (a === "tovideo") { checkpoint(); const s = size(n); const at = freeSpot(n.x + s.w + 110, n.y, "video"); const m = addNode("video", at.x, at.y); link(n, m, true); selectOnly(m.id); }
  else if (a === "cont") openVideoExtension(n);
  else if (a === "extension-film") openExtensionTimeline(n);
  else if (a === "segment-edit") openSegmentEditor(n);
  else if (a === "camera-retake") openSegmentEditor(n,{retake:true});
  else if (a === "object-remove" || a === "object-replace") openSegmentEditor(n,{objectAction:a.slice(7)});
  else if (a === "object-settings") openObjectSettings(n);
  else if (a === "draft-final") openVideoDraftFinal(n);
  else if (a === "retake-settings") openRetakeSettings(n);
  else if (a === "segment-film") openSegmentTimeline(n);
  else if (a === "segment-review") openSegmentReview(n);
  else if (a === "segment-review-parent") openSegmentReview(n,true);
  else if (a === "trim-video") openVideoTrim(n);
  else if (a === "gif-export") openGifExport(n,v);
  else if (a === "capture") openFrameCapture(n);
  else if (["frame","firstframe","currentframe"].includes(a)) {
    const video = els.get(n.id)?.querySelector("video");
    const position = a==="firstframe"?"first":a==="frame"?"last":"time";
    if (position==="time" && !(video?.readyState>=1)) return openFrameCapture(n);
    captureOnCanvas(n.id,v,{position,at:position==="time"?video.currentTime:undefined})
      .catch(error=>toast("截帧失败："+error.message));
  }
  else if (a === "hd") hdRedraw(n);
  else if (a === "edit") openImageEditor(n);
  else if (a === "relight") return openImageEditor(n).then(()=>{if(IMAGE_EDITOR?.n===n)ieMode("relight");});
  else if (a === "image-camera") return openImageEditor(n).then(()=>{if(IMAGE_EDITOR?.n===n)ieMode("camera");});
  else if (a === "image-upscale") return openImageEditor(n).then(()=>{if(IMAGE_EDITOR?.n===n)ieMode("upscale");});
  else if (a === "image-decompose") return openImageEditor(n).then(()=>{if(IMAGE_EDITOR?.n===n)ieMode("layers");});
  else if (a === "image-pixels") return openImageEditor(n).then(()=>{
    const E=IMAGE_EDITOR;if(E?.n!==n || !E.image)return;
    ieMode("local");if(E.mode==="local"){ $("#iePixelSize").open=true;updatePixelPreview(E);$("#iePixelWidth").focus(); }
  });
  else if (a === "agent") acUseNode(n).catch(e => toast(e.message));
  else if (a === "describe") describeImage(n);
  else if (a === "analyze") analyzeVideo(n);
  else if (a === "remake") openVideoRemake(n);
  else if (a === "previs") openPrevis(n);
  else if (a === "previsvideo") usePrevisForVideo(n);
  else if (a === "audio-upload") pickAudio(file=>uploadInto(n,file));
  else if (a === "transcript") openAudioTranscript(n);
  else if (a === "separate-audio") openAudioSeparation(n);
  else if (a === "saved-transcript") openSavedTranscript(n);
  else if (a === "playlist-open") openFilm(n);
  else if (a === "film") {
    if (n.type === "video" && (!n.data.film || v?.film_recipe?.timeline)) editVideoTimeline(n);
    else if (n.data.film) openFilm(n);
    else openFilm([n]);
  }
  else if (a.startsWith("split")) { const [r, c] = a.slice(5).split("x").map(Number); splitGrid(n, r, c); }
  else if (a.startsWith("asset:")) saveAsset(n, a.slice(6));
}
function selectOnly(id) { sel = new Set([id]); updateSel(); }
let lightState = null;

function pausePreviewMedia(container) {
  $$("video,audio", container).forEach(player => { if (!player.paused) player.pause(); });
}

function lightDockAssistant(show) {
  const dialog = $("#light"), pane = $("#agentChat"), notice = $("#toast");
  if (show) {
    acVoiceCancel();
    acPickPlacement(false);
    cmClose();
    dialog.append(pane,notice);
    dialog.classList.add("light-chat");
  } else if (pane?.parentElement === dialog) {
    cmClose();
    document.body.append(pane,notice);
    dialog.classList.remove("light-chat");
    if (dialog.open) $("[data-light-agent]",dialog)?.focus();
  }
}

function closeLightbox() {
  const dialog = $("#light");
  if (!lightState) return;
  const overlay = $(".light-view",dialog);
  overlay._disposeRegion?.();
  const {focus} = lightState;
  lightState = null;
  pausePreviewMedia(overlay);
  if (dialog.close) dialog.close(); else dialog.removeAttribute("open");
  lightDockAssistant(false);
  dialog.classList.remove("on");
  overlay.remove();
  if (focus?.isConnected) focus.focus({preventScroll:true});
}

function lightbox(version, source, {at,end,box}={}) {
  if (!version?.url) return;
  closeLightbox();
  const gallery = source ? byPosition(B.nodes.filter(n =>
    ["image","video","audio"].includes(n.type) && (n === source || !ctFolded(n.id)) &&
    curV(n)?.url).map(n => n.id)).map(n => n.id) : [];
  lightState = {gallery, nodeId:source?.id, focus:document.activeElement};
  const dialog = $("#light"), overlay = document.createElement("div");
  overlay.className = "light-view";
  dialog.append(overlay);
  renderLightbox(version, source, false, box);
  dialog.classList.add("on");
  if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open", "");
  const player=$("video,audio",overlay);
  if (player && Number.isFinite(at)) {
    player.autoplay=false;
    if(!player.paused)player.pause();
    const seek=()=>{player.currentTime=Number.isFinite(player.duration) ? Math.min(at,player.duration) : at;};
    if (player.readyState>=1)seek();else player.addEventListener("loadedmetadata",seek,{once:true});
    if(Number.isFinite(end) && end>at)lightReviewPlayback(overlay,player,at,end);
  }
  $("[data-light-close]", overlay).focus();
}

function lightReviewPlayback(overlay, player, at, end) {
  const status=$(".light-status",overlay), button=document.createElement("button");
  button.type="button";
  button.dataset.lightPlayReview="";
  button.textContent=`播放批注片段 · ${at.toFixed(2)}–${end.toFixed(2)} 秒`;
  let stop=end, playing=false;
  function ready() {
    stop=Number.isFinite(player.duration) ? Math.min(end,player.duration) : end;
    button.disabled=stop<=at;
    if(button.disabled)status.textContent="批注片段超出当前素材时长";
  }
  button.disabled=player.readyState<1;
  if(!button.disabled)ready();else player.addEventListener("loadedmetadata",ready,{once:true});
  button.onclick=async()=>{
    player.currentTime=at;
    playing=true;
    try{await player.play();}
    catch{playing=false;if(button.isConnected)status.textContent="无法播放批注片段";}
  };
  player.addEventListener("seeking",()=>{if(player.currentTime<at)playing=false;});
  player.addEventListener("pause",()=>{playing=false;});
  player.addEventListener("timeupdate",()=>{
    if(!playing || player.currentTime<stop)return;
    playing=false;
    player.pause();
    player.currentTime=stop;
  });
  status.before(button);
}

function lightNeighbor(offset) {
  const {gallery,nodeId} = lightState;
  const index = gallery.indexOf(nodeId);
  if (index < 0) return null;
  for (let i = index + offset; i >= 0 && i < gallery.length; i += offset) {
    const candidate = node(gallery[i]);
    if (curV(candidate)?.url && !ctFolded(candidate.id)) return candidate;
  }
  return null;
}

function lightNavigate(offset) {
  const target = lightNeighbor(offset);
  if (!target) return;
  lightState.nodeId = target.id;
  renderLightbox(curV(target), target);
}

function renderLightbox(version, source, comparing = false, reviewBox = null, overview = false) {
  const dialog = $("#light"), overlay = $(".light-view",dialog);
  overlay._disposeRegion?.();
  overlay._disposeRegion=null;
  const previousFocus = document.activeElement?.getAttributeNames().find(name => name.startsWith("data-light-"));
  const type = source?.type || cmMediaType(version.ref) || "image";
  const index = source?.versions.indexOf(version) ?? -1;
  const choices = (source?.versions || []).map((v,i) => ({v,i})).filter(({v}) => v.url);
  const active = curV(source);
  const previous = choices.findLast(({i,v}) => i < index && v.ref !== version.ref);
  const comparison = type === "image" && (active?.url && active.ref !== version.ref
    ? {v:active,i:source.cur} : previous || choices.find(({v})=>v.ref!==version.ref));
  const imageCompare = !!comparison;
  const videoCompareAvailable = type === "video" && choices.length > 1;
  const editable = index >= 0 && version.ref && canvasCanEdit() && !source.job && !prepping.has(source.id);
  const title = source?.name || version.ref?.split("/").pop() || "媒体";
  const prompt = [version.generation_record?.prompt,version.prompt,version.edit?.recipe?.prompt]
    .find(text => typeof text === "string" && text.trim());
  const effective = version.generation_record?.effective_prompt;
  const hasEffectivePrompt = typeof effective === "string" && effective.trim() && effective !== prompt;
  const transcripts = type === "audio" && source ? B.nodes.filter(n =>
    n.type === "text" && n.data.transcript?.source_node === source.id &&
    n.data.transcript.source_ref === version.ref && n.data.text?.trim()) : [];
  const webSource = version.web_source;
  const origin = publicResearchLink(webSource?.link);
  const license = publicResearchLink(webSource?.license_url);
  const usedAssets = Array.isArray(version.memory_used) ? version.memory_used.filter(asset => asset?.name) : [];
  const hasDetails = prompt || hasEffectivePrompt || transcripts.length || origin || usedAssets.length;
  const editLabel = type === "image" ? (index === source?.cur ? "编辑图片" : "切到此版本并编辑") :
    type === "video" ? "剪辑视频" : "转写音频";
  const media = (v, label) => type === "audio" ? audioPreviewMarkup(v,true) : type === "image" ? `<img src="${esc(v.url)}" alt="${esc(label)}">` :
    `<${type} src="${esc(v.url)}" aria-label="${esc(label)}" controls ${type === "video" ? "autoplay playsinline" : ""}></${type}>`;
  function tile({v,i}) {
    const thumb = type === "image" ? `<img src="${esc(v.url)}" alt="" loading="lazy">` :
      type === "video" ? `<video src="${esc(v.url)}#t=0.001" preload="metadata" loading="lazy" muted playsinline aria-hidden="true"></video>` : ico("audio");
    return `<button type="button" data-light-tile="${i}" ${i===index?'aria-current="true"':""}>
      <span class="light-tile-media">${thumb}</span>
      <strong>版本 ${i+1}${i===source.cur?" · 画布当前":""}</strong>
      ${v.label?`<small>${esc(v.label)}</small>`:""}
      ${v.seconds>0?`<small>${Number(v.seconds).toFixed(1)} 秒</small>`:""}</button>`;
  }
  pausePreviewMedia(overlay);
  overlay._peekPrevious=null;
  if (type !== "image") pausePreviewMedia($("#world"));
  overlay.innerHTML = `
    <header class="light-header">
      <div class="light-navigation">
        <button type="button" data-light-prev title="上一个素材" aria-label="上一个素材" ${lightNeighbor(-1) ? "" : "disabled"}>${ico("left")}</button>
        <button type="button" data-light-next title="下一个素材" aria-label="下一个素材" ${lightNeighbor(1) ? "" : "disabled"}>${ico("right")}</button>
      </div>
      <h2 id="lightTitle" title="${esc(title)}">${esc(title)}</h2>
      <button type="button" data-light-close title="关闭预览" aria-label="关闭预览">×</button>
    </header>
    <div class="light-body">
      ${overview ? `<section class="light-version-grid" aria-label="所有版本">${choices.map(tile).join("")}</section>` :
        `<div class="light-stage">
        ${comparing && comparison ? `<figure><figcaption>${comparison.i===source.cur?"画布当前版本":"版本 "+(comparison.i+1)}</figcaption>
          ${media(comparison.v,"版本 " + (comparison.i+1))}</figure>
          <figure><figcaption>预览版本 ${index + 1}</figcaption>${media(version,"预览版本 " + (index + 1))}</figure>` : media(version,title)}
        </div>`}
      ${!overview && hasDetails ? `<aside id="lightDetails" aria-label="版本信息" hidden>
        ${origin ? `<h3>公开素材来源</h3><a href="${esc(origin)}" target="_blank" rel="noopener noreferrer">${esc(webSource.title || "查看原始来源")}</a>
          ${webSource.credit ? `<p>作者 · ${esc(webSource.credit)}</p>` : ""}
          ${license ? `<a href="${esc(license)}" target="_blank" rel="noopener noreferrer">${esc(webSource.license || "查看许可")}</a>` : esc(webSource.license || "")}` : ""}
        ${prompt ? `<h3>提示词</h3><pre>${esc(prompt)}</pre>` : ""}
        ${hasEffectivePrompt ? `<details ${prompt ? "" : "open"}><summary>生成时使用的提示词</summary><pre>${esc(effective)}</pre></details>` : ""}
        ${prompt || hasEffectivePrompt ? '<button type="button" data-light-copy-prompt>复制提示词</button>' : ""}
        ${usedAssets.length ? `<h3>生成时使用的资产</h3><ul>${usedAssets.map(asset => {
          const refs = Array.isArray(asset.references) ? asset.references :
            asset.ref ? [{ref:asset.ref}] : [];
          const links = refs.filter(item=>item?.ref).map(({ref,view})=>
            `<a href="/media?ref=${encodeURIComponent(ref)}" target="_blank" rel="noopener">${esc(CHARACTER_VIEWS[view]?.[0] || "参考图")}</a>`);
          return `<li>${esc(asset.name)}${links.length ? " · "+links.join("、") : ""}</li>`;
        }).join("")}</ul>` : ""}
        ${transcripts.map(n => `<details open><summary>${esc(n.name)}</summary><pre>${esc(n.data.text)}</pre></details>`).join("")}
        <p class="light-details-status" role="status"></p>
      </aside>` : ""}
    </div>
    <footer class="light-actions">
      ${overview ? '<button type="button" data-light-overview aria-pressed="true">返回单个版本</button>' : `
      ${choices.length > 1 ? `<select data-light-version aria-label="预览版本">${choices.map(({v,i}) =>
        `<option value="${i}" ${i === index ? "selected" : ""}>版本 ${i + 1}${i === source.cur ? " · 当前" : ""}${v.label ? " · " + esc(v.label) : ""}</option>`).join("")}</select>` : ""}
      ${choices.length > 1 ? '<button type="button" data-light-overview aria-pressed="false">所有版本</button>' : ""}
      ${imageCompare || videoCompareAvailable ? `<button type="button" data-light-compare>${comparing ? "结束对比" : "对比版本"}</button>` : ""}
      ${type==="image" && previous && !comparing ? '<button type="button" data-light-peek title="按住反斜杠键或此按钮">按住看上一版</button>' : ""}
      ${hasDetails ? '<button type="button" data-light-details aria-controls="lightDetails" aria-expanded="false">版本信息</button>' : ""}
      ${index>=0 && hasGenerationDraft(source,version) ? '<button type="button" data-light-generation-draft>用此版本改稿</button>' : ""}
      ${index>=0 && canReuseGenerationAssets(source,version) ? '<button type="button" data-light-replay-assets>沿用原资产改稿</button>' : ""}
      ${index >= 0 && version.ref && canvasCanEdit() ? '<button type="button" data-light-agent aria-controls="agentChat" aria-keyshortcuts="Meta+J Control+J /">和助手讨论此版本</button>' : ""}
      ${index >= 0 && vtCanCopyVersion(source,index) ? '<button type="button" data-light-copy>放入画布</button>' : ""}
      ${index >= 0 && version.ref ? `<button type="button" data-light-comment>${type === "image" ? "批注此版本" : "批注当前时间"}</button>` : ""}
      ${index >= 0 && version.ref && type === "image" && !comparing ? '<button type="button" data-light-mark-region>框选批注</button><button type="button" data-light-save-region hidden>填写区域批注</button><button type="button" data-light-cancel-region hidden>取消框选</button>' : ""}
      ${index >= 0 && version.ref && ["video","audio"].includes(type) ? '<button type="button" data-light-range>标记片段</button><button type="button" data-light-cancel-range hidden>取消标记</button>' : ""}
      ${index >= 0 && version.ref && canvasCanEdit() && ["video","audio"].includes(type) ? '<button type="button" data-light-separate>人声分离</button>' : ""}
      ${editable ? `<button type="button" data-light-edit title="${esc(editLabel)}（E）">${editLabel}</button>` : ""}
      <a href="${esc(version.url)}" download="${esc(version.ref?.split("/").pop())}">下载</a>
      <span class="light-status" role="status"></span>
      <button type="button" data-light-locate hidden>在画布定位</button>`}
    </footer>`;
  const bind = (name, action) => {
    const control = $(`[data-light-${name}]`,overlay);
    if (control) control[control.tagName === "SELECT" ? "onchange" : "onclick"] = action;
  };
  if(type==="audio"&&!overview)bindAudioPreview(overlay,version);
  function currentSource(at) {
    const current = source && node(source.id);
    const expected = choices.find(entry => entry.i === at)?.v;
    if (expected?.ref && current?.versions[at]?.ref === expected.ref && current.versions[at].url) return current;
    const status = $(".light-status",overlay);
    if (status) status.textContent = "画布上的版本已变更，请重新打开预览";
    else toast("画布上的版本已变更，请重新打开预览");
    return null;
  }
  bind("close",closeLightbox);
  bind("prev",() => lightNavigate(-1));
  bind("next",() => lightNavigate(1));
  bind("overview",() => {
    const current = currentSource(index);
    if (!current) return;
    renderLightbox(current.versions[index],current,false,null,!overview);
    if (!overview) $('[data-light-tile][aria-current="true"]',overlay)?.focus();
  });
  $$("[data-light-tile]",overlay).forEach(button=>button.onclick=()=>{
    const at = Number(button.dataset.lightTile);
    const current = currentSource(at);
    if (!current) return;
    renderLightbox(current.versions[at],current);
    $("[data-light-overview]",overlay)?.focus();
  });
  const peekButton = $("[data-light-peek]",overlay);
  if (peekButton) {
    const stage = $(".light-stage",overlay), main = $("img",stage);
    overlay._peekPrevious = show => {
      if (show && main.classList.contains("light-region-drawing")) return;
      let peek = $(".light-peek",stage);
      if (show && !peek) {
        peek = document.createElement("img");
        peek.className = "light-peek";
        peek.src = previous.v.url;
        peek.alt = "上一版 · 版本 " + (previous.i + 1);
        stage.append(peek);
      }
      if (peek) peek.hidden = !show;
      main.classList.toggle("light-peek-replaced",show);
    };
    peekButton.onpointerdown = e => {
      if (e.button !== 0) return;
      peekButton.setPointerCapture?.(e.pointerId);
      overlay._peekPrevious(true);
    };
    peekButton.onpointerup = peekButton.onpointercancel = peekButton.onlostpointercapture =
      peekButton.onblur = () => overlay._peekPrevious(false);
    peekButton.onkeydown = e => {
      if ([" ","Enter"].includes(e.key)) { e.preventDefault(); overlay._peekPrevious(true); }
    };
    peekButton.onkeyup = () => overlay._peekPrevious(false);
  }
  bind("agent",async event => {
    const button = event.currentTarget;
    if (!canvasCanEdit() || !currentSource(index)) return;
    if (!dialog.classList.contains("light-chat")) lightDockAssistant(true);
    button.disabled = true;
    try {
      await acOpen({focus:false});
      if (!button.isConnected || !dialog.open || !dialog.classList.contains("light-chat")) return;
      const current = currentSource(index);
      if (!current || !canvasCanEdit()) return;
      const status = $(".light-status",overlay);
      if (acAttachNodeReference(current,version.ref,message => {status.textContent = message;})) {
        status.textContent = "已引用此版本";
        $("#acInput").focus();
      }
    } finally {
      button.disabled = false;
    }
  });
  bind("details",event => {
    const details = $("#lightDetails",overlay);
    details.hidden = !details.hidden;
    event.currentTarget.setAttribute("aria-expanded",String(!details.hidden));
  });
  bind("copy-prompt",async () => {
    const status = $(".light-details-status",overlay);
    try { await acCopyText(prompt || effective); status.textContent = "已复制提示词"; }
    catch { status.textContent = "复制失败，可选中文字后复制"; }
  });
  const reuseDraft = reuseAssets => {
    const current=currentSource(index);
    if (!current || !loadGenerationDraft(current,current.versions[index],message=>{
      $(".light-status",overlay).textContent=message;
    },{reuseAssets})) return;
    closeLightbox();
    focusNodePrompt(current);
  };
  bind("generation-draft",()=>reuseDraft(false));
  bind("replay-assets",()=>reuseDraft(true));
  bind("version",event => {
    const at = Number(event.target.value);
    const current = currentSource(at);
    if (current) renderLightbox(current.versions[at],current);
    else event.target.value = String(index);
  });
  bind("copy",() => {
    const current = currentSource(index);
    const copy = current && vtCopyVersion(current,index);
    if (!copy) return;
    $(".light-status",overlay).textContent = "已放入画布";
    const locate = $("[data-light-locate]",overlay);
    locate.hidden = false;
    locate.onclick = () => {
      const target = node(copy.id);
      if (!target) { $(".light-status",overlay).textContent = "已复制的节点已移除"; locate.hidden = true; return; }
      closeLightbox();
      selectOnly(target.id);
      fit([target]);
    };
  });
  bind("comment",() => {
    const current=currentSource(index);
    if(!current)return;
    const at=$("video,audio",overlay)?.currentTime;
    closeLightbox();
    ccNode(current,current.versions[index],at);
  });
  overlay._disposeRegion=lightRegionAnnotation(overlay,reviewBox,box=>{
    const current=currentSource(index);
    if(!current)return;
    closeLightbox();
    ccNode(current,current.versions[index],undefined,undefined,box);
  });
  let rangeStart=null;
  function showRange() {
    const started=rangeStart!==null;
    $("[data-light-range]",overlay).textContent=started?"在此结束并批注":"标记片段";
    $("[data-light-cancel-range]",overlay).hidden=!started;
    $(".light-status",overlay).textContent=started?`起点 ${rangeStart.toFixed(2)} 秒 · 移动播放头选择终点`:"";
  }
  bind("range",()=>{
    const current=currentSource(index);
    if(!current)return;
    const player=$("video,audio",overlay), at=Math.round(player.currentTime*1000)/1000;
    if(!Number.isFinite(at))return;
    if (rangeStart===null) {
      rangeStart=at;
      if(!player.paused)player.pause();
      showRange();
    } else if (at<=rangeStart) {
      $(".light-status",overlay).textContent=`终点必须晚于起点 ${rangeStart.toFixed(2)} 秒`;
    } else {
      closeLightbox();
      ccNode(current,current.versions[index],rangeStart,at);
    }
  });
  bind("cancel-range",()=>{rangeStart=null;showRange();});
  bind("separate",()=>{
    const current=currentSource(index);
    if(!current||!canvasCanEdit())return;
    closeLightbox();
    openAudioSeparation(current,current.versions[index]);
  });
  bind("compare",() => {
    const current = currentSource(index);
    if (!current) return;
    if (videoCompareAvailable) {
      closeLightbox();
      openVideoCompare(current,index);
    } else {
      renderLightbox(current.versions[index],current,!comparing && imageCompare);
    }
  });
  bind("edit",() => {
    const current = currentSource(index);
    if (!current || !canvasCanEdit()) return;
    if (current.job || prepping.has(current.id) || type === "image" && (IMAGE_EDITOR?.busy || IMAGE_EDITOR?.agentSelection)) {
      $(".light-status",overlay).textContent = "请等待当前任务完成后再编辑";
      return;
    }
    if (type === "image" && index !== current.cur && !switchVersion(current,index)) return;
    closeLightbox();
    if (type === "audio") openAudioTranscript(current,null,current.versions[index]);
    else if (type === "video" && index !== current.cur) editVideoTimeline(current,current.versions[index]);
    else nodeAction(current,type === "image" ? "edit" : "film");
  });
  if (dialog.open && !$("#agentChat")?.contains(document.activeElement)) {
    const control = previousFocus && $(`[${previousFocus}]`,overlay);
    (control && !control.disabled ? control : $("[data-light-close]",overlay)).focus();
  }
}
$("#light").addEventListener("cancel", e => { e.preventDefault(); closeLightbox(); });
$("#light").addEventListener("click", e => { if (e.target === e.currentTarget || e.target.matches(".light-stage")) closeLightbox(); });

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

// ---- right-click menu
function nodePinPalette(nodes) {
  return `<div class="node-pin-menu" role="group" aria-label="节点颜色标记">
    ${[...NODE_PINS].map(([key,label]) => `<button type="button" data-a="pin:${key}" title="${label}标记" aria-label="${label}标记" aria-pressed="${nodes.every(n=>nodePins(n).includes(key))}"><span class="node-pin" data-color="${key}"></span></button>`).join("")}
    <button type="button" data-a="pin:" title="清除标记" aria-label="清除标记" ${nodes.some(n=>nodePins(n).length) ? "" : "disabled"}>${ico("minus")}</button>
  </div>`;
}
let nodePinTrigger = null;
function openNodePinMenu(button) {
  const nodes = [...sel].map(node).filter(Boolean);
  if (!canvasCanEdit() || !nodes.length) return;
  const menu = $("#nodePinMenu");
  closeMenus();
  const board = B, ids = nodes.map(n=>n.id);
  nodePinTrigger = button;
  menu.innerHTML = nodePinPalette(nodes);
  menu.classList.add("on");
  const rect = button.getBoundingClientRect();
  const below = rect.bottom + 6;
  menu.style.left = Math.max(8, Math.min(rect.left, innerWidth - menu.offsetWidth - 8)) + "px";
  menu.style.top = Math.max(8, below + menu.offsetHeight <= innerHeight - 8 ? below : rect.top - menu.offsetHeight - 6) + "px";
  const triggerSelector = ids.length === 1 ? "#ntools [data-a=pin]" : "#selectionTools [data-action=pin]";
  $$("button", menu).forEach(choice => choice.onclick = () => {
    closeMenus();
    if (B !== board || ids.length !== sel.size || !ids.every(id=>sel.has(id))) return;
    markCanvasNodes(ids, choice.dataset.a.slice(4));
    $(triggerSelector)?.focus();
    hideNodeToolTip();
  });
  $("button", menu).focus();
}
function ctxMenu(e) {
  const el = e.target.closest?.(".node");
  if (!canvasCanEdit() && !el) { ccPoint(toW(e.clientX, e.clientY)); return; }
  if (!el) { openAddMenu(e.clientX, e.clientY, { at: toW(e.clientX, e.clientY), arrange: true }); return; }
  const n = node(el.dataset.id); if (!n) return;
  if (!sel.has(n.id)) selectOnly(n.id);
  const selected = [...sel].map(node).filter(Boolean);
  const many = sel.size > 1, v = curV(n), it = [];
  const add = (a, icon, label, k = "") => it.push(`<button data-a="${a}">${ico(icon)}${label}${k ? `<span class="k">${k}</span>` : ""}</button>`);
  it.push(`<div class="mt">${many ? `已选 ${sel.size} 个节点` : esc(n.name)}</div>`);
  if (canvasCanEdit()) {
    add("agent-new", "script", many ? "用选中节点发起新对话" : "用此节点发起新对话");
    it.push(nodePinPalette(selected));
    if (selected.some(m=>!nodeLocked(m))) add("lock-selection","lock",many ? "锁定所选节点" : "锁定节点");
    if (selected.some(nodeLocked)) add("unlock-selection","lock",many ? "解锁所选节点" : "解锁节点");
    it.push('<div class="sep"></div>');
  }
  if (!many && n.type === "text") add("text-document", "script", canvasCanEdit() ? "编辑文档" : "查看文档");
  if (!many && n.type === "text" && n.data.transcript?.cues?.length) add("saved-transcript", "scissors", "按台词剪辑音频");
  if (!many && n.data.previs) add("previs", "video", "编辑白模");
  if (!many && n.type === "audio") add("audio-upload","upload","上传音频版本");
  if (!many && n.type === "audio" && v?.ref) add("transcript","text","音频转写");
  if (!many && ["video","audio"].includes(n.type) && v?.ref && canvasCanEdit()) add("separate-audio","audio","人声分离");
  if (!many && n.data.playlist) add("playlist-open","stack","打开播放列表");
  if (!many && canvasCanEdit() && B.edges.some(edge=>edge.from===n.id && vtGenerationReference(edge,n,node(edge.to)))) {
    add("replace-reference","next","替换下游参考…");
  }
  if (!many && v) {
    if (pvGuideAvailable(v)) add("previsvideo", "next", "用作动作参考");
    if (n.type === "image") {
      add("edit", "image", "编辑图片（局部重绘 / 扩图 / 裁剪）");
      add("relight", "edit", "调整图片布光");
      add("image-camera", "video", "图片换机位");
      if (panoramaVersion(v)) add("panorama","panorama","360° 全景预览");
      add("image-pixels", "fit", "调整像素尺寸");
      add("image-upscale", "full", "智能放大");
      add("image-decompose", "assets", "自动分层");
      add("tovideo", "video", "生成视频"); add("hd", "full", "高清重绘"); add("describe", "text", "反推提示词");
      add("film", "scissors", "用图片开始剪辑");
      if (v.ref) add("gif-export", "motion", "宫格生成 GIF");
      it.push(`<div class="sep"></div>`);
      add("split2x2", "assets", "拆分宫格 2×2"); add("split3x3", "assets", "拆分宫格 3×3"); add("split4x4", "assets", "拆分宫格 4×4"); add("split5x5", "assets", "拆分宫格 5×5");
      it.push(`<div class="sep"></div>`);
      add("asset:character", "image", n.data.asset?.kind === "character" ? "更新资产库角色" : "存为角色"); add("asset:scene", "image", "存为场景"); add("asset:prop", "image", "存为道具");
      it.push(`<div class="sep"></div>`);
    }
    if (n.type === "video" && n.data.film && !n.data.playlist) add("film", "scissors", "编辑成片");
    else if (n.type === "video" && !n.data.film) { add("cont", "next", "续拍"); add("film", "scissors", "剪辑视频（导出为新版本）"); add("analyze", "script", "拉片（拆镜头复刻）"); }
    if (n.type === "video") { add("firstframe", "image", "截取首帧"); add("currentframe", "image", "截取当前帧"); add("frame", "image", "截取末帧"); }
    if (n.type === "video") add("remake", "video", "视频重制 · 替换角色");
    if (n.type === "video") add("trim-video", "scissors", "裁剪视频 / 智能拆镜头");
    if (n.type === "video" && v.draft_expires) add("draft-final","hd","从样片生成定稿");
    if (n.type === "video" && n.versions.filter(v=>v.url).length > 1) add("compare-video", "stack", "对比视频版本");
    if (n.type === "video" && v.source!=="previs") {
      add("segment-edit","edit","修改视频片段");
      add("camera-retake","video","镜头重拍");
      add("object-remove","edit","移除视频物体");
      add("object-replace","edit","替换视频物体");
      if (n.data.object_edit && videoInputs(n)[0]?.edge.segment_edit) add("object-settings","edit","调整物体编辑设置");
      if (n.data.camera_plan && videoInputs(n)[0]?.edge.segment_edit) add("retake-settings","edit","调整当前重拍设置");
    }
    if (n.type === "video" && (v.segment_review || collectSegmentVersions({node:n,index:n.cur}).length)) add("segment-review","scissors","审核修改片段");
    if (n.type === "video" && extensionInput(v)) add("extension-film","scissors","原片与续拍一起剪辑");
    if (v.video_recipe?.segment_edit) {
      add("segment-film","scissors","在原片中核对这一段");
      add("segment-review-parent","scissors","审核原片的各段修改");
    }
    add("full", "full", "全屏查看");
    add("dl", "dl", "下载");
    if (n.type === "video" && v.ref) add("gif-export","motion","导出循环 GIF");
    if (canvasCanEdit() && v.ref && ["image","video"].includes(n.type)) add("broll","motion","B-roll 动态画面");
    it.push(`<div class="sep"></div>`);
  }
  if (many) {
    if (canvasCanEdit() && selected.some(groupGeneratable)) add("ct:generate", "motion", "批量生成选中节点");
    add("ct:fold", "stack", "收起为一组");
    add("ct:left", "fit", "左对齐"); add("ct:top", "fit", "顶部对齐");
    add("ct:distributeX", "assets", "水平等距排列"); add("ct:distributeY", "assets", "垂直等距排列");
    add("ct:group", "assets", "编组", "⌘G"); add("ct:ungroup", "assets", "取消编组", "⇧⌘G");
    if (ctSelected().some(alCanvasCollectable)) add("ct:collect","assets","收录到资产库");
    add("ct:download", "dl", "批量下载素材"); it.push(`<div class="sep"></div>`);
    add("template", "stack", "将选区保存为模板");
  }
  if (!many) add("comment", "comment", "评论此节点");
  add("arrange", "assets", "整理图片与视频…");
  const vids = [...sel].map(node).filter(m => m && m.type === "video" && curV(m));
  if(vids.length>=2){const info=vtMergeInfo(vids.map(m=>m.id));it.push(`<button data-a="merge-tabs" ${info.error?`disabled title="${esc(info.error)}"`:""}>${ico("stack")}合并为 Tab（${vids.length} 个视频）</button>`);}
  if(!many&&n.type==="video"&&n.versions.length>1){add("split-tab","copy","拆出当前 Tab");add("split-tabs","assets","拆开所有 Tab");}
  const qv = [...sel].map(node).filter(m => m && m.type === "video" && !m.job && !m.data.film && !m.data.previs);
  if (many && qv.length) { add("queuegen", "video", `排队生成（${qv.length} 段视频，按名称顺序）`); if (!(vids.length >= 2)) it.push(`<div class="sep"></div>`); }
  const media = byPosition([...sel]).filter(filmSource);
  if (media.filter(playlistVideo).length >= 2) add("playlist-create","stack","创建播放列表");
  if (many && media.length >= 2) { add("concat", "scissors", `剪辑成片（${media.length} 段，按位置顺序）`); it.push(`<div class="sep"></div>`); }
  if (!many) add("workflow-review", "script", "制作复盘");
  add("focus", "fit", many ? "聚焦选中" : "聚焦此节点", "F");
  if (!many) add("rename", "text", "重命名");
  add("dup", "copy", "创建副本", "⌘D");
  it.push(`<div class="sep"></div>`);
  if (canvasCanEdit() && selected.some(m=>!nodeLocked(m))) add("del","trash",selected.some(nodeLocked) ? "删除未锁定节点" : "删除","Del");
  const m = $("#ctxMenu"); m.innerHTML = it.join(""); m.classList.add("on");
  if (!canvasCanEdit()) $$("button[data-a]",m).filter(b=>!["comment","full","compare-video","dl","gif-export","focus","workflow-review","playlist-open","text-document","panorama"].includes(b.dataset.a)).forEach(b=>b.remove());
  m.style.left = Math.min(e.clientX, innerWidth - m.offsetWidth - 8) + "px"; m.style.top = Math.min(e.clientY, innerHeight - m.offsetHeight - 8) + "px";
  $$("button", m).forEach(b => b.onclick = () => {
    closeMenus(); const a = b.dataset.a;
    if (a === "arrange") ctOpenArrangeMenu(e.clientX, e.clientY);
    else if (a === "comment") ccNode(n);
    else if (a === "template") openWorkflowTemplates(true);
    else if (a === "agent-new") acNewNodeSession(selected.map(item=>({id:item.id,ref:curV(item)?.ref}))).catch(error=>toast(error.message));
    else if (a === "replace-reference") vtOpenReferenceUpdate(n);
    else if (a === "workflow-review") openWorkflowReview(n.id, n.cur >= 0 ? n.cur + 1 : null);
    else if(a==="merge-tabs")vtMerge(vids.map(m=>m.id),n.id);
    else if(a==="split-tab"||a==="split-tabs")vtSplit(n.id,n.cur,a==="split-tabs");
    else if (a.startsWith("ct:")) ctAction(a.slice(3));
    else if (a === "focus") fit([...sel].map(node).filter(Boolean));
    else if (a === "rename") { const nm = $(".nm", els.get(n.id)); nm.dispatchEvent(new MouseEvent("dblclick", { bubbles: false })); }
    else if (a === "dup") duplicate([...sel]);
    else if (a === "del") removeNodes([...sel]);
    else if (a === "lock-selection" || a === "unlock-selection") markCanvasNodes([...sel],a === "lock-selection",{lock:true});
    else if (a.startsWith("pin:")) markCanvasNodes([...sel],a.slice(4));
    else if (a === "concat") openFilm(media);
    else if (a === "playlist-create") createFilmPlaylist(media);
    else if (a === "queuegen") queueVideos([...sel].map(node).filter(m => m && m.type === "video" && !m.job && !m.data.film && !m.data.previs));
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
      list.innerHTML = '<div class="sep"></div><div class="mt">选用白模动作参考</div>';
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
      button.append("从资产库选用"+TYPE_CN[kind]);
      button.onclick=()=>{closeMenus();openReferenceLibrary(ctx.to,kind);};
      library.append(button);
    }
    m.append(library);
  }
  $(".mt", m).textContent = ctx.from ? "连接到新节点" : ctx.to ? "添加上游输入" : "添加到画布";
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
function paste(items, dx = 40, dy = 40, fragment = null) {
  checkpoint(); const map = Object.create(null); const made = [];
  for (const o of items) { const n = addNode(o.type, o.x + dx, o.y + dy, o.data); n.versions = JSON.parse(JSON.stringify(o.versions)); n.cur = o.cur; n.name = o.name + " 副本"; map[o.id] = n.id; render(n); made.push(n.id); }
  const remapData = data=>{
    for(const shot of data?.made || []) for(const key of ["img","vid"]) if(shot[key]) shot[key]=map[shot[key]]||"";
    if(data?.previs_source) data.previs_source=map[data.previs_source]||"";
    if(data?.film?.story_script) data.film.story_script=map[data.film.story_script]||"";
    for(const clip of data?.film?.clips || []) if(clip.node) clip.node=map[clip.node]||"";
    for(const clip of data?.film?.cutaways || []) if(clip.node) clip.node=map[clip.node]||"";
  };
  const remapSeedRefs=data=>{
    if (data?.mode==="seed_audio") data.references=seedAudioRefs({data}).map(ref=>({...ref,node_id:map[ref.node_id]||ref.node_id}));
  };
  for (const id of made) {
    remapSeedRefs(node(id).data);
    if(fragment || map[node(id).data?.previs_source])remapData(node(id).data);
    else for (const clip of node(id).data?.film?.cutaways || []) if(map[clip.node]) clip.node=map[clip.node];
    for(const v of node(id).versions) {
      remapSeedRefs(v.audio_recipe);
      if(v.input_edges) v.input_edges = v.input_edges.filter(e=>!fragment||map[e.from]).map(e=>({...e,from:map[e.from]||e.from,to:id}));
      if(v.copied_from?.node) {
        const origin=map[v.copied_from.node];
        if(origin)v.copied_from.node=origin;
        else if(fragment)delete v.copied_from.node;
      }
      if (Array.isArray(v.segment_review)) v.segment_review=v.segment_review.filter(c=>c&&(!fragment||map[c.node_id]))
        .map(c=>({...c,node_id:map[c.node_id]||c.node_id}));
      for (const guide of [v.video_recipe?.previs_guide, ...(v.video_recipe?.audio_refs || []), ...(v.video_recipe?.video_refs || [])].filter(Boolean)) {
        if (map[guide.node_id]) guide.node_id = map[guide.node_id];
        else if (fragment) delete guide.node_id;
      }
      for (const [entries, key] of [[v.video_recipe?.images,"node_id"], [v.generation_record?.inputs,"node_id"],
        [v.film_recipe?.clips,"node"], [v.film_recipe?.audio,"node"], [v.film_recipe?.timeline?.clips,"node"],
        [v.film_recipe?.timeline?.audio_clips,"node"], [v.film_recipe?.cutaways,"node"], [v.film_recipe?.timeline?.cutaways,"node"]]) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          if (!entry || typeof entry[key] !== "string") continue;
          if (map[entry[key]]) entry[key] = map[entry[key]];
          else if (fragment) delete entry[key];
        }
      }
      for (const origin of [v.capture,v.draft_final]) {
        if (origin?.source_node && (fragment || map[origin.source_node])) origin.source_node = map[origin.source_node] || "";
      }
      if(fragment){
        remapData(v.node_data);
        if(v.remake?.source_node)v.remake.source_node=map[v.remake.source_node]||"";
      }
      if(v.tab_nodes)v.tab_nodes=[id];delete v.tab_origin;
    }
  }
  for (const e of fragment?.edges || B.edges.slice()) if (map[e.from] && map[e.to]) B.edges.push({ ...e, from: map[e.from], to: map[e.to] });
  for (const group of fragment?.groups || [...(B.groups || [])]) if(group.nodes.every(id => map[id])) B.groups.push({...group,id:"g"+Date.now().toString(36)+Math.random().toString(36).slice(2,6),name:group.name+" 副本",nodes:group.nodes.map(id=>map[id]),
    ...(Number.isFinite(group.fold?.x)&&Number.isFinite(group.fold?.y)?{fold:{x:group.fold.x+dx,y:group.fold.y+dy}}:{})});
  if(fragment)made.forEach(id=>render(node(id)));
  drawEdges(); sel = new Set(made); updateSel(); save();
  return made;
}
function duplicate(ids) { paste(ids.map(id => JSON.parse(JSON.stringify(node(id)))), 60, 60); }
