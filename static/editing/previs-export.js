"use strict";

function pvUpdateRenderState(n) {
  const E=PV.editor;
  if (!E || E.n!==n) return;
  const submit=pvElement("[data-pv-render]");
  const busy=E.sending || !!E.guideBatch;
  submit.disabled=busy || !!n.job;
  submit.textContent=n.job?"渲染中…":"渲染预演";
  const use=pvElement("[data-pv-use]");
  const version=curV(n);
  use.hidden=version?.source!=="previs";
  use.disabled=busy || !pvGuideAvailable(version);
  use.title=use.disabled && !busy?"动作参考至少需要 2 秒":"";
  pvElement("[data-pv-render-shot]").disabled=submit.disabled;
  pvRefreshShotGuide(E,version);
  pvElement("[data-pv-batch-open]").hidden=!pvGuideScripts(E).length;
  pvElement("[data-pv-batch-open]").disabled=submit.disabled;
  const stop=pvElement("[data-pv-batch-stop]");
  stop.hidden=!E.guideBatch;
  stop.disabled=!!E.guideBatch?.stopping;
  pvElement("[data-pv-close]").disabled=busy;
  pvElement("fieldset").disabled=busy;
}

function pvFinished(n, error) {
  if (PV.editor?.n !== n) return;
  pvUpdateRenderState(n);
  if(PV.editor.guideBatch)return;
  const version=curV(n), span=version?.previs_span;
  pvStatus(error || (span ? `镜头 ${pvSpanLabel(span)} 已加入此节点的版本。${pvGuideAvailable(version)?"":"素材短于 2 秒，可用于剪辑。"}` : "预演视频已加入此节点。"));
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
    pvRefreshLighting(E);
    pvRefreshTrack(E);
  }
  pvElement("[data-pv-heading]").textContent=E.n.name;
  pvUpdateRenderState(E.n);
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

async function pvExportFrame(E, download, free=false) {
  if (!pvValidNode(E) || E.sending || free && (E.view!=="free" || !E.freeView)) return;
  pvPause(E);
  if (!download && !pvCommit(E)) return;
  const tick=E.tick, time=pvTime(tick), board=B, savedScene=E.savedScene;
  const [w,h]=PV_SIZE[E.scene.aspect];
  E.sending=true;
  pvUpdateRenderState(E.n);
  pvStatus(download ? "正在导出 PNG…" : "正在将当前帧放入画布…");
  try {
    const blob=await pvFramePng(free?pvFreeScene(E):E.scene,tick);
    const name=E.n.name+(free?" · 自由视图 · ":" · ")+time;
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
    const version=mediaVersion({...asset,w,h},{source:"previs-frame",mode:free?"白模自由视图":"白模机位截帧"});
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

async function pvFramePng(scene,tick) {
  const frame=document.createElement("canvas");
  [frame.width,frame.height]=PV_SIZE[scene.aspect];
  pvPaint(frame,scene,tick);
  const blob=await new Promise(resolve=>frame.toBlob(resolve,"image/png"));
  if (!blob) throw new Error("无法导出机位帧");
  return blob;
}

async function pvExportStoryboard(E) {
  if (!pvValidNode(E) || E.sending) return;
  pvPause(E);
  if (!pvCommit(E)) return;
  const scene=structuredClone(E.scene), board=B, savedScene=E.savedScene;
  const [w,h]=PV_SIZE[scene.aspect], boundaries=pvStoryboardBoundaries(scene);
  const count=boundaries.length-1;
  if (E.storyboardDraft?.scene!==savedScene) E.storyboardDraft={scene:savedScene,shots:[]};
  const {shots}=E.storyboardDraft;
  const current=()=>PV.editor===E && B===board && pvValidNode(E) && JSON.stringify(E.n.data.previs)===savedScene;
  E.sending=true;
  pvUpdateRenderState(E.n);
  try {
    for (let i=shots.length;i<count;i++) {
      pvStatus(`正在准备镜头首帧 ${i+1}/${count}…`);
      const start=boundaries[i], end=boundaries[i+1];
      const blob=await pvFramePng(scene,start);
      if (!current()) throw new Error("画布或白模场景已更新，请重新打开场景后再创建分镜");
      const {ref}=await ewUpload(blob,`白模镜头-${String(i+1).padStart(2,"0")}.png`);
      if (!current()) throw new Error("画布或白模场景已更新，请重新打开场景后再创建分镜");
      if (!ref) throw new Error("机位帧上传失败");
      shots.push({duration:(end-start)/PV_FPS,frame:{ref,w,h,source:"previs-frame"},previs_range:[start,end],
        shot_size:"",camera:"",scene:"",keyframe:"",characters:[],action:[],dialogue:[],sound:""});
    }
    const title=E.n.name+" · 分镜";
    const data={title,aspect:scene.aspect,shots,previs_source:E.n.id};
    const scriptSize=size({type:"script",data});
    const imageSize=size({type:"image",data,versions:[],cur:-1});
    const videoSize=size({type:"video",data,versions:[],cur:-1});
    const area={w:scriptSize.w+140+count*(Math.max(imageSize.w,videoSize.w)+80)-80,
      h:Math.max(scriptSize.h,Math.max(imageSize.h,300)+110+videoSize.h)};
    const at=freeSpot(E.n.x+size(E.n).w+110,E.n.y,"script",area);
    checkpoint();
    const script=addNode("script",at.x,at.y,data,{name:title});
    expandScript(script,null,{recordUndo:false});
    E.storyboardDraft=null;
    loadAssets();
    if (PV.editor===E) pvStatus(`已创建 ${count} 镜，关闭预演即可查看分镜和首帧`);
  } catch(error) {
    if (PV.editor===E) pvStatus(error.message);
  } finally {
    E.sending=false;
    pvUpdateRenderState(E.n);
  }
}

async function pvRender(E,span=null) {
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
    const key=JSON.stringify([E.board,E.n.id,E.n.data.previs,span]);
    let attempt=PV.attempts.get(key);
    if (!attempt) {
      attempt=crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), b=>b.toString(16).padStart(2,"0")).join("");
      PV.attempts.set(key,attempt);
    }
    const result=await api("/api/previs/render",{board:E.board,node:E.n.id,revision:B.rev,request_key:attempt,...(span?{span}:{})});
    if (!pvValidNode(E)) return;
    PV.attempts.delete(key);
    E.n.job={ids:result.ids,prompt:"",source:"previs",t0:Date.now(),st:{},history:{
      previs_recipe:scene,node_data:structuredClone(E.n.data),input_edges:[],...(span?{previs_span:span}:{}),
    }};
    save(); render(E.n); poll();
    pvStatus("已提交渲染，完成后会加入此节点的版本列表。");
    return E.n.job;
  } catch(error) {
    pvStatus(error.message);
  } finally {
    E.sending=false;
    pvUpdateRenderState(E.n);
  }
}
