"use strict";

const OBJECT_EDIT_LABELS={remove:"移除物体",replace:"替换物体"};

function openObjectSettings(target) {
  const input=videoInputs(target)[0];
  if (!input?.edge.segment_edit || !input.version) return toast("要编辑的原片版本已移除");
  openSegmentEditor(input.source,{objectAction:target.data.object_edit.action,target,input});
}

function objectReferencePicker(panel, existing, update) {
  const ref=$("[data-object-ref]",panel), upload=$("[data-object-upload]",panel), file=$("[data-object-file]",panel);
  const image=$("[data-object-preview]",panel), status=$("[data-object-ref-status]",panel);
  const groups=new Map();
  let uploading=false;
  ref.replaceChildren(new Option("请选择参考图",""));
  const add=(group,name,value)=>{
    if (!value || [...ref.options].some(option=>option.value===value)) return;
    if (!groups.has(group)) {
      const entries=document.createElement("optgroup");entries.label=group;
      ref.append(entries);groups.set(group,entries);
    }
    groups.get(group).append(new Option(name,value));
  };
  for (const node of B.nodes.filter(n=>n.type==="image" && curV(n)?.ref)) {
    add("画布",node.name+" · 版本 "+(node.cur+1),curV(node).ref);
  }
  add("已保存",existing?.replacement_name || "已选的参考图版本",existing?.replacement_ref);
  ref.value=existing?.replacement_ref || "";
  const show=()=>{
    image.hidden=!ref.value;
    if (ref.value) image.src=remakeMedia(ref.value); else image.removeAttribute("src");
  };
  const select=()=>{show();update();};
  const active=()=>panel.closest("dialog").open && !panel.hidden && !panel.closest("fieldset").hidden && ref.onchange===select;
  show();
  ref.onchange=select;
  ref.disabled=upload.disabled=false;
  file.value="";
  status.textContent="";
  upload.onclick=()=>file.click();
  file.onchange=async()=>{
    const selected=file.files[0];
    file.value="";
    if (!selected || uploading) return;
    if (!/\.(png|jpe?g|webp)$/i.test(selected.name)) {
      status.textContent="请选择 PNG、JPG 或 WEBP 图片";return;
    }
    uploading=ref.disabled=upload.disabled=true;
    status.textContent="正在上传…";
    update();
    const body=new FormData();
    body.append("image",selected,selected.name);
    try {
      const response=await fetchOk("/api/upload",{method:"POST",body});
      const result=await response.json();
      if (!active()) return;
      add("本地上传",selected.name,result.ref);
      ref.value=result.ref;
      status.textContent="";
    } catch (error) {
      if (active()) status.textContent="上传失败："+error.message;
    } finally {
      uploading=false;
      if (active()) {ref.disabled=upload.disabled=false;select();}
    }
  };
  api("/api/library?board="+encodeURIComponent(boardId),null,"GET").then(assets=>{
    if (!active() || !Array.isArray(assets)) return;
    for (const asset of assets) {
      if (/\.(png|jpe?g|webp)$/i.test(asset.ref || "")) add("资产库",asset.name,asset.ref);
    }
  }).catch(()=>{
    if (active() && !status.textContent) status.textContent="资产库暂时无法读取";
  });
  return {
    read:()=>({replacement_ref:ref.value,replacement_name:ref.selectedOptions[0]?.text.slice(0,120)}),
    busy:()=>uploading,
  };
}

function objectEditControls(form, player, version, action, existing, update) {
  const panel=$("[data-vs-object]",form), overlay=$("[data-object-overlay]",form);
  const boxEl=$("[data-object-box]",overlay), mark=$("[data-object-mark]",form);
  const status=$("[data-object-status]",form), locate=$("[data-object-locate]",form);
  panel.hidden=overlay.hidden=!action;
  overlay.classList.remove("marking");boxEl.hidden=true;
  if (!action) return null;

  let at=existing?.at, box=existing?.box, anchor=null, marking=false;
  const reference=$("[data-object-reference]",panel);
  reference.hidden=action!=="replace";
  const picker=reference.hidden?null:objectReferencePicker(reference,existing,update);
  const imageRect=()=>{
    const rect=player.getBoundingClientRect(), w=player.videoWidth||version.w, h=player.videoHeight||version.h;
    if (!(rect.width && rect.height && w && h)) return null;
    const scale=Math.min(rect.width/w,rect.height/h);
    const width=w*scale,height=h*scale;
    return {left:(rect.width-width)/2,top:(rect.height-height)/2,width,height,x:rect.left,y:rect.top};
  };
  const point=event=>{
    const rect=imageRect();
    if (!rect) return null;
    const clamp=n=>Math.max(0,Math.min(1,n));
    return [clamp((event.clientX-rect.x-rect.left)/rect.width),clamp((event.clientY-rect.y-rect.top)/rect.height)];
  };
  const paint=()=>{
    const rect=imageRect();
    boxEl.hidden=!box || !rect || (!anchor && Math.abs(player.currentTime-at)>.025);
    if (boxEl.hidden) return;
    Object.assign(boxEl.style,{left:rect.left+rect.width*box[0]+"px",top:rect.top+rect.height*box[1]+"px",
      width:rect.width*(box[2]-box[0])+"px",height:rect.height*(box[3]-box[1])+"px"});
  };
  const setMarking=value=>{
    marking=value;overlay.classList.toggle("marking",value);
    mark.textContent=value?"取消框选":OneShotI18n.t("在当前帧框选");
    status.textContent=value?"拖动鼠标框住目标":box?("已标注 "+at.toFixed(2)+" 秒"):"拖到目标清晰的一帧后框选";
    locate.hidden=value || !box;
  };
  locate.onclick=()=>{
    if (!Number.isFinite(at) || player.readyState<1) return;
    player.pause();player.currentTime=at;paint();
  };
  mark.onclick=()=>{
    if (player.readyState<1 || !imageRect()) return toast("视频正在加载，请稍后框选");
    player.pause();
    setMarking(!marking);
  };
  overlay.onpointerdown=event=>{
    if (!marking || event.button!==0) return;
    anchor=point(event);
    if (!anchor) return;
    overlay.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };
  overlay.onpointermove=event=>{
    if (!anchor) return;
    const end=point(event);
    if (!end) return;
    box=[Math.min(anchor[0],end[0]),Math.min(anchor[1],end[1]),Math.max(anchor[0],end[0]),Math.max(anchor[1],end[1])];
    paint();
  };
  overlay.onpointerup=event=>{
    if (!anchor) return;
    overlay.onpointermove(event);
    anchor=null;
    if (box && box[2]-box[0]>=.005 && box[3]-box[1]>=.005) at=Number(player.currentTime.toFixed(5));
    else {box=null;at=null;}
    setMarking(false);paint();update();
  };
  overlay.onpointercancel=()=>{
    anchor=null;box=null;at=null;setMarking(false);paint();update();
  };
  player.ontimeupdate=paint;
  player.onseeked=paint;
  setMarking(false);
  return {
    read:()=>box ? {action,at,box,...picker?.read()} : null,
    busy:()=>picker?.busy(),
    loaded:()=>{
      if (Number.isFinite(at)) player.currentTime=at;
      paint();
    },
  };
}
