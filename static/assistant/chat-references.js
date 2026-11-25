"use strict";

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

function acNodeReferenceMarkup(n,selection,reviews){
 const pin=AC.referencePins.get(n.id);
 const fixedRef=selection?.node_id===n.id?selection.source_ref:acReviewVersion(n,reviews);
 const ref=pin?.ref||fixedRef;
 const index=ref?n.versions.findIndex(v=>v.ref===ref):n.cur;
 const version=n.versions[index];
 const preview=n.type==="image"&&version?.ref
  ? `<img src="${esc(ewRefUrl(version.ref))}" alt="" loading="lazy" draggable="false">`
  : ico(n.type);
 const label=AC.emptyMediaNode===n.id?"接收生成结果":index>=0?"版本 "+(index+1)+(pin||fixedRef?" · 已指定":""):ref?"版本已移除":TYPE_CN[n.type];
 const options=n.versions.map((entry,i)=>entry.ref
  ? OneShotI18n.html`<option value="${i}" ${pin&&version===entry?"selected":""}>版本 ${i+1}${pin&&version===entry?" · 已指定":""}</option>`:"").join("");
 const choices=!fixedRef&&options&&(n.versions.length>1||pin&&!version)
  ? `<select data-reference-version="${esc(n.id)}" aria-label="${esc(n.name)}的引用版本" ${AC.sending?"disabled":""}>
    <option value="" ${!pin?"selected":""}>${n.cur>=0?`跟随画布 · 版本 ${n.cur+1}`:"跟随画布"}</option>
    ${pin&&!version?OneShotI18n.markup('<option value="missing" disabled selected>版本已移除</option>'):""}${options}</select>`
  : `<span class="ac-reference-version">${esc(label)}</span>`;
 return OneShotI18n.html`<span class="ac-ref ac-node-ref" title="${esc(n.name)} · ${esc(label)}">${preview}<span class="ac-reference-name">${esc(n.name)}</span>${choices}<button type="button" data-remove="${esc(n.id)}" aria-label="移除引用">×</button></span>`;
}
function acRenderRefs(){
 const box=$("#acRefs");if(!box||!B)return;
 acRenderPlacement();
 const selection=AC.board===boardId?AC.selection:null;
 const reviews=AC.board===boardId?AC.reviews:[];
 const refs=acRefs();
 const refsMarkup=refs.map(n=>acNodeReferenceMarkup(n,selection,reviews)).join("");
 const missing=[...AC.referencePins].filter(([id])=>AC.refs?.includes(id)&&!node(id)).map(([id,pin])=>
  OneShotI18n.html`<span class="ac-ref">${esc(pin.name)} · 节点已移除<button type="button" data-remove="${esc(id)}" aria-label="移除已失效引用">×</button></span>`).join("");
 const selectionMarkup=selection?OneShotI18n.html`<span class="ac-ref ac-ref-selection"><a href="${esc(ewRefUrl(selection.preview_ref))}" target="_blank" rel="noopener" aria-label="查看选区预览"><img src="${esc(ewRefUrl(selection.preview_ref))}" alt=""></a>${refs.some(n=>n.id===selection.node_id&&n.versions.some(v=>v.ref===selection.source_ref))?"已圈选区域":"选区源图已失效"}<button type="button" data-remove-selection aria-label="移除圈选区域">×</button></span>`:"";
 const reviewMarkup=reviews.map(review=>OneShotI18n.html`<span class="ac-ref ac-review-ref"><button type="button" data-open-review="${esc(review.id)}" title="${esc(review.body)}">${review.anchor?.node&&!acReviewTarget(review)?"审阅素材已失效":"审阅评论 · "+esc(review.body.slice(0,24))}</button><button type="button" data-remove-review="${esc(review.id)}" aria-label="移除审阅评论">×</button></span>`).join("");
 const placementMarkup=AC.board===boardId&&AC.placement?OneShotI18n.markup('<span class="ac-ref"><button type="button" data-locate-placement title="定位到标记">已指定放置位置</button><button type="button" data-remove-placement aria-label="清除放置位置">×</button></span>'):"";
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
  if(AC.emptyMediaNode===b.dataset.remove)AC.emptyMediaNode=null;
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
async function acNewNodeSession(references,{draft="",emptyMediaNode=null}={}){
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
  AC.emptyMediaNode=AC.refs.includes(emptyMediaNode)?emptyMediaNode:null;
  for(const {id,ref} of remaining)if(ref)AC.referencePins.set(id,{ref,name:node(id).name});
  if(remaining.length&&draft)$("#acInput").value=draft;
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
  B.nodes.slice(0,200).map(n=>`<button type="button" data-node="${esc(n.id)}">${esc(n.name)} · ${TYPE_CN[n.type]}</button>`).join("")||OneShotI18n.t("画布还没有节点");
 $$("[data-memory]",box).forEach(b=>b.onclick=()=>{const a=memories.find(a=>a.id===b.dataset.memory);if(a)cmInsert($("#acInput"),a);box.hidden=true;});
 $$("[data-asset-folder]",box).forEach(b=>b.onclick=()=>{
  box.hidden=true;
  const folder=folders.find(folder=>folder.id===b.dataset.assetFolder);
  if(folder)cmInsert($("#acInput"),{...folder,assetFolder:true});
 });
 $$("[data-node]",box).forEach(b=>b.onclick=()=>{if(acAttachNodeReference(node(b.dataset.node))){box.hidden=true;$("#acInput").focus();}});
}
