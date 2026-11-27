"use strict";

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
  const voices = (F.spec.narration || []).flatMap((clip, index) => clip.ref && clip.seconds > 0
    ? [{clip, index, name: filmDubbingLabel(clip, index)}] : []);
  $("#fmTime").max = total;
  host.hidden = !tracks.length && !voices.length;
  const lane = (clip, endTime, name, index, dubbing) => {
    const start = Math.min(total, clip.start);
    const end = Math.min(total, endTime);
    const label = esc(start >= total ? `${name} · ${OneShotI18n.t("超出成片范围")}` : name);
    const position = start >= total ? "left:0;max-width:100%" : `left:${100 * start / total}%;width:${100 * (end - start) / total}%`;
    return `<div class="fm-audio-lane ${dubbing ? "fm-voice-lane" : ""}"><button type="button" data-${dubbing ? "voice" : "audio"}-jump="${index}" style="${position}" title="${esc(name)} · ${clip.start.toFixed(2)}s">${label}</button></div>`;
  };
  host.innerHTML = tracks.map((clip, i) => lane(clip, clip.start + clip.out - clip.in, clip.name, i, false)).join("")
    + voices.map(({clip, index, name}) => lane(clip, clip.start + clip.seconds, name, index, true)).join("");
  $$("[data-audio-jump]", host).forEach(button => button.onclick = () => {
    const index = Number(button.dataset.audioJump);
    seekTimeline(Math.min(tracks[index].start, total));
    $("[data-audio-index='"+index+"'] [data-audio-locate]").focus();
  });
  $$("[data-voice-jump]", host).forEach(button => button.onclick = () => {
    const index = Number(button.dataset.voiceJump);
    seekTimeline(Math.min(F.spec.narration[index].start, total));
    $(`#fmNarr [data-i="${index}"] textarea`)?.focus();
  });
}

function syncFilmAudio(F, time) {
  const players = F.audioPlayers ||= new Map();
  const active = new Set();
  if (Number.isFinite(time)) for (const clip of [...(F.spec.audio_clips || []), ...(F.spec.narration || [])]) {
    const begin = clip.in ?? 0, end = clip.out ?? clip.seconds, volume = clip.volume ?? 1;
    const offset = begin + time - clip.start;
    if (!clip.ref || offset < begin || !(offset < end) || !volume) continue;
    active.add(clip);
    let player = players.get(clip);
    if (!player || player.ref !== clip.ref) {
      player?.media.pause();
      player = {media:new Audio(remakeMedia(clip.ref)), ref:clip.ref, pending:false, blocked:false};
      players.set(clip, player);
    }
    const media = player.media;
    media.volume = volume;
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
