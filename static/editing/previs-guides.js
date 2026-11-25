"use strict";

function pvGuideAvailable(version) {
  if(version?.source!=="previs")return false;
  const span=version.previs_span;
  if(Array.isArray(span))return span[1]-span[0]>=2*PV_FPS;
  return !Number.isFinite(version.seconds) || version.seconds>=2;
}

function previsInput(n) {
  const edge = B.edges.find(e => e.to === n.id && e.relation === "previs");
  if (!edge) return null;
  const source = node(edge.from);
  const index = source?.versions.findIndex(v => v.ref === edge.ref && v.source === "previs") ?? -1;
  return {edge, source, version:source?.versions[index], index};
}

function setPrevisGuide(source,video,version) {
  const guide=previsInput(video);
  if (guide) B.edges = B.edges.filter(e => e !== guide.edge);
  const services = CAPS_LIST.previs || [];
  if (!services.some(s => s.id === video.data.provider)) video.data.provider = services[0]?.id || "";
  B.edges.push({from:source.id, to:video.id, relation:"previs", ref:version.ref});
}

function attachPrevis(source, video) {
  setPrevisGuide(source,video,curV(source));
  save(); refresh(video); selectOnly(video.id);
  $("#prompt").focus();
}

function usePrevisForVideo(source) {
  if (!canvasCanEdit() || !pvGuideAvailable(curV(source))) return;
  const version = curV(source), s = size(source);
  const at = freeSpot(source.x + s.w + 110, source.y, "video");
  const aspect = version.previs_recipe?.aspect || (version.w === version.h ? "1:1" : version.w < version.h ? "9:16" : "16:9");
  checkpoint();
  const video = addNode("video", at.x, at.y, {aspect, duration:Math.min(14, Math.max(4, Math.round(version.seconds || 5)))},
    {name:source.name + " · 正式视频"});
  attachPrevis(source, video);
}

function updatePrevisInput(n) {
  if (!canvasCanEdit() || n.job || prepping.has(n.id)) return;
  const guide = previsInput(n), next = curV(guide?.source);
  if (!guide || !pvGuideAvailable(next) || guide.edge.ref === next.ref) return;
  checkpoint(); rememberVideoVersion(n);
  guide.edge.ref = next.ref;
  save(); refresh(n);
}

function pvStoryboardBoundaries(scene) {
  const end=scene.duration*PV_FPS;
  return [0,...scene.camera.filter(key=>key.ease==="cut" && key.t>0 && key.t<end).map(key=>key.t),end];
}

function pvSpanLabel([start,end]) {
  return `${(start/PV_FPS).toFixed(2)}–${pvTime(end)}`;
}

function pvRefreshShotRanges(E) {
  const boundaries=pvStoryboardBoundaries(E.scene);
  const control=pvElement("[data-pv-shot-range]"), previous=control.value;
  pvElement("[data-pv-shot-render-tools]").hidden=boundaries.length<=2;
  const options=boundaries.slice(0,-1).map((start,i)=>{
    const span=[start,boundaries[i+1]];
    return new Option(`第 ${i+1} 镜 · ${pvSpanLabel(span)}`,JSON.stringify(span));
  });
  control.replaceChildren(...options);
  const at=Math.min(E.tick,boundaries.at(-1)-1);
  const current=boundaries.findIndex((start,i)=>start<=at && at<boundaries[i+1]);
  if(options.some(option=>option.value===previous))control.value=previous;
  else control.selectedIndex=Math.max(0,current);
}

function pvShotGuideTargets(E,version) {
  if(!pvGuideAvailable(version) || !Array.isArray(version.previs_span))return new Map();
  const [start,end]=version.previs_span, matches=new Map();
  for(const script of B.nodes){
    if(script.type!=="script" || script.data.previs_source!==E.n.id)continue;
    const pairs=scriptShotLinks(script);
    script.data.shots?.forEach((shot,i)=>{
      const input=shot.previs_range, video=node(pairs[i]?.vid);
      if(input?.[0]!==start || input?.[1]!==end || video?.type!=="video" ||
         video.data.previs || video.data.film || video.job || prepping.has(video.id))return;
      matches.set(video.id,`${script.name} · 第 ${i+1} 镜`);
    });
  }
  return matches;
}

function pvRefreshShotGuide(E,version) {
  const targets=pvShotGuideTargets(E,version), choice=pvElement("[data-pv-guide-target]"), previous=choice.value;
  pvElement("[data-pv-shot-guide]").hidden=targets.size===0;
  choice.replaceChildren(...[...targets].map(([id,label])=>new Option(label,id)));
  if(targets.has(previous))choice.value=previous;
}

function pvAttachShotGuide(E) {
  const version=curV(E.n), id=pvElement("[data-pv-guide-target]").value;
  if(!pvShotGuideTargets(E,version).has(id))return pvStatus("对应镜头已移除或正在生成，请重新核对");
  if(!closePrevis())return;
  const video=node(id);
  checkpoint();rememberVideoVersion(video);
  attachPrevis(E.n,video);
  toast(`已为「${video.name}」绑定 ${pvSpanLabel(version.previs_span)} 的白模动作`);
}

function pvGuideScripts(E) {
  return B.nodes.filter(n=>n.type==="script" && n.data.previs_source===E.n.id && n.data.shots?.length);
}

function pvGuideBatchPlan(E,script) {
  if(!pvGuideScripts(E).includes(script))return [];
  const boundaries=pvStoryboardBoundaries(E.scene);
  const allowed=new Set(boundaries.slice(0,-1).map((start,i)=>JSON.stringify([start,boundaries[i+1]])));
  const scene=JSON.stringify(E.scene), links=scriptShotLinks(script);
  return script.data.shots.map((shot,i)=>{
    const span=shot.previs_range, video=node(links[i]?.vid);
    let skip="";
    if(!allowed.has(JSON.stringify(span)))skip="切点已变化或缺少白模区间";
    else if(span[1]-span[0]<2*PV_FPS)skip="少于 2 秒";
    else if(video?.type!=="video" || video.data.previs || video.data.film)skip="缺少对应分镜视频";
    else if(video.job || prepping.has(video.id))skip="分镜视频正在生成";
    else if(previsInput(video))skip="已有动作参考";
    const existing=!skip && E.n.versions.findLast(version=>pvGuideAvailable(version) &&
      JSON.stringify(version.previs_span)===JSON.stringify(span) && JSON.stringify(version.previs_recipe)===scene);
    return {index:i,span,video:video?.id,name:video?.name,skip,ref:existing?.ref};
  });
}

function pvDrawGuideBatch(rows) {
  const list=pvElement("[data-pv-batch-rows]");
  list.replaceChildren(...rows.map(row=>{
    const item=document.createElement("li");
    const label=Array.isArray(row.span)?` · ${pvSpanLabel(row.span)}`:"";
    item.textContent=`第 ${row.index+1} 镜${label}${row.name?" · "+row.name:""} · ${row.state || (row.skip?`跳过（${row.skip}）`:row.ref?"复用当前场景的已渲染动作":"渲染并绑定")}`;
    return item;
  }));
}

function pvPreviewGuideBatch(E) {
  const panel=pvElement("[data-pv-batch-panel]"), choice=pvElement("[data-pv-batch-script]"), previous=choice.value;
  choice.replaceChildren(...pvGuideScripts(E).map(script=>new Option(script.name,script.id)));
  if([...choice.options].some(option=>option.value===previous))choice.value=previous;
  const script=node(choice.value), rows=pvGuideBatchPlan(E,script);
  E.guideReview={script:script?.id,scene:JSON.stringify(E.scene),rows};
  panel.hidden=false;
  pvDrawGuideBatch(rows);
  pvElement("[data-pv-batch-confirm]").disabled=!rows.some(row=>!row.skip);
}

async function pvRunGuideBatch(E) {
  if(!pvValidNode(E) || E.n.job || E.guideBatch || !E.guideReview)return;
  const {script:scriptId,scene,rows:planned}=E.guideReview;
  const review=pvGuideBatchPlan(E,node(scriptId));
  if(scene!==JSON.stringify(E.scene) || JSON.stringify(review)!==JSON.stringify(planned)){
    pvPreviewGuideBatch(E);pvStatus("分镜或白模已变化，请核对后再次确认。");return;
  }
  pvPause(E);
  if(!review.some(row=>!row.skip) || !pvCommit(E))return;
  const batch=E.guideBatch={stopping:false}, rows=review.map(row=>({...row})), staged=[];
  const current=()=>PV.editor===E && pvValidNode(E) && JSON.stringify(E.n.data.previs)===scene &&
    JSON.stringify(E.scene)===scene;
  const target=row=>{
    const linked=pvGuideBatchPlan(E,node(scriptId))[row.index];
    return linked && !linked.skip && linked.video===row.video &&
      JSON.stringify(linked.span)===JSON.stringify(row.span) ? node(linked.video) : null;
  };
  let bound=0;
  pvUpdateRenderState(E.n);
  try {
    for(const row of rows){
      if(!current() || batch.stopping)break;
      if(row.skip)continue;
      if(!target(row)){row.state="分镜已变化，已跳过";continue;}
      let version=E.n.versions.find(v=>v.ref===row.ref);
      if(!version){
        const before=new Set(E.n.versions.map(v=>v.ref));
        row.state="渲染中";
        pvDrawGuideBatch(rows);
        const job=await pvRender(E,row.span);
        if(!job){row.state="未确认渲染已提交";break;}
        const id=job.ids[0];
        while(current() && E.n.job?.ids?.includes(id))await sleep(200);
        if(!current())break;
        version=E.n.versions.findLast(v=>!before.has(v.ref) && JSON.stringify(v.previs_span)===JSON.stringify(row.span) &&
          pvGuideAvailable(v) && JSON.stringify(v.previs_recipe)===scene);
      }
      if(!version){row.state="渲染未完成，可重试";continue;}
      row.state="待绑定";
      staged.push({row,version});
      pvDrawGuideBatch(rows);
    }
    if(current())for(const {row,version} of staged){
      const video=target(row);
      if(!video || !E.n.versions.some(item=>item.ref===version.ref)){row.state="分镜或白模版本已变化，已跳过";continue;}
      if(!bound)checkpoint();
      rememberVideoVersion(video);
      setPrevisGuide(E.n,video,version);
      render(video);
      row.state="已绑定";
      bound++;
    }
    if(bound){drawEdges();showPanel();save();}
    for(const row of rows)if(!row.skip && (!row.state || row.state==="待绑定" || row.state==="渲染中"))row.state="等待重新核对";
  } finally {
    E.guideBatch=null;
    E.guideReview=null;
    if(PV.editor===E){
      if(!pvValidNode(E))closePrevis(true);
      else {
        pvUpdateRenderState(E.n);
        pvDrawGuideBatch(rows);
        pvElement("[data-pv-batch-confirm]").disabled=true;
        pvStatus(`已绑定 ${bound} 镜。${batch.stopping?"已停止后续渲染。":"可核对各镜头的处理结果。"}`);
      }
    }
  }
}
