"use strict";

function setupRemakePlayback(editor) {
  const { player, result, el, panel } = editor;

  let comparison = null;
  let restorePlaybackTime = 0;

  player.ontimeupdate = () => {
    if (editor.originalEnd !== null && player.currentTime >= editor.originalEnd) {
      player.pause();
      editor.originalEnd = null;
    }
    renderCutControls();
  };
  player.onseeked = renderCutControls;
  function stopComparison() {
    if (!comparison) return;
    const {sourceMuted, resultMuted, sourceRate, frameCallback} = comparison;
    comparison = null;
    if (frameCallback != null) result.cancelVideoFrameCallback(frameCallback);
    player.pause();
    result.pause();
    player.controls = true;
    player.muted = sourceMuted;
    player.playbackRate = sourceRate;
    result.muted = resultMuted;
    const control = el("[data-compare]");
    if (control) control.textContent = "原声对照播放";
  }

  function syncComparison(force = false) {
    if (!comparison) return;
    const {start, end} = comparison;
    if (result.currentTime >= end - start) {
      stopComparison();
      return;
    }
    const at = start + result.currentTime;
    if (force || (!player.seeking && Math.abs(player.currentTime - at) > .12)) player.currentTime = at;
  }

  function playComparison(media, playback) {
    media.play().catch(error => {
      if (comparison !== playback || error.name === "AbortError") return;
      stopComparison();
      editor.status(error.message || "无法播放原声对照");
    });
  }

  function toggleComparison(shot, sourceUrl) {
    if (comparison) {
      stopComparison();
      return;
    }
    const playback = comparison = {
      start: shot.start, end: shot.end, sourceUrl,
      sourceMuted: player.muted, resultMuted: result.muted, sourceRate: player.playbackRate,
    };
    editor.originalEnd = null;
    player.controls = false;
    player.muted = false;
    result.muted = true;
    player.playbackRate = result.playbackRate;
    result.currentTime = 0;
    syncComparison(true);
    el("[data-compare]").textContent = "停止原声对照";
    playComparison(result, playback);
    playComparison(player, playback);
    if (result.requestVideoFrameCallback) {
      const onFrame = () => {
        syncComparison();
        if (comparison === playback) playback.frameCallback = result.requestVideoFrameCallback(onFrame);
      };
      playback.frameCallback = result.requestVideoFrameCallback(onFrame);
    }
  }

  result.ontimeupdate = () => syncComparison();
  result.onseeking = () => {
    if (!comparison) return;
    player.pause();
    syncComparison(true);
  };
  result.onplaying = result.onseeked = () => {
    const playback = comparison;
    if (!playback || result.paused || result.seeking) return;
    syncComparison();
    if (comparison && player.paused) playComparison(player, playback);
  };
  result.onpause = result.onwaiting = () => { if (comparison) player.pause(); };
  result.onended = result.onerror = stopComparison;
  player.onerror = () => {
    stopComparison();
    editor.playbackError = true;
    editor.renderPanel();
  };
  player.onloadedmetadata = () => {
    editor.playbackError = false;
    if (restorePlaybackTime > 0 && Number.isFinite(player.duration)) {
      player.currentTime = Math.min(restorePlaybackTime, player.duration);
    }
    restorePlaybackTime = 0;
    editor.renderPanel();
  };
  result.onratechange = () => { if (comparison) player.playbackRate = result.playbackRate; };

  function renderPlayback() {
    const playback = editor.session?.playback;
    const playingUrl = playback?.ref ? remakeMedia(playback.ref) : "";
    if (playingUrl && player.getAttribute("src") !== playingUrl) {
      stopComparison();
      restorePlaybackTime = player.currentTime;
      player.src = playingUrl;
    }
    const converting = !!playback && editor.active(playback);
    const controls = el("[data-playback]");
    controls.hidden = !editor.playbackError && !converting;
    el("[data-playback-status]").textContent = converting ? "正在生成浏览器可播放的预览…" :
      playback?.error || (playingUrl ? "播放预览暂不可用，可继续从已提取的画面操作。" : "浏览器无法播放原片，可生成兼容的播放预览。");
    const convert = el("[data-prepare-playback]");
    convert.hidden = !editor.playbackError || converting;
    convert.disabled = editor.busy;
    convert.textContent = playback?.error || playingUrl ? "重试播放预览" : "生成播放预览";
  }

  function renderCutControls() {
    const shot = editor.currentShot();
    el(".rm-cuts").hidden = !shot;
    if (!shot) return;
    const at = Math.round(player.currentTime * RM_FPS);
    const start = Math.round(shot.start * RM_FPS);
    const end = Math.round(shot.end * RM_FPS);
    const previous = Math.round((editor.session.shots[editor.shotIndex - 1]?.start || 0) * RM_FPS);
    el("[data-cut-time]").textContent = `${(at / RM_FPS).toFixed(2)} 秒`;
    const locked = editor.busy || editor.playbackError || !!editor.session.export && editor.active(editor.session.export);
    const depthBusy = item => !!item?.depth && editor.active(item.depth);
    const cuttingDepth = depthBusy(shot);
    const joiningDepth = cuttingDepth || depthBusy(editor.session.shots[editor.shotIndex - 1]);
    el('[data-cut="split_shot"]').disabled = locked || cuttingDepth || at <= start || at >= end;
    el('[data-cut="move_cut"]').disabled = locked || joiningDepth || !editor.shotIndex || at <= previous || at >= end || at === start;
    el('[data-cut="merge_shots"]').disabled = locked || joiningDepth || !editor.shotIndex;
    const longSplit = el('[data-cut="split_long_shot"]');
    const pieces = Math.ceil((end - start) / (editor.videoLimit(editor.shotIndex) * RM_FPS));
    longSplit.hidden = pieces <= 1 || !editor.inScope(editor.shotIndex);
    longSplit.disabled = editor.busy || !!editor.session.export && editor.active(editor.session.export) || shot.videos?.some(editor.active) ||
      Object.values(shot.frames).some(frame => frame.previews.some(editor.active));
    longSplit.textContent = `拆成 ${pieces} 个镜头`;
    const undo = el('[data-cut="undo_cut"]');
    undo.hidden = !editor.session.can_undo_cut;
    undo.disabled = locked || editor.session.shots.some(depthBusy);
    for (const button of panel.querySelectorAll("[data-step]")) button.disabled = locked;
  }

  function renderVideo() {
    const shot = editor.currentShot();
    editor.renderMotionAnalysis(shot);
    const videos = shot.videos || [];
    const latest = videos.at(-1);
    const selected = videos.find(v => v.job === editor.videoId) || latest;
    const start = editor.shotStart(shot);
    const approved = start?.preview;
    const startsAbsent = editor.personAbsent(shot.frames.first);
    const firstApproved = !!approved && editor.matchesPerson(approved);
    const staleStart = firstApproved && !editor.previewMatchesRegions(start.frame, approved);
    const guides = firstApproved ? editor.shotGuides(shot, approved, start.entryTick) : [];
    editor.renderDepth(shot, {firstApproved, staleStart, startsAbsent, guides});
    const limit = editor.videoLimit(editor.shotIndex);
    const tooLong = Math.round(shot.end * RM_FPS) - Math.round(shot.start * RM_FPS) > limit * RM_FPS;
    let hint = "先在「镜头首帧」中采用替换预览。";
    if (!editor.inScope(editor.shotIndex)) hint = "该镜头不在替换范围，合成时使用原片。";
    else if (tooLong) hint = `当前方式单镜最多 ${limit} 秒。拆分后可逐段预览并批量生成。`;
    else if (staleStart) hint = `${startsAbsent ? "入画帧" : "首帧"}选区已更新，请重新生成并采用预览。`;
    else if (!guides) hint = "动作关键帧的选区已更新，请重新生成预览或取消该关键帧。";
    else if (startsAbsent) hint = firstApproved
      ? "将用本地 H3 按入画帧生成。生成后请做局部合成，以保留开头原片。"
      : "在人物首次入画的位置添加校正帧，圈选人物并采用替换预览为动作关键帧。";
    else if (guides.length) hint = `本次将用本地 H3 按原片时间生成，采用 ${guides.length} 张动作关键帧。生成后请核对动作和口型。`;
    else if (firstApproved) hint = "可在校正帧添加动作关键帧。生成后请对照原片检查动作和口型。";
    else if (approved) hint = "首帧属于之前的人物映射，请为当前角色重新生成并采用。";
    el(".rm-motion-hint").textContent = hint;
    const input = el("[data-motion]");
    const motion = editor.shotMotion(shot);
    if (input.value !== motion) input.value = motion;
    el("[data-generate-video]").disabled = editor.busy || !editor.inScope(editor.shotIndex) || tooLong || !firstApproved || staleStart || !guides || videos.some(editor.active);
    el("[data-generate-video]").textContent = latest ? "重试镜头视频" : "生成镜头视频";
    el(".rm-video-result").hidden = !selected;
    const source = selected?.ref ? remakeMedia(selected.ref) : "";
    if (comparison && comparison.sourceUrl !== source) stopComparison();
    result.hidden = !source;
    if (source && result.getAttribute("src") !== source) result.src = source;
    else if (!source) result.removeAttribute("src");
    el(".rm-video-status").textContent = selected?.error || (selected && editor.active(selected)
      ? selected.mode === "local" ? "正在跟踪人物并合成…" : "正在处理镜头视频…" : "");
    const review = el(".rm-video-review");
    review.replaceChildren();
    if (selected) {
      const startMatches = !!selected.entry_tick === startsAbsent;
      const combined = selected.mode === "combined";
      const sameLayers = combined && JSON.stringify((selected.roles || []).map(r => r.job)) === JSON.stringify((shot.role_layers || []).map(r => r.job));
      const canAdopt = combined ? sameLayers : startMatches && (!startsAbsent || selected.mode === "local");
      const select = document.createElement("select");
      select.setAttribute("aria-label", "镜头视频版本");
      videos.forEach((v, i) => {
        const label = v.mode === "combined" ? "多角色合成" : v.mode === "local" ? "局部合成" :
          v.mode === "depth" ? "深度参考重制" : v.guides?.length ? `按 ${v.guides.length} 张动作关键帧重制` : "整镜重制";
        select.append(new Option(`${i + 1}. ${label} · ${!editor.matchesPerson(v) ? "旧映射" : shot.adopted_video === v.job && !shot.keep_original ? "已采用" : v.ref ? "待审核" : v.state === "error" ? "失败" : "处理中"}`, v.job));
      });
      select.value = selected.job;
      select.onchange = () => { editor.videoId = select.value; renderVideo(); };
      review.append(select, editor.button("播放原镜头", () => {
        stopComparison();
        if (!result.paused) result.pause();
        editor.originalEnd = shot.end;
        player.currentTime = shot.start;
        player.play().catch(error => editor.status(error.message));
      }, editor.busy || editor.playbackError));
      if (source) {
        const compare = editor.button(comparison ? "停止原声对照" : "原声对照播放", () => toggleComparison(shot, source), editor.busy || editor.playbackError);
        compare.dataset.compare = "";
        review.append(compare);
      }
      if (source && (shot.adopted_video !== selected.job || shot.keep_original)) {
        review.append(editor.button("采用此视频", () => editor.change("approve_video", {job:selected.job}),
          editor.busy || !canAdopt || !combined && (!editor.inScope(editor.shotIndex) || !editor.matchesPerson(selected))));
      }
      if (source && canAdopt && shot.adopted_video === selected.job && !shot.keep_original && (combined || editor.inScope(editor.shotIndex) && editor.matchesPerson(selected))) {
        review.append(editor.button("镜头放入画布", () => editor.insertRemadeVideo(selected, shot), editor.busy));
      }
      if (source && !combined && selected.mode !== "local") {
        const count = Object.values(shot.frames).filter(f => Number.isInteger(f.correction_tick) &&
          (editor.personSelection(f) || editor.personAbsent(f) || f.protection)).length;
        const caption = count ? `跟踪人物并局部合成（${count} 张校正帧）` : "跟踪人物并局部合成";
        review.append(editor.button(caption, () => editor.change("localize", {job:selected.job}),
          editor.busy || !startMatches || !editor.inScope(editor.shotIndex) || !editor.matchesPerson(selected) || videos.some(editor.active)));
      }
      if (source && selected.mode === "local" && selected.source_person && editor.matchesPerson(selected)) {
        review.append(editor.button("加入角色图层", () => editor.change("add_role_layer", {job:selected.job}), editor.busy));
      }
    }
    const layers = shot.role_layers || [];
    if (layers.length) {
      const group = document.createElement("div");
      group.className = "rm-role-layers";
      for (const [i, layer] of layers.entries()) {
        const item = document.createElement("div");
        item.textContent = `${layer.source_person} → ${layer.asset.name}`;
        item.append(editor.button("向底层移", () => editor.change("move_role_layer", {job:layer.job}), editor.busy || i === 0),
          editor.button("移除", () => editor.change("remove_role_layer", {job:layer.job}), editor.busy));
        group.append(item);
      }
      group.append(editor.button("合成所选角色", () => editor.change("combine_roles"), editor.busy || layers.length < 2 || videos.some(editor.active)));
      review.append(group);
    }
    const exp = editor.session.export;
    const {adopted, remaining} = editor.session.export_review;
    const next = remaining.find(entry => entry.shot > editor.shotIndex) || remaining[0];
    const nextReview = el("[data-review-next]");
    nextReview.hidden = !next;
    nextReview.disabled = editor.busy;
    if (next) {
      nextReview.textContent = `${remaining.length} 个镜头待审核`;
      nextReview.title = `镜头 ${next.shot + 1} ${next.error}`;
      nextReview.onclick = () => {
        const shotButton = el(".rm-shots").children[next.shot];
        shotButton.click();
        el(".rm-shots").children[next.shot].focus();
        editor.status(`镜头 ${next.shot + 1} ${next.error}`);
      };
    }
    const exportButton = el("[data-export]");
    exportButton.hidden = !adopted && !remaining.length;
    exportButton.disabled = editor.busy || !adopted || !!remaining.length || !!exp && editor.active(exp);
    exportButton.textContent = exp && editor.active(exp) ? "合成中…" : exp?.state === "error" ? "重新合成" : "合成并保留原声";
    const toFilm = el("[data-send-film]");
    toFilm.disabled = editor.busy || !!remaining.length || !editor.session.shots.length;
    const download = el("[data-download]");
    const watch = el("[data-watch]");
    const insert = el("[data-insert-export]");
    download.hidden = exp?.state !== "done" || !exp.ref || !!exp.stale;
    watch.hidden = download.hidden;
    insert.hidden = download.hidden;
    insert.disabled = editor.busy;
    if (!download.hidden) {
      watch.href = download.href = remakeMedia(exp.ref);
      download.download = exp.ref.split("/").at(-1);
    } else {
      download.removeAttribute("href");
      download.removeAttribute("download");
      watch.removeAttribute("href");
    }
    if (exp?.error && !exp.stale && !el(".rm-status").textContent) editor.status(exp.error);
  }

  Object.assign(editor, { stopComparison, renderPlayback, renderCutControls, renderVideo });
}
