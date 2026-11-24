"use strict";

function closeVideoGif() {
  const dialog = $("#videoGif"), video = $("video",dialog);
  if (!dialog.open) return;
  if (!video.paused) video.pause();
  video.onloadedmetadata = null;
  video.removeAttribute("src");
  $("[data-gif-grid-preview] img",dialog).removeAttribute("src");
  const preview = $(".gif-preview",dialog);
  preview.hidden = true;
  $("img",preview).removeAttribute("src");
  $("a",preview).removeAttribute("href");
  if (dialog.open && dialog.close) dialog.close(); else dialog.removeAttribute("open");
}

function openGifExport(source, version = curV(source)) {
  const dialog = $("#videoGif");
  if (!version?.ref || !source.versions.includes(version) || dialog.open) return;
  const board = boardId, form = $("form",dialog), video = $("video",form);
  const {start,end,size,fps,pingPong,rows,cols,first,last} = form.elements;
  const grid = source.type==="image", gridPreview=$("[data-gif-grid-preview]",form);
  const cells = $("[data-gif-cells]",form);
  const preview = $(".gif-preview",form), submit = $("button[type=submit]",form), status = $("[data-gif-status]",form);
  const publish = $("[data-gif-publish]",preview);
  let duration = version.seconds || 0, busy = false, total = 16;
  form.reset();
  video.hidden = $("[data-gif-video-controls]",form).hidden = grid;
  gridPreview.hidden = $("[data-gif-grid-controls]",form).hidden = !grid;
  $("#videoGifTitle").textContent = grid ? "宫格生成 GIF" : "导出循环 GIF";
  if (grid) fps.value = "8";
  start.value = "0";
  end.value = duration ? String(Math.min(3,duration)) : "";
  $("[data-gif-source]",form).textContent = source.name + " · 版本 " + (source.versions.indexOf(version)+1);
  const active = () => dialog.open && boardId===board && form.onsubmit===convert;
  function gridRange() {
    const r=rows.valueAsNumber,c=cols.valueAsNumber,a=first.valueAsNumber,b=last.valueAsNumber;
    const gridValid=[r,c].every(t=>Number.isInteger(t)&&t>=1&&t<=6);
    const valid=gridValid && Number.isInteger(a)&&Number.isInteger(b)&&a>=1&&a<b&&b<=r*c;
    cells.style.gridTemplateColumns=gridValid ? `repeat(${c},1fr)` : "";
    cells.style.gridTemplateRows=gridValid ? `repeat(${r},1fr)` : "";
    cells.replaceChildren(...Array.from({length:gridValid?r*c:0},(_,i)=>{
      const number=document.createElement("span");
      number.textContent=String(i+1);
      number.toggleAttribute("data-selected",valid&&a<=i+1&&i+1<=b);
      return number;
    }));
    return {valid, message:valid?`已选 ${b-a+1} 帧 · 按行播放`:"请选择 1–6 行列及至少两格连续画面"};
  }
  function update(message = "") {
    const span = end.valueAsNumber - start.valueAsNumber;
    const valid = duration>0 && start.valueAsNumber>=0 && end.valueAsNumber<=duration+.005 && span>=.25 && span<=8;
    const selection = grid ? gridRange() : {valid,message:valid?`已选 ${span.toFixed(2)} 秒`:
      duration?"请选择原片内 0.25–8 秒的区间":"正在读取视频时长…"};
    for (const input of [start,end,size,fps,pingPong,rows,cols,first,last]) input.disabled=busy;
    submit.disabled=busy || !selection.valid;
    status.textContent=message || selection.message;
  }
  function changed() {
    preview.hidden = true;
    $("img",preview).removeAttribute("src");
    $("a",preview).removeAttribute("href");
    update();
  }
  form.oninput = event => {
    if (grid && (event.target===rows || event.target===cols) && rows.validity.valid && cols.validity.valid) {
      const next = rows.valueAsNumber * cols.valueAsNumber;
      if (Number.isInteger(next) && next>=1) {
        if (last.valueAsNumber===total || last.valueAsNumber>next) last.value=String(next);
        total=next;
      }
    }
    changed();
  };
  video.onloadedmetadata = () => {
    if (!active() || !Number.isFinite(video.duration)) return;
    duration=video.duration;
    if (!end.value || end.valueAsNumber>duration) end.value=String(Math.min(3,duration));
    update();
  };
  for (const button of $$("[data-gif-point]",form)) button.onclick = () => {
    if (busy || video.readyState<1) return;
    form.elements[button.dataset.gifPoint].value=String(Math.round(video.currentTime*1000)/1000);
    changed();
  };
  async function convert(event) {
    event.preventDefault();
    if (!active() || submit.disabled) return;
    if (!node(source.id)?.versions.some(v=>v.ref===version.ref)) return update("原素材版本已移除");
    const range=grid?{rows:rows.valueAsNumber,cols:cols.valueAsNumber,first:first.valueAsNumber,last:last.valueAsNumber}:
      {start:start.valueAsNumber,end:end.valueAsNumber};
    const payload={ref:version.ref,...range,
      fps:Number(fps.value),size:Number(size.value),ping_pong:pingPong.checked};
    changed();
    busy=true; update("正在生成 GIF…");
    try {
      const result=await api(grid?"/api/image/gif":"/api/video/gif",payload);
      if (!active()) return;
      const url="/media?ref="+encodeURIComponent(result.ref), link=$("a",preview);
      $("img",preview).src=url;
      link.href=url;
      link.download=result.ref.split("/").pop();
      preview.hidden=false;
      publish.hidden=!showcaseCanPublish();
      publish.onclick=()=>{
        if (!active() || preview.hidden) return;
        closeVideoGif();
        void openGifShowcase({ref:result.ref,name:source.name+" · GIF",source:{node:source.id,ref:version.ref}});
      };
      busy=false; update(`${result.width}×${result.height} · ${result.seconds.toFixed(2)} 秒 · ${Math.ceil(result.size_bytes/1024)} KB`);
      link.focus();
    } catch (error) {
      if (active()) { busy=false; update(error.message || "生成 GIF 失败"); }
    }
  }
  form.onsubmit=convert;
  update();
  const original=grid?$("img",gridPreview):video;
  original.src=version.url || "/media?ref="+encodeURIComponent(version.ref);
  if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open","");
}

$("#videoGif [data-gif-close]").onclick=closeVideoGif;
$("#videoGif").addEventListener("cancel",event=>{event.preventDefault();closeVideoGif();});
