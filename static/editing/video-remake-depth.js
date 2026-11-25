"use strict";

function setupRemakeDepth(editor) {
  const { el, depthPlayer, board, video, source } = editor;

  function renderDepth(shot, {firstApproved, staleStart, startsAbsent, guides}) {
    const depth = shot.depth;
    const ready = depth?.state === "done" && !!depth.ref;
    const loading = !!depth && editor.active(depth);
    const ticks = Math.round(shot.end * RM_FPS) - Math.round(shot.start * RM_FPS);
    const allowed = editor.session.depth_available && ticks > 0 && ticks <= RM_MAX_SHOT_SECONDS * RM_FPS;
    const button = el("[data-prepare-depth]");
    button.hidden = ready;
    button.disabled = editor.busy || !canvasCanEdit() || !allowed || editor.session.shots.some(item => item.depth && editor.active(item.depth));
    button.textContent = depth?.state === "error" ? "重试深度参考" : "生成深度参考";
    el("[data-depth-status]").textContent = depth?.error || (loading ? editor.taskProgress(depth.job).text :
      ready ? "与原镜头同长的灰度参考，可下载或放入画布。" :
        !editor.session.depth_available ? "部署主机尚未安装视频深度模型。" :
          !allowed ? `单段最多 ${RM_MAX_SHOT_SECONDS} 秒，请先拆分镜头。` : "提取前后层次、动作和运镜，生成无声灰度视频。");
    const url = ready ? remakeMedia(depth.ref) : "";
    const download = el("[data-download-depth]");
    download.hidden = !ready;
    if (ready) {
      download.href = url;
      download.download = `镜头 ${editor.shotIndex + 1} · 深度参考.mp4`;
    } else download.removeAttribute("href");
    el("[data-insert-depth]").hidden = !ready || !canvasCanEdit();
    el("[data-insert-depth]").disabled = editor.busy;
    depthPlayer.hidden = !ready;
    if (url && depthPlayer.getAttribute("src") !== url) depthPlayer.src = url;
    else if (!url && depthPlayer.hasAttribute("src")) {
      depthPlayer.removeAttribute("src");
      depthPlayer.load();
    }
    el(".rm-depth-send").hidden = !ready || !canvasCanEdit() || !editor.inScope(editor.shotIndex);
    if (!ready) return;
    const providers = editor.session.motion_providers || [];
    const service = el("[data-depth-provider]");
    const signature = JSON.stringify(providers);
    if (service.dataset.options !== signature) {
      const previous = service.value;
      service.replaceChildren(...providers.map(p => new Option(`${p.name} · ${p.model}`, p.id)));
      if (providers.some(p => p.id === previous)) service.value = previous;
      service.dataset.options = signature;
    }
    service.closest("label").hidden = !providers.length;
    service.disabled = editor.busy;
    const first = shot.frames.first;
    const ratio = first.w / first.h;
    const missing = !providers.length ? "请在控制台配置支持参考视频的 Seedance 服务。" :
      ticks < 2 * RM_FPS || ratio < .4 || ratio > 2.5 ? "动作参考需至少 2 秒，且宽高比在 0.4 到 2.5 之间。" :
      startsAbsent || !guides || guides.length ? "此镜头请使用按关键帧生成。" :
      !firstApproved || staleStart ? "先采用当前镜头的首帧预览。" : "";
    el("[data-generate-depth-video]").disabled = !!missing || editor.busy || (shot.videos || []).some(editor.active);
    el("[data-depth-send-status]").textContent = missing || "提交后，已采用的首帧和深度视频将发给选定服务。合成时可保留原声。";
  }

  function insertDepth() {
    const shot = editor.currentShot(), depth = shot?.depth;
    if (boardId !== board || node(video.id) !== video || !canvasCanEdit() || !depth?.ref || depth.state !== "done") return;
    let target = B.nodes.find(n => n.type === "video" && n.versions.some(v => v.ref === depth.ref && v.remake?.kind === "depth"));
    if (target) {
      if (target.job || prepping.has(target.id)) return editor.status("画布上的参考节点正在生成，请等待完成");
      switchVersion(target, target.versions.findIndex(v => v.ref === depth.ref));
    } else {
      checkpoint();
      const at = placeRight(video, "video"), label = `镜头 ${editor.shotIndex + 1} · 深度参考`;
      target = addNode("video", at.x, at.y, defaults("video"), {name:label});
      const edges = [{from:video.id, to:target.id, relation:"remake", source_ref:source.ref}];
      target.versions.push(mediaVersion({ref:depth.ref, url:remakeMedia(depth.ref),
        w:depth.w, h:depth.h, seconds:depth.end - depth.start}, {
        source:"remake", label, mode:"深度参考", input_edges:edges,
        remake:{kind:"depth", source_node:video.id, source_ref:source.ref, start:depth.start, end:depth.end, job:depth.job},
      }));
      switchVersion(target, 0, {recordUndo:false});
    }
    editor.close();
    selectOnly(target.id);
    fit([target]);
  }

  Object.assign(editor, { renderDepth, insertDepth });
}
