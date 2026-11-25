"use strict";

function acMarkRetried(card) {
 if(!card)return;
 const button=$("[data-retry-call]",card);
 if(!button)return;
 button.disabled=true;
 button.dataset.attempted="yes";
 button.textContent=OneShotI18n.t("已提交重试");
}

async function acRetryCall(button) {
 if(button.disabled||!AC.session)return;
 const sid=AC.session;
 const feedback=$("[role=status]",button.parentElement);
 button.disabled=true;button.dataset.sending="yes";
 feedback.textContent="";
 try{
  await flushSave();
  if(sid!==AC.session)return;
  await acApi(`/api/chat/sessions/${encodeURIComponent(sid)}/calls/${encodeURIComponent(button.dataset.retryCall)}/retry`,{});
  acMarkRetried(button.closest(".ac-call"));
  await acPoll();
 }catch(e){feedback.textContent=OneShotI18n.t(e.message);}
 finally{delete button.dataset.sending;if(sid===AC.session)acRenderState();}
}

function acAddCallRetry(card, data) {
 const host=$(".ac-output",card), row=document.createElement("div"), button=document.createElement("button");
 const count=data.retry_count;
 row.className="ac-retry";
 button.type="button";button.dataset.retryCall=data.call_id;
 button.textContent=count>1?OneShotI18n.t("按原参数重试 {count} 个失败结果",{count}):OneShotI18n.t("按原参数重试");
 button.onclick=()=>acRetryCall(button);
 const feedback=document.createElement("span");feedback.setAttribute("role","status");
 if(data.result.errors?.length && !data.result.error){
  const text=document.createElement("pre");text.textContent=data.result.errors.join("；");row.append(text);
 }
 row.append(button,feedback);
 host.append(row);
 card.open=true;
}

function acAppendEvent(e,replay=false){
 const box=$("#acMessages"),d=e.data;let el;
 if(e.kind==="question_answer"){
  acQuestionDrafts.delete(d.call_id);
  el=document.createElement("div");el.className="ac-msg user ac-question-summary";
  el.innerHTML=OneShotI18n.html`<strong>已提交创作确认</strong><dl>${d.answers.map(item=>`<div><dt>${esc(item.question)}</dt><dd>${esc(item.answer)}</dd></div>`).join("")}</dl>`;
  box.append(el);return;
 }
 if(["user","assistant","notice"].includes(e.kind)){
  el=document.createElement("div");el.className="ac-msg "+e.kind;
  if(e.kind!=="notice")acMarkdown(el,e.kind==="user" ? cmReadableReferences(d.text) : d.text);else el.textContent=d.text;
  if(e.kind==="user"&&d.execution_scope&&Object.hasOwn(AC_EXECUTION_SCOPES,d.execution_scope)){
   const badge=document.createElement("div");badge.className="ac-sent-skill";
   badge.textContent=AC_EXECUTION_SCOPES[d.execution_scope];el.append(badge);
  }
  if(e.kind==="user"&&d.skill){
   const badge=document.createElement("div");
   badge.className="ac-sent-skill";badge.textContent="创作技能 · "+d.skill.name;
   el.append(badge);
  }
  if(e.kind==="user"&&d.documents?.length){
   const attachments=document.createElement("div");
   attachments.className="ac-sent-skill";
   attachments.textContent="附件 · "+d.documents.map(doc=>doc.name).join("、");
   el.append(attachments);
  }
  if(e.kind==="user"&&d.selected_versions?.length){
   const refs=document.createElement("div");
   refs.className="ac-sent-skill";
   refs.textContent=d.selected_versions.map(item=>item.name+" · 版本 "+item.version).join("、");
   el.append(refs);
  }
  if(e.kind==="user"&&d.placement){
   const location=document.createElement("div");location.className="ac-sent-skill";
   location.textContent=`放置位置 · ${d.placement.x}, ${d.placement.y}`;
   el.append(location);
  }
  if(e.kind==="user")for(const [i,note] of (d.reviews || (d.review?[d.review]:[])).entries()){
   const review=document.createElement("details"), summary=document.createElement("summary");
   review.className="ac-sent-review";
   summary.textContent="引用审阅评论" + (d.reviews?.length>1 ? " "+(i+1) : "");
   if(note.anchor)summary.textContent+=" · "+ccAnchorLabel(note.anchor);
   review.append(summary);
   if(note.anchor?.passage?.quote){
    const original=document.createElement("blockquote");original.textContent=note.anchor.passage.quote;review.append(original);
   }
   for(const text of [note.body,...note.replies]) {
    const quote=document.createElement("p"); quote.textContent=text; review.append(quote);
   }
   el.append(review);
  }
  if(e.kind==="assistant")acAddChoices(el,e);
 }
 if(e.kind==="retry_queued"){acMarkRetried(AC.calls.get(d.call_id));return;}
 if(e.kind==="profile_decision"){cpApplyDecision(d.id,d.decision);return;}
 if(e.kind==="tool_start"){
  el=document.createElement("details");
  el.className="ac-call";
  el.dataset.call=d.call_id;
  el.dataset.tool=d.name;
  el.dataset.label=(d.retry?"重试 · ":"")+(AC_LABELS[d.name]||d.name);
  el.open=!!d.retry;
  el.innerHTML=`<summary>${esc(el.dataset.label)} · 执行中</summary><div class="ac-progress"></div><div class="ac-output"></div>`;
  AC.calls.set(d.call_id,el);
 }
 if(e.kind==="tool_end"){
  el=AC.calls.get(d.call_id);
  if(!el)return;
  if(e.run_id)el.dataset.taskRun=e.run_id;
  const result=d.result, output=$(".ac-output",el);
  if(result.creative_directions?.length||result.previs_node||result.previs_storyboard_plan||result.playlist_node||result.workflow||result.workflow_templates||result.template_fill_plan||result.reference_plan||result.group_run_plan||result.storyboard_create||result.storyboard_plan||result.shot_review||result.shot_revision||result.shot_range_plan||result.remake_plan||result.review_versions?.length||
     result.split_shots?.length||result.preview?.completed?.length||result.video?.completed||result.gif||d.name==="video_remake_export"&&result.export_ref||
     ["video_broll_generate","video_extend"].includes(d.name)&&result.nodes?.length||result.sources?.length||result.memories?.length)el.open=true;
  el.classList.add(result.error||d.retry_count?"error":"done");
  const state=result.error?"未完成":d.retry_count?"部分失败":result.profile_suggestion||result.reference_plan||result.group_run_plan||(result.storyboard_create&&!node(result.storyboard_create.id))||result.storyboard_plan||result.shot_revision||result.shot_range_plan||result.previs_storyboard_plan||result.template_fill_plan?"等待确认":"完成";
  $("summary",el).textContent=el.dataset.label+" · "+state;
  $(".ac-progress",el).textContent="";
  const detail=document.createElement("pre");
  let description="画布操作已保存。";
  if(result.nodes)description=`已保存 ${result.nodes.length} 个结果，点击缩略图定位。`;
  else if(result.total_nodes!=null)description=`已读取画布，共 ${result.total_nodes} 个节点。`;
  else if(d.name==="image_segment")description="选区已准备好，可继续局部编辑。";
  else if(d.name==="canvas_focus")description="已向页面发送定位请求。";
  else if(result.adopted){
   const names=result.adopted.map(a=>a.name).join("、");
   description=result.retained_explicit_ids
    ? [result.note,names,result.retained_explicit_ids.length?"已保留用户指定的引用。":""].filter(Boolean).join("\n")
    : "已采用："+names;
  }
  else if(result.memories)description=result.memories.length
   ? ["找到 "+result.memories.length+" 条创作记忆",...result.memories.map(a=>`${a.name} · ${cmKind(a)}`)].join("\n")
   : "当前范围内没有匹配的资产。";
  else if(result.memory)description="已保存记忆："+result.memory.name;
  detail.textContent=result.error||result.text||description;
  output.replaceChildren(detail);
  output.insertAdjacentHTML("beforeend",acResultCards(result));
  if(result.sources?.length)output.insertAdjacentHTML("beforeend",acWebSources(result.sources));
  const planCard=$("[data-plan]",el);
  if(planCard)acRestoreRemakePlan(planCard);
  if(result.workflow)acWorkflowResult(output,result.workflow);
  if(typeof aeResultExtras==="function")aeResultExtras(output,result,d.name);
  if(d.retry_count)acAddCallRetry(el,d);
  if(result.profile_suggestion){cpAddSuggestion(output,result.profile_suggestion);el.open=true;}
  return;
 }
 if(e.kind==="progress"){
  el=AC.calls.get(d.call_id);
  if(el){
   const progress=d.jobs.map(j=>{const phase=AC_PHASES[j.phase]||AC_PHASES[j.state]||"处理中",pct=j.max?` · ${Math.min(j.state==="done"?100:99,Math.round((j.value||0)/j.max*100))}%`:"";return phase+pct+(j.ahead?` · 前方 ${j.ahead} 个任务`:"");}).join(" / ");
   $(".ac-progress",el).textContent=progress;
   if(["video_remake_export","video_remake_preview","video_remake_generate"].includes(el.dataset.tool))$("summary",el).textContent=`${AC_LABELS[el.dataset.tool]} · ${progress}`;
  }
  return;
 }
 if(e.kind==="focus"&&!replay){acFocus(d.node_ids,d.open_editor);return;}
 if(typeof aeAppendEvent==="function"&&aeAppendEvent(e,replay))return;
 if(el){
  if(e.run_id&&e.kind==="user")el.dataset.taskRequest=e.run_id;
  if(e.run_id&&["assistant","notice"].includes(e.kind))el.dataset.taskRun=e.run_id;
  $(".ac-empty",box)?.remove();box.append(el);
 }
}
function acWorkflowResult(target, report){
 const button=document.createElement("button");
 button.type="button";
 button.textContent=OneShotI18n.t("打开制作复盘");
 button.onclick=()=>openWorkflowReview(report.node, report.version);
 target.append(button);
}
