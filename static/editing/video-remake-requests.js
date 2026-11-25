"use strict";

function setupRemakeRequests(editor) {
  const { panel, url, el, player } = editor;

  const cancelling = new Set();
  let timer = null;
  let revision = 0;
  let liveJobs = {};

  function stopPolling() {
    clearTimeout(timer);
  }

  function schedulePoll() {
    clearTimeout(timer);
    if (!panel.isConnected || !editor.session) return;
    const ids = [...new Set(pendingTasks().map(task => task.job))];
    if (!ids.length) return;
    timer = setTimeout(async () => {
      if (!panel.isConnected) return;
      if (!editor.busy) {
        const pendingRevision = revision;
        try {
          const response = await fetch("/api/jobs?ids=" + encodeURIComponent(ids.join(",")));
          if (!response.ok) throw new Error("进度暂不可用，正在重连");
          const jobs = await response.json();
          const result = await remakeRequest(url);
          if (revision === pendingRevision && !editor.busy && panel.isConnected) {
            liveJobs = jobs;
            applySession(result);
            editor.renderPanel();
          }
        } catch (error) { editor.status(error.message); }
      }
      schedulePoll();
    }, 1500);
  }

  function pendingTasks() {
    const tasks = [];
    if (editor.session?.playback && editor.active(editor.session.playback)) tasks.push({job:editor.session.playback.job, label:"原片播放预览"});
    if (editor.session?.export && editor.active(editor.session.export)) tasks.push({job:editor.session.export.job, label:"成片合成"});
    for (const [index, shot] of (editor.session?.shots || []).entries()) {
      const label = `镜头 ${index + 1}`;
      if (shot.depth && editor.active(shot.depth)) tasks.push({job:shot.depth.job, label:`${label} · 深度参考`});
      for (const [key, frame] of Object.entries(shot.frames)) {
        const name = key === "first" ? "首帧预览" : key === "middle" ? "中间帧预览" : `${frame.at.toFixed(2)} 秒校正帧预览`;
        for (const preview of frame.previews.filter(editor.active)) tasks.push({job:preview.job, label:`${label} · ${name}`});
      }
      for (const video of (shot.videos || []).filter(editor.active)) {
        tasks.push({job:video.job, label:`${label} · ${video.mode === "local" ? "局部合成" : "镜头视频"}`});
      }
    }
    return tasks;
  }

  function taskProgress(job) {
    const data = liveJobs[job];
    if (cancelling.has(job)) return {text:"正在取消", percent:null};
    if (!data || data.state === "queued") {
      return {text:data?.prep ? "准备提交" : data?.ahead > 0 ? `排队中 · 前面 ${data.ahead} 个` : "排队中", percent:null};
    }
    const percent = Number.isFinite(data.value) && Number.isFinite(data.max) && data.max > 0
      ? Math.round(100 * Math.max(0, Math.min(1, data.value / data.max))) : null;
    const phase = EW_PHASES[data.phase] || "处理中";
    return {text:percent === null ? phase : `${phase} · ${percent}%`, percent};
  }

  function renderTasks() {
    const tasks = pendingTasks();
    const panelTasks = el(".rm-tasks");
    if (panelTasks.hidden && tasks.length) panelTasks.open = tasks.length === 1;
    panelTasks.hidden = !tasks.length;
    el("[data-task-summary]").textContent = tasks.length === 1
      ? `${tasks[0].label} · ${taskProgress(tasks[0].job).text}` : `${tasks.length} 个任务处理中`;
    el("[data-task-list]").replaceChildren(...tasks.map(task => {
      const {text, percent} = taskProgress(task.job);
      const row = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = `${task.label} · ${text}`;
      row.append(label);
      if (percent !== null) {
        const bar = document.createElement("progress");
        bar.max = 100;
        bar.value = percent;
        bar.setAttribute("aria-label", task.label);
        row.append(bar);
      }
      const cancel = editor.button("取消", () => cancelTask(task.job), editor.busy || cancelling.has(task.job));
      cancel.setAttribute("aria-label", `取消${task.label}`);
      row.append(cancel);
      return row;
    }));
  }

  async function cancelTask(job) {
    if (editor.busy || cancelling.has(job)) return;
    const requestRevision = ++revision;
    cancelling.add(job);
    renderTasks();
    try {
      await api("/api/cancel", {ids:[job]});
      const next = await remakeRequest(url);
      if (!editor.busy && requestRevision === revision && panel.isConnected) applySession(next);
    } catch (error) {
      editor.status(error.message);
    } finally {
      cancelling.delete(job);
      editor.renderPanel();
      schedulePoll();
    }
  }

  function applySession(next) {
    const cutChanged = next?.cut_revision !== editor.session?.cut_revision;
    editor.session = next;
    if (!cutChanged || !editor.session?.shots.length) return;
    editor.stopComparison();
    editor.shotIndex = editor.session.selected_shot ?? Math.min(editor.shotIndex, editor.session.shots.length - 1);
    editor.frameKey = "first";
    editor.versionId = editor.videoId = null;
    editor.originalEnd = null;
    player.currentTime = editor.currentShot().start;
    editor.fillViews();
  }

  async function change(action, extra={}) {
    if (editor.busy) return;
    revision++;
    editor.busy = true;
    editor.renderPanel();
    const cutAction = ["split_shot", "split_long_shot", "move_cut", "merge_shots", "undo_cut"].includes(action);
    editor.status(cutAction ? "正在更新剪辑点…" : {analyze:"正在拆分与分析镜头…",retry_analysis:"正在补充缺失的镜头分析…",select:"正在处理选区…",locate_person:"正在识别原片人物…",suggest_entry:"正在查找人物入画位置…",batch_locate_people:"正在为各镜头查找人物位置…",apply_person_hint:"正在按建议生成选区…",preview:"正在提交预览…",batch_previews:"正在提交各镜头的起始帧预览…",generate_video:"正在提交镜头生成…",batch_videos:"正在批量提交镜头视频…",localize:"正在提交局部合成…",export:"正在提交成片合成…",analyze_motion:"正在分析带时间点的原片画面…",prepare_depth:"正在提交深度参考…"}[action] || "");
    try {
      applySession(await remakeRequest(url, {action, shot:editor.shotIndex, frame:editor.frameKey, cut_revision:editor.session?.cut_revision ?? 0, ...extra}));
      if (action === "prepare_playback" && editor.session.playback?.ref && player.getAttribute("src") === remakeMedia(editor.session.playback.ref)) {
        player.load();
      }
      if (["analyze", "map_person", "remove_mapping"].includes(action)) editor.fillViews();
      if (["capture_correction", "suggest_entry"].includes(action) && editor.session.captured_frame) {
        editor.frameKey = editor.session.captured_frame;
        editor.versionId = null;
        if (action === "suggest_entry") {
          editor.stopComparison();
          editor.originalEnd = null;
          if (!editor.playbackError) player.currentTime = editor.currentFrame().at;
        }
      }
      if (action === "remove_correction") {
        editor.frameKey = "first";
        editor.versionId = null;
      }
      if (action === "preview" || action === "batch_previews") editor.versionId = null;
      if (["generate_video", "generate_depth_video", "batch_videos", "localize", "combine_roles"].includes(action)) editor.videoId = null;
      if (action === "batch_locate_people") {
        const {located, skipped, failed} = editor.session[action];
        const items = [`${located.length} 个镜头已标出位置，请逐镜确认`];
        if (skipped.length) items.push(`跳过 ${skipped.length} 个镜头`);
        for (const result of failed) items.push(`镜头 ${result.shot + 1}（${result.error}）`);
        editor.status(items.join("。"));
      } else if (action === "batch_previews" || action === "batch_videos") {
        const {submitted, skipped, failed} = editor.session[action];
        if (action === "batch_previews" && submitted.includes(editor.shotIndex)) {
          const key = editor.startPreviewKey(editor.currentShot());
          if (key && key !== "first" && key !== editor.frameKey) {
            editor.frameKey = key;
            editor.stopComparison();
            editor.originalEnd = null;
            player.currentTime = editor.currentFrame().at;
          }
        }
        const items = [`已提交 ${submitted.length} 个镜头`];
        if (skipped.length) items.push(`跳过 ${skipped.length} 个镜头`);
        for (const result of failed) items.push(`镜头 ${result.shot + 1} 未提交（${result.error}）`);
        editor.status(items.join("。"));
      } else if (action === "suggest_entry") {
        editor.status(editor.personSelection(editor.currentFrame()) ? "已定位到候选入画帧，请核对此帧的人物选区。" :
          "已找到候选入画帧，请核对人物位置后确认。");
      } else {
        editor.status(cutAction && editor.session.mapping ? "剪辑点已更新，请核对人物映射范围。" : "");
      }
    } catch (error) { editor.status(error.message); }
    finally { editor.busy = false; editor.renderPanel(); schedulePoll(); }
  }

  Object.assign(editor, { stopPolling, schedulePoll, taskProgress, renderTasks, change });
}
