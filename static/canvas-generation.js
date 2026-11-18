"use strict";

// ================================================================= generation
async function api(path, body, method = "POST") {
  const r = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { error: t }; }
  if (!r.ok) throw new Error(j.error || t || r.statusText); return j;
}
function fullPrompt(n) {
  const parts = inputs(n, "text").map(t => t.data.text.trim()).filter(Boolean);
  if (!usesFields(n) && n.data.prompt.trim()) parts.push(n.data.prompt.trim());   // field mode: the fields replace the free text
  return parts.join("\n");
}
function showErr(n, msg) { const b = $(".errbox", els.get(n.id)); b.textContent = msg || ""; b.classList.toggle("on", !!msg); }
const usesFields = n => !!n && n.type === "video" && n.data.pmode === "fields";
const fieldsFilled = n => FIELDS.some(f => !["sound", "music"].includes(f.k) && (n.data.fields?.[f.k] || "").trim());
const prepping = new Set();   // video nodes whose request is being prepared (prompt translated) before it reaches the queue
function showPrep(n, on) {
  const el = els.get(n.id); if (!el) return;
  const g = $(".gen", el);
  if (!on) { renderJob(n); if (!n.job) g.classList.toggle("on", toolBusy.has(n.id)); return; }
  g.classList.add("on"); $(".pct", g).textContent = "译"; $(".bar i", g).style.width = "3%";
  $(".s", g).textContent = "提交中…";
}
async function generate(n) {
  if (n.type === "script") return planStoryboard(n);
  if (n.job) return toast("这个节点仍有生成任务，请等待完成或取消");
  if (prepping.has(n.id)) return toast("这个视频正在准备提交，请稍等");
  const d = n.data, prompt = fullPrompt(n); delete n.agent_error; showErr(n, "");
  if (usesFields(n) ? !fieldsFilled(n) : !prompt) { toast(usesFields(n) ? "至少填写场景、动作或对话中的一项" : "先写提示词，或连入一个文本节点"); if (!usesFields(n)) $("#prompt").focus(); return; }
  let req;
  if (n.type === "image") {
    const ins = imgInputs(n), images = [];
    if (ins.length && d.model === "h3video") { toast("以图改图需要 H3-Image 模型"); return; }
    for (const m of ins) { const v = curV(m); if (!v) { toast(`「${m.name}」还没有图片`); return; } images.push({ ref: v.ref }); }
    let ar = AR[d.aspect];
    if (d.aspect === "auto") { const v = ins.length ? curV(ins[0]) : null; ar = v && v.w ? v.w / v.h : 1; }
    req = { kind: "image", model: d.model, expand: d.expand, prompt, images, ar, quality: d.model === "h3video" ? (d.quality === "16mp" ? "hd" : "std") : d.quality, turbo: d.turbo, seed: d.seed, count: d.count };
  }
  else { req = videoReq(n, prompt); if (!req) return; }
  req.label = n.name;
  req.board = boardId;
  if (n.data.provider && (CAPS_LIST[n.type === "image" ? "image" : "video"] || []).some(x => x.id === n.data.provider)) req.provider = n.data.provider;
  const slow = n.type === "video";
  const history = slow ? {input_edges: JSON.parse(JSON.stringify(B.edges.filter(e => e.to === n.id))), node_data: JSON.parse(JSON.stringify(n.data)), video_recipe: JSON.parse(JSON.stringify(req))} : null;
  rememberVideoVersion(n);
  if (slow) { prepping.add(n.id); showPrep(n, true); }
  try {
    const r = await api("/api/generate", req);
    if (history && r.memory_context) Object.assign(history.video_recipe, r.memory_context);
    n.job = { ids: r.ids, prompt, t0: Date.now(), st: {}, memory_used:r.memory_used||[], ...(history ? {history} : {}) }; save(); render(n); showPanel(); poll();
  } catch (e) { showErr(n, e.message); }
  finally { if (slow) { prepping.delete(n.id); showPrep(n, false); } }
}
function videoReq(n, prompt) {
  const d = n.data;
  let req;
  {
    const p = plan(n), imgs = [];
    for (const [i, m] of p.imgs.entries()) {
      const v = curV(m); if (!v) { toast(`「${m.name}」还没有图片`); return null; }
      imgs.push({ node_id: m.id, ref: v.ref, name: m.name, caption: m.data.caption || (v.source === "gen" ? v.prompt : "") || "", index: i + 1, asset: m.data.asset?.id,
                  role: p.roles[i] === "subject" ? "subject" : "frame", time: p.times[i] ?? 0, w: v.w, h: v.h });
    }
    // the video's shape: chosen, or the first frame's, or a character image's
    const lead = p.ordered.length ? imgs[p.ordered[0]] : null;
    let ar = AR[d.aspect]; if (d.aspect === "auto") ar = lead && lead.w ? lead.w / lead.h : 16 / 9;
    const common = { kind: "video", prompt, ar, duration: d.duration, quality: d.quality, turbo: d.turbo, seed: d.seed, sound: d.sound, music: d.music, count: d.count || 1 };
    if (usesFields(n)) common.fields = { ...d.fields };
    if (p.useRef) req = { ...common, planned: true, images: imgs };
    else req = { ...common, images: p.ordered.map(i => imgs[i]), mode: "fl2v" };
  }
  return req;
}
async function rewritePrompt(n) {
  const prompt = fullPrompt(n);
  if (usesFields(n) ? !fieldsFilled(n) : !prompt) { toast(usesFields(n) ? "至少填写场景、动作或对话中的一项" : "先写一段中文描述"); return; }
  const req = videoReq(n, prompt); if (!req) return;
  const btn = $("#rwBtn"); btn.disabled = true; btn.innerHTML = `${ico("clock")}改写中…`;
  const t0 = Date.now(), tick = setInterval(() => { if ($("#rwBtn")) $("#rwBtn").innerHTML = `${ico("clock")}改写中 ${Math.round((Date.now() - t0) / 1000)}s`; }, 1000);
  try {
    const r = await api("/api/rewrite", req);
    checkpoint();
    if (!n.data.prompt_src) { n.data.prompt_src = n.data.prompt; if (usesFields(n)) n.data.rw_from = "fields"; }
    n.data.prompt = r.prompt; n.data.pmode = "free"; save();   // the English result is edited as free text; 还原原文 brings the fields back
    const ta = $("#prompt"); if (ta._node === n.id) { ta.value = r.prompt; autoGrow(ta); }
    toast(`已按官方格式改写（${r.mode}，${r.seconds}s，${r.device}）`, 3000);
  } catch (e) { toast("改写失败：" + e.message, 4000); }
  finally { clearInterval(tick); if (sel.has(n.id)) showPanel(); }
}
async function cancel(n) { if (n.job) try { await api("/api/cancel", { ids: n.job.ids }); } catch {} }
function renderJob(n) {
  const el = els.get(n.id); if (!el || n.type === "text") return;
  const g = $(".gen", el);
  if (!n.job) { g.classList.toggle("on", toolBusy.has(n.id)); return; }
  g.classList.add("on");
  const sts = n.job.ids.map(i => n.job.st?.[i]).filter(Boolean);
  const run = sts.find(s => s.state === "running"), q = sts.find(s => s.state === "queued"), done = sts.filter(s => s.state === "done").length;
  let pct = "", msg = "提交中…", frac = 0;
  if (run) {
    if (run.max > 1 && run.value != null) { frac = run.value / run.max; pct = Math.round(frac * 100) + "%"; msg = n.data.film ? "合成成片中" : run.value >= run.max ? "解码合成中" : `生成中 · 第 ${run.value}/${run.max} 步`; }
    else { pct = "…"; msg = "加载模型 / 处理输入"; }
    if (run.phase && EW_PHASES[run.phase] && run.phase !== "sampling") { pct = "…"; msg = EW_PHASES[run.phase]+"…"; }
  } else if (q) { pct = "排队"; msg = q.prep ? "已进入队列 · 正在把提示词翻译成英文" : q.ahead > 0 ? `前面还有 ${q.ahead} 个任务` : "即将开始"; }
  const eta = Math.max(0, ...sts.filter(s => s.state !== "done").map(s => s.eta || 0));
  if (eta && (run || q)) msg += ` · ${run ? "还要" : ""}约 ${fmtT(eta)}${run ? "" : "后完成"}`;
  if (n.job.ids.length > 1) msg += ` · ${done}/${n.job.ids.length}`;
  $(".pct", g).textContent = pct; $(".bar i", g).style.width = Math.max(3, frac * 100) + "%";
  $(".s", g).textContent = msg + " · " + Math.round((Date.now() - n.job.t0) / 1000) + "s";
}
let polling = false;
async function poll() {
  if (polling) return; polling = true;
  try {
    for (;;) {
      const act = B.nodes.filter(n => n.job); if (!act.length) break;
      let st;
      try { st = await (await fetch("/api/jobs?ids=" + act.flatMap(n => n.job.ids).join(","))).json(); } catch { await sleep(3000); continue; }
      for (const n of act) {
        if(!n.job || node(n.id)!==n) continue;
        n.job.st = st;
        const sts = n.job.ids.map(i => st[i]).filter(Boolean);
        if (!(sts.length === n.job.ids.length && sts.every(s => s.state === "done" || s.state === "error"))) { renderJob(n); continue; }
        if (n.job.agent_call) { await acSyncAgentJobs(); if (node(n.id)?.job) renderJob(node(n.id)); continue; }
        const errs = sts.filter(s => s.state === "error").map(s => s.error);
        for (const s of sts.filter(s => s.state === "done")) for (const o of s.outputs || []) {
          const m = o.meta || {};
          n.versions.push({ ref: o.ref, url: o.url, prompt: n.job.prompt, seed: s.meta?.seed, w: m.width || s.meta?.width, h: m.height || s.meta?.height, seconds: m.duration, source: n.data.film ? "film" : "gen", memory_used: n.job.memory_used||[], mode: s.meta?.mode_name, ...(o.extra || {}), ...(n.job.history || {}) });
          n.cur = n.versions.length - 1;
        }
        n.job = null; save(); render(n); refreshDownstream(n); drawEdges();
        if (sel.has(n.id)) showPanel();
        showErr(n, errs.length ? "生成失败：" + errs.join("\n") : "");
        if (!errs.length) loadAssets();
      }
      await sleep(1200);
    }
  } finally { polling = false; }
}

// ================================================================= uploads, assets, frames
let pickCb = null;
function pickFiles(cb) { pickCb = cb; $("#file").click(); }
$("#file").onchange = e => { const f = [...e.target.files]; e.target.value = ""; if (f.length && pickCb) pickCb(f); pickCb = null; };
const imgSize = url => new Promise(r => { const i = new Image(); i.onload = () => r([i.naturalWidth, i.naturalHeight]); i.onerror = () => r([0, 0]); i.src = url; });
function addVersion(n, v) {
  checkpoint(); n.versions.push(v); n.cur = n.versions.length - 1; save(); render(n); refreshDownstream(n); drawEdges(); if (sel.has(n.id)) showPanel();
}
async function uploadInto(n, file) {
  showErr(n, ""); const fd = new FormData(); fd.append("image", file, file.name || "paste.png");
  try {
    const r = await fetch("/api/upload", { method: "POST", body: fd }); if (!r.ok) throw new Error(await r.text());
    const j = await r.json();
    if (j.type === "video") { if (n.name.startsWith("视频 ") && file.name) n.name = file.name.replace(/\.[^.]+$/, "").slice(0, 24); addVersion(n, { ref: j.ref, url: j.url, w: j.w, h: j.h, seconds: j.seconds, source: "upload", prompt: "" }); loadAssets(); return; }
    const [w, h] = await imgSize(j.url);
    if (!n.data.caption) n.data.caption = (file.name || "").replace(/\.[^.]+$/, "").replace(/[-_ ]?\d+$/, "").replace(/^(image|paste|IMG|DSC|Screenshot).*$/i, "");
    if (file.name && n.name.startsWith("图片 ")) n.name = file.name.replace(/\.[^.]+$/, "").slice(0, 24);
    addVersion(n, { ref: j.ref, url: j.url, w, h, source: "upload", prompt: "" }); loadAssets();
  } catch (e) { showErr(n, "上传失败：" + e.message); }
}
vp.addEventListener("dragover", e => e.preventDefault());
vp.addEventListener("drop", e => {
  e.preventDefault(); const at = toW(e.clientX, e.clientY);
  const a = e.dataTransfer.getData("application/x-h3-asset");
  if (a) { placeAsset(JSON.parse(a), at); return; }
  const files = [...e.dataTransfer.files].filter(f => f.type.startsWith("image/") || f.type.startsWith("video/"));
  if (files.length) checkpoint();
  files.forEach((f, i) => uploadInto(addNode(f.type.startsWith("video/") ? "video" : "image", at.x + i * 340, at.y), f));
});
addEventListener("paste", e => {
  if (e.target.closest("input, textarea, [contenteditable=true]")) return;
  const f = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith("image/")); if (!f) return;
  e.preventDefault(); const one = sel.size === 1 ? node([...sel][0]) : null;
  if (one && one.type === "image" && !curV(one)) uploadInto(one, f);
  else { const at = toW(innerWidth / 2 - 150, innerHeight / 2 - 180); uploadInto(addNode("image", at.x, at.y), f); }
});
async function continueFrom(n, frameOnly) {
  const v = curV(n); if (!v) return toast("还没有视频");
  try {
    const j = await api("/api/lastframe", { ref: v.ref }); checkpoint();
    const s = size(n);
    const at = freeSpot(n.x + s.w + 110, n.y, "image");
    const img = addNode("image", at.x, at.y, { caption: (v.prompt || "").slice(0, 200) }, { name: n.name + " · 末帧" });
    img.versions.push({ ref: j.ref, url: j.url, w: j.w, h: j.h, source: "frame", prompt: "" }); img.cur = 0; render(img);
    if (frameOnly) { selectOnly(img.id); loadAssets(); return; }
    const at2 = freeSpot(img.x + size(img).w + 110, img.y, "video");
    const vid = addNode("video", at2.x, at2.y, { duration: n.data.duration, quality: n.data.quality, turbo: n.data.turbo, aspect: n.data.aspect });
    link(img, vid, true); selectOnly(vid.id); setTimeout(() => $("#prompt").focus(), 30); toast("已截取最后一帧，写下一段的提示词继续生成"); loadAssets();
  } catch (e) { toast("截帧失败：" + e.message); }
}
let assetsCache = [], afilter = "all";
async function loadAssets() {
  if (!$("#drawer").classList.contains("on")) return;
  if (KIND_CN[afilter]) { $("#drawer .h").textContent = "点击或拖到画布上使用；输入 @ 采用设定与参考图；右上角查看记忆和版本"; return renderLibrary(afilter); }
  $("#drawer .h").textContent = "点击或拖到画布上使用";
  try { assetsCache = await (await fetch("/api/assets")).json(); } catch { return; }
  const g = $("#agrid"), list = assetsCache.filter(a => afilter === "all" || a.type === afilter);
  g.innerHTML = list.map((a, i) => `<div class="as" draggable="true" data-i="${assetsCache.indexOf(a)}">${a.type === "video" ? `<video src="${a.url}#t=0.5" preload="metadata" muted></video>` : `<img src="${a.url}" loading="lazy">`}<span class="ty">${a.type === "video" ? "视频" : a.source === "upload" ? "上传" : a.source === "frame" ? "截帧" : "生成"}</span></div>`).join("") || `<div class="h">还没有素材</div>`;
  $$(".as", g).forEach(d => {
    const a = assetsCache[+d.dataset.i];
    d.addEventListener("dragstart", e => e.dataTransfer.setData("application/x-h3-asset", JSON.stringify(a)));
    d.onclick = () => placeAsset(a, toW(innerWidth / 2 - 150, innerHeight / 2 - 180));
  });
}
async function placeAsset(a, at) {
  const n = addNode(a.type, at.x, at.y);
  let w = 0, h = 0;
  if (a.type === "image") [w, h] = await imgSize(a.url);
  else await new Promise(r => { const v = document.createElement("video"); v.preload = "metadata"; v.onloadedmetadata = () => { w = v.videoWidth; h = v.videoHeight; r(); }; v.onerror = r; v.src = a.url; });
  n.versions.push({ ref: a.ref, url: a.url, w, h, source: a.source, prompt: "" }); n.cur = 0; render(n); save(); selectOnly(n.id);
}
$("#assetBtn").onclick = () => { $("#drawer").classList.toggle("on"); $("#assetBtn").classList.toggle("on"); loadAssets(); };
$$("#drawer .tabs button").forEach(b => b.onclick = () => { $$("#drawer .tabs button").forEach(x => x.classList.remove("on")); b.classList.add("on"); afilter = b.dataset.f; loadAssets(); });
