"use strict";

function videoDraftAvailable(n) {
  if (n.type!=="video" || n.data.previs || n.data.film) return false;
  if (hasMediaReferences(n)) return !!canvasNodeModel(n,referenceService(n),true)?.draft;
  if (n.data.selected_model) return !!canvasNodeModel(n,nodeProvider(n))?.draft;
  return n.data.provider ? !!CAPS_LIST.video?.find(service=>service.id===n.data.provider)?.draft : CAPS_LIST.default_video_draft===true;
}

function closeVideoDraftFinal() {
  const dialog=$("#videoDraftFinal");
  if (dialog.open) {
    if (dialog.close) dialog.close(); else dialog.removeAttribute("open");
  }
}

function openVideoDraftFinal(n) {
  const version=curV(n), dialog=$("#videoDraftFinal"), form=$("form",dialog);
  if (!canvasCanEdit() || n.job || prepping.has(n.id) || dialog.open || !version?.draft_expires) return;
  const board=boardId, send=$("button[type=submit]",form), status=$("[data-draft-status]",form);
  const expired=version.draft_expires<=Date.now()/1000;
  status.textContent=expired?"样片已过定稿有效期，请重新生成样片。":"";
  send.disabled=expired;
  form.elements.resolution.value=n.draft_finalize_attempt?.ref===version.ref?n.draft_finalize_attempt.resolution:"1080p";
  $("[data-draft-name]",form).textContent=n.name+" · 版本 "+(n.cur+1);
  $("[data-draft-close]",form).onclick=closeVideoDraftFinal;
  dialog.oncancel=event=>{event.preventDefault();closeVideoDraftFinal();};
  async function submit(event) {
    event.preventDefault();
    if (send.disabled || n.job || node(n.id)!==n || curV(n)?.ref!==version.ref) return;
    const resolution=form.elements.resolution.value;
    const prior=n.draft_finalize_attempt;
    if (prior && prior.ref===version.ref && prior.resolution!==resolution) {
      status.textContent="上一项定稿请求尚未确认。请先用原分辨率重试。";return;
    }
    const attempt=prior?.ref===version.ref?prior:{ref:version.ref,resolution,
      key:crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,"0")).join("")};
    n.draft_finalize_attempt=attempt;
    send.disabled=true;status.textContent="正在提交定稿…";
    prepping.add(n.id);
    save();
    try {
      await flushSave();
      if (boardId!==board || node(n.id)!==n) return;
      const result=await api("/api/video/draft/finalize",{board,node:n.id,ref:version.ref,resolution,request_key:attempt.key});
      if (boardId!==board || node(n.id)!==n) return;
      rememberVideoVersion(n);
      const copy=vtClone(version.node_data || n.data), recipe=vtClone(version.video_recipe || {});
      delete copy.draft;delete recipe.draft;
      copy.quality=recipe.quality="hd";
      n.job={ids:result.ids,t0:Date.now(),st:{},prompt:version.prompt||"",
        history:{input_edges:vtClone(version.input_edges || []),node_data:copy,video_recipe:recipe,
          draft_final:{source_ref:version.ref,resolution}},
        generation_record:{...vtClone(version.generation_record || {}),settings:{
          ...version.generation_record?.settings,resolution}}
      };
      if (form.onsubmit===submit) closeVideoDraftFinal();
      save();render(n);showPanel();poll();
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
