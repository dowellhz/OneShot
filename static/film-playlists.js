"use strict";

function playlistVideo(n) { return n?.type === "video" && filmSource(n); }

let filmPlaylistPicker = null;

function paintFilmPlaylistPicker() {
  const picker=filmPlaylistPicker;
  const orders=new Map([...(picker?.clips.keys()||[])].map((id,i)=>[id,i+1]));
  for(const [id,element] of els){
    const n=node(id);
    const eligible=!!picker && id!==picker.film.n.id && playlistVideo(n);
    element.classList.toggle("playlist-pickable",!!eligible);
    const order=orders.get(id);
    element.classList.toggle("playlist-picked",order!=null);
    if(order!=null)element.dataset.playlistPickOrder=order;
    else delete element.dataset.playlistPickOrder;
  }
  const bar=$("#filmPlaylistPick");
  bar.hidden=!picker;
  if(!picker)return;
  const count=picker.clips.size;
  $("[data-playlist-pick-count]",bar).textContent=`已选 ${count} 段`;
  $("[data-playlist-pick-apply]",bar).disabled=!count;
}

function startFilmPlaylistPicker(F) {
  if(FILM!==F || !F.n?.data.playlist || F.busy || !canvasCanEdit())return;
  const videos=B.nodes.filter(n=>n.id!==F.n.id&&playlistVideo(n)&&!ctFolded(n.id));
  if(!videos.length)return toast("当前画布没有可选的可播放视频");
  filmPlaylistPicker={film:F,board:B,clips:new Map()};
  playAll=false;
  if(!$("#fmV").paused)$("#fmV").pause();
  syncFilmAudio(F);
  $("#fmAdd").classList.remove("on");
  $("#film").classList.remove("on");
  document.body.classList.add("playlist-picking");
  paintFilmPlaylistPicker();
  fit(videos,false);
  $("#filmPlaylistPick").focus();
}

function finishFilmPlaylistPicker(apply=false,returnToFilm=true) {
  const picker=filmPlaylistPicker;
  if(!picker)return;
  const F=picker.film;
  if(apply){
    if(FILM!==F || picker.board!==B || !canvasCanEdit())return finishFilmPlaylistPicker();
    const clips=[...picker.clips].map(([id,clip])=>{
      const found=vtResolve(clip.node,clip.ref);
      if(found?.node.type==="video")return {...clip,node:found.node.id};
      picker.clips.delete(id);
      return null;
    });
    if(!clips.length)return;
    if(clips.some(clip=>!clip)){
      toast("部分已选视频版本已移除，请重新选择");
      paintFilmPlaylistPicker();
      return;
    }
    F.spec.clips.push(...clips);
  }
  filmPlaylistPicker=null;
  document.body.classList.remove("playlist-picking");
  paintFilmPlaylistPicker();
  if(!returnToFilm || FILM!==F || picker.board!==B)return;
  $("#film").classList.add("on");
  if(apply){
    renderFilm();
    selectClip(F.spec.clips.length-1);
    saveFilmDraft(F);
  }
  $("#fmTl .fadd")?.focus();
}

function initFilmPlaylistPicker() {
  document.body.insertAdjacentHTML("beforeend",`<aside id="filmPlaylistPick" aria-label="从画布选择视频" tabindex="-1" hidden>
    <strong>点击画布视频，按顺序加入播放列表</strong><span data-playlist-pick-count role="status"></span>
    <button type="button" class="pill" data-playlist-pick-cancel>取消</button>
    <button type="button" class="pill" data-playlist-pick-apply>加入列表</button></aside>`);
  $("[data-playlist-pick-cancel]").onclick=()=>finishFilmPlaylistPicker();
  $("[data-playlist-pick-apply]").onclick=()=>finishFilmPlaylistPicker(true);
  vp.addEventListener("pointerdown",e=>{
    if(!filmPlaylistPicker || e.button!==0 || spaceDown || !e.target.closest(".node"))return;
    e.preventDefault();e.stopImmediatePropagation();
  },true);
  vp.addEventListener("click",e=>{
    const picker=filmPlaylistPicker, element=e.target.closest(".node");
    if(!picker || !element || spaceDown)return;
    e.preventDefault();e.stopImmediatePropagation();
    const n=node(element.dataset.id);
    if(!canvasCanEdit() || !playlistVideo(n) || n.id===picker.film.n.id)return;
    if(!picker.clips.delete(n.id))picker.clips.set(n.id,newFilmClip(n));
    paintFilmPlaylistPicker();
  },true);
  vp.addEventListener("dblclick",e=>{
    if(filmPlaylistPicker){e.preventDefault();e.stopImmediatePropagation();}
  },true);
}

function createFilmPlaylist(media = [], at = null) {
  if (!canvasCanEdit()) return;
  const videos = media.filter(playlistVideo);
  if (media.length && videos.length < 2) return toast("请选择至少两个可播放的视频节点");
  if (!at) {
    const edge = videos.length ? Math.max(...videos.map(n=>n.x+size(n).w)) : 0;
    at = freeSpot(edge+110,videos.length ? Math.min(...videos.map(n=>n.y)) : 0,"video");
  }
  checkpoint();
  const count = B.nodes.filter(n => n.data.playlist).length + 1;
  const playlist = addNode("video",at.x,at.y,{playlist:true,film:newSpec(videos)},{name:`播放列表 ${count}`});
  selectOnly(playlist.id);
  fit([playlist]);
  return playlist;
}

function appendFilmPlaylist(playlist, moving, starts, before) {
  if (!playlist?.data.playlist || playlist.job || !moving.every(playlistVideo)) return false;
  moving.forEach((n,i) => { [n.x,n.y] = starts[i]; render(n); });
  const spec = playlist.data.film;
  spec.clips.push(...byPosition(moving.map(n=>n.id)).map(newFilmClip));
  undoStack.push(before);
  redoStack.length = 0;
  render(playlist); selectOnly(playlist.id); drawEdges(); drawMini(); save();
  toast(`已添加 ${moving.length} 段视频到播放列表`);
  return true;
}

function saveFilmPlaylist(F, {notify=true, spec=F.spec} = {}) {
  const playlist = node(F.n?.id);
  if (F.board !== boardId || !canvasCanEdit() || !playlist?.data.playlist) return false;
  if (JSON.stringify(playlist.data.film) !== F.playlistBase) {
    toast("播放列表已更新，请重新打开后再编辑",4000);
    return false;
  }
  const snapshot = vtClone(spec);
  snapshot.clips.forEach(clip => { delete clip.src_len; });
  const base = JSON.stringify(snapshot);
  if (base !== F.playlistBase) {
    checkpoint();
    playlist.data.film = snapshot;
    F.playlistBase = base;
    F.n = playlist;
    save();
    render(playlist);
  }
  saveFilmDraft(F);
  if (notify) toast("播放列表已保存到画布");
  return true;
}

function locateFilmPlaylistSource(F, clip) {
  if(FILM!==F || F.board!==boardId)return;
  const resolved = vtResolve(clip.node,clip.ref);
  if (!resolved) return toast("原视频节点已移除，播放列表仍保留素材引用");
  closeFilm();
  selectOnly(resolved.node.id);
  fit([resolved.node]);
  if (resolved.index !== resolved.node.cur) toast(`播放列表使用该节点的版本 ${resolved.index+1}`);
}

function closePlaylistClipMenu({focus=false}={}) {
  const menu=$("#playlistClipMenu");
  if(!menu.classList.contains("on"))return false;
  menu.classList.remove("on");
  if(focus && menu._trigger?.isConnected)menu._trigger.focus();
  menu._trigger=null;
  return true;
}

function showPlaylistClipMenu(F,clip,trigger,x,y) {
  if(FILM!==F || !F.n?.data.playlist || !F.spec.clips.includes(clip))return;
  const menu=$("#playlistClipMenu"),source=vtResolve(clip.node,clip.ref),media=filmVersion(clip);
  menu._trigger=trigger;
  $("#fmAdd").classList.remove("on");
  menu.innerHTML=`<div class="mt">${esc(clip.name || "片段")}</div>
    <button type="button" data-source-location ${source?"":"disabled"}>${ico("fit")}定位原片节点</button>
    <button type="button" data-source-preview ${media?.ref?"":"disabled"}>${ico("full")}预览引用版本</button>
    ${canvasCanEdit()?'<button type="button" data-playlist-clip-remove>移出播放列表</button>':""}`;
  $("[data-source-location]",menu).onclick=()=>locateFilmPlaylistSource(F,clip);
  $("[data-source-preview]",menu).onclick=()=>{
    if(FILM!==F || F.board!==boardId)return;
    const resolved=vtResolve(clip.node,clip.ref);
    const version=resolved?.node.versions[resolved.index] || filmVersion(clip);
    if(!version?.url)return toast("引用的媒体已移除");
    closePlaylistClipMenu({focus:true});
    playAll=false;
    pausePreviewMedia($("#film"));
    syncFilmAudio(F);
    lightbox(version,resolved?.node,{at:clip.in||0});
  };
  const remove=$("[data-playlist-clip-remove]",menu);
  if(remove)remove.onclick=()=>removeFilmClip(F,clip);
  menu.classList.add("on");
  menu.style.left=Math.max(8,Math.min(x,innerWidth-menu.offsetWidth-8))+"px";
  menu.style.top=Math.max(8,Math.min(y,innerHeight-menu.offsetHeight-8))+"px";
  $("button:enabled",menu)?.focus();
}

async function downloadFilmPlaylistSources(F) {
  const refs = [...new Set(F.spec.clips.map(clip => filmVersion(clip)?.ref).filter(Boolean))];
  if (!refs.length) return;
  const button = $("#fmPlaylistSources");
  button.disabled = true;
  try {
    await flushSave();
    const response = await fetchOk("/api/assets/export",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({refs})});
    const blob = await response.blob(), url = URL.createObjectURL(blob), anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${F.n.name}-原片.zip`;
    anchor.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  } catch (error) { toast("原片下载失败：" + error.message,4000); }
  finally { if (FILM === F) button.disabled = false; }
}
