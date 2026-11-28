"use strict";
// Timeline editor state, lifecycle, and event wiring.

const TRANS_CN = { cut: "硬切", fade: "叠化", black: "黑场" };
const FIT_CN = { pad: "加黑边", blur: "模糊背景填充", crop: "裁切铺满" };
const ASPECT_CN = { source: "跟随原片", "16:9": "横屏 16:9", "9:16": "竖屏 9:16", "1:1": "方形 1:1", "4:3": "4:3", "3:4": "3:4" };
const FILM_FPS = 24;
let FILM = null;            // { n (film node or null), spec, sel, srcIds }
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
function filmVersion(c) {
  return c.ref ? {ref:c.ref, url:remakeMedia(c.ref), seconds:c.media_seconds} : curV(node(c.node));
}
function filmMediaLength(c) { return c.src_len || filmVersion(c)?.seconds || vlen(node(c.node)); }
function filmSpeed(c) { return c.kind !== "image" && Number.isFinite(c.speed) && c.speed >= .5 && c.speed <= 2 ? c.speed : 1; }
function clipLen(c) {
  if (c.kind === "image") return c.duration;
  const seconds = (c.out ?? filmMediaLength(c)) - (c.in || 0), speed = filmSpeed(c);
  if (speed !== 1) return Math.max(1, Math.round(seconds / speed * FILM_FPS)) / FILM_FPS;
  return Math.max(c.remake_shot || c.tight ? 0 : .5, seconds);
}
const displayClipSeconds = c => clipLen(c).toFixed(c.story_frames ? 2 : 1);

function filmSource(n) { return n && ["image", "video"].includes(n.type) && curV(n); }
function newFilmClip(n) { return filmClipForVersion(n,curV(n)); }
function filmClipForVersion(n, v) {
  const data = v === curV(n) ? n.data : v.node_data;
  return {node:n.id, kind:n.type, ref:v.ref, name:n.name, trans:"cut", volume:1, subs:subsOf({data}),
    ...(n.type === "image" ? {duration:3} : {in:0, out:null, media_seconds:v.seconds || data?.duration || 5})};
}
function clipOverlap(c, next) {
  if (c?.trans !== "fade" || !next) return 0;
  const fps = FILM_FPS;
  return Math.min(fps / 2, Math.floor(Math.round(clipLen(c) * fps) / 2),
    Math.floor(Math.round(clipLen(next) * fps) / 2)) / fps;
}
function filmTotal(spec) {
  let t = 0;
  spec.clips.forEach((c, i) => { t += clipLen(c) - clipOverlap(c, spec.clips[i + 1]); });
  return Math.max(0, t);
}
const filmTotalLabel = (spec,total) => `${spec.clips.length} 段 · ${total.toFixed(spec.clips.some(c=>c.story_frames) ? 2 : 1)} 秒`;
function newSpec(media) {
  return {
    clips: media.map(newFilmClip),
    aspect: "source", fit: "blur", subtitles: true, sub_size: 1, titles:[], cutaways:[], bgm: null, narration: [], audio_clips:[], cover: 0,
  };
}

// open the editor: on a film node (re-edit), or with a list of shot videos (new film)
function openFilm(arg) {
  let n = null, spec;
  if (arg && !Array.isArray(arg) && arg.data?.film) { n = arg; spec = JSON.parse(JSON.stringify(n.data.film)); }
  else {
    const media = (arg || []).filter(filmSource);
    if (!media.length) return toast("先选择至少一张图片或一段视频");
    spec = newSpec(media);
  }
  return showFilm(spec, n);
}
function editVideoTimeline(n, version = curV(n)) {
  if (!canvasCanEdit() || !version?.ref || !n.versions.includes(version)) return;
  if (n.job || prepping.has(n.id)) return toast("请等待当前视频任务完成后再剪辑");
  const target = {id:n.id, ref:version.ref};
  const key = filmDraftPrefix() + "video:" + JSON.stringify([target.id,target.ref]);
  const saved = version.film_recipe?.timeline;
  const spec = saved?.clips?.length ? vtClone(saved) : {...newSpec([]),clips:[filmClipForVersion(n,version)]};
  return showFilm(spec, null, key, target);
}
function showFilm(spec, n = null, key = filmDraftKey(spec, n), target = null, story = null) {
  if (target && !node(target.id)?.versions.some(v => v.ref === target.ref)) return toast("剪辑草稿对应的视频版本已移除");
  closeStoryDraftPicker();
  closeStorySlowdown();
  closeFilmStoryTiming();
  stopFilmVersionPreview(FILM);
  finishFilmPlaylistPicker(false,false);
  if (FILM) { saveFilmDraft(); syncFilmAudio(FILM); FILM.tracks?.waveformObserver?.disconnect(); }
  playAll = false;
  let saved;
  try { saved = JSON.parse(localStorage.getItem(key)); } catch {}
  const playlistBase = n?.data.playlist ? JSON.stringify(n.data.film) : undefined;
  if (playlistBase && (saved?.playlistBase !== playlistBase || !canvasCanEdit())) saved = null;
  if (saved?.spec?.clips?.length || playlistBase && Array.isArray(saved?.spec?.clips)) {
    spec = spec.story_script ? {...saved.spec,story_script:spec.story_script} : saved.spec;
    refreshStoryClipPlans(spec,story);
  }
  const sel = Math.max(0, Math.min(spec.clips.length - 1, saved?.sel || 0));
  FILM = {n:saved?.node ? node(saved.node) || n : n, target, spec, sel, key, board:boardId, story,
    storySource:story?.scope[0] || saved?.storySource,attempt:saved?.attempt,
    canvasAttempt:saved?.canvasAttempt,downloadExport:saved?.downloadExport,playlistBase};
  $("#fmStoryReuse").hidden=!(story && canvasCanEdit() && !FILM.n && story.base===storyDraftSignature(spec) && earlierStoryDrafts(FILM).length);
  $("#fmHeading").textContent = playlistBase ? n.name : "成片编辑";
  $("#film").classList.toggle("playlist-review",!!playlistBase && !canvasCanEdit());
  $("#fmSaveList").hidden = !playlistBase || !canvasCanEdit();
  $("#fmPlaylistSources").hidden = !playlistBase;
  $("#fmDownloadMerged").hidden = !playlistBase || !canvasCanEdit();
  $("#fmExportCanvas").hidden = !playlistBase || !canvasCanEdit();
  $("#fmDownloadStatus").textContent = "";
  $("#fmGo").textContent = target ? "导出为新版本" : "导出成片";
  $("#fmGo").disabled = !canvasCanEdit();
  $("#film").classList.add("on");
  renderFilm(); selectClip(sel, saved?.offset || 0); renderFilmTrackEditor();
  if (voiceList) loadDubbingVoices();
  saveFilmDraft();
  return FILM;
}
function closeFilm() {
  closeStoryDraftPicker();
  closeStorySlowdown();
  closeFilmStoryTiming();
  stopFilmVersionPreview(FILM);
  closePlaylistClipMenu();
  finishFilmPlaylistPicker(false,false);
  saveFilmDraft(); if (FILM) syncFilmAudio(FILM);
  FILM?.tracks?.waveformObserver?.disconnect();
  playAll = false; FILM = null;
  renderFilmTrackEditor();
  clearFilmCutawayPreview();
  const transfer=$("#assetTransferPanel");
  if (transfer.parentElement===$("#film")) document.body.append(transfer);
  $("#film").classList.remove("on"); $("#fmAdd").classList.remove("on");
  for (const id of ["fmV", "fmOriginal", "fmA"]) {
    const media = $("#"+id);
    if (!media.paused) media.pause();
  }
}

async function fetchOk(url, opt) { const r = await fetch(url, opt); if (!r.ok) { let m = r.statusText; try { m = (await r.json()).error || m; } catch {} throw new Error(m); } return r; }
// ================================================================= wiring
function initFilm() {
  const css = document.createElement("style");
  css.textContent = `
#film { position: fixed; inset: 0; z-index: 60; background: #0b0b0c; display: none; flex-direction: column; }
#film.on { display: flex; }
#film.playlist-review :is(#fmSet,#fmTl .x,#fmTl .fadd,#fmTl .ft,#fmClip .trim,#fmClip .row2,#fmClip .fm-caption-actions,#fmClip button:not([data-playlist-locate])) { display:none; }
#film .hd { display: flex; align-items: center; gap: 12px; padding: 12px 18px; border-bottom: 1px solid var(--line); }
#film .hd b { font-size: var(--fs-heading); } #film .hd .dim, #film .dim { color: var(--dim); font-size: var(--fs-small); }
:is(#fmStoryDialog,#fmSlowdownDialog,#fmTimingDialog) { width:min(550px,calc(100vw - 30px)); max-height:85vh; z-index:66; margin:auto; padding:18px;
  border:1px solid var(--line2); border-radius:14px; background:var(--panel); color:var(--text); }
:is(#fmStoryDialog,#fmSlowdownDialog,#fmTimingDialog)::backdrop { background:#0009; }
:is(#fmStoryDialog,#fmSlowdownDialog,#fmTimingDialog) h2 { font-size:var(--fs-heading); margin:0; }
:is(#fmStoryDialog,#fmSlowdownDialog,#fmTimingDialog) form { display:grid; gap:12px; }
#fmStoryDialog label { display:grid; gap:5px; }
#fmStoryDialog select { min-width:0; color:var(--text); background:var(--card); border:1px solid var(--line2); border-radius:7px; padding:7px; }
#fmStoryDialog ol { margin:0; padding-left:22px; max-height:34vh; overflow:auto; line-height:1.65; }
:is(#fmStoryDialog,#fmSlowdownDialog,#fmTimingDialog) p { margin:0; color:var(--dim); font-size:var(--fs-small); }
:is(#fmStoryDialog,#fmSlowdownDialog,#fmTimingDialog) footer { display:flex; justify-content:flex-end; gap:8px; }
#fmSlowdownDialog video { width:100%; max-height:52vh; object-fit:contain; background:#080809; border-radius:8px; }
#fmTimingDialog ul { max-height:48vh; overflow:auto; padding:0; margin:0; list-style:none; }
#fmTimingDialog li { display:flex; align-items:center; gap:10px; padding:10px 0; border-bottom:1px solid var(--line); }
#fmTimingDialog li span { min-width:0; flex:1; overflow-wrap:anywhere; }
#fmTimingDialog li small { display:block; margin-top:4px; color:var(--dim); }
#fmTimingDialog li label { font-size:var(--fs-small); white-space:nowrap; }
#fmDownloadStatus:empty { display:none; }
@media (max-width:950px) { #film .hd { flex-wrap:wrap; gap:6px; } }
#film .main { flex: 1; min-height: 0; display: flex; gap: 16px; padding: 16px 18px 8px; }
#film .pv { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
#film .scr { position: relative; flex: 1; min-height: 0; background: #000; border-radius: 12px; overflow: hidden; display: flex; align-items: center; justify-content: center; }
#film .scr :is(video, img) { max-width: 100%; max-height: 100%; object-fit: contain; }
#film-output .fm-output-layer { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); overflow:hidden; container-type:size; pointer-events:none;
  width:var(--fm-frame-width,100%); height:var(--fm-frame-height,100%); }
#fmCutawayLayer { background:#000; }
#film .scr #fmCutawayLayer :is(video,img) { display:block; width:100%; height:100%; object-fit:cover; }
.fm-title-block { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); max-width:86%; box-sizing:border-box; color:white;
  font-size:max(8px,min(7.5cqw,7.5cqh)); line-height:1.22; font-weight:600; text-align:center; overflow-wrap:anywhere;
  text-shadow:0 0 3px #000,0 1px 4px #000; }
.fm-title-block[data-position=top] { top:13%; font-size:max(8px,min(5cqw,5cqh)); }
.fm-title-block[data-position=lower_left] { top:76%; left:7%; transform:translateY(-50%); max-width:72%; text-align:left; font-size:max(8px,min(5cqw,5cqh)); }
.fm-title-block[data-style=label] { padding:.4em; border-radius:.4em; background:#141417dc; text-shadow:none; }
#fmStillControls { display: flex; align-items: center; gap: 10px; }
#fmStillControls[hidden] { display: none; }
#fmExportCanvas[hidden] { display: none; }
#fmStillSeek { flex: 1; accent-color: var(--c-image); }
#fmClip .still-duration { font-size: var(--fs-small); color: var(--dim); }
#fmClip .still-duration input { width: 75px; margin: 0 5px; padding: 4px 7px; background: var(--card-hi); border: 1px solid var(--line); border-radius: 6px; }
#fmAdd { z-index: 61; }
#playlistClipMenu { z-index:62; }
#filmPlaylistPick { position:fixed; z-index:72; left:50%; bottom:22px; transform:translateX(-50%); display:flex; align-items:center; gap:9px; flex-wrap:wrap; max-width:calc(100vw - 24px); width:max-content; padding:9px 13px; border:1px solid var(--line2); border-radius:12px; background:var(--panel); color:var(--text); box-shadow:0 8px 32px #0006; }
#filmPlaylistPick[hidden] { display:none; }
#filmPlaylistPick span { color:var(--dim); }
.playlist-picking #vp .node:not(.playlist-pickable) { opacity:.5; }
.playlist-picking #vp .playlist-pickable { cursor:pointer; }
.playlist-picking #vp .playlist-pickable:hover .card, .playlist-picking #vp .playlist-picked .card { outline:2px solid var(--c-video); }
.playlist-picking #vp .playlist-picked::after { content:attr(data-playlist-pick-order); position:absolute; pointer-events:none; top:6px; right:6px; min-width:24px; height:24px; display:grid; place-items:center; background:var(--text); color:var(--bg); border-radius:7px; font-weight:600; }
.playlist-picking :is(#ntools,#selectionTools,#pp,#chatLaunch) { visibility:hidden; }
#fmSub { position: absolute; left: 5%; right: 5%; bottom: 7%; text-align: center; color: #fff; font-size: 100%; font-weight: 600; pointer-events: none;
  text-shadow: 0 0 3px #000, 0 0 3px #000, 0 0 6px #000; font-size: clamp(14px, 2.4vw, 30px); }
#fmClip { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
#fmClip .row, #fmClip .trim, #fmClip .row2 { display: flex; align-items: center; gap: 10px; }
#fmClip .row { flex-wrap: wrap; }
#fmClip .fm-version-picker { display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:8px; color:var(--dim); border:1px solid var(--line); border-radius:8px; font-size:var(--fs-small); }
#fmClip .fm-version-picker select { background:var(--card-hi); color:var(--text); border:1px solid var(--line2); border-radius:6px; padding:5px; }
#fmClip .fm-version-picker [role=status] { flex:1 1 140px; }
#fmClip .fm-version-picker video { width:100%; max-height:200px; object-fit:contain; background:#080809; border-radius:8px; }
#fmClip .grow { flex: 1; } #fmClip .trim input { flex: 1; accent-color: #ffb36b; }
#fmClip .row2 label { display: flex; flex-direction: column; gap: 4px; color: var(--dim); font-size: var(--fs-small); flex: 1; }
#fmClip .row2 { flex-wrap: wrap; }
#fmClip .row2 label.vol { flex: 0 1 150px; } #fmClip .row2 .vol input { width: 100%; }
#fmClip .row2 label.clip-speed { flex: 0 0 68px; }
#fmClip .clip-speed input { width: 68px; padding:4px 7px; color:var(--text); background:var(--card-hi); border:1px solid var(--line); border-radius:6px; }
#fmClip textarea, #fmNarr textarea { width: 100%; resize: vertical; background: #111113; border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; color: var(--text); }
#fmSet { width: 330px; flex: none; overflow-y: auto; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 4px 14px 14px; display: flex; flex-direction: column; gap: 8px; }
#fmSet h4 { margin: 12px 0 0; font-size: var(--fs-small); color: var(--dim); font-weight: 600; letter-spacing: .5px; }
#fmSet label { display: flex; align-items: center; gap: 8px; font-size: var(--fs-small); }
#fmSet :is(label select,#fmCutawaySource) { background:#222226; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:4px 6px; }
#fmSet label select { flex:1; }
#fmSet label input[type=range] { flex: 1; } #fmSet .h, #qp .h { color: var(--faint); font-size: var(--fs-caption); line-height: 1.5; }
#fmSet .bgm { display: flex; align-items: center; gap: 6px; } #fmSet .bgm span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nar { border: 1px solid var(--line); border-radius: 10px; padding: 8px; display: flex; flex-direction: column; gap: 6px; margin-bottom: 6px; }
.nar .nr { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: var(--fs-small); }
.nar select { background: #222226; border: 1px solid var(--line); border-radius: 7px; padding: 3px 4px; }
.nar input[type=number] { width: 56px; background: #111113; border: 1px solid var(--line); border-radius: 6px; padding: 2px 4px; margin: 0 4px; }
.nar .pill { height: 26px; }
.fm-dubbing-heading, .fm-dubbing-header { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.fm-dubbing-heading { margin-top:12px; } #fmSet .fm-dubbing-heading h4 { margin:0; }
#fmNarr { display:grid; gap:8px; }
.fm-dubbing { display:grid; gap:9px; min-width:0; padding:10px; border:1px solid var(--line); border-radius:10px; }
.fm-dubbing-header b { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.fm-dubbing-header span { flex:none; color:var(--dim); font-size:var(--fs-caption); }
.fm-dubbing :is(input,textarea) { min-width:0; padding:6px 8px; color:var(--text); background:#111113; border:1px solid var(--line); border-radius:7px; }
.fm-dubbing label select { min-width:0; }
.fm-dubbing-timing { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
#fmSet .fm-dubbing-timing label { display:grid; gap:3px; }
.fm-dubbing-timing input { width:100%; }
.fm-dubbing-actions { display:flex; flex-wrap:wrap; gap:5px; }
.fm-dubbing-actions .pill { min-height:28px; }
.fm-dubbing-primary:not(:disabled) { background:var(--text); color:var(--card); }
.fm-dubbing-warning { color:#ffc68e; font-size:var(--fs-caption); }
#fmTl { display: flex; align-items: stretch; gap: 0; overflow-x: auto; padding: 10px 18px 16px; border-top: 1px solid var(--line); min-height: 128px; }
#fmTl .fc { position: relative; flex: none; height: 104px; border-radius: 10px; overflow: hidden; background: #000; border: 2px solid transparent; cursor: pointer; }
#fmTl .fc.on { border-color: var(--c-video); } #fmTl .fc.over { border-color: var(--blue); } #fmTl .fc.drag { opacity: .4; }
#fmTl .fc :is(video, img) { width: 100%; height: 100%; object-fit: cover; pointer-events: none; }
#fmTl .fm-trim-edge { position:absolute; top:25px; bottom:25px; width:16px; z-index:1; display:grid; place-items:center; cursor:ew-resize; touch-action:none; }
#fmTl .fm-trim-edge[data-trim-edge=in] { left:0; }
#fmTl .fm-trim-edge[data-trim-edge=out] { right:0; }
#fmTl .fm-trim-edge::after { content:""; width:4px; height:24px; border-radius:2px; background:#fff; box-shadow:0 1px 4px #000; opacity:.45; }
#fmTl .fm-trim-edge[data-trim-time]::before { content:attr(data-trim-time); position:absolute; top:0; left:12px; padding:2px 5px; border-radius:4px; background:#16161a; color:#fff; font-size:var(--fs-caption); white-space:nowrap; }
#fmTl .fm-trim-edge[data-trim-edge=out][data-trim-time]::before { left:auto; right:12px; }
#fmTl .fc:hover .fm-trim-edge::after, #fmTl .fc.on .fm-trim-edge::after { opacity:1; }
#fmTl .fc .x { z-index:2; }
#fmTl .fl { position: absolute; left: 0; right: 0; top: 0; padding: 4px 7px; font-size: var(--fs-caption); background: linear-gradient(#000c, #0000); display: flex; gap: 4px; white-space: nowrap; overflow: hidden; }
#fmTl .fl span { margin-left: auto; color: #ddd; }
#fmTl .fs { position: absolute; left: 0; right: 0; bottom: 0; padding: 3px 7px; font-size: var(--fs-caption); background: #000a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#fmTl .x { position: absolute; right: 4px; bottom: 22px; width: 20px; height: 20px; border-radius: 50%; border: none; background: #000b; color: #fff; display: none; }
#fmTl .fc:hover .x { display: block; }
#fmTl .fm-clip-menu { position:absolute; right:5px; top:24px; width:26px; height:23px; z-index:3; background:#16161acf; border:1px solid #ffffff35; color:#fff; border-radius:6px; }
#fmTl .ft { flex: none; align-self: center; margin: 0 4px; padding: 3px 7px; font-size: var(--fs-caption); border-radius: 8px; border: 1px solid var(--line2); background: #1b1b1f; color: #cfcfd5; writing-mode: vertical-rl; letter-spacing: 2px; }
#fmTl .fadd { flex: none; align-self: center; margin-left: 12px; height: 104px; padding: 0 16px; border-radius: 10px; border: 1px dashed var(--line2); background: none; color: var(--dim); }
.fm-time { display: flex; align-items: center; gap: 10px; margin: 0 18px 8px; color: var(--dim); font-size: var(--fs-caption); }
#fmTime { flex: 1; accent-color: var(--c-video); }
.fm-captions { flex:1 1 100%; min-width:0; max-height:210px; overflow:auto; }
.fm-caption { display:grid; grid-template-columns:auto 5.8ch 5.8ch minmax(8ch,1fr) auto; align-items:center; gap:5px; margin:4px 0; }
.fm-caption input { min-width:0; width:100%; padding:4px 5px; color:var(--text); background:var(--card); border:1px solid var(--line2); border-radius:6px; }
.fm-caption-actions { margin-top:6px; flex-wrap:wrap; }
#fmTimeLabel { min-width: 7ch; text-align: right; font-variant-numeric: tabular-nums; }
#fmAudioLanes { max-height: 120px; overflow: auto; padding: 0 18px 12px; }
#fmTitleLanes { max-height:72px; overflow:auto; padding:0 18px 6px; }
.fm-title-lane { position:relative; height:26px; margin-top:4px; border-radius:7px; background:var(--card); }
.fm-title-lane button { position:absolute; height:100%; min-width:1.5rem; max-width:100%; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;
  text-align:left; border:1px solid var(--line2); border-radius:7px; background:var(--card-hi); color:var(--text); font-size:var(--fs-caption); }
#fmCutawayLane { position:relative; margin:0 18px 7px; min-height:26px; background:var(--card); border-radius:7px; overflow:hidden; }
#fmCutawayLane button { position:absolute; height:100%; min-width:1.5rem; max-width:100%; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;
  text-align:left; border:1px solid var(--line2); border-radius:7px; background:var(--card-hi); color:var(--text); font-size:var(--fs-caption); }
.fm-title-edit input[type=text] { min-width:0; flex:1; color:var(--text); background:var(--card-hi); border:1px solid var(--line2); border-radius:6px; padding:4px 6px; }
.fm-audio-lane { position: relative; height: 28px; margin-top: 4px; border-radius: 7px; background: var(--card); }
.fm-audio-lane button { position: absolute; height: 100%; max-width: 100%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; border: 1px solid var(--line2); border-radius: 7px; background: var(--card-hi); color: var(--text); text-align: left; font-size: var(--fs-caption); }
.fm-audio-lane button:focus-visible { outline: 2px solid var(--c-image); outline-offset: -2px; }
.fm-voice-lane button { border-color:#aa8cc6; background:#30263a; }
#fmAudioSettings .nr b { flex: 1; min-width: 100px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
#fmGo { background: #fff; color: #000; font-weight: 600; }
#qp { position: fixed; top: 54px; right: 14px; z-index: 31; width: min(360px, calc(100vw - 28px)); max-height: 70vh; overflow-y: auto; display: none; flex-direction: column; gap: 4px; padding: 8px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 13px; box-shadow: 0 12px 40px rgba(0,0,0,.55); }
#qp.on { display: flex; } #qp .mt { padding: 4px 6px 6px; color: var(--dim); font-size: var(--fs-small); }
#qp .qj { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 9px; background: #1a1a1d; font-size: var(--fs-small); }
#qp .qj .ty { color: var(--faint); font-size: var(--fs-caption); width: 26px; } #qp .qj .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#qp .qj .nm[data-n] { cursor: pointer; } #qp .qj .nm[data-n]:hover { text-decoration: underline; }
#qp .qj.running .st { color: #ffcf5a; } #qp .qj .st { color: var(--dim); font-size: var(--fs-caption); white-space: nowrap; }
#qp .qj .x { border: none; background: none; color: var(--faint); font-size: var(--fs-heading); } #qp .qj .x:hover { color: var(--red); }
#qp .h { padding: 4px 6px; }
#qpJobs { display: contents; }
#qp [data-enable-notifications] { align-self: flex-end; }`;
  document.head.appendChild(css);
  document.body.insertAdjacentHTML("beforeend", OneShotI18n.html`
<div id="film">
  <div class="hd"><b id="fmHeading">成片编辑</b><span class="dim" id="fmTotal"></span><span class="dim" id="fmDraftState" role="status"></span><span style="flex:1"></span>
    <button class="pill" id="fmTiming" type="button" hidden>核对镜长</button>
    <button class="pill" id="fmStoryReuse" type="button" hidden>沿用剪辑草稿</button>
    <button class="pill" id="fmSaveList" type="button" hidden>保存列表</button><button class="pill" id="fmPlaylistSources" type="button" hidden>下载原片</button>
    <button class="pill" id="fmDownloadMerged" type="button" hidden>下载合并 MP4</button>
    <button class="pill" id="fmExportCanvas" type="button" hidden>导出到新节点</button><span class="dim" id="fmDownloadStatus" role="status"></span>
    <button class="pill" id="fmAll" title="从头顺序播放片段与字幕">▶ 预览全片</button>
    <button class="pill" id="fmClose">关闭</button><button class="pill" id="fmGo">导出成片</button></div>
  <div class="main">
    <div class="pv"><div id="film-output" class="scr"><video id="fmV" controls playsinline></video><img id="fmStill" alt="静态片段预览" hidden><audio id="fmOriginal" preload="metadata" hidden></audio><div id="fmCutawayLayer" class="fm-output-layer" aria-hidden="true" hidden></div><div id="fmSub"></div><div id="fmTitleLayer" class="fm-output-layer" aria-hidden="true"></div></div>
      <div id="fmStillControls" hidden><button class="pill" type="button" id="fmStillPlay">播放</button><input id="fmStillSeek" aria-label="图片片段播放进度" type="range" min="0" max="3" step="0.01"></div><div id="fmClip"></div></div>
    <div id="fmSet"></div>
  </div>
  <div id="fmTl"></div>
  <div class="fm-time"><button class="pill" id="fmMainPlay" type="button" hidden>播放</button><label for="fmTime">全片播放位置</label><input id="fmTime" type="range" min="0" max="0" step="0.01"><output id="fmTimeLabel">0.00s</output></div>
  <div id="fmCutawayLane" aria-label="补画面时间线" hidden></div>
  <div id="fmTitleLanes" aria-label="画面标题时间线" hidden></div>
  <div id="fmAudioLanes" aria-label="音频片段时间线" hidden></div>
  <audio id="fmA"></audio>
</div>
<dialog id="fmStoryDialog" aria-labelledby="fmStoryTitle">
  <form><h2 id="fmStoryTitle">沿用剪辑草稿</h2>
    <label>来源草稿<select aria-label="来源草稿"></select></label>
    <ol aria-label="镜头版本变更"></ol>
    <p>保留原剪辑顺序、裁剪区间、字幕和声音轨道。换用镜头后可预览核对。</p>
    <footer><button type="button" class="pill" data-close>取消</button><button type="submit" class="pill">沿用到当前剪辑</button></footer>
  </form>
</dialog>
<dialog id="fmSlowdownDialog" aria-labelledby="fmSlowdownTitle">
  <form><h2 id="fmSlowdownTitle">预览减速补齐</h2>
    <video aria-label="减速预览" controls playsinline preload="metadata"></video>
    <p data-slowdown-result role="status"></p>
    <footer><button type="button" class="pill" data-close>取消</button><button type="submit" class="pill">应用减速</button></footer>
  </form>
</dialog>
<dialog id="fmTimingDialog" aria-labelledby="fmTimingTitle">
  <form><h2 id="fmTimingTitle">核对分镜时长</h2>
    <p data-timing-summary role="status"></p>
    <ul data-timing-list aria-label="片段镜长清单"></ul>
    <p>勾选后按当前入点和速度调整出点。</p>
    <footer><button type="button" class="pill" data-close>关闭</button><button type="submit" class="pill" hidden>应用勾选的出点</button></footer>
  </form>
</dialog>
<div class="menu" id="fmAdd"></div><div class="menu" id="playlistClipMenu" aria-label="片段操作"></div>
<div id="qp"><div id="qpContext" class="h"></div><div id="qpJobs"></div><button type="button" data-enable-notifications hidden>开启完成通知</button></div>`);
  $("#fmClose").onclick = closeFilm;
  $("#fmTiming").onclick = () => { if (FILM) openFilmStoryTiming(FILM); };
  $("#fmTimingDialog [data-close]").onclick = () => closeFilmStoryTiming(true);
  $("#fmTimingDialog").oncancel = event=>{event.preventDefault();closeFilmStoryTiming(true);};
  $("#fmStoryReuse").onclick = () => { if (FILM?.story) openStoryDraftPicker(FILM); };
  $("#fmStoryDialog [data-close]").onclick = closeStoryDraftPicker;
  $("#fmSlowdownDialog [data-close]").onclick = closeStorySlowdown;
  $("#fmSlowdownDialog").oncancel = event=>{event.preventDefault();closeStorySlowdown();};
  $("#fmSaveList").onclick = () => { if (FILM) saveFilmPlaylist(FILM); };
  $("#fmPlaylistSources").onclick = () => { if (FILM) downloadFilmPlaylistSources(FILM); };
  if (typeof ResizeObserver === "function") new ResizeObserver(sizeFilmTitleLayer).observe($("#fmTitleLayer").parentElement);
  $("#fmGo").onclick = () => void exportFilm();
  $("#fmDownloadMerged").onclick = () => void exportFilm("download");
  $("#fmExportCanvas").onclick = () => void exportFilm("canvas");
  initFilmPlaylistPicker();
  $("#fmMainPlay").onclick = () => {
    if (!FILM) return;
    const video = $("#fmV");
    if (FILM.still?.started != null || !FILM.still && !video.paused) {
      playAll = false;
      if (FILM.still) $("#fmStillPlay").click(); else video.pause();
    } else {
      playAll = true;
      playFilmClip();
    }
    previewTick();
  };
  $("#fmTime").oninput = e => seekTimeline(e.target.valueAsNumber);
  $("#fmAll").onclick = () => { if (FILM) { playAll = true; selectClip(0, 0, true); } };
  $("#fmStillPlay").onclick = () => {
    if (!FILM?.still) return;
    if (FILM.still.started === null) playFilmClip();
    else {
      FILM.still.offset = filmClipOffset(FILM); FILM.still.started = null; playAll = false;
      syncFilmAudio(FILM);
      $("#fmStillPlay").textContent = OneShotI18n.t("播放");
    }
  };
  $("#fmStillSeek").oninput = e => {
    if (!FILM?.still) return;
    FILM.still.offset = e.target.valueAsNumber;
    if (FILM.still.started !== null) FILM.still.started = performance.now();
  };
  setInterval(previewTick, 50);
  setInterval(() => saveFilmDraft(), 900);
  addEventListener("pagehide", () => saveFilmDraft());
  $("#canvasQueueBtn").onclick = () => toggleQueue();
  for (const event of ["play","pause","seeked","ratechange"]) $("#fmV").addEventListener(event, syncFilmOriginal);
  $("#fmV").addEventListener("play",()=>stopFilmVersionPreview(FILM));
  $("#fmV").addEventListener("pause", () => { if (FILM) syncFilmAudio(FILM); });
  document.addEventListener("pointerdown", e => {
    if (qOpen && !e.target.closest("#qp, #canvasQueueBtn")) toggleQueue(false);
    if (!e.target.closest("#fmAdd, .fadd, [data-track-action=add]")) $("#fmAdd").classList.remove("on");
    if (!e.target.closest("#playlistClipMenu,.fm-clip-menu")) closePlaylistClipMenu();
  });
  $("#fmTl").addEventListener("scroll",()=>closePlaylistClipMenu(),{passive:true});
  document.addEventListener("keydown", e => {
    if (!FILM) return;
    if($("#light").open)return;
    if ($("#fmTimingDialog").open) {
      if (e.key==="Escape") { e.preventDefault();closeFilmStoryTiming(true); }
      e.stopImmediatePropagation();
      return;
    }
    if ($("#fmSlowdownDialog").open) {
      if (e.key==="Escape") { e.preventDefault();closeStorySlowdown(); }
      e.stopImmediatePropagation();
      return;
    }
    if ($("#fmStoryDialog").open) {
      if (e.key==="Escape") { e.preventDefault(); closeStoryDraftPicker(); $("#fmStoryReuse").focus(); }
      e.stopImmediatePropagation();
      return;
    }
    if(e.key==="Escape" && closePlaylistClipMenu({focus:true})){
      e.preventDefault();e.stopImmediatePropagation();return;
    }
    if(filmPlaylistPicker){
      if(e.key==="Escape"){e.preventDefault();e.stopImmediatePropagation();finishFilmPlaylistPicker();}
      else if(e.key==="Enter"&&!e.isComposing&&!e.repeat&&!e.target.closest?.("#filmPlaylistPick button")){
        e.preventDefault();e.stopImmediatePropagation();finishFilmPlaylistPicker(true);
      }else if(e.key!=="Tab" && !e.target.closest?.("#filmPlaylistPick button") &&
          (e.metaKey||e.ctrlKey||![" ","+","=","-","0","f","m"].includes(e.key.toLowerCase()))){
        e.preventDefault();e.stopImmediatePropagation();
      }
      return;
    }
    if (e.key === "Escape") { e.stopPropagation(); closeFilm(); return; }
    if (handleFilmTrackKey(FILM,e)) return;
    if (!canvasCanEdit() || FILM.busy || e.defaultPrevented || e.isComposing || e.repeat ||
        e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || $("dialog[open]")) return;
    if (e.target!==document && e.target!==document.body && !e.target.closest?.("#film"))return;
    if (e.target.closest?.("input:not(#fmTime),textarea,select,[contenteditable]:not([contenteditable=false])")) return;
    const action = {c:"[data-split-clip]",q:"[data-a=in]",e:"[data-a=out]"}[e.key.toLowerCase()];
    const button=action&&$(action,$("#fmClip"));
    if (button) { e.preventDefault();e.stopPropagation();button.click(); }
  }, true);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && doneCount) { doneCount = 0; document.title = "OneShot"; } });
  const enableNotifications = $("#qp [data-enable-notifications]");
  enableNotifications.hidden = !window.Notification || Notification.permission !== "default";
  enableNotifications.onclick = async () => {
    enableNotifications.disabled = true;
    try { await Notification.requestPermission(); }
    catch { toast("无法开启通知，请检查浏览器设置"); }
    finally {
      enableNotifications.hidden = Notification.permission !== "default";
      enableNotifications.disabled = false;
    }
  };
  initFilmTrackEditor();
  setInterval(watchDone, 1500);
}
