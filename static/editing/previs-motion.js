"use strict";

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
