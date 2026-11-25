"use strict";

function canEditNodePrompt(n) {
  return !!n && canvasCanEdit() && canvasMediaUploadTarget(n) && !n.job && !prepping.has(n.id);
}

function focusNodePrompt(n) {
  if (!canEditNodePrompt(n) || node(n.id)!==n) return;
  selectOnly(n.id);
  const field = usesFields(n) ? $('#pfields textarea[data-k="action"]') : $("#prompt");
  field?.focus();
}

function hasGenerationDraft(n,v) {
  return canEditNodePrompt(n) && !!v?.ref && !v.image_grid &&
    (n.type==="audio" ? typeof v.audio_recipe?.prompt==="string" :
      !!(v.node_data && Array.isArray(v.input_edges) && (v.generation_record || v.video_recipe)) ||
      n.type==="video" && hasVideoRecipeInputs(v.video_recipe) ||
      n.type==="image" && typeof v.generation_record?.prompt==="string" && Array.isArray(v.generation_record.inputs));
}

function generationDraft(n,v) {
  if (!hasGenerationDraft(n,v) || node(n.id)!==n || !n.versions.includes(v)) throw new Error("此版本的生成草稿不可用");
  if (n.type==="video" && (!v.node_data || !Array.isArray(v.input_edges))) v=vtSnapshot(n,n.versions.indexOf(v));
  const receipt = v.generation_record;
  const saved = n.type==="audio" ? v.audio_recipe : v.node_data;
  const data = {...defaults(n.type),...structuredClone(saved || {})};
  // Library identity belongs to the node, even when its generation settings change.
  for (const key of ["asset","caption"]) if (Object.hasOwn(n.data,key)) data[key] = structuredClone(n.data[key]);
  delete data.character_draft;
  const inputs = Array.isArray(receipt?.inputs) ? receipt.inputs : [];
  const legacyImage = n.type==="image" && (!v.node_data || !Array.isArray(v.input_edges));
  let links = n.type==="audio" ? [] : v.input_edges;
  if (n.type==="video") {
    links=vtEdgesWithReferenceRanges(links,v.video_recipe);
    vtRestoreVideoModel(data,v);
  }
  if (legacyImage) {
    const {model,provider,provider_model,quality,seed,count,ar} = receipt.settings || {};
    data.prompt=receipt.prompt;
    for (const [key,value] of Object.entries({model,provider,quality,seed,count})) if (value != null) data[key]=value;
    if (provider && provider_model && provider!=="local_h3") data.selected_model=provider_model;
    if (Number.isFinite(ar)) data.aspect=Object.keys(AR).find(key=>Math.abs(AR[key]-ar)<.001) || "auto";
    links=inputs.filter(input=>input.role!=="text" && input.node_id).map(input=>({from:input.node_id,to:n.id,ref:input.ref}));
  }
  const recordedRefs = new Map((v.video_recipe?.images || []).concat(inputs)
    .filter(input=>input.node_id && input.ref).map(input=>[input.node_id,input.ref]));
  const savedText = new Map(inputs.filter(input=>input.role==="text").map(input=>[input.node_id,input.text]));
  const edges = links.map(edge => {
    const source = node(edge.from);
    if (!source || vtReferenceAncestors(source).has(n.id)) throw new Error("历史引用已移除或会形成循环连线");
    if (source.type==="text") {
      if (savedText.has(source.id) && (source.data.text || "").slice(0,5000)!==savedText.get(source.id))
        throw new Error("历史文本引用已修改，无法恢复原草稿");
      return {...edge,to:n.id};
    }
    const ref = edge.ref || edge.source_ref || recordedRefs.get(source.id);
    if (!ref || !source.versions.some(item=>item.ref===ref)) throw new Error("历史素材版本已移除");
    return {...edge,to:n.id,...(edge.source_ref ? {} : {ref})};
  });
  for (const item of (n.type==="audio" && Array.isArray(data.references) ? data.references : [])) {
    const source = node(item.node_id);
    if (!source?.versions.some(version=>version.ref===item.ref) || vtReferenceAncestors(source).has(n.id))
      throw new Error("历史音频参考版本已移除或会形成循环连线");
  }
  return {data,edges};
}

function canReuseGenerationAssets(n,v) {
  return ["image","video"].includes(n.type) && hasGenerationDraft(n,v) && !!v.memory_used?.length;
}

function loadGenerationDraft(n,v,report=toast,{reuseAssets=false}={}) {
  let draft;
  try { draft=generationDraft(n,v); }
  catch (error) { report(error.message);return false; }
  checkpoint();
  rememberVideoVersion(n);
  n.data=draft.data;
  if (reuseAssets) n.data.replay_memory_ref=v.ref;
  else delete n.data.replay_memory_ref;
  n.cur=n.versions.indexOf(v);
  B.edges=B.edges.filter(edge=>edge.to!==n.id).concat(draft.edges);
  if (n.type==="audio") syncSeedAudioEdges();
  $("#prompt")._node=null;
  $("#pfields")._node=null;
  render(n);
  refreshDownstream(n);
  drawEdges();
  save();
  return true;
}
