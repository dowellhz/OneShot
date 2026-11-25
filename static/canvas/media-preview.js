"use strict";

let lightState = null;

function pausePreviewMedia(container) {
  $$("video,audio", container).forEach(player => { if (!player.paused) player.pause(); });
}

function lightDockAssistant(show) {
  const dialog = $("#light"), pane = $("#agentChat"), notice = $("#toast");
  if (show) {
    acVoiceCancel();
    acPickPlacement(false);
    cmClose();
    dialog.append(pane,notice);
    dialog.classList.add("light-chat");
  } else if (pane?.parentElement === dialog) {
    cmClose();
    document.body.append(pane,notice);
    dialog.classList.remove("light-chat");
    if (dialog.open) $("[data-light-agent]",dialog)?.focus();
  }
}

function closeLightbox() {
  const dialog = $("#light");
  if (!lightState) return;
  const overlay = $(".light-view",dialog);
  overlay._disposeRegion?.();
  const {focus} = lightState;
  lightState = null;
  pausePreviewMedia(overlay);
  if (dialog.close) dialog.close(); else dialog.removeAttribute("open");
  lightDockAssistant(false);
  dialog.classList.remove("on");
  overlay.remove();
  if (focus?.isConnected) focus.focus({preventScroll:true});
}

function lightbox(version, source, {at,end,box}={}) {
  if (!version?.url) return;
  closeLightbox();
  const gallery = source ? byPosition(B.nodes.filter(n =>
    ["image","video","audio"].includes(n.type) && (n === source || !ctFolded(n.id)) &&
    curV(n)?.url).map(n => n.id)).map(n => n.id) : [];
  lightState = {gallery, nodeId:source?.id, focus:document.activeElement};
  const dialog = $("#light"), overlay = document.createElement("div");
  overlay.className = "light-view";
  dialog.append(overlay);
  renderLightbox(version, source, false, box);
  dialog.classList.add("on");
  if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open", "");
  const player=$("video,audio",overlay);
  if (player && Number.isFinite(at)) {
    player.autoplay=false;
    if(!player.paused)player.pause();
    const seek=()=>{player.currentTime=Number.isFinite(player.duration) ? Math.min(at,player.duration) : at;};
    if (player.readyState>=1)seek();else player.addEventListener("loadedmetadata",seek,{once:true});
    if(Number.isFinite(end) && end>at)lightReviewPlayback(overlay,player,at,end);
  }
  $("[data-light-close]", overlay).focus();
}

function lightReviewPlayback(overlay, player, at, end) {
  const status=$(".light-status",overlay), button=document.createElement("button");
  button.type="button";
  button.dataset.lightPlayReview="";
  button.textContent=`播放批注片段 · ${at.toFixed(2)}–${end.toFixed(2)} 秒`;
  let stop=end, playing=false;
  function ready() {
    stop=Number.isFinite(player.duration) ? Math.min(end,player.duration) : end;
    button.disabled=stop<=at;
    if(button.disabled)status.textContent="批注片段超出当前素材时长";
  }
  button.disabled=player.readyState<1;
  if(!button.disabled)ready();else player.addEventListener("loadedmetadata",ready,{once:true});
  button.onclick=async()=>{
    player.currentTime=at;
    playing=true;
    try{await player.play();}
    catch{playing=false;if(button.isConnected)status.textContent="无法播放批注片段";}
  };
  player.addEventListener("seeking",()=>{if(player.currentTime<at)playing=false;});
  player.addEventListener("pause",()=>{playing=false;});
  player.addEventListener("timeupdate",()=>{
    if(!playing || player.currentTime<stop)return;
    playing=false;
    player.pause();
    player.currentTime=stop;
  });
  status.before(button);
}

function lightNeighbor(offset) {
  const {gallery,nodeId} = lightState;
  const index = gallery.indexOf(nodeId);
  if (index < 0) return null;
  for (let i = index + offset; i >= 0 && i < gallery.length; i += offset) {
    const candidate = node(gallery[i]);
    if (curV(candidate)?.url && !ctFolded(candidate.id)) return candidate;
  }
  return null;
}

function lightNavigate(offset) {
  const target = lightNeighbor(offset);
  if (!target) return;
  lightState.nodeId = target.id;
  renderLightbox(curV(target), target);
}

function renderLightbox(version, source, comparing = false, reviewBox = null, overview = false) {
  const dialog = $("#light"), overlay = $(".light-view",dialog);
  overlay._disposeRegion?.();
  overlay._disposeRegion=null;
  const previousFocus = document.activeElement?.getAttributeNames().find(name => name.startsWith("data-light-"));
  const type = source?.type || cmMediaType(version.ref) || "image";
  const index = source?.versions.indexOf(version) ?? -1;
  const choices = (source?.versions || []).map((v,i) => ({v,i})).filter(({v}) => v.url);
  const active = curV(source);
  const previous = choices.findLast(({i,v}) => i < index && v.ref !== version.ref);
  const comparison = type === "image" && (active?.url && active.ref !== version.ref
    ? {v:active,i:source.cur} : previous || choices.find(({v})=>v.ref!==version.ref));
  const imageCompare = !!comparison;
  const videoCompareAvailable = type === "video" && choices.length > 1;
  const draftCompareAvailable = type === "video" && draftVideoComparison(source,version);
  const editable = index >= 0 && version.ref && canvasCanEdit() && !source.job && !prepping.has(source.id);
  const title = source?.name || version.ref?.split("/").pop() || "媒体";
  const prompt = [version.generation_record?.prompt,version.prompt,version.edit?.recipe?.prompt]
    .find(text => typeof text === "string" && text.trim());
  const effective = version.generation_record?.effective_prompt;
  const hasEffectivePrompt = typeof effective === "string" && effective.trim() && effective !== prompt;
  const transcripts = type === "audio" && source ? B.nodes.filter(n =>
    n.type === "text" && n.data.transcript?.source_node === source.id &&
    n.data.transcript.source_ref === version.ref && n.data.text?.trim()) : [];
  const webSource = version.web_source;
  const origin = publicResearchLink(webSource?.link);
  const license = publicResearchLink(webSource?.license_url);
  const usedAssets = Array.isArray(version.memory_used) ? version.memory_used.filter(asset => asset?.name) : [];
  const hasDetails = prompt || hasEffectivePrompt || transcripts.length || origin || usedAssets.length;
  const editLabel = type === "image" ? (index === source?.cur ? "编辑图片" : "切到此版本并编辑") :
    type === "video" ? "剪辑视频" : "转写音频";
  const media = (v, label) => type === "audio" ? audioPreviewMarkup(v,true) : type === "image" ? `<img src="${esc(v.url)}" alt="${esc(label)}">` :
    `<${type} src="${esc(v.url)}" aria-label="${esc(label)}" controls ${type === "video" ? "autoplay playsinline" : ""}></${type}>`;
  function tile({v,i}) {
    const thumb = type === "image" ? `<img src="${esc(v.url)}" alt="" loading="lazy">` :
      type === "video" ? `<video src="${esc(v.url)}#t=0.001" preload="metadata" loading="lazy" muted playsinline aria-hidden="true"></video>` : ico("audio");
    return OneShotI18n.html`<button type="button" data-light-tile="${i}" ${i===index?'aria-current="true"':""}>
      <span class="light-tile-media">${thumb}</span>
      <strong>版本 ${i+1}${i===source.cur?" · 画布当前":""}</strong>
      ${v.label?`<small>${esc(v.label)}</small>`:""}
      ${v.seconds>0?OneShotI18n.html`<small>${Number(v.seconds).toFixed(1)} 秒</small>`:""}</button>`;
  }
  pausePreviewMedia(overlay);
  overlay._peekPrevious=null;
  if (type !== "image") pausePreviewMedia($("#world"));
  overlay.innerHTML = OneShotI18n.html`
    <header class="light-header">
      <div class="light-navigation">
        <button type="button" data-light-prev title="上一个素材" aria-label="上一个素材" ${lightNeighbor(-1) ? "" : "disabled"}>${ico("left")}</button>
        <button type="button" data-light-next title="下一个素材" aria-label="下一个素材" ${lightNeighbor(1) ? "" : "disabled"}>${ico("right")}</button>
      </div>
      <h2 id="lightTitle" title="${esc(title)}">${esc(title)}</h2>
      <button type="button" data-light-close title="关闭预览" aria-label="关闭预览">×</button>
    </header>
    <div class="light-body">
      ${overview ? OneShotI18n.html`<section class="light-version-grid" aria-label="所有版本">${choices.map(tile).join("")}</section>` :
        `<div class="light-stage">
        ${comparing && comparison ? `<figure><figcaption>${comparison.i===source.cur?"画布当前版本":"版本 "+(comparison.i+1)}</figcaption>
          ${media(comparison.v,"版本 " + (comparison.i+1))}</figure>
          <figure><figcaption>预览版本 ${index + 1}</figcaption>${media(version,"预览版本 " + (index + 1))}</figure>` : media(version,title)}
        </div>`}
      ${!overview && hasDetails ? OneShotI18n.html`<aside id="lightDetails" aria-label="版本信息" hidden>
        ${origin ? `<h3>公开素材来源</h3><a href="${esc(origin)}" target="_blank" rel="noopener noreferrer">${esc(webSource.title || "查看原始来源")}</a>
          ${webSource.credit ? `<p>作者 · ${esc(webSource.credit)}</p>` : ""}
          ${license ? `<a href="${esc(license)}" target="_blank" rel="noopener noreferrer">${esc(webSource.license || "查看许可")}</a>` : esc(webSource.license || "")}` : ""}
        ${prompt ? OneShotI18n.html`<h3>提示词</h3><pre>${esc(prompt)}</pre>` : ""}
        ${hasEffectivePrompt ? OneShotI18n.html`<details ${prompt ? "" : "open"}><summary>生成时使用的提示词</summary><pre>${esc(effective)}</pre></details>` : ""}
        ${prompt || hasEffectivePrompt ? OneShotI18n.markup('<button type="button" data-light-copy-prompt>复制提示词</button>') : ""}
        ${usedAssets.length ? OneShotI18n.html`<h3>生成时使用的资产</h3><ul>${usedAssets.map(asset => {
          const refs = Array.isArray(asset.references) ? asset.references :
            asset.ref ? [{ref:asset.ref}] : [];
          const links = refs.filter(item=>item?.ref).map(item=>{
            const {ref,view,start,end}=item, kind=cmMediaType(ref,item);
            const label=CHARACTER_VIEWS[view]?.[0] || ({video:"参考视频",audio:"参考音频"}[kind] || "参考图");
            const hasRange=(kind==="video"||kind==="audio") && Number.isFinite(start) && Number.isFinite(end) && start>=0 && end>start;
            const fragment=hasRange ? `#t=${start},${end}` : "";
            const caption=hasRange ? `${label} ${Number(start.toFixed(2))}–${Number(end.toFixed(2))} 秒` : label;
            return `<a href="/media?ref=${encodeURIComponent(ref)}${fragment}" target="_blank" rel="noopener">${esc(caption)}</a>`;
          });
          return `<li>${esc(asset.name)}${links.length ? " · "+links.join("、") : ""}</li>`;
        }).join("")}</ul>` : ""}
        ${transcripts.map(n => `<details open><summary>${esc(n.name)}</summary><pre>${esc(n.data.text)}</pre></details>`).join("")}
        <p class="light-details-status" role="status"></p>
      </aside>` : ""}
    </div>
    <footer class="light-actions">
      ${overview ? '<button type="button" data-light-overview aria-pressed="true">返回单个版本</button>' : OneShotI18n.html`
      ${choices.length > 1 ? OneShotI18n.html`<select data-light-version aria-label="预览版本">${choices.map(({v,i}) =>
        OneShotI18n.html`<option value="${i}" ${i === index ? "selected" : ""}>版本 ${i + 1}${i === source.cur ? " · 当前" : ""}${v.label ? " · " + esc(v.label) : ""}</option>`).join("")}</select>` : ""}
      ${choices.length > 1 ? OneShotI18n.markup('<button type="button" data-light-overview aria-pressed="false">所有版本</button>') : ""}
      ${imageCompare || videoCompareAvailable ? `<button type="button" data-light-compare>${comparing ? "结束对比" : "对比版本"}</button>` : ""}
      ${draftCompareAvailable ? '<button type="button" data-light-compare-draft>对比样片与定稿</button>' : ""}
      ${editable && type==="video" && version.draft_expires ? '<button type="button" data-light-draft-final>从此样片生成定稿</button>' : ""}
      ${type==="image" && previous && !comparing ? '<button type="button" data-light-peek title="按住反斜杠键或此按钮">按住看上一版</button>' : ""}
      ${hasDetails ? OneShotI18n.markup('<button type="button" data-light-details aria-controls="lightDetails" aria-expanded="false">版本信息</button>') : ""}
      ${index>=0 && hasGenerationDraft(source,version) ? '<button type="button" data-light-generation-draft>用此版本改稿</button>' : ""}
      ${index>=0 && canReuseGenerationAssets(source,version) ? '<button type="button" data-light-replay-assets>沿用原资产改稿</button>' : ""}
      ${index >= 0 && version.ref && canvasCanEdit() ? '<button type="button" data-light-agent aria-controls="agentChat" aria-keyshortcuts="Meta+J Control+J /">和助手讨论此版本</button>' : ""}
      ${index >= 0 && vtCanCopyVersion(source,index) ? OneShotI18n.markup('<button type="button" data-light-copy>放入画布</button>') : ""}
      ${index >= 0 && version.ref ? `<button type="button" data-light-comment>${type === "image" ? "批注此版本" : "批注当前时间"}</button>` : ""}
      ${index >= 0 && version.ref && type === "image" && !comparing ? '<button type="button" data-light-mark-region>框选批注</button><button type="button" data-light-save-region hidden>填写区域批注</button><button type="button" data-light-cancel-region hidden>取消框选</button>' : ""}
      ${index >= 0 && version.ref && ["video","audio"].includes(type) ? '<button type="button" data-light-range>标记片段</button><button type="button" data-light-cancel-range hidden>取消标记</button>' : ""}
      ${index >= 0 && version.ref && canvasCanEdit() && ["video","audio"].includes(type) ? OneShotI18n.markup('<button type="button" data-light-separate>人声分离</button>') : ""}
      ${editable ? `<button type="button" data-light-edit title="${esc(editLabel)}（E）">${editLabel}</button>` : ""}
      <a href="${esc(version.url)}" download="${esc(version.ref?.split("/").pop())}">下载</a>
      <span class="light-status" role="status"></span>
      <button type="button" data-light-locate hidden>在画布定位</button>`}
    </footer>`;
  const bind = (name, action) => {
    const control = $(`[data-light-${name}]`,overlay);
    if (control) control[control.tagName === "SELECT" ? "onchange" : "onclick"] = action;
  };
  if(type==="audio"&&!overview)bindAudioPreview(overlay,version);
  function currentSource(at) {
    const current = source && node(source.id);
    const expected = choices.find(entry => entry.i === at)?.v;
    if (expected?.ref && current?.versions[at]?.ref === expected.ref && current.versions[at].url) return current;
    const status = $(".light-status",overlay);
    if (status) status.textContent = "画布上的版本已变更，请重新打开预览";
    else toast("画布上的版本已变更，请重新打开预览");
    return null;
  }
  bind("close",closeLightbox);
  bind("prev",() => lightNavigate(-1));
  bind("next",() => lightNavigate(1));
  bind("overview",() => {
    const current = currentSource(index);
    if (!current) return;
    renderLightbox(current.versions[index],current,false,null,!overview);
    if (!overview) $('[data-light-tile][aria-current="true"]',overlay)?.focus();
  });
  $$("[data-light-tile]",overlay).forEach(button=>button.onclick=()=>{
    const at = Number(button.dataset.lightTile);
    const current = currentSource(at);
    if (!current) return;
    renderLightbox(current.versions[at],current);
    $("[data-light-overview]",overlay)?.focus();
  });
  const peekButton = $("[data-light-peek]",overlay);
  if (peekButton) {
    const stage = $(".light-stage",overlay), main = $("img",stage);
    overlay._peekPrevious = show => {
      if (show && main.classList.contains("light-region-drawing")) return;
      let peek = $(".light-peek",stage);
      if (show && !peek) {
        peek = document.createElement("img");
        peek.className = "light-peek";
        peek.src = previous.v.url;
        peek.alt = "上一版 · 版本 " + (previous.i + 1);
        stage.append(peek);
      }
      if (peek) peek.hidden = !show;
      main.classList.toggle("light-peek-replaced",show);
    };
    peekButton.onpointerdown = e => {
      if (e.button !== 0) return;
      peekButton.setPointerCapture?.(e.pointerId);
      overlay._peekPrevious(true);
    };
    peekButton.onpointerup = peekButton.onpointercancel = peekButton.onlostpointercapture =
      peekButton.onblur = () => overlay._peekPrevious(false);
    peekButton.onkeydown = e => {
      if ([" ","Enter"].includes(e.key)) { e.preventDefault(); overlay._peekPrevious(true); }
    };
    peekButton.onkeyup = () => overlay._peekPrevious(false);
  }
  bind("agent",async event => {
    const button = event.currentTarget;
    if (!canvasCanEdit() || !currentSource(index)) return;
    if (!dialog.classList.contains("light-chat")) lightDockAssistant(true);
    button.disabled = true;
    try {
      await acOpen({focus:false});
      if (!button.isConnected || !dialog.open || !dialog.classList.contains("light-chat")) return;
      const current = currentSource(index);
      if (!current || !canvasCanEdit()) return;
      const status = $(".light-status",overlay);
      if (acAttachNodeReference(current,version.ref,message => {status.textContent = message;})) {
        status.textContent = "已引用此版本";
        $("#acInput").focus();
      }
    } finally {
      button.disabled = false;
    }
  });
  bind("details",event => {
    const details = $("#lightDetails",overlay);
    details.hidden = !details.hidden;
    event.currentTarget.setAttribute("aria-expanded",String(!details.hidden));
  });
  bind("copy-prompt",async () => {
    const status = $(".light-details-status",overlay);
    try { await acCopyText(prompt || effective); status.textContent = OneShotI18n.t("已复制提示词"); }
    catch { status.textContent = OneShotI18n.t("复制失败，可选中文字后复制"); }
  });
  const reuseDraft = reuseAssets => {
    const current=currentSource(index);
    if (!current || !loadGenerationDraft(current,current.versions[index],message=>{
      $(".light-status",overlay).textContent=message;
    },{reuseAssets})) return;
    closeLightbox();
    focusNodePrompt(current);
  };
  bind("generation-draft",()=>reuseDraft(false));
  bind("replay-assets",()=>reuseDraft(true));
  bind("version",event => {
    const at = Number(event.target.value);
    const current = currentSource(at);
    if (current) renderLightbox(current.versions[at],current);
    else event.target.value = String(index);
  });
  bind("copy",() => {
    const current = currentSource(index);
    const copy = current && vtCopyVersion(current,index);
    if (!copy) return;
    $(".light-status",overlay).textContent = OneShotI18n.t("已放入画布");
    const locate = $("[data-light-locate]",overlay);
    locate.hidden = false;
    locate.onclick = () => {
      const target = node(copy.id);
      if (!target) { $(".light-status",overlay).textContent = "已复制的节点已移除"; locate.hidden = true; return; }
      closeLightbox();
      selectOnly(target.id);
      fit([target]);
    };
  });
  bind("comment",() => {
    const current=currentSource(index);
    if(!current)return;
    const at=$("video,audio",overlay)?.currentTime;
    closeLightbox();
    ccNode(current,current.versions[index],at);
  });
  overlay._disposeRegion=lightRegionAnnotation(overlay,reviewBox,box=>{
    const current=currentSource(index);
    if(!current)return;
    closeLightbox();
    ccNode(current,current.versions[index],undefined,undefined,box);
  });
  let rangeStart=null;
  function showRange() {
    const started=rangeStart!==null;
    $("[data-light-range]",overlay).textContent=started?"在此结束并批注":"标记片段";
    $("[data-light-cancel-range]",overlay).hidden=!started;
    $(".light-status",overlay).textContent=started?`起点 ${rangeStart.toFixed(2)} 秒 · 移动播放头选择终点`:"";
  }
  bind("range",()=>{
    const current=currentSource(index);
    if(!current)return;
    const player=$("video,audio",overlay), at=Math.round(player.currentTime*1000)/1000;
    if(!Number.isFinite(at))return;
    if (rangeStart===null) {
      rangeStart=at;
      if(!player.paused)player.pause();
      showRange();
    } else if (at<=rangeStart) {
      $(".light-status",overlay).textContent=`终点必须晚于起点 ${rangeStart.toFixed(2)} 秒`;
    } else {
      closeLightbox();
      ccNode(current,current.versions[index],rangeStart,at);
    }
  });
  bind("cancel-range",()=>{rangeStart=null;showRange();});
  bind("separate",()=>{
    const current=currentSource(index);
    if(!current||!canvasCanEdit())return;
    closeLightbox();
    openAudioSeparation(current,current.versions[index]);
  });
  bind("compare",() => {
    const current = currentSource(index);
    if (!current) return;
    if (videoCompareAvailable) {
      closeLightbox();
      openVideoCompare(current,index);
    } else {
      renderLightbox(current.versions[index],current,!comparing && imageCompare);
    }
  });
  bind("compare-draft",() => {
    const current = currentSource(index);
    if (!current) return;
    closeLightbox();
    openDraftComparison(current,current.versions[index]);
  });
  bind("draft-final",() => {
    const current = currentSource(index);
    if (!current) return;
    closeLightbox();
    openVideoDraftFinal(current,current.versions[index]);
  });
  bind("edit",() => {
    const current = currentSource(index);
    if (!current || !canvasCanEdit()) return;
    if (current.job || prepping.has(current.id) || type === "image" && (IMAGE_EDITOR?.busy || IMAGE_EDITOR?.agentSelection)) {
      $(".light-status",overlay).textContent = OneShotI18n.t("请等待当前任务完成后再编辑");
      return;
    }
    if (type === "image" && index !== current.cur && !switchVersion(current,index)) return;
    closeLightbox();
    if (type === "audio") openAudioTranscript(current,null,current.versions[index]);
    else if (type === "video" && index !== current.cur) editVideoTimeline(current,current.versions[index]);
    else nodeAction(current,type === "image" ? "edit" : "film");
  });
  if (dialog.open && !$("#agentChat")?.contains(document.activeElement)) {
    const control = previousFocus && $(`[${previousFocus}]`,overlay);
    (control && !control.disabled ? control : $("[data-light-close]",overlay)).focus();
  }
}
$("#light").addEventListener("cancel", e => { e.preventDefault(); closeLightbox(); });
$("#light").addEventListener("click", e => { if (e.target === e.currentTarget || e.target.matches(".light-stage")) closeLightbox(); });
