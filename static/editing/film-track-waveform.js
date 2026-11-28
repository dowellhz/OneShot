"use strict";

function drawFilmTrackWaveform(canvas, waveform, item, length) {
  const {peaks,seconds} = waveform, duration = seconds || item.clip?.seconds;
  if (!(duration>0)) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const start = item.clip?.in ?? 0;
  const visible = Math.min(item.end,length)-item.start;
  if (!(visible>0)) return;
  const middle = canvas.height/2;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle = "#a7dac3";
  for (let x=0;x<canvas.width;x+=2) {
    const time = start + x*visible/canvas.width;
    const source = item.type==="music" ? time%duration : time;
    const peak = peaks[Math.min(peaks.length-1,Math.floor(source*peaks.length/duration))];
    const height = Math.max(1,peak*(canvas.height-4));
    ctx.fillRect(x,middle-height/2,1,height);
  }
}

function loadFilmTrackWaveforms(F, content, items, length) {
  const state = F.tracks;
  const load = async canvas => {
    const item = items[Number(canvas.closest("[data-track-item]").dataset.trackItem)];
    if (!item?.ref) return;
    state.missingWaveforms ||= new Set();
    if (state.missingWaveforms.has(item.ref)) return;
    try {
      const waveform = await audioPreviewWaveform(item.ref);
      if (FILM===F && canvas.isConnected) drawFilmTrackWaveform(canvas,waveform,item,length);
    } catch {
      state.missingWaveforms.add(item.ref);
    }
  };
  state.waveformObserver?.disconnect();
  const canvases = $$("canvas[data-track-waveform]",content);
  if (!window.IntersectionObserver) {
    canvases.forEach(load);
    return;
  }
  state.waveformObserver = new IntersectionObserver(entries=>{
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      state.waveformObserver.unobserve(entry.target);
      load(entry.target);
    }
  },{root:$("#fmTrackViewport")});
  canvases.forEach(canvas=>state.waveformObserver.observe(canvas));
}
