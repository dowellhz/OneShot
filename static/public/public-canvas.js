"use strict";

const token = location.pathname.split("/").at(-1);
const moderation = location.pathname.startsWith("/showcase-review/");
const source = moderation ? "/api/admin/showcase/" + encodeURIComponent(token) + "/canvas" :
  "/api/share/" + encodeURIComponent(token);
const select = id => document.getElementById(id);
const viewport = select("viewport"), layer = select("snapshotNodes"), links = select("links");
const geometry = new Map();
const view = {x:0,y:0,k:1};
let edges = [];

function text(tag, value, parent, className) {
  const el = document.createElement(tag);
  el.textContent = value;
  if (className) el.className = className;
  parent.append(el);
  return el;
}

function media(parent, kind, id, name) {
  const el = document.createElement(kind === "audio" ? "audio" : kind === "video" ? "video" : "img");
  el.src = source + "/media/" + id;
  if (kind === "video" || kind === "audio") {
    el.controls = true; el.playsInline = true; el.preload = "metadata";
  } else {
    el.alt = name || ""; el.loading = "lazy"; el.draggable = false;
  }
  el.addEventListener("error",()=>{
    if (el.isConnected) {
      const placeholder = text("p", "素材暂时无法播放或查看", parent, "node-content");
      el.replaceWith(placeholder);
    }
  },{once:true});
  parent.append(el);
}

function showSnapshot(snapshot) {
  document.title = snapshot.name + " · OneShot";
  document.querySelector("h1").textContent = snapshot.name;
  select("published").textContent = new Date(snapshot.created * 1000).toLocaleDateString(OneShotI18n.locale);
  edges = snapshot.edges;
  for (const n of snapshot.nodes) {
    const card = document.createElement("article");
    card.className = "snapshot-node";
    const w = n.type === "script" ? 360 : 310;
    const h = n.type === "audio" ? 104 : n.type === "script" ? 300 : n.type === "text" ? 215 : Math.min(420,Math.max(130, w * (n.h || 2) / (n.w || 3)) + 32);
    geometry.set(n.id,{x:n.x,y:n.y,w,h});
    Object.assign(card.style,{left:n.x+"px",top:n.y+"px",width:w+"px",height:h+"px"});
    text("h2",n.name || "未命名节点",card);
    if (n.type === "text") {
      if (typeof n.text_background === "string") card.dataset.documentBackground = n.text_background;
      const content = text("div",n.text,card,"node-content");
      if (n.text_format === "markdown") acMarkdown(content,n.text,{images:false});
    }
    else if (n.type === "script") {
      const story = text("div","",card,"node-content");
      text("b",n.script.title || "分镜",story);
      if (n.script.style) text("p",n.script.style,story);
      const shots = document.createElement("ol"); story.append(shots);
      for (const shot of n.script.shots) {
        const li = document.createElement("li"); shots.append(li);
        text("b",[shot.shot_size,shot.camera,shot.duration+"s"].filter(Boolean).join(" · "),li);
        if (shot.media !== undefined) media(li,"image",shot.media,"分镜预览");
        for (const line of [...shot.action,...shot.dialogue]) text("p",line,li);
      }
    } else if (n.media !== undefined) media(card,n.type,n.media,n.name);
    else text("div","发布时暂无可预览素材",card,"node-content");
    layer.append(card);
  }
  const empty = select("emptyView");
  empty.hidden = !!snapshot.nodes.length;
  if (!empty.hidden) empty.textContent = OneShotI18n.t("发布时画布为空");
  select("copyBoard").disabled = moderation;
  select("explainBoard").disabled = moderation || !snapshot.nodes.length;
  fitView();
}

function drawView() {
  layer.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.k})`;
  const width = viewport.clientWidth, height = viewport.clientHeight, density = devicePixelRatio || 1;
  const w = Math.floor(width * density), h = Math.floor(height * density);
  if (links.width !== w || links.height !== h) {
    links.width = w; links.height = h;
    links.style.width = width+"px"; links.style.height = height+"px";
  }
  const g = links.getContext("2d");
  if (!g) return;
  g.setTransform(density,0,0,density,0,0); g.clearRect(0,0,width,height);
  g.translate(view.x,view.y); g.scale(view.k,view.k);
  g.strokeStyle = "#757581"; g.lineWidth = 1.3 / view.k;
  g.beginPath();
  for (const e of edges) {
    const a=geometry.get(e.from), b=geometry.get(e.to);
    if (!a || !b) continue;
    const ax=a.x+a.w, ay=a.y+a.h/2, by=b.y+b.h/2;
    const bend=Math.max(32, Math.abs(b.x-ax)*.45);
    g.moveTo(ax,ay); g.bezierCurveTo(ax+bend,ay,b.x-bend,by,b.x,by);
  }
  g.stroke();
}

function fitView() {
  if (!geometry.size) return;
  const nodes=[...geometry.values()];
  const x=Math.min(...nodes.map(n=>n.x)), y=Math.min(...nodes.map(n=>n.y));
  const width=Math.max(...nodes.map(n=>n.x+n.w))-x, height=Math.max(...nodes.map(n=>n.y+n.h))-y;
  view.k=Math.max(.0001, Math.min(1,(viewport.clientWidth-32)/width,(viewport.clientHeight-32)/height));
  view.x=(viewport.clientWidth-width*view.k)/2-x*view.k;
  view.y=(viewport.clientHeight-height*view.k)/2-y*view.k;
  drawView();
}

function zoom(factor, x=viewport.clientWidth/2, y=viewport.clientHeight/2) {
  if (!geometry.size) return;
  const k=Math.min(3,Math.max(.0001,view.k*factor));
  view.x=x-(x-view.x)*k/view.k; view.y=y-(y-view.y)*k/view.k; view.k=k;
  drawView();
}

select("zoomOut").onclick=()=>zoom(1/1.25);
select("zoomIn").onclick=()=>zoom(1.25);
select("fitView").onclick=fitView;
addEventListener("resize",drawView);
viewport.addEventListener("wheel",e=>{
  if (e.target.closest(".snapshot-node") && !e.ctrlKey) return;
  e.preventDefault();
  const box=viewport.getBoundingClientRect();
  zoom(e.deltaY>0?1/1.12:1.12,e.clientX-box.left,e.clientY-box.top);
},{passive:false});
viewport.addEventListener("pointerdown",e=>{
  if(e.button!==0 || e.target.closest(".snapshot-node")) return;
  viewport.setPointerCapture(e.pointerId);
  const x=e.clientX-view.x,y=e.clientY-view.y, id=e.pointerId;
  const move=event=>{ if(event.pointerId===id){view.x=event.clientX-x;view.y=event.clientY-y;drawView();} };
  viewport.addEventListener("pointermove",move);
  viewport.addEventListener("lostpointercapture",()=>viewport.removeEventListener("pointermove",move),{once:true});
});
viewport.addEventListener("keydown",e=>{
  if(e.target!==viewport)return;
  const offset={ArrowLeft:[36,0],ArrowRight:[-36,0],ArrowUp:[0,36],ArrowDown:[0,-36]}[e.key];
  if(offset){e.preventDefault();view.x+=offset[0];view.y+=offset[1];drawView();}
});

const copyButton=select("copyBoard"), explainButton=select("explainBoard");
copyButton.hidden=explainButton.hidden=moderation;
async function adoptSnapshot(explain) {
  const feedback=select("shareFeedback"), wasDisabled=explainButton.disabled;
  copyButton.disabled=explainButton.disabled=true;
  feedback.hidden=true;
  try {
    const r=await fetch(source+(explain?"/explain":"/copy"),{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
    if(r.status===401){location.assign("/login?next="+encodeURIComponent(location.pathname));return;}
    if(!r.ok) {
      const detail=await r.json().catch(()=>null);
      throw new Error(detail?.error || (r.status===404?"此分享已撤销":explain?"暂时无法解读，请稍后重试":"暂时无法复制，请稍后重试"));
    }
    const board=await r.json();
    const params=new URLSearchParams({board:board.id});
    if(board.session)params.set("session",board.session);
    location.assign("/?"+params);
  } catch (error) { feedback.textContent=OneShotI18n.t(error.message); feedback.hidden=false; }
  finally { copyButton.disabled=false; explainButton.disabled=wasDisabled; }
}
copyButton.onclick=()=>adoptSnapshot(false);
explainButton.onclick=()=>adoptSnapshot(true);

fetch(source).then(async r=>{
  if(!r.ok)throw new Error(r.status===404?"分享链接已撤销或不存在":"暂时无法读取此画布");
  showSnapshot(await r.json());
}).catch(error=>{select("emptyView").textContent=OneShotI18n.t(error.message);});
