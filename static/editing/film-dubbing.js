"use strict";

let voiceList = null, voiceListRequest = null;
const dubbingRequests = new WeakSet();

function filmNarrationRequest(clip) {
  return {text:clip.text, voice:clip.voice, provider:clip.provider, speed:clip.speed};
}

function filmDubbingLabel(clip, index) {
  return clip.speaker?.trim() || OneShotI18n.t("第 {number} 段配音", {number:index + 1});
}

function addFilmDubbing(F, voice) {
  const previous = F.spec.narration.at(-1);
  F.spec.narration.push({text:"", voice:voice?.id ?? previous?.voice, provider:voice ? voice.provider : previous?.provider, speed:previous?.speed ?? 1,
    start:+timelinePos().toFixed(2), volume:1});
  saveFilmDraft(F);
  renderNarr();
  $("#fmNarr .fm-dubbing:last-child textarea")?.focus();
}

function loadDubbingVoices() {
  if (voiceListRequest) return voiceListRequest;
  voiceListRequest = fetchOk("/api/voices")
    .then(response => response.json())
    .then(result => { voiceList = result; })
    .catch(() => { voiceList = {error:true, voices:[]}; })
    .finally(() => {
      voiceListRequest = null;
      if ($("#fmNarr")) {renderNarr(); if (FILM) renderStoryDubbing(FILM);}
    });
  return voiceListRequest;
}

function dubbingVoiceLabel(voice) {
  return voice.service ? `${voice.name} · ${voice.service}` : voice.name;
}

async function pickCanvasDubbingVoice(button, menu, n, version) {
  const board = B, t = OneShotI18n.t;
  button.disabled = true;
  await loadDubbingVoices();
  button.disabled = false;
  if (!button.isConnected || !menu.classList.contains("on") || B !== board) return;
  if (voiceList?.error) return toast(t("音色加载失败"));
  const voices = voiceList?.voices || [];
  if (!voices.length) return toast(t("请先在控制台接入一个配音服务。"));

  const select = document.createElement("select");
  select.className = "pill";
  select.setAttribute("aria-label", t("配音音色"));
  select.add(new Option(t("选择配音音色"), "", true, true));
  select.options[0].disabled = true;
  voices.forEach((voice, index) => select.add(new Option(dubbingVoiceLabel(voice), String(index))));
  button.replaceWith(select);
  select.focus();
  select.onchange = () => {
    closeMenus();
    if (B !== board || !canvasCanEdit() || node(n.id) !== n || nodeLocked(n) || curV(n) !== version) return;
    const film = n.data.film && !version.film_recipe?.timeline ? openFilm(n) : editVideoTimeline(n, version);
    if (film) addFilmDubbing(film, voices[Number(select.value)]);
  };
}

function renderNarr() {
  const F = FILM, box = $("#fmNarr"), t = OneShotI18n.t;
  if (!F || !box) return;
  if (!voiceList) loadDubbingVoices();
  const tracks = F.spec.narration, total = filmTotal(F.spec), editable = canvasCanEdit();
  const empty = $("[data-dubbing-empty]");
  if (empty) empty.hidden = !!tracks.length;
  const voices = voiceList?.voices || [];
  const state = !voiceList ? "正在加载音色…" : voiceList.error ? "音色加载失败" : !voices.length ? "请先在控制台接入一个配音服务。" : "";
  box.innerHTML = (state ? `<div class="h" role="status">${esc(t(state))}</div>` : "") +
    (voiceList?.error ? OneShotI18n.html`<button type="button" class="pill" data-dubbing-reload>重试</button>` : "") +
    tracks.map((clip, index) => {
      if (!clip.voice && voices.length) {
        clip.voice = voices[0].id;
        clip.provider = voices[0].provider;
      }
      const selected = voices.findIndex(voice => voice.id === clip.voice && voice.provider === clip.provider);
      const options = voices.map((voice, option) =>
        `<option value="${option}" ${option === selected ? "selected" : ""}>${esc(dubbingVoiceLabel(voice))}</option>`);
      if (selected < 0) options.unshift(`<option value="" selected disabled>${esc(t("所选音色不可用"))}</option>`);
      const running = dubbingRequests.has(clip);
      const status = running ? t("配音中…") : clip.ref ? t("已生成 · {seconds}s", {seconds:(clip.seconds || 0).toFixed(1)}) : t("待生成");
      const truncated = clip.ref && clip.start + clip.seconds > total + .01;
      const localSample = selected >= 0 && !clip.provider && /^(zf_|zm_)[A-Za-z0-9_-]+$/.test(clip.voice);
      const speed = [[0.85, "慢"], [1, "正常"], [1.15, "快"]].map(([value, label]) =>
        `<option value="${value}" ${value === Number(clip.speed) ? "selected" : ""}>${esc(t(label))}</option>`).join("");
      return OneShotI18n.html`<div class="fm-dubbing" data-i="${index}">
        <div class="fm-dubbing-header"><b>${esc(filmDubbingLabel(clip, index))}</b><span role="status" data-dubbing-status>${esc(status)}</span></div>
        <input type="text" maxlength="40" data-n="speaker" aria-label="角色名" placeholder="角色名（可选）" value="${esc(clip.speaker || "")}" ${editable ? "" : "readonly"}>
        <textarea rows="3" aria-label="配音文案" placeholder="输入旁白或一句角色台词" ${editable ? "" : "readonly"}>${esc(clip.text)}</textarea>
        <label>配音音色<select data-n="voice" ${editable && voices.length ? "" : "disabled"}>${options.join("")}</select></label>
        <div class="fm-dubbing-timing">
          <label>语速<select data-n="speed" ${editable ? "" : "disabled"}>${speed}</select></label>
          <label>起点（秒）<input type="number" data-n="start" step="0.01" min="0" max="${total.toFixed(2)}" value="${Number(clip.start)||0}" ${editable ? "" : "readonly"}></label>
        </div>
        <div class="fm-dubbing-warning" ${truncated ? "" : "hidden"}>这段配音会在成片结尾截断。</div>
        <div class="fm-dubbing-actions">
          ${editable ? OneShotI18n.html`<button type="button" class="pill fm-dubbing-primary" data-a="gen" ${running || F.busy || selected < 0 || !clip.text.trim() ? "disabled" : ""}>${esc(t(clip.ref ? "重新配音" : "生成配音"))}</button>` : ""}
          ${clip.ref ? OneShotI18n.html`<button type="button" class="pill" data-a="play">试听配音</button>` : localSample ? OneShotI18n.html`<button type="button" class="pill" data-a="sample">试听音色</button>` : ""}
          ${editable ? OneShotI18n.html`<button type="button" class="pill" data-a="here">对齐播放头</button><button type="button" class="pill" data-a="rm">移除</button>` : ""}
        </div></div>`;
    }).join("");
  $("[data-dubbing-reload]", box)?.addEventListener("click", () => {
    voiceList = null;
    renderNarr();
  });
  if (editable) $$("[data-i]", box).forEach(row => bindDubbingRow(F, row, voices));
  else $$('[data-a="play"],[data-a="sample"]', box).forEach(button => {
    button.onclick = () => playDubbing(F.spec.narration[Number(button.closest("[data-i]").dataset.i)], button.dataset.a);
  });
  renderFilmAudioLanes();
}

function bindDubbingRow(F, row, voices) {
  const tracks = F.spec.narration, clip = tracks[Number(row.dataset.i)], t = OneShotI18n.t;
  $("textarea", row).oninput = event => {
    if (clip.text === event.target.value) return;
    clip.text = event.target.value;
    clip.ref = null;
    const button = $('[data-a="gen"]', row);
    button.textContent = t("生成配音");
    button.disabled = !clip.text.trim() || dubbingRequests.has(clip) || F.busy ||
      !voices.some(voice => voice.id === clip.voice && voice.provider === clip.provider);
    $("[data-dubbing-status]", row).textContent = dubbingRequests.has(clip) ? t("配音中…") : t("待生成");
    $('[data-a="play"]', row)?.remove();
    $(".fm-dubbing-warning", row).hidden = true;
    renderFilmAudioLanes();
    saveFilmDraft(F);
  };
  $$("[data-n]", row).forEach(field => field.onchange = () => {
    const key = field.dataset.n;
    if (key === "voice") {
      const voice = voices[Number(field.value)];
      if (!voice) return;
      clip.voice = voice.id;
      clip.provider = voice.provider;
    } else if (key === "speaker") clip.speaker = field.value.trim();
    else if (key === "start") {
      delete clip.story_shot;
      clip.start = Number.isFinite(field.valueAsNumber) ? Math.min(filmTotal(F.spec), Math.max(0, field.valueAsNumber)) : clip.start;
      field.value = clip.start;
    } else clip[key] = Number(field.value);
    const newAudio = key === "voice" || key === "speed";
    if (newAudio) clip.ref = null;
    saveFilmDraft(F);
    if (newAudio) renderNarr();
    else {
      $(".fm-dubbing-header b", row).textContent = filmDubbingLabel(clip, Number(row.dataset.i));
      $(".fm-dubbing-warning", row).hidden = !clip.ref || !(clip.start + clip.seconds > filmTotal(F.spec) + .01);
      renderFilmAudioLanes();
    }
  });
  $$("button[data-a]", row).forEach(button => button.onclick = () => {
    switch (button.dataset.a) {
      case "gen": return generateFilmDubbing(F, clip);
      case "play":
      case "sample": return playDubbing(clip, button.dataset.a);
      case "here": delete clip.story_shot; clip.start = +timelinePos().toFixed(2); break;
      case "rm": tracks.splice(tracks.indexOf(clip), 1); break;
    }
    saveFilmDraft(F);
    renderNarr();
  });
}

function playDubbing(clip, action) {
  const player = $("#fmA");
  const src = action === "sample" ? `/static/voices/${clip.voice}.wav` : "/media?ref=" + encodeURIComponent(clip.ref);
  if (!player.paused && player.getAttribute("src") === src) {
    player.pause();
    return;
  }
  $("#fmV").pause();
  if (FILM.still?.started != null) {
    FILM.still.offset = filmClipOffset(FILM);
    FILM.still.started = null;
  }
  syncFilmAudio(FILM);
  player.src = src;
  player.volume = clip.volume ?? 1;
  player.play().catch(() => toast(OneShotI18n.t("无法播放配音")));
}

async function generateFilmDubbing(F, clip) {
  if (dubbingRequests.has(clip) || F.busy || !clip.text.trim()) return;
  const request = filmNarrationRequest(clip);
  dubbingRequests.add(clip);
  renderNarr();
  try {
    const result = await api("/api/tts", request);
    if (FILM !== F || !F.spec.narration.includes(clip) || Object.keys(request).some(key => request[key] !== clip[key])) return;
    clip.ref = result.ref;
    clip.seconds = result.seconds;
    saveFilmDraft(F);
  } catch (error) {
    if (FILM === F) toast(OneShotI18n.t(error.message), 4000);
  } finally {
    dubbingRequests.delete(clip);
    if (FILM === F) renderNarr();
  }
}
