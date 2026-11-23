"use strict";

const GROUP_RUN_LABELS={waiting:"待提交",running:"生成中",done:"已完成",error:"失败",skipped:"已跳过"};
let groupRun=null;

const groupRunStorageKey=bid=>`h3.group-run.${ME_USER?.id??""}.${bid}`;

function canvasRunScope({groupId,story}) {
  if(!story)return (B.groups||[]).find(group=>group.id===groupId);
  const script=node(story.scriptId);
  if(script?.type!=="script")return null;
  const links=scriptShotLinks(script);
  const samePair=pair=>pair&&(pair.img||null)===story.imageId&&(pair.vid||null)===story.videoId;
  const index=story.shotId?script.data.shots.findIndex(shot=>shot.id===story.shotId):links.findIndex(samePair);
  if(index<0 || !samePair(links[index]))return null;
  return {name:`${script.name} · 第 ${index+1} 镜`,nodes:[story.imageId,story.videoId].filter(Boolean),script,index,links};
}

function preserveCanvasGroupRun(run) {
  try{
    const key=groupRunStorageKey(run.boardId);
    if(groupRun!==run && (boardId===run.boardId || JSON.parse(sessionStorage.getItem(key)||"null")?.id!==run.id))return;
    const steps=run.steps.map(({id,name,type,count,status,error,outputRef})=>({id,name,type,count,status,error,outputRef}));
    sessionStorage.setItem(key,JSON.stringify({id:run.id,groupId:run.groupId,story:run.story,name:run.name,stop:run.stop,steps}));
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
  const run=groupRun={...receipt,board:B,boardId,active:false,recovered:true};
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
      run.inFlight={nodeId:step.id};
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
    return {name:source?.name||"来源节点已移除",label:[role,state,interval].filter(Boolean).join(" · "),
      thumbnail:!followsRun&&source?.type==="image"?version?.ref:null};
  });
  return refs.concat(inputs(n,"text").map(source=>({name:source.name,label:"文字参考"})));
}

function groupRunAffected(group, changed) {
  const members=new Set(group.nodes), affected=new Set([...changed].filter(id=>members.has(id)));
  for(const id of affected){
    const source=node(id);
    if(source?.type!=="image")continue;
    for(const edge of B.edges){
      if(edge.from!==id || edge.ref || edge.relation || !members.has(edge.to))continue;
      if(vtGenerationReference(edge,source,node(edge.to)))affected.add(edge.to);
    }
  }
  return affected;
}

function groupGenerationNodes(group, includeExisting, affected=null, completed=new Map()) {
  const candidates=[...new Set(group.nodes)].map(node).filter(n=>n &&
    ["image","video","audio"].includes(n.type) && !n.data.previs && !n.data.film &&
    (!affected || affected.has(n.id)) &&
    (includeExisting || !curV(n)));
  const ids=new Set(candidates.map(n=>n.id));
  const steps=candidates.map(n=>{
    const media=groupRunInputs(n);
    const deps=media.filter(({edge,source})=>!edge.ref&&source?.type==="image"&&ids.has(source.id)).map(({source})=>source.id);
    const missing=media.find(({edge,version})=>!deps.includes(edge.from)&&!version?.ref);
    const switched=media.find(({edge,version})=>!edge.ref && completed.has(edge.from) &&
      version?.ref!==completed.get(edge.from).outputRef);
    const configured=n.type==="audio"?n.data.prompt?.trim():usesFields(n)?fieldsFilled(n):fullPrompt(n);
    const hasEditPlan=n.type==="video" && (n.data.camera_plan || n.data.object_edit) && videoInputs(n)[0]?.edge.segment_edit;
    const error=n.job||prepping.has(n.id)?"节点已有任务":missing?`参考素材不可用${missing.source?` · ${missing.source.name}`:""}`:
      switched?`「${switched.source.name}」已切换版本，请切回上轮结果或固定要用的版本`:
      !configured && !hasEditPlan?"尚未填写生成指令":"";
    const count=n.type==="audio"?1:Math.max(1,Math.min(4,Math.trunc(Number(n.data.count))||1));
    return {id:n.id,name:n.name,type:n.type,deps,count,error,status:error?"skipped":"waiting",
      recipe:groupRunRecipe(n,deps,media),references:groupRunReferenceDetails(n,media,deps,completed)};
  });
  const ready=[], available=new Set();
  while(ready.length<steps.length){
    const next=steps.find(step=>!available.has(step.id) && step.deps.every(id=>available.has(id)));
    if(!next)break;
    ready.push(next);available.add(next.id);
  }
  for(const step of steps.filter(step=>!available.has(step.id))) {
    step.status="skipped";
    step.error="图片输入存在循环依赖";
    ready.push(step);
  }
  const byId=new Map(ready.map(step=>[step.id,step]));
  for(const step of ready) {
    if(step.status==="waiting" && step.deps.some(id=>byId.get(id)?.status==="skipped")) {
      step.status="skipped";
      step.error="上游图片节点无法生成";
    }
  }
  return ready;
}

function groupRunRecipe(n, deps, media=groupRunInputs(n)) {
  return JSON.stringify({data:n.data,edges:B.edges.filter(e=>e.to===n.id),
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
    return `<li><strong>${esc(step.name)}</strong><span>${GROUP_RUN_LABELS[step.status]}${step.error?" · "+esc(step.error):" · "+step.count+" 项"}</span>${refs}</li>`;
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

function openScriptShotRun(script,index,{mode="missing"}={}) {
  if(node(script.id)!==script||nodeLocked(script))return;
  const pair=scriptShotLinks(script)[index];
  if(!pair)return toast("请先展开这一镜");
  openCanvasRun({story:{scriptId:script.id,shotId:script.data.shots[index]?.id||null,
    imageId:pair.img||null,videoId:pair.vid||null}},{initialMode:mode});
}

function openCanvasRun(origin, {changed=null,retry=null,plan=null,initialMode=null}={}) {
  const scope=canvasRunScope(origin), {story}=origin;
  if(!canvasCanEdit() || !scope)return;
  if(groupRun?.active){$("#groupRunProgress").hidden=false;return toast("当前有运行计划正在生成");}
  const dialog=$("#groupRunConfirm"), board=B, form=$("form",dialog);
  const mode=$("[name=mode]",form), submit=$("[type=submit]",form), summary=$("[data-summary]",form), list=$("ol",form);
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
    const selection=mode.value==="frame"?new Set([story?.imageId]):
      mode.value==="video"?new Set([story?.videoId]):
      mode.value==="affected"&&changed?groupRunAffected(current,changed):targets;
    const steps=retry?groupGenerationNodes(current,true,groupRunRetryIds(retry,current),completed):
      groupGenerationNodes(current,mode.value!=="missing",selection);
    const tail=story&&scriptContinuityStatus(current.links,current.index,scriptTailEdges());
    return {steps,notice:tail?.warning?tail.text:""};
  };
  let reviewed;
  const preview=()=>{
    const previous=reviewed;
    reviewed=collect();
    const {steps,notice}=reviewed;
    const ready=steps.filter(step=>step.status==="waiting");
    const outputs=ready.reduce((total,step)=>total+step.count,0);
    summary.textContent=ready.length?`将${retry?"重试":"运行"} ${ready.length} 个节点，计划生成 ${outputs} 项。实际用量由所选服务记录。`:"当前没有可运行的节点";
    if(retained.length)summary.textContent+=` 已保留 ${retained.length} 个完成节点。`;
    if(notice)summary.textContent+=` ${notice}。`;
    const expanded=new Set(previous?$$("details[open]",list).map(row=>row.dataset.step):
      steps.length<=2?steps.map(step=>step.id):[]);
    list.innerHTML=groupRunRows(steps,expanded);
    submit.disabled=!ready.length;
  };
  mode.onchange=preview;
  form.onsubmit=event=>{
    event.preventDefault();
    if(groupRun?.active || retry&&groupRun!==retry || B!==board || !canvasCanEdit())return;
    const current=collect();
    if(JSON.stringify(current)!==JSON.stringify(reviewed)){preview();summary.textContent+=" 画布已更新，请再次确认。";return;}
    if(!current.steps.some(step=>step.status==="waiting"))return;
    closeCanvasGroupRunDialog();
    const id=crypto.randomUUID?.() || "group-"+Date.now()+"-"+Math.random().toString(36).slice(2);
    void executeCanvasGroup({id,board,boardId,...origin,name:scope.name,steps:[...retained,...current.steps],active:true,stop:false});
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
  $("[data-dismiss]",panel).hidden=run.active;
  panel.hidden=false;
}

async function executeCanvasGroup(run) {
  groupRun=run;
  preserveCanvasGroupRun(run);
  const byId=new Map(run.steps.map(step=>[step.id,step]));
  const current=()=>B===run.board && canvasCanEdit();
  try{
    for(const step of run.steps) {
      if(step.status!=="waiting")continue;
      const n=current()?node(step.id):null;
      if(run.stop || !current()) {
        run.stop=true;
        step.status="skipped";step.error="已停止提交";
        continue;
      }
      const membership=canvasRunScope(run);
      if(!n || !membership?.nodes.includes(step.id) || n.job || prepping.has(n.id) || groupRunRecipe(n,step.deps)!==step.recipe) {
        step.status="skipped";step.error="节点或输入已修改，或正在生成";
        continue;
      }
      const upstream=step.deps.find(id=>{
        const source=byId.get(id);
        return source?.status!=="done" || source.outputRef!==curV(node(id))?.ref;
      });
      if(upstream) {
        step.status="skipped";step.error=`上游「${byId.get(upstream).name}」的本轮结果不可用`;
        continue;
      }
      step.status="running";
      preserveCanvasGroupRun(run);renderCanvasGroupRun();
      run.inFlight={nodeId:n.id};
      try {
        await generate(n,{batchLayout:"tabs",groupRunId:run.id});
        while(current() && node(n.id)===n && n.job)await sleep(250);
        const result=run.inFlight.result;
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
      preserveCanvasGroupRun(run);
      renderCanvasGroupRun();
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
  if(!run?.active || run.board!==B || job.group_run_id!==run.id || run.inFlight?.nodeId!==n.id)return;
  const result={refs:versions.map(v=>v.ref).filter(Boolean),errors:errors.filter(Boolean)};
  run.inFlight.result=result;
  if(!run.recovered)return;
  groupRunSetResult(run.steps.find(step=>step.id===n.id),result);
  run.active=false;
  preserveCanvasGroupRun(run);renderCanvasGroupRun();
}

function initCanvasGroupRun() {
  document.body.insertAdjacentHTML("beforeend",`<dialog id="groupRunConfirm" aria-labelledby="groupRunTitle"><form>
    <header><strong id="groupRunTitle" data-title></strong><button type="button" data-close aria-label="关闭">×</button></header>
    <label>运行范围 <select name="mode"><option value="missing">补齐未生成节点</option><option value="all">全部生成节点</option><option value="affected" hidden disabled>重跑受影响的节点</option>
      <option value="frame" data-shot-mode hidden disabled>只生成分镜图</option><option value="video" data-shot-mode hidden disabled>只生成视频</option></select></label>
    <p data-summary></p><ol></ol>
    <footer><button type="button" data-close>取消</button><button type="submit">确认运行</button></footer>
    </form></dialog>
    <aside id="groupRunProgress" aria-label="生成进度" hidden>
    <header><strong data-title></strong><button type="button" data-dismiss aria-label="关闭进度">×</button></header>
    <p data-summary role="status"></p><ol></ol><footer><button type="button" data-stop>停止后续节点</button>
    <button type="button" data-retry hidden>重试未完成节点</button></footer></aside>`);
  const dialog=$("#groupRunConfirm"), panel=$("#groupRunProgress");
  $$("[data-close]",dialog).forEach(button=>button.onclick=closeCanvasGroupRunDialog);
  dialog.oncancel=event=>{event.preventDefault();closeCanvasGroupRunDialog();};
  $("[data-stop]",panel).onclick=()=>{if(groupRun?.active){groupRun.stop=true;preserveCanvasGroupRun(groupRun);renderCanvasGroupRun();}};
  $("[data-retry]",panel).onclick=()=>{
    const run=groupRun;
    if(!run||run.active||run.boardId!==boardId)return;
    const scope=canvasRunScope(run);
    if(scope&&groupRunRetryIds(run,scope).size)openCanvasRun({groupId:run.groupId,story:run.story},{retry:run});
  };
  $("[data-dismiss]",panel).onclick=()=>{
    if(groupRun?.active)return;
    try{sessionStorage.removeItem(groupRunStorageKey(boardId));}catch{}
    groupRun=null;panel.hidden=true;
  };
}
