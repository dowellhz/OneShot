"use strict";

function filmTrimBounds(c) {
  const length=filmMediaLength(c);
  const start=c.remake_shot?c.remake_shot.start-c.audio_start:0;
  const end=c.remake_shot?Math.min(length,c.remake_shot.end-c.audio_start):
    c.audio_ref?Math.min(length,c.audio_seconds-c.audio_start):length;
  const minimum=Math.min(c.remake_shot||c.tight?1/RM_FPS:.5,Math.max(0,end-start));
  return {start,end,minimum,length};
}
function filmTrimPoint(c,side,value,bounds=filmTrimBounds(c)) {
  const point=c.remake_shot||c.tight?Math.round(value*RM_FPS)/RM_FPS:+value.toFixed(2);
  return side==="in"?Math.max(bounds.start,Math.min(point,(c.out??bounds.end)-bounds.minimum)):
    Math.min(bounds.end,Math.max(point,(c.in||0)+bounds.minimum));
}
function setFilmTrim(c,side,point,bounds=filmTrimBounds(c)) {
  c[side]=side==="out"&&!c.remake_shot&&!c.tight&&point>=bounds.length-.05?null:point;
}
function bindFilmTrimEdge(F,index,handle) {
  const side=handle.dataset.trimEdge,clip=F.spec.clips[index];
  let drag;
  handle.onpointerdown=event=>{
    if(event.button!==0 || drag || FILM!==F || F.busy || !canvasCanEdit())return;
    const width=handle.parentElement.getBoundingClientRect().width;
    const seconds=clipLen(clip)*filmSpeed(clip);
    if(!(width>0 && seconds>0))return;
    const bounds=filmTrimBounds(clip),point=side==="in"?clip.in||0:clip.out??bounds.end;
    event.preventDefault();event.stopPropagation();
    handle.setPointerCapture(event.pointerId);
    drag={id:event.pointerId,x:event.clientX,point,scale:seconds/width,width,bounds};
    playAll=false;
    const player=$("#fmV");
    if(!player.paused)player.pause();
  };
  const pointAt=event=>filmTrimPoint(clip,side,drag.point+(event.clientX-drag.x)*drag.scale,drag.bounds);
  handle.onpointermove=event=>{
    if(event.pointerId!==drag?.id)return;
    const point=pointAt(event),dx=(point-drag.point)/drag.scale;
    handle.style.translate=Math.max(-drag.width,Math.min(dx,drag.width))+"px";
    handle.dataset.trimTime=point.toFixed(2)+" 秒";
  };
  const finish=event=>{
    if(event.pointerId!==drag?.id)return;
    const point=pointAt(event), bounds=drag.bounds;
    const moved=Math.abs(point-drag.point)>.0001;
    drag=null;
    handle.style.translate="";
    delete handle.dataset.trimTime;
    if(event.type!=="pointerup" || !moved || FILM!==F || F.spec.clips[index]!==clip || !canvasCanEdit())return;
    setFilmTrim(clip,side,point,bounds);
    renderFilm();selectClip(index,side==="in"?0:Math.max(0,clipLen(clip)-1/FILM_FPS));saveFilmDraft(F);
  };
  handle.onpointerup=handle.onpointercancel=handle.onlostpointercapture=finish;
}
function splitFilmClip(F, clip, position) {
  const start = clip.in || 0, end = clip.out ?? filmMediaLength(clip), speed = filmSpeed(clip);
  // Snap to the rendered timeline so splitting a retimed clip keeps its export length.
  const tick = Math.round((position - start) / speed * FILM_FPS);
  const frames = Math.round((end - start) / speed * FILM_FPS);
  if (!(0 < tick && tick < frames)) return toast("请把播放头移到片段内部再分割");
  const elapsed = tick / FILM_FPS, split = start + elapsed * speed;
  const cues = filmSubtitleCues(clip.subs, frames / FILM_FPS);
  const right = {...clip, in:split, out:end, tight:true,
    subs:cues.filter(cue => (cue.start + cue.end) / 2 >= elapsed).map(cue => cue.text)};
  const left = {...clip, out:split, tight:true, trans:"cut",
    subs:cues.filter(cue => (cue.start + cue.end) / 2 < elapsed).map(cue => cue.text)};
  delete left.story_frames;
  delete right.story_frames;
  delete left.story_pending_length;
  delete right.story_pending_length;
  if (clip.story_shot) left.story_split=right.story_split=true;
  if (clip.captions) {
    left.captions = clip.captions.filter(cue => cue.start < split);
    right.captions = clip.captions.filter(cue => cue.end > split);
  }
  const previous = F.spec.clips[F.sel - 1], next = F.spec.clips[F.sel + 1];
  if ((previous && clipOverlap(previous, left) < clipOverlap(previous, clip)) ||
      clipOverlap(right, next) < clipOverlap(clip, next))
    return toast("切点太靠近叠化转场，请把播放头移开后再分割");
  F.spec.clips.splice(F.sel, 1, left, right);
  renderFilm();
  selectClip(F.sel + 1);
  saveFilmDraft();
}
async function captureFilmFrame(F, clip, button) {
  const video = $("#fmV"), version = filmVersion(clip);
  if (video.readyState < 1 || !version) return toast("请等待当前视频片段载入");
  // The out point belongs to the next clip, so use the preceding frame at that boundary.
  const time = Math.max(clip.in || 0, Math.min(video.currentTime, (clip.out ?? filmMediaLength(clip)) - .001));
  button.disabled = true;
  try {
    const image = await captureOnCanvas(clip.node, version, {position:"time", at:time, allowDetached:true, active:()=>FILM===F});
    if (image && FILM===F) closeFilm();
  } catch (error) { toast("截帧失败：" + error.message); }
  finally { button.disabled = false; }
}

function filmCaptionInput(F, clip) {
  const audioRef = clip.audio_ref || (clip.audio_start != null && F.spec.remake_audio);
  return {board:F.board, ref:filmVersion(clip)?.ref, in:clip.in || 0, out:clip.out,
    ...(audioRef ? {audio_ref:audioRef, audio_start:clip.audio_start} : {})};
}

async function transcribeFilmClip(F, clip, button) {
  const pending = F.captionRequests ||= new Set();
  if (pending.has(clip)) return;
  const request = filmCaptionInput(F, clip);
  if (!request.ref) return toast("找不到要识别字幕的视频");
  const signature = () => JSON.stringify([filmCaptionInput(F, clip),clip.subs,clip.captions]);
  const before = signature();
  pending.add(clip);
  button.disabled = true;
  button.textContent = OneShotI18n.t("正在识别…");
  try {
    const result = await api("/api/video/captions", request);
    if (FILM !== F || !F.spec.clips.includes(clip)) return;
    if (signature() !== before) return toast("字幕或素材区间已修改，请重新识别");
    if (!result.captions?.length) return toast("这段原声未识别到台词");
    clip.captions = result.captions;
    F.spec.subtitles = true;
    renderFilm();
    saveFilmDraft(F);
  } catch (error) {
    if (FILM === F) toast("字幕识别失败：" + error.message, 5000);
  } finally {
    pending.delete(clip);
    if (FILM === F && F.spec.clips[F.sel] === clip) renderClipBox();
  }
}

function renderClipBox() {
  const F = FILM, c = F.spec.clips[F.sel], box = $("#fmClip"), L = filmMediaLength(c), out = c.out ?? L;
  stopFilmVersionPreview(F);
  const isStill = c.kind === "image";
  const bounds=filmTrimBounds(c),{start:baseIn,end:baseOut}=bounds;
  const tr = OneShotI18n.t;
  const volumeLabel = tr(c.audio_ref ? "原片音量" : "原声音量");
  const seekStep = c.remake_shot || c.tight ? 1 / RM_FPS : .1;
  const source = node(c.node);
  const planLength=Number.isSafeInteger(c.story_frames) && c.story_frames>0 && !isStill ? c.story_frames/FILM_FPS : 0;
  const sourcePlayLength=(baseOut-(c.in||0))/filmSpeed(c);
  const pendingPlan=planLength && c.story_pending_length;
  const shortPlan=planLength && !pendingPlan && sourcePlayLength+1e-6<planLength;
  const slowdown=shortPlan && !F.spec.remake_audio && storySlowdownPlan(c,baseOut);
  const beyondSlowdown=shortPlan && (baseOut-(c.in||0))*2+1e-6<planLength;
  const alternative = canvasCanEdit() && c.node!==F.target?.id && source?.versions.some(v=>v.ref && v.ref!==c.ref);
  const trimControls = isStill ? "" : '<button class="pill" data-a="in" title="从这里开始 (Q)" aria-keyshortcuts="Q">从这里开始</button><button class="pill" data-a="out" title="到这里结束 (E)" aria-keyshortcuts="E">到这里结束</button><button class="pill" data-a="reset">恢复完整</button><button class="pill" data-split-clip title="在播放头分割 (C)" aria-keyshortcuts="C">在播放头分割</button>' +
    (canvasCanEdit() ? '<button class="pill" data-film-capture>截帧到画布</button>' : "");
  const captionBusy = F.captionRequests?.has(c);
  const captions = c.captions ? OneShotI18n.html`<div class="fm-captions" aria-label="时间码字幕">
    ${c.captions.map((cue,i) => `<div class="fm-caption" data-cue="${i}">
      <button class="pill" type="button" data-cue-seek aria-label="${esc(tr("定位第 {number} 条字幕", {number:i+1}))}">▶</button>
      <input type="number" min="0" step=".001" data-cue-time="start" value="${esc(cue.start)}" aria-label="${esc(tr("第 {number} 条字幕开始时间", {number:i+1}))}">
      <input type="number" min="0" step=".001" data-cue-time="end" value="${esc(cue.end)}" aria-label="${esc(tr("第 {number} 条字幕结束时间", {number:i+1}))}">
      <input type="text" data-cue-text maxlength="500" value="${esc(cue.text)}" aria-label="${esc(tr("第 {number} 条字幕文本", {number:i+1}))}">
      <button class="pill" type="button" data-cue-remove aria-label="${esc(tr("删除第 {number} 条字幕", {number:i+1}))}">×</button>
    </div>`).join("")}</div>`
    : OneShotI18n.html`<label>手写字幕（一行一句）<textarea data-film-lines rows="2" placeholder="这段没有字幕">${esc(c.subs.join("\n"))}</textarea></label>`;
  box.innerHTML = OneShotI18n.html`<div class="row"><b>${esc(tr("第 {number} 段 · {name}", {number:F.sel+1,name:c.name || source?.name || ""}))}</b>
      <span class="grow"></span>${c.ref && (c.remake_shot || alternative) ? `<button class="pill" data-update-version ${c.remake_shot?"":'aria-expanded="false"'}>${c.remake_shot ? "更新这一镜" : "更换素材版本"}</button>` : ""}${trimControls}</div>
    ${isStill ? OneShotI18n.html`<label class="still-duration">停留时长 <input type="number" min="0.5" max="60" step="0.1" value="${c.duration}"> 秒</label>` : OneShotI18n.html`
    <div class="trim"><span>入点 <b>${(c.in || 0).toFixed(1)}s</b></span><input type="range" min="${baseIn}" max="${baseOut}" step="${seekStep}" value="${c.in || 0}" data-t="in">
      <input type="range" min="${baseIn}" max="${baseOut}" step="${seekStep}" value="${out}" data-t="out"><span>出点 <b>${out.toFixed(1)}s</b></span><span class="dim">保留 ${(out - (c.in || 0)).toFixed(1)}s / 原长 ${(baseOut - baseIn).toFixed(1)}s</span></div>`}
    ${planLength ? OneShotI18n.html`<div class="row"><span class="dim">分镜计划 ${planLength.toFixed(2)} 秒 · 当前片段 ${displayClipSeconds(c)} 秒${pendingPlan?" · 待核实素材时长":""}${shortPlan?` · 素材时长不足，缺 ${(planLength-sourcePlayLength).toFixed(2)} 秒`:""}${beyondSlowdown?"（0.5 倍速仍不足）":""}</span>
      ${canvasCanEdit()&&!pendingPlan?'<button class="pill" type="button" data-a="story-length">按分镜时长</button>':""}
      ${slowdown&&canvasCanEdit()?'<button class="pill" type="button" data-story-slowdown>预览减速补齐</button>':""}</div>` : ""}
    <div class="row2">${captions}
      ${isStill ? "" : `<label class="vol">${volumeLabel}<input type="range" min="0" max="1.5" step="0.05" value="${c.volume}"><span>${Math.round(c.volume * 100)}%</span></label><label class="clip-speed">速度（倍）<input type="number" min="0.5" max="2" step="any" value="${filmSpeed(c)}" data-clip-speed></label>`}</div>`;
  if (!isStill && canvasCanEdit()) box.insertAdjacentHTML("beforeend", OneShotI18n.html`<div class="row fm-caption-actions">
    <button class="pill" type="button" data-film-transcribe ${captionBusy ? "disabled" : ""}>${tr(captionBusy ? "正在识别…" : c.captions ? "重新识别字幕" : "识别原声字幕")}</button>
    ${c.captions ? OneShotI18n.html`<button class="pill" type="button" data-film-manual>改用手写字幕</button><span class="dim">时间为原片秒数</span>` : ""}</div>`);
  const vid = $("#fmV");
  if (F.n?.data.playlist) {
    const locate = document.createElement("button");
    locate.className = "pill";
    locate.type = "button";
    locate.textContent = OneShotI18n.t("定位原片");
    locate.dataset.playlistLocate = "";
    locate.onclick = () => locateFilmPlaylistSource(F,c);
    $(".row", box).append(locate);
  }
  const update = $("[data-update-version]", box);
  if (update && !c.remake_shot) update.onclick = () => openFilmVersionPicker(F,c,source,box,update);
  if (update && c.remake_shot) update.onclick = async () => {
    update.disabled = true;
    try { await updateRemakeFilmClip(F, c); }
    catch (error) { toast(error.message); }
    finally { update.disabled = false; }
  };
  const manual = $("[data-film-lines]", box);
  if (manual) {
    manual.oninput = e => { c.subs = e.target.value.split("\n").map(x => x.trim()).filter(Boolean); };
    manual.onblur = () => renderFilm();
  }
  const transcribe = $("[data-film-transcribe]", box);
  if (transcribe) transcribe.onclick = () => transcribeFilmClip(F, c, transcribe);
  const useManual = $("[data-film-manual]", box);
  if (useManual) useManual.onclick = () => {
    c.subs = c.captions.map(cue => cue.text).filter(Boolean);
    delete c.captions;
    renderFilm(); renderClipBox(); saveFilmDraft(F);
  };
  $$("[data-cue]", box).forEach(row => {
    const i = Number(row.dataset.cue), cue = c.captions[i];
    $("[data-cue-seek]", row).onclick = () => { vid.currentTime = Math.max(c.in || 0, Math.min(cue.start, out)); };
    $("[data-cue-text]", row).onchange = e => { cue.text = e.target.value.trim(); saveFilmDraft(F); };
    $("[data-cue-remove]", row).onclick = () => { c.captions.splice(i,1); renderFilm(); renderClipBox(); saveFilmDraft(F); };
    $$("[data-cue-time]", row).forEach(input => input.onchange = () => {
      const key = input.dataset.cueTime, value = input.valueAsNumber;
      const start = key === "start" ? value : cue.start, end = key === "end" ? value : cue.end;
      if (!Number.isFinite(value) || !(start >= (c.captions[i-1]?.end ?? 0) && start < end && end <= (c.captions[i+1]?.start ?? L + .001))) {
        input.value = cue[key];
        return toast("字幕时间须在原片范围内，且不能与相邻字幕重叠");
      }
      cue[key] = value;
      saveFilmDraft(F);
    });
  });
  if (isStill) {
    syncFilmOriginal();
    const duration = $(".still-duration input", box);
    duration.onchange = () => {
      const value = duration.valueAsNumber;
      if (!Number.isFinite(value) || value < .5 || value > 60) {
        duration.value = c.duration;
        toast("图片停留时长须在 0.5–60 秒之间");
        return;
      }
      const offset = filmClipOffset(F);
      c.duration = value;
      renderFilm(); selectClip(F.sel, Math.min(offset, value)); saveFilmDraft();
    };
    return;
  }
  const trim = (k,value) => setFilmTrim(c,k,filmTrimPoint(c,k,value,bounds),bounds);
  $$("input[data-t]", box).forEach(r => r.oninput = () => {
    const k = r.dataset.t;
    trim(k, +r.value);
    vid.currentTime = c[k] ?? baseOut; renderClipBox(); refreshTimelineLabels();
  });
  $$("button[data-a]", box).forEach(b => b.onclick = () => {
    const a = b.dataset.a;
    if (a === "reset") { c.in = baseIn; c.out = c.remake_shot || c.audio_ref ? baseOut : null; }
    else if (a === "story-length") {
      if (!alignStoryClipLength(c,baseOut)) return toast("当前入点后没有完整的视频帧");
      if (vid.currentTime > c.out) vid.currentTime=c.in||0;
    }
    else trim(a, vid.currentTime);
    renderClipBox(); refreshTimelineLabels();saveFilmDraft(F);
  });
  const vr = $(".vol input", box); vr.oninput = () => { c.volume = +vr.value; vr.nextElementSibling.textContent = Math.round(c.volume * 100) + "%"; vid.volume = Math.min(1, c.volume); syncFilmOriginal(); };
  const speed = $("[data-clip-speed]", box);
  const slowdownButton=$("[data-story-slowdown]",box);
  if(slowdownButton)slowdownButton.onclick=()=>openStorySlowdown(F,c,slowdownButton);
  $("[data-split-clip]", box).onclick = () => splitFilmClip(F, c, vid.currentTime);
  const capture = $("[data-film-capture]", box);
  if (capture) capture.onclick = () => captureFilmFrame(F, c, capture);
  speed.onchange = () => {
    const rate = speed.valueAsNumber;
    if (!Number.isFinite(rate) || rate < .5 || rate > 2) {
      speed.value = filmSpeed(c);
      toast("播放速度须在 0.5–2 倍之间");
      return;
    }
    if (rate === 1) delete c.speed; else c.speed = rate;
    vid.playbackRate = rate;
    syncFilmOriginal();
    if (planLength) {
      const focused=document.activeElement===speed;
      renderClipBox();
      if(focused)$("[data-clip-speed]",box)?.focus();
    }
    refreshTimelineLabels();
    saveFilmDraft();
  };
  vid.volume = Math.min(1, c.volume);
  syncFilmOriginal();
}

function removeFilmClip(F,clip) {
  if(FILM!==F || !canvasCanEdit() || F.busy)return;
  const clips=F.spec.clips,index=clips.indexOf(clip);
  if(index<0)return;
  if(clips.length<=1 && !F.n?.data.playlist)return toast("至少保留一段");
  const current=clips[F.sel],offset=filmClipOffset(F);
  clips.splice(index,1);
  const retained=clips.indexOf(current);
  const next=retained>=0?retained:Math.max(0,Math.min(index,clips.length-1));
  renderFilm();
  selectClip(next,retained>=0?offset:0);
  saveFilmDraft(F);
}

function addClipMenu(e) {
  closePlaylistClipMenu();
  const F = FILM;
  const have = new Set(F.spec.clips.map(c => c.ref || filmVersion(c)?.ref));
  const media = byPosition(B.nodes.filter(n => filmSource(n) && (!F.n?.data.playlist || playlistVideo(n)) && n !== F.n && n.id !== F.target?.id).map(n => n.id));
  const m = $("#fmAdd");
  m.innerHTML = `<div class="mt">添加到末尾</div>` + (media.map(n => `<button data-id="${esc(n.id)}">${ico(n.type)}${esc(n.name)}<span class="k">${have.has(curV(n).ref) ? "已加入" : n.type === "image" ? "图片 · 3s" : vlen(n).toFixed(1) + "s"}</span></button>`).join("") || `<div class="h" style="padding:8px">画布上没有可用素材</div>`);
  if(F.n?.data.playlist && media.some(n=>!ctFolded(n.id)) && canvasCanEdit()){
    $(".mt",m).insertAdjacentHTML("afterend",`<button type="button" data-playlist-pick>${ico("select")}在画布多选</button>`);
    $("[data-playlist-pick]",m).onclick=()=>startFilmPlaylistPicker(F);
  }
  m.classList.add("on");
  const r = e.target.getBoundingClientRect();
  m.style.left = Math.min(r.left, innerWidth - m.offsetWidth - 8) + "px"; m.style.top = Math.max(8, r.top - m.offsetHeight - 8) + "px";
  $$("button[data-id]", m).forEach(b => b.onclick = () => {
    m.classList.remove("on");
    const n = node(b.dataset.id);
    if (FILM !== F || !filmSource(n)) return;
    F.spec.clips.push(newFilmClip(n)); renderFilm(); selectClip(F.spec.clips.length - 1); saveFilmDraft(F);
  });
}
