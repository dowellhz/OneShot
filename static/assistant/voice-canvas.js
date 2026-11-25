"use strict";

function nodeVoiceTarget(n) {
 if (!n || !["image","video","audio"].includes(n.type) || n.data.film || n.data.previs) return null;
 if (usesFields(n)) {
  const fields = $("#pfields");
  if (fields._node !== n.id) return null;
  return fields.contains(lastField) ? lastField : $("textarea[data-k=action]",fields);
 }
 const prompt = $("#prompt");
 return prompt._node === n.id ? prompt : null;
}

function nodeVoiceCurrent(active) {
 const {board, source, target} = active;
 return B === board && node(source.id) === source && sel.size === 1 && sel.has(source.id) && canvasCanEdit() &&
   !source.job && !prepping.has(source.id) && target.isConnected &&
   (target === $("#prompt") ? !usesFields(source) && target._node === source.id :
    usesFields(source) && $("#pfields")._node === source.id);
}

function nodeVoiceRender(message) {
 const box = $("#ppVoice"), button = $("#ppVoiceRecord"), status = $("#ppVoiceStatus");
 const upload = $("#ppVoiceUpload");
 const source = B && sel.size === 1 ? node([...sel][0]) : null;
 if (box._source !== source) {
  box._source = source;
  status.textContent = "";
 }
 const active = acVoiceActive;
 const recording = active?.target && active.phase === "recording";
 box.hidden = !acVoiceAvailable || !canvasCanEdit() || !nodeVoiceTarget(source);
 button.textContent = recording ? "停止录音" : OneShotI18n.t("语音输入");
 button.setAttribute("aria-pressed", String(!!recording));
 const busy = !!source?.job || !!source && prepping.has(source.id);
 button.disabled = busy || !!active && !recording;
 upload.disabled = busy || !!active;
 $("#ppVoiceCancel").hidden = !active?.target;
 if (message !== undefined) status.textContent = message;
}

function nodeVoiceSync() {
 const active = acVoiceActive;
 if (active?.target && !nodeVoiceCurrent(active)) acVoiceEnd(active);
 else nodeVoiceRender();
}

function nodeVoiceInsert(target, transcript) {
 const separator = target.value && !/\s$/.test(target.value) ? "\n" : "";
 const room = target.maxLength < 0 ? transcript.length : target.maxLength - target.value.length - separator.length;
 const addition = transcript.slice(0,Math.max(0,room)).replace(/[\uD800-\uDBFF]$/,"");
 if (!addition) return "提示词已达到长度上限";
 checkpoint();
 target.value += separator + addition;
 target.focus();
 target.setSelectionRange(target.value.length,target.value.length);
 target.dispatchEvent(new Event("input",{bubbles:true}));
 target._before = snap();
 return addition === transcript ? "已填入提示词" : "已填入可容纳的文字";
}

function nodeVoiceSelection() {
 if (acVoiceActive || $("#ppVoice").hidden) return null;
 const source = $("#ppVoice")._source, target = nodeVoiceTarget(source);
 const selection = {board:B,source,target};
 return target && nodeVoiceCurrent(selection) ? selection : null;
}

function nodeVoiceStart(hold = null) {
 const selection = nodeVoiceSelection();
 if (!selection) return;
 const format = voiceRecordingFormat();
 if (!format) {
  nodeVoiceRender(window.isSecureContext === false ? "请用 HTTPS 访问以使用麦克风，或选择音频转写" : "当前页面无法录音，可用音频文件转写");
  return;
 }
 acVoiceActive = {...selection,phase:"permission",hold};
 void voiceRecord(acVoiceActive,format);
}

function acVoiceApplyReferences(active) {
 const requested = [...active.refs].map(([id,ref]) => ({n:node(id),ref}));
 if (requested.some(({n,ref}) => !n || ref && !n.versions.some(v => v.ref === ref))) return false;
 const previous = {refs:AC.refs,pins:new Map(AC.referencePins)};
 AC.refs = requested.map(({n}) => n.id);
 if (requested.every(({n,ref}) => acAttachNodeReference(n,ref))) {
  acRenderRefs();
  return true;
 }
 AC.refs = previous.refs;
 AC.referencePins = previous.pins;
 acRenderRefs();
 return false;
}

function acVoiceReferenceStatus() {
 const active = acVoiceActive;
 const text = active.phase === "permission" ? "等待麦克风权限" : "正在录音";
 acVoiceRender(`${text} · 点选素材或标记空白位置${active.refs.size ? ` · 已引用 ${active.refs.size} 个` : ""}${active.placement ? " · 已指定位置" : ""}`);
}

function acVoiceAddReferences(active,ids) {
 for (const id of ids) {
  const n = node(id);
  if (!n || !active.refs.has(id) && active.refs.size >= 30) continue;
  const ref = curV(n)?.ref || null;
  active.refs.set(id,ref);
 }
 acVoiceReferenceStatus();
}

function acVoicePoint(event) {
 if (event.button !== 0 || !acVoicePointing()) return;
 const active = acVoiceActive;
 const card = event.target.closest(".node");
 const background = acCanvasBackground(event.target);
 if (!card && !background) return;
 event.preventDefault();
 event.stopPropagation();
 if (card) return acVoiceAddReferences(active,[card.dataset.id]);
 const box = $("#marquee"), start = {x:event.clientX,y:event.clientY};
 const point = toW(start.x,start.y);
 const listeners = new AbortController(), options = {signal:listeners.signal};
 const pointer = event.pointerId;
 let range, moved = false;
 function move(e) {
  if (e.pointerId !== pointer) return;
  const x = Math.min(e.clientX,start.x), y = Math.min(e.clientY,start.y);
  const w = Math.abs(e.clientX-start.x), h = Math.abs(e.clientY-start.y);
  if (w + h < 6) { range = null; box.style.display = "none"; return; }
  moved = true;
  range = {x,y,w,h};
  Object.assign(box.style,{display:"block",left:x+"px",top:y+"px",width:w+"px",height:h+"px"});
 }
 active.finishRange?.();
 active.finishRange = (apply = false, clicked = false) => {
  listeners.abort();
  active.finishRange = null;
  box.style.display = "none";
  if (!apply || acVoiceActive !== active) return;
  if (!range) {
   if (clicked && !moved) {
    const placement=acPlacementPoint(point);
    if (placement) { active.placement=placement; acVoiceReferenceStatus(); }
   }
   return;
  }
  const ids = [...els].filter(([id,el]) => {
   if (el.hidden || ctFolded(id)) return false;
   const cardRect = $(".card",el).getBoundingClientRect();
   const x = cardRect.left + cardRect.width / 2, y = cardRect.top + cardRect.height / 2;
   return x >= range.x && x <= range.x + range.w && y >= range.y && y <= range.y + range.h;
  }).map(([id]) => id);
  acVoiceAddReferences(active,ids);
 };
 addEventListener("pointermove",move,options);
 addEventListener("pointerup",e => {
  if (e.pointerId === pointer) { move(e); active.finishRange?.(true,true); }
 },options);
 addEventListener("pointercancel",e => { if (e.pointerId === pointer) active.finishRange?.(); },options);
}
