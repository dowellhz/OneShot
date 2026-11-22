"use strict";

const GROUP_RUN_LABELS={waiting:"待提交",running:"生成中",done:"已完成",error:"失败",skipped:"已跳过"};
let groupRun=null;

function groupGenerationNodes(group, includeExisting) {
  const candidates=[...new Set(group.nodes)].map(node).filter(n=>n &&
    ["image","video","audio"].includes(n.type) && !n.data.previs && !n.data.film &&
    (includeExisting || !curV(n)));
  const ids=new Set(candidates.map(n=>n.id));
  const steps=candidates.map(n=>{
    const inputs=imageInputs(n), deps=inputs.filter(({edge,source})=>!edge.ref&&ids.has(source.id)).map(({source})=>source.id);
    const missing=inputs.find(({edge,source,version})=>(edge.ref||!ids.has(source.id))&&!version?.ref);
    const configured=n.type==="audio"?n.data.prompt?.trim():usesFields(n)?fieldsFilled(n):fullPrompt(n);
    const hasEditPlan=n.type==="video" && (n.data.camera_plan || n.data.object_edit) && videoInputs(n)[0]?.edge.segment_edit;
    const error=n.job||prepping.has(n.id)?"节点已有任务":missing?`缺少「${missing.source.name}」的参考图片`:
      !configured && !hasEditPlan?"尚未填写生成指令":"";
    const count=n.type==="audio"?1:Math.max(1,Math.min(4,Math.trunc(Number(n.data.count))||1));
    return {id:n.id,name:n.name,type:n.type,deps,count,error,status:error?"skipped":"waiting",
      recipe:groupRunRecipe(n)};
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

function groupRunRecipe(n) {
  return JSON.stringify({data:n.data,edges:B.edges.filter(e=>e.to===n.id),
    text:inputs(n,"text").map(t=>t.data.text)});
}

function groupRunRows(steps) {
  return steps.map(step=>`<li><strong>${esc(step.name)}</strong><span>${GROUP_RUN_LABELS[step.status]}${step.error?" · "+esc(step.error):" · "+step.count+" 项"}</span></li>`).join("");
}

function openCanvasGroupRun(group) {
  if(!canvasCanEdit() || !(B.groups || []).includes(group))return;
  if(groupRun?.active){$("#groupRunProgress").hidden=false;return toast("当前有分组正在生成");}
  const dialog=$("#groupRunConfirm"), board=B, form=$("form",dialog);
  const mode=$("[name=mode]",form), submit=$("[type=submit]",form), summary=$("[data-summary]",form);
  $("[data-title]",form).textContent="运行「"+group.name+"」";
  mode.value="missing";
  let steps;
  const preview=()=>{
    steps=groupGenerationNodes(group,mode.value==="all");
    const ready=steps.filter(step=>step.status==="waiting");
    const outputs=ready.reduce((total,step)=>total+step.count,0);
    summary.textContent=ready.length?`将运行 ${ready.length} 个节点，计划生成 ${outputs} 项。实际用量由所选服务记录。`:"当前没有可运行的节点";
    $("ol",form).innerHTML=groupRunRows(steps);
    submit.disabled=!ready.length;
  };
  mode.onchange=preview;
  form.onsubmit=event=>{
    event.preventDefault();
    if(groupRun?.active || B!==board || !canvasCanEdit() || !(B.groups||[]).includes(group))return;
    const current=groupGenerationNodes(group,mode.value==="all");
    if(JSON.stringify(current)!==JSON.stringify(steps)){preview();summary.textContent+=" 画布已更新，请再次确认。";return;}
    if(!current.some(step=>step.status==="waiting"))return;
    closeCanvasGroupRunDialog();
    const id=crypto.randomUUID?.() || "group-"+Date.now()+"-"+Math.random().toString(36).slice(2);
    void executeCanvasGroup({id,board,boardId,groupId:group.id,name:group.name,steps:current,active:true,stop:false});
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
  $("[data-title]",panel).textContent=run.name;
  $("[data-summary]",panel).textContent=run.active
    ? (run.stop?"已停止提交后续节点，已提交的任务继续运行":`正在运行 · 已完成 ${done} / ${run.steps.length}`)
    : `${run.stop?"已停止":"执行结束"} · ${done} 个完成${issue?`，${issue} 个失败或跳过`:""}`;
  $("ol",panel).innerHTML=groupRunRows(run.steps);
  $("[data-stop]",panel).hidden=!run.active || run.stop;
  $("[data-dismiss]",panel).hidden=run.active;
  panel.hidden=false;
}

async function executeCanvasGroup(run) {
  groupRun=run;
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
      const membership=B.groups.find(g=>g.id===run.groupId);
      if(!n || !membership?.nodes.includes(step.id) || n.job || prepping.has(n.id) || groupRunRecipe(n)!==step.recipe) {
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
      step.status="running";renderCanvasGroupRun();
      run.inFlight={nodeId:n.id};
      try {
        await generate(n,{batchLayout:"tabs",groupRunId:run.id});
        while(current() && node(n.id)===n && n.job)await sleep(250);
        const result=run.inFlight.result;
        if(!current()){
          run.stop=true;
          step.status="skipped";step.error="已离开画布，已提交的任务保留";
        } else if(node(n.id)===n && result?.refs.length) {
          step.status="done";
          step.count=result.refs.length;
          step.outputRef=result.refs.at(-1);
          if(result.errors.length)step.error="部分结果失败 · "+result.errors.join("、");
        } else {
          step.status="error";
          step.error=result?.errors.join("、") || els.get(n.id)?.querySelector(".errbox")?.textContent || "未生成可用结果";
        }
      } catch(error) {step.status="error";step.error=error.message;}
      renderCanvasGroupRun();
    }
  } finally {run.active=false;renderCanvasGroupRun();}
}

function groupRunJobFinished(n, job, versions, errors) {
  if(groupRun?.active && groupRun.board===B && job.group_run_id===groupRun.id && groupRun.inFlight?.nodeId===n.id) {
    groupRun.inFlight.result={refs:versions.map(v=>v.ref).filter(Boolean),errors:errors.filter(Boolean)};
  }
}

function initCanvasGroupRun() {
  document.body.insertAdjacentHTML("beforeend",`<dialog id="groupRunConfirm" aria-labelledby="groupRunTitle"><form>
    <header><strong id="groupRunTitle" data-title></strong><button type="button" data-close aria-label="关闭">×</button></header>
    <label>运行范围 <select name="mode"><option value="missing">补齐未生成节点</option><option value="all">全部生成节点</option></select></label>
    <p data-summary></p><ol></ol>
    <footer><button type="button" data-close>取消</button><button type="submit">确认运行</button></footer>
    </form></dialog>
    <aside id="groupRunProgress" aria-label="分组生成进度" hidden>
    <header><strong data-title></strong><button type="button" data-dismiss aria-label="关闭进度">×</button></header>
    <p data-summary role="status"></p><ol></ol><footer><button type="button" data-stop>停止后续节点</button></footer></aside>`);
  const dialog=$("#groupRunConfirm"), panel=$("#groupRunProgress");
  $$("[data-close]",dialog).forEach(button=>button.onclick=closeCanvasGroupRunDialog);
  dialog.oncancel=event=>{event.preventDefault();closeCanvasGroupRunDialog();};
  $("[data-stop]",panel).onclick=()=>{if(groupRun?.active){groupRun.stop=true;renderCanvasGroupRun();}};
  $("[data-dismiss]",panel).onclick=()=>{if(!groupRun?.active){groupRun=null;panel.hidden=true;}};
}
