"use strict";

const wizardOpeningAnalysisStarted=new WeakSet();
const wizardImageAnalysisRuns=new WeakSet();
const wizardImageAnalysisErrors=new WeakSet();

function wizardOpeningCharacterUpload() {
  return W?.media?.find(item=>item.kind==="image" && item.use==="first" && wizardMediaSource(item));
}

function wizardCharacterSubjects(item) {
  return item && item.analysis?.ref===item.ref ? item.analysis.subjects : null;
}

async function analyzeWizardCharacterUpload(item, active, {retry=false}={}) {
  const media=wizardMediaSource(item);
  if (!media) throw new Error("素材版本已移除");
  if (!retry && item.analysis?.ref===item.ref) return item.analysis.subjects;
  const mode=OneShotI18n.locale==="en"?"character_ref_en":"character_ref";
  wizardImageAnalysisRuns.add(item);
  wizardImageAnalysisErrors.delete(item);
  refreshWizardMedia();
  try {
    const response=await api("/api/describe",{mode,images:[{ref:item.ref,name:media.source.name}]});
    if (!active() || !W.media.includes(item)) return null;
    const subjects=response.subjects;
    item.analysis={ref:item.ref,subjects,summary:response.summary||""};
    if (!Number.isInteger(item.subject) || item.subject>=subjects.length || retry)
      item.subject=subjects.length===1?0:null;
    wizSave();
    return subjects;
  } catch (error) {
    wizardImageAnalysisErrors.add(item);
    throw error;
  } finally {
    wizardImageAnalysisRuns.delete(item);
    if (active()) refreshWizardMedia();
  }
}

function wizardImageAnalysisCard(item, disabled) {
  const result=item.analysis?.ref===item.ref?item.analysis:null;
  const failed=wizardImageAnalysisErrors.has(item);
  if (wizardImageAnalysisRuns.has(item))
    return OneShotI18n.html`<small class="est" role="status">正在分析图片…</small>`;
  return OneShotI18n.html`
    ${failed?OneShotI18n.html`<small class="est" role="status">图片分析失败，可重试。</small>`:""}
    ${result?OneShotI18n.html`<small class="est">图片分析完成</small>
      ${result.summary?`<div class="est">${esc(result.summary)}</div>`:""}`:""}
    ${(failed||!result)&&item.use!=="character_ref"?OneShotI18n.html`<button type="button" class="ghost sm"
      data-wz-action="analyze-character" ${disabled}>${esc(OneShotI18n.t(failed?"重新分析图片":"分析图片"))}</button>`:""}`;
}

function wizardCharacterUploadFields(item, disabled) {
  const subjects=item.analysis?.ref===item.ref?item.analysis.subjects:null;
  const selected=Number.isInteger(item.subject)?subjects?.[item.subject]:null;
  const options=subjects?.map((subject,index)=>
    `<option value="${index}" ${item.subject===index?"selected":""}>${esc(subject.position || OneShotI18n.t("主体 {number}",{number:index+1}))}</option>`).join("");
  return OneShotI18n.html`
    <label>参考角色名（可选）<input maxlength="60" data-wz-field="characterName" value="${esc(item.characterName || "")}" ${disabled}></label>
    ${subjects?.length>1?OneShotI18n.html`<label>目标主体<select data-wz-field="subject" ${disabled}>
      <option value="">选择要生成的主体</option>${options}</select></label>`:""}
    ${selected?OneShotI18n.html`<small class="est">模型识别到的外观</small><div class="est">${esc(selected.appearance)}</div>`:""}
    ${subjects?.length===0?OneShotI18n.html`<small class="est">没有识别到清晰的角色主体。</small>`:""}
    <button type="button" class="ghost sm" data-wz-action="analyze-character" ${disabled}>${esc(OneShotI18n.t(subjects?"重新分析图片":"分析图片"))}</button>`;
}

function selectedWizardCharacterRef(script, character) {
  const candidates=script.data.wizard_media?.characterRefs || [];
  const opening=wizardOpeningCharacterUpload();
  const explicit=Object.hasOwn(character,"wizard_character_ref");
  if (!explicit) {
    const name=character.name.trim().toLocaleLowerCase();
    const planned=candidates.find(item=>item.name && item.name.toLocaleLowerCase()===name) ||
      (candidates.length===1 && script.data.characters?.length===1 ? candidates[0] : undefined);
    if (planned) return planned;
    if (!opening || wizardCharacterSubjects(opening)?.length===0) return;
  }
  const id=explicit?character.wizard_character_ref:opening.node;
  if (!id) return;
  const item=W.media?.find(item=>item.kind==="image" && item.node===id);
  const subjects=wizardCharacterSubjects(item);
  const subjectIndex=character.wizard_character_subject ??
    (subjects?.length===1 && (item!==opening || script.data.characters?.length===1) ? 0 : null);
  const subject=subjects?.[subjectIndex];
  if (subject) return {node:id,ref:item.ref,...subject};
  return candidates.find(item=>item.node===id) || {node:id,ref:item?.ref};
}

async function startWizardOpeningAnalysis() {
  if (W?.step!==2 || !$("#wiz").classList.contains("on")) return;
  const wizard=W, script=wizScript(), item=wizardOpeningCharacterUpload();
  if (!item || !script?.data.characters?.some(character=>{
    const target=castOf(character.name);
    return curV(target)?.source!=="upload" && !wizardSuppliedAsset(script,character,"character",target) &&
      selectedWizardCharacterRef(script,character)?.node===item.node;
  }) || !canvasCanEdit() || wizardMediaRuns.has(wizard) ||
      wizardCharacterSubjects(item) || wizardOpeningAnalysisStarted.has(item)) return;
  wizardOpeningAnalysisStarted.add(item);
  const analysis=runWizardMedia(active=>analyzeWizardCharacterUpload(item,active));
  renderWiz();
  await analysis;
  if (W===wizard && wizScript()===script && W.step===2 && $("#wiz").classList.contains("on")) renderWiz();
}

function wizardCharacterRefPicker(script,character, disabled) {
  const planned=script.data.wizard_media?.characterRefs || [];
  const candidates=[...new Map([...(W.media || []).filter(item=>item.kind==="image"),...planned]
    .map(item=>[item.node,item])).values()];
  if (!candidates.length) return "";
  const selection=selectedWizardCharacterRef(script,character);
  const options=candidates.map(item=>{
    const media=wizardMediaSource(item);
    return `<option value="${esc(item.node)}" ${item.node===selection?.node?"selected":""}>${esc(item.name || media?.source.name || OneShotI18n.t("素材版本已移除"))}</option>`;
  }).join("");
  const item=W.media?.find(item=>item.kind==="image" && item.node===selection?.node);
  const subjects=wizardCharacterSubjects(item);
  const chooseSubject=subjects?.length>1 ||
    (subjects?.length===1 && item===wizardOpeningCharacterUpload() && script.data.characters?.length>1);
  return OneShotI18n.html`<label>人物生成参考<select data-wz-cast-ref ${disabled?"disabled":""}>
    <option value="">不使用上传的参考图</option>${options}</select></label>
    ${chooseSubject?OneShotI18n.html`<label>目标主体<select data-wz-cast-subject ${disabled?"disabled":""}>
      <option value="">选择要生成的主体</option>
      ${subjects.map((subject,index)=>`<option value="${index}" ${character.wizard_character_subject===index?"selected":""}>${esc(subject.position || OneShotI18n.t("主体 {number}",{number:index+1}))}</option>`).join("")}</select></label>`:""}
    ${selection?.appearance ? `<small class="est">${esc(selection.appearance)}</small>` : ""}
    ${subjects?.length===0?OneShotI18n.html`<small class="est">没有识别到清晰的角色主体。</small>`:""}
    ${item && !subjects?OneShotI18n.html`<button class="ghost sm" type="button" data-wz-cast-analyze ${disabled?"disabled":""}>分析图片</button>`:""}`;
}

function wireWizardCharacterRef(card, character) {
  const select=$("[data-wz-cast-ref]",card);
  if (!select) return;
  const analyze=async item=>{
    const wizard=W, script=wizScript();
    if (!item || item.analysis?.ref===item.ref) return;
    const button=$("[data-wz-cast-analyze]",card);
    if (button) {
      button.disabled=true;
      button.textContent=OneShotI18n.t("正在分析人物参考…");
    }
    await runWizardMedia(active=>analyzeWizardCharacterUpload(item,active));
    if (W===wizard && wizScript()===script && W.step===2) renderWiz();
  };
  select.onchange=async()=>{
    checkpoint();
    character.wizard_character_ref=select.value;
    delete character.wizard_character_subject;
    save();
    renderWiz();
    await analyze(W.media?.find(item=>item.kind==="image"&&item.node===select.value));
  };
  $("[data-wz-cast-analyze]",card)?.addEventListener("click",()=>analyze(
    W.media?.find(item=>item.kind==="image"&&item.node===select.value)));
  $("[data-wz-cast-subject]",card)?.addEventListener("change",event=>{
    checkpoint();
    character.wizard_character_ref=select.value;
    character.wizard_character_subject=event.target.value===""?null:Number(event.target.value);
    save();
    renderWiz();
  });
}

function bindWizardCharacterRef(n, selection) {
  const media=selection&&wizardMediaSource(selection);
  if (selection && !media) throw new Error(OneShotI18n.t("人物参考图版本已移除，请重新选择"));
  if (selection && !selection.appearance) throw new Error(OneShotI18n.t("请先分析图片并选择人物主体"));
  B.edges=B.edges.filter(edge=>edge.to!==n.id || !edge.wizard_character_ref ||
    edge.from===media?.source.id && edge.ref===selection.ref);
  if (!media) {
    delete n.data.wizard_character_reference;
    return "";
  }
  const prior=B.edges.find(edge=>edge.to===n.id && edge.from===media.source.id);
  const token=bindPromptMedia(media.source,n,selection.ref,false);
  const edge=B.edges.find(edge=>edge.to===n.id && edge.from===media.source.id);
  if (!edge) throw new Error(OneShotI18n.t("无法连接人物参考图"));
  edge.image_use="character";
  if (!prior) edge.wizard_character_ref=true;
  n.data.wizard_character_reference={node_id:media.source.id,ref:selection.ref};
  return `Use ${token} for the appearance of just the selected subject${selection.position?` (${selection.position})`:""}. Preserve this subject’s visible appearance: ${selection.appearance}. Exclude other people or animals and the original background.`;
}

function updateWizardAssetShots(script, assetNode, ref) {
  const pairs=scriptShotLinks(script).filter(Boolean);
  const protectedFrames=new Set(pairs.flatMap(pair=>script.data.shots.find(shot=>shot.id===pair.shot_id)
    ?.frame?.source==="wizard-opening"?[pair.img]:[]));
  const targets=new Set(pairs.flatMap(pair=>[...shotFrameIds(pair),pair.vid]));
  const linked=B.edges.filter(edge=>edge.from===assetNode.id && targets.has(edge.to) &&
    (["character","scene","prop"].includes(edge.image_use) || edge.role==="subject" || edge.story_cast));
  const changed=new Set();
  for (const edge of linked) {
    const n=node(edge.to);
    if (!n || protectedFrames.has(n.id) || nodeLocked(n) || n.job || prepping.has(n.id)) continue;
    if (n.type==="video") rememberVideoVersion(n);
    if (edge.ref) edge.ref=ref;
    changed.add(n.id);
  }
  for (const pair of pairs) {
    const frames=shotFrameIds(pair);
    if (!frames.some(id=>changed.has(id))) continue;
    for (const id of [...frames,pair.vid]) if (!protectedFrames.has(id)) changed.add(id);
  }
  for (const id of changed) {
    const n=node(id);
    if (!n || nodeLocked(n) || n.job || prepping.has(n.id)) continue;
    if (n.versions.length) n.data.storyboard_stale_refs=n.versions.map(version=>version.ref);
    refresh(n);
  }
}

function wizardCharacterReferenceReady(n, selection) {
  const version=curV(n);
  const record=version?.generation_record;
  return !!version && (!selection || (selection.appearance && record?.prompt?.includes(selection.appearance) &&
    record.inputs?.some(item=>item.node_id===selection.node && item.ref===selection.ref && item.image_use==="character")));
}
