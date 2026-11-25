"use strict";

// ================================================================= model
const node = id => B.nodes.find(n => n.id === id);
const curV = n => (n && n.versions[n.cur]) || null;
function defaults(type) {
  if (type === "audio") return {prompt:"",mode:"tts",provider:"",voice:"",speed:1,lyrics:"",duration_seconds:null,
    prompt_influence:.3,loop:false,subtitles:false,audio_format:"source",sample_rate:null,pitch_semitones:0,gain:1,references:[]};
  if (type === "text") return { text: "" };
  if (type === "script") return { prompt: "", nshots: "auto", shotlen: "auto", aspect: "16:9", quality: "hd", title: "", style: "", characters: [], shots: [], made: [] };
  if (type === "image") return { prompt: "", model: "h3img", expand: false, aspect: "3:4", quality: "4mp", count: 1, turbo: true, seed: -1, caption: "" };
  return { prompt: "", duration: 5, aspect: "auto", quality: "hd", mode: "auto", turbo: true, seed: -1, sound: "", music: "", pmode: "free", fields: {}, count: 1 };
}
function nextName(type) { const c = B.nodes.filter(n => n.type === type).length + 1; return `${TYPE_CN[type]} ${c}`; }
function newCanvasNodeId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return "n" + Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
function addNode(type, x, y, data = {}, extra = {}) {
  const n = { id: newCanvasNodeId(), type, name: nextName(type), x: Math.round(x), y: Math.round(y), data: { ...defaults(type), ...data }, versions: [], cur: -1, job: null, ...extra };
  B.nodes.push(n); build(n); save(); updateEmpty(); if(nodePins(n).length)renderNodePinBar(); return n;
}
function size(n) {
  if (n.type === "group") return {w:n.w,h:n.h};
  if (n.type === "text") return { w: 300, h: 220 };
  if (n.type === "audio") return { w: 320, h: 120 };
  if (n.type === "script") { const k = (n.data.shots || []).length; return { w: 440, h: k ? Math.min(620, Math.max(300, 96 + k * 92)) : 300 }; }
  const v = curV(n);
  let ar = v && v.w ? v.w / v.h : (n.data.aspect !== "auto" ? AR[n.data.aspect] : (() => {
    const p=n.type==="video"?plan(n):null;
    const input=p?(p.ordered.length?p.inputs[p.ordered[0]]:audioInputs(n).length?p.inputs[0]:null):imageInputs(n)[0];
    const fv = (p && (previsInput(n)?.version || videoInputs(n)[0]?.version)) || input?.version;
    return fv && fv.w ? fv.w / fv.h : (n.type === "image" ? 1 : 16 / 9); })());
  if (n.type === "image") { const area = 300 * 380; let w = Math.sqrt(area * ar); w = Math.max(220, Math.min(460, w)); return { w: Math.round(w), h: Math.round(w / ar) }; }
  const area = 440 * 250; let w = Math.sqrt(area * ar); w = Math.max(240, Math.min(520, w)); return { w: Math.round(w), h: Math.round(w / ar) };
}

function removeNodes(ids) {
  if (!canvasCanEdit()) return;
  const targets = [...new Set(ids)].map(node).filter(Boolean);
  const removable = new Set(targets.filter(n => !nodeLocked(n)).map(n => n.id));
  const protectedCount = targets.length - removable.size;
  if (protectedCount) toast(`已保留 ${protectedCount} 个锁定节点，解锁后可删除`);
  if (!removable.size) return;
  checkpoint();
  for (const id of removable) { const n = node(id); if (n.job) cancel(n); els.get(id)?.remove(); els.delete(id); }
  B.nodes = B.nodes.filter(n => !removable.has(n.id));
  const touched = B.edges.filter(e => removable.has(e.from)).map(e => e.to);
  B.edges = B.edges.filter(e => !removable.has(e.from) && !removable.has(e.to));
  sel = new Set([...sel].filter(i => !removable.has(i)));
  touched.forEach(id => node(id) && refresh(node(id)));
  drawEdges(); save(); updateEmpty(); updateSel();renderNodePinBar();
}
function markCanvasNodes(ids, value, {lock = false} = {}) {
  if (!canvasCanEdit() || !lock && value && !NODE_PINS.has(value)) return;
  const nodes=[...new Set(ids)].map(node).filter(Boolean);
  const removeColor=!lock&&value&&nodes.every(n=>nodePins(n).includes(value));
  const changed=nodes.filter(n=>lock?nodeLocked(n)!==!!value:
    value?nodePins(n).includes(value)===!!removeColor:nodePins(n).length>0);
  if (!changed.length) return;
  checkpoint();
  for (const n of changed) {
    if(lock){
      if(value)n.locked=true;
      else delete n.locked;
    }else{
      const colors=!value?[]:removeColor?nodePins(n).filter(color=>color!==value):[...nodePins(n),value];
      if(colors.length){
        n.pins=colors;
        n.pin=colors[0];
      }else{
        delete n.pins; delete n.pin;
      }
    }
    render(n);
  }
  if(!lock)renderNodePinBar();
  showPanel();
  save();
}
