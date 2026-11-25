"use strict";
// A canvas video can hold several results; input snapshots travel with each tab.
const vtClone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
function vtReferences(id){
  return B.nodes.some(n=>(n.data?.film?.clips||[]).some(c=>c.node===id)||(n.data?.made||[]).some(s=>s.vid===id));
}
function vtSignature(n){
  const p=plan(n),entries=p.es.map((e,i)=>{
    let role=p.roles[i],time=null;
    if(role!=="subject"){
      if(!p.useRef)role=p.ordered.indexOf(i)===0?"first":"last";
      else {time=p.times[i]??0;const end=(vidFrames(n.data.duration)-4)/24;role=time<=.01?"first":time>=end-.05?"last":"keyframe";if(role!=="keyframe")time=null;}
    }
    return [e.from,role,time==null?null:Math.round(time*1000)/1000,e.ref||null];
  });
  for(const e of B.edges.filter(e=>e.to===n.id&&node(e.from)?.type==="text"))entries.push([e.from,"text",null]);
  for(const e of B.edges.filter(e=>e.to===n.id&&e.relation==="remake"))entries.push([e.from,"remake",e.source_ref]);
  for(const e of B.edges.filter(e=>e.to===n.id&&e.relation==="trim"))entries.push([e.from,"trim",e.source_ref,e.start,e.end]);
  for(const e of B.edges.filter(e=>e.to===n.id&&e.relation==="draft_final"))entries.push([e.from,"draft_final",e.ref]);
  const guide=previsInput(n);
  if(guide)entries.push([guide.edge.from,"previs",guide.edge.ref]);
  for(const {edge} of audioInputs(n))entries.push([edge.from,"audio_ref",edge.ref,edge.start??0,edge.end??null]);
  videoInputs(n).forEach(({edge},i)=>entries.push([edge.from,"video_ref",edge.ref,i,edge.start??0,edge.end??null,edge.extension??null,!!edge.segment_edit]));
  return JSON.stringify(entries.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
function vtMergeInfo(ids){
  const nodes=[...new Set(ids)].map(node);
  if(nodes.length<2||nodes.some(n=>!n||n.type!=="video"||n.data.film||!n.versions.length||!curV(n)))return {error:"请选择至少两个已生成的普通视频"};
  if(nodes.some(nodeLocked))return {error:"请先解锁视频节点再合并 Tab"};
  if(nodes.some(n=>n.job||prepping.has(n.id)))return {error:"请等待这些视频的任务完成后再合并"};
  if(nodes.some(n=>!!n.data.previs!==!!nodes[0].data.previs))return {error:"白模预演和正式视频需要保留为独立节点"};
  if(nodes.some(n=>B.edges.some(e=>e.from===n.id&&!["remake","previs","video_ref","trim","capture","draft_final"].includes(e.relation))))return {error:"视频还有下游连线，先移除该连线再合并"};
  if(nodes.some(n=>vtSignature(n)!==vtSignature(nodes[0])))return {error:"输入或参考版本不同，不能合并为同一组 Tab"};
  const pinned=nodes.filter(n=>vtReferences(n.id));
  if(pinned.length>1)return {error:"多个视频分别被成片或分镜引用，请保留为独立节点"};
  return {nodes,pinned:pinned[0]};
}
function hasVideoRecipeInputs(recipe) {
  return !!recipe && (["images","audio_refs","video_refs"].some(key=>Array.isArray(recipe[key])) || !!recipe.previs_guide);
}
function vtRestoreVideoModel(data,version) {
  const recipe=version.video_recipe, recorded=version.generation_record?.settings;
  const saved=recipe?.provider && (recipe.selected_model || recipe.provider==="local_h3")
    ? {provider:recipe.provider,model:recipe.selected_model}
    : {provider:recorded?.provider,model:recorded?.provider_model};
  if (!saved.provider || (!saved.model && saved.provider!=="local_h3")) return;
  data.provider=saved.provider;
  if (saved.model) data.selected_model=saved.model;
  else delete data.selected_model;
}
function vtEdgesWithReferenceRanges(edges,recipe) {
  const references={audio_ref:recipe?.audio_refs,video_ref:recipe?.video_refs};
  return edges.map(edge=>{
    const entries=references[edge.relation];
    const match=Array.isArray(entries) && entries.find(input=>input.node_id===edge.from && input.ref===edge.ref);
    if (!match) return edge;
    return {...edge,...(Number.isFinite(match.start)?{start:match.start}:{}),
      ...(Number.isFinite(match.end)?{end:match.end}:{})};
  });
}
function videoRecipeEdges(n,r) {
  const end=(vidFrames(r.duration||n.data.duration)-4)/24;
  const edges=(r.images||[]).filter(im=>im.node_id).map((im,k)=>{
      const time=Number(im.time)||0,role=im.role==="subject"?"subject":r.planned?(time<=.01?"first":time>=end-.05?"last":"keyframe"):(k===0?"first":"last");
      const slot=promptSlot(im.prompt_slot);
      return {from:im.node_id,to:n.id,role,...(r.planned&&role!=="subject"?{time}:{}),
        ...(slot?{prompt_slot:slot}:{}),...((slot||im.pinned===true)&&im.ref?{ref:im.ref}:{})};
  });
  if (r.previs_guide) edges.push({from:r.previs_guide.node_id,to:n.id,relation:"previs",ref:r.previs_guide.ref});
  for (const [inputs,relation] of [[r.audio_refs,"audio_ref"],[r.video_refs,"video_ref"]]) {
    (inputs || []).forEach((input,i) => {
      const {node_id:from,ref,start,end} = input;
      const slot = promptSlot(input.prompt_slot);
      edges.push({from,to:n.id,ref,relation,...(slot?{prompt_slot:slot}:{}),
        start,end,...(relation==="video_ref"&&i===0&&r.extension?{extension:r.extension}:{}),
        ...(relation==="video_ref"&&i===0&&r.segment_edit?{segment_edit:true}:{})});
    });
  }
  return edges;
}

function vtSnapshot(n,i){
  const v=vtClone(n.versions[i]);
  if(v.draft_final?.source_ref&&!v.draft_final.source_node&&n.versions.some(source=>source.ref===v.draft_final.source_ref))
    v.draft_final.source_node=n.id;
  if(!Array.isArray(v.input_edges)){
    v.input_edges=hasVideoRecipeInputs(v.video_recipe)?videoRecipeEdges(n,v.video_recipe):vtClone(B.edges.filter(e=>e.to===n.id));
  } else {
    v.input_edges=vtEdgesWithReferenceRanges(v.input_edges,v.video_recipe);
  }
  if(!v.node_data){
    v.node_data=vtClone(n.data);const r=v.video_recipe;
    if(r){for(const k of ["prompt","duration","quality","seed","turbo","provider","selected_model","sound","music","fields","camera_plan","object_edit","draft","video_optics"])if(k in r)v.node_data[k]=vtClone(r[k]);
      if(!r.selected_model)delete v.node_data.selected_model;
      if(!r.camera_plan)delete v.node_data.camera_plan;
      if(!r.object_edit)delete v.node_data.object_edit;
      if(!r.video_optics)delete v.node_data.video_optics;
      if(!r.draft)delete v.node_data.draft;
      if(r.ar)v.node_data.aspect=Object.keys(AR).find(key=>Math.abs(AR[key]-r.ar)<.001) || "auto";
      v.node_data.mode=r.planned?"keyframes":"auto";v.node_data.pmode=r.fields?"fields":"free";}
  }
  vtRestoreVideoModel(v.node_data,v);
  v.label=v.label||n.name;
  v.tab_nodes=[...new Set([...(v.tab_nodes||[]),n.id])];
  v.tab_origin=v.tab_origin||{id:n.id,name:n.name,x:n.x,y:n.y,version_index:i,groups:(B.groups||[]).filter(g=>g.nodes.includes(n.id)).map(g=>g.id)};
  return v;
}
function vtRetargetVersion(v,id){return {...v,input_edges:(v.input_edges||[]).map(e=>({...e,to:id}))};}
function vtSetInputs(n){
  const v=curV(n),edges=(v?.input_edges||[]).filter(e=>e.from!==n.id&&validVideoInput(e)).map(e=>({...e,to:n.id}));
  B.edges=B.edges.filter(e=>e.to!==n.id).concat(vtClone(edges));
  if(v?.node_data)n.data=vtClone(v.node_data);
}
function vtFinish(ids){
  sel=new Set(ids);selEdge=null;rebuild();updateSel();drawEdges();drawMini();placeOverlays();save();
}
function vtMerge(ids,targetId,before=null){
  const info=vtMergeInfo(ids);if(info.error){toast(info.error,4000);return false;}
  const destination=info.nodes.find(n=>n.id===targetId)||info.nodes[0],keeper=info.pinned||destination;
  const others=info.nodes.filter(n=>n!==keeper),removed=new Set(others.map(n=>n.id));
  const versions=[keeper,...others].flatMap(n=>n.versions.map((_,i)=>vtRetargetVersion(vtSnapshot(n,i),keeper.id)));
  if(before){undoStack.push(before);redoStack.length=0;}else checkpoint();
  keeper.versions=versions;keeper.x=destination.x;keeper.y=destination.y;
  for(const n of others)for(const v of n.versions)vtMoveVideoSource(n.id,keeper.id,v.ref);
  B.nodes=B.nodes.filter(n=>!removed.has(n.id));B.edges=B.edges.filter(e=>!removed.has(e.from)&&!removed.has(e.to));
  for(const g of B.groups||[])g.nodes=[...new Set(g.nodes.map(id=>removed.has(id)?keeper.id:id))];
  vtFinish([keeper.id]);toast("已合并为 "+versions.length+" 个 Tab，右键 Tab 可拆出；支持撤销",4500);return true;
}
function vtMoveReferences(oldId,newId){
  for(const n of B.nodes){for(const c of n.data?.film?.clips||[])if(c.node===oldId&&(!n.data.playlist||!c.ref))c.node=newId;for(const s of n.data?.made||[])if(s.vid===oldId)s.vid=newId;}
}
function vtMoveVideoSource(oldId,newId,ref){
  const move=edges=>{
    for(const e of edges||[]){
      const pinned=["remake","trim","capture"].includes(e.relation)?e.source_ref:["previs","video_ref","draft_final"].includes(e.relation)?e.ref:null;
      if(pinned&&e.from===oldId&&pinned===ref)e.from=newId;
    }
  };
  move(B.edges);
  for(const n of B.nodes)if(n.data.playlist)for(const clip of n.data.film?.clips||[])
    if(clip.node===oldId&&clip.ref===ref)clip.node=newId;
  for(const n of B.nodes)for(const item of n.data?.film?.cutaways||[])
    if(item.node===oldId&&item.ref===ref)item.node=newId;
  for(const n of B.nodes)for(const history of [...n.versions,n.job?.history].filter(Boolean)){
    move(history.input_edges);
    if(history.draft_final?.source_node===oldId&&history.draft_final.source_ref===ref)history.draft_final.source_node=newId;
  }
  for(const n of B.nodes)for(const v of n.versions){
    if(Array.isArray(v.segment_review)){
      for(const choice of v.segment_review)if(choice?.node_id===oldId&&choice.ref===ref)choice.node_id=newId;
    }
    if(v.remake?.source_node===oldId&&v.remake.source_ref===ref)v.remake.source_node=newId;
    if(v.capture?.source_node===oldId&&v.capture.source_ref===ref)v.capture.source_node=newId;
    for(const clips of [v.film_recipe?.clips,v.film_recipe?.timeline?.clips,v.film_recipe?.cutaways,
      v.film_recipe?.timeline?.cutaways,v.node_data?.film?.cutaways])
      for(const clip of clips||[])if(clip.node===oldId&&clip.ref===ref)clip.node=newId;
    const guide=v.video_recipe?.previs_guide;
    if(guide?.node_id===oldId&&guide.ref===ref)guide.node_id=newId;
    for(const input of v.video_recipe?.video_refs||[])if(input.node_id===oldId&&input.ref===ref)input.node_id=newId;
    for(const input of v.generation_record?.inputs||[])if(["previs","video_ref"].includes(input.role)&&input.node_id===oldId&&input.ref===ref)input.node_id=newId;
  }
}
function vtSplit(id,index,all=false){
  const n=node(id);
  if(!n||n.type!=="video"||n.data.film||n.versions.length<2)return false;
  if(n.job||prepping.has(id)){toast("请等待视频任务完成后再拆开");return false;}
  if(!Number.isInteger(index)||!n.versions[index])return false;
  const versions=n.versions.map((_,i)=>vtSnapshot(n,i)),oldCur=n.cur;
  const moving=versions.map((v,i)=>({v,i})).filter(({i})=>all?i!==oldCur:i===index);
  const keep=versions.map((v,i)=>({v,i})).filter(({i})=>!moving.some(m=>m.i===i));
  const width=Math.max(...versions.map(v=>size({...n,versions:[v],cur:0}).w));
  checkpoint();const made=[];let y=n.y;
  for(const {v,i}of moving){
    const nid=newCanvasNodeId();
    const version=vtRetargetVersion(v,nid),m={id:nid,type:"video",name:(v.tab_origin?.name||v.label||n.name)+" · 版本 "+(i+1),
      x:n.x+width+CT_LAYOUT_GAP.x,y,data:vtClone(v.node_data||n.data),versions:[version],cur:0,job:null};
    made.push(m);y+=size(m).h+CT_LAYOUT_GAP.y;
    if(i===oldCur)vtMoveReferences(id,nid);
  }
  n.versions=keep.map(({v})=>vtRetargetVersion(v,n.id));n.cur=Math.max(0,keep.findIndex(k=>k.i===oldCur));
  vtSetInputs(n);
  const positions=ctAvoidObstacles(made.map(({id,x,y})=>({id,x,y})),made,B.nodes);
  for(const m of made){Object.assign(m,positions.find(p=>p.id===m.id));B.nodes.push(m);B.edges.push(...vtClone(m.versions[0].input_edges.filter(e=>node(e.from))));}
  for(const m of made){
    const ref=curV(m).ref;
    if(!n.versions.some(v=>v.ref===ref))vtMoveVideoSource(id,m.id,ref);
  }
  const originalGroups=new Set(versions.flatMap(v=>v.tab_origin?.groups||[]));
  for(const g of B.groups||[])if(g.nodes.includes(id)){
    if(originalGroups.has(g.id)&&!keep.some(({v})=>v.tab_origin?.groups?.includes(g.id)))g.nodes=g.nodes.filter(nid=>nid!==id);
    g.nodes.push(...made.filter(m=>!originalGroups.has(g.id)||m.versions[0].tab_origin?.groups?.includes(g.id)).map(m=>m.id));
  }
  vtFinish(made.map(m=>m.id));toast("已拆为独立视频节点，输入连线和参数已保留；支持撤销",4500);return true;
}
function vtResolve(id,ref){
  const direct=node(id),index=direct?.versions.findIndex(v=>v.ref===ref);
  if(direct&&(!ref||index>=0))return {node:direct,index:ref?index:direct.cur};
  for(const n of B.nodes){const i=n.versions.findIndex(v=>(v.tab_nodes||[]).includes(id)&&(!ref||v.ref===ref));if(i>=0)return {node:n,index:i};}
  return null;
}
function vtDropTarget(moving){
  if(moving.some(n=>n.type!=="video"))return null;
  const ids=moving.map(n=>n.id),candidates=B.nodes.filter(n=>n.type==="video"&&!ids.includes(n.id));let best=null,score=.55;
  for(const target of candidates){
    const t=size(target),overlap=Math.max(...moving.map(n=>{const s=size(n),w=Math.max(0,Math.min(n.x+s.w,target.x+t.w)-Math.max(n.x,target.x)),h=Math.max(0,Math.min(n.y+s.h,target.y+t.h)-Math.max(n.y,target.y));return w*h/Math.min(s.w*s.h,t.w*t.h);}));
    if(overlap<=score)continue;
    const accepted=target.data.playlist ? !target.job&&moving.every(playlistVideo) : !vtMergeInfo([...ids,target.id]).error;
    if(accepted){best=target;score=overlap;}
  }
  return best;
}
function vtMarkDrop(target){
  $$(".node.tab-merge-target").forEach(el=>el.classList.remove("tab-merge-target","playlist-drop-target"));
  if(target){const el=els.get(target.id);el?.classList.add("tab-merge-target");if(target.data.playlist)el?.classList.add("playlist-drop-target");}
}
function vtCanCopyVersion(n,index) {
  return canvasCanEdit() && node(n.id)===n && !n.job && !prepping.has(n.id) && !!n.versions[index]?.ref;
}

function vtCopyVersion(n,index,at=null) {
  if(!vtCanCopyVersion(n,index))return false;
  const v=n.type==="video"?vtSnapshot(n,index):vtClone(n.versions[index]);
  const data=vtClone(v.node_data||n.data);
  const receipt=v.generation_record;
  let inputs=[];
  if(n.type==="video") {
    inputs=v.input_edges.filter(e=>validVideoInput(e));
  } else if(n.type==="audio") {
    Object.assign(data,v.audio_recipe||{}, {prompt:v.audio_recipe?.prompt??v.prompt??""});
  } else {
    if (!v.node_data) data.prompt=v.prompt??receipt?.prompt??"";
    const settings=receipt?.settings||{};
    for(const key of ["model","provider","quality","seed"])if(settings[key]!=null)data[key]=settings[key];
    if(Number.isFinite(settings.ar))data.aspect=Object.keys(AR).find(key=>Math.abs(AR[key]-settings.ar)<.001)||"auto";
    if(Array.isArray(v.input_edges))inputs=v.input_edges.filter(edge=>node(edge.from)?.type==="image" ||
      v.node_data && node(edge.from)?.type==="text");
    else{
      const sources=new Set((receipt?.inputs||[]).filter(input=>{
        const source=node(input.node_id);
        return source?.type==="image" && input.ref && curV(source)?.ref===input.ref;
      }).map(input=>input.node_id));
      inputs=[...sources].map(from=>({from}));
    }
  }
  if(n.type!=="audio")data.count=1;
  if(data.previs_composition?.ref!==v.ref)delete data.previs_composition;
  delete data.asset;
  delete data.character_draft;
  delete v.tab_nodes;
  delete v.tab_origin;
  v.copied_from={node:n.id,ref:v.ref,version:index+1};
  if(v.node_data)v.node_data=vtClone(data);
  if(v.video_recipe)v.video_recipe.count=1;
  const dimensions=size({...n,data,versions:[v],cur:0});
  const point=at||{x:n.x+size(n).w+CT_LAYOUT_GAP.x,y:n.y};
  const spot=freeSpot(point.x,point.y,n.type,dimensions);
  checkpoint();
  const result=addNode(n.type,spot.x,spot.y,data,{name:n.name+" · 版本 "+(index+1),versions:[v],cur:0});
  const edges=inputs.map(e=>({...e,to:result.id}));
  v.input_edges=vtClone(edges);
  B.edges.push(...edges);
  drawEdges();selectOnly(result.id);save();
  toast("已复制为独立节点");
  return result;
}

function vtAdjacentIndex(n,index,direction) {
  const count=n.versions.length;
  return (Math.max(0,index)+direction+count)%count;
}

function vtWireTab(button,n) {
  const index=Number(button.dataset.i);
  button.onclick=event=>{
    event.stopPropagation();
    if(!button._versionDragged)switchVersion(n,index);
  };
  const menu=event=>{
    const rect=button.getBoundingClientRect();
    event.preventDefault();event.stopPropagation();
    vtTabMenu(n,index,event.clientX||rect.right,event.clientY||rect.bottom);
  };
  button.onkeydown=event=>{
    if(canvasCanEdit() && (event.key==="ContextMenu" || event.shiftKey&&event.key==="F10"))return menu(event);
    if(event.altKey || event.metaKey || event.ctrlKey || event.shiftKey)return;
    const offset={ArrowUp:-1,ArrowLeft:-1,ArrowDown:1,ArrowRight:1}[event.key];
    const target=event.key==="Home"?0:event.key==="End"?n.versions.length-1:offset?vtAdjacentIndex(n,index,offset):null;
    if(target===null)return;
    event.preventDefault();event.stopPropagation();
    if(switchVersion(n,target))els.get(n.id)?.querySelector(`.vtabs button[data-i="${target}"]`)?.focus();
  };
  if(!canvasCanEdit())return;
  button.oncontextmenu=menu;
  button.onpointerdown=event=>{
    if(event.button!==0 || !vtCanCopyVersion(n,index))return;
    const board=B, version=n.versions[index], x=event.clientX,y=event.clientY;
    let ghost=null;
    const destination=e=>{
      const element=document.elementFromPoint?.(e.clientX,e.clientY);
      if(element===vp || element===world || element===svg)return {copy:true};
      const target=node(element?.closest(".node")?.dataset.id);
      if(target && !target.job && !prepping.has(target.id) && canPromptMedia(n,target,version.ref))return {target};
      return null;
    };
    const move=e=>{
      if(!ghost && Math.hypot(e.clientX-x,e.clientY-y)<6)return;
      if(!ghost) {
        ghost=document.createElement("div");
        ghost.className="version-drag-label";
        ghost.setAttribute("aria-hidden","true");
        document.body.append(ghost);
      }
      const drop=destination(e);
      ghost.classList.toggle("can-drop",!!drop);
      ghost.textContent=drop?.target?"用作参考 · 版本 "+(index+1):"版本 "+(index+1);
      Object.assign(ghost.style,{left:e.clientX+12+"px",top:e.clientY+12+"px"});
    };
    const stop=e=>{
      removeEventListener("pointermove",move);
      removeEventListener("pointerup",stop);
      removeEventListener("pointercancel",stop);
      if(!ghost)return;
      ghost.remove();button._versionDragged=true;
      setTimeout(()=>button._versionDragged=false,0);
      if(e.type!=="pointerup" || B!==board || n.versions[index]!==version || !vtCanCopyVersion(n,index))return;
      const drop=destination(e);
      if(drop?.target){
        if(isSeedAudio(drop.target))addSeedAudioReference(drop.target,n,version);
        else bindPromptMedia(n,drop.target,version.ref);
      }
      else if(drop?.copy)vtCopyVersion(n,index,toW(e.clientX,e.clientY));
    };
    if(Number.isInteger(event.pointerId))button.setPointerCapture(event.pointerId);
    addEventListener("pointermove",move);
    addEventListener("pointerup",stop);
    addEventListener("pointercancel",stop);
  };
}

function vtTabMenu(n,index,x,y){
  closeMenus();let m=$("#videoTabMenu");if(!m){m=document.createElement("div");m.id="videoTabMenu";m.className="menu";document.body.append(m);}
  m.innerHTML=OneShotI18n.html`<div class="mt">${TYPE_CN[n.type]}版本 ${index+1}</div><button data-version-copy>${ico("copy")}复制此版本为独立节点</button>`+
    (hasGenerationDraft(n,n.versions[index])?`<button data-version-draft>${ico("edit")}用此版本改稿</button>`:"")+
    (canReuseGenerationAssets(n,n.versions[index])?`<button data-version-replay-assets>${ico("assets")}沿用原资产改稿</button>`:"")+
    (canvasCanEdit()&&n.versions[index]?.ref?`<button data-version-reference>${ico("script")}引用此版本到创作助手</button>
      <button data-version-new-session>${ico("script")}用此版本发起新对话</button>`:"")+
    (vtCanCopyVersion(n,index)&&vtReferenceUpdates(n,n.versions[index]).length?`<button data-version-update>${ico("next")}更新下游引用…</button>`:"")+
    (n.type==="video"&&!n.data.film?`<button data-split>${ico("next")}拆出这个 Tab</button><button data-all>${ico("assets")}拆开所有 Tab</button>`:"");
  const version=n.versions[index];
  $$("button",m).forEach(b=>{
    if(b.hasAttribute("data-version-draft") || b.hasAttribute("data-version-replay-assets")){
      const reuseAssets=b.hasAttribute("data-version-replay-assets");
      b.onclick=()=>{closeMenus();if (loadGenerationDraft(n,version,toast,{reuseAssets})) focusNodePrompt(n);};
      return;
    }
    if(b.hasAttribute("data-version-new-session")){
      b.onclick=boardAction(()=>{closeMenus();return acNewNodeSession([{id:n.id,ref:version.ref}]);});
      return;
    }
    if(b.hasAttribute("data-version-update")){
      b.onclick=()=>{closeMenus();if(n.versions[index]===version)vtOpenReferenceUpdate(n,index);};
      return;
    }
    if(b.hasAttribute("data-version-reference")){
      b.onclick=boardAction(async()=>{
        closeMenus();
        const bid=boardId;
        await acOpen();
        if(boardId===bid && node(n.id)===n)acAttachNodeReference(n,version.ref);
      });
      return;
    }
    b.disabled=!vtCanCopyVersion(n,index);
    b.onclick=()=>{
      closeMenus();
      if(n.versions[index]!==version || !vtCanCopyVersion(n,index))return;
      if(b.hasAttribute("data-version-copy"))vtCopyVersion(n,index);
      else vtSplit(n.id,index,b.hasAttribute("data-all"));
    };
  });
  m.classList.add("on");m.style.left=Math.max(8,Math.min(x,innerWidth-m.offsetWidth-8))+"px";m.style.top=Math.max(8,Math.min(y,innerHeight-m.offsetHeight-8))+"px";
}
