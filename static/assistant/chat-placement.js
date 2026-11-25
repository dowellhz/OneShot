"use strict";

let acPickingPlacement = false;
const acCanvasBackground = target => [vp,world,svg].includes(target);
const AC_CONTINUATION_DRAG="application/x-oneshot-assistant-continuation";
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
function acPickPlacement(active, continuation=null) {
 acPickingPlacement = active;
 AC.continuation=active?continuation:null;
 vp.classList.toggle("ac-placement-picking",active);
 vp.classList.toggle("ac-continuation-picking",!!AC.continuation);
 $("#acPickPlacement").setAttribute("aria-pressed",String(active));
 $("#acContinuation").hidden=!AC.continuation;
 if(AC.continuation)$("#acContinuationDrag").textContent=AC.continuation.title;
}

function acContinuationTarget(target){
 if(acCanvasBackground(target))return {valid:true,node:null};
 const element=target.closest?.(".node");
 const targetNode=element&&els.get(element.dataset.id)===element?node(element.dataset.id):null;
 return {valid:!!targetNode,node:targetNode};
}

function acApplyContinuation(target,x,y){
 const turn=AC.continuation;
 if(!turn||turn.board!==boardId||turn.session!==AC.session||!AC.open||!canvasCanEdit()||
    AC.sending||AC.loadingSessions||acVoicePointing())return;
 const hit=acContinuationTarget(target);
 if(!hit.valid)return;
 if(hit.node){
  if(!acAttachNodeReference(hit.node))return;
 }else{
  const point=acPlacementPoint(toW(x,y));
  if(!point)return;
  AC.placement=point;
 }
 acPickPlacement(false);
 acRenderState();
 $("#acInput").focus();
}

function acInitPlacementControls(){
 $("#acPickPlacement").onclick=()=>{
  if (AC.sending || !AC.session || AC.board!==boardId || !canvasCanEdit() || acVoicePointing()) return;
  acPickPlacement(!acPickingPlacement);
  if(acPickingPlacement)toast(OneShotI18n.t("点击画布空白处指定放置位置，按 Esc 取消"));
 };
 document.addEventListener("keydown",event=>{
  acKeyboardShortcut(event);
  if(event.key==="Escape"&&acPickingPlacement){event.preventDefault();event.stopPropagation();acPickPlacement(false);}
 },true);
 vp.addEventListener("pointerdown",event=>{
  if(!acPickingPlacement || event.defaultPrevented || event.button!==0)return;
  event.preventDefault();event.stopPropagation();
  if(AC.continuation){acApplyContinuation(event.target,event.clientX,event.clientY);return;}
  if(!acCanvasBackground(event.target))return;
  acPickPlacement(false);
  if(AC.open&&AC.board===boardId&&canvasCanEdit()){
   const point=acPlacementPoint(toW(event.clientX,event.clientY));
   if(point){AC.placement=point;acRenderRefs();}
  }
 },true);
 vp.addEventListener("dragover",event=>{
  if(!AC.continuation||!event.dataTransfer?.types.includes(AC_CONTINUATION_DRAG)||!acContinuationTarget(event.target).valid)return;
  event.preventDefault();event.stopPropagation();
  event.dataTransfer.dropEffect="copy";
 },true);
 vp.addEventListener("drop",event=>{
  if(!AC.continuation||event.dataTransfer?.getData(AC_CONTINUATION_DRAG)!==AC.continuation.session)return;
  event.preventDefault();event.stopPropagation();
  acApplyContinuation(event.target,event.clientX,event.clientY);
 },true);
}
