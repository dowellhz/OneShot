"use strict";

function setFilmRangePreview(video, url, {start,end,rate,volume}) {
  video.src=url;
  video.playbackRate=rate;
  video.volume=Math.min(1,volume??1);
  video.onloadedmetadata=()=>{video.currentTime=start;video.playbackRate=rate;};
  video.onplay=()=>{
    if(video.currentTime<start || video.currentTime>=end-.001)video.currentTime=start;
  };
  video.ontimeupdate=()=>{if(video.currentTime>=end-.001 && !video.paused)video.pause();};
}

function clearFilmRangePreview(video) {
  if (!video.paused) video.pause();
  video.onloadedmetadata=video.ontimeupdate=video.onplay=null;
  video.removeAttribute("src");video.load();
}

// ---- preview: one clip (trimmed) or the whole film in sequence, with the subtitles on top
let playAll = false;
function clipStart(i) { const s = FILM.spec; let t = 0; for (let k = 0; k < i; k++) t += clipLen(s.clips[k]) - clipOverlap(s.clips[k], s.clips[k + 1]); return t; }
function filmClipOffset(F) {
  const c = F.spec.clips[F.sel];
  if (F.still) {
    const elapsed = F.still.started === null ? 0 : (performance.now() - F.still.started) / 1000;
    return Math.min(c.duration, F.still.offset + elapsed);
  }
  return F.pendingOffset ?? Math.max(0, (($("#fmV").currentTime || 0) - (c.in || 0)) / filmSpeed(c));
}
function timelinePos() { return FILM.spec.clips.length ? clipStart(FILM.sel) + filmClipOffset(FILM) : 0; }
function playFilmClip() {
  if (FILM.still) {
    if (filmClipOffset(FILM) >= clipLen(FILM.spec.clips[FILM.sel])) FILM.still.offset = 0;
    FILM.still.started = performance.now();
    $("#fmStillPlay").textContent = "暂停";
  } else {
    $("#fmV").play().catch(() => { playAll = false; });
  }
}
function seekTimeline(t) {
  const s = FILM.spec; let i = 0;
  if (!s.clips.length) return;
  while (i + 1 < s.clips.length && clipStart(i + 1) <= t) i++;
  selectClip(i, t - clipStart(i));
}
function selectClip(i, offset = 0, autoplay = false, ready = null) {
  const F = FILM; if (!F) return; F.sel = i;
  stopFilmVersionPreview(F);
  if (!autoplay) { playAll = false; syncFilmAudio(F); }
  F.still = null;
  F.pendingOffset = offset;
  updateFilmTrackPlayhead(F.spec.clips.length ? clipStart(i)+offset : 0);
  $$("#fmTl .fc").forEach(el => el.classList.toggle("on", +el.dataset.i === i));
  const c = F.spec.clips[i], vid = $("#fmV"), image = $("#fmStill");
  if (!c) {
    if (!vid.paused) vid.pause();
    vid.hidden = image.hidden = $("#fmStillControls").hidden = true;
    $("#fmClip").textContent = "添加视频片段后即可连续预览";
    $("#fmSub").textContent = "";
    clearFilmCutawayPreview(); renderFilmTitlePreview(0);
    return;
  }
  const v = filmVersion(c);
  const isStill = c.kind === "image";
  vid.hidden = isStill || !v;
  image.hidden = !isStill || !v;
  $("#fmStillControls").hidden = !isStill || !v;
  if (!vid.paused) vid.pause();
  vid.onloadedmetadata = null;
  vid.onerror = null;
  if (!v) { $("#fmClip").textContent = "片段素材已不存在"; return; }
  if (isStill) {
    F.pendingOffset = null;
    F.still = {offset:Math.min(offset, c.duration), started:null};
    image.src = v.url;
    image.onload = sizeFilmTitleLayer;
    const seek = $("#fmStillSeek");
    seek.max = c.duration; seek.value = F.still.offset;
    $("#fmStillPlay").textContent = OneShotI18n.t("播放");
    renderClipBox();
    if (autoplay) playFilmClip();
    return;
  }
  if (!vid.src.endsWith(v.url)) vid.src = v.url;
  vid.playbackRate = filmSpeed(c);
  const go = () => {
    if (FILM !== F || F.spec.clips[F.sel] !== c) return;
    if (Number.isFinite(vid.duration) && vid.duration>0) {
      c.src_len=vid.duration;
      if (c.story_pending_length) {
        delete c.story_pending_length;
        if (!c.in && c.out==null && !c.tight && c.story_frames) alignStoryClipLength(c,vid.duration);
        refreshTimelineLabels();
        saveFilmDraft(F);
      }
    }
    sizeFilmTitleLayer();
    vid.currentTime = Math.min(c.out ?? filmMediaLength(c), (c.in || 0) + offset * filmSpeed(c));
    F.pendingOffset = null;
    renderClipBox();
    ready?.();
    if (autoplay) playFilmClip();
  };
  if (vid.readyState >= 1) go();
  else {
    $("#fmClip").textContent = "正在加载片段…";
    vid.onloadedmetadata = () => { vid.onloadedmetadata = null; go(); };
    vid.onerror = () => {
      if (FILM !== F || F.spec.clips[F.sel] !== c) return;
      if (ready) { renderClipBox();ready(); }
      else $("#fmClip").textContent = "无法预览这段素材";
    };
  }
}
function filmSubtitleCues(lines, length) {
  const weights = lines.map(line => [...line].length + 4);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const span = Math.max(.3, length - .15) - .15;
  let start = .15;
  return lines.map((text, index) => {
    const end = start + span * weights[index] / total;
    const cue = {text, start, end};
    start = end;
    return cue;
  });
}

function syncFilmOriginal() {
  const track = $("#fmOriginal"), video = $("#fmV"), clip = FILM?.spec.clips[FILM.sel];
  const ref = clip?.audio_ref || FILM?.spec.remake_audio;
  const original = !!ref && clip?.kind !== "image" && clip?.audio_start != null;
  video.muted = original && !(clip.audio_ref === clip.ref && clip.audio_start === 0);
  if (!video.muted) { if (!track.paused) track.pause(); return; }
  const url = remakeMedia(ref);
  if (track.getAttribute("src") !== url) track.src = url;
  const time = clip.audio_start + video.currentTime;
  if (Math.abs(track.currentTime - time) > .08) track.currentTime = time;
  track.volume = video.volume;
  track.playbackRate = video.playbackRate;
  if (video.paused) track.pause();
  else if (track.paused) track.play()?.catch(() => {});
}

function previewTick() {
  const F = FILM; if (!F) return;
  const vid = $("#fmV"), c = F.spec.clips[F.sel]; if (!c) return;
  const isStill = c.kind === "image";
  if (isStill && !F.still) return;
  const L = isStill ? c.duration : c.src_len || vid.duration || 0, out = c.out ?? L;
  const offset = filmClipOffset(F);
  const playing = isStill ? F.still.started !== null : !vid.paused || playAll && vid.ended;
  // The sequential preview cuts at the start of an exported dissolve.
  // This keeps the preview clock and the timed audio on the same timeline.
  const overlap = playAll ? clipOverlap(c, F.spec.clips[F.sel + 1]) : 0;
  const ended = isStill ? offset >= c.duration - overlap : vid.ended || vid.currentTime >= out - overlap * filmSpeed(c) - .001;
  if (playing && ended) {
    if (playAll && F.sel + 1 < F.spec.clips.length) { selectClip(F.sel + 1, 0, true); return; }
    if (isStill) {
      F.still.offset = c.duration; F.still.started = null;
      $("#fmStillPlay").textContent = OneShotI18n.t("播放");
    } else vid.pause();
    playAll = false;
  }
  if (isStill) $("#fmStillSeek").value = offset;
  else if (!vid.paused && vid.currentTime < (c.in || 0) - .1) vid.currentTime = c.in || 0;
  // subtitle overlay: the same spread as the renderer
  const sub = $("#fmSub"), lines = F.spec.subtitles ? c.subs : [];
  const position = clipStart(F.sel) + offset;
  const voiceCaption = F.spec.subtitles ? filmAudioCaption(F.spec,position) : "";
  const sourcePosition = (c.in || 0) + offset * filmSpeed(c);
  const timedVisible = offset >= clipOverlap(F.spec.clips[F.sel - 1], c) && offset < clipLen(c) - clipOverlap(c, F.spec.clips[F.sel + 1]);
  const captions = c.captions ?? automaticStoryCaptions(F.spec,c);
  const txt = voiceCaption || (captions && F.spec.subtitles
    ? (timedVisible && captions.find(cue => sourcePosition >= cue.start && sourcePosition < cue.end)?.text || "")
    : filmSubtitleCues(lines, clipLen(c)).find(cue => offset >= cue.start && offset < cue.end)?.text || "");
  sub.textContent = txt; sub.style.fontSize = (F.spec.sub_size || 1) * 100 + "%"; sub.style.display = txt ? "" : "none";
  syncFilmOriginal();
  previewFilmCutaway(F,position,playing && !ended);
  const mainPlay = $("#fmMainPlay"), playLabel = playing && !ended ? "暂停" : "播放";
  if (mainPlay.textContent !== playLabel) mainPlay.textContent = playLabel;
  renderFilmTitlePreview(position);
  $("#fmTime").value = position;
  updateFilmTrackPlayhead(position);
  $("#fmTimeLabel").textContent = Math.min(Number($("#fmTime").max), position).toFixed(2) + "s";
  syncFilmAudio(F, playing && !ended ? position : undefined);
}
