"use strict";

const imageCameraFields = ["Yaw","Pitch","Distance","Framing","Lens"];
const imageCameraDraftIds = [...imageCameraFields.map(id=>"ieCam"+id),"ieCamCount"];
const imageCameraPresets = [
  ["左侧面",-90,0,0,50,"中景"], ["右侧面",90,0,0,50,"中景"], ["背面",180,0,0,50,"全景"],
  ["高机位",0,45,0,35,"全景"], ["低机位",0,-30,0,35,"全景"], ["近距特写",0,0,-55,85,"面部特写"],
];

function imageCameraSettings(prefix="ieCam") {
  const [yaw,pitch,distance,framing,lens] = imageCameraFields.map(field=>$("#"+prefix+field).value);
  return {yaw:+yaw,pitch:+pitch,distance:+distance,framing,lens:+lens};
}

function imageCameraPrompt({yaw,pitch,distance,framing,lens}) {
  const pieces=[yaw ? `从原机位向${yaw>0?"右":"左"}环绕 ${Math.abs(yaw)}°` : "保持水平机位",
    pitch ? `${pitch>0?"升高机位俯拍":"降低机位仰拍"} ${Math.abs(pitch)}°` : "保持机位高度",
    distance ? `相机${distance<0?"靠近":"远离"}主体，移动幅度 ${Math.abs(distance)}/100` : "保持拍摄距离",
    `使用 ${lens} mm 镜头`,framing ? `景别采用${framing}` : "保持原图景别"];
  return pieces.join("，");
}

function imageCameraFieldsHTML(prefix) {
  const sliders=[["Yaw","水平环绕",-180,180,1,45],["Pitch","俯仰",-60,60,1,0],["Distance","拍摄距离",-100,100,1,0]];
  return sliders.map(([id,label,min,max,step,value])=>`<label class="ie-label" for="${prefix+id}">${label}<output id="${prefix+id}V"></output></label>
    <input type="range" id="${prefix+id}" min="${min}" max="${max}" step="${step}" value="${value}">`).join("") +
    `<div class="ie-padding"><label>景别<select id="${prefix}Framing"><option value="">保持不变</option>${["面部特写","近景","中景","全景","远景"].map(label=>`<option>${label}</option>`).join("")}</select></label>
      <label>焦段<select id="${prefix}Lens">${[[24,"广角"],[35,"小广角"],[50,"标准"],[85,"人像"],[135,"长焦"]].map(([mm,label])=>`<option value="${mm}"${mm===50?" selected":""}>${mm} mm · ${label}</option>`).join("")}</select></label></div>`;
}

function imageCameraHTML() {
  return `<div class="ie-section" data-section="camera">
    <div class="ie-camera-orbit" role="img" aria-label="水平机位示意图"><span class="ie-camera-subject">主体</span><i></i></div>
    <div class="ie-row ie-camera-presets">${imageCameraPresets.map(([name],i)=>`<button type="button" data-camera-preset="${i}">${name}</button>`).join("")}</div>
    ${imageCameraFieldsHTML("ieCam")}
    <label class="ie-label" for="ieCamCount">候选图数量</label><select id="ieCamCount">${[1,2,3,4].map(n=>`<option>${n}</option>`).join("")}</select>
    <p class="ie-note">机位图用于设定构图。新视角由图像模型推演。</p></div>`;
}

function imageCameraRefresh(prefix="ieCam") {
  const settings=imageCameraSettings(prefix), {yaw,pitch,distance}=settings;
  $("#"+prefix+"YawV").textContent=(yaw>0?"右 ":yaw<0?"左 ":"")+Math.abs(yaw)+"°";
  $("#"+prefix+"PitchV").textContent=(pitch>0?"俯 ":pitch<0?"仰 ":"")+Math.abs(pitch)+"°";
  $("#"+prefix+"DistanceV").textContent=distance ? (distance<0?"靠近 ":"远离 ")+Math.abs(distance) : "保持";
  if(prefix!=="ieCam")return;
  const orbit=$(".ie-camera-orbit"), mark=$("i",orbit), radians=yaw*Math.PI/180, radius=33+distance*.09;
  mark.style.left=50+Math.sin(radians)*radius+"%";
  mark.style.top=50+Math.cos(radians)*radius+"%";
  mark.style.transform=`translate(-50%,-50%) rotate(${-yaw}deg)`;
  orbit.setAttribute("aria-label","机位示意 · "+imageCameraPrompt(settings));
}

function imageCameraSet(settings={}, count=1) {
  const {yaw=45,pitch=0,distance=0,framing="",lens=50}=settings;
  [yaw,pitch,distance,framing,lens].forEach((value,i)=>$("#ieCam"+imageCameraFields[i]).value=value);
  $("#ieCamCount").value=count;
  imageCameraRefresh();
}

function initImageCamera() {
  for(const field of imageCameraFields) $("#ieCam"+field).oninput=()=>imageCameraRefresh();
  $$("[data-camera-preset]").forEach(button=>button.onclick=()=>{
    if(!IMAGE_EDITOR || IMAGE_EDITOR.busy || IMAGE_EDITOR.n.job || !canvasCanEdit())return;
    const [,yaw,pitch,distance,lens,framing]=imageCameraPresets[+button.dataset.cameraPreset];
    imageCameraSet({yaw,pitch,distance,lens,framing},+$("#ieCamCount").value);ewScheduleDraft();
  });
  const orbit=$(".ie-camera-orbit");let dragging=false;
  const place=event=>{
    if(!dragging || IMAGE_EDITOR?.mode!=="camera")return;
    const {left,top,width,height}=orbit.getBoundingClientRect();
    const x=event.clientX-left-width/2,y=event.clientY-top-height/2;
    if(Math.hypot(x,y)<10)return;
    $("#ieCamYaw").value=Math.round(Math.atan2(x,y)*180/Math.PI);
    imageCameraRefresh();ewScheduleDraft();
  };
  orbit.onpointerdown=event=>{
    if(event.button!==0 || !canvasCanEdit() || IMAGE_EDITOR?.busy || IMAGE_EDITOR?.n.job)return;
    dragging=true;orbit.setPointerCapture(event.pointerId);place(event);
  };
  orbit.onpointermove=place;
  orbit.onpointerup=orbit.onpointercancel=orbit.onlostpointercapture=()=>{dragging=false;};
}
