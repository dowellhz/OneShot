"use strict";

function closeShotEditor() {
  const dialog=$("#shotEditor");
  if(dialog.open){if(dialog.close)dialog.close();else dialog.removeAttribute("open");}
}

function editShotAssets(dialog, notify) {
  const panel=$("[data-shot-assets]",dialog), search=$("[data-shot-asset-query]",panel);
  const selected=$("[data-shot-asset-selected]",panel), results=$("[data-shot-asset-results]",panel);
  const status=$("[data-shot-asset-status]",panel), bid=boardId;
  let refs=[], request=0, timer=null;
  const label=asset=>asset.name+(CHARACTER_VIEWS[asset.view]?.[0]?" · "+CHARACTER_VIEWS[asset.view][0]:"");
  const draw=()=>{
    selected.replaceChildren();
    refs.forEach((asset,index)=>{
      const row=document.createElement("li"), name=document.createElement("span"), remove=document.createElement("button");
      name.textContent=label(asset);
      remove.type="button";remove.textContent=OneShotI18n.t("移除");remove.dataset.removeShotAsset="";
      remove.setAttribute("aria-label","移除 "+label(asset));
      remove.onclick=()=>{refs.splice(index,1);status.textContent="";draw();notify();search.focus();};
      row.append(name,remove);selected.append(row);
    });
  };
  const find=()=>{
    const q=search.value.trim(), epoch=++request;
    clearTimeout(timer);
    results.replaceChildren();
    status.textContent=q?"正在找素材…":"";
    if(!q)return;
    const active=()=>dialog.open&&bid===boardId&&search.oninput===find&&epoch===request;
    timer=setTimeout(async()=>{
      try{
        const matches=await cmReferenceSearch(q);
        if(!active())return;
        status.textContent=matches.length?"":"没有匹配资产";
        for(const asset of matches){
          const row=document.createElement("li"), title=document.createElement("span"), add=document.createElement("button");
          title.textContent=asset.name+" · "+cmScopeLabel(asset);
          row.append(title);
          const slots=Object.keys(CHARACTER_VIEWS).filter(slot=>asset.character_views?.[slot]);
          let view;
          if(slots.length){
            view=document.createElement("select");
            view.setAttribute("aria-label",asset.name+" 的参考视角");
            view.append(new Option("默认参考",""),...slots.map(slot=>new Option(CHARACTER_VIEWS[slot][0],slot)));
            row.append(view);
          }
          add.type="button";add.textContent=OneShotI18n.t("添加");add.dataset.addShotAsset=asset.id;
          add.setAttribute("aria-label","添加 "+asset.name);
          add.onclick=()=>{
            const slot=view?.value||"", related=refs.filter(ref=>ref.id===asset.id);
            if(related.some(ref=>(ref.view||"")===slot))return;
            if(!related.length&&new Set(refs.map(ref=>ref.id)).size>=8){
              status.textContent="每镜最多采用 8 项资产";return;
            }
            if(slot&&related.filter(ref=>ref.view).length>=3){
              status.textContent="每个角色最多采用 3 个视角";return;
            }
            const keep=refs.filter(ref=>ref.id!==asset.id||slot&&ref.view);
            refs=[...keep,{id:asset.id,name:asset.name,kind:asset.kind,...(slot?{view:slot}:{})}];
            status.textContent="";draw();notify();
          };
          row.append(add);results.append(row);
        }
      }catch(error){if(active())status.textContent=error.message;}
    },140);
  };
  search.oninput=find;
  search.onkeydown=event=>{if(event.key==="Enter"&&!event.isComposing)event.preventDefault();};
  search.value="";
  find();
  panel.open=false;
  return {
    read:()=>structuredClone(refs),
    reset:assets=>{refs=structuredClone(assets||[]);draw();},
  };
}

function openShotEditor(script, index, onSaved, draft=null) {
  const order=script.data.shots||[], shot=draft||order[index];
  if(!shot||!canvasCanEdit()||node(script.id)!==script||nodeLocked(script))return;
  const dialog=$("#shotEditor"), form=$("form",dialog), board=boardId;
  if(dialog.open)return;
  const inserting=!!draft, placement=$("[data-shot-placement]",form), setAfter=$("select",placement), originalOrder=order.slice();
  const cast=$("[name=characters]",form);
  cast.closest("label").hidden=!inserting;
  placement.hidden=!inserting;
  const fields=$$("[name]",form).filter(field=>inserting||field!==cast), duration=form.elements.namedItem("duration");
  const status=$("[role=status]",form), saveButton=$("[type=submit]",form), run=$("[data-run-shot-edit]",form);
  const duplicate=$("[data-duplicate-shot]",form), remove=$("[data-remove-shot]",form), removeActions=$("[data-shot-remove-actions]",form);
  duplicate.hidden=remove.hidden=inserting;
  duplicate.disabled=remove.disabled=false;
  removeActions.hidden=true;
  if(inserting){
    setAfter.replaceChildren(new Option("放在最前面","0"),
      ...order.map((_,i)=>new Option(`第 ${i+1} 镜之后`,String(i+1))));
    setAfter.value=String(index);
  }
  $("#shotEditorTitle").textContent=inserting?"新增镜头":`编辑第 ${index+1} 镜`;
  saveButton.textContent=inserting?"添加镜头":"保存修改";
  const times=[...new Set([...SCRIPT_VIDEO_DURATIONS,...(shot.duration>0?[Number(shot.duration)]:[])])].sort((a,b)=>a-b);
  duration.replaceChildren(...times.map(seconds=>new Option(`${seconds} 秒`,String(seconds))));
  const multiline=new Set(["action","dialogue"]);
  const baseline={}, values={}, updatedTypes=new Set();
  const assets=editShotAssets(dialog,()=>form.oninput());
  let mode=null;
  const fill=()=>{
    for(const field of fields){
      const raw=shot[field.name]??null;
      baseline[field.name]=structuredClone(raw);
      field.value=field===duration?String(raw||5):field===cast?(raw||[]).join("，"):multiline.has(field.name)?(raw||[]).join("\n"):raw||"";
      values[field.name]=field.value;
    }
    baseline.asset_refs=structuredClone(shot.asset_refs??null);
    assets.reset(baseline.asset_refs);
  };
  const changed=()=>fields.filter(field=>field.value!==values[field.name]);
  const changedAssets=()=>JSON.stringify(assets.read())!==JSON.stringify(baseline.asset_refs||[]);
  const dirty=()=>!!changed().length||changedAssets();
  const getIndex=()=>script.data.shots?.indexOf(shot)??-1;
  const validateEdit=()=>{
    if(board!==boardId || !canvasCanEdit() || node(script.id)!==script || nodeLocked(script) || toolBusy.has(script.id)){
      throw new Error("分镜已变化、已锁定或正在改写，请重新打开编辑");
    }
    if(groupRun?.active&&groupRun.board===B&&groupRun.story?.scriptId===script.id){
      throw new Error("请等此分镜的批量生成结束后再修改");
    }
  };
  const publishOrder=notice=>{
    render(script);
    if(sel.size===1&&sel.has(script.id))showPanel();
    drawEdges();save();
    closeShotEditor();
    onSaved();
    toast(notice);
  };
  status.textContent="";
  fill();
  saveButton.disabled=!inserting;run.hidden=true;
  form.oninput=()=>{
    const hasChanges=dirty();
    saveButton.disabled=!inserting&&!hasChanges;
    duplicate.disabled=remove.disabled=hasChanges;
    removeActions.hidden=true;
    run.hidden=!mode||!saveButton.disabled;
    status.textContent="";
  };
  form.onsubmit=event=>{
    event.preventDefault();
    if(!dialog.open)return;
    const patch=inserting?fields:changed();
    const before={}, changes={};
    for(const field of patch){
      const name=field.name, value=field.value.trim();
      before[name]=baseline[name];
      changes[name]=field===duration?Number(value):field===cast?value.split(/[,，\n]+/).map(item=>item.trim()).filter(Boolean):
        multiline.has(name)?value.split("\n").map(line=>line.trim()).filter(Boolean):value;
    }
    if(changedAssets() || inserting&&assets.read().length){
      before.asset_refs=baseline.asset_refs;
      changes.asset_refs=assets.read();
    }
    try{
      validateEdit();
      if(inserting){
        const shots=script.data.shots||[], position=Number(setAfter.value);
        if(!setAfter.value || !Number.isInteger(position) || position<0 || position>shots.length ||
           shots.length!==originalOrder.length || shots.some((item,i)=>item!==originalOrder[i])){
          throw new Error("镜头顺序已变化，请重新选择插入位置");
        }
        checkpoint();
        ensureScriptShotIds(script);
        if(!script.data.shots)script.data.shots=shots;
        shots.splice(position,0,{id:newCanvasNodeId(),...changes});
        publishOrder(`已添加第 ${position+1} 镜`);
        return;
      }
      const currentIndex=getIndex();
      if(currentIndex<0)throw new Error("镜头已变化，请重新打开编辑");
      if(!Object.keys(changes).length)return;
      const result=applyScriptShotRevision(script,{shot_id:shot.id,shot:currentIndex+1,before,changes});
      for(const n of result.updated)updatedTypes.add(n.type);
      mode=updatedTypes.size>1?"all":updatedTypes.has("video")?"video":updatedTypes.has("image")?"frame":null;
      fill();
      saveButton.disabled=true;run.hidden=!mode;
      duplicate.disabled=remove.disabled=false;
      status.textContent=result.already?"修改已存在":`已保存分镜${result.updated.length?`，同步了 ${result.updated.length} 个生成节点`:""}。`+
        (result.retained.length?`保留「${result.retained.join("、")}」中的独立设置。`:"");
      onSaved();
    }catch(error){status.textContent=error.message;}
  };
  duplicate.onclick=()=>{
    const currentIndex=getIndex();
    if(inserting||dirty()||currentIndex<0)return;
    try{validateEdit();}catch(error){status.textContent=error.message;return;}
    closeShotEditor();
    openShotEditor(script,currentIndex+1,onSaved,shot);
  };
  remove.onclick=()=>{
    if(inserting||dirty())return;
    removeActions.hidden=false;
    status.textContent="将从分镜移除此镜，画布上的图片、视频和历史版本会保留。";
    $("[data-confirm-shot-remove]",removeActions).focus();
  };
  $("[data-cancel-shot-remove]",removeActions).onclick=()=>{
    removeActions.hidden=true;status.textContent="";remove.focus();
  };
  $("[data-confirm-shot-remove]",removeActions).onclick=()=>{
    const currentIndex=getIndex();
    if(inserting||dirty()||currentIndex<0||removeActions.hidden)return;
    try{
      validateEdit();
      const linked=scriptShotLinks(script)[currentIndex];
      if([node(linked?.img),node(linked?.vid)].some(n=>n&&(n.job||prepping.has(n.id)||toolBusy.has(n.id)))){
        throw new Error("请等本镜任务结束后再移出分镜");
      }
      checkpoint();
      ensureScriptShotIds(script);
      script.data.shots.splice(currentIndex,1);
      if(script.data.made)script.data.made=script.data.made.filter(pair=>pair.shot_id!==shot.id);
      publishOrder(`已移出第 ${currentIndex+1} 镜，可撤销`);
    }catch(error){status.textContent=error.message;}
  };
  run.onclick=()=>{
    const currentIndex=getIndex();
    if(board!==boardId || node(script.id)!==script || currentIndex<0 || !mode || dirty())return;
    closeShotEditor();
    openScriptShotRun(script,currentIndex,{mode});
  };
  if(dialog.showModal)dialog.showModal();else dialog.setAttribute("open","");
}
