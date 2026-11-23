"use strict";

const extensionLabel=direction=>direction==="before"?"补拍片头":"续拍片尾";

function videoReferenceRange(edge, version, limit) {
  const seconds=Number.isFinite(version?.seconds)&&version.seconds>0?version.seconds:undefined;
  const direction=edge.extension;
  const start=direction==="before"?0:Number.isFinite(edge.start)?edge.start:direction==="after"?
    (seconds==null?undefined:Math.max(0,Math.round((seconds-4)*100)/100)):0;
  const end=direction==="after"?seconds:Number.isFinite(edge.end)?edge.end:
    (seconds==null?undefined:Math.min(seconds,start+(direction==="before"?4:limit)));
  return {start,end};
}

function openVideoExtension(source) {
  const version=curV(source);
  if (!canvasCanEdit() || !version) return toast("请先选择可播放的视频");
  const board=boardId;
  const services=(CAPS_LIST.previs || []).filter(()=>version.source!=="previs" && !(version.seconds>0 && version.seconds<2));
  const dialog=$("#videoExtension"), form=$("form",dialog), mode=$("[name=method]",form);
  if (dialog.open) return;
  mode.replaceChildren(...services.map(service=>new Option("连续画面 · "+service.name,service.id)),
    new Option("以接点画面为参考","frame"));
  mode.selectedIndex=0;
  form.elements.direction.value="after";
  form.elements.prompt.value="";
  form.elements.duration.value=5;
  $("[data-ve-source]",form).textContent=`${source.name} · 版本 ${source.cur+1}`;
  const refresh=()=>{
    const service=services.find(s=>s.id===mode.value);
    const max=service?.model?.includes("2-5")?30:service?15:14;
    form.elements.duration.max=max;
    form.elements.duration.min=service?4:2;
    form.elements.duration.value=Math.max(Number(form.elements.duration.min),Math.min(max,form.elements.duration.valueAsNumber||5));
    const before=form.elements.direction.value==="before";
    $("[data-ve-help]",form).textContent=service?
      `默认使用原视频${before?"开头":"末尾"}最多 4 秒的连续画面，创建后可调整参考区间。`:
      before?"用原视频第一帧作为新片段的尾帧。":"用原视频最后一帧作为新片段的首帧。";
    form.elements.prompt.placeholder=before?"描述原视频开始之前发生的事":"描述原视频结束之后发生的事";
  };
  mode.onchange=form.elements.direction.onchange=refresh;
  $("[data-ve-close]",form).onclick=()=>closeVideoExtension(dialog);
  form.onsubmit=event=>{
    event.preventDefault();
    if (board!==boardId || node(source.id)!==source || curV(source)?.ref!==version.ref) {
      closeVideoExtension(dialog);toast("原视频版本已切换，请重新打开续拍");return;
    }
    const direction=form.elements.direction.value, duration=form.elements.duration.valueAsNumber;
    const prompt=form.elements.prompt.value.trim();
    closeVideoExtension(dialog);
    if (mode.value==="frame") {
      continueFrom(source,{direction,duration,prompt});return;
    }
    const provider=mode.value;
    const at=freeSpot(direction==="before"?source.x-580:source.x+size(source).w+110,source.y,"video");
    checkpoint();
    const result=addNode("video",at.x,at.y,{prompt,provider,duration,aspect:"auto",quality:source.data.quality || "hd"},
      {name:`${source.name} · ${extensionLabel(direction)}`});
    if (link(source,result,true)) {
      const edge=B.edges.find(e=>e.from===source.id && e.to===result.id);
      edge.extension=direction;
      drawEdges();save();
    }
    selectOnly(result.id);$("#prompt").focus();
  };
  refresh();
  if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open","");
}

function closeVideoExtension(dialog=$("#videoExtension")) {
  if (!dialog?.open) return;
  if (dialog.close) dialog.close(); else dialog.removeAttribute("open");
}

function extensionInput(version) {
  const recipe=version?.video_recipe;
  if(!recipe)return null;
  if(recipe.extension && recipe.video_refs?.[0]){
    const {node_id,ref}=recipe.video_refs[0];
    return {node_id,ref,direction:recipe.extension};
  }
  if(recipe.video_refs?.length || recipe.previs_guide)return null;
  const images=(recipe.images||[]).filter(im=>im.role!=="subject");
  const end=Number.isFinite(recipe.duration)?(vidFrames(recipe.duration)-4)/24:Infinity;
  const inputs=images.flatMap((image,i)=>{
    const capture=node(image.node_id)?.versions.find(v=>v.ref===image.ref)?.capture;
    if(!capture?.source_node || !capture.source_ref)return [];
    const first=recipe.planned?image.time<=.01:i===0;
    const last=recipe.planned?image.time>=end-.05:i>0&&i===images.length-1;
    if(!(capture.position==="first"&&last || capture.position==="last"&&first))return [];
    return [{node_id:capture.source_node,ref:capture.source_ref,direction:capture.position==="first"?"before":"after"}];
  });
  return inputs.length===1?inputs[0]:null;
}

function openExtensionTimeline(result,version=curV(result)) {
  if(!version?.ref || !result.versions.includes(version))return toast("续拍结果版本已移除");
  const input=extensionInput(version);
  if(!input)return toast("找不到唯一的续拍接点");
  const source=vtResolve(input.node_id,input.ref);
  if(!source || source.node.type!=="video")return toast("续拍对应的原视频版本已移除");
  const original = {...source.node,cur:source.index};
  const continuation={...result,cur:result.versions.indexOf(version)};
  const spec = newSpec(input.direction==="before"?[continuation,original]:[original,continuation]);
  const key=filmDraftPrefix()+"extension:"+JSON.stringify(spec.clips.map(item=>[item.node,item.ref]));
  showFilm(spec,null,key);
}
