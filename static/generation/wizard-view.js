"use strict";

const wizardShotNumbers = numbers => numbers.join(OneShotI18n.locale==="en"?", ":"、");

function jobText(n) {
  if (!n?.job) return "";
  const st = n.job.ids.map(i => n.job.st?.[i]).filter(Boolean), run = st.find(s => s.state === "running"), q = st.find(s => s.state === "queued");
  const eta = Math.max(...st.map(s => s.eta || 0), 0);
  const quality=(run||q)?.meta?.quality_review;
  if (quality) return videoQualityProgress(quality,run||q);
  if (run && run.max > 1 && run.value != null) return OneShotI18n.t("生成中 {percent}%",{percent:Math.round(run.value / run.max * 100)}) +
    (eta ? OneShotI18n.t(" · 还要约 {time}",{time:fmtT(eta)}) : "");
  if (run) return OneShotI18n.t("准备中…");
  if (q) return OneShotI18n.t("排队中") +
    (q.ahead ? OneShotI18n.t("（前面 {count} 个）",{count:q.ahead}) : "") +
    (eta ? OneShotI18n.t(" · 约 {time}后完成",{time:fmtT(eta)}) : "");
  return OneShotI18n.t("提交中…");
}
const verNav = n => n.versions.length > 1 ? `<span class="vn"><button data-v="prev" data-n="${n.id}">‹</button>${OneShotI18n.t("第 {current}/{total} 版",{current:n.cur+1,total:n.versions.length})}<button data-v="next" data-n="${n.id}">›</button></span>` : "";

// ① 想法
function stepIdea() {
  const precheck=wizardQualityEnabled();
  const chip = (k, v, label = v) => `<button class="chip ${String(k==="quality_precheck"?precheck:W[k]) === String(v) ? "on" : ""}" data-set="${k}" data-val="${v}">${OneShotI18n.t(label)}</button>`;
  return OneShotI18n.html`<div class="wz1">
    <h2>你想拍一个什么样的视频？</h2>
    <textarea id="wzIdea" rows="5" placeholder="用一两句话说说你的想法，例如：一只橘猫在雨夜给流浪狗送伞">${esc(W.idea)}</textarea>
    <div class="tpl"><span class="lab">没有灵感？试试这些：</span>${TEMPLATES.map((t, i) => `<button class="chip" data-tpl="${i}">${OneShotI18n.t(t.t)}</button>`).join("")}</div>
    ${SAMPLES.length ? OneShotI18n.html`<div class="gal"><span class="lab">看看做出来是什么样：</span><div class="gl">${sampleCards()}</div></div>` : ""}
    <div class="opts">
      <div><span class="lab">风格</span>${STYLES.map(s => chip("style", s)).join("")}</div>
      <div><span class="lab">时长</span>${chip("dur", 15, "15 秒")}${chip("dur", 30, "30 秒")}${chip("dur", 60, "1 分钟")}</div>
      <div><span class="lab">画幅</span>${chip("aspect", "16:9", "横屏 16:9")}${chip("aspect", "9:16", "竖屏 9:16")}</div>
      <div><span class="lab">画质</span>${chip("quality", "std", "快速 480P")}${chip("quality", "hd", "高清 768P")}</div>
      ${CAPS_LIST.video_quality_precheck || precheck ? OneShotI18n.html`<div><span class="lab">质量预检</span>${chip("quality_precheck",true,"先用 INT8 检查")}${chip("quality_precheck",false,"直接生成")}</div>` : ""}
      ${precheck ? OneShotI18n.html`<div class="est">每镜最多试生成五次，再用 BF16 生成一份定稿。</div>` : OneShotI18n.html`<div><span class="lab">每个镜头</span>${chip("takes",1,"出 1 个版本")}${chip("takes",2,"抽 2 个挑")}${chip("takes",3,"抽 3 个挑")}</div>`}
    </div>
    <div class="est">根据动作和台词决定镜头数。较长的段落会拆成多个镜头。</div>
    <div class="nav"><span></span><button class="go" data-go="script">写剧本 →</button></div></div>`;
}
// ② 剧本
function stepScript() {
  const s = wizScript(), d = s?.data;
  if (!s || toolBusy.has(s.id)) return OneShotI18n.html`<div class="wait"><div class="spin"></div>AI 正在写剧本、拆镜头…（GPU 空闲时约 10~30 秒）</div>`;
  if (!(d.shots || []).length) return OneShotI18n.html`<div class="wait">还没有剧本。<button class="go" data-go="script">重新生成</button><button class="ghost" data-goto="0">← 改一下想法</button></div>`;
  const total = d.shots.reduce((a, x) => a + (x.duration || 0), 0);
  return OneShotI18n.html`<div class="wz2">
    <div class="row"><input id="wzTitle" class="title" value="${esc(d.title)}" placeholder="片名"><span class="dim">${OneShotI18n.t("{count} 个镜头 · 约 {seconds} 秒",{count:d.shots.length,seconds:total})}</span>
      <span class="grow"></span><button class="ghost" data-go="script">不满意，重新写</button></div>
    <label class="sty">画面风格<input id="wzStyle" value="${esc(d.style)}"></label>
    <div class="shots">${d.shots.map((x, i) => OneShotI18n.html`<div class="sh" data-i="${i}">
        <div class="h"><b>${OneShotI18n.t("镜头 {number}",{number:i+1})}</b><select data-f="duration">${SCRIPT_VIDEO_DURATIONS.map(t => OneShotI18n.html`<option value="${t}" ${t === scriptVideoDuration(x.duration) ? "selected" : ""}>${OneShotI18n.t("{seconds} 秒",{seconds:t})}</option>`).join("")}</select>
          <input data-f="cam" value="${esc([x.shot_size, x.camera].filter(Boolean).join("，"))}" placeholder="景别和运镜，如：中景，缓慢推近">
          <span class="grow"></span><button class="ic" data-m="up" title="上移">↑</button><button class="ic" data-m="down" title="下移">↓</button><button class="ic" data-m="del" title="删除这个镜头">×</button></div>
        <label>首帧画面<textarea data-f="keyframe" rows="2">${esc(x.keyframe)}</textarea></label>
        ${motionFramePhases(x).map(phase=>`<label>${OneShotI18n.t(phase==="middle"?"中帧画面":"尾帧画面")}<textarea data-motion-frame="${phase}" rows="2">${esc(x.motion_frames[phase]||"")}</textarea></label>`).join("")}
        <label>动作<textarea data-f="action" rows="2" placeholder="一行一个动作，可写 0–0.5 秒 保持站姿">${esc(x.action.join("\n"))}</textarea></label>
        <label>台词<textarea data-f="dialogue" rows="1" placeholder="名字：台词（没有可以空着）">${esc(x.dialogue.join("\n"))}</textarea></label></div>`).join("")}
      <button class="add" data-m="add">＋ 加一个镜头</button></div>
    <div class="nav"><button class="ghost" data-goto="0">← 想法</button><button class="go" data-goto="2">下一步：制作素材 →</button></div></div>`;
}
// ③ 角色
function stepCast() {
  const script=wizScript(), chars=script.data.characters||[], busy=wizardAssetRuns.has(script);
  return OneShotI18n.html`<div class="wz3"><p class="tip">先准备角色、场景和道具。缺少的素材会生成并存入库，分镜只引用所需素材的选定版本。</p>
    <div class="cast">${chars.map((c, i) => {
      const m = castOf(c.name), busy = m && (m.job || toolBusy.has(m.id));
      return OneShotI18n.html`<div class="cc" data-i="${i}"><div class="pics">${m && m.versions.length ? m.versions.map((v, k) => OneShotI18n.html`<img src="${v.url}" class="${k === m.cur ? "on" : ""}" data-pick="${k}" data-n="${m.id}" title="点击选用这张">`).join("") : ""}
          ${busy ? OneShotI18n.html`<div class="pend"><div class="spin"></div>${jobText(m) || OneShotI18n.t("处理中…")}</div>` : ""}${!m || (!m.versions.length && !busy) ? OneShotI18n.html`<div class="pend">还没有形象图</div>` : ""}</div>
        <div class="info"><input class="nm" data-c="name" value="${esc(c.name)}" title="角色名（改名会同步到剧本）">
          <label>外貌<textarea data-c="look" rows="3">${esc(c.look)}</textarea></label>
          <label>声音<input data-c="voice" value="${esc(c.voice || "")}" placeholder="例如：清亮少女音，语速轻快"></label>
          <div class="vh">${VOICES_HINT.map(v => `<button class="chip sm" data-voice="${v}">${OneShotI18n.t(v)}</button>`).join("")}</div>
          <div class="btns"><button class="go sm" data-cast="gen">${OneShotI18n.t(m && m.versions.length ? "再画 2 张" : "画 2 张定妆照")}</button>
            <button class="ghost sm" data-cast="lib">从资产库选</button><button class="ghost sm" data-cast="up">上传图片</button></div></div></div>`;
    }).join("")}${wizardAssetCards(script)}</div>
    <div id="wzLib"></div>
    <div class="nav"><button class="ghost" data-goto="1">← 剧本</button><button class="go" data-go="boards" ${busy?"disabled":""}>${OneShotI18n.t(busy?"正在准备素材…":"准备素材并生成分镜 →")}</button></div></div>`;
}
// ④ 分镜图
function stepBoards() {
  const pairs = shotPairs(), d = wizScript().data;
  const cards=pairs.flatMap(p=>wizardShotFrames(p).map(frame=>({...frame,pair:p})));
  const images=[...new Set(cards.map(frame=>frame.node))];
  const ready=images.filter(storyboardFrameReady).length;
  const missing=pairs.length!==d.shots.length||pairs.some(p=>missingMotionFrames(d.shots[p.index],p.record));
  return OneShotI18n.html`<div class="wz4"><p class="tip">核对每镜的构图和动作姿态。${missing ? OneShotI18n.t("有镜头还未准备分镜") : ready < images.length ?
    OneShotI18n.t("已完成 {ready}/{total} 张",{ready,total:images.length}) : OneShotI18n.t("画面已就绪")}</p>
    <div class="grid ${d.aspect === "9:16" ? "tall" : ""}">${cards.map(({node:image,phase,label,pair}) => {
      const v=curV(image), busy=image.job, shot=d.shots[pair.index];
      const shared=phase==="first"&&pair.record.shared_first;
      const middle=phase==="middle"&&wizardMiddleTiming(pair);
      return OneShotI18n.html`<div class="bc"><div class="pic">${v ? OneShotI18n.html`<img src="${esc(v.url)}">` : ""}${busy ? OneShotI18n.html`<div class="pend"><div class="spin"></div>${jobText(image)}</div>` : !v ? OneShotI18n.html`<div class="pend">等待生成</div>` : ""}</div>
        <div class="cap"><b>${OneShotI18n.t("镜头 {number}",{number:pair.index+1})} · ${middle?OneShotI18n.t("中帧"):label}</b>${shared?"":verNav(image)}</div><div class="txt">${esc(shared?image.data.caption : phase==="first"?shot.keyframe:shot.motion_frames?.[phase]||image.data.caption)}</div>
        ${middle?OneShotI18n.html`<label class="wz-frame-time">时点 <input type="number" step="any" min="0.04" max="${(middle.maxFrame/24).toFixed(2)}" value="${Number(middle.time.toFixed(2))}" data-middle-time="${pair.index}" aria-label="${OneShotI18n.t("镜头 {number} 中帧时点（秒）",{number:pair.index+1})}" ${middle.editable?"":"disabled"}> ${OneShotI18n.t("秒")}</label>`:""}
        ${v&&!storyboardFrameReady(image)?OneShotI18n.html`<p class="wz-shot-error" role="status">分镜描述已更新，请重新生成画面。</p>`:""}
        ${shared?"":OneShotI18n.html`<div class="fix"><input placeholder="怎么改？例如：人物离镜头近一点" data-fix="${image.id}"><button class="ghost sm" data-redo="${image.id}" ${busy?"disabled":""}>${OneShotI18n.t(v ? "重画" : "生成")}</button></div>`}</div>`;
    }).join("")}</div>
    <div class="nav"><button class="ghost" data-goto="2">← 制作素材</button>
      ${missing||ready<images.length?OneShotI18n.html`<button class="ghost" data-go="fill-frames">补齐关键帧</button>`:""}
      <button class="go" data-go="videos" ${missing||ready<images.length ? "disabled" : ""}>下一步：生成视频 →</button></div></div>`;
}
// ⑤ 视频
function stepVideos() {
  const pairs = shotPairs(), d = wizScript().data, done = pairs.filter(p => storyboardVersionReady(p.vid)).length, busy = pairs.filter(p => p.vid.job).length;
  const missing = wizardMissingVideos(wizScript());
  const unexpanded = pairs.length < d.shots.length;
  return OneShotI18n.html`<div class="wz5"><p class="tip">${busy ? OneShotI18n.t("正在生成 {count} 个镜头，",{count:busy}) + '<span id="wzEta"></span>' +
      OneShotI18n.t("可以关掉网页，回来接着看。") : missing.length ?
      OneShotI18n.t("镜头 {numbers} 还缺少视频。",{numbers:wizardShotNumbers(missing)}) :
      OneShotI18n.t("全部生成好了。有多个版本的镜头，用 ‹ › 挑出最好的一版。")}</p>
    <div class="grid ${d.aspect === "9:16" ? "tall" : ""}">${pairs.map(p => {
      const i=p.index;
      const v = curV(p.vid), s = d.shots[i] || {}, error=canvasGenerationError(p.vid);
      return OneShotI18n.html`<div class="bc"><div class="pic">${v ? `<video src="${v.url}" controls playsinline preload="metadata"></video>` : curV(p.img) ? OneShotI18n.html`<img src="${curV(p.img).url}" class="dimg">` : ""}
          ${p.vid.job ? OneShotI18n.html`<div class="pend"><div class="spin"></div>${jobText(p.vid)}</div>` : ""}</div>
        <div class="cap"><b>${OneShotI18n.t("镜头 {number}",{number:i+1})}</b>${verNav(p.vid)}<span class="grow"></span>
          ${p.record.shared_first&&curV(node(scriptShotLinks(wizScript())[i-1]?.vid))?OneShotI18n.html`<button class="ghost sm" data-motion-tail="${i}" ${p.vid.job||scriptContinuityPending.has(p.vid)?"disabled":""}>接上一镜成片尾帧</button>`:""}
          <button class="ghost sm" data-vredo="${p.vid.id}" ${p.vid.job ? "disabled" : ""}>${OneShotI18n.t(v ? storyboardVersionReady(p.vid)?"再抽一个":"按新剧本生成" : "生成")}</button></div>
        <div class="txt">${esc((s.dialogue || []).join(" ") || (s.action || []).join("，"))}</div>
        ${error?`<p class="wz-shot-error" role="status">${esc(error)}</p>`:""}</div>`;
    }).join("")}</div>
    <div class="nav"><button class="ghost" data-goto="3">← 分镜图</button>${unexpanded && missing.length ? OneShotI18n.html`<button class="ghost" data-go="repair-shots">补齐镜头节点</button>` : ""}
      ${done < pairs.length && !busy ? OneShotI18n.html`<button class="go" data-go="genvids">${OneShotI18n.t("开始生成（{count} 个镜头）",{count:pairs.length-done})}</button>` : ""}
      <button class="go" data-goto="5" ${missing.length ? "disabled" : ""}>下一步：成片 →</button></div></div>`;
}
// ⑥ 成片
function stepFilm() {
  const script = wizScript(), f = wizardFilm(script), v = f && curV(f);
  const missing = wizardMissingVideos(script);
  return OneShotI18n.html`<div class="wz6">${f ? (f.job ? OneShotI18n.html`<div class="wait"><div class="spin"></div>正在合成成片… ${jobText(f)}</div>` : v ? OneShotI18n.html`<video src="${v.url}" controls playsinline class="final"></video>
      <div class="row"><a class="go" href="${v.url}" download="${esc((wizScript()?.data.title || OneShotI18n.t("成片")).replace(/[\\/:*?"<>|]/g, ""))}.mp4">下载成片</a>${v.cover_url ? OneShotI18n.html`<a class="ghost" href="${v.cover_url}" download>下载封面</a>` : ""}
        <button class="ghost" data-go="edit">继续剪辑</button>${!missing.length ? OneShotI18n.html`<button class="ghost" data-go="current-cut">用当前镜头剪辑</button>` : ""}
        <button class="ghost" data-go="canvas">去画布精修</button></div>` : OneShotI18n.html`<div class="wait">上次合成没有成功。<button class="go" data-go="edit">重新打开剪辑台</button></div>`)
    : missing.length ? OneShotI18n.html`<p class="tip" role="status">${OneShotI18n.t("镜头 {numbers} 还缺少视频。补齐后可导出完整成片。",{numbers:wizardShotNumbers(missing)})}</p>`
    : OneShotI18n.html`<p class="tip">在剪辑台里调整顺序、裁剪片段、加字幕和背景音乐。台词会自动作为字幕带入。</p>
       <div class="row"><button class="go" data-go="edit">打开剪辑台</button><button class="ghost" data-go="quick">导出成片</button></div>`}
    <div class="nav"><button class="ghost" data-goto="4">← 视频</button><span></span></div></div>`;
}
