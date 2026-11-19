"use strict";

const RM_VIEW_NAMES = {main:"标准主图", face:"正面头肩", side:"侧面", back:"背面", detail:"固定细节"};

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
  panel.innerHTML = `<header class="rm-heading"><div><h2 id="rmTitle">视频重制 · 替换角色</h2><span>${esc(video.name)} · 单帧预览</span></div><button type="button" data-close>返回画布</button></header>
    <div class="rm-body">
      <section class="rm-source"><video controls preload="metadata" playsinline></video>
        <div class="rm-actions"><button type="button" data-analyze>分析原片</button><span class="rm-analysis"></span></div>
        <nav class="rm-shots" aria-label="原片镜头"></nav>
      </section>
      <section class="rm-editor" hidden>
        <div class="rm-actions"><strong class="rm-shot"></strong><select data-frame aria-label="选取原片画面"><option value="first">镜头首帧</option><option value="middle">镜头中间帧</option></select></div>
        <p class="rm-summary"></p>
        <div class="rm-actions">
          <button type="button" data-mode="point" aria-pressed="true">点选人物</button>
          <button type="button" data-mode="box" aria-pressed="false">框选区域</button>
          <span class="rm-selection-status">在原画面中点选要替换的人物</span>
        </div>
        <div class="rm-stage">
          <div class="rm-frame"><span>原画面</span><div class="rm-surface"><img class="rm-original" alt="原片画面"><img class="rm-mask" alt="" hidden></div></div>
          <div class="rm-frame"><span>替换预览</span><div class="rm-output">生成后显示在这里</div></div>
        </div>
        <div class="rm-actions rm-role">
          <label>替换为<select data-role aria-label="资产库角色"></select></label>
          <label>参考角度<select data-view aria-label="参考角度"></select></label>
          <label class="rm-note">本镜头要求<input maxlength="800" placeholder="例如保留挡在人物前面的桌沿"></label>
          <button type="button" data-generate>生成预览</button>
        </div>
        <div class="rm-actions rm-review" aria-label="预览版本与审核"></div>
      </section>
    </div><div class="rm-status" role="status"></div>`;
  document.body.append(panel);
  panel.showModal ? panel.showModal() : panel.setAttribute("open", "");
  const el = selector => panel.querySelector(selector);
  const player = el("video");
  player.src = remakeMedia(source.ref);
  let session = null, assets = [], shotIndex = 0, frameKey = "first", mode = "point", versionId = null;
  let busy = true, dragStart = null, timer = null, revision = 0;
  const status = message => { el(".rm-status").textContent = message; };
  const currentShot = () => session?.shots[shotIndex];
  const currentFrame = () => currentShot()?.frames[frameKey];
  function close() {
    clearTimeout(timer);
    if (!player.paused) player.pause();
    panel.remove();
  }
  el("[data-close]").onclick = close;
  panel.addEventListener("cancel", event => { event.preventDefault(); close(); });
  panel.addEventListener("keydown", event => event.stopPropagation());
  panel.addEventListener("pointerdown", event => event.stopPropagation());
  const active = p => !["done","error"].includes(p.state);

  function fillViews(value) {
    const asset = assets.find(item => item.id === el("[data-role]").value);
    const views = el("[data-view]");
    views.replaceChildren();
    for (const [view, label] of Object.entries(RM_VIEW_NAMES)) {
      if (view === "main" || asset?.character_views?.[view]) views.append(new Option(label, view));
    }
    if ([...views.options].some(option => option.value === value)) views.value = value;
  }

  function renderPanel() {
    if (!panel.isConnected) return;
    const shots = session?.shots || [];
    el("[data-analyze]").hidden = !!shots.length;
    el("[data-analyze]").disabled = busy;
    el(".rm-analysis").textContent = session?.warning || (shots.length ? `${shots.length} 个镜头` : "支持 60 秒以内的视频");
    el(".rm-editor").hidden = !shots.length;
    if (!shots.length) return;
    const shot = currentShot(), frame = currentFrame();
    const shotList = el(".rm-shots");
    shotList.replaceChildren(...shots.map((item, i) => {
      const card = document.createElement("button");
      card.type = "button";
      card.setAttribute("aria-pressed", String(i === shotIndex));
      const completed = Object.values(item.frames).some(f => f.approved);
      card.textContent = `镜头 ${i + 1} · ${item.start.toFixed(1)}–${item.end.toFixed(1)} 秒` +
        (item.keep_original ? " · 保留原片" : completed ? " · 已采用预览" : "");
      card.onclick = () => {
        if (busy) return;
        shotIndex = i;
        versionId = null;
        player.currentTime = item.start;
        renderPanel();
      };
      return card;
    }));
    el(".rm-shot").textContent = `镜头 ${shotIndex + 1}`;
    const summary = shot.summary || {};
    el(".rm-summary").textContent = [summary.shot_size, summary.camera, ...(Array.isArray(summary.action) ? summary.action : [])].filter(Boolean).join(" · ");
    const original = el(".rm-original"), selection = el(".rm-mask");
    const originalUrl = remakeMedia(frame.ref);
    if (original.getAttribute("src") !== originalUrl) original.src = originalUrl;
    selection.hidden = !frame.selection;
    if (frame.selection) selection.src = remakeMedia(frame.selection.overlay);
    el(".rm-selection-status").textContent = frame.selection ? "已选区域，可重新点选或框选" : "在原画面中选择要替换的人物";
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
      output.textContent = version?.error || (version ? version.state === "running" ? "正在生成…" : "等待生成…" : "生成后显示在这里");
    }
    const review = el(".rm-review");
    review.replaceChildren();
    if (previews.length) {
      const select = document.createElement("select");
      select.setAttribute("aria-label", "预览版本");
      previews.forEach((item, i) => select.append(new Option(`版本 ${i + 1} · ${item.job === frame.approved ? "已采用" : item.ref ? "待审核" : item.state === "error" ? "失败" : "处理中"}`, item.job)));
      select.value = version.job;
      select.onchange = () => { versionId = select.value; renderPanel(); };
      review.append(select);
    }
    if (version?.ref) {
      if (version.job !== frame.approved || shot.keep_original) {
        review.append(button("采用此预览", () => change("approve", {job:version.job}), busy));
      } else {
        review.append(button("放入画布", () => insertPreview(version, frame, false), busy));
        if (frameKey === "first") review.append(button("用作视频首帧", () => insertPreview(version, frame, true), busy));
      }
    }
    if (!shot.keep_original) review.append(button("保留这个原镜头", () => change("keep"), busy));
    el("[data-generate]").disabled = busy || !frame.selection || !el("[data-role]").value || !!latest && active(latest);
    el("[data-frame]").disabled = busy;
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
    const ids = session.shots.flatMap(shot => Object.values(shot.frames))
      .flatMap(frame => frame.previews.filter(active).map(item => item.job));
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
          if (revision === pendingRevision && !busy && panel.isConnected) { session = result; renderPanel(); }
        } catch (error) { status(error.message); }
      }
      schedulePoll();
    }, 1500);
  }

  async function change(action, extra={}) {
    if (busy) return;
    revision++;
    busy = true;
    renderPanel();
    status({analyze:"正在拆分与分析镜头…",select:"正在处理选区…",preview:"正在提交预览…"}[action] || "");
    try {
      session = await remakeRequest(url, {action, shot:shotIndex, frame:frameKey, ...extra});
      if (action === "preview") versionId = null;
      status("");
    } catch (error) { status(error.message); }
    finally { busy = false; renderPanel(); schedulePoll(); }
  }

  el("[data-analyze]").onclick = () => change("analyze");
  el("[data-frame]").onchange = event => { frameKey = event.target.value; versionId = null; renderPanel(); };
  el("[data-role]").onchange = () => { fillViews("main"); renderPanel(); };
  el("[data-generate]").onclick = () => change("preview", {
    asset:el("[data-role]").value, view:el("[data-view]").value, note:el(".rm-note input").value,
  });
  for (const control of panel.querySelectorAll("[data-mode]")) {
    control.onclick = () => {
      mode = control.dataset.mode;
      for (const item of panel.querySelectorAll("[data-mode]")) item.setAttribute("aria-pressed", String(item === control));
      el(".rm-selection-status").textContent = mode === "box" ? "在原画面中拖出人物范围" : "在原画面中点选人物";
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
    change("select", selection);
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
    fillViews(session?.role?.view);
    busy = false;
    renderPanel();
    schedulePoll();
  } catch (error) { status(error.message); }
}
