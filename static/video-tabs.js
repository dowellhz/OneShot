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
    return [e.from,role,time==null?null:Math.round(time*1000)/1000];
  });
  for(const e of B.edges.filter(e=>e.to===n.id&&node(e.from)?.type==="text"))entries.push([e.from,"text",null]);
  return JSON.stringify(entries.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
function vtMergeInfo(ids){
  const nodes=[...new Set(ids)].map(node);
  if(nodes.length<2||nodes.some(n=>!n||n.type!=="video"||n.data.film||!n.versions.length||!curV(n)))return {error:"请选择至少两个已生成的普通视频"};
  if(nodes.some(n=>n.job||prepping.has(n.id)))return {error:"请等待这些视频的任务完成后再合并"};
  if(nodes.some(n=>B.edges.some(e=>e.from===n.id)))return {error:"视频还有下游连线，先移除该连线再合并"};
  if(nodes.some(n=>vtSignature(n)!==vtSignature(nodes[0])))return {error:"输入图片、文字或关键帧角色不同，不能合并为同一组 Tab"};
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
    if(r){for(const k of ["prompt","duration","quality","seed","turbo","provider","sound","music","fields"])if(k in r)v.node_data[k]=vtClone(r[k]);
      if(r.ar)v.node_data.aspect=r.ar+":1";v.node_data.mode=r.planned?"keyframes":"auto";v.node_data.pmode=r.fields?"fields":"free";}
  }
  v.label=v.label||n.name;
  v.tab_nodes=[...new Set([...(v.tab_nodes||[]),n.id])];
  v.tab_origin=v.tab_origin||{id:n.id,name:n.name,x:n.x,y:n.y,version_index:i,groups:(B.groups||[]).filter(g=>g.nodes.includes(n.id)).map(g=>g.id)};
  return v;
}
function vtRetargetVersion(v,id){return {...v,input_edges:(v.input_edges||[]).map(e=>({...e,to:id}))};}
function vtSetInputs(n){
  const v=curV(n),edges=(v?.input_edges||[]).filter(e=>e.from!==n.id&&["image","text"].includes(node(e.from)?.type)).map(e=>({...e,to:n.id}));
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
  B.nodes=B.nodes.filter(n=>!removed.has(n.id));B.edges=B.edges.filter(e=>!removed.has(e.from)&&!removed.has(e.to));
  for(const g of B.groups||[])g.nodes=[...new Set(g.nodes.map(id=>removed.has(id)?keeper.id:id))];
  vtFinish([keeper.id]);toast("已合并为 "+versions.length+" 个 Tab，右键 Tab 可拆出；支持撤销",4500);return true;
}
function vtMoveReferences(oldId,newId){
  for(const n of B.nodes){for(const c of n.data?.film?.clips||[])if(c.node===oldId)c.node=newId;for(const s of n.data?.made||[])if(s.vid===oldId)s.vid=newId;}
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
    let nid;do{nid="n"+(B.seq++);}while(node(nid)||made.some(m=>m.id===nid));
    const version=vtRetargetVersion(v,nid),m={id:nid,type:"video",name:(v.tab_origin?.name||v.label||n.name)+" · 版本 "+(i+1),
      x:n.x+width+CT_LAYOUT_GAP.x,y,data:vtClone(v.node_data||n.data),versions:[version],cur:0,job:null};
    made.push(m);y+=size(m).h+CT_LAYOUT_GAP.y;
    if(i===oldCur)vtMoveReferences(id,nid);
  }
  n.versions=keep.map(({v})=>vtRetargetVersion(v,n.id));n.cur=Math.max(0,keep.findIndex(k=>k.i===oldCur));
  vtSetInputs(n);
  const positions=ctAvoidObstacles(made.map(({id,x,y})=>({id,x,y})),made,B.nodes);
  for(const m of made){Object.assign(m,positions.find(p=>p.id===m.id));B.nodes.push(m);B.edges.push(...vtClone(m.versions[0].input_edges.filter(e=>node(e.from))));}
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
    if(overlap>score&&!vtMergeInfo([...ids,target.id]).error){best=target;score=overlap;}
  }
  return best;
}
function vtMarkDrop(target){
  $$(".node.tab-merge-target").forEach(el=>el.classList.remove("tab-merge-target"));
  if(target)els.get(target.id)?.classList.add("tab-merge-target");
}
function vtTabMenu(n,index,x,y){
  closeMenus();let m=$("#videoTabMenu");if(!m){m=document.createElement("div");m.id="videoTabMenu";m.className="menu";document.body.append(m);}
  m.innerHTML=`<div class="mt">视频版本 ${index+1}</div><button data-split>${ico("copy")}拆出这个 Tab</button><button data-all>${ico("assets")}拆开所有 Tab</button>`;
  $$("button",m).forEach(b=>{b.disabled=!!n.job||prepping.has(n.id)||n.versions.length<2;b.onclick=()=>{closeMenus();vtSplit(n.id,index,b.hasAttribute("data-all"));};});
  m.classList.add("on");m.style.left=Math.max(8,Math.min(x,innerWidth-m.offsetWidth-8))+"px";m.style.top=Math.max(8,Math.min(y,innerHeight-m.offsetHeight-8))+"px";
}
