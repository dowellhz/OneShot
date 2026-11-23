"use strict";

function remakeTimelineSpec(video, source, session) {
  const spec = newSpec([]);
  spec.fit = "pad";
  spec.subtitles = false;
  spec.remake_audio = source.ref;
  spec.clips = session.shots.map((shot, index) => {
    const inScope = !session.mapping || session.mapping.shots.includes(index);
    const job = session.reviewed_jobs ? session.reviewed_jobs[index] : inScope && !shot.keep_original ? shot.adopted_video : null;
    const adopted = shot.videos?.find(v => v.job === job && v.state === "done" && v.ref);
    const elapsed = (Math.round(shot.end * RM_FPS) - Math.round(shot.start * RM_FPS)) / RM_FPS;
    const take = adopted ? {ref:adopted.ref, in:0, out:elapsed, audio_start:shot.start, media_seconds:adopted.duration || elapsed}
      : {ref:source.ref, in:shot.start, out:shot.end, audio_start:0, media_seconds:session.duration};
    return {node:video.id, ...take, name:`镜头 ${index + 1}`, trans:"cut", subs:[], volume:1,
      remake_shot:{source:source.ref, start:shot.start, end:shot.end}};
  });
  return spec;
}

function sendRemakeToFilm(video, source, session) {
  if (!session?.shots.length || session.export_review?.remaining?.length) return toast("请先完成镜头审核");
  showFilm(remakeTimelineSpec(video, source, session));
}

function closeShotContinuityReview() {
  const dialog=$("#shotContinuityReview");
  if(!dialog?.open)return;
  if(dialog.close)dialog.close();else dialog.removeAttribute("open");
}

function openShotContinuityReview(script,index,evidence=null) {
  if(node(script.id)!==script||index<1)return;
  const links=scriptShotLinks(script);
  const previous=node(links[index-1]?.vid), video=node(links[index]?.vid), still=node(links[index]?.img);
  const choices=(n,kind,position)=>n?.versions.flatMap((version,i)=>{
    if(!version.ref)return [];
    const params=new URLSearchParams({ref:version.ref});
    if(position)params.set("position",position);
    return [{node:n.id,ref:version.ref,version:i+1,type:n.type,url:`${position?"/api/video/frame-preview":"/media"}?${params}`,
      label:`${kind} · 版本 ${i+1}${n.cur===i?"（当前）":""}`,current:n.cur===i}];
  })||[];
  const left=choices(previous,"视频","last");
  const right=[...choices(video,"视频首帧","first"),...choices(still,"分镜图")];
  const evidenceIndex=(items,version)=>{
    const matches=item=>item.node===version.node&&item.ref===version.ref;
    const exact=items.findIndex(item=>matches(item)&&item.version===version.version);
    return exact<0?items.findIndex(matches):exact;
  };
  const leftIndex=evidence?evidenceIndex(left,evidence.left):left.findIndex(item=>item.current);
  const rightIndex=evidence?evidenceIndex(right,evidence.right):right.findIndex(item=>item.current);
  if(evidence&&(leftIndex<0||rightIndex<0))return toast("审阅的镜头或版本已变化，请重新分析");
  if(!left.length)return toast("上一镜还没有可对比的视频");
  if(!right.length)return toast("请先为当前镜头准备分镜图或视频");
  const dialog=$("#shotContinuityReview");
  if(dialog.open)return;
  const board=boardId, request=$("[data-request-review]",dialog), requestStatus=$("footer [role=status]",dialog);
  const attempts=new Map();
  request.disabled=false;request.hidden=!canvasCanEdit();requestStatus.textContent="";
  $("#shotContinuityTitle").textContent=`${script.name} · 镜头 ${index} 与镜头 ${index+1}`;
  const fill=(selector,media,index,side)=>{
    const pane=$(selector,dialog), pick=$("select",pane), img=$("img",pane), status=$("[role=status]",pane);
    const samples=$("[data-samples]",pane);
    pick.replaceChildren(...media.map(({label},i)=>new Option(label,String(i))));
    pick.selectedIndex=Math.max(0,index);
    const show=url=>{
      img.hidden=true;
      status.textContent="正在读取画面…";
      img.onload=()=>{img.hidden=false;status.textContent="";};
      img.onerror=()=>{status.textContent="画面暂时无法读取";};
      img.src=url;
    };
    pick.onchange=()=>{
      const selected=media[pick.selectedIndex];
      const frames=pick.selectedIndex===index?evidence?.samples?.[side]||[]:[];
      samples.replaceChildren();samples.hidden=!frames.some(frame=>frame.position==="time");
      for(const frame of samples.hidden?[]:frames){
        const button=document.createElement("button");
        button.type="button";
        button.textContent=frame.position==="time"?`${frame.seconds.toFixed(2)}s`:frame.position==="last"?"尾帧":"首帧";
        button.setAttribute("aria-pressed",String(frame.position!=="time"));
        button.onclick=()=>{
          for(const item of samples.children)item.setAttribute("aria-pressed",String(item===button));
          const url=new URL(selected.url,location.href);
          url.searchParams.set("position",frame.position);
          if(frame.position==="time")url.searchParams.set("at",frame.at);
          show(url.pathname+url.search);
        };
        samples.append(button);
      }
      show(selected.url);
      if(side==="right")request.textContent=selected.type==="video"?"交给助手审阅动作衔接":"交给助手审阅画面衔接";
    };
    pick.onchange();
    return ()=>media[pick.selectedIndex];
  };
  const pickLeft=fill("[data-left-frame]",left,leftIndex,"left");
  const pickRight=fill("[data-right-frame]",right,rightIndex,"right");
  const submit=async()=>{
    const from=pickLeft(), to=pickRight();
    const pin=({node,ref,version})=>({node,ref,version});
    const shot_review={node_id:script.id,shot:index+1,left:pin(from),right:pin(to),current_type:to.type};
    const key=JSON.stringify(shot_review);
    if(!attempts.has(key))attempts.set(key,crypto.randomUUID?.()||("shot-review-"+Date.now()+Math.random()));
    request.disabled=true;requestStatus.textContent="正在提交审阅…";
    try{
      await acSendShotRequest(board,{shot_review,request_key:attempts.get(key),enqueue:true,
        text:`审阅第 ${index} 镜（版本 ${from.version}）到第 ${index+1} 镜${to.type==="image"?"分镜图":""}（版本 ${to.version}）的${to.type==="video"?"动作":"画面"}衔接`});
      if(request.onclick===submit && dialog.open){closeShotContinuityReview();$("#acInput").focus();}
    }catch(error){if(request.onclick===submit)requestStatus.textContent=error.message;}
    finally{if(request.onclick===submit)request.disabled=false;}
  };
  request.onclick=submit;
  if(dialog.showModal)dialog.showModal();else dialog.setAttribute("open","");
}

function openPlannedShotRange(plan) {
  const script=node(plan.script);
  if(plan.board!==boardId || !canvasCanEdit() || script?.type!=="script")return toast("请回到对应的可编辑分镜");
  const shots=script.data.shots||[];
  const indices=plan.anchors.map((anchor,offset)=>{
    if(anchor.id)return shots.findIndex(shot=>shot.id===anchor.id);
    const i=plan.first-1+offset, shot=shots[i];
    return shot&&Object.entries(anchor.fields).every(([key,value])=>JSON.stringify(shot[key]??null)===JSON.stringify(value))?i:-1;
  });
  if(!indices.length||indices.some((index,i)=>index<0||i>0&&index!==indices[i-1]+1))return toast("镜头范围已变化，请让助手重新准备");
  openShotRangePicker(script,null,{firstIndex:indices[0],lastIndex:indices.at(-1),mode:plan.mode,tailMode:plan.tail_mode});
}

function openShotRangePicker(script, onExpanded, {firstIndex=0,lastIndex=null,mode="missing",tailMode="keep"}={}) {
  if(!canvasCanEdit() || node(script.id)!==script || nodeLocked(script))return;
  const dialog=$("#shotRangePicker"), form=$("form",dialog), board=boardId, shots=script.data.shots.slice();
  if(dialog.open || !shots.length)return;
  const first=$("[name=first]",form), last=$("[name=last]",form), submit=$("[type=submit]",form), status=$("[role=status]",form);
  const label=(shot,i)=>`镜头 ${i+1}${shot.shot_size?" · "+shot.shot_size:""}`;
  first.replaceChildren(...shots.map((shot,i)=>new Option(label(shot,i),String(i))));
  first.value=String(firstIndex);
  const missing=()=>{
    const linked=scriptShotLinks(script);
    return shots.flatMap((_,i)=>i>=Number(first.value) && i<=Number(last.value) && shotNeedsNodes(linked[i])?[i]:[]);
  };
  const update=()=>{
    const amount=Number(last.value)-Number(first.value)+1, pending=missing().length;
    status.textContent=`已选 ${amount} 镜${pending?`，其中 ${pending} 镜待展开`:""}`;
    submit.textContent=pending?"展开并查看计划":"查看生成计划";
  };
  first.onchange=()=>{
    const start=Number(first.value), end=last.value===""?shots.length-1:Number(last.value);
    last.replaceChildren(...shots.slice(start).map((shot,i)=>new Option(label(shot,start+i),String(start+i))));
    last.value=String(end>=start&&end<shots.length?end:shots.length-1);
    update();
  };
  last.replaceChildren();last.onchange=update;first.onchange();
  if(lastIndex!=null){last.value=String(lastIndex);update();}
  form.onsubmit=event=>{
    event.preventDefault();
    if(board!==boardId || !canvasCanEdit() || node(script.id)!==script || nodeLocked(script) ||
       shots.length!==script.data.shots.length || shots.some((shot,i)=>shot!==script.data.shots[i])){
      status.textContent="分镜已更新，请重新选择镜头范围";submit.disabled=true;return;
    }
    if(groupRun?.active){status.textContent="当前有运行计划正在生成";return;}
    const pending=missing();
    if(pending.length){expandScript(script,pending);onExpanded?.();}
    closeShotRangePicker();
    openScriptShotRangeRun(script,Number(first.value),Number(last.value),mode,tailMode);
  };
  submit.disabled=false;
  if(dialog.showModal)dialog.showModal();else dialog.setAttribute("open","");
}

function closeShotRangePicker() {
  const dialog=$("#shotRangePicker");
  if(dialog.close)dialog.close();else dialog.removeAttribute("open");
}

function closeShotEditor() {
  const dialog=$("#shotEditor");
  if(dialog.open){if(dialog.close)dialog.close();else dialog.removeAttribute("open");}
}

function closeShotMediaPicker() {
  const dialog=$("#shotMediaPicker");
  if(dialog.open){if(dialog.close)dialog.close();else dialog.removeAttribute("open");}
}

function openShotMediaPicker(script, shot, onSaved) {
  const index=script.data.shots.indexOf(shot);
  if(index<0||!canvasCanEdit()||nodeLocked(script)||node(script.id)!==script)return;
  const dialog=$("#shotMediaPicker"), form=$("form",dialog), board=boardId;
  if(dialog.open)return;
  const selects=$$("select",form), status=$("[role=status]",form), submit=$("[type=submit]",form);
  const pair=scriptShotLinks(script)[index], binding=[pair?.img||"",pair?.vid||""];
  const usedByOtherShots=()=>{
    const used=new Set();
    for(const source of B.nodes.filter(n=>n.type==="script")){
      scriptShotLinks(source).forEach((linked,i)=>{
        if(linked&&(source!==script||source.data.shots[i]!==shot)){
          used.add(linked.img);used.add(linked.vid);
        }
      });
    }
    return used;
  };
  const types=["image","video"], permitted=(n,i,used)=>n?.type===types[i]&&
    (n.id===binding[i]||!!curV(n)?.ref&&!used.has(n.id)&&!n.data.previs&&!n.data.film&&!n.job&&!prepping.has(n.id));
  const used=usedByOtherShots();
  $("#shotMediaTitle").textContent=`关联第 ${index+1} 镜的素材`;
  status.textContent="";
  selects.forEach((select,i)=>{
    const candidates=B.nodes.filter(n=>permitted(n,i,used));
    select.replaceChildren(new Option("未关联",""),...candidates.map(n=>{
      const version=curV(n)?.ref?`版本 ${n.cur+1}`:"待生成";
      return new Option(`${n.name} · ${version}`,n.id);
    }));
    select.value=binding[i];
    if(!select.value)select.selectedIndex=0;
  });
  const changed=()=>selects.some((select,i)=>select.value!==binding[i]);
  submit.disabled=true;
  form.onchange=()=>{submit.disabled=!changed();status.textContent="";};
  form.onsubmit=event=>{
    event.preventDefault();
    if(!dialog.open||!changed())return;
    const currentIndex=script.data.shots.indexOf(shot);
    if(board!==boardId||node(script.id)!==script||!canvasCanEdit()||nodeLocked(script)||currentIndex<0){
      status.textContent="分镜已变化，请重新选择镜头";return;
    }
    if(groupRun?.active&&groupRun.board===B&&groupRun.story?.scriptId===script.id){
      status.textContent="请等此分镜的批量生成结束后再修改";return;
    }
    const current=scriptShotLinks(script)[currentIndex], next=selects.map(select=>select.value);
    if((current?.img||"")!==binding[0]||(current?.vid||"")!==binding[1]){
      status.textContent="素材关联已变化，请重新打开";return;
    }
    const occupied=usedByOtherShots();
    if(next.some((id,i)=>id&&!permitted(node(id),i,occupied))){
      status.textContent="所选素材已不可用或已关联其他镜头";return;
    }
    if(binding.some((id,i)=>id!==next[i]&&(node(id)?.job||prepping.has(id)))){
      status.textContent="请等原素材的生成任务结束后再修改";return;
    }
    checkpoint();
    ensureScriptShotIds(script);
    script.data.made=(script.data.made||[]).filter(record=>record.shot_id!==shot.id);
    if(next.some(Boolean))script.data.made.push({shot_id:shot.id,...(next[0]?{img:next[0]}:{}),...(next[1]?{vid:next[1]}:{})});
    refresh(script);save();
    closeShotMediaPicker();
    onSaved();
    toast("已更新镜头素材，可撤销");
  };
  if(dialog.showModal)dialog.showModal();else dialog.setAttribute("open","");
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
  let mode=null;
  const fill=()=>{
    for(const field of fields){
      const raw=shot[field.name]??null;
      baseline[field.name]=structuredClone(raw);
      field.value=field===duration?String(raw||5):field===cast?(raw||[]).join("，"):multiline.has(field.name)?(raw||[]).join("\n"):raw||"";
      values[field.name]=field.value;
    }
  };
  const changed=()=>fields.filter(field=>field.value!==values[field.name]);
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
    const hasChanges=!!changed().length;
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
      if(!patch.length)return;
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
    if(inserting||changed().length||currentIndex<0)return;
    try{validateEdit();}catch(error){status.textContent=error.message;return;}
    closeShotEditor();
    openShotEditor(script,currentIndex+1,onSaved,shot);
  };
  remove.onclick=()=>{
    if(inserting||changed().length)return;
    removeActions.hidden=false;
    status.textContent="将从分镜移除此镜，画布上的图片、视频和历史版本会保留。";
    $("[data-confirm-shot-remove]",removeActions).focus();
  };
  $("[data-cancel-shot-remove]",removeActions).onclick=()=>{
    removeActions.hidden=true;status.textContent="";remove.focus();
  };
  $("[data-confirm-shot-remove]",removeActions).onclick=()=>{
    const currentIndex=getIndex();
    if(inserting||changed().length||currentIndex<0||removeActions.hidden)return;
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
    if(board!==boardId || node(script.id)!==script || currentIndex<0 || !mode || changed().length)return;
    closeShotEditor();
    openScriptShotRun(script,currentIndex,{mode});
  };
  if(dialog.showModal)dialog.showModal();else dialog.setAttribute("open","");
}

function initShotList() {
  const button = $("#shotListBtn");
  if (!button) return;
  const panel = document.createElement("aside");
  panel.id = "shotList";
  panel.hidden = true;
  panel.setAttribute("aria-labelledby","shotListTitle");
  panel.innerHTML = `<header><h2 id="shotListTitle">镜头清单</h2><button class="pill" data-close>收起</button></header>
    <div class="sl-controls"><select data-source aria-label="镜头来源"></select><button class="pill" data-reload>刷新</button>
    <button class="pill" data-add-shot hidden>新增镜头</button><button class="pill" data-sort-shots hidden aria-pressed="false">排序</button><button class="pill" data-run-range hidden>批量生成</button><button class="pill" data-film disabled>送入剪辑</button><button class="pill" data-draft>恢复剪辑</button></div>
    <div class="sl-film-range" hidden><label>从<select data-film-from aria-label="剪辑起始镜头"></select></label>
      <label>到<select data-film-to aria-label="剪辑结束镜头"></select></label><span role="status" data-film-count></span></div>
    <output aria-live="polite"></output><ol></ol>`;
  document.body.append(panel);
  document.body.insertAdjacentHTML("beforeend",`<dialog id="shotContinuityReview" aria-labelledby="shotContinuityTitle">
    <header><h2 id="shotContinuityTitle"></h2><button type="button" data-close>关闭</button></header>
    <div class="shot-continuity-frames">
      <figure data-left-frame><figcaption>前一镜尾帧</figcaption><select aria-label="前一镜版本"></select>
        <div><img alt="前一镜画面" hidden><span role="status"></span></div><nav data-samples aria-label="前一镜取样" hidden></nav></figure>
      <figure data-right-frame><figcaption>当前镜头</figcaption><select aria-label="当前镜头版本"></select>
        <div><img alt="当前镜头画面" hidden><span role="status"></span></div><nav data-samples aria-label="当前镜头取样" hidden></nav></figure>
    </div><footer><span role="status"></span><button type="button" data-request-review>交给助手审阅</button></footer></dialog>
    <dialog id="shotRangePicker" aria-labelledby="shotRangeTitle"><form>
      <header><h2 id="shotRangeTitle">批量生成镜头</h2></header>
      <div class="sl-run-range"><label>开始镜头<select name="first"></select></label><label>结束镜头<select name="last"></select></label></div>
      <p role="status"></p><footer><button type="button" data-close>取消</button><button type="submit">查看生成计划</button></footer>
    </form></dialog>
    <dialog id="shotEditor" aria-labelledby="shotEditorTitle"><form>
    <header><h2 id="shotEditorTitle"></h2><button type="button" data-close>关闭</button></header>
    <div class="sl-edit-fields">
      <label class="sl-wide" data-shot-placement hidden>插入位置<select></select></label>
      <label>时长<select name="duration"></select></label>
      <label>景别<input name="shot_size" maxlength="60"></label>
      <label class="sl-wide">场景<textarea name="scene" rows="2" maxlength="800"></textarea></label>
      <label class="sl-wide" hidden>人物<input name="characters" placeholder="用逗号分隔人物名称"></label>
      <label class="sl-wide">首帧描述<textarea name="keyframe" rows="2" maxlength="800"></textarea></label>
      <label class="sl-wide">运镜<textarea name="camera" rows="2" maxlength="400"></textarea></label>
      <label>动作<textarea name="action" rows="4" placeholder="一行一个动作"></textarea></label>
      <label>台词<textarea name="dialogue" rows="4" placeholder="一行一句台词"></textarea></label>
      <label class="sl-wide">声音<textarea name="sound" rows="2" maxlength="600"></textarea></label>
    </div>
    <p role="status"></p>
    <div class="sl-remove-actions" data-shot-remove-actions hidden><button type="button" data-cancel-shot-remove>取消</button><button type="button" data-confirm-shot-remove>确认移出</button></div>
    <footer><button type="button" data-duplicate-shot>复制设定</button><button type="button" data-remove-shot>移出分镜</button>
      <button type="button" data-run-shot-edit hidden>查看重生成计划</button><button type="submit">保存修改</button></footer>
    </form></dialog>
    <dialog id="shotMediaPicker" aria-labelledby="shotMediaTitle"><form>
    <header><h2 id="shotMediaTitle"></h2><button type="button" data-close>关闭</button></header>
    <div class="sl-edit-fields">
      <label class="sl-wide">分镜图节点<select></select></label>
      <label class="sl-wide">视频节点<select></select></label>
    </div>
    <p>分镜使用所选节点的当前版本。</p><p role="status"></p>
    <footer><button type="submit">保存关联</button></footer>
    </form></dialog>`);
  const review=$("#shotContinuityReview");
  $("[data-close]",review).onclick=closeShotContinuityReview;
  review.onkeydown=event=>event.stopPropagation();
  review.onclose=()=>{if(!review.open)$$("img",review).forEach(img=>img.removeAttribute("src"));};
  const picker=$("#shotRangePicker");
  $("[data-close]",picker).onclick=closeShotRangePicker;
  picker.onkeydown=event=>event.stopPropagation();
  const editor=$("#shotEditor");
  $("[data-close]",editor).onclick=closeShotEditor;
  editor.onkeydown=event=>event.stopPropagation();
  const mediaPicker=$("#shotMediaPicker");
  $("[data-close]",mediaPicker).onclick=closeShotMediaPicker;
  mediaPicker.onkeydown=event=>event.stopPropagation();
  let epoch = 0;
  const sourceSelect = $("[data-source]", panel);
  const list = $("ol", panel), message = $("output", panel), film = $("[data-film]", panel);
  const run=$("[data-run-range]",panel), sort=$("[data-sort-shots]",panel), add=$("[data-add-shot]",panel);
  const range=$(".sl-film-range",panel), from=$("[data-film-from]",range), to=$("[data-film-to]",range), count=$("[data-film-count]",range);
  let filmRange = null, sorting=false, dragged=null;

  function toggle(show) {
    panel.hidden = !show;
    button.setAttribute("aria-expanded", String(show));
    if (!show) { epoch++;sorting=false;dragged=null;return; }
    const sources = B.nodes.filter(n => n.type === "script" ||
      n.type === "video" && curV(n)?.ref && !n.data.film && !curV(n).remake);
    const selected = sources.find(n => sel.has(n.id))?.id || sourceSelect.value;
    sourceSelect.replaceChildren(...sources.map(n => new Option(n.name, n.id)));
    if (sources.some(n => n.id === selected)) sourceSelect.value = selected;
    refresh();
  }
  function locate(target) {
    if (!target) return;
    selectOnly(target.id);
    fit([target]);
  }
  function row(title, details, onOpen, versions, selected, onVersion, shotIndex=null, onCompare=null) {
    const el = document.createElement("li"), info = document.createElement("div"), open = document.createElement("button");
    open.type = "button"; open.className = "pill"; open.textContent = title; open.onclick = onOpen;
    const subtitle = document.createElement("span"); subtitle.textContent = details;
    info.append(open, subtitle); el.append(info);
    if(shotIndex!==null){
      const tail=document.createElement("span");tail.className="story-tail-status";
      tail.dataset.scriptTailStatus=String(shotIndex);tail.hidden=true;info.append(tail);
    }
    if(onCompare){
      const compare=document.createElement("button");compare.className="pill";compare.type="button";
      compare.textContent="对比衔接";compare.onclick=onCompare;info.append(compare);
    }
    if (versions.length) {
      const input = document.createElement("select");
      input.setAttribute("aria-label", `${title}版本`);
      input.replaceChildren(...versions.map(([value, label]) => new Option(label, value)));
      input.value = selected || "";
      input.onchange = () => onVersion(input.value);
      el.append(input);
    }
    list.append(el);
    return el;
  }
  function shotTailActions(el, script, shot, index) {
    const actions=document.createElement("div");
    actions.className="sl-tail-actions";actions.dataset.shotTailActions=String(index);actions.hidden=true;
    actions.innerHTML='<button class="pill" type="button" data-tail-link></button><button class="pill" type="button" data-tail-remove>移除尾帧引用</button>';
    actions.onclick=async event=>{
      const control=event.target.closest("button");
      if(!control||control.hidden||control.disabled||sourceSelect.value!==script.id||
        node(script.id)!==script||script.data.shots[index]!==shot||!canvasCanEdit()||nodeLocked(script))return;
      if(groupRun?.active&&groupRun.board===B&&groupRun.story?.scriptId===script.id){
        return toast("请等此分镜的批量生成结束后再修改尾帧");
      }
      if(control.hasAttribute("data-tail-remove")){
        const edge=scriptTailEdges().get(scriptShotLinks(script)[index]?.img);
        if(edge&&cutEdge(edge))toast("已移除尾帧引用，可撤销");
        return;
      }
      const pending=linkPreviousShotFrame(script,index,{select:false});
      paintScriptContinuity(script,list);
      await pending;
      if(node(script.id)===script&&sourceSelect.value===script.id)paintScriptContinuity(script,list);
    };
    el.firstElementChild.append(actions);
  }
  function moveShot(script, shots, from, to, focus) {
    if(panel.hidden || sourceSelect.value!==script.id || node(script.id)!==script || !canvasCanEdit() || nodeLocked(script))return;
    if(groupRun?.active && groupRun.board===B && groupRun.story?.scriptId===script.id){
      message.textContent="请等此分镜的批量生成结束后再排序";
      return;
    }
    const order=script.data.shots;
    if(order.length!==shots.length || shots.some((shot,i)=>shot!==order[i]))return refresh();
    if(from===to || !shots[from] || !shots[to])return;
    checkpoint();
    ensureScriptShotIds(script);
    const [shot]=order.splice(from,1);
    order.splice(to,0,shot);
    render(script);
    if(sel.size===1&&sel.has(script.id))showPanel();
    drawEdges();
    save();
    refresh();
    const edge=scriptTailEdges(), links=scriptShotLinks(script);
    const warnings=links.filter((_,i)=>scriptContinuityStatus(links,i,edge)?.warning).length;
    message.textContent=`已把第 ${from+1} 镜移到第 ${to+1} 镜${warnings?`，有 ${warnings} 处尾帧引用待核对`:""}`;
    const controls=$$("[data-shot-order]",list)[to];
    ($(`[data-step="${focus}"]:not(:disabled)`,controls) || $("button:not(:disabled)",controls))?.focus();
  }
  function shotOrderControls(el, script, shots, index) {
    const controls=document.createElement("div");
    controls.className="sl-shot-order";controls.dataset.shotOrder=String(index);
    const grip=document.createElement("span");
    grip.className="sl-sort-grip";grip.textContent="⠿";grip.title="拖动调整顺序";grip.draggable=true;grip.setAttribute("aria-hidden","true");
    controls.append(grip);
    for(const [step,label] of [[-1,"上移"],[1,"下移"]]){
      const move=document.createElement("button");
      move.type="button";move.className="pill";move.dataset.step=String(step);
      move.textContent=step<0?"↑":"↓";move.title=label;move.setAttribute("aria-label",`${label}第 ${index+1} 镜`);
      move.disabled=!shots[index+step];
      move.onclick=()=>moveShot(script,shots,index,index+step,step);
      controls.append(move);
    }
    el.append(controls);
    grip.ondragstart=event=>{
      dragged={script,shots,index};
      event.dataTransfer.setData("application/x-oneshot-shot-order",String(index));
      event.dataTransfer.effectAllowed="move";
    };
    grip.ondragend=()=>{
      dragged=null;
      for(const row of $$("[data-shot-drop]",list))row.removeAttribute("data-shot-drop");
    };
    const targetAt=event=>{
      const {top,height}=el.getBoundingClientRect(), after=event.clientY>=top+height/2;
      const insert=index+Number(after);
      return {after,to:insert-Number(insert>dragged.index)};
    };
    el.ondragover=event=>{
      if(dragged?.shots!==shots)return;
      event.preventDefault();
      event.dataTransfer.dropEffect="move";
      for(const row of $$("[data-shot-drop]",list))row.removeAttribute("data-shot-drop");
      el.dataset.shotDrop=targetAt(event).after?"after":"before";
    };
    el.ondragleave=event=>{if(!el.contains(event.relatedTarget))el.removeAttribute("data-shot-drop");};
    el.ondrop=event=>{
      if(dragged?.shots!==shots)return;
      event.preventDefault();
      const origin=dragged.index, {to}=targetAt(event);
      grip.ondragend();
      moveShot(script,shots,origin,to,-1);
    };
  }
  function scriptFilmRange(target, connected, rows) {
    const board=boardId, shots=target.data.shots.slice();
    const keys=shots.map((shot,i)=>shot.id || `index:${i}`);
    const isReady=pair=>!!curV(node(pair?.vid))?.ref;
    const options=keys.map((key,i)=>new Option(`镜头 ${i+1}`,key));
    options.forEach((option,i)=>option.disabled=!isReady(connected[i]));
    from.replaceChildren(...options);
    from.selectedIndex=options.findIndex(option=>!option.disabled);
    if(filmRange?.board===board && filmRange.script===target.id && options.some(option=>option.value===filmRange.from&&!option.disabled)){
      from.value=filmRange.from;
    }
    const update=()=>{
      const start=from.selectedIndex, end=keys.indexOf(to.value);
      const amount=start>=0&&end>=start?end-start+1:0;
      film.disabled=!amount;
      count.textContent=amount?`已选 ${amount} 镜`:"暂无可剪辑的镜头";
      rows.forEach((row,i)=>row.toggleAttribute("data-clip-range",amount>0&&i>=start&&i<=end));
    };
    const chooseEnd=preferred=>{
      const start=from.selectedIndex, ends=[];
      for(let i=start;i>=0&&i<keys.length&&isReady(connected[i]);i++)ends.push(new Option(`镜头 ${i+1}`,keys[i]));
      to.replaceChildren(...ends);
      to.selectedIndex=ends.length-1;
      if(ends.some(option=>option.value===preferred))to.value=preferred;
      from.disabled=to.disabled=!ends.length;
      update();
    };
    const remember=()=>{filmRange={board,script:target.id,from:from.value,to:to.value};};
    from.onchange=()=>{chooseEnd(to.value);remember();};
    to.onchange=()=>{update();remember();};
    chooseEnd(filmRange?.board===board && filmRange.script===target.id?filmRange.to:null);
    film.onclick=()=>{
      if(board!==boardId || node(target.id)!==target)return refresh();
      const current=target.data.shots, start=from.selectedIndex, end=keys.indexOf(to.value);
      const latest=scriptShotLinks(target);
      if(start<0 || end<start || keys.length!==current.length || shots.slice(start,end+1).some((shot,i)=>shot!==current[start+i]))return refresh();
      const pairs=latest.slice(start,end+1);
      if(pairs.length!==end-start+1 || pairs.some((pair,i)=>pair?.vid!==connected[start+i]?.vid || !isReady(pair)))return refresh();
      openStoryFilm(target,start,end);
    };
    range.hidden=false;
  }
  async function refresh() {
    const request = ++epoch, board = boardId, target = node(sourceSelect.value);
    list.replaceChildren(); message.textContent = ""; film.disabled = true; film.onclick = null; range.hidden=true;
    add.hidden=target?.type!=="script" || !canvasCanEdit() || nodeLocked(target);
    run.hidden=add.hidden||!target.data.shots?.length;
    sort.hidden=run.hidden||target.data.shots.length<2;
    if(sort.hidden)sorting=false;
    sort.setAttribute("aria-pressed",String(sorting));
    sort.textContent=sorting?"完成排序":"排序";
    if (!target) { message.textContent = "添加原片或生成分镜后，可在这里查看镜头。"; return; }
    if (target.type === "script") {
      if(!target.data.shots?.length){message.textContent="分镜还没有镜头";return;}
      const connected = scriptShotLinks(target);
      const shots=target.data.shots.slice();
      const rows=shots.map((shot, i) => {
        const v = node(connected[i]?.vid);
        const el=row(`镜头 ${i + 1}`, [`${shot.duration || "—"} 秒`, ...(shot.characters || []),
          v?.job ? "生成中" : curV(v) ? "已生成" : connected[i]?"待生成":"未展开"].join(" · "),
          () => locate(v || node(connected[i]?.img) || target),
          v?.versions.map((_, index) => [String(index), `版本 ${index + 1}`]) || [], String(v?.cur ?? ""),
          value => { if (switchVersion(v, +value)) locate(v); refresh(); },i,
          i>0&&connected[i-1]&&connected[i]?()=>openShotContinuityReview(target,i):null);
        if(connected[i]?.img)shotTailActions(el,target,shot,i);
        if(!sorting&&canvasCanEdit()&&!nodeLocked(target)){
          const edit=document.createElement("button");
          edit.type="button";edit.className="pill sl-edit-shot";edit.dataset.editShot=String(i);
          edit.textContent="编辑";edit.setAttribute("aria-label",`编辑第 ${i+1} 镜`);
          edit.onclick=()=>openShotEditor(target,target.data.shots.indexOf(shot),refresh);
          const media=document.createElement("button");
          media.type="button";media.className="pill sl-edit-shot";media.dataset.shotMedia=String(i);
          media.textContent="关联素材";media.setAttribute("aria-label",`关联第 ${i+1} 镜的素材`);
          media.onclick=()=>openShotMediaPicker(target,shot,refresh);
          el.firstElementChild.firstElementChild.after(edit,media);
        }
        if(sorting){
          const summary=shot.keyframe || shot.action?.[0] || shot.scene;
          if(summary){
            const text=document.createElement("span");
            text.className="sl-shot-summary";text.textContent=summary;el.firstElementChild.append(text);
          }
          shotOrderControls(el,target,shots,i);
        }
        return el;
      });
      paintScriptContinuity(target,list,connected);
      scriptFilmRange(target,connected,rows);
      return;
    }
    const source = curV(target);
    message.textContent = "读取镜头…";
    try {
      await flushSave();
      const url = `/api/video-remake/${encodeURIComponent(board)}/${encodeURIComponent(target.id)}?source=${encodeURIComponent(source.ref)}`;
      const session = await remakeRequest(url);
      if (request !== epoch || board !== boardId || panel.hidden) return;
      message.textContent = "";
      if (!session?.shots.length) {
        row("分析原片", "待分析", () => openVideoRemake(target), [], "", null);
        return;
      }
      const issues = new Set(session.export_review?.remaining.map(x => x.shot));
      session.shots.forEach((shot, i) => {
        const versions = (shot.videos || []).filter(v => v.state === "done" && v.ref);
        const adopted = !issues.has(i) && versions.some(v => v.job === (session.reviewed_jobs ? session.reviewed_jobs[i] : shot.adopted_video));
        const kept = !adopted && !issues.has(i) && (shot.keep_original || session.mapping && !session.mapping.shots.includes(i));
        const state = kept ? "保留原片" : adopted ? "已采用" : shot.videos?.some(v => !["done","error"].includes(v.state)) ? "生成中" : versions.length ? "待审核" : "待生成";
        const open = videoJob => openVideoRemake(target, {shotStart:shot.start, videoJob});
        row(`镜头 ${i + 1}`, [`${(shot.end - shot.start).toFixed(1)} 秒`, ...(shot.summary?.characters || []), state].join(" · "),
          () => open(adopted && !kept ? shot.adopted_video : undefined),
          versions.length ? [["","查看版本"], ...versions.map(v => [v.job,`版本 ${shot.videos.indexOf(v) + 1}`])] : [],
          adopted && !kept ? shot.adopted_video : "", value => { if (value) open(value); });
      });
      film.disabled = issues.size > 0;
      film.onclick = () => sendRemakeToFilm(target, source, session);
    } catch (error) {
      if (request === epoch && board === boardId) message.textContent = error.message;
    }
  }
  button.onclick = () => toggle(panel.hidden);
  $("[data-close]", panel).onclick = () => toggle(false);
  $("[data-reload]", panel).onclick = () => toggle(true);
  $("[data-draft]", panel).onclick = resumeFilmDraft;
  run.onclick=()=>{const target=node(sourceSelect.value);if(target?.type==="script")openShotRangePicker(target,refresh);};
  add.onclick=()=>{
    const script=node(sourceSelect.value);
    if(script?.type!=="script")return;
    const shots=script.data.shots||[], adjacent=shots.at(-1);
    openShotEditor(script,shots.length,refresh,{duration:5,shot_size:"中景",scene:adjacent?.scene,characters:adjacent?.characters});
  };
  sort.onclick=()=>{sorting=!sorting;dragged=null;refresh();};
  sourceSelect.onchange = ()=>{sorting=false;dragged=null;refresh();};
  panel.addEventListener("canvas-restored",()=>{if(!panel.hidden&&node(sourceSelect.value)?.type==="script")refresh();});
  panel.addEventListener("keydown", event => {
    event.stopPropagation();
    if(event.key==="Escape"){toggle(false);button.focus();return;}
    if(node(sourceSelect.value)?.type==="script" && canvasCanEdit() && (event.metaKey||event.ctrlKey) && event.key.toLowerCase()==="z"){
      event.preventDefault();
      if(event.shiftKey)redo();else undo();
      (sort.hidden?$("[data-close]",panel):sort).focus();
    }
  });
}
