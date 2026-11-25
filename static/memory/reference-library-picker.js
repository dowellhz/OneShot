"use strict";

document.getElementById("mediaToolDialogs").insertAdjacentHTML("beforebegin", OneShotI18n.html`
<dialog id="referenceLibrary" aria-labelledby="referenceLibraryTitle">
  <form>
    <strong id="referenceLibraryTitle">选用参考素材</strong>
    <input type="search" aria-label="搜索资产" placeholder="搜索名称、别名或标签">
    <select aria-label="资产版本"></select>
    <audio controls preload="metadata" hidden></audio>
    <video controls preload="metadata" playsinline hidden></video>
    <div role="status"></div>
    <footer><button type="button" data-cancel>取消</button><button type="submit" disabled>添加参考</button></footer>
  </form>
</dialog>
`);

async function openReferenceLibrary(target, kind) {
  const seed=isSeedAudio(target), label=TYPE_CN[kind];
  const dialog=$("#referenceLibrary"), board=B, bid=boardId, epoch=boardOpenEpoch;
  const current=()=>B===board && boardOpenEpoch===epoch && canvasCanEdit() &&
    node(target.id)===target && !target.job && !prepping.has(target.id) &&
    (seed?isSeedAudio(target):target.type==="video" && !target.data.previs && !target.data.film);
  if (dialog.open || !current()) return;
  const form=$("form",dialog), query=$('input[type="search"]',form), list=$("select",form);
  const preview=$(kind,form), status=$("[role=status]",form), apply=$('[type="submit"]',form);
  $("#referenceLibraryTitle",form).textContent="从资产库选用"+label;
  apply.textContent="添加参考"+label;
  let choices=[], busy=false;
  const stopPreview=()=>{
    preview.pause();
    preview.removeAttribute("src");
    preview.hidden=true;
  };
  const close=()=>{
    if(dialog.close)dialog.close();
    else dialog.removeAttribute("open");
    stopPreview();
  };
  const available=({spec})=>{
    const version=curV(spec);
    if (seed) return canSeedAudioReference(target,spec,version) && !(version.seconds>30.001);
    return !target.versions.some(v=>v.ref===version.ref) &&
      !promptMediaInputs(kind,target).some(input=>input.edge.ref===version.ref);
  };
  const picked=()=>choices[list.value];
  const updatePreview=()=>{
    const version=curV(picked()?.spec);
    preview.pause();
    preview.hidden=!version;
    if (version) preview.src=version.url;
    else preview.removeAttribute("src");
    apply.disabled=!version || busy;
  };
  const filter=()=>{
    const q=query.value.trim().toLocaleLowerCase();
    const matches=choices.flatMap((choice,index)=>choice.search.includes(q)&&available(choice)?
      [new Option(choice.label,String(index))]:[]);
    list.replaceChildren(new Option("请选择"+label,""),...matches);
    list.disabled=!matches.length;
    status.textContent=matches.length?"":"没有可添加的"+label+"参考";
    updatePreview();
  };
  const active=()=>dialog.open && form.onsubmit===submit && current();
  const submit=async event=>{
    event.preventDefault();
    const choice=picked();
    if (busy || !choice || !active() || !available(choice)) return;
    const id=choice.spec.data.asset.id, ref=curV(choice.spec).ref;
    busy=query.disabled=list.disabled=apply.disabled=true;
    status.textContent=OneShotI18n.t("正在核对素材…");
    try {
      const [asset]=await boardRequest("/api/memory/resolve","POST",{board:bid,ids:[id]});
      if (!active()) return;
      const resolved=asset && vtLibraryReferences([asset],kind).find(({spec})=>curV(spec).ref===ref);
      if (!resolved || !available(resolved)) throw new Error("资产或参考列表已更新，请重新选择");
      const {spec}=resolved;
      const existing=B.nodes.find(n=>n!==target && n.type===kind &&
        n.versions.some(v=>v.ref===ref && v.source!=="previs" && (seed || canLink(n,target,v))) &&
        !vtReferenceAncestors(n).has(target.id));
      checkpoint();
      const dimensions=size(spec);
      const source=existing || buildCanvasMediaNode(spec,
        freeSpot(target.x-dimensions.w-CT_LAYOUT_GAP.x,target.y,kind,dimensions));
      if (seed) addSeedAudioReference(target,source,source.versions.find(v=>v.ref===ref),false);
      else bindPromptMedia(source,target,ref,false);
      close();
      toast("已添加参考"+label);
    } catch(error) {
      if (active()) status.textContent=error.message;
    } finally {
      if (active()) {
        busy=query.disabled=list.disabled=false;
        apply.disabled=!picked();
      }
    }
  };
  form.onsubmit=submit;
  $("[data-cancel]",form).onclick=close;
  dialog.onclose=()=>{if(!dialog.open)stopPreview();};
  dialog.onkeydown=event=>event.stopPropagation();
  query.value="";
  query.disabled=list.disabled=true;
  query.oninput=filter;
  list.onchange=updatePreview;
  list.replaceChildren();
  status.textContent=OneShotI18n.t("正在读取资产库…");
  updatePreview();
  if(dialog.showModal)dialog.showModal();
  else dialog.setAttribute("open","");
  try {
    const items=await boardRequest("/api/memory?board="+encodeURIComponent(bid));
    if (!active()) return;
    choices=vtLibraryReferences(items,kind);
    query.disabled=false;
    filter();
    query.focus();
  } catch(error) {
    if (active()) status.textContent=error.message;
  }
}
