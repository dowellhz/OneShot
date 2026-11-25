"use strict";

function groupRunInputs(n) {
  if(n.type==="video")return [...imageInputs(n),...audioInputs(n),...videoInputs(n),previsInput(n)].filter(Boolean);
  if(n.type==="image")return imageInputs(n);
  return isSeedAudio(n)?seedAudioRefs(n).map(({node_id,ref})=>{
    const source=node(node_id);
    return {edge:{from:node_id,ref},source,version:source?.versions.find(v=>v.ref===ref)};
  }):[];
}

function groupRunReferenceDetails(n, media, deps, completed) {
  const imagePlan=n.type==="video"?plan(n):null;
  const imageRoles=new Map(imagePlan?.inputs.map(({edge},i)=>[edge,imagePlan.labels[i]])||[]);
  const types={video_ref:"视频参考",audio_ref:"音频参考",previs:"白模动作",seed_audio_ref:"生成参考"};
  const seconds=value=>Number(value.toFixed(2));
  const refs=media.map(({edge,source,version})=>{
    const followsRun=deps.includes(edge.from)&&!edge.ref;
    const index=version?(source?.versions.indexOf(version)??-1)+1:0;
    const retained=!edge.ref&&version?.ref&&completed.get(edge.from)?.outputRef===version.ref;
    const state=followsRun?"本轮生成":index?`版本 ${index}（${edge.ref?"固定":retained?"上轮结果":"当前"}）`:"版本不可用";
    const role=edge.story_continuity?"上一镜尾帧":imageRoles.get(edge)||types[edge.relation]||(n.type==="audio"?"生成参考":"图片参考");
    const range=edge.relation==="video_ref"&&version?videoReferenceRange(edge,version,referenceDuration(n)):null;
    const interval=Number.isFinite(range?.end)?`${seconds(range.start??0)}–${seconds(range.end)} 秒`:
      Number.isFinite(range?.start)?`${seconds(range.start)} 秒起`:"";
    const draft=!followsRun && version?.source==="previs-frame" ? "白模草稿" : "";
    return {name:source?.name||"来源节点已移除",label:[role,state,draft,interval].filter(Boolean).join(" · "),
      whiteboxFirst:!!draft && imageRoles.get(edge)==="首帧",
      thumbnail:!followsRun&&source?.type==="image"?version?.ref:null};
  });
  return refs.concat(inputs(n,"text").map(source=>({name:source.name,label:"文字参考"})));
}

function groupRunAssetRequest(n) {
  if(n.type==="audio")return null;
  const text=value=>typeof value==="string"?value.replace(/@(?:图|视频|音频|音)(?:\{\d{1,16}\}|\d+)/g,""):value;
  const request={id:n.id,kind:n.type,prompt:text(fullPrompt(n))};
  if(usesFields(n))request.fields=Object.fromEntries(Object.entries(n.data.fields||{}).map(([key,value])=>[key,text(value)]));
  if(n.type==="video")applyVideoMemory(n,request);
  return request.memory_ids?.length||request.replay_memory_ref||
    [request.prompt,...Object.values(request.fields||{})].some(value=>typeof value==="string"&&value.includes("@"))?request:null;
}

async function groupRunReviewAssets(board, entries) {
  const reviewed = new Map();
  for(let start=0;start<entries.length;start+=50){
    const batch=entries.slice(start,start+50);
    try{
      const results=await api("/api/memory/review-generation",{board,entries:batch});
      for(const result of results)reviewed.set(result.id,result);
    }catch(error){
      for(const entry of batch)reviewed.set(entry.id,{error:error.message||"无法核对参考资产"});
    }
  }
  return reviewed;
}

function groupRunReviewedSteps(steps, reviews) {
  if(!reviews?.size)return steps;
  const byId=new Map(), checked=[];
  for(const step of steps){
    const review=reviews.get(step.id), upstream=step.deps.some(id=>byId.get(id)?.status==="skipped");
    let result=step;
    if(step.status==="waiting" && (review?.error||upstream)){
      result={...step,status:"skipped",error:review?.error||"上游节点无法生成"};
    }else if(review){
      const assets=review.assets.map(asset=>{
        const views=(asset.references||[]).map(ref=>CHARACTER_VIEWS[ref.view]?.[0]).filter(Boolean);
        return {name:asset.name,label:["资产库",cmKind(asset),...views].join(" · "),
          thumbnail:asset.ref&&cmMediaType(asset.ref)==="image"?asset.ref:null};
      });
      result={...step,references:[...step.references,...assets],assetReviewKey:review.key};
    }
    byId.set(step.id,result);checked.push(result);
  }
  return checked;
}

function groupRunAffected(group, changed) {
  const members=new Set(group.nodes), affected=new Set([...changed].filter(id=>members.has(id)));
  for(const id of affected){
    const source=node(id);
    if(!["image","text"].includes(source?.type))continue;
    for(const edge of B.edges){
      if(edge.from!==id || !members.has(edge.to))continue;
      const target=node(edge.to);
      if(source.type==="text" ? target&&inputs(target,"text").includes(source) : !edge.ref&&!edge.relation&&vtGenerationReference(edge,source,target))affected.add(edge.to);
    }
  }
  return affected;
}

const groupGeneratable=n=>!!n&&["image","video","audio"].includes(n.type)&&!n.data.previs&&!n.data.film&&!draftFinalEdge(n);
function groupGenerationNodes(group, includeExisting, affected=null, completed=new Map(), tails=new Map()) {
  const candidates=[...new Set(group.nodes)].map(node).filter(n=>groupGeneratable(n) &&
    (!affected || affected.has(n.id)) &&
    (includeExisting || (n.type==="image" && (group.previsTiming || n.data.storyboard_stale_refs) ? !storyboardFrameReady(n) : !curV(n))));
  const ids=new Set(candidates.map(n=>n.id));
  const steps=candidates.map(n=>{
    const media=groupRunInputs(n);
    const deps=media.filter(({edge,source})=>!edge.ref&&source&&ids.has(source.id)&&
      (group.selection||source.type==="image")).map(({source})=>source.id);
    const continuity=tails.get(n.id), previous=node(continuity?.sourceId);
    const followsRun=!!previous&&ids.has(previous.id);
    const expectedRef=followsRun?null:curV(previous)?.ref;
    const tail=continuity&&{sourceId:previous?.id,expectedRef,connect:continuity.connect};
    const tailError=!continuity?"":nodeLocked(n)?"请先解锁分镜图":
      n.data.model==="h3video"?"分镜图模型不支持参考图片":
      !expectedRef&&!followsRun?"上一镜没有可用视频":
      vtReferenceAncestors(previous).has(n.id)?"上一镜已依赖本镜分镜图":
      completed.has(previous.id)&&completed.get(previous.id).outputRef!==expectedRef?"上一镜已切换版本，请切回上轮结果":"";
    if(followsRun&&!tailError)deps.push(previous.id);
    const usableMedia=continuity?media.filter(({edge})=>edge!==continuity.edge):media;
    const missing=usableMedia.find(({edge,version})=>!deps.includes(edge.from)&&!version?.ref);
    const switched=media.find(({edge,version})=>!edge.ref && completed.has(edge.from) &&
      version?.ref!==completed.get(edge.from).outputRef);
    const configured=n.type==="audio"?n.data.prompt?.trim():usesFields(n)?fieldsFilled(n):fullPrompt(n);
    const hasEditPlan=n.type==="video" && (n.data.camera_plan || n.data.object_edit) && videoInputs(n)[0]?.edge.segment_edit;
    const composition=previsComposition(n);
    const compositionSlots=media.map(({version})=>version?.ref);
    if(continuity?.connect)compositionSlots.push(null);
    const compositionError=!composition?.enabled?"":!composition.version?"白模构图版本已移除":
      n.data.model==="h3video"?"分镜图模型不支持参考图片":
      !previsCompositionHasRoom(n,composition,compositionSlots)?"参考图过多，请为白模构图留出一个位置":"";
    const error=n.job||prepping.has(n.id)?"节点已有任务":tailError||compositionError|| (missing?`参考素材不可用${missing.source?` · ${missing.source.name}`:""}`:
      switched?`「${switched.source.name}」已切换版本，请切回上轮结果或固定要用的版本`:
      !configured && !hasEditPlan?"尚未填写生成指令":"");
    const count=canvasGenerationCount(n);
    const references=groupRunReferenceDetails(n,usableMedia,deps,completed);
    if(composition?.enabled)references.push({name:"白模构图",label:composition.version?"固定参考":"版本已移除",
      thumbnail:composition.version?.ref});
    const previsSeconds=group.previsTiming?.get(n.id);
    const timing=Number.isFinite(previsSeconds) && Number.isFinite(n.data.duration)
      ? `白模 ${Number(previsSeconds.toFixed(2))} 秒 · 视频设定 ${n.data.duration} 秒` : "";
    if(tail)references.unshift({name:previous?.name||"上一镜",label:(continuity.edge?"上一镜尾帧":"连接上一镜尾帧")+" · "+
      (tailError|| (followsRun?"取本轮生成视频":`取当前版本 ${previous.cur+1}`))});
    return {id:n.id,name:n.name,type:n.type,deps,count,error,tail,status:error?"skipped":"waiting",
      recipe:groupRunRecipe(n,deps,media),references,timing,whiteboxFirst:references.some(ref=>ref.whiteboxFirst)};
  });
  const ready=[], available=new Set();
  while(ready.length<steps.length){
    const next=steps.find(step=>!available.has(step.id) && step.deps.every(id=>available.has(id)));
    if(!next)break;
    ready.push(next);available.add(next.id);
  }
  for(const step of steps.filter(step=>!available.has(step.id))) {
    step.status="skipped";
    step.error="生成节点存在循环依赖";
    ready.push(step);
  }
  const byId=new Map(ready.map(step=>[step.id,step]));
  for(const step of ready) {
    if(step.status==="waiting" && step.deps.some(id=>byId.get(id)?.status==="skipped")) {
      step.status="skipped";
      step.error="上游节点无法生成";
    }
  }
  return ready;
}

function groupRunRecipe(n, deps, media=groupRunInputs(n)) {
  return JSON.stringify({data:n.data,edges:B.edges.filter(e=>e.to===n.id),
    composition:previsComposition(n)?.version?.ref,
    media:media.map(({edge,source,version})=>[edge.from,deps.includes(edge.from)&&!edge.ref?null:version?.ref,
      source?.name,source?.data.caption,source?.data.asset?.id]),
    text:inputs(n,"text").map(t=>t.data.text)});
}
