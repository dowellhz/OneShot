"use strict";

let voiceList = null;

function pickAudio(cb) { const i = document.createElement("input"); i.type = "file"; i.accept = "audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg"; i.onchange = () => i.files[0] && cb(i.files[0]); i.click(); }

function addFilmAudio(F, audio, start) {
  (F.spec.audio_clips ||= []).push({ref:audio.ref, name:audio.name, seconds:audio.seconds, node:audio.node,
    start, in:0, out:audio.seconds, volume:1});
  renderFilmAudio();
  saveFilmDraft(F);
}

function uploadFilmAudio(F, timed) {
  const start = +timelinePos().toFixed(2);
  pickAudio(async file => {
    const body = new FormData(); body.append("file", file);
    try {
      const audio = await (await fetchOk("/api/upload_audio", {method:"POST", body})).json();
      if (FILM !== F || F.board !== boardId) return;
      if (timed) {
        addFilmAudio(F,audio,start);
        return;
      } else {
        F.spec.bgm = {ref:audio.ref, url:audio.url, name:audio.name, volume:.35, duck:true};
        renderFilm();
      }
      saveFilmDraft(F);
    } catch (e) { toast(e.message, 4000); }
  });
}

function filmAudioTranscripts(track) {
  return B.nodes.filter(n=>n.type === "text" && n.data.transcript?.source_ref === track.ref &&
    Array.isArray(n.data.transcript.cues) && n.data.transcript.cues.length);
}

function filmAudioCaption(spec,time) {
  for (const track of spec.audio_clips || []) {
    const start = track.start ?? 0, begin = track.in ?? 0, end = track.out ?? track.seconds;
    if (!Array.isArray(track.captions) || time < start || time >= start + end - begin) continue;
    const source = begin + time - start;
    const cue = track.captions.find(cue=>source >= cue?.start && source < cue.end && cue.text?.trim());
    if (cue) return cue.text;
  }
  return "";
}

function renderFilmAudio() {
  const F = FILM, box = $("#fmAudioSettings"), tracks = F.spec.audio_clips || [];
  box.innerHTML = tracks.map((clip, i) => {
    const choices = filmAudioTranscripts(clip);
    const saved = clip.captions?.length ? `<option value=":saved" selected>已采用的字幕 · ${clip.captions.length} 条</option>` : "";
    return OneShotI18n.html`<div class="nar" data-audio-index="${i}">
    <div class="nr"><b title="${esc(clip.name)}">${esc(clip.name)}</b><button class="pill" type="button" data-audio-locate>定位</button><button class="pill" type="button" data-audio-remove>移除</button></div>
    <div class="nr">${[["start","起点",null],["in","入点",clip.seconds],["out","出点",clip.seconds]].map(([key,label,max]) =>
      OneShotI18n.html`<label>${label}<input type="number" data-audio-key="${key}" min="0" ${max === null ? "" : `max="${max}"`} step="0.01" value="${clip[key]}">秒</label>`).join("")}</div>
    <label>音量<input type="range" data-audio-key="volume" min="0" max="1" step="0.01" value="${clip.volume}"><output>${Math.round(clip.volume * 100)}%</output></label>
    ${saved || choices.length ? `<label>旁白字幕<select data-audio-transcript aria-label="${esc(clip.name)}的旁白字幕" ${canvasCanEdit() ? "" : "disabled"}>
      <option value="">不使用旁白字幕</option>${saved}${choices.map(n=>OneShotI18n.html`<option value="${esc(n.id)}">采用 ${esc(n.name)}</option>`).join("")}</select></label>` : ""}
  </div>`;
  }).join("");
  $$("[data-audio-index]", box).forEach(row => {
    const index = Number(row.dataset.audioIndex), clip = tracks[index];
    const captions = $("[data-audio-transcript]",row);
    if (captions) captions.onchange = () => {
      if (!canvasCanEdit() || captions.value === ":saved") return;
      if (captions.value) {
        const source = filmAudioTranscripts(clip).find(n=>n.id===captions.value);
        if (!source) { renderFilmAudio(); return toast("所选转写已移除，请重新选择"); }
        clip.captions = vtClone(source.data.transcript.cues);
        F.spec.subtitles = true;
      } else delete clip.captions;
      saveFilmDraft(F);
      renderFilm();
      previewTick();
    };
    $("[data-audio-locate]", row).onclick = () => seekTimeline(Math.min(clip.start, filmTotal(F.spec)));
    $("[data-audio-remove]", row).onclick = () => {
      tracks.splice(index, 1); syncFilmAudio(F); renderFilmAudio(); saveFilmDraft(F);
    };
    $$("[data-audio-key]", row).forEach(input => input.onchange = () => {
      const key = input.dataset.audioKey, value = input.valueAsNumber;
      if (!Number.isFinite(value) || value < 0 || key === "in" && value >= clip.out ||
          key === "out" && (value <= clip.in || value > clip.seconds)) {
        input.value = clip[key]; toast("请检查音频时间，出点须晚于入点"); return;
      }
      clip[key] = value;
      if (key === "volume") input.nextElementSibling.textContent = Math.round(value * 100) + "%";
      syncFilmAudio(F); renderFilmAudioLanes(); saveFilmDraft(F);
    });
  });
  renderFilmAudioLanes();
}

function renderFilmAudioLanes() {
  const F = FILM, host = $("#fmAudioLanes"), tracks = F.spec.audio_clips || [], total = filmTotal(F.spec);
  $("#fmTime").max = total;
  host.hidden = !tracks.length;
  host.innerHTML = tracks.map((clip, i) => {
    const start = Math.min(total, clip.start);
    const end = Math.min(total, clip.start + clip.out - clip.in);
    const label = start >= total ? `${esc(clip.name)} · 超出成片范围` : esc(clip.name);
    const position = start >= total ? "left:0;max-width:100%" : `left:${100 * start / total}%;width:${100 * (end - start) / total}%`;
    return `<div class="fm-audio-lane"><button type="button" data-audio-jump="${i}" style="${position}" title="${esc(clip.name)} · ${clip.start.toFixed(2)}s">${label}</button></div>`;
  }).join("");
  $$("[data-audio-jump]", host).forEach(button => button.onclick = () => {
    const index = Number(button.dataset.audioJump);
    seekTimeline(Math.min(tracks[index].start, total));
    $("[data-audio-index='"+index+"'] [data-audio-locate]").focus();
  });
}

function syncFilmAudio(F, time) {
  const players = F.audioPlayers ||= new Map();
  const active = new Set();
  if (Number.isFinite(time)) for (const clip of F.spec.audio_clips || []) {
    const offset = clip.in + time - clip.start;
    if (offset < clip.in || offset >= clip.out || !clip.volume) continue;
    active.add(clip);
    let player = players.get(clip);
    if (!player) {
      player = {media:new Audio(remakeMedia(clip.ref)), pending:false, blocked:false};
      players.set(clip, player);
    }
    const media = player.media;
    media.volume = clip.volume;
    if (Math.abs(media.currentTime - offset) > .12) media.currentTime = offset;
    if (media.paused && !player.pending && !player.blocked) {
      player.pending = true;
      media.play().catch(() => { player.blocked = true; }).finally(() => { player.pending = false; });
    }
  }
  for (const [clip, player] of players) {
    if (!active.has(clip)) { player.media.pause(); players.delete(clip); }
  }
}

function renderNarr() {
  const s = FILM.spec, box = $("#fmNarr");
  if (!voiceList) { fetch("/api/voices").then(r => r.json()).then(v => { voiceList = v; if (FILM) renderNarr(); }).catch(() => {}); }
  if (voiceList && !voiceList.available) { box.innerHTML = `<div class="h">配音模型还没装好</div>`; return; }
  const vs = voiceList?.voices || [];
  box.innerHTML = s.narration.map((x, i) => OneShotI18n.html`<div class="nar" data-i="${i}">
      <textarea rows="2" placeholder="写旁白，例如：那天夜里，雨下得很大……">${esc(x.text)}</textarea>
      <div class="nr"><select data-n="voice">${vs.map(v => `<option value="${v.id}" ${v.id === x.voice ? "selected" : ""}>${v.name}</option>`).join("")}</select>
        <button class="pill" data-a="sample" title="试听这个声音">▶</button>
        <select data-n="speed">${[[0.85, "慢"], [1, "正常"], [1.15, "快"]].map(([a, t]) => `<option value="${a}" ${+a === +x.speed ? "selected" : ""}>${t}</option>`).join("")}</select>
        <label>从<input type="number" step="0.1" min="0" value="${x.start}" data-n="start">秒开始</label></div>
      <div class="nr"><button class="pill" data-a="gen">${x.ref ? "重新配音" : "生成配音"}</button>${x.ref ? `<button class="pill" data-a="play">试听 ${x.seconds?.toFixed(1)}s</button>` : ""}<button class="pill" data-a="here" title="把开始时间设为预览里当前的位置">设为当前位置</button><button class="pill" data-a="rm">删除</button></div></div>`).join("");
  $$(".nar", box).forEach(el => {
    const x = s.narration[+el.dataset.i];
    $("textarea", el).oninput = e => { if (x.text !== e.target.value) { x.text = e.target.value; x.ref = null; } };
    $$("[data-n]", el).forEach(f => f.onchange = () => { const k = f.dataset.n; x[k] = k === "voice" ? f.value : +f.value; if (k !== "start") { x.ref = null; renderNarr(); } });
    $$("button[data-a]", el).forEach(b => b.onclick = async () => {
      const a = b.dataset.a;
      if (a === "rm") { s.narration.splice(+el.dataset.i, 1); renderNarr(); }
      else if (a === "sample") { const au = $("#fmA"); au.src = `/static/voices/${x.voice}.wav`; au.volume = 1; au.play(); }
      else if (a === "here") { x.start = +(timelinePos() || 0).toFixed(1); renderNarr(); }
      else if (a === "play") { const au = $("#fmA"); au.src = "/media?ref=" + encodeURIComponent(x.ref); au.volume = 1; au.play(); }
      else if (a === "gen") {
        if (!x.text.trim()) return toast("先写旁白文字");
        b.disabled = true; b.textContent = "配音中…";
        try { const r = await api("/api/tts", { text: x.text, voice: x.voice, speed: x.speed }); x.ref = r.ref; x.seconds = r.seconds; renderNarr(); const au = $("#fmA"); au.src = r.url; au.play(); }
        catch (e) { toast(e.message, 4000); b.disabled = false; b.textContent = "生成配音"; }
      }
    });
  });
}
