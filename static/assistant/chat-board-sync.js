"use strict";

function acRememberBoard(id,b){AC.base.set(id,acClone(b));}
// Incoming links to one node form an ordered list of references.
function acIncomingEdges(board) {
 const targets=new Map();
 for(const edge of board.edges||[]){
  if(!targets.has(edge.to))targets.set(edge.to,[]);
  targets.get(edge.to).push(edge);
 }
 return targets;
}

function acCheckMergedEdges(boards, merged) {
 const nodeIds=new Set(merged.nodes.map(n=>n.id));
 const knownIds=new Set(boards.flatMap(b=>(b.nodes||[]).map(n=>n.id)));
 const pair=(from,to)=>JSON.stringify([from,to]);
 const existingPairs=boards.slice(1).map(b=>new Set((b.edges||[]).map(e=>pair(e.from,e.to))));
 const mergedPairs=new Set((merged.edges||[]).map(e=>pair(e.from,e.to)));
 for(const edge of merged.edges||[]){
  if([edge.from,edge.to].some(id=>knownIds.has(id)&&!nodeIds.has(id)))throw new Error("连线的节点已被删除");
  const forward=pair(edge.from,edge.to),reverse=pair(edge.to,edge.from);
  if(mergedPairs.has(reverse)&&!existingPairs.some(pairs=>pairs.has(forward)&&pairs.has(reverse)))
   throw new Error("同一对节点已建立冲突的连线");
 }
}

function acMerge(base,local,remote,pick){
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),missing=Symbol("missing");
 const record=value=>value&&typeof value==="object"&&!Array.isArray(value);
 function merge(a,l,r,path){
  if(same(l,r)||same(a,r))return l;
  if(same(a,l))return r;
  if([a,l,r].every(record)){
   const entries=[];
   for(const key of new Set([...Object.keys(a),...Object.keys(l),...Object.keys(r)])){
    const v=merge(...[a,l,r].map(obj=>Object.hasOwn(obj,key)?obj[key]:missing),[...path,key]);
    if(v!==missing)entries.push([key,v]);
   }
   return Object.fromEntries(entries);
  }
  if(pick)return pick(path,l,r);
  throw new Error("同一内容已被修改");
 }
 const out=acClone(remote);
 const boards=[base,local,remote];
 for(const key of new Set([...Object.keys(local),...Object.keys(remote)])){
  if(["rev","nodes","agent_ops","access","owner","collaborators"].includes(key))continue;
  const [a,l,r]=boards.map(b=>b[key]);
  if(key==="view"){out.view=l??r;continue;}
  if(key==="seq"&&Number.isFinite(l)&&Number.isFinite(r)){out.seq=Math.max(l,r);continue;}
  if(key==="edges"&&!same(a,l)&&!same(a,r)&&!same(l,r)){
   const [original,mine,theirs]=boards.map(acIncomingEdges);
   out.edges=[...new Set([...theirs.keys(),...mine.keys()])].flatMap(id=>merge(original.get(id),mine.get(id),theirs.get(id),["edges",id])||[]);
   continue;
  }
  const v=merge(a,l,r,[key]);if(v!==undefined)out[key]=v;else delete out[key];
 }
 const maps=boards.map(b=>new Map((b.nodes||[]).map(n=>[n.id,n])));out.nodes=[];
 for(const id of new Set([...maps[2].keys(),...maps[1].keys()])){
  const [original,mine,theirs]=maps.map(map=>map.get(id));
  const n=merge(original,mine,theirs,["nodes",id]);
  if(!n)continue;
  // Keep the position seen by the editor who locked the node during a concurrent move.
  const lockedPosition=mine && theirs && nodeLocked(mine)!==nodeLocked(theirs) && (nodeLocked(mine)?mine:theirs);
  out.nodes.push(nodeLocked(n) && lockedPosition ? {...n,x:lockedPosition.x,y:lockedPosition.y} : n);
 }
 acCheckMergedEdges(boards,out);
 return out;
}
async function acRecoverSave(p){
 const base=AC.base.get(p.id);if(!base)return false;
 const remote=await acApi("/api/board/"+p.id),local=acClone(liveBoardData(p.b));let merged;
 try{merged=acMerge(base,local,remote);}catch{
  return acHoldConflict(p,base);
 }
 const r=await fetch("/api/board/"+p.id,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(merged)});
 if(!r.ok){if(r.status===409){savePending=p;saveT=setTimeout(flushSave,1000);}else throw new Error("合并保存失败");return true;}
 const j=await r.json();merged.rev=j.rev;acRememberBoard(p.id,merged);
 if(p.b===B&&p.id===boardId){
  const current=liveBoardData(B),keepView=!!liveCanvas?.following;
  if(JSON.stringify(current)!==JSON.stringify(local)){
   try{const next=acMerge(local,current,merged);acApplyBoard(next,keepView);save();}
   catch{return acHoldConflict(p,local);}
  }else acApplyBoard(merged,keepView);
 }
 return true;
}
async function acSyncBoard(rev,independent=false){
 if((!independent&&AC.board!==boardId)||!B||rev<=(B.rev||0)||AC.pending.has(boardId))return;
 const id=boardId, original=B, settled=flushSave();
 await settled;
 if(id!==boardId||B!==original||AC.pending.has(id))return;
 const j=await acApi("/api/board/"+id);
 if(id!==boardId||B!==original||savePending?.id===id||saveChain!==settled||AC.pending.has(id))return;
 if(j.rev>(B.rev||0)){acRememberBoard(id,j);acApplyBoard(j,true);}
}
async function acSyncAgentJobs(){const id=boardId;const remote=await acApi("/api/board/"+id);if(id===boardId)await acSyncBoard(remote.rev,true);}
async function acReconcileCanvasJob(n, states) {
 const board=B, receipt=n.job;
 try { await acSyncAgentJobs(); } catch { /* A later poll can retry board synchronization. */ }
 if(B!==board||node(n.id)!==n||n.job!==receipt)return;
 const known=new Set(n.versions.map(version=>version.ref).filter(Boolean));
 const adopted=states.length>0&&states.every(state=>state.state==="done"&&state.outputs?.length&&
   state.outputs.every(output=>known.has(output.ref)));
 if(!adopted){renderJob(n);return;}
 n.job=null;
 save();render(n);
 if(sel.has(n.id))showPanel();
}
function acApplyBoard(data,keepView=false){rebaseCanvasHistory(data);const previous=new Map(B.nodes.map(n=>[n.id,n])),view=B.view;const nodes=data.nodes.map(n=>{const old=previous.get(n.id);if(!old)return n;for(const k of Object.keys(old))if(!(k in n))delete old[k];Object.assign(old,n);return old;});Object.assign(B,data,{nodes});canvasApplyAccess();if(keepView)B.view=view;sel=new Set([...sel].filter(id=>node(id)));rebuild();applyView();if(B.nodes.some(n=>n.job?.agent_call))poll();B.nodes.filter(n=>n.agent_error).forEach(n=>showErr(n,n.agent_error));if(IMAGE_EDITOR&&!node(IMAGE_EDITOR.n.id))closeImageEditor();pvSyncBoard();canvasDocument?.update();}
