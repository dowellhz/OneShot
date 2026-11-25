"use strict";

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
