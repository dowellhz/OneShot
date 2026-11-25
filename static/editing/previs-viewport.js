"use strict";

const PV_LIGHT_PRESETS={
  side:{label:"中性侧光",settings:{azimuth:45,elevation:30,key:.8,ambient:.32,tone:"neutral"}},
  back:{label:"暖色后光",settings:{azimuth:-145,elevation:28,key:.95,ambient:.23,tone:"warm"}},
  top:{label:"冷色顶光",settings:{azimuth:15,elevation:75,key:1,ambient:.28,tone:"cool"}},
};
const PV_LIGHT_LABELS={azimuth:"方位角（°）",elevation:"高度角（°）",key:"主光强度",ambient:"环境光"};

function pvRefreshLighting(E) {
  const light=E.scene.lighting;
  pvElement("[data-pv-light-fields]").hidden=!light;
  const match=light && Object.entries(PV_LIGHT_PRESETS).find(([,preset])=>
    Object.entries(preset.settings).every(([key,value])=>value===light[key]));
  pvElement("[data-pv-light-preset]").value=light?match?.[0]||"custom":"off";
  if(light){
    for(const key of Object.keys(PV_LIGHT_LIMITS))pvElement(`[data-pv-light-value="${key}"]`).value=light[key];
    pvElement("[data-pv-light-tone]").value=light.tone;
  }
}

function pvFrame(E) {
  const canvas=pvElement("canvas"), [width,height]=PV_SIZE[E.scene.aspect];
  if (canvas.width!==width || canvas.height!==height) {
    canvas.width=width;
    canvas.height=height;
  }
  const free=E.view==="free";
  canvas.tabIndex=free?0:-1;
  canvas.toggleAttribute("data-pv-free",free);
  pvElement("[data-pv-free-controls]").hidden=!free;
  if (E.view==="plan") pvPaintPlan(canvas,E.scene,E.tick,E.active,E.drag?.layout,E.route);
  else if (free) pvPaint(canvas,pvFreeScene(E),E.tick);
  else pvPaint(canvas,E.scene,E.tick,E.active);
  pvElement("[data-pv-time]").textContent=pvTime(E.tick);
  const scrub=pvElement("[data-pv-scrub]");
  scrub.max=E.scene.duration*PV_FPS;
  scrub.value=E.tick;
}

function pvFreeScene(E) {
  return {...E.scene,camera:[E.freeView]};
}

function pvResetFreeView(E) {
  E.freeView=pvSample(E.scene.camera,E.tick);
  pvFrame(E);
}

function pvTurnFreeView(E, dx, dy) {
  const camera=E.freeView;
  const x=camera.tx-camera.x, y=camera.ty-camera.y, z=camera.tz-camera.z;
  const distance=Math.max(1,Math.hypot(x,y,z));
  const yaw=Math.atan2(x,z)-dx*.006;
  const pitch=Math.max(-1.48,Math.min(1.48,Math.atan2(y,Math.hypot(x,z))-dy*.006));
  Object.assign(camera,{tx:camera.x+distance*Math.cos(pitch)*Math.sin(yaw),
    ty:camera.y+distance*Math.sin(pitch),tz:camera.z+distance*Math.cos(pitch)*Math.cos(yaw)});
  pvFrame(E);
}

function pvMoveFreeView(E, key, step) {
  const camera=E.freeView;
  const yaw=Math.atan2(camera.tx-camera.x,camera.tz-camera.z);
  const forward=["w","s"].includes(key)?(key==="w"?step:-step):0;
  const sideways=["a","d"].includes(key)?(key==="d"?step:-step):0;
  const delta=[forward*Math.sin(yaw)-sideways*Math.cos(yaw),key==="e"?step:key==="q"?-step:0,
    forward*Math.cos(yaw)+sideways*Math.sin(yaw)];
  for(const [i,axis] of ["x","y","z"].entries()){
    const next=Math.max(-50,Math.min(50,camera[axis]+delta[i]));
    camera["t"+axis]+=next-camera[axis];
    camera[axis]=next;
  }
  pvFrame(E);
}

function pvAdoptFreeView(E) {
  if (E.view!=="free" || !E.freeView)return;
  pvPause(E);
  const pose=Object.fromEntries(PV_PARAMS.camera.map(([key])=>[key,E.freeView[key]]));
  if(PV_PARAMS.camera.some(([key])=>key!=="fov" && Math.abs(pose[key])>50)){
    pvStatus("视线超出机位可记录范围，请向场景内部移动后再设为机位。");return;
  }
  E.active="camera";
  if(!pvChangePose(E,pose)){pvRefreshTrack(E);pvStatus("机位轨道已满，请移除一个关键帧后再试。");return;}
  E.view="camera";
  E.look=null;
  const view=pvElement("[data-pv-view]");
  view.value="camera";
  pvFrame(E);
  view.focus();
  pvStatus(`已将自由视图设为 ${pvTime(E.tick)} 的机位`);
}

function pvPointer(canvas,ev,width,height) {
  const rect=canvas.getBoundingClientRect();
  return [(ev.clientX-rect.left)*width/rect.width,(ev.clientY-rect.top)*height/rect.height];
}

function pvBindCanvas(canvas) {
  canvas.onpointerdown=ev=>{
    const E=PV.editor;
    if (!E || E.sending || E.guideBatch || ev.button!==0) return;
    if(E.view==="free"){
      canvas.focus();
      E.look={id:ev.pointerId,x:ev.clientX,y:ev.clientY};
      canvas.setPointerCapture?.(ev.pointerId);
      return;
    }
    if(E.view!=="plan")return;
    pvPause(E);
    const layout=pvPlan(E.scene,E.tick,canvas.width,canvas.height,E.active);
    const [x,z]=layout.world(...pvPointer(canvas,ev,canvas.width,canvas.height));
    const limit=v=>Math.max(-50,Math.min(50,Math.round(v*100)/100));
    if (E.route) {
      const item=E.scene.objects.find(o=>o.id===E.route.id), points=E.route.points;
      if (!item || E.route.pending || points.length>=31) return;
      const last=points.at(-1) || pvSample(item.keys,E.route.start), next={x:limit(x),z:limit(z)};
      if (Math.hypot(next.x-last.x,next.z-last.z)<.01) return;
      points.push(next);
      pvRefreshRoute(E);
      pvFrame(E);
      return;
    }
    const near=layout.objects.filter(o=>{
      const a=o.yaw*Math.PI/180,dx=x-o.x,dz=z-o.z,padding=5/layout.scale;
      return Math.abs(dx*Math.cos(a)+dz*Math.sin(a))<=o.width/2+padding &&
        Math.abs(-dx*Math.sin(a)+dz*Math.cos(a))<=o.depth/2+padding;
    });
    const chosen=near.find(o=>o.id===E.active) || near.at(-1);
    if (!chosen) return;
    E.active=chosen.id;
    E.drag={layout,id:ev.pointerId,dx:x-chosen.x,dz:z-chosen.z};
    canvas.setPointerCapture?.(ev.pointerId);
    pvRefreshTrack(E);
  };
  canvas.onpointermove=ev=>{
    const E=PV.editor,drag=E?.drag;
    if(E?.sending || E?.guideBatch)return;
    if(E?.view==="free" && E.look && E.look.id===ev.pointerId){
      const look=E.look;
      pvTurnFreeView(E,ev.clientX-look.x,ev.clientY-look.y);
      Object.assign(look,{x:ev.clientX,y:ev.clientY});
      return;
    }
    if (!drag || drag.id!==ev.pointerId) return;
    const [x,z]=drag.layout.world(...pvPointer(canvas,ev,canvas.width,canvas.height));
    const limit=v=>Math.max(-50,Math.min(50,Math.round(v*100)/100));
    if (pvChangePose(E,{x:limit(x-drag.dx),z:limit(z-drag.dz)},false)) pvFrame(E);
  };
  const end=ev=>{
    const E=PV.editor;
    if(E?.look && E.look.id===ev?.pointerId)E.look=null;
    if (!E?.drag) return;
    E.drag=null;
    pvRefreshTrack(E);
  };
  canvas.onpointerup=canvas.onpointercancel=canvas.onlostpointercapture=end;
  canvas.onkeydown=event=>{
    const E=PV.editor;
    if(E?.view!=="free" || E.sending || E.guideBatch || event.altKey || event.ctrlKey || event.metaKey)return;
    const key=event.key.toLowerCase(), turns={arrowleft:[-12,0],arrowright:[12,0],arrowup:[0,-12],arrowdown:[0,12]};
    if(Object.hasOwn(turns,key))pvTurnFreeView(E,...turns[key]);
    else if(["w","a","s","d","q","e"].includes(key))pvMoveFreeView(E,key,event.shiftKey ? .8 : .25);
    else return;
    event.preventDefault();
  };
}
