"use strict";

function showPanel() {
  hideNodeToolTip();
  ctRenderSelectionTools();
  const tools = $("#ntools");
  const tr=OneShotI18n.t;
  if (sel.size !== 1) { placeOverlays(); return; }
  const n = node([...sel][0]); if (!n) return;
  const v = curV(n);
  // ---- toolbar
  const b = [];
  const tool = (action, icon, label, hint = label) => `<button type="button" data-a="${action}" aria-label="${esc(OneShotI18n.t(label))}" data-tip="${esc(OneShotI18n.t(hint))}">${ico(icon)}</button>`;
  if (n.type === "text") b.push(tool("text-document", "script", canvasCanEdit() ? "编辑文档" : "查看文档"));
  if (n.type === "text" && n.data.transcript?.cues?.length && canvasCanEdit()) b.push(tool("saved-transcript", "scissors", "按台词剪辑音频"));
  if (n.data.previs) b.push(tool("previs", "video", "编辑白模"));
  if (pvGuideAvailable(v)) b.push(tool("previsvideo", "next", "用作动作参考"));
  if (n.type === "audio") b.push(tool("audio-upload","upload","上传音频版本"));
  if (n.type === "audio" && v?.ref && canvasCanEdit()) b.push(tool("transcript","text","音频转写"));
  if (["video","audio"].includes(n.type) && v?.ref && canvasCanEdit()) b.push(tool("separate-audio","audio","人声分离"));
  if (n.data.playlist) b.push(tool("playlist-open","stack","打开播放列表"));
  if (!n.job && canvasCanEdit() && draftFinalEdge(n)) b.push(tool("draft-final","hd","重试定稿"));
  if (n.versions.length > 1) b.push(tool("prev", "left", "上一个版本") + `<span class="pg">${n.cur + 1}/${n.versions.length}</span>` + tool("next", "right", "下一个版本") + `<span class="sep"></span>`);
  if (v) {
    if (n.type === "image") b.push(tool("edit", "edit", "编辑图片", "编辑图片 · 局部重绘、扩图、裁剪与调色") + tool("tovideo", "video", "生成视频") + tool("hd", "hd", "高清重绘") + tool("describe", "text", "反推提示词"));
    if (n.type==="image" && v.image_grid && canvasCanEdit()) b.push(tool("split3x3","assets","拆成九张机位图"));
    if (n.type==="image" && panoramaVersion(v)) b.push(tool("panorama","panorama","360° 全景预览"));
    if (n.type === "video" && n.data.film && !n.data.playlist) b.push(tool("film", "scissors", "编辑成片"));
    else if (n.type === "video" && !n.data.film) b.push(tool("cont", "next", "续拍") + tool("film", "scissors", "剪辑视频", "剪辑视频 · 导出为原节点的新版本") + tool("analyze", "script", "拉片", "拉片 · 拆分镜头并分析"));
    if (n.type === "video" && canvasCanEdit()) b.push(tool("capture", "image", "视频截帧", "截取首帧、当前帧或末帧") + tool("trim-video", "scissors", "裁剪视频", "裁剪视频 · 保留区间、手动分割或智能切镜头"));
    if (n.type==="video" && v.draft_expires && canvasCanEdit()) b.push(tool("draft-final","hd","生成定稿"));
    if (draftVideoComparison(n,v)) b.push(tool("compare-draft","fit","对比样片与定稿"));
    if (n.type === "video" && n.versions.filter(v=>v.url).length > 1) b.push(tool("compare-video", "stack", "对比视频版本"));
    if (canvasCanEdit() && v.ref && ["image","video"].includes(n.type)) b.push(tool("broll","motion","B-roll 动态画面"));
    b.push(tool("full", "full", "全屏查看"));
    b.push(tool("dl", "dl", "下载"));
    if (v.ref && ["image","video","audio"].includes(n.type)) b.push(tool("favorite", "star", "收藏此版本"));
  }
  b.push(tool("agent", "script", "交给创作助手") + tool("dup", "copy", "创建副本") +
    (nodeLocked(n) ? tool("unlock-node", "lock", "解锁节点") : tool("del", "trash", "删除节点")) +
    (canvasCanEdit() ? tool("pin", "tag", "颜色标记") : "") + tool("more", "more", "更多操作"));
  tools.innerHTML = b.join("");
  $$("button", tools).forEach(x => {
    x.onmouseenter = x.onfocus = () => showNodeToolTip(x);
    x.onmouseleave = x.onblur = hideNodeToolTip;
    if (x.dataset.a === "favorite") nodeMediaFavorite(x,n,v);
    else x.onclick = ev => {
      hideNodeToolTip();
      if (x.dataset.a === "pin") return openNodePinMenu(x);
      if (x.dataset.a !== "more") return nodeAction(n, x.dataset.a);
      ev.stopPropagation();
      const rect = x.getBoundingClientRect();
      ctxMenu({ target: els.get(n.id), clientX: rect.left, clientY: rect.bottom + 6 });
    };
  });
  if (n.type === "audio") { renderAudioPanel(n); placeOverlays(); return; }
  if (n.type === "text" || n.data.previs) { placeOverlays(); return; }
  // ---- refs
  const refs = $("#refs"), items = [];
  const videoPlan = n.type === "video" ? plan(n) : null;
  const pictures = videoPlan?.inputs || (n.type === "image" ? imageInputs(n) : []);
  const canRemoveImage = () => canvasCanEdit() && !nodeLocked(n) && !n.job &&
    !prepping.has(n.id) && !toolBusy.has(n.id);
  const disableRemove = !canRemoveImage();
  const guide = n.type === "video" ? previsInput(n) : null;
  const sounds = n.type === "video" ? audioInputs(n) : [];
  const clips = n.type === "video" ? videoInputs(n) : [];
  const extension = clips[0]?.edge.extension;
  const segment = clips[0]?.edge.segment_edit;
  const reference = guide || sounds.length || clips.length;
  if (n.type === "script") imgInputs(n).forEach(m => { const mv = curV(m); items.push(`<span class="ref" title="${esc(m.name)}">${mv ? `<img src="${mv.url}">` : `<span class="tx">${ico("image")}</span>`}${esc(m.name)}<span class="role">${KIND_CN[m.data.asset?.kind] || "参考"}</span></span>`); });
  if (n.type === "image") {
    pictures.forEach((input,i)=>items.push(imagePromptChip(input,i,imageReferenceSelect(n,input.edge,i),disableRemove)));
    const composition=previsComposition(n);
    if(composition){
      const label=composition.enabled?"使用中":"已关闭";
      const picture=composition.version ? `<img src="/media?ref=${encodeURIComponent(composition.ref)}" alt="">` : "";
      const button=canvasCanEdit()&&!nodeLocked(n) ? OneShotI18n.html`<button type="button" data-previs-composition aria-label="使用白模构图参考" aria-pressed="${composition.enabled}">${composition.enabled?"关闭":"启用"}</button>` : "";
      items.push(OneShotI18n.html`<span class="ref">${picture}白模构图<span class="role">${composition.version?label:composition.enabled?"版本已移除":label}</span>${button}</span>`);
    }
  }
  if (n.type === "video") {
    const p = videoPlan;
    if (!n.data.replay_memory_ref) inheritedVideoAssets(n).forEach(asset=>{
      const name = asset.name || "资产";
      items.push(OneShotI18n.html`<span class="ref"><span class="tx">${ico("assets")}</span>${esc(name)}<span class="role">沿用资产</span>
        ${canvasCanEdit() ? OneShotI18n.html`<button type="button" data-memory-ignore="${esc(asset.id)}" aria-label="${esc(OneShotI18n.t("取消沿用 {name}",{name}))}" title="取消沿用此资产">×</button>` : ""}</span>`);
    });
    if (guide) {
      const latest = curV(guide.source);
      const update = pvGuideAvailable(latest) && latest.ref !== guide.edge.ref;
      const span=guide.version?.previs_span;
      items.push(OneShotI18n.html`<span class="ref" data-tok="@视频${extension||segment?2:1}" title="${esc(guide.source?.name || "白模预演")}"><span class="tx">${ico("video")}</span>白模动作参考<span class="role">${guide.version ? `版本 ${guide.index + 1}${Array.isArray(span)?" · "+pvSpanLabel(span):""}` : "版本已移除"}</span>${update ? '<button type="button" data-previs-update>改用当前版本</button>' : ""}</span>`);
    }
    clips.forEach(({edge,source,version,index},i)=>{
      const number=promptVideoIndex(i,guide,extension||segment);
      const {start,end:finish}=videoReferenceRange(edge,version,referenceDuration(n));
      const settings=version ? `<label>${tr("入")} <input class="tsec" type="number" min="0" step=".01" value="${start ?? ""}" data-clip-index="${i}" data-clip-point="start" aria-label="${tr("视频 {number} 入点（秒）",{number})}" ${edge.extension==="before"?"disabled":""}></label>
        <label>${tr("出")} <input class="tsec" type="number" min="0" step=".01" value="${finish ?? ""}" data-clip-index="${i}" data-clip-point="end" aria-label="${tr("视频 {number} 出点（秒）",{number})}" ${edge.extension==="after"?"disabled":""}></label>` : "";
      const change=curV(source) && curV(source)!==version;
      const role=version ? [edge.segment_edit?tr("待修改片段"):edge.extension?tr(extensionLabel(edge.extension)):"",
        tr("视频 {number}",{number}),tr("版本 {number}",{number:index+1})].filter(Boolean).join(" · ") : tr("版本已移除");
      const name=esc(source?.name || tr("视频参考"));
      items.push(`<span class="ref" data-tok="${promptMediaToken("video",edge.prompt_slot,number)}" title="${name}"><span class="tx">${ico("video")}</span>${name}<span class="role">${role}</span>${settings}${change ? `<button type="button" data-video-update="${i}">${tr("改用当前版本")}</button>` : ""}</span>`);
    });
    sounds.forEach(({edge,source,version,index},i)=>{
      const change = curV(source) && curV(source) !== version;
      const settings=version ? ["start","end"].map((point,j)=>`<label>${tr(j?"出":"入")} <input class="tsec" type="number"
        min="0" step=".01" value="${Number.isFinite(edge[point])?edge[point]:""}"
        placeholder="${j?esc(version.seconds||tr("结尾")):"0"}"
        data-audio-index="${i}" data-audio-point="${point}" aria-label="${tr(j?"音频 {number} 出点（秒）":"音频 {number} 入点（秒）",{number:i+1})}"></label>`).join("") : "";
      const name=esc(source?.name || tr("音频参考"));
      const role=version ? tr("音频 {number}",{number:i+1})+" · "+tr("版本 {number}",{number:index+1}) : tr("版本已移除");
      items.push(`<span class="ref" data-tok="${promptMediaToken("audio",edge.prompt_slot,i+1)}" title="${name}"><span class="tx">${ico("audio")}</span>${name}<span class="role">${role}</span>${settings}${change ? `<button type="button" data-audio-update="${i}">${tr("改用当前版本")}</button>` : ""}</span>`);
    });
    p.inputs.forEach((input, i) => { const r = p.roles[i];
      // keyframes get a seconds box: where in the video this picture should be reached
      const tbox = p.useRef && r !== "subject" && r !== "first" && r !== "last" && p.times[i] != null
        ? OneShotI18n.html`<input class="tsec" type="number" min="0" max="${p.end.toFixed(1)}" step="0.1" value="${(+p.times[i]).toFixed(1)}" data-time="${B.edges.indexOf(p.es[i])}" title="第几秒到达这张图">s` : "";
      const label = `<span class="role rsel">${OneShotI18n.t(p.labels[i])} ▾${roleSelect(p.es[i])}</span>`;
      items.push(imagePromptChip(input,i,label+tbox,disableRemove)); });
  }
  inputs(n, "text").forEach(t => items.push(OneShotI18n.html`<span class="ref" title="${esc(t.data.text.slice(0, 200))}"><span class="tx">${ico("text")}</span>${esc(t.name)}<span class="role">已并入</span></span>`));
  if (n.data.replay_memory_ref) items.push(OneShotI18n.html`<span class="ref"><span class="tx">${ico("assets")}</span>沿用原资产
    <button type="button" data-replay-assets-clear aria-label="取消沿用原资产" title="取消沿用原资产" ${n.job||nodeLocked(n)||!canvasCanEdit()?"disabled":""}>×</button></span>`);
  refs.innerHTML = items.join(""); refs.style.display = items.length ? "" : "none";
  $$("[data-image-remove]",refs).forEach(button=>{
    const {edge}=pictures[Number(button.dataset.imageRemove)];
    button.onclick=()=>{
      if (node(n.id)===n && canRemoveImage()) cutEdge(edge);
    };
  });
  const replayClear=$("[data-replay-assets-clear]",refs);
  if (replayClear) replayClear.onclick=()=>{
    if (!canvasCanEdit() || nodeLocked(n) || n.job || prepping.has(n.id)) return;
    checkpoint(); delete n.data.replay_memory_ref; save(); showPanel();
  };
  const compositionButton=$("[data-previs-composition]",refs);
  if(compositionButton)compositionButton.onclick=()=>{
    if(!canvasCanEdit()||nodeLocked(n)||n.job||prepping.has(n.id))return;
    const composition=previsComposition(n);
    if(!composition)return;
    checkpoint();
    n.data.previs_composition.enabled=!composition.enabled;
    save();showPanel();
  };
  $$("[data-memory-ignore]",refs).forEach(button=>button.onclick=()=>{
    if(!canvasCanEdit()||n.job||prepping.has(n.id))return;
    checkpoint(); rememberVideoVersion(n);
    const ignored = Array.isArray(n.data.ignored_memory_ids) ? n.data.ignored_memory_ids : [];
    n.data.ignored_memory_ids = [...ignored,button.dataset.memoryIgnore];
    save(); showPanel();
  });
  $$(".ref[data-tok]", refs).forEach(r => r.onclick = e => { if (!e.target.closest("button, select, input, label")) insertTok(r.dataset.tok); });
  $$("[data-image-use]", refs).forEach(select=>select.onchange=()=>{
    if (!canvasCanEdit() || nodeLocked(n) || n.job || prepping.has(n.id)) return;
    const input=imageInputs(n)[Number(select.dataset.imageUse)];
    if (!input) return;
    checkpoint();
    input.edge.image_use=select.value;
    save();
  });
  $$("[data-image-update]",refs).forEach(button=>button.onclick=()=>{
    if(!canvasCanEdit()||n.job||prepping.has(n.id))return;
    const input=imageInputs(n)[Number(button.dataset.imageUpdate)], latest=curV(input?.source);
    if(latest?.ref && latest.ref!==input.edge.ref){
      checkpoint();rememberVideoVersion(n);input.edge.ref=latest.ref;refresh(n);save();
    }
  });
  const guideUpdate = $("[data-previs-update]", refs);
  if (guideUpdate) guideUpdate.onclick = () => updatePrevisInput(n);
  $$("[data-audio-update]",refs).forEach(button=>button.onclick=()=>{
    if (!canvasCanEdit() || n.job || prepping.has(n.id)) return;
    const input=audioInputs(n)[Number(button.dataset.audioUpdate)], picked=curV(input?.source);
    if (!picked || picked.ref===input.edge.ref) return;
    checkpoint(); rememberVideoVersion(n); input.edge.ref=picked.ref;
    delete input.edge.start; delete input.edge.end; save(); refresh(n);
  });
  $$("[data-video-update]",refs).forEach(button=>button.onclick=()=>{
    if (!canvasCanEdit() || n.job || prepping.has(n.id)) return;
    const input=videoInputs(n)[Number(button.dataset.videoUpdate)], picked=curV(input?.source);
    if (!picked || picked.ref===input.edge.ref) return;
    if (input.edge.segment_edit && picked.seconds>0 && picked.seconds<4) return toast("当前版本短于 4 秒，无法作为片段编辑来源");
    checkpoint(); rememberVideoVersion(n); input.edge.ref=picked.ref;
    if (!input.edge.segment_edit) {delete input.edge.start; delete input.edge.end;}
    else if (picked.seconds>0) {
      input.edge.start=Math.min(input.edge.start??0,Math.max(0,picked.seconds-4));
      input.edge.end=Math.min(picked.seconds,Math.max(input.edge.start+4,input.edge.end??input.edge.start+4));
    }
    save(); refresh(n);
  });
  $$("[data-clip-point],[data-audio-point]",refs).forEach(input=>input.onchange=()=>{
    if (!canvasCanEdit() || n.job || prepping.has(n.id)) {showPanel();return;}
    const audio=!!input.dataset.audioPoint, point=audio?input.dataset.audioPoint:input.dataset.clipPoint;
    const clip=audio?audioInputs(n)[Number(input.dataset.audioIndex)]:videoInputs(n)[Number(input.dataset.clipIndex)];
    const value=input.valueAsNumber;
    if (!clip) return;
    if (input.value!=="" && (!Number.isFinite(value) || value<0 || value>(clip.version?.seconds || Infinity))) {
      toast("参考入点与出点须在素材时长内"); showPanel(); return;
    }
    checkpoint(); rememberVideoVersion(n);
    if (input.value==="") delete clip.edge[point];
    else clip.edge[point]=value;
    save(); showPanel();
  });
  $$("input[data-time]", refs).forEach(inp => {
    ["pointerdown", "click", "keydown"].forEach(ev => inp.addEventListener(ev, e => e.stopPropagation()));
    inp.onchange = () => {
      const e = B.edges[+inp.dataset.time]; if (!e) return;
      const v = parseFloat(inp.value); checkpoint();
      if (isFinite(v)) { e.time = Math.round(v * 10) / 10; if (!e.role) e.role = "keyframe"; } else delete e.time;
      save(); const vn = node(e.to); render(vn); drawEdges(); if (sel.has(vn.id)) showPanel();
    };
  });
  wireRoleSelects(refs);
  // ---- prompt
  const ta = $("#prompt");
  ta.removeAttribute("maxlength");
  ta.placeholder = n.type === "script" ? OneShotI18n.t("写剧情，例如：深夜书房，裴照在灯下写字，突然有人敲门。河神抱着一碗汤进来，衣摆滴水，把碗放在桌上。裴照低头察看，碗里映出河神的脸……\n\n可以连入角色 / 场景图片，Qwen 会按图里的样子安排人物") : n.type === "image" ? (imgInputs(n).length ? OneShotI18n.t("写修改要求，例如：把 @图1 里的橘猫换成穿校服的样子，背景改成樱花校园，保持猫的长相不变") : OneShotI18n.t("描述你想生成的画面，例如：秋日校园里，一只背着书包的橘猫站在红砖教学楼前，电影感，暖色逆光")) :
    (imgInputs(n).length ? OneShotI18n.t("描述视频中的动作、镜头和声音；点上方的图可以用 @图1 引用它") : OneShotI18n.t("描述视频内容、动作、镜头运动和声音，例如：雪地森林里一只红狐狸小跑后回头看向镜头，镜头缓慢推近；风声和踩雪声"));
  if (segment) ta.placeholder = n.data.camera_plan ? OneShotI18n.t("选填补充要求。机位和景别可在「重拍设置」修改。") :
    n.data.object_edit ? OneShotI18n.t("选填补充要求。目标选区可在「物体编辑设置」修改。") : OneShotI18n.t("描述这段视频要改的内容，例如把窗外改成雨天，保留人物和镜头节奏。");
  else if (extension) ta.placeholder = extension==="before"?OneShotI18n.t("描述原视频开头之前发生的事。"):OneShotI18n.t("描述原视频结尾之后发生的事。");
  else if (guide) ta.placeholder = OneShotI18n.t("描述正式画面的人物、环境和风格。已连接的白模负责参考运镜和走位。");
  else if (clips.length) ta.placeholder = OneShotI18n.t("描述新画面。用 @视频1 指定要复用的动作、运镜或构图。");
  else if (sounds.length) ta.placeholder = OneShotI18n.t("描述画面和声音，点击上方音频可引用它的节奏、语调或环境声。");
  if (n.type === "image" || n.type === "video") ta.placeholder = OneShotI18n.t("输入 @ 搜索并引用素材。") + "\n" + ta.placeholder;
  if (ta._node !== n.id) { ta.value = n.data.prompt; ta._node = n.id; }
  const fm = n.type === "video" && n.data.pmode === "fields";
  $("#pmode").innerHTML = n.type === "video" ? OneShotI18n.html`<button data-m="free" class="${fm ? "" : "on"}" title="一段话自由描述">自由描述</button><button data-m="fields" class="${fm ? "on" : ""}" title="按场景 / 人物 / 动作 / 对话分开填写，系统合成官方格式">分栏填写</button>` : "";
  $$("#pmode button").forEach(b => b.onclick = () => setPMode(n, b.dataset.m));
  ta.style.display = fm ? "none" : ""; $("#pp").classList.toggle("wide", fm);
  renderFields(n, fm);
  if (!fm) autoGrow(ta);
  // ---- controls
  const d = n.data, ctl = $("#ctl");
  const pill = (k, opts, label, extra = "", current=d[k]) => {
    const service = k === "provider" || k === "selected_model";
    const aria = {selected_model:"生成模型",image_text:"画面文字"}[k];
    const name = aria ? ` aria-label="${esc(OneShotI18n.t(aria))}"` : "";
    const options = Object.entries(opts).map(([value, text]) =>
      `<option value="${esc(value)}" ${String(value) === String(current) ? "selected" : ""}>${service ? text : OneShotI18n.t(text)}</option>`).join("");
    return `<span class="pill ${extra}">${service ? label : OneShotI18n.t(label)}<select data-k="${k}"${name}>${options}</select></span>`;
  };
  const arIcon = a => { const r = AR[a] || 1.6; const w = r >= 1 ? 13 : Math.round(13 * r), h = r >= 1 ? Math.round(13 / r) : 13; return `<span class="ar" style="width:${w}px;height:${h}px"></span>`; };
  let h;
  if (n.type === "script") h = scriptCtl(n);
  else if (n.type === "image") {
    const model = canvasNodeModel(n,nodeProvider(n)), alternative = model?.image_engine;
    const rem = isRemote(n), hi = rem || alternative || d.model !== "h3video", ins = imgInputs(n).length || previsComposition(n)?.enabled, fa = d.aspect === "auto";
    h = provPill(n, pill) + nodeModelPill(n,pill);
    if (!rem && !alternative) {
      h += pill("model", { h3img: "H3-Image（推荐，支持以图改图）", h3video: "H3 视频模型 · 快速出图" }, `<span class="dot"></span>${hi ? "H3-Image" : OneShotI18n.t("H3 快速")}${ico("down")}`, "model");
      if (hi) h += pill("expand", { false: "智能扩写：关", true: "智能扩写：开（按官方格式扩写，理解更准）" }, d.expand ? "扩写 开" : "扩写 关");
      else h += pill("turbo", { true: "极速 8 步", false: "高质量 30 步" }, d.turbo ? "极速" : "高质量");
    }
    h += pill("aspect", { ...(ins ? { auto: "跟随原图" } : {}), "1:1": "1:1", "3:4": "3:4", "4:3": "4:3", "9:16": "9:16", "16:9": "16:9", "21:9": "21:9" }, fa ? `${arIcon(ins ? "4:3" : "1:1")}${ins ? OneShotI18n.t("原图比例") : "1:1"}` : `${arIcon(d.aspect)}${d.aspect}`);
    if (alternative && !model.high_resolution) h += '<span class="pill">1K</span>';
    else {
      const megapixels = hi && !alternative;
      h += pill("quality", megapixels ? { "4mp": "4MP（约 2K）", "16mp": "16MP（约 4K，最佳画质，慢）" } : { "4mp": "1K", "16mp": "2K" },
        megapixels ? (d.quality === "16mp" ? "16MP" : "4MP") : (d.quality === "16mp" ? "2K" : "1K"));
    }
    h += pill("count", { 1: "1 张", 2: "2 张", 4: "4 张" }, `${ico("stack")}${d.count}`);
    h += pill("image_text", {auto:"文字按描述",none:"画面无文字",specified:"仅指定文字"},
      OneShotI18n.t(({none:"画面无文字",specified:"仅指定文字"})[d.image_text] || "文字按描述"),
      "", d.image_text || "auto");
    if (d.image_text==="specified") h += OneShotI18n.html`<span class="est">指定文字用引号标出</span>`;
    h += OneShotI18n.html`<button class="pill" id="pvBtn" title="核对生成用的提示词和参考素材">预览</button>`;
    if (hi) h += OneShotI18n.html`<button class="pill" id="slashBtn" title="三视图、九宫格、换角度、打光……（也可以在提示词里输入 /）">/ 工具</button>`;
  } else {
    const rem = isRemote(n);
    if (reference) {
      const services = referenceServices(n), selected = referenceService(n);
      const unavailable = d.provider && !selected;
      const opts = {"":"自动选择参考服务", ...Object.fromEntries(services.map(s => [s.id, esc(s.name)]))};
      if (unavailable) opts[d.provider]=esc(d.provider+"（不可用）");
      h = services.length || unavailable ? pill("provider", opts, `${esc(selected?.name || (unavailable?"重新选择参考服务":"自动选择参考服务"))}${ico("down")}`, "model")
        : OneShotI18n.html`<span class="pill" title="在控制台配置视频生成服务">待配置${guide || clips.length ? "视频参考" : "音频参考"}服务</span>`;
      if (selected) h += nodeModelPill(n,pill,selected,true);
    } else {
      h = provPill(n, pill) + nodeModelPill(n,pill);
      if (!rem && !videoOutputModel(n)?.fixed_sampling) h += pill("turbo", { true: "MiniMax H3 · 极速", false: "MiniMax H3 · 高质量" }, `<span class="dot"></span>${OneShotI18n.t(d.turbo ? "H3 极速" : "H3 高质量")}${ico("down")}`, "model");
    }
    const fa = d.aspect === "auto";
    const followSource=extension && /(?:seedance-2-5|^ep-)/.test(canvasNodeModel(n,referenceService(n),true)?.id || "");
    h += followSource || segment ? OneShotI18n.markup('<span class="pill">跟随原视频画幅</span>') :
      pill("aspect", { auto: extension ? "跟随原视频" : guide ? "跟随白模" : "跟随首图", "16:9": "16:9", "9:16": "9:16", "1:1": "1:1", "4:3": "4:3", "3:4": "3:4" }, `${arIcon(fa ? "16:9" : d.aspect)}${fa ? OneShotI18n.t("自动") : d.aspect}`);
    const canDraft=videoDraftAvailable(n);
    if (canDraft) h += pill("draft",{false:"正式生成",true:"480p 样片"},d.draft?"480p 样片":"正式生成");
    if (!(canDraft && d.draft)) {
      const qualities=videoOutputModel(n)?.qualities;
      if (qualities) {
        const options=Object.fromEntries(Object.entries(qualities).map(([key,label])=>[key,label==="4k"?"4K":esc(label)]));
        const quality=canvasVideoQuality(n), label=options[quality];
        h += Object.keys(qualities).length===1 ? `<span class="pill">${label}</span>` : pill("quality",options,label,"",quality);
      } else if (canDraft) h += pill("quality",{hd:"1080p",std:"720p"},d.quality==="hd"?"1080p":"720p");
      else h += pill("quality", reference ? {hd:"高清",std:"720P"} : {hd:"高清 768P",std:"标准 480P"},
        reference ? (d.quality==="hd"?"高清":"720P") : (d.quality==="hd"?"768P":"480P"));
    }
    const durationChoices=canvasVideoDurationChoices(n);
    const durations=Object.fromEntries(durationChoices.map(seconds=>
      [seconds,OneShotI18n.t(!reference && seconds===durationChoices.at(-1)?"{seconds} 秒（最长）":"{seconds} 秒",{seconds})]));
    const max=durationChoices.at(-1), seconds=canvasVideoDuration(n);
    const range=segment ? videoReferenceRange(clips[0].edge,clips[0].version,referenceDuration(n)) : null;
    h += segment ? `<span class="pill">${range.end>range.start?OneShotI18n.t("{seconds} 秒",{seconds:(range.end-range.start).toFixed(2)}):OneShotI18n.t("跟随修改区间")}</span>`
      : pill("duration",durations,`${ico("clock")}${Math.min(max,Math.max(durationChoices[0],seconds))}s`,"",seconds);
    if (!reference && imgInputs(n).length && !videoOutputModel(n)?.first_last_only) h += pill("mode", { auto: "按每张图的设置", keyframes: "全部当关键帧", reference: "全部当人物设定" }, planLabel(plan(n)));
    if (reference) h += OneShotI18n.html`<span class="pill">全模态参考</span>`;
    if(!d.film&&!d.previs)h += OneShotI18n.html`<button type="button" class="pill" id="videoOpticsBtn"${n.job||nodeLocked(n)?" disabled":""}>镜头参数${Number.isFinite(d.video_optics?.lens)?` · ${d.video_optics.lens} mm`:d.video_optics?" · 已设置":""}</button>`;
    if (segment && d.camera_plan) h += OneShotI18n.html`<button type="button" class="pill" id="retakeSettings" title="重拍设置">重拍设置 · ${esc(cameraModeLabel[d.camera_plan.mode] || "机位")}</button>`;
    if (segment && d.object_edit) h += OneShotI18n.html`<button type="button" class="pill" id="objectSettings">物体编辑设置</button>`;
    const precheck=videoQualityPrecheckAvailable(n);
    const precheckEnabled=videoQualityPrecheckEnabled(n);
    if (precheck || precheckEnabled) h += pill("quality_precheck",{false:"关闭质量预检",true:"INT8 画面预检，最多五次"},
      precheckEnabled?"质量预检开":"质量预检关","",precheckEnabled);
    if (!d.film && !(precheck && precheckEnabled)) h += pill("count", { 1: "出 1 个", 2: "抽 2 个版本，挑最好的", 3: "抽 3 个版本，挑最好的" }, `${ico("stack")}${d.count > 1 ? OneShotI18n.t("抽 {count}",{count:d.count}) : OneShotI18n.t("1 个")}`);
  }
  if (n.type !== "script") h += OneShotI18n.html`<button class="pill" id="moreBtn" title="更多设置">${ico("more")}</button>`;
  if (n.type === "video" && d.pmode === "fields") h += OneShotI18n.html`<button class="pill" id="fillBtn" title="Qwen 看连入的首帧 / 人物图，填写风格、场景、人物、镜头（只填空着的栏）">看图填写</button>`;
  if (n.type === "video") {
    h += OneShotI18n.html`<button class="pill" id="pvBtn" title="核对生成用的提示词和参考素材">预览</button>`;
    if (!reference) h += OneShotI18n.html`<button class="pill" id="rwBtn" title="用本地 Qwen3.5 把描述改写成 H3 官方英文结构化提示词（可看到连入的图片）">✨ 改写</button>`;
    if (d.prompt_src) h += OneShotI18n.html`<button class="pill" id="rsBtn" title="还原改写前的原文">还原原文</button>`;
  }
  h += `<span class="grow"></span>${reference ? "" : `<span class="est">${estimate(n)}</span>`}`;
  if (!n.job && n.type !== "script" && !d.film) h += OneShotI18n.html`<span class="est" data-generation-cost title="仅估算生成服务费用，实际费用以服务账单为准">正在估算费用…</span>`;
  const sendLabel = OneShotI18n.t(n.job ? "取消" : draftFinalEdge(n) ? "重试定稿" : curV(n) && n.type!=="script" ? "重新生成" : "生成");
  h += `<button id="send" class="${n.job ? "stop" : ""}" aria-label="${sendLabel}" title="${sendLabel}${n.job?"":" (⌘↩)"}">${ico(n.job ? "stop" : "send")}</button>`;
  ctl.innerHTML = h;
  renderCanvasCost(n,$("[data-generation-cost]",ctl));
  $$("select", ctl).forEach(s => s.onchange = () => {
    checkpoint();
    const key = s.dataset.k;
    const modelChanged = n.type === "video" && (key === "provider" || key === "selected_model");
    const previousDefault = modelChanged ? videoOutputModel(n)?.default_quality : null;
    let val = s.value; if (["turbo","expand","draft","quality_precheck"].includes(key)) val = val === "true"; else if (["count", "duration"].includes(key)) val = Number(val);
    if (key === "provider") delete d.selected_model;
    if (key === "selected_model" && val && !d.provider) d.provider = nodeProvider(n)?.id;
    if (key === "selected_model" && nodeProvider(n)?.models?.some(model=>model.id===val && model.first_last_only)) {
      d.mode = "auto";
      d.quality_precheck = false;
    }
    if (key === "selected_model" && !val) delete d.selected_model;
    else d[key] = val;
    if (modelChanged && previousDefault !== "480p" && videoOutputModel(n)?.default_quality === "480p") d.quality = "480p";
    save(); render(n); refreshDownstream(n); showPanel();
  });
  $("#send").onclick = () => n.job ? cancel(n) : generate(n);
  if ($("#moreBtn")) $("#moreBtn").onclick = e => { e.stopPropagation(); $("#more").classList.toggle("on"); };
  if ($("#slashBtn")) $("#slashBtn").onclick = e => { e.stopPropagation(); openSlash(n, false); };
  if ($("#fillBtn")) $("#fillBtn").onclick = () => fillFieldsFromImages(n);
  if (n.type === "script") { wireScriptCtl(n, ctl); $("#more").classList.remove("on"); placeOverlays(); return; }
  if ($("#rwBtn")) $("#rwBtn").onclick = () => rewritePrompt(n);
  if ($("#pvBtn")) $("#pvBtn").onclick = () => previewPrompt(n);
  if ($("#videoOpticsBtn")) $("#videoOpticsBtn").onclick = () => openVideoOptics(n);
  if ($("#retakeSettings")) $("#retakeSettings").onclick = () => openRetakeSettings(n);
  if ($("#objectSettings")) $("#objectSettings").onclick = () => openObjectSettings(n);
  if ($("#rsBtn")) $("#rsBtn").onclick = () => {
    checkpoint(); n.data.prompt = n.data.prompt_src; delete n.data.prompt_src;
    if (n.data.rw_from === "fields") n.data.pmode = "fields"; delete n.data.rw_from;
    save(); $("#prompt").value = n.data.prompt; showPanel();
  };
  // ---- more
  const more = $("#more");
  more.innerHTML = (canBranchGeneration(n)?OneShotI18n.markup('<button type="button" class="pill" id="generationBranch">生成到新节点（1 个）</button>'):"") +
    OneShotI18n.html`<label>随机种子<input type="number" id="mSeed" value="${d.seed}"></label><div class="h">-1 为每次随机；固定数字可复现同一结果</div>` +
    (n.type === "image" ? OneShotI18n.html`<label>画面描述<input type="text" id="mCap" value="${esc(d.caption)}" placeholder="供多图视频使用"></label><div class="h">上传的图片建议填写；生成的图片自动使用提示词</div>` :
      (d.pmode === "fields" ? OneShotI18n.html`<div class="h">分栏模式：声音、配乐在上方填写。<br>极速：4~8 步，约 1~2.5 分钟；高质量 20 步，慢约 4 倍</div>` :
      OneShotI18n.html`<label>声音<input type="text" id="mSound" value="${esc(d.sound)}" placeholder="环境音、动作音效"></label>
       <label>配乐<input type="text" id="mMusic" value="${esc(d.music)}" placeholder="留空 = 无配乐"></label>
       <div class="h">会写进官方格式的 overall_soundscape / non_diegetic_music。台词直接写进提示词，如：裴照低声问："谁？"<br>极速：4~8 步，约 1~2.5 分钟；高质量 20 步，慢约 4 倍</div>`));
  $("#mSeed").onchange = e => { n.data.seed = Number(e.target.value); save(); };
  const branch=$("[id=generationBranch]",more);
  if (branch) branch.onclick=()=>{
    more.classList.remove("on");
    if (n.type==="video") void previewPrompt(n,{branch:true});
    else void generate(n,{branch:true});
  };
  const mc = $("#mCap"); if (mc) mc.oninput = e => { n.data.caption = e.target.value; save(); };
  const ms = $("#mSound"); if (ms) ms.oninput = e => { n.data.sound = e.target.value; save(); };
  const mm = $("#mMusic"); if (mm) mm.oninput = e => { n.data.music = e.target.value; save(); };
  placeOverlays();
}
function imagePromptChip({edge,source,version,index},i,role,disableRemove) {
  const slot=promptSlot(edge.prompt_slot), token=promptMediaToken("image",slot,i+1);
  const pinned=edge.ref?`<span class="role">${version?OneShotI18n.t("版本 {number}",{number:index+1}):OneShotI18n.t("版本已移除")}</span>`:"";
  const latest=curV(source);
  const update=edge.ref&&latest?.ref&&latest.ref!==edge.ref?OneShotI18n.html`<button type="button" data-image-update="${i}">改用当前版本</button>`:"";
  const removeLabel=esc(OneShotI18n.t("移除参考图 · {name}",{name:source.name}));
  const remove=`<button type="button" data-image-remove="${i}" aria-label="${removeLabel}" title="${removeLabel}" ${disableRemove?"disabled":""}>×</button>`;
  return `<span class="ref" data-tok="${token}" title="${esc(OneShotI18n.t("点击在提示词中引用 · {name}",{name:source.name}))}">${version?.url?`<img src="${esc(version.url)}">`:`<span class="tx">${ico("image")}</span>`}${slot?esc(source.name):OneShotI18n.t("图{number}",{number:i+1})}${role}${pinned}${update}${remove}</span>`;
}
function imageReferenceSelect(n,edge,index) {
  const current=edge.image_use || (edge.story_cast ? "character" : "reference");
  const disabled=!canvasCanEdit() || nodeLocked(n) || n.job || prepping.has(n.id);
  return OneShotI18n.html`<select data-image-use="${index}" aria-label="图片参考用途" ${disabled?"disabled":""}>${Object.entries(IMAGE_REFERENCE_USE).map(([use,label])=>
    `<option value="${use}" ${use===current?"selected":""}>${OneShotI18n.t(label)}</option>`).join("")}</select>`;
}
function roleSelect(e) {
  const i = B.edges.indexOf(e);
  return OneShotI18n.html`<select data-edge="${i}" title="这张图在视频里的作用">${Object.entries(ROLE_CN).map(([k, t]) => `<option value="${k}" ${(e.role || "auto") === k ? "selected" : ""}>${OneShotI18n.t(t)}</option>`).join("")}</select>`;
}
function wireRoleSelects(root) {
  $$("select[data-edge]", root).forEach(sl => {
    sl.disabled = !canvasCanEdit();
    sl.addEventListener("pointerdown", e => e.stopPropagation());
    sl.addEventListener("click", e => e.stopPropagation());
    sl.onchange = () => {
      const e = B.edges[+sl.dataset.edge]; if (!e || !canvasCanEdit()) return;
      checkpoint(); e.role = sl.value === "auto" ? undefined : sl.value; save();
      const v = node(e.to); render(v); drawEdges(); if (sel.has(v.id)) showPanel();
      if (sl.value === "subject") toast(OneShotI18n.t("这张图将用于参考人物的长相和服装"), 2600);
    };
  });
}
function estimate(n) {
  const d = n.data;
  if (n.type === "script") return (d.shots || []).length ? `${d.shots.length} 镜 · 重新拆约 20 秒` : "≈ 10~30 秒";
  if (n.type === "image") {
    const s = d.model === "h3video" ? (d.turbo ? 32 : 110) * (d.quality === "16mp" ? 2 : 1) * d.count
      : ((d.quality === "16mp" ? IMG_T.mp16 : IMG_T.mp4) + (d.expand ? IMG_T.pe : 0)) * d.count;
    return "≈ " + fmtT(s);
  }
  const p = plan(n), hd = d.quality === "hd";
  const s = (p.mode === "fl2v" ? (hd ? 120 : 60) : (hd ? 150 : 65)) * (d.duration / 5) * (d.turbo ? 1 : 4) * (d.count || 1);  // measured
  return "≈ " + fmtT(s);
}
const IMG_T = { mp4: 30, mp16: 50, pe: 25 };   // seconds, measured on the 4090
const fmtT = s => s >= 90 ? OneShotI18n.t("{count} 分钟", {count:Math.round(s / 30) / 2}) : OneShotI18n.t("{seconds} 秒", {seconds:Math.round(s)});
function autoGrow(ta) { ta.style.height = "auto"; ta.style.height = Math.min(320, Math.max(70, ta.scrollHeight)) + "px"; }
// ---- field-by-field video prompt
const FIELDS = [
  { k: "style", t: "风格", ph: "画面风格、质感、色调，如：写实电影感，暖色烛光，浅景深" },
  { k: "scene", t: "场景", sub: "背景", ph: "地点、时间、环境、光线，如：古代书房，深夜，窗外下着雨，油灯昏黄" },
  { k: "people", t: "人物", ph: "一行一个「名字：外貌穿着」，如：\n裴照：二十多岁的书生，青色长衫\n河神：白衣男子，长发湿漉漉" },
  { k: "camera", t: "镜头", ph: "景别与运镜，如：中景固定机位，最后缓慢推近到桌上的碗" },
  { k: "action", t: "动作", sub: "按顺序", ph: "一行一个动作，按发生顺序，如：\n门外突然传来敲门声，裴照在灯下停笔抬头\n河神抱着碗推门进来，衣摆滴水\n河神把碗放到桌上，裴照低头察看" },
  { k: "dialogue", t: "对话", sub: "原文保留", ph: "一行一句「名字：台词」，可加语气，如：\n裴照（低声）：谁？\n河神：给你送碗汤。" },
  { k: "sound", t: "声音", ph: "环境音和动作音效，如：雨声、敲门声、木门吱呀、衣摆滴水声（留空自动匹配）" },
  { k: "music", t: "配乐", ph: "留空 = 无配乐；如：低沉的古琴，节奏缓慢" },
];
let lastField = null;
function renderFields(n, on) {
  const box = $("#pfields"); box.classList.toggle("on", on);
  if (!on) { box._node = null; return; }
  if (box._node === n.id) return;          // keep focus / caret while typing
  box._node = n.id; const f = n.data.fields || (n.data.fields = {});
  box.innerHTML = FIELDS.map(x => `<label class="f"><span>${OneShotI18n.t(x.t)}${x.sub ? `<small>${OneShotI18n.t(x.sub)}</small>` : ""}</span><textarea rows="1" data-k="${x.k}" placeholder="${esc((x.k === "action" ? OneShotI18n.t("输入 @ 引用素材。") : "")+OneShotI18n.t(x.ph))}"></textarea></label>`).join("");
  $$("textarea", box).forEach(t => {
    t.value = f[t.dataset.k] || ""; fieldGrow(t);
    t.addEventListener("input", () => {
      f[t.dataset.k] = t.value; fieldGrow(t); save(); placeOverlays();
      renderCanvasCost(n,$("[data-generation-cost]"));
    });
    t.addEventListener("focus", () => { lastField = t; t._before = snap(); });
    t.addEventListener("blur", () => { if (t._before && t._before !== snap()) checkpoint(t._before); });
    t.addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (!n.job) generate(n); } });
  });
  requestAnimationFrame(() => { $$("textarea", box).forEach(fieldGrow); placeOverlays(); });   // measure once the panel is visible
}
function fieldGrow(t) { t.style.height = "auto"; t.style.height = Math.min(160, Math.max(28, t.scrollHeight)) + "px"; }
function setPMode(n, m) {
  if (n.data.pmode === m) return;
  checkpoint(); const f = n.data.fields || (n.data.fields = {});
  if (m === "fields" && !Object.values(f).some(v => (v || "").trim())) {   // carry the free text over once
    const p = (n.data.prompt || "").trim();
    if (p && !/integrated_multimodal_description:|subject_definitions:/.test(p)) f.action = p;
    if (n.data.sound) f.sound = n.data.sound;
    if (n.data.music) f.music = n.data.music;
  }
  n.data.pmode = m; save(); $("#pfields")._node = null; showPanel();
  if (m === "fields") setTimeout(() => $(`#pfields textarea[data-k="${f.action ? "action" : "scene"}"]`)?.focus(), 30);
}

function insertTok(tok) {
  const ta = (usesFields(node($("#prompt")._node)) && lastField && document.contains(lastField)) ? lastField : $("#prompt"), s = ta.selectionStart ?? ta.value.length;
  ta.value = ta.value.slice(0, s) + tok + " " + ta.value.slice(ta.selectionEnd ?? s); ta.focus(); ta.selectionStart = ta.selectionEnd = s + tok.length + 1;
  ta.dispatchEvent(new Event("input"));
}
$("#prompt").addEventListener("input", e => {
  const n = node(e.target._node); if (!n) return; n.data.prompt = e.target.value; autoGrow(e.target); save(); placeOverlays();
  if (n.type === "video") renderCanvasCost(n,$("[data-generation-cost]"));
});
$("#prompt").addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); const n = node(e.target._node); if (n && !n.job) generate(n); } });
$("#prompt").addEventListener("focus", e => { e.target._before = snap(); });
$("#prompt").addEventListener("blur", e => { if (e.target._before && e.target._before !== snap()) checkpoint(e.target._before); });
document.addEventListener("pointerdown", e => { if (!e.target.closest("#more, #moreBtn")) $("#more").classList.remove("on"); });
