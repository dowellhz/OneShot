"use strict";

document.getElementById("mediaToolDialogs").insertAdjacentHTML("beforebegin", OneShotI18n.html`
<dialog id="videoSegment" aria-labelledby="videoSegmentTitle">
  <form>
    <header><strong id="videoSegmentTitle">修改视频片段</strong><button type="button" data-vs-close aria-label="关闭">×</button></header>
    <p data-vs-title></p>
    <div class="video-segment-surface">
      <video controls playsinline preload="metadata"></video>
      <div class="video-object-overlay" data-object-overlay hidden><div data-object-box hidden></div></div>
    </div>
    <section data-retake-ranges hidden aria-label="重拍区间">
      <div class="retake-strip" data-retake-strip aria-label="原片区间分布" role="img"></div>
      <div class="retake-range-buttons" data-retake-tabs role="group" aria-label="选择重拍区间"></div>
      <div class="retake-range-buttons">
        <button type="button" data-retake-add>添加区间</button>
        <button type="button" data-retake-split>在播放头拆分区间</button>
        <button type="button" data-retake-remove>移除当前区间</button>
        <button type="button" data-retake-preview>预览当前区间</button>
      </div>
    </section>
    <label>入点 <input name="start" type="number" min="0" step="any" required> 秒 <button type="button" data-vs-point="start">设为播放位置</button></label>
    <label>出点 <input name="end" type="number" min="0" step="any" required> 秒 <button type="button" data-vs-point="end">设为播放位置</button></label>
    <label>服务 <select name="provider" aria-label="片段编辑服务"></select></label>
    <fieldset data-vs-object hidden>
      <legend>目标物体</legend>
      <button type="button" data-object-mark>在当前帧框选</button>
      <button type="button" data-object-locate hidden>定位标注帧</button>
      <span data-object-status aria-live="polite"></span>
      <div data-object-reference hidden>
        <label>替换参考图 <select data-object-ref aria-label="选择替换参考图"></select></label>
        <div class="object-reference-actions">
          <button type="button" data-object-upload>上传本地图片</button>
          <input type="file" data-object-file accept=".png,.jpg,.jpeg,.webp" hidden>
          <img data-object-preview alt="当前所选替换参考图" hidden>
          <span data-object-ref-status role="status"></span>
        </div>
      </div>
    </fieldset>
    <fieldset data-vs-camera hidden>
      <legend>镜头方案</legend>
      <label>镜头方式 <select name="cameraMode">
        <option value="fixed">固定机位</option><option value="cut">切换机位</option><option value="move">连续运镜</option>
      </select></label>
      <div class="retake-views">
        <fieldset data-vs-view="start"><legend>机位</legend></fieldset>
        <fieldset data-vs-view="end" hidden><legend>结束机位</legend></fieldset>
      </div>
      <p data-vs-camera-hint></p>
    </fieldset>
    <p data-vs-status role="status"></p>
    <textarea name="prompt" rows="3" maxlength="3000" aria-label="片段修改描述" placeholder="例如把窗外改成雨天，保留人物和镜头节奏"></textarea>
    <footer><button type="submit">创建修改节点</button><button type="submit" data-retake-generate hidden>创建并生成</button></footer>
  </form>
</dialog>
`);

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
    $("[data-vs-view=start] legend",panel).textContent=mode.value==="fixed"?OneShotI18n.t("机位"):"起始机位";
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
  prompt.placeholder=objectAction?"选填，例如说明要保留的遮挡、影子或物体运动":retake?"选填，例如保留人物回头的动作，在换机位后突出表情":OneShotI18n.t("例如把窗外改成雨天，保留人物和镜头节奏");
  provider.value=services.some(service=>service.id===target?.data.provider)?target.data.provider:provider.options[0].value;
  $("#videoSegmentTitle").textContent=objectAction?OBJECT_EDIT_LABELS[objectAction]:retake?"镜头重拍":OneShotI18n.t("修改视频片段");
  submit.textContent=target?(objectAction?"保存物体编辑设置":"保存重拍设置"):retake?"创建重拍节点":OneShotI18n.t("创建修改节点");
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
