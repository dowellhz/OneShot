"use strict";

const IMAGE_REFERENCE_USE = {
  reference:"参考图", source:"原图", composition:"构图参考", camera:"机位参考", character:"角色外观",
  scene:"场景参考", prop:"道具参考", style:"画面风格"
};

function imageCanvasRequest(n, prompt, {grid=false,silent=false}={}) {
  const d=n.data;
  let gridReference;
  const fail=message=>{if(!silent)showErr(n,OneShotI18n.t(message));};
  const linked=imageInputs(n), images=[];
  const guide=grid?null:previsComposition(n);
  if(grid){
    gridReference=linked.find(input=>input.version?.ref);
    if(!gridReference)return fail("请先连入有图片的节点");
  }
  const sheet=!grid&&d.character_sheet===true;
  const selected=canvasNodeModel(n,nodeProvider(n));
  const ref=sheet?d.wizard_character_reference:null;
  const ins=grid?[gridReference]:sheet?linked.filter(item=>ref?.node_id===item.source.id &&
    ref.ref===item.edge.ref && item.edge.image_use==="character").slice(0,1):linked;
  const model=selected?.image_engine || isRemote(n) ? "h3img" : d.model;
  if ((ins.length || guide?.enabled) && model === "h3video") return fail("以图改图需要 H3-Image 模型");
  for(const {edge,source,version} of ins){
    if(!version?.ref)return fail(edge.ref?`「${source.name}」引用的版本已移除`:`「${source.name}」还没有图片`);
    images.push({ref:version.ref,node_id:source.id,name:source.name,
      ...(edge.story_cast&&!edge.ref&&source.data.asset?.id?{story_cast:true,asset:source.data.asset.id}:{}),
      ...((edge.image_use || edge.story_cast) ? {image_use:edge.image_use || "character"} : {}),
      ...(edge.prompt_slot?{prompt_slot:edge.prompt_slot}:{})});
  }
  let resolved=resolveCanvasPrompt(n,prompt,canvasPromptBindings(ins),{silent});
  if(resolved===null)return;
  if(guide?.enabled){
    if(!guide.version)return fail("白模构图版本已移除，请关闭构图参考或恢复原版本");
    if(!selected?.ref_limit&&!previsCompositionHasRoom(n,guide,images.map(image=>image.ref))){
      return fail("H3-Image 最多使用 9 张参考图，请为白模构图留出一个位置");
    }
    let index=images.findIndex(image=>image.ref===guide.ref);
    if(index<0){
      index=images.length;
      images.push({ref:guide.ref,node_id:n.id,name:"白模构图"});
    }
    images[index].image_use="composition";
  }
  if(selected?.ref_limit && images.length>selected.ref_limit)
    return fail(OneShotI18n.t("此模型最多使用 {count} 张参考图",{count:selected.ref_limit}));
  let ar = AR[d.aspect];
  if (d.aspect === "auto") { const v=ins[0]?.version || (guide?.enabled && guide.version); ar=v?.w&&v.h?v.w/v.h:1; }
  const request = { kind: "image", model, expand: d.expand, prompt:resolved, images, ar, quality: model === "h3video" ? (d.quality === "16mp" ? "hd" : "std") : d.quality, turbo: d.turbo, seed: d.seed, count: canvasGenerationCount(n),
    ...(d.image_text ? {image_text:d.image_text} : {}) };
  request.board=boardId;
  if(sheet)Object.assign(request,{character_sheet:true,expand:false,image_text:"none",
    ...(ins.length?{character_sheet_reference:ref.ref}:{})});
  if (d.replay_memory_ref) request.replay_memory_ref=d.replay_memory_ref;
  if (d.provider) request.provider=d.provider;
  if (d.selected_model) Object.assign(request,{provider:d.provider,selected_model:d.selected_model});
  return {request,gridReference};
}
