"use strict";

function setupRemakeActions(editor) {
  const { el, video, source, panel, player } = editor;

  el("[data-analyze]").onclick = () => editor.change(editor.session?.shots.length ? "retry_analysis" : "analyze");
  el("[data-send-film]").onclick = () => {
    if (!editor.session?.shots.length || editor.session.export_review.remaining.length) return;
    editor.close();
    sendRemakeToFilm(video, source, editor.session);
  };
  el("[data-prepare-playback]").onclick = () => editor.change("prepare_playback");
  el("[data-batch-locate]").onclick = () => {
    const shots = editor.batchLocateShots();
    if (!shots.length) return;
    const {source, asset, look} = editor.session.mapping;
    editor.change("batch_locate_people", {shots, person:source, asset, look:look || ""});
  };
  for (const [selector, action, prepare] of [
    ["[data-batch-previews]", "batch_previews", editor.batchPreviews],
    ["[data-batch-videos]", "batch_videos", editor.batchVideos],
  ]) {
    el(selector).onclick = () => {
      const shots = prepare();
      if (shots.length) editor.change(action, {shots, asset:editor.session.mapping.asset, person:editor.session.mapping.source});
    };
  }
  for (const control of panel.querySelectorAll("[data-cut], [data-step]")) {
    control.onclick = () => {
      editor.stopComparison();
      if (!player.paused) player.pause();
      const at = player.currentTime;
      if (control.dataset.cut) {
        editor.change(control.dataset.cut, {at});
      } else {
        const end = editor.session.shots.at(-1).end;
        player.currentTime = Math.max(0, Math.min(end, (Math.round(at * RM_FPS) + Number(control.dataset.step)) / RM_FPS));
        editor.renderCutControls();
      }
    };
  }
  el("[data-person]").onchange = () => {
    el("[data-person-look]").value = "";
    editor.updateSuggestions();
  };
  el("[data-save-mapping]").onclick = () => {
    const source = el("[data-person]").value;
    editor.change("map_person", {
      person: source === "__manual__" ? el("[data-person-manual]").value : source,
      look: el("[data-person-look]").value,
      asset: el("[data-map-asset]").value,
      shots: Array.from(panel.querySelectorAll("[data-map-shots] input:checked"), box => Number(box.value)),
    });
  };
  el("[data-clear-mapping]").onclick = () => editor.change("remove_mapping");
  el("[data-frame]").onchange = event => {
    editor.stopComparison();
    editor.frameKey = event.target.value;
    editor.versionId = null;
    if (Number.isFinite(editor.currentFrame().at)) player.currentTime = editor.currentFrame().at;
    editor.renderPanel();
  };
  el("[data-capture-correction]").onclick = () => {
    editor.stopComparison();
    if (!player.paused) player.pause();
    editor.change("capture_correction", {at:player.currentTime});
  };
  el("[data-remove-correction]").onclick = () => editor.change("remove_correction");
  el("[data-absence]").onclick = () => editor.change("set_absence", {absent:!editor.personAbsent(editor.currentFrame())});
  el("[data-suggest-entry]").onclick = () => editor.change("suggest_entry", {person:editor.session.mapping.source});
  el("[data-layer]").onchange = editor.updateSelectionControls;
  el("[data-locate-person]").onclick = () => editor.change(
    editor.personHint() ? "apply_person_hint" : "locate_person", {person:editor.session.mapping.source},
  );
  el("[data-clear-protection]").onclick = () => editor.change("clear_protection");
  el("[data-role]").onchange = () => { editor.fillViews(); editor.renderPanel(); };
  el("[data-view]").onchange = event => {
    editor.writeDraft("view", event.target.value, el("[data-role]").value);
    editor.renderBatchButtons();
  };
  el(".rm-note input").oninput = event => {
    editor.writeDraft("note", event.target.value);
    editor.renderBatchButtons();
  };
  el("[data-generate]").onclick = () => {
    const asset = editor.assets.find(item => item.id === el("[data-role]").value);
    const view = el("[data-view]").value;
    const reference = editor.roleReference(asset, view);
    if (reference) editor.change("preview", {asset:asset.id, view, reference, note:el(".rm-note input").value});
  };
  el("[data-motion]").oninput = event => {
    editor.writeDraft("motion", event.target.value);
    editor.renderBatchButtons();
  };
  el("[data-analyze-motion]").onclick = () => editor.change("analyze_motion");
  el("[data-prepare-depth]").onclick = () => editor.change("prepare_depth");
  el("[data-insert-depth]").onclick = editor.insertDepth;
  el("[data-generate-depth-video]").onclick = () => editor.change("generate_depth_video", {
    provider:el("[data-depth-provider]").value, first_job:editor.shotStart(editor.currentShot())?.preview?.job, motion:el("[data-motion]").value,
  });
  el("[data-use-motion]").onclick = () => {
    const analysis = editor.motionAnalysis(editor.currentShot());
    if (!analysis) return;
    const notes = [analysis.camera, ...analysis.beats.map(beat => `镜头内 ${(beat.tick / RM_FPS).toFixed(2)} 秒，${beat.action}`)].filter(Boolean);
    const input = el("[data-motion]");
    const existing = input.value.split("\n");
    const combined = [input.value, ...notes.filter(note => !existing.includes(note))].filter(Boolean).join("\n");
    if (combined.length > input.maxLength) return editor.status("追加后会超过动作说明字数，请先精简已有内容");
    input.value = combined;
    input.dispatchEvent(new Event("input"));
    input.focus();
  };
  el("[data-generate-video]").onclick = () => editor.change("generate_video", {motion:el("[data-motion]").value});
  el("[data-export]").onclick = () => editor.change("export");
  el("[data-insert-export]").onclick = () => editor.insertRemadeVideo(editor.session.export);

  const surface = el(".rm-surface");
  function point(event) {
    const rect = el(".rm-original").getBoundingClientRect();
    const clamp = n => Math.max(0, Math.min(1, n));
    return [clamp((event.clientX - rect.left) / (rect.width || 1)), clamp((event.clientY - rect.top) / (rect.height || 1))];
  }
  surface.onpointerdown = event => {
    if (editor.busy || event.button !== 0 || (editor.personAbsent(editor.currentFrame()) && el("[data-layer]").value === "selection")) return;
    event.preventDefault();
    editor.dragStart = point(event);
    surface.setPointerCapture?.(event.pointerId);
  };
  surface.onpointercancel = () => { editor.dragStart = null; };
  surface.onpointerup = event => {
    if (!editor.dragStart || editor.busy) return;
    const end = point(event);
    const selection = editor.mode === "box" ? {rect:[...editor.dragStart, ...end]} : {point:end};
    editor.dragStart = null;
    editor.change("select", {...selection, layer:el("[data-layer]").value});
  };
}
