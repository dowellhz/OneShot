"use strict";

const videoCompare = $("#videoCompare");
const comparePlayers = $$("video", videoCompare);
const compareVersions = $$("[data-compare-version]", videoCompare);
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
  comparePlay.textContent = "播放";
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
  compareStatus.textContent = failed ? "有一侧视频加载失败，可以选择其他版本。" : !compareLength ? "正在加载视频…"
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
  let selected = [String(other.index), String(current.index)];

  function loadChoices() {
    compareStop();
    compareLength = 0;
    compareTime.max = "0";
    compareDisplay(0);
    comparePlay.disabled = compareTime.disabled = true;
    compareStatus.textContent = "正在加载视频…";
    compareVersions.forEach((select, side) => {
      select.value = selected[side];
      const {version} = choices.find(item => String(item.index) === selected[side]);
      const resolution = version.draft_final?.resolution?.toUpperCase() || (version.draft_expires ? "480p 样片" : "");
      compareDetails[side].textContent = [resolution, version.w && version.h ? `${version.w}×${version.h}` : "",
        Number.isFinite(version.seconds) ? `${version.seconds.toFixed(2)} 秒` : ""].filter(Boolean).join(" · ");
      comparePlayers[side].src = version.url;
    });
  }

  $$("#world video").forEach(player => { if (!player.paused) player.pause(); });
  compareVersions.forEach((select, side) => {
    select.replaceChildren(...choices.map(({version,index}) => new Option(
      `版本 ${index + 1}${index === n.cur ? " · 当前" : ""}${version.label ? " · " + version.label : ""}`, String(index))));
    select.onchange = () => {
      if (select.value === selected[1 - side]) selected[1 - side] = selected[side];
      selected[side] = select.value;
      loadChoices();
    };
  });
  $("#videoCompareTitle").textContent = `对比视频版本 · ${n.name}`;
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
