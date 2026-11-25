"use strict";

document.getElementById("mediaToolDialogs").insertAdjacentHTML("beforebegin", OneShotI18n.html`
<dialog id="videoCompare" aria-labelledby="videoCompareTitle">
  <header><strong id="videoCompareTitle">对比视频版本</strong><button type="button" data-compare-close aria-label="关闭">×</button></header>
  <div class="compare-panes">
    <section><label><span data-compare-label>左侧版本</span> <select data-compare-version></select></label><video playsinline preload="auto"></video><p data-compare-meta></p></section>
    <section><label><span data-compare-label>右侧版本</span> <select data-compare-version></select></label><video playsinline preload="auto"></video><p data-compare-meta></p></section>
  </div>
  <footer>
    <button type="button" data-compare-play disabled>播放</button>
    <input type="range" min="0" max="0" step=".01" value="0" aria-label="同步播放进度" data-compare-time disabled>
    <output data-compare-clock>0.00 / 0.00 秒</output>
    <label>声音 <select data-compare-audio><option value="left">左侧</option><option value="right">右侧</option><option value="mute">静音</option></select></label>
  </footer>
  <p role="status" data-compare-status></p>
</dialog>
`);

const videoCompare = $("#videoCompare");
const comparePlayers = $$("video", videoCompare);
const compareVersions = $$("[data-compare-version]", videoCompare);
const compareLabels = $$("[data-compare-label]", videoCompare);
const compareDetails = $$("[data-compare-meta]", videoCompare);
const compareTime = $("[data-compare-time]", videoCompare);
const comparePlay = $("[data-compare-play]", videoCompare);
const compareClock = $("[data-compare-clock]", videoCompare);
const compareAudio = $("[data-compare-audio]", videoCompare);
const compareStatus = $("[data-compare-status]", videoCompare);
let compareLength = 0, comparePlaying = false, compareStarted = false, comparePlayback = 0;

function compareStop() {
  comparePlayback++;
  comparePlaying = compareStarted = false;
  comparePlay.textContent = OneShotI18n.t("播放");
  comparePlayers.forEach(video => video.pause());
}

function compareDisplay(at) {
  compareTime.value = String(at);
  compareClock.textContent = `${at.toFixed(2)} / ${compareLength.toFixed(2)} 秒`;
}

function compareSeek(at) {
  comparePlayers.forEach(video => { if (Math.abs(video.currentTime - at) > .001) video.currentTime = at; });
  compareDisplay(at);
}

function compareReadiness() {
  if (!videoCompare.open) return;
  const failed = comparePlayers.some(video => video.error);
  const durations = comparePlayers.map(video => video.duration);
  compareLength = !failed && durations.every(value => Number.isFinite(value) && value > 0) ? Math.min(...durations) : 0;
  comparePlay.disabled = compareTime.disabled = !compareLength;
  compareTime.max = String(compareLength);
  compareDisplay(Math.min(comparePlayers[0].currentTime, compareLength));
  if (failed) compareStop();
  compareStatus.textContent = failed ? "有一侧视频加载失败。" : !compareLength ? "正在加载视频…"
    : Math.abs(durations[0] - durations[1]) > .05 ? "播放到较短版本的末尾。" : "";
}

function compareUpdateAudio() {
  comparePlayers[0].muted = compareAudio.value !== "left";
  comparePlayers[1].muted = compareAudio.value !== "right";
}

function openVideoCompare(n, previewIndex = n.cur) {
  if (videoCompare.open) return;
  const choices = n.versions.map((version, index) => ({version, index})).filter(item => item.version.url);
  if (choices.length < 2) return;
  const current = choices.find(item => item.index === n.cur) || choices.at(-1);
  const other = choices.find(item => item.index === previewIndex && item !== current) ||
    choices.filter(item => item.index < current.index).at(-1) || choices.find(item => item !== current);
  const pool = choices.map(({version,index}) => ({
    version,key:String(index),label:`版本 ${index + 1}${index === n.cur ? " · 当前" : ""}${version.label ? " · " + version.label : ""}`
  }));
  showVideoComparison([pool,pool],[String(other.index),String(current.index)],`对比视频版本 · ${n.name}`);
}

function draftComparisonSource(n, version) {
  const origin = version.draft_final;
  if (!origin?.source_ref) {
    const index = n.versions.indexOf(version);
    return version.draft_expires && version.url && index >= 0 ? {node:n,index} : null;
  }
  const binding = [...(version.input_edges || []), ...B.edges.filter(edge=>edge.to===n.id)]
    .find(edge=>edge.relation==="draft_final" && edge.ref===origin.source_ref);
  for (const id of [binding?.from,origin.source_node,n.id,...(version.tab_nodes || [])].filter(Boolean)) {
    const source = vtResolve(id,origin.source_ref), draft = source?.node.versions[source.index];
    if (source?.node.type==="video" && draft?.draft_expires && draft.url) return source;
  }
  return null;
}

function draftVideoComparison(n, version) {
  if (n?.type!=="video" || !version) return null;
  const source = draftComparisonSource(n,version);
  if (!source) return null;
  const ref = source.node.versions[source.index].ref;
  const finals=[];
  for (const item of B.nodes) {
    if (item.type!=="video") continue;
    item.versions.forEach((result,index)=>{
      if (!result.url || result.draft_final?.source_ref!==ref) return;
      const bound = draftComparisonSource(item,result);
      if (bound?.node===source.node && bound.index===source.index) finals.push({node:item,index});
    });
  }
  if (!finals.length) return null;
  return {source,finals};
}

function openDraftComparison(n, version = curV(n)) {
  const pair = draftVideoComparison(n,version);
  if (!pair || videoCompare.open) return;
  const option = item => ({
    version:item.node.versions[item.index],key:`${item.node.id}:${item.index}`,
    label:`${item.node.name} · 版本 ${item.index+1}`
  });
  const sample=option(pair.source), finals=pair.finals.map(option);
  const selected=finals.find(item=>item.version===version) || finals.at(-1);
  showVideoComparison([[sample],finals],[sample.key,selected.key],"对比样片与定稿",["样片","定稿"]);
}

function showVideoComparison(pools, selected, title, labels = ["左侧版本","右侧版本"]) {
  function loadChoices() {
    compareStop();
    compareLength = 0;
    compareTime.max = "0";
    compareDisplay(0);
    comparePlay.disabled = compareTime.disabled = true;
    compareStatus.textContent = "正在加载视频…";
    compareVersions.forEach((select, side) => {
      select.value = selected[side];
      const {version} = pools[side].find(item => item.key === selected[side]);
      const resolution = version.draft_final?.resolution ? `${version.draft_final.resolution.toUpperCase()} 定稿` : (version.draft_expires ? "480p 样片" : "");
      compareDetails[side].textContent = [resolution, version.w && version.h ? `${version.w}×${version.h}` : "",
        Number.isFinite(version.seconds) ? `${version.seconds.toFixed(2)} 秒` : ""].filter(Boolean).join(" · ");
      comparePlayers[side].src = version.url;
    });
  }

  $$("#world video").forEach(player => { if (!player.paused) player.pause(); });
  compareVersions.forEach((select, side) => {
    compareLabels[side].textContent = labels[side];
    select.replaceChildren(...pools[side].map(item => new Option(item.label,item.key)));
    select.disabled = pools[side].length < 2;
    select.onchange = () => {
      if (select.value === selected[1 - side]) selected[1 - side] = selected[side];
      selected[side] = select.value;
      loadChoices();
    };
  });
  $("#videoCompareTitle").textContent = title;
  compareAudio.value = "right";
  compareUpdateAudio();
  if (videoCompare.showModal) videoCompare.showModal(); else videoCompare.setAttribute("open", "");
  loadChoices();
}

compareAudio.onchange = compareUpdateAudio;
comparePlay.onclick = async () => {
  if (comparePlaying) return compareStop();
  if (!compareLength) return;
  const at = comparePlayers[0].currentTime;
  compareSeek(at >= compareLength - .02 ? 0 : at);
  const playback = ++comparePlayback;
  comparePlaying = true;
  comparePlay.textContent = "暂停";
  try {
    await Promise.all(comparePlayers.map(video => video.play()));
    if (playback === comparePlayback) { compareStarted = true; compareReadiness(); }
  } catch {
    if (playback !== comparePlayback) return;
    compareStop();
    compareStatus.textContent = "暂时无法同步播放，请等待视频加载后重试。";
  }
};

compareTime.oninput = () => {
  compareStop();
  compareSeek(Number(compareTime.value));
};

comparePlayers.forEach(video => {
  video.addEventListener("loadedmetadata", compareReadiness);
  video.addEventListener("error", compareReadiness);
  video.addEventListener("waiting", () => {
    if (!compareStarted || video.seeking) return;
    compareStop();
    compareSeek(Math.min(...comparePlayers.map(player => player.currentTime), compareLength));
    compareStatus.textContent = "视频正在缓冲，点击播放继续。";
  });
  video.addEventListener("ended", () => {
    if (comparePlaying && compareLength) { compareStop(); compareSeek(compareLength); }
  });
});
comparePlayers[0].addEventListener("timeupdate", () => {
  if (!comparePlaying) return;
  const at = comparePlayers[0].currentTime;
  if (at >= compareLength) { compareStop(); compareSeek(compareLength); return; }
  if (!comparePlayers[1].seeking && Math.abs(comparePlayers[1].currentTime - at) > .15) comparePlayers[1].currentTime = at;
  compareDisplay(at);
});

function closeVideoCompare() {
  if (!videoCompare.open) return;
  compareStop();
  compareVersions.forEach(select => { select.onchange = null; });
  comparePlayers.forEach(video => { video.removeAttribute("src"); video.load(); });
  if (videoCompare.close) videoCompare.close(); else videoCompare.removeAttribute("open");
}

$("[data-compare-close]", videoCompare).onclick = closeVideoCompare;
videoCompare.oncancel = event => { event.preventDefault(); closeVideoCompare(); };
