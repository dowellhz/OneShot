"use strict";

document.getElementById("audioToolDialogs").insertAdjacentHTML("beforebegin", OneShotI18n.html`
<dialog id="audioTranscript" aria-labelledby="audioTranscriptTitle">
  <header><strong id="audioTranscriptTitle">音频转写</strong><button type="button" data-transcript-close aria-label="关闭">×</button></header>
  <p data-transcript-source></p><audio controls preload="metadata"></audio>
  <form><label>开始（秒） <input name="in" type="number" min="0" step="any" required></label>
    <label>结束（秒） <input name="out" type="number" min="0" step="any" placeholder="音频末尾"></label>
    <button type="submit" data-transcript-run>开始转写</button></form>
  <p role="status"></p><div data-transcript-result></div>
  <footer><button type="button" data-transcript-download disabled>下载 SRT</button><button type="button" data-transcript-add disabled>放入画布</button><button type="button" data-transcript-cut disabled>剪出选中台词</button></footer>
</dialog>
`);

function closeAudioTranscript() {
  const dialog = $("#audioTranscript");
  if (!dialog.open) return;
  const player = $("audio",dialog);
  if (!player.paused) player.pause();
  player.removeAttribute("src");
  dialog.close?.();
  dialog.removeAttribute("open");
}

function transcriptTime(seconds) {
  const ms = Math.round(seconds * 1000);
  const pad = (n,digits=2) => String(n).padStart(digits,"0");
  return `${pad(Math.floor(ms/3600000))}:${pad(Math.floor(ms/60000)%60)}:${pad(Math.floor(ms/1000)%60)},${pad(ms%1000,3)}`;
}

function downloadTranscript(captions, name) {
  const srt = captions.map((cue,i)=>`${i + 1}\n${transcriptTime(cue.start)} --> ${transcriptTime(cue.end)}\n${cue.text.replace(/\n\s*\n/g,"\n")}`).join("\n\n");
  const url = URL.createObjectURL(new Blob([srt+"\n"],{type:"application/x-subrip;charset=utf-8"}));
  const download = document.createElement("a");
  download.href=url;download.download=name.replace(/[\\/:*?"<>|]/g,"_")+".srt";download.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

function openSavedTranscript(documentNode) {
  const saved = documentNode.data.transcript;
  if (!Array.isArray(saved?.cues) || !saved.cues.length) return toast("这份转写没有时间码");
  const source = node(saved?.source_node);
  if (source?.type !== "audio" || !source.versions.some(v=>v.ref===saved.source_ref)) return toast("原音频版本已移除");
  openAudioTranscript(source,saved);
}

function transcriptCuts(captions, selected) {
  const ranges = [];
  let group = null;
  captions.forEach((cue,index)=>{
    if (!selected.has(index)) { group=null; return; }
    if (!group) {
      group = {start:cue.start,end:cue.end,cues:[]};
      ranges.push(group);
    }
    group.end = cue.end;
    group.cues.push({...cue});
  });
  return ranges;
}

function addTranscriptNode(source, version, text, result, at, extra={}) {
  const n = addNode("text",at.x,at.y,{text,transcript:{source_node:source.id,source_ref:version.ref,
    start:result.start,end:result.end,cues:result.captions}},{name:source.name+" · 转写",...extra});
  B.edges.push({from:source.id,to:n.id,relation:"transcript",source_ref:version.ref});
  return n;
}

function addGeneratedAudioSubtitle(source,version) {
  const saved=version.audio_transcript;
  if (!saved?.cues?.length) return;
  const id="nsub_"+version.ref.split("/").at(-1).replace(/\.[^.]+$/,"").replace(/[^A-Za-z0-9_-]/g,"_").slice(0,35);
  if (node(id)) return;
  const at=freeSpot(source.x+size(source).w+110,source.y,"text");
  const text=saved.cues.map(cue=>cue.text).join("\n");
  addTranscriptNode(source,version,text,{...saved,captions:structuredClone(saved.cues)},at,{id,name:source.name+" · 字幕"});
}

function openAudioTranscript(source,saved,version = saved ? source.versions.find(v=>v.ref===saved.source_ref) : curV(source)) {
  const dialog = $("#audioTranscript");
  if (!canvasCanEdit() || !version?.ref || !source.versions.includes(version) || dialog.open) return;
  saved ||= version.audio_transcript;
  const player = $("audio",dialog), form = $("form",dialog), resultBox = $("[data-transcript-result]",dialog);
  const start = form.elements.namedItem("in"), end = form.elements.namedItem("out");
  const status = $("[role=status]",dialog), identify = $("[data-transcript-source]",dialog);
  const run = $("[data-transcript-run]",dialog), add = $("[data-transcript-add]",dialog), download = $("[data-transcript-download]",dialog);
  const cut = $("[data-transcript-cut]",dialog), selected = new Set();
  const board = B, bid = boardId;
  const active = () => dialog.open && form.onsubmit === submit && B === board;
  const boundSource = () => {
    const n = node(source.id);
    return n?.type === "audio" && n.versions.some(v=>v.ref===version.ref) ? n : null;
  };
  let result = saved ? {start:saved.start,end:saved.end,captions:structuredClone(saved.cues),text:""} : null;
  let cutting = false;
  const cues = () => (result?.captions || []).filter(cue=>cue.text.trim());
  const transcript = () => (result?.captions.length ? cues().map(cue=>cue.text.trim()).join("\n") : result?.text || "").trim();
  function updateActions() {
    const text = transcript();
    add.disabled = cutting || !text || text.length > 20_000 || !canvasCanEdit();
    add.title = text.length > 20_000 ? "正文超过单个画布文档的 20,000 字符上限" : "";
    download.disabled = !cues().length;
    cut.disabled = cutting || run.disabled || !selected.size || !canvasCanEdit();
  }

  player.src = version.url;
  identify.textContent = source.name + " · 版本 " + (source.versions.indexOf(version)+1);
  start.value = String(saved?.start ?? 0);
  end.value = saved ? String(saved.end) : version.seconds > 0 ? String(Math.min(90,version.seconds)) : "";
  status.textContent = "";
  resultBox.replaceChildren();
  run.disabled = false;
  paintResult();

  async function submit(event) {
    event.preventDefault();
    if (run.disabled || cutting || !canvasCanEdit() || !boundSource()) return;
    const first = start.valueAsNumber, last = end.value ? end.valueAsNumber : null;
    if (!Number.isFinite(first) || first < 0 || (last !== null && (!Number.isFinite(last) || last <= first || last - first > 90))) {
      status.textContent="请填写有效的起止时间，每次最多转写 90 秒";
      return;
    }
    run.disabled = true;
    updateActions();
    status.textContent = "正在转写…";
    try {
      await flushSave();
      if (!active() || !canvasCanEdit() || !boundSource()) return;
      result = await boardRequest("/api/audio/transcript","POST",{board:bid,node:source.id,ref:version.ref,in:first,out:last});
      if (!active()) return;
      paintResult();
    } catch (error) {
      if (active()) status.textContent = error.message;
    } finally {
      if (active()) { run.disabled=false;updateActions(); }
    }
  }

  function paintResult() {
    resultBox.replaceChildren();
    selected.clear();
    if (result) {
      if (result.captions.length) {
        for (const [index,cue] of result.captions.entries()) {
          const row = document.createElement("div");
          const keep = document.createElement("input");
          keep.type = "checkbox";keep.checked = true;
          keep.setAttribute("aria-label","保留第 " + (index+1) + " 句音频");
          selected.add(index);
          keep.onchange = () => { if (keep.checked) selected.add(index); else selected.delete(index); updateActions(); };
          const seek = document.createElement("button");
          seek.type = "button";seek.textContent = transcriptTime(cue.start).replace(",",".");
          seek.setAttribute("aria-label","定位到 " + seek.textContent);
          seek.onclick = () => { if (player.readyState) player.currentTime = cue.start; };
          const field = document.createElement("textarea");
          field.value = cue.text;field.rows = 2;field.maxLength = 500;
          field.setAttribute("aria-label","台词 " + (index+1));
          field.oninput = () => { cue.text = field.value; updateActions(); };
          row.append(keep,seek,field);resultBox.append(row);
        }
        status.textContent = "勾选要保留的台词。连续勾选的台词会保留中间的停顿。";
      } else if (result.text) {
        const field = document.createElement("textarea");
        field.value = result.text;field.rows = 8;field.maxLength = 20_000;
        field.setAttribute("aria-label","转写文本");
        field.oninput = () => { result.text = field.value; updateActions(); };
        resultBox.append(field);
        status.textContent = "服务返回了纯文本，可校对后放入画布。";
      } else status.textContent = "这段音频未识别到台词";
    }
    updateActions();
  }

  form.onsubmit = submit;
  add.onclick = () => {
    const origin = boundSource(), text = transcript();
    if (!active() || !canvasCanEdit() || !origin || !text || text.length > 20_000) {
      status.textContent = "原音频版本不可用，或正文超出画布文档长度";
      return;
    }
    const at = freeSpot(origin.x+size(origin).w+110,origin.y,"text");
    checkpoint();
    const n = addTranscriptNode(origin,version,text,{...result,captions:cues()},at);
    selectOnly(n.id);save();closeAudioTranscript();
  };
  cut.onclick = async () => {
    if (cut.disabled || !active() || !boundSource()) return;
    const groups = transcriptCuts(result.captions,selected);
    cutting = true;
    status.textContent = "正在剪辑音频…";
    updateActions();
    try {
      await flushSave();
      if (!active() || !canvasCanEdit() || !boundSource()) return;
      const edited = await boardRequest("/api/audio/cut","POST",{board:bid,node:source.id,ref:version.ref,
        ranges:groups.map(({start,end})=>({start,end}))});
      const origin = boundSource();
      if (!active() || !canvasCanEdit()) return;
      if (!origin) throw new Error("原音频版本已移除");
      const captions = groups.flatMap(({cues},index)=>{
        const range = edited.ranges[index];
        const remap = seconds=>+(range.at + seconds - range.start).toFixed(3);
        return cues.map(cue=>({start:remap(Math.max(cue.start,range.start)),end:remap(Math.min(cue.end,range.end)),text:cue.text.trim()}))
          .filter(cue=>cue.text && cue.end>cue.start);
      });
      checkpoint();
      const at = freeSpot(origin.x+size(origin).w+110,origin.y,"audio");
      const output = {ref:edited.ref,url:edited.url,seconds:edited.seconds,source:"audio_cut",
        audio_cut:{source_ref:version.ref,source_node:origin.id,ranges:edited.ranges}};
      const audio = addNode("audio",at.x,at.y,{}, {name:origin.name+" · 台词剪辑",versions:[output],cur:0});
      B.edges.push({from:origin.id,to:audio.id,relation:"audio_cut",source_ref:version.ref});
      const text = captions.map(cue=>cue.text).join("\n");
      if (text && text.length <= 20_000) addTranscriptNode(audio,output,text,{start:0,end:edited.seconds,captions},
        freeSpot(audio.x+size(audio).w+110,audio.y,"text"));
      selectOnly(audio.id);save();closeAudioTranscript();
      toast("已剪出保留的台词");
    } catch (error) { if (active()) status.textContent=error.message; }
    finally { if (active()) { cutting=false;updateActions(); } }
  };
  download.onclick = () => downloadTranscript(cues(),source.name);
  $("[data-transcript-close]",dialog).onclick = closeAudioTranscript;
  dialog.oncancel = event => { event.preventDefault();closeAudioTranscript(); };
  dialog.onkeydown = event => event.stopPropagation();
  if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open","");
}
