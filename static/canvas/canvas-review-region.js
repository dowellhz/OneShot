"use strict";

function lightImageArea(image) {
  const rect=image.getBoundingClientRect(), aspect=image.naturalWidth/image.naturalHeight;
  if (!Number.isFinite(aspect) || aspect<=0 || !rect.width || !rect.height) return null;
  const width=Math.min(rect.width,rect.height*aspect), height=width/aspect;
  return {x:rect.left+(rect.width-width)/2,y:rect.top+(rect.height-height)/2,width,height};
}

function lightRegionAnnotation(overlay, savedBox, confirm) {
  const image=$(".light-stage img",overlay);
  const mark=$("[data-light-mark-region]",overlay);
  if (!image || !mark) return null;
  const done=$("[data-light-save-region]",overlay), cancel=$("[data-light-cancel-region]",overlay);
  const status=$(".light-status",overlay);
  const rect=document.createElement("span");
  rect.className="light-review-region";
  rect.setAttribute("aria-hidden","true");
  overlay.append(rect);
  const listeners=new AbortController(), opts={signal:listeners.signal};
  let box=savedBox, drawing=false, start=null, pointer=null;

  function position() {
    const area=lightImageArea(image);
    rect.hidden=!box || !area;
    if (rect.hidden) return;
    const [left,top,right,bottom]=box;
    Object.assign(rect.style,{left:(area.x+left*area.width)+"px",top:(area.y+top*area.height)+"px",
      width:((right-left)*area.width)+"px",height:((bottom-top)*area.height)+"px"});
  }
  function sync() {
    mark.hidden=drawing;
    cancel.hidden=!drawing;
    done.hidden=!drawing;
    done.disabled=!box || !!start;
    image.classList.toggle("light-region-drawing",drawing);
    position();
  }
  function reset(enter) {
    drawing=enter; start=null; pointer=null; box=enter?null:savedBox;
    status.textContent=enter?"在图片上拖出要批注的区域":"";
    sync();
  }
  function point(event, area) {
    const cap=value=>Math.max(0,Math.min(1,value));
    return [cap((event.clientX-area.x)/area.width),cap((event.clientY-area.y)/area.height)];
  }
  function update(event) {
    const area=lightImageArea(image);
    if (!start || event.pointerId!==pointer || !area) return;
    const [x,y]=point(event,area), [a,b]=start;
    box=Math.abs(x-a)*area.width>=3 && Math.abs(y-b)*area.height>=3 ? [Math.min(x,a),Math.min(y,b),Math.max(x,a),Math.max(y,b)] : null;
    position();
  }

  image.addEventListener("pointerdown",event=>{
    const area=lightImageArea(image);
    if(!drawing || event.button!==0 || !area || start ||
       event.clientX<area.x || event.clientX>area.x+area.width || event.clientY<area.y || event.clientY>area.y+area.height)return;
    event.preventDefault();
    pointer=event.pointerId;
    start=point(event,area);
    if(Number.isInteger(pointer))image.setPointerCapture?.(pointer);
    box=null; sync();
  },opts);
  image.addEventListener("pointermove",update,opts);
  image.addEventListener("pointerup",event=>{
    if(!start || event.pointerId!==pointer)return;
    update(event);
    start=null; pointer=null;
    status.textContent=box?"区域已选定，可重新拖动或填写批注":"请拖出有效的批注区域";
    sync();
  },opts);
  image.addEventListener("pointercancel",event=>{
    if(event.pointerId!==pointer)return;
    start=null; pointer=null; box=null; sync();
  },opts);
  image.addEventListener("dragstart",event=>{if(drawing)event.preventDefault();},opts);
  image.addEventListener("load",position,opts);
  overlay.addEventListener("keydown",event=>{
    if(drawing && event.key==="Escape"){event.preventDefault();event.stopPropagation();reset(false);mark.focus();}
  },opts);
  const observer=new ResizeObserver(position);
  observer.observe(image);observer.observe(overlay);observer.observe($(".light-stage",overlay));
  mark.onclick=()=>{reset(true);cancel.focus();};
  cancel.onclick=()=>{reset(false);mark.focus();};
  done.onclick=()=>{if(box&&!start)confirm(box);};
  sync();
  return ()=>{observer.disconnect();listeners.abort();};
}
