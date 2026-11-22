"use strict";

function closeSegmentEditor() {
  const dialog=$("#videoSegment"), player=$("video",dialog);
  if (!dialog.open) return;
  player.pause();player.removeAttribute("src");player.onloadedmetadata=player.ontimeupdate=player.onseeked=null;
  if (dialog.close) dialog.close(); else dialog.removeAttribute("open");
}

const CAMERA_ANGLES={front:"正面",front_left:"左前方三分之四",front_right:"右前方三分之四",left:"左侧",right:"右侧",rear:"背面",overhead:"俯拍",low:"低机位仰拍"};
const CAMERA_SCALES={detail:"大特写",close:"特写",medium_close:"中近景",medium:"中景",wide:"全景",far:"远景"};
const cameraModeLabel={fixed:"固定机位",cut:"切换机位",move:"连续运镜"};

function retakeControls(form, enabled, existing) {
  const panel=$("[data-vs-camera]",form), mode=form.elements.cameraMode;
  panel.hidden=!enabled;
  if (!enabled) return ()=>null;
  const views={};
  for (const key of ["start","end"]) {
    const group=$(`[data-vs-view="${key}"]`,panel);
    const legend=$("legend",group);
    group.replaceChildren(legend);
    views[key]={};
    for (const [field,label,choices] of [["angle","角度",CAMERA_ANGLES],["scale","景别",CAMERA_SCALES]]) {
      const wrap=document.createElement("label"), select=document.createElement("select");
      select.append(...Object.entries(choices).map(([value,name])=>new Option(name,value)));
      select.value=Object.hasOwn(choices,existing?.[key]?.[field])?existing[key][field] :
        field==="scale"?"medium":key==="start"?"front":"front_left";
      wrap.append(label,select);group.append(wrap);views[key][field]=select;
    }
  }
  mode.value=Object.hasOwn(cameraModeLabel,existing?.mode)?existing.mode:"fixed";
  mode.onchange=()=>{
    $("[data-vs-view=end]",panel).hidden=mode.value==="fixed";
    $("[data-vs-view=start] legend",panel).textContent=mode.value==="fixed"?"机位":"起始机位";
    $("[data-vs-camera-hint]",panel).textContent=mode.value==="cut"?"在区间中点切到结束机位。":
      mode.value==="move"?"从起始机位平滑移到结束机位。":"整个区间使用同一机位和景别。";
  };
  mode.onchange();
  const view=key=>Object.fromEntries(Object.entries(views[key]).map(([name,select])=>[name,select.value]));
  return ()=>{
    const start=view("start"), end=view("end");
    if (mode.value==="fixed" || (start.angle===end.angle && start.scale===end.scale)) return {mode:"fixed",start};
    return {mode:mode.value,start,end};
  };
}

function openRetakeSettings(target) {
  const input=videoInputs(target)[0];
  if (!input?.edge.segment_edit || !input.version) return toast("重拍的原片版本已移除");
  openSegmentEditor(input.source,{retake:true,target,input});
}

function segmentBounds(range,total) {
  const {start,end}=range;
  const first=segmentFrame(start), last=segmentFrame(Math.min(end,total)), length=last-first;
  if (!(0<=start && start<end && end<=total+.02 && length>=4*SEGMENT_FPS && length<=30*SEGMENT_FPS)) return null;
  return {first,last};
}

function retakeRangePicker(form,player,getTotal,read,load,update) {
  const host=$("[data-retake-ranges]",form), tabs=$("[data-retake-tabs]",host), strip=$("[data-retake-strip]",host);
  const add=$("[data-retake-add]",host), split=$("[data-retake-split]",host);
  const remove=$("[data-retake-remove]",host), preview=$("[data-retake-preview]",host);
  const ranges=[read()];
  let active=0, previewEnd=null;
  const save=()=>{ranges[active]=read();return ranges;};
  const select=(index,seek=true)=>{
    active=index;
    load(ranges[index]);
    previewEnd=null;
    if (seek && player.readyState>=1 && Number.isFinite(ranges[index].start)) {
      player.pause();
      player.currentTime=ranges[index].start;
    }
    update();
  };
  const ordered=()=>save().map((range,index)=>({index,...segmentBounds(range,getTotal())}))
    .sort((a,b)=>(a.first??Infinity)-(b.first??Infinity));
  const seconds=frame=>Number((frame/SEGMENT_FPS).toFixed(5));
  const gap=()=>{
    const total=segmentFrame(getTotal()), entries=ordered(), minimum=4*SEGMENT_FPS;
    if (entries.some(entry=>entry.first===undefined)) return null;
    let last=0;
    for (const entry of [...entries,{first:total,last:total}]) {
      if (entry.first-last>=minimum) return {first:last,last:Math.min(entry.first,last+5*SEGMENT_FPS)};
      last=Math.max(last,entry.last);
    }
    return null;
  };
  const playheadCut=()=>{
    const bounds=segmentBounds(save()[active],getTotal()), at=segmentFrame(player.currentTime);
    if (!bounds || player.readyState<1 || at-bounds.first<4*SEGMENT_FPS || bounds.last-at<4*SEGMENT_FPS) return null;
    return at;
  };
  const render=()=>{
    const total=getTotal(), end=segmentFrame(total), entries=ordered();
    strip.replaceChildren(...entries.filter(entry=>entry.first!==undefined).map(entry=>{
      const mark=document.createElement("span");
      mark.style.left=100*entry.first/end+"%";
      mark.style.width=100*(entry.last-entry.first)/end+"%";
      mark.classList.toggle("on",entry.index===active);
      return mark;
    }));
    tabs.replaceChildren(...entries.map(({index,first,last},i)=>{
      const button=document.createElement("button");
      button.type="button";
      button.setAttribute("aria-pressed",String(index===active));
      button.textContent=first===undefined?`区间 ${i+1} · 待调整`:`${seconds(first).toFixed(2)}–${seconds(last).toFixed(2)} 秒`;
      button.onclick=()=>{save();select(index);form.elements.start.focus();};
      return button;
    }));
    add.disabled=!gap();
    remove.disabled=ranges.length===1;
    preview.disabled=!segmentBounds(ranges[active],total);
    split.disabled=playheadCut()===null;
  };
  add.onclick=()=>{
    const range=gap();
    if (!range) return;
    ranges.push({start:seconds(range.first),end:Math.min(getTotal(),seconds(range.last)),prompt:""});
    select(ranges.length-1);
  };
  split.onclick=()=>{
    const at=playheadCut();
    if (at===null) return;
    const before=save()[active];
    const time=seconds(at);
    ranges.splice(active,1,{...before,end:time},{...before,start:time});
    select(active+1,false);
  };
  remove.onclick=()=>{
    if (ranges.length<2) return;
    ranges.splice(active,1);
    select(Math.min(active,ranges.length-1));
  };
  preview.onclick=()=>{
    if (player.readyState<1) return toast("视频正在载入，请稍后预览");
    const {first,last}=segmentBounds(save()[active],getTotal());
    player.currentTime=seconds(first);
    previewEnd=seconds(last);
    player.play()?.catch(()=>{previewEnd=null;toast("无法播放预览");});
  };
  player.ontimeupdate=()=>{
    if (previewEnd!==null && player.currentTime>=previewEnd) {
      player.pause();
      if (player.currentTime>previewEnd) player.currentTime=previewEnd;
      previewEnd=null;
    }
    split.disabled=playheadCut()===null;
  };
  return {read:save,render};
}

function openSegmentEditor(source,{retake=false,objectAction=null,target=null,input=null}={}) {
  const version=input?.version || curV(source), index=input?.index ?? source.cur;
  if (!canvasCanEdit() || !version || version.source==="previs") return;
  if (target && (target.job || prepping.has(target.id))) return toast("请等待当前视频任务完成");
  const board=boardId, epoch=boardOpenEpoch, dialog=$("#videoSegment"), form=$("form",dialog), player=$("video",form);
  if (dialog.open) return;
  const targetIndex=target?.cur;
  const start=form.elements.start, end=form.elements.end, provider=form.elements.provider, prompt=form.elements.prompt;
  const status=$("[data-vs-status]",form), submit=$("[type=submit]",form), generate=$("[data-retake-generate]",form);
  const multi=retake && !target;
  $("[data-retake-ranges]",form).hidden=!multi;
  generate.hidden=!multi;
  const services=CAPS_LIST.segment_edit || [];
  let total=Number(version.seconds)||0;
  provider.replaceChildren(...services.map(r=>new Option(r.name+" · "+r.model,r.id)));
  if (!services.length) provider.append(new Option("请配置支持片段编辑的 Seedance 2.5",""));
  start.value=input?.edge.start??0;end.value=input?.edge.end??(total?Math.min(total,5):"");
  prompt.value=target?.data.prompt || "";
  prompt.placeholder=objectAction?"选填，例如说明要保留的遮挡、影子或物体运动":retake?"选填，例如保留人物回头的动作，在换机位后突出表情":"例如把窗外改成雨天，保留人物和镜头节奏";
  provider.value=services.some(service=>service.id===target?.data.provider)?target.data.provider:provider.options[0].value;
  $("#videoSegmentTitle").textContent=objectAction?OBJECT_EDIT_LABELS[objectAction]:retake?"镜头重拍":"修改视频片段";
  submit.textContent=target?(objectAction?"保存物体编辑设置":"保存重拍设置"):retake?"创建重拍节点":"创建修改节点";
  let readCamera=retakeControls(form,retake,target?.data.camera_plan);
  const read=()=>({start:start.valueAsNumber,end:end.valueAsNumber,prompt:prompt.value.trim(),camera_plan:readCamera()});
  const load=range=>{
    start.value=Number.isFinite(range.start)?range.start:"";
    end.value=Number.isFinite(range.end)?range.end:"";
    prompt.value=range.prompt;
    readCamera=retakeControls(form,retake,range.camera_plan);
  };
  $("[data-vs-title]",form).textContent=`${source.name} · 版本 ${index+1}`;
  const reason=ranges=>{
    if (!services.length) return "在控制台配置 Seedance 2.5 和参考视频公网地址后可使用。";
    if (!total) return "正在读取视频时长…";
    if (total<4) return "原视频须至少 4 秒。";
    const intervals=ranges.map(range=>segmentBounds(range,total));
    if (intervals.includes(null)) return ranges.length>1?"请检查各区间的入出点。每段须在原片范围内，长度为 4 到 30 秒。":
      "请在原片范围内选择 4 到 30 秒。";
    if (objectAction) {
      if (objectControls.busy()) return "正在上传替换参考图…";
      const plan=objectControls.read(), {first,last}=intervals[0];
      if (!plan) return "请在视频画面上框选目标物体。";
      if (!(first/SEGMENT_FPS<=plan.at && plan.at<Math.min(total,last/SEGMENT_FPS))) return "标注帧须位于要修改的区间内。";
      if (objectAction==="replace" && !plan.replacement_ref) return "请选择一张替换参考图。";
    }
    intervals.sort((a,b)=>a.first-b.first);
    if (intervals.some((entry,index)=>index && entry.first<intervals[index-1].last)) return "重拍区间重叠，请调整入出点。";
    return "";
  };
  const readAll=()=>picker?.read() || [read()];
  const update=()=>{
    const ranges=readAll(), error=reason(ranges);
    status.textContent=error || (ranges.length===1?`选中 ${(end.valueAsNumber-start.valueAsNumber).toFixed(2)} 秒`:`${ranges.length} 个重拍区间`);
    submit.disabled=generate.disabled=!!error;
    if (multi) {
      submit.textContent=ranges.length===1?"创建重拍节点":`创建 ${ranges.length} 个重拍节点`;
      picker.render();
    }
  };
  const picker=multi?retakeRangePicker(form,player,()=>total,read,load,update):null;
  const objectControls=objectEditControls(form,player,version,objectAction,target?.data.object_edit,update);
  start.oninput=end.oninput=update;
  player.onloadedmetadata=()=>{
    if (!total && Number.isFinite(player.duration)) {
      total=player.duration;
      if (!end.value) end.value=Math.min(total,5).toFixed(2);
    }
    objectControls?.loaded();
    update();
  };
  player.src=version.url || "";
  $$("[data-vs-point]",form).forEach(button=>button.onclick=()=>{
    if (player.readyState<1) return;
    form.elements[button.dataset.vsPoint].value=player.currentTime.toFixed(2);update();
  });
  $("[data-vs-close]",form).onclick=closeSegmentEditor;
  dialog.oncancel=event=>{event.preventDefault();closeSegmentEditor();};
  form.onsubmit=event=>{
    event.preventDefault();
    const ranges=readAll(), generateNow=multi && event.submitter===generate;
    if (reason(ranges) || !form.reportValidity()) return;
    if (generateNow && queueing) return toast("正在提交其他视频，请稍后再生成");
    const changed=target ? node(target.id)!==target || target.cur!==targetIndex || target.job || prepping.has(target.id) ||
      !B.edges.includes(input.edge) || input.edge.ref!==version.ref : curV(source)?.ref!==version.ref;
    if (board!==boardId || epoch!==boardOpenEpoch || !canvasCanEdit() || node(source.id)!==source || changed) {
      closeSegmentEditor();toast("原视频版本已切换，请重新选择要修改的区间");return;
    }
    const sorted=[...ranges].sort((a,b)=>a.start-b.start);
    checkpoint();
    const made=[];
    let y=source.y;
    for (const [i,range] of sorted.entries()) {
      const begin=range.start, finish=Math.min(total,range.end);
      const settings={prompt:range.prompt,duration:finish-begin,aspect:"auto",provider:provider.value,
        ...(retake?{camera_plan:range.camera_plan}: {}), ...(objectAction?{object_edit:objectControls.read()}: {})};
      if (target) {
        rememberVideoVersion(target);
        Object.assign(input.edge,{start:begin,end:finish});
        Object.assign(target.data,settings);
        made.push(target);
        continue;
      }
      const point=freeSpot(source.x+size(source).w+110,y,"video");
      const label=objectAction?" · "+OBJECT_EDIT_LABELS[objectAction]:retake?` · 重拍${sorted.length>1?" "+(i+1):""}`:" · 片段修改";
      const result=addNode("video",point.x,point.y,{...settings,quality:source.data.quality||"hd"},{name:source.name+label});
      B.edges.push({from:source.id,to:result.id,relation:"video_ref",ref:version.ref,segment_edit:true,start:begin,end:finish});
      y=result.y+size(result).h+50;
      made.push(result);
    }
    made.forEach(render);save();
    $("#prompt")._node=null;
    closeSegmentEditor();
    if (made.length===1) {selectOnly(made[0].id);$("#prompt").focus();}
    else {sel=new Set(made.map(result=>result.id));updateSel();fit([source,...made]);}
    if (generateNow) queueVideos(made);
  };
  update();
  if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open","");
}

function openSegmentTimeline(result) {
  const edited=curV(result), recipe=edited?.video_recipe, clip=recipe?.video_refs?.[0];
  if (!recipe?.segment_edit || !clip) return;
  const source=vtResolve(clip.node_id,clip.ref);
  if (!source) return toast("修改所对应的原片版本已移除");
  try {
    const candidate=segmentCandidate(result,result.cur);
    if (!candidate) throw new Error("无法读取原片与修改结果的剪辑点");
    showSegmentCut(source,[candidate],source.node.versions[source.index].segment_review_original_audio===true);
  } catch (error) { toast(error.message); }
}

const SEGMENT_FPS=24;
const segmentFrame=value=>Math.round(value*SEGMENT_FPS);
const segmentTime=frame=>(frame/SEGMENT_FPS).toFixed(2)+" 秒";

function segmentCandidate(result,index) {
  const version=result.versions[index], recipe=version?.video_recipe, clip=recipe?.video_refs?.[0];
  if (!recipe?.segment_edit || !clip?.ref || !version.ref || !Number.isFinite(clip.start) || !Number.isFinite(clip.end)) return null;
  const start=segmentFrame(clip.start), end=segmentFrame(clip.end);
  if (!(0<=start && start<end)) return null;
  return {node:result,index,version,clip,start,end,short:!Number.isFinite(version.seconds) || segmentFrame(version.seconds)+1<end-start};
}

function collectSegmentVersions(source) {
  const original=source.node.versions[source.index], groups=new Map();
  for (const result of B.nodes) {
    if (result.type!=="video") continue;
    result.versions.forEach((v,index)=>{
      const entry=segmentCandidate(result,index);
      if (!entry || entry.clip.ref!==original.ref) return;
      const linked=vtResolve(entry.clip.node_id,entry.clip.ref);
      if (linked?.node!==source.node) return;
      const key=`${entry.start}:${entry.end}`;
      if (!groups.has(key)) groups.set(key,{start:entry.start,end:entry.end,key,entries:[]});
      groups.get(key).entries.push(entry);
    });
  }
  return [...groups.values()].sort((a,b)=>a.start-b.start || a.end-b.end);
}

function segmentTimelineSpec(source,selected,keepAudio=false) {
  const version=source.node.versions[source.index];
  const ordered=[...selected].sort((a,b)=>a.start-b.start || a.end-b.end);
  const duration=version.seconds || ordered[0]?.clip.source_seconds || collectSegmentVersions(source)[0]?.entries[0].clip.source_seconds;
  const total=segmentFrame(duration);
  if (!(total>0)) throw new Error("无法读取原片时长");
  const spec=newSpec([{...source.node,cur:source.index}]), base=spec.clips[0];
  const piece=(clip,from,to,audioOffset=0)=>({...clip,tight:true,in:from/SEGMENT_FPS,out:to/SEGMENT_FPS,subs:[],
    ...(keepAudio ? {audio_ref:version.ref,audio_start:audioOffset/SEGMENT_FPS,audio_seconds:total/SEGMENT_FPS} : {})});
  const clips=[];
  let end=0;
  for (const entry of ordered) {
    if (entry.start<end) throw new Error("已采用的区间有重叠，请为重叠范围保留一段。");
    if (entry.end>total) throw new Error("有区间超出原片时长");
    if (entry.short) throw new Error("有生成结果短于指定区间，请重新选择版本");
    if (entry.start>end) clips.push(piece(base,end,entry.start));
    clips.push(piece(newFilmClip({...entry.node,cur:entry.index}),0,entry.end-entry.start,entry.start));
    end=entry.end;
  }
  if (end<total) clips.push(piece(base,end,total));
  return {...spec,clips};
}

function showSegmentCut(source,selected,keepAudio=false) {
  const spec=segmentTimelineSpec(source,selected,keepAudio);
  const key=filmDraftPrefix()+"segment:"+JSON.stringify(spec.clips.map(c=>keepAudio?[c.ref,c.in,c.out,c.audio_ref,c.audio_start]:[c.ref,c.in,c.out]));
  showFilm(spec,null,key);
}

function closeSegmentReview() {
  const dialog=$("#segmentReview"), player=$("video",dialog);
  if (!dialog.open) return;
  player.pause();player.removeAttribute("src");
  player.onloadedmetadata=player.ontimeupdate=null;
  if (dialog.close) dialog.close(); else dialog.removeAttribute("open");
}

function openSegmentReview(sourceNode, useParent=false) {
  if (!canvasCanEdit()) return;
  const v=curV(sourceNode);
  const clip=useParent && v?.video_recipe?.segment_edit && v.video_recipe.video_refs?.[0];
  const source=clip ? vtResolve(clip.node_id,clip.ref) : {node:sourceNode,index:sourceNode.cur};
  if (!source?.node.versions[source.index]) return toast("修改所对应的原片版本已移除");
  const board=boardId, original=source.node.versions[source.index], originalId=source.node.id;
  const dialog=$("#segmentReview"), player=$("video",dialog), list=$("[data-sr-list]",dialog), status=$("[data-sr-status]",dialog);
  if (dialog.open) return;
  const rows=collectSegmentVersions(source);
  if (!rows.length) return toast("这个原片版本还没有生成完成的修改片段");
  const reviewState=version=>JSON.stringify([version.segment_review ?? null,version.segment_review_original_audio===true]);
  const initialReview=reviewState(original), keepAudio=$("[data-sr-original-audio]",dialog);
  keepAudio.checked=original.segment_review_original_audio===true;
  const prior=Array.isArray(original.segment_review)?original.segment_review:[];
  const picks=new Map();
  const entryKey=entry=>JSON.stringify([entry.node.id,entry.version.ref,entry.start,entry.end]);
  const options=new Map(rows.flatMap(row=>row.entries.map(entry=>[entryKey(entry),entry])));
  const read=()=>[...picks.values()].filter(Boolean).map(key=>options.get(key));
  let missing=0;
  for (const choice of prior) {
    const row=rows.find(row=>row.start===choice?.start_frame && row.end===choice.end_frame);
    const entry=row?.entries.find(entry=>entry.node.id===choice.node_id&&entry.version.ref===choice.ref) ||
      row?.entries.find(entry=>entry.version.ref===choice.ref);
    if (entry && !entry.short) picks.set(row.key,entryKey(entry));
    else missing++;
  }
  if (clip && !Array.isArray(original.segment_review)) {
    const match=segmentCandidate(sourceNode,sourceNode.cur);
    if (match && !match.short && options.has(entryKey(match))) picks.set(`${match.start}:${match.end}`,entryKey(match));
  }
  $("[data-sr-name]",dialog).textContent=`${source.node.name} · 版本 ${source.index+1}`;
  const hint=$("[data-sr-preview]",dialog);
  hint.textContent="";
  player.hidden=true;
  const preview=(version,start,end,label)=>{
    player.pause();player.hidden=false;hint.textContent=label;
    const startTime=start/SEGMENT_FPS, endTime=end/SEGMENT_FPS;
    player.onloadedmetadata=()=>{player.currentTime=startTime;};
    player.ontimeupdate=()=>{
      if (player.currentTime>=endTime) {player.pause();if (player.currentTime>endTime) player.currentTime=endTime;}
    };
    if (player.getAttribute("src")!==version.url) player.src=version.url || "";
    else if (player.readyState>=1) player.currentTime=startTime;
  };
  const button=(label, action)=>{
    const element=document.createElement("button");element.type="button";element.textContent=label;element.onclick=action;return element;
  };
  const send=$("[data-sr-send]",dialog),saveButton=$("[data-sr-save]",dialog);
  const update=()=>{
    const selected=read();
    try {
      segmentTimelineSpec(source,selected);
      status.textContent=`采用 ${selected.length} 个区间`+(missing?`，${missing} 个已保存结果不可用`:"");
      send.disabled=saveButton.disabled=false;
    } catch (error) {status.textContent=error.message;send.disabled=saveButton.disabled=true;}
  };
  list.replaceChildren(...rows.map(row=>{
    const group=document.createElement("fieldset"); group.className="segment-review-row";
    const title=document.createElement("legend");title.textContent=`${segmentTime(row.start)} – ${segmentTime(row.end)}`;
    const select=document.createElement("select");select.setAttribute("aria-label",`采用 ${title.textContent} 的版本`);
    select.append(new Option("保留原片",""));
    for (const entry of row.entries) {
      const option=new Option(`${entry.node.name} · 版本 ${entry.index+1}${entry.short?"（时长不足）":""}`,entryKey(entry));
      option.disabled=entry.short;select.append(option);
    }
    select.value=picks.get(row.key)||"";
    select.onchange=()=>{picks.set(row.key,select.value);update();};
    group.append(title,select,button("预览原片",()=>preview(original,row.start,row.end,title.textContent+" · 原片")),
      button("预览候选",()=>{
        const candidate=options.get(select.value)||row.entries.find(entry=>!entry.short);
        if (!candidate) return;
        preview(candidate.version,0,candidate.end-candidate.start,candidate.node.name+` · 版本 ${candidate.index+1}`);
      }));
    return group;
  }));
  const commit=editing=>{
    const current=vtResolve(originalId,original.ref);
    const ver=current?.node.versions[current.index];
    if (!canvasCanEdit() || board!==boardId || !ver || reviewState(ver)!==initialReview) {
      status.textContent="画布中的审核决定已变更，请关闭后重新打开。";return;
    }
    const live=collectSegmentVersions(current), valid=new Map(live.flatMap(row=>row.entries.map(entry=>[entryKey(entry),entry])));
    const selected=read().map(entry=>valid.get(entryKey(entry)));
    if (selected.some(entry=>!entry)) {status.textContent="有候选版本已变更，请关闭后重新打开。";return;}
    try { segmentTimelineSpec(current,selected); } catch (error) {status.textContent=error.message;return;}
    const review=selected.sort((a,b)=>a.start-b.start)
      .map(entry=>({node_id:entry.node.id,ref:entry.version.ref,start_frame:entry.start,end_frame:entry.end}));
    const audio=keepAudio.checked;
    if (JSON.stringify([review,audio])!==initialReview) {
      checkpoint();ver.segment_review=review;ver.segment_review_original_audio=audio;save();
    }
    closeSegmentReview();
    if (editing) showSegmentCut(current,selected,audio);
  };
  $("[data-sr-close]",dialog).onclick=closeSegmentReview;
  dialog.oncancel=event=>{event.preventDefault();closeSegmentReview();};
  send.onclick=()=>commit(true);saveButton.onclick=()=>commit(false);
  update();
  if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open","");
}
