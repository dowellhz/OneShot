"use strict";

function storyDubbingRange(clip) {
  return {
    ref: filmVersion(clip)?.ref, in: clip.in || 0, out: clip.out ?? filmMediaLength(clip),
    audio_ref: clip.audio_ref || undefined, audio_start: clip.audio_ref ? clip.audio_start : undefined,
  };
}

function storyDubbingPlan(spec) {
  const occurrences = new Map();
  for (const {story_shot} of spec.clips) {
    if (story_shot) occurrences.set(story_shot, (occurrences.get(story_shot) || 0) + 1);
  }
  let offset = 0, incomingOverlap = 0;
  return spec.clips.map((clip, index) => {
    const duration = clipLen(clip);
    const outgoingOverlap = clipOverlap(clip, spec.clips[index + 1]);
    const range = storyDubbingRange(clip);
    const lines = storyDialogueLines(clip);
    const entry = {number:index + 1, key:clip.story_shot, range, lines, clipStart:offset,
      text:lines.map(line=>line.text).join("\n"), start:offset + incomingOverlap,
      end:offset + duration - outgoingOverlap};
    offset += duration - outgoingOverlap;
    incomingOverlap = outgoingOverlap;
    return clip.kind === "video" && occurrences.get(entry.key) === 1 && range.ref && entry.text ? entry : null;
  }).filter(Boolean);
}

function alignStoryDubbing(spec) {
  if (!spec.narration.some(track => track.story_shot)) return null;
  const plan = new Map(storyDubbingPlan(spec).map(shot => [shot.key, shot]));
  const offsets = new Map();
  let issue = null;
  for (const track of spec.narration) {
    if (!track.story_shot) continue;
    const shot = plan.get(track.story_shot);
    if (!shot) issue ||= "有补配音找不到对应片段，请移除或手动调整配音位置。";
    else {
      track.start = offsets.get(shot.key) ?? shot.start;
      const end = track.start + (track.ref ? track.seconds || 0 : 0);
      offsets.set(shot.key,end);
      if (end > shot.end + 1e-6)
        issue ||= "配音长于片段可用时间，请缩短台词或延长镜头。";
    }
  }
  return issue;
}

function hasStoryDubbing(spec, shot) {
  return spec.narration.some(track => {
    if (!track.ref && !track.text?.trim()) return false;
    return track.story_shot === shot.key || track.start < shot.end &&
      (track.start >= shot.start || track.start + (track.seconds || 0) > shot.start);
  });
}

function renderStoryDubbing(F) {
  const slot = $("[data-story-dubbing]");
  if (!slot || !F.spec.clips.some(clip => clip.story_shot && (clip.subs?.length || clip.story_dialogue?.length))) return;
  const state = F.storyDubbing;
  slot.innerHTML = OneShotI18n.html`<button class="pill" type="button" ${state?.running ? "disabled" : ""}>检查并补对白</button>
    <div data-story-voices></div><p class="h" role="status"></p><ul class="h" hidden></ul>`;
  renderStoryVoiceOptions(F,$("[data-story-voices]",slot));
  $("button", slot).onclick = () => void fillMissingStoryDubbing(F);
  const items = $("ul", slot);
  $("p", slot).textContent = state?.status || OneShotI18n.t("核对已有原声，只给未检测到语音的片段补配音。");
  for (const note of state?.notes || []) {
    const item = document.createElement("li");
    item.textContent = note;
    items.append(item);
  }
  items.hidden = !items.children.length;
}

async function fillMissingStoryDubbing(F) {
  if (FILM !== F || !canvasCanEdit() || F.busy || F.storyDubbing?.running) return;
  const plan = storyDubbingPlan(F.spec), fingerprint = JSON.stringify(plan), t = OneShotI18n.t;
  const active = () => FILM === F && boardId === F.board && canvasCanEdit();
  const unchanged = () => active() && JSON.stringify(storyDubbingPlan(F.spec)) === fingerprint;
  const preparedAudio = F.storyDubbing?.preparedAudio || new Map();
  const state = F.storyDubbing = {running:true, status:t("正在准备对白检查…"), notes:[], preparedAudio};
  let added = 0;
  const note = (shot, message) => state.notes.push(t("片段 {number} · {message}", {number:shot.number, message}));
  renderStoryDubbing(F);
  try {
    await flushSave();
    await loadDubbingVoices();
    const voices = voiceList?.voices || [];
    if (!voices.length) throw new Error(t("没有可用的配音音色。"));
    for (const shot of plan) {
      if (!unchanged()) break;
      if (hasStoryDubbing(F.spec, shot)) {
        note(shot, t("已有配音，已保留"));
        continue;
      }
      state.status = t("正在检查片段 {number} 的对白…", {number:shot.number});
      renderStoryDubbing(F);
      try {
        const result = await api("/api/video/captions", {...shot.range, board:F.board, allow_silence:true});
        if (!unchanged()) break;
        const speech = result.captions.map(cue => cue.text || "").join(" ").trim();
        if (speech) {
          const matches = normalizedSpeech(speech) === normalizedSpeech(shot.text);
          if (matches) {
            const clip = F.spec.clips[shot.number - 1];
            clip.story_captions = {source: JSON.stringify([shot.range,shot.lines]), cues: result.captions};
            saveFilmDraft(F);
          }
          note(shot, t(matches ? "检测到原声语音，已保留" : "原声转写与剧本有差异，请试听核对。"));
          continue;
        }
        if (hasStoryDubbing(F.spec, shot)) continue;
        const tracks = [], audioKeys = [];
        let start = shot.start;
        for (const [index,line] of shot.lines.entries()) {
          if (!unchanged()) break;
          const binding = F.spec.story_voices?.find(item=>item.speaker===line.speaker);
          const voice = binding ? voices.find(item=>item.id===binding.id&&item.provider===binding.provider) : voices[0];
          if (!voice) throw new Error(t("{name} 的配音音色不可用。",{name:line.speaker}));
          const track = {story_shot:shot.key, start, ...line,voice:voice.id,provider:voice.provider,speed:1,volume:1};
          const request = filmNarrationRequest(track), audioKey = JSON.stringify([shot.key,index,request]);
          const audio = preparedAudio.get(audioKey) || await api("/api/tts",request);
          if (!audio.ref || !Number.isFinite(audio.seconds) || audio.seconds <= 0) throw new Error(t("生成的配音不可用。"));
          preparedAudio.set(audioKey,audio);
          audioKeys.push(audioKey);
          tracks.push({...track,ref:audio.ref,seconds:audio.seconds});
          start += audio.seconds;
        }
        if (!unchanged()) break;
        if (start > shot.end + 1e-6) {
          note(shot, t("配音长于片段可用时间，请缩短台词或延长镜头。"));
          continue;
        }
        if (hasStoryDubbing(F.spec, shot)) continue;
        F.spec.narration.push(...tracks);
        audioKeys.forEach(key=>preparedAudio.delete(key));
        added++;
        note(shot, t("已添加配音"));
        saveFilmDraft(F);
        renderNarr();
      } catch (error) {
        note(shot, error.message);
      }
    }
    state.status = unchanged() ? t("对白检查完成，已补配音 {count} 段。", {count:added}) : t("剪辑内容已变化，请重新检查对白。");
  } catch (error) {
    state.status = error.message;
  } finally {
    state.running = false;
    if (active()) renderStoryDubbing(F);
  }
}
