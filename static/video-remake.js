"use strict";

const RM_VIEW_NAMES = {main:"标准主图", face:"正面头肩", side:"侧面", back:"背面", detail:"固定细节"};
const RM_FPS = 24;
const RM_MAX_SHOT_SECONDS = 14;

function remakeMedia(ref) {
  return "/media?ref=" + encodeURIComponent(ref);
}

async function remakeRequest(url, data) {
  if (data) return api(url, data);
  const response = await fetch(url);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "读取角色替换工作区失败");
  return result;
}

async function openVideoRemake(video, {shotStart: initialShotStart, frame: initialFrame, videoJob: initialVideoJob} = {}) {
  const source = curV(video);
  if (!source?.ref) return toast("请先上传或生成视频");
  await flushSave();
  if (node(video.id) !== video) return;
  $("#videoRemake")?.remove();
  const board = boardId;
  const url = "/api/video-remake/" + encodeURIComponent(board) + "/" + encodeURIComponent(video.id) + "?source=" + encodeURIComponent(source.ref);
  const panel = document.createElement("dialog");
  panel.id = "videoRemake";
  panel.setAttribute("aria-labelledby", "rmTitle");
  panel.innerHTML = `<div class="rm-top"><header class="rm-heading"><div><h2 id="rmTitle">视频重制 · 替换角色</h2><span>${esc(video.name)}</span></div><div class="rm-actions"><button type="button" data-review-next hidden></button><button type="button" data-export hidden>合成并保留原声</button><a data-watch target="_blank" rel="noopener" hidden>预览成片</a><a data-download hidden>下载成片</a><button type="button" data-insert-export hidden>成片放入画布</button><button type="button" data-close>返回画布</button></div></header>
    <details class="rm-tasks" hidden><summary data-task-summary></summary><ul data-task-list></ul></details></div>
    <div class="rm-body">
      <section class="rm-source"><video controls preload="metadata" playsinline></video>
        <div class="rm-actions" data-playback hidden><span class="rm-analysis" data-playback-status role="status"></span>
          <button type="button" data-prepare-playback>生成播放预览</button></div>
        <div class="rm-actions"><button type="button" data-analyze>分析原片</button><span class="rm-analysis"></span>
          <button type="button" data-batch-locate hidden title="在已映射的镜头首帧标出人物位置，供逐镜确认">批量定位人物</button>
          <button type="button" data-batch-previews hidden title="为已确认映射且已圈出人物的镜头生成首帧或首次入画帧">批量生成起始帧</button>
          <button type="button" data-batch-videos hidden title="为已采用首帧或首次入画帧的镜头提交视频生成">批量生成镜头视频</button></div>
        <details class="rm-mapping" hidden>
          <summary>跨镜头人物映射</summary>
          <p class="rm-mapping-status"></p>
          <label>原片人物<select data-person></select></label>
          <label data-manual-label hidden>人物称呼<input data-person-manual maxlength="60" placeholder="例如穿红衣的人"></label>
          <label>原片外貌提示（可选）<input data-person-look maxlength="240" placeholder="例如红色外套、黑色眼镜"></label>
          <label>替换为<select data-map-asset></select></label>
          <fieldset><legend>确认出现该人物的镜头</legend><div data-map-shots></div></fieldset>
          <div class="rm-actions"><button type="button" data-save-mapping>保存映射</button><button type="button" data-clear-mapping hidden>清除映射</button></div>
        </details>
        <nav class="rm-shots" aria-label="原片镜头"></nav>
        <details class="rm-cuts" hidden>
          <summary>调整剪辑点</summary>
          <div class="rm-actions">
            <button type="button" data-step="-1" aria-label="原片后退一帧">−1 帧</button>
            <button type="button" data-step="1" aria-label="原片前进一帧">+1 帧</button>
            <output data-cut-time aria-label="原片播放位置"></output>
          </div>
          <div class="rm-actions">
            <button type="button" data-cut="split_shot">从播放位置拆分</button>
            <button type="button" data-cut="move_cut">移动所选镜头起点</button>
            <button type="button" data-cut="merge_shots">与上一镜头合并</button>
            <button type="button" data-cut="undo_cut" hidden>撤销上次调整</button>
          </div>
        </details>
      </section>
      <section class="rm-editor" hidden>
        <div class="rm-actions"><strong class="rm-shot"></strong><select data-frame aria-label="选取原片画面"></select>
          <button type="button" data-capture-correction>添加当前位置为校正帧</button><button type="button" data-remove-correction hidden>删除校正帧</button>
          <button type="button" data-suggest-entry hidden>查找入画帧</button>
          <button type="button" data-absence hidden>标记人物出画</button></div>
        <p class="rm-summary"></p>
        <div class="rm-actions">
          <select data-layer aria-label="要标记的区域"><option value="selection">替换人物</option><option value="protection">保护前景</option></select>
          <button type="button" data-mode="point" aria-pressed="true">智能点选</button>
          <button type="button" data-mode="box" aria-pressed="false">框选区域</button>
          <button type="button" data-locate-person hidden>定位原片人物</button>
          <button type="button" data-clear-protection hidden>从此帧停止保护</button>
          <span class="rm-selection-status"></span>
        </div>
        <div class="rm-stage">
          <div class="rm-frame"><span>原画面</span><div class="rm-surface"><img class="rm-original" alt="原片画面"><img class="rm-mask" alt="" hidden><img class="rm-mask rm-protection" alt="" hidden><span class="rm-person-point" aria-hidden="true" hidden></span></div></div>
          <div class="rm-frame"><span>替换预览</span><div class="rm-output">生成后显示在这里</div></div>
        </div>
        <div class="rm-actions rm-role">
          <label>替换为<select data-role aria-label="资产库角色"></select></label>
          <label>参考角度<select data-view aria-label="参考角度"></select></label>
          <label class="rm-note">本镜头要求<input maxlength="800" placeholder="例如保留挡在人物前面的桌沿"></label>
          <button type="button" data-generate>生成预览</button>
        </div>
        <div class="rm-actions rm-review" aria-label="预览版本与审核"></div>
        <section class="rm-motion" aria-label="重制镜头">
          <h3>重制这个镜头</h3>
          <p class="rm-motion-hint">先采用首帧预览，再生成视频。</p>
          <div class="rm-actions">
            <button type="button" data-analyze-motion>分析原片动作</button>
            <button type="button" data-use-motion hidden>追加到动作说明</button>
          </div>
          <div class="rm-motion-analysis" hidden>
            <p data-camera-motion></p>
            <ol data-motion-beats aria-label="镜头内的动作时间点"></ol>
          </div>
          <div class="rm-actions">
            <label>动作与运镜<textarea data-motion rows="2" maxlength="1600" placeholder="补充动作时机、人物与道具的互动，或说明镜头如何运动"></textarea></label>
            <button type="button" data-generate-video>生成镜头视频</button>
            <button type="button" data-cut="split_long_shot" hidden>拆分长镜头</button>
          </div>
          <div class="rm-video-result" hidden>
            <div class="rm-actions rm-video-review"></div>
            <video data-result controls preload="metadata" playsinline muted></video>
            <div class="rm-video-status" role="status"></div>
          </div>
        </section>
      </section>
    </div><div class="rm-status" role="status"></div>`;
  document.body.append(panel);
  panel.showModal ? panel.showModal() : panel.setAttribute("open", "");
  const el = selector => panel.querySelector(selector);
  const player = el("video");
  const result = el("[data-result]");
  player.src = remakeMedia(source.ref);
  let session = null, assets = [], shotIndex = 0, frameKey = "first", mode = "point", versionId = null;
  let busy = true, dragStart = null, timer = null, revision = 0;
  let videoId = null, originalEnd = null;
  let comparison = null;
  let playbackError = false, restorePlaybackTime = 0;
  let liveJobs = {};
  const cancelling = new Set();
  const drafts = new Map();
  const draftScope = () => ME_USER?.id == null ? "" : "oneshot.remake.draft:" +
    JSON.stringify([ME_USER.id, board, session?.session_node || video.id, source.ref]) + ":";
  const inScope = index => !session?.mapping || session.mapping.shots.includes(index);
  const matchesPerson = version => !session?.mapping || (
    version?.asset?.id === session.mapping.asset && version.source_person === session.mapping.source
  );
  const adoptedPreview = frame => frame.previews.find(item => item.job === frame.approved && item.ref);
  const matchesFirst = (guide, first) => !!guide && !!first && matchesPerson(first) &&
    guide.asset?.id === first.asset?.id && guide.source_person === first.source_person;
  const status = message => { el(".rm-status").textContent = message; };
  const currentShot = () => session?.shots[shotIndex];
  const currentFrame = () => currentShot()?.frames[frameKey];
  const shotKey = (shot = currentShot()) => shot ? `${shot.start}:${shot.end}` : "";
  const draftKey = (field, shot, asset) => JSON.stringify([shotKey(shot), session?.mapping?.source ?? null, field, asset ?? null]);
  function readDraft(field, shot = currentShot(), asset) {
    const key = draftKey(field, shot, asset);
    if (drafts.has(key)) return drafts.get(key);
    const scope = draftScope();
    try { return scope ? localStorage.getItem(scope + key) : null; }
    catch { return null; }
  }
  function writeDraft(field, value, asset) {
    const key = draftKey(field, currentShot(), asset);
    drafts.set(key, value);
    const scope = draftScope();
    try { if (scope) localStorage.setItem(scope + key, value); }
    catch {}
  }
  const personAbsent = frame => !!frame?.person_absent && (
    !session.mapping || frame.person_absent.source == null || frame.person_absent.source === session.mapping.source
  );
  const personSelection = frame => {
    const selection = frame.selection;
    if (personAbsent(frame)) return null;
    return selection?.source_person && session.mapping && selection.source_person !== session.mapping.source ? null : selection;
  };
  function close() {
    clearTimeout(timer);
    stopComparison();
    if (!player.paused) player.pause();
    if (!result.paused) result.pause();
    panel.remove();
  }
  el("[data-close]").onclick = close;
  panel.addEventListener("cancel", event => { event.preventDefault(); close(); });
  panel.addEventListener("keydown", event => event.stopPropagation());
  panel.addEventListener("pointerdown", event => event.stopPropagation());
  const active = p => !["done","error"].includes(p.state);
  player.ontimeupdate = () => {
    if (originalEnd !== null && player.currentTime >= originalEnd) {
      player.pause();
      originalEnd = null;
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
      status(error.message || "无法播放原声对照");
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
    originalEnd = null;
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
    playbackError = true;
    renderPanel();
  };
  player.onloadedmetadata = () => {
    playbackError = false;
    if (restorePlaybackTime > 0 && Number.isFinite(player.duration)) {
      player.currentTime = Math.min(restorePlaybackTime, player.duration);
    }
    restorePlaybackTime = 0;
    renderPanel();
  };
  result.onratechange = () => { if (comparison) player.playbackRate = result.playbackRate; };

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
    const choice = readDraft("view", shot, asset?.id);
    return choice === "main" || asset?.character_views?.[choice] ? choice : suggestedView(asset, shot);
  }

  function roleReference(asset, view) {
    return asset?.character_views?.[view] || (view === "main" ? asset?.ref : "") || "";
  }

  function fillViews() {
    const asset = assets.find(item => item.id === el("[data-role]").value);
    const views = el("[data-view]");
    const recommended = suggestedView(asset, currentShot());
    const value = chosenView(asset, currentShot());
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
    if (!personAbsent(shot.frames.first)) return "first";
    return Object.keys(shot.frames)
      .filter(key => Number.isInteger(shot.frames[key].correction_tick) && personSelection(shot.frames[key]))
      .sort((a, b) => shot.frames[a].correction_tick - shot.frames[b].correction_tick)[0];
  }

  function batchPreviews() {
    const mapping = session?.mapping;
    const asset = assets.find(item => item.id === mapping?.asset);
    if (!asset) return [];
    const queue = [];
    for (const index of mapping.shots) {
      const shot = session.shots[index];
      const key = startPreviewKey(shot);
      if (!key) continue;
      const frame = shot.frames[key];
      const selection = personSelection(frame);
      if (!selection || shot.keep_original || frame.previews.some(active)) continue;
      const view = chosenView(asset, shot);
      const reference = roleReference(asset, view);
      if (!reference) continue;
      const note = (readDraft("note", shot) ?? "").slice(0, 800);
      const hasPreview = frame.previews.some(p => p.ref && matchesPerson(p) && p.mask === selection.mask &&
        (p.protection || null) === (frame.protection?.mask || null) && (p.asset?.view || "main") === view &&
        p.asset?.ref === reference && (p.note || "") === note);
      if (!hasPreview) queue.push({shot:index, frame:key, view, reference, note});
    }
    return queue;
  }

  function shotStart(shot) {
    const first = shot.frames.first;
    if (!personAbsent(first)) {
      const preview = adoptedPreview(first);
      return preview ? {preview, frame:first, ref:preview.ref, entryTick:0} : null;
    }
    const entry = shot.frames[startPreviewKey(shot)];
    const preview = entry && adoptedPreview(entry);
    if (!preview) return null;
    return {preview, frame:entry, ref:first.ref, entryTick:entry.correction_tick - Math.round(shot.start * RM_FPS)};
  }

  function previewMatchesRegions(frame, preview) {
    const selection = personSelection(frame);
    return !!preview && (!selection || selection.mask === preview.mask) &&
      (frame.protection?.mask ?? null) === (preview.protection ?? null);
  }

  function shotGuides(shot, first, entryTick = 0) {
    const guides = [];
    for (const frame of Object.values(shot.frames)) {
      if (!Number.isInteger(frame.correction_tick) || personAbsent(frame)) continue;
      const guide = adoptedPreview(frame);
      const tick = frame.correction_tick - Math.round(shot.start * RM_FPS);
      if (tick < entryTick || !matchesFirst(guide, first)) continue;
      if (!previewMatchesRegions(frame, guide)) return null;
      guides.push({tick, ref:guide.ref});
    }
    return guides.sort((a, b) => a.tick - b.tick);
  }

  function shotMotion(shot) {
    return readDraft("motion", shot) ?? shot.videos?.filter(matchesPerson).at(-1)?.motion ?? "";
  }

  function motionAnalysis(shot) {
    const analysis = shot.motion_analysis;
    return analysis && analysis.source_person === (session.mapping?.source ?? null) ? analysis : null;
  }

  function renderMotionAnalysis(shot) {
    const analysis = motionAnalysis(shot);
    const control = el("[data-analyze-motion]");
    control.disabled = busy || !inScope(shotIndex);
    control.textContent = analysis ? "重新分析原片动作" : "分析原片动作";
    const use = el("[data-use-motion]");
    use.hidden = !analysis;
    use.disabled = busy;
    el(".rm-motion-analysis").hidden = !analysis;
    const camera = el("[data-camera-motion]");
    camera.textContent = analysis?.camera || "";
    camera.hidden = !camera.textContent;
    el("[data-motion-beats]").replaceChildren(...(analysis?.beats || []).map(beat => {
      const time = beat.tick / RM_FPS;
      const row = document.createElement("li");
      const jump = button(`${time.toFixed(2)} 秒`, () => {
        stopComparison();
        if (!player.paused) player.pause();
        originalEnd = null;
        player.currentTime = (Math.round(shot.start * RM_FPS) + beat.tick) / RM_FPS;
        renderCutControls();
      }, busy);
      jump.title = "定位到这张原片采样画面";
      const action = document.createElement("span");
      action.textContent = beat.action;
      row.append(jump, action);
      return row;
    }));
  }

  function batchVideos() {
    if (!session?.mapping) return [];
    const queue = [];
    for (const index of session.mapping.shots) {
      const shot = session.shots[index];
      const start = shotStart(shot);
      const first = start?.preview;
      const versions = shot.videos || [];
      const duration = (Math.round(shot.end * RM_FPS) - Math.round(shot.start * RM_FPS)) / RM_FPS;
      if (!first || !matchesPerson(first) || !previewMatchesRegions(start.frame, first) ||
          shot.keep_original || versions.some(active) || duration <= 0 || duration > RM_MAX_SHOT_SECONDS) continue;
      const guides = shotGuides(shot, first, start.entryTick);
      if (!guides) continue;
      const motion = shotMotion(shot).slice(0, 1600);
      const ready = versions.some(v => {
        const used = v.guides || [];
        return v.ref && matchesPerson(v) && v.first_frame === start.ref && (v.motion || "") === motion &&
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
    if (start && matchesPerson(start.preview)) return previewMatchesRegions(start.frame, start.preview)
      ? ` · 已采用${label}` : ` · ${label}选区已更新`;
    const latest = shot.frames[key].previews.filter(matchesPerson).at(-1);
    if (!latest) {
      if (key !== "first") return " · 入画帧待生成";
      return !personSelection(shot.frames.first) && personHint(shot.frames.first) ? " · 人物位置待确认" : "";
    }
    if (active(latest)) return ` · ${label}生成中`;
    if (latest.error === "已取消") return ` · ${label}已取消`;
    return ` · ${label}${latest.ref ? "待审核" : "失败"}`;
  }

  function renderMapping(shots) {
    const editor = el(".rm-mapping");
    editor.hidden = !shots.length;
    if (!shots.length) return;
    const mapping = session.mapping;
    const people = [...new Set(shots.flatMap(shotPeople))];
    const version = JSON.stringify([mapping, people, session.source_people, session.cut_revision, assets.map(asset => asset.id)]);
    if (editor.dataset.state !== version) {
      editor.dataset.state = version;
      const person = el("[data-person]");
      person.replaceChildren(new Option("选择分析到的人物", ""));
      for (const name of people) person.append(new Option(name, name));
      person.append(new Option("手动填写人物", "__manual__"));
      person.value = mapping ? people.includes(mapping.source) ? mapping.source : "__manual__" : people.length ? "" : "__manual__";
      el("[data-person-manual]").value = mapping?.source || "";
      el("[data-person-look]").value = mapping?.look || "";
      const asset = el("[data-map-asset]");
      asset.replaceChildren(new Option("选择资产库角色", ""), ...assets.map(item => new Option(item.name, item.id)));
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
    el("[data-clear-mapping]").disabled = busy;
    el("[data-save-mapping]").disabled = busy;
  }

  function updateSuggestions() {
    const person = el("[data-person]").value;
    el("[data-manual-label]").hidden = person !== "__manual__";
    const appearance = session.source_people?.find(item => item.name === person)?.look;
    el("[data-person-look]").placeholder = appearance || "例如红色外套、黑色眼镜";
    for (const hint of panel.querySelectorAll("[data-suggestion]")) {
      const names = shotPeople(session.shots[Number(hint.dataset.suggestion)]);
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
      batch.hidden = !session?.mapping;
      batch.disabled = busy || !count;
      batch.textContent = count ? `${label}（${count} 个镜头）` : label;
    }
  }

  function batchLocateShots() {
    return (session?.mapping?.shots || []).filter(index => {
      const shot = session.shots[index];
      const first = shot.frames.first;
      return !shot.keep_original && !personAbsent(first) && !personSelection(first) && !personHint(first);
    });
  }

  function renderPanel() {
    if (!panel.isConnected) return;
    renderPlayback();
    const shots = session?.shots || [];
    el("[data-analyze]").hidden = !!shots.length;
    el("[data-analyze]").disabled = busy;
    el(".rm-analysis").textContent = session?.warning || (shots.length ? `${shots.length} 个镜头` : "支持 60 秒以内的视频");
    el(".rm-editor").hidden = !shots.length;
    renderMapping(shots);
    renderCutControls();
    renderBatchButtons();
    renderTasks();
    if (!shots.length) return;
    const shot = currentShot();
    if (!currentFrame()) frameKey = "first";
    const frame = currentFrame();
    const shotList = el(".rm-shots");
    shotList.replaceChildren(...shots.map((item, i) => {
      const card = document.createElement("button");
      card.type = "button";
      card.setAttribute("aria-pressed", String(i === shotIndex));
      const chosen = item.videos?.find(v => v.job === item.adopted_video);
      const reviewIssue = session.export_review?.remaining.find(entry => entry.shot === i);
      card.textContent = `镜头 ${i + 1} · ${item.start.toFixed(2)}–${item.end.toFixed(2)} 秒` +
        (!inScope(i) ? " · 不在替换范围" : item.keep_original ? " · 保留原片" :
          item.videos?.some(active) ? " · 视频生成中" : chosen && !reviewIssue && matchesPerson(chosen) ? " · 已采用视频" :
            chosen && reviewIssue ? " · 需要重新审核" : previewStatus(item));
      card.onclick = () => {
        if (busy) return;
        stopComparison();
        shotIndex = i;
        frameKey = "first";
        versionId = null;
        videoId = null;
        originalEnd = null;
        player.currentTime = item.start;
        fillViews();
        renderPanel();
      };
      return card;
    }));
    el(".rm-shot").textContent = `镜头 ${shotIndex + 1}`;
    const options = el("[data-frame]");
    const corrections = Object.entries(shot.frames).filter(([, item]) => Number.isInteger(item.correction_tick))
      .sort(([, a], [, b]) => a.correction_tick - b.correction_tick);
    const first = shotStart(shot)?.preview;
    const startKey = startPreviewKey(shot);
    const choices = [["first", "镜头首帧"], ["middle", "镜头中间帧"], ...corrections.map(([key, item]) =>
      [key, `${key === startKey ? "首次入画帧" : "校正帧"} · ${item.at.toFixed(2)} 秒${personAbsent(item) ? " · 人物出画" : item.approved
        ? !previewMatchesRegions(item, adoptedPreview(item)) ? " · 选区已更新" :
          matchesFirst(adoptedPreview(item), first) ? " · 动作关键帧" : first ? " · 角色与首帧不同" : " · 等待首帧"
        : ""}`])];
    if (JSON.stringify(choices) !== options.dataset.choices) {
      options.replaceChildren(...choices.map(([key, label]) => new Option(label, key)));
      options.dataset.choices = JSON.stringify(choices);
    }
    options.value = frameKey;
    const isCorrection = Number.isInteger(frame.correction_tick);
    const absent = personAbsent(frame);
    el("[data-capture-correction]").disabled = busy || playbackError;
    const suggest = el("[data-suggest-entry]");
    suggest.hidden = !session.mapping || !inScope(shotIndex) || !personAbsent(shot.frames.first);
    suggest.disabled = busy;
    el("[data-remove-correction]").hidden = !isCorrection;
    el("[data-remove-correction]").disabled = busy;
    const absence = el("[data-absence]");
    absence.hidden = (frameKey !== "first" && !isCorrection) || !inScope(shotIndex);
    absence.disabled = busy;
    absence.textContent = absent ? "取消人物出画标记" : isCorrection ? "标记人物从此帧出画" : "标记人物尚未入画";
    const role = el("[data-role]");
    role.disabled = busy || !!session.mapping;
    if (session.mapping && role.value !== session.mapping.asset) {
      role.value = session.mapping.asset;
      fillViews();
    }
    const note = el(".rm-note input");
    const draftNote = readDraft("note") ?? "";
    if (note.value !== draftNote) note.value = draftNote;
    const summary = shot.summary || {};
    el(".rm-summary").textContent = [summary.shot_size, summary.camera, ...(Array.isArray(summary.action) ? summary.action : [])].filter(Boolean).join(" · ");
    const original = el(".rm-original"), selection = el(".rm-mask");
    const originalUrl = remakeMedia(frame.ref);
    if (original.getAttribute("src") !== originalUrl) original.src = originalUrl;
    const selectedArea = personSelection(frame);
    selection.hidden = !selectedArea;
    if (selectedArea) selection.src = remakeMedia(selectedArea.overlay);
    const protection = el(".rm-protection");
    protection.hidden = !frame.protection?.overlay;
    if (!protection.hidden) protection.src = remakeMedia(frame.protection.overlay);
    const layer = el("[data-layer]");
    layer.hidden = frameKey !== "first" && !isCorrection;
    if (layer.hidden) layer.value = "selection";
    layer.disabled = busy;
    updateSelectionControls();
    const previews = frame.previews;
    const latest = previews.at(-1);
    const version = previews.find(item => item.job === versionId) || latest;
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
      select.setAttribute("aria-label", "预览版本");
      previews.forEach((item, i) => {
        const asset = assets.find(asset => asset.id === item.asset?.id);
        const oldReference = asset && item.asset?.ref && item.asset.ref !== roleReference(asset, item.asset.view || "main");
        const state = !matchesPerson(item) ? "旧映射" : item.ref && !previewMatchesRegions(frame, item) ? "选区已更新" :
          item.job === frame.approved ? "已采用" : item.ref ? "待审核" : item.state === "error" ? "失败" : "处理中";
        select.append(new Option(`版本 ${i + 1} · ${state}${oldReference ? " · 旧参考图" : ""}`, item.job));
      });
      select.value = version.job;
      select.onchange = () => { versionId = select.value; renderPanel(); };
      review.append(select);
    }
    if (version?.ref) {
      if (version.job !== frame.approved) {
        review.append(button(isCorrection ? "用作动作关键帧" : "采用此预览", () => change("approve", {job:version.job}),
          busy || absent || !inScope(shotIndex) || !matchesPerson(version) || !previewMatchesRegions(frame, version)));
      } else {
        review.append(button("放入画布", () => insertPreview(version, frame, false), busy));
        if (frameKey === "first" && !absent) review.append(button("用作视频首帧", () => insertPreview(version, frame, true),
          busy || !matchesPerson(version) || !previewMatchesRegions(frame, version)));
        if (isCorrection) review.append(button("取消动作关键帧", () => change("clear_guide"), busy));
      }
    }
    if (!shot.keep_original) review.append(button("保留这个原镜头", () => change("keep"), busy));
    el("[data-generate]").disabled = busy || !inScope(shotIndex) || !selectedArea || !role.value || !!latest && active(latest);
    el("[data-frame]").disabled = busy;
    renderVideo();
  }

  function renderPlayback() {
    const playback = session?.playback;
    const playingUrl = playback?.ref ? remakeMedia(playback.ref) : "";
    if (playingUrl && player.getAttribute("src") !== playingUrl) {
      stopComparison();
      restorePlaybackTime = player.currentTime;
      player.src = playingUrl;
    }
    const converting = !!playback && active(playback);
    const controls = el("[data-playback]");
    controls.hidden = !playbackError && !converting;
    el("[data-playback-status]").textContent = converting ? "正在生成浏览器可播放的预览…" :
      playback?.error || (playingUrl ? "播放预览暂不可用，可继续从已提取的画面操作。" : "浏览器无法播放原片，可生成兼容的播放预览。");
    const convert = el("[data-prepare-playback]");
    convert.hidden = !playbackError || converting;
    convert.disabled = busy;
    convert.textContent = playback?.error || playingUrl ? "重试播放预览" : "生成播放预览";
  }

  function renderCutControls() {
    const shot = currentShot();
    el(".rm-cuts").hidden = !shot;
    if (!shot) return;
    const at = Math.round(player.currentTime * RM_FPS);
    const start = Math.round(shot.start * RM_FPS);
    const end = Math.round(shot.end * RM_FPS);
    const previous = Math.round((session.shots[shotIndex - 1]?.start || 0) * RM_FPS);
    el("[data-cut-time]").textContent = `${(at / RM_FPS).toFixed(2)} 秒`;
    const locked = busy || playbackError || !!session.export && active(session.export);
    el('[data-cut="split_shot"]').disabled = locked || at <= start || at >= end;
    el('[data-cut="move_cut"]').disabled = locked || !shotIndex || at <= previous || at >= end || at === start;
    el('[data-cut="merge_shots"]').disabled = locked || !shotIndex;
    const longSplit = el('[data-cut="split_long_shot"]');
    const pieces = Math.ceil((end - start) / (RM_MAX_SHOT_SECONDS * RM_FPS));
    longSplit.hidden = pieces <= 1 || !inScope(shotIndex);
    longSplit.disabled = busy || !!session.export && active(session.export) || shot.videos?.some(active) ||
      Object.values(shot.frames).some(frame => frame.previews.some(active));
    longSplit.textContent = `拆成 ${pieces} 个镜头`;
    const undo = el('[data-cut="undo_cut"]');
    undo.hidden = !session.can_undo_cut;
    undo.disabled = locked;
    for (const button of panel.querySelectorAll("[data-step]")) button.disabled = locked;
  }

  function renderVideo() {
    const shot = currentShot();
    renderMotionAnalysis(shot);
    const videos = shot.videos || [];
    const latest = videos.at(-1);
    const selected = videos.find(v => v.job === videoId) || latest;
    const start = shotStart(shot);
    const approved = start?.preview;
    const startsAbsent = personAbsent(shot.frames.first);
    const firstApproved = !!approved && matchesPerson(approved);
    const staleStart = firstApproved && !previewMatchesRegions(start.frame, approved);
    const guides = firstApproved ? shotGuides(shot, approved, start.entryTick) : [];
    const tooLong = Math.round(shot.end * RM_FPS) - Math.round(shot.start * RM_FPS) > RM_MAX_SHOT_SECONDS * RM_FPS;
    let hint = "先在「镜头首帧」中采用替换预览。";
    if (!inScope(shotIndex)) hint = "该镜头不在替换范围，合成时使用原片。";
    else if (tooLong) hint = `单个镜头最多生成 ${RM_MAX_SHOT_SECONDS} 秒。拆分后可逐段预览并批量生成。`;
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
    const motion = shotMotion(shot);
    if (input.value !== motion) input.value = motion;
    el("[data-generate-video]").disabled = busy || !inScope(shotIndex) || tooLong || !firstApproved || staleStart || !guides || videos.some(active);
    el("[data-generate-video]").textContent = latest ? "重试镜头视频" : "生成镜头视频";
    el(".rm-video-result").hidden = !selected;
    const source = selected?.ref ? remakeMedia(selected.ref) : "";
    if (comparison && comparison.sourceUrl !== source) stopComparison();
    result.hidden = !source;
    if (source && result.getAttribute("src") !== source) result.src = source;
    else if (!source) result.removeAttribute("src");
    el(".rm-video-status").textContent = selected?.error || (selected && active(selected)
      ? selected.mode === "local" ? "正在跟踪人物并合成…" : "正在处理镜头视频…" : "");
    const review = el(".rm-video-review");
    review.replaceChildren();
    if (selected) {
      const startMatches = !!selected.entry_tick === startsAbsent;
      const canAdopt = startMatches && (!startsAbsent || selected.mode === "local");
      const select = document.createElement("select");
      select.setAttribute("aria-label", "镜头视频版本");
      videos.forEach((v, i) => {
        const label = v.mode === "local" ? "局部合成" : v.guides?.length ? `按 ${v.guides.length} 张动作关键帧重制` : "整镜重制";
        select.append(new Option(`${i + 1}. ${label} · ${!matchesPerson(v) ? "旧映射" : shot.adopted_video === v.job && !shot.keep_original ? "已采用" : v.ref ? "待审核" : v.state === "error" ? "失败" : "处理中"}`, v.job));
      });
      select.value = selected.job;
      select.onchange = () => { videoId = select.value; renderVideo(); };
      review.append(select, button("播放原镜头", () => {
        stopComparison();
        if (!result.paused) result.pause();
        originalEnd = shot.end;
        player.currentTime = shot.start;
        player.play().catch(error => status(error.message));
      }, busy || playbackError));
      if (source) {
        const compare = button(comparison ? "停止原声对照" : "原声对照播放", () => toggleComparison(shot, source), busy || playbackError);
        compare.dataset.compare = "";
        review.append(compare);
      }
      if (source && (shot.adopted_video !== selected.job || shot.keep_original)) {
        review.append(button("采用此视频", () => change("approve_video", {job:selected.job}),
          busy || !canAdopt || !inScope(shotIndex) || !matchesPerson(selected)));
      }
      if (source && canAdopt && shot.adopted_video === selected.job && !shot.keep_original && inScope(shotIndex) && matchesPerson(selected)) {
        review.append(button("镜头放入画布", () => insertRemadeVideo(selected, shot), busy));
      }
      if (source && selected.mode !== "local") {
        const count = Object.values(shot.frames).filter(f => Number.isInteger(f.correction_tick) &&
          (personSelection(f) || personAbsent(f) || f.protection)).length;
        const caption = count ? `跟踪人物并局部合成（${count} 张校正帧）` : "跟踪人物并局部合成";
        review.append(button(caption, () => change("localize", {job:selected.job}),
          busy || !startMatches || !inScope(shotIndex) || !matchesPerson(selected) || videos.some(active)));
      }
    }
    const exp = session.export;
    const {adopted, remaining} = session.export_review;
    const next = remaining.find(entry => entry.shot > shotIndex) || remaining[0];
    const nextReview = el("[data-review-next]");
    nextReview.hidden = !next;
    nextReview.disabled = busy;
    if (next) {
      nextReview.textContent = `${remaining.length} 个镜头待审核`;
      nextReview.title = `镜头 ${next.shot + 1} ${next.error}`;
      nextReview.onclick = () => {
        const shotButton = el(".rm-shots").children[next.shot];
        shotButton.click();
        el(".rm-shots").children[next.shot].focus();
        status(`镜头 ${next.shot + 1} ${next.error}`);
      };
    }
    const exportButton = el("[data-export]");
    exportButton.hidden = !adopted && !remaining.length;
    exportButton.disabled = busy || !adopted || !!remaining.length || !!exp && active(exp);
    exportButton.textContent = exp && active(exp) ? "合成中…" : "合成并保留原声";
    const download = el("[data-download]");
    const watch = el("[data-watch]");
    const insert = el("[data-insert-export]");
    download.hidden = !exp?.ref || !!exp.stale;
    watch.hidden = download.hidden;
    insert.hidden = download.hidden;
    insert.disabled = busy;
    if (exp?.ref) {
      watch.href = download.href = remakeMedia(exp.ref);
      download.download = exp.ref.split("/").at(-1);
    }
    if (exp?.error && !exp.stale && !el(".rm-status").textContent) status(exp.error);
  }

  function button(label, handler, disabled) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = label; b.onclick = handler; b.disabled = disabled;
    return b;
  }

  function insertCanvasFrame(ref, frame, name) {
    const at = placeRight(video, "image");
    const image = addNode("image", at.x, at.y, {}, {name, versions:[
      mediaVersion({ref, url:remakeMedia(ref), w:frame.w, h:frame.h}, {source:"edit"}),
    ], cur:0});
    return image;
  }

  function insertPreview(version, frame, videoFirst) {
    if (boardId !== board || node(video.id) !== video) return status("原片所在画布已切换");
    checkpoint();
    const image = insertCanvasFrame(version.ref, frame, `镜头 ${shotIndex + 1} · ${version.asset.name}`);
    if (videoFirst) {
      const shot = currentShot(), info = shot.summary;
      const prompt = [info.camera, ...(Array.isArray(info.action) ? info.action : [])].filter(Boolean).join("。");
      const at = placeRight(image, "video");
      const target = addNode("video", at.x, at.y, {
        prompt, duration: Math.min(15, Math.max(2, Math.round(shot.end - shot.start))),
      }, {name:`重制 · 镜头 ${shotIndex + 1}`});
      link(image, target, true);
      selectOnly(target.id);
    } else selectOnly(image.id);
    close();
  }

  function insertRemadeVideo(version, shot = null) {
    if (boardId !== board || node(video.id) !== video) return status("原片所在画布已切换");
    if (!version?.ref || version.stale) return;
    const kind = shot ? "shot" : "export";
    const origin = {kind, source_node:video.id, source_ref:source.ref, job:version.job,
      ...(shot ? {start:shot.start, end:shot.end} : {clips:version.clips || []})};
    const matchesOrigin = v => v.remake?.kind === kind && v.remake.source_node === video.id &&
      v.remake.source_ref === source.ref && (!shot || v.remake.start === shot.start && v.remake.end === shot.end);
    const candidates = B.nodes.filter(n => n.type === "video" && n.versions.some(matchesOrigin));
    let target = candidates.find(n => n.versions.some(v => matchesOrigin(v) && v.ref === version.ref)) || candidates[0];
    if (target?.job || (target && prepping.has(target.id))) return status("画布上的对应视频正在生成，请等待完成");
    const existing = target?.versions.findIndex(v => matchesOrigin(v) && v.ref === version.ref);
    if (existing >= 0) {
      switchVersion(target, existing);
    } else {
      checkpoint();
      const first = shot?.frames.first;
      const label = shot ? `重制 · 镜头 ${shotIndex + 1}` : "重制成片";
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
      const seconds = version.duration || (shot ? shot.end - shot.start : session.duration || session.shots.at(-1).end);
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
      }, {source:"remake", label, mode:shot ? version.mode === "local" ? "局部合成" : "整镜重制" : "重制成片",
        remake:origin, input_edges:edges, node_data:data}));
      switchVersion(target, target.versions.length - 1, {recordUndo:false});
    }
    close();
    selectOnly(target.id);
    fit([target]);
  }

  function schedulePoll() {
    clearTimeout(timer);
    if (!panel.isConnected || !session) return;
    const ids = [...new Set(pendingTasks().map(task => task.job))];
    if (!ids.length) return;
    timer = setTimeout(async () => {
      if (!panel.isConnected) return;
      if (!busy) {
        const pendingRevision = revision;
        try {
          const response = await fetch("/api/jobs?ids=" + encodeURIComponent(ids.join(",")));
          if (!response.ok) throw new Error("进度暂不可用，正在重连");
          const jobs = await response.json();
          const result = await remakeRequest(url);
          if (revision === pendingRevision && !busy && panel.isConnected) {
            liveJobs = jobs;
            applySession(result);
            renderPanel();
          }
        } catch (error) { status(error.message); }
      }
      schedulePoll();
    }, 1500);
  }

  function pendingTasks() {
    const tasks = [];
    if (session?.playback && active(session.playback)) tasks.push({job:session.playback.job, label:"原片播放预览"});
    if (session?.export && active(session.export)) tasks.push({job:session.export.job, label:"成片合成"});
    for (const [index, shot] of (session?.shots || []).entries()) {
      const label = `镜头 ${index + 1}`;
      for (const [key, frame] of Object.entries(shot.frames)) {
        const name = key === "first" ? "首帧预览" : key === "middle" ? "中间帧预览" : `${frame.at.toFixed(2)} 秒校正帧预览`;
        for (const preview of frame.previews.filter(active)) tasks.push({job:preview.job, label:`${label} · ${name}`});
      }
      for (const video of (shot.videos || []).filter(active)) {
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
      const cancel = button("取消", () => cancelTask(task.job), busy || cancelling.has(task.job));
      cancel.setAttribute("aria-label", `取消${task.label}`);
      row.append(cancel);
      return row;
    }));
  }

  async function cancelTask(job) {
    if (busy || cancelling.has(job)) return;
    const requestRevision = ++revision;
    cancelling.add(job);
    renderTasks();
    try {
      await api("/api/cancel", {ids:[job]});
      const next = await remakeRequest(url);
      if (!busy && requestRevision === revision && panel.isConnected) applySession(next);
    } catch (error) {
      status(error.message);
    } finally {
      cancelling.delete(job);
      renderPanel();
      schedulePoll();
    }
  }

  function applySession(next) {
    const cutChanged = next?.cut_revision !== session?.cut_revision;
    session = next;
    if (!cutChanged || !session?.shots.length) return;
    stopComparison();
    shotIndex = session.selected_shot ?? Math.min(shotIndex, session.shots.length - 1);
    frameKey = "first";
    versionId = videoId = null;
    originalEnd = null;
    player.currentTime = currentShot().start;
    fillViews();
  }

  async function change(action, extra={}) {
    if (busy) return;
    revision++;
    busy = true;
    renderPanel();
    const cutAction = ["split_shot", "split_long_shot", "move_cut", "merge_shots", "undo_cut"].includes(action);
    status(cutAction ? "正在更新剪辑点…" : {analyze:"正在拆分与分析镜头…",select:"正在处理选区…",locate_person:"正在识别原片人物…",suggest_entry:"正在查找人物入画位置…",batch_locate_people:"正在为各镜头查找人物位置…",apply_person_hint:"正在按建议生成选区…",preview:"正在提交预览…",batch_previews:"正在提交各镜头的起始帧预览…",generate_video:"正在提交镜头生成…",batch_videos:"正在批量提交镜头视频…",localize:"正在提交局部合成…",export:"正在提交成片合成…",analyze_motion:"正在分析带时间点的原片画面…"}[action] || "");
    try {
      applySession(await remakeRequest(url, {action, shot:shotIndex, frame:frameKey, cut_revision:session?.cut_revision ?? 0, ...extra}));
      if (action === "prepare_playback" && session.playback?.ref && player.getAttribute("src") === remakeMedia(session.playback.ref)) {
        player.load();
      }
      if (["analyze", "map_person", "remove_mapping"].includes(action)) fillViews();
      if (["capture_correction", "suggest_entry"].includes(action) && session.captured_frame) {
        frameKey = session.captured_frame;
        versionId = null;
        if (action === "suggest_entry") {
          stopComparison();
          originalEnd = null;
          if (!playbackError) player.currentTime = currentFrame().at;
        }
      }
      if (action === "remove_correction") {
        frameKey = "first";
        versionId = null;
      }
      if (action === "preview" || action === "batch_previews") versionId = null;
      if (["generate_video", "batch_videos", "localize"].includes(action)) videoId = null;
      if (action === "batch_locate_people") {
        const {located, skipped, failed} = session[action];
        const items = [`${located.length} 个镜头已标出位置，请逐镜确认`];
        if (skipped.length) items.push(`跳过 ${skipped.length} 个镜头`);
        for (const result of failed) items.push(`镜头 ${result.shot + 1}（${result.error}）`);
        status(items.join("。"));
      } else if (action === "batch_previews" || action === "batch_videos") {
        const {submitted, skipped, failed} = session[action];
        if (action === "batch_previews" && submitted.includes(shotIndex)) {
          const key = startPreviewKey(currentShot());
          if (key && key !== "first" && key !== frameKey) {
            frameKey = key;
            stopComparison();
            originalEnd = null;
            player.currentTime = currentFrame().at;
          }
        }
        const items = [`已提交 ${submitted.length} 个镜头`];
        if (skipped.length) items.push(`跳过 ${skipped.length} 个镜头`);
        for (const result of failed) items.push(`镜头 ${result.shot + 1} 未提交（${result.error}）`);
        status(items.join("。"));
      } else if (action === "suggest_entry") {
        status(personSelection(currentFrame()) ? "已定位到候选入画帧，请核对此帧的人物选区。" :
          "已找到候选入画帧，请核对人物位置后确认。");
      } else {
        status(cutAction && session.mapping ? "剪辑点已更新，请核对人物映射范围。" : "");
      }
    } catch (error) { status(error.message); }
    finally { busy = false; renderPanel(); schedulePoll(); }
  }

  el("[data-analyze]").onclick = () => change("analyze");
  el("[data-prepare-playback]").onclick = () => change("prepare_playback");
  el("[data-batch-locate]").onclick = () => {
    const shots = batchLocateShots();
    if (!shots.length) return;
    const {source, asset, look} = session.mapping;
    change("batch_locate_people", {shots, person:source, asset, look:look || ""});
  };
  for (const [selector, action, prepare] of [
    ["[data-batch-previews]", "batch_previews", batchPreviews],
    ["[data-batch-videos]", "batch_videos", batchVideos],
  ]) {
    el(selector).onclick = () => {
      const shots = prepare();
      if (shots.length) change(action, {shots, asset:session.mapping.asset, person:session.mapping.source});
    };
  }
  for (const control of panel.querySelectorAll("[data-cut], [data-step]")) {
    control.onclick = () => {
      stopComparison();
      if (!player.paused) player.pause();
      const at = player.currentTime;
      if (control.dataset.cut) {
        change(control.dataset.cut, {at});
      } else {
        const end = session.shots.at(-1).end;
        player.currentTime = Math.max(0, Math.min(end, (Math.round(at * RM_FPS) + Number(control.dataset.step)) / RM_FPS));
        renderCutControls();
      }
    };
  }
  el("[data-person]").onchange = () => {
    el("[data-person-look]").value = "";
    updateSuggestions();
  };
  el("[data-save-mapping]").onclick = () => {
    const source = el("[data-person]").value;
    change("map_person", {
      person: source === "__manual__" ? el("[data-person-manual]").value : source,
      look: el("[data-person-look]").value,
      asset: el("[data-map-asset]").value,
      shots: Array.from(panel.querySelectorAll("[data-map-shots] input:checked"), box => Number(box.value)),
    });
  };
  el("[data-clear-mapping]").onclick = () => change("remove_mapping");
  el("[data-frame]").onchange = event => {
    stopComparison();
    frameKey = event.target.value;
    versionId = null;
    if (Number.isFinite(currentFrame().at)) player.currentTime = currentFrame().at;
    renderPanel();
  };
  el("[data-capture-correction]").onclick = () => {
    stopComparison();
    if (!player.paused) player.pause();
    change("capture_correction", {at:player.currentTime});
  };
  el("[data-remove-correction]").onclick = () => change("remove_correction");
  el("[data-absence]").onclick = () => change("set_absence", {absent:!personAbsent(currentFrame())});
  el("[data-suggest-entry]").onclick = () => change("suggest_entry", {person:session.mapping.source});
  el("[data-layer]").onchange = updateSelectionControls;
  el("[data-locate-person]").onclick = () => change(
    personHint() ? "apply_person_hint" : "locate_person", {person:session.mapping.source},
  );
  el("[data-clear-protection]").onclick = () => change("clear_protection");
  el("[data-role]").onchange = () => { fillViews(); renderPanel(); };
  el("[data-view]").onchange = event => {
    writeDraft("view", event.target.value, el("[data-role]").value);
    renderBatchButtons();
  };
  el(".rm-note input").oninput = event => {
    writeDraft("note", event.target.value);
    renderBatchButtons();
  };
  el("[data-generate]").onclick = () => {
    const asset = assets.find(item => item.id === el("[data-role]").value);
    const view = el("[data-view]").value;
    const reference = roleReference(asset, view);
    if (reference) change("preview", {asset:asset.id, view, reference, note:el(".rm-note input").value});
  };
  el("[data-motion]").oninput = event => {
    writeDraft("motion", event.target.value);
    renderBatchButtons();
  };
  el("[data-analyze-motion]").onclick = () => change("analyze_motion");
  el("[data-use-motion]").onclick = () => {
    const analysis = motionAnalysis(currentShot());
    if (!analysis) return;
    const notes = [analysis.camera, ...analysis.beats.map(beat => `镜头内 ${(beat.tick / RM_FPS).toFixed(2)} 秒，${beat.action}`)].filter(Boolean);
    const input = el("[data-motion]");
    const existing = input.value.split("\n");
    const combined = [input.value, ...notes.filter(note => !existing.includes(note))].filter(Boolean).join("\n");
    if (combined.length > input.maxLength) return status("追加后会超过动作说明字数，请先精简已有内容");
    input.value = combined;
    input.dispatchEvent(new Event("input"));
    input.focus();
  };
  el("[data-generate-video]").onclick = () => change("generate_video", {motion:el("[data-motion]").value});
  el("[data-export]").onclick = () => change("export");
  el("[data-insert-export]").onclick = () => insertRemadeVideo(session.export);
  function personHint(frame = currentFrame()) {
    const hint = frame?.person_hint;
    const mapping = session?.mapping;
    return hint && mapping && hint.source === mapping.source && hint.look === (mapping.look || "") ? hint.point : null;
  }

  function updateSelectionControls() {
    const frame = currentFrame();
    const layer = el("[data-layer]").value;
    const protect = layer === "protection";
    const clear = el("[data-clear-protection]");
    clear.hidden = !protect || frame.protection?.mask === null || (frameKey === "first" && !frame.protection);
    clear.disabled = busy;
    const instruction = mode === "box" ? "拖动框选" : "在原画面中点选";
    const target = protect ? "要保留的前景" : "要替换的人物";
    const selection = protect ? frame.protection : personSelection(frame);
    const absent = !protect && personAbsent(frame);
    let message = selection?.overlay ? `已标记${target}，可重新${mode === "box" ? "框选" : "点选"}` : instruction + target;
    if (protect && frame.protection?.mask === null) message = "从此帧停止保护，可重新标记前景";
    const locate = el("[data-locate-person]");
    locate.hidden = protect || absent || !session.mapping || !inScope(shotIndex) || !!selection;
    locate.disabled = busy;
    const point = locate.hidden ? null : personHint();
    locate.textContent = point ? "按此位置选中" : "定位原片人物";
    const marker = el(".rm-person-point");
    marker.hidden = !point;
    if (point) {
      marker.style.left = `${point[0] * 100}%`;
      marker.style.top = `${point[1] * 100}%`;
      message = `请核对「${session.mapping.source}」的位置，也可直接手动选择`;
    }
    if (absent) message = "局部合成从此帧保留原片。人物重新入画时，请将对应校正帧用作动作关键帧。";
    el(".rm-selection-status").textContent = message;
  }
  for (const control of panel.querySelectorAll("[data-mode]")) {
    control.onclick = () => {
      mode = control.dataset.mode;
      for (const item of panel.querySelectorAll("[data-mode]")) item.setAttribute("aria-pressed", String(item === control));
      updateSelectionControls();
    };
  }
  const surface = el(".rm-surface");
  function point(event) {
    const rect = el(".rm-original").getBoundingClientRect();
    const clamp = n => Math.max(0, Math.min(1, n));
    return [clamp((event.clientX - rect.left) / (rect.width || 1)), clamp((event.clientY - rect.top) / (rect.height || 1))];
  }
  surface.onpointerdown = event => {
    if (busy || event.button !== 0 || (personAbsent(currentFrame()) && el("[data-layer]").value === "selection")) return;
    event.preventDefault();
    dragStart = point(event);
    surface.setPointerCapture?.(event.pointerId);
  };
  surface.onpointercancel = () => { dragStart = null; };
  surface.onpointerup = event => {
    if (!dragStart || busy) return;
    const end = point(event);
    const selection = mode === "box" ? {rect:[...dragStart, ...end]} : {point:end};
    dragStart = null;
    change("select", {...selection, layer:el("[data-layer]").value});
  };
  try {
    renderPanel();
    [session, assets] = await Promise.all([
      remakeRequest(url),
      remakeRequest("/api/memory?board=" + encodeURIComponent(board) + "&kind=character"),
    ]);
    if (!panel.isConnected) return;
    assets = assets.filter(item => item.ref);
    const role = el("[data-role]");
    role.append(new Option(assets.length ? "选择资产库角色" : "资产库暂无带参考图的角色", ""));
    assets.forEach(item => role.append(new Option(item.name, item.id)));
    if (assets.some(item => item.id === session?.role?.asset)) role.value = session.role.asset;
    if (Number.isFinite(initialShotStart)) {
      const index = session?.shots.findIndex(shot => shot.start === initialShotStart);
      if (index >= 0) {
        shotIndex = index;
        if (initialFrame && Object.hasOwn(currentShot().frames, initialFrame)) frameKey = initialFrame;
        if (initialVideoJob && currentShot().videos?.some(version => version.job === initialVideoJob)) videoId = initialVideoJob;
        player.currentTime = currentFrame().at ?? initialShotStart;
      } else {
        status("剪辑点已变更，请在镜头列表中重新选择。");
      }
    }
    fillViews();
    busy = false;
    renderPanel();
    schedulePoll();
  } catch (error) { status(error.message); }
}
