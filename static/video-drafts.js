"use strict";

function videoDraftAvailable(n) {
  if (n.type!=="video" || n.data.previs || n.data.film) return false;
  if (hasMediaReferences(n)) return !!videoOutputModel(n)?.draft;
  if (n.data.selected_model) return !!canvasNodeModel(n,nodeProvider(n))?.draft;
  return n.data.provider ? !!CAPS_LIST.video?.find(service=>service.id===n.data.provider)?.draft : CAPS_LIST.default_video_draft===true;
}

function closeVideoDraftFinal() {
  const dialog=$("#videoDraftFinal");
  if (dialog.open) {
    if (dialog.close) dialog.close(); else dialog.removeAttribute("open");
  }
}

function draftFinalEdge(n) {
  if (n.type==="video" && !n.versions.length) return B.edges.find(edge=>edge.to===n.id && edge.relation==="draft_final");
}

function openVideoDraftFinal(n, selectedVersion = null) {
  const dialog=$("#videoDraftFinal"), form=$("form",dialog);
  if (!canvasCanEdit() || n.job || prepping.has(n.id) || dialog.open) return;
  const edge=draftFinalEdge(n), source=edge?node(edge.from):n;
  const version=edge?source?.versions.find(v=>v.ref===edge.ref):selectedVersion || curV(source);
  if (!version?.draft_expires) {
    if (edge) toast("定稿对应的样片版本已移除");
    return;
  }
  const board=boardId, send=$("button[type=submit]",form), status=$("[data-draft-status]",form);
  const expired=version.draft_expires<=Date.now()/1000;
  const saved=n.draft_finalize_attempt?.ref===version.ref?n.draft_finalize_attempt:null;
  status.textContent=expired?(saved?"可恢复已提交的定稿任务。":"样片已过定稿有效期，请重新生成样片。"):"";
  send.disabled=expired&&!saved;
  send.textContent=expired&&saved?"恢复定稿":"生成定稿";
  $("[data-draft-guidance]",form).textContent=saved?"使用原请求查看定稿任务。":"沿用所选样片的提示词与参考素材，提交一项新的定稿任务。";
  form.elements.resolution.value=saved?.resolution || (edge && n.data.quality==="4k"?"4k":"1080p");
  form.elements.placement.value=edge?"branch":saved?.placement || "tab";
  form.elements.placement.disabled=!!edge;
  $("[data-draft-name]",form).textContent=source.name+" · 版本 "+(source.versions.indexOf(version)+1);
  $("[data-draft-close]",form).onclick=closeVideoDraftFinal;
  dialog.oncancel=event=>{event.preventDefault();closeVideoDraftFinal();};
  async function submit(event) {
    event.preventDefault();
    if (send.disabled || n.job || node(n.id)!==n) return;
    const current=()=>{
      if (boardId!==board || node(n.id)!==n || node(source.id)!==source || n.job) return false;
      if (!edge) return selectedVersion ? source.versions.some(v=>v.ref===version.ref) : curV(source)?.ref===version.ref;
      const binding=draftFinalEdge(n);
      return binding?.from===source.id && binding.ref===version.ref && source.versions.some(v=>v.ref===version.ref);
    };
    if (!current()) {
      status.textContent="原样片版本已改变，请重新打开定稿";
      return;
    }
    const resolution=form.elements.resolution.value, placement=edge?"branch":form.elements.placement.value;
    const prior=n.draft_finalize_attempt;
    if (version.draft_expires<=Date.now()/1000 && prior?.ref!==version.ref) {
      status.textContent="样片已过定稿有效期，请重新生成样片。";send.disabled=true;return;
    }
    if (prior && prior.ref===version.ref && (prior.resolution!==resolution || (prior.placement || "tab")!==placement)) {
      status.textContent="上一项定稿请求尚未确认。请用相同的分辨率和结果位置重试。";return;
    }
    const attempt=prior?.ref===version.ref?prior:{ref:version.ref,resolution,placement,
      ...(placement==="branch"?{nodeId:edge?n.id:newCanvasNodeId()}:{}),
      key:crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,"0")).join("")};
    n.draft_finalize_attempt=attempt;
    send.disabled=true;status.textContent="正在提交定稿…";
    prepping.add(n.id);
    save();
    try {
      await flushSave();
      if (!current()) throw new Error("原样片版本已改变，请重新打开定稿");
      const savedAttempt=AC.base.get(board)?.nodes?.find(item=>item.id===n.id)?.draft_finalize_attempt;
      if (savedAttempt?.key!==attempt.key) throw new Error("定稿请求尚未保存，请重试");
      const result=await api("/api/video/draft/finalize",{board,node:source.id,ref:version.ref,resolution,request_key:attempt.key});
      if (boardId!==board || node(n.id)!==n) return;
      const copy=vtClone(version.node_data || source.data), recipe=vtClone(version.video_recipe || {});
      delete copy.draft;delete recipe.draft;
      copy.quality=recipe.quality=resolution==="4k"?"4k":"hd";
      const job={ids:result.ids,t0:Date.now(),st:{},prompt:version.prompt||"",memory_used:vtClone(version.memory_used || []),
        history:{input_edges:vtClone(version.input_edges || B.edges.filter(edge=>edge.to===source.id)),node_data:copy,video_recipe:recipe,
          draft_final:{source_node:source.id,source_ref:version.ref,resolution}},
        generation_record:{...vtClone(version.generation_record || {}),settings:{
          ...version.generation_record?.settings,resolution}}
      };
      let target=n;
      if (placement==="branch") {
        delete n.draft_finalize_attempt;
        const binding={from:source.id,to:attempt.nodeId,relation:"draft_final",ref:version.ref};
        job.history.input_edges=[binding];
        copy.prompt=job.prompt;
        target=edge?n:node(attempt.nodeId);
        if (!target) {
          checkpoint();
          const dimensions=size(source);
          const at=freeSpot(source.x+dimensions.w+110,source.y,"video",dimensions);
          target=addNode("video",at.x,at.y,copy,{
            id:attempt.nodeId,name:source.name.slice(0,44)+" · "+resolution.toUpperCase()+" 定稿",job});
          B.edges.push(binding);
        } else if (edge) {
          target.job=job;
        }
      } else {
        rememberVideoVersion(n);
        n.job=job;
      }
      if (form.onsubmit===submit) closeVideoDraftFinal();
      save();render(target);drawEdges();selectOnly(target.id);poll();
    } catch(error) {
      if (boardId===board && dialog.open && form.onsubmit===submit) {
        status.textContent=error.message;
        send.disabled=false;
      }
    } finally {
      prepping.delete(n.id);
      if (node(n.id)===n) renderJob(n);
    }
  }
  form.onsubmit=submit;
  if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open","");
}
