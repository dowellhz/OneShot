"use strict";

function initFilmTrackEditor() {
  $("#film .hd").insertAdjacentHTML("beforeend",OneShotI18n.html`
    <button id="fmTrackSwitch" class="pill" type="button" aria-pressed="false">多轨时间线</button>`);
  $("#fmAudioLanes").insertAdjacentHTML("afterend",OneShotI18n.html`
    <section id="fmTracks" aria-label="多轨时间线" hidden>
      <div class="fm-track-tools">
        <button class="pill" data-track-action="add" type="button">＋ 添加片段</button>
        <button class="pill" data-track-action="split" type="button">分割</button>
        <button class="pill" data-track-action="remove" type="button" title="Delete">移除片段</button>
        <div class="fm-track-toolgroup" role="group" aria-label="编辑历史">
          <button class="pill" data-track-action="undo" type="button">撤销剪辑</button>
          <button class="pill" data-track-action="redo" type="button">重做剪辑</button>
        </div>
        <label><input id="fmTrackSnap" type="checkbox" checked>吸附</label>
        <div class="fm-track-toolgroup fm-track-zoom" role="group" aria-label="时间线缩放">
          <button class="pill" data-track-action="out" type="button" aria-label="缩小时间线">−</button>
          <output id="fmTrackZoom">100%</output>
          <button class="pill" data-track-action="in" type="button" aria-label="放大时间线">＋</button>
          <button class="pill" data-track-action="fit" type="button">适合窗口</button>
        </div>
      </div>
      <div id="fmTrackViewport" tabindex="0" aria-label="时间线轨道"><div id="fmTrackContent"></div></div>
    </section>`);
  $("#fmTrackSwitch").onclick = () => {
    if (!FILM) return;
    const state = filmTrackState(FILM);
    state.open = !state.open;
    closePlaylistClipMenu();
    renderFilmTrackEditor();
  };
  $("#fmTrackSnap").onchange = event => { if (FILM) filmTrackState(FILM).snap = event.target.checked; };
  $("#fmTracks .fm-track-tools").onclick = event => {
    const button = event.target.closest("[data-track-action]");
    if (!button || !FILM) return;
    const state = filmTrackState(FILM);
    const action = button.dataset.trackAction;
    if (action==="add") return addClipMenu(event);
    if (action==="remove") return filmTrackRemoveSelection(FILM);
    if (action==="split") return filmTrackSplitSelection(FILM);
    if (action==="undo" || action==="redo") return stepFilmTrackHistory(FILM,action==="undo");
    setFilmTrackZoom(FILM,action==="fit" ? 1 : action==="in" ? state.zoom*2 : state.zoom/2);
  };
}

function filmTrackState(F) {
  return F.tracks ||= {open:false,zoom:1,snap:true,undo:[],redo:[]};
}

function filmTracksEditable(F) {
  return FILM===F && F.board===boardId && !F.busy && canvasCanEdit();
}

function queueFilmTrackEditor(F = FILM) {
  const state = F?.tracks;
  if (!state?.open || state.queued) return;
  state.queued = true;
  queueMicrotask(() => {
    state.queued = false;
    if (FILM!==F) return;
    if (state.dragging) state.refreshAfterDrag = true;
    else renderFilmTrackEditor();
  });
}

function setFilmTrackZoom(F, zoom) {
  const viewport = $("#fmTrackViewport"), ruler = $(".fm-track-ruler",viewport);
  const left = viewport.scrollLeft;
  const oldWidth = ruler?.getBoundingClientRect().width || 0;
  filmTrackState(F).zoom = Math.max(1,Math.min(zoom,16));
  renderFilmTrackEditor();
  const width = $(".fm-track-ruler",viewport)?.getBoundingClientRect().width || 0;
  viewport.scrollLeft = zoom===1 ? 0 : oldWidth ? left*width/oldWidth : left;
}

function filmTrackRuler(length, zoom) {
  const approximate = length/(8*zoom), base = 10 ** Math.floor(Math.log10(approximate));
  const step = Math.max(.25,([1,2,5,10].find(value=>value*base>=approximate)||10)*base);
  const ticks = [];
  for (let i=0;i*step<length;i++) {
    const time = i*step;
    ticks.push(`<span style="left:${100*time/length}%">${Number(time.toFixed(2))}s</span>`);
  }
  return ticks.join("");
}

function renderFilmTrackEditor() {
  const F = FILM, host = $("#fmTracks");
  if (!host) return;
  const state = F && filmTrackState(F), show = !!state?.open;
  host.hidden = !show;
  $("#film").classList.toggle("fm-multitrack",show);
  $("#fmMainPlay").hidden = !show && !F?.spec.cutaways?.length;
  $("#fmTrackSwitch").setAttribute("aria-pressed",String(show));
  if (!show) {
    state?.waveformObserver?.disconnect();
    $("#fmTrackContent").replaceChildren();
    return;
  }
  const length = filmTotal(F.spec) || 1, content = $("#fmTrackContent");
  const rows = filmTrackRows(F.spec).filter(row=>row.type==="picture" || row.items.length);
  const editable = filmTracksEditable(F), items = [];
  const focused = document.activeElement?.closest("[data-track-item]")?._trackItem;
  content.style.width = `${state.zoom * 100}%`;
  content.innerHTML = `<div class="fm-track-name fm-track-ruler-name">${esc(OneShotI18n.t("时间线"))}</div>
    <div class="fm-track-ruler">${filmTrackRuler(length,state.zoom)}</div>` + rows.map(row=>{
    const lanes = packFilmTrack(row.items);
    return `<div class="fm-track-name" data-track-type="${row.type}">${esc(row.label)}</div>
      <div class="fm-track-lanes" data-track-type="${row.type}">${lanes.map(lane=>`<div class="fm-track-lane">
        ${lane.map(item=>{
          const id = items.push(item)-1, start = Math.min(item.start,length), end = Math.min(item.end,length);
          const outside = start >= end;
          const label = outside ? `${item.label} · ${OneShotI18n.t("超出成片范围")}` : item.label;
          const movable = editable && !item.locked && !!item.clip;
          const trimmable = movable && (row.type==="audio" || row.type==="picture" && item.clip.kind==="video");
          const selected = Number.isInteger(item.index) && row.type==="picture" && item.index===F.sel;
          const previewClass = row.type==="picture" ? " fm-track-picture" : "";
          const version = item.ref && node(item.clip?.node)?.versions.find(version=>version.ref===item.ref);
          const thumbnail = row.type==="picture" && (version?.cover ? remakeMedia(version.cover) :
            item.clip.kind==="image" && item.ref ? remakeMedia(item.ref) : "");
          return `<div class="fm-track-item${previewClass}" data-track-item="${id}" data-editable="${movable}"
            ${row.type==="picture"?`data-picture-index="${item.index}"`:""}
            style="left:${100*start/length}%;width:${100*Math.max(0,end-start)/length}%"${selected?" data-active":""}>
            <button type="button" data-track-body title="${esc(label)} · ${item.start.toFixed(2)}s">
              ${thumbnail?`<img src="${esc(thumbnail)}" alt="">`:""}
              ${item.ref && FILM_WAVEFORM_TRACKS.has(row.type) && !outside ?
                '<canvas data-track-waveform width="192" height="24" aria-hidden="true"></canvas>' : ""}
              <span>${esc(label)}</span></button>
            ${trimmable?`<span data-track-edge="in" aria-hidden="true" title="${esc(OneShotI18n.t("拖动入点"))}"></span>
              <span data-track-edge="out" aria-hidden="true" title="${esc(OneShotI18n.t("拖动出点"))}"></span>`:""}
          </div>`;
        }).join("")}</div>`).join("")}</div>`;
  }).join("")+`<div class="fm-track-overlay" aria-hidden="true"><i id="fmTrackPlayhead"></i></div>`;
  for (const element of $$("[data-track-item]",content)) {
    const item = items[Number(element.dataset.trackItem)];
    element._trackItem = item;
    bindFilmTrackItem(F,element,item,length);
    if (item.clip && item.clip===focused?.clip && item.type===focused.type) $("[data-track-body]",element).focus({preventScroll:true});
  }
  bindFilmTrackRuler(F,$(".fm-track-ruler",content),length);
  loadFilmTrackWaveforms(F,content,items,length);
  $("#fmTrackZoom").textContent = `${state.zoom * 100}%`;
  $("#fmTrackSnap").checked = state.snap;
  state.selection = null;
  state.selectedTrack = null;
  updateFilmTrackPlayhead(F.spec.clips.length ? timelinePos() : 0,length);
  updateFilmTrackControls(F);
}

function updateFilmTrackPlayhead(time, length) {
  if (!FILM?.tracks?.open) return;
  const state = FILM.tracks;
  if (length) state.length = length;
  length = state.length || 1;
  const playhead = $("#fmTrackPlayhead");
  if (playhead) playhead.style.left = `${100*Math.min(Math.max(0,time),length)/length}%`;
  const selected = filmTrackSelected(FILM), active = selected?.type==="picture" ? null : selected?.clip ?? null;
  if (state.selection!==FILM.sel || state.selectedTrack!==active) {
    state.selection = FILM.sel;
    state.selectedTrack = active;
    for (const element of $$("[data-track-item]",$("#fmTrackContent"))) {
      const item = element._trackItem;
      element.toggleAttribute("data-active",active ? item?.clip===active :
        item?.type==="picture" && item.index===FILM.sel);
    }
    updateFilmTrackControls(FILM);
  }
}

function updateFilmTrackControls(F) {
  const editable = filmTracksEditable(F), state = filmTrackState(F);
  const selected = filmTrackSelected(F);
  const enable = {add:editable,split:editable && (selected?.type==="audio" || selected?.type==="picture" && selected.clip.kind==="video"),
    remove:editable && !!selected,
    undo:editable && state.undo.length,redo:editable && state.redo.length,
    out:state.zoom>1,in:state.zoom<16,fit:state.zoom>1};
  for (const button of $$("#fmTracks [data-track-action]")) button.disabled = !enable[button.dataset.trackAction];
}

function revealFilmTrackPlayhead() {
  const viewport = $("#fmTrackViewport"), playhead = $("#fmTrackPlayhead");
  if (!viewport || !playhead) return;
  const frame = viewport.getBoundingClientRect(), x = playhead.getBoundingClientRect().left;
  const start = frame.left + $(".fm-track-name",viewport).getBoundingClientRect().width;
  const end = frame.right - 16;
  if (end>start) viewport.scrollLeft += x<start ? x-start : x>end ? x-end : 0;
}

function bindFilmTrackRuler(F, ruler, length) {
  const seek = event => {
    if (F!==FILM) return;
    const rect = ruler.getBoundingClientRect();
    if (!rect.width) return;
    const point = (event.clientX-rect.left)*length/rect.width;
    F.tracks.active = null;
    seekTimeline(Math.max(0,Math.min(filmTotal(F.spec),point)));
    updateFilmTrackPlayhead(timelinePos(),length);
    updateFilmTrackControls(F);
  };
  ruler.onpointerdown = event => {
    if (event.button!==0 || !F.spec.clips.length) return;
    ruler.setPointerCapture?.(event.pointerId);
    seek(event);
  };
  ruler.onpointermove = event => { if (ruler.hasPointerCapture?.(event.pointerId)) seek(event); };
}

function bindFilmTrackItem(F, element, item, length) {
  const state = filmTrackState(F), spec = F.spec;
  let drag, suppressClick = false;
  element.onclick = event => {
    if (suppressClick || FILM!==F || event.target.closest("[data-track-edge]")) return;
    state.active = item.type!=="picture" && item.clip ? {type:item.type,clip:item.clip} : null;
    if (item.type==="picture") selectClip(item.index);
    else seekTimeline(Math.min(filmTotal(spec),item.start));
    const inspector = {audio:`[data-audio-index="${item.index}"] [data-audio-locate]`,
      voice:`#fmNarr [data-i="${item.index}"] textarea`,title:`[data-title-index="${item.index}"] [data-title-key=text]`,
      cutaway:`[data-cutaway-index="${item.index}"] [data-cutaway-key=start]`,music:"#fmSet [data-bk=volume]"};
    if (inspector[item.type]) $(inspector[item.type])?.scrollIntoView?.({block:"nearest"});
    updateFilmTrackPlayhead(timelinePos(),length);
    updateFilmTrackControls(F);
  };
  if (element.dataset.editable!=="true") return;
  element.onpointerdown = event => {
    if (event.button!==0 || state.dragging || !filmTracksEditable(F)) return;
    const rect = $(".fm-track-ruler").getBoundingClientRect();
    if (!rect.width) return;
    const edge = event.target.closest("[data-track-edge]")?.dataset.trackEdge;
    drag = {id:event.pointerId,x:event.clientX,edge,left:rect.left,scale:length/rect.width,position:timelinePos(),
      pictures:filmTrackClips(spec)};
    state.dragging = true;
    element.setPointerCapture?.(event.pointerId);
  };
  const pointAt = event => {
    const cursor = drag.edge==="out" ? item.end : item.start;
    const marks = [0,filmTotal(spec),drag.position,...drag.pictures.filter(picture=>picture.clip!==item.clip)
      .flatMap(picture=>[picture.start,picture.end])];
    return filmTrackSnap(cursor+(event.clientX-drag.x)*drag.scale,marks,drag.scale*8,state.snap && !event.altKey);
  };
  element.onpointermove = event => {
    if (event.pointerId!==drag?.id || Math.abs(event.clientX-drag.x)<4) return;
    const point = pointAt(event);
    if (!drag.edge) {
      const start = Math.min(Math.max(0,point),length);
      element.style.translate = `${(start-item.start)/drag.scale}px`;
    } else {
      const start = drag.edge==="in" ? Math.min(Math.max(0,point),item.end) : item.start;
      const end = drag.edge==="out" ? Math.max(item.start,Math.min(point,length)) : item.end;
      element.style.left = `${100*start/length}%`;
      element.style.width = `${100*Math.max(0,end-start)/length}%`;
    }
    element.dataset.trimTime = `${Math.max(0,point).toFixed(2)}s`;
  };
  element.onpointerup = element.onpointercancel = element.onlostpointercapture = event => {
    if (event.pointerId!==drag?.id) return;
    const {edge,position,pictures,left,scale} = drag, point = pointAt(event);
    const moved = Math.abs(event.clientX-drag.x)>=4;
    drag = null;
    state.dragging = false;
    if (state.refreshAfterDrag) {
      state.refreshAfterDrag = false;
      queueFilmTrackEditor(F);
    }
    delete element.dataset.trimTime;
    element.style.translate = "";
    element.style.left = `${100*Math.min(item.start,length)/length}%`;
    element.style.width = `${100*Math.max(0,Math.min(item.end,length)-Math.min(item.start,length))/length}%`;
    if (event.type!=="pointerup" || !moved || F.spec!==spec || !filmTracksEditable(F)) return;
    suppressClick = true;
    setTimeout(()=>{suppressClick=false;},0);
    if (item.type==="picture" && !edge) {
      const at = (event.clientX-left)*scale;
      const next = pictures.findIndex(target=>at < (target.start+target.end)/2);
      let index = next<0 ? pictures.length-1 : next;
      if (next>item.index) index--;
      if (index!==item.index) {
        state.active = null;
        const offset = spec.clips[F.sel]===item.clip ? Math.max(0,Math.min(position-item.start,clipLen(item.clip)-1/FILM_FPS)) : 0;
        const reordered = spec.clips.slice();
        reordered.splice(index,0,reordered.splice(item.index,1)[0]);
        recordFilmTrackList(F,"clips",reordered,()=>clipStart(index)+offset);
      }
      return;
    }
    const fields = filmTrackTimedEdit(F,item,edge,point);
    if (!fields) return toast(OneShotI18n.t("此处没有足够的轨道空间"));
    state.active = item.type!=="picture" ? {type:item.type,clip:item.clip} : null;
    recordFilmTrackFields(F,item,fields,position);
  };
}
