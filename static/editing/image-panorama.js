"use strict";

document.getElementById("mediaToolDialogs").insertAdjacentHTML("beforebegin", OneShotI18n.html`
<dialog id="imagePanorama" aria-labelledby="imagePanoramaTitle">
  <header><strong id="imagePanoramaTitle">360° 全景预览</strong><span data-panorama-name></span>
    <button type="button" data-panorama-close aria-label="关闭全景">×</button></header>
  <canvas tabindex="0" aria-label="全景视图"></canvas>
  <footer><span role="status"></span>
    <label>画幅 <select data-panorama-aspect><option>16:9</option><option>9:16</option><option>1:1</option></select></label>
    <button type="button" data-panorama-reset>重置视角</button>
    <button type="button" data-panorama-capture>视角放入画布</button></footer>
</dialog>
`);

const panoramaSizes={"16:9":[960,540],"9:16":[540,960],"1:1":[768,768]};
const panoramaVersion=v=>!!(v?.ref&&v.url&&Math.abs(v.w/v.h-2)<.03);
let panorama=null,panoramaPipeline=null;

function panoramaGraphics(canvas) {
  const gl=canvas.getContext("webgl",{alpha:false,preserveDrawingBuffer:true});
  if (!gl) throw new Error("此浏览器暂时无法打开 WebGL 全景预览");
  const program=gl.createProgram();
  const vertex=`attribute vec2 point; varying vec2 pixel;
    void main(){pixel=point;gl_Position=vec4(point,0.0,1.0);}`;
  const fragment=`precision mediump float;
    uniform sampler2D photo;
    uniform vec3 forward,right,up;
    uniform vec2 framing;
    varying vec2 pixel;
    void main(){
      vec3 ray=normalize(forward+pixel.x*framing.x*right+pixel.y*framing.y*up);
      float lon=atan(ray.x,ray.z);
      float lat=asin(clamp(ray.y,-1.0,1.0));
      vec2 uv=vec2(fract(0.5+lon/6.28318530718),0.5-lat/3.14159265359);
      gl_FragColor=texture2D(photo,uv);
    }`;
  try {
    for (const [kind,source] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]) {
      const shader=gl.createShader(kind);
      gl.shaderSource(shader,source);
      gl.compileShader(shader);
      const valid=gl.getShaderParameter(shader,gl.COMPILE_STATUS);
      if (valid) gl.attachShader(program,shader);
      gl.deleteShader(shader);
      if (!valid) throw new Error("全景预览初始化失败");
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error("全景预览初始化失败");
  } catch(error) {
    gl.deleteProgram(program);
    throw error;
  }
  const quad=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,quad);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
  const point=gl.getAttribLocation(program,"point");
  const uniforms=Object.fromEntries(["forward","right","up","framing"].map(key=>[key,gl.getUniformLocation(program,key)]));
  return {gl,program,point,uniforms,quad};
}

function panoramaDraw(state) {
  if (!state.texture || !panoramaPipeline) return;
  const canvas=state.canvas,{gl,program,point,uniforms,quad}=panoramaPipeline;
  const [w,h]=panoramaSizes[state.aspect];
  if (canvas.width!==w || canvas.height!==h) { canvas.width=w; canvas.height=h; }
  const radians=Math.PI/180, a=state.yaw*radians,b=state.pitch*radians;
  const sx=Math.sin(a),cx=Math.cos(a),sy=Math.sin(b),cy=Math.cos(b);
  const f=Math.tan(state.fov*radians/2);
  gl.viewport(0,0,w,h);
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER,quad);
  gl.enableVertexAttribArray(point);
  gl.vertexAttribPointer(point,2,gl.FLOAT,false,0,0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D,state.texture);
  gl.uniform3f(uniforms.forward,sx*cy,sy,cx*cy);
  gl.uniform3f(uniforms.right,cx,0,-sx);
  gl.uniform3f(uniforms.up,-sx*sy,cy,-cx*sy);
  gl.uniform2f(uniforms.framing,f*w/h,f);
  gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
}

function panoramaMove(state,dx,dy,fov) {
  state.yaw=(state.yaw+dx)%360;
  state.pitch=Math.max(-89,Math.min(89,state.pitch+dy));
  state.fov=Math.max(28,Math.min(105,fov));
  panoramaDraw(state);
}

function panoramaClose() {
  if (panorama?.texture) panoramaPipeline?.gl.deleteTexture(panorama.texture);
  panorama=null;
}

async function openPanorama(n) {
  const version=curV(n);
  if (n.type!=="image" || !panoramaVersion(version)) return;
  const dialog=$("#imagePanorama"),canvas=$("canvas",dialog),status=$("[role=status]",dialog);
  panoramaClose();
  const state=panorama={n,version,board:B,epoch:boardOpenEpoch,canvas,yaw:0,pitch:0,fov:70,aspect:"16:9",busy:false,texture:null};
  $("[data-panorama-name]",dialog).textContent=n.name+" · 版本 "+(n.cur+1);
  const aspect=$("[data-panorama-aspect]",dialog);
  aspect.value=state.aspect;
  aspect.disabled=true;
  const capture=$("[data-panorama-capture]",dialog);
  capture.hidden=!canvasCanEdit();
  capture.disabled=true;
  canvas.hidden=true;
  status.textContent="正在加载全景图…";
  if (!dialog.open) dialog.showModal();
  try {
    const image=new Image();
    image.src=version.url;
    await image.decode();
    if (panorama!==state) return;
    panoramaPipeline ||= panoramaGraphics(canvas);
    const {gl}=panoramaPipeline,cap=gl.getParameter(gl.MAX_TEXTURE_SIZE);
    let source=image;
    if (Math.max(image.naturalWidth,image.naturalHeight)>cap) {
      const scale=cap/Math.max(image.naturalWidth,image.naturalHeight);
      source=document.createElement("canvas");
      source.width=Math.max(1,Math.floor(image.naturalWidth*scale));
      source.height=Math.max(1,Math.floor(image.naturalHeight*scale));
      source.getContext("2d").drawImage(image,0,0,source.width,source.height);
    }
    state.texture=gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,state.texture);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB,gl.RGB,gl.UNSIGNED_BYTE,source);
    if (gl.getError()!==gl.NO_ERROR) throw new Error("无法加载全景图纹理");
    panoramaDraw(state);
    canvas.hidden=false;
    aspect.disabled=false;
    capture.disabled=false;
    status.textContent="拖动查看，滚轮缩放，也可用方向键转动。";
  } catch(error) {
    if (panorama!==state) return;
    if (state.texture) panoramaPipeline.gl.deleteTexture(state.texture);
    state.texture=null;
    status.textContent=error.message || "无法读取全景图";
  }
}

async function panoramaCapture(dialog) {
  const state=panorama,button=$("[data-panorama-capture]",dialog),status=$("[role=status]",dialog);
  if (!state?.texture || state.busy || !canvasCanEdit()) return;
  state.busy=button.disabled=true;
  const framing=$("[data-panorama-aspect]",dialog);
  framing.disabled=true;
  status.textContent="正在保存视角…";
  const {canvas,n,version,aspect}=state,w=canvas.width,h=canvas.height;
  const view={yaw:state.yaw,pitch:state.pitch,fov:state.fov};
  try {
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));
    if (!blob) throw new Error("当前视角无法保存");
    const asset=await ewUpload(blob,"panorama-view.png");
    if (panorama!==state || B!==state.board || boardOpenEpoch!==state.epoch || !canvasCanEdit() ||
        node(n.id)!==n || !n.versions.some(item=>item.ref===version.ref)) throw new Error("原图或画布已更新，请重新打开全景");
    const captured=mediaVersion({...asset,w,h},{source:"panorama-frame",mode:"全景截帧",panorama:{source:version.ref,...view}});
    const data={aspect},extra={name:n.name+" · 全景截帧",versions:[captured],cur:0};
    const dimensions=size({type:"image",data,...extra}),at=freeSpot(n.x+size(n).w+110,n.y,"image",dimensions);
    checkpoint();
    const image=addNode("image",at.x,at.y,data,extra);
    link(n,image,true,{ref:version.ref});
    selectOnly(image.id);
    fit([image]);
    loadAssets();
    dialog.close();
  } catch(error) {
    if (panorama===state) status.textContent=error.message;
  } finally {
    if (panorama===state) {
      state.busy=false;
      button.disabled=framing.disabled=!state.texture;
    }
  }
}

function initPanorama() {
  const dialog=$("#imagePanorama"),canvas=$("canvas",dialog);
  const update=fn=>event=>{if(panorama?.texture&&!panorama.busy)fn(panorama,event);};
  dialog.addEventListener("close",()=>{if(!dialog.open)panoramaClose();});
  dialog.addEventListener("keydown",event=>event.stopPropagation());
  $("[data-panorama-close]",dialog).onclick=()=>dialog.close();
  $("[data-panorama-capture]",dialog).onclick=()=>panoramaCapture(dialog);
  $("[data-panorama-aspect]",dialog).onchange=update((state,event)=>{state.aspect=event.target.value;panoramaDraw(state);});
  $("[data-panorama-reset]",dialog).onclick=update(state=>{state.yaw=state.pitch=0;panoramaMove(state,0,0,70);});
  canvas.addEventListener("webglcontextlost",event=>{
    event.preventDefault();
    panoramaPipeline=null;
    if (!panorama) return;
    panorama.texture=null;
    $("[data-panorama-capture]",dialog).disabled=true;
    $("[role=status]",dialog).textContent="图形上下文已中断，请关闭后重新打开全景。";
  });
  canvas.onpointerdown=update((state,e)=>{
    if (e.button!==0) return;
    canvas.setPointerCapture(e.pointerId);
    state.drag={id:e.pointerId,x:e.clientX,y:e.clientY};
  });
  canvas.onpointermove=update((state,e)=>{
    const drag=state.drag;
    if (drag?.id!==e.pointerId) return;
    const step=state.fov/Math.max(1,canvas.clientHeight);
    panoramaMove(state,(drag.x-e.clientX)*step,(e.clientY-drag.y)*step,state.fov);
    Object.assign(drag,{x:e.clientX,y:e.clientY});
  });
  canvas.onlostpointercapture=()=>{if(panorama)panorama.drag=null;};
  canvas.addEventListener("wheel",update((state,e)=>{
    e.preventDefault();
    panoramaMove(state,0,0,state.fov+Math.sign(e.deltaY)*4);
  }),{passive:false});
  canvas.onkeydown=update((state,e)=>{
    const move={ArrowLeft:[-5,0,0],ArrowRight:[5,0,0],ArrowUp:[0,5,0],ArrowDown:[0,-5,0],"+":[0,0,-4],"-":[0,0,4]}[e.key];
    if (!move) return;
    e.preventDefault();
    panoramaMove(state,move[0],move[1],state.fov+move[2]);
  });
}
initPanorama();
