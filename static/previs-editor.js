"use strict";

const PV = {editor:null, attempts:new Map()};
const PV_PARAMS = {
  camera:[["x","机位 X"],["y","机位高度"],["z","机位 Z"],["tx","目标 X"],["ty","目标高度"],["tz","目标 Z"],["fov","视角"]],
  object:[["x","位置 X"],["y","离地高度"],["z","位置 Z"],["yaw","旋转角度"]],
  size:[["width","宽"],["height","高"],["depth","深"]],
};
const PV_MOVES = {push:"推进",pull:"拉远",slide_left:"向左横移",slide_right:"向右横移",
  orbit_left:"向左环绕",orbit_right:"向右环绕",follow:"跟拍物体"};

function pvInitialScene() {
  return {duration:4,aspect:"16:9",
    camera:[{t:0,x:5,y:3.2,z:7,tx:0,ty:1,tz:0,fov:42,ease:"linear"}],
    objects:[
      {id:"actor",label:"人物 1",shape:"figure",width:.85,height:1.8,depth:.58,
        keys:[{t:0,x:-1.7,y:0,z:0,yaw:0,ease:"linear"},{t:96,x:1.5,y:0,z:0,yaw:0,ease:"smooth"}]},
      {id:"block",label:"前景方块",shape:"box",width:1.35,height:.8,depth:1.1,keys:[{t:0,x:1.8,y:0,z:1.5,yaw:12,ease:"linear"}]},
    ]};
}

function addPrevisNode(at) {
  if (!canvasCanEdit()) return;
  checkpoint();
  const scene=pvInitialScene();
  const n=addNode("video",at.x,at.y,{previs:scene,aspect:scene.aspect,duration:scene.duration},{name:"白模预演"});
  selectOnly(n.id);
  openPrevis(n);
}

function pvActive(E) { return E.scene.objects.find(item=>item.id===E.active); }
function pvTrack(E) { return pvActive(E)?.keys || E.scene.camera; }
function pvElement(selector) { return $(selector, $("#previsEditor")); }
function pvStatus(text) { pvElement("[data-pv-status]").textContent=text; }
function pvTime(tick) { return (tick/PV_FPS).toFixed(2)+" 秒"; }
function pvValidNode(E) { return E && E.board===boardId && node(E.n.id)===E.n && canvasCanEdit(); }

function pvUsableScene(scene) {
  const trackValid=(list, props)=>Array.isArray(list) && list.length>0 && list.length<=32 && list.every((key,i)=>
    key && Number.isInteger(key.t) && key.t>(list[i-1]?.t ?? -1) && props.every(([p])=>Number.isFinite(key[p])));
  let triangleCount=0;
  const validShape=o=>{
    if (o.shape!=="mesh") return Object.hasOwn(PV_MESH,o.shape);
    if (!Array.isArray(o.triangles) || !o.triangles.length) return false;
    triangleCount+=o.triangles.length;
    return triangleCount<=PV_TRIANGLE_LIMIT && o.triangles.every(face=>
      Array.isArray(face)&&face.length===9&&face.every(v=>Number.isFinite(v)&&Math.abs(v)<=1));
  };
  return !!scene && Number.isInteger(scene.duration) && scene.duration>=2 && scene.duration<=14 && !!PV_SIZE[scene.aspect] &&
    trackValid(scene.camera,PV_PARAMS.camera) && Array.isArray(scene.objects) && scene.objects.every(o=>
      o && o.id!=="camera" && validShape(o) && PV_PARAMS.size.every(([p])=>Number.isFinite(o[p])) && trackValid(o.keys,PV_PARAMS.object));
}

function pvUpdateRenderState(n) {
  const E=PV.editor;
  if (!E || E.n!==n) return;
  const submit=pvElement("[data-pv-render]");
  submit.disabled=E.sending || !!n.job;
  submit.textContent=n.job?"渲染中…":"渲染预演";
  const use=pvElement("[data-pv-use]");
  use.hidden=curV(n)?.source!=="previs";
  use.disabled=E.sending;
  pvElement("[data-pv-close]").disabled=E.sending;
  pvElement("fieldset").disabled=E.sending;
}

function previsInput(n) {
  const edge = B.edges.find(e => e.to === n.id && e.relation === "previs");
  if (!edge) return null;
  const source = node(edge.from);
  const index = source?.versions.findIndex(v => v.ref === edge.ref && v.source === "previs") ?? -1;
  return {edge, source, version:source?.versions[index], index};
}

function attachPrevis(source, video) {
  const version = curV(source), guide = previsInput(video);
  if (guide) B.edges = B.edges.filter(e => e !== guide.edge);
  const services = CAPS_LIST.previs || [];
  if (!services.some(s => s.id === video.data.provider)) video.data.provider = services[0]?.id || "";
  B.edges.push({from:source.id, to:video.id, relation:"previs", ref:version.ref});
  save(); refresh(video); selectOnly(video.id);
  $("#prompt").focus();
}

function usePrevisForVideo(source) {
  if (!canvasCanEdit() || curV(source)?.source !== "previs") return;
  const version = curV(source), s = size(source);
  const at = freeSpot(source.x + s.w + 110, source.y, "video");
  const aspect = version.previs_recipe?.aspect || (version.w === version.h ? "1:1" : version.w < version.h ? "9:16" : "16:9");
  checkpoint();
  const video = addNode("video", at.x, at.y, {aspect, duration:Math.min(14, Math.max(4, Math.round(version.seconds || 5)))},
    {name:source.name + " · 正式视频"});
  attachPrevis(source, video);
}

function updatePrevisInput(n) {
  if (!canvasCanEdit() || n.job || prepping.has(n.id)) return;
  const guide = previsInput(n), next = curV(guide?.source);
  if (!guide || next?.source !== "previs" || guide.edge.ref === next.ref) return;
  checkpoint(); rememberVideoVersion(n);
  guide.edge.ref = next.ref;
  save(); refresh(n);
}

function pvFinished(n, error) {
  if (PV.editor?.n !== n) return;
  pvUpdateRenderState(n);
  pvStatus(error || "预演视频已加入此节点。");
}

function pvSyncBoard() {
  const E=PV.editor;
  if (!E || E.sending) return;
  if (!pvValidNode(E) || !pvUsableScene(E.n.data.previs)) { closePrevis(true); return; }
  const incoming=JSON.stringify(E.n.data.previs);
  if (incoming!==E.savedScene && JSON.stringify(E.scene)===E.savedScene) {
    pvPause(E);
    E.scene=structuredClone(E.n.data.previs);
    E.savedScene=incoming;
    E.tick=Math.min(E.tick,E.scene.duration*PV_FPS);
    if (!pvActive(E)) E.active="camera";
    pvElement("[data-pv-duration]").value=E.scene.duration;
    pvElement("[data-pv-aspect]").value=E.scene.aspect;
    pvRefreshTrack(E);
  }
  pvElement("[data-pv-heading]").textContent=E.n.name;
  pvUpdateRenderState(E.n);
}

function pvFrame(E) {
  const canvas=pvElement("canvas"), [width,height]=PV_SIZE[E.scene.aspect];
  if (canvas.width!==width || canvas.height!==height) {
    canvas.width=width;
    canvas.height=height;
  }
  if (E.view==="plan") pvPaintPlan(canvas,E.scene,E.tick,E.active,E.drag?.layout,E.route);
  else pvPaint(canvas,E.scene,E.tick,E.active);
  pvElement("[data-pv-time]").textContent=pvTime(E.tick);
  const scrub=pvElement("[data-pv-scrub]");
  scrub.max=E.scene.duration*PV_FPS;
  scrub.value=E.tick;
}

function pvRefreshFields(E) {
  const item=pvActive(E), pose=pvSample(pvTrack(E),E.tick);
  for (const field of $$("[data-pv-param]",$("#previsEditor"))) {
    const owner=field.dataset.owner, key=field.dataset.pvParam;
    field.closest("label").hidden=item ? owner==="camera" : owner!=="camera";
    const value=owner==="size"?item?.[key]:pose[key];
    if (Number.isFinite(value) && document.activeElement!==field) field.value=Number(value.toFixed(2));
  }
  pvElement("[data-pv-shape]").hidden=!item||item.shape==="mesh";
  pvElement("[data-pv-delete-object]").hidden=!item;
  pvElement("[data-pv-name]").closest("label").hidden=!item;
  if (item && document.activeElement!==pvElement("[data-pv-name]")) pvElement("[data-pv-name]").value=item.label;
  if (item) pvElement("[data-pv-kind]").value=item.shape;
  const track=pvTrack(E);
  const key=track.find(p=>p.t===E.tick);
  pvElement("[data-pv-key-delete]").disabled=!key || track.length<=1;
  pvElement("[data-pv-ease]").disabled=!key;
  pvElement("[data-pv-ease]").value=key?.ease || "linear";
  pvElement("[data-pv-ease] option[value=cut]").hidden=!!item;
  pvElement("[data-pv-cut-tools]").hidden=!!item;
  pvElement("[data-pv-add-cut]").disabled=!!item || E.tick===0 || E.tick>=E.scene.duration*PV_FPS ||
    (!key && track.length>=32);
  pvElement("[data-pv-key-add]").disabled=!!key || track.length>=32;
  pvRefreshMotion(E);
  pvRefreshRoute(E);
  for (const b of $$("[data-pv-at]",$("#previsEditor"))) b.setAttribute("aria-pressed",String(Number(b.dataset.pvAt)===E.tick));
}

function pvRefreshTrack(E) {
  const pick=pvElement("[data-pv-track]");
  pick.replaceChildren(new Option("机位","camera"),...E.scene.objects.map(item=>new Option(item.label,item.id)));
  pick.value=E.active;
  const target=pvElement("[data-pv-motion-target]"), previous=target.value;
  target.replaceChildren(...E.scene.objects.map(item=>new Option(item.label,item.id)));
  if (E.scene.objects.some(item=>item.id===previous)) target.value=previous;
  const cutSource=pvElement("[data-pv-cut-source]"), chosen=cutSource.value;
  cutSource.replaceChildren(new Option("当前构图","current"),...E.scene.camera.map(key=>
    new Option(pvTime(key.t),String(key.t))));
  if ([...cutSource.options].some(option=>option.value===chosen)) cutSource.value=chosen;
  const marker = pvElement("[data-pv-keys]");
  marker.replaceChildren(...pvTrack(E).map(key=>{
    const b=document.createElement("button");
    b.type="button";
    b.textContent=pvTime(key.t)+(key.ease==="cut"?" · 硬切":"");
    b.toggleAttribute("data-pv-cut",key.ease==="cut");
    b.dataset.pvAt=key.t;
    b.onclick=()=>{pvPause(E);E.tick=key.t;pvRefreshFields(E);pvFrame(E);};
    return b;
  }));
  pvRefreshFields(E);
  pvFrame(E);
}

function pvMotionPlan(E) {
  const mode = pvElement("[data-pv-motion-mode]").value;
  return {mode,start:E.tick,end:Math.round(pvElement("[data-pv-motion-end]").valueAsNumber*PV_FPS),
    amount:pvElement("[data-pv-motion-amount]").valueAsNumber,
    target:pvElement("[data-pv-motion-target]").value};
}

function pvRoutePlan(route) {
  return {target:route.id,start:route.start,
    end:Math.round(pvElement("[data-pv-route-end]").valueAsNumber*PV_FPS),points:route.points};
}

function pvRefreshRoute(E) {
  const route=E.route, item=route && E.scene.objects.find(o=>o.id===route.id);
  pvElement("[data-pv-route-start]").disabled=!!route || !pvActive(E) || E.tick>=E.scene.duration*PV_FPS;
  pvElement("[data-pv-route-tools]").hidden=!route;
  const undo=E.routeUndo, changed=undo && E.scene.objects.find(o=>o.id===undo.id)?.keys;
  pvElement("[data-pv-route-undo]").disabled=!changed || undo.applied!==JSON.stringify(changed) || !!route;
  if (!route) return;
  const plan=pvRoutePlan(route);
  pvElement("[data-pv-route-end]").max=E.scene.duration;
  pvElement("[data-pv-route-info]").textContent=item?
    `${item.label} · ${pvTime(route.start)} 起 · 已选 ${route.points.length} 个路点`:"路线物体已移除";
  pvElement("[data-pv-route-apply]").disabled=route.pending || !item || !route.points.length ||
    !(route.start+route.points.length<=plan.end && plan.end<=E.scene.duration*PV_FPS);
  pvElement("[data-pv-route-pop]").disabled=route.pending || !route.points.length;
}

function pvStartRoute(E) {
  const item=pvActive(E);
  if (!item || E.route || E.tick>=E.scene.duration*PV_FPS) return;
  pvPause(E);
  E.route={id:item.id,start:E.tick,points:[]};
  E.view="plan";
  pvElement("[data-pv-view]").value="plan";
  pvElement("[data-pv-route-end]").value=E.scene.duration;
  pvRefreshRoute(E);
  pvFrame(E);
  pvStatus("在俯视图按顺序点选经过的位置，最后一个点为终点。");
}

async function pvApplyRoute(E) {
  const route=E.route, item=route && E.scene.objects.find(o=>o.id===route.id);
  if (!pvValidNode(E) || !item || pvElement("[data-pv-route-apply]").disabled) return;
  pvPause(E);
  const plan=pvRoutePlan(route), snapshot=JSON.stringify(E.scene);
  const planSnapshot=JSON.stringify(plan);
  route.pending=true;
  pvRefreshRoute(E);
  try {
    const result=await api("/api/previs/object-motion",{scene:JSON.parse(snapshot),plan});
    if (PV.editor!==E || E.route!==route || !pvValidNode(E) || E.sending) return;
    if (JSON.stringify(E.scene)!==snapshot || JSON.stringify(pvRoutePlan(route))!==planSnapshot) {
      pvStatus("场景或路线已变更，请重新应用");
      return;
    }
    E.routeUndo={id:item.id,previous:item.keys,applied:JSON.stringify(result.keys)};
    item.keys=result.keys;
    E.route=null;
    E.active=item.id;
    E.tick=route.start;
    pvRefreshTrack(E);
    pvStatus("路线已应用，可播放预览或逐帧调整。");
  } catch (error) {
    if (PV.editor===E && E.route===route) pvStatus(error.message);
  } finally {
    route.pending=false;
    if (PV.editor===E) pvRefreshRoute(E);
  }
}

function pvRefreshMotion(E) {
  const {mode,start,end,target} = pvMotionPlan(E);
  const orbit = mode.startsWith("orbit"), follow = mode==="follow";
  const amount = pvElement("[data-pv-motion-amount]"), limit=pvElement("[data-pv-motion-end]");
  limit.max=E.scene.duration;
  amount.min=orbit ? 5 : .1;
  amount.max=orbit ? 180 : 20;
  pvElement("[data-pv-motion-unit]").textContent=orbit ? "角度（度）" : "距离（米）";
  amount.closest("label").hidden=follow;
  pvElement("[data-pv-motion-target]").closest("label").hidden=!follow;
  pvElement("[data-pv-motion-start]").textContent=pvTime(start);
  const replaced=E.scene.camera.filter(key=>start<key.t && key.t<=end).length;
  pvElement("[data-pv-motion-segment]").textContent=replaced?`区间内 ${replaced} 个机位关键帧将替换`:"";
  pvElement("[data-pv-motion-apply]").disabled=!!E.motionPending ||
    !(start<end && end<=E.scene.duration*PV_FPS && (follow ? !!target : pvNumber(amount)!=null));
  pvElement("[data-pv-motion-undo]").disabled=!E.motionUndo ||
    E.motionUndo.applied!==JSON.stringify(E.scene.camera);
}

async function pvApplyMotion(E) {
  if (!pvValidNode(E) || pvElement("[data-pv-motion-apply]").disabled) return;
  pvPause(E);
  const plan=pvMotionPlan(E), snapshot=JSON.stringify(E.scene), previous=E.scene.camera;
  E.motionPending=true;
  pvRefreshMotion(E);
  pvStatus("正在计算运镜关键帧…");
  try {
    const result=await api("/api/previs/camera-motion",{scene:JSON.parse(snapshot),plan});
    if (PV.editor!==E || !pvValidNode(E) || E.sending) return;
    if (JSON.stringify(E.scene)!==snapshot || JSON.stringify(pvMotionPlan(E))!==JSON.stringify(plan)) {
      pvStatus("运镜区间或场景已变更，请重新应用");
      return;
    }
    E.scene.camera=result.camera;
    E.motionUndo={previous,applied:JSON.stringify(result.camera)};
    E.active="camera";
    pvRefreshTrack(E);
    pvStatus(`已应用${PV_MOVES[plan.mode]}。可播放预览或调整生成的关键帧。`);
  } catch (error) {
    if (PV.editor===E) pvStatus(error.message || "运镜计算失败");
  } finally {
    E.motionPending=false;
    if (PV.editor===E) pvRefreshMotion(E);
  }
}

function pvChangePose(E, change, refresh=true) {
  const track=pvTrack(E), index=track.findIndex(key=>key.t===E.tick);
  if (index<0 && track.length>=32) return false;
  const pose=pvSample(track,E.tick);
  const ease=track[index]?.ease ?? (pose.ease==="cut" ? "linear" : pose.ease);
  const newKey={...pose,t:E.tick,ease,...change};
  if (index>=0) track[index]=newKey;
  else {
    track.push(newKey);
    track.sort((a,b)=>a.t-b.t);
  }
  if (refresh) pvRefreshTrack(E);
  return true;
}

function pvCommit(E) {
  if (!pvValidNode(E)) return false;
  const local=JSON.stringify(E.scene), stored=JSON.stringify(E.n.data.previs);
  if (local!==stored && local!==E.savedScene) {
    if (stored!==E.savedScene) {
      pvElement("[data-pv-discard]").hidden=false;
      pvStatus("画布中的白模已有更新。关闭并放弃本次编辑后，可重新打开最新场景。");
      return false;
    }
    checkpoint();
    rememberVideoVersion(E.n);
    Object.assign(E.n.data,{previs:structuredClone(E.scene),aspect:E.scene.aspect,duration:E.scene.duration});
    render(E.n); showPanel(); drawEdges(); save();
  }
  E.savedScene=local;
  return true;
}

function pvPause(E) {
  if (!E.playing) return;
  E.playing=false;
  cancelAnimationFrame(E.animation);
  pvElement("[data-pv-play]").textContent="播放";
  pvRefreshFields(E);
}

function pvPlayback(E) {
  if (E.playing) return pvPause(E);
  if (E.tick>=E.scene.duration*PV_FPS) E.tick=0;
  const origin=performance.now()-E.tick*1000/PV_FPS;
  E.playing=true;
  pvElement("[data-pv-play]").textContent="暂停";
  const step=now=>{
    if (PV.editor!==E || !E.playing) return;
    E.tick=Math.min(E.scene.duration*PV_FPS,Math.max(0,Math.round((now-origin)*PV_FPS/1000)));
    pvFrame(E);
    if (E.tick>=E.scene.duration*PV_FPS) pvPause(E);
    else E.animation=requestAnimationFrame(step);
  };
  E.animation=requestAnimationFrame(step);
}

function closePrevis(discard=false) {
  const E=PV.editor;
  if (!E || E.sending) return !E;
  pvPause(E);
  if (discard!==true && pvValidNode(E) && !pvCommit(E)) return false;
  PV.editor=null;
  const panel=$("#previsEditor");
  if (panel.close) panel.close();
  else panel.removeAttribute("open");
  return true;
}

function openPrevis(n) {
  if (!canvasCanEdit() || !n?.data.previs) return;
  if (!pvUsableScene(n.data.previs)) return toast("白模场景记录无法读取");
  if (PV.editor && !closePrevis()) return;
  const scene=structuredClone(n.data.previs);
  const E=PV.editor={n,board:boardId,scene,savedScene:JSON.stringify(scene),active:"camera",tick:0,view:"camera",sending:false};
  const panel=$("#previsEditor");
  if (panel.showModal) panel.showModal();
  else panel.setAttribute("open","");
  pvElement("[data-pv-duration]").value=scene.duration;
  pvElement("[data-pv-aspect]").value=scene.aspect;
  pvElement("[data-pv-view]").value="camera";
  pvElement("[data-pv-motion]").open=false;
  pvElement("[data-pv-motion-mode]").value="push";
  pvElement("[data-pv-motion-end]").value=scene.duration;
  pvElement("[data-pv-motion-amount]").value="1";
  pvElement("[data-pv-heading]").textContent=n.name;
  pvElement("[data-pv-discard]").hidden=true;
  pvElement("[data-pv-import-model]").textContent="导入 3D 模型";
  pvStatus("");
  pvRefreshTrack(E);
  pvUpdateRenderState(n);
}

function pvDownload(blob, filename) {
  const url=URL.createObjectURL(blob), link=document.createElement("a");
  link.href=url;
  link.download=filename;
  link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

function pvDownloadScene(E) {
  if (!pvValidNode(E)) return;
  pvPause(E);
  try {
    const name=E.n.name || "白模预演";
    pvDownload(pvGlb(E.scene,E.tick,name),name.replace(/[\\/:*?"<>|]/g,"_")+".glb");
    pvStatus("已开始下载场景 GLB");
  } catch(error) {
    pvStatus(error.message);
  }
}

async function pvImportModel(E,picked) {
  if (!picked.length || !pvValidNode(E)) return;
  if (E.scene.objects.length>=24) return pvStatus("一个场景最多包含 24 个物体");
  const main=picked.filter(file=>/\.(glb|gltf)$/i.test(file.name));
  if (main.length>1) return pvStatus("每次请选择一个 GLB 或 glTF 模型");
  const file=main[0] || E.modelImport?.file;
  if (!file || file.size>PV_MODEL_SIZE) return pvStatus("请选择 12 MiB 以内的 GLB 或 glTF 模型");
  const files=new Map(main.length?[]:E.modelImport.files);
  const selected=picked.filter(part=>part!==file);
  if (new Set(selected.map(part=>part.name)).size!==selected.length) return pvStatus("所选的配套文件有重名，请检查文件名");
  selected.forEach(part=>files.set(part.name,part));
  const button=pvElement("[data-pv-import-model]");
  E.modelImport=null;
  button.textContent="导入 3D 模型";
  pvPause(E);
  E.sending=true;
  pvUpdateRenderState(E.n);
  try {
    const used=E.scene.objects.reduce((total,item)=>total+(item.shape==="mesh"?item.triangles.length:0),0);
    const available=PV_TRIANGLE_LIMIT-used;
    const {triangles,dimensions:[width,height,depth]}=/\.gltf$/i.test(file.name) ?
      await pvReadGltf(file,files,available) : pvReadGlb(await file.arrayBuffer(),available);
    if (!pvValidNode(E)) return;
    if (!pvFaces({shape:"mesh",triangles}).length) throw new Error("模型没有可显示的三角面");
    const id=newCanvasNodeId(), label=file.name.replace(/\.(gltf|glb)$/i,"").trim().slice(0,40)||"导入模型";
    E.scene.objects.push({id,label,shape:"mesh",triangles,width,height,depth,
      keys:[{t:0,x:0,y:0,z:0,yaw:0,ease:"linear"}]});
    E.active=id;
    pvRefreshTrack(E);
    pvStatus(`已导入 ${label} · ${triangles.length} 个三角面`);
  } catch(error) {
    if (error.missingBuffers) {
      E.modelImport={file,files};
      button.textContent="补选模型文件";
    }
    pvStatus(error.message);
  } finally {
    E.sending=false;
    pvUpdateRenderState(E.n);
  }
}

async function pvExportFrame(E, download) {
  if (!pvValidNode(E) || E.sending) return;
  pvPause(E);
  if (!download && !pvCommit(E)) return;
  const tick=E.tick, time=pvTime(tick), board=B, savedScene=E.savedScene;
  const [w,h]=PV_SIZE[E.scene.aspect];
  E.sending=true;
  pvUpdateRenderState(E.n);
  pvStatus(download ? "正在导出 PNG…" : "正在将当前帧放入画布…");
  try {
    const frame=document.createElement("canvas");
    frame.width=w;
    frame.height=h;
    pvPaint(frame,E.scene,tick);
    const blob=await new Promise(resolve=>frame.toBlob(resolve,"image/png"));
    if (!blob) throw new Error("无法导出当前帧");
    const name=E.n.name+" · "+time;
    const filename=name.replace(/[\\/:*?"<>|]/g,"_")+".png";
    if (download) {
      pvDownload(blob,filename);
      pvStatus("已开始下载当前帧");
      return;
    }
    const asset=await ewUpload(blob,filename);
    if (PV.editor!==E || B!==board || !pvValidNode(E) || JSON.stringify(E.n.data.previs)!==savedScene) {
      throw new Error("画布或白模场景已更新，请重新打开场景后再截帧");
    }
    const version=mediaVersion({...asset,w,h},{source:"previs-frame",mode:"白模机位截帧"});
    const data={aspect:E.scene.aspect};
    const extra={name,versions:[version],cur:0};
    const dimensions=size({type:"image",data,...extra});
    const at=freeSpot(E.n.x+size(E.n).w+110,E.n.y,"image",dimensions);
    checkpoint();
    const image=addNode("image",at.x,at.y,data,extra);
    selectOnly(image.id);
    fit([image]);
    loadAssets();
    pvStatus("当前帧已放入画布，关闭预演即可查看");
  } catch(error) {
    pvStatus(error.message);
  } finally {
    E.sending=false;
    pvUpdateRenderState(E.n);
  }
}

async function pvRender(E) {
  if (!pvValidNode(E) || E.sending || E.n.job) return;
  pvPause(E);
  if (!pvCommit(E)) return;
  const scene=structuredClone(E.n.data.previs);
  E.sending=true;
  pvUpdateRenderState(E.n);
  pvStatus("正在保存并提交白模…");
  try {
    await flushSave();
    if (!pvValidNode(E)) return;
    if (JSON.stringify(E.n.data.previs)!==JSON.stringify(scene)) throw new Error("白模场景已更新，请重新打开后渲染");
    const key=JSON.stringify([E.board,E.n.id,E.n.data.previs]);
    let attempt=PV.attempts.get(key);
    if (!attempt) {
      attempt=crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), b=>b.toString(16).padStart(2,"0")).join("");
      PV.attempts.set(key,attempt);
    }
    const result=await api("/api/previs/render",{board:E.board,node:E.n.id,revision:B.rev,request_key:attempt});
    if (!pvValidNode(E)) return;
    PV.attempts.delete(key);
    E.n.job={ids:result.ids,prompt:"",source:"previs",t0:Date.now(),st:{},history:{
      previs_recipe:scene,node_data:structuredClone(E.n.data),input_edges:[],
    }};
    save(); render(E.n); poll();
    pvStatus("已提交渲染，完成后会加入此节点的版本列表。");
  } catch(error) {
    pvStatus(error.message);
  } finally {
    E.sending=false;
    pvUpdateRenderState(E.n);
  }
}

function pvNumber(field) {
  return Number.isFinite(field.valueAsNumber) ? Math.min(Number(field.max),Math.max(Number(field.min),field.valueAsNumber)) : null;
}

function pvPointer(canvas,ev,width,height) {
  const rect=canvas.getBoundingClientRect();
  return [(ev.clientX-rect.left)*width/rect.width,(ev.clientY-rect.top)*height/rect.height];
}

function pvBindPlan(canvas) {
  canvas.onpointerdown=ev=>{
    const E=PV.editor;
    if (!E || E.view!=="plan" || E.sending || ev.button!==0) return;
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
    if (!drag || drag.id!==ev.pointerId) return;
    const [x,z]=drag.layout.world(...pvPointer(canvas,ev,canvas.width,canvas.height));
    const limit=v=>Math.max(-50,Math.min(50,Math.round(v*100)/100));
    if (pvChangePose(E,{x:limit(x-drag.dx),z:limit(z-drag.dz)},false)) pvFrame(E);
  };
  const end=()=>{
    const E=PV.editor;
    if (!E?.drag) return;
    E.drag=null;
    pvRefreshTrack(E);
  };
  canvas.onpointerup=canvas.onpointercancel=canvas.onlostpointercapture=end;
}

function initPrevis() {
  const params=Object.entries(PV_PARAMS).flatMap(([owner,fields])=>fields.map(([key,label])=>{
    const min=owner==="size" ? .1 : key==="fov" ? 18 : key==="yaw" ? -360 : -50;
    const max=owner==="size"?20:key==="fov"?95:key==="yaw"?360:50;
    return `<label>${label}<input type="number" min="${min}" max="${max}" step=".1" data-owner="${owner}" data-pv-param="${key}"></label>`;
  })).join("");
  document.body.insertAdjacentHTML("beforeend",`<dialog id="previsEditor" aria-labelledby="pvTitle">
    <header class="pv-head"><div><strong id="pvTitle">3D 白模预演</strong><span data-pv-heading></span></div>
      <button type="button" data-pv-render>渲染预演</button><button type="button" data-pv-use hidden>用作动作参考</button><button type="button" data-pv-close>保存并关闭</button></header>
    <fieldset><div class="pv-layout">
      <section class="pv-stage"><div class="pv-controls">
        <label>视图<select data-pv-view><option value="camera">机位预览</option><option value="plan">俯视摆位</option></select></label>
        <label>画幅<select data-pv-aspect><option>16:9</option><option>9:16</option><option>1:1</option></select></label>
        <label>时长<input type="number" min="2" max="14" step="1" data-pv-duration> 秒</label>
      </div><canvas aria-label="白模场景预览"></canvas>
      <div class="pv-controls pv-timeline"><button type="button" data-pv-play>播放</button>
        <input type="range" min="0" max="96" step="1" data-pv-scrub aria-label="预演时间轴">
        <output data-pv-time></output></div>
      <div class="pv-controls"><button type="button" data-pv-frame-canvas>机位帧放入画布</button>
        <button type="button" data-pv-frame-download>下载机位帧 PNG</button>
        <button type="button" data-pv-scene-download>导出场景 GLB</button></div>
      <div class="pv-keys" data-pv-keys aria-label="当前轨道的关键帧"></div></section>
      <section class="pv-inspector">
        <label class="pv-wide">轨道<select data-pv-track></select></label>
        <div class="pv-controls"><select data-pv-add-kind aria-label="新增物体类型">${Object.entries(PV_SHAPES).map(([shape,label])=>`<option value="${shape}">${label}</option>`).join("")}</select>
          <button type="button" data-pv-add-object>添加物体</button><button type="button" data-pv-import-model>导入 3D 模型</button>
          <input type="file" data-pv-model-file accept=".glb,.gltf,.bin,application/octet-stream" multiple hidden><button type="button" data-pv-delete-object hidden>移除物体</button></div>
        <label class="pv-wide" hidden>物体名<input maxlength="40" data-pv-name></label>
        <label class="pv-wide" data-pv-shape hidden>形状<select data-pv-kind>${Object.entries(PV_SHAPES).map(([shape,label])=>`<option value="${shape}">${label}</option>`).join("")}</select></label>
        <div class="pv-fields">${params}</div>
        <div class="pv-controls"><button type="button" data-pv-key-add>添加关键帧</button><button type="button" data-pv-key-delete>移除此帧</button>
          <label>过渡<select data-pv-ease><option value="linear">匀速</option><option value="smooth">平滑</option><option value="cut">硬切</option></select></label></div>
        <div class="pv-controls pv-cut-tools" data-pv-cut-tools>
          <label>切镜构图<select data-pv-cut-source></select></label>
          <button type="button" data-pv-add-cut>添加切镜</button></div>
        <details data-pv-motion><summary>运镜预设</summary>
          <label class="pv-wide">方式<select data-pv-motion-mode>${Object.entries(PV_MOVES).map(([id,label])=>`<option value="${id}">${label}</option>`).join("")}</select></label>
          <p>起点用当前播放头 <output data-pv-motion-start></output></p>
          <label class="pv-wide">结束秒数<input type="number" min="0" step="any" data-pv-motion-end></label>
          <label class="pv-wide"><span data-pv-motion-unit>距离（米）</span><input type="number" min=".1" max="20" step="any" data-pv-motion-amount></label>
          <label class="pv-wide" hidden>跟拍目标<select data-pv-motion-target></select></label>
          <p data-pv-motion-segment></p>
          <div class="pv-controls"><button type="button" data-pv-motion-apply>应用运镜</button>
            <button type="button" data-pv-motion-undo>撤销本次运镜</button></div>
        </details>
        <div class="pv-route"><div class="pv-controls"><button type="button" data-pv-route-start>绘制走位</button>
          <button type="button" data-pv-route-undo disabled>撤销本次走位</button></div>
          <div data-pv-route-tools hidden><p data-pv-route-info></p>
            <label class="pv-wide">结束秒数<input type="number" min="0" step="any" data-pv-route-end></label>
            <div class="pv-controls"><button type="button" data-pv-route-pop>删除上一点</button>
              <button type="button" data-pv-route-apply>应用路线</button><button type="button" data-pv-route-cancel>取消路线</button></div>
          </div>
        </div>
      </section></div></fieldset>
    <div data-pv-status role="status"></div><button type="button" data-pv-discard hidden>关闭并放弃本次编辑</button></dialog>`);
  const panel=$("#previsEditor"), canvas=pvElement("canvas");
  panel.addEventListener("keydown", ev=>ev.stopPropagation());
  panel.addEventListener("cancel", ev=>{ev.preventDefault();closePrevis();});
  pvBindPlan(canvas);
  const on=(selector,key,fn)=>{pvElement(selector)[key]=event=>{const E=PV.editor;if(E&&!E.sending)fn(E,event);};};
  on("[data-pv-render]","onclick",pvRender);
  on("[data-pv-use]","onclick",E=>{if(closePrevis())usePrevisForVideo(E.n);});
  on("[data-pv-close]","onclick",()=>closePrevis());
  on("[data-pv-discard]","onclick",()=>closePrevis(true));
  on("[data-pv-play]","onclick",pvPlayback);
  on("[data-pv-frame-canvas]","onclick",E=>pvExportFrame(E,false));
  on("[data-pv-frame-download]","onclick",E=>pvExportFrame(E,true));
  on("[data-pv-scene-download]","onclick",pvDownloadScene);
  on("[data-pv-import-model]","onclick",()=>pvElement("[data-pv-model-file]").click());
  on("[data-pv-model-file]","onchange",(E,ev)=>{
    const files=[...ev.target.files];
    ev.target.value="";
    void pvImportModel(E,files);
  });
  on("[data-pv-scrub]","oninput",(E,ev)=>{pvPause(E);E.tick=Number(ev.target.value);pvRefreshFields(E);pvFrame(E);});
  on("[data-pv-track]","onchange",(E,ev)=>{pvPause(E);E.active=ev.target.value;pvRefreshTrack(E);});
  on("[data-pv-view]","onchange",(E,ev)=>{E.view=ev.target.value;pvFrame(E);});
  on("[data-pv-aspect]","onchange",(E,ev)=>{E.scene.aspect=ev.target.value;pvFrame(E);});
  on("[data-pv-duration]","onchange",(E,ev)=>{
    pvPause(E);
    const seconds=pvNumber(ev.target);
    if (seconds!=null) {
      E.scene.duration=Math.round(seconds);
      const end=E.scene.duration*PV_FPS;
      for (const track of [E.scene.camera,...E.scene.objects.map(o=>o.keys)]) {
        if (!track.some(k=>k.t>end)) continue;
        const atEnd=pvSample(track,end), keep=track.filter(k=>k.t<end);
        track.splice(0,track.length,...keep,{...atEnd,t:end});
      }
      E.tick=Math.min(E.tick,end);
    }
    ev.target.value=E.scene.duration;
    pvRefreshTrack(E);
  });
  on("[data-pv-add-object]","onclick",E=>{
    if (E.scene.objects.length>=24) return pvStatus("一个场景最多包含 24 个物体。");
    pvPause(E);
    const shape=pvElement("[data-pv-add-kind]").value, id="o"+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
    E.scene.objects.push({id,shape,label:PV_SHAPES[shape]+" "+(E.scene.objects.length+1),
      width:shape==="figure" ? .85 : 1,height:shape==="figure" ? 1.8 : 1,depth:shape==="figure" ? .58 : 1,
      keys:[{t:0,x:0,y:0,z:0,yaw:0,ease:"linear"}]});
    E.active=id;
    pvRefreshTrack(E);
  });
  on("[data-pv-delete-object]","onclick",E=>{
    if (!pvActive(E)) return;
    pvPause(E);
    E.scene.objects=E.scene.objects.filter(o=>o.id!==E.active);
    E.active="camera";pvRefreshTrack(E);
  });
  on("[data-pv-name]","onchange",(E,ev)=>{
    const item=pvActive(E);
    if (item) item.label=ev.target.value.trim() || PV_SHAPES[item.shape] || "导入模型";
    pvRefreshTrack(E);
  });
  on("[data-pv-kind]","onchange",(E,ev)=>{
    const item=pvActive(E);if(item)item.shape=ev.target.value;pvFrame(E);
  });
  on("[data-pv-key-add]","onclick",E=>{pvPause(E);pvChangePose(E,{});});
  on("[data-pv-key-delete]","onclick",E=>{
    pvPause(E);
    const track=pvTrack(E),index=track.findIndex(k=>k.t===E.tick);
    if (index>=0 && track.length>1) track.splice(index,1);
    pvRefreshTrack(E);
  });
  on("[data-pv-ease]","onchange",(E,ev)=>{pvPause(E);pvChangePose(E,{ease:ev.target.value});});
  on("[data-pv-add-cut]","onclick",E=>{
    if (pvElement("[data-pv-add-cut]").disabled) return;
    pvPause(E);
    const position=pvElement("[data-pv-cut-source]").value;
    const source=position==="current"?null:E.scene.camera.find(key=>key.t===Number(position));
    const pose=source?Object.fromEntries(PV_PARAMS.camera.map(([field])=>[field,source[field]])):{};
    if (pvChangePose(E,{...pose,ease:"cut"})) pvStatus("已添加硬切，可继续调整切换后的构图。");
  });
  on("[data-pv-motion-mode]","onchange",(E,ev)=>{
    pvElement("[data-pv-motion-amount]").value=ev.target.value.startsWith("orbit")?"45":"1";
    pvRefreshMotion(E);
  });
  for (const selector of ["[data-pv-motion-end]","[data-pv-motion-amount]","[data-pv-motion-target]"]) on(selector,"oninput",pvRefreshMotion);
  on("[data-pv-motion-apply]","onclick",pvApplyMotion);
  on("[data-pv-motion-undo]","onclick",E=>{
    if (pvElement("[data-pv-motion-undo]").disabled) return;
    E.scene.camera=E.motionUndo.previous;
    E.motionUndo=null;
    pvRefreshTrack(E);
    pvStatus("已撤销本次运镜");
  });
  on("[data-pv-route-start]","onclick",pvStartRoute);
  on("[data-pv-route-end]","oninput",pvRefreshRoute);
  on("[data-pv-route-apply]","onclick",pvApplyRoute);
  on("[data-pv-route-pop]","onclick",E=>{
    if (!E.route || E.route.pending) return;
    E.route.points.pop();pvRefreshRoute(E);pvFrame(E);
  });
  on("[data-pv-route-cancel]","onclick",E=>{
    E.route=null;pvRefreshRoute(E);pvFrame(E);pvStatus("");
  });
  on("[data-pv-route-undo]","onclick",E=>{
    if (pvElement("[data-pv-route-undo]").disabled) return;
    const item=E.scene.objects.find(o=>o.id===E.routeUndo.id);
    item.keys=E.routeUndo.previous;
    E.routeUndo=null;pvRefreshTrack(E);pvStatus("已撤销本次走位");
  });
  for (const field of $$("[data-pv-param]",panel)) {
    field.onchange=()=>{
      const E=PV.editor, value=pvNumber(field), key=field.dataset.pvParam;
      if (!E) return;
      pvPause(E);
      if (value==null) {field.blur();pvRefreshFields(E);return;}
      if (field.dataset.owner==="size") {
        const item=pvActive(E);
        if (item) item[key]=value;
        pvFrame(E);
      } else if (!pvChangePose(E,{[key]:value})) pvStatus("这条轨道已达到 32 个关键帧。");
      field.value=value;
    };
  }
}
