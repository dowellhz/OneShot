"use strict";

function setupRemakeShotControls(editor) {
  const { el, player, panel } = editor;

  function suggestedView(asset, shot) {
    const summary = shot?.summary || {};
    const camera = [summary.shot_size, summary.camera, summary.scene].filter(Boolean).join(" ");
    for (const [key, pattern] of [
      ["back", /背面|背影|从(?:他|她|人物)?身后|背对/],
      ["side", /侧面|侧身|侧脸|侧拍|侧视/],
      ["detail", /配饰特写|饰品特写|道具特写|伤疤特写|手部特写/],
      ["face", /特写|近景|头肩/],
    ]) if (asset?.character_views?.[key] && pattern.test(camera)) return key;
    return "main";
  }

  function chosenView(asset, shot) {
    const choice = editor.readDraft("view", shot, asset?.id);
    return choice === "main" || asset?.character_views?.[choice] ? choice : suggestedView(asset, shot);
  }

  function roleReference(asset, view) {
    return asset?.character_views?.[view] || (view === "main" ? asset?.ref : "") || "";
  }

  function fillViews() {
    const asset = editor.assets.find(item => item.id === el("[data-role]").value);
    const views = el("[data-view]");
    const recommended = suggestedView(asset, editor.currentShot());
    const value = chosenView(asset, editor.currentShot());
    views.replaceChildren();
    for (const [view, label] of Object.entries(RM_VIEW_NAMES)) {
      if (view === "main" || asset?.character_views?.[view]) {
        views.append(new Option(label + (view === recommended && view !== "main" ? "（建议）" : ""), view));
      }
    }
    if ([...views.options].some(option => option.value === value)) views.value = value;
  }

  function shotPeople(shot) {
    return Array.isArray(shot.summary?.characters) ? shot.summary.characters.filter(name => typeof name === "string" && name.trim()) : [];
  }

  function startPreviewKey(shot) {
    if (!editor.personAbsent(shot.frames.first)) return "first";
    return Object.keys(shot.frames)
      .filter(key => Number.isInteger(shot.frames[key].correction_tick) && editor.personSelection(shot.frames[key]))
      .sort((a, b) => shot.frames[a].correction_tick - shot.frames[b].correction_tick)[0];
  }

  function batchPreviews() {
    const mapping = editor.session?.mapping;
    const asset = editor.assets.find(item => item.id === mapping?.asset);
    if (!asset) return [];
    const queue = [];
    for (const index of mapping.shots) {
      const shot = editor.session.shots[index];
      const key = startPreviewKey(shot);
      if (!key) continue;
      const frame = shot.frames[key];
      const selection = editor.personSelection(frame);
      if (!selection || shot.keep_original || frame.previews.some(editor.active)) continue;
      const view = chosenView(asset, shot);
      const reference = roleReference(asset, view);
      if (!reference) continue;
      const note = (editor.readDraft("note", shot) ?? "").slice(0, 800);
      const hasPreview = frame.previews.some(p => p.ref && editor.matchesPerson(p) && p.mask === selection.mask &&
        (p.protection || null) === (frame.protection?.mask || null) && (p.asset?.view || "main") === view &&
        p.asset?.ref === reference && (p.note || "") === note);
      if (!hasPreview) queue.push({shot:index, frame:key, view, reference, note});
    }
    return queue;
  }

  function shotStart(shot) {
    const first = shot.frames.first;
    if (!editor.personAbsent(first)) {
      const preview = editor.adoptedPreview(first);
      return preview ? {preview, frame:first, ref:preview.ref, entryTick:0} : null;
    }
    const entry = shot.frames[startPreviewKey(shot)];
    const preview = entry && editor.adoptedPreview(entry);
    if (!preview) return null;
    return {preview, frame:entry, ref:first.ref, entryTick:entry.correction_tick - Math.round(shot.start * RM_FPS)};
  }

  function previewMatchesRegions(frame, preview) {
    const selection = editor.personSelection(frame);
    return !!preview && (!selection || selection.mask === preview.mask) &&
      (frame.protection?.mask ?? null) === (preview.protection ?? null);
  }

  function shotGuides(shot, first, entryTick = 0) {
    const guides = [];
    for (const frame of Object.values(shot.frames)) {
      if (!Number.isInteger(frame.correction_tick) || editor.personAbsent(frame)) continue;
      const guide = editor.adoptedPreview(frame);
      const tick = frame.correction_tick - Math.round(shot.start * RM_FPS);
      if (tick < entryTick || !editor.matchesFirst(guide, first)) continue;
      if (!previewMatchesRegions(frame, guide)) return null;
      guides.push({tick, ref:guide.ref});
    }
    return guides.sort((a, b) => a.tick - b.tick);
  }

  function shotMotion(shot) {
    return editor.readDraft("motion", shot) ?? shot.videos?.filter(editor.matchesPerson).at(-1)?.motion ?? "";
  }

  function motionAnalysis(shot) {
    const analysis = shot.motion_analysis;
    return analysis && analysis.source_person === (editor.session.mapping?.source ?? null) ? analysis : null;
  }

  function renderMotionAnalysis(shot) {
    const analysis = motionAnalysis(shot);
    const control = el("[data-analyze-motion]");
    control.disabled = editor.busy || !editor.inScope(editor.shotIndex);
    control.textContent = analysis ? "重新分析原片动作" : "分析原片动作";
    const use = el("[data-use-motion]");
    use.hidden = !analysis;
    use.disabled = editor.busy;
    el(".rm-motion-analysis").hidden = !analysis;
    const camera = el("[data-camera-motion]");
    camera.textContent = analysis?.camera || "";
    camera.hidden = !camera.textContent;
    el("[data-motion-beats]").replaceChildren(...(analysis?.beats || []).map(beat => {
      const time = beat.tick / RM_FPS;
      const row = document.createElement("li");
      const jump = editor.button(`${time.toFixed(2)} 秒`, () => {
        editor.stopComparison();
        if (!player.paused) player.pause();
        editor.originalEnd = null;
        player.currentTime = (Math.round(shot.start * RM_FPS) + beat.tick) / RM_FPS;
        editor.renderCutControls();
      }, editor.busy);
      jump.title = "定位到这张原片采样画面";
      const action = document.createElement("span");
      action.textContent = beat.action;
      row.append(jump, action);
      return row;
    }));
  }

  function videoLimit(index) {
    return editor.session.video_limits?.[index] || RM_MAX_SHOT_SECONDS;
  }

  function batchVideos() {
    if (!editor.session?.mapping) return [];
    const queue = [];
    for (const index of editor.session.mapping.shots) {
      const shot = editor.session.shots[index];
      const start = shotStart(shot);
      const first = start?.preview;
      const versions = shot.videos || [];
      const duration = (Math.round(shot.end * RM_FPS) - Math.round(shot.start * RM_FPS)) / RM_FPS;
      if (!first || !editor.matchesPerson(first) || !previewMatchesRegions(start.frame, first) ||
          shot.keep_original || versions.some(editor.active) || duration <= 0 || duration > videoLimit(index)) continue;
      const guides = shotGuides(shot, first, start.entryTick);
      if (!guides) continue;
      const motion = shotMotion(shot).slice(0, 1600);
      const ready = versions.some(v => {
        const used = v.guides || [];
        return v.ref && !v.depth_ref && editor.matchesPerson(v) && v.first_frame === start.ref && (v.motion || "") === motion &&
          (v.entry_tick || 0) === start.entryTick &&
          used.length === guides.length && guides.every((guide, i) => guide.tick === used[i].tick && guide.ref === used[i].ref);
      });
      if (!ready) queue.push({shot:index, first_job:first.job, motion});
    }
    return queue;
  }

  function previewStatus(shot) {
    const key = startPreviewKey(shot);
    if (!key) return " · 待设置入画帧";
    const label = key === "first" ? "首帧" : "入画帧";
    const start = shotStart(shot);
    if (start && editor.matchesPerson(start.preview)) return previewMatchesRegions(start.frame, start.preview)
      ? ` · 已采用${label}` : ` · ${label}选区已更新`;
    const latest = shot.frames[key].previews.filter(editor.matchesPerson).at(-1);
    if (!latest) {
      if (key !== "first") return " · 入画帧待生成";
      return !editor.personSelection(shot.frames.first) && editor.personHint(shot.frames.first) ? " · 人物位置待确认" : "";
    }
    if (editor.active(latest)) return ` · ${label}生成中`;
    if (latest.error === "已取消") return ` · ${label}已取消`;
    return ` · ${label}${latest.ref ? "待审核" : "失败"}`;
  }

  function renderMapping(shots) {
    const mappingPanel = el(".rm-mapping");
    mappingPanel.hidden = !shots.length;
    if (!shots.length) return;
    const mapping = editor.session.mapping;
    const people = [...new Set(shots.flatMap(shotPeople))];
    const version = JSON.stringify([mapping, people, editor.session.source_people, editor.session.cut_revision, editor.assets.map(asset => asset.id)]);
    if (mappingPanel.dataset.state !== version) {
      mappingPanel.dataset.state = version;
      const person = el("[data-person]");
      person.replaceChildren(new Option("选择分析到的人物", ""));
      for (const name of people) person.append(new Option(name, name));
      person.append(new Option("手动填写人物", "__manual__"));
      person.value = mapping ? people.includes(mapping.source) ? mapping.source : "__manual__" : people.length ? "" : "__manual__";
      el("[data-person-manual]").value = mapping?.source || "";
      el("[data-person-look]").value = mapping?.look || "";
      const asset = el("[data-map-asset]");
      asset.replaceChildren(new Option("选择资产库角色", ""), ...editor.assets.map(item => new Option(item.name, item.id)));
      asset.value = mapping?.asset || el("[data-role]").value;
      const list = el("[data-map-shots]");
      list.replaceChildren(...shots.map((item, index) => {
        const label = document.createElement("label");
        const check = document.createElement("input");
        check.type = "checkbox";
        check.value = index;
        check.checked = mapping?.shots.includes(index) || false;
        const thumb = document.createElement("img");
        thumb.src = remakeMedia(item.frames.first.ref);
        thumb.alt = `镜头 ${index + 1} 代表帧`;
        thumb.loading = "lazy";
        const title = document.createElement("span");
        title.textContent = `镜头 ${index + 1}`;
        const hint = document.createElement("small");
        hint.dataset.suggestion = index;
        label.append(check, thumb, title, hint);
        return label;
      }));
      updateSuggestions();
    }
    el(".rm-mapping-status").textContent = mapping
      ? `${mapping.source} → ${mapping.asset_name} · ${mapping.shots.length} 个镜头`
      : "确认原片人物和镜头后，可在多个镜头使用同一个角色。";
    el("[data-clear-mapping]").hidden = !mapping;
    el("[data-clear-mapping]").disabled = editor.busy;
    el("[data-save-mapping]").disabled = editor.busy;
  }

  function updateSuggestions() {
    const person = el("[data-person]").value;
    el("[data-manual-label]").hidden = person !== "__manual__";
    const appearance = editor.session.source_people?.find(item => item.name === person)?.look;
    el("[data-person-look]").placeholder = appearance || "例如红色外套、黑色眼镜";
    for (const hint of panel.querySelectorAll("[data-suggestion]")) {
      const names = shotPeople(editor.session.shots[Number(hint.dataset.suggestion)]);
      hint.textContent = person && names.includes(person) ? "分析建议" : "";
    }
  }

  function renderBatchButtons() {
    for (const [selector, count, label] of [
      ["[data-batch-locate]", batchLocateShots().length, "批量定位人物"],
      ["[data-batch-previews]", batchPreviews().length, "批量生成起始帧"],
      ["[data-batch-videos]", batchVideos().length, "批量生成镜头视频"],
    ]) {
      const batch = el(selector);
      batch.hidden = !editor.session?.mapping;
      batch.disabled = editor.busy || !count;
      batch.textContent = count ? `${label}（${count} 个镜头）` : label;
    }
  }

  function batchLocateShots() {
    return (editor.session?.mapping?.shots || []).filter(index => {
      const shot = editor.session.shots[index];
      const first = shot.frames.first;
      return !shot.keep_original && !editor.personAbsent(first) && !editor.personSelection(first) && !editor.personHint(first);
    });
  }

  Object.assign(editor, { roleReference, fillViews, startPreviewKey, batchPreviews, shotStart, previewMatchesRegions, shotGuides, shotMotion, motionAnalysis, renderMotionAnalysis, videoLimit, batchVideos, previewStatus, renderMapping, updateSuggestions, renderBatchButtons, batchLocateShots });
}
