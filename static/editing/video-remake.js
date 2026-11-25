"use strict";

const RM_VIEW_NAMES = {main:"标准主图", face:"正面头肩", side:"侧面", back:"背面", detail:"固定细节"};
const RM_FPS = 24;
const RM_MAX_SHOT_SECONDS = 14;

function remakeMedia(ref) {
  return "/media?ref=" + encodeURIComponent(ref);
}

async function remakeRequest(url, data) {
  if (data) return api(url, data);
  const response = await fetch(url);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "读取角色替换工作区失败");
  return result;
}

async function openVideoRemake(video, {shotStart: initialShotStart, frame: initialFrame, previewJob: initialPreviewJob,
    videoJob: initialVideoJob, sourceRef=null, brief=""} = {}) {
  const source = sourceRef?video?.versions.find(v=>v.ref===sourceRef):curV(video);
  if (!source?.ref) return toast("请先上传或生成视频");
  await flushSave();
  if (node(video.id) !== video || !video.versions.includes(source)) return;
  $("#videoRemake")?.remove();
  const board = boardId;
  const url = "/api/video-remake/" + encodeURIComponent(board) + "/" + encodeURIComponent(video.id) + "?source=" + encodeURIComponent(source.ref);
  const panel = mountVideoRemake(video, source, brief);
  const el = selector => panel.querySelector(selector);
  const player = el("video");
  const result = el("[data-result]");
  const depthPlayer = el("[data-depth-player]");
  const editor = {
    video, source, board, url, panel, el, player, result, depthPlayer,
    session: null,
    assets: [],
    shotIndex: 0,
    frameKey: "first",
    mode: "point",
    versionId: null,
    videoId: null,
    busy: true,
    dragStart: null,
    originalEnd: null,
    playbackError: false,
  };
  player.src = remakeMedia(source.ref);
  const drafts = new Map();
  const draftScope = () => ME_USER?.id == null ? "" : "oneshot.remake.draft:" +
    JSON.stringify([ME_USER.id, board, editor.session?.session_node || video.id, source.ref]) + ":";
  const inScope = index => !editor.session?.mapping || editor.session.mapping.shots.includes(index);
  const matchesPerson = version => !editor.session?.mapping || (version?.roles || [version]).some(role =>
    role?.asset?.id === editor.session.mapping.asset && role.source_person === editor.session.mapping.source);
  const adoptedPreview = frame => frame.previews.find(item => item.job === frame.approved && item.ref);
  const matchesFirst = (guide, first) => !!guide && !!first && matchesPerson(first) &&
    guide.asset?.id === first.asset?.id && guide.source_person === first.source_person;
  const status = message => { el(".rm-status").textContent = message; };
  const currentShot = () => editor.session?.shots[editor.shotIndex];
  const currentFrame = () => currentShot()?.frames[editor.frameKey];
  const shotKey = (shot = currentShot()) => shot ? `${shot.start}:${shot.end}` : "";
  const draftKey = (field, shot, asset) => JSON.stringify([shotKey(shot), editor.session?.mapping?.source ?? null, field, asset ?? null]);
  function readDraft(field, shot = currentShot(), asset) {
    const key = draftKey(field, shot, asset);
    if (drafts.has(key)) return drafts.get(key);
    const scope = draftScope();
    try { return scope ? localStorage.getItem(scope + key) : null; }
    catch { return null; }
  }
  function writeDraft(field, value, asset) {
    const key = draftKey(field, currentShot(), asset);
    drafts.set(key, value);
    const scope = draftScope();
    try { if (scope) localStorage.setItem(scope + key, value); }
    catch {}
  }
  const personAbsent = frame => !!frame?.person_absent && (
    !editor.session.mapping || frame.person_absent.source == null || frame.person_absent.source === editor.session.mapping.source
  );
  const personSelection = frame => {
    const selection = frame.selection;
    if (personAbsent(frame)) return null;
    return selection?.source_person && editor.session.mapping && selection.source_person !== editor.session.mapping.source ? null : selection;
  };
  function close() {
    editor.stopPolling();
    editor.stopComparison();
    if (!player.paused) player.pause();
    if (!result.paused) result.pause();
    if (!depthPlayer.paused) depthPlayer.pause();
    panel.remove();
  }
  el("[data-close]").onclick = close;
  panel.addEventListener("cancel", event => { event.preventDefault(); close(); });
  panel.addEventListener("keydown", event => event.stopPropagation());
  panel.addEventListener("pointerdown", event => event.stopPropagation());
  const active = p => !["done","error"].includes(p.state);

  Object.assign(editor, {
    inScope, matchesPerson, adoptedPreview, matchesFirst, status, currentShot,
    currentFrame, readDraft, writeDraft, personAbsent, personSelection, close, active,
  });
  setupRemakeShotControls(editor);
  setupRemakePlayback(editor);
  setupRemakePanel(editor);
  setupRemakePlacement(editor);
  setupRemakeDepth(editor);
  setupRemakeRequests(editor);
  setupRemakeActions(editor);

  try {
    editor.renderPanel();
    [editor.session, editor.assets] = await Promise.all([
      remakeRequest(url),
      remakeRequest("/api/memory?board=" + encodeURIComponent(board) + "&kind=character"),
    ]);
    if (!panel.isConnected) return;
    editor.assets = editor.assets.filter(item => item.ref);
    const role = el("[data-role]");
    role.append(new Option(editor.assets.length ? "选择资产库角色" : "资产库暂无带参考图的角色", ""));
    editor.assets.forEach(item => role.append(new Option(item.name, item.id)));
    if (editor.assets.some(item => item.id === editor.session?.role?.asset)) role.value = editor.session.role.asset;
    if (Number.isFinite(initialShotStart)) {
      const index = editor.session?.shots.findIndex(shot => shot.start === initialShotStart);
      if (index >= 0) {
        editor.shotIndex = index;
        if (initialFrame && Object.hasOwn(currentShot().frames, initialFrame)) editor.frameKey = initialFrame;
        if (initialPreviewJob && currentFrame().previews.some(version => version.job === initialPreviewJob)) editor.versionId = initialPreviewJob;
        if (initialVideoJob && currentShot().videos?.some(version => version.job === initialVideoJob)) editor.videoId = initialVideoJob;
        player.currentTime = currentFrame().at ?? initialShotStart;
      } else {
        status("剪辑点已变更，请在镜头列表中重新选择。");
      }
    }
    editor.fillViews();
    editor.busy = false;
    editor.renderPanel();
    editor.schedulePoll();
  } catch (error) { status(error.message); }
}
