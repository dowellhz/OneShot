"use strict";
const AC={session:null,board:null,events:[],runs:[],queue:[],documents:[],documentUpload:null,cursor:0,open:false,polling:false,sending:false,refs:null,referencePins:new Map(),reviews:[],placement:null,skill:null,base:new Map(),pending:new Map(),calls:new Map(),epoch:0};
AC.sessions=[];
AC.questionnaires=[];
const acQuestionDrafts=new Map();
AC.models=[];
AC.modelSelection={};
const AC_THINKING_LEVELS={off:"关闭",low:"轻量",high:"标准",max:"深度"};
AC.drafts=new Map();
const AC_REVIEW_LIMIT=8;
const AC_GENERATION_MODES={auto:"自动生成",smart:"智能确认",manual:"每次确认"};
const AC_EXECUTION_SCOPES={full:"正常执行",analysis:"仅分析",plan:"仅拟方案",brainstorm:"头脑风暴"};
AC.executionScope="full";
let acGenerationMode=localStorage.getItem("h3.chat.generationMode") || "auto";
if(!Object.hasOwn(AC_GENERATION_MODES,acGenerationMode))acGenerationMode="auto";
const AC_LABELS={audio_separate:"人声分离",video_remake_plan:"确认换角计划",video_remake_status:"读取视频重制进度",video_remake_analyze:"分析重制原片",video_remake_map:"保存角色映射",video_remake_preview:"提交换角预览",video_remake_generate:"提交重制镜头视频",video_remake_export:"合成并保留原声",video_remake_review:"保存镜头审核决定",video_remake_locate:"定位原片人物",canvas_context:"读取画布",canvas_create_text:"创建文本",canvas_update:"更新节点",canvas_arrange:"整理排列",canvas_focus:"定位节点",media_describe:"理解图片",image_generate:"生成图片",image_edit:"编辑图片",image_cutout:"去除背景",image_segment:"识别选区",image_transform:"调整图片",memory_search:"检索创作记忆",memory_get:"读取创作记忆",memory_use:"采用记忆素材",memory_save:"保存创作记忆"};
const AC_STATES={thinking:"正在理解与规划…",running:"正在执行…",stopping:"正在停止，保留已完成结果…",stopped:"本轮已停止",done:"本轮已结束",error:"本轮执行中断"};
const AC_PHASES={queued:"排队",loading:"加载模型",encoding:"处理提示词与图片",sampling:"生成",decoding:"解码",compositing:"合成",watermark:"写入 AI 水印",done:"完成",error:"失败"};
AC_LABELS.creative_skill_load="加载创作技能";
AC_LABELS.image_generate_set="生成图片套图";
AC_LABELS.canvas_replace_passage="替换批注段落";
AC_STATES.waiting_approval="等待确认生成方案…";
AC.approvals=[];
const acDecidedApprovals=new Set();
AC_LABELS.canvas_workflow_review="读取制作复盘";
AC_LABELS.canvas_reference_plan="准备参考素材替换";
AC_LABELS.canvas_group_run_plan="准备分组运行";
AC_LABELS.workflow_template_search="查找工作流模板";
AC_LABELS.workflow_template_inputs="读取模板填写项";
AC_LABELS.workflow_template_plan="准备模板填写草稿";
AC_LABELS.storyboard_context="读取分镜脚本";
AC_LABELS.storyboard_visual_review="审阅镜头衔接";
AC_LABELS.storyboard_next_shot_plan="准备下一镜";
AC_LABELS.storyboard_revision_plan="准备镜头修改";
AC_LABELS.storyboard_range_run_plan="准备批量生成镜头";
AC_LABELS.creative_directions="比较创意方向";
AC_LABELS.image_camera="图片换机位";
AC_LABELS.image_relight="图片重新布光";
AC_LABELS.web_search="搜索公开资料";
AC_LABELS.web_save_references="保存公开资料";

function publicResearchLink(value) {
 try {
  const url=new URL(value);
  return ["http:","https:"].includes(url.protocol)&&!url.username&&!url.password?url.href:"";
 } catch { return ""; }
}

function acWebSources(items) {
 return `<ol class="ac-web-sources">${items.map(item=>{
  const link=publicResearchLink(item.url), image=publicResearchLink(item.image);
  if(!link)return "";
  const thumbnail=image&&["upload.wikimedia.org","thumb.wikimedia.org"].includes(new URL(image).hostname)?
   `<img src="${esc(image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:"";
  return `<li>${thumbnail}<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>
   ${item.date||item.credit||item.license?`<small>${esc([item.date,item.credit,item.license].filter(Boolean).join(" · "))}</small>`:""}
   ${item.snippet?`<p>${esc(item.snippet)}</p>`:""}</li>`;
 }).join("")}</ol>`;
}
Object.assign(AC_LABELS,{video_generate:"生成视频",video_regenerate:"重新生成视频",
 video_extend:"续拍视频",video_edit_segment:"修改视频片段",video_object_settings:"读取物体编辑设置",video_capture_frame:"截取视频帧",
 video_draft_status:"查询样片版本",video_draft_finalize:"生成样片定稿",
 video_titles_get:"读取画面标题",video_titles_edit:"编辑画面标题",
 video_cutaways_get:"读取补画面",video_cutaways_edit:"编辑补画面",
 video_broll_generate:"制作 B-roll 动态画面",
 video_playlist_create:"创建播放列表",video_playlist_read:"读取播放列表",video_playlist_edit:"调整播放列表",video_playlist_export:"导出播放列表",
 video_previs_get:"读取白模场景",video_previs_save:"保存白模场景",video_previs_render:"渲染白模预演",
 audio_services:"读取配音与音乐服务",audio_generate:"生成音频"});
const acClone=v=>JSON.parse(JSON.stringify(v));
function acActive(){return AC.runs.find(r=>!["done","error","stopped"].includes(r.state));}
async function acApi(url,body){const r=await fetch(url,body===undefined?{}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});let j;try{j=await r.json();}catch{throw new Error("服务返回异常，请稍后重试");}if(!r.ok)throw new Error(j.error||"请求失败");return j;}
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
function acApplyBoard(data,keepView=false){rebaseCanvasHistory(data);const previous=new Map(B.nodes.map(n=>[n.id,n])),view=B.view;const nodes=data.nodes.map(n=>{const old=previous.get(n.id);if(!old)return n;for(const k of Object.keys(old))if(!(k in n))delete old[k];Object.assign(old,n);return old;});Object.assign(B,data,{nodes});canvasApplyAccess();if(keepView)B.view=view;sel=new Set([...sel].filter(id=>node(id)));rebuild();applyView();if(B.nodes.some(n=>n.job?.agent_call))poll();B.nodes.filter(n=>n.agent_error).forEach(n=>showErr(n,n.agent_error));if(IMAGE_EDITOR&&!node(IMAGE_EDITOR.n.id))closeImageEditor();pvSyncBoard();canvasDocument?.update();}
function acReviewTarget(review){
 return review?.anchor?.node ? vtResolve(review.anchor.node,review.anchor.ref)?.node : null;
}
function acReviewVersion(n, reviews=AC.reviews) {
 return reviews.find(r=>r.anchor?.ref && acReviewTarget(r)?.id===n.id)?.anchor.ref || null;
}
function acCheckReviews(reviews) {
 const pins=new Map([...AC.referencePins].map(([id,pin])=>[id,pin.ref]));
 if(AC.selection) {
  const {node_id,source_ref}=AC.selection;
  if(pins.has(node_id) && pins.get(node_id)!==source_ref) return "节点引用和圈选区域对应不同版本，请移除其中一项";
  pins.set(node_id,source_ref);
 }
 for(const review of reviews) {
  if(!review.anchor?.node)continue;
  const n=acReviewTarget(review), ref=review.anchor.ref;
  if(!n)return "审阅素材已失效，请重新选择评论";
  if(ref && pins.has(n.id) && pins.get(n.id)!==ref) return "同一节点的评论、圈选或引用对应不同版本，请分开提交";
  if(ref)pins.set(n.id,ref);
 }
 return "";
}
function acRefs(){
 const refs=(AC.refs===null?[...sel]:AC.refs).map(node).filter(Boolean);
 const targets=AC.board===boardId?AC.reviews.map(acReviewTarget).filter(Boolean):[];
 return [...new Set([...targets,...refs])];
}
let acPickingPlacement = false;
const acCanvasBackground = target => [vp,world,svg].includes(target);
function acRenderPlacement() {
 const marker = $("#acPlacementMarker");
 const point = AC.open && AC.board === boardId && (acVoiceActive?.placement || AC.placement);
 marker.hidden = !point;
 if (!point || !B) return;
 const {x,y,k} = B.view;
 marker.style.left = (x + point.x * k) + "px";
 marker.style.top = (y + point.y * k) + "px";
}
function acPlacementPoint(point) {
 const x = Math.round(point.x), y = Math.round(point.y);
 if (Math.abs(x) > 1_000_000 || Math.abs(y) > 1_000_000) {
  toast("放置位置超出画布坐标范围");
  return null;
 }
 return {x,y};
}
function acPickPlacement(active) {
 acPickingPlacement = active;
 vp.classList.toggle("ac-placement-picking",active);
 $("#acPickPlacement").setAttribute("aria-pressed",String(active));
}
function acNodeReferenceMarkup(n,selection,reviews){
 const pin=AC.referencePins.get(n.id);
 const fixedRef=selection?.node_id===n.id?selection.source_ref:acReviewVersion(n,reviews);
 const ref=pin?.ref||fixedRef;
 const index=ref?n.versions.findIndex(v=>v.ref===ref):n.cur;
 const version=n.versions[index];
 const preview=n.type==="image"&&version?.ref
  ? `<img src="${esc(ewRefUrl(version.ref))}" alt="" loading="lazy" draggable="false">`
  : ico(n.type);
 const label=index>=0?"版本 "+(index+1)+(pin||fixedRef?" · 已指定":""):ref?"版本已移除":TYPE_CN[n.type];
 const options=n.versions.map((entry,i)=>entry.ref
  ? `<option value="${i}" ${pin&&version===entry?"selected":""}>版本 ${i+1}${pin&&version===entry?" · 已指定":""}</option>`:"").join("");
 const choices=!fixedRef&&options&&(n.versions.length>1||pin&&!version)
  ? `<select data-reference-version="${esc(n.id)}" aria-label="${esc(n.name)}的引用版本" ${AC.sending?"disabled":""}>
    <option value="" ${!pin?"selected":""}>${n.cur>=0?`跟随画布 · 版本 ${n.cur+1}`:"跟随画布"}</option>
    ${pin&&!version?'<option value="missing" disabled selected>版本已移除</option>':""}${options}</select>`
  : `<span class="ac-reference-version">${esc(label)}</span>`;
 return `<span class="ac-ref ac-node-ref" title="${esc(n.name)} · ${esc(label)}">${preview}<span class="ac-reference-name">${esc(n.name)}</span>${choices}<button type="button" data-remove="${esc(n.id)}" aria-label="移除引用">×</button></span>`;
}
function acRenderRefs(){
 const box=$("#acRefs");if(!box||!B)return;
 acRenderPlacement();
 const selection=AC.board===boardId?AC.selection:null;
 const reviews=AC.board===boardId?AC.reviews:[];
 const refs=acRefs();
 const refsMarkup=refs.map(n=>acNodeReferenceMarkup(n,selection,reviews)).join("");
 const missing=[...AC.referencePins].filter(([id])=>AC.refs?.includes(id)&&!node(id)).map(([id,pin])=>
  `<span class="ac-ref">${esc(pin.name)} · 节点已移除<button type="button" data-remove="${esc(id)}" aria-label="移除已失效引用">×</button></span>`).join("");
 const selectionMarkup=selection?`<span class="ac-ref ac-ref-selection"><a href="${esc(ewRefUrl(selection.preview_ref))}" target="_blank" rel="noopener" aria-label="查看选区预览"><img src="${esc(ewRefUrl(selection.preview_ref))}" alt=""></a>${refs.some(n=>n.id===selection.node_id&&n.versions.some(v=>v.ref===selection.source_ref))?"已圈选区域":"选区源图已失效"}<button type="button" data-remove-selection aria-label="移除圈选区域">×</button></span>`:"";
 const reviewMarkup=reviews.map(review=>`<span class="ac-ref ac-review-ref"><button type="button" data-open-review="${esc(review.id)}" title="${esc(review.body)}">${review.anchor?.node&&!acReviewTarget(review)?"审阅素材已失效":"审阅评论 · "+esc(review.body.slice(0,24))}</button><button type="button" data-remove-review="${esc(review.id)}" aria-label="移除审阅评论">×</button></span>`).join("");
 const placementMarkup=AC.board===boardId&&AC.placement?'<span class="ac-ref"><button type="button" data-locate-placement title="定位到标记">已指定放置位置</button><button type="button" data-remove-placement aria-label="清除放置位置">×</button></span>':"";
 const markup=refsMarkup+missing+selectionMarkup+reviewMarkup+placementMarkup;
 if(box._refMarkup===markup)return;
 const focus=box.contains(document.activeElement)?document.activeElement.dataset.referenceVersion:null;
 box._refMarkup=markup;box.innerHTML=markup;
 for(const picker of $$("[data-reference-version]",box)){
  const id=picker.dataset.referenceVersion;
  if(id===focus)picker.focus({preventScroll:true});
  picker.onchange=()=>{
   const n=node(id),ref=picker.value===""?null:n?.versions[Number(picker.value)]?.ref;
   if(ref===undefined||!acAttachNodeReference(n,ref)){
    box._refMarkup=null;acRenderRefs();
   }
  };
 }
 $$("[data-remove]",box).forEach(b=>b.onclick=()=>{
  AC.refs=acRefs().map(n=>n.id).filter(id=>id!==b.dataset.remove);
  AC.referencePins.delete(b.dataset.remove);
  if(AC.selection?.node_id===b.dataset.remove)AC.selection=null;
  AC.reviews=AC.reviews.filter(r=>acReviewTarget(r)?.id!==b.dataset.remove);
  acRenderRefs();acRenderState();
 });
 const remove=$("[data-remove-selection]",box);
 if(remove)remove.onclick=()=>{AC.selection=null;acRenderRefs();};
 $$("[data-remove-review]",box).forEach(button=>button.onclick=()=>{
  AC.reviews=AC.reviews.filter(r=>r.id!==button.dataset.removeReview);
  acRenderRefs();acRenderState();
 });
 $$("[data-open-review]",box).forEach(button=>button.onclick=()=>ccOpenReview(button.dataset.openReview));
 const locate=$("[data-locate-placement]",box);
 if(locate)locate.onclick=()=>{
  const {x,y}=AC.placement;liveStopFollow(false);
  B.view.x=innerWidth/2-x*B.view.k;B.view.y=innerHeight/2-y*B.view.k;applyView();save();
 };
 const clear=$("[data-remove-placement]",box);
 if(clear)clear.onclick=()=>{AC.placement=null;acRenderRefs();};
}
function acPinReference(n){
 AC.refs=[n.id,...acRefs().map(item=>item.id).filter(id=>id!==n.id)].slice(0,30);
 acRenderRefs();
}
function acAttachNodeReference(n, ref=curV(n)?.ref, report=toast) {
 if(!n || node(n.id)!==n || AC.board!==boardId || !AC.session || AC.sending)return false;
 const refs=new Set([...(AC.refs??[...sel]),...acRefs().map(item=>item.id),n.id]);
 if(refs.size>30){report("每条消息最多引用 30 个画布节点");return false;}
 if(ref && !n.versions.some(v=>v.ref===ref)){report("引用版本已移除，请重新选择");return false;}
 const reviewRef=acReviewVersion(n);
 if(ref && ((AC.selection?.node_id===n.id && AC.selection.source_ref!==ref) ||
    (reviewRef && reviewRef!==ref))) {
  report("当前引用和圈选或审阅素材对应不同版本，请先移除旧引用");return false;
 }
 AC.refs=[...refs];
 if(ref)AC.referencePins.set(n.id,{ref,name:n.name});else AC.referencePins.delete(n.id);
 acRenderRefs();
 return true;
}
async function acUseNodes(nodes){
 const id=boardId;
 await acOpen();
 if(id!==boardId||AC.board!==id||!AC.session)return;
 const added=nodes.filter(n=>node(n.id)===n).map(n=>n.id);
 if(!added.length)return;
 const refs=[...new Set([...added,...acRefs().map(n=>n.id)])];
 AC.refs=refs.slice(0,30);
 acRenderRefs();
 if(nodes.length>1&&refs.length>30)toast("创作助手每条消息最多引用 30 个节点，已选取前 30 个");
}
function acUseNode(n){return acUseNodes([n]);}
async function acNewNodeSession(references){
 if(!canvasCanEdit() || AC.sending || AC.documentUpload || AC.loadingSessions || AC.newNodeSession)return;
 const board=boardId;
 if(!references.length)return;
 if(references.length>30)throw new Error("每条消息最多引用 30 个画布节点");
 const available=()=>references.filter(({id,ref})=>{
  const n=node(id);
  return n&&(!ref||n.versions.some(version=>version.ref===ref));
 });
 AC.newNodeSession=true;
 try {
  await flushSave();
  if(board!==boardId || !canvasCanEdit() || AC.sending || AC.documentUpload || AC.loadingSessions)return;
  if(!available().length)throw new Error("选中的素材或版本已移除");
  acShowPane();
  const session=await acSessions(true);
  if(!session||session!==AC.session||board!==boardId)return;
  const remaining=available();
  AC.refs=remaining.map(({id})=>id);
  for(const {id,ref} of remaining)if(ref)AC.referencePins.set(id,{ref,name:node(id).name});
  if(remaining.length!==references.length)toast("部分引用已移除，请核对新对话的素材");
  acRenderState();
  if(AC.open)$("#acInput").focus();
 }finally{AC.newNodeSession=false;}
}
async function acAttachReviews(incoming){
 const bid=boardId;
 if(AC.sending)throw new Error("请等当前消息发送完成");
 await acOpen();
 if(bid!==boardId||AC.board!==bid||!AC.session)return false;
 if(AC.sending)throw new Error("请等当前消息发送完成");
 const next=new Map(AC.reviews.map(review=>[review.id,review]));
 for(const {id,body,anchor} of incoming)next.set(id,{id,body,anchor});
 const reviews=[...next.values()];
 if(reviews.length>AC_REVIEW_LIMIT)throw new Error(`每条消息最多引用 ${AC_REVIEW_LIMIT} 条审阅评论`);
 const conflict=acCheckReviews(reviews);
 if(conflict)throw new Error(conflict);
 if(new Set([...acRefs(),...reviews.map(acReviewTarget).filter(Boolean)]).size>30)throw new Error("引用的评论和节点合计超过 30 个画布节点");
 AC.reviews=reviews;
 acRenderRefs();acRenderState();
 return true;
}
function acAttachReview(review){return acAttachReviews([review]);}
async function acPick(){
 const box=$("#acPicker"),bid=boardId,epoch=AC.epoch;
 box.hidden=!box.hidden;if(box.hidden)return;
 const [memories,folders]=await Promise.all([cmList(true).catch(()=>[]),cmFolders().catch(()=>[])]);
 if(bid!==boardId||epoch!==AC.epoch||box.hidden)return;
 box.innerHTML=folders.map(folder=>`<button type="button" data-asset-folder="${esc(folder.id)}">${esc(folder.name)} · 文件夹 · ${folder.count} 项</button>`).join("")+
  memories.map(a=>`<button type="button" data-memory="${esc(a.id)}">@${esc(a.name)} · ${esc(cmKind(a))}</button>`).join("")+
  B.nodes.slice(0,200).map(n=>`<button type="button" data-node="${esc(n.id)}">${esc(n.name)} · ${TYPE_CN[n.type]}</button>`).join("")||"画布还没有节点";
 $$("[data-memory]",box).forEach(b=>b.onclick=()=>{const a=memories.find(a=>a.id===b.dataset.memory);if(a)cmInsert($("#acInput"),a);box.hidden=true;});
 $$("[data-asset-folder]",box).forEach(b=>b.onclick=()=>{
  box.hidden=true;
  const folder=folders.find(folder=>folder.id===b.dataset.assetFolder);
  if(folder)cmInsert($("#acInput"),{...folder,assetFolder:true});
 });
 $$("[data-node]",box).forEach(b=>b.onclick=()=>{if(acAttachNodeReference(node(b.dataset.node))){box.hidden=true;$("#acInput").focus();}});
}
async function acFocus(ids,editor=false){
 if(AC.board!==boardId)return;
 const nodes=ids.map(id=>vtResolve(id)?.node).filter(Boolean);
 if(!nodes.length)return;
 sel=new Set(nodes.map(n=>n.id));updateSel();fit(nodes);
 if(editor&&nodes.length===1&&nodes[0].type==="image"){
  closeLightbox();
  await openImageEditor(nodes[0]);
 }
}
function acResultVersion(item){const resolved=vtResolve(item.id,item.ref);return resolved?.node.versions[resolved.index]||item;}
function acResultCards(result){
 if(result.creative_directions?.length){
  return result.creative_directions.map(direction=>`<section class="ac-storyboard-plan ac-direction" data-creative-direction="${esc(JSON.stringify(direction))}">
    <strong>${esc(direction.title)}</strong><p>${esc(direction.premise)}</p>
    <dl><dt>执行方法</dt><dd>${esc(direction.approach)}</dd><dt>取舍</dt><dd>${esc(direction.tradeoff)}</dd>
    <dt>第一步</dt><dd>${esc(direction.first_step)}</dd></dl>
    <div class="ac-storyboard-actions"><button type="button" data-explore-direction>继续讨论这个方向</button>
    <button type="button" data-plan-direction>拟制作方案</button></div></section>`).join("");
 }
 if(result.shot_range_plan){
  const plan=result.shot_range_plan;
  const modes={missing:"补齐未生成镜头",all:"运行所有选中的节点",missing_frame:"只补齐分镜图",missing_video:"只补齐视频",frame:"重生成分镜图",video:"重生成视频"};
  const tails={connect:"连接缺失的上一镜尾帧",refresh:"刷新已有的上一镜尾帧",connect_and_refresh:"连接缺失并刷新已有的上一镜尾帧"};
  const details=[modes[plan.mode],tails[plan.tail_mode]].filter(Boolean).join(" · ");
  return `<section class="ac-storyboard-plan"><strong>${esc(plan.name)} · 第 ${esc(plan.first)}${plan.first===plan.last?"":"–"+esc(plan.last)} 镜</strong>
    <p>${esc(details)}</p><button type="button" data-open-shot-range="${esc(JSON.stringify(plan))}">核对生成范围</button></section>`;
 }
 if(result.template_fill_plan){
  const plan=result.template_fill_plan;
  return `<div class="ac-template-results"><article><strong>${esc(plan.name)}</strong>
    <small>已填写 ${esc(plan.inputs.length)} 项</small>
    <button type="button" data-template-fill-plan="${esc(JSON.stringify(plan))}">核对填写草稿</button>
  </article></div>`;
 }
 if(result.workflow_templates?.length){
  const source={private:"我的模板",catalog:"共享模板",presets:"内置工作流",favorites:"收藏模板"};
  return `<div class="ac-template-results">${result.workflow_templates.map(row=>`<article>
   <strong>${esc(row.name)}</strong><small>${esc([source[row.scope],row.category,row.author].filter(Boolean).join(" · "))} · ${esc(row.nodes)} 个节点</small>
   ${row.description?`<p>${esc(row.description)}</p>`:""}
   <button type="button" data-open-workflow-template="${esc(row.id)}" data-template-scope="${esc(row.scope)}" aria-label="预览与使用 ${esc(row.name)}">预览与使用</button>
  </article>`).join("")}</div>`;
 }
 if(result.shot_revision){
  const p=result.shot_revision;
  const labels={duration:"时长",shot_size:"景别",camera:"机位",scene:"场景",action:"动作",dialogue:"台词",sound:"声音",keyframe:"首帧"};
  const display=value=>esc((Array.isArray(value)?value.join("\n"):value)??"");
  return `<section class="ac-storyboard-plan" data-shot-revision="${esc(JSON.stringify(p))}">
   <strong>${esc(p.name)} · 第 ${p.shot} 镜</strong>
   <dl>${Object.entries(p.changes).map(([key,value])=>`<dt>${esc(labels[key])}</dt><dd>
     <span class="ac-revision-before">${display(p.before[key])||"未填写"}</span><span aria-label="改为"> → </span>${display(value)||"清空"}</dd>`).join("")}</dl>
   <div class="ac-storyboard-actions"><button type="button" data-apply-shot-revision>应用到原镜头</button>
    <button type="button" data-run-shot-revision hidden>查看重生成计划</button></div><span role="status"></span></section>`;
 }
 if(result.shot_review){
  const p=result.shot_review;
  return `<div class="ac-results" data-shot-review-card="${esc(JSON.stringify(p))}"><span>第 ${p.shot-1} 镜尾帧（版本 ${p.left.version}） · 第 ${p.shot} 镜${p.right.kind==="image"?"分镜图":"首帧"}（版本 ${p.right.version}）</span>
   <div class="ac-storyboard-actions"><button type="button" data-shot-review>${p.samples?"查看切点与取样":"打开双帧对比"}</button>
    ${canvasCanEdit()?'<button type="button" data-plan-review-revision>为当前镜头拟修改</button>':""}</div><span role="status"></span></div>`;
 }
 if(result.storyboard_plan){
  const p=result.storyboard_plan,s=p.shot;
  const fields=[["场景",s.scene],["机位",s.camera],["首帧",s.keyframe],["动作",s.action.join("\n")],
    ["角色",s.characters.join("、")],["台词",s.dialogue.join("\n")],["声音",s.sound]];
  return `<section class="ac-storyboard-plan" data-storyboard-plan="${esc(JSON.stringify(p))}">
   <strong>${esc(p.name)} · 第 ${p.anchor.count+1} 镜 · ${esc(s.shot_size)} · ${s.duration} 秒</strong>
   <dl>${fields.filter(([,value])=>value).map(([label,value])=>`<dt>${label}</dt><dd>${esc(value)}</dd>`).join("")}</dl>
   <div class="ac-storyboard-actions"><button type="button" data-adopt-storyboard>加入分镜</button>
    <button type="button" data-open-approved-shot hidden>展开这一镜</button>
    <button type="button" data-link-previous-shot hidden>参考上一镜尾帧</button>
    <button type="button" data-run-approved-shot hidden>生成这一镜…</button></div><span role="status"></span></section>`;
 }
 if(result.group_run_plan){
  const p=result.group_run_plan;
  return `<div class="ac-results"><span>${esc(p.name)} · ${p.targets.length} 个节点 · ${p.mode==="all"?"运行指定节点":"补齐未生成节点"}</span>
   <button type="button" data-group-run-plan="${esc(JSON.stringify(p))}">查看分组运行计划</button></div>`;
 }
 if(result.reference_plan){
  const p=result.reference_plan;
  return `<div class="ac-results"><span>${esc(p.source_name)} → ${esc(p.replacement_name)}${p.version?" · 版本 "+esc(p.version):""}${p.group_name?" · "+esc(p.group_name):""}${p.targets?.length?" · "+p.targets.length+" 个指定节点":""}</span>
   <button type="button" data-reference-plan="${esc(JSON.stringify(p))}">预览参考替换</button></div>`;
 }
 if (result.remake) {
  const {node_id, source_ref, shot_number, shot_start, frame, preview_job, video_job} = result.remake;
  const locate = Number.isFinite(shot_start) && Number.isInteger(shot_number);
  const label = locate ? result.location ? `确认镜头 ${shot_number} 的人物位置` : `打开重制镜头 ${shot_number}` : "打开视频重制";
  const open = (text, job) => {
   const target = locate ? ` data-remake-start="${shot_start}" data-remake-frame="${esc(frame || "")}" data-remake-preview-job="${esc(preview_job || "")}" data-remake-video-job="${esc(job || "")}"` : "";
   return `<button type="button" data-remake-node="${esc(node_id)}" data-remake-ref="${esc(source_ref)}"${target}>${esc(text)}</button>`;
  };
  let review = "";
  if (locate && result.review_board && Number.isInteger(result.cut_revision) && Array.isArray(result.review_versions)) {
   const decision = (text, job, pressed, issue) =>
    `<button type="button" data-remake-decision="${job ? "adopt" : "keep"}" data-review-job="${esc(job || "")}" aria-pressed="${!!pressed}"${issue ? ` disabled title="${esc(issue)}"` : ""}>${esc(text)}</button>`;
   const rows = result.review_versions.map(version =>
    `<div>${open(`查看版本 ${version.number}`, version.job)}${decision(`采用版本 ${version.number}`, version.job, version.adopted, version.review_issue)}</div>`).join("");
   review = `<div class="ac-remake-review" data-review-board="${esc(result.review_board)}" data-review-node="${esc(node_id)}"
    data-review-ref="${esc(source_ref)}" data-review-shot="${shot_number}" data-review-revision="${result.cut_revision}">
    ${rows}<div>${decision("保留原片", "", result.shots?.[shot_number - 1]?.keep_original)}</div>
    <span data-review-status role="status"></span></div>`;
  } else if (result.review_versions?.length) {
   review = `<div class="ac-results">${result.review_versions.map(version => open(`查看版本 ${version.number}`, version.job)).join("")}</div>`;
  }
  const download = result.export_ref ? `<a href="/media?ref=${encodeURIComponent(result.export_ref)}" download="${esc(result.export_ref.split("/").at(-1))}">下载成片</a>` : "";
  const plan = result.remake_plan;
  const planCard = plan ? `<fieldset class="ac-remake-plan" data-plan="${esc(JSON.stringify({...plan, node_id, source_ref}))}">
    <legend>确认换角计划</legend><div><img src="${remakeMedia(plan.reference)}" alt="角色参考图"><strong>${esc(plan.person)} → ${esc(plan.asset_name)}</strong></div>
    ${plan.shots.map(s => `<label><input type="checkbox" value="${s.shot}" ${s.keep ? "disabled" : "checked"}>镜头 ${s.shot} · ${s.keep ? "保留原片" : s.selection_ready ? "可生成预览" : "需要确认人物选区"}</label>`).join("")}
    <button type="button" data-apply-plan>确认所选镜头</button><output aria-live="polite"></output></fieldset>` : "";
  return `<div class="ac-results">${open(label, video_job)}${download}</div>${review}${planCard}`;
 }
 const made=result.nodes||[];
 const editor=result.previs_node ? `<button type="button" data-previs-open="${esc(result.previs_node)}" data-previs-ref="${esc(made[0]?.ref || "")}">打开白模编辑器</button>`
  : result.playlist_node ? `<button type="button" data-playlist-open="${esc(result.playlist_node)}" data-playlist-rev="${esc(result.board_rev || 0)}">打开播放列表</button>` : "";
 if(!made.length&&!editor)return "";
 const cards=made.map(item=>{
  const n=vtResolve(item.id,item.ref)?.node,v=acResultVersion(item),kind=item.type||n?.type;
  const media=v?.ref?"/media?ref="+encodeURIComponent(v.ref):"";
  const focus=`data-focus="${esc(item.id)}" data-version-ref="${esc(v?.ref||"")}"`;
  if(kind==="video"||kind==="audio"){
   const player=kind==="video"?`<video controls playsinline preload="metadata" src="${media}" aria-label="${editor?"白模预演视频":"生成的视频"}"></video>`
    :`<audio controls preload="metadata" src="${media}" aria-label="生成的音频"></audio>`;
   const cut=kind==="video"&&extensionInput(v)
    ?`<button type="button" data-extension-clip="${esc(item.id)}" data-version-ref="${esc(v.ref)}">与原片一起剪辑</button>`:"";
   return `<div class="ac-result ac-${kind}">${player}<button type="button" ${focus}>${kind==="video"?"定位视频":"定位音频"}</button>${cut}</div>`;
  }
  return `<button type="button" class="ac-result" ${focus}>${media?`<img loading="lazy" alt="生成结果" src="${media}">`:""}<span>${esc(n?.name||item.name||"查看结果")}</span></button>`;
 });
 return `<div class="ac-results">${cards.join("")}${editor}</div>`;}

async function acApplyRemakePlan(button) {
 const card = button.closest("[data-plan]");
 const plan = JSON.parse(card.dataset.plan);
 const shots = $$("input:checked:not(:disabled)", card).map(control => Number(control.value) - 1);
 const status = $("output", card);
 if (!shots.length) { status.textContent = "请至少勾选一个镜头"; return; }
 card.disabled = true;
 try {
  await flushSave();
  if (boardId !== plan.board) throw new Error("请回到对应画布");
  const target = vtResolve(plan.node_id, plan.source_ref);
  if (!target || target.node.versions[target.index]?.ref !== plan.source_ref) throw new Error("原片版本已不存在");
  const url = `/api/video-remake/${encodeURIComponent(plan.board)}/${encodeURIComponent(target.node.id)}?source=${encodeURIComponent(plan.source_ref)}`;
  const state = await remakeRequest(url, {"action":"apply_plan", shots, plan_id:plan.id, cut_revision:plan.cut_revision,
    person:plan.person, asset:plan.asset, reference:plan.reference, look:plan.look});
  acShowRemakeReceipt(card, url, plan, state, state.apply_plan, target.node.id);
 } catch (e) {
  status.textContent = e.message;
  card.disabled = false;
 }
}

function acShowRemakeReceipt(card, url, plan, state, outcome, nodeId) {
  if (!outcome || card.dataset.receipt) return;
  card.dataset.receipt = "1";
  card.disabled = true;
  const status = $("output", card);
  const summary = [`已提交 ${outcome.submitted.length} 个预览`, ...outcome.failed.map(s => `镜头 ${s.shot + 1} ${s.error}`)];
  if (outcome.uncertain) summary.push("提交曾中断，请先核对已有任务");
  if (outcome.needs_selection.length) summary.push(`请确认镜头 ${outcome.needs_selection.map(i => i + 1).join("、")} 的人物选区`);
  status.textContent = summary.join(" · ");
  const first = (outcome.needs_selection.length ? outcome.needs_selection : outcome.submitted)[0];
  if (first != null && state.shots[first]) {
   const link = document.createElement("button"); link.type = "button"; link.textContent = `打开镜头 ${first + 1}`;
   Object.assign(link.dataset, {remakeNode:nodeId, remakeRef:plan.source_ref, remakeStart:state.shots[first].start});
   card.after(link);
  }
  if (outcome.submitted.length) {
   const results = document.createElement("div"); results.className = "ac-remake-plan";
   card.after(results);
   watchRemakePlan(results, url, plan, outcome.jobs || []);
  }
}

async function acRestoreRemakePlan(card) {
 const plan = JSON.parse(card.dataset.plan);
 if (!plan.id || plan.board !== boardId) return;
 const controls = $$("input:not(:disabled)", card);
 const key = `oneshot.plan:${ME_USER?.id ?? "local"}:${plan.board}:${plan.id}`;
 const apply = selected => controls.forEach(c => { c.checked = selected.includes(Number(c.value) - 1); });
 try {
  const draft = JSON.parse(localStorage.getItem(key));
  if (Array.isArray(draft)) apply(draft);
 } catch {}
 card.addEventListener("change", () => {
  try { localStorage.setItem(key, JSON.stringify(controls.filter(c => c.checked).map(c => Number(c.value) - 1))); } catch {}
 });
 try {
  const target = vtResolve(plan.node_id, plan.source_ref);
  if (!target || target.node.versions[target.index]?.ref !== plan.source_ref) return;
  const url = `/api/video-remake/${encodeURIComponent(plan.board)}/${encodeURIComponent(target.node.id)}?source=${encodeURIComponent(plan.source_ref)}`;
  const state = await remakeRequest(url);
  const receipt = state?.remake_plans?.[plan.id];
  if (!receipt || !card.isConnected || boardId !== plan.board) return;
  apply(receipt.shots);
  acShowRemakeReceipt(card, url, plan, state, receipt.result, target.node.id);
 } catch {}
}

async function watchRemakePlan(results, url, plan, targets) {
 if (!targets.length) return;
 let allDone = false;
 const deadline = Date.now() + 30 * 60 * 1000;
 while (!allDone && results.isConnected && boardId === plan.board && Date.now() < deadline) {
  try {
   const jobs = await acApi("/api/jobs?ids=" + encodeURIComponent(targets.map(t => t.job).join(",")));
   const latest = await remakeRequest(url);
   if (!results.isConnected || boardId !== plan.board) return;
   allDone = targets.every(t => ["done","error"].includes(jobs[t.job]?.state));
   results.replaceChildren();
   for (const {index, frame, job} of targets) {
    const shot = latest.shots[index], preview = shot?.frames[frame]?.previews.find(p => p.job === job);
    const line = document.createElement("div");
    const ref = preview?.ref || jobs[job]?.outputs?.[0]?.ref;
    line.textContent = `镜头 ${index + 1} · ${ref ? "预览完成" : preview?.error || jobs[job]?.error || "生成中"}`;
    if (ref) {
     const view = document.createElement("img");
     view.src = remakeMedia(ref); view.alt = `镜头 ${index + 1} 换角预览`;
     line.append(view);
    }
    if (preview?.ref && latest.cut_revision === plan.cut_revision) {
     const accept = document.createElement("button"); accept.type = "button"; accept.textContent = "采用预览";
     accept.disabled = shot.frames[frame].approved === job;
     if (accept.disabled) accept.textContent = "已采用";
     accept.onclick = async () => {
      accept.disabled = true;
      try {
       await remakeRequest(url, {action:"approve", shot:index, frame, job, cut_revision:plan.cut_revision});
       accept.textContent = "已采用";
      } catch (e) { accept.disabled = false; toast(e.message); }
     };
     line.append(accept);
    }
    results.append(line);
   }
  } catch (e) {
   results.textContent = "进度暂不可用 · " + e.message;
  }
  if (!allDone) await new Promise(resolve => setTimeout(resolve, 1700));
 }
 if (!allDone && results.isConnected && boardId === plan.board) results.textContent = "等待超时，可在重制工作区继续查看任务";
}

async function acReviewRemake(button) {
 const card = button.closest("[data-review-board]");
 if (!card || button.disabled || card.getAttribute("aria-busy") === "true") return;
 const {reviewBoard, reviewNode, reviewRef, reviewShot, reviewRevision} = card.dataset;
 const info = $("[data-review-status]", card);
 const decisions = $$("[data-remake-decision]:not(:disabled)", card);
 const adopting = button.dataset.remakeDecision === "adopt";
 const shot = Number(reviewShot) - 1;
 const job = button.dataset.reviewJob;
 card.setAttribute("aria-busy", "true");
 decisions.forEach(control => { control.disabled = true; });
 info.textContent = "正在保存审核决定…";
 try {
  if (reviewBoard !== boardId) throw new Error("画布已切换，请重新打开对应对话");
  await flushSave();
  if (reviewBoard !== boardId) throw new Error("画布已切换，请重新打开对应对话");
  const target = vtResolve(reviewNode, reviewRef);
  if (!target || target.node.type !== "video" || target.node.versions[target.index]?.ref !== reviewRef) {
   throw new Error("原片版本已不存在");
  }
  const url = "/api/video-remake/" + encodeURIComponent(reviewBoard) + "/" + encodeURIComponent(target.node.id) +
   "?source=" + encodeURIComponent(reviewRef);
  const session = await remakeRequest(url, {
   action:adopting ? "approve_video" : "keep", shot, cut_revision:Number(reviewRevision), ...(adopting ? {job} : {}),
  });
  const selected = session.shots[shot];
  for (const control of decisions) {
   const pressed = selected.keep_original ? control.dataset.remakeDecision === "keep" : !!selected.adopted_video &&
    selected.adopted_video === control.dataset.reviewJob;
   control.setAttribute("aria-pressed", String(pressed));
  }
  info.textContent = adopting ? `镜头 ${reviewShot} 已采用所选版本。` : `镜头 ${reviewShot} 已设为保留原片。`;
 } catch (error) {
  info.textContent = error.message;
 } finally {
  decisions.forEach(control => { control.disabled = false; });
  card.removeAttribute("aria-busy");
 }
}

function acAddChoices(message, event) {
 const prose = Array.from(message.children).filter(el => !["OL","UL","PRE","BLOCKQUOTE"].includes(el.tagName));
 const prompt = prose.map(el => el.textContent).join(" ");
 if (!/(?:请选择|(?:你|您)(?:想|要|会)?选|选哪|选一个|哪[个种一]|二选一|回复\s*[12]|1\s*还是\s*2|choose|pick one|which option)/i.test(prompt)) return;
 const lists = Array.from(message.children).filter(el => el.tagName === "OL");
 const list = lists[0];
 let options;
 if (lists.length === 1) {
  const items = Array.from(list.children);
  if (list.start !== 1 || items.some(el => el.querySelector("ol,ul,pre,table,input,a,img"))) return;
  options = items.map(el => el.textContent.trim().replace(/\s+/g, " "));
 } else if (!lists.length && /(?:^|\D)1\s*还是\s*2(?:\D|$)/.test(prompt)) {
  options = ["", ""];
 } else return;
 if (options.length < 2 || options.length > 6 || options.some(label => label.length > 350)) return;
 const card = document.createElement("div");
 card.className = "ac-choices";
 card.dataset.event = event.id;
 card.setAttribute("role", "group");
 card.setAttribute("aria-label", "请选择一个方案");
 const title = document.createElement("strong");
 title.textContent = "请选择一个方案";
 card.append(title);
 options.forEach((label, index) => {
  const button = document.createElement("button");
  button.type = "button";
  const number = document.createElement("span");
  number.className = "ac-choice-number";
  number.textContent = index + 1;
  button.append(number, document.createTextNode(label || `选择 ${index + 1}`));
  button.disabled = true;
  button.onclick = () => {
   if (!button.disabled) acSend(label ? `我选择 ${index + 1}：${label}` : `我选择 ${index + 1}`);
  };
  card.append(button);
 });
 if (list) list.replaceWith(card);
 else message.append(card);
}

function acMarkRetried(card) {
 if(!card)return;
 const button=$("[data-retry-call]",card);
 if(!button)return;
 button.disabled=true;
 button.dataset.attempted="yes";
 button.textContent="已提交重试";
}

async function acRetryCall(button) {
 if(button.disabled||!AC.session)return;
 const sid=AC.session;
 const feedback=$("[role=status]",button.parentElement);
 button.disabled=true;button.dataset.sending="yes";
 feedback.textContent="";
 try{
  await flushSave();
  if(sid!==AC.session)return;
  await acApi(`/api/chat/sessions/${encodeURIComponent(sid)}/calls/${encodeURIComponent(button.dataset.retryCall)}/retry`,{});
  acMarkRetried(button.closest(".ac-call"));
  await acPoll();
 }catch(e){feedback.textContent=e.message;}
 finally{delete button.dataset.sending;if(sid===AC.session)acRenderState();}
}

function acAddCallRetry(card, data) {
 const host=$(".ac-output",card), row=document.createElement("div"), button=document.createElement("button");
 const count=data.retry_count;
 row.className="ac-retry";
 button.type="button";button.dataset.retryCall=data.call_id;
 button.textContent=count>1?`按原参数重试 ${count} 个失败结果`:"按原参数重试";
 button.onclick=()=>acRetryCall(button);
 const feedback=document.createElement("span");feedback.setAttribute("role","status");
 if(data.result.errors?.length && !data.result.error){
  const text=document.createElement("pre");text.textContent=data.result.errors.join("；");row.append(text);
 }
 row.append(button,feedback);
 host.append(row);
 card.open=true;
}

function acAppendEvent(e,replay=false){
 const box=$("#acMessages"),d=e.data;let el;
 if(e.kind==="question_answer"){
  acQuestionDrafts.delete(d.call_id);
  el=document.createElement("div");el.className="ac-msg user ac-question-summary";
  el.innerHTML=`<strong>已提交创作确认</strong><dl>${d.answers.map(item=>`<div><dt>${esc(item.question)}</dt><dd>${esc(item.answer)}</dd></div>`).join("")}</dl>`;
  box.append(el);return;
 }
 if(["user","assistant","notice"].includes(e.kind)){
  el=document.createElement("div");el.className="ac-msg "+e.kind;
  if(e.kind!=="notice")acMarkdown(el,e.kind==="user" ? cmReadableReferences(d.text) : d.text);else el.textContent=d.text;
  if(e.kind==="user"&&d.execution_scope&&Object.hasOwn(AC_EXECUTION_SCOPES,d.execution_scope)){
   const badge=document.createElement("div");badge.className="ac-sent-skill";
   badge.textContent=AC_EXECUTION_SCOPES[d.execution_scope];el.append(badge);
  }
  if(e.kind==="user"&&d.skill){
   const badge=document.createElement("div");
   badge.className="ac-sent-skill";badge.textContent="创作技能 · "+d.skill.name;
   el.append(badge);
  }
  if(e.kind==="user"&&d.documents?.length){
   const attachments=document.createElement("div");
   attachments.className="ac-sent-skill";
   attachments.textContent="附件 · "+d.documents.map(doc=>doc.name).join("、");
   el.append(attachments);
  }
  if(e.kind==="user"&&d.selected_versions?.length){
   const refs=document.createElement("div");
   refs.className="ac-sent-skill";
   refs.textContent=d.selected_versions.map(item=>item.name+" · 版本 "+item.version).join("、");
   el.append(refs);
  }
  if(e.kind==="user"&&d.placement){
   const location=document.createElement("div");location.className="ac-sent-skill";
   location.textContent=`放置位置 · ${d.placement.x}, ${d.placement.y}`;
   el.append(location);
  }
  if(e.kind==="user")for(const [i,note] of (d.reviews || (d.review?[d.review]:[])).entries()){
   const review=document.createElement("details"), summary=document.createElement("summary");
   review.className="ac-sent-review";
   summary.textContent="引用审阅评论" + (d.reviews?.length>1 ? " "+(i+1) : "");
   if(note.anchor)summary.textContent+=" · "+ccAnchorLabel(note.anchor);
   review.append(summary);
   if(note.anchor?.passage?.quote){
    const original=document.createElement("blockquote");original.textContent=note.anchor.passage.quote;review.append(original);
   }
   for(const text of [note.body,...note.replies]) {
    const quote=document.createElement("p"); quote.textContent=text; review.append(quote);
   }
   el.append(review);
  }
  if(e.kind==="assistant")acAddChoices(el,e);
 }
 if(e.kind==="retry_queued"){acMarkRetried(AC.calls.get(d.call_id));return;}
 if(e.kind==="profile_decision"){cpApplyDecision(d.id,d.decision);return;}
 if(e.kind==="tool_start"){
  el=document.createElement("details");
  el.className="ac-call";
  el.dataset.call=d.call_id;
  el.dataset.tool=d.name;
  el.dataset.label=(d.retry?"重试 · ":"")+(AC_LABELS[d.name]||d.name);
  el.open=!!d.retry;
  el.innerHTML=`<summary>${esc(el.dataset.label)} · 执行中</summary><div class="ac-progress"></div><div class="ac-output"></div>`;
  AC.calls.set(d.call_id,el);
 }
 if(e.kind==="tool_end"){
  el=AC.calls.get(d.call_id);
  if(!el)return;
  const result=d.result, output=$(".ac-output",el);
  if(result.creative_directions?.length||result.previs_node||result.playlist_node||result.workflow||result.workflow_templates||result.template_fill_plan||result.reference_plan||result.group_run_plan||result.storyboard_plan||result.shot_review||result.shot_revision||result.shot_range_plan||result.remake_plan||result.review_versions?.length||
     result.preview?.completed?.length||result.video?.completed||d.name==="video_remake_export"&&result.export_ref||
     ["video_broll_generate","video_extend"].includes(d.name)&&result.nodes?.length||result.sources?.length)el.open=true;
  el.classList.add(result.error||d.retry_count?"error":"done");
  const state=result.error?"未完成":d.retry_count?"部分失败":result.profile_suggestion||result.reference_plan||result.group_run_plan||result.storyboard_plan||result.shot_revision||result.shot_range_plan||result.template_fill_plan?"等待确认":"完成";
  $("summary",el).textContent=el.dataset.label+" · "+state;
  $(".ac-progress",el).textContent="";
  const detail=document.createElement("pre");
  let description="画布操作已保存。";
  if(result.nodes)description=`已保存 ${result.nodes.length} 个结果，点击缩略图定位。`;
  else if(result.total_nodes!=null)description=`已读取画布，共 ${result.total_nodes} 个节点。`;
  else if(d.name==="image_segment")description="选区已准备好，可继续局部编辑。";
  else if(d.name==="canvas_focus")description="已向页面发送定位请求。";
  else if(result.adopted)description="已采用："+result.adopted.map(a=>a.name).join("、");
  else if(result.memories)description="找到 "+result.memories.length+" 条创作记忆。";
  else if(result.memory)description="已保存记忆："+result.memory.name;
  detail.textContent=result.error||result.text||description;
  output.replaceChildren(detail);
  output.insertAdjacentHTML("beforeend",acResultCards(result));
  if(result.sources?.length)output.insertAdjacentHTML("beforeend",acWebSources(result.sources));
  const planCard=$("[data-plan]",el);
  if(planCard)acRestoreRemakePlan(planCard);
  if(result.workflow)acWorkflowResult(output,result.workflow);
  if(typeof aeResultExtras==="function")aeResultExtras(output,result,d.name);
  if(d.retry_count)acAddCallRetry(el,d);
  if(result.profile_suggestion){cpAddSuggestion(output,result.profile_suggestion);el.open=true;}
  return;
 }
 if(e.kind==="progress"){
  el=AC.calls.get(d.call_id);
  if(el){
   const progress=d.jobs.map(j=>{const phase=AC_PHASES[j.phase]||AC_PHASES[j.state]||"处理中",pct=j.max?` · ${Math.min(j.state==="done"?100:99,Math.round((j.value||0)/j.max*100))}%`:"";return phase+pct+(j.ahead?` · 前方 ${j.ahead} 个任务`:"");}).join(" / ");
   $(".ac-progress",el).textContent=progress;
   if(["video_remake_export","video_remake_preview","video_remake_generate"].includes(el.dataset.tool))$("summary",el).textContent=`${AC_LABELS[el.dataset.tool]} · ${progress}`;
  }
  return;
 }
 if(e.kind==="focus"&&!replay){acFocus(d.node_ids,d.open_editor);return;}
 if(typeof aeAppendEvent==="function"&&aeAppendEvent(e,replay))return;
 if(el){$(".ac-empty",box)?.remove();box.append(el);}
}
function acWorkflowResult(target, report){
 const button=document.createElement("button");
 button.type="button";
 button.textContent="打开制作复盘";
 button.onclick=()=>openWorkflowReview(report.node, report.version);
 target.append(button);
}

function acDocumentUrl(sid,id) {
 return `/api/chat/sessions/${encodeURIComponent(sid)}/documents${id?"/"+encodeURIComponent(id):""}`;
}
async function acAddDocuments(files) {
 if(!AC.session || AC.board!==boardId || AC.documentUpload || AC.sending || !files.length)return;
 const limit=2-AC.documents.length;
 if(files.length>limit)return toast("每条消息最多添加 2 个文档");
 if(files.some(file=>!CM_DOCUMENT_EXT.test(file.name)))return toast("支持 TXT、Markdown、CSV、JSON、DOCX 和 PDF 文档");
 if(files.some(file=>file.size>8*1024*1024))return toast("每个文档不能超过 8 MB");
 const sid=AC.session, epoch=AC.epoch, operation={};
 AC.documentUpload=operation;
 acRenderState();
 try{
  for(const file of files){
   const form=new FormData();
   form.append("file",file,file.name);
   const result=await (await fetchOk(acDocumentUrl(sid),{method:"POST",body:form})).json();
   if(sid!==AC.session || epoch!==AC.epoch){
    void boardRequest(acDocumentUrl(sid,result.id),"DELETE").catch(()=>{});
    return;
   }
   AC.documents.push(result);
  }
 }catch(error){if(epoch===AC.epoch)toast(error.message,5000);}
 finally{if(AC.documentUpload===operation){AC.documentUpload=null;acRenderState();}}
}
function acRenderDocuments(){
 const pane=$("#acDocuments");
 const markup=AC.documents.map(doc=>`<span class="ac-ref" title="${esc(doc.name)}">${ico("script")}<span>${esc(doc.name)}${doc.truncated?" · 已截取":""}</span><button type="button" data-remove-document="${esc(doc.id)}" aria-label="移除附件">×</button></span>`).join("");
 if(pane._items!==markup){pane._items=markup;pane.innerHTML=markup;}
 pane.hidden=!AC.documents.length;
 $("#acAttachDocs").disabled=!AC.session||AC.sending||!!AC.documentUpload||AC.documents.length>=2;
 $("#acAttachDocs").lastChild.textContent=AC.documentUpload?"读取中…":"文档";
}
function acRenderQuestions(){
 const panel=$("#acQuestions"), card=AC.questionnaires[0];
 if(!card){panel.hidden=true;panel.replaceChildren();panel._step=null;return;}
 if(!acQuestionDrafts.has(card.id))acQuestionDrafts.set(card.id,{
  step:0,answers:card.questions.map(question=>({pick:question.options.length?null:-1,value:""}))
 });
 const draft=acQuestionDrafts.get(card.id), {step,answers}=draft;
 if(draft.sent){panel.hidden=true;return;}
 panel.hidden=false;
 const key=card.id+":"+step;
 if(panel._step===key)return;
 panel._step=key;
 const item=card.questions[step], selection=answers[step];
 const options=item?.options||[];
 panel.innerHTML=`<form>
  <header><strong>需要你的确认</strong><span>${item?`第 ${step+1} 项，共 ${answers.length} 项`:"核对答案"}</span></header>
  ${item?`<fieldset><legend>${esc(item.prompt)}</legend>
    ${options.map((text,i)=>`<label><input type="radio" name="choice" value="${i}" ${selection.pick===i?"checked":""}>${esc(text)}</label>`).join("")}
    ${options.length?`<label><input type="radio" name="choice" value="-1" ${selection.pick===-1?"checked":""}>自填答案</label>`:""}
    <textarea maxlength="500" aria-label="填写答案" rows="2" ${selection.pick===-1?"":"hidden"}>${esc(selection.pick===-1?selection.value:"")}</textarea>
  </fieldset>`:`<dl>${card.questions.map(({prompt},i)=>`<div><dt>${esc(prompt)}</dt><dd>${esc(answers[i].value)}</dd></div>`).join("")}</dl>`}
  <footer>${step?'<button type="button" data-question-back>上一步</button>':""}
  ${item?`<button type="button" data-question-next ${selection.value.trim()?"":"disabled"}>${step+1===answers.length?"核对答案":"下一项"}</button>`:
    '<button type="submit">提交答案</button>'}</footer></form>`;
 const form=$("form",panel), next=$("[data-question-next]",form);
 const move=offset=>{
  draft.step+=offset;acRenderQuestions();
  const heading=$("legend",panel)||$("header strong",panel);
  heading.setAttribute("tabindex","-1");heading.focus();
 };
 $("[data-question-back]",form)?.addEventListener("click",()=>move(-1));
 if(item){
  const source=$("textarea",form), update=()=>{next.disabled=!selection.value.trim();};
  form.onchange=e=>{
   if(e.target.name!=="choice")return;
   selection.pick=Number(e.target.value);
   source.hidden=selection.pick!==-1;
   selection.value=source.hidden?options[selection.pick]:source.value;
   if(!source.hidden)source.focus();
   update();
  };
  source.oninput=()=>{selection.value=source.value;update();};
  next.onclick=()=>move(1);
 }
 form.onsubmit=async e=>{
  e.preventDefault();
  if(item||draft.sending)return;
  const epoch=AC.epoch, button=$("button[type=submit]",form);
  button.disabled=true;draft.sending=true;
  try{
   await acApi(`/api/chat/runs/${encodeURIComponent(card.run_id)}/questions/${encodeURIComponent(card.id)}`,
    {answers:answers.map(answer=>answer.value.trim())});
   draft.sent=true;
   if(epoch===AC.epoch){acRenderQuestions();await acPoll();}
  }catch(error){if(epoch===AC.epoch){toast(error.message);await acPoll();}}
  finally{draft.sending=false;button.disabled=false;}
 };
}

function acRenderState(){
 if(AC.open)acRenderRefs();
 acRenderDocuments();
 acRenderApprovals();
 acRenderQuestions();
 const active=acActive(),latest=AC.runs[0];
 for(const button of $$("[data-retry-call]",$("#acMessages"))) {
  button.disabled=!!(button.dataset.attempted||button.dataset.sending||active||AC.queue.length||AC.sending);
 }
 $("#acStatus").textContent=active?AC_STATES[active.state]:(latest?.error||AC_STATES[latest?.state]||"可以讨论，也可以直接操作当前画布");
 if(AC.questionnaires.length)$("#acStatus").textContent="请完成创作确认后继续";
 const queue=$("#acQueue");
 const queueMarkup=AC.queue.map((item,index)=>`<li><span title="${esc(item.text)}">${esc(item.text)}</span><button type="button" data-remove-queued="${esc(item.id)}" aria-label="移除第 ${index+1} 条排队消息">移除</button></li>`).join("");
 if(queue._items!==queueMarkup){queue._items=queueMarkup;$("ol",queue).innerHTML=queueMarkup;}
 queue.hidden=!AC.queue.length;
 $("[data-queued-count]",queue).textContent="待执行 · "+AC.queue.length;
 if(!active&&AC.queue.length)$("#acStatus").textContent="指令已入队，等待并行位置";
 const lastMessage = AC.events.findLast(e => ["assistant","user","question_answer"].includes(e.kind));
 let choosing = false;
 for (const card of $$("#acMessages .ac-choices")) {
  const current = AC.session && lastMessage?.kind === "assistant" && card.dataset.event === String(lastMessage.id);
  for (const button of card.querySelectorAll("button")) button.disabled = !current || !!active || !!AC.queue.length || AC.sending;
  choosing ||= !!current && !active && !AC.queue.length && !AC.sending;
 }
 if (choosing) $("#acStatus").textContent = "请选择上方的方案，或输入你的回复";
 $("#acStop").hidden=!active;$("#acStop").disabled=active?.state==="stopping";
 $("#acSend").disabled=AC.sending||!!AC.documentUpload||!!AC.loadingSessions||!AC.session||(!$("#acInput").value.trim()&&!AC.documents.length&&!AC.reviews.length);
 $("#acSend").textContent=active||AC.queue.length?"加入队列":"发送";
 $("#acUndo").hidden=!latest||!!active||!!AC.queue.length;
 $("#acNew").disabled=$("#acSessions").disabled=!!(AC.sending||AC.documentUpload||AC.loadingSessions);
 $("#acExecutionScope").value=AC.executionScope;
 $("#acExecutionScope").disabled=AC.sending||!!AC.loadingSessions;
 $("#acInput").placeholder=AC.executionScope==="brainstorm"?"描述创作目标，输入 @ 引用素材，一起探索不同方向…":"描述你想做什么，输入 @ 引用素材…";
 $("#acGenerationMode").disabled=AC.executionScope!=="full"||AC.sending||!!AC.loadingSessions;
 acRenderParallel();
 acRenderNodeActivity();
 $("#acModel").textContent=latest?.model?latest.model.provider+" · "+latest.model.model:"";
 acRenderModelPicker();
 if(typeof aeRenderInputs==="function")aeRenderInputs();
}

function acRenderModelPicker(){
 const state=AC.modelSelection, picker=$("#acModelChoice"), thinking=$("#acThinkingLevel");
 const models=AC.models.slice();
 if(state.locked?.id&&!models.some(model=>model.id===state.locked.id)){
  models.push({...state.locked,name:state.locked.name+"（已停用）",levels:[]});
 }
 const choice=state.locked?.id??state.choice??"";
 const option=models.find(model=>model.id===choice);
 const choices='<option value="">自动（平台路由）</option>'+models.map(model=>
  `<option value="${esc(model.id)}">${esc(model.name+" · "+model.model)}</option>`).join("");
 if(picker._options!==choices){picker._options=choices;picker.innerHTML=choices;}
 picker.value=option?.id||"";
 picker.disabled=!AC.session||AC.sending||!!AC.loadingSessions||!!state.locked||!models.length;
 picker.title=state.locked?"新建对话可切换模型":"选择本对话使用的文本模型";
 const levels=option?.levels||[];
 thinking.parentElement.hidden=levels.length<2;
 const options=levels.map(level=>`<option value="${level}">${AC_THINKING_LEVELS[level]}</option>`).join("");
 if(thinking._options!==options){thinking._options=options;thinking.innerHTML=options;}
 thinking.value=levels.includes(state.level)?state.level:"off";
 thinking.disabled=AC.sending||!!AC.loadingSessions;
}

function acSessionDirectory(sessions, selected=AC.session){
 AC.sessions=sessions;
 const select=$("#acSessions");
 const options=AC.sessions.map(s=>`<option value="${esc(s.id)}">${esc(s.title)}</option>`).join("");
 if(select._items!==options){select._items=options;select.innerHTML=options;}
 if(selected)select.value=selected;
}

function acRenderParallel(){
 const panel=$("#acParallel");
 const active=AC.sessions.filter(session=>session.run_state||session.queued_count>0);
 panel.hidden=!active.some(session=>session.id!==AC.session);
 const disabled=AC.sending||AC.documentUpload||AC.loadingSessions;
 const list=active.map(session=>{
  const current=session.id===AC.session;
  const phase=(AC_STATES[session.run_state]||"等待执行").replace(/…$/,"");
  const status=phase+(session.queued_count>0&&session.run_state?` · 排队 ${session.queued_count}`:"");
  return `<button type="button" data-parallel-session="${esc(session.id)}"${current?' aria-current="true"':""}${disabled?" disabled":""}>
   <span>${esc(session.title)}</span> <small>${esc(status)}</small></button>`;
 }).join("");
 if(panel._items!==list){panel._items=list;panel.innerHTML=list;}
}

function acRenderNodeActivity(){
 const directory=AC.board===boardId&&AC.session?AC.sessions:AC.nodeDirectory?.board===boardId?AC.nodeDirectory.rows:[];
 const sessions=directory.filter(session=>session.run_state&&session.node_activity);
 const calls=new Map(sessions.flatMap(session=>session.node_activity.calls.map(id=>[id,session])));
 const active=new Map();
 const attach=(id,session)=>{
  if(els.has(id)){
   if(!active.has(id))active.set(id,new Set());
   active.get(id).add(session);
  }
 };
 for(const session of sessions)for(const id of session.node_activity.nodes)attach(id,session);
 if(calls.size)for(const n of B.nodes){
  const session=calls.get(n.job?.agent_call);
  if(session)attach(n.id,session);
 }
 for(const box of $$(".node-agent-activity",world))if(!active.has(box.dataset.nodeId))box.remove();
 const disabled=AC.sending||AC.documentUpload||AC.loadingSessions;
 for(const [id,relevant] of active){
  const element=els.get(id);
  let box=$(".node-agent-activity",element);
  if(!box){
   box=document.createElement("div");box.className="node-agent-activity";box.dataset.nodeId=id;
   box.addEventListener("pointerdown",event=>event.stopPropagation());
   box.addEventListener("dblclick",event=>event.stopPropagation());
   box.onclick=event=>{
    const btn=event.target.closest("[data-node-agent-session]");
    if(!btn)return;
    event.stopPropagation();
    acOpenNodeSession(btn.dataset.nodeAgentSession).catch(error=>toast(error.message));
   };
   $(".card",element).append(box);
  }
  const labels={thinking:"规划中",running:"执行中",waiting_approval:"待确认",waiting_input:"待补充",stopping:"正在停止"};
  const markup=[...relevant].map(session=>`<button type="button" data-node-agent-session="${esc(session.id)}"${disabled?" disabled":""}
   title="${esc(session.title)}" aria-label="打开对话 ${esc(session.title)} · ${esc(labels[session.run_state]||"")}">
   ${ico("script")}<span>${esc(labels[session.run_state]||"助手")}</span></button>`).join("");
  if(box._items!==markup){box._items=markup;box.innerHTML=markup;}
 }
}

async function acRefreshNodeDirectory(){
 const board=boardId;
 if(!board||AC.nodeDirectoryRequest?.board===board)return;
 const request=AC.nodeDirectoryRequest={board};
 try {
  const data=await acApi("/api/chat/sessions?board="+encodeURIComponent(board));
  if(board!==boardId||AC.nodeDirectoryRequest!==request)return;
  AC.nodeDirectory={board,rows:Array.isArray(data.sessions)?data.sessions:[]};
  acRenderNodeActivity();
 }catch{}
 finally{if(AC.nodeDirectoryRequest===request)AC.nodeDirectoryRequest=null;}
}

async function acOpenNodeSession(id){
 if(AC.sending||AC.documentUpload||AC.loadingSessions)return;
 const board=boardId;
 await acOpen({focus:false});
 if(board!==boardId || AC.board!==board || !AC.sessions.some(session=>session.id===id))return;
 if(id!==AC.session)await acLoadSession(id);
 $("#acInput").focus();
}

function acRememberDraft(){
 if(!AC.session)return;
 AC.drafts.set(AC.session,{text:$("#acInput").value,refs:AC.refs?.slice()??null,pins:[...AC.referencePins],
  selection:AC.selection,reviews:AC.reviews.slice(),placement:AC.placement,skill:AC.skill,documents:AC.documents.slice(),
  modelChoice:AC.modelSelection.choice,thinkingLevel:AC.modelSelection.level,executionScope:AC.executionScope});
}

function acRestoreDraft(draft){
 $("#acInput").value=draft.text;
 AC.refs=draft.refs;
 AC.referencePins=new Map(draft.pins);
 AC.selection=draft.selection;
 AC.reviews=draft.reviews;
 AC.placement=draft.placement;
 AC.documents=draft.documents;
 AC.modelSelection.choice=draft.modelChoice;
 AC.modelSelection.level=draft.thinkingLevel;
 AC.executionScope=draft.executionScope||"full";
 csChoose(draft.skill);
}
function acRenderApprovals() {
 const panel=$("#acApprovals");
 const items=AC.approvals.filter(item=>!acDecidedApprovals.has(item.id));
 const units={image:"张图片",video:"段视频",audio:"段音频",previs:"段白模预演"};
 const markup=items.map(({id,plan={},name})=>{
  const graphics=name==="video_broll_generate";
  const details=[plan.duration && `${plan.duration} 秒`,plan.resolution || plan.quality,plan.provider,
   plan.model,plan.aspect || (Number.isFinite(plan.ar) && `宽高比 ${Number(plan.ar.toFixed(2))}:1`),
   plan.voice,graphics && plan.mode,plan.references>0 && `${plan.references} 个素材引用`,plan.asset_count>0 && `${plan.asset_count} 个资产引用`].filter(Boolean).join(" · ");
  const editable=plan.editable||{};
  const form=editable.prompt||editable.count?`<details><summary>调整参数</summary>
    <form class="ac-approval-editor" data-approval-edit="${esc(id)}">
    ${editable.prompt?`<label>${plan.kind==="audio"?"文案或描述":"提示词"}<textarea name="prompt" required maxlength="${esc(editable.prompt)}">${esc(plan.prompt||"")}</textarea></label>`:""}
    ${editable.count?`<label>生成数量<input type="number" name="count" required min="1" max="${esc(editable.count)}" value="${esc(plan.count)}"></label>`:""}
    <div class="ac-approval-actions"><button type="submit">保存参数</button><button type="reset">放弃更改</button></div></form></details>`:"";
  return `<article><strong>确认生成</strong><div>${esc(plan.label || AC_LABELS[name] || "生成方案")} · ${esc(plan.count)} ${esc(units[plan.kind]||"个结果")}</div>
   ${details?`<small>${esc(details)}</small>`:""}
   ${plan.camera_summary||plan.light_summary?`<p>${esc(plan.camera_summary||plan.light_summary)}</p>`:""}
   ${plan.prompt?`<details${graphics?" open":""}><summary>${graphics?"B-roll 画面方案":plan.items?"整组风格":plan.kind==="audio"?"文案或描述":"提示词"}</summary><p>${esc(plan.prompt)}</p></details>`:""}
   ${plan.items?`<ol class="ac-approval-items">${plan.items.map(item=>`<li><details><summary>${esc(item.name)} · ${esc(item.aspect==="auto"?"沿用参考比例":item.aspect)}</summary><p>${esc(item.prompt)}</p></details></li>`).join("")}</ol>`:""}
   ${form}
   <div class="ac-approval-actions"><button type="button" data-approval-id="${esc(id)}" data-decision="approve">确认生成</button>
   <button type="button" data-approval-id="${esc(id)}" data-decision="skip">跳过</button></div></article>`;
 }).join("");
 if(panel._items!==markup){panel._items=markup;panel.innerHTML=markup;}
 panel.hidden=!items.length;
}
function acRenderReplyPreview(box,replies){
 const reply=replies?.at(-1);
 let preview=$("[data-ac-reply-preview]",box);
 if(!reply?.text){preview?.remove();return;}
 if(!preview){
  preview=document.createElement("div");
  preview.className="ac-msg assistant";
  preview.dataset.acReplyPreview="";
 }
 if(preview.textContent!==reply.text)preview.textContent=reply.text;
 if(box.lastElementChild!==preview)box.append(preview);
}
async function acPoll(background=false){
 if(AC.polling?.epoch===AC.epoch||(!AC.open&&!background)||!AC.session)return;
 const sid=AC.session,epoch=AC.epoch,polling={epoch};
 AC.polling=polling;
 try{const j=await acApi(`/api/chat/sessions/${sid}?after=${AC.cursor}`);if(epoch!==AC.epoch||sid!==AC.session)return;await acSyncBoard(j.board_rev);if(epoch!==AC.epoch)return;
  AC.runs=j.runs;AC.queue=j.queue||[];AC.inputs=j.inputs||[];AC.approvals=j.approvals||[];AC.questionnaires=j.questionnaires||[];const box=$("#acMessages"),bottom=box.scrollHeight-box.scrollTop-box.clientHeight<90;
  if(Array.isArray(j.model_options))AC.models=j.model_options;
  if(j.chat_model!==undefined){
   AC.modelSelection.locked=j.chat_model;
   AC.modelSelection.level??=j.thinking_level??"off";
  }
  if(Array.isArray(j.sessions)){
   const listed=j.sessions;
   if(j.session&&!listed.some(item=>item.id===sid))listed.push(j.session);
   acSessionDirectory(listed);
  }
  for(const e of j.events){AC.cursor=e.id;AC.events.push(e);acAppendEvent(e,AC.replaying||!AC.open);}
  acRenderReplyPreview(box,j.reply_previews);
  AC.replaying=false;acRenderState();if(bottom)box.scrollTop=box.scrollHeight;$("#acError").hidden=true;
 }catch(e){if(epoch===AC.epoch){$("#acError").textContent="连接中断，将自动重连："+e.message;$("#acError").hidden=false;}}finally{if(AC.polling===polling)AC.polling=false;}
}
function acResetSession(id){
 acVoiceCancel();
 AC.approvals=[];acDecidedApprovals.clear();
 AC.questionnaires=[];
 acPickPlacement(false);AC.placement=null;
 csClose();csChoose(null);cmClose();
 AC.epoch++;AC.session=id;AC.cursor=0;AC.events=[];AC.runs=[];AC.queue=[];AC.documents=[];AC.documentUpload=null;AC.inputs=[];AC.refs=null;AC.selection=null;AC.reviews=[];AC.calls.clear();AC.replaying=true;
 AC.referencePins.clear();
 AC.modelSelection={};
 AC.executionScope="full";
 $("#acMessages").replaceChildren();$("#acInput").value="";
 $("#acModel").textContent="使用平台配置的文本模型";
}
async function acLoadSession(id){
 acRememberDraft();
 acResetSession(id);
 const draft=AC.drafts.get(id), epoch=AC.epoch;
 if(draft)acRestoreDraft(draft);
 $("#acSessions").value=id;
 localStorage.setItem("h3.chat.session."+boardId,id);
 try{
  const outbox=JSON.parse(localStorage.getItem("h3.chat.outbox."+id));
  if(outbox?.payload){
   const {text,selected,selection_id,review_id,review_ids,skill_id,document_ids,selected_versions,placement,generation_mode,chat_model,thinking_level,execution_scope}=outbox.payload;
   if(!draft){
    $("#acInput").value=outbox.payload.text;AC.refs=outbox.payload.selected;
    AC.selection=outbox.selection||null;AC.reviews=outbox.reviews||(outbox.review?[outbox.review]:[]);
    AC.placement=placement||null;
    for(const {node_id,ref} of selected_versions||[])AC.referencePins.set(node_id,{ref,name:node(node_id)?.name||node_id});
    AC.documents=outbox.documents||[];
    AC.modelSelection.choice=chat_model;
    AC.modelSelection.level=thinking_level;
    AC.executionScope=Object.hasOwn(AC_EXECUTION_SCOPES,execution_scope)?execution_scope:"full";
    if(skill_id)csChoose(outbox.skill||{id:skill_id,name:"已选技能"});
   }
   AC.pending.set(JSON.stringify([boardId,id,text,selected,selection_id,review_ids||(review_id?[review_id]:[]),skill_id,document_ids||[],selected_versions||[],placement||null,generation_mode||"auto",chat_model||"",thinking_level||"off",execution_scope||"full"]),outbox.payload);
  }
 }catch{}
 acRenderRefs();acRenderState();await acPoll();
 if(AC.epoch===epoch)acRenderEmpty();
}
async function acSessions(fresh=false){
 const id=boardId;
 if(AC.loadingSessions?.board===id)return;
 const loading={board:id};
 AC.loadingSessions=loading;
 if(AC.board!==id){
  acRememberDraft();acResetSession(null);AC.board=id;acSessionDirectory([]);
  acRenderRefs();
 }
 const epoch=AC.epoch;
 const current=()=>id===boardId&&epoch===AC.epoch&&AC.loadingSessions===loading;
 acRenderState();
 try{
  const j=await acApi("/api/chat/sessions?board="+encodeURIComponent(id));
  if(!current())return;
  AC.models=(j.models||[]).filter(model=>model.id);
  let chosen=!fresh&&(j.sessions.find(s=>s.id===localStorage.getItem("h3.chat.session."+id))?.id||j.sessions[0]?.id);
  if(!chosen){
   const made=await acApi("/api/chat/sessions",{board:id});
   if(!current())return;
   chosen=made.id;j.sessions.unshift({id:chosen,title:"新对话"});
  }
  acSessionDirectory(j.sessions,chosen);
  await acLoadSession(chosen);
  if(id===boardId&&chosen===AC.session)return chosen;
 }finally{
  if(AC.loadingSessions===loading){AC.loadingSessions=null;acRenderState();}
 }
}
function acRenderEmpty(){const box=$("#acMessages");if(box.children.length)return;box.innerHTML=`<div class="ac-empty"><b>告诉我你想怎么创作</b><div>引用画布素材，我可以生成、编辑和整理结果。</div><button data-example="描述一下选中的图片">理解这张图片</button><button data-example="以选中图片为参考生成三个暖色版本，横向排列在原图右边">生成三个暖色版本</button><button data-example="把选中的节点横向排齐">整理选中的节点</button></div>`;$$("[data-example]",box).forEach(b=>b.onclick=()=>{$("#acInput").value=b.dataset.example;acRenderState();$("#acInput").focus();});}
async function acSend(choiceText){
 if(AC.sending||AC.documentUpload||AC.loadingSessions||!AC.session||(typeof choiceText==="string"&&(acActive()||AC.queue.length)))return;
 const input = $("#acInput"), draft = input.value;
 const reviews=AC.reviews, reviewIds=reviews.map(review=>review.id);
 const documents=typeof choiceText==="string"?[]:AC.documents.slice(), documentIds=documents.map(doc=>doc.id);
 const text=typeof choiceText==="string"?choiceText:draft.trim()||(reviewIds.length
  ? documentIds.length ? "请阅读引用的审阅评论和附件，汇总修改建议。" : "请汇总这些审阅评论并给出修改建议。"
  : documentIds.length?"请阅读我上传的文档":"");
 if(!text)return;
 const sid=AC.session,id=boardId,selection=AC.selection,selected=acRefs().map(n=>n.id);
 const skill=typeof choiceText==="string"?null:AC.skill;
 const placement=typeof choiceText==="string"?null:AC.placement;
 if(AC.board!==id)return;
 if(selected.length>30){toast("每条消息最多引用 30 个画布节点");return;}
 const selectedVersions=[...AC.referencePins].filter(([nid])=>AC.refs?.includes(nid))
  .map(([node_id,{ref}])=>({node_id,ref}));
 if(selectedVersions.some(({node_id,ref})=>!node(node_id)?.versions.some(v=>v.ref===ref))){
  toast("引用的节点或版本已移除，请重新选择");return;
 }
 if(selection&&(!selected.includes(selection.node_id)||!node(selection.node_id)?.versions.some(v=>v.ref===selection.source_ref))){
  toast("选区源图已失效，请移除选区或重新圈选");return;
 }
 const reviewConflict=acCheckReviews(reviews);
 if(reviewConflict){toast(reviewConflict);return;}
 const modelChoice=$("#acModelChoice").value, thinking=$("#acThinkingLevel").value||"off";
 const scope=typeof choiceText==="string"?(AC.events.findLast(event=>event.kind==="user")?.data.execution_scope||"full"):AC.executionScope;
 const generation=scope==="full"?acGenerationMode:"auto";
 const key=JSON.stringify([id,sid,text,selected,selection?.selection_id,reviewIds,skill?.id,documentIds,selectedVersions,placement,generation,modelChoice,thinking,scope]);
 let pending=AC.pending.get(key);
 if(!pending){
  pending={text,selected,request_key:crypto.randomUUID?.()||("req"+Date.now()+Math.random()),enqueue:typeof choiceText!=="string"};
  if(selection)pending.selection_id=selection.selection_id;
  if(reviewIds.length===1)pending.review_id=reviewIds[0];
  if(reviewIds.length>1)pending.review_ids=reviewIds;
  if(skill)pending.skill_id=skill.id;
  if(documentIds.length)pending.document_ids=documentIds;
  if(selectedVersions.length)pending.selected_versions=selectedVersions;
  if(placement)pending.placement=placement;
  if(generation!=="auto")pending.generation_mode=generation;
  if(scope!=="full")pending.execution_scope=scope;
  if(modelChoice)pending.chat_model=modelChoice;
  if(thinking!=="off")pending.thinking_level=thinking;
  AC.pending.set(key,pending);
  try{localStorage.setItem("h3.chat.outbox."+sid,JSON.stringify({payload:pending,selection,reviews,skill,documents}));}catch{}
 }
 if(typeof choiceText!=="string"){acPickPlacement(false);acVoiceCancel();}
 AC.sending=true;acRenderState();try{await flushSave();if(id!==boardId||sid!==AC.session)throw new Error("画布已切换，请重新发送");if(AC.pending.has(id))throw new Error("请先处理画布保存冲突");
  const sent=await acApi(`/api/chat/sessions/${sid}/messages`,pending);
  AC.pending.delete(key);localStorage.removeItem("h3.chat.outbox."+sid);
  if(id!==boardId||sid!==AC.session)return;
  AC.modelSelection.locked??=AC.models.find(model=>model.id===modelChoice)||{id:""};
  if(sent.state==="queued"){
   if(!AC.queue.some(item=>item.id===sent.id))AC.queue.push({id:sent.id,text});
   toast("已加入创作助手队列");
  }else if(!AC.runs.some(r=>r.id===sent.id))AC.runs.unshift(sent);
  const option=$("#acSessions").selectedOptions[0];if(option?.textContent==="新对话")option.textContent=text.slice(0,30);
  if(typeof choiceText!=="string"&&input.value===draft)input.value="";
  AC.documents=AC.documents.filter(doc=>!documentIds.includes(doc.id));
  AC.referencePins.clear();
  if(AC.selection===selection){AC.refs=null;AC.selection=null;}
  if(AC.reviews===reviews)AC.reviews=[];
  if(AC.placement===placement)AC.placement=null;
  if(skill&&AC.skill===skill)csChoose(null);
  await acPoll();acRenderRefs();
 }catch(e){toast(e.message,6000);}finally{AC.sending=false;acRenderState();}
}
function acShowPane(){AC.open=true;$("#agentChat").hidden=false;$("#chatLaunch").hidden=true;acRenderPlacement();acVoiceRefresh();}
async function acOpen({focus=true}={}){if(!B)return;acShowPane();try{await flushSave();if(AC.board!==boardId||!AC.session)await acSessions();else await acPoll();}catch(e){$("#acError").textContent=e.message;$("#acError").hidden=false;}if(focus&&AC.open)$("#acInput").focus();}
async function acSendShotRequest(board, payload, expectedSession=null){
 if(board!==boardId || !canvasCanEdit())throw new Error("请回到对应的可编辑画布");
 await acOpen({focus:false});
 if(board!==boardId || AC.board!==board || !AC.session || AC.loadingSessions)throw new Error("对话尚未准备好，请重试");
 const session=AC.session;
 if(expectedSession && session!==expectedSession)throw new Error("请回到审阅所属对话");
 await flushSave();
 if(board!==boardId || session!==AC.session || AC.pending.has(board))throw new Error("画布或对话已变化，请重试");
 const sent=await acApi(`/api/chat/sessions/${session}/messages`,payload);
 if(board===boardId && session===AC.session){
  if(sent.state==="queued")toast("已加入创作助手队列");
  await acPoll();
 }
}
function acBoardChanged(){cpClose();if(!AC.open){void acRefreshNodeDirectory();return;}acSessions().catch(e=>toast(e.message));}
function initAgentChat(){
 const launch=document.createElement("button");launch.id="chatLaunch";launch.innerHTML=`${ico("script")}<span>创作助手</span>`;launch.setAttribute("aria-controls","agentChat");launch.onclick=acOpen;document.body.append(launch);
 const pane=document.createElement("section");pane.id="agentChat";pane.hidden=true;pane.setAttribute("role","region");pane.setAttribute("aria-label","创作助手");pane.innerHTML=`<header class="ac-head"><strong>创作助手</strong><button id="acDock" title="切换停靠 / 浮动" aria-label="切换停靠 / 浮动">${ico("full")}</button><button id="acClose" title="收起，任务继续运行" aria-label="收起助手">×</button></header><div class="ac-subhead"><select id="acSessions" aria-label="对话历史"></select><button id="acNew">新对话</button></div><div id="acModel" class="ac-model">使用平台配置的文本模型</div><div id="acMessages" class="ac-messages" role="log" aria-label="对话与操作记录"></div><div id="acError" class="ac-status" hidden></div><div id="acStatus" class="ac-status" role="status"></div><div class="ac-composer"><div id="acRefs" class="ac-refs"></div><div id="acPicker" class="ac-picker" hidden></div><textarea id="acInput" aria-label="告诉助手要做什么" placeholder="描述你想做什么，输入 @ 引用素材…" maxlength="8000"></textarea><div class="ac-actions"><button id="acReference" title="引用画布节点">@ 引用</button><button id="acUndo" hidden>撤销本轮</button><span class="ac-hint">Enter 发送</span><button id="acStop" hidden>停止</button><button id="acSend" disabled>发送</button></div></div>`;document.body.append(pane);
 $("#acModel").insertAdjacentHTML("afterend",'<section id="acParallel" aria-label="并行对话" hidden></section>');
 $("#acModel").insertAdjacentHTML("beforebegin",`<div class="ac-model-settings">
   <label>对话模型<select id="acModelChoice"></select></label>
   <label hidden>思考强度<select id="acThinkingLevel"></select></label>
 </div>`);
 $("#acModelChoice").onchange=event=>{
  AC.modelSelection.choice=event.target.value;
  AC.modelSelection.level="off";
  acRenderModelPicker();
 };
 $("#acThinkingLevel").onchange=event=>{AC.modelSelection.level=event.target.value;};
 $("#acParallel").onclick=event=>{
  const button=event.target.closest("[data-parallel-session]");
  if(button&&!button.disabled&&button.dataset.parallelSession!==AC.session)
   acLoadSession(button.dataset.parallelSession).catch(error=>toast(error.message));
 };
 acVoiceInit();
 initCreativeSkills();
 initCreativeProfile();
 $("#acStatus").insertAdjacentHTML("afterend",`<section id="acApprovals" aria-label="待确认的生成方案" aria-live="polite" hidden></section>`);
 $("#acRefs").insertAdjacentHTML("beforebegin",'<section id="acQuestions" aria-label="待填写的创作确认" hidden></section>');
 $(".ac-subhead",pane).insertAdjacentHTML("afterend",`<div class="ac-execution-controls"><label class="ac-generation-mode">本轮范围 <select id="acExecutionScope" aria-label="本轮执行范围">${Object.entries(AC_EXECUTION_SCOPES).map(([key,label])=>`<option value="${key}">${label}</option>`).join("")}</select></label>
  <label class="ac-generation-mode">生成方式 <select id="acGenerationMode" aria-label="生成确认方式" title="智能确认每轮最多自动生成两张图片，超出额度的批次和其他类型会先确认">${Object.entries(AC_GENERATION_MODES).map(([key,label])=>`<option value="${key}">${label}</option>`).join("")}</select></label></div>`);
 $("#acExecutionScope").onchange=event=>{AC.executionScope=event.target.value;acRenderState();};
 const generationMode=$("#acGenerationMode");
 generationMode.value=acGenerationMode;
 generationMode.onchange=()=>{acGenerationMode=generationMode.value;localStorage.setItem("h3.chat.generationMode",acGenerationMode);};
 async function decideApproval(id,payload,origin){
  const item=AC.approvals.find(item=>item.id===id);
  if(!item || acDecidedApprovals.has(item.id))return;
  const card=origin.closest("article"), epoch=AC.epoch;
  if(card.dataset.pending)return;
  card.dataset.pending="true";
  const controls=$$("button",card), disabled=controls.map(button=>button.disabled);
  controls.forEach(button=>button.disabled=true);
  try{
   await acApi(`/api/chat/runs/${encodeURIComponent(item.run_id)}/approvals/${encodeURIComponent(item.id)}`,payload);
   if(epoch===AC.epoch){acDecidedApprovals.add(item.id);acRenderApprovals();await acPoll();}
  }catch(error){toast(error.message);if(epoch===AC.epoch)await acPoll();}
  finally{delete card.dataset.pending;controls.forEach((button,i)=>button.disabled=disabled[i]);}
 }
 $("#acApprovals").onclick=event=>{
  const button=event.target.closest("[data-approval-id]");
  if(button && !button.disabled)void decideApproval(button.dataset.approvalId,{decision:button.dataset.decision},button);
 };
 $("#acApprovals").onsubmit=event=>{
  const form=event.target.closest("[data-approval-edit]");
  if(!form)return;
  event.preventDefault();
  if(!form.reportValidity())return;
  const parameters={};
  if(form.elements.prompt)parameters.prompt=form.elements.prompt.value;
  if(form.elements.count)parameters.count=form.elements.count.valueAsNumber;
  void decideApproval(form.dataset.approvalEdit,{decision:"adjust",parameters},form);
 };
 $("#acApprovals").oninput=event=>{
  const form=event.target.closest("[data-approval-edit]");
  if(!form || form.closest("article").dataset.pending)return;
  $("[data-decision=approve]",form.closest("article")).disabled=[...form.elements].some(input=>input.name && input.value!==input.defaultValue);
 };
 $("#acApprovals").onreset=event=>{
  const form=event.target.closest("[data-approval-edit]");
  if(form && !form.closest("article").dataset.pending)$("[data-decision=approve]",form.closest("article")).disabled=false;
 };
 $("#acStatus").insertAdjacentHTML("afterend",`<section id="acQueue" aria-label="待执行指令" hidden><strong data-queued-count></strong><ol></ol></section>`);
 $("#acRefs").insertAdjacentHTML("afterend",`<div id="acDocuments" class="ac-refs" aria-label="文档附件" hidden></div>`);
 $("#acReference").insertAdjacentHTML("afterend",`<button type="button" id="acAttachDocs" title="添加文档附件" disabled>${ico("upload")}<span>文档</span></button>
   <button type="button" id="acPickPlacement" title="指定新结果放置位置" aria-label="指定新结果放置位置" aria-pressed="false">${ico("fit")}</button>
   <input type="file" id="acDocumentFile" accept=".txt,.md,.markdown,.csv,.json,.docx,.pdf" multiple hidden>`);
 const documentInput=$("#acDocumentFile"), composer=$(".ac-composer",pane);
 $("#acAttachDocs").onclick=()=>documentInput.click();
 documentInput.onchange=()=>{const files=[...documentInput.files];documentInput.value="";void acAddDocuments(files);};
 composer.ondragover=event=>{if(event.dataTransfer.types.includes("Files")){event.preventDefault();event.stopPropagation();}};
 composer.ondrop=event=>{
  const files=[...event.dataTransfer.files];
  if(files.length){event.preventDefault();event.stopPropagation();void acAddDocuments(files);}
 };
 $("#acDocuments").onclick=event=>{
  const button=event.target.closest("[data-remove-document]");
  if(!button || AC.sending)return;
  const id=button.dataset.removeDocument;
  AC.documents=AC.documents.filter(doc=>doc.id!==id);acRenderState();
  void boardRequest(acDocumentUrl(AC.session,id),"DELETE").catch(()=>{});
 };
 $("#acQueue").onclick=async event=>{
  const button=event.target.closest("[data-remove-queued]");
  if(!button||button.disabled)return;
  const sid=AC.session,id=button.dataset.removeQueued;
  button.disabled=true;
  try{
   await boardRequest(`/api/chat/runs/${encodeURIComponent(id)}/queue`,"DELETE");
   if(sid===AC.session){AC.queue=AC.queue.filter(item=>item.id!==id);acRenderState();}
  }catch(e){toast(e.message);}
  finally {button.disabled=false;if(sid===AC.session)await acPoll();}
 };
 $("#acClose").onclick=()=>{cpClose();lightDockAssistant(false);acVoiceCancel();acPickPlacement(false);csClose();AC.open=false;acRenderPlacement();pane.hidden=true;launch.hidden=false;};$("#acDock").onclick=()=>{pane.classList.toggle("floating");pane.style.left=pane.style.top=pane.style.height=pane.style.width="";acStoreWindow();};
 $("#acPickPlacement").onclick=()=>{
  if (AC.sending || !AC.session || AC.board!==boardId || !canvasCanEdit() || acVoicePointing()) return;
  acPickPlacement(!acPickingPlacement);
  if(acPickingPlacement)toast("点击画布空白处指定放置位置，按 Esc 取消");
 };
 document.addEventListener("keydown",event=>{
  if(event.key==="Escape"&&acPickingPlacement){event.preventDefault();event.stopPropagation();acPickPlacement(false);}
 },true);
 vp.addEventListener("pointerdown",event=>{
  if(!acPickingPlacement || event.button!==0)return;
  event.preventDefault();event.stopPropagation();
  if(!acCanvasBackground(event.target))return;
  acPickPlacement(false);
  if(AC.open&&AC.board===boardId&&canvasCanEdit()){
   const point=acPlacementPoint(toW(event.clientX,event.clientY));
   if(point){AC.placement=point;acRenderRefs();}
  }
 },true);
 $("#acNew").onclick=()=>acSessions(true).catch(e=>toast(e.message));$("#acSessions").onchange=e=>acLoadSession(e.target.value).catch(e=>toast(e.message));$("#acReference").onclick=acPick;$("#acSend").onclick=acSend;
 $("#acStop").title="停止此对话的当前任务，队列继续执行";
 $("#acInput").oninput=()=>{acRenderState();};$("#acInput").onkeydown=e=>{e.stopPropagation();if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing){e.preventDefault();acSend();}};
 $("#acStop").onclick=async()=>{const r=acActive();if(!r)return;try{await acApi(`/api/chat/runs/${r.id}/stop`,{});await acPoll();}catch(e){toast(e.message);}};
 $("#acUndo").onclick=async()=>{const rid=AC.runs[0]?.id;if(!rid)return;try{await flushSave();await acApi(`/api/chat/runs/${rid}/undo`,{});await acPoll();toast("已撤销本轮画布改动，生成文件仍保留");}catch(e){toast(e.message,5000);}};
 $("#acMessages").onclick=async e=>{
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
  const revisionButton=e.target.closest("[data-apply-shot-revision],[data-run-shot-revision]");
  if(revisionButton){
   const card=revisionButton.closest("[data-shot-revision]"), p=JSON.parse(card.dataset.shotRevision), script=node(p.node);
   if(p.board!==boardId || AC.board!==boardId || !canvasCanEdit())return toast("请回到对应的可编辑画布");
   if(script?.type!=="script")return toast("分镜已移除");
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
   if(script?.type!=="script")return toast("分镜已移除");
   if(reviewButton.hasAttribute("data-plan-review-revision")){
    const status=$('[role="status"]',card), call=card.closest("[data-call]").dataset.call;
    const model=$("#acModelChoice").value, thinking=$("#acThinkingLevel").value;
    reviewButton.dataset.requestKey ||= crypto.randomUUID?.() || ("revise-review-"+Date.now()+Math.random());
    reviewButton.disabled=true;status.textContent="正在提交…";
    try{
     await acSendShotRequest(p.board,{text:"根据这次审阅，为当前镜头拟一份修改方案。",review_revision_call:call,
      request_key:reviewButton.dataset.requestKey,enqueue:true,...(model?{chat_model:model}:{}),
      ...(thinking&&thinking!=="off"?{thinking_level:thinking}:{})},AC.session);
     status.textContent="已提交修改方案请求";
    }catch(error){reviewButton.disabled=false;status.textContent=error.message;}
   }else{
    const index=p.shot_id?script.data.shots.findIndex(shot=>shot.id===p.shot_id):p.shot-1;
    if(index<1)return toast("审阅关联的切点已变化，请重新审阅");
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
   if(pair)open.textContent="定位这一镜";
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
     open.textContent=pair?"定位这一镜":"展开这一镜";
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
 pane.addEventListener("keydown",e=>{
  if(e.key==="Escape"&&!e.isComposing&&!e.defaultPrevented&&pane.parentElement.id==="light"){
   e.preventDefault();$("#acClose").click();
  }
 },true);
 pane.addEventListener("pointerdown",e=>e.stopPropagation());pane.addEventListener("wheel",e=>e.stopPropagation(),{passive:true});pane.addEventListener("keydown",e=>e.stopPropagation());
 $(".ac-head",pane).addEventListener("pointerdown",e=>{if(pane.parentElement.id==="light"||e.button!==0||e.target.closest("button"))return;e.preventDefault();const r=pane.getBoundingClientRect(),start={x:e.clientX,y:e.clientY};pane.classList.add("floating");pane.style.height=r.height+"px";pane.style.width=r.width+"px";pane.style.left=r.left+"px";pane.style.top=r.top+"px";const move=ev=>{pane.style.left=Math.max(0,Math.min(innerWidth-r.width, r.left+ev.clientX-start.x))+"px";pane.style.top=Math.max(8,Math.min(innerHeight-150,r.top+ev.clientY-start.y))+"px";};const end=()=>{removeEventListener("pointermove",move);removeEventListener("pointerup",end);removeEventListener("pointercancel",end);acStoreWindow();};addEventListener("pointermove",move);addEventListener("pointerup",end);addEventListener("pointercancel",end);});
 try{const layout=JSON.parse(localStorage.getItem("h3.chat.window"));if(layout?.floating){pane.classList.add("floating");for(const k of ["left","top","width","height"])if(Number.isFinite(layout[k]))pane.style[k]=Math.max(k==="width"?300:k==="height"?300:8,Math.min(layout[k],k==="left"?innerWidth-300:k==="top"?innerHeight-150:k==="width"?innerWidth-16:innerHeight-24))+"px";}}catch{}
 if(typeof aeInit==="function")aeInit();
 const resize=new ResizeObserver(()=>{if(pane.classList.contains("floating")&&!pane.hidden)acStoreWindow();});resize.observe(pane);
 let nextPoll=0;
 setInterval(()=>{
  const now=performance.now();
  if(now<nextPoll)return;
  nextPoll=now+(AC.open&&acActive()?.state==="thinking"?400:1000);
  if(AC.open){
   if(AC.board!==boardId||!AC.session)acBoardChanged();
   else acPoll();
   acRenderRefs();
  }else if(AC.board===boardId&&(acActive()||AC.queue.length||AC.sessions.some(s=>s.run_state||s.queued_count)))acPoll(true);
  else if(AC.nodeDirectory?.board===boardId&&AC.nodeDirectory.rows.some(session=>session.run_state||session.queued_count))void acRefreshNodeDirectory();
 },200);
}
function acStoreWindow(){const p=$("#agentChat");if(p.parentElement.id==="light")return;const r=p.getBoundingClientRect();try{localStorage.setItem("h3.chat.window",JSON.stringify({floating:p.classList.contains("floating"),left:r.left,top:r.top,width:r.width,height:r.height}));}catch{}}
