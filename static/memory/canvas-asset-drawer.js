"use strict";

let assetsCache = [], afilter = "all";
async function loadAssets() {
  if (!$("#drawer").classList.contains("on")) return;
  if (KIND_CN[afilter]) { $("#drawer .h").textContent = "点击或拖到画布上使用；输入 @ 采用设定与参考图；右上角查看记忆和版本"; return renderLibrary(afilter); }
  $("#drawer .h").textContent = OneShotI18n.t("点击或拖到画布上使用");
  try { assetsCache = await (await fetch("/api/assets")).json(); } catch { return; }
  const g = $("#agrid"), list = assetsCache.filter(a => afilter === "all" || a.type === afilter);
  g.innerHTML = list.map(a => `<div class="as" draggable="true" data-i="${assetsCache.indexOf(a)}">${a.type === "video" ? `<video src="${a.url}#t=0.5" preload="metadata" muted></video>` : a.type==="audio" ? `<div class="asset-audio">${ico("audio")}</div>` : `<img src="${a.url}" loading="lazy">`}<span class="ty">${a.type === "audio" || a.type==="video" ? TYPE_CN[a.type] : a.source === "upload" ? "上传" : a.source === "frame" ? "截帧" : "生成"}</span></div>`).join("") || OneShotI18n.html`<div class="h">还没有素材</div>`;
  $$(".as", g).forEach(d => {
    const a = assetsCache[+d.dataset.i];
    d.addEventListener("dragstart", e => e.dataTransfer.setData("application/x-h3-asset", JSON.stringify(a)));
    d.onclick = () => placeAsset(a, toW(innerWidth / 2 - 150, innerHeight / 2 - 180));
  });
}
async function placeAsset(a, at) {
  const n = addNode(a.type, at.x, at.y);
  let w = 0, h = 0, seconds;
  if (a.type === "image") [w, h] = await imgSize(a.url);
  else await new Promise(r => { const v = document.createElement(a.type); v.preload = "metadata"; v.onloadedmetadata = () => { w = v.videoWidth; h = v.videoHeight; seconds = Number.isFinite(v.duration) ? v.duration : undefined; r(); }; v.onerror = r; v.src = a.url; });
  if (node(n.id)!==n) return;
  n.versions.push({ ref:a.ref,url:a.url,w,h,seconds,source:a.source,prompt:"" }); n.cur = 0; render(n); save(); selectOnly(n.id);
}
$$("#drawer .tabs button").forEach(b => b.onclick = () => { $$("#drawer .tabs button").forEach(x => x.classList.remove("on")); b.classList.add("on"); afilter = b.dataset.f; loadAssets(); });
