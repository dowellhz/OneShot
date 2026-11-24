"use strict";

const imageCameraFields = ["Yaw","Pitch","Distance","Framing","Lens"];
const imageCameraOpticalFields = {
  sensor:{label:"传感器",options:[["s35","Super 35"],["full-frame","全画幅"],["medium-format","中画幅"]]},
  optics:{label:"镜头质感",options:[["spherical","球面定焦"],["anamorphic","变形镜头"],["vintage","复古柔焦"],["macro","微距"]]},
  aperture:{label:"光圈",options:["1.4","2","2.8","4","5.6","8","11","16"].map(f=>[f,"f/"+f])},
};
const imageCameraOpticalId = field => "ieCam"+field[0].toUpperCase()+field.slice(1);
const imageCameraOpticalKeys = Object.keys(imageCameraOpticalFields);
const cameraLensOptions=[[18,"超广角"],[24,"广角"],[28,"广角"],[35,"小广角"],[40,"标准"],[50,"标准"],[85,"人像"],[100,"中长焦"],[135,"长焦"],[200,"长焦"]];
const imageCameraDraftIds = [...imageCameraFields.map(id=>"ieCam"+id),...imageCameraOpticalKeys.map(imageCameraOpticalId),"ieCamCount"];
const imageCameraPresets = [
  ["左侧面",-90,0,0,50,"中景"], ["右侧面",90,0,0,50,"中景"], ["背面",180,0,0,50,"全景"],
  ["高机位",0,45,0,35,"全景"], ["低机位",0,-30,0,35,"全景"], ["近距特写",0,0,-55,85,"面部特写"],
];

function imageCameraSettings(prefix="ieCam") {
  const [yaw,pitch,distance,framing,lens] = imageCameraFields.map(field=>$("#"+prefix+field).value);
  const settings={yaw:+yaw,pitch:+pitch,distance:+distance,framing,lens:+lens};
  if(prefix==="ieCam")for(const field of imageCameraOpticalKeys){
    const value=$("#"+imageCameraOpticalId(field)).value;
    if(value)settings[field]=value;
  }
  return settings;
}

function imageCameraPrompt({yaw,pitch,distance,framing,lens,...optical}) {
  const pieces=[yaw ? `从原机位向${yaw>0?"右":"左"}环绕 ${Math.abs(yaw)}°` : "保持水平机位",
    pitch ? `${pitch>0?"升高机位俯拍":"降低机位仰拍"} ${Math.abs(pitch)}°` : "保持机位高度",
    distance ? `相机${distance<0?"靠近":"远离"}主体，移动幅度 ${Math.abs(distance)}/100` : "保持拍摄距离",
    `使用 ${lens} mm 镜头`,framing ? `景别采用${framing}` : "保持原图景别"];
  for(const field of imageCameraOpticalKeys){
    const option=imageCameraOpticalFields[field].options.find(([id])=>id===optical[field]);
    if(option)pieces.push(option[1]);
  }
  return pieces.join("，");
}

function imageCameraFieldsHTML(prefix) {
  const sliders=[["Yaw","水平环绕",-180,180,1,45],["Pitch","俯仰",-60,60,1,0],["Distance","拍摄距离",-100,100,1,0]];
  return sliders.map(([id,label,min,max,step,value])=>`<label class="ie-label" for="${prefix+id}">${label}<output id="${prefix+id}V"></output></label>
    <input type="range" id="${prefix+id}" min="${min}" max="${max}" step="${step}" value="${value}">`).join("") +
    OneShotI18n.html`<div class="ie-padding"><label>景别<select id="${prefix}Framing"><option value="">保持不变</option>${["面部特写","近景","中景","全景","远景"].map(label=>`<option>${label}</option>`).join("")}</select></label>
      <label>焦段<select id="${prefix}Lens">${cameraLensOptions.map(([mm,label])=>`<option value="${mm}"${mm===50?" selected":""}>${mm} mm · ${label}</option>`).join("")}</select></label></div>`;
}

const videoOpticPresets=[
  ["环境广角",{lens:24,sensor:"s35",optics:"spherical",aperture:"8"}],
  ["人物浅景深",{lens:85,sensor:"full-frame",optics:"spherical",aperture:"2"}],
  ["宽银幕质感",{lens:40,sensor:"s35",optics:"anamorphic",aperture:"2.8"}],
  ["微距细节",{lens:100,optics:"macro",aperture:"5.6"}],
];

function closeVideoOptics() {
  const dialog=$("#videoOptics");
  if(dialog?.open){if(dialog.close)dialog.close();else dialog.removeAttribute("open");}
}

function openVideoOptics(n) {
  if(n.type!=="video"||!canvasCanEdit()||nodeLocked(n)||n.job||prepping.has(n.id)||node(n.id)!==n)return;
  const options={lens:{label:"焦段",options:cameraLensOptions.map(([mm,label])=>[mm,`${mm} mm · ${label}`])},...imageCameraOpticalFields};
  if(!$("#videoOptics")){
    document.body.insertAdjacentHTML("beforeend",OneShotI18n.html`<dialog id="videoOptics" aria-labelledby="videoOpticsTitle"><form>
      <header><h2 id="videoOpticsTitle">视频镜头参数</h2><button type="button" data-close>关闭</button></header>
      <div class="ie-row">${videoOpticPresets.map(([name],i)=>`<button type="button" data-video-optics-preset="${i}">${name}</button>`).join("")}</div>
      <div class="ie-padding">${Object.entries(options).map(([key,{label,options:pairs}])=>`<label>${label}<select name="${key}">
        <option value="">由模型决定</option>${pairs.map(([value,text])=>`<option value="${value}">${text}</option>`).join("")}
        </select></label>`).join("")}</div>
      <p>参数会加入生成指令，由视频模型推演镜头效果。</p><p role="status"></p>
      <footer><button type="button" data-reset>清除设置</button><button type="submit">应用</button></footer>
      </form></dialog>`);
  }
  const dialog=$("#videoOptics"), form=$("form",dialog), board=boardId, version=curV(n);
  const baseline=JSON.stringify(n.data.video_optics||{}), fields=$$("select",form), status=$("[role=status]",form);
  const paint=settings=>{for(const field of fields)field.value=String(settings[field.name]||"");};
  paint(n.data.video_optics||{});
  status.textContent="";
  $("[data-close]",form).onclick=closeVideoOptics;
  $("[data-reset]",form).onclick=()=>paint({});
  $$("[data-video-optics-preset]",form).forEach(button=>{
    button.onclick=()=>paint(videoOpticPresets[Number(button.dataset.videoOpticsPreset)][1]);
  });
  form.onsubmit=event=>{
    event.preventDefault();
    if(board!==boardId||node(n.id)!==n||!canvasCanEdit()||nodeLocked(n)||n.job||prepping.has(n.id)||
      curV(n)!==version||JSON.stringify(n.data.video_optics||{})!==baseline){
      status.textContent="节点、版本或镜头参数已变化，请重新打开";return;
    }
    const settings=Object.fromEntries(fields.filter(field=>field.value).map(field=>[field.name,field.name==="lens"?+field.value:field.value]));
    if(JSON.stringify(settings)!==baseline){
      checkpoint();rememberVideoVersion(n);
      if(Object.keys(settings).length)n.data.video_optics=settings;
      else delete n.data.video_optics;
      refresh(n);save();
    }
    closeVideoOptics();
  };
  dialog.onkeydown=event=>event.stopPropagation();
  if(!dialog.open){if(dialog.showModal)dialog.showModal();else dialog.setAttribute("open","");}
}

function imageCameraHTML() {
  return `<div class="ie-section" data-section="camera">
    <div class="ie-camera-orbit" role="img" aria-label="机位示意图">
      <span class="ie-camera-subject">主体</span><span class="ie-camera-height" aria-hidden="true"></span><i></i>
    </div>
    <p class="ie-note ie-camera-gesture">横拖环绕，竖拖俯仰</p>
    <div class="ie-row ie-camera-presets">${imageCameraPresets.map(([name],i)=>`<button type="button" data-camera-preset="${i}">${name}</button>`).join("")}</div>
    ${imageCameraFieldsHTML("ieCam")}
    <div class="ie-padding">${Object.entries(imageCameraOpticalFields).map(([field,{label,options}])=>`<label>${label}
      <select id="${imageCameraOpticalId(field)}"><option value="">由模型决定</option>${options.map(([value,name])=>`<option value="${value}">${name}</option>`).join("")}</select></label>`).join("")}</div>
    <label class="ie-label" for="ieCamCount">候选图数量</label><select id="ieCamCount">${[1,2,3,4].map(n=>`<option>${n}</option>`).join("")}</select>
    <p class="ie-note">机位图用于设定构图。新视角由图像模型推演。</p></div>`;
}

function imageCameraRefresh(prefix="ieCam") {
  const settings=imageCameraSettings(prefix), {yaw,pitch,distance}=settings;
  $("#"+prefix+"YawV").textContent=(yaw>0?"右 ":yaw<0?"左 ":"")+Math.abs(yaw)+"°";
  $("#"+prefix+"PitchV").textContent=(pitch>0?"俯 ":pitch<0?"仰 ":"")+Math.abs(pitch)+"°";
  $("#"+prefix+"DistanceV").textContent=distance ? (distance<0?"靠近 ":"远离 ")+Math.abs(distance) : "保持";
  if(prefix!=="ieCam")return;
  const orbit=$(".ie-camera-orbit"), mark=$("i",orbit), guide=$(".ie-camera-height",orbit);
  const heading=yaw*Math.PI/180, elevation=pitch*Math.PI/180, radius=33+distance*.09;
  const x=50+Math.sin(heading)*radius, floor=50+Math.cos(heading)*radius*.55;
  const height=Math.sin(elevation)*radius*.85, y=floor-height;
  mark.style.left=x+"%";
  mark.style.top=y+"%";
  mark.style.transform=`translate(-50%,-50%) rotate(${-Math.atan2(x-50,y-50)*180/Math.PI}deg)`;
  Object.assign(guide.style,{left:x+"%",top:Math.min(y,floor)+"%",height:Math.abs(height)+"%"});
  guide.hidden=!pitch;
  orbit.setAttribute("aria-label","机位示意 · "+imageCameraPrompt(settings));
}

function imageCameraSet(settings={}, count=1) {
  const {yaw=45,pitch=0,distance=0,framing="",lens=50}=settings;
  [yaw,pitch,distance,framing,lens].forEach((value,i)=>$("#ieCam"+imageCameraFields[i]).value=value);
  for(const field of imageCameraOpticalKeys)$("#"+imageCameraOpticalId(field)).value=settings[field]||"";
  $("#ieCamCount").value=count;
  imageCameraRefresh();
}

function initImageCamera() {
  for(const id of imageCameraDraftIds)$("#"+id).oninput=()=>imageCameraRefresh();
  $$("[data-camera-preset]").forEach(button=>button.onclick=()=>{
    if(!IMAGE_EDITOR || IMAGE_EDITOR.busy || IMAGE_EDITOR.n.job || !canvasCanEdit())return;
    const [,yaw,pitch,distance,lens,framing]=imageCameraPresets[+button.dataset.cameraPreset];
    imageCameraSet({...imageCameraSettings(),yaw,pitch,distance,lens,framing},+$("#ieCamCount").value);ewScheduleDraft();
  });
  const orbit=$(".ie-camera-orbit"), yaw=$("#ieCamYaw"), pitch=$("#ieCamPitch");
  let drag=null;
  const change=(heading,elevation)=>{
    yaw.value=heading;
    pitch.value=elevation;
    imageCameraRefresh();
  };
  orbit.onpointerdown=event=>{
    if(event.button!==0 || drag || IMAGE_EDITOR?.mode!=="camera" || !canvasCanEdit() || IMAGE_EDITOR.busy || IMAGE_EDITOR.n.job)return;
    drag={id:event.pointerId,editor:IMAGE_EDITOR,x:event.clientX,y:event.clientY,yaw:+yaw.value,pitch:+pitch.value,moved:false};
    orbit.setPointerCapture(event.pointerId);
  };
  orbit.onpointermove=event=>{
    if(!drag || event.pointerId!==drag.id || drag.editor!==IMAGE_EDITOR || IMAGE_EDITOR.mode!=="camera")return;
    const dx=event.clientX-drag.x, dy=event.clientY-drag.y;
    if(!drag.moved && Math.hypot(dx,dy)<4)return;
    drag.moved=true;
    const heading=dx ? ((Math.round(drag.yaw+dx*1.5)+180)%360+360)%360-180 : drag.yaw;
    change(heading,Math.round(drag.pitch-dy));
  };
  orbit.onpointerup=event=>{
    if(!drag || event.pointerId!==drag.id)return;
    const start=drag;
    drag=null;
    if(start.editor!==IMAGE_EDITOR || IMAGE_EDITOR.mode!=="camera")return;
    if(!start.moved){
      const {left,top,width,height}=orbit.getBoundingClientRect();
      const x=event.clientX-left-width/2,y=(event.clientY-top-height/2)/.55;
      if(Math.hypot(x,y)>10)change(Math.round(Math.atan2(x,y)*180/Math.PI),start.pitch);
    }
    ewScheduleDraft();
  };
  orbit.onpointercancel=orbit.onlostpointercapture=event=>{
    if(!drag || event.pointerId!==drag.id)return;
    if(drag.editor===IMAGE_EDITOR && IMAGE_EDITOR.mode==="camera")change(drag.yaw,drag.pitch);
    drag=null;
  };
}
