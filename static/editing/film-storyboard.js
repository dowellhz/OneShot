"use strict";

function storyFilmSelection(script, start = 0, end = script.data.shots.length - 1) {
  const links = scriptShotLinks(script), media = [], missing = [];
  for (let i = start; i <= end; i++) {
    const source = node(links[i]?.vid);
    if (source?.type === "video" && curV(source)?.ref) media.push(source);
    else missing.push(i + 1);
  }
  return {media, missing};
}

function openStoryFilm(script, start = 0, end = script.data.shots.length - 1, transition = "cut") {
  const {media, missing} = storyFilmSelection(script, start, end);
  if (missing.length) {
    toast(`镜头 ${missing.join("、")} 缺少视频。可先补齐，或到镜头清单选择已完成的连续片段。`, 4500);
    return false;
  }
  if (!media.length) return false;
  const spec = newSpec(media);
  if (start === 0 && end === script.data.shots.length - 1) spec.story_script = script.id;
  const selectedShots = script.data.shots.slice(start, end + 1);
  const keys = selectedShots.map((shot, i) => shot.id || `index:${start+i}`);
  spec.story_tracking = true;
  const shots = spec.clips.map((clip,i) => {
    const shot=selectedShots[i], range=shot.previs_range;
    clip.trans=transition;
    clip.story_shot=keys[i];
    const whitebox=Array.isArray(range) && range.length===2 && range.every(Number.isSafeInteger) && range[0]>=0 && range[1]>range[0];
    const frames=Number.isFinite(shot.duration) && shot.duration>0 ? Math.max(1,Math.round(shot.duration*FILM_FPS)) :
      whitebox ? range[1]-range[0] : null;
    if (whitebox) clip.trans="cut";
    if (Number.isSafeInteger(frames)) {
      clip.story_frames=frames;
      const seconds=curV(media[i]).seconds;
      if (Number.isFinite(seconds) && seconds>0) alignStoryClipLength(clip,seconds);
      else clip.story_pending_length=true;
    }
    return {id:keys[i],node:clip.node,ref:clip.ref,number:start+i+1,frames};
  });
  const scope = [script.id,keys];
  const key = filmDraftPrefix()+"story:"+JSON.stringify([...scope,shots.map(shot=>[shot.node,shot.ref])]);
  showFilm(spec,null,key,null,{scope,shots,base:storyDraftSignature(spec)});
  return true;
}

function storyDraftSignature(spec) {
  return JSON.stringify(spec, (key,value) => ["src_len","story_tracking","story_shot","story_frames","story_pending_length"].includes(key) ? undefined : value);
}

function refreshStoryClipPlans(spec, story) {
  if (!spec.story_tracking || !story) return;
  const plans=new Map(story.shots.map(shot=>[shot.id,shot])), occurrences=new Map();
  for (const clip of spec.clips) {
    if (clip.story_shot) occurrences.set(clip.story_shot,(occurrences.get(clip.story_shot) || 0)+1);
  }
  for (const clip of spec.clips) {
    const plan=plans.get(clip.story_shot);
    if (!plan || clip.node!==plan.node || clip.story_split || occurrences.get(clip.story_shot)!==1) continue;
    if (Number.isSafeInteger(plan.frames)) clip.story_frames=plan.frames;
    else {
      delete clip.story_frames;
      delete clip.story_pending_length;
    }
  }
}
