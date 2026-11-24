"use strict";

function closeVideoTrim() {
  const dialog=$("#videoTrim"), video=$("video",dialog);
  if (!dialog.open) return;
  video.pause();
  video.removeAttribute("src");
  video.onloadedmetadata=video.ontimeupdate=null;
  if (dialog.close) dialog.close(); else dialog.removeAttribute("open");
}

function openVideoTrim(source) {
  const version=curV(source), dialog=$("#videoTrim");
  if (!canvasCanEdit() || !version || dialog.open) return;
  const bid=boardId, form=$("form",dialog), video=$("video",form);
  const start=form.elements.start, end=form.elements.end, submit=$("button[type=submit]",form);
  const status=$("[data-trim-status]",form), cutsHost=$("[data-trim-cuts]",form);
  const detect=$("[data-trim-detect]",form), split=$("[data-trim-split]",form), preview=$("[data-trim-preview]",form);
  const playheadButtons=$$("[data-trim-point]",form);
  const frame=time=>Math.round(time*SEGMENT_FPS);
  const seconds=tick=>(tick/SEGMENT_FPS).toFixed(2);
  const range=()=>[frame(start.valueAsNumber),frame(end.valueAsNumber)];
  let total=frame(Number(version.seconds)||0), cuts=[], busy=false, previewEnd=null;
  start.value="0"; end.value=total?seconds(total):"";
  $("[data-trim-source]",form).textContent=source.name+" · 版本 "+(source.cur+1);
  const active=()=>dialog.open && boardId===bid && form.onsubmit===create;
  const update=(message="")=>{
    const [first,last]=range();
    const valid=0<=first && first<last && last<=total;
    cuts=valid?cuts.filter(cut=>first<cut && cut<last):[];
    start.disabled=end.disabled=busy;
    submit.disabled=preview.disabled=split.disabled=detect.disabled=busy || !valid;
    for (const button of playheadButtons) button.disabled=busy;
    split.disabled ||= cuts.length>=11;
    detect.disabled ||= last-first<2;
    cutsHost.replaceChildren(...cuts.map(cut=>{
      const button=document.createElement("button");
      button.type="button";button.textContent=seconds(cut)+" 秒 ×";
      button.setAttribute("aria-label","移除 "+seconds(cut)+" 秒切点");
      button.disabled=busy;
      button.onclick=()=>{cuts=cuts.filter(point=>point!==cut);update();};
      return button;
    }));
    submit.textContent=cuts.length?"生成 "+(cuts.length+1)+" 段视频":OneShotI18n.t("生成裁剪视频");
    status.textContent=message || (valid?seconds(last-first)+" 秒 · "+(cuts.length+1)+" 段":
      total?"请选择至少一帧且在原片范围内的区间。":"正在读取视频时长…");
  };
  const scrub=()=>{
    previewEnd=null;
    update();
  };
  start.oninput=end.oninput=scrub;
  video.onloadedmetadata=()=>{
    if (!total && Number.isFinite(video.duration)) {
      total=frame(video.duration);end.value=seconds(total);update();
    }
  };
  video.ontimeupdate=()=>{
    if (previewEnd!==null && video.currentTime>=previewEnd) {
      video.pause();video.currentTime=previewEnd;previewEnd=null;
    }
  };
  video.src=version.url || "";
  for (const button of playheadButtons) button.onclick=()=>{
    if (video.readyState<1) return;
    form.elements[button.dataset.trimPoint].value=seconds(frame(video.currentTime));
    scrub();
  };
  preview.onclick=()=>{
    if (video.readyState<1) return update("视频正在载入，请稍后预览。");
    const [first,last]=range();
    previewEnd=last/SEGMENT_FPS;
    video.currentTime=first/SEGMENT_FPS;
    video.play()?.catch(()=>update("无法播放预览。"));
  };
  split.onclick=()=>{
    const [first,last]=range(), cut=frame(video.currentTime);
    if (video.readyState<1 || cut<=first || cut>=last) return update("请把播放头移到选中区间内部。");
    if (cuts.includes(cut)) return update("这一帧已有切点。");
    cuts.push(cut);cuts.sort((a,b)=>a-b);update();
  };
  detect.onclick=async()=>{
    busy=true;update("正在识别明显的镜头切换…");
    try {
      const result=await api("/api/video/trim",{ref:version.ref,action:"detect",points:range()});
      if (!active()) return;
      cuts=result.cuts;
      busy=false;
      update(cuts.length?"已找到 "+cuts.length+" 个切点，可点选移除。":"未发现明显的镜头切换。可手动添加切点。");
    } catch (error) {
      if (active()) {busy=false;update(error.message);}
    }
  };
  async function create(event) {
    event.preventDefault();
    if (submit.disabled) return;
    const [first,last]=range();
    busy=true;update("正在生成裁剪视频…");
    try {
      const result=await api("/api/video/trim",{ref:version.ref,action:"render",points:[first,...cuts,last]});
      if (!active() || !canvasCanEdit()) return;
      const original=vtResolve(source.id,version.ref);
      if (!original) {busy=false;return update("原片版本已移除。");}
      const input=original.node, clips=result.clips;
      checkpoint();
      const ids=[];
      let y=input.y;
      for (const [index,clip] of clips.entries()) {
        const at=freeSpot(input.x+size(input).w+110,y,"video");
        const name=input.name+(clips.length>1?" · 片段 "+(index+1):" · 裁剪");
        const output=addNode("video",at.x,at.y,{duration:clip.seconds},{name});
        const edge={from:input.id,to:output.id,relation:"trim",source_ref:version.ref,start:clip.start,end:clip.end};
        const recipe={clips:[{node:input.id,ref:version.ref,in:clip.start,out:clip.end,trans:"cut"}]};
        output.versions.push({ref:clip.ref,url:clip.url,w:clip.w,h:clip.h,seconds:clip.seconds,source:"trim",
          mode:"视频裁剪",prompt:"",input_edges:[edge],film_recipe:recipe});
        output.cur=0; B.edges.push({...edge});render(output);
        y=output.y+size(output).h+50;ids.push(output.id);
      }
      closeVideoTrim();
      sel=new Set(ids);updateSel();save();fit([input,...ids.map(node)]);loadAssets();
      toast("已生成 "+ids.length+" 段裁剪视频");
    } catch(error) {
      if (active()) {busy=false;update(error.message);}
    }
  }
  form.onsubmit=create;
  $("[data-trim-close]",form).onclick=closeVideoTrim;
  dialog.oncancel=event=>{event.preventDefault();closeVideoTrim();};
  update();
  if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open","");
}
