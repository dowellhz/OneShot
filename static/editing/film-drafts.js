"use strict";

function filmDraftPrefix() { return `oneshot.film:${ME_USER?.id ?? "local"}:${boardId}:`; }
function filmDraftKey(spec, n) {
  return filmDraftPrefix() + (n ? n.id : JSON.stringify([spec.remake_audio || "", spec.clips.map(c => c.node)]));
}
function saveFilmDraft(F = FILM) {
  if (!F || F.board !== boardId) return;
  if (F.n?.data.playlist && !canvasCanEdit()) return;
  if (ME_USER?.id == null) return;
  const reuse = $("#fmStoryReuse");
  if (F.story && !reuse.hidden && F.story.base !== storyDraftSignature(F.spec)) reuse.hidden = true;
  const clip = F.spec.clips[F.sel];
  const offset = clip ? Math.max(0, Math.min(clipLen(clip), filmClipOffset(F))) : 0;
  const spec = {...F.spec, clips:F.spec.clips.map(({src_len, ...c}) => c)};
  const state = JSON.stringify({spec, sel:F.sel, offset:Math.round(offset * 4) / 4, node:F.n?.id, target:F.target,
    attempt:F.attempt,canvasAttempt:F.canvasAttempt,downloadExport:F.downloadExport,playlistBase:F.playlistBase,storySource:F.storySource});
  if (state === F.saved) return;
  try {
    localStorage.setItem(F.key, state);
    localStorage.setItem(filmDraftPrefix() + "latest", F.key);
    if (F.n) localStorage.setItem(filmDraftKey(spec, F.n), state);
    F.saved = state;
    $("#fmDraftState").textContent = "草稿已保存到此浏览器";
  } catch {
    $("#fmDraftState").textContent = "浏览器空间不足，草稿未保存";
  }
}

function resumeFilmDraft() {
  try {
    const key = localStorage.getItem(filmDraftPrefix() + "latest");
    const saved = key && JSON.parse(localStorage.getItem(key));
    const owner = saved?.node ? node(saved.node) : null;
    if (owner?.data.playlist) return openFilm(owner);
    if (saved?.playlistBase) return toast("播放列表已从画布移除");
    if (saved?.spec?.clips?.length) return showFilm(saved.spec, node(saved.node), key, saved.target);
  } catch {}
  toast("此项目没有剪辑草稿");
}

function earlierStoryDrafts(F) {
  const prefix = filmDraftPrefix()+"story:", scope = JSON.stringify(F.story.scope);
  const drafts = [];
  try {
    const latest = localStorage.getItem(filmDraftPrefix()+"latest");
    for (let i=localStorage.length-1;i>=0;i--) {
      const key = localStorage.key(i);
      if (!key?.startsWith(prefix) || key===F.key) continue;
      try {
        const [script,ids,refs] = JSON.parse(key.slice(prefix.length));
        if (JSON.stringify([script,ids])!==scope || refs.length!==F.story.shots.length ||
            refs.some((entry,j)=>entry[0]!==F.story.shots[j].node)) continue;
        const saved = JSON.parse(localStorage.getItem(key));
        if (saved?.spec?.clips?.length) drafts.push({saved,refs,latest:key===latest});
      } catch {}
    }
  } catch {}
  return drafts.sort((a,b)=>Number(b.latest)-Number(a.latest));
}

function reuseStoryDraft(F, draft) {
  const spec = JSON.parse(JSON.stringify(draft.saved.spec)), updates = new Map(), legacy = new Map();
  const shots = F.story.shots.map((shot,i) => {
    const source = node(shot.node), oldRef = draft.refs[i][1];
    const to = source?.versions.findIndex(v=>v.ref===shot.ref) ?? -1;
    const status = {...shot,to,count:0,skipped:0};
    const entry = {status,source,oldRef};
    updates.set(shot.id,entry);
    legacy.set(shot.node,legacy.has(shot.node) ? null : entry);
    return status;
  });
  for (const clip of spec.clips) {
    const entry = spec.story_tracking ? updates.get(clip.story_shot) : legacy.get(clip.node);
    if (!entry || clip.node!==entry.status.node || clip.remake_shot ||
        (!spec.story_tracking && clip.ref!==entry.oldRef)) continue;
    const {status,source} = entry;
    clip.story_shot=status.id;
    if (clip.ref===status.ref || status.to<0) continue;
    try {
      const {shorter,...changes} = filmVersionReplacement(clip,source.versions[status.to],source);
      if (shorter>1e-6) throw new Error("新版本过短");
      Object.assign(clip,changes,{story_shot:status.id});
      delete clip.src_len;
      status.count++;
    } catch { status.skipped++; }
  }
  spec.story_tracking = true;
  if (F.spec.story_script) spec.story_script = F.story.scope[0];
  else delete spec.story_script;
  refreshStoryClipPlans(spec,F.story);
  return {spec,shots};
}

function openStoryDraftPicker(F) {
  const editable = () => FILM===F && F.board===boardId && canvasCanEdit() && !F.busy && !F.n &&
    F.story.base===storyDraftSignature(F.spec);
  if (!editable()) return toast("当前剪辑已有改动");
  const drafts = earlierStoryDrafts(F);
  if (!drafts.length) return toast("没有可沿用的剪辑草稿");
  const dialog = $("#fmStoryDialog"), list = $("ol",dialog), choice = $("select",dialog);
  choice.replaceChildren(...drafts.map(({saved,refs},i)=>new Option(
    `草稿 ${i+1} · ${saved.spec.clips.length} 段 · ${refs.map(([id,ref])=>{
      const version=node(id)?.versions.findIndex(v=>v.ref===ref) ?? -1;
      return version<0?"历史版本":`V${version+1}`;
    }).join(" / ")}`,String(i))));
  choice.selectedIndex=0;
  const describe = () => {
    const {shots} = reuseStoryDraft(F,drafts[Number(choice.value)]);
    list.replaceChildren(...shots.map(({number,to,count,skipped})=>{
      const item=document.createElement("li");
      const changes = [count?`${count} 段改用版本 ${to+1}`:"",skipped?`${skipped} 段因新版本过短保留原素材`:""].filter(Boolean);
      item.textContent=`镜头 ${number} · ${changes.join("，") || "沿用草稿中的选择"}`;
      return item;
    }));
  };
  choice.onchange=describe;
  $("form",dialog).onsubmit=event=>{
    event.preventDefault();
    if (!editable()) { closeStoryDraftPicker(); return; }
    let saved;
    try { saved = JSON.parse(localStorage.getItem(F.key)); } catch {}
    if (saved?.spec && F.story.base!==storyDraftSignature(saved.spec)) {
      closeStoryDraftPicker();
      return toast("此剪辑草稿已有改动，请重新打开剪辑");
    }
    const script=node(F.story.scope[0]), first=F.story.shots[0].number-1;
    const current=script?.type==="script" ? storyFilmSelection(script,first,first+F.story.shots.length-1) : null;
    if (!current || current.missing.length || F.story.shots.some((shot,i)=>
        current.media[i]?.id!==shot.node || curV(current.media[i])?.ref!==shot.ref ||
        (script.data.shots[first+i]?.id || `index:${first+i}`)!==shot.id)) {
      closeStoryDraftPicker();
      return toast("当前分镜或视频版本已变更，请重新打开剪辑");
    }
    const draft=drafts[Number(choice.value)];
    const {spec}=reuseStoryDraft(F,draft);
    F.spec=spec;
    F.sel=Math.max(0,Math.min(spec.clips.length-1,draft.saved.sel||0));
    closeStoryDraftPicker();
    $("#fmStoryReuse").hidden=true;
    renderFilm(); selectClip(F.sel,Math.min(clipLen(spec.clips[F.sel]),draft.saved.offset||0)); saveFilmDraft(F);
    toast("已沿用剪辑草稿");
  };
  describe();
  if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open","");
  choice.focus();
}

function closeStoryDraftPicker() {
  const dialog=$("#fmStoryDialog");
  if (dialog.open && dialog.close) dialog.close(); else dialog.removeAttribute("open");
}
