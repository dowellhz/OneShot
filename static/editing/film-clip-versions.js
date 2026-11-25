"use strict";

function filmVersionReplacement(clip, candidate, source) {
  if (clip.kind==="image")return {ref:candidate.ref,shorter:0};
  const length=candidate.seconds || candidate.node_data?.duration || source.data?.duration;
  if (!Number.isFinite(length) || length<=0)throw new Error("新版本的时长不可用");
  const next={...clip,media_seconds:length,src_len:undefined};
  const bounds=filmTrimBounds(next), start=clip.in||0;
  const out=clip.out??filmTrimBounds(clip).end, end=Math.min(out,bounds.end);
  if (!(end>start) || end-start+1e-6<bounds.minimum)throw new Error("新版本太短，无法保留当前入点");
  return {ref:candidate.ref,media_seconds:length,out:end,shorter:(out-end)/filmSpeed(clip)};
}

function storyVersionShortage(clip, version) {
  if(!Number.isSafeInteger(clip.story_frames) || clip.story_frames<1 || !Number.isFinite(version?.seconds) || version.seconds<=0)return null;
  const shortage=(clip.in||0)+clip.story_frames/FILM_FPS-version.seconds;
  return shortage>1e-6?shortage:0;
}

function stopFilmVersionPreview(F) {
  const preview=F?.versionPreview;
  if(!preview)return;
  clearFilmRangePreview(preview);preview.hidden=true;
  F.versionPreview=null;
}

function openFilmVersionPicker(F,clip,source,box,button,preferredRef=null) {
  const open=$(".fm-version-picker",box);
  if(open){stopFilmVersionPreview(F);open.remove();button.setAttribute("aria-expanded","false");return;}
  const options=source.versions.filter(version=>version.ref&&version.ref!==clip.ref);
  const form=document.createElement("form");
  form.className="fm-version-picker";
  const keepsAudio=!!(clip.audio_ref || clip.audio_start!=null && F.spec.remake_audio);
  const planned=clip.kind==="video" && Number.isSafeInteger(clip.story_frames) && clip.story_frames>0 && !keepsAudio;
  form.innerHTML=`<label>替换为 <select aria-label="替换素材版本"></select></label>
    ${clip.captions&&!keepsAudio?'<label><input type="checkbox" data-keep-captions> 沿用原时间码字幕</label>':""}
    ${planned?'<label><input type="checkbox" data-fit-story> 以原速按分镜时长取用</label><button class="pill" type="button" data-preview-version>预览所选版本</button>':""}
    <span role="status"></span><button class="pill" type="submit">应用版本</button>
    ${planned?'<video controls playsinline preload="metadata" aria-label="所选版本预览" hidden></video>':""}`;
  const picker=$("select",form), status=$("[role=status]",form), apply=$('[type="submit"]',form), captions=$("[data-keep-captions]",form);
  const fit=$("[data-fit-story]",form), watch=$("[data-preview-version]",form), preview=$("video",form);
  const active=curV(source);
  const coverage=version=>{
    const shortage=storyVersionShortage(clip,version);
    return shortage===null?" · 待核实时长":shortage>1e-6?` · 缺 ${shortage.toFixed(2)} 秒`:" · 够计划镜长";
  };
  picker.replaceChildren(...options.map((version,index)=>new Option(
    `版本 ${source.versions.indexOf(version)+1}${version===active?"（画布当前）":""}${version.seconds?` · ${version.seconds.toFixed(1)}s`:""}${planned?coverage(version):""}`,String(index))));
  const preferred=planned && preferredRef ? options.findIndex(version=>version.ref===preferredRef &&
    storyVersionShortage(clip,version)===0) : -1;
  if (preferred>=0) {
    picker.value=String(preferred);
    fit.checked=true;
  } else if(options.includes(active))picker.value=String(options.indexOf(active));
  const proposal=()=>{
    const live=node(clip.node);
    const requested=options[Number(picker.value)];
    const version=live?.versions.find(version=>version.ref===requested?.ref);
    if(!version || version.ref===clip.ref)throw new Error("所选版本已移除，请重新选择");
    const changes=filmVersionReplacement(clip,version,live);
    const shortage=planned?storyVersionShortage(clip,version):null;
    if(fit?.checked && shortage!==null && shortage<=1e-6){
      return {shortage,changes:{...changes,shorter:0,out:(clip.in||0)+clip.story_frames/FILM_FPS,speed:1,tight:true}};
    }
    return {shortage,changes};
  };
  let reviewed;
  picker.onchange=()=>{
    stopFilmVersionPreview(F);
    try {
      reviewed=proposal();
      if(fit){
        fit.disabled=reviewed.shortage===null || reviewed.shortage>1e-6;
        if(fit.disabled)fit.checked=false;
      }
      const {shorter}=reviewed.changes;
      status.textContent=fit?.checked?`以原速取用 ${(clip.story_frames/FILM_FPS).toFixed(2)} 秒`:
        shorter>1e-6?`片段将缩短 ${shorter.toFixed(2)} 秒`:(clip.kind==="video"?"保留当前剪辑区间":"保留停留时长");
      if(captions&&!captions.checked)status.textContent+=" · 将清除原时间码字幕";
      apply.disabled=false;
      if(watch)watch.disabled=false;
    } catch(error){
      reviewed=null;
      status.textContent=error.message;apply.disabled=true;
      if(watch)watch.disabled=fit.disabled=true;
    }
  };
  if(captions)captions.onchange=picker.onchange;
  if(fit)fit.onchange=picker.onchange;
  if(watch)watch.onclick=()=>{
    if(FILM!==F || F.spec.clips[F.sel]!==clip || F.busy || !canvasCanEdit())return;
    picker.onchange();
    if(!reviewed)return;
    const {changes}=reviewed;
    const player=$("#fmV");
    playAll=false;
    if(!player.paused)player.pause();
    syncFilmAudio(F);
    F.versionPreview=preview;preview.hidden=false;
    setFilmRangePreview(preview,remakeMedia(changes.ref),{start:clip.in||0,end:changes.out,
      rate:changes.speed??filmSpeed(clip),volume:clip.volume});
    preview.focus();
  };
  form.onsubmit=event=>{
    event.preventDefault();
    if(!canvasCanEdit() || FILM!==F || F.spec.clips[F.sel]!==clip || F.busy)return;
    try {
      const latest=proposal();
      if(JSON.stringify(latest)!==JSON.stringify(reviewed)){
        picker.onchange();status.textContent+=" · 素材已更新，请再次确认";return;
      }
      const {shorter,...changes}=latest.changes, offset=filmClipOffset(F);
      if(!keepsAudio && !captions?.checked)delete clip.captions;
      delete clip.src_len;
      delete clip.story_shot;
      Object.assign(clip,changes);
      renderFilm();selectClip(F.sel,Math.min(offset,clipLen(clip)));saveFilmDraft(F);
    } catch(error){status.textContent=error.message;}
  };
  $(".row",box).after(form);button.setAttribute("aria-expanded","true");
  picker.onchange();picker.focus();
  if (preferred>=0) watch.click();
  else if (preferredRef) status.textContent+=" · 推荐版本已变化，请重新选择";
}

async function updateRemakeFilmClip(F, clip) {
  const provenance = clip.remake_shot;
  const bid = boardId;
  if (provenance) {
    await flushSave();
    const target = vtResolve(clip.node, provenance.source);
    if (!target || target.node.versions[target.index]?.ref !== provenance.source) throw new Error("原片版本已不存在");
    const version = target.node.versions[target.index];
    const session = await remakeRequest(`/api/video-remake/${encodeURIComponent(bid)}/${encodeURIComponent(target.node.id)}?source=${encodeURIComponent(provenance.source)}`);
    const index = session?.shots.findIndex(shot => shot.start === provenance.start && shot.end === provenance.end);
    if (!(index >= 0)) throw new Error("原片剪辑点已变更，请从镜头清单重新送入剪辑");
    if (session.export_review.remaining.some(issue => issue.shot === index)) throw new Error("请先在重制工作区采用镜头版本");
    if (FILM !== F || boardId !== bid || !F.spec.clips.includes(clip)) return;
    const next = remakeTimelineSpec(target.node, version, session).clips[index];
    const start = (clip.in || 0) + clip.audio_start - provenance.start;
    const end = (clip.out ?? filmMediaLength(clip)) + clip.audio_start - provenance.start;
    if (clip.ref !== next.ref || clip.audio_start !== next.audio_start) delete clip.captions;
    Object.assign(clip, {ref:next.ref, media_seconds:next.media_seconds, audio_start:next.audio_start, src_len:undefined,
      in:Math.max(next.in, next.in + start), out:Math.min(next.out, next.in + end)});
  }
  renderFilm(); selectClip(F.sel);
}
