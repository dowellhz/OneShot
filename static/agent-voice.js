const acVoiceFormats = [
 ["audio/webm;codecs=opus", ".webm"],
 ["audio/mp4", ".m4a"],
 ["audio/ogg;codecs=opus", ".ogg"],
 ["audio/webm", ".webm"],
 ["audio/ogg", ".ogg"],
];
const acVoiceLimit = 8 * 1024 * 1024;
const voicePreviewInterval = 9000;
const voicePreviewMaxRequests = 6;
let acVoiceActive = null;
let acVoiceAvailable = false, acVoiceHold = null;
let voicePreviewEnabled = localStorage.getItem("h3.voice.livePreview") === "true";
let acVoiceChoosingKey = false;
const acVoiceKeys = {KeyR:"R",Space:"空格",off:"关闭"};
const acVoiceKeyValid = code => Object.hasOwn(acVoiceKeys,code) || /^(?:Key[A-Z]|Digit[0-9])$/.test(code);
const acVoiceKeyLabel = code => acVoiceKeys[code] || code.replace(/^(?:Key|Digit)/,"");
const acVoiceStopCommands = new Set(["停止","停止任务","停止当前任务","取消当前任务","stop","stop the current task"]);
const voiceRecordingFormat = () => navigator.mediaDevices?.getUserMedia &&
 window.MediaRecorder && acVoiceFormats.find(([type]) => MediaRecorder.isTypeSupported(type));
let acVoiceKey = localStorage.getItem("h3.chat.voiceKey") || "KeyR";
if (!acVoiceKeyValid(acVoiceKey)) acVoiceKey = "KeyR";

function acVoiceKeyOptions() {
 const picker = $("#acVoiceKey");
 const codes = new Set(["KeyR","Space",acVoiceKey,"off"]);
 picker.replaceChildren(...[...codes].map(code=>new Option(acVoiceKeyLabel(code),code)),
  new Option("自定义按键…","custom"));
 picker.value=acVoiceKey;
}

function acVoiceSetKey(code) {
 acVoiceKey=code;
 acVoiceChoosingKey=false;
 localStorage.setItem("h3.chat.voiceKey",code);
 acVoiceKeyOptions();
 acVoiceRender();
}

function acVoicePointing() {
 return acVoiceActive?.refs && ["permission","recording"].includes(acVoiceActive.phase);
}

function acVoicePoints() {
 vp.classList.toggle("ac-voice-pointing",!!acVoicePointing());
 for (const [id,el] of els) el.classList.toggle("ac-voice-reference",!!acVoicePointing() && acVoiceActive.refs.has(id));
}

function acVoiceRender(message = "") {
 const active = acVoiceActive;
 const assistant = active?.target ? null : active;
 const record = $("#acVoiceRecord"), upload = $("#acVoiceUpload"), cancel = $("#acVoiceCancel");
 record.textContent = assistant?.phase === "recording" ? "停止录音" : "录音";
 record.setAttribute("aria-pressed", String(assistant?.phase === "recording"));
 record.disabled = !!active && assistant?.phase !== "recording";
 upload.disabled = !!active;
 $("#acVoiceKey").disabled = !!active;
 cancel.hidden = !assistant;
 const status = $("#acVoiceStatus");
 if (!active?.target) {
  status.textContent = message;
  status.hidden = !message;
 }
 nodeVoiceRender(active?.target ? message : undefined);
 renderVoicePreview();
 acVoicePoints();
 acRenderPlacement();
}

function renderVoicePreview() {
 const active = acVoiceActive;
 for (const [setting,output,isNode] of [
  [$("#acVoiceLive"),$("#acVoicePreview"),false],
  [$("#ppVoiceLive"),$("#ppVoicePreview"),true]
 ]) {
  if (setting) {
   setting.checked = voicePreviewEnabled;
   setting.disabled = !!active;
  }
  if (output) {
   const text = active && !!active.target === isNode ? active.previewText : "";
   output.textContent = text || "";
   output.hidden = !text;
  }
 }
}

function acVoiceRelease(active) {
 clearTimeout(active.timer);
 active.previewController?.abort();
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
 acVoiceRender(active.target ? "" : message);
 if (active.target) nodeVoiceRender(message);
}

function acVoiceCancel() {
 if (acVoiceChoosingKey) {
  acVoiceChoosingKey=false;
  acVoiceKeyOptions();
 }
 if (acVoiceActive) acVoiceEnd(acVoiceActive);
 else if ($("#acVoiceStatus")) acVoiceRender();
}

async function acVoiceRefresh() {
 try {
  const {available} = await acApi("/api/transcription");
  acVoiceAvailable = available === true;
  $("#acVoice").hidden = !available;
  if (!available) acVoiceCancel();
  nodeVoiceRender();
 } catch {
  // Keep the last known availability until the next open.
 }
}

function acVoiceBegin(phase) {
 if (acVoiceActive || AC.sending || !AC.session || AC.board !== boardId || !canvasCanEdit()) return null;
 acVoiceActive = {phase, session: AC.session, board: boardId, epoch: AC.epoch};
 return acVoiceActive;
}

async function voiceTranscription(blob, filename, signal, preview = false) {
 const form = new FormData();
 form.append("file", blob, filename);
 const response = await fetch(preview ? "/api/transcription?preview=1" : "/api/transcription", {method:"POST", body:form, signal});
 const result = await response.json();
 if (!response.ok) throw new Error(result.error || "转写失败，请重试");
 if (typeof result.text !== "string") throw new Error("转写服务返回异常，请重试");
 return result.text.trim();
}

async function requestVoicePreview(active, chunks, mimeType, filename) {
 if (!active.livePreview || active.phase !== "recording" || active.previewController ||
     active.previewRequests >= voicePreviewMaxRequests || performance.now() < active.nextPreviewAt) return;
 const controller = active.previewController = new AbortController();
 active.previewRequests++;
 active.nextPreviewAt = performance.now() + voicePreviewInterval;
 try {
  const text = await voiceTranscription(new Blob(chunks,{type:mimeType}),filename,controller.signal,true);
  if (acVoiceActive === active && active.phase === "recording" && !controller.signal.aborted && text) {
   active.previewText = text;
   renderVoicePreview();
  }
 } catch {
  // A growing recording can be unreadable until the recorder finishes.
 } finally {
  active.previewController = null;
 }
}

async function acVoiceSubmit(active, blob, filename) {
 if (acVoiceActive !== active) return;
 if (!blob.size) return acVoiceEnd(active, "没有收到音频，请重新录制或选择文件");
 if (blob.size > acVoiceLimit) return acVoiceEnd(active, "音频文件不能超过 8 MB");
 active.phase = "transcribing";
 active.controller = new AbortController();
 acVoiceRender("正在转写…");
 let message, send = false;
 try {
  const transcript = await voiceTranscription(blob,filename,active.controller.signal);
  if (acVoiceActive !== active) return;
  if (active.target ? !nodeVoiceCurrent(active) :
      !AC.open || active.session !== AC.session || active.board !== boardId || active.epoch !== AC.epoch) return;
  if (!transcript) {
   message = "没有识别到语音";
   return;
  }
  if (active.target) {
   message = nodeVoiceInsert(active.target, transcript);
   return;
  }
  const command = transcript.toLocaleLowerCase().replace(/[.!?。！？]+$/u,"").trim();
  if (active.hold && acVoiceStopCommands.has(command)) {
   const stopped = active.stopRun && await acStopCurrent(active.stopRun);
   message = stopped ? "已请求停止当前任务" :
    active.stopRun ? "录音开始时的任务已无法停止" : "录音开始时没有可停止的任务";
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
 if (acVoiceActive?.phase === "recording") {
  if (!hold && !acVoiceActive.target) acVoiceStop(acVoiceActive);
  return;
 }
 const format = voiceRecordingFormat();
 if (!format) {
  acVoiceRender("当前页面无法录音，可用音频文件转写");
  return;
 }
 const active = acVoiceBegin("permission");
 if (!active) return;
 acPickPlacement(false);
 active.hold = hold;
 active.autoSend = !!hold;
 active.stopRun = hold ? acActive()?.id : null;
 active.refs = new Map(acRefs().slice(0,30).map(n => {
  const explicit = AC.referencePins.get(n.id)?.ref || (AC.selection?.node_id === n.id ? AC.selection.source_ref : null) ||
   acReviewVersion(n);
  return [n.id,explicit || curV(n)?.ref || null];
 }));
 await voiceRecord(active, format);
}

async function voiceRecord(active, format) {
 acVoiceRender("等待麦克风权限…");
 try {
  active.stream = await navigator.mediaDevices.getUserMedia({audio:true});
  if (acVoiceActive !== active) return acVoiceRelease(active);
  if (active.target && !nodeVoiceCurrent(active)) return acVoiceEnd(active);
  if (active.hold && acVoiceHold !== active.hold) return acVoiceEnd(active,"请再次按住说话");
  const [mimeType, extension] = format;
  const filename = "voice" + extension;
  const recorder = active.recorder = new MediaRecorder(active.stream, {mimeType, audioBitsPerSecond:64000});
  active.livePreview = voicePreviewEnabled;
  active.previewRequests = 0;
  active.nextPreviewAt = performance.now() + 4000;
  const chunks = [];
  let size = 0;
  recorder.ondataavailable = event => {
   if (acVoiceActive !== active || !event.data.size) return;
   size += event.data.size;
   if (size > acVoiceLimit) return acVoiceEnd(active, "音频文件不能超过 8 MB");
   chunks.push(event.data);
   if (active.livePreview) void requestVoicePreview(active,chunks,mimeType,filename);
  };
  recorder.onerror = () => acVoiceEnd(active, "录音中断，请重试");
  recorder.onstop = () => {
   acVoiceRelease(active);
   if (acVoiceActive !== active) return;
   if (active.phase !== "transcribing") return acVoiceEnd(active,"录音中断，请重试");
   void acVoiceSubmit(active,new Blob(chunks,{type:mimeType}),filename);
  };
  recorder.start(1000);
  active.phase = "recording";
  active.timer = setTimeout(() => acVoiceStop(active), 60000);
  if (active.target) acVoiceRender("正在录音…");
  else acVoiceReferenceStatus();
 } catch (error) {
  const reason = error.name === "NotAllowedError" ? "麦克风权限未开启" : "无法使用麦克风";
  acVoiceEnd(active, active.target ? reason : reason + "，可用音频文件转写");
 }
}

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
 const source = B && sel.size === 1 ? node([...sel][0]) : null;
 if (box._source !== source) {
  box._source = source;
  status.textContent = "";
 }
 const active = acVoiceActive;
 const recording = active?.target && active.phase === "recording";
 box.hidden = !acVoiceAvailable || !canvasCanEdit() || !nodeVoiceTarget(source);
 button.textContent = recording ? "停止录音" : "语音输入";
 button.setAttribute("aria-pressed", String(!!recording));
 button.disabled = !!source?.job || !!source && prepping.has(source.id) || !!active && !recording;
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

function nodeVoiceStart(hold = null) {
 if (acVoiceActive || $("#ppVoiceRecord").disabled || $("#ppVoice").hidden) return;
 const source = $("#ppVoice")._source, target = nodeVoiceTarget(source);
 if (!target) return;
 const format = voiceRecordingFormat();
 if (!format) return nodeVoiceRender("当前页面无法使用麦克风");
 const active = {phase:"permission",board:B,source,target,hold};
 if (!nodeVoiceCurrent(active)) return;
 acVoiceActive = active;
 void voiceRecord(active,format);
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
 if (acVoiceChoosingKey && !event.isComposing) {
  event.preventDefault();
  event.stopPropagation();
  if (event.key==="Escape") return acVoiceCancel();
  if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (acVoiceKeyValid(event.code)) acVoiceSetKey(event.code);
  else acVoiceRender("请选择一个字母、数字或空格键");
  return;
 }
 if (event.key === "Escape" && (acVoiceActive?.refs || acVoiceActive?.target || acVoiceHold)) {
  event.preventDefault(); event.stopPropagation(); acVoiceHold = null; acVoiceCancel(); return;
 }
 if (event.code === "Space" && event.target === $("#ppVoiceRecord") && !event.isComposing &&
     !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat && !acVoiceActive && !acVoiceHold && voiceRecordingFormat()) {
   const hold = acVoiceHold = {key:event.code};
   nodeVoiceStart(hold);
  }
  return;
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
  <label class="ac-voice-key">按住说话 <select id="acVoiceKey" aria-label="按住说话快捷键"></select></label>
  <button type="button" id="acVoiceCancel" title="取消录音或转写" hidden>取消</button>
  <input type="file" id="acVoiceFile" accept=".wav,.webm,.ogg,.m4a,.mp4,.mp3,.flac" hidden>
  <label class="voice-live-setting" title="录音时会额外调用转写服务，可能产生额外费用"><input type="checkbox" id="acVoiceLive">实时预览</label>
  <span id="acVoiceStatus" role="status" hidden></span>
  <output class="voice-live-preview" id="acVoicePreview" aria-label="实时转写草稿" hidden></output>`;
 $("#agentChat .ac-composer").append(box);
 const picker = $("#acVoiceFile");
 $("#acVoiceRecord").onclick = () => acVoiceRecord();
 $("#acVoiceUpload").onclick = () => picker.click();
 $("#acVoiceCancel").onclick = acVoiceCancel;
 $("#ppVoiceRecord").onclick = () => {
  if (acVoiceActive?.target && acVoiceActive.phase === "recording") acVoiceStop(acVoiceActive);
  else nodeVoiceStart();
 };
 $("#ppVoiceCancel").onclick = acVoiceCancel;
 for (const setting of [$("#acVoiceLive"),$("#ppVoiceLive")]) setting.onchange = () => {
  voicePreviewEnabled = setting.checked;
  localStorage.setItem("h3.voice.livePreview",String(voicePreviewEnabled));
  renderVoicePreview();
 };
 renderVoicePreview();
 const shortcut = $("#acVoiceKey");
 acVoiceKeyOptions();
 shortcut.onchange = () => {
  if (shortcut.value==="custom") {
   acVoiceChoosingKey=true;
   acVoiceRender("按下一个字母、数字或空格键，Esc 取消");
  } else acVoiceSetKey(shortcut.value);
 };
 document.addEventListener("keydown",acVoiceHotkey,true);
 document.addEventListener("keyup",acVoiceHotkeyUp,true);
 addEventListener("blur",() => {
  acVoiceHold = null;
  if (acVoiceChoosingKey) acVoiceCancel();
  const active = acVoiceActive;
  if (active?.phase === "recording" || active?.phase === "permission" && (active.hold || active.target)) acVoiceEnd(active,"录音已取消");
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
