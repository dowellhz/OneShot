"use strict";
// 成片编辑 (timeline: order, trim, transitions, subtitles, music, narration, cover, aspect), the queue panel with ETAs,
// and the "all done" notice. Loaded before the main script; the main script calls initFilm() before it boots.

const TRANS_CN = { cut: "硬切", fade: "叠化", black: "黑场" };
const FIT_CN = { pad: "加黑边", blur: "模糊背景填充", crop: "裁切铺满" };
const ASPECT_CN = { source: "跟随原片", "16:9": "横屏 16:9", "9:16": "竖屏 9:16", "1:1": "方形 1:1", "4:3": "4:3", "3:4": "3:4" };
let FILM = null;            // { n (film node or null), spec, sel, srcIds }
let voiceList = null;

// subtitles from a shot's 对话 field: drop the "名字（语气）：" prefix and the quotes
function subsOf(n) {
  const lines = (n?.data?.fields?.dialogue || "").split("\n").map(s => s.trim()).filter(Boolean);
  return lines.map(l => {
    const m = l.match(/^(.{1,24}?)\s*[:：]+\s*(.+)$/);
    let t = m && !/^[“"「]/.test(l) ? m[2] : l;
    t = t.trim().replace(/^[“"「]+|[”"」]+$/g, "");
    return t;
  }).filter(Boolean);
}
const vlen = n => curV(n)?.seconds || n?.data?.duration || 5;
function clipLen(c) { const n = node(c.node); const L = c.src_len || vlen(n); return Math.max(0.5, (c.out ?? L) - (c.in || 0)); }
function filmTotal(spec) {
  let t = 0;
  spec.clips.forEach((c, i) => { t += clipLen(c); if (c.trans === "fade" && i + 1 < spec.clips.length) t -= 0.5; });
  return Math.max(0, t);
}
function newSpec(vids) {
  return {
    clips: vids.map(m => ({ node: m.id, in: 0, out: null, trans: "cut", subs: subsOf(m), volume: 1 })),
    aspect: "source", fit: "blur", subtitles: true, sub_size: 1, bgm: null, narration: [], cover: 0,
  };
}

// open the editor: on a film node (re-edit), or with a list of shot videos (new film)
function openFilm(arg) {
  let n = null, spec;
  if (arg && !Array.isArray(arg) && arg.data?.film) { n = arg; spec = JSON.parse(JSON.stringify(n.data.film)); }
  else {
    const vids = (arg || []).filter(m => m && m.type === "video" && curV(m));
    if (!vids.length) return toast("先选中至少一段已生成的视频");
    spec = newSpec(vids);
  }
  FILM = { n, spec, sel: 0 };
  $("#film").classList.add("on");
  renderFilm(); selectClip(0);
}
function closeFilm() { $("#film").classList.remove("on"); const v = $("#fmV"); v.pause(); FILM = null; }

function renderFilm() {
  const F = FILM, s = F.spec, total = filmTotal(s);
  $("#fmTotal").textContent = `${s.clips.length} 段 · ${total.toFixed(1)} 秒`;
  // timeline strip
  const tl = $("#fmTl");
  tl.innerHTML = s.clips.map((c, i) => {
    const m = node(c.node), v = curV(m), L = clipLen(c);
    return `<div class="fc ${i === F.sel ? "on" : ""}" draggable="true" data-i="${i}" style="width:${Math.round(90 + L * 22)}px">
        <video src="${v ? v.url + "#t=" + ((c.in || 0) + 0.05) : ""}" preload="metadata" muted></video>
        <div class="fl"><b>${i + 1}</b> ${esc(m?.name || "已删除")}<span>${L.toFixed(1)}s</span></div>
        ${c.subs.length && s.subtitles ? `<div class="fs">${esc(c.subs[0])}${c.subs.length > 1 ? " …" : ""}</div>` : ""}
        <button class="x" title="从成片中移除">×</button></div>` +
      (i + 1 < s.clips.length ? `<button class="ft" data-i="${i}" title="点击切换转场">${TRANS_CN[c.trans] || "硬切"}</button>` : "");
  }).join("") + `<button class="fadd" title="把画布上的其他视频加进来">＋ 添加片段</button>`;
  $$(".fc", tl).forEach(el => {
    const i = +el.dataset.i;
    el.onclick = e => { if (e.target.closest(".x")) return; selectClip(i); };
    $(".x", el).onclick = () => { if (s.clips.length <= 1) return toast("至少保留一段"); s.clips.splice(i, 1); F.sel = Math.min(F.sel, s.clips.length - 1); renderFilm(); selectClip(F.sel); };
    el.addEventListener("dragstart", e => { e.dataTransfer.setData("text/x-clip", String(i)); el.classList.add("drag"); });
    el.addEventListener("dragend", () => el.classList.remove("drag"));
    el.addEventListener("dragover", e => { e.preventDefault(); el.classList.add("over"); });
    el.addEventListener("dragleave", () => el.classList.remove("over"));
    el.addEventListener("drop", e => {
      e.preventDefault(); el.classList.remove("over");
      const from = +e.dataTransfer.getData("text/x-clip"); if (isNaN(from) || from === i) return;
      const [c] = s.clips.splice(from, 1); s.clips.splice(i, 0, c); F.sel = i; renderFilm(); selectClip(i);
    });
  });
  $$(".ft", tl).forEach(b => b.onclick = () => {
    const c = s.clips[+b.dataset.i], k = Object.keys(TRANS_CN); c.trans = k[(k.indexOf(c.trans) + 1) % k.length]; renderFilm();
  });
  $(".fadd", tl).onclick = e => addClipMenu(e);
  // settings column
  const set = $("#fmSet");
  const opt = (k, map, cur) => `<select data-k="${k}">${Object.entries(map).map(([a, t]) => `<option value="${a}" ${a === String(cur) ? "selected" : ""}>${t}</option>`).join("")}</select>`;
  const bg = s.bgm;
  set.innerHTML = `
    <h4>画面</h4>
    <label>画幅${opt("aspect", ASPECT_CN, s.aspect)}</label>
    ${s.aspect !== "source" ? `<label>比例不同时${opt("fit", FIT_CN, s.fit)}</label>` : ""}
    <h4>字幕</h4>
    <label class="ck"><input type="checkbox" data-k="subtitles" ${s.subtitles ? "checked" : ""}>烧录字幕（来自每段的台词，可在下方改）</label>
    ${s.subtitles ? `<label>字号${opt("sub_size", { 0.8: "小", 1: "中", 1.25: "大" }, s.sub_size)}</label>` : ""}
    <h4>背景音乐</h4>
    ${bg ? `<div class="bgm"><span title="${esc(bg.name || "")}">♪ ${esc(bg.name || "音乐")}</span><button class="pill" data-b="play">试听</button><button class="pill" data-b="rm">移除</button></div>
      <label>音量<input type="range" min="0.05" max="1" step="0.05" value="${bg.volume}" data-bk="volume"><span>${Math.round(bg.volume * 100)}%</span></label>
      <label class="ck"><input type="checkbox" data-bk="duck" ${bg.duck !== false ? "checked" : ""}>有台词和旁白时自动压低音乐</label>`
      : `<button class="pill" data-b="up">上传音乐（mp3 / wav / m4a）</button><div class="h">没有配乐模型，可以用自己的音乐；会自动循环并在结尾淡出</div>`}
    <h4>旁白配音</h4>
    <div id="fmNarr"></div>
    <button class="pill" data-b="narr">＋ 添加一段旁白</button>
    <h4>封面</h4>
    <label>取第<input type="range" min="0" max="${Math.max(0.1, total).toFixed(1)}" step="0.1" value="${Math.min(s.cover || 0, total)}" data-k="cover"><span>${(+s.cover || 0).toFixed(1)}s</span></label>
    <div class="h">导出时把这一帧存为封面图（含字幕）</div>`;
  $$("select[data-k]", set).forEach(x => x.onchange = () => { s[x.dataset.k] = x.dataset.k === "sub_size" ? +x.value : x.value; renderFilm(); });
  $$("input[type=checkbox][data-k]", set).forEach(x => x.onchange = () => { s[x.dataset.k] = x.checked; renderFilm(); });
  const cov = $("input[data-k=cover]", set);
  cov.oninput = () => { s.cover = +cov.value; cov.nextElementSibling.textContent = s.cover.toFixed(1) + "s"; seekTimeline(s.cover); };
  $$("input[data-bk]", set).forEach(x => x.oninput = () => {
    if (x.type === "checkbox") bg.duck = x.checked; else { bg.volume = +x.value; x.nextElementSibling.textContent = Math.round(bg.volume * 100) + "%"; }
  });
  $$("button[data-b]", set).forEach(b => b.onclick = () => ({
    up: () => pickAudio(async f => {
      const fd = new FormData(); fd.append("file", f);
      try { const r = await (await fetchOk("/api/upload_audio", { method: "POST", body: fd })).json(); s.bgm = { ref: r.ref, url: r.url, name: r.name, volume: 0.35, duck: true }; renderFilm(); toast(`已加入背景音乐（${r.seconds.toFixed(0)} 秒）`); }
      catch (e) { toast(e.message, 4000); }
    }),
    rm: () => { s.bgm = null; renderFilm(); },
    play: () => { const a = $("#fmA"); if (!a.paused && a.src.endsWith(bg.url)) { a.pause(); return; } a.src = bg.url; a.volume = bg.volume; a.play(); },
    narr: () => { s.narration.push({ text: "", voice: voiceList?.voices?.[0]?.id || "zf_001", speed: 1, start: +(timelinePos() || 0).toFixed(1), volume: 1 }); renderNarr(); },
  })[b.dataset.b]());
  renderNarr();
}
async function fetchOk(url, opt) { const r = await fetch(url, opt); if (!r.ok) { let m = r.statusText; try { m = (await r.json()).error || m; } catch {} throw new Error(m); } return r; }
function pickAudio(cb) { const i = document.createElement("input"); i.type = "file"; i.accept = "audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg"; i.onchange = () => i.files[0] && cb(i.files[0]); i.click(); }

function renderNarr() {
  const s = FILM.spec, box = $("#fmNarr");
  if (!voiceList) { fetch("/api/voices").then(r => r.json()).then(v => { voiceList = v; if (FILM) renderNarr(); }).catch(() => {}); }
  if (voiceList && !voiceList.available) { box.innerHTML = `<div class="h">配音模型还没装好</div>`; return; }
  const vs = voiceList?.voices || [];
  box.innerHTML = s.narration.map((x, i) => `<div class="nar" data-i="${i}">
      <textarea rows="2" placeholder="写旁白，例如：那天夜里，雨下得很大……">${esc(x.text)}</textarea>
      <div class="nr"><select data-n="voice">${vs.map(v => `<option value="${v.id}" ${v.id === x.voice ? "selected" : ""}>${v.name}</option>`).join("")}</select>
        <button class="pill" data-a="sample" title="试听这个声音">▶</button>
        <select data-n="speed">${[[0.85, "慢"], [1, "正常"], [1.15, "快"]].map(([a, t]) => `<option value="${a}" ${+a === +x.speed ? "selected" : ""}>${t}</option>`).join("")}</select>
        <label>从<input type="number" step="0.1" min="0" value="${x.start}" data-n="start">秒开始</label></div>
      <div class="nr"><button class="pill" data-a="gen">${x.ref ? "重新配音" : "生成配音"}</button>${x.ref ? `<button class="pill" data-a="play">试听 ${x.seconds?.toFixed(1)}s</button>` : ""}<button class="pill" data-a="here" title="把开始时间设为预览里当前的位置">设为当前位置</button><button class="pill" data-a="rm">删除</button></div></div>`).join("");
  $$(".nar", box).forEach(el => {
    const x = s.narration[+el.dataset.i];
    $("textarea", el).oninput = e => { if (x.text !== e.target.value) { x.text = e.target.value; x.ref = null; } };
    $$("[data-n]", el).forEach(f => f.onchange = () => { const k = f.dataset.n; x[k] = k === "voice" ? f.value : +f.value; if (k !== "start") { x.ref = null; renderNarr(); } });
    $$("button[data-a]", el).forEach(b => b.onclick = async () => {
      const a = b.dataset.a;
      if (a === "rm") { s.narration.splice(+el.dataset.i, 1); renderNarr(); }
      else if (a === "sample") { const au = $("#fmA"); au.src = `/static/voices/${x.voice}.wav`; au.volume = 1; au.play(); }
      else if (a === "here") { x.start = +(timelinePos() || 0).toFixed(1); renderNarr(); }
      else if (a === "play") { const au = $("#fmA"); au.src = "/media?ref=" + encodeURIComponent(x.ref); au.volume = 1; au.play(); }
      else if (a === "gen") {
        if (!x.text.trim()) return toast("先写旁白文字");
        b.disabled = true; b.textContent = "配音中…";
        try { const r = await api("/api/tts", { text: x.text, voice: x.voice, speed: x.speed }); x.ref = r.ref; x.seconds = r.seconds; renderNarr(); const au = $("#fmA"); au.src = r.url; au.play(); }
        catch (e) { toast(e.message, 4000); b.disabled = false; b.textContent = "生成配音"; }
      }
    });
  });
}

// ---- preview: one clip (trimmed) or the whole film in sequence, with the subtitles on top
let playAll = false;
function clipStart(i) { const s = FILM.spec; let t = 0; for (let k = 0; k < i; k++) { t += clipLen(s.clips[k]); if (s.clips[k].trans === "fade") t -= 0.5; } return t; }
function timelinePos() { const v = $("#fmV"), c = FILM.spec.clips[FILM.sel]; return c ? clipStart(FILM.sel) + Math.max(0, v.currentTime - (c.in || 0)) : 0; }
function seekTimeline(t) {
  const s = FILM.spec; let i = 0;
  while (i + 1 < s.clips.length && clipStart(i + 1) <= t) i++;
  selectClip(i, t - clipStart(i));
}
function selectClip(i, offset = 0) {
  const F = FILM; if (!F) return; F.sel = i;
  $$("#fmTl .fc").forEach(el => el.classList.toggle("on", +el.dataset.i === i));
  const c = F.spec.clips[i], m = node(c.node), v = curV(m), vid = $("#fmV");
  if (!v) return;
  if (!vid.src.endsWith(v.url)) vid.src = v.url;
  const go = () => { c.src_len = vid.duration || c.src_len; vid.currentTime = (c.in || 0) + offset; renderClipBox(); };
  if (vid.readyState >= 1) go(); else vid.onloadedmetadata = () => { vid.onloadedmetadata = null; go(); };
}
function renderClipBox() {
  const F = FILM, c = F.spec.clips[F.sel], box = $("#fmClip"), L = c.src_len || vlen(node(c.node)), out = c.out ?? L;
  box.innerHTML = `<div class="row"><b>第 ${F.sel + 1} 段 · ${esc(node(c.node)?.name || "")}</b>
      <span class="grow"></span><button class="pill" data-a="in" title="把当前画面设为开始">从这里开始</button><button class="pill" data-a="out" title="把当前画面设为结束">到这里结束</button><button class="pill" data-a="reset">恢复完整</button></div>
    <div class="trim"><span>入点 <b>${(c.in || 0).toFixed(1)}s</b></span><input type="range" min="0" max="${L.toFixed(2)}" step="0.1" value="${c.in || 0}" data-t="in">
      <input type="range" min="0" max="${L.toFixed(2)}" step="0.1" value="${out}" data-t="out"><span>出点 <b>${out.toFixed(1)}s</b></span><span class="dim">保留 ${(out - (c.in || 0)).toFixed(1)}s / 原长 ${L.toFixed(1)}s</span></div>
    <div class="row2"><label>字幕（一行一句，按顺序出现）<textarea rows="2" placeholder="这段没有字幕">${esc(c.subs.join("\n"))}</textarea></label>
      <label class="vol">原声音量<input type="range" min="0" max="1.5" step="0.05" value="${c.volume}"><span>${Math.round(c.volume * 100)}%</span></label></div>`;
  const vid = $("#fmV");
  $$("input[data-t]", box).forEach(r => r.oninput = () => {
    const k = r.dataset.t; let x = +r.value;
    if (k === "in") x = Math.min(x, (c.out ?? L) - 0.5); else x = Math.max(x, (c.in || 0) + 0.5);
    c[k] = +x.toFixed(2); if (k === "out" && c.out >= L - 0.05) c.out = null;
    vid.currentTime = k === "in" ? c.in : x; renderClipBox(); refreshTimelineLabels();
  });
  $$("button[data-a]", box).forEach(b => b.onclick = () => {
    const a = b.dataset.a, t = +vid.currentTime.toFixed(2);
    if (a === "in") c.in = Math.min(t, (c.out ?? L) - 0.5); else if (a === "out") c.out = Math.max(t, (c.in || 0) + 0.5); else { c.in = 0; c.out = null; }
    renderClipBox(); refreshTimelineLabels();
  });
  $("textarea", box).oninput = e => { c.subs = e.target.value.split("\n").map(x => x.trim()).filter(Boolean); };
  $("textarea", box).onblur = () => renderFilm();
  const vr = $(".vol input", box); vr.oninput = () => { c.volume = +vr.value; vr.nextElementSibling.textContent = Math.round(c.volume * 100) + "%"; vid.volume = Math.min(1, c.volume); };
  vid.volume = Math.min(1, c.volume);
}
function refreshTimelineLabels() {
  const s = FILM.spec;
  $$("#fmTl .fc").forEach(el => { const c = s.clips[+el.dataset.i]; const L = clipLen(c); el.style.width = Math.round(90 + L * 22) + "px"; $(".fl span", el).textContent = L.toFixed(1) + "s"; });
  $("#fmTotal").textContent = `${s.clips.length} 段 · ${filmTotal(s).toFixed(1)} 秒`;
}
function previewTick() {
  const F = FILM; if (!F) return;
  const vid = $("#fmV"), c = F.spec.clips[F.sel]; if (!c) return;
  const L = c.src_len || vid.duration || 0, out = c.out ?? L;
  if (!vid.paused && vid.currentTime >= out - 0.04) {
    if (playAll && F.sel + 1 < F.spec.clips.length) { selectClip(F.sel + 1); vid.play(); } else { vid.pause(); playAll = false; }
  }
  if (!vid.paused && vid.currentTime < (c.in || 0) - 0.1) vid.currentTime = c.in || 0;
  // subtitle overlay: the same spread as the renderer
  const sub = $("#fmSub"), lines = F.spec.subtitles ? c.subs : [];
  let txt = "";
  if (lines.length) {
    const len = out - (c.in || 0), t = vid.currentTime - (c.in || 0), a = 0.15, b = Math.max(0.3, len - 0.15);
    const w = lines.map(x => x.length + 4), tot = w.reduce((p, q) => p + q, 0); let st = a;
    lines.forEach((x, k) => { const d = (b - a) * w[k] / tot; if (t >= st && t < st + d) txt = x; st += d; });
  }
  sub.textContent = txt; sub.style.fontSize = (F.spec.sub_size || 1) * 100 + "%"; sub.style.display = txt ? "" : "none";
}
function addClipMenu(e) {
  const have = new Set(FILM.spec.clips.map(c => c.node));
  const vids = byPosition(B.nodes.filter(m => m.type === "video" && curV(m) && !m.data.film).map(m => m.id));
  const m = $("#fmAdd");
  m.innerHTML = `<div class="mt">点击加到成片末尾</div>` + (vids.map(v => `<button data-id="${v.id}">${esc(v.name)}<span class="k">${have.has(v.id) ? "已在成片中" : vlen(v).toFixed(1) + "s"}</span></button>`).join("") || `<div class="h" style="padding:8px">画布上没有其他视频</div>`);
  m.classList.add("on");
  const r = e.target.getBoundingClientRect();
  m.style.left = Math.min(r.left, innerWidth - m.offsetWidth - 8) + "px"; m.style.top = Math.max(8, r.top - m.offsetHeight - 8) + "px";
  $$("button", m).forEach(b => b.onclick = () => {
    m.classList.remove("on"); const v = node(b.dataset.id);
    FILM.spec.clips.push({ node: v.id, in: 0, out: null, trans: "cut", subs: subsOf(v), volume: 1 }); renderFilm(); selectClip(FILM.spec.clips.length - 1);
  });
}

// ---- export: create / update the film node and render it as a job
async function exportFilm() {
  const F = FILM, s = F.spec;
  const clips = s.clips.map(c => ({ c, v: curV(node(c.node)) }));
  if (clips.some(x => !x.v)) return toast("有片段的视频已被删除或还没生成，先移除它");
  const pending = s.narration.filter(x => x.text.trim() && !x.ref);
  for (const x of pending) {
    toast(`正在为旁白配音（${pending.indexOf(x) + 1}/${pending.length}）…`, 8000);
    try { const r = await api("/api/tts", { text: x.text, voice: x.voice, speed: x.speed }); x.ref = r.ref; x.seconds = r.seconds; }
    catch (e) { return toast("旁白配音失败：" + e.message, 5000); }
  }
  const spec = {
    clips: clips.map(({ c, v }) => ({ ref: v.ref, in: c.in || 0, out: c.out, trans: c.trans, volume: c.volume, subs: c.subs })),
    aspect: s.aspect, fit: s.fit, subtitles: s.subtitles, sub_size: s.sub_size, cover: s.cover || 0,
    bgm: s.bgm ? { ref: s.bgm.ref, volume: s.bgm.volume, duck: s.bgm.duck !== false } : null,
    narration: s.narration.filter(x => x.ref).map(x => ({ ref: x.ref, start: x.start, volume: x.volume || 1 })),
  };
  checkpoint();
  let n = F.n && node(F.n.id);
  if (!n) {
    const src = clips.map(x => node(x.c.node)), right = src.reduce((a, b) => (b.x + size(b).w > a.x + size(a).w ? b : a));
    const at = freeSpot(right.x + size(right).w + 110, right.y, "video");
    n = addNode("video", at.x, at.y, { aspect: s.aspect === "source" ? "auto" : s.aspect }, { name: "成片" });
    F.n = n;
  }
  const keep = JSON.parse(JSON.stringify(s)); keep.clips.forEach(c => delete c.src_len);
  n.data.film = keep;
  try {
    const r = await api("/api/render", { spec, label: n.name });
    n.job = { ids: r.ids, prompt: "", t0: Date.now(), st: {} }; save(); render(n); poll();
    closeFilm(); selectOnly(n.id); fit([n]);
    toast(`正在合成成片（约 ${fmtT(r.meta.est)}），完成后可以在节点上播放和下载`, 4000);
  } catch (e) { toast("合成失败：" + e.message, 5000); }
}

// ================================================================= queue panel + ETAs + "all done"
let qOpen = false, qTimer = null;
const clock = sec => { const d = new Date(Date.now() + sec * 1000); return d.toTimeString().slice(0, 5); };
async function renderQueue() {
  const box = $("#qp");
  let q; try { q = await (await fetch("/api/queue")).json(); } catch { box.innerHTML = `<div class="h">连不上画布服务</div>`; return; }
  const byJob = new Map(); B.nodes.forEach(n => n.job?.ids.forEach(i => byJob.set(i, n)));
  box.innerHTML = `<div class="mt">任务队列${q.jobs.length ? ` · 全部完成约 ${fmtT(q.total)}（${clock(q.total)}）` : ""}</div>` +
    (q.jobs.map(j => {
      const n = byJob.get(j.id), pct = j.max ? Math.round((j.value || 0) / j.max * 100) : 0;
      return `<div class="qj ${j.state}"><span class="ty">${{ image: "图片", video: "视频", render: "成片" }[j.kind] || ""}</span>
        <span class="nm" ${n ? `data-n="${n.id}" title="在画布上定位"` : ""}>${esc(n?.name || j.label)}</span>
        <span class="st">${j.state === "running" ? (pct ? `${pct}%` : "进行中") : "排队"} · ${j.state === "running" ? "还要" : ""}约 ${fmtT(j.eta)}</span>
        <button class="x" data-id="${j.id}" title="取消">×</button></div>`;
    }).join("") || `<div class="h">没有进行中的任务</div>`) +
    (q.foreign ? `<div class="h">另有 ${q.foreign} 个其他来源的任务在 ComfyUI 排队</div>` : "") +
    `<div class="h">可以关掉网页，任务会在 4090 上继续跑；回来后结果会自动出现在画布上</div>`;
  $$(".qj .x", box).forEach(b => b.onclick = async e => { e.stopPropagation(); await api("/api/cancel", { ids: [b.dataset.id] }).catch(() => {}); renderQueue(); });
  $$(".qj .nm[data-n]", box).forEach(s => s.onclick = () => { const n = node(s.dataset.n); if (n) { selectOnly(n.id); fit([n]); } });
}
function toggleQueue(on = !qOpen) {
  qOpen = on; $("#qp").classList.toggle("on", on); clearInterval(qTimer);
  if (on) { renderQueue(); qTimer = setInterval(renderQueue, 2000); }
}
let wasBusy = false, doneCount = 0;
function watchDone() {
  const busy = !!B && B.nodes.some(n => n.job);
  if (wasBusy && !busy) notifyDone();
  wasBusy = busy;
}
function notifyDone() {
  toast("✓ 全部任务已完成", 5000);
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)(), o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = 880; o.connect(g); g.connect(ac.destination); g.gain.setValueAtTime(0.12, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.6); o.start(); o.stop(ac.currentTime + 0.6);
  } catch {}
  if (document.hidden) {
    doneCount++; document.title = "✓ 生成完成 · OneShot";
    if (window.Notification && Notification.permission === "granted") try { new Notification("OneShot", { body: "全部任务已完成" }); } catch {}
  }
}

// ================================================================= wiring
function initFilm() {
  const css = document.createElement("style");
  css.textContent = `
#film { position: fixed; inset: 0; z-index: 60; background: #0b0b0c; display: none; flex-direction: column; }
#film.on { display: flex; }
#film .hd { display: flex; align-items: center; gap: 12px; padding: 12px 18px; border-bottom: 1px solid var(--line); }
#film .hd b { font-size: 15px; } #film .hd .dim, #film .dim { color: var(--dim); font-size: 12px; }
#film .main { flex: 1; min-height: 0; display: flex; gap: 16px; padding: 16px 18px 8px; }
#film .pv { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
#film .scr { position: relative; flex: 1; min-height: 0; background: #000; border-radius: 12px; overflow: hidden; display: flex; align-items: center; justify-content: center; }
#film .scr video { max-width: 100%; max-height: 100%; }
#fmSub { position: absolute; left: 5%; right: 5%; bottom: 7%; text-align: center; color: #fff; font-size: 100%; font-weight: 600; pointer-events: none;
  text-shadow: 0 0 3px #000, 0 0 3px #000, 0 0 6px #000; font-size: clamp(14px, 2.4vw, 30px); }
#fmClip { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
#fmClip .row, #fmClip .trim, #fmClip .row2 { display: flex; align-items: center; gap: 10px; }
#fmClip .grow { flex: 1; } #fmClip .trim input { flex: 1; accent-color: #ffb36b; }
#fmClip .row2 label { display: flex; flex-direction: column; gap: 4px; color: var(--dim); font-size: 12px; flex: 1; }
#fmClip .row2 label.vol { flex: 0 0 180px; } #fmClip .row2 .vol input { width: 100%; }
#fmClip textarea, #fmNarr textarea { width: 100%; resize: vertical; background: #111113; border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; color: var(--text); }
#fmSet { width: 330px; flex: none; overflow-y: auto; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 4px 14px 14px; display: flex; flex-direction: column; gap: 8px; }
#fmSet h4 { margin: 12px 0 0; font-size: 12px; color: var(--dim); font-weight: 600; letter-spacing: .5px; }
#fmSet label { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
#fmSet label select { flex: 1; background: #222226; border: 1px solid var(--line); border-radius: 8px; padding: 4px 6px; }
#fmSet label input[type=range] { flex: 1; } #fmSet .h, #qp .h { color: var(--faint); font-size: 11.5px; line-height: 1.5; }
#fmSet .bgm { display: flex; align-items: center; gap: 6px; } #fmSet .bgm span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nar { border: 1px solid var(--line); border-radius: 10px; padding: 8px; display: flex; flex-direction: column; gap: 6px; margin-bottom: 6px; }
.nar .nr { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; }
.nar select { background: #222226; border: 1px solid var(--line); border-radius: 7px; padding: 3px 4px; }
.nar input[type=number] { width: 56px; background: #111113; border: 1px solid var(--line); border-radius: 6px; padding: 2px 4px; margin: 0 4px; }
.nar .pill { height: 26px; }
#fmTl { display: flex; align-items: stretch; gap: 0; overflow-x: auto; padding: 10px 18px 16px; border-top: 1px solid var(--line); min-height: 128px; }
#fmTl .fc { position: relative; flex: none; height: 104px; border-radius: 10px; overflow: hidden; background: #000; border: 2px solid transparent; cursor: pointer; }
#fmTl .fc.on { border-color: #ffb36b; } #fmTl .fc.over { border-color: var(--blue); } #fmTl .fc.drag { opacity: .4; }
#fmTl .fc video { width: 100%; height: 100%; object-fit: cover; pointer-events: none; }
#fmTl .fl { position: absolute; left: 0; right: 0; top: 0; padding: 4px 7px; font-size: 11.5px; background: linear-gradient(#000c, #0000); display: flex; gap: 4px; white-space: nowrap; overflow: hidden; }
#fmTl .fl span { margin-left: auto; color: #ddd; }
#fmTl .fs { position: absolute; left: 0; right: 0; bottom: 0; padding: 3px 7px; font-size: 11px; background: #000a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#fmTl .x { position: absolute; right: 4px; bottom: 22px; width: 20px; height: 20px; border-radius: 50%; border: none; background: #000b; color: #fff; display: none; }
#fmTl .fc:hover .x { display: block; }
#fmTl .ft { flex: none; align-self: center; margin: 0 4px; padding: 3px 7px; font-size: 11px; border-radius: 8px; border: 1px solid var(--line2); background: #1b1b1f; color: #cfcfd5; writing-mode: vertical-rl; letter-spacing: 2px; }
#fmTl .fadd { flex: none; align-self: center; margin-left: 12px; height: 104px; padding: 0 16px; border-radius: 10px; border: 1px dashed var(--line2); background: none; color: var(--dim); }
#fmGo { background: #fff; color: #000; font-weight: 600; }
#qp { position: fixed; top: 54px; right: 14px; z-index: 31; width: 360px; max-height: 70vh; overflow-y: auto; display: none; flex-direction: column; gap: 4px; padding: 8px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 13px; box-shadow: 0 12px 40px rgba(0,0,0,.55); }
#qp.on { display: flex; } #qp .mt { padding: 4px 6px 6px; color: var(--dim); font-size: 12px; }
#qp .qj { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 9px; background: #1a1a1d; font-size: 12.5px; }
#qp .qj .ty { color: var(--faint); font-size: 11px; width: 26px; } #qp .qj .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#qp .qj .nm[data-n] { cursor: pointer; } #qp .qj .nm[data-n]:hover { text-decoration: underline; }
#qp .qj.running .st { color: #ffcf5a; } #qp .qj .st { color: var(--dim); font-size: 11.5px; white-space: nowrap; }
#qp .qj .x { border: none; background: none; color: var(--faint); font-size: 15px; } #qp .qj .x:hover { color: var(--red); }
#qp .h { padding: 4px 6px; }
#tr { cursor: pointer; }`;
  document.head.appendChild(css);
  document.body.insertAdjacentHTML("beforeend", `
<div id="film">
  <div class="hd"><b>成片编辑</b><span class="dim" id="fmTotal"></span><span style="flex:1"></span>
    <button class="pill" id="fmAll" title="从头连续播放（含转场以外的效果）">▶ 预览全片</button>
    <button class="pill" id="fmClose">关闭</button><button class="pill" id="fmGo">导出成片</button></div>
  <div class="main">
    <div class="pv"><div class="scr"><video id="fmV" controls playsinline></video><div id="fmSub"></div></div><div id="fmClip"></div></div>
    <div id="fmSet"></div>
  </div>
  <div id="fmTl"></div>
  <audio id="fmA"></audio>
</div>
<div class="menu" id="fmAdd"></div>
<div id="qp"></div>`);
  $("#fmClose").onclick = closeFilm;
  $("#fmGo").onclick = exportFilm;
  $("#fmAll").onclick = () => { playAll = true; selectClip(0); setTimeout(() => $("#fmV").play(), 100); };
  setInterval(previewTick, 50);
  $("#tr").addEventListener("click", e => { e.stopPropagation(); toggleQueue(); });
  document.addEventListener("pointerdown", e => {
    if (qOpen && !e.target.closest("#qp, #tr")) toggleQueue(false);
    if (!e.target.closest("#fmAdd, .fadd")) $("#fmAdd").classList.remove("on");
  });
  document.addEventListener("keydown", e => { if (FILM && e.key === "Escape") { e.stopPropagation(); closeFilm(); } }, true);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && doneCount) { doneCount = 0; document.title = "OneShot"; } });
  if (window.Notification && Notification.permission === "default") document.addEventListener("pointerdown", () => { try { Notification.requestPermission(); } catch {} }, { once: true });
  setInterval(watchDone, 1500);
}
