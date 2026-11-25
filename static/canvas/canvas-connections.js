"use strict";

function canLink(a, b, version=curV(a)) {
  if (!a || !b || a.id === b.id) return false;
  if (b.data?.previs) return false;
  if (isSeedAudio(b)) return canSeedAudioReference(b,a,version);
  if (B.edges.some(e => (e.from === a.id && e.to === b.id) || (e.from === b.id && e.to === a.id))) return false;
  if (a.type === "audio") return b.type === "video" && !b.data?.film && !!version;
  if (a.type === "video") return b.type === "video" && !b.data?.film && !!version && version.source !== "previs";
  return (a.type === "text" && b.type !== "text" && b.type !== "audio") || (a.type === "image" && (b.type === "video" || b.type === "image" || b.type === "script"));
}
function why(a, b) {
  if (b.data?.previs) return "白模的素材在场景编辑器中添加";
  if (isSeedAudio(b)) return "参考生成可连入最多 3 段不同的音频版本或 1 张图片";
  if (a.type === "video") return "参考视频可连到普通视频节点，每个来源只连一次";
  if (a.type === "audio") return "音频可连接到支持全模态参考的视频节点";
  if (b.type === "text") return "文本节点不接收输入";
  return "这两个节点不能这样连接";
}
function link(a, b, quiet, binding) {
  const version=binding?.ref?a?.versions.find(v=>v.ref===binding.ref):curV(a);
  if (isSeedAudio(b)) {
    if (addSeedAudioReference(b,a,version,!quiet)) return true;
    if (!quiet && a && a!==b) toast(why(a,b));
    return false;
  }
  if ((binding?.ref&&!version) || !canLink(a, b, version)) { if (!quiet && a && b && a.id !== b.id) toast(why(a, b)); return false; }
  if (!quiet) checkpoint();   // quiet callers checkpoint before creating the node
  const e = { from: a.id, to: b.id, ...binding };
  if (a.data.asset?.kind === "character" && b.type === "video") e.role = "subject";   // new links from a library character default to 人物设定
  if (a.type === "audio" || a.type === "video") {
    Object.assign(e,{relation:a.type+"_ref",ref:version.ref});
    rememberVideoVersion(b);
    B.edges.push(e);
    const routes=referenceServices(b);
    if (!routes.some(service=>service.id===b.data.provider)) b.data.provider=routes[0]?.id || "";
  } else B.edges.push(e);
  refresh(b); save(); return true;
}
function inputs(n, type) { return B.edges.filter(e => e.to === n.id).map(e => node(e.from)).filter(m => m && (!type || m.type === type)); }
const imgInputs = n => inputs(n, "image");
function imageInputs(n) {
  return B.edges.filter(edge=>edge.to===n.id && node(edge.from)?.type==="image").map(edge=>{
    const source=node(edge.from);
    const index=edge.ref?source.versions.findIndex(v=>v.ref===edge.ref):source.cur;
    return {edge,source,index,version:source.versions[index]};
  });
}
function canvasPromptNode(ta) {
  return node(ta.id==="prompt"?ta._node:$("#pfields")._node);
}
const PROMPT_MEDIA_TAG={image:"图",video:"视频",audio:"音"};
const promptSlot=value=>Number.isSafeInteger(value)&&value>0?value:0;
function promptMediaInputs(type,target){
  if(type==="image")return imageInputs(target);
  return type==="audio"?audioInputs(target):videoInputs(target);
}
function canPromptMedia(source,target,ref=curV(source)?.ref) {
  if(!canvasCanEdit()||!ref||!Object.hasOwn(PROMPT_MEDIA_TAG,source?.type))return false;
  const version=source.versions.find(v=>v.ref===ref);
  if(!version || source.type==="video"&&version.source==="previs")return false;
  if(isSeedAudio(target))return canSeedAudioReference(target,source,version);
  if(!["image","video"].includes(target?.type)||target.data.previs||target.data.film)return false;
  if(target.type==="image"&&(source.type!=="image"||target.data.model==="h3video"))return false;
  const prior=promptMediaInputs(source.type,target).find(input=>input.source===source)?.edge;
  return prior?(!(prior.segment_edit||prior.extension)||prior.ref===ref):canLink(source,target,version);
}
function attachPromptMedia(ta,source,ref) {
  const target=canvasPromptNode(ta);
  if(!canPromptMedia(source,target,ref) || !sel.has(target.id) || sel.size!==1)return "";
  if(target.job||prepping.has(target.id)){toast("请等当前生成完成后再修改参考素材");return "";}
  if(isSeedAudio(target)){
    const version=source.versions.find(v=>v.ref===ref);
    if(!addSeedAudioReference(target,source,version))return "";
    return source.type==="audio"?"@音频"+seedAudioRefs(target).length:"参考图";
  }
  return bindPromptMedia(source,target,ref);
}
function bindPromptMedia(source,target,ref,recordUndo=true) {
  const list=promptMediaInputs(source.type,target), prior=list.find(input=>input.source===source)?.edge;
  const sequence=source.type+"_ref_seq";
  const slot=promptSlot(prior?.prompt_slot) || 1+Math.max(promptSlot(target.data[sequence]),...list.map(input=>promptSlot(input.edge.prompt_slot)));
  if (recordUndo) checkpoint();
  rememberVideoVersion(target);
  target.data[sequence]=Math.max(promptSlot(target.data[sequence]),slot);
  if(prior){
    if(source.type!=="image"&&prior.ref!==ref){delete prior.start;delete prior.end;}
    Object.assign(prior,{ref,prompt_slot:slot});refresh(target);save();
  }
  else link(source,target,true,{ref,prompt_slot:slot});
  return promptMediaToken(source.type,slot);
}
function promptMediaToken(type,slot,position){
  return "@"+PROMPT_MEDIA_TAG[type]+(promptSlot(slot)?"{"+slot+"}":position);
}
function mediaInputs(n, relation) {
  return B.edges.filter(e=>e.to===n.id && e.relation===relation).map(edge=>{
    const source=node(edge.from), index=source?.versions.findIndex(v=>v.ref===edge.ref) ?? -1;
    return {edge,source,index,version:source?.versions[index]};
  });
}
const audioInputs=n=>mediaInputs(n,"audio_ref");
function videoInputs(n) { return mediaInputs(n,"video_ref").sort((a,b)=>Number(!!(b.edge.extension||b.edge.segment_edit))-Number(!!(a.edge.extension||a.edge.segment_edit))); }
const promptVideoIndex=(i,guide,special)=>i+1+(guide&&(!special||i>0)?1:0);
function needsReferenceVideo(n) { return !!previsInput(n) || videoInputs(n).length > 0; }
function hasMediaReferences(n) { return needsReferenceVideo(n) || audioInputs(n).length > 0; }
