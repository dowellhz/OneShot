"use strict";

// ---- right-click menu
function nodePinPalette(nodes) {
  return OneShotI18n.html`<div class="node-pin-menu" role="group" aria-label="节点颜色标记">
    ${[...NODE_PINS].map(([key,label]) => `<button type="button" data-a="pin:${key}" title="${label}标记" aria-label="${label}标记" aria-pressed="${nodes.every(n=>nodePins(n).includes(key))}"><span class="node-pin" data-color="${key}"></span></button>`).join("")}
    <button type="button" data-a="pin:" title="清除标记" aria-label="清除标记" ${nodes.some(n=>nodePins(n).length) ? "" : "disabled"}>${ico("minus")}</button>
  </div>`;
}
let nodePinTrigger = null;
function openNodePinMenu(button) {
  const nodes = [...sel].map(node).filter(Boolean);
  if (!canvasCanEdit() || !nodes.length) return;
  const menu = $("#nodePinMenu");
  closeMenus();
  const board = B, ids = nodes.map(n=>n.id);
  nodePinTrigger = button;
  menu.innerHTML = nodePinPalette(nodes);
  menu.classList.add("on");
  const rect = button.getBoundingClientRect();
  const below = rect.bottom + 6;
  menu.style.left = Math.max(8, Math.min(rect.left, innerWidth - menu.offsetWidth - 8)) + "px";
  menu.style.top = Math.max(8, below + menu.offsetHeight <= innerHeight - 8 ? below : rect.top - menu.offsetHeight - 6) + "px";
  const triggerSelector = ids.length === 1 ? "#ntools [data-a=pin]" : "#selectionTools [data-action=pin]";
  $$("button", menu).forEach(choice => choice.onclick = () => {
    closeMenus();
    if (B !== board || ids.length !== sel.size || !ids.every(id=>sel.has(id))) return;
    markCanvasNodes(ids, choice.dataset.a.slice(4));
    $(triggerSelector)?.focus();
    hideNodeToolTip();
  });
  $("button", menu).focus();
}
function ctxMenu(e) {
  const el = e.target.closest?.(".node");
  if (!canvasCanEdit() && !el) { ccPoint(toW(e.clientX, e.clientY)); return; }
  if (!el) { openAddMenu(e.clientX, e.clientY, { at: toW(e.clientX, e.clientY), arrange: true }); return; }
  const n = node(el.dataset.id); if (!n) return;
  if (!sel.has(n.id)) selectOnly(n.id);
  const selected = [...sel].map(node).filter(Boolean);
  const many = sel.size > 1, v = curV(n), it = [];
  const add = (a, icon, label, k = "") => it.push(`<button data-a="${a}">${ico(icon)}${label}${k ? `<span class="k">${k}</span>` : ""}</button>`);
  it.push(`<div class="mt">${many ? `已选 ${sel.size} 个节点` : esc(n.name)}</div>`);
  if (canvasCanEdit()) {
    add("agent-new", "script", many ? "用选中节点发起新对话" : "用此节点发起新对话");
    it.push(nodePinPalette(selected));
    if (selected.some(m=>!nodeLocked(m))) add("lock-selection","lock",many ? "锁定所选节点" : "锁定节点");
    if (selected.some(nodeLocked)) add("unlock-selection","lock",many ? "解锁所选节点" : "解锁节点");
    it.push('<div class="sep"></div>');
  }
  if (!many && n.type === "text") add("text-document", "script", canvasCanEdit() ? "编辑文档" : "查看文档");
  if (!many && n.type === "text" && n.data.transcript?.cues?.length) add("saved-transcript", "scissors", "按台词剪辑音频");
  if (!many && n.data.previs) add("previs", "video", "编辑白模");
  if (!many && n.type === "audio") add("audio-upload","upload","上传音频版本");
  if (!many && n.type === "audio" && v?.ref) add("transcript","text","音频转写");
  if (!many && ["video","audio"].includes(n.type) && v?.ref && canvasCanEdit()) add("separate-audio","audio","人声分离");
  if (!many && n.data.playlist) add("playlist-open","stack","打开播放列表");
  if (!many && !n.job && canvasCanEdit() && draftFinalEdge(n)) add("draft-final","hd","重试定稿");
  if (!many && canvasCanEdit() && B.edges.some(edge=>edge.from===n.id && vtGenerationReference(edge,n,node(edge.to)))) {
    add("replace-reference","next","替换下游参考…");
  }
  if (!many && v) {
    if (pvGuideAvailable(v)) add("previsvideo", "next", "用作动作参考");
    if (n.type === "image") {
      add("edit", "image", "编辑图片（局部重绘 / 扩图 / 裁剪）");
      add("relight", "edit", "调整图片布光");
      add("image-camera", "video", "图片换机位");
      if (panoramaVersion(v)) add("panorama","panorama","360° 全景预览");
      add("image-pixels", "fit", "调整像素尺寸");
      add("image-upscale", "full", "智能放大");
      add("image-decompose", "assets", "自动分层");
      add("tovideo", "video", "生成视频"); add("hd", "full", "高清重绘"); add("describe", "text", "反推提示词");
      add("film", "scissors", "用图片开始剪辑");
      if (v.ref) add("gif-export", "motion", "宫格生成 GIF");
      it.push(`<div class="sep"></div>`);
      add("split2x2", "assets", "拆分宫格 2×2"); add("split3x3", "assets", "拆分宫格 3×3"); add("split4x4", "assets", "拆分宫格 4×4"); add("split5x5", "assets", "拆分宫格 5×5");
      it.push(`<div class="sep"></div>`);
      add("asset:character", "image", n.data.asset?.kind === "character" ? "更新资产库角色" : "存为角色"); add("asset:scene", "image", "存为场景"); add("asset:prop", "image", "存为道具");
      it.push(`<div class="sep"></div>`);
    }
    if (n.type === "video" && n.data.film && !n.data.playlist) add("film", "scissors", "编辑成片");
    else if (n.type === "video" && !n.data.film) { add("cont", "next", "续拍"); add("film", "scissors", "剪辑视频（导出为新版本）"); add("analyze", "script", "拉片（拆镜头复刻）"); }
    if (n.type === "video") { add("firstframe", "image", "截取首帧"); add("currentframe", "image", "截取当前帧"); add("frame", "image", "截取末帧"); }
    if (n.type === "video") add("remake", "video", "视频重制 · 替换角色");
    if (n.type === "video") add("trim-video", "scissors", "裁剪视频 / 智能拆镜头");
    if (n.type === "video" && v.ref && canvasCanEdit()) add("dialogue-review", "audio", "核对对白");
    if (n.type === "video" && v.draft_expires) add("draft-final","hd","从样片生成定稿");
    if (draftVideoComparison(n,v)) add("compare-draft","fit","对比样片与定稿");
    if (n.type === "video" && n.versions.filter(v=>v.url).length > 1) add("compare-video", "stack", "对比视频版本");
    if (n.type === "video" && v.source!=="previs") {
      add("segment-edit","edit","修改视频片段");
      add("camera-retake","video","镜头重拍");
      add("object-remove","edit","移除视频物体");
      add("object-replace","edit","替换视频物体");
      if (n.data.object_edit && videoInputs(n)[0]?.edge.segment_edit) add("object-settings","edit","调整物体编辑设置");
      if (n.data.camera_plan && videoInputs(n)[0]?.edge.segment_edit) add("retake-settings","edit","调整当前重拍设置");
    }
    if (n.type === "video" && (v.segment_review || collectSegmentVersions({node:n,index:n.cur}).length)) add("segment-review","scissors","审核修改片段");
    if (n.type === "video" && extensionInput(v)) add("extension-film","scissors","原片与续拍一起剪辑");
    if (v.video_recipe?.segment_edit) {
      add("segment-film","scissors","在原片中核对这一段");
      add("segment-review-parent","scissors","审核原片的各段修改");
    }
    add("full", "full", "全屏查看");
    add("dl", "dl", "下载");
    if (n.type === "video" && v.ref) add("gif-export","motion","导出循环 GIF");
    if (canvasCanEdit() && v.ref && ["image","video"].includes(n.type)) add("broll","motion","B-roll 动态画面");
    it.push(`<div class="sep"></div>`);
  }
  if (many) {
    if (canvasCanEdit() && selected.some(groupGeneratable)) add("ct:generate", "motion", "批量生成选中节点");
    add("ct:fold", "stack", "收起为一组");
    add("ct:left", "fit", "左对齐"); add("ct:top", "fit", "顶部对齐");
    add("ct:distributeX", "assets", "水平等距排列"); add("ct:distributeY", "assets", "垂直等距排列");
    add("ct:group", "assets", "编组", "⌘G"); add("ct:ungroup", "assets", "取消编组", "⇧⌘G");
    if (ctSelected().some(alCanvasCollectable)) add("ct:collect","assets","收录到资产库");
    add("ct:download", "dl", "批量下载素材"); it.push(`<div class="sep"></div>`);
    add("template", "stack", "将选区保存为模板");
  }
  if (!many) add("comment", "comment", "评论此节点");
  add("arrange", "assets", "整理图片与视频…");
  const vids = [...sel].map(node).filter(m => m && m.type === "video" && curV(m));
  if(vids.length>=2){const info=vtMergeInfo(vids.map(m=>m.id));it.push(`<button data-a="merge-tabs" ${info.error?`disabled title="${esc(info.error)}"`:""}>${ico("stack")}合并为 Tab（${vids.length} 个视频）</button>`);}
  if(!many&&n.type==="video"&&n.versions.length>1){add("split-tab","copy","拆出当前 Tab");add("split-tabs","assets","拆开所有 Tab");}
  const qv = [...sel].map(node).filter(m => m && m.type === "video" && !m.job && !m.data.film && !m.data.previs);
  if (many && qv.length) { add("queuegen", "video", `排队生成（${qv.length} 段视频，按名称顺序）`); if (!(vids.length >= 2)) it.push(`<div class="sep"></div>`); }
  const media = byPosition([...sel]).filter(filmSource);
  if (media.filter(playlistVideo).length >= 2) add("playlist-create","stack","创建播放列表");
  if (many && media.length >= 2) { add("concat", "scissors", `剪辑成片（${media.length} 段，按位置顺序）`); it.push(`<div class="sep"></div>`); }
  if (!many) add("workflow-review", "script", "制作复盘");
  add("focus", "fit", many ? "聚焦选中" : "聚焦此节点", "F");
  if (!many) add("rename", "text", "重命名");
  add("dup", "copy", "创建副本", "⌘D");
  it.push(`<div class="sep"></div>`);
  if (canvasCanEdit() && selected.some(m=>!nodeLocked(m))) add("del","trash",selected.some(nodeLocked) ? "删除未锁定节点" : "删除","Del");
  const m = $("#ctxMenu"); m.innerHTML = it.join(""); m.classList.add("on");
  if (!canvasCanEdit()) $$("button[data-a]",m).filter(b=>!["comment","full","compare-video","dl","gif-export","focus","workflow-review","playlist-open","text-document","panorama"].includes(b.dataset.a)).forEach(b=>b.remove());
  m.style.left = Math.min(e.clientX, innerWidth - m.offsetWidth - 8) + "px"; m.style.top = Math.min(e.clientY, innerHeight - m.offsetHeight - 8) + "px";
  $$("button", m).forEach(b => b.onclick = () => {
    closeMenus(); const a = b.dataset.a;
    if (a === "arrange") ctOpenArrangeMenu(e.clientX, e.clientY);
    else if (a === "comment") ccNode(n);
    else if (a === "template") openWorkflowTemplates(true);
    else if (a === "agent-new") acNewNodeSession(selected.map(item=>({id:item.id,ref:curV(item)?.ref}))).catch(error=>toast(error.message));
    else if (a === "replace-reference") vtOpenReferenceUpdate(n);
    else if (a === "workflow-review") openWorkflowReview(n.id, n.cur >= 0 ? n.cur + 1 : null);
    else if(a==="merge-tabs")vtMerge(vids.map(m=>m.id),n.id);
    else if(a==="split-tab"||a==="split-tabs")vtSplit(n.id,n.cur,a==="split-tabs");
    else if (a.startsWith("ct:")) ctAction(a.slice(3));
    else if (a === "focus") fit([...sel].map(node).filter(Boolean));
    else if (a === "rename") { const nm = $(".nm", els.get(n.id)); nm.dispatchEvent(new MouseEvent("dblclick", { bubbles: false })); }
    else if (a === "dup") duplicate([...sel]);
    else if (a === "del") removeNodes([...sel]);
    else if (a === "lock-selection" || a === "unlock-selection") markCanvasNodes([...sel],a === "lock-selection",{lock:true});
    else if (a.startsWith("pin:")) markCanvasNodes([...sel],a.slice(4));
    else if (a === "concat") openFilm(media);
    else if (a === "playlist-create") createFilmPlaylist(media);
    else if (a === "queuegen") queueVideos([...sel].map(node).filter(m => m && m.type === "video" && !m.job && !m.data.film && !m.data.previs));
    else nodeAction(n, a);
  });
}
