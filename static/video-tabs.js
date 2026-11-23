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
      return {from:im.node_id,to:n.id,role,...(r.planned&&role!=="subject"?{time}:{})};
    });}else v.input_edges=vtClone(B.edges.filter(e=>e.to===n.id));
  }
  if(!v.node_data){
    v.node_data=vtClone(n.data);const r=v.video_recipe;
    if(r){for(const k of ["prompt","duration","quality","seed","turbo","provider","sound","music","fields","camera_plan","object_edit","draft"])if(k in r)v.node_data[k]=vtClone(r[k]);
      if(!r.camera_plan)delete v.node_data.camera_plan;
      if(!r.object_edit)delete v.node_data.object_edit;
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

function vtReferenceUpdates(source, version) {
  if(!version?.ref || source.type==="video"&&version.source==="previs")return [];
  const updates=[];
  for(const edge of B.edges){
    if(edge.from!==source.id || edge.ref===version.ref || edge.segment_edit || edge.extension)continue;
    const target=node(edge.to);
    if(!target || nodeLocked(target) || target.job || prepping.has(target.id) || target.data.film || target.data.previs)continue;
    const relation=edge.relation;
    if(relation==="seed_audio_ref" && isSeedAudio(target)){
      const refs=seedAudioRefs(target), fromSource=refs.filter(ref=>ref.node_id===source.id);
      if(fromSource.length!==1 || refs.some(ref=>ref.ref===version.ref))continue;
      updates.push({target,edge,prior:edge.ref,seedRef:fromSource[0]});
    }else if((source.type==="image"&&!relation&&["image","video"].includes(target.type)) ||
             (target.type==="video"&&["audio","video"].includes(source.type)&&relation===source.type+"_ref")){
      updates.push({target,edge,prior:edge.ref??curV(source)?.ref});
    }
  }
  return updates;
}

function vtOpenReferenceUpdate(source,index){
  if(!vtCanCopyVersion(source,index))return;
  const board=B, version=source.versions[index];
  let dialog=$("#versionRefUpdate");
  if(!dialog){
    document.body.insertAdjacentHTML("beforeend",`<dialog id="versionRefUpdate" aria-labelledby="versionRefTitle"><form>
      <header><strong id="versionRefTitle">更新下游引用</strong></header>
      <p data-summary></p><ol></ol>
      <footer><button type="button" data-cancel>取消</button><button type="submit">应用版本</button></footer>
    </form></dialog>`);
    dialog=$("#versionRefUpdate");
    dialog.onkeydown=event=>event.stopPropagation();
  }
  const form=$("form",dialog), list=$("ol",form), summary=$("[data-summary]",form), apply=$('[type="submit"]',form);
  const cancel=$("[data-cancel]",form);
  const close=()=>{if(dialog.close)dialog.close();else dialog.removeAttribute("open");};
  cancel.onclick=close;
  let updates;
  const preview=()=>{
    updates=vtReferenceUpdates(source,version);
    summary.textContent=updates.length?`${source.name} · 版本 ${index+1} · 更新 ${new Set(updates.map(u=>u.target.id)).size} 个节点`:
      "没有可更新的下游引用";
    list.innerHTML=updates.map(({target,edge,prior})=>{
      const old=source.versions.findIndex(v=>v.ref===prior)+1;
      const priorLabel=edge.ref?(old?"版本 "+old:"原引用"):"跟随当前版本";
      const details=[priorLabel+" → 版本 "+(index+1),edge.relation==="video_ref"&&(edge.start!=null||edge.end!=null)?"参考区间将重置":""];
      return `<li>${esc(target.name)}<span>${esc(details.filter(Boolean).join(" · "))}</span></li>`;
    }).join("");
    apply.disabled=!updates.length;
  };
  form.onsubmit=event=>{
    event.preventDefault();
    if(B!==board || !vtCanCopyVersion(source,index) || source.versions[index]!==version){close();return;}
    const current=vtReferenceUpdates(source,version);
    if(current.length!==updates.length || current.some((u,i)=>u.edge!==updates[i].edge||u.prior!==updates[i].prior)){
      preview();summary.textContent+="。连线已更新，请再次核对。";return;
    }
    if(!current.length)return;
    checkpoint();
    const changed=new Set();
    for(const {target,edge,seedRef} of current){
      if(!changed.has(target))rememberVideoVersion(target);
      changed.add(target);
      if(seedRef)target.data.references=seedAudioRefs(target).map(ref=>ref===seedRef?{...ref,ref:version.ref}:ref);
      else {
        edge.ref=version.ref;
        if(edge.relation==="video_ref"){delete edge.start;delete edge.end;}
      }
    }
    changed.forEach(render);
    if(sel.size===1 && changed.has(node([...sel][0])))showPanel();
    drawEdges();save();close();
    toast(`已更新 ${changed.size} 个下游节点的参考`);
  };
  preview();
  if(dialog.showModal)dialog.showModal();else dialog.setAttribute("open","");
  cancel.focus();
}

function vtTabMenu(n,index,x,y){
  closeMenus();let m=$("#videoTabMenu");if(!m){m=document.createElement("div");m.id="videoTabMenu";m.className="menu";document.body.append(m);}
  m.innerHTML=`<div class="mt">${TYPE_CN[n.type]}版本 ${index+1}</div><button data-version-copy>${ico("copy")}复制此版本为独立节点</button>`+
    (canvasCanEdit()&&n.versions[index]?.ref?`<button data-version-reference>${ico("script")}引用此版本到创作助手</button>`:"")+
    (vtCanCopyVersion(n,index)&&vtReferenceUpdates(n,n.versions[index]).length?`<button data-version-update>${ico("next")}更新下游引用…</button>`:"")+
    (n.type==="video"&&!n.data.film?`<button data-split>${ico("next")}拆出这个 Tab</button><button data-all>${ico("assets")}拆开所有 Tab</button>`:"");
  const version=n.versions[index];
  $$("button",m).forEach(b=>{
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
