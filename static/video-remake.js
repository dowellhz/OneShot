"use strict";

const RM_VIEW_NAMES = {main:"标准主图", face:"正面头肩", side:"侧面", back:"背面", detail:"固定细节"};
const RM_FPS = 24;

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

async function openVideoRemake(video) {
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
  panel.innerHTML = `<header class="rm-heading"><div><h2 id="rmTitle">视频重制 · 替换角色</h2><span>${esc(video.name)}</span></div><div class="rm-actions"><button type="button" data-export hidden>合成并保留原声</button><a data-watch target="_blank" rel="noopener" hidden>预览成片</a><a data-download hidden>下载成片</a><button type="button" data-close>返回画布</button></div></header>
    <div class="rm-body">
      <section class="rm-source"><video controls preload="metadata" playsinline></video>
        <div class="rm-actions"><button type="button" data-analyze>分析原片</button><span class="rm-analysis"></span></div>
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
          <button type="button" data-capture-correction>添加当前位置为校正帧</button><button type="button" data-remove-correction hidden>删除校正帧</button></div>
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
            <label>动作与运镜<textarea data-motion rows="2" maxlength="1600" placeholder="补充动作时机、人物与道具的互动，或说明镜头如何运动"></textarea></label>
            <button type="button" data-generate-video>生成镜头视频</button>
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
  const motionDrafts = new Map();
  const viewChoices = new Map();
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
  const shotKey = () => currentShot() ? `${currentShot().start}:${currentShot().end}` : "";
  const personSelection = frame => {
    const selection = frame.selection;
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
  result.onended = result.onerror = player.onerror = stopComparison;
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

  function fillViews() {
    const asset = assets.find(item => item.id === el("[data-role]").value);
    const views = el("[data-view]");
    const recommended = suggestedView(asset, currentShot());
    const value = viewChoices.get(shotKey() + ":" + asset?.id) || recommended;
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

  function renderPanel() {
    if (!panel.isConnected) return;
    const shots = session?.shots || [];
    el("[data-analyze]").hidden = !!shots.length;
    el("[data-analyze]").disabled = busy;
    el(".rm-analysis").textContent = session?.warning || (shots.length ? `${shots.length} 个镜头` : "支持 60 秒以内的视频");
    el(".rm-editor").hidden = !shots.length;
    renderMapping(shots);
    renderCutControls();
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
      card.textContent = `镜头 ${i + 1} · ${item.start.toFixed(2)}–${item.end.toFixed(2)} 秒` +
        (!inScope(i) ? " · 不在替换范围" : item.keep_original ? " · 保留原片" :
          chosen && matchesPerson(chosen) ? " · 已采用视频" : Object.values(item.frames).some(f => f.approved) ? " · 已采用预览" : "");
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
    const first = adoptedPreview(shot.frames.first);
    const choices = [["first", "镜头首帧"], ["middle", "镜头中间帧"], ...corrections.map(([key, item]) =>
      [key, `校正帧 · ${item.at.toFixed(2)} 秒${item.approved
        ? matchesFirst(adoptedPreview(item), first) ? " · 动作关键帧" : first ? " · 角色与首帧不同" : " · 等待首帧"
        : ""}`])];
    if (JSON.stringify(choices) !== options.dataset.choices) {
      options.replaceChildren(...choices.map(([key, label]) => new Option(label, key)));
      options.dataset.choices = JSON.stringify(choices);
    }
    options.value = frameKey;
    const isCorrection = Number.isInteger(frame.correction_tick);
    el("[data-capture-correction]").disabled = busy;
    el("[data-remove-correction]").hidden = !isCorrection;
    el("[data-remove-correction]").disabled = busy;
    const role = el("[data-role]");
    role.disabled = busy || !!session.mapping;
    if (session.mapping && role.value !== session.mapping.asset) {
      role.value = session.mapping.asset;
      fillViews();
    }
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
      previews.forEach((item, i) => select.append(new Option(`版本 ${i + 1} · ${!matchesPerson(item) ? "旧映射" : item.job === frame.approved ? "已采用" : item.ref ? "待审核" : item.state === "error" ? "失败" : "处理中"}`, item.job)));
      select.value = version.job;
      select.onchange = () => { versionId = select.value; renderPanel(); };
      review.append(select);
    }
    if (version?.ref) {
      if (version.job !== frame.approved) {
        review.append(button(isCorrection ? "用作动作关键帧" : "采用此预览", () => change("approve", {job:version.job}),
          busy || !inScope(shotIndex) || !matchesPerson(version)));
      } else {
        review.append(button("放入画布", () => insertPreview(version, frame, false), busy));
        if (frameKey === "first") review.append(button("用作视频首帧", () => insertPreview(version, frame, true), busy));
        if (isCorrection) review.append(button("取消动作关键帧", () => change("clear_guide"), busy));
      }
    }
    if (!shot.keep_original) review.append(button("保留这个原镜头", () => change("keep"), busy));
    el("[data-generate]").disabled = busy || !inScope(shotIndex) || !selectedArea || !role.value || !!latest && active(latest);
    el("[data-frame]").disabled = busy;
    renderVideo();
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
    const locked = busy || !!session.export && active(session.export);
    el('[data-cut="split_shot"]').disabled = locked || at <= start || at >= end;
    el('[data-cut="move_cut"]').disabled = locked || !shotIndex || at <= previous || at >= end || at === start;
    el('[data-cut="merge_shots"]').disabled = locked || !shotIndex;
    const undo = el('[data-cut="undo_cut"]');
    undo.hidden = !session.can_undo_cut;
    undo.disabled = locked;
    for (const button of panel.querySelectorAll("[data-step]")) button.disabled = locked;
  }

  function renderVideo() {
    const shot = currentShot();
    const videos = shot.videos || [];
    const latest = videos.at(-1);
    const selected = videos.find(v => v.job === videoId) || latest;
    const first = shot.frames.first;
    const approved = adoptedPreview(first);
    const firstApproved = !!approved && matchesPerson(approved);
    const guides = firstApproved ? Object.values(shot.frames).filter(frame => {
      return Number.isInteger(frame.correction_tick) && matchesFirst(adoptedPreview(frame), approved);
    }).length : 0;
    el(".rm-motion-hint").textContent = !inScope(shotIndex) ? "该镜头不在替换范围，合成时使用原片。" : firstApproved
      ? guides ? `本次将用本地 H3 按原片时间生成，采用 ${guides} 张动作关键帧。生成后请核对动作和口型。`
        : "可在校正帧添加动作关键帧。生成后请对照原片检查动作和口型。"
      : approved ? "首帧属于之前的人物映射，请为当前角色重新生成并采用。"
      : "先在「镜头首帧」中采用替换预览。";
    const input = el("[data-motion]");
    const motion = motionDrafts.get(shotKey()) ?? latest?.motion ?? "";
    if (input.value !== motion) input.value = motion;
    el("[data-generate-video]").disabled = busy || !inScope(shotIndex) || !firstApproved || videos.some(active);
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
      }, busy));
      if (source) {
        const compare = button(comparison ? "停止原声对照" : "原声对照播放", () => toggleComparison(shot, source), busy);
        compare.dataset.compare = "";
        review.append(compare);
      }
      if (source && (shot.adopted_video !== selected.job || shot.keep_original)) {
        review.append(button("采用此视频", () => change("approve_video", {job:selected.job}),
          busy || !inScope(shotIndex) || !matchesPerson(selected)));
      }
      if (source && selected.mode !== "local") {
        const count = Object.values(shot.frames).filter(f => Number.isInteger(f.correction_tick) && (personSelection(f) || f.protection)).length;
        const caption = count ? `跟踪人物并局部合成（${count} 张校正帧）` : "跟踪人物并局部合成";
        review.append(button(caption, () => change("localize", {job:selected.job}),
          busy || !inScope(shotIndex) || !matchesPerson(selected) || videos.some(active)));
      }
    }
    const exp = session.export;
    const exportButton = el("[data-export]");
    exportButton.hidden = !session.shots.some((s, i) => inScope(i) && !s.keep_original &&
      s.videos?.some(v => v.job === s.adopted_video && matchesPerson(v)));
    exportButton.disabled = busy || !!exp && active(exp);
    exportButton.textContent = exp && active(exp) ? "合成中…" : "合成并保留原声";
    const download = el("[data-download]");
    const watch = el("[data-watch]");
    download.hidden = !exp?.ref || !!exp.stale;
    watch.hidden = download.hidden;
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

  function insertPreview(version, frame, videoFirst) {
    if (boardId !== board || node(video.id) !== video) return status("原片所在画布已切换");
    checkpoint();
    const at = placeRight(video, "image");
    const image = addNode("image", at.x, at.y, {}, {name:`镜头 ${shotIndex + 1} · ${version.asset.name}`});
    image.versions.push({ref:version.ref, url:remakeMedia(version.ref), w:frame.w, h:frame.h, source:"edit", prompt:""});
    image.cur = 0;
    render(image);
    save();
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

  function schedulePoll() {
    clearTimeout(timer);
    if (!panel.isConnected || !session) return;
    const versions = session.shots.flatMap(shot => [...Object.values(shot.frames).flatMap(frame => frame.previews), ...(shot.videos || [])]);
    if (session.export) versions.push(session.export);
    const ids = versions.filter(active).map(item => item.job);
    if (!ids.length) return;
    timer = setTimeout(async () => {
      if (!panel.isConnected) return;
      if (!busy) {
        const pendingRevision = revision;
        try {
          const response = await fetch("/api/jobs?ids=" + encodeURIComponent(ids.join(",")));
          if (!response.ok) throw new Error("进度暂不可用，正在重连");
          await response.json();
          const result = await remakeRequest(url);
          if (revision === pendingRevision && !busy && panel.isConnected) { applySession(result); renderPanel(); }
        } catch (error) { status(error.message); }
      }
      schedulePoll();
    }, 1500);
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
    const cutAction = ["split_shot", "move_cut", "merge_shots", "undo_cut"].includes(action);
    status(cutAction ? "正在更新剪辑点…" : {analyze:"正在拆分与分析镜头…",select:"正在处理选区…",locate_person:"正在识别原片人物…",apply_person_hint:"正在按建议生成选区…",preview:"正在提交预览…",generate_video:"正在提交镜头生成…",localize:"正在提交局部合成…",export:"正在提交成片合成…"}[action] || "");
    try {
      applySession(await remakeRequest(url, {action, shot:shotIndex, frame:frameKey, cut_revision:session?.cut_revision ?? 0, ...extra}));
      if (action === "analyze") fillViews();
      if (action === "capture_correction" && session.captured_frame) {
        frameKey = session.captured_frame;
        versionId = null;
      }
      if (action === "remove_correction") {
        frameKey = "first";
        versionId = null;
      }
      if (action === "preview") versionId = null;
      if (action === "generate_video" || action === "localize") videoId = null;
      status(cutAction && session.mapping ? "剪辑点已更新，请核对人物映射范围。" : "");
    } catch (error) { status(error.message); }
    finally { busy = false; renderPanel(); schedulePoll(); }
  }

  el("[data-analyze]").onclick = () => change("analyze");
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
  el("[data-layer]").onchange = updateSelectionControls;
  el("[data-locate-person]").onclick = () => change(
    personHint() ? "apply_person_hint" : "locate_person", {person:session.mapping.source},
  );
  el("[data-clear-protection]").onclick = () => change("clear_protection");
  el("[data-role]").onchange = () => { fillViews(); renderPanel(); };
  el("[data-view]").onchange = event => {
    viewChoices.set(shotKey() + ":" + el("[data-role]").value, event.target.value);
  };
  el("[data-generate]").onclick = () => change("preview", {
    asset:el("[data-role]").value, view:el("[data-view]").value, note:el(".rm-note input").value,
  });
  el("[data-motion]").oninput = event => motionDrafts.set(shotKey(), event.target.value);
  el("[data-generate-video]").onclick = () => change("generate_video", {motion:el("[data-motion]").value});
  el("[data-export]").onclick = () => change("export");
  function personHint() {
    const hint = currentFrame()?.person_hint;
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
    let message = selection?.overlay ? `已标记${target}，可重新${mode === "box" ? "框选" : "点选"}` : instruction + target;
    if (protect && frame.protection?.mask === null) message = "从此帧停止保护，可重新标记前景";
    const locate = el("[data-locate-person]");
    locate.hidden = protect || !session.mapping || !inScope(shotIndex) || !!selection;
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
    if (busy || event.button !== 0) return;
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
    fillViews();
    busy = false;
    renderPanel();
    schedulePoll();
  } catch (error) { status(error.message); }
}
