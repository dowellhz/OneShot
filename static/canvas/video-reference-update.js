"use strict";

function vtReferenceSources(source) {
  if(!["image","video","audio"].includes(source.type))return [];
  return B.nodes.filter(candidate=>candidate!==source && candidate.type===source.type &&
    !candidate.job && !prepping.has(candidate.id) &&
    candidate.versions.some(v=>v.ref && v.source!=="previs"));
}

function vtReferenceAncestors(source) {
  const parents=new Map();
  for(const {from,to} of B.edges){
    if(!parents.has(to))parents.set(to,[]);
    parents.get(to).push(from);
  }
  const ancestors=new Set([source.id]);
  for(const id of ancestors)for(const parent of parents.get(id)||[])ancestors.add(parent);
  return ancestors;
}

function vtGenerationReference(edge,source,target) {
  if(!source || !target || edge.segment_edit || edge.extension || target.data.film || target.data.previs)return false;
  return edge.relation==="seed_audio_ref"&&isSeedAudio(target) ||
    source.type==="image"&&!edge.relation&&["image","video"].includes(target.type) ||
    target.type==="video"&&["audio","video"].includes(source.type)&&edge.relation===source.type+"_ref";
}

function vtGroupReferenceSources(group) {
  const targets=new Set(group.nodes), sources=new Set();
  for(const edge of B.edges){
    if(!targets.has(edge.to))continue;
    const source=node(edge.from);
    if(vtGenerationReference(edge,source,node(edge.to)))sources.add(source);
  }
  return [...sources];
}

function vtReferenceUpdates(source, version, replacement=source, {group=null,targets=null}={}) {
  if(!version?.ref || source.type==="video"&&version.source==="previs")return [];
  const moving=replacement!==source;
  const members=group?new Set(group.nodes):null;
  const ancestors=moving?vtReferenceAncestors(replacement):new Set();
  const existing=moving?new Set(B.edges.filter(e=>e.from===replacement.id).map(e=>e.to)):new Set();
  const updates=[];
  for(const edge of B.edges){
    if(edge.from!==source.id || !moving&&edge.ref===version.ref ||
      members&&!members.has(edge.to) || targets&&!targets.has(edge.to))continue;
    if(ancestors.has(edge.to)||existing.has(edge.to))continue;
    const target=node(edge.to);
    if(!vtGenerationReference(edge,source,target) || nodeLocked(target) || target.job || prepping.has(target.id))continue;
    const relation=edge.relation;
    if(relation==="seed_audio_ref"){
      const refs=seedAudioRefs(target), fromSource=refs.filter(ref=>ref.node_id===source.id);
      if(fromSource.length!==1 || refs.some(ref=>ref.ref===version.ref))continue;
      updates.push({target,edge,prior:edge.ref,seedRef:fromSource[0]});
    }else {
      const prior=edge.ref??curV(source)?.ref;
      const resetRange=relation==="video_ref"&&prior!==version.ref;
      updates.push({target,edge,prior,resetRange,start:edge.start,end:edge.end});
    }
  }
  return updates;
}

function vtLibraryReferences(items, kind) {
  const choices=[];
  for(const asset of items){
    const media=new Map((asset.media||[]).map(m=>[m.ref,m]));
    const views=asset.kind==="character"?asset.character_views||{}:{};
    const primary=kind==="image"?(views.main||asset.ref):libraryPrimary(asset)?.ref;
    const labelled=new Map();
    if(primary)labelled.set(primary,views.main===primary?CHARACTER_VIEWS.main[0]:"");
    for(const [slot,[label]] of Object.entries(CHARACTER_VIEWS)){
      if(views[slot]&&!labelled.has(views[slot]))labelled.set(views[slot],label);
    }
    let number=0;
    for(const ref of media.keys())if(!labelled.has(ref)&&cmMediaType(ref,media.get(ref))===kind){
      labelled.set(ref,"素材 "+(++number));
    }
    for(const [ref,label] of labelled){
      const item=media.get(ref)||{ref};
      if(cmMediaType(ref,item)!==kind)continue;
      const spec=libraryNodeSpec(asset,item);
      if(ref!==primary&&label)spec.name=`${asset.name} · ${label}`;
      choices.push({spec,label:[asset.name,label,cmScopeLabel(asset)].filter(Boolean).join(" · "),
        search:[asset.name,label,cmKind(asset),...(asset.aliases||[]),...(asset.tags||[])].join(" ").toLocaleLowerCase()});
    }
  }
  return choices;
}

function vtOpenReferenceUpdate(source,index,group=null,preset=null){
  if(!canvasCanEdit())return;
  const originals=group?(B.groups||[]).includes(group)?vtGroupReferenceSources(group):[]:[source];
  const planned=preset?.replacement && vtReferenceSources(source).find(n=>n.id===preset.replacement);
  const plannedIndex=planned?(planned.versions[preset.version-1]?.ref===preset.ref?preset.version-1:
    planned.versions.findIndex(v=>v.ref===preset.ref)):-1;
  if(preset && (!originals.includes(source) || !preset.spec&&
    (!planned || plannedIndex<0 || planned.versions[plannedIndex].source==="previs"))){
    toast("原素材、替换版本或组内引用已变化，请重新准备方案");return;
  }
  if(!originals.length)return;
  const originalId=source?.id;
  const scope={group,targets:preset?.targets?new Set(preset.targets):null};
  source=originals[0];
  if(node(source.id)!==source)return;
  const choosing=index===undefined, board=B, epoch=boardOpenEpoch;
  if(!choosing&&!vtCanCopyVersion(source,index))return;
  let dialog=$("#versionRefUpdate");
  if(!dialog){
    document.body.insertAdjacentHTML("beforeend",OneShotI18n.html`<dialog id="versionRefUpdate" aria-labelledby="versionRefTitle"><form>
      <header><strong id="versionRefTitle">更新下游引用</strong></header>
      <div data-choose-source hidden>
        <label data-original hidden>原素材<select name="original"></select></label>
        <label>替换素材<select name="replacement"></select></label>
        <label>素材版本<select name="replacementVersion"></select></label>
        <div class="vt-ref-actions">
          <button type="button" data-library-source aria-expanded="false">从资产库选择</button>
          <button type="button" data-upload-source>上传替换素材</button><input type="file" name="replacementFile" hidden>
        </div>
        <section data-library-picker hidden aria-label="资产库">
          <input type="search" aria-label="搜索资产" placeholder="搜索名称、别名或标签">
          <select aria-label="选择库中素材"></select>
          <div role="status"></div>
        </section>
        <div data-reference-media hidden></div>
        <div data-upload-status role="status" hidden></div>
      </div>
      <p data-summary></p><ol></ol>
      <footer><button type="button" data-cancel>取消</button><button type="submit">应用版本</button>
        <button type="submit" data-review-run hidden>替换并查看运行计划</button></footer>
    </form></dialog>`);
    dialog=$("#versionRefUpdate");
    dialog.onkeydown=event=>event.stopPropagation();
  }
  const form=$("form",dialog), list=$("ol",form), summary=$("[data-summary]",form), apply=$('[type="submit"]',form);
  const reviewRun=$("[data-review-run]",form);
  const cancel=$("[data-cancel]",form);
  const controls=$("[data-choose-source]",form);
  const original=$('[name="original"]',form);
  const sources=$('[name="replacement"]',form), versions=$('[name="replacementVersion"]',form);
  const uploadButton=$("[data-upload-source]",form), fileInput=$('[name="replacementFile"]',form);
  const uploadStatus=$("[data-upload-status]",form);
  const libraryButton=$("[data-library-source]",form), library=$("[data-library-picker]",form);
  const query=$("input",library), libraryChoices=$("select",library), libraryStatus=$("[role=status]",library);
  const mediaPreview=$("[data-reference-media]",form);
  const isCurrent=()=>B===board && boardOpenEpoch===epoch && canvasCanEdit() &&
    (!group||(B.groups||[]).includes(group)) && node(source.id)===source;
  const close=()=>{if(dialog.close)dialog.close();else dialog.removeAttribute("open");};
  dialog.onclose=()=>{if(!dialog.open)mediaPreview.replaceChildren();};
  cancel.onclick=close;
  $("#versionRefTitle",dialog).textContent=group?`${group.name} · 替换参考素材`:choosing?"替换下游参考":"更新下游引用";
  controls.hidden=!choosing;
  original.parentElement.hidden=!group;
  apply.textContent=choosing?"替换引用":"应用版本";
  reviewRun.hidden=!group;
  let replacement=source, version=source.versions[index], uploading=false;
  let staged=preset?.spec?{...preset.spec,id:newCanvasNodeId()}:null;
  let updates;
  const preview=()=>{
    updates=replacement?vtReferenceUpdates(source,version,replacement,scope):[];
    const change=choosing?`${source.name} → ${replacement?.name??""}`:source.name;
    summary.textContent=!replacement?"从资产库选择素材，或上传替换文件":
      updates.length?`${change} · 版本 ${index+1} · 更新 ${new Set(updates.map(u=>u.target.id)).size} 个节点`:
      "没有可更新的下游引用";
    list.innerHTML=updates.map(({target,edge,prior,resetRange,start,end})=>{
      const old=source.versions.findIndex(v=>v.ref===prior)+1;
      const priorLabel=edge.ref?(old?"版本 "+old:"原引用"):"跟随当前版本";
      const details=[priorLabel+" → 版本 "+(index+1),resetRange&&(start!=null||end!=null)?"参考区间将重置":""];
      return `<li>${esc(target.name)}<span>${esc(details.filter(Boolean).join(" · "))}</span></li>`;
    }).join("");
    apply.disabled=reviewRun.disabled=uploading||!updates.length;
  };
  if(choosing){
    let candidates=[];
    const options=nodes=>nodes.map(n=>`<option value="${esc(n.id)}">${esc(n.name)}${n!==staged?"":n.data.asset?"（资产库）":"（新上传）"}</option>`).join("");
    const showMedia=()=>{
      const v=replacement===staged&&version?.source==="asset"?version:null;
      mediaPreview.hidden=!v;
      mediaPreview.replaceChildren();
      if(!v)return;
      const player=document.createElement(staged.type==="image"?"img":staged.type);
      if(staged.type==="image")player.alt=staged.name;
      else {player.controls=true;player.preload="none";}
      player.src=v.url;
      mediaPreview.append(player);
    };
    versions.onchange=()=>{
      index=Number(versions.value);
      version=replacement.versions[index];
      preview();
      showMedia();
    };
    sources.onchange=()=>{
      replacement=candidates.find(n=>n.id===sources.value);
      versions.disabled=!replacement;
      versions.innerHTML=(replacement?.versions||[]).map((v,i)=>v.ref&&v.source!=="previs"?
        OneShotI18n.html`<option value="${i}">版本 ${i+1}${i===replacement.cur?"（当前）":""}</option>`:"").join("");
      if(!replacement){version=null;preview();showMedia();return;}
      if([...versions.options].some(option=>Number(option.value)===replacement.cur))versions.value=String(replacement.cur);
      versions.onchange();
    };
    original.innerHTML=options(originals);
    const refreshCandidates=selected=>{
      candidates=vtReferenceSources(source);
      if(staged?.type===source.type)candidates.unshift(staged);
      sources.disabled=!candidates.length;
      sources.innerHTML=options(candidates);
      if(selected)sources.value=selected;
      sources.onchange();
    };
    const setUploadStatus=message=>{
      uploadStatus.textContent=message;
      uploadStatus.hidden=!message;
    };
    const setUploading=busy=>{
      uploading=busy;
      original.disabled=uploadButton.disabled=libraryButton.disabled=busy;
      apply.disabled=reviewRun.disabled=busy||!updates?.length;
    };
    let choices=[], request=0;
    const setLibraryOpen=open=>{
      library.hidden=!open;
      libraryButton.setAttribute("aria-expanded",String(open));
      if(!open)request++;
    };
    const drawLibrary=()=>{
      const search=query.value.trim().toLocaleLowerCase();
      libraryChoices.replaceChildren(new Option("选择素材…",""));
      for(const [i,choice] of choices.entries()){
        if(!search||choice.search.includes(search))libraryChoices.add(new Option(choice.label,String(i)));
      }
      const empty=libraryChoices.options.length===1;
      libraryChoices.disabled=empty;
      libraryStatus.textContent=empty?(choices.length?OneShotI18n.t("没有匹配的素材"):"资产库中没有同类型的素材"):"";
    };
    query.oninput=drawLibrary;
    libraryChoices.onchange=()=>{
      if(!libraryChoices.value || !isCurrent() || uploading)return;
      staged={...choices[Number(libraryChoices.value)].spec,id:newCanvasNodeId()};
      refreshCandidates(staged.id);
      setLibraryOpen(false);
      libraryButton.focus();
    };
    const openLibrary=async()=>{
      if(!library.hidden){setLibraryOpen(false);return;}
      setLibraryOpen(true);
      query.value="";
      query.disabled=libraryChoices.disabled=true;
      libraryChoices.replaceChildren();
      libraryStatus.textContent=OneShotI18n.t("正在读取资产库…");
      const token=++request;
      const active=()=>dialog.open && isCurrent() && libraryButton.onclick===openLibrary && request===token;
      try{
        const items=await boardRequest("/api/memory?board="+encodeURIComponent(boardId));
        if(!active())return;
        choices=vtLibraryReferences(items,source.type);
        query.disabled=false;
        drawLibrary();
        query.focus();
      }catch(error){
        if(active())libraryStatus.textContent=error.message;
      }
    };
    libraryButton.onclick=openLibrary;
    const accepted={image:".png,.jpg,.jpeg,.webp",video:".mp4,.mov,.webm,.m4v,.mkv",audio:".wav,.mp3,.m4a,.aac,.flac,.ogg"};
    original.onchange=()=>{
      source=originals.find(n=>n.id===original.value);
      fileInput.accept=accepted[source.type];
      setUploadStatus("");
      setLibraryOpen(false);
      refreshCandidates();
    };
    uploadButton.onclick=()=>{setLibraryOpen(false);fileInput.click();};
    const upload=async()=>{
      const file=fileInput.files[0], kind=source.type;
      fileInput.value="";
      if(!file||uploading||!isCurrent())return;
      if(canvasUploadKind(file)!==kind){setUploadStatus(`请选择${TYPE_CN[kind]}文件`);return;}
      setUploading(true);
      setUploadStatus(`正在上传 ${file.name}…`);
      const active=()=>dialog.open && fileInput.onchange===upload && isCurrent();
      try{
        const media=await readCanvasFile(file,kind);
        if(!active())return;
        if(!media.version?.ref)throw new Error("未取得素材引用");
        staged={id:newCanvasNodeId(),type:kind,name:media.name||TYPE_CN[kind],data:media.data,versions:[media.version],cur:0};
        setUploadStatus("");
        refreshCandidates(staged.id);
      }catch(error){
        if(active())setUploadStatus("上传失败："+error.message);
      }finally{
        if(active())setUploading(false);
      }
    };
    fileInput.onchange=upload;
    setUploading(false);
    if(preset)original.value=originalId;
    original.onchange();
    if(preset){
      sources.value=planned?planned.id:staged.id;
      sources.onchange();
      versions.value=String(planned?plannedIndex:staged.cur);
      versions.onchange();
    }
  }else {
    fileInput.onchange=null;
    mediaPreview.replaceChildren();
    mediaPreview.hidden=true;
    preview();
  }
  form.onsubmit=event=>{
    event.preventDefault();
    if(uploading || !replacement)return;
    const adding=replacement===staged;
    if(!isCurrent() || (!adding&&!vtCanCopyVersion(replacement,index)) || replacement.versions[index]!==version){close();return;}
    const current=vtReferenceUpdates(source,version,replacement,scope);
    if(current.length!==updates.length || current.some((u,i)=>u.edge!==updates[i].edge||u.target!==updates[i].target||
      u.prior!==updates[i].prior||u.seedRef!==updates[i].seedRef||u.start!==updates[i].start||u.end!==updates[i].end)){
      preview();summary.textContent+="。连线已更新，请再次核对。";return;
    }
    if(!current.length)return;
    checkpoint();
    if(adding){
      const bounds=CT_FOLD_BOXES.get(ctFolded(source.id)?.id)||source;
      const dimensions=size({...staged,data:{...defaults(staged.type),...staged.data}});
      const spot=freeSpot(bounds.x-dimensions.w-110,bounds.y,staged.type,dimensions);
      buildCanvasMediaNode(staged,spot);
      void loadAssets();
    }
    const changed=new Set();
    for(const {target,edge,seedRef,resetRange} of current){
      if(!changed.has(target))rememberVideoVersion(target);
      changed.add(target);
      if(seedRef)target.data.references=seedAudioRefs(target).map(ref=>ref===seedRef?{...ref,node_id:replacement.id,ref:version.ref}:ref);
      else {
        edge.from=replacement.id;
        edge.ref=version.ref;
        if(resetRange){delete edge.start;delete edge.end;}
      }
    }
    changed.forEach(render);
    if(sel.size===1 && changed.has(node([...sel][0])))showPanel();
    drawEdges();save();close();
    toast(`已更新 ${changed.size} 个下游节点的参考`);
    if(group&&event.submitter===reviewRun)openCanvasGroupRun(group,{changed:new Set([...changed].map(target=>target.id))});
  };
  if(dialog.showModal)dialog.showModal();else dialog.setAttribute("open","");
  (group?original:!choosing?cancel:sources.disabled?uploadButton:sources).focus();
}
