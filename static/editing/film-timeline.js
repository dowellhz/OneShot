"use strict";

function renderFilm() {
  closePlaylistClipMenu();
  const F = FILM, s = F.spec, total = filmTotal(s);
  alignStoryDubbing(s);
  const playlist = !!F.n?.data.playlist, editable = canvasCanEdit();
  if (playlist) $("#fmGo").disabled = !editable || F.busy || !s.clips.length;
  $("#fmDownloadMerged").disabled = !editable || F.busy || !s.clips.length;
  $("#fmExportCanvas").disabled = $("#fmDownloadMerged").disabled;
  $("#fmAll").disabled = !s.clips.length;
  $("#fmPlaylistSources").disabled = !!F.sourceDownload || !s.clips.length;
  $("#fmTotal").textContent = filmTotalLabel(s,total);
  $("#fmTiming").hidden=!s.clips.some(clip=>clip.kind==="video" && Number.isSafeInteger(clip.story_frames) && clip.story_frames>0);
  // timeline strip
  const tl = $("#fmTl");
  tl.innerHTML = s.clips.map((c, i) => {
    const m = node(c.node), v = filmVersion(c), L = clipLen(c);
    const lines = c.captions ? c.captions.map(cue => cue.text).filter(Boolean) : c.subs;
    const preview = v && (c.kind === "image" ? `<img src="${esc(v.url)}" alt="">` :
      `<video src="${esc(v.url)}#t=${(c.in || 0) + Math.min(.05,L/2)}" preload="metadata" muted></video>`);
    return `<div class="fc ${i === F.sel ? "on" : ""}" draggable="${!playlist || editable}" data-i="${i}" style="width:${Math.round(90 + L * 22)}px">
        ${preview || ""}
        <div class="fl"><b>${i + 1}</b> ${esc(c.name || m?.name || "已删除")}<span>${displayClipSeconds(c)}s</span></div>
        ${lines.length && s.subtitles ? `<div class="fs">${esc(lines[0])}${lines.length > 1 ? " …" : ""}</div>` : ""}
        ${editable&&c.kind!=="image"?'<span class="fm-trim-edge" data-trim-edge="in" title="拖动入点" aria-hidden="true"></span><span class="fm-trim-edge" data-trim-edge="out" title="拖动出点" aria-hidden="true"></span>':""}
        ${playlist?'<button class="fm-clip-menu" type="button" aria-label="片段操作" aria-haspopup="true">⋯</button>':""}
        <button class="x" title="从成片中移除">×</button></div>` +
      (i + 1 < s.clips.length ? `<button class="ft" data-i="${i}" title="点击切换转场">${TRANS_CN[c.trans] || "硬切"}</button>` : "");
  }).join("") + `<button class="fadd" title="添加画布上的图片或视频">＋ 添加片段</button>`;
  $$(".fc", tl).forEach(el => {
    const i = +el.dataset.i;
    const clip=s.clips[i];
    el.onclick = e => { if (e.target.closest(".x,.fm-clip-menu,[data-trim-edge]")) return; selectClip(i); };
    for(const handle of $$("[data-trim-edge]",el))bindFilmTrimEdge(F,i,handle);
    $(".x", el).onclick = () => removeFilmClip(F,clip);
    const menu=$(".fm-clip-menu",el);
    if(menu){
      menu.onclick=()=>{
        const pos=menu.getBoundingClientRect();
        showPlaylistClipMenu(F,clip,menu,pos.left,pos.bottom+5);
      };
      el.oncontextmenu=e=>{
        e.preventDefault();
        showPlaylistClipMenu(F,clip,menu,e.clientX,e.clientY);
      };
    }
    el.addEventListener("dragstart", e => { e.dataTransfer.setData("text/x-clip", String(i)); el.classList.add("drag"); });
    el.addEventListener("dragend", () => el.classList.remove("drag"));
    el.addEventListener("dragover", e => { e.preventDefault(); el.classList.add("over"); });
    el.addEventListener("dragleave", () => el.classList.remove("over"));
    el.addEventListener("drop", e => {
      e.preventDefault(); el.classList.remove("over");
      const source = e.dataTransfer.getData("text/x-clip"), from = Number(source);
      if (!source || !Number.isInteger(from) || from < 0 || from >= s.clips.length || from === i) return;
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
  set.innerHTML = OneShotI18n.html`
    <h4>画面</h4>
    <label>画幅${opt("aspect", ASPECT_CN, s.aspect)}</label>
    ${s.aspect !== "source" ? `<label>比例不同时${opt("fit", FIT_CN, s.fit)}</label>` : ""}
    <div class="fm-dubbing-heading"><h4>视频配音</h4>
      ${editable ? OneShotI18n.html`<button class="pill" type="button" data-b="narr">＋ 添加配音</button>` : ""}</div>
    ${editable ? OneShotI18n.html`<div class="h" data-dubbing-empty ${s.narration.length ? "hidden" : ""}>把播放头移到要开口的位置，再添加一段旁白或台词。</div>` : ""}
    <div id="fmNarr"></div>
    ${editable ? '<div data-story-dubbing></div>' : ""}
    <h4>补画面</h4>
    ${canvasCanEdit() ? `<select id="fmCutawaySource" aria-label="在播放头添加补画面"><option value="">在播放头添加补画面</option>${B.nodes.filter(filmSource).map(n=>
      `<option value="${esc(n.id)}">${esc(n.name)} · 版本 ${n.cur+1}</option>`).join("")}</select>` : ""}
    <div id="fmCutawaySettings"></div>
    <h4>画面标题</h4>
    ${canvasCanEdit() ? '<button class="pill" type="button" data-b="title">＋ 在播放头添加标题</button>' : ""}
    <div id="fmTitleSettings"></div>
    <h4>字幕</h4>
    <label class="ck"><input type="checkbox" data-k="subtitles" ${s.subtitles ? "checked" : ""}>导出时烧录字幕</label>
    ${s.subtitles ? `<label>字号${opt("sub_size", { 0.8: "小", 1: "中", 1.25: "大" }, s.sub_size)}</label>` : ""}
    <h4>背景音乐</h4>
    ${bg ? OneShotI18n.html`<div class="bgm"><span title="${esc(bg.name || "")}">♪ ${esc(bg.name || "音乐")}</span><button class="pill" data-b="play">试听</button><button class="pill" data-b="rm">移除</button></div>
      <label>音量<input type="range" min="0.05" max="1" step="0.05" value="${bg.volume}" data-bk="volume"><span>${Math.round(bg.volume * 100)}%</span></label>
      <label class="ck"><input type="checkbox" data-bk="duck" ${bg.duck !== false ? "checked" : ""}>有台词和旁白时自动压低音乐</label>`
      : ""}
    ${editable ? OneShotI18n.html`<button class="pill" data-b="up">上传音乐（mp3 / wav / m4a）</button><div id="fmMusicMaker"></div>` : ""}
    <h4>音频片段</h4>
    <div id="fmAudioSettings"></div>
    <button class="pill" data-b="audio">＋ 上传到当前播放位置</button>
    <select id="fmCanvasAudio" aria-label="选用画布音频"><option value="">选用画布音频</option>${B.nodes.filter(n=>n.type==="audio"&&curV(n)?.seconds).map(n=>`<option value="${esc(n.id)}">${esc(n.name)} · 版本 ${n.cur+1}</option>`).join("")}</select>
    <h4>封面</h4>
    <label>取第<input type="range" min="0" max="${Math.max(0.1, total).toFixed(1)}" step="0.1" value="${Math.min(s.cover || 0, total)}" data-k="cover"><span>${(+s.cover || 0).toFixed(1)}s</span></label>
    <div class="h">取这一帧作为封面，包含当时显示的标题和字幕。</div>`;
  $$("select[data-k]", set).forEach(x => x.onchange = () => { s[x.dataset.k] = x.dataset.k === "sub_size" ? +x.value : x.value; renderFilm(); });
  $$("input[type=checkbox][data-k]", set).forEach(x => x.onchange = () => { s[x.dataset.k] = x.checked; renderFilm(); });
  const cov = $("input[data-k=cover]", set);
  cov.oninput = () => { s.cover = +cov.value; cov.nextElementSibling.textContent = s.cover.toFixed(1) + "s"; seekTimeline(s.cover); };
  $$("input[data-bk]", set).forEach(x => x.oninput = () => {
    if (x.type === "checkbox") bg.duck = x.checked; else { bg.volume = +x.value; x.nextElementSibling.textContent = Math.round(bg.volume * 100) + "%"; }
  });
  $$("button[data-b]", set).forEach(b => b.onclick = () => ({
    title: () => addFilmTitle(F),
    up: () => uploadFilmAudio(F, false),
    audio: () => uploadFilmAudio(F, true),
    rm: () => { s.bgm = null; renderFilm(); },
    play: () => { const a = $("#fmA"); if (!a.paused && a.src.endsWith(bg.url)) { a.pause(); return; } a.src = bg.url; a.volume = bg.volume; a.play(); },
    narr: () => addFilmDubbing(F),
  })[b.dataset.b]());
  const canvasAudio=$("#fmCanvasAudio",set);
  canvasAudio.onchange=()=>{
    const n=node(canvasAudio.value), v=curV(n);
    canvasAudio.value="";
    if (!v?.seconds) return;
    addFilmAudio(F,{ref:v.ref,name:n.name,seconds:v.seconds,node:n.id},+timelinePos().toFixed(2));
  };
  const cutawaySource = $("#fmCutawaySource",set);
  if (cutawaySource) cutawaySource.onchange = () => {
    const media = node(cutawaySource.value);
    cutawaySource.value = "";
    if (filmSource(media)) addFilmCutaway(F,media);
  };
  renderNarr();
  renderStoryDubbing(F);
  renderFilmMusic(F);
  renderFilmAudio();
  renderFilmTitles();
  renderFilmCutaways();
}

function refreshTimelineLabels() {
  const s = FILM.spec;
  $$("#fmTl .fc").forEach(el => { const c = s.clips[+el.dataset.i]; const L = clipLen(c); el.style.width = Math.round(90 + L * 22) + "px"; $(".fl span", el).textContent = displayClipSeconds(c) + "s"; });
  const total = filmTotal(s);
  $("#fmTotal").textContent = filmTotalLabel(s,total);
  const cover = $("#fmSet [data-k=cover]");
  if (cover) {
    cover.max = Math.max(.1, total).toFixed(1);
    s.cover = Math.min(s.cover || 0, total);
    cover.value = s.cover;
    cover.nextElementSibling.textContent = s.cover.toFixed(1) + "s";
  }
  renderFilmAudioLanes();
  renderFilmTitleLane();
  renderFilmCutawayLane();
}
