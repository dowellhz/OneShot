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
  const guide=previsInput(n);
  if(guide)entries.push([guide.edge.from,"previs",guide.edge.ref]);
  for(const {edge} of audioInputs(n))entries.push([edge.from,"audio_ref",edge.ref]);
  videoInputs(n).forEach(({edge},i)=>entries.push([edge.from,"video_ref",edge.ref,i,edge.start??0,edge.end??null,edge.extension??null,!!edge.segment_edit]));
  return JSON.stringify(entries.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
function vtMergeInfo(ids){
  const nodes=[...new Set(ids)].map(node);
  if(nodes.length<2||nodes.some(n=>!n||n.type!=="video"||n.data.film||!n.versions.length||!curV(n)))return {error:"请选择至少两个已生成的普通视频"};
  if(nodes.some(nodeLocked))return {error:"请先解锁视频节点再合并 Tab"};
  if(nodes.some(n=>n.job||prepping.has(n.id)))return {error:"请等待这些视频的任务完成后再合并"};
  if(nodes.some(n=>!!n.data.previs!==!!nodes[0].data.previs))return {error:"白模预演和正式视频需要保留为独立节点"};
  if(nodes.some(n=>B.edges.some(e=>e.from===n.id&&!["remake","previs","video_ref","trim","capture"].includes(e.relation))))return {error:"视频还有下游连线，先移除该连线再合并"};
  if(nodes.some(n=>vtSignature(n)!==vtSignature(nodes[0])))return {error:"输入或参考版本不同，不能合并为同一组 Tab"};
  const pinned=nodes.filter(n=>vtReferences(n.id));
  if(pinned.length>1)return {error:"多个视频分别被成片或分镜引用，请保留为独立节点"};
  return {nodes,pinned:pinned[0]};
}
function vtSnapshot(n,i){
  const v=vtClone(n.versions[i]);
  if(!Array.isArray(v.input_edges)){
    const r=v.video_recipe,images=r?.images?.filter(im=>im.node_id);
    if(images?.length){const end=(vidFrames(r.duration||n.data.duration)-4)/24;v.input_edges=images.map((im,k)=>{
      const time=Number(im.time)||0,role=im.role==="subject"?"subject":r.planned?(time<=.01?"first":time>=end-.05?"last":"keyframe"):(k===0?"first":"last");
      const promptSlot=Number.isInteger(im.prompt_slot)&&im.prompt_slot>0;
      return {from:im.node_id,to:n.id,role,...(r.planned&&role!=="subject"?{time}:{}),
        ...(promptSlot?{prompt_slot:im.prompt_slot}:{}),...((promptSlot||im.pinned===true)&&im.ref?{ref:im.ref}:{})};
    });}else v.input_edges=vtClone(B.edges.filter(e=>e.to===n.id));
  }
  if(!v.node_data){
    v.node_data=vtClone(n.data);const r=v.video_recipe;
    if(r){for(const k of ["prompt","duration","quality","seed","turbo","provider","sound","music","fields","camera_plan","object_edit","draft","video_optics"])if(k in r)v.node_data[k]=vtClone(r[k]);
      if(!r.camera_plan)delete v.node_data.camera_plan;
      if(!r.object_edit)delete v.node_data.object_edit;
      if(!r.video_optics)delete v.node_data.video_optics;
      if(!r.draft)delete v.node_data.draft;
      if(r.ar)v.node_data.aspect=r.ar+":1";v.node_data.mode=r.planned?"keyframes":"auto";v.node_data.pmode=r.fields?"fields":"free";}
  }
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
      const pinned=["remake","trim","capture"].includes(e.relation)?e.source_ref:["previs","video_ref"].includes(e.relation)?e.ref:null;
      if(pinned&&e.from===oldId&&pinned===ref)e.from=newId;
    }
  };
  move(B.edges);
  for(const n of B.nodes)if(n.data.playlist)for(const clip of n.data.film?.clips||[])
    if(clip.node===oldId&&clip.ref===ref)clip.node=newId;
  for(const n of B.nodes)for(const item of n.data?.film?.cutaways||[])
    if(item.node===oldId&&item.ref===ref)item.node=newId;
  for(const n of B.nodes)for(const v of n.versions){
    move(v.input_edges);
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
    data.prompt=v.prompt??receipt?.prompt??"";
    const settings=receipt?.settings||{};
    for(const key of ["model","provider","quality","seed"])if(settings[key]!=null)data[key]=settings[key];
    if(Number.isFinite(settings.ar))data.aspect=Object.keys(AR).find(key=>Math.abs(AR[key]-settings.ar)<.001)||"auto";
    if(Array.isArray(v.input_edges))inputs=v.input_edges.filter(edge=>node(edge.from)?.type==="image");
    else{
      const sources=new Set((receipt?.inputs||[]).filter(input=>{
        const source=node(input.node_id);
        return source?.type==="image" && input.ref && curV(source)?.ref===input.ref;
      }).map(input=>input.node_id));
      inputs=[...sources].map(from=>({from}));
    }
  }
  if(n.type!=="audio")data.count=1;
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
    const last=n.versions.length-1, offset={ArrowUp:-1,ArrowLeft:-1,ArrowDown:1,ArrowRight:1}[event.key];
    const target=event.key==="Home"?0:event.key==="End"?last:offset?(index+offset+last+1)%(last+1):null;
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

function vtReferenceSources(source) {
  if(!["image","video","audio"].includes(source.type))return [];
  return B.nodes.filter(candidate=>candidate!==source && candidate.type===source.type &&
    !candidate.job && !prepping.has(candidate.id) &&
    candidate.versions.some(v=>v.ref && v.source!=="previs"));
}

function vtReferenceAncestors(source) {
  const parents=new Map();
  for(const {from,to} of B.edges){
    if(!parents.has(to))parents.set(to,[]);
    parents.get(to).push(from);
  }
  const ancestors=new Set([source.id]);
  for(const id of ancestors)for(const parent of parents.get(id)||[])ancestors.add(parent);
  return ancestors;
}

function vtGenerationReference(edge,source,target) {
  if(!source || !target || edge.segment_edit || edge.extension || target.data.film || target.data.previs)return false;
  return edge.relation==="seed_audio_ref"&&isSeedAudio(target) ||
    source.type==="image"&&!edge.relation&&["image","video"].includes(target.type) ||
    target.type==="video"&&["audio","video"].includes(source.type)&&edge.relation===source.type+"_ref";
}

function vtGroupReferenceSources(group) {
  const targets=new Set(group.nodes), sources=new Set();
  for(const edge of B.edges){
    if(!targets.has(edge.to))continue;
    const source=node(edge.from);
    if(vtGenerationReference(edge,source,node(edge.to)))sources.add(source);
  }
  return [...sources];
}

function vtReferenceUpdates(source, version, replacement=source, {group=null,targets=null}={}) {
  if(!version?.ref || source.type==="video"&&version.source==="previs")return [];
  const moving=replacement!==source;
  const members=group?new Set(group.nodes):null;
  const ancestors=moving?vtReferenceAncestors(replacement):new Set();
  const existing=moving?new Set(B.edges.filter(e=>e.from===replacement.id).map(e=>e.to)):new Set();
  const updates=[];
  for(const edge of B.edges){
    if(edge.from!==source.id || !moving&&edge.ref===version.ref ||
      members&&!members.has(edge.to) || targets&&!targets.has(edge.to))continue;
    if(ancestors.has(edge.to)||existing.has(edge.to))continue;
    const target=node(edge.to);
    if(!vtGenerationReference(edge,source,target) || nodeLocked(target) || target.job || prepping.has(target.id))continue;
    const relation=edge.relation;
    if(relation==="seed_audio_ref"){
      const refs=seedAudioRefs(target), fromSource=refs.filter(ref=>ref.node_id===source.id);
      if(fromSource.length!==1 || refs.some(ref=>ref.ref===version.ref))continue;
      updates.push({target,edge,prior:edge.ref,seedRef:fromSource[0]});
    }else {
      const prior=edge.ref??curV(source)?.ref;
      const resetRange=relation==="video_ref"&&prior!==version.ref;
      updates.push({target,edge,prior,resetRange,start:edge.start,end:edge.end});
    }
  }
  return updates;
}

function vtLibraryReferences(items, kind) {
  const choices=[];
  for(const asset of items){
    const media=new Map((asset.media||[]).map(m=>[m.ref,m]));
    const views=asset.kind==="character"?asset.character_views||{}:{};
    const primary=kind==="image"?(views.main||asset.ref):libraryPrimary(asset)?.ref;
    const labelled=new Map();
    if(primary)labelled.set(primary,views.main===primary?CHARACTER_VIEWS.main[0]:"");
    for(const [slot,[label]] of Object.entries(CHARACTER_VIEWS)){
      if(views[slot]&&!labelled.has(views[slot]))labelled.set(views[slot],label);
    }
    let number=0;
    for(const ref of media.keys())if(!labelled.has(ref)&&cmMediaType(ref,media.get(ref))===kind){
      labelled.set(ref,"素材 "+(++number));
    }
    for(const [ref,label] of labelled){
      const item=media.get(ref)||{ref};
      if(cmMediaType(ref,item)!==kind)continue;
      const spec=libraryNodeSpec(asset,item);
      if(ref!==primary&&label)spec.name=`${asset.name} · ${label}`;
      choices.push({spec,label:[asset.name,label,cmScopeLabel(asset)].filter(Boolean).join(" · "),
        search:[asset.name,label,cmKind(asset),...(asset.aliases||[]),...(asset.tags||[])].join(" ").toLocaleLowerCase()});
    }
  }
  return choices;
}

function vtOpenReferenceUpdate(source,index,group=null,preset=null){
  if(!canvasCanEdit())return;
  const originals=group?(B.groups||[]).includes(group)?vtGroupReferenceSources(group):[]:[source];
  const planned=preset?.replacement && vtReferenceSources(source).find(n=>n.id===preset.replacement);
  const plannedIndex=planned?(planned.versions[preset.version-1]?.ref===preset.ref?preset.version-1:
    planned.versions.findIndex(v=>v.ref===preset.ref)):-1;
  if(preset && (!originals.includes(source) || !preset.spec&&
    (!planned || plannedIndex<0 || planned.versions[plannedIndex].source==="previs"))){
    toast("原素材、替换版本或组内引用已变化，请重新准备方案");return;
  }
  if(!originals.length)return;
  const originalId=source?.id;
  const scope={group,targets:preset?.targets?new Set(preset.targets):null};
  source=originals[0];
  if(node(source.id)!==source)return;
  const choosing=index===undefined, board=B, epoch=boardOpenEpoch;
  if(!choosing&&!vtCanCopyVersion(source,index))return;
  let dialog=$("#versionRefUpdate");
  if(!dialog){
    document.body.insertAdjacentHTML("beforeend",`<dialog id="versionRefUpdate" aria-labelledby="versionRefTitle"><form>
      <header><strong id="versionRefTitle">更新下游引用</strong></header>
      <div data-choose-source hidden>
        <label data-original hidden>原素材<select name="original"></select></label>
        <label>替换素材<select name="replacement"></select></label>
        <label>素材版本<select name="replacementVersion"></select></label>
        <div class="vt-ref-actions">
          <button type="button" data-library-source aria-expanded="false">从资产库选择</button>
          <button type="button" data-upload-source>上传替换素材</button><input type="file" name="replacementFile" hidden>
        </div>
        <section data-library-picker hidden aria-label="资产库">
          <input type="search" aria-label="搜索资产" placeholder="搜索名称、别名或标签">
          <select aria-label="选择库中素材"></select>
          <div role="status"></div>
        </section>
        <div data-reference-media hidden></div>
        <div data-upload-status role="status" hidden></div>
      </div>
      <p data-summary></p><ol></ol>
      <footer><button type="button" data-cancel>取消</button><button type="submit">应用版本</button>
        <button type="submit" data-review-run hidden>替换并查看运行计划</button></footer>
    </form></dialog>`);
    dialog=$("#versionRefUpdate");
    dialog.onkeydown=event=>event.stopPropagation();
  }
  const form=$("form",dialog), list=$("ol",form), summary=$("[data-summary]",form), apply=$('[type="submit"]',form);
  const reviewRun=$("[data-review-run]",form);
  const cancel=$("[data-cancel]",form);
  const controls=$("[data-choose-source]",form);
  const original=$('[name="original"]',form);
  const sources=$('[name="replacement"]',form), versions=$('[name="replacementVersion"]',form);
  const uploadButton=$("[data-upload-source]",form), fileInput=$('[name="replacementFile"]',form);
  const uploadStatus=$("[data-upload-status]",form);
  const libraryButton=$("[data-library-source]",form), library=$("[data-library-picker]",form);
  const query=$("input",library), libraryChoices=$("select",library), libraryStatus=$("[role=status]",library);
  const mediaPreview=$("[data-reference-media]",form);
  const isCurrent=()=>B===board && boardOpenEpoch===epoch && canvasCanEdit() &&
    (!group||(B.groups||[]).includes(group)) && node(source.id)===source;
  const close=()=>{if(dialog.close)dialog.close();else dialog.removeAttribute("open");};
  dialog.onclose=()=>{if(!dialog.open)mediaPreview.replaceChildren();};
  cancel.onclick=close;
  $("#versionRefTitle",dialog).textContent=group?`${group.name} · 替换参考素材`:choosing?"替换下游参考":"更新下游引用";
  controls.hidden=!choosing;
  original.parentElement.hidden=!group;
  apply.textContent=choosing?"替换引用":"应用版本";
  reviewRun.hidden=!group;
  let replacement=source, version=source.versions[index], uploading=false;
  let staged=preset?.spec?{...preset.spec,id:newCanvasNodeId()}:null;
  let updates;
  const preview=()=>{
    updates=replacement?vtReferenceUpdates(source,version,replacement,scope):[];
    const change=choosing?`${source.name} → ${replacement?.name??""}`:source.name;
    summary.textContent=!replacement?"从资产库选择素材，或上传替换文件":
      updates.length?`${change} · 版本 ${index+1} · 更新 ${new Set(updates.map(u=>u.target.id)).size} 个节点`:
      "没有可更新的下游引用";
    list.innerHTML=updates.map(({target,edge,prior,resetRange,start,end})=>{
      const old=source.versions.findIndex(v=>v.ref===prior)+1;
      const priorLabel=edge.ref?(old?"版本 "+old:"原引用"):"跟随当前版本";
      const details=[priorLabel+" → 版本 "+(index+1),resetRange&&(start!=null||end!=null)?"参考区间将重置":""];
      return `<li>${esc(target.name)}<span>${esc(details.filter(Boolean).join(" · "))}</span></li>`;
    }).join("");
    apply.disabled=reviewRun.disabled=uploading||!updates.length;
  };
  if(choosing){
    let candidates=[];
    const options=nodes=>nodes.map(n=>`<option value="${esc(n.id)}">${esc(n.name)}${n!==staged?"":n.data.asset?"（资产库）":"（新上传）"}</option>`).join("");
    const showMedia=()=>{
      const v=replacement===staged&&version?.source==="asset"?version:null;
      mediaPreview.hidden=!v;
      mediaPreview.replaceChildren();
      if(!v)return;
      const player=document.createElement(staged.type==="image"?"img":staged.type);
      if(staged.type==="image")player.alt=staged.name;
      else {player.controls=true;player.preload="none";}
      player.src=v.url;
      mediaPreview.append(player);
    };
    versions.onchange=()=>{
      index=Number(versions.value);
      version=replacement.versions[index];
      preview();
      showMedia();
    };
    sources.onchange=()=>{
      replacement=candidates.find(n=>n.id===sources.value);
      versions.disabled=!replacement;
      versions.innerHTML=(replacement?.versions||[]).map((v,i)=>v.ref&&v.source!=="previs"?
        `<option value="${i}">版本 ${i+1}${i===replacement.cur?"（当前）":""}</option>`:"").join("");
      if(!replacement){version=null;preview();showMedia();return;}
      if([...versions.options].some(option=>Number(option.value)===replacement.cur))versions.value=String(replacement.cur);
      versions.onchange();
    };
    original.innerHTML=options(originals);
    const refreshCandidates=selected=>{
      candidates=vtReferenceSources(source);
      if(staged?.type===source.type)candidates.unshift(staged);
      sources.disabled=!candidates.length;
      sources.innerHTML=options(candidates);
      if(selected)sources.value=selected;
      sources.onchange();
    };
    const setUploadStatus=message=>{
      uploadStatus.textContent=message;
      uploadStatus.hidden=!message;
    };
    const setUploading=busy=>{
      uploading=busy;
      original.disabled=uploadButton.disabled=libraryButton.disabled=busy;
      apply.disabled=reviewRun.disabled=busy||!updates?.length;
    };
    let choices=[], request=0;
    const setLibraryOpen=open=>{
      library.hidden=!open;
      libraryButton.setAttribute("aria-expanded",String(open));
      if(!open)request++;
    };
    const drawLibrary=()=>{
      const search=query.value.trim().toLocaleLowerCase();
      libraryChoices.replaceChildren(new Option("选择素材…",""));
      for(const [i,choice] of choices.entries()){
        if(!search||choice.search.includes(search))libraryChoices.add(new Option(choice.label,String(i)));
      }
      const empty=libraryChoices.options.length===1;
      libraryChoices.disabled=empty;
      libraryStatus.textContent=empty?(choices.length?"没有匹配的素材":"资产库中没有同类型的素材"):"";
    };
    query.oninput=drawLibrary;
    libraryChoices.onchange=()=>{
      if(!libraryChoices.value || !isCurrent() || uploading)return;
      staged={...choices[Number(libraryChoices.value)].spec,id:newCanvasNodeId()};
      refreshCandidates(staged.id);
      setLibraryOpen(false);
      libraryButton.focus();
    };
    const openLibrary=async()=>{
      if(!library.hidden){setLibraryOpen(false);return;}
      setLibraryOpen(true);
      query.value="";
      query.disabled=libraryChoices.disabled=true;
      libraryChoices.replaceChildren();
      libraryStatus.textContent="正在读取资产库…";
      const token=++request;
      const active=()=>dialog.open && isCurrent() && libraryButton.onclick===openLibrary && request===token;
      try{
        const items=await boardRequest("/api/memory?board="+encodeURIComponent(boardId));
        if(!active())return;
        choices=vtLibraryReferences(items,source.type);
        query.disabled=false;
        drawLibrary();
        query.focus();
      }catch(error){
        if(active())libraryStatus.textContent=error.message;
      }
    };
    libraryButton.onclick=openLibrary;
    const accepted={image:".png,.jpg,.jpeg,.webp",video:".mp4,.mov,.webm,.m4v,.mkv",audio:".wav,.mp3,.m4a,.aac,.flac,.ogg"};
    original.onchange=()=>{
      source=originals.find(n=>n.id===original.value);
      fileInput.accept=accepted[source.type];
      setUploadStatus("");
      setLibraryOpen(false);
      refreshCandidates();
    };
    uploadButton.onclick=()=>{setLibraryOpen(false);fileInput.click();};
    const upload=async()=>{
      const file=fileInput.files[0], kind=source.type;
      fileInput.value="";
      if(!file||uploading||!isCurrent())return;
      if(canvasUploadKind(file)!==kind){setUploadStatus(`请选择${TYPE_CN[kind]}文件`);return;}
      setUploading(true);
      setUploadStatus(`正在上传 ${file.name}…`);
      const active=()=>dialog.open && fileInput.onchange===upload && isCurrent();
      try{
        const media=await readCanvasFile(file,kind);
        if(!active())return;
        if(!media.version?.ref)throw new Error("未取得素材引用");
        staged={id:newCanvasNodeId(),type:kind,name:media.name||TYPE_CN[kind],data:media.data,versions:[media.version],cur:0};
        setUploadStatus("");
        refreshCandidates(staged.id);
      }catch(error){
        if(active())setUploadStatus("上传失败："+error.message);
      }finally{
        if(active())setUploading(false);
      }
    };
    fileInput.onchange=upload;
    setUploading(false);
    if(preset)original.value=originalId;
    original.onchange();
    if(preset){
      sources.value=planned?planned.id:staged.id;
      sources.onchange();
      versions.value=String(planned?plannedIndex:staged.cur);
      versions.onchange();
    }
  }else {
    fileInput.onchange=null;
    mediaPreview.replaceChildren();
    mediaPreview.hidden=true;
    preview();
  }
  form.onsubmit=event=>{
    event.preventDefault();
    if(uploading || !replacement)return;
    const adding=replacement===staged;
    if(!isCurrent() || (!adding&&!vtCanCopyVersion(replacement,index)) || replacement.versions[index]!==version){close();return;}
    const current=vtReferenceUpdates(source,version,replacement,scope);
    if(current.length!==updates.length || current.some((u,i)=>u.edge!==updates[i].edge||u.target!==updates[i].target||
      u.prior!==updates[i].prior||u.seedRef!==updates[i].seedRef||u.start!==updates[i].start||u.end!==updates[i].end)){
      preview();summary.textContent+="。连线已更新，请再次核对。";return;
    }
    if(!current.length)return;
    checkpoint();
    if(adding){
      const bounds=CT_FOLD_BOXES.get(ctFolded(source.id)?.id)||source;
      const dimensions=size({...staged,data:{...defaults(staged.type),...staged.data}});
      const spot=freeSpot(bounds.x-dimensions.w-110,bounds.y,staged.type,dimensions);
      buildCanvasMediaNode(staged,spot);
      void loadAssets();
    }
    const changed=new Set();
    for(const {target,edge,seedRef,resetRange} of current){
      if(!changed.has(target))rememberVideoVersion(target);
      changed.add(target);
      if(seedRef)target.data.references=seedAudioRefs(target).map(ref=>ref===seedRef?{...ref,node_id:replacement.id,ref:version.ref}:ref);
      else {
        edge.from=replacement.id;
        edge.ref=version.ref;
        if(resetRange){delete edge.start;delete edge.end;}
      }
    }
    changed.forEach(render);
    if(sel.size===1 && changed.has(node([...sel][0])))showPanel();
    drawEdges();save();close();
    toast(`已更新 ${changed.size} 个下游节点的参考`);
    if(group&&event.submitter===reviewRun)openCanvasGroupRun(group,{changed:new Set([...changed].map(target=>target.id))});
  };
  if(dialog.showModal)dialog.showModal();else dialog.setAttribute("open","");
  (group?original:!choosing?cancel:sources.disabled?uploadButton:sources).focus();
}

function vtTabMenu(n,index,x,y){
  closeMenus();let m=$("#videoTabMenu");if(!m){m=document.createElement("div");m.id="videoTabMenu";m.className="menu";document.body.append(m);}
  m.innerHTML=`<div class="mt">${TYPE_CN[n.type]}版本 ${index+1}</div><button data-version-copy>${ico("copy")}复制此版本为独立节点</button>`+
    (canvasCanEdit()&&n.versions[index]?.ref?`<button data-version-reference>${ico("script")}引用此版本到创作助手</button>
      <button data-version-new-session>${ico("script")}用此版本发起新对话</button>`:"")+
    (vtCanCopyVersion(n,index)&&vtReferenceUpdates(n,n.versions[index]).length?`<button data-version-update>${ico("next")}更新下游引用…</button>`:"")+
    (n.type==="video"&&!n.data.film?`<button data-split>${ico("next")}拆出这个 Tab</button><button data-all>${ico("assets")}拆开所有 Tab</button>`:"");
  const version=n.versions[index];
  $$("button",m).forEach(b=>{
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
