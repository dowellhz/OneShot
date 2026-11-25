"use strict";

document.getElementById("mediaToolDialogs").insertAdjacentHTML("beforebegin", OneShotI18n.html`
<dialog id="frameCapture" aria-labelledby="frameCaptureTitle">
  <header><strong id="frameCaptureTitle">视频截帧</strong><button type="button" data-capture-close aria-label="关闭">×</button></header>
  <p data-capture-source></p>
  <video controls playsinline preload="metadata"></video>
  <p data-capture-status role="status"></p>
  <footer>
    <button type="button" data-capture-position="first">截取首帧</button>
    <button type="button" data-capture-position="time">截取当前帧</button>
    <button type="button" data-capture-position="last">截取末帧</button>
  </footer>
</dialog>
`);

function frameCaptureSuffix(position, at) {
  return position === "first" ? "首帧" : position === "last" ? "末帧" : at.toFixed(2) + " 秒";
}
async function captureOnCanvas(sourceId, version, {position, at, before=false, active=()=>true, allowDetached=false, onCaptured=null, select=true}={}) {
  if (!canvasCanEdit() || !version?.ref) return null;
  const board = boardId, epoch = boardOpenEpoch;
  const result = await api("/api/lastframe", {ref:version.ref, position, at});
  if (boardId !== board || epoch !== boardOpenEpoch || !canvasCanEdit() || !active()) return null;
  const source = vtResolve(sourceId, version.ref)?.node;
  if (!source && !allowDetached) throw new Error("取帧所用的原视频版本已移除");
  const anchor = source ? {x:before ? source.x-430 : source.x+size(source).w+110,y:source.y}
    : toW(innerWidth / 2 - 150, innerHeight / 2 - 160);
  const point = freeSpot(anchor.x, anchor.y, "image");
  const time = result.at ?? at ?? null;
  const title = source?.name || "剪辑片段";
  checkpoint();
  const image = addNode("image", point.x, point.y, {caption:(version.prompt || "").slice(0,200)},
    {name:title+" · "+frameCaptureSuffix(position,time)});
  const capture = {source_node:source?.id || "",source_ref:version.ref,position,at:time};
  image.versions.push({ref:result.ref,url:result.url,w:result.w,h:result.h,source:"frame",prompt:"",capture});
  image.cur=0;
  if (source) B.edges.push({from:source.id,to:image.id,relation:"capture",source_ref:version.ref,at:time});
  const selected=onCaptured?.(image)||image;
  render(image);if(selected!==image)render(selected);
  if(select)selectOnly(selected.id);
  save();loadAssets();
  return image;
}
async function continueFrom(n, extension) {
  const v = curV(n); if (!v) return toast(OneShotI18n.t("还没有视频"));
  const before=extension.direction==="before";
  try {
    const anchor=await captureOnCanvas(n.id,v,{position:before?"first":"last",before,onCaptured:image=>{
      const at=freeSpot(before?image.x-460:image.x+size(image).w+110,image.y,"video");
      const result=addNode("video",at.x,at.y,{duration:extension.duration,quality:n.data.quality,turbo:n.data.turbo,
        aspect:"auto",prompt:extension.prompt,provider:extension.provider||""},
        {name:n.name+" · "+extensionLabel(extension.direction)});
      link(image,result,true,{ref:curV(image).ref,role:before?"last":"first"});
      return result;
    }});
    if (!anchor) return;
    $("#prompt").focus();
    toast(before?"已用原视频首帧作为新片段尾帧":"已截取最后一帧，写下一段的提示词继续生成");
  } catch (e) { toast("截帧失败：" + e.message); }
}
function closeFrameCapture() {
  const dialog=$("#frameCapture");
  if (!dialog.open) return;
  const player=$("video",dialog);
  player.pause();player.removeAttribute("src");
  if (dialog.close) dialog.close(); else dialog.removeAttribute("open");
}
function openFrameCapture(source) {
  const version=curV(source), dialog=$("#frameCapture");
  if (!canvasCanEdit() || !version || dialog.open) return;
  const player=$("video",dialog), status=$("[data-capture-status]",dialog);
  const buttons=$$("[data-capture-position]",dialog);
  status.textContent="";
  player.src=version.url;
  $("[data-capture-source]",dialog).textContent=source.name+" · 版本 "+(source.cur+1);
  buttons.forEach(button=>{
    button.disabled=false;
    const capture=async()=>{
      const position=button.dataset.capturePosition;
      if (position==="time" && player.readyState<1) {status.textContent="视频正在加载，请稍后截取当前帧";return;}
      buttons.forEach(control=>control.disabled=true);
      status.textContent="正在截帧…";
      const active=()=>dialog.open && button.onclick===capture;
      try {
        const image=await captureOnCanvas(source.id,version,{position,at:position==="time"?player.currentTime:undefined,active});
        if (image && active()) closeFrameCapture();
      } catch(error) {
        if (active()) status.textContent=error.message;
      } finally {
        if (active()) buttons.forEach(control=>control.disabled=false);
      }
    };
    button.onclick=capture;
  });
  $("[data-capture-close]",dialog).onclick=closeFrameCapture;
  dialog.oncancel=event=>{event.preventDefault();closeFrameCapture();};
  if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open","");
}
