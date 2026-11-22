"use strict";

const FILM_CUTAWAY_LIMIT = 24;

function addFilmCutaway(F, node) {
  const version = curV(node);
  if (!version || FILM !== F) return;
  const items = F.spec.cutaways ||= [];
  if (items.length >= FILM_CUTAWAY_LIMIT) return toast("时间线最多可添加 24 段补画面");
  const total = filmTotal(F.spec);
  const start = Math.max(0,Math.min(total,Math.floor(timelinePos()*1000)/1000));
  if (items.some(item => item.start <= start && start < item.start + item.duration)) return toast("请把播放头移到补画面轨的空白处");
  const next = Math.min(total,...items.filter(item => item.start > start).map(item => item.start));
  const sourceSeconds = node.type === "video" ? vlen(node) : null;
  const duration = Math.min(2.5,next-start,sourceSeconds ?? Infinity);
  if (duration < 1/FILM_FPS) return toast("当前位置没有可用的补画面时长");
  items.push({node:node.id,ref:version.ref,name:node.name,version:node.cur+1,kind:node.type,start,duration,in:0,seconds:sourceSeconds});
  renderFilmCutaways();
  previewTick();
  saveFilmDraft(F);
}

function renderFilmCutaways() {
  const F = FILM, host = $("#fmCutawaySettings"), items = F.spec.cutaways || [];
  host.innerHTML = items.map((item,i) => `<div class="nar fm-cutaway-edit" data-cutaway-index="${i}">
    <div class="nr"><b>${esc(item.name || "补画面")}${item.version ? ` · 版本 ${esc(item.version)}` : ""}</b></div>
    <div class="nr"><label>开始（秒）<input type="number" min="0" step="any" data-cutaway-key="start" value="${esc(item.start)}"></label>
      <label>时长（秒）<input type="number" min="0" step="any" data-cutaway-key="duration" value="${esc(item.duration)}"></label></div>
    ${item.kind === "video" ? `<label>原片入点（秒）<input type="number" min="0" step="any" data-cutaway-key="in" value="${esc(item.in)}"></label>` : ""}
    <div class="nr"><button class="pill" type="button" data-cutaway-locate>定位</button>
      <button class="pill" type="button" data-cutaway-remove>删除</button></div>
  </div>`).join("");
  $$("[data-cutaway-index]",host).forEach(row => {
    const index = Number(row.dataset.cutawayIndex), item = items[index];
    $$("input[data-cutaway-key]",row).forEach(input => input.onchange = () => {
      const key = input.dataset.cutawayKey, value = input.valueAsNumber, changed = {...item,[key]:value};
      const end = changed.start + changed.duration;
      let error = "";
      if (!Number.isFinite(value) || value < 0 || changed.duration < 1/FILM_FPS || !Number.isFinite(end)) error = "请填写有效的开始时间、时长和原片入点";
      else if (item.kind === "video" && changed.in + changed.duration > item.seconds + 1e-6) error = "补画面的出点超出原片范围";
      else if (items.some(other => other !== item && end > other.start + 1e-6 && changed.start + 1e-6 < other.start + other.duration)) error = "补画面的时间不能重叠";
      if (error) { input.value = item[key]; return toast(error); }
      item[key] = value;
      renderFilmCutawayLane();
      previewTick();
      saveFilmDraft(F);
    });
    $("[data-cutaway-locate]",row).onclick = () => seekTimeline(Math.min(item.start,filmTotal(F.spec)));
    $("[data-cutaway-remove]",row).onclick = () => {
      items.splice(index,1);
      renderFilmCutaways();
      previewTick();
      saveFilmDraft(F);
    };
  });
  renderFilmCutawayLane();
}

function renderFilmCutawayLane() {
  const F = FILM, host = $("#fmCutawayLane"), items = F.spec.cutaways || [], total = filmTotal(F.spec);
  host.hidden = !items.length;
  $("#fmMainPlay").hidden = host.hidden;
  host.innerHTML = items.map((item,i) => {
    const start = Math.min(total,item.start), end = Math.min(total,item.start+item.duration);
    const position = start < end ? `left:${100*start/total}%;width:${100*(end-start)/total}%` : "left:0";
    const name = esc(item.name || "补画面");
    return `<button type="button" data-cutaway-jump="${i}" style="${position}" title="${name} · ${esc(item.start)} 秒">
      ${name}${start < end ? "" : " · 超出成片范围"}</button>`;
  }).join("");
  $$("[data-cutaway-jump]",host).forEach(button => button.onclick = () => {
    const i = Number(button.dataset.cutawayJump);
    seekTimeline(Math.min(items[i].start,total));
    $(`[data-cutaway-index="${i}"] input`).focus();
  });
}

function clearFilmCutawayPreview() {
  const layer = $("#fmCutawayLayer"), previous = $("video",layer);
  if (previous && !previous.paused) previous.pause();
  layer.hidden = true;
  layer.replaceChildren();
}

function previewFilmCutaway(F, time, playing) {
  const layer = $("#fmCutawayLayer");
  const item = (F.spec.cutaways || []).find(clip => clip.start <= time && time < clip.start + clip.duration);
  if (!item) {
    if (layer.childElementCount) clearFilmCutawayPreview();
    return;
  }
  let media = layer.firstElementChild;
  if (media?._clip !== item) {
    clearFilmCutawayPreview();
    media = document.createElement(item.kind === "video" ? "video" : "img");
    media._clip = item;
    const reveal = () => {
      if (FILM === F && layer.firstElementChild === media) previewTick();
    };
    if (item.kind === "video") {
      media.muted = true;
      media.playsInline = true;
      media.preload = "auto";
      media.onloadeddata = reveal;
    } else {
      media.alt = "";
      media.onload = reveal;
    }
    layer.append(media);
    media.src = remakeMedia(item.ref);
  }
  if (item.kind === "image") { layer.hidden = !media.complete || !media.naturalWidth; return; }
  if (media.readyState < 2 || media.error) { layer.hidden = true; return; }
  const at = Math.min(media.duration,item.in + time - item.start);
  const tolerance = playing && media._positioned ? .15 : .012;
  if (!media.seeking && Math.abs(media.currentTime-at) > tolerance) media.currentTime = at;
  media._positioned = true;
  layer.hidden = false;
  if (playing && media.paused && !media._playPending) {
    media._playPending = true;
    media.play().catch(() => {}).finally(() => { media._playPending = false; });
  } else if (!playing && !media.paused) media.pause();
}
