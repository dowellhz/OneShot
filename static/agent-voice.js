const acVoiceFormats = [
 ["audio/webm;codecs=opus", ".webm"],
 ["audio/mp4", ".m4a"],
 ["audio/ogg;codecs=opus", ".ogg"],
 ["audio/webm", ".webm"],
 ["audio/ogg", ".ogg"],
];
const acVoiceLimit = 8 * 1024 * 1024;
let acVoiceActive = null;
let acVoiceAvailable = false, acVoiceHold = null;
const acVoiceKeys = {KeyR:"R",Space:"空格",off:"关闭"};
let acVoiceKey = localStorage.getItem("h3.chat.voiceKey") || "KeyR";
if (!Object.hasOwn(acVoiceKeys,acVoiceKey)) acVoiceKey = "KeyR";

function acVoicePointing() {
 return acVoiceActive?.refs && ["permission","recording"].includes(acVoiceActive.phase);
}

function acVoicePoints() {
 vp.classList.toggle("ac-voice-pointing",!!acVoicePointing());
 for (const [id,el] of els) el.classList.toggle("ac-voice-reference",!!acVoicePointing() && acVoiceActive.refs.has(id));
}

function acVoiceRender(message = "") {
 const active = acVoiceActive;
 const record = $("#acVoiceRecord"), upload = $("#acVoiceUpload"), cancel = $("#acVoiceCancel");
 record.textContent = active?.phase === "recording" ? "停止录音" : "录音";
 record.setAttribute("aria-pressed", String(active?.phase === "recording"));
 record.disabled = !!active && active.phase !== "recording";
 upload.disabled = !!active;
 cancel.hidden = !active;
 const status = $("#acVoiceStatus");
 status.textContent = message;
 status.hidden = !message;
 acVoicePoints();
 acRenderPlacement();
}

function acVoiceRelease(active) {
 clearTimeout(active.timer);
 active.stream?.getTracks().forEach(track => track.stop());
 active.stream = null;
}

function acVoiceEnd(active, message = "") {
 if (acVoiceActive !== active) return;
 acVoiceActive = null;
 active.finishRange?.();
 active.controller?.abort();
 if (active.recorder?.state === "recording") active.recorder.stop();
 acVoiceRelease(active);
 acVoiceRender(message);
}

function acVoiceCancel() {
 if (acVoiceActive) acVoiceEnd(acVoiceActive);
 else if ($("#acVoiceStatus")) acVoiceRender();
}

async function acVoiceRefresh() {
 try {
  const {available} = await acApi("/api/transcription");
  acVoiceAvailable = available === true;
  $("#acVoice").hidden = !available;
  if (!available) acVoiceCancel();
 } catch {
  // Keep the last known availability until the next open.
 }
}

function acVoiceBegin(phase) {
 if (acVoiceActive || AC.sending || !AC.session || AC.board !== boardId || !canvasCanEdit()) return null;
 acVoiceActive = {phase, session: AC.session, board: boardId, epoch: AC.epoch};
 return acVoiceActive;
}

async function acVoiceSubmit(active, blob, filename) {
 if (acVoiceActive !== active) return;
 if (!blob.size) return acVoiceEnd(active, "没有收到音频，请重新录制或选择文件");
 if (blob.size > acVoiceLimit) return acVoiceEnd(active, "音频文件不能超过 8 MB");
 active.phase = "transcribing";
 active.controller = new AbortController();
 acVoiceRender("正在转写…");
 const form = new FormData();
 form.append("file", blob, filename);
 let message, send = false;
 try {
  const response = await fetch("/api/transcription", {method:"POST", body:form, signal:active.controller.signal});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "转写失败，请重试");
  if (acVoiceActive !== active || !AC.open || active.session !== AC.session ||
      active.board !== boardId || active.epoch !== AC.epoch) return;
  if (typeof result.text !== "string") throw new Error("转写服务返回异常，请重试");
  const transcript = result.text.trim();
  if (!transcript) {
   message = "没有识别到语音";
   return;
  }
  const input = $("#acInput");
  const newDraft = !input.value.trim();
  const separator = input.value && !/\s$/.test(input.value) ? "\n" : "";
  const available = input.maxLength - input.value.length - separator.length;
  if (available <= 0) {
   message = "草稿已达到长度上限";
   return;
  }
  const addition = transcript.slice(0, available).replace(/[\uD800-\uDBFF]$/, "");
  if (!addition) {
   message = "草稿已达到长度上限";
   return;
  }
  input.value += separator + addition;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  input.dispatchEvent(new Event("input", {bubbles:true}));
  message = addition === transcript ? "已添加到草稿" : "草稿达到长度上限，已添加可容纳的文字";
  if (active.placement) AC.placement = active.placement;
  if (active.refs && !acVoiceApplyReferences(active)) {
   acRenderRefs();
   message = "已保留转写草稿。引用的节点或版本有变化，请重新选择后发送";
   return;
  }
  send = active.autoSend && newDraft && addition === transcript && !AC.documentUpload;
 } catch (error) {
  message = error instanceof SyntaxError ? "转写服务返回异常，请重试" : (error.message || "转写失败，请重试");
 } finally {
  acVoiceEnd(active, message);
 }
 if (send) await acSend();
}

function acVoiceStop(active) {
 if (active.recorder.state !== "recording") return;
 active.finishRange?.(true);
 active.phase = "transcribing";
 active.recorder.stop();
 acVoiceRelease(active);
 acVoiceRender("正在转写…");
}

async function acVoiceRecord({hold = null} = {}) {
 if (acVoiceActive?.phase === "recording") return hold ? undefined : acVoiceStop(acVoiceActive);
 const format = window.MediaRecorder && acVoiceFormats.find(([type]) => MediaRecorder.isTypeSupported(type));
 if (!format || !navigator.mediaDevices?.getUserMedia) {
  acVoiceRender("当前页面无法录音，可用音频文件转写");
  return;
 }
 const active = acVoiceBegin("permission");
 if (!active) return;
 acPickPlacement(false);
 active.hold = hold;
 active.autoSend = !!hold;
 active.refs = new Map(acRefs().slice(0,30).map(n => {
  const explicit = AC.referencePins.get(n.id)?.ref || (AC.selection?.node_id === n.id ? AC.selection.source_ref : null) ||
   acReviewVersion(n);
  return [n.id,explicit || curV(n)?.ref || null];
 }));
 acVoiceRender("等待麦克风权限…");
 try {
  active.stream = await navigator.mediaDevices.getUserMedia({audio:true});
  if (acVoiceActive !== active) return acVoiceRelease(active);
  if (hold && acVoiceHold !== hold) return acVoiceEnd(active,"请再次按住说话");
  const [mimeType, extension] = format;
  const recorder = active.recorder = new MediaRecorder(active.stream, {mimeType, audioBitsPerSecond:64000});
  const chunks = [];
  let size = 0;
  recorder.ondataavailable = event => {
   if (acVoiceActive !== active || !event.data.size) return;
   size += event.data.size;
   if (size > acVoiceLimit) return acVoiceEnd(active, "音频文件不能超过 8 MB");
   chunks.push(event.data);
  };
  recorder.onerror = () => acVoiceEnd(active, "录音中断，请重试");
  recorder.onstop = () => {
   acVoiceRelease(active);
   if (acVoiceActive === active) acVoiceSubmit(active, new Blob(chunks, {type:mimeType}), "voice" + extension);
  };
  recorder.start(1000);
  active.phase = "recording";
  active.timer = setTimeout(() => acVoiceStop(active), 60000);
  acVoiceReferenceStatus();
 } catch (error) {
  acVoiceEnd(active, error.name === "NotAllowedError"
   ? "麦克风权限未开启，可用音频文件转写" : "无法使用麦克风，可用音频文件转写");
 }
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

function acVoiceHotkey(event) {
 if (event.key === "Escape" && (acVoiceActive?.refs || acVoiceHold)) {
  event.preventDefault(); event.stopPropagation(); acVoiceHold = null; acVoiceCancel(); return;
 }
 if (!acVoiceAvailable || event.code !== acVoiceKey || !B || !canvasCanEdit() ||
     event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing ||
     event.target.closest?.("input,textarea,select,button,[contenteditable=true],video,audio") ||
     document.querySelector("dialog[open],#film.on,#wiz.on,#pv.on,#settings.on,#help.on,#assetLibrary:not([hidden])")) return;
 if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia || acVoiceActive && !acVoiceHold) return;
 event.preventDefault();
 event.stopPropagation();
 if (event.repeat || acVoiceHold) return;
 const hold = acVoiceHold = {key:event.code,board:boardId};
 if (AC.open && AC.board === boardId && AC.session) void acVoiceRecord({hold});
 else void acOpen({focus:false}).then(() => {
  if (acVoiceHold === hold && hold.board === boardId && AC.open) void acVoiceRecord({hold});
 });
}

function acVoiceHotkeyUp(event) {
 const hold = acVoiceHold;
 if (!hold || event.code !== hold.key) return;
 event.preventDefault();
 acVoiceHold = null;
 const active = acVoiceActive;
 if (active?.hold !== hold) return;
 if (active.phase === "recording") acVoiceStop(active);
 else if (active.phase === "permission") acVoiceEnd(active,"请等麦克风开始录音后再说话");
}

function acVoiceInit() {
 const box = document.createElement("div");
 box.id = "acVoice";
 box.hidden = true;
 box.innerHTML = `<button type="button" id="acVoiceRecord" aria-pressed="false">录音</button>
  <button type="button" id="acVoiceUpload" title="将音频转写为草稿">音频</button>
  <label class="ac-voice-key">按住说话 <select id="acVoiceKey" aria-label="按住说话快捷键">${Object.entries(acVoiceKeys).map(([key,label])=>`<option value="${key}">${label}</option>`).join("")}</select></label>
  <button type="button" id="acVoiceCancel" title="取消录音或转写" hidden>取消</button>
  <input type="file" id="acVoiceFile" accept=".wav,.webm,.ogg,.m4a,.mp4,.mp3,.flac" hidden>
  <span id="acVoiceStatus" role="status" hidden></span>`;
 $("#agentChat .ac-composer").append(box);
 const picker = $("#acVoiceFile");
 $("#acVoiceRecord").onclick = () => acVoiceRecord();
 $("#acVoiceUpload").onclick = () => picker.click();
 $("#acVoiceCancel").onclick = acVoiceCancel;
 const shortcut = $("#acVoiceKey");
 shortcut.value = acVoiceKey;
 shortcut.onchange = () => {
  acVoiceKey = shortcut.value;
  localStorage.setItem("h3.chat.voiceKey",acVoiceKey);
 };
 document.addEventListener("keydown",acVoiceHotkey,true);
 document.addEventListener("keyup",acVoiceHotkeyUp,true);
 addEventListener("blur",() => {
  acVoiceHold = null;
  const active = acVoiceActive;
  if (active?.phase === "recording" || active?.phase === "permission" && active.hold) acVoiceEnd(active,"录音已取消");
 });
 vp.addEventListener("pointerdown",acVoicePoint,true);
 for (const type of ["click","dblclick"]) vp.addEventListener(type,event => {
  if (acVoicePointing() && (acCanvasBackground(event.target) || event.target.closest(".node"))) {
   event.preventDefault(); event.stopPropagation();
  }
 },true);
 void acVoiceRefresh();
 picker.onchange = () => {
  const file = picker.files[0];
  picker.value = "";
  if (!file) return;
  const active = acVoiceBegin("transcribing");
  if (active) acVoiceSubmit(active, file, file.name);
 };
}
