"use strict";

const relightControls = [
  ["LightX","光源左右",-100,100,-55], ["LightY","光源上下",-100,100,-55],
  ["LightKey","主光强度",0,100,55], ["LightExposure","整体曝光",-100,100,0],
  ["LightTemperature","色温",-100,100,0], ["LightRim","轮廓光",0,100,15],
  ["LightDepth","主光前后",-100,100,0],
];
const relightInputIds = relightControls.map(([id])=>"ie"+id);
const relightClamp = (value,min,max) => Math.min(max,Math.max(min,value));
const relightKelvin = temperature => 5600-temperature*(temperature>=0?31:39);
const relightDepthLabel = depth => depth ? (depth>0?"前方 ":"后方 ")+Math.abs(depth)+"%" : "侧向";

function relightHTML() {
  return OneShotI18n.html`<div class="ie-section" data-section="relight"><p class="ie-note">拖动图上的光源，调整方向和强度，再预览照片的明暗变化。</p>
    ${relightControls.map(([id,label,min,max,value])=>`<label class="ie-label" for="ie${id}">${label}<output id="ie${id}Value">${value}</output></label>
      <input id="ie${id}" type="range" min="${min}" max="${max}" value="${value}">`).join("")}
    <div class="ie-row"><button type="button" id="ieResetLight">重置</button><button type="button" id="ieRelightAI">交给模型重打光</button></div>
    <div class="ie-row"><button type="button" id="ieSaveLight" class="ie-primary">保存布光为新版本</button>
    <button type="button" id="ieExportLight">导出到画布</button></div>
    <button type="button" id="ieLocateLight" hidden>在画布定位导出图</button></div>`;
}

function relightSettings() {
  const [x,y,key,exposure,temperature,rim,depth] = relightInputIds.map(id=>+$("#"+id).value);
  return {x,y,key,exposure,temperature,rim,depth};
}

function relightSet(values={}) {
  ["x","y","key","exposure","temperature","rim","depth"].forEach((key,i)=>{
    $("#"+relightInputIds[i]).value = values[key] ?? relightControls[i][4];
  });
  relightRefresh();
}

function relightRefresh() {
  for(const id of relightInputIds) $("#"+id+"Value").textContent = $("#"+id).value;
  const temperature=$("#ieLightTemperature"),depth=$("#ieLightDepth");
  $("#ieLightTemperatureValue").textContent=relightKelvin(+temperature.value)+" K";
  $("#ieLightDepthValue").textContent=relightDepthLabel(+depth.value);
  temperature.setAttribute("aria-valuetext",$("#ieLightTemperatureValue").textContent);
  depth.setAttribute("aria-valuetext",$("#ieLightDepthValue").textContent);
}

function relightMap({width,height,data}, light) {
  const levels = new Float32Array(width*height), field = new Float32Array(levels.length);
  for(let i=0;i<levels.length;i++) {
    const j=i*4;
    levels[i]=(data[j]*.2126+data[j+1]*.7152+data[j+2]*.0722)*data[j+3]/65025;
  }
  const lx=light.x/100, ly=light.y/100, power=light.key/100, rim=light.rim/100, exposure=2**(light.exposure/100);
  const depth=(light.depth ?? 0)/100;
  const front=Math.max(0,depth), back=Math.max(0,-depth);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const i=y*width+x, horizontal=Math.max(0,x-2), vertical=Math.max(0,y-2);
    const dx=levels[y*width+Math.min(width-1,x+2)]-levels[y*width+horizontal];
    const dy=levels[Math.min(height-1,y+2)*width+x]-levels[vertical*width+x];
    const px=2*x/Math.max(1,width-1)-1, py=2*y/Math.max(1,height-1)-1;
    const distance=(px-lx)**2+(py-ly)**2;
    const falloff=2/(1+.75*distance)-.85;
    const detail=relightClamp(dx*lx+dy*ly,-.35,.35);
    const boundary=relightClamp(Math.abs(dx)+Math.abs(dy),0,.65);
    const direct=(.55*falloff+.7*detail)*(1-.65*back-.4*front)+.33*front;
    field[i]=exposure*(1+power*(direct+back*(1.1*boundary-.18))+rim*.62*boundary);
  }
  return {width,height,field};
}

function relightApply({width,height,data}, map, temperature) {
  const warm=temperature/100, red=1+.24*warm, green=1+.025*warm, blue=1-.24*warm;
  const columns=Float32Array.from({length:width},(_,x)=>x*(map.width-1)/Math.max(1,width-1));
  for(let y=0;y<height;y++) {
    const position=y*(map.height-1)/Math.max(1,height-1), top=Math.floor(position), fy=position-top;
    const lower=Math.min(top+1,map.height-1)*map.width, upper=top*map.width;
    for(let x=0;x<width;x++) {
      const i=(y*width+x)*4;
      if (!data[i+3]) continue;
      const left=Math.floor(columns[x]), right=Math.min(left+1,map.width-1), fx=columns[x]-left;
      const a=map.field[upper+left]*(1-fx)+map.field[upper+right]*fx;
      const b=map.field[lower+left]*(1-fx)+map.field[lower+right]*fx;
      const value=a*(1-fy)+b*fy;
      data[i]*=value*red;data[i+1]*=value*green;data[i+2]*=value*blue;
    }
  }
}

function relightSource(E, limit) {
  const {naturalWidth:w,naturalHeight:h}=E.image, scale=Math.min(1,limit/Math.max(w,h));
  const canvas=document.createElement("canvas");
  canvas.width=Math.max(1,Math.round(w*scale));canvas.height=Math.max(1,Math.round(h*scale));
  const ctx=canvas.getContext("2d",{willReadFrequently:true});
  ctx.save();ctx.scale(canvas.width/w,canvas.height/h);ewDrawLayers(E,ctx);ctx.restore();
  return {canvas,ctx};
}

function relightRender(E, light, limit) {
  const base=relightSource(E,192), map=relightMap(base.ctx.getImageData(0,0,base.canvas.width,base.canvas.height),light);
  const out=relightSource(E,limit), pixels=out.ctx.getImageData(0,0,out.canvas.width,out.canvas.height);
  relightApply(pixels,map,light.temperature);
  out.ctx.putImageData(pixels,0,0);
  return out.canvas;
}

function relightPreview(E) {
  const light=relightSettings(), key=JSON.stringify([E.ref,E.layers,light]);
  if (E.lightPreview?.key !== key) E.lightPreview={key,canvas:relightRender(E,light,512)};
  return E.lightPreview.canvas;
}

function relightPointer(E, event, phase, p) {
  if (phase === "down") { E.movingLight=true;event.currentTarget.setPointerCapture(event.pointerId); }
  if (!E.movingLight) return;
  event.preventDefault();
  $("#ieLightX").value=Math.round(relightClamp(2*p.x/E.image.naturalWidth-1,-1,1)*100);
  $("#ieLightY").value=Math.round(relightClamp(2*p.y/E.image.naturalHeight-1,-1,1)*100);
  relightRefresh();ieDraw();
  if (phase === "up") { E.movingLight=false;ewScheduleDraft(); }
}

async function saveRelight(asNode = false) {
  const E=IMAGE_EDITOR;
  if (!E?.image || E.mode!=="relight" || E.busy || E.loading || E.restoring ||
      !vtCanCopyVersion(E.n,E.n.cur) || E.agentSelection) return;
  const board=B, ref=E.ref, light=relightSettings();
  E.busy=true;ieSync();ieStatus("正在按原图尺寸保存…");
  try {
    await ewPreload(E,E.layers.map(layer=>layer.ref));
    const output=relightRender(E,light,Infinity);
    const blob=await new Promise(resolve=>output.toBlob(resolve,"image/png"));
    if (!blob) throw new Error("浏览器无法导出这张图，请尝试较小的图片");
    const asset=await ewUpload(blob,"relight.png");
    if(IMAGE_EDITOR!==E || B!==board || !vtCanCopyVersion(E.n,E.n.cur) || curV(E.n)?.ref!==ref) {
      throw new Error("画布或来源版本已更新，请重新选择图片");
    }
    const version=mediaVersion({...asset,w:output.width,h:output.height},{source:"edit",mode:"手动布光",edit:{source:ref,mode:"relight",light}});
    if (asNode) {
      const dimensions=size({...E.n,versions:[version],cur:0});
      const spot=freeSpot(E.n.x+size(E.n).w+CT_LAYOUT_GAP.x,E.n.y,"image",dimensions);
      checkpoint();
      const image=addNode("image",spot.x,spot.y,{}, {name:E.n.name+" · 布光",versions:[version],cur:0});
      E.lightExportId=image.id;
      ieStatus("布光图片已导出到画布");
    } else {
      addVersion(E.n,version);
      ieMode("local",true);ieLoad(curV(E.n));ieHistory();
      ieStatus("已保存布光版本，可在版本栏切回原图");
    }
    loadAssets();
  }catch(error){ if(IMAGE_EDITOR===E)ieStatus(error.message,true); }
  finally{ E.busy=false;ieSync(); }
}

function initRelightControls() {
  for(const id of relightInputIds) $("#"+id).oninput=()=>{relightRefresh();ieDraw();};
  $("#ieResetLight").onclick=()=>{relightSet();ieDraw();ewScheduleDraft();};
  $("#ieSaveLight").onclick=()=>saveRelight();
  $("#ieExportLight").onclick=()=>saveRelight(true);
  $("#ieLocateLight").onclick=()=>{
    const E=IMAGE_EDITOR, image=E?.lightExportId && node(E.lightExportId);
    if (!image || E.busy) return;
    closeImageEditor(false);
    selectOnly(image.id);fit([image]);
  };
  $("#ieRelightAI").onclick=()=>{
    const E=IMAGE_EDITOR;if(!E || E.busy || E.n.job || !canvasCanEdit())return;
    if(E.mode==="relight_ai"){ieMode("relight");ewScheduleDraft();return;}
    ieMode("relight_ai");$("#iePrompt").focus();ewScheduleDraft();
  };
}
