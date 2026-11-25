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
  const lighting=scene?.lighting;
  const usableLight=lighting===undefined || !!lighting && Object.hasOwn(PV_LIGHT_TONES,lighting.tone) &&
    Object.entries(PV_LIGHT_LIMITS).every(([key,[min,max]])=>Number.isFinite(lighting[key]) && lighting[key]>=min && lighting[key]<=max);
  return !!scene && usableLight && Number.isInteger(scene.duration) && scene.duration>=2 && scene.duration<=14 && !!PV_SIZE[scene.aspect] &&
    trackValid(scene.camera,PV_PARAMS.camera) && Array.isArray(scene.objects) && scene.objects.every(o=>
      o && o.id!=="camera" && validShape(o) && PV_PARAMS.size.every(([p])=>Number.isFinite(o[p])) && trackValid(o.keys,PV_PARAMS.object));
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
  pvRefreshShotRanges(E);
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
  pvElement("[data-pv-play]").textContent=OneShotI18n.t("播放");
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
  if (!E || E.sending || E.guideBatch) return !E;
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
  const start=curV(n)?.previs_span?.[0];
  const tick=Number.isInteger(start)?Math.max(0,Math.min(start,scene.duration*PV_FPS)):0;
  const E=PV.editor={n,board:boardId,scene,savedScene:JSON.stringify(scene),active:"camera",tick,view:"camera",sending:false};
  const panel=$("#previsEditor");
  if (panel.showModal) panel.showModal();
  else panel.setAttribute("open","");
  pvElement("[data-pv-duration]").value=scene.duration;
  pvElement("[data-pv-aspect]").value=scene.aspect;
  pvElement("[data-pv-view]").value="camera";
  pvElement("[data-pv-batch-panel]").hidden=true;
  pvElement("[data-pv-shot-range]").selectedIndex=-1;
  pvElement("[data-pv-motion]").open=false;
  pvElement("[data-pv-lighting]").open=false;
  pvElement("[data-pv-motion-mode]").value="push";
  pvElement("[data-pv-motion-end]").value=scene.duration;
  pvElement("[data-pv-motion-amount]").value="1";
  pvElement("[data-pv-heading]").textContent=n.name;
  pvElement("[data-pv-discard]").hidden=true;
  pvElement("[data-pv-import-model]").textContent="导入 3D 模型";
  pvStatus("");
  pvRefreshLighting(E);
  pvRefreshTrack(E);
  pvUpdateRenderState(n);
}

function pvNumber(field) {
  return Number.isFinite(field.valueAsNumber) ? Math.min(Number(field.max),Math.max(Number(field.min),field.valueAsNumber)) : null;
}

function initPrevis() {
  const params=Object.entries(PV_PARAMS).flatMap(([owner,fields])=>fields.map(([key,label])=>{
    const min=owner==="size" ? .1 : key==="fov" ? 18 : key==="yaw" ? -360 : -50;
    const max=owner==="size"?20:key==="fov"?95:key==="yaw"?360:50;
    return `<label>${label}<input type="number" min="${min}" max="${max}" step=".1" data-owner="${owner}" data-pv-param="${key}"></label>`;
  })).join("");
  const lightControls=Object.entries(PV_LIGHT_LIMITS).map(([key,[min,max]])=>
    `<label>${PV_LIGHT_LABELS[key]}<input type="number" min="${min}" max="${max}" step="${max>2?1:.05}" data-pv-light-value="${key}"></label>`).join("");
  document.body.insertAdjacentHTML("beforeend",OneShotI18n.html`<dialog id="previsEditor" aria-labelledby="pvTitle">
    <header class="pv-head"><div><strong id="pvTitle">3D 白模预演</strong><span data-pv-heading></span></div>
      <button type="button" data-pv-render>渲染预演</button><button type="button" data-pv-use hidden>用作动作参考</button>
      <button type="button" data-pv-batch-stop hidden>停止后续渲染</button><button type="button" data-pv-close>保存并关闭</button></header>
    <fieldset><div class="pv-layout">
      <section class="pv-stage"><div class="pv-controls">
        <label>视图<select data-pv-view><option value="camera">机位预览</option><option value="plan">俯视摆位</option><option value="free">自由视图</option></select></label>
        <label>画幅<select data-pv-aspect><option>16:9</option><option>9:16</option><option>1:1</option></select></label>
        <label>时长<input type="number" min="2" max="14" step="1" data-pv-duration> 秒</label>
      </div><canvas aria-label="白模场景预览"></canvas>
      <div class="pv-controls pv-free-controls" data-pv-free-controls hidden>
        <span>拖动或方向键转向，WASD 移动，Q/E 升降</span>
        <button type="button" data-pv-free-reset>回到当前机位</button>
        <button type="button" data-pv-free-capture>截图到画布</button>
        <button type="button" data-pv-free-adopt>设为当前机位</button>
      </div>
      <div class="pv-controls pv-timeline"><button type="button" data-pv-play>播放</button>
        <input type="range" min="0" max="96" step="1" data-pv-scrub aria-label="预演时间轴">
        <output data-pv-time></output></div>
      <div class="pv-controls"><button type="button" data-pv-frame-canvas>机位帧放入画布</button>
        <button type="button" data-pv-frame-download>下载机位帧 PNG</button>
        <button type="button" data-pv-storyboard>按切点创建分镜</button>
        <button type="button" data-pv-batch-open hidden>批量绑定动作</button>
        <button type="button" data-pv-scene-download>导出场景 GLB</button></div>
      <div class="pv-controls pv-shot-controls" data-pv-shot-render-tools hidden>
        <label>镜头<select data-pv-shot-range></select></label><button type="button" data-pv-render-shot>渲染这一镜</button></div>
      <div class="pv-controls pv-shot-controls" data-pv-shot-guide hidden>
        <label>分镜视频<select data-pv-guide-target></select></label><button type="button" data-pv-apply-shot-guide>绑定本镜动作</button></div>
      <section data-pv-batch-panel class="pv-batch-panel" aria-label="批量绑定白模动作" hidden>
        <label>分镜<select data-pv-batch-script></select></label><ol data-pv-batch-rows></ol>
        <div class="pv-controls"><button type="button" data-pv-batch-hide>收起</button>
          <button type="button" data-pv-batch-confirm>确认渲染并绑定</button></div>
      </section>
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
        <details data-pv-lighting>
          <summary>场景灯光</summary>
          <label class="pv-wide">预设<select data-pv-light-preset><option value="off">默认白模</option>
            ${Object.entries(PV_LIGHT_PRESETS).map(([id,preset])=>`<option value="${id}">${preset.label}</option>`).join("")}
            <option value="custom" disabled>自定义</option></select></label>
          <div data-pv-light-fields hidden>
            <div class="pv-fields">${lightControls}</div>
            <label class="pv-wide">色调<select data-pv-light-tone><option value="neutral">中性</option><option value="warm">暖光</option><option value="cool">冷光</option></select></label>
          </div>
        </details>
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
  pvBindCanvas(canvas);
  const on=(selector,key,fn)=>{pvElement(selector)[key]=event=>{const E=PV.editor;if(E&&!E.sending&&!E.guideBatch)fn(E,event);};};
  on("[data-pv-render]","onclick",E=>pvRender(E));
  on("[data-pv-shot-range]","onchange",(E,ev)=>{
    pvPause(E);
    E.tick=JSON.parse(ev.target.value)[0];
    pvRefreshFields(E);pvFrame(E);
  });
  on("[data-pv-render-shot]","onclick",E=>{
    const value=pvElement("[data-pv-shot-range]").value;
    if(value)pvRender(E,JSON.parse(value));
  });
  on("[data-pv-apply-shot-guide]","onclick",pvAttachShotGuide);
  on("[data-pv-batch-open]","onclick",pvPreviewGuideBatch);
  on("[data-pv-batch-script]","onchange",pvPreviewGuideBatch);
  on("[data-pv-batch-hide]","onclick",()=>{pvElement("[data-pv-batch-panel]").hidden=true;});
  on("[data-pv-batch-confirm]","onclick",pvRunGuideBatch);
  pvElement("[data-pv-batch-stop]").onclick=()=>{
    const E=PV.editor;
    if(!E?.guideBatch)return;
    E.guideBatch.stopping=true;
    pvUpdateRenderState(E.n);
    pvStatus("当前镜头将完成，后续镜头停止提交。");
  };
  on("[data-pv-use]","onclick",E=>{if(closePrevis())usePrevisForVideo(E.n);});
  on("[data-pv-close]","onclick",()=>closePrevis());
  on("[data-pv-discard]","onclick",()=>closePrevis(true));
  on("[data-pv-play]","onclick",pvPlayback);
  on("[data-pv-frame-canvas]","onclick",E=>pvExportFrame(E,false));
  on("[data-pv-frame-download]","onclick",E=>pvExportFrame(E,true));
  on("[data-pv-free-reset]","onclick",E=>{pvResetFreeView(E);canvas.focus();});
  on("[data-pv-free-capture]","onclick",E=>pvExportFrame(E,false,true));
  on("[data-pv-free-adopt]","onclick",pvAdoptFreeView);
  on("[data-pv-storyboard]","onclick",pvExportStoryboard);
  on("[data-pv-scene-download]","onclick",pvDownloadScene);
  on("[data-pv-import-model]","onclick",()=>pvElement("[data-pv-model-file]").click());
  on("[data-pv-model-file]","onchange",(E,ev)=>{
    const files=[...ev.target.files];
    ev.target.value="";
    void pvImportModel(E,files);
  });
  on("[data-pv-scrub]","oninput",(E,ev)=>{pvPause(E);E.tick=Number(ev.target.value);pvRefreshFields(E);pvFrame(E);});
  on("[data-pv-track]","onchange",(E,ev)=>{pvPause(E);E.active=ev.target.value;pvRefreshTrack(E);});
  on("[data-pv-view]","onchange",(E,ev)=>{
    E.view=ev.target.value;
    E.look=E.drag=null;
    if(E.view==="free"){
      pvPause(E);
      if(!E.freeView)pvResetFreeView(E);else pvFrame(E);
      canvas.focus();
    }else pvFrame(E);
  });
  on("[data-pv-aspect]","onchange",(E,ev)=>{E.scene.aspect=ev.target.value;pvFrame(E);});
  on("[data-pv-light-preset]","onchange",(E,ev)=>{
    const preset=PV_LIGHT_PRESETS[ev.target.value];
    if(preset)E.scene.lighting={...preset.settings};
    else if(ev.target.value==="off")delete E.scene.lighting;
    pvRefreshLighting(E);pvFrame(E);
  });
  function updateLight(E,key,value) {
    if(E.scene.lighting && value!==null)E.scene.lighting[key]=value;
    pvRefreshLighting(E);pvFrame(E);
  }
  for(const key of Object.keys(PV_LIGHT_LIMITS))on(`[data-pv-light-value="${key}"]`,"onchange",(E,ev)=>
    updateLight(E,key,pvNumber(ev.target)));
  on("[data-pv-light-tone]","onchange",(E,ev)=>updateLight(E,"tone",ev.target.value));
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
