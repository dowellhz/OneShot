"use strict";

function referenceServices(n) {
  const edge=videoInputs(n)[0]?.edge;
  if (edge?.segment_edit) return CAPS_LIST.segment_edit || [];
  if (edge?.extension) return CAPS_LIST.video_extension || CAPS_LIST.previs || [];
  return (needsReferenceVideo(n) ? CAPS_LIST.previs : CAPS_LIST.audio_reference) || [];
}
function referenceService(n) { return referenceServices(n).find(service => service.id === n.data.provider); }
function videoOutputModel(n) {
  if (hasMediaReferences(n) && !n.data.provider) {
    const models=referenceServices(n).flatMap(service=>service.models||[]);
    if (models.length) {
      const durations=[...new Set(models.flatMap(model=>model.durations||[]))].sort((a,b)=>a-b);
      const labels={std:"标准",hd:"高清","480p":"480P","4k":"4K"};
      const qualities=Object.fromEntries(Object.entries(labels).filter(([quality])=>
        models.some(model=>Object.hasOwn(model.qualities||{},quality))));
      return {durations:durations.length?durations:undefined,
        qualities:Object.keys(qualities).length?qualities:undefined,draft:models.some(model=>model.draft)};
    }
  }
  return hasMediaReferences(n)?canvasNodeModel(n,referenceService(n),true):canvasNodeModel(n,nodeProvider(n));
}
function referenceDuration(n) {
  const model=videoOutputModel(n);
  return model?.durations?.at(-1) || (model?.id?.includes("2-5") ? 30 : 15);
}
function canvasVideoDurationChoices(n) {
  const clip=videoInputs(n)[0], guide=previsInput(n);
  if (clip?.edge.segment_edit) return [];
  const configured=videoOutputModel(n)?.durations;
  if (!guide && !clip && !audioInputs(n).length) return configured || SCRIPT_VIDEO_DURATIONS;
  const max=guide && !clip?.edge.extension ? 14 : referenceDuration(n);
  if (configured) return configured.filter(seconds=>seconds<=max);
  return Array.from({length:max-3},(_,index)=>index+4);
}
function canvasVideoDuration(n) {
  const seconds=Number(n.data.duration) || 5;
  const options=canvasVideoDurationChoices(n);
  if (!options.length) return seconds;
  if (!hasMediaReferences(n) && !isRemote(n)) return Math.min(options.at(-1),Math.max(options[0],seconds));
  if (!videoOutputModel(n)?.durations) return seconds;
  const rounded=Math.round(seconds);
  return options.reduce((best,value)=>Math.abs(rounded-value)<Math.abs(rounded-best)?value:best);
}
function canvasVideoQuality(n) {
  const quality=n.data.quality || "hd", options=videoOutputModel(n)?.qualities;
  return options && !Object.hasOwn(options,quality) ? "std" : quality;
}

const ROLE_CN = { auto: "自动", subject: "人物设定", first: "首帧", last: "尾帧", keyframe: "关键帧" };
function vidFrames(sec) { let f = Math.max(5, Math.round(sec * 24)); return f + (5 - f % 17 + 17) % 17; }
// how a video node uses its images: per edge role (auto / subject / first / last / keyframe) -> labels, times, model path
function plan(n) {
  const d = n.data, inputs=imageInputs(n), es=inputs.map(input=>input.edge);
  const imgs=inputs.map(input=>input.source);
  const guide = hasMediaReferences(n);
  let roles = es.map(e => e.role || "auto");
  if (guide || d.mode === "reference") roles = roles.map(r => r === "auto" ? "subject" : r);
  const subj = [], fr = [];
  roles.forEach((r, i) => (r === "subject" ? subj : fr).push(i));
  const ordered = [...fr.filter(i => roles[i] === "first"), ...fr.filter(i => roles[i] === "auto" || roles[i] === "keyframe"), ...fr.filter(i => roles[i] === "last")];
  const end = (vidFrames(canvasVideoDuration(n)) - 4) / 24;
  const useRef = subj.length > 0 || d.mode === "keyframes" || ordered.length > 2 || roles.includes("keyframe") || (ordered.length === 1 && roles[ordered[0]] === "last");
  const times = {}, labels = [];
  if (!useRef) { if (ordered.length >= 1) labels[ordered[0]] = "首帧"; if (ordered.length === 2) labels[ordered[1]] = "尾帧"; }
  else ordered.forEach((i, j) => {
    let t = ordered.length === 1 ? 0 : end * j / (ordered.length - 1);
    if (roles[i] === "first") t = 0; else if (roles[i] === "last") t = end;
    else if (es[i].time != null && isFinite(+es[i].time)) t = Math.min(end, Math.max(0, +es[i].time));   // a time the user typed in
    times[i] = t; labels[i] = t <= 0.01 ? "首帧" : t >= end - 0.05 ? "尾帧" : t.toFixed(1) + "s";
  });
  subj.forEach(i => labels[i] = guide && es[i].role !== "subject" ? "参考图" : "人物设定");
  const name = !useRef ? ["文生视频", "首帧生视频", "首尾帧生视频"][Math.min(ordered.length, 2)]
    : (subj.length ? "人物设定" : "") + (subj.length && ordered.length ? " + " : "") + (ordered.length === 1 ? labels[ordered[0]] : ordered.length ? "关键帧" : "");
  return { imgs, es, inputs, roles, labels, times, end, useRef, ordered, subj, mode: useRef ? "ref" : "fl2v", name };
}

function planLabel(p) { return p.name.split(" + ").map(label => OneShotI18n.t(label)).join(" + "); }
