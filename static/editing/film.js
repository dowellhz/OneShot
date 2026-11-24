"use strict";
// 成片编辑 (timeline: order, trim, transitions, subtitles, music, narration, cover, aspect), the queue panel with ETAs,
// and the "all done" notice. Loaded before the main script; the main script calls initFilm() before it boots.

const TRANS_CN = { cut: "硬切", fade: "叠化", black: "黑场" };
const FIT_CN = { pad: "加黑边", blur: "模糊背景填充", crop: "裁切铺满" };
const ASPECT_CN = { source: "跟随原片", "16:9": "横屏 16:9", "9:16": "竖屏 9:16", "1:1": "方形 1:1", "4:3": "4:3", "3:4": "3:4" };
const FILM_FPS = 24;
let FILM = null;            // { n (film node or null), spec, sel, srcIds }
let voiceList = null;

function filmDraftPrefix() { return `oneshot.film:${ME_USER?.id ?? "local"}:${boardId}:`; }
function filmDraftKey(spec, n) {
  return filmDraftPrefix() + (n ? n.id : JSON.stringify([spec.remake_audio || "", spec.clips.map(c => c.node)]));
}
function saveFilmDraft(F = FILM) {
  if (!F || F.board !== boardId) return;
  if (F.n?.data.playlist && !canvasCanEdit()) return;
  if (ME_USER?.id == null) return;
  const reuse = $("#fmStoryReuse");
  if (F.story && !reuse.hidden && F.story.base !== storyDraftSignature(F.spec)) reuse.hidden = true;
  const clip = F.spec.clips[F.sel];
  const offset = clip ? Math.max(0, Math.min(clipLen(clip), filmClipOffset(F))) : 0;
  const spec = {...F.spec, clips:F.spec.clips.map(({src_len, ...c}) => c)};
  const state = JSON.stringify({spec, sel:F.sel, offset:Math.round(offset * 4) / 4, node:F.n?.id, target:F.target,
    attempt:F.attempt,canvasAttempt:F.canvasAttempt,downloadExport:F.downloadExport,playlistBase:F.playlistBase,storySource:F.storySource});
  if (state === F.saved) return;
  try {
    localStorage.setItem(F.key, state);
    localStorage.setItem(filmDraftPrefix() + "latest", F.key);
    if (F.n) localStorage.setItem(filmDraftKey(spec, F.n), state);
    F.saved = state;
    $("#fmDraftState").textContent = "草稿已保存到此浏览器";
  } catch {
    $("#fmDraftState").textContent = "浏览器空间不足，草稿未保存";
  }
}

function resumeFilmDraft() {
  try {
    const key = localStorage.getItem(filmDraftPrefix() + "latest");
    const saved = key && JSON.parse(localStorage.getItem(key));
    const owner = saved?.node ? node(saved.node) : null;
    if (owner?.data.playlist) return openFilm(owner);
    if (saved?.playlistBase) return toast("播放列表已从画布移除");
    if (saved?.spec?.clips?.length) return showFilm(saved.spec, node(saved.node), key, saved.target);
  } catch {}
  toast("此项目没有剪辑草稿");
}

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

function storyFilmSelection(script, start = 0, end = script.data.shots.length - 1) {
  const links = scriptShotLinks(script), media = [], missing = [];
  for (let i = start; i <= end; i++) {
    const source = node(links[i]?.vid);
    if (source?.type === "video" && curV(source)?.ref) media.push(source);
    else missing.push(i + 1);
  }
  return {media, missing};
}

function openStoryFilm(script, start = 0, end = script.data.shots.length - 1, transition = "cut") {
  const {media, missing} = storyFilmSelection(script, start, end);
  if (missing.length) {
    toast(`镜头 ${missing.join("、")} 缺少视频。可先补齐，或到镜头清单选择已完成的连续片段。`, 4500);
    return false;
  }
  if (!media.length) return false;
  const spec = newSpec(media);
  if (start === 0 && end === script.data.shots.length - 1) spec.story_script = script.id;
  const selectedShots = script.data.shots.slice(start, end + 1);
  const keys = selectedShots.map((shot, i) => shot.id || `index:${start+i}`);
  spec.story_tracking = true;
  const shots = spec.clips.map((clip,i) => {
    const shot=selectedShots[i], range=shot.previs_range;
    clip.trans=transition;
    clip.story_shot=keys[i];
    const whitebox=Array.isArray(range) && range.length===2 && range.every(Number.isSafeInteger) && range[0]>=0 && range[1]>range[0];
    const frames=Number.isFinite(shot.duration) && shot.duration>0 ? Math.max(1,Math.round(shot.duration*FILM_FPS)) :
      whitebox ? range[1]-range[0] : null;
    if (whitebox) clip.trans="cut";
    if (Number.isSafeInteger(frames)) {
      clip.story_frames=frames;
      const seconds=curV(media[i]).seconds;
      if (Number.isFinite(seconds) && seconds>0) alignStoryClipLength(clip,seconds);
      else clip.story_pending_length=true;
    }
    return {id:keys[i],node:clip.node,ref:clip.ref,number:start+i+1,frames};
  });
  const scope = [script.id,keys];
  const key = filmDraftPrefix()+"story:"+JSON.stringify([...scope,shots.map(shot=>[shot.node,shot.ref])]);
  showFilm(spec,null,key,null,{scope,shots,base:storyDraftSignature(spec)});
  return true;
}

function storyDraftSignature(spec) {
  return JSON.stringify(spec, (key,value) => ["src_len","story_tracking","story_shot","story_frames","story_pending_length"].includes(key) ? undefined : value);
}

function refreshStoryClipPlans(spec, story) {
  if (!spec.story_tracking || !story) return;
  const plans=new Map(story.shots.map(shot=>[shot.id,shot])), occurrences=new Map();
  for (const clip of spec.clips) {
    if (clip.story_shot) occurrences.set(clip.story_shot,(occurrences.get(clip.story_shot) || 0)+1);
  }
  for (const clip of spec.clips) {
    const plan=plans.get(clip.story_shot);
    if (!plan || clip.node!==plan.node || clip.story_split || occurrences.get(clip.story_shot)!==1) continue;
    if (Number.isSafeInteger(plan.frames)) clip.story_frames=plan.frames;
    else {
      delete clip.story_frames;
      delete clip.story_pending_length;
    }
  }
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

function earlierStoryDrafts(F) {
  const prefix = filmDraftPrefix()+"story:", scope = JSON.stringify(F.story.scope);
  const drafts = [];
  try {
    const latest = localStorage.getItem(filmDraftPrefix()+"latest");
    for (let i=localStorage.length-1;i>=0;i--) {
      const key = localStorage.key(i);
      if (!key?.startsWith(prefix) || key===F.key) continue;
      try {
        const [script,ids,refs] = JSON.parse(key.slice(prefix.length));
        if (JSON.stringify([script,ids])!==scope || refs.length!==F.story.shots.length ||
            refs.some((entry,j)=>entry[0]!==F.story.shots[j].node)) continue;
        const saved = JSON.parse(localStorage.getItem(key));
        if (saved?.spec?.clips?.length) drafts.push({saved,refs,latest:key===latest});
      } catch {}
    }
  } catch {}
  return drafts.sort((a,b)=>Number(b.latest)-Number(a.latest));
}

function reuseStoryDraft(F, draft) {
  const spec = JSON.parse(JSON.stringify(draft.saved.spec)), updates = new Map(), legacy = new Map();
  const shots = F.story.shots.map((shot,i) => {
    const source = node(shot.node), oldRef = draft.refs[i][1];
    const to = source?.versions.findIndex(v=>v.ref===shot.ref) ?? -1;
    const status = {...shot,to,count:0,skipped:0};
    const entry = {status,source,oldRef};
    updates.set(shot.id,entry);
    legacy.set(shot.node,legacy.has(shot.node) ? null : entry);
    return status;
  });
  for (const clip of spec.clips) {
    const entry = spec.story_tracking ? updates.get(clip.story_shot) : legacy.get(clip.node);
    if (!entry || clip.node!==entry.status.node || clip.remake_shot ||
        (!spec.story_tracking && clip.ref!==entry.oldRef)) continue;
    const {status,source} = entry;
    clip.story_shot=status.id;
    if (clip.ref===status.ref || status.to<0) continue;
    try {
      const {shorter,...changes} = filmVersionReplacement(clip,source.versions[status.to],source);
      if (shorter>1e-6) throw new Error("新版本过短");
      Object.assign(clip,changes,{story_shot:status.id});
      delete clip.src_len;
      status.count++;
    } catch { status.skipped++; }
  }
  spec.story_tracking = true;
  if (F.spec.story_script) spec.story_script = F.story.scope[0];
  else delete spec.story_script;
  refreshStoryClipPlans(spec,F.story);
  return {spec,shots};
}

function openStoryDraftPicker(F) {
  const editable = () => FILM===F && F.board===boardId && canvasCanEdit() && !F.busy && !F.n &&
    F.story.base===storyDraftSignature(F.spec);
  if (!editable()) return toast("当前剪辑已有改动");
  const drafts = earlierStoryDrafts(F);
  if (!drafts.length) return toast("没有可沿用的剪辑草稿");
  const dialog = $("#fmStoryDialog"), list = $("ol",dialog), choice = $("select",dialog);
  choice.replaceChildren(...drafts.map(({saved,refs},i)=>new Option(
    `草稿 ${i+1} · ${saved.spec.clips.length} 段 · ${refs.map(([id,ref])=>{
      const version=node(id)?.versions.findIndex(v=>v.ref===ref) ?? -1;
      return version<0?"历史版本":`V${version+1}`;
    }).join(" / ")}`,String(i))));
  choice.selectedIndex=0;
  const describe = () => {
    const {shots} = reuseStoryDraft(F,drafts[Number(choice.value)]);
    list.replaceChildren(...shots.map(({number,to,count,skipped})=>{
      const item=document.createElement("li");
      const changes = [count?`${count} 段改用版本 ${to+1}`:"",skipped?`${skipped} 段因新版本过短保留原素材`:""].filter(Boolean);
      item.textContent=`镜头 ${number} · ${changes.join("，") || "沿用草稿中的选择"}`;
      return item;
    }));
  };
  choice.onchange=describe;
  $("form",dialog).onsubmit=event=>{
    event.preventDefault();
    if (!editable()) { closeStoryDraftPicker(); return; }
    let saved;
    try { saved = JSON.parse(localStorage.getItem(F.key)); } catch {}
    if (saved?.spec && F.story.base!==storyDraftSignature(saved.spec)) {
      closeStoryDraftPicker();
      return toast("此剪辑草稿已有改动，请重新打开剪辑");
    }
    const script=node(F.story.scope[0]), first=F.story.shots[0].number-1;
    const current=script?.type==="script" ? storyFilmSelection(script,first,first+F.story.shots.length-1) : null;
    if (!current || current.missing.length || F.story.shots.some((shot,i)=>
        current.media[i]?.id!==shot.node || curV(current.media[i])?.ref!==shot.ref ||
        (script.data.shots[first+i]?.id || `index:${first+i}`)!==shot.id)) {
      closeStoryDraftPicker();
      return toast("当前分镜或视频版本已变更，请重新打开剪辑");
    }
    const draft=drafts[Number(choice.value)];
    const {spec}=reuseStoryDraft(F,draft);
    F.spec=spec;
    F.sel=Math.max(0,Math.min(spec.clips.length-1,draft.saved.sel||0));
    closeStoryDraftPicker();
    $("#fmStoryReuse").hidden=true;
    renderFilm(); selectClip(F.sel,Math.min(clipLen(spec.clips[F.sel]),draft.saved.offset||0)); saveFilmDraft(F);
    toast("已沿用剪辑草稿");
  };
  describe();
  if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open","");
  choice.focus();
}

function closeStoryDraftPicker() {
  const dialog=$("#fmStoryDialog");
  if (dialog.open && dialog.close) dialog.close(); else dialog.removeAttribute("open");
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
  showFilm(spec, n);
}
function editVideoTimeline(n, version = curV(n)) {
  if (!canvasCanEdit() || !version?.ref || !n.versions.includes(version)) return;
  if (n.job || prepping.has(n.id)) return toast("请等待当前视频任务完成后再剪辑");
  const target = {id:n.id, ref:version.ref};
  const key = filmDraftPrefix() + "video:" + JSON.stringify([target.id,target.ref]);
  const saved = version.film_recipe?.timeline;
  const spec = saved?.clips?.length ? vtClone(saved) : {...newSpec([]),clips:[filmClipForVersion(n,version)]};
  showFilm(spec, null, key, target);
}
function showFilm(spec, n = null, key = filmDraftKey(spec, n), target = null, story = null) {
  if (target && !node(target.id)?.versions.some(v => v.ref === target.ref)) return toast("剪辑草稿对应的视频版本已移除");
  closeStoryDraftPicker();
  closeStorySlowdown();
  closeFilmStoryTiming();
  stopFilmVersionPreview(FILM);
  finishFilmPlaylistPicker(false,false);
  if (FILM) { saveFilmDraft(); syncFilmAudio(FILM); }
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
  renderFilm(); selectClip(sel, saved?.offset || 0);
  saveFilmDraft();
}
function closeFilm() {
  closeStoryDraftPicker();
  closeStorySlowdown();
  closeFilmStoryTiming();
  stopFilmVersionPreview(FILM);
  closePlaylistClipMenu();
  finishFilmPlaylistPicker(false,false);
  saveFilmDraft(); if (FILM) syncFilmAudio(FILM);
  playAll = false; FILM = null;
  clearFilmCutawayPreview();
  const transfer=$("#assetTransferPanel");
  if (transfer.parentElement===$("#film")) document.body.append(transfer);
  $("#film").classList.remove("on"); $("#fmAdd").classList.remove("on");
  for (const id of ["fmV", "fmOriginal", "fmA"]) {
    const media = $("#"+id);
    if (!media.paused) media.pause();
  }
}

function renderFilm() {
  closePlaylistClipMenu();
  const F = FILM, s = F.spec, total = filmTotal(s);
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
  set.innerHTML = `
    <h4>画面</h4>
    <label>画幅${opt("aspect", ASPECT_CN, s.aspect)}</label>
    ${s.aspect !== "source" ? `<label>比例不同时${opt("fit", FIT_CN, s.fit)}</label>` : ""}
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
    ${bg ? `<div class="bgm"><span title="${esc(bg.name || "")}">♪ ${esc(bg.name || "音乐")}</span><button class="pill" data-b="play">试听</button><button class="pill" data-b="rm">移除</button></div>
      <label>音量<input type="range" min="0.05" max="1" step="0.05" value="${bg.volume}" data-bk="volume"><span>${Math.round(bg.volume * 100)}%</span></label>
      <label class="ck"><input type="checkbox" data-bk="duck" ${bg.duck !== false ? "checked" : ""}>有台词和旁白时自动压低音乐</label>`
      : `<button class="pill" data-b="up">上传音乐（mp3 / wav / m4a）</button><div class="h">没有配乐模型，可以用自己的音乐；会自动循环并在结尾淡出</div>`}
    <h4>旁白配音</h4>
    <div id="fmNarr"></div>
    <button class="pill" data-b="narr">＋ 添加一段旁白</button>
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
    narr: () => { s.narration.push({ text: "", voice: voiceList?.voices?.[0]?.id || "zf_001", speed: 1, start: +(timelinePos() || 0).toFixed(1), volume: 1 }); renderNarr(); },
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
  renderFilmAudio();
  renderFilmTitles();
  renderFilmCutaways();
}
async function fetchOk(url, opt) { const r = await fetch(url, opt); if (!r.ok) { let m = r.statusText; try { m = (await r.json()).error || m; } catch {} throw new Error(m); } return r; }
function pickAudio(cb) { const i = document.createElement("input"); i.type = "file"; i.accept = "audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg"; i.onchange = () => i.files[0] && cb(i.files[0]); i.click(); }

function addFilmAudio(F, audio, start) {
  (F.spec.audio_clips ||= []).push({ref:audio.ref, name:audio.name, seconds:audio.seconds, node:audio.node,
    start, in:0, out:audio.seconds, volume:1});
  renderFilmAudio();
  saveFilmDraft(F);
}

function uploadFilmAudio(F, timed) {
  const start = +timelinePos().toFixed(2);
  pickAudio(async file => {
    const body = new FormData(); body.append("file", file);
    try {
      const audio = await (await fetchOk("/api/upload_audio", {method:"POST", body})).json();
      if (FILM !== F || F.board !== boardId) return;
      if (timed) {
        addFilmAudio(F,audio,start);
        return;
      } else {
        F.spec.bgm = {ref:audio.ref, url:audio.url, name:audio.name, volume:.35, duck:true};
        renderFilm();
      }
      saveFilmDraft(F);
    } catch (e) { toast(e.message, 4000); }
  });
}

function filmAudioTranscripts(track) {
  return B.nodes.filter(n=>n.type === "text" && n.data.transcript?.source_ref === track.ref &&
    Array.isArray(n.data.transcript.cues) && n.data.transcript.cues.length);
}

function filmAudioCaption(spec,time) {
  for (const track of spec.audio_clips || []) {
    const start = track.start ?? 0, begin = track.in ?? 0, end = track.out ?? track.seconds;
    if (!Array.isArray(track.captions) || time < start || time >= start + end - begin) continue;
    const source = begin + time - start;
    const cue = track.captions.find(cue=>source >= cue?.start && source < cue.end && cue.text?.trim());
    if (cue) return cue.text;
  }
  return "";
}

function renderFilmAudio() {
  const F = FILM, box = $("#fmAudioSettings"), tracks = F.spec.audio_clips || [];
  box.innerHTML = tracks.map((clip, i) => {
    const choices = filmAudioTranscripts(clip);
    const saved = clip.captions?.length ? `<option value=":saved" selected>已采用的字幕 · ${clip.captions.length} 条</option>` : "";
    return `<div class="nar" data-audio-index="${i}">
    <div class="nr"><b title="${esc(clip.name)}">${esc(clip.name)}</b><button class="pill" type="button" data-audio-locate>定位</button><button class="pill" type="button" data-audio-remove>移除</button></div>
    <div class="nr">${[["start","起点",null],["in","入点",clip.seconds],["out","出点",clip.seconds]].map(([key,label,max]) =>
      `<label>${label}<input type="number" data-audio-key="${key}" min="0" ${max === null ? "" : `max="${max}"`} step="0.01" value="${clip[key]}">秒</label>`).join("")}</div>
    <label>音量<input type="range" data-audio-key="volume" min="0" max="1" step="0.01" value="${clip.volume}"><output>${Math.round(clip.volume * 100)}%</output></label>
    ${saved || choices.length ? `<label>旁白字幕<select data-audio-transcript aria-label="${esc(clip.name)}的旁白字幕" ${canvasCanEdit() ? "" : "disabled"}>
      <option value="">不使用旁白字幕</option>${saved}${choices.map(n=>`<option value="${esc(n.id)}">采用 ${esc(n.name)}</option>`).join("")}</select></label>` : ""}
  </div>`;
  }).join("");
  $$("[data-audio-index]", box).forEach(row => {
    const index = Number(row.dataset.audioIndex), clip = tracks[index];
    const captions = $("[data-audio-transcript]",row);
    if (captions) captions.onchange = () => {
      if (!canvasCanEdit() || captions.value === ":saved") return;
      if (captions.value) {
        const source = filmAudioTranscripts(clip).find(n=>n.id===captions.value);
        if (!source) { renderFilmAudio(); return toast("所选转写已移除，请重新选择"); }
        clip.captions = vtClone(source.data.transcript.cues);
        F.spec.subtitles = true;
      } else delete clip.captions;
      saveFilmDraft(F);
      renderFilm();
      previewTick();
    };
    $("[data-audio-locate]", row).onclick = () => seekTimeline(Math.min(clip.start, filmTotal(F.spec)));
    $("[data-audio-remove]", row).onclick = () => {
      tracks.splice(index, 1); syncFilmAudio(F); renderFilmAudio(); saveFilmDraft(F);
    };
    $$("[data-audio-key]", row).forEach(input => input.onchange = () => {
      const key = input.dataset.audioKey, value = input.valueAsNumber;
      if (!Number.isFinite(value) || value < 0 || key === "in" && value >= clip.out ||
          key === "out" && (value <= clip.in || value > clip.seconds)) {
        input.value = clip[key]; toast("请检查音频时间，出点须晚于入点"); return;
      }
      clip[key] = value;
      if (key === "volume") input.nextElementSibling.textContent = Math.round(value * 100) + "%";
      syncFilmAudio(F); renderFilmAudioLanes(); saveFilmDraft(F);
    });
  });
  renderFilmAudioLanes();
}

function renderFilmAudioLanes() {
  const F = FILM, host = $("#fmAudioLanes"), tracks = F.spec.audio_clips || [], total = filmTotal(F.spec);
  $("#fmTime").max = total;
  host.hidden = !tracks.length;
  host.innerHTML = tracks.map((clip, i) => {
    const start = Math.min(total, clip.start);
    const end = Math.min(total, clip.start + clip.out - clip.in);
    const label = start >= total ? `${esc(clip.name)} · 超出成片范围` : esc(clip.name);
    const position = start >= total ? "left:0;max-width:100%" : `left:${100 * start / total}%;width:${100 * (end - start) / total}%`;
    return `<div class="fm-audio-lane"><button type="button" data-audio-jump="${i}" style="${position}" title="${esc(clip.name)} · ${clip.start.toFixed(2)}s">${label}</button></div>`;
  }).join("");
  $$("[data-audio-jump]", host).forEach(button => button.onclick = () => {
    const index = Number(button.dataset.audioJump);
    seekTimeline(Math.min(tracks[index].start, total));
    $("[data-audio-index='"+index+"'] [data-audio-locate]").focus();
  });
}

function syncFilmAudio(F, time) {
  const players = F.audioPlayers ||= new Map();
  const active = new Set();
  if (Number.isFinite(time)) for (const clip of F.spec.audio_clips || []) {
    const offset = clip.in + time - clip.start;
    if (offset < clip.in || offset >= clip.out || !clip.volume) continue;
    active.add(clip);
    let player = players.get(clip);
    if (!player) {
      player = {media:new Audio(remakeMedia(clip.ref)), pending:false, blocked:false};
      players.set(clip, player);
    }
    const media = player.media;
    media.volume = clip.volume;
    if (Math.abs(media.currentTime - offset) > .12) media.currentTime = offset;
    if (media.paused && !player.pending && !player.blocked) {
      player.pending = true;
      media.play().catch(() => { player.blocked = true; }).finally(() => { player.pending = false; });
    }
  }
  for (const [clip, player] of players) {
    if (!active.has(clip)) { player.media.pause(); players.delete(clip); }
  }
}

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
    $("#fmStillPlay").textContent = "播放";
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
  button.textContent = "正在识别…";
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
  const volumeLabel = c.audio_ref ? "原片音量" : "原声音量";
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
  const captions = c.captions ? `<div class="fm-captions" aria-label="时间码字幕">
    ${c.captions.map((cue,i) => `<div class="fm-caption" data-cue="${i}">
      <button class="pill" type="button" data-cue-seek aria-label="定位第 ${i+1} 条字幕">▶</button>
      <input type="number" min="0" step=".001" data-cue-time="start" value="${esc(cue.start)}" aria-label="第 ${i+1} 条字幕开始时间">
      <input type="number" min="0" step=".001" data-cue-time="end" value="${esc(cue.end)}" aria-label="第 ${i+1} 条字幕结束时间">
      <input type="text" data-cue-text maxlength="500" value="${esc(cue.text)}" aria-label="第 ${i+1} 条字幕文本">
      <button class="pill" type="button" data-cue-remove aria-label="删除第 ${i+1} 条字幕">×</button>
    </div>`).join("")}</div>`
    : `<label>手写字幕（一行一句）<textarea data-film-lines rows="2" placeholder="这段没有字幕">${esc(c.subs.join("\n"))}</textarea></label>`;
  box.innerHTML = `<div class="row"><b>第 ${F.sel + 1} 段 · ${esc(c.name || node(c.node)?.name || "")}</b>
      <span class="grow"></span>${c.ref && (c.remake_shot || alternative) ? `<button class="pill" data-update-version ${c.remake_shot?"":'aria-expanded="false"'}>${c.remake_shot ? "更新这一镜" : "更换素材版本"}</button>` : ""}${trimControls}</div>
    ${isStill ? `<label class="still-duration">停留时长 <input type="number" min="0.5" max="60" step="0.1" value="${c.duration}"> 秒</label>` : `
    <div class="trim"><span>入点 <b>${(c.in || 0).toFixed(1)}s</b></span><input type="range" min="${baseIn}" max="${baseOut}" step="${seekStep}" value="${c.in || 0}" data-t="in">
      <input type="range" min="${baseIn}" max="${baseOut}" step="${seekStep}" value="${out}" data-t="out"><span>出点 <b>${out.toFixed(1)}s</b></span><span class="dim">保留 ${(out - (c.in || 0)).toFixed(1)}s / 原长 ${(baseOut - baseIn).toFixed(1)}s</span></div>`}
    ${planLength ? `<div class="row"><span class="dim">分镜计划 ${planLength.toFixed(2)} 秒 · 当前片段 ${displayClipSeconds(c)} 秒${pendingPlan?" · 待核实素材时长":""}${shortPlan?` · 素材时长不足，缺 ${(planLength-sourcePlayLength).toFixed(2)} 秒`:""}${beyondSlowdown?"（0.5 倍速仍不足）":""}</span>
      ${canvasCanEdit()&&!pendingPlan?'<button class="pill" type="button" data-a="story-length">按分镜时长</button>':""}
      ${slowdown&&canvasCanEdit()?'<button class="pill" type="button" data-story-slowdown>预览减速补齐</button>':""}</div>` : ""}
    <div class="row2">${captions}
      ${isStill ? "" : `<label class="vol">${volumeLabel}<input type="range" min="0" max="1.5" step="0.05" value="${c.volume}"><span>${Math.round(c.volume * 100)}%</span></label><label class="clip-speed">速度（倍）<input type="number" min="0.5" max="2" step="any" value="${filmSpeed(c)}" data-clip-speed></label>`}</div>`;
  if (!isStill && canvasCanEdit()) box.insertAdjacentHTML("beforeend", `<div class="row fm-caption-actions">
    <button class="pill" type="button" data-film-transcribe ${captionBusy ? "disabled" : ""}>${captionBusy ? "正在识别…" : c.captions ? "重新识别字幕" : "识别原声字幕"}</button>
    ${c.captions ? '<button class="pill" type="button" data-film-manual>改用手写字幕</button><span class="dim">时间为原片秒数</span>' : ""}</div>`);
  const vid = $("#fmV");
  if (F.n?.data.playlist) {
    const locate = document.createElement("button");
    locate.className = "pill";
    locate.type = "button";
    locate.textContent = "定位原片";
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
      $("#fmStillPlay").textContent = "播放";
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
  const txt = voiceCaption || (c.captions && F.spec.subtitles
    ? (timedVisible && c.captions.find(cue => sourcePosition >= cue.start && sourcePosition < cue.end)?.text || "")
    : filmSubtitleCues(lines, clipLen(c)).find(cue => offset >= cue.start && offset < cue.end)?.text || "");
  sub.textContent = txt; sub.style.fontSize = (F.spec.sub_size || 1) * 100 + "%"; sub.style.display = txt ? "" : "none";
  syncFilmOriginal();
  previewFilmCutaway(F,position,playing && !ended);
  const mainPlay = $("#fmMainPlay"), playLabel = playing && !ended ? "暂停" : "播放";
  if (mainPlay.textContent !== playLabel) mainPlay.textContent = playLabel;
  renderFilmTitlePreview(position);
  $("#fmTime").value = position;
  $("#fmTimeLabel").textContent = Math.min(Number($("#fmTime").max), position).toFixed(2) + "s";
  syncFilmAudio(F, playing && !ended ? position : undefined);
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

// ---- export: create / update the film node and render it as a job
async function exportFilm(destination="version") {
  const F = FILM;
  if (!F || F.busy || !canvasCanEdit()) return;
  const downloadOnly = destination==="download";
  if (destination==="canvas" && !F.n?.data.playlist) return;
  if (!F.spec.clips.length) return toast("先添加视频片段");
  if (F.captionRequests?.size) return toast("请等待字幕识别完成后再导出");
  if (!downloadOnly && F.n?.job) return toast("此成片仍在导出，请稍候");
  F.busy = true;
  $("#fmGo").disabled = $("#fmDownloadMerged").disabled = $("#fmExportCanvas").disabled = true;
  if(downloadOnly)$("#fmDownloadStatus").textContent="正在检查剪辑内容…";
  try { await submitFilm(F,destination); }
  catch (error) {
    if(FILM!==F)return;
    if(downloadOnly)$("#fmDownloadStatus").textContent=error.message;
    toast("导出失败：" + error.message, 5000);
  }
  finally {
    F.busy = false;
    if (FILM === F) $("#fmGo").disabled = $("#fmDownloadMerged").disabled = $("#fmExportCanvas").disabled =
      !canvasCanEdit() || !F.spec.clips.length;
  }
}

function filmExportKey() {
  return crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2,"0")).join("");
}

async function downloadFilmRender(F,spec) {
  const label=F.n.name;
  const active=()=>FILM===F && F.board===boardId && canvasCanEdit();
  const status=$("#fmDownloadStatus"), fingerprint=JSON.stringify(spec);
  if(F.downloadExport?.fingerprint!==fingerprint)F.downloadExport={fingerprint,key:filmExportKey()};
  const pending=F.downloadExport;
  saveFilmDraft(F);
  if(!pending.id){
    const response=await api("/api/render",{spec,board:F.board,label:label+" · 下载",request_key:pending.key});
    if(!active())return;
    pending.id=response.ids[0];
    saveFilmDraft(F);
  }
  while(active()){
    const job=(await boardRequest("/api/jobs?ids="+encodeURIComponent(pending.id)))[pending.id];
    if(!active())return;
    if(!job || job.state==="error" || job.state==="done"&&!job.outputs?.[0]?.ref){
      F.downloadExport=null;
      saveFilmDraft(F);
      throw new Error(job?.error || "成片文件不可用，请重新下载");
    }
    if(job.state==="done"){
      const ref=job.outputs?.[0]?.ref;
      const anchor=document.createElement("a");
      anchor.href=ewRefUrl(ref);
      anchor.download=label+".mp4";
      document.body.append(anchor);anchor.click();anchor.remove();
      status.textContent="成片已发送到浏览器下载";
      return;
    }
    status.textContent=job.state==="running"&&job.max>0?`正在合成 · ${Math.min(100,Math.round((job.value||0)*100/job.max))}%`:"等待合成…";
    await sleep(750);
  }
}

async function submitFilm(F,destination) {
  const s = vtClone(F.spec);
  const clips = s.clips.map(c => ({ c, v: filmVersion(c) }));
  const missing = clips.findIndex(x => !x.v);
  if (missing >= 0) { selectClip(missing); throw new Error(`第 ${missing + 1} 段素材已不存在`); }
  const narration = () => s.narration.filter(x => x.ref).map(x => ({ref:x.ref, start:x.start, volume:x.volume ?? 1}));
  const spec = {
    clips: clips.map(({ c, v }) => ({ ref: v.ref, kind:c.kind, duration:c.duration, in: c.in || 0, out: c.out, trans: c.trans, volume: c.volume, subs: c.subs, captions:c.captions,
      tight:c.tight, speed:c.speed, audio_ref:c.audio_ref, audio_start:c.audio_start, remake_shot:c.remake_shot && {...c.remake_shot, node:c.node} })),
    remake_audio:s.remake_audio,
    aspect: s.aspect, fit: s.fit, subtitles: s.subtitles, sub_size: s.sub_size, cover: s.cover || 0,
    titles: (s.titles || []).filter(title => title.text.trim()),
    cutaways: (s.cutaways || []).map(({node,ref,kind,start,duration,in:inPoint,memory_id,name,version})=>
      ({node,ref,kind,start,duration,in:inPoint,memory_id,name,version})),
    bgm: s.bgm ? { ref: s.bgm.ref, volume: s.bgm.volume, duck: s.bgm.duck !== false } : null,
    narration: narration(),
    audio_clips: (s.audio_clips || []).map(({ref,start,in:inPoint,out,volume,node,captions}) => ({ref,start,in:inPoint,out,volume,node,captions})),
  };
  const preflight = await api("/api/render/check", {spec, board:F.board});
  if (FILM !== F || F.board !== boardId) return;
  if (!preflight.ok) {
    const first = preflight.issues[0];
    if (Number.isInteger(first.clip)) selectClip(first.clip);
    if (Number.isInteger(first.audio)) $("#fmAudioSettings [data-audio-index='"+first.audio+"'] input")?.focus();
    throw new Error(first.error);
  }
  const pending = s.narration.filter(x => x.text.trim() && !x.ref);
  for (const x of pending) {
    toast(`正在为旁白配音（${pending.indexOf(x) + 1}/${pending.length}）…`, 8000);
    try {
      const r = await api("/api/tts", {text:x.text, voice:x.voice, speed:x.speed});
      x.ref = r.ref; x.seconds = r.seconds;
      const current = F.spec.narration[s.narration.indexOf(x)];
      if (current && !current.ref && ["text","voice","speed"].every(k => current[k] === x[k])) {
        current.ref = r.ref; current.seconds = r.seconds;
      }
      saveFilmDraft(F);
    } catch (e) { throw new Error("旁白配音失败：" + e.message); }
    if (FILM !== F || F.board !== boardId) return;
  }
  spec.narration = narration();
  if(destination==="download")return downloadFilmRender(F,spec);
  const newNode = destination==="canvas";
  const target = newNode ? null : F.target;
  let n = target ? node(target.id) : F.n && node(F.n.id);
  if (newNode && (!n?.data.playlist || n!==F.n)) throw new Error("播放列表已移除，请重新打开");
  const versionIndex = target ? n?.versions.findIndex(v => v.ref === target.ref) : -1;
  if (target && !(versionIndex >= 0)) throw new Error("剪辑所用的视频版本已移除");
  if (n?.job || prepping.has(n?.id)) throw new Error("节点正在处理另一个任务，请稍候");
  const sourceVersion = target ? vtSnapshot(n,versionIndex) : null;
  if (!target && !n?.data.playlist && !newNode) checkpoint();
  if (!n) {
    const src = clips.map(x => node(x.c.node)).filter(Boolean);
    const right = src.reduce((a, b) => !a || b.x + size(b).w > a.x + size(a).w ? b : a, null);
    const at = right ? freeSpot(right.x + size(right).w + 110, right.y, "video") : freeSpot(0, 0, "video");
    n = addNode("video", at.x, at.y, { aspect: s.aspect === "source" ? "auto" : s.aspect }, { name: "成片" });
    F.n = n;
  }
  const keep = s;
  keep.clips.forEach((c,i) => { c.ref = clips[i].v.ref; delete c.src_len; });
  if (!newNode && !target && n.data.playlist) {
    if (!saveFilmPlaylist(F,{notify:false,spec:keep})) return;
  } else if (!newNode && !target) n.data.film = keep;
  const fingerprint = JSON.stringify(spec);
  const attemptField = newNode ? "canvasAttempt" : "attempt";
  if (F[attemptField]?.fingerprint !== fingerprint) {
    F[attemptField] = {key:filmExportKey(), fingerprint,...(newNode?{nodeId:newCanvasNodeId()}:{})};
  }
  const attempt = F[attemptField];
  saveFilmDraft(F);
  const filmNodeId = n.id;
  const sourceBoard = B;
  prepping.add(filmNodeId);
  let r;
  try {
    save(); await flushSave();
    if (FILM !== F || F.board !== boardId || node(filmNodeId) !== n || n.job) return;
    const label = newNode ? n.name.slice(0,54)+" · 成片" : n.name;
    r = await api("/api/render", {spec, board:F.board, label, request_key:attempt.key,
      ...(target ? {target:{node:filmNodeId,ref:target.ref}} : {})});
    if (B!==sourceBoard || F.board !== boardId || node(filmNodeId) !== n || n.job) return;
    if (newNode) {
      const source = n, previous = node(attempt.nodeId);
      if (previous) {
        F[attemptField] = null;saveFilmDraft(F);return;
      }
      checkpoint();
      const at = freeSpot(source.x+size(source).w+110,source.y,"video");
      n = addNode("video",at.x,at.y,{aspect:s.aspect==="source"?"auto":s.aspect,film:keep},
                  {id:attempt.nodeId,name:label});
    }
  } finally {
    prepping.delete(filmNodeId);
  }
  F[attemptField] = null;
  saveFilmDraft(F);
  const filmRecipe = {
    clips:spec.clips.map(({ref,in:at,out,duration,trans,speed,audio_ref,audio_start}, index)=>
      ({node:clips[index].c.node,ref,in:at,out,duration,trans,speed,audio_ref,audio_start})),
    audio:[
      ...(spec.remake_audio ? [{ref:spec.remake_audio,role:"original_sound"}] : []),
      ...(spec.bgm ? [{ref:spec.bgm.ref,role:"bgm"}] : []),
      ...spec.narration.map(({ref,start})=>({ref,start,role:"narration"})),
      ...spec.audio_clips.map(({ref,start,node})=>({ref,start,node,role:"audio"})),
    ],
    ...(spec.titles.length ? {titles:spec.titles} : {}),
    ...(spec.cutaways.length ? {cutaways:spec.cutaways} : {}),
  };
  const history = {film_recipe:filmRecipe};
  if (target) {
    checkpoint();
    rememberVideoVersion(n);
    history.node_data = sourceVersion.node_data;
    history.input_edges = sourceVersion.input_edges;
    history.mode = "剪辑";
    filmRecipe.timeline = keep;
  }
  n.job = { ids: r.ids, prompt: sourceVersion?.prompt || "", t0: Date.now(), st: {}, source:"film", history };
  save(); render(n); poll();
  if (FILM === F) { closeFilm();selectOnly(n.id);fit([n]); }
  toast(target ? "正在导出，完成后会加入原视频的版本 Tab" : `正在导出 ${preflight.dimensions.join("×")} 成片，完成后可在节点上播放和下载`, 4000);
}

// ================================================================= queue panel + ETAs + "all done"
let qOpen = false, qTimer = null;
const clock = sec => { const d = new Date(Date.now() + sec * 1000); return d.toTimeString().slice(0, 5); };
async function renderQueue() {
  const box = $("#qpJobs");
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
#fmAudioSettings .nr b { flex: 1; min-width: 100px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
#fmGo { background: #fff; color: #000; font-weight: 600; }
#qp { position: fixed; top: 54px; right: 14px; z-index: 31; width: 360px; max-height: 70vh; overflow-y: auto; display: none; flex-direction: column; gap: 4px; padding: 8px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 13px; box-shadow: 0 12px 40px rgba(0,0,0,.55); }
#qp.on { display: flex; } #qp .mt { padding: 4px 6px 6px; color: var(--dim); font-size: var(--fs-small); }
#qp .qj { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 9px; background: #1a1a1d; font-size: var(--fs-small); }
#qp .qj .ty { color: var(--faint); font-size: var(--fs-caption); width: 26px; } #qp .qj .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#qp .qj .nm[data-n] { cursor: pointer; } #qp .qj .nm[data-n]:hover { text-decoration: underline; }
#qp .qj.running .st { color: #ffcf5a; } #qp .qj .st { color: var(--dim); font-size: var(--fs-caption); white-space: nowrap; }
#qp .qj .x { border: none; background: none; color: var(--faint); font-size: var(--fs-heading); } #qp .qj .x:hover { color: var(--red); }
#qp .h { padding: 4px 6px; }
#qpJobs { display: contents; }
#qp [data-enable-notifications] { align-self: flex-end; }
#tr { cursor: pointer; }`;
  document.head.appendChild(css);
  document.body.insertAdjacentHTML("beforeend", `
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
<div id="qp"><div id="qpJobs"></div><button type="button" data-enable-notifications hidden>开启完成通知</button></div>`);
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
      $("#fmStillPlay").textContent = "播放";
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
  $("#tr").addEventListener("click", e => { if (!e.target.closest("button")) { e.stopPropagation(); toggleQueue(); } });
  for (const event of ["play","pause","seeked","ratechange"]) $("#fmV").addEventListener(event, syncFilmOriginal);
  $("#fmV").addEventListener("play",()=>stopFilmVersionPreview(FILM));
  $("#fmV").addEventListener("pause", () => { if (FILM) syncFilmAudio(FILM); });
  document.addEventListener("pointerdown", e => {
    if (qOpen && !e.target.closest("#qp, #tr")) toggleQueue(false);
    if (!e.target.closest("#fmAdd, .fadd")) $("#fmAdd").classList.remove("on");
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
  setInterval(watchDone, 1500);
}
