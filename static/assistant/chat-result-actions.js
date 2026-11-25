"use strict";

function acInitResultActions(){
 $("#acMessages").onclick=async e=>{
  const gif=e.target.closest("[data-gif-showcase]");
  if(gif){if(AC.board===boardId)await openGifShowcase({ref:gif.dataset.gifShowcase});return;}
  const follow=e.target.closest("[data-explore-direction],[data-plan-direction]");
  if(follow){
   if(AC.board!==boardId||!AC.session||AC.sending||AC.loadingSessions)return;
   const direction=JSON.parse(follow.closest("[data-creative-direction]").dataset.creativeDirection);
   const plan=follow.hasAttribute("data-plan-direction"), input=$("#acInput");
   const heading=plan?`把「${direction.title}」拟成制作方案`:`继续讨论「${direction.title}」`;
   const task=plan?"请列出制作步骤、所需素材和第一项可验证的交付。有适用的工作流时，准备可核对的方案。":
    "请细化执行方法和第一步。";
   const draft=[heading,direction.premise,`执行方法 · ${direction.approach}`,`取舍 · ${direction.tradeoff}`,`第一步 · ${direction.first_step}`,task].join("\n");
   const next=[input.value.trimEnd(),draft].filter(Boolean).join("\n\n");
   if(next.length>input.maxLength)return toast("草稿超过输入长度，原内容已保留");
   AC.executionScope=plan?"plan":"brainstorm";
   input.value=next;input.focus();input.setSelectionRange(next.length,next.length);
   acRenderState();
   return;
  }
  const shotRange=e.target.closest("[data-open-shot-range]");
  if(shotRange){if(AC.board===boardId)openPlannedShotRange(JSON.parse(shotRange.dataset.openShotRange));return;}
  const template=e.target.closest("[data-open-workflow-template],[data-template-fill-plan]");
  if(template){
   const target=template.dataset.templateFillPlan?JSON.parse(template.dataset.templateFillPlan):
    {id:template.dataset.openWorkflowTemplate,scope:template.dataset.templateScope};
   if(AC.board!==boardId || target.board&&target.board!==boardId || !["private","catalog","presets","favorites"].includes(target.scope))return;
   await openWorkflowTemplates(false,null,target);
   return;
  }
  const createStoryboard=e.target.closest("[data-create-storyboard]");
  if(createStoryboard){
   const card=createStoryboard.closest("[data-storyboard-create]"), p=JSON.parse(card.dataset.storyboardCreate);
   const status=$("[role=status]",card);
   if(p.board!==boardId || AC.board!==boardId || !canvasCanEdit())return toast("请回到对应的可编辑画布");
   let script=node(p.id);
   if (!script) {
    const refs=p.refs.map(item=>({source:node(item.node),ref:item.ref}));
    if (refs.some(({source,ref})=>source?.type!=="image" || !source.versions.some(version=>version.ref===ref))) {
     status.textContent="部分参考图或版本已移除，请重新拟定分镜";
     return;
    }
    const position=toW(innerWidth/2,innerHeight/2), spot=freeSpot(position.x,position.y,"script",{w:440,h:620});
    checkpoint();
    script=addNode("script",spot.x,spot.y,{prompt:p.story,title:p.title,style:p.style,aspect:p.aspect,
     characters:p.characters,shots:p.shots.map(shot=>({...shot,id:newCanvasNodeId()}))},
     {id:p.id,name:(p.title || "分镜脚本").slice(0,80)});
    for (const {source,ref} of refs) link(source,script,true,{ref});
    drawEdges();
   }
   createStoryboard.textContent=OneShotI18n.t("定位分镜");
   status.textContent=OneShotI18n.t("分镜已加入画布");
   const summary=card.closest(".ac-call")?.querySelector("summary");
   if(summary)summary.textContent=AC_LABELS.storyboard_create_plan+" · 已加入";
   selectOnly(script.id);fit([script]);
   return;
  }
  const revisionButton=e.target.closest("[data-apply-shot-revision],[data-run-shot-revision]");
  if(revisionButton){
   const card=revisionButton.closest("[data-shot-revision]"), p=JSON.parse(card.dataset.shotRevision), script=node(p.node);
   if(p.board!==boardId || AC.board!==boardId || !canvasCanEdit())return toast("请回到对应的可编辑画布");
   if(script?.type!=="script")return toast(OneShotI18n.t("分镜已移除"));
   const run=$("[data-run-shot-revision]",card), status=$('[role="status"]',card);
   if(revisionButton===run){
    const index=script.data.shots.findIndex(shot=>shot.id===run.dataset.shot);
    if(index<0)return toast("该镜头已移除");
    openScriptShotRun(script,index,{mode:run.dataset.mode});
    return;
   }
   try{
    const result=applyScriptShotRevision(script,p);
    revisionButton.disabled=true;
    status.textContent=result.already?"该修改已在分镜中":
     `分镜已更新，已同步 ${result.updated.length} 个生成节点。${result.retained.length?"保留已有调整的节点："+result.retained.join("、")+"。":""}`;
    if(result.updated.length){
     run.hidden=false;
     run.dataset.shot=script.data.shots[result.index].id;
     run.dataset.mode=result.updated.length>1?"all":result.updated[0].type==="video"?"video":"frame";
    }
    card.closest(".ac-call").querySelector("summary").textContent=AC_LABELS.storyboard_revision_plan+" · 已应用";
   }catch(error){status.textContent=error.message;}
   return;
  }
  const reviewButton=e.target.closest("[data-shot-review],[data-plan-review-revision]");
  if(reviewButton){
   const card=reviewButton.closest("[data-shot-review-card]"), p=JSON.parse(card.dataset.shotReviewCard);
   if(p.board!==boardId || AC.board!==boardId)return toast("请回到审阅所属画布");
   const script=node(p.script);
   if(script?.type!=="script")return toast(OneShotI18n.t("分镜已移除"));
   if(reviewButton.hasAttribute("data-plan-review-revision")){
    const status=$('[role="status"]',card), call=card.closest("[data-call]").dataset.call;
    const model=$("#acModelChoice").value, thinking=$("#acThinkingLevel").value;
    reviewButton.dataset.requestKey ||= crypto.randomUUID?.() || ("revise-review-"+Date.now()+Math.random());
    reviewButton.disabled=true;status.textContent=OneShotI18n.t("正在提交…");
    try{
     await acSendShotRequest(p.board,{text:"根据这次审阅，为当前镜头拟一份修改方案。",review_revision_call:call,
      request_key:reviewButton.dataset.requestKey,enqueue:true,...(model?{chat_model:model}:{}),
      ...(thinking&&thinking!=="off"?{thinking_level:thinking}:{})},AC.session);
     status.textContent=OneShotI18n.t("已提交修改方案请求");
    }catch(error){reviewButton.disabled=false;status.textContent=error.message;}
   }else{
    const index=p.shot_id?script.data.shots.findIndex(shot=>shot.id===p.shot_id):p.shot-1;
    if(index<1)return toast(OneShotI18n.t("审阅关联的切点已变化，请重新审阅"));
    openShotContinuityReview(script,index,p);
   }
   return;
  }
  const shotButton=e.target.closest("[data-open-approved-shot],[data-link-previous-shot],[data-run-approved-shot]");
  if(shotButton){
   const card=shotButton.closest("[data-storyboard-plan]"), plan=JSON.parse(card.dataset.storyboardPlan);
   const open=$("[data-open-approved-shot]",card), tail=$("[data-link-previous-shot]",card), run=$("[data-run-approved-shot]",card);
   if(plan.board!==boardId || AC.board!==boardId || !canvasCanEdit())return toast("请回到对应的可编辑画布");
   const script=node(plan.node);
   const index=script?.data.shots?.findIndex(shot=>shot.id===open.dataset.openApprovedShot)??-1;
   if(script?.type!=="script" || index<0)return toast("这一镜已移除");
   if(shotButton===run){openScriptShotRun(script,index);return;}
   if(shotButton===tail){
    tail.disabled=true;
    try{await linkPreviousShotFrame(script,index);}finally{tail.disabled=false;}
    return;
   }
   openScriptShot(script,index);
   const pair=scriptShotLinks(script)[index];
   if(pair)open.textContent=OneShotI18n.t("定位这一镜");
   tail.hidden=index===0||!node(pair?.img);
   run.hidden=!pair;
   return;
  }
  const adopt=e.target.closest("[data-adopt-storyboard]");
  if(adopt){
   const card=adopt.closest("[data-storyboard-plan]"), p=JSON.parse(card.dataset.storyboardPlan), status=$('[role="status"]',card);
   const script=node(p.node), data=script?.data, shots=data?.shots||[];
   if(p.board!==boardId || AC.board!==boardId || !canvasCanEdit())return toast("请回到对应的可编辑画布");
   if(script?.type!=="script" || nodeLocked(script) || toolBusy.has(script.id)){
    status.textContent="脚本已移除、锁定或正在改写，请检查后再试";return;
   }
   const accepted=(shot,label)=>{
    status.textContent=label;adopt.disabled=true;
    const open=$("[data-open-approved-shot]",card), index=data.shots.indexOf(shot);
    if(shot.id){
     open.dataset.openApprovedShot=shot.id;
     const pair=scriptShotLinks(script)[index];
     open.textContent=pair?OneShotI18n.t("定位这一镜"):OneShotI18n.t("展开这一镜");
     open.hidden=false;
     $("[data-link-previous-shot]",card).hidden=index===0||!node(pair?.img);
     $("[data-run-approved-shot]",card).hidden=!pair;
    }
    card.closest(".ac-call").querySelector("summary").textContent=AC_LABELS.storyboard_next_shot_plan+" · 已加入分镜";
   };
   const sameFields=(a,b)=>Object.keys(b).every(key=>JSON.stringify(a?.[key]??null)===JSON.stringify(b[key]));
   const prior=p.shot_id?shots.find(shot=>shot.id===p.shot_id):
    shots.length===p.anchor.count+1&&sameFields(shots.at(-1),p.shot)?shots.at(-1):null;
   if(prior){accepted(prior,"这一镜已加入分镜");return;}
   if(shots.length!==p.anchor.count || !sameFields(shots.at(-1),p.anchor.last) ||
      (data.style||"")!==p.anchor.style || JSON.stringify(data.characters||[])!==JSON.stringify(p.anchor.characters)){
    status.textContent="前镜或角色设定已更新，请重新准备方案";return;
   }
   checkpoint();ensureScriptShotIds(script);
   const shot={...p.shot,id:p.shot_id||newCanvasNodeId()};
   data.shots=[...shots,shot];refresh(script);save();
   accepted(shot,"已加入分镜");
   void acFocus([script.id]);
   return;
  }
  const groupPlan=e.target.closest("[data-group-run-plan]");
  if(groupPlan){
   const plan=JSON.parse(groupPlan.dataset.groupRunPlan);
   if(plan.board!==boardId || AC.board!==boardId || !canvasCanEdit())return toast("请回到对应的可编辑画布");
   const group=(B.groups||[]).find(g=>g.id===plan.group);
   if(!group || !plan.targets.some(id=>group.nodes.includes(id)&&node(id)))return toast("分组或目标节点已移除，请重新准备方案");
   openCanvasGroupRun(group,{plan});
   return;
  }
  const reference=e.target.closest("[data-reference-plan]");
  if(reference){
   const p=JSON.parse(reference.dataset.referencePlan), source=node(p.source);
   if(p.board!==boardId || AC.board!==boardId || !canvasCanEdit())return toast("请回到对应的可编辑画布");
   const group=p.group?(B.groups||[]).find(g=>g.id===p.group):null;
   if(!source || p.group&&!group)return toast("原素材或分组已移除，请重新准备方案");
   if(!p.memory){vtOpenReferenceUpdate(source,undefined,group,p);return;}
   const board=B, epoch=boardOpenEpoch;
   reference.disabled=true;
   try{
    const asset=await boardRequest("/api/memory/"+encodeURIComponent(p.memory)+"?board="+encodeURIComponent(p.board));
    if(B!==board || boardOpenEpoch!==epoch || AC.board!==boardId || !reference.isConnected)return;
    const choice=vtLibraryReferences([asset],source.type).find(item=>item.spec.versions[0]?.ref===p.ref);
    if(!choice || p.character_view && asset.character_views?.[p.character_view]!==p.ref){
     return toast("资产参考图或定稿视角已变化，请重新准备方案");
    }
    vtOpenReferenceUpdate(source,undefined,group,{...p,spec:choice.spec});
   }catch(error){if(B===board)toast(error.message);}
   finally{reference.disabled=false;}
   return;
  }
  const playlist=e.target.closest("[data-playlist-open]");
  if(playlist&&AC.board===boardId){
   const board=boardId;
   try{await acSyncBoard(Number(playlist.dataset.playlistRev));}
   catch(error){return toast(error.message);}
   if(board!==boardId)return;
   const target=node(playlist.dataset.playlistOpen);
   if(!target?.data.playlist)return toast("播放列表已移除或尚未同步");
   closeLightbox();acFocus([target.id]);openFilm(target);return;
  }
  const plan=e.target.closest("[data-apply-plan]");
  if(plan){acApplyRemakePlan(plan);return;}
  const decision=e.target.closest("[data-remake-decision]");
  if(decision){acReviewRemake(decision);return;}
  const remake=e.target.closest("[data-remake-node]");
  if(remake){
   const target=vtResolve(remake.dataset.remakeNode,remake.dataset.remakeRef);
   if(!target || target.node.type!=="video" || target.node.versions[target.index]?.ref!==remake.dataset.remakeRef){toast("原片版本已不存在");return;}
   if(target.node.cur!==target.index && !switchVersion(target.node,target.index))return;
   closeLightbox();
   const start=remake.dataset.remakeStart;
   openVideoRemake(target.node,{shotStart:start===undefined ? undefined : Number(start), frame:remake.dataset.remakeFrame,
    previewJob:remake.dataset.remakePreviewJob,videoJob:remake.dataset.remakeVideoJob});
   return;
  }
  const previsStoryboard=e.target.closest("[data-open-previs-storyboard]");
  if(previsStoryboard){
   const p=JSON.parse(previsStoryboard.dataset.openPrevisStoryboard);
   if(p.board!==boardId || !canvasCanEdit())return toast("请打开可编辑的原画布");
   const target=node(p.node), scene=target?.data?.previs;
   if(!pvUsableScene(scene))return toast("白模场景已移除或尚未同步");
   if(p.fps!==PV_FPS || p.aspect!==scene.aspect || JSON.stringify(p.boundaries)!==JSON.stringify(pvStoryboardBoundaries(scene))){
    return toast("白模切点或画幅已更新，请重新准备分镜");
   }
   closeLightbox();
   openPrevis(target);
   if(PV.editor?.n===target)pvElement("[data-pv-storyboard]").focus();
   return;
  }
  const previsButton=e.target.closest("[data-previs-open]");
  if(previsButton&&AC.board===boardId){
   const ref=previsButton.dataset.previsRef;
   const resolved=vtResolve(previsButton.dataset.previsOpen,ref);
   if(!resolved?.node.data.previs){toast("白模节点或版本已移除");return;}
   if(ref&&resolved.node.cur!==resolved.index&&!switchVersion(resolved.node,resolved.index))return;
   closeLightbox();acFocus([resolved.node.id]);openPrevis(resolved.node);return;
  }
  const cut=e.target.closest("[data-extension-clip]");
  if(cut&&AC.board===boardId){
   const result=vtResolve(cut.dataset.extensionClip,cut.dataset.versionRef);
   if(!result || result.node.type!=="video")return toast("续拍结果版本已移除");
   closeLightbox();
   openExtensionTimeline(result.node,result.node.versions[result.index]);
   return;
  }
  const b=e.target.closest("[data-focus]");if(b){const resolved=vtResolve(b.dataset.focus,b.dataset.versionRef);if(resolved){closeLightbox();switchVersion(resolved.node,resolved.index);acFocus([resolved.node.id]);}}};
}
