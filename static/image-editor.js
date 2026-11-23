"use strict";
// Image editor uses the canvas's existing versions and job polling. Closing it
// leaves queued jobs attached to the node, so progress survives a page reload.
let IMAGE_EDITOR = null;
const IE_WINDOW = { rect:null, maximized:false, collapsed:false, dock:"" };

function ieFitWindow(rect, viewport={w:innerWidth,h:innerHeight}) {
  const maxW=Math.max(1,viewport.w-16), maxH=Math.max(1,viewport.h-16);
  const finite=(value,fallback)=>Number.isFinite(value) ? value : fallback;
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  const w=clamp(finite(rect?.w,Math.min(1060,maxW-64)),Math.min(720,maxW),maxW);
  const h=clamp(finite(rect?.h,Math.min(720,maxH-64)),Math.min(420,maxH),maxH);
  return {w,h,x:clamp(finite(rect?.x,(viewport.w-w)/2),8,Math.max(8,viewport.w-w-8)),y:clamp(finite(rect?.y,56),8,Math.max(8,viewport.h-h-8))};
}

function ieRememberWindow() {
  try { localStorage.setItem("oneshot.imageEditor.window",JSON.stringify({rect:IE_WINDOW.rect,dock:IE_WINDOW.dock,maximized:IE_WINDOW.maximized})); } catch {}
}

function ieApplyWindow() {
  const host=$("#imageEditor"); if (!host) return;
  if (!IE_WINDOW.collapsed) IE_WINDOW.rect=ieFitWindow(IE_WINDOW.rect);
  let r=IE_WINDOW.rect || (IE_WINDOW.rect=ieFitWindow(null));
  if(IE_WINDOW.dock && !IE_WINDOW.collapsed && !IE_WINDOW.maximized) {
    const w=Math.min(innerWidth-16,Math.max(720,Math.round(innerWidth/2)-12));
    r={x:IE_WINDOW.dock==="left" ? 8 : innerWidth-w-8,y:8,w,h:Math.max(1,innerHeight-16)};
  }
  host.classList.toggle("docked",!!IE_WINDOW.dock); $("#ieDock").value=IE_WINDOW.dock;
  host.classList.toggle("maximized",IE_WINDOW.maximized);
  host.classList.toggle("collapsed",IE_WINDOW.collapsed);
  if (IE_WINDOW.collapsed) {
    const w=Math.min(r.w,560,Math.max(1,innerWidth-16));
    const h=$(".ie-top",host).offsetHeight+($(".ie-statusbar",host).hidden ? 0 : $(".ie-statusbar",host).offsetHeight)+2;
    r.x=Math.max(8,Math.min(innerWidth-w-8,r.x)); r.y=Math.max(8,Math.min(innerHeight-h-8,r.y));
    Object.assign(host.style,{left:r.x+"px",top:r.y+"px",width:w+"px",height:"auto"});
  } else Object.assign(host.style,{left:r.x+"px",top:r.y+"px",width:r.w+"px",height:r.h+"px"});
  $("#ieMaximize").textContent=IE_WINDOW.maximized ? "还原" : "最大化";
  $("#ieMaximize").setAttribute("aria-pressed",String(IE_WINDOW.maximized));
  $("#ieCollapse").textContent=IE_WINDOW.collapsed ? "展开" : "收起";
  $("#ieCollapse").setAttribute("aria-expanded",String(!IE_WINDOW.collapsed));
  $(".ie-layout",host).hidden=IE_WINDOW.collapsed;
  ieDraw();
}

function ieToggleMaximize() {
  IE_WINDOW.maximized=!IE_WINDOW.maximized; IE_WINDOW.dock=""; IE_WINDOW.collapsed=false; ieApplyWindow(); ieRememberWindow();
}

function ieInitWindow(host) {
  try { const saved=JSON.parse(localStorage.getItem("oneshot.imageEditor.window"));IE_WINDOW.rect=ieFitWindow(saved?.rect || saved);IE_WINDOW.dock=["left","right"].includes(saved?.dock) ? saved.dock : "";IE_WINDOW.maximized=!!saved?.maximized; } catch { IE_WINDOW.rect=ieFitWindow(null); }
  $("#ieDock").onchange=e=>{IE_WINDOW.dock=e.target.value;IE_WINDOW.maximized=false;IE_WINDOW.collapsed=false;ieApplyWindow();ieRememberWindow();};
  $("#ieMaximize").onclick=()=>{ieToggleMaximize();ieRememberWindow();};
  $("#ieCollapse").onclick=()=>{ IE_WINDOW.collapsed=!IE_WINDOW.collapsed; ieApplyWindow(); };
  const title=$(".ie-top",host), grip=$("#ieResize"), drag={active:null};
  title.ondblclick=e=>{ if (!e.target.closest("button,select")) ieToggleMaximize(); };
  const start=(e,kind)=>{
    if (e.button!==0 || (kind==="move" && e.target.closest("button,select")) || (IE_WINDOW.maximized && !IE_WINDOW.collapsed)) return;
    e.preventDefault();
    if(IE_WINDOW.dock){const box=host.getBoundingClientRect();IE_WINDOW.dock="";IE_WINDOW.rect=ieFitWindow({x:box.left,y:box.top,w:box.width,h:box.height});}
    drag.active={kind,x:e.clientX,y:e.clientY,rect:{...IE_WINDOW.rect}};
    e.currentTarget.setPointerCapture(e.pointerId); host.classList.add("moving");
  };
  const move=e=>{
    const d=drag.active; if (!d) return;
    const dx=e.clientX-d.x,dy=e.clientY-d.y;
    if (d.kind==="move") IE_WINDOW.rect={...d.rect,x:d.rect.x+dx,y:d.rect.y+dy};
    else IE_WINDOW.rect=ieFitWindow({...d.rect,w:Math.min(innerWidth-d.rect.x-8,d.rect.w+dx),h:Math.min(innerHeight-d.rect.y-8,d.rect.h+dy)});
    ieApplyWindow();
  };
  const end=()=>{ if(drag.active){const kind=drag.active.kind;drag.active=null;host.classList.remove("moving");if(kind==="move" && !IE_WINDOW.collapsed){const r=host.getBoundingClientRect();if(r.left<24)IE_WINDOW.dock="left";else if(r.right>innerWidth-24)IE_WINDOW.dock="right";else if(r.top<24)IE_WINDOW.maximized=true;}ieApplyWindow();ieRememberWindow();} };
  title.onpointerdown=e=>start(e,"move"); grip.onpointerdown=e=>start(e,"resize");
  for (const el of [title,grip]) { el.onpointermove=move; el.onpointerup=el.onpointercancel=el.onlostpointercapture=end; }
  grip.onkeydown=e=>{
    const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];
    if (!delta) return;
    e.preventDefault(); e.stopPropagation(); const step=e.shiftKey ? 50 : 10, r=IE_WINDOW.rect;
    IE_WINDOW.rect=ieFitWindow({...r,w:Math.min(innerWidth-r.x-8,r.w+delta[0]*step),h:Math.min(innerHeight-r.y-8,r.h+delta[1]*step)});
    ieApplyWindow(); ieRememberWindow();
  };
  addEventListener("resize",()=>{ ieApplyWindow(); ieRememberWindow(); });
  ieApplyWindow();
}

function initImageEditor() {
  const host = document.createElement("section");
  host.id = "imageEditor";
  host.setAttribute("role", "dialog"); host.setAttribute("aria-modal", "false"); host.setAttribute("aria-label", "图像编辑浮动窗口");
  host.innerHTML = `<header class="ie-top" title="拖动标题栏移动窗口，双击最大化或还原"><strong>图像编辑</strong><span class="ie-name"></span><span class="ie-meta"></span><span class="ie-spacer"></span>
    <select id="ieDock" aria-label="窗口停靠"><option value="">浮动</option><option value="left">靠左</option><option value="right">靠右</option></select><button id="ieCompare" title="按住查看打开编辑器时的原图">对比原图</button><button id="ieCollapse" aria-expanded="true">收起</button><button id="ieMaximize" aria-pressed="false">最大化</button><button id="ieClose" aria-label="关闭图像编辑窗口" title="关闭窗口，生成任务会继续">关闭</button></header>
    <div class="ie-statusbar" hidden><div class="ie-status" role="status" aria-live="polite"><span id="ieStatusText"></span>
      <div id="ieProgress" class="ie-progress" role="progressbar" aria-label="图像编辑进度" aria-valuemin="0" aria-valuemax="100" hidden><i></i></div></div>
      <button id="ieCancel" hidden>取消生成</button></div>
    <div class="ie-layout"><div class="ie-main">${ewToolbarHTML()}<div class="ie-stage"><canvas class="ie-canvas" aria-label="图片编辑画布"></canvas><span id="ieBrushCursor" hidden></span><span class="ie-stage-note"></span></div><div class="ie-history-actions"><span id="ieDraftState">草稿自动保存</span><span class="ie-spacer"></span><button id="ieReuse">复用参数</button><button id="ieRetry" hidden>重新生成</button></div><div class="ie-history" aria-label="历史版本"></div></div>
    <aside class="ie-side"><div class="ie-group-title">编辑方式</div><div class="ie-tabs"><button data-mode="region" class="on">局部重绘</button><button data-mode="whole">整图编辑</button><button data-mode="outpaint">智能扩图</button><button data-mode="local">裁剪 / 调色</button><button data-mode="relight">布光</button><button data-mode="camera">换机位</button><button data-mode="layers">图层 / 抠图</button></div>
    <div class="ie-section on" data-section="region"><div class="ie-row"><button data-tool="brush" class="on">画笔</button><button data-tool="rect">矩形</button><button data-tool="erase">擦除</button><button data-tool="smart" title="点击选中物体，Shift 点击排除">智能选物</button></div>
      <label class="ie-label" for="ieBrush">画笔大小 <output id="ieBrushValue">64 px</output></label><input id="ieBrush" type="range" min="4" max="512" value="64">
      <div class="ie-row"><button id="ieUndoMask">撤销</button><button id="ieRedoMask">重做</button><button id="ieClearMask">清空</button><button id="ieInvertMask">反选</button></div>
      <label class="ie-label" for="ieFeather">边缘羽化 <output id="ieFeatherValue">8 px</output></label><input id="ieFeather" type="range" min="0" max="64" value="8">
      <div class="ie-row"><button id="ieCutSelection">选区转透明图层</button></div><p class="ie-note">粉色区域会被修改，选区外像素保持原样。可用于替换物体、修改服装或修复细节。</p></div>
    <div class="ie-section" data-section="outpaint"><p class="ie-note">向四周延伸画面，原图区域保持原样。边距单位：像素。</p><div class="ie-padding">
      <label>左<input id="iePadLeft" type="number" min="0" max="2048" step="32" value="128"></label><label>右<input id="iePadRight" type="number" min="0" max="2048" step="32" value="128"></label>
      <label>上<input id="iePadTop" type="number" min="0" max="2048" step="32" value="0"></label><label>下<input id="iePadBottom" type="number" min="0" max="2048" step="32" value="0"></label></div></div>
    <div class="ie-section" data-section="whole"><p class="ie-note">用文字修改整张图片，例如改变画风、光线或场景。每次生成都会保存为新版本。</p></div>
    <div class="ie-section" data-section="local"><p class="ie-note">在图片上拖出裁剪矩形；不画选区则保留完整画面。旋转、翻转会直接保存为新版本。</p>
      <div class="ie-row"><button data-rotate="-90" title="向左旋转 90 度">左转 90°</button><button data-rotate="90" title="向右旋转 90 度">右转 90°</button></div>
      <div class="ie-row"><button data-flip="flip_x">水平翻转</button><button data-flip="flip_y">垂直翻转</button></div>
      ${[["Brightness", "亮度"], ["Contrast", "对比度"], ["Saturation", "饱和度"]].map(([k,t])=>`<label class="ie-label" for="ie${k}">${t}<output id="ie${k}Value">100%</output></label><input id="ie${k}" type="range" min="0" max="200" value="100">`).join("")}
      <div class="ie-row"><button id="ieResetLocal">重置调整</button></div><button id="ieSaveLocal" class="ie-primary">保存为新版本</button>${pixelSizeHTML()}</div>
    ${relightHTML()}${imageCameraHTML()}${ewLayersHTML()}<div id="ieAI"><div class="ie-group-title">生成设置</div><label class="ie-label" for="iePrompt">修改要求</label><textarea id="iePrompt" maxlength="8000" placeholder="例如：把选中的衣服改为深蓝色，保留布料质感和光影"></textarea>
      <div class="ie-row" id="iePresets"><button data-preset="移除选中的物体，用自然连贯的背景填补，匹配周围纹理和光线">移除物体</button><button data-preset="修复选中区域的模糊与瑕疵，恢复自然清晰的纹理和细节">修复细节</button></div>
      <div id="ieBlend"><label class="ie-label" for="ieStrength">结果融合比例 <output id="ieStrengthValue">100%</output></label><input id="ieStrength" type="range" min="1" max="100" value="100"><p class="ie-note">控制生成结果与原图的混合比例。</p></div>
      <label class="ie-label" for="ieBackend">编辑引擎</label><select id="ieBackend"><option value="h3">参考图编辑（H3 / 第三方）</option><option value="native">原生遮罩重绘（SD）</option></select><div id="ieNativeSettings" hidden><label class="ie-label" for="ieDenoise">重绘强度<output id="ieDenoiseValue">95%</output></label><input id="ieDenoise" type="range" min="10" max="100" value="95"><label class="ie-label" for="ieSteps">采样步数</label><input id="ieSteps" type="number" min="10" max="50" value="25"></div><label class="ie-label" for="ieSeed">随机种子（−1 为随机）</label><input id="ieSeed" type="number" min="-1" step="1" value="-1"><label class="ie-label" for="ieProvider">图像服务</label><select id="ieProvider"></select><button id="ieGenerate" class="ie-primary">生成新版本</button></div></aside></div>
      <button id="ieResize" class="ie-resize" aria-label="调整窗口大小" title="拖动调整大小，也可用方向键微调"></button>`;
  document.body.append(host);
  $("#ieClose").onclick = closeImageEditor;
  $$("[data-mode]", host).forEach(b => b.onclick = () => ieMode(b.dataset.mode));
  $$("[data-tool]", host).forEach(b => b.onclick = () => { if (!IMAGE_EDITOR) return; IMAGE_EDITOR.tool = b.dataset.tool; $$("[data-tool]", host).forEach(x=>x.classList.toggle("on", x===b)); });
  for (const [key, unit] of [["Brush", " px"], ["Feather", " px"], ["Strength", "%"], ["Brightness", "%"], ["Contrast", "%"], ["Saturation", "%"]]) {
    $("#ie"+key).oninput = e => { $("#ie"+key+"Value").textContent = e.target.value + unit; ieDraw(); };
  }
  for (const key of ["Left", "Right", "Top", "Bottom"]) $("#iePad"+key).oninput = ieDraw;
  $("#ieUndoMask").onclick = () => { if (!IMAGE_EDITOR?.busy) { IMAGE_EDITOR?.strokes.pop(); ieRebuildMask(); } };
  $("#ieClearMask").onclick = () => { if (!IMAGE_EDITOR?.busy) { IMAGE_EDITOR.strokes=[]; ieRebuildMask(); } };
  $("#ieInvertMask").onclick = () => { if (IMAGE_EDITOR && !IMAGE_EDITOR.busy) { IMAGE_EDITOR.strokes.push({tool:"invert"}); ieRebuildMask(); } };
  $("#ieResetLocal").onclick = ieResetLocal;
  $$("[data-rotate]", host).forEach(b=>b.onclick=()=>ieLocal({rotate:+b.dataset.rotate}));
  $$("[data-flip]", host).forEach(b=>b.onclick=()=>ieLocal({[b.dataset.flip]:true}));
  $$("[data-preset]", host).forEach(b=>b.onclick=()=>$("#iePrompt").value=b.dataset.preset);
  $("#ieSaveLocal").onclick = () => ieLocal();
  $("#ieGenerate").onclick = ieGenerate;
  $("#ieCancel").onclick = () => IMAGE_EDITOR && cancel(IMAGE_EDITOR.n);
  const compare = on => { if (IMAGE_EDITOR) { IMAGE_EDITOR.compare=on; ieDraw(); } };
  $("#ieCompare").onpointerdown = e => { e.currentTarget.setPointerCapture(e.pointerId); compare(true); };
  $("#ieCompare").onpointerup = $("#ieCompare").onpointercancel = () => compare(false);
  $("#ieCompare").onkeydown = e => { if ([" ","Enter"].includes(e.key)) { e.preventDefault(); compare(true); } };
  $("#ieCompare").onkeyup = $("#ieCompare").onblur = () => compare(false);
  const canvas = $(".ie-canvas", host);
  canvas.onpointerdown = e => iePointer(e, "down");
  canvas.onpointermove = e => iePointer(e, "move");
  canvas.onpointerup = e => iePointer(e, "up");
  canvas.onpointercancel = () => { if (IMAGE_EDITOR) { IMAGE_EDITOR.drawing=null; IMAGE_EDITOR.movingLight=false; ieRebuildMask(); } };
  host.addEventListener("keydown", e => {
    if (ewKey(e)) { e.stopPropagation(); return; }
    if (e.key === "Escape") { e.preventDefault(); closeImageEditor(); }
    e.stopPropagation();
  });
  host.addEventListener("paste", e=>e.stopPropagation());
  ieInitWindow(host);
  ewInitEditor(host);
  initRelightControls();
  initImageCamera();
  initPixelSize();
  new ResizeObserver(ieDraw).observe($(".ie-stage", host));
  setInterval(ieSync, 600);
}

async function openImageEditor(n) {
  const v = curV(n); if (!v || n.type!=="image") return toast("先选择一张图片");
  if (IMAGE_EDITOR?.busy) return ieStatus("正在提交或保存，完成后即可切换图片");
  if (IMAGE_EDITOR?.n===n) { IE_WINDOW.collapsed=false; ieApplyWindow(); ieSync(); $("#ieClose").focus(); return; }
  if (IMAGE_EDITOR) { ewScheduleDraft(true); ewFlushDraft(IMAGE_EDITOR); }
  closeMenus();
  IMAGE_EDITOR = {n, mode:"region", tool:"brush", strokes:[], crop:null, image:null, original:null, ref:null, loading:null, busy:false, drawing:null, compare:false, ...ewNewState(n)};
  $("#imageEditor").classList.add("on");
  IE_WINDOW.collapsed=false; ieApplyWindow();
  $(".ie-name", $("#imageEditor")).textContent = n.name;
  $("#iePrompt").value="";
  $("#ieProvider").innerHTML = `<option value="">平台默认图像服务</option>` + (CAPS_LIST.image || []).map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  $("#ieProvider").value = n.data.provider || "";
  ieStatus(""); ieResetLocal(); ieMode("region"); ieHistory();
  ewCapabilities(IMAGE_EDITOR);
  await ieLoad(v, true);
  $("#ieClose").focus();
}

function closeImageEditor(restoreSelection=true) {
  const E=IMAGE_EDITOR; if (!E) return;
  if (E.busy) return ieStatus("正在提交或保存，完成后即可返回画布");
  ewScheduleDraft(true); ewFlushDraft(E);
  ieRememberWindow();
  if(typeof aeUnlockEditor==="function")aeUnlockEditor(E);
  $("#imageEditor").classList.remove("on"); IMAGE_EDITOR=null;
  if (restoreSelection && node(E.n.id)===E.n) selectOnly(E.n.id);
  document.activeElement?.closest("#imageEditor") && document.activeElement.blur();
}

function ieStatus(message, error=false, progress=null) {
  const host=$("#imageEditor"), bar=$(".ie-statusbar",host), track=$("#ieProgress");
  $("#ieStatusText").textContent=message;
  bar.hidden=!message; bar.classList.toggle("error",error);
  const working=!!(IMAGE_EDITOR?.n.job || IMAGE_EDITOR?.busy);
  track.hidden=!working || error;
  track.classList.toggle("indeterminate",progress===null);
  if (progress===null) { track.removeAttribute("aria-valuenow"); $("i",track).style.width=""; }
  else {
    const pct=Math.max(0,Math.min(100,progress));
    track.setAttribute("aria-valuenow",String(pct)); $("i",track).style.width=pct+"%";
  }
  if (IE_WINDOW.collapsed) ieApplyWindow();
}

async function ieLoad(v, original=false) {
  const E=IMAGE_EDITOR; if (!E) return;
  if(E.loading===v.ref) return E.loadPromise;
  ewScheduleDraft(true);
  const token={}; E.loadToken=token; E.loading=v.ref; E.image=null; ieDraw();
  E.loadPromise=(async()=>{
    await ewFlushDraft(E);
    const im=await new Promise((resolve,reject)=>{ const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error("图片加载失败，请重新打开图片"));image.src=v.url; });
    if(IMAGE_EDITOR!==E || E.loadToken!==token) return;
    if(im.naturalWidth>8192 || im.naturalHeight>8192 || im.naturalWidth*im.naturalHeight>32*1024*1024) throw new Error("图片超过编辑上限：边长 8192 像素 / 3200 万像素");
    E.image=im; E.ref=v.ref; if(original) E.original=im;
    E.mask=document.createElement("canvas");E.mask.width=im.naturalWidth;E.mask.height=im.naturalHeight;
    E.strokes=[];E.crop=null;E.drawing=null;ieResetLocal();ewResetImage(E);
    await ewRestoreDraft(E); if(IMAGE_EDITOR!==E || E.loadToken!==token) return;
    ieRebuildMask();ieHistory();
  })().catch(err=>{if(IMAGE_EDITOR===E && E.loadToken===token){E.failedRef=v.ref;ieStatus(err.message,true);}}).finally(()=>{
    if(E.loadToken!==token)return;
    E.loading=null;
    if(IMAGE_EDITOR===E && typeof aeEditorControls==="function")aeEditorControls();
  });
  return E.loadPromise;
}

function ieMode(mode, force=false) {
  const E=IMAGE_EDITOR; if (!E || (E.busy && !force)) return;
  if(E.agentSelection&&mode!=="region")return ieStatus("请先发送当前选区，或收起窗口后在聊天中停止本轮任务");
  E.mode=mode; E.drawing=null; E.movingLight=false;
  const modelLight=mode==="relight_ai", section=modelLight?"relight":mode;
  $$("[data-mode]",$("#imageEditor")).forEach(b=>b.classList.toggle("on",b.dataset.mode===section));
  $$("[data-section]",$("#imageEditor")).forEach(b=>b.classList.toggle("on",b.dataset.section===section));
  const camera=mode==="camera", structured=camera||modelLight;
  $("#ieSaveLight").hidden=modelLight;
  $("#ieRelightAI").textContent=modelLight?"返回手动布光":"交给模型重打光";
  $("#ieAI").hidden=["local","layers","relight"].includes(mode); $("#ieBlend").hidden=mode==="outpaint"||structured;
  $("#iePresets").hidden=$("#ieBackend").hidden=$('label[for="ieBackend"]').hidden=structured;
  $('label[for="iePrompt"]').textContent = structured ? "补充要求（可选）" : "修改要求";
  $("#iePrompt").placeholder=modelLight?"例如：保留眼睛里的高光":camera?"例如：保持原来的灯光方向":
    "例如：把选中的衣服改为深蓝色，保留布料质感和光影";
  ewBackend();
  if(typeof aeEditorControls==="function")aeEditorControls();
  ieDraw();
}

function ieResetLocal() {
  if (IMAGE_EDITOR) IMAGE_EDITOR.crop=null;
  for (const k of ["Brightness","Contrast","Saturation"]) { $("#ie"+k).value=100; $("#ie"+k+"Value").textContent="100%"; }
  ieDraw();
}

function iePadding() { return Object.fromEntries(["left","right","top","bottom"].map(k=>[k, Math.max(0,Math.min(2048,+$("#iePad"+k[0].toUpperCase()+k.slice(1)).value||0))])); }

function ieDraw() { ewDrawEditor(); }

function ieRect(points) {
  const a=points[0],b=points[points.length-1];
  return {x:Math.floor(Math.min(a.x,b.x)),y:Math.floor(Math.min(a.y,b.y)),w:Math.max(1,Math.floor(Math.abs(a.x-b.x))),h:Math.max(1,Math.floor(Math.abs(a.y-b.y)))};
}

function iePaint(stroke, segmentOnly=false) {
  const E=IMAGE_EDITOR; if (!E?.mask) return;
  const c=E.mask.getContext("2d"), pts=stroke.points;
  c.save();
  if (stroke.tool==="clear") c.clearRect(0,0,E.mask.width,E.mask.height);
  else if (stroke.tool==="mask") {
    const im=E.assets.get(stroke.ref);
    if(im instanceof HTMLImageElement) {
      if(stroke.replace) c.clearRect(0,0,E.mask.width,E.mask.height);
      if(stroke.luminance) {
        E.maskAssets ||= new Map();let converted=E.maskAssets.get(stroke.ref);
        if(!converted){converted=document.createElement("canvas");converted.width=im.naturalWidth;converted.height=im.naturalHeight;const tc=converted.getContext("2d");tc.drawImage(im,0,0);const data=tc.getImageData(0,0,converted.width,converted.height);for(let i=0;i<data.data.length;i+=4){const a=Math.round(.299*data.data[i]+.587*data.data[i+1]+.114*data.data[i+2]);data.data[i]=data.data[i+1]=data.data[i+2]=255;data.data[i+3]=a;}tc.putImageData(data,0,0);E.maskAssets.set(stroke.ref,converted);}
        c.drawImage(converted,0,0);
      } else c.drawImage(im,0,0);
    }
  }
  else if (stroke.tool==="invert") { c.globalCompositeOperation="xor"; c.fillStyle="white"; c.fillRect(0,0,E.mask.width,E.mask.height); }
  else if (stroke.tool==="rect") { const r=ieRect(pts); c.fillStyle="white"; c.fillRect(r.x,r.y,r.w,r.h); }
  else {
    c.globalCompositeOperation=stroke.tool==="erase" ? "destination-out" : "source-over";
    c.strokeStyle=c.fillStyle="white"; c.lineWidth=stroke.width; c.lineCap=c.lineJoin="round";
    const start=segmentOnly ? Math.max(0,pts.length-2) : 0;
    c.beginPath(); c.moveTo(pts[start].x,pts[start].y); for (let i=start+1;i<pts.length;i++) c.lineTo(pts[i].x,pts[i].y); c.stroke();
    if (pts.length===1) { c.beginPath(); c.arc(pts[0].x,pts[0].y,stroke.width/2,0,Math.PI*2); c.fill(); }
  }
  c.restore();
}

function ieRebuildMask() {
  const E=IMAGE_EDITOR; if (!E?.mask) return;
  E.mask.getContext("2d").clearRect(0,0,E.mask.width,E.mask.height);
  E.strokes.forEach(s=>iePaint(s)); ieDraw();
}

function iePointer(e, phase) { ewPointer(e,phase); }

function ieHistory() {
  const E=IMAGE_EDITOR; if (!E) return;
  ewUpdateHistoryActions();
  const box=$(".ie-history",$("#imageEditor"));
  box.innerHTML=E.n.versions.map((v,i)=>`<button data-version="${i}" class="${i===E.n.cur ? "on" : ""}" title="${esc(v.mode || v.prompt || "原始图片")}"><img src="${esc(v.url)}" loading="lazy" alt="版本 ${i+1}"><small>${i+1} · ${esc(v.mode || (v.source==="upload" ? "原图" : "图片"))}</small></button>`).join("");
  $$("button",box).forEach(b=>b.onclick=()=>{ if (E.busy || E.n.job || E.agentSelection) return; if (!switchVersion(E.n,+b.dataset.version)) return; E.agentPinnedRef=null; ieLoad(curV(E.n)); ieHistory(); });
}

async function ieLocal(extra={}) {
  const E=IMAGE_EDITOR; if (!E?.image || E.busy || E.n.job || E.agentSelection || !canvasCanEdit()) return;
  const board=B, source=E.ref;
  E.busy=true; ieSync(); ieStatus("正在保存新版本…");
  try {
    const ref=await ewFlatten(E);
    const stillCurrent=()=>B===board && node(E.n.id)===E.n && curV(E.n)?.ref===source && canvasCanEdit();
    if (extra.resize && !stillCurrent()) throw new Error("来源图片已更新，请重新选择版本");
    const p={ref,crop:E.crop,brightness:+$("#ieBrightness").value/100,contrast:+$("#ieContrast").value/100,saturation:+$("#ieSaturation").value/100,...extra};
    const result=await api("/api/image-edit/transform",p);
    if (extra.resize && !stillCurrent()) throw new Error("来源图片已更新，请重新选择版本");
    const edit={source,mode:"local",...(extra.resize ? {resize:result.resize || extra.resize} : {})};
    const label=extra.resize ? "调整像素尺寸" : extra.rotate ? "旋转" : extra.flip_x || extra.flip_y ? "翻转" : E.crop ? "裁剪 / 调色" : "调色";
    addVersion(E.n,mediaVersion(result,{source:"edit",mode:label,edit}));
    if (IMAGE_EDITOR===E) { ieLoad(curV(E.n)); ieHistory(); ieStatus("已保存为新版本，可在下方切回历史版本"); }
    loadAssets();
  } catch(e) { ieStatus(e.message,true); }
  finally { E.busy=false; ieSync(); }
}

async function ieGenerate() {
  const E=IMAGE_EDITOR; if (!E?.image || E.busy || E.n.job || E.agentSelection || !canvasCanEdit()) return;
  const camera=E.mode==="camera", modelLight=E.mode==="relight_ai", structured=camera||modelLight;
  const prompt=$("#iePrompt").value.trim(); if (!prompt && !structured) return ieStatus("请填写修改要求",true);
  if (E.mode==="region" && !E.strokes.length) return ieStatus("请先选择要修改的区域",true);
  const board=B, sourceRef=E.ref;
  E.busy=true; ieSync(); ieStatus("正在提交编辑任务…");
  try {
    const ref=await ewFlatten(E);
    if (structured && (B!==board || node(E.n.id)!==E.n || curV(E.n)?.ref!==sourceRef || !canvasCanEdit()))
      throw new Error("图片版本或编辑权限已变更，请重新打开编辑器");
    const p={ref,mode:E.mode,prompt,backend:$("#ieBackend").value,denoise:+$("#ieDenoise").value/100,steps:+$("#ieSteps").value,seed:+$("#ieSeed").value,strength:+$("#ieStrength").value/100,feather:+$("#ieFeather").value,padding:iePadding(),provider:$("#ieProvider").value,board:boardId,label:E.n.name+" · 图像编辑"};
    if (camera) Object.assign(p,{mode:"whole",backend:"h3",strength:1,camera_view:imageCameraSettings(),
      count:+$("#ieCamCount").value,quality:E.n.data.quality || "4mp",label:E.n.name+" · 换机位"});
    if (modelLight) Object.assign(p,{mode:"whole",backend:"h3",strength:1,relight:relightSettings(),
      quality:E.n.data.quality || "4mp",label:E.n.name+" · 重新布光"});
    if (E.mode==="region") p.mask=(await ewExportMask(E)).ref;
    E.n.data.lastImageEdit={...p}; save(); ewScheduleDraft(true);
    const r=await api("/api/image-edit/generate",p);
    if (structured && (B!==board || node(E.n.id)!==E.n)) return;
    E.n.data.lastImageEdit.seed=r.meta?.seed ?? p.seed;
    const description= camera?imageCameraPrompt(p.camera_view)+(prompt?"。"+prompt:""):prompt;
    E.n.job={ids:r.ids,prompt:description||(modelLight?"重新布光":""),t0:Date.now(),st:{}}; save(); render(E.n); showPanel(); poll();
    if (IMAGE_EDITOR===E) ieStatus("已排队，可返回画布继续工作；完成后会保存为新版本");
  } catch(e) { ieStatus(e.message,true); }
  finally { E.busy=false; ieSync(); }
}

function ieSync() {
  const E=IMAGE_EDITOR; if (!E) return;
  if (node(E.n.id)!==E.n && !E.busy) { closeImageEditor(false); return; }
  const busy=E.busy || E.restoring || !!E.n.job || !E.image || !!E.agentSelection;
  if(typeof aeEditorControls==="function")aeEditorControls();
  for (const id of ["ieGenerate","ieSaveLocal"]) $("#"+id).disabled=busy || !!E.agentSelection;
  for (const id of [...relightInputIds,"ieSaveLight","ieResetLight","ieRelightAI"]) $("#"+id).disabled=busy || !canvasCanEdit();
  for (const id of imageCameraDraftIds) $("#"+id).disabled=busy || !canvasCanEdit();
  if(E.image)updatePixelPreview(E);
  $$("[data-camera-preset]").forEach(button=>button.disabled=busy || !canvasCanEdit());
  $$("[data-rotate], [data-flip]",$("#imageEditor")).forEach(b=>b.disabled=busy);
  $("#ieCancel").hidden=!E.n.job;
  if(typeof aeEditorControls==="function")aeEditorControls();
  if (E.n.job && !E.busy) {
    E.hadJob=true;
    const states=Object.values(E.n.job.st || {}), running=states.find(x=>x.state==="running");
    const pct=running?.max>1 && running.value!=null && Number.isFinite(+running.value) ? Math.max(0,Math.min(99,Math.round(running.value/running.max*100))) : null;
    const phase=running?.phase || (pct===100 ? "decoding" : "sampling");
    const stage=EW_PHASES[phase] || "处理图像";
    const elapsed=running?.elapsed!=null ? ` · 已用 ${Math.round(running.elapsed)} 秒` : "";
    ieStatus(running ? stage+(phase==="sampling" && pct!==null ? " · "+pct+"%" : "…")+elapsed : "排队中"+(states[0]?.ahead>0 ? ` · 前面还有 ${states[0].ahead} 个任务` : "")+"，可继续操作画布",false,phase==="sampling" ? Math.min(99,pct ?? 0) : null);
  } else if (E.hadJob && !E.busy) {
    E.hadJob=false;
    const err=$(".errbox",els.get(E.n.id))?.textContent;
    ieStatus(err || "已生成新版本，可在下方对比与切换",!!err);
  }
  $("#ieProgress").hidden=(!E.busy && !E.n.job) || $(".ie-statusbar",$("#imageEditor")).classList.contains("error");
  ewUpdateHistoryActions();
  if(typeof aeEditorControls==="function")aeEditorControls();
  const v=E.agentPinnedRef ? E.n.versions.find(v=>v.ref===E.agentPinnedRef) : curV(E.n); if (v && v.ref!==E.ref && E.loading!==v.ref && E.failedRef!==v.ref) ieLoad(v);
}
