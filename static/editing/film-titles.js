"use strict";

const FILM_TITLE_POSITIONS = {center:"居中", top:"上方", lower_left:"左下"};
const FILM_TITLE_STYLES = {plain:"描边文字", label:"深色底牌"};
const FILM_TITLE_LIMIT = 20;

function addFilmTitle(F) {
  const titles = F.spec.titles ||= [];
  if (titles.length >= FILM_TITLE_LIMIT) return toast("时间线最多可添加 20 条标题");
  const total = filmTotal(F.spec);
  if (total <= 0) return;
  const start = Math.floor(Math.max(0, Math.min(timelinePos(), total - 1 / FILM_FPS)) * 100) / 100;
  const end = Math.min(total, start + 2.5);
  titles.push({text:"",start,end,position:"center",style:"plain"});
  renderFilmTitles();
  $(`[data-title-index="${titles.length - 1}"] [data-title-key=text]`).focus();
  saveFilmDraft(F);
}

function renderFilmTitles() {
  const F = FILM, host = $("#fmTitleSettings"), titles = F.spec.titles || [];
  const choices = (values, selected) => Object.entries(values).map(([value,label]) =>
    `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`).join("");
  host.innerHTML = titles.map((title,i) => OneShotI18n.html`<div class="nar fm-title-edit" data-title-index="${i}">
    <label>文字<input type="text" maxlength="120" data-title-key="text" value="${esc(title.text)}" aria-label="第 ${i+1} 条标题文字"></label>
    <div class="nr"><label>开始（秒）<input type="number" min="0" step="any" data-title-key="start" value="${esc(title.start)}"></label>
      <label>结束（秒）<input type="number" min="0" step="any" data-title-key="end" value="${esc(title.end)}"></label></div>
    <div class="nr"><label>位置<select data-title-key="position">${choices(FILM_TITLE_POSITIONS,title.position)}</select></label>
      <label>样式<select data-title-key="style">${choices(FILM_TITLE_STYLES,title.style)}</select></label></div>
    <div class="nr"><button class="pill" type="button" data-title-locate>定位</button>
      <button class="pill" type="button" data-title-remove>删除</button></div>
  </div>`).join("");
  $$("[data-title-index]", host).forEach(row => {
    const index = Number(row.dataset.titleIndex), title = titles[index];
    const update = () => { renderFilmTitleLane(); renderFilmTitlePreview(timelinePos()); saveFilmDraft(F); };
    $("[data-title-key=text]", row).oninput = e => { title.text = e.target.value; update(); };
    $$("select[data-title-key]", row).forEach(input => input.onchange = () => {
      title[input.dataset.titleKey] = input.value;
      update();
    });
    $$("input[type=number]", row).forEach(input => input.onchange = () => {
      const key = input.dataset.titleKey, value = input.valueAsNumber;
      const start = key === "start" ? value : title.start, end = key === "end" ? value : title.end;
      if (!Number.isFinite(value) || !(0 <= start && start < end)) {
        input.value = title[key];
        toast("标题结束时间须晚于开始时间");
        return;
      }
      title[key] = value;
      update();
    });
    $("[data-title-locate]", row).onclick = () => seekTimeline(Math.min(title.start,filmTotal(F.spec)));
    $("[data-title-remove]", row).onclick = () => {
      titles.splice(index,1);
      renderFilmTitles();
      saveFilmDraft(F);
    };
  });
  renderFilmTitleLane();
  sizeFilmTitleLayer();
  renderFilmTitlePreview(timelinePos());
}

function renderFilmTitleLane() {
  const F = FILM, host = $("#fmTitleLanes"), titles = F.spec.titles || [], total = filmTotal(F.spec);
  host.hidden = !titles.length;
  host.innerHTML = titles.map((title,i) => {
    const start = Math.min(total, title.start), end = Math.min(total, title.end);
    const inside = start < end;
    const label = title.text.trim() || "空白标题";
    const pos = inside ? `left:${100*start/total}%;width:${100*(end-start)/total}%` : "left:0";
    return `<div class="fm-title-lane"><button type="button" data-title-jump="${i}" style="${pos}" title="${esc(label)}">
      ${esc(label)}${inside ? "" : " · 超出成片范围"}</button></div>`;
  }).join("");
  $$("[data-title-jump]", host).forEach(button => button.onclick = () => {
    const i = Number(button.dataset.titleJump);
    seekTimeline(Math.min(titles[i].start,total));
    $(`[data-title-index="${i}"] [data-title-key=text]`).focus();
  });
}

function sizeFilmTitleLayer() {
  if (!FILM) return;
  const host = $("#film-output"), frame = host.getBoundingClientRect();
  const {spec} = FILM;
  const [w,h] = (spec.aspect || "").split(":").map(Number);
  let aspect = w > 0 && h > 0 ? w / h : 0;
  if (!aspect) {
    const first = spec.clips[0];
    if (!first) return;
    const ref = spec.remake_audio || filmVersion(first)?.ref;
    const version = node(first.node)?.versions?.find(v => v.ref === ref)
      || B.nodes.flatMap(n => n.versions || []).find(v => v.ref === ref);
    if (version?.w > 0 && version.h > 0) aspect = version.w / version.h;
    else if (FILM.sel === 0) {
      const video = $("#fmV"), image = $("#fmStill");
      aspect = first.kind === "image" ? image.naturalWidth / image.naturalHeight : video.videoWidth / video.videoHeight;
    }
  }
  if (!frame.width || !frame.height) return;
  const ratio = aspect > 0 ? aspect : frame.width / frame.height;
  host.style.setProperty("--fm-frame-width",`${Math.min(frame.width,frame.height*ratio)}px`);
  host.style.setProperty("--fm-frame-height",`${Math.min(frame.height,frame.width/ratio)}px`);
}

function renderFilmTitlePreview(time) {
  const F = FILM;
  if (!F) return;
  const layer = $("#fmTitleLayer");
  const active = (F.spec.titles || []).filter(title => title.start <= time && time < title.end && title.text.trim());
  const signature = JSON.stringify(active);
  if (layer._signature === signature) return;
  layer._signature = signature;
  layer.replaceChildren(...active.map(title => {
    const item = document.createElement("span");
    item.className = "fm-title-block";
    item.dataset.position = title.position;
    item.dataset.style = title.style;
    item.textContent = title.text.trim();
    return item;
  }));
}
