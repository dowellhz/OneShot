"use strict";

function acRenderApprovals() {
 const panel=$("#acApprovals");
 const items=AC.approvals.filter(item=>!acDecidedApprovals.has(item.id));
 const units={image:"张图片",video:"段视频",audio:"段音频",previs:"段白模预演"};
 const markup=items.map(({id,plan={},name})=>{
  const graphics=name==="video_broll_generate";
  const review=plan.reference_review;
  const details=[(review?.duration ?? plan.duration) && `${review?.duration ?? plan.duration} 秒`,
   review?.quality || plan.resolution || plan.quality,review?.provider || plan.provider,
   review?.model || plan.model,plan.aspect || (Number.isFinite(plan.ar) && `宽高比 ${Number(plan.ar.toFixed(2))}:1`),
   plan.voice,graphics && plan.mode,name==="video_draft_finalize" && (plan.placement==="branch"?"相连的新节点":"原节点的新版本"),
   plan.references>0 && `${plan.references} 个素材引用`,plan.asset_count>0 && `${plan.asset_count} 个资产引用`].filter(Boolean).join(" · ");
  const editable=plan.editable||{};
  const referenceLabels={audio_ref:"音频",video_ref:"视频",previs:"白模",subject:"参考图"};
  const referenceMarkup=review?.inputs?.length?`<details open><summary>生成参考 · ${esc(review.counts.filter(([,count])=>count)
    .map(([label,count,limit])=>`${label} ${count}/${limit}`).join(" · "))}</summary>
    <ul class="ac-approval-items">${review.inputs.map(input=>{
     const role=input.image_role || input.role;
     const timedFrame=role==="frame" && Number.isFinite(input.time);
     const label=role==="frame"?"构图参考":referenceLabels[role]||"图片";
     const timing=Number.isFinite(input.start)&&Number.isFinite(input.end)?` · ${input.start}–${input.end} 秒`:
      timedFrame?` · ${Number(input.time.toFixed(2))} 秒`:"";
     const version=Number.isInteger(input.version)?` · 版本 ${input.version}`:"";
     return `<li>${esc([input.name||"参考素材",input.prompt_reference,label+version+timing].filter(Boolean).join(" · "))}</li>`;
   }).join("")}</ul></details>`:"";
  const form=editable.prompt||editable.count?OneShotI18n.html`<details><summary>调整参数</summary>
    <form class="ac-approval-editor" data-approval-edit="${esc(id)}">
    ${editable.prompt?`<label>${plan.kind==="audio"?"文案或描述":"提示词"}<textarea name="prompt" required maxlength="${esc(editable.prompt)}">${esc(plan.prompt||"")}</textarea></label>`:""}
    ${editable.count?OneShotI18n.html`<label>生成数量<input type="number" name="count" required min="1" max="${esc(editable.count)}" value="${esc(plan.count)}"></label>`:""}
    <div class="ac-approval-actions"><button type="submit">保存参数</button><button type="reset">放弃更改</button></div></form></details>`:"";
  const blocked=!!(plan.reference_pending||plan.reference_error);
  return OneShotI18n.html`<article${blocked?" data-reference-blocked":""}><strong>确认生成</strong><div>${esc(plan.label || AC_LABELS[name] || "生成方案")} · ${esc(plan.count)} ${esc(units[plan.kind]||"个结果")}</div>
   ${details?`<small>${esc(details)}</small>`:""}
   <small title="实际费用以服务账单为准">${esc(displayGenerationCost(Number.isFinite(plan.unit_cost) ? plan.unit_cost*plan.count : null))}</small>
   ${plan.reference_pending||plan.reference_error?`<p role="status">${esc(plan.reference_error||"正在核对生成参考…")}</p>`:referenceMarkup}
   ${review?.assets?.length?`<small>资产 · ${esc(review.assets.join("、"))}</small>`:""}
   ${plan.camera_summary||plan.light_summary?`<p>${esc(plan.camera_summary||plan.light_summary)}</p>`:""}
   ${plan.prompt?`<details${graphics?" open":""}><summary>${graphics?"B-roll 画面方案":plan.items?"整组风格":plan.kind==="audio"?"文案或描述":"提示词"}</summary><p>${esc(plan.prompt)}</p></details>`:""}
   ${plan.items?`<ol class="ac-approval-items">${plan.items.map(item=>`<li><details><summary>${esc(item.name)} · ${esc(item.aspect==="auto"?"沿用参考比例":item.aspect)}</summary><p>${esc(item.prompt)}</p></details>
    ${item.assets?.length?`<small>参考资产 · ${esc(item.assets.join("、"))}</small>`:""}</li>`).join("")}</ol>`:""}
   ${form}
   <div class="ac-approval-actions"><button type="button" data-approval-id="${esc(id)}" data-decision="approve"${blocked?" disabled":""}>确认生成</button>
   <button type="button" data-approval-id="${esc(id)}" data-decision="skip">跳过</button></div></article>`;
 }).join("");
 if(panel._items!==markup){panel._items=markup;panel.innerHTML=markup;}
 panel.hidden=!items.length;
}

function acInitExecutionControls(pane){
 $("#acStatus").insertAdjacentHTML("afterend",OneShotI18n.html`<section id="acApprovals" aria-label="待确认的生成方案" aria-live="polite" hidden></section>`);
 $("#acRefs").insertAdjacentHTML("beforebegin",OneShotI18n.markup('<section id="acQuestions" aria-label="待填写的创作确认" hidden></section>'));
 $(".ac-subhead",pane).insertAdjacentHTML("afterend",OneShotI18n.html`<div class="ac-execution-controls"><label class="ac-generation-mode">本轮范围 <select id="acExecutionScope" aria-label="本轮执行范围">${Object.entries(AC_EXECUTION_SCOPES).map(([key,label])=>`<option value="${key}">${label}</option>`).join("")}</select></label>
  <label class="ac-generation-mode">生成方式 <select id="acGenerationMode" aria-label="生成确认方式" title="智能确认每轮最多自动生成两张图片，超出额度的批次和其他类型会先确认">${Object.entries(AC_GENERATION_MODES).map(([key,label])=>`<option value="${key}">${label}</option>`).join("")}</select></label></div>`);
 $("#acExecutionScope").onchange=event=>{AC.executionScope=event.target.value;acRenderState();};
 const generationMode=$("#acGenerationMode");
 generationMode.value=acGenerationMode;
 generationMode.onchange=()=>{acGenerationMode=generationMode.value;localStorage.setItem("h3.chat.generationMode",acGenerationMode);};
 async function decideApproval(id,payload,origin){
  const item=AC.approvals.find(item=>item.id===id);
  if(!item || acDecidedApprovals.has(item.id))return;
  const card=origin.closest("article"), epoch=AC.epoch;
  if(card.dataset.pending)return;
  card.dataset.pending="true";
  const controls=$$("button",card), disabled=controls.map(button=>button.disabled);
  controls.forEach(button=>button.disabled=true);
  try{
   await acApi(`/api/chat/runs/${encodeURIComponent(item.run_id)}/approvals/${encodeURIComponent(item.id)}`,payload);
   if(epoch===AC.epoch){acDecidedApprovals.add(item.id);acRenderApprovals();await acPoll();}
  }catch(error){toast(error.message);if(epoch===AC.epoch)await acPoll();}
  finally{delete card.dataset.pending;controls.forEach((button,i)=>button.disabled=disabled[i]);}
 }
 $("#acApprovals").onclick=event=>{
  const button=event.target.closest("[data-approval-id]");
  if(button && !button.disabled)void decideApproval(button.dataset.approvalId,{decision:button.dataset.decision},button);
 };
 $("#acApprovals").onsubmit=event=>{
  const form=event.target.closest("[data-approval-edit]");
  if(!form)return;
  event.preventDefault();
  if(!form.reportValidity())return;
  const parameters={};
  if(form.elements.prompt)parameters.prompt=form.elements.prompt.value;
  if(form.elements.count)parameters.count=form.elements.count.valueAsNumber;
  void decideApproval(form.dataset.approvalEdit,{decision:"adjust",parameters},form);
 };
 $("#acApprovals").oninput=event=>{
  const form=event.target.closest("[data-approval-edit]");
  if(!form || form.closest("article").dataset.pending)return;
  const card=form.closest("article");
  $("[data-decision=approve]",card).disabled=card.hasAttribute("data-reference-blocked")||
    [...form.elements].some(input=>input.name && input.value!==input.defaultValue);
 };
 $("#acApprovals").onreset=event=>{
  const form=event.target.closest("[data-approval-edit]");
  const card=form?.closest("article");
  if(card && !card.dataset.pending)$("[data-decision=approve]",card).disabled=card.hasAttribute("data-reference-blocked");
 };
}
