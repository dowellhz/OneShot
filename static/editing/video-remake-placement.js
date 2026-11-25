"use strict";

function setupRemakePlacement(editor) {
  const { video, board, source } = editor;

  function insertCanvasFrame(ref, frame, name) {
    const at = placeRight(video, "image");
    const image = addNode("image", at.x, at.y, {}, {name, versions:[
      mediaVersion({ref, url:remakeMedia(ref), w:frame.w, h:frame.h}, {source:"edit"}),
    ], cur:0});
    return image;
  }

  function insertPreview(version, frame, videoFirst) {
    if (boardId !== board || node(video.id) !== video) return editor.status("原片所在画布已切换");
    checkpoint();
    const image = insertCanvasFrame(version.ref, frame, `镜头 ${editor.shotIndex + 1} · ${version.asset.name}`);
    if (videoFirst) {
      const shot = editor.currentShot(), info = shot.summary;
      const prompt = [info.camera, ...(Array.isArray(info.action) ? info.action : [])].filter(Boolean).join("。");
      const at = placeRight(image, "video");
      const target = addNode("video", at.x, at.y, {
        prompt, duration: Math.min(15, Math.max(2, Math.round(shot.end - shot.start))),
      }, {name:`重制 · 镜头 ${editor.shotIndex + 1}`});
      link(image, target, true);
      selectOnly(target.id);
    } else selectOnly(image.id);
    editor.close();
  }

  function insertRemadeVideo(version, shot = null) {
    if (boardId !== board || node(video.id) !== video) return editor.status("原片所在画布已切换");
    if (!version?.ref || version.stale) return;
    const kind = shot ? "shot" : "export";
    const origin = {kind, source_node:video.id, source_ref:source.ref, job:version.job,
      ...(version.depth_ref ? {depth_ref:version.depth_ref, motion_model:version.motion_model} : {}),
      ...(shot ? {start:shot.start, end:shot.end} : {clips:version.clips || []})};
    const matchesOrigin = v => v.remake?.kind === kind && v.remake.source_node === video.id &&
      v.remake.source_ref === source.ref && (!shot || v.remake.start === shot.start && v.remake.end === shot.end);
    const candidates = B.nodes.filter(n => n.type === "video" && n.versions.some(matchesOrigin));
    let target = candidates.find(n => n.versions.some(v => matchesOrigin(v) && v.ref === version.ref)) || candidates[0];
    if (target?.job || (target && prepping.has(target.id))) return editor.status("画布上的对应视频正在生成，请等待完成");
    const existing = target?.versions.findIndex(v => matchesOrigin(v) && v.ref === version.ref);
    if (existing >= 0) {
      switchVersion(target, existing);
    } else {
      checkpoint();
      const first = shot?.frames.first;
      const label = shot ? `重制 · 镜头 ${editor.shotIndex + 1}` : "重制成片";
      const guides = shot ? version.guides || [] : [];
      const frames = shot && version.first_frame
        ? [{ref:version.first_frame, role:"first", time:0}, ...guides.map(guide => ({ref:guide.ref, role:"keyframe", time:guide.tick / RM_FPS}))]
        : [];
      const used = new Set();
      const sources = frames.map(frame => {
        const name = `${label} · ${frame.role === "first" ? "首帧" : frame.time.toFixed(2) + " 秒"}`;
        const image = B.nodes.find(n => n.type === "image" && !used.has(n.id) && curV(n)?.ref === frame.ref) ||
          insertCanvasFrame(frame.ref, first, name);
        used.add(image.id);
        return image;
      });
      const seconds = version.duration || (shot ? shot.end - shot.start : editor.session.duration || editor.session.shots.at(-1).end);
      const summary = shot?.summary || {};
      const motion = Array.isArray(summary.action) ? summary.action : [];
      const data = {...defaults("video"), ...version.generation,
        prompt:version.prompt || [summary.camera, ...motion, version.motion].filter(Boolean).join("。"),
        duration:version.generation?.duration || Math.min(15, Math.max(2, seconds)), mode:guides.length ? "keyframes" : "auto"};
      if (!target) {
        const at = placeRight(sources.at(-1) || video, "video");
        target = addNode("video", at.x, at.y, data, {name:label});
      }
      const edges = [{from:video.id, to:target.id, relation:"remake", source_ref:source.ref}];
      sources.forEach((image, i) => {
        edges.push({from:image.id, to:target.id, role:frames[i].role, time:frames[i].time});
      });
      target.versions.push(mediaVersion({
        ref:version.ref, url:remakeMedia(version.ref),
        w:version.w || first?.w || source.w || 1280,
        h:version.h || first?.h || source.h || 720, seconds,
      }, {source:"remake", label, mode:shot ? version.mode === "local" ? "局部合成" :
        version.mode === "depth" ? "深度参考重制" : "整镜重制" : "重制成片",
        remake:origin, input_edges:edges, node_data:data}));
      switchVersion(target, target.versions.length - 1, {recordUndo:false});
    }
    editor.close();
    selectOnly(target.id);
    fit([target]);
  }

  Object.assign(editor, { insertPreview, insertRemadeVideo });
}
