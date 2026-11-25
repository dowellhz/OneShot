"use strict";

function setupRemakePanel(editor) {
  const { panel, el, player } = editor;

  function renderPanel() {
    if (!panel.isConnected) return;
    editor.renderPlayback();
    const shots = editor.session?.shots || [];
    const analyze = el("[data-analyze]");
    analyze.hidden = !!shots.length && !shots.some(shot => shot.analysis_missing);
    analyze.disabled = editor.busy;
    analyze.textContent = shots.length ? "重试视觉分析" : "分析原片";
    el(".rm-analysis").textContent = editor.session?.warning || (shots.length ? `${shots.length} 个镜头` : "支持 60 秒以内的视频");
    el(".rm-editor").hidden = !shots.length;
    editor.renderMapping(shots);
    editor.renderCutControls();
    editor.renderBatchButtons();
    editor.renderTasks();
    if (!shots.length) return;
    const shot = editor.currentShot();
    if (!editor.currentFrame()) editor.frameKey = "first";
    const frame = editor.currentFrame();
    const shotList = el(".rm-shots");
    shotList.replaceChildren(...shots.map((item, i) => {
      const card = document.createElement("button");
      card.type = "button";
      card.setAttribute("aria-pressed", String(i === editor.shotIndex));
      const chosen = item.videos?.find(v => v.job === item.adopted_video);
      const reviewIssue = editor.session.export_review?.remaining.find(entry => entry.shot === i);
      const reviewed = editor.session.reviewed_jobs ? !!editor.session.reviewed_jobs[i] : chosen && !reviewIssue && editor.matchesPerson(chosen);
      card.textContent = `镜头 ${i + 1} · ${item.start.toFixed(2)}–${item.end.toFixed(2)} 秒` +
        (item.keep_original ? " · 保留原片" : item.videos?.some(editor.active) ? " · 视频生成中" :
          reviewed ? " · 已采用视频" : chosen && reviewIssue ? " · 需要重新审核" :
            !editor.inScope(i) ? " · 不在替换范围" : editor.previewStatus(item));
      card.onclick = () => {
        if (editor.busy) return;
        editor.stopComparison();
        editor.shotIndex = i;
        editor.frameKey = "first";
        editor.versionId = null;
        editor.videoId = null;
        editor.originalEnd = null;
        player.currentTime = item.start;
        editor.fillViews();
        renderPanel();
      };
      return card;
    }));
    el(".rm-shot").textContent = `镜头 ${editor.shotIndex + 1}`;
    const options = el("[data-frame]");
    const corrections = Object.entries(shot.frames).filter(([, item]) => Number.isInteger(item.correction_tick))
      .sort(([, a], [, b]) => a.correction_tick - b.correction_tick);
    const first = editor.shotStart(shot)?.preview;
    const startKey = editor.startPreviewKey(shot);
    const choices = [["first", "镜头首帧"], ["middle", "镜头中间帧"], ...corrections.map(([key, item]) =>
      [key, `${key === startKey ? "首次入画帧" : "校正帧"} · ${item.at.toFixed(2)} 秒${editor.personAbsent(item) ? " · 人物出画" : item.approved
        ? !editor.previewMatchesRegions(item, editor.adoptedPreview(item)) ? " · 选区已更新" :
          editor.matchesFirst(editor.adoptedPreview(item), first) ? " · 动作关键帧" : first ? " · 角色与首帧不同" : " · 等待首帧"
        : ""}`])];
    if (JSON.stringify(choices) !== options.dataset.choices) {
      options.replaceChildren(...choices.map(([key, label]) => new Option(label, key)));
      options.dataset.choices = JSON.stringify(choices);
    }
    options.value = editor.frameKey;
    const isCorrection = Number.isInteger(frame.correction_tick);
    const absent = editor.personAbsent(frame);
    el("[data-capture-correction]").disabled = editor.busy || editor.playbackError;
    const suggest = el("[data-suggest-entry]");
    suggest.hidden = !editor.session.mapping || !editor.inScope(editor.shotIndex) || !editor.personAbsent(shot.frames.first);
    suggest.disabled = editor.busy;
    el("[data-remove-correction]").hidden = !isCorrection;
    el("[data-remove-correction]").disabled = editor.busy;
    const absence = el("[data-absence]");
    absence.hidden = (editor.frameKey !== "first" && !isCorrection) || !editor.inScope(editor.shotIndex);
    absence.disabled = editor.busy;
    absence.textContent = absent ? "取消人物出画标记" : isCorrection ? "标记人物从此帧出画" : "标记人物尚未入画";
    const role = el("[data-role]");
    role.disabled = editor.busy || !!editor.session.mapping;
    if (editor.session.mapping && role.value !== editor.session.mapping.asset) {
      role.value = editor.session.mapping.asset;
      editor.fillViews();
    }
    const note = el(".rm-note input");
    const draftNote = editor.readDraft("note") ?? "";
    if (note.value !== draftNote) note.value = draftNote;
    const summary = shot.summary || {};
    el(".rm-summary").textContent = [summary.shot_size, summary.camera, ...(Array.isArray(summary.action) ? summary.action : [])].filter(Boolean).join(" · ");
    const original = el(".rm-original"), selection = el(".rm-mask");
    const originalUrl = remakeMedia(frame.ref);
    if (original.getAttribute("src") !== originalUrl) original.src = originalUrl;
    const selectedArea = editor.personSelection(frame);
    selection.hidden = !selectedArea;
    if (selectedArea) selection.src = remakeMedia(selectedArea.overlay);
    const protection = el(".rm-protection");
    protection.hidden = !frame.protection?.overlay;
    if (!protection.hidden) protection.src = remakeMedia(frame.protection.overlay);
    const layer = el("[data-layer]");
    layer.hidden = editor.frameKey !== "first" && !isCorrection;
    if (layer.hidden) layer.value = "selection";
    layer.disabled = editor.busy;
    updateSelectionControls();
    const previews = frame.previews;
    const latest = previews.at(-1);
    const version = previews.find(item => item.job === editor.versionId) || latest;
    const output = el(".rm-output");
    output.replaceChildren();
    if (version?.ref) {
      const link = document.createElement("a");
      link.href = remakeMedia(version.ref); link.target = "_blank"; link.rel = "noopener";
      const image = document.createElement("img");
      image.src = link.href; image.alt = "角色替换预览";
      link.append(image); output.append(link);
    } else {
      output.textContent = version?.error || (version ? version.state === "running" ? "正在生成…" : "等待生成…"
        : isCorrection ? "生成替换预览后，可在此审核为动作关键帧。" : "生成后显示在这里");
    }
    const review = el(".rm-review");
    review.replaceChildren();
    if (previews.length) {
      const select = document.createElement("select");
      select.setAttribute("aria-label", OneShotI18n.t("预览版本"));
      previews.forEach((item, i) => {
        const asset = editor.assets.find(asset => asset.id === item.asset?.id);
        const oldReference = asset && item.asset?.ref && item.asset.ref !== editor.roleReference(asset, item.asset.view || "main");
        const state = !editor.matchesPerson(item) ? "旧映射" : item.ref && !editor.previewMatchesRegions(frame, item) ? "选区已更新" :
          item.job === frame.approved ? "已采用" : item.ref ? "待审核" : item.state === "error" ? "失败" : "处理中";
        select.append(new Option(`版本 ${i + 1} · ${state}${oldReference ? " · 旧参考图" : ""}`, item.job));
      });
      select.value = version.job;
      select.onchange = () => { editor.versionId = select.value; renderPanel(); };
      review.append(select);
    }
    if (version?.ref) {
      if (version.job !== frame.approved) {
        review.append(button(isCorrection ? "用作动作关键帧" : "采用此预览", () => editor.change("approve", {job:version.job}),
          editor.busy || absent || !editor.inScope(editor.shotIndex) || !editor.matchesPerson(version) || !editor.previewMatchesRegions(frame, version)));
      } else {
        review.append(button("放入画布", () => editor.insertPreview(version, frame, false), editor.busy));
        if (editor.frameKey === "first" && !absent) review.append(button("用作视频首帧", () => editor.insertPreview(version, frame, true),
          editor.busy || !editor.matchesPerson(version) || !editor.previewMatchesRegions(frame, version)));
        if (isCorrection) review.append(button("取消动作关键帧", () => editor.change("clear_guide"), editor.busy));
      }
    }
    if (!shot.keep_original) review.append(button("保留这个原镜头", () => editor.change("keep"), editor.busy));
    el("[data-generate]").disabled = editor.busy || !editor.inScope(editor.shotIndex) || !selectedArea || !role.value || !!latest && editor.active(latest);
    el("[data-frame]").disabled = editor.busy;
    editor.renderVideo();
  }

  function button(label, handler, disabled) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = label; b.onclick = handler; b.disabled = disabled;
    return b;
  }

  function personHint(frame = editor.currentFrame()) {
    const hint = frame?.person_hint;
    const mapping = editor.session?.mapping;
    return hint && mapping && hint.source === mapping.source && hint.look === (mapping.look || "") ? hint.point : null;
  }

  function updateSelectionControls() {
    const frame = editor.currentFrame();
    const layer = el("[data-layer]").value;
    const protect = layer === "protection";
    const clear = el("[data-clear-protection]");
    clear.hidden = !protect || frame.protection?.mask === null || (editor.frameKey === "first" && !frame.protection);
    clear.disabled = editor.busy;
    const instruction = editor.mode === "box" ? "拖动框选" : "在原画面中点选";
    const target = protect ? "要保留的前景" : "要替换的人物";
    const selection = protect ? frame.protection : editor.personSelection(frame);
    const absent = !protect && editor.personAbsent(frame);
    let message = selection?.overlay ? `已标记${target}，可重新${editor.mode === "box" ? "框选" : "点选"}` : instruction + target;
    if (protect && frame.protection?.mask === null) message = "从此帧停止保护，可重新标记前景";
    const locate = el("[data-locate-person]");
    locate.hidden = protect || absent || !editor.session.mapping || !editor.inScope(editor.shotIndex) || !!selection;
    locate.disabled = editor.busy;
    const point = locate.hidden ? null : personHint();
    locate.textContent = point ? "按此位置选中" : "定位原片人物";
    const marker = el(".rm-person-point");
    marker.hidden = !point;
    if (point) {
      marker.style.left = `${point[0] * 100}%`;
      marker.style.top = `${point[1] * 100}%`;
      message = `请核对「${editor.session.mapping.source}」的位置，也可直接手动选择`;
    }
    if (absent) message = "局部合成从此帧保留原片。人物重新入画时，请将对应校正帧用作动作关键帧。";
    el(".rm-selection-status").textContent = message;
  }
  for (const control of panel.querySelectorAll("[data-mode]")) {
    control.onclick = () => {
      editor.mode = control.dataset.mode;
      for (const item of panel.querySelectorAll("[data-mode]")) item.setAttribute("aria-pressed", String(item === control));
      updateSelectionControls();
    };
  }

  Object.assign(editor, { renderPanel, button, personHint, updateSelectionControls });
}
