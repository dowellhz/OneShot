"use strict";

function alignStoryClipLength(clip, sourceEnd) {
  const start = clip.in || 0, speed = filmSpeed(clip);
  const available = Math.floor((sourceEnd - start) / speed * FILM_FPS + 1e-6);
  if (!Number.isSafeInteger(available) || available < 1) return false;
  clip.out = start + Math.min(clip.story_frames,available)*speed/FILM_FPS;
  clip.tight = true;
  return true;
}

function storySlowdownPlan(clip, end) {
  if (clip.kind!=="video" || clip.remake_shot || clip.audio_ref ||
      !Number.isSafeInteger(clip.story_frames) || clip.story_frames<1) return null;
  const start=clip.in||0, seconds=clip.story_frames/FILM_FPS;
  const rate=(end-start)/seconds;
  if (!Number.isFinite(rate) || rate<.5 || rate>=filmSpeed(clip)-1e-6) return null;
  return {start,end,rate,seconds};
}

function closeStorySlowdown() {
  const dialog=$("#fmSlowdownDialog");
  if (!dialog.open) return;
  const preview=$("video",dialog);
  clearFilmRangePreview(preview);
  $("form",dialog).onsubmit=null;
  if (dialog.close) dialog.close();else dialog.removeAttribute("open");
  dialog._trigger?.focus();
  dialog._trigger=null;
}

function openStorySlowdown(F,clip,trigger) {
  const plan=storySlowdownPlan(clip,filmTrimBounds(clip).end), media=filmVersion(clip);
  if (!plan || !media || F.spec.remake_audio || F.busy || !canvasCanEdit()) return;
  const dialog=$("#fmSlowdownDialog"), preview=$("video",dialog), player=$("#fmV");
  const source=[clip.ref,clip.in,clip.out,clip.speed];
  stopFilmVersionPreview(F);
  playAll=false;
  if (!player.paused)player.pause();
  syncFilmAudio(F);
  setFilmRangePreview(preview,media.url,{...plan,volume:clip.volume});
  $("[data-slowdown-result]",dialog).textContent=`从当前入点取 ${(plan.end-plan.start).toFixed(2)} 秒素材，以 ${plan.rate.toFixed(3)} 倍速播放 ${plan.seconds.toFixed(2)} 秒。`;
  $("form",dialog).onsubmit=event=>{
    event.preventDefault();
    const latest=storySlowdownPlan(clip,filmTrimBounds(clip).end);
    if(FILM!==F || F.board!==boardId || F.spec.clips[F.sel]!==clip || F.busy || !canvasCanEdit() ||
      F.spec.remake_audio || JSON.stringify(latest)!==JSON.stringify(plan) ||
      [clip.ref,clip.in,clip.out,clip.speed].some((value,i)=>value!==source[i])){
      closeStorySlowdown();return toast("当前片段已变更，请重新预览减速");
    }
    Object.assign(clip,{out:plan.end,speed:plan.rate,tight:true});
    closeStorySlowdown();
    renderFilm();selectClip(F.sel);saveFilmDraft(F);
    $("[data-a=story-length]",$("#fmClip"))?.focus();
  };
  dialog._trigger=trigger;
  if(dialog.showModal)dialog.showModal();else dialog.setAttribute("open","");
  $("[data-close]",dialog).focus();
}

function filmTimingShot(F,clip) {
  const script=node(F.storySource || F.spec.story_script);
  if (script?.type!=="script" || nodeLocked(script) || !clip.story_shot || clip.story_split) return null;
  const index=script.data.shots.findIndex((shot,i)=>(shot.id || `index:${i}`)===clip.story_shot);
  if (index<0 || scriptShotLinks(script)[index]?.vid!==clip.node) return null;
  return {script,index};
}

function filmStoryTiming(F) {
  return F.spec.clips.flatMap((clip,index)=>{
    const wanted=clip.story_frames;
    if (clip.kind!=="video" || !Number.isSafeInteger(wanted) || wanted<1) return [];
    const source=node(clip.node), version=source?.versions.find(item=>item.ref===clip.ref);
    const seconds=clip.src_len || version?.seconds;
    const start=clip.in || 0, speed=filmSpeed(clip);
    const known=Number.isFinite(seconds) && seconds>0;
    const end=known ? Math.min(seconds,filmTrimBounds(clip).end) : 0;
    const available=Math.max(0,Math.floor((end-start)/speed*FILM_FPS+1e-6));
    const current=Math.round(clipLen(clip)*FILM_FPS);
    const out=start+wanted*speed/FILM_FPS;
    const protectedAudio=!!(clip.audio_ref || clip.remake_shot || F.spec.remake_audio);
    const short=known && available<wanted;
    const adjustable=known && !short && current!==wanted && !protectedAudio;
    const canReplace=short && !protectedAudio && clip.node!==F.target?.id;
    const alternatives=canReplace ? (source?.versions || []).filter(item=>
      item.ref && item.ref!==clip.ref && storyVersionShortage(clip,item)===0) : [];
    const preferred=alternatives.includes(curV(source)) ? curV(source) : alternatives.at(-1);
    const status=!known ? "待核实素材时长" : short ?
      `素材缺 ${((wanted-available)/FILM_FPS).toFixed(2)} 秒` :
      current===wanted ? "已对齐" : protectedAudio ? "保留同步原声的剪辑点" :
      `当前片段${current<wanted?"少":"多"} ${(Math.abs(current-wanted)/FILM_FPS).toFixed(2)} 秒`;
    const stamp=JSON.stringify([clip.ref,clip.in,clip.out,speed,wanted,seconds,end,protectedAudio]);
    return [{clip,index,wanted,current,status,adjustable,out,stamp,short,known,canReplace,
      alternatives:alternatives.length,preferred:preferred?.ref}];
  });
}

function closeFilmStoryTiming(focus=false) {
  const dialog=$("#fmTimingDialog");
  if (!dialog.open) return;
  $("form",dialog).onsubmit=null;
  if (dialog.close) dialog.close();else dialog.removeAttribute("open");
  if (focus) $("#fmTiming").focus();
}

function openFilmStoryTiming(F) {
  const dialog=$("#fmTimingDialog"), form=$("form",dialog), list=$("[data-timing-list]",dialog);
  const rows=filmStoryTiming(F);
  if (!rows.length) return;
  const editable=()=>FILM===F && F.board===boardId && !F.busy && canvasCanEdit();
  playAll=false;
  const player=$("#fmV");
  if (!player.paused) player.pause();
  syncFilmAudio(F);
  $("[data-timing-summary]",dialog).textContent=
    `${rows.length} 段有镜长计划 · ${rows.filter(row=>row.short).length} 段素材不足 · ${rows.filter(row=>!row.known).length} 段待核实`;
  list.innerHTML=rows.map(({clip,index,wanted,current,status,adjustable,known,canReplace,alternatives})=>`<li>
    <span><strong>第 ${index+1} 段 · ${esc(clip.name || node(clip.node)?.name || "视频")}</strong>
      <small>计划 ${(wanted/FILM_FPS).toFixed(2)} 秒 · ${known?`当前 ${(current/FILM_FPS).toFixed(2)} 秒 · `:""}${esc(status)}
      ${canReplace ? alternatives ? ` · ${alternatives} 个备选版本原速够长` : " · 暂无够长的备选版本" : ""}</small></span>
    ${editable()&&adjustable?`<label><input type="checkbox" data-timing-check="${index}"> 对齐出点</label>`:""}
    ${editable()&&alternatives?`<button type="button" class="pill" data-timing-preview="${index}">预览备选</button>`:""}
    ${editable()&&canReplace&&!alternatives&&filmTimingShot(F,clip)?
      `<button type="button" class="pill" data-timing-retake="${index}">补拍计划</button>`:""}
    <button type="button" class="pill" data-timing-locate="${index}" aria-label="定位第 ${index+1} 段">定位</button>
  </li>`).join("");
  const apply=$("button[type=submit]",form);
  apply.hidden=!$("[data-timing-check]",list);
  apply.disabled=true;
  list.onchange=()=>{apply.disabled=!$("[data-timing-check]:checked",list);};
  list.onclick=event=>{
    const button=event.target.closest("[data-timing-locate],[data-timing-preview],[data-timing-retake]");
    if (!button) return;
    const preview=button.hasAttribute("data-timing-preview");
    const retake=button.hasAttribute("data-timing-retake");
    const row=rows.find(item=>item.index===Number(button.dataset.timingPreview ?? button.dataset.timingRetake ?? button.dataset.timingLocate));
    if (!row || FILM!==F || F.spec.clips[row.index]!==row.clip) return closeFilmStoryTiming(true);
    if ((preview || retake) && (!editable() || !filmStoryTiming(F).some(item=>
        item.index===row.index && item.stamp===row.stamp && item.preferred===row.preferred))) {
      openFilmStoryTiming(F);
      return toast("片段或备选版本已变更，请重新选择");
    }
    if (retake) {
      const shot=filmTimingShot(F,row.clip);
      if (!shot) { openFilmStoryTiming(F);return toast("分镜关联已变更，请重新核对"); }
      const filmReturn={key:F.key,nodeId:row.clip.node,ref:row.clip.ref,shotId:row.clip.story_shot};
      openScriptShotRun(shot.script,shot.index,{mode:"video",requiredSeconds:row.out,filmReturn});
      if ($("#groupRunConfirm").open) {
        closeFilm();
        selectOnly(row.clip.node);
        fit([node(row.clip.node)]);
      }
      return;
    }
    closeFilmStoryTiming();
    selectClip(row.index,0,false,preview?()=>{
      const box=$("#fmClip"), source=node(row.clip.node), trigger=$("[data-update-version]",box);
      if (editable() && source && trigger && !row.clip.remake_shot) {
        openFilmVersionPicker(F,row.clip,source,box,trigger,row.preferred);
      }
    }:null);
    $(`#fmTl .fc[data-i="${row.index}"]`)?.scrollIntoView?.({block:"nearest",inline:"nearest"});
    if (!preview) $("#fmTiming").focus();
  };
  form.onsubmit=event=>{
    event.preventDefault();
    if (!editable()) return closeFilmStoryTiming(true);
    const selected=new Set($$("[data-timing-check]:checked",list).map(input=>Number(input.dataset.timingCheck)));
    if (!selected.size) return;
    const latest=new Map(filmStoryTiming(F).map(row=>[row.index,row]));
    const changes=rows.filter(row=>selected.has(row.index));
    if (changes.some(row=>latest.get(row.index)?.clip!==row.clip || latest.get(row.index)?.stamp!==row.stamp)) {
      openFilmStoryTiming(F);
      return toast("片段或素材已变更，请重新核对出点");
    }
    const offset=filmClipOffset(F);
    changes.forEach(row=>Object.assign(row.clip,{out:row.out,tight:true}));
    closeFilmStoryTiming(true);
    renderFilm();selectClip(F.sel,Math.min(offset,clipLen(F.spec.clips[F.sel])));saveFilmDraft(F);
  };
  if (!dialog.open) {
    if (dialog.showModal) dialog.showModal();else dialog.setAttribute("open","");
  }
  $("[data-close]",dialog).focus();
}

function returnFilmTimingRetake(receipt,outputRef) {
  if (typeof receipt.key!=="string" || !receipt.key.startsWith(filmDraftPrefix())) return false;
  let saved;
  try { saved=JSON.parse(localStorage.getItem(receipt.key)); } catch {}
  if (!saved?.spec?.clips?.length) { toast("补拍对应的剪辑草稿已找不到");return false; }
  showFilm(saved.spec,node(saved.node),receipt.key,saved.target);
  const F=FILM;
  if (!F || F.key!==receipt.key) return false;
  const matches=F.spec.clips.map((clip,index)=>({clip,index})).filter(({clip})=>
    clip.node===receipt.nodeId && clip.ref===receipt.ref && clip.story_shot===receipt.shotId && !clip.story_split);
  if (matches.length!==1) {
    toast("草稿里的片段已变更，请核对当前位置");
    return true;
  }
  const {clip,index}=matches[0];
  selectClip(index,0,false,()=>{
    const source=node(clip.node), version=source?.versions.find(item=>item.ref===outputRef);
    const box=$("#fmClip"), trigger=$("[data-update-version]",box);
    if (canvasCanEdit() && trigger && !clip.audio_ref && !clip.remake_shot && !F.spec.remake_audio &&
        version && version.ref!==clip.ref && storyVersionShortage(clip,version)===0) {
      openFilmVersionPicker(F,clip,source,box,trigger,outputRef);
    } else openFilmStoryTiming(F);
  });
  return true;
}
