"use strict";

const FILM_TRACK_FIELDS = Object.freeze({picture:"clips",audio:"audio_clips",voice:"narration",title:"titles",cutaway:"cutaways"});
const FILM_WAVEFORM_TRACKS = new Set(["audio","voice","music"]);

function filmTrackClips(spec) {
  let start = 0;
  return spec.clips.map((clip, index) => {
    const end = start + clipLen(clip);
    const item = {type:"picture", clip, index, start, end, label:clip.name || node(clip.node)?.name || OneShotI18n.t("片段"),
      ref:filmVersion(clip)?.ref};
    start = end - clipOverlap(clip,spec.clips[index + 1]);
    return item;
  });
}

function filmTrackCaptions(spec, pictures, audio) {
  if (!spec.subtitles) return [];
  const captions = [];
  for (const {clip,index,start,end} of pictures) {
    const timed = clip.captions ?? (typeof automaticStoryCaptions==="function" ? automaticStoryCaptions(spec,clip) : null);
    const rate = filmSpeed(clip), source = clip.in || 0;
    const minimum = start + (timed ? clipOverlap(spec.clips[index-1],clip) : 0);
    const maximum = end - (timed ? clipOverlap(clip,spec.clips[index+1]) : 0);
    for (const cue of timed ?? filmSubtitleCues(clip.subs || [],end-start)) {
      const a = start + (timed ? (cue.start-source)/rate : cue.start);
      const b = start + (timed ? (cue.end-source)/rate : cue.end);
      captions.push({type:"caption",index,start:Math.max(minimum,a),end:Math.min(maximum,b),label:cue.text});
    }
  }
  for (const {clip,start,end} of audio) {
    const source = clip.in ?? 0;
    for (const cue of clip.captions || []) {
      captions.push({type:"caption",start:Math.max(start,start+cue.start-source),
        end:Math.min(end,start+cue.end-source),label:cue.text});
    }
  }
  return captions.filter(item=>item.label && item.start < item.end);
}

function filmTrackRows(spec) {
  const t = OneShotI18n.t;
  const pictures = filmTrackClips(spec), total = filmTotal(spec);
  const audio = (spec.audio_clips || []).flatMap((clip,index)=>{
    const start = clip.start ?? 0, length = (clip.out ?? clip.seconds)-(clip.in ?? 0);
    return length>0 ? [{type:"audio",clip,index,start,end:start+length,
      label:clip.name || t("音频片段"),ref:clip.ref}] : [];
  });
  const voices = (spec.narration || []).flatMap((clip,index)=>clip.ref && clip.seconds>0 ? [{
    type:"voice",clip,index,start:clip.start,end:clip.start+clip.seconds,
    label:filmDubbingLabel(clip,index),ref:clip.ref,locked:!!clip.story_shot,
  }] : []);
  const titles = (spec.titles || []).map((clip,index)=>({type:"title",clip,index,start:clip.start,
    end:clip.end,label:clip.text.trim() || t("空白标题")}));
  const cutaways = (spec.cutaways || []).map((clip,index)=>({type:"cutaway",clip,index,start:clip.start,
    end:clip.start+clip.duration,label:clip.name || t("补画面"),ref:clip.ref}));
  const music = spec.bgm ? [{type:"music",clip:spec.bgm,locked:true,start:0,end:total,
    label:spec.bgm.name || t("背景音乐"),ref:spec.bgm.ref}] : [];
  return [
    {label:t("画面"),type:"picture",items:pictures},
    {label:t("补画面"),type:"cutaway",items:cutaways},
    {label:t("字幕"),type:"caption",items:filmTrackCaptions(spec,pictures,audio)},
    {label:t("画面标题"),type:"title",items:titles},
    {label:t("配音"),type:"voice",items:voices},
    {label:t("音频片段"),type:"audio",items:audio},
    {label:t("背景音乐"),type:"music",items:music},
  ];
}

function packFilmTrack(items) {
  const lanes = [], ends = [];
  for (const item of [...items].sort((a,b)=>a.start-b.start)) {
    let lane = ends.findIndex(end=>end <= item.start + 1e-6);
    if (lane < 0) { lane = lanes.length; lanes.push([]); }
    lanes[lane].push(item);
    ends[lane] = item.end;
  }
  return lanes.length ? lanes : [[]];
}

function filmTrackSnap(point, marks, tolerance, enabled) {
  if (enabled) {
    const nearest = marks.reduce((best,mark)=>Math.abs(mark-point)<Math.abs(best-point) ? mark : best,Infinity);
    if (Math.abs(nearest-point)<=tolerance) return nearest;
  }
  return Math.round(point*FILM_FPS)/FILM_FPS;
}

function filmTrackTimedEdit(F, item, edge, point) {
  const {clip,type,start,end} = item, total = filmTotal(F.spec);
  if (edge && type==="picture") {
    const bounds = filmTrimBounds(clip);
    const initial = edge==="in" ? clip.in || 0 : clip.out ?? bounds.end;
    const value = filmTrimPoint(clip,edge,initial+(point-(edge==="in"?start:end))*filmSpeed(clip),bounds);
    const adjusted = {...clip};
    setFilmTrim(adjusted,edge,value,bounds);
    return {[edge]:adjusted[edge]};
  }
  if (edge && type==="audio") {
    const minimum = 1/FILM_FPS;
    const sourceIn = clip.in ?? 0, sourceOut = clip.out ?? clip.seconds, sourceLimit = clip.seconds ?? sourceOut;
    if (edge==="in") {
      const delta = Math.max(-Math.min(start,sourceIn),Math.min(point-start,sourceOut-sourceIn-minimum));
      return {start:start+delta,in:sourceIn+delta};
    }
    const out = Math.min(sourceLimit,sourceIn+total-start,sourceOut+point-end);
    return out>=sourceIn+minimum ? {out} : null;
  }
  const duration = end-start;
  const at = Math.max(0,Math.min(point,Math.max(0,total-duration)));
  if (type==="cutaway" && (at+duration>total+1e-6 || F.spec.cutaways.some(other=>
      other!==clip && at<other.start+other.duration-1e-6 && at+duration>other.start+1e-6))) return null;
  return type==="title" ? {start:at,end:at+duration} : {start:at};
}
