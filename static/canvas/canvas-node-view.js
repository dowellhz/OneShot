"use strict";

// ================================================================= node DOM
function build(n) {
  const el = document.createElement("div");
  el.className = "node " + n.type; el.dataset.id = n.id;
  el.innerHTML = OneShotI18n.html`<div class="lbl">${ico(n.type)}<span class="nm"></span><span class="meta"></span><span class="node-pins" hidden></span><span class="node-lock" title="已锁定位置和删除" aria-label="已锁定位置和删除" hidden>${ico("lock")}</span><span class="gr" title="按住拖动">${ico("grip")}</span></div>
    <div class="card"><div class="grip" title="按住拖动">${ico("grip")}</div><div class="body"></div><div class="gen"><div class="pct"></div><div class="bar"><i></i></div><div class="s"></div></div><div class="errbox"></div></div>
    <div class="plus l" title="添加上游节点">${ico("plus")}</div><div class="plus r" title="拖动连线 / 点击新建下游节点">${ico("plus")}</div>`;
  world.appendChild(el); els.set(n.id, el);
  wire(n, el); render(n);
}
function rebuild() {
  els.forEach(e => e.remove()); els.clear();
  B.nodes.forEach(build); drawEdges(); updateEmpty(); placeOverlays();
  renderNodePinBar();
  acRenderNodeActivity();
  if (filmPlaylistPicker) paintFilmPlaylistPicker();
}
function render(n) {
  const el = els.get(n.id); if (!el) return;
  const s = size(n), v = curV(n), card = $(".card", el), body = $(".body", el);
  el.classList.toggle("ac-voice-reference",!!acVoicePointing() && acVoiceActive.refs.has(n.id));
  el.style.left = n.x + "px"; el.style.top = n.y + "px";
  card.style.width = s.w + "px"; card.style.height = s.h + "px";
  if (n.type === "text") card.dataset.documentBackground = documentBackground(n.data.text_background);
  $(".nm", el).textContent = n.name; $(".nm", el).title = n.name;
  const pinGroup=$(".node-pins",el),colors=nodePins(n),colorKey=colors.join(",");
  if(pinGroup.dataset.colors!==colorKey){
    pinGroup.dataset.colors=colorKey;
    pinGroup.hidden=!colors.length;
    pinGroup.innerHTML=colors.map(color=>`<span class="node-pin" data-color="${color}" title="${NODE_PINS.get(color)}标记"></span>`).join("");
  }
  el.classList.toggle("node-locked",nodeLocked(n));
  $(".node-lock",el).hidden = !nodeLocked(n);
  let meta = "";
  if (n.type === "text" && n.data.text_format === "markdown") {
    let article = $(".node-document",body);
    if (!article) {
      article = document.createElement("article");
      article.className = "node-document";
      body.replaceChildren(article);
    }
    if (article._text !== n.data.text) {
      article._text = n.data.text;
      renderDocumentPreview(article,documentText(n));
    }
  } else if (n.type === "text") {
    if (!body.querySelector("textarea")) {
      body.innerHTML = OneShotI18n.html`<textarea placeholder="输入文本：脚本、画面描述、风格、镜头语言……&#10;&#10;连到图片或视频节点后，会并入它们的提示词"></textarea>`;
      const ta = $("textarea", body); ta.value = n.data.text;
      ta.addEventListener("input", () => { n.data.text = ta.value; save(); B.edges.filter(e => e.from === n.id).forEach(e => refresh(node(e.to))); });
      ta.addEventListener("focus", () => { ta._before = snap(); });
      ta.addEventListener("blur", () => { if (ta._before && ta._before !== snap()) checkpoint(ta._before); });
    }
    const ta = $("textarea", body);
    if (ta.value !== (n.data.text ?? "")) ta.value = n.data.text ?? "";
    ta.readOnly = !canvasCanEdit();
  } else if (n.type === "script") {
    renderScript(n, body);
    meta = (n.data.shots || []).length ? `${n.data.shots.length} 镜` : "";
  } else if (n.type === "audio") {
    if(v){
      const player=$("audio",body);
      if(!player||player.getAttribute("src")!==(v.url||"")){
        if(player&&!player.paused)player.pause();
        body.innerHTML=audioPreviewMarkup(v);
        bindAudioPreview(body,v);
      }
    }else body.innerHTML=OneShotI18n.html`<div class="ph">${ico("audio")}<div class="t">输入文案生成配音或音乐<br>也可拖入音频文件</div></div>`;
    meta = v?.seconds ? `${v.seconds.toFixed(1)}s` : "";
  } else if (n.data.playlist && !v) {
    const clips = n.data.film?.clips || [];
    meta = clips.length ? `${clips.length} 段 · ${filmTotal(n.data.film).toFixed(1)}s` : "空播放列表";
    body.innerHTML = OneShotI18n.html`<div class="ph">${ico("stack")}<button class="pill" type="button" data-open-playlist>打开播放列表</button></div>`;
    $("[data-open-playlist]",body).onclick = event => { event.stopPropagation(); openFilm(n); };
  } else if (v) {
    body.innerHTML = n.type === "image" ? `<img class="m" src="${v.url}" draggable="false">` : `<video class="m" src="${v.url}" controls playsinline preload="metadata"></video>`;
    meta = `${v.w}×${v.h}` + (v.seconds ? ` · ${v.seconds.toFixed(1)}s` : "") + (n.versions.length > 1 ? ` · ${n.cur + 1}/${n.versions.length}` : "");
    const badge=v.draft_final?.resolution ? `${String(v.draft_final.resolution).toUpperCase()} 定稿` : v.draft_expires ? "480p 样片" : v.mode;
    if (n.type === "video" && badge) body.insertAdjacentHTML("beforeend", `<span class="badge">${esc(badge)}</span>`);
  } else {
    const tr = OneShotI18n.t;
    let hint;
    if (n.data.previs) hint = tr("双击编辑白模场景") + "<br>" + tr("设置机位与走位，渲染预演视频");
    else if (n.type === "image") {
      const count = imgInputs(n).length;
      hint = count ? tr("以图改图 · {count} 张参考图", {count}) + "<br>" + tr("选中后写下修改要求，用 @图1 指代原图") :
        tr("选中后在下方输入提示词生成") + "<br>" + tr("或把图片拖到这里");
    } else {
      const p = plan(n);
      hint = p.imgs.length ? tr("{plan} · {count} 张图", {plan: planLabel(p), count:p.imgs.length}) + "<br>" + tr("点连线上的标签可设为人物设定 / 首帧 / 尾帧") :
        tr("选中后输入提示词生成") + "<br>" + tr("或把视频拖到这里");
    }
    body.innerHTML = `<div class="ph">${ico(n.type)}<div class="t">${hint}</div></div>`;
  }
  if(!v&&canvasCanEdit()&&canvasMediaUploadTarget(n)&&!n.job){
    const placeholder=$(".ph",body);
    placeholder.insertAdjacentHTML("beforeend",OneShotI18n.html`<div class="node-start-actions">
      <button type="button" class="pill" data-node-start="agent">交给助手</button>
      <button type="button" class="pill" data-node-start="prompt">填写提示词</button>
    </div>`);
  }
  const promptAction = $("[data-node-prompt]",body);
  if (v && canvasCanEdit() && canvasMediaUploadTarget(n)) {
    if (!promptAction) body.insertAdjacentHTML("beforeend",OneShotI18n.markup('<button type="button" class="pill node-prompt-action" data-node-prompt>提示词</button>'));
  } else {
    promptAction?.remove();
  }
  renderVTabs(n, el);
  $(".meta", el).textContent = meta;
  el.classList.toggle("sel", sel.has(n.id));
  renderJob(n);
  if(n.agent_error)showErr(n,n.agent_error);
  if (n.type==="video") $(".plus.r",el).title=v&&v.source!=="previs"?OneShotI18n.t("拖动连线用作视频参考 · 点击续拍"):OneShotI18n.t("续拍：取最后一帧接着生成");
}

function refresh(n) { if (!n) return; render(n); if (sel.size === 1 && sel.has(n.id)) showPanel(); drawEdges(); }

function wire(n, el) {
  // drag the node (card or label); click selects
  const startDrag = e => {
    if (e.button !== 0 || spaceDown || e.target.closest(".plus, [contenteditable=true], [data-open-playlist], [data-node-start], [data-node-prompt], .node-document a, .node-document button")) return;
    const vid = e.target.closest("video");
    if (!canvasCanEdit()) { selectOnly(n.id); return; }
    // typing in a text node, or the video's control bar: select only, leave the element alone
    if (e.target.closest("textarea,audio") || (vid && e.clientY > vid.getBoundingClientRect().bottom - 52 * B.view.k)) {
      if (!sel.has(n.id) || sel.size > 1) { sel = new Set([n.id]); updateSel(); }
      return;
    }
    e.stopPropagation();
    if (vid) e.preventDefault();
    if (!sel.has(n.id)) { if (!e.shiftKey) sel.clear(); sel.add(n.id); updateSel(); }
    else if (e.shiftKey) { sel.delete(n.id); updateSel(); return; }
    if (nodeLocked(n)) return;
    const moving = [...sel].map(node).filter(m => m && !nodeLocked(m)), w0 = toW(e.clientX, e.clientY);
    const board = B;
    const validMove = () => B === board && canvasCanEdit() && moving.every(m=>els.has(m.id) && !nodeLocked(m));
    const starts = moving.map(m => [m.x, m.y]); let moved = false, before = snap(), last = e;
    const place = canvasDragPlacement(moving);
    const ap = autoPan(() => mv(last));
    const mv = ev => {
      if (!validMove()) { ap.stop(); clearCanvasGuides(); return; }
      last = ev;
      if (!moved && Math.abs(ev.clientX - e.clientX) + Math.abs(ev.clientY - e.clientY) < 4) return;
      if (!moved) { moved = true;liveStopFollow(false);moving.forEach(m => els.get(m.id)?.classList.add("dragging")); }
      ap.move(ev);
      const w = toW(ev.clientX, ev.clientY), groupTarget = ctGroupDropTarget(ev);
      const delta = place(w.x - w0.x,w.y - w0.y,ev.altKey || !!groupTarget);
      moving.forEach((m, i) => { m.x = Math.round(starts[i][0] + delta.x); m.y = Math.round(starts[i][1] + delta.y); const me = els.get(m.id); me.style.left = m.x + "px"; me.style.top = m.y + "px"; });
      drawEdges(); placeOverlays();
      ctMarkGroupDrop(groupTarget);
      const tabTarget = groupTarget ? null : vtDropTarget(moving);
      if (tabTarget) clearCanvasGuides();
      vtMarkDrop(tabTarget);
    };
    const up = ev => {
      if (moved && ev.type === "pointerup" && ev.altKey !== last.altKey) mv(ev);
      ap.stop(); removeEventListener("pointermove", mv); removeEventListener("pointerup", up);removeEventListener("pointercancel",up);
      removeEventListener("blur",up);
      clearCanvasGuides();
      moving.forEach(m => els.get(m.id)?.classList.remove("dragging"));
      const valid = validMove();
      const dropped=moved&&ev?.type==="pointerup"&&valid, groupTarget=dropped?ctGroupDropTarget(ev):null;
      ctMarkGroupDrop(null);vtMarkDrop(null);
      if (moved && valid && (groupTarget || !dropped)) {
        moving.forEach((m,i)=>{ [m.x,m.y]=starts[i]; render(m); });
        if (groupTarget) ctJoinFoldedGroup(groupTarget,moving,before);
        else { drawEdges(); placeOverlays(); drawMini(); }
        el._dragged=true;setTimeout(()=>el._dragged=false,0);return;
      }
      const mergeTarget=dropped?vtDropTarget(moving):null;
      if (mergeTarget?.data.playlist && appendFilmPlaylist(mergeTarget,moving,starts,before)) {
        el._dragged=true;setTimeout(()=>el._dragged=false,0);return;
      }
      if(mergeTarget&&vtMerge([...moving.map(m=>m.id),mergeTarget.id],mergeTarget.id,before)){
        for(const id of sel){const me=els.get(id);if(me){me._dragged=true;setTimeout(()=>me._dragged=false,0);}}return;
      }
      if (moved && valid) {
        el._dragged = true; setTimeout(() => el._dragged = false, 0);
        if (moving.some((m,i) => m.x !== starts[i][0] || m.y !== starts[i][1])) {
          undoStack.push(before); redoStack.length = 0; save();
        }
      }
    };
    addEventListener("pointermove", mv); addEventListener("pointerup", up);addEventListener("pointercancel",up);
    addEventListener("blur",up);
  };
  // a drag that started on a video must not also toggle play/pause
  el.addEventListener("click", ev => { if (el._dragged) { ev.preventDefault(); ev.stopPropagation(); } }, true);
  $(".card", el).addEventListener("pointerdown", startDrag);
  $(".lbl", el).addEventListener("pointerdown", startDrag);
  $(".card", el).addEventListener("dblclick", e => {
    if (n.type === "text" && e.target.closest(".node-document") && !e.target.closest("a,button")) {
      e.stopPropagation(); openTextDocument(n); return;
    }
    if (n.data.playlist && !e.target.closest("video")) { e.stopPropagation(); openFilm(n); return; }
    if (n.data.previs && !e.target.closest("video")) { e.stopPropagation(); openPrevis(n); return; }
    const v = curV(n);
    if (!v || !["image","video","audio"].includes(n.type) || e.target.closest("audio")) return;
    e.stopPropagation(); lightbox(v,n);
  });
  // rename
  const nm = $(".nm", el);
  nm.addEventListener("dblclick", e => { if (!canvasCanEdit()) return; e.stopPropagation(); nm.contentEditable = "true"; nm.focus(); document.getSelection().selectAllChildren(nm); });
  nm.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); nm.blur(); } });
  nm.addEventListener("blur", () => { if (nm.contentEditable !== "true") return; nm.contentEditable = "false"; const t = nm.textContent.trim(); if (t && t !== n.name) { checkpoint(); n.name = t; save(); refreshDownstream(n); } else nm.textContent = n.name; });
  // + handles
  const pr = $(".plus.r", el), pl = $(".plus.l", el);
  pr.addEventListener("pointerdown", e => {
    e.stopPropagation(); e.preventDefault();
    if (n.type === "video" && (!curV(n) || curV(n).source === "previs")) return;
    dragLink(n, e, () => { // click without drag: pick a downstream node type
      if (n.type==="video") {openVideoExtension(n);return;}
      openAddMenu(pr.getBoundingClientRect().right + 8, pr.getBoundingClientRect().top - 10, { from: n });
    });
  });
  pr.addEventListener("click", e => { if (n.type === "video" && (!curV(n) || curV(n).source === "previs")) { e.stopPropagation(); openVideoExtension(n); } });
  pl.addEventListener("pointerdown", e => { e.stopPropagation(); e.preventDefault(); const r = pl.getBoundingClientRect(); openAddMenu(r.left - 200, r.top - 10, { to: n }); });
  if (canvasMediaUploadTarget(n)) {
    el.addEventListener("click",e=>{
      if (e.target.closest("[data-node-prompt]")) {
        e.stopPropagation();
        focusNodePrompt(n);
        return;
      }
      const button=e.target.closest("[data-node-start]");
      if(!button)return;
      e.stopPropagation();
      if(node(n.id)!==n||!canvasCanEdit()||curV(n)||n.job||prepping.has(n.id))return;
      if(button.dataset.nodeStart==="agent"){
        void acNewNodeSession([{id:n.id}],{draft:n.data.prompt||"",emptyMediaNode:n.id}).catch(error=>toast(error.message));
      }else{
        focusNodePrompt(n);
      }
    });
    el.addEventListener("dragover", e => {
      const types=Array.from(e.dataTransfer?.types||[]);
      if(!canvasCanUploadInto(n)||!types.some(type=>type==="Files"||type==="application/x-h3-asset"))return;
      e.preventDefault();e.stopPropagation();el.classList.add("ok-target");
    });
    el.addEventListener("dragleave", e => {if(!el.contains(e.relatedTarget))el.classList.remove("ok-target");});
    el.addEventListener("drop", e => {
      el.classList.remove("ok-target");
      if (!canvasCanEdit()) return;
      const a=e.dataTransfer.getData("application/x-h3-asset"), files=e.dataTransfer.files;
      const asset=a?JSON.parse(a):null;
      const file=files.length===1&&canvasUploadKind(files[0])===n.type?files[0]:null;
      if(asset?.type!==n.type&&!file)return;
      e.preventDefault();e.stopPropagation();
      if(!canvasCanUploadInto(n)){toast("当前节点暂时无法接收文件");return;}
      if(file)void uploadInto(n,file);
      else addVersion(n,asset);
    });
  }
}
function refreshDownstream(n) { B.edges.filter(e => e.from === n.id).forEach(e => refresh(node(e.to))); }

function hideNodeToolTip() {
  const tip = $("#nodeToolTip"); tip.hidden = true;
  tip._button?.removeAttribute("aria-describedby"); tip._button = null;
}
function showNodeToolTip(button) {
  hideNodeToolTip();
  const tip = $("#nodeToolTip"), r = button.getBoundingClientRect();
  tip.textContent = button.dataset.tip; tip.hidden = false; tip._button = button;
  button.setAttribute("aria-describedby", "nodeToolTip");
  tip.style.left = Math.max(8, Math.min(innerWidth - tip.offsetWidth - 8, r.left + (r.width - tip.offsetWidth) / 2)) + "px";
  const below = r.bottom + 8;
  tip.style.top = Math.max(8, below + tip.offsetHeight <= innerHeight - 8 ? below : r.top - tip.offsetHeight - 8) + "px";
}

function nodeAction(n, a) {
  if (a === "text-document") return openTextDocument(n);
  if (a === "panorama") return openPanorama(n);
  if (!canvasCanEdit() && !["prev","next","full","compare-video","compare-draft","dl","gif-export","playlist-open"].includes(a)) return;
  const v = curV(n);
  if (a === "prev" || a === "next") { switchVersion(n, (n.cur + (a === "next" ? 1 : -1) + n.versions.length) % n.versions.length); }
  else if (a === "dl") { const x = document.createElement("a"); x.href = v.url; x.download = v.ref.split("/").pop(); x.click(); }
  else if (a === "full") lightbox(v,n);
  else if (a === "compare-video") openVideoCompare(n);
  else if (a === "compare-draft") openDraftComparison(n);
  else if (a === "broll") openBroll(n);
  else if (a === "unlock-node") markCanvasNodes([n.id],false,{lock:true});
  else if (a === "del") removeNodes([n.id]);
  else if (a === "dup") duplicate([n.id]);
  else if (a === "tovideo") { checkpoint(); const s = size(n); const at = freeSpot(n.x + s.w + 110, n.y, "video"); const m = addNode("video", at.x, at.y); link(n, m, true); selectOnly(m.id); }
  else if (a === "cont") openVideoExtension(n);
  else if (a === "extension-film") openExtensionTimeline(n);
  else if (a === "segment-edit") openSegmentEditor(n);
  else if (a === "camera-retake") openSegmentEditor(n,{retake:true});
  else if (a === "object-remove" || a === "object-replace") openSegmentEditor(n,{objectAction:a.slice(7)});
  else if (a === "object-settings") openObjectSettings(n);
  else if (a === "draft-final") openVideoDraftFinal(n);
  else if (a === "retake-settings") openRetakeSettings(n);
  else if (a === "segment-film") openSegmentTimeline(n);
  else if (a === "segment-review") openSegmentReview(n);
  else if (a === "segment-review-parent") openSegmentReview(n,true);
  else if (a === "trim-video") openVideoTrim(n);
  else if (a === "dialogue-review") void openDialogueReview(n,v);
  else if (a === "gif-export") openGifExport(n,v);
  else if (a === "capture") openFrameCapture(n);
  else if (["frame","firstframe","currentframe"].includes(a)) {
    const video = els.get(n.id)?.querySelector("video");
    const position = a==="firstframe"?"first":a==="frame"?"last":"time";
    if (position==="time" && !(video?.readyState>=1)) return openFrameCapture(n);
    captureOnCanvas(n.id,v,{position,at:position==="time"?video.currentTime:undefined})
      .catch(error=>toast("截帧失败："+error.message));
  }
  else if (a === "hd") hdRedraw(n);
  else if (a === "edit") openImageEditor(n);
  else if (a === "relight") return openImageEditor(n).then(()=>{if(IMAGE_EDITOR?.n===n)ieMode("relight");});
  else if (a === "image-camera") return openImageEditor(n).then(()=>{if(IMAGE_EDITOR?.n===n)ieMode("camera");});
  else if (a === "image-upscale") return openImageEditor(n).then(()=>{if(IMAGE_EDITOR?.n===n)ieMode("upscale");});
  else if (a === "image-decompose") return openImageEditor(n).then(()=>{if(IMAGE_EDITOR?.n===n)ieMode("layers");});
  else if (a === "image-pixels") return openImageEditor(n).then(()=>{
    const E=IMAGE_EDITOR;if(E?.n!==n || !E.image)return;
    ieMode("local");if(E.mode==="local"){ $("#iePixelSize").open=true;updatePixelPreview(E);$("#iePixelWidth").focus(); }
  });
  else if (a === "agent") acUseNode(n).catch(e => toast(e.message));
  else if (a === "describe") describeImage(n);
  else if (a === "analyze") analyzeVideo(n);
  else if (a === "remake") openVideoRemake(n);
  else if (a === "previs") openPrevis(n);
  else if (a === "previsvideo") usePrevisForVideo(n);
  else if (a === "audio-upload") pickAudio(file=>uploadInto(n,file));
  else if (a === "transcript") openAudioTranscript(n);
  else if (a === "separate-audio") openAudioSeparation(n);
  else if (a === "saved-transcript") openSavedTranscript(n);
  else if (a === "playlist-open") openFilm(n);
  else if (a === "film") {
    if (n.type === "video" && (!n.data.film || v?.film_recipe?.timeline)) editVideoTimeline(n);
    else if (n.data.film) openFilm(n);
    else openFilm([n]);
  }
  else if (a.startsWith("split")) { const [r, c] = a.slice(5).split("x").map(Number); splitGrid(n, r, c); }
  else if (a.startsWith("asset:")) saveAsset(n, a.slice(6));
}
