"use strict";

function renderFilmMusic(F) {
  const host = $("#fmMusicMaker");
  if (!host) return;
  const services = CAPS_LIST.audio_generation?.music || [];
  if (!services.length) {
    host.innerHTML = OneShotI18n.html`<div class="h">接入音乐模型后可生成配乐，也可以上传现有音乐。</div>`;
    return;
  }
  const draft = F.spec.music_draft || {};
  const selected = services.find(service => service.id === draft.provider) || services[0];
  const options = services.map(service =>
    `<option value="${esc(service.id)}" ${service === selected ? "selected" : ""}>${esc(service.name)} · ${esc(service.model)}</option>`).join("");
  host.innerHTML = OneShotI18n.html`<details ${draft.open || draft.job ? "open" : ""}>
    <summary>生成配乐</summary>
    <form class="fm-dubbing">
      <label>音乐模型<select name="provider">${options}</select></label>
      <textarea name="prompt" rows="3" maxlength="2000" required aria-label="配乐描述" placeholder="例如：轻柔的钢琴和弦乐，节奏舒缓">${esc(draft.prompt || "")}</textarea>
      <div class="fm-dubbing-actions"><button type="submit" class="pill fm-dubbing-primary" ${draft.job ? "disabled" : ""}>生成纯音乐</button>
        ${draft.track ? OneShotI18n.html`<button type="button" class="pill" data-music-preview>试听生成的配乐</button><button type="button" class="pill" data-music-apply>用作背景音乐</button>` : ""}</div>
      <div role="status" class="h" data-music-status>${esc(draft.error || (draft.job ? OneShotI18n.t("正在生成配乐…") : ""))}</div>
    </form></details>`;
  const details = $("details", host), form = $("form", host);
  const save = () => {
    if (!host.isConnected || FILM !== F) return;
    Object.assign(draft, {open:details.open, prompt:form.elements.prompt.value, provider:form.elements.provider.value});
    F.spec.music_draft = draft;
    saveFilmDraft(F);
  };
  details.ontoggle = save;
  form.oninput = save;
  form.onsubmit = async event => {
    event.preventDefault();
    if (draft.job || F.submittingMusic || !canvasCanEdit()) return;
    save();
    const provider = services.find(service => service.id === draft.provider);
    const prompt = draft.prompt.trim();
    if (!provider || !prompt) return;
    const payload = {mode:"music", board:F.board, provider:provider.id, prompt, label:OneShotI18n.t("视频配乐")};
    if (provider.music_duration) payload.duration_seconds = Math.min(600, Math.max(3, Math.round(filmTotal(F.spec) * 100) / 100));
    const signature = JSON.stringify(payload);
    if (draft.signature !== signature || !draft.requestKey) draft.requestKey = filmExportKey();
    draft.signature = signature;
    draft.error = "";
    F.submittingMusic = true;
    $("button[type=submit]", form).disabled = true;
    $("[data-music-status]", form).textContent = OneShotI18n.t("正在生成配乐…");
    saveFilmDraft(F);
    try {
      await flushSave();
      if (FILM !== F || F.board !== boardId) return;
      const response = await api("/api/audio/generate", {...payload, request_key:draft.requestKey});
      draft.job = response.ids[0];
    } catch (error) {
      draft.error = error.message;
    } finally {
      F.submittingMusic = false;
      if (FILM === F) { saveFilmDraft(F); renderFilmMusic(F); }
    }
  };
  $("[data-music-preview]", form)?.addEventListener("click", () => {
    const audio = $("#fmA");
    if (!audio.paused && audio.getAttribute("src") === draft.track.url) { audio.pause(); return; }
    audio.src = draft.track.url;
    audio.volume = .55;
    audio.play().catch(() => toast(OneShotI18n.t("无法播放配乐")));
  });
  $("[data-music-apply]", form)?.addEventListener("click", () => {
    if (!canvasCanEdit()) return;
    F.spec.bgm = {...draft.track, volume:F.spec.bgm?.volume ?? .35, duck:F.spec.bgm?.duck ?? true};
    saveFilmDraft(F);
    renderFilm();
  });
  if (draft.job && !F.musicPolling) pollFilmMusic(F, draft);
}

async function pollFilmMusic(F, draft) {
  F.musicPolling = true;
  try {
    while (FILM === F && F.board === boardId) {
      const jobs = await boardRequest("/api/jobs?ids=" + encodeURIComponent(draft.job));
      if (FILM !== F) return;
      const job = jobs[draft.job];
      if (!job || ["done", "error", "cancelled", "canceled"].includes(job.state)) {
        const audio = job?.state === "done" && job.outputs?.[0];
        if (audio) draft.track = {name:OneShotI18n.t("生成的配乐"), ref:audio.ref, url:"/media?ref=" + encodeURIComponent(audio.ref)};
        else draft.error = job?.error || OneShotI18n.t("配乐任务未完成");
        delete draft.job;
        delete draft.requestKey;
        saveFilmDraft(F);
        renderFilmMusic(F);
        return;
      }
      await sleep(1500);
    }
  } catch (error) {
    if (FILM === F) {
      const status = $("#fmMusicMaker [data-music-status]");
      if (status) status.textContent = OneShotI18n.t("暂时无法查看配乐进度，重新打开剪辑台可继续查看。");
    }
  } finally {
    F.musicPolling = false;
  }
}
