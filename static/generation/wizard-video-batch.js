"use strict";

const wizardVideoBatchPath = id => "/api/wizard/video-batches/"+encodeURIComponent(id);

function adoptWizardBatchFilm(batch, film) {
  let out = node(batch.filmNode);
  if (out?.data.film?.story_script !== film.timeline.story_script && out) throw new Error("成片节点已变化");
  if (out?.job || curV(out)) return out;
  if (!out) {
    const sources = film.timeline.clips.map(clip => node(clip.node)).filter(Boolean);
    const right = sources.reduce((x,y) => !x || y.x + size(y).w > x.x + size(x).w ? y : x,null);
    const at = right ? freeSpot(right.x + size(right).w + 110,right.y,"video") : freeSpot(0,0,"video");
    out = addNode("video",at.x,at.y,{film:film.timeline},{id:batch.filmNode,name:OneShotI18n.t("成片")});
  }
  const clips = film.timeline.clips.map(({node,ref,in:at,out:end,trans})=>({node,ref,in:at,out:end,trans}));
  out.job = {ids:[film.job_id],prompt:"",t0:Date.now(),st:{},source:"film",history:{film_recipe:{clips,audio:[]}}};
  save(); render(out); poll();
  return out;
}

async function pauseWizardProduction(run) {
  const t = OneShotI18n.t, batch = run.videoBatch, bid = boardId;
  if (W?.production !== run || run.status !== "running") return;
  wizardProductionStatus(run,"paused",t("制作已暂停"));
  if (batch?.started) {
    try { await api(wizardVideoBatchPath(batch.id),{board:bid,paused:true},"PUT"); }
    catch {
      if (W?.production === run && run.status === "paused")
        wizardProductionStatus(run,"paused",t("未能确认服务器暂停，已接收的镜头批次可能继续运行。"));
    }
  }
}

async function runWizardVideoBatch(run, script, {active,persist,wait}) {
  const bid = boardId, t = OneShotI18n.t, pairs = shotPairs();
  let batch = run.videoBatch;
  if (!batch) {
    const entries = [];
    for (const {vid} of pairs) {
      if (!active()) return false;
      if (storyboardVersionReady(vid) || vid.job || prepping.has(vid.id)) continue;
      if (nodeLocked(vid)) throw new Error(t("节点「{name}」已锁定。",{name:vid.name}));
      setWizardVideoQuality(vid,W.takes);
      const snapshot = await generate(vid,{batchLayout:"tabs",snapshotOnly:true});
      if (!snapshot) throw new Error(canvasGenerationError(vid) || t("未生成「{name}」。",{name:vid.name}));
      entries.push({node:vid.id,key:filmExportKey(),snapshot,previous:curV(vid)?.ref});
    }
    const queued = new Set(entries.map(entry=>entry.node));
    const assembly = pairs.length === script.data.shots.length && pairs.every(({vid})=>queued.has(vid.id)||storyboardVersionReady(vid))
      ? pairs.map(({vid})=>({node:vid.id,ref:queued.has(vid.id)?null:curV(vid).ref})) : null;
    if ((entries.length || assembly) && active()) {
      batch = run.videoBatch = {id:filmExportKey(),entries,...(assembly?{assembly,filmNode:newCanvasNodeId()}:{})};
      await persist();
    }
  }
  if (batch && active()) {
    const path = wizardVideoBatchPath(batch.id);
    let status = await api("/api/wizard/video-batches",{id:batch.id,board:bid,script:script.id,
      entries:batch.entries.map(({node,key,snapshot})=>({node,key,payload:snapshot.payload})),
      ...(batch.assembly?{assembly:batch.assembly}:{})});
    batch.started = true;
    if (!active()) {
      if (run.status === "paused") await api(path,{board:bid,paused:true},"PUT");
      return false;
    }
    if (status.state === "paused" && batch.resumeRequested) {
      await api(path,{board:bid,paused:false},"PUT");
      status = await api(path+"?"+new URLSearchParams({board:bid}),null,"GET");
    }
    delete batch.resumeRequested;
    await persist();

    const snapshots = new Map(batch.entries.map(entry=>[entry.node,entry]));
    while (active()) {
      let attached = false;
      for (const receipt of status.entries) {
        const entry = snapshots.get(receipt.node), media = node(receipt.node);
        if (!entry || !media || entry.attached || !receipt.result || media.job || curV(media)?.ref !== entry.previous) continue;
        rememberVideoVersion(media);
        applyCanvasGenerationReceipt(media,receipt.result,entry.snapshot);
        entry.attached = attached = true;
      }
      if (attached) await persist();
      if (!active()) return false;
      if (status.film?.state === "rendering" && !run.message)
        wizardProductionStatus(run,"running",t("服务器正在合成初稿…"));
      if (status.state === "done") break;
      if (status.state === "paused") {
        wizardProductionStatus(run,"paused",t("服务器已暂停剩余镜头。"));
        return false;
      }
      await sleep(1200);
      if (!active()) return false;
      status = await api(path+"?"+new URLSearchParams({board:bid}),null,"GET");
    }
    if (!active()) return false;
    for (const {vid} of pairs) if (!await wait(vid)) return false;
    const uncertain = status.entries.find(entry=>entry.state==="uncertain"&&!storyboardVersionReady(node(entry.node)));
    if (uncertain) {
      wizardProductionStatus(run,"uncertain",uncertain.error || t("提交状态未记录。先检查任务中心，再确认重试。"));
      return false;
    }
    const failure = status.entries.find(entry=>!storyboardVersionReady(node(entry.node)));
    if (!failure && status.film?.state === "done" && batch.filmNode) {
      const film = adoptWizardBatchFilm(batch,status.film);
      await persist();
      if (!await wait(film)) return false;
      if (!curV(film)) throw new Error(canvasGenerationError(film) || t("成片尚未生成。"));
    }
    run.videoBatch = null;
    if (!failure && status.film?.state === "error") run.stage = W.step = 5;
    await persist();
    if (failure) throw new Error(failure.error || t("仍有镜头缺少视频。"));
    if (status.film?.state === "error") throw new Error(status.film.error || t("成片尚未生成。"));
    return active();
  }
  for (const {vid} of pairs) if (!await wait(vid)) return false;
  return active();
}
