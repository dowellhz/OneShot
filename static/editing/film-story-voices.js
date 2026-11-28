"use strict";

function storyDialogueLines(clip) {
  if (!clip.story_dialogue?.length) {
    const text = (clip.subs || []).join("\n").trim();
    return text ? [{speaker:"",text}] : [];
  }
  return clip.story_dialogue.flatMap(raw => {
    const line = raw.trim();
    const labeled = !/^[“"「]/.test(line) && line.match(/^([^：:\n]{1,24})[：:]+\s*(.+)$/);
    const speaker = labeled ? labeled[1].replace(/[（(][^）)]*[）)]\s*$/, "").trim() : "";
    const text = (labeled ? labeled[2] : line).replace(/^[“"「]+|[”"」]+$/g,"").trim();
    return text ? [{speaker,text}] : [];
  });
}

function renderStoryVoiceOptions(F, host) {
  const t = OneShotI18n.t, voices = voiceList?.voices || [];
  const speakers = [...new Set(storyDubbingPlan(F.spec).flatMap(shot=>shot.lines.map(line=>line.speaker)).filter(Boolean))];
  const bindings = F.spec.story_voices || [];
  speakers.forEach(speaker => {
    const row = document.createElement("label"), select = document.createElement("select");
    row.textContent = speaker;
    select.setAttribute("aria-label",t("{name} 的配音音色",{name:speaker}));
    select.add(new Option(t("默认音色"),""));
    voices.forEach((voice,index)=>select.add(new Option(dubbingVoiceLabel(voice),String(index))));
    const binding = bindings.find(item=>item.speaker===speaker);
    const selected = binding ? voices.findIndex(voice=>voice.id===binding.id && voice.provider===binding.provider) : -1;
    if (binding && selected < 0) {
      select.add(new Option(t("所选音色不可用"),"unavailable"));
      select.options[select.options.length-1].disabled=true;
      select.value="unavailable";
    } else select.value=selected<0?"":String(selected);
    select.disabled=!!F.storyDubbing?.running || !voices.length;
    select.onchange=()=>{
      const old = (F.spec.story_voices || []).filter(item=>item.speaker!==speaker);
      const voice = select.value === "" ? null : voices[Number(select.value)];
      F.spec.story_voices = voice ? [...old,{speaker,id:voice.id,provider:voice.provider}] : old;
      const script = node(F.spec.story_script);
      if (script && !nodeLocked(script)) {script.data.story_voices = structuredClone(F.spec.story_voices); save();}
      saveFilmDraft(F);
    };
    row.append(select);
    host.append(row);
  });
}

function automaticStoryCaptions(spec, clip) {
  if (!clip.story_shot) return undefined;
  const tracks = spec.narration.filter(track=>track.story_shot===clip.story_shot && track.ref && track.seconds>0);
  if (!tracks.length) return clip.story_captions && clip.story_captions.source === JSON.stringify([storyDubbingRange(clip),storyDialogueLines(clip)])
    ? clip.story_captions.cues : undefined;
  const shot = storyDubbingPlan(spec).find(item=>item.key===clip.story_shot);
  if (!shot) return undefined;
  const speed = filmSpeed(clip), start = clip.in || 0;
  return tracks.map(track=>({start:start+(track.start-shot.clipStart)*speed,
    end:start+(track.start-shot.clipStart+track.seconds)*speed,text:track.text}));
}
