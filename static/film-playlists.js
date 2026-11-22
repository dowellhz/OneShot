"use strict";

function playlistVideo(n) { return n?.type === "video" && filmSource(n); }

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
  const resolved = vtResolve(clip.node,clip.ref);
  if (!resolved) return toast("原视频节点已移除，播放列表仍保留素材引用");
  closeFilm();
  selectOnly(resolved.node.id);
  fit([resolved.node]);
  if (resolved.index !== resolved.node.cur) toast(`播放列表使用该节点的版本 ${resolved.index+1}`);
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
