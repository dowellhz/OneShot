"use strict";

function applyScriptShotRevision(script,plan,{wizard=false,recordUndo=true}={}) {
  if(!canvasCanEdit())throw new Error("当前画布仅可查看");
  if(node(script.id)!==script || nodeLocked(script) || toolBusy.has(script.id))throw new Error("分镜已锁定或正在改写");
  const shots=script.data.shots||[];
  const index=plan.shot_id?shots.findIndex(shot=>shot.id===plan.shot_id):plan.shot-1;
  const shot=shots[index], same=(value,expected)=>JSON.stringify(value??null)===JSON.stringify(expected);
  if(!shot)throw new Error("镜头已移除");
  if(Object.entries(plan.changes).every(([key,value])=>same(shot[key],value)))return {index,updated:[],retained:[],already:true};
  if(!Object.entries(plan.before).every(([key,value])=>same(shot[key],value)))throw new Error("镜头内容已变化，请重新准备修改方案");
  const next={...shot,...plan.changes}, previous=scriptShotSettings(script,shot), settings=scriptShotSettings(script,next);
  const pair=scriptShotLinks(script)[index], image=node(pair?.img), video=node(pair?.vid);
  const videoPatch={}, fieldPatch={}, retained=new Set();
  const stage=(n,patch,key,current,before,after)=>{
    if(!n||before===after||current===after)return;
    if(n.job||prepping.has(n.id)||toolBusy.has(n.id))throw new Error("请等本镜的生成任务结束后再应用修改");
    if(nodeLocked(n)||current!==before){retained.add(n.name);return;}
    patch[key]=after;
  };
  const imageChanges=new Map();
  const stageImage=(target,oldSettings,newSettings)=>{
    if(!target)return;
    const patch={};
    const before=oldSettings.prompt, after=newSettings.prompt, current=target.data.prompt;
    const suffix=before&&current?.startsWith(before+"\n")?current.slice(before.length):"";
    const base=target.data.base_prompt;
    stage(target,patch,"prompt",current,before+suffix,after+suffix);
    if(base===before&&patch.prompt)patch.base_prompt=after;
    stage(target,patch,"caption",target.data.caption,oldSettings.caption,newSettings.caption);
    if(Object.keys(patch).length)imageChanges.set(target,patch);
  };
  const detach=wizard&&pair?.shared_first&&image&&previous.image.caption!==settings.image.caption;
  const middle=node(pair?.motion_frames?.middle);
  if(detach&&[video,middle].some(target=>target&&(nodeLocked(target)||target.job||prepping.has(target.id))))
    throw new Error("请先解锁镜头并等待生成完成，再修改共用首帧");
  if(pair?.shared_first&&!detach){
    if(previous.image.caption!==settings.image.caption)retained.add(image?.name||"共用首帧");
  }else if(!detach)stageImage(image,previous.image,settings.image);
  if(wizard&&shot.motion_frames&&next.motion_frames){
    for(const phase of ["middle","end"]){
      stageImage(node(pair?.motion_frames?.[phase]),shotMotionFrameSettings(script,shot,phase),
        shotMotionFrameSettings(script,next,phase));
    }
  }
  if(video){
    stage(video,videoPatch,"duration",video.data.duration,previous.video.duration,settings.video.duration);
    for(const [key,value] of Object.entries(settings.video.fields)){
      if(previous.video.fields[key]===value)continue;
      if(video.data.pmode==="fields")stage(video,fieldPatch,key,video.data.fields?.[key],previous.video.fields[key],value);
      else retained.add(video.name);
    }
  }
  if(recordUndo)checkpoint();
  ensureScriptShotIds(script);
  Object.assign(shot,plan.changes);
  const updated=[];
  const stale=new Set();
  if(detach){
    const first=addNode("image",middle?.x??image.x,(middle?.y??image.y)-size(image).h-110,
      {...settings.image,aspect:script.data.aspect,quality:"4mp"},{name:`镜${index+1} · 分镜图`});
    settings.references.forEach(ref=>B.edges.push({from:ref.node.id,to:first.id,story_cast:!ref.pinned,...(ref.pinned?{ref:ref.ref}:{})}));
    if(video){
      rememberVideoVersion(video);
      const edge=B.edges.find(entry=>entry.to===video.id&&entry.role==="first");
      if(edge){edge.from=first.id;delete edge.ref;}
      else B.edges.push({from:first.id,to:video.id,role:"first"});
    }
    if(middle){
      const guide=B.edges.find(entry=>entry.to===middle.id&&entry.prompt_slot===1);
      if(guide){guide.from=first.id;delete guide.ref;}
      else B.edges.push({from:first.id,to:middle.id,prompt_slot:1});
      stale.add(middle);
    }
    pair.img=first.id;
    pair.shared_first=false;
    updated.push(first);
  }
  for(const [target,patch] of imageChanges){
    Object.assign(target.data,patch);
    if(wizard&&patch.prompt)stale.add(target);
    updated.push(target);
  }
  const affectedPairs=wizard&&stale.size?scriptShotLinks(script).filter(Boolean):[];
  if(affectedPairs.length){
    const motionIds=new Set(affectedPairs.flatMap(item=>Object.values(item.motion_frames||{})));
    for(const source of stale)
      for(const edge of B.edges)
        if(edge.from===source.id&&edge.prompt_slot===1&&!edge.ref&&motionIds.has(edge.to)&&node(edge.to))
          stale.add(node(edge.to));
  }
  for(const target of stale)if(target.versions.length)
    target.data.storyboard_stale_refs=target.versions.map(version=>version.ref);
  if(Object.keys(videoPatch).length||Object.keys(fieldPatch).length){
    rememberVideoVersion(video);
    Object.assign(video.data,videoPatch);
    if(Object.keys(fieldPatch).length)video.data.fields={...video.data.fields,...fieldPatch};
    updated.push(video);
  }
  if(wizard){
    const staleIds=new Set([...stale].map(target=>target.id));
    const staleVideos=new Set(affectedPairs.filter(item=>shotFrameIds(item).some(id=>staleIds.has(id))).map(item=>node(item.vid)));
    if(video&&(updated.includes(video)||stale.size||detach))staleVideos.add(video);
    for(const target of staleVideos)if(target?.versions.length){
      rememberVideoVersion(target);
      target.data.storyboard_stale_refs=target.versions.map(version=>version.ref);
    }
  }
  render(script);updated.forEach(render);
  if(sel.size===1&&[script,...updated].some(n=>sel.has(n.id)))showPanel();
  drawEdges();save();
  return {index,updated,retained:[...retained],already:false};
}
