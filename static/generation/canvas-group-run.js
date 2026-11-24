"use strict";

const GROUP_RUN_LABELS={waiting:"待提交",running:"生成中",done:"已完成",error:"失败",skipped:"已跳过"};
let groupRun=null;

const groupRunStorageKey=bid=>`h3.group-run.${ME_USER?.id??""}.${bid}`;

function canvasRunScope({groupId,story,template,selection}) {
  if(Array.isArray(selection)){
    const nodes=selection.filter(id=>node(id));
    return nodes.length?{name:"选中节点",nodes,selection:true}:null;
  }
  if(template&&Array.isArray(template.nodes)){
    const nodes=template.nodes.filter(id=>node(id));
    return nodes.length?{name:template.name,nodes}:null;
  }
  if(!story)return (B.groups||[]).find(group=>group.id===groupId);
  const script=node(story.scriptId);
  if(script?.type!=="script")return null;
  const links=scriptShotLinks(script);
  const targets=story.shots||[story];
  const indices=targets.map(target=>{
    const matches=pair=>pair&&(pair.img||null)===target.imageId&&(pair.vid||null)===target.videoId;
    const index=target.shotId?script.data.shots.findIndex(shot=>shot.id===target.shotId):links.findIndex(matches);
    return matches(links[index])?index:-1;
  });
  if(!indices.length || indices.some((index,i)=>index<0 || i>0&&index!==indices[i-1]+1))return null;
  const first=indices[0]+1, last=indices.at(-1)+1;
  const name=`${script.name} · 第 ${first}${first===last?"":"–"+last} 镜`;
  const previsTiming=new Map(indices.flatMap(index=>{
    const ticks=script.data.shots[index]?.previs_range;
    const video=links[index]?.vid;
    return video && Array.isArray(ticks) && ticks.length===2 && ticks.every(Number.isInteger) && ticks[1]>ticks[0]
      ? [[video,(ticks[1]-ticks[0])/PV_FPS]] : [];
  }));
  const images=[...new Set(indices.flatMap(index=>shotFrameIds(links[index])))];
  const videos=targets.map(target=>target.videoId).filter(Boolean);
  const nodes=[...new Set(indices.flatMap(index=>[...shotFrameIds(links[index]),links[index].vid]).filter(Boolean))];
  return {name,nodes,images,videos,indices,links,previsTiming};
}

function preserveCanvasGroupRun(run) {
  try{
    const key=groupRunStorageKey(run.boardId);
    if(groupRun!==run && (boardId===run.boardId || JSON.parse(sessionStorage.getItem(key)||"null")?.id!==run.id))return;
    const steps=run.steps.map(({id,name,type,count,status,error,outputRef})=>({id,name,type,count,status,error,outputRef}));
    sessionStorage.setItem(key,JSON.stringify({id:run.id,groupId:run.groupId,story:run.story,template:run.template,selection:run.selection,
      name:run.name,stop:run.stop,refreshTails:run.refreshTails,connectTails:run.connectTails,filmReturn:run.filmReturn,steps}));
  }catch{}
}

function restoreCanvasGroupRun() {
  groupRun=null;
  let receipt;
  try{receipt=JSON.parse(sessionStorage.getItem(groupRunStorageKey(boardId))||"null");}catch{}
  if(!receipt || !canvasCanEdit() || !Array.isArray(receipt.steps) || !canvasRunScope(receipt)){
    renderCanvasGroupRun();
    return;
  }
  const run=groupRun={...receipt,board:B,boardId,active:false,recovered:true,inFlight:new Map()};
  for(const step of run.steps){
    if(step.status!=="waiting" && step.status!=="running")continue;
    run.stop=true;
    if(step.status==="waiting"){
      step.status="skipped";
      step.error="已中断，等待确认后续节点";
      continue;
    }
    const n=node(step.id);
    const refs=(n?.versions||[]).filter(version=>version.group_run_id===run.id).map(version=>version.ref).filter(Boolean);
    if(refs.length)groupRunSetResult(step,{refs,errors:[]});
    else if(n?.job?.group_run_id===run.id){
      run.active=true;
      run.inFlight.set(step.id,{});
    }else {
      step.status="skipped";
      step.error="提交状态未记录，请检查节点后再重试";
    }
  }
  preserveCanvasGroupRun(run);
  renderCanvasGroupRun();
}

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

function groupRunRows(steps, expanded=null) {
  return steps.map(step=>{
    const refs=expanded&&step.references?.length?`<details class="group-run-refs" data-step="${esc(step.id)}"${expanded.has(step.id)?" open":""}>
      <summary>参考素材 ${step.references.length} 项</summary>
      ${step.references.map(({name,label,thumbnail})=>`<div>${thumbnail?`<img src="/media?ref=${encodeURIComponent(thumbnail)}" alt="" loading="lazy">`:""}
        <span>${esc(name)}<small>${esc(label)}</small></span></div>`).join("")}</details>`:"";
    return `<li><strong>${esc(step.name)}</strong><span>${GROUP_RUN_LABELS[step.status]}${step.error?" · "+esc(step.error):" · "+step.count+" 项"}${step.timing?" · "+esc(step.timing):""}${step.whiteboxFirst?" · 首帧仍为白模":""}</span>${refs}</li>`;
  }).join("");
}

function groupRunRetryIds(run, group) {
  const members=new Set(group.nodes);
  return new Set(run.steps.filter(step=>["error","skipped"].includes(step.status)&&members.has(step.id)&&node(step.id)).map(step=>step.id));
}

function openCanvasGroupRun(group, {changed=null,retry=null,plan=null}={}) {
  if(!(B.groups||[]).includes(group))return;
  openCanvasRun({groupId:group.id},{changed,retry,plan});
}

function openCanvasSelectionRun(nodes){
  if(!nodes.some(groupGeneratable))return;
  openCanvasRun({selection:nodes.map(n=>n.id)},{initialMode:"all"});
}

function openScriptShotRun(script,index,{mode="missing",requiredSeconds=null,filmReturn=null}={}) {
  if(node(script.id)!==script||nodeLocked(script))return;
  const pair=scriptShotLinks(script)[index];
  if(!pair)return toast("请先展开这一镜");
  openCanvasRun({story:{scriptId:script.id,shotId:script.data.shots[index]?.id||null,
    imageId:pair.img||null,videoId:pair.vid||null}},{initialMode:mode,requiredSeconds,filmReturn});
}

function openScriptShotRangeRun(script, first, last, mode="missing", tailMode="keep") {
  if(node(script.id)!==script || nodeLocked(script))return;
  const links=scriptShotLinks(script), shots=script.data.shots;
  const range=links.slice(first,last+1).map((pair,i)=>pair&&{
    shotId:shots[first+i]?.id||null,imageId:pair.img||null,videoId:pair.vid||null});
  if(!range.length || range.some(pair=>!pair))return toast("请先展开所选镜头");
  openCanvasRun({story:{scriptId:script.id,shots:range}},{initialMode:mode,initialTailMode:tailMode});
}

function openTemplateRun(name,nodes,changes) {
  const template={name,nodes}, scope=canvasRunScope({template});
  if(!scope)return;
  const affected=groupRunAffected(scope,changes);
  const hasChanges=affected.size && groupGenerationNodes(scope,true,affected).length;
  openCanvasRun({template},{changed:hasChanges?changes:null});
}

function openCanvasRun(origin, {changed=null,retry=null,plan=null,initialMode=null,initialTailMode="keep",requiredSeconds=null,filmReturn=null}={}) {
  const scope=canvasRunScope(origin), {story}=origin;
  if(!canvasCanEdit() || !scope)return;
  if(groupRun?.active){$("#groupRunProgress").hidden=false;return toast("当前有运行计划正在生成");}
  const dialog=$("#groupRunConfirm"), board=B, form=$("form",dialog);
  const mode=$("[name=mode]",form), submit=$("[type=submit]",form), summary=$("[data-summary]",form), list=$("ol",form);
  const adjustLength=$("[data-set-retake-length]",form);
  const refresh=$("[name=refresh-tails]",form);
  const connect=$("[name=connect-tails]",form);
  refresh.checked=retry?!!retry.refreshTails:["refresh","connect_and_refresh"].includes(initialTailMode);
  connect.checked=retry?!!retry.connectTails:["connect","connect_and_refresh"].includes(initialTailMode);
  $("[data-title]",form).textContent=(retry?"重试":"运行")+"「"+scope.name+"」";
  mode.closest("label").hidden=!!(retry||plan);
  const affectedOption=$('option[value="affected"]',mode);
  affectedOption.hidden=affectedOption.disabled=!changed;
  for(const option of $$("[data-shot-mode]",mode))option.hidden=option.disabled=!story;
  mode.value=plan?.mode || initialMode || (changed?"affected":"missing");
  const targets=plan?new Set(plan.targets):null;
  const retained=retry?.steps.filter(step=>step.status==="done")||[];
  const completed=new Map(retained.map(step=>[step.id,step]));
  const collect=()=>{
    const current=canvasRunScope(origin);
    if(!current)return {steps:[],notice:"镜头或分组已变化，请重新打开运行计划"};
    const selection=["frame","missing_frame"].includes(mode.value)?new Set(current.images):
      ["video","missing_video"].includes(mode.value)?new Set(current.videos):
      mode.value==="affected"&&changed?groupRunAffected(current,changed):targets;
    const affected=retry?groupRunRetryIds(retry,current):selection;
    const includeExisting=!!retry||!mode.value.startsWith("missing");
    const edges=story?scriptTailEdges():new Map();
    const tails=new Map();
    const pinned=new Set();
    let canRefresh=false, canConnect=false;
    for(const index of current.indices||[]){
      const img=current.links[index]?.img, picture=node(img), edge=edges.get(img);
      if(index===0||current.links[index].shared_first||picture?.type!=="image"||(affected&&!affected.has(img))||(!includeExisting&&storyboardFrameReady(picture)))continue;
      if(edge){
        pinned.add(img);
        canRefresh=true;
      }else canConnect=true;
      if(edge?refresh.checked:connect.checked)tails.set(img,{edge,sourceId:current.links[index-1]?.vid,connect:!edge});
    }
    const steps=groupGenerationNodes(current,includeExisting,affected,completed,tails);
    let warnings=[];
    if(story){
      const planned=new Set(steps.filter(step=>step.status==="waiting").map(step=>step.id));
      warnings=current.indices.flatMap(index=>{
        const img=current.links[index]?.img;
        if(tails.has(img))return [];
        if(pinned.has(img)&&planned.has(img)&&planned.has(current.links[index-1]?.vid)){
          return [`第 ${index+1} 镜会沿用已固定的尾帧，上一镜生成的新版本不会用于本镜`];
        }
        const tail=scriptContinuityStatus(current.links,index,edges);
        return tail?.warning?[current.indices.length>1?`第 ${index+1} 镜：${tail.text}`:tail.text]:[];
      });
    }
    const video=requiredSeconds>0 && mode.value==="video" ? node(story?.videoId) : null;
    const choices=video && (!hasMediaReferences(video) || referenceService(video)) ? canvasVideoDurationChoices(video) : [];
    const configured=video?.data.duration;
    const suggestion=choices.find(seconds=>seconds+1e-6>=requiredSeconds);
    const timing=video ? {configured,max:choices.at(-1),suggestion} : null;
    return {steps,canRefresh,canConnect,refreshTails:canRefresh&&refresh.checked,connectTails:canConnect&&connect.checked,timing,
      notice:warnings.slice(0,3).join("；")+(warnings.length>3?`，另有 ${warnings.length-3} 镜待核对`:"")};
  };
  let reviewed, assetReviews, rendered=false;
  const renderPreview=()=>{
    const {notice,timing}=reviewed;
    const steps=groupRunReviewedSteps(reviewed.steps,assetReviews);
    const pending=assetReviews===null;
    refresh.closest("label").hidden=!reviewed.canRefresh;
    connect.closest("label").hidden=!reviewed.canConnect;
    const ready=steps.filter(step=>step.status==="waiting");
    const outputs=ready.reduce((total,step)=>total+step.count,0);
    summary.textContent=ready.length?`将${retry?"重试":"运行"} ${ready.length} 个节点，计划生成 ${outputs} 项。`:"当前没有可运行的节点";
    if(pending)summary.textContent+=" 正在核对参考资产。";
    const cost = $("[data-group-cost]",dialog);
    cost.hidden=pending||!ready.length;
    if (!pending&&ready.length) {
      cost.textContent="正在估算费用…";
      const snapshot=reviewed;
      void canvasGenerationCosts(ready.map(step=>canvasCostRequest(node(step.id)))).then(amounts=>{
        if (B!==board || reviewed!==snapshot || !dialog.open) return;
        const known=amounts.filter(Number.isFinite);
        const total=known.reduce((sum,amount)=>sum+amount,0);
        cost.textContent=known.length===ready.length?displayGenerationCost(total):
          known.length?`${displayGenerationCost(total)}（已知部分），另有 ${ready.length-known.length} 个节点无法估算`:
          displayGenerationCost(null);
      });
    }
    const newConnections=ready.filter(step=>step.tail?.connect).length;
    if(newConnections)summary.textContent+=` 将为 ${newConnections} 张分镜图连接上一镜尾帧。`;
    if(retained.length)summary.textContent+=` 已保留 ${retained.length} 个完成节点。`;
    if(notice)summary.textContent+=` ${notice}。`;
    adjustLength.hidden=true;
    if (timing) {
      const {configured,max,suggestion}=timing;
      summary.textContent+=` 按剪辑的当前入点和速度，这一镜至少需要 ${requiredSeconds.toFixed(2)} 秒素材。`;
      if (max && !suggestion) summary.textContent+=` 当前可选档位最长 ${max} 秒，低于所需长度。`;
      if (Number.isFinite(configured) && configured+1e-6<requiredSeconds) {
        summary.textContent+=` 当前生成时长设为 ${configured} 秒。`;
        if (suggestion && ready.some(step=>step.id===story.videoId)) {
          adjustLength.hidden=false;
          adjustLength.textContent=`将视频节点设为 ${suggestion} 秒`;
        }
      }
    }
    const priorRows=rendered?$$("details",list):[];
    const expanded=new Set(priorRows.filter(row=>row.open).map(row=>row.dataset.step));
    if(steps.length<=2)for(const step of steps){
      if(!priorRows.some(row=>row.dataset.step===step.id))expanded.add(step.id);
    }
    list.innerHTML=groupRunRows(steps,expanded);
    rendered=true;
    submit.disabled=pending||!ready.length;
  };
  const preview=()=>{
    reviewed=collect();
    const entries=reviewed.steps.filter(step=>step.status==="waiting").map(step=>groupRunAssetRequest(node(step.id))).filter(Boolean);
    assetReviews=entries.length?null:new Map();
    renderPreview();
    if(!entries.length)return;
    const snapshot=reviewed;
    void groupRunReviewAssets(boardId,entries).then(results=>{
      if(B!==board||!dialog.open||reviewed!==snapshot)return;
      for(const entry of entries)if(!results.has(entry.id))results.set(entry.id,{error:"无法核对参考资产"});
      assetReviews=results;renderPreview();
    });
  };
  mode.onchange=refresh.onchange=connect.onchange=preview;
  adjustLength.onclick=()=>{
    if (adjustLength.hidden || B!==board || !canvasCanEdit() || groupRun?.active) return;
    const current=collect();
    if (JSON.stringify(current)!==JSON.stringify(reviewed)) {
      preview();summary.textContent+=" 画布已更新，请再次核对时长。";return;
    }
    const video=node(story.videoId), duration=current.timing.suggestion;
    checkpoint();
    video.data.duration=duration;
    save();render(video);refreshDownstream(video);
    if (sel.has(video.id)) showPanel();
    preview();
  };
  form.onsubmit=event=>{
    event.preventDefault();
    if(groupRun?.active || retry&&groupRun!==retry || B!==board || !canvasCanEdit())return;
    const current=collect();
    if(JSON.stringify(current)!==JSON.stringify(reviewed)){preview();summary.textContent+=" 画布已更新，请再次确认。";return;}
    if(assetReviews===null)return;
    const steps=groupRunReviewedSteps(current.steps,assetReviews);
    if(!steps.some(step=>step.status==="waiting"))return;
    closeCanvasGroupRunDialog();
    const id=crypto.randomUUID?.() || "group-"+Date.now()+"-"+Math.random().toString(36).slice(2);
    void executeCanvasGroup({id,board,boardId,...origin,name:scope.name,steps:[...retained,...steps],
      refreshTails:current.refreshTails,connectTails:current.connectTails,filmReturn:filmReturn || retry?.filmReturn,active:true,stop:false});
  };
  preview();
  if(!dialog.open){if(dialog.showModal)dialog.showModal();else dialog.setAttribute("open","");}
}

function closeCanvasGroupRunDialog() {
  const dialog=$("#groupRunConfirm");
  if(dialog?.open){if(dialog.close)dialog.close();else dialog.removeAttribute("open");}
}

function renderCanvasGroupRun() {
  const panel=$("#groupRunProgress");
  if(!groupRun || groupRun.boardId!==boardId){panel.hidden=true;return;}
  const run=groupRun, done=run.steps.filter(step=>step.status==="done").length;
  const issue=run.steps.filter(step=>["error","skipped"].includes(step.status)).length;
  const scope=canvasRunScope(run);
  $("[data-title]",panel).textContent=run.name;
  $("[data-summary]",panel).textContent=run.active
    ? (run.stop?"已停止提交后续节点，已提交的任务继续运行":`正在运行 · 已完成 ${done} / ${run.steps.length}`)
    : `${run.stop?"已停止":"执行结束"} · ${done} 个完成${issue?`，${issue} 个失败或跳过`:""}`;
  $("ol",panel).innerHTML=groupRunRows(run.steps);
  $("[data-stop]",panel).hidden=!run.active || run.stop;
  $("[data-retry]",panel).hidden=run.active || !issue || !canvasCanEdit() || !scope || !groupRunRetryIds(run,scope).size;
  $("[data-film-return]",panel).hidden=run.active || !run.filmReturn;
  $("[data-dismiss]",panel).hidden=run.active;
  panel.hidden=false;
}

async function executeCanvasGroupStep(run,step,byId,current) {
  const n=current()?node(step.id):null;
  if(run.stop || !current()) {
    run.stop=true;
    step.status="skipped";step.error="已停止提交";
    return;
  }
  const membership=canvasRunScope(run);
  if(!n || !membership?.nodes.includes(step.id) || n.job || prepping.has(n.id) || groupRunRecipe(n,step.deps)!==step.recipe) {
    step.status="skipped";step.error="节点或输入已修改，或正在生成";
    return;
  }
  const upstream=step.deps.find(id=>{
    const source=byId.get(id);
    return source?.status!=="done" || source.outputRef!==curV(node(id))?.ref;
  });
  if(upstream) {
    step.status="skipped";step.error=`上游「${byId.get(upstream).name}」的本轮结果不可用`;
    return;
  }
  step.status="running";
  preserveCanvasGroupRun(run);renderCanvasGroupRun();
  const receipt={};
  run.inFlight.set(n.id,receipt);
  try {
    if(step.tail){
      const {sourceId,expectedRef,connect}=step.tail;
      const expected=expectedRef||byId.get(sourceId)?.outputRef;
      const findIndex=scope=>scope?.indices.find(index=>{
        return scope.links[index]?.img===n.id&&scope.links[index-1]?.vid===sourceId;
      });
      const index=findIndex(membership);
      const active=()=>!run.stop&&current()&&findIndex(canvasRunScope(run))===index&&
        curV(node(sourceId))?.ref===expected&&groupRunRecipe(n,step.deps)===step.recipe;
      if(index===undefined||!expected||!active())throw new Error("上一镜或视频版本已变化，请重新确认尾帧");
      if(!await linkPreviousShotFrame(node(run.story.scriptId),index,{batch:true,allowNew:connect,active})){
        throw new Error("未能连接上一镜尾帧，已跳过本镜生成");
      }
      if(run.stop||!current())throw new Error("已停止提交");
    }
    await generate(n,{batchLayout:"tabs",groupRunId:run.id,assetReviewKey:step.assetReviewKey});
    while(current() && node(n.id)===n && n.job)await sleep(250);
    const result=receipt.result;
    if(!current() && result){
      run.stop=true;
      groupRunSetResult(step,result);
    } else if(!current()){
      run.stop=true;
      step.error="已离开画布，等待已有任务";
    } else if(node(n.id)===n && result) {
      groupRunSetResult(step,result);
    } else {
      step.status="error";
      step.error=result?.errors.join("、") || els.get(n.id)?.querySelector(".errbox")?.textContent || "未生成可用结果";
    }
  } catch(error) {step.status="error";step.error=error.message;}
}

async function executeCanvasGroup(run) {
  groupRun=run;
  run.inFlight=new Map();
  preserveCanvasGroupRun(run);
  const byId=new Map(run.steps.map(step=>[step.id,step]));
  const current=()=>B===run.board && canvasCanEdit();
  const concurrency=run.selection?3:1;
  const submitted=new Map();
  try{
    while(true){
      const halted=run.stop||!current();
      const ready=run.steps.filter(step=>step.status==="waiting"&&(halted||step.deps.every(id=>
        !["waiting","running"].includes(byId.get(id)?.status))));
      for(const step of ready.slice(0,concurrency-submitted.size)){
        const task=executeCanvasGroupStep(run,step,byId,current).finally(()=>{
          submitted.delete(step.id);
          run.inFlight.delete(step.id);
          preserveCanvasGroupRun(run);renderCanvasGroupRun();
        });
        submitted.set(step.id,task);
      }
      if(!submitted.size)break;
      await Promise.race(submitted.values());
    }
  } finally {run.active=false;preserveCanvasGroupRun(run);renderCanvasGroupRun();}
}

function groupRunSetResult(step, {refs,errors}) {
  if(refs.length){
    step.status="done";
    step.count=refs.length;
    step.outputRef=refs.at(-1);
    step.error=errors.length?"部分结果失败 · "+errors.join("、"):"";
  }else {
    step.status="error";
    step.error=errors.join("、")||"未生成可用结果";
  }
}

function groupRunJobFinished(n, job, versions, errors) {
  const run=groupRun;
  const receipt=run?.inFlight?.get(n.id);
  if(!run?.active || run.board!==B || job.group_run_id!==run.id || !receipt)return;
  const result={refs:versions.map(v=>v.ref).filter(Boolean),errors:errors.filter(Boolean)};
  receipt.result=result;
  if(!run.recovered)return;
  groupRunSetResult(run.steps.find(step=>step.id===n.id),result);
  run.inFlight.delete(n.id);
  run.active=run.inFlight.size>0;
  preserveCanvasGroupRun(run);renderCanvasGroupRun();
}

function initCanvasGroupRun() {
  document.body.insertAdjacentHTML("beforeend",`<dialog id="groupRunConfirm" aria-labelledby="groupRunTitle"><form>
    <header><strong id="groupRunTitle" data-title></strong><button type="button" data-close aria-label="关闭">×</button></header>
    <label>运行范围 <select name="mode"><option value="missing">补齐未生成节点</option><option value="all">全部生成节点</option><option value="affected" hidden disabled>重跑受影响的节点</option>
      <option value="missing_frame" data-shot-mode hidden disabled>只补齐分镜图</option><option value="missing_video" data-shot-mode hidden disabled>只补齐视频</option>
      <option value="frame" data-shot-mode hidden disabled>重生成分镜图</option><option value="video" data-shot-mode hidden disabled>重生成视频</option></select></label>
    <label hidden><input type="checkbox" name="refresh-tails">生成分镜图前刷新已有的上一镜尾帧</label>
    <label hidden><input type="checkbox" name="connect-tails">为未连接的分镜图连接上一镜尾帧</label>
    <p data-summary></p><p data-group-cost role="status" title="实际费用以服务账单为准" hidden></p><ol></ol>
    <footer><button type="button" data-close>取消</button><button type="button" data-set-retake-length hidden></button><button type="submit">确认运行</button></footer>
    </form></dialog>
    <aside id="groupRunProgress" aria-label="生成进度" hidden>
    <header><strong data-title></strong><button type="button" data-dismiss aria-label="关闭进度">×</button></header>
    <p data-summary role="status"></p><ol></ol><footer><button type="button" data-stop>停止后续节点</button>
    <button type="button" data-retry hidden>重试未完成节点</button><button type="button" data-film-return hidden>返回剪辑核对</button></footer></aside>`);
  const dialog=$("#groupRunConfirm"), panel=$("#groupRunProgress");
  $$("[data-close]",dialog).forEach(button=>button.onclick=closeCanvasGroupRunDialog);
  dialog.oncancel=event=>{event.preventDefault();closeCanvasGroupRunDialog();};
  $("[data-stop]",panel).onclick=()=>{if(groupRun?.active){groupRun.stop=true;preserveCanvasGroupRun(groupRun);renderCanvasGroupRun();}};
  $("[data-retry]",panel).onclick=()=>{
    const run=groupRun;
    if(!run||run.active||run.boardId!==boardId)return;
    const scope=canvasRunScope(run);
    if(scope&&groupRunRetryIds(run,scope).size)openCanvasRun({groupId:run.groupId,story:run.story,
      template:run.template,selection:run.selection},{retry:run});
  };
  $("[data-film-return]",panel).onclick=()=>{
    const run=groupRun;
    if (!run?.filmReturn || run.active || run.boardId!==boardId) return;
    const step=run.steps.find(item=>item.id===run.filmReturn.nodeId && item.status==="done");
    if (returnFilmTimingRetake(run.filmReturn,step?.outputRef)) panel.hidden=true;
  };
  $("[data-dismiss]",panel).onclick=()=>{
    if(groupRun?.active)return;
    try{sessionStorage.removeItem(groupRunStorageKey(boardId));}catch{}
    groupRun=null;panel.hidden=true;
  };
}
