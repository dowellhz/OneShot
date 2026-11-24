"use strict";
// Canvas tools: storyboard script node, "/" image tools, grid split, HD redraw, 反推, 拉片, concat, asset library.
// Loaded before the main script; only declarations here. The main script calls initTools() before it boots.

const KIND_CN = { character: "角色", scene: "场景", prop: "道具", style: "风格", document: "资料", world: "世界观" };
const toolBusy = new Map();          // node id -> { label, t0 } while a Qwen / media tool runs on it

function setToolBusy(n, label) {
  if (label) toolBusy.set(n.id, { label, t0: Date.now() }); else toolBusy.delete(n.id);
  const el = els.get(n.id); if (!el) return;
  const g = $(".gen", el), on = !!label;
  if (!n.job) { g.classList.toggle("on", on); if (on) { $(".pct", g).textContent = ""; $(".bar i", g).style.width = "0"; } }
  if (on) $(".s", g).textContent = label;
}
setInterval(() => toolBusy.forEach((b, id) => {
  const el = els.get(id); if (el && !node(id)?.job) $(".gen .s", el).textContent = `${b.label} ${Math.round((Date.now() - b.t0) / 1000)}s`;
}), 1000);
async function withBusy(n, label, fn) {
  if (toolBusy.has(n.id)) { toast("这个节点正在处理中"); return; }
  setToolBusy(n, label);
  try { return await fn(); }
  catch (e) { toast(e.message, 4500); }
  finally { setToolBusy(n, null); if (sel.has(n.id)) showPanel(); }
}
const llmNote = r => r && r.device === "CPU" ? "（引擎正忙，用 CPU 跑的，较慢）" : r && r.device && r.device !== "GPU" ? `（${r.device}）` : "";
const mediaVersion = (r, extra = {}) => ({ ref: r.ref, url: r.url, w: r.w, h: r.h, seconds: r.seconds, prompt: "", ...extra });
function placeRight(n, type, dy = 0) { const s = size(n); return freeSpot(n.x + s.w + 110, n.y + dy, type); }

// ================================================================= "/" tools for image prompts
const GRID9_ANGLES = ["鸟瞰远景","正面全景","低机位全景","左前中景","平视近景","右前侧近景","正侧构图","从背面看","主体细节特写"];
const GRID9_PROMPT = "把 @图1 中已经存在的同一主体和场景从九个机位重新拍成一张规则的 3×3 九宫格。" +
  "保留主体的类别、数量、形状、颜色、材质、动作，以及场景布局和照明。只移动相机，禁止添加或替换主体、物件和装饰。" +
  "参考图里若没有人、动物或脸，九格也不能出现人、动物或脸，不能把物体拟人化。九格必须同时呈现同一时刻，严格等大。" +
  "按从左至右、从上到下依次为："+GRID9_ANGLES.join("、")+"。分隔线细而一致，不加文字、编号和外边框。";
const SLASH = [
  { k: "3view", t: "三视图", d: "同一角色的正面 / 侧面 / 背面设定图", img: true, aspect: "16:9",
    p: "角色设定三视图：参考 @图1 中的角色，画出同一角色的正面、侧面、背面全身站姿，三个视图从左到右并排，纯白背景，长相、发型、服装、配色和体型与 @图1 完全一致，线条干净，标准角色设定图排版" },
  { k: "grid9", t: "生成多机位九宫格", d: "使用第一张已连入的图片和当前生成参数", img: true, generate: true },
  { k: "grid25", t: "25 宫格连贯分镜", d: "按时间顺序的 25 格分镜", aspect: "1:1",
    p: "5×5 二十五宫格连贯分镜图，格子之间用细白线分隔，从左到右、从上到下按时间顺序讲述：【在这里写剧情】。每格一个镜头，景别和机位有变化，人物长相、服装和场景前后一致，电影感" },
  { k: "next", t: "剧情推演", d: "画出接下来的一个镜头", img: true,
    p: "根据 @图1 推演下一个镜头：【写接下来发生什么】。保持人物长相、服装、场景、光线和画风与 @图1 一致，换一个合适的景别和机位，电影感构图" },
  { k: "light", t: "电影打光", d: "构图不变，只换光线", img: true,
    p: "保持 @图1 的构图、人物和场景完全不变，只改变光线：【伦勃朗光 / 逆光剪影 / 黄金时刻暖光 / 冷色月光 / 霓虹灯光】，电影级布光，光影层次丰富，色调统一" },
  { k: "angle", t: "换角度", d: "拖滑块调整机位，不用写提示词", img: true, angle: true },
];
let slashState = null;

function closeSlash() {
  slashState = null;
  $("#slashMenu").classList.remove("on");
  const field = $("#prompt");
  field.removeAttribute("aria-activedescendant");
  field.removeAttribute("aria-controls");
}

function slashEnabled(n, command) {
  if (!canvasCanEdit() || n.type !== "image" || !isRemote(n) && n.data.model === "h3video") return false;
  if (command.img && !imageInputs(n).some(input => input.version?.ref)) return false;
  return !command.generate || !(n.job || prepping.has(n.id));
}

function openSlash(n, viaKey) {
  if ($("#prompt")._node !== n.id || !canvasCanEdit() || n.type !== "image" || !isRemote(n) && n.data.model === "h3video") return;
  closeMenus();
  const field = $("#prompt");
  const end = field.selectionEnd;
  slashState = {n,board:B,viaKey,start:viaKey?end-1:field.selectionStart,end,active:null};
  field.focus({preventScroll:true});
  field.setAttribute("aria-controls","slashMenu");
  renderSlash();
}

function slashButtons() {
  return $$("button:not(:disabled)",$("#slashMenu"));
}

function highlightSlash(button, scroll=false) {
  for (const item of slashButtons()) item.setAttribute("aria-selected",String(item===button));
  slashState.active=button?.dataset.k||null;
  const field=$("#prompt");
  if (!button) { field.removeAttribute("aria-activedescendant"); return; }
  field.setAttribute("aria-activedescendant",button.id);
  if (scroll) button.scrollIntoView?.({block:"nearest"});
}

function renderSlash() {
  const state=slashState, field=$("#prompt"), menu=$("#slashMenu");
  if (!state || B!==state.board || field._node!==state.n.id) return closeSlash();
  if(state.viaKey){
    state.end=field.selectionStart;
    if(!/^\/[\p{L}\p{N}-]*$/u.test(field.value.slice(state.start,state.end)))return closeSlash();
  }
  const query=state.viaKey?field.value.slice(state.start+1,state.end).toLowerCase():"";
  const commands=SLASH.filter(x=>[x.k,x.t,x.d].some(value=>value.toLowerCase().includes(query)));
  const hasImage=imageInputs(state.n).some(input=>input.version?.ref);
  menu.innerHTML='<div class="mt">'+(commands.length ? "图片工具" : "没有匹配的图片工具")+'</div>'+commands.map(x=>{
    const enabled=slashEnabled(state.n,x);
    const why=!enabled?(hasImage?"请等待当前任务结束":"请先连入有图片的节点"):x.d;
    return `<button type="button" role="option" tabindex="-1" id="slash-${x.k}" data-k="${x.k}" aria-selected="false" ${enabled?"":"disabled"}>
      <span><b>${x.t}</b><small>${why}</small></span></button>`;
  }).join("");
  menu.classList.add("on");
  const target=field.getBoundingClientRect();
  menu.style.left=Math.max(8,Math.min(target.left,innerWidth-menu.offsetWidth-8))+"px";
  menu.style.top=Math.max(8,target.top-menu.offsetHeight-8)+"px";
  const enabled=slashButtons();
  highlightSlash(enabled.find(item=>item.dataset.k===state.active)||enabled[0]);
  for(const button of enabled){
    button.onpointerdown=e=>e.preventDefault();
    button.onmouseenter=()=>highlightSlash(button);
    button.onclick=()=>applySlash(state,SLASH.find(x=>x.k===button.dataset.k));
  }
}

function applySlash(state, command) {
  const field=$("#prompt"), {n,board,start,end,viaKey}=state;
  if (board!==B || node(n.id)!==n || field._node!==n.id || !slashEnabled(n,command)) return closeSlash();
  if (viaKey && !/^\/[\p{L}\p{N}-]*$/u.test(field.value.slice(start,end))) return closeSlash();
  closeSlash();
  const insert=(text, aspect, a=start, b=end)=>{
    if(board!==B || node(n.id)!==n || field._node!==n.id || !canvasCanEdit())return;
    const prefix=text && a>0 && !/\s/.test(field.value[a-1]) ? "\n" : "";
    const suffix=text && b<field.value.length && !/\s/.test(field.value[b]) ? "\n" : "";
    if (a===b && !text) return;
    checkpoint(field._before || snap());
    if (aspect) n.data.aspect=aspect;
    field.setRangeText(prefix+text+suffix,a,b,"end");
    field.dispatchEvent(new Event("input"));
    field._before=snap();
    if (aspect) showPanel();
    const placeholder=/【[^】]+】/.exec(text);
    if (placeholder) field.setSelectionRange(a+prefix.length+placeholder.index,a+prefix.length+placeholder.index+placeholder[0].length);
  };
  if(command.generate){
    if(viaKey)insert("");
    return generate(n,{imageGrid:true});
  }
  if(command.angle){
    const draft=field.value;
    return openAngle(n,text=>{if(field.value===draft)insert(text);});
  }
  insert(command.p,command.aspect);
}

function slashKeys(event) {
  if(!slashState || !$("#slashMenu").classList.contains("on") || event.isComposing || event.metaKey || event.ctrlKey || event.altKey)return;
  if(!["ArrowDown","ArrowUp","Enter","Tab","Escape"].includes(event.key))return;
  const active=slashButtons(), index=active.findIndex(button=>button.dataset.k===slashState.active);
  if(event.key==="Tab" && (event.shiftKey || index<0)){closeSlash();return;}
  event.preventDefault();event.stopImmediatePropagation();
  if(event.key==="Escape")return closeSlash();
  if(event.key==="Enter" || event.key==="Tab")return active[index]?.click();
  if(active.length)highlightSlash(active[(index+(event.key==="ArrowDown"?1:-1)+active.length)%active.length],true);
}

function openAngle(n, apply) {
  const pop = $("#anglePop"), r = $("#prompt").getBoundingClientRect();
  const board=B;
  pop.classList.add("on");
  pop.style.left = Math.max(8, Math.min(r.left, innerWidth - 330)) + "px";
  pop.style.top = Math.max(8, r.top - pop.offsetHeight - 8) + "px";
  const text = () => `保持 @图1 中的主体、动作、光照和场景，${imageCameraPrompt(imageCameraSettings("ag"))}，从新机位重新构图。`;
  const upd = () => { imageCameraRefresh("ag");$("#agText").textContent=text(); };
  for(const field of imageCameraFields) $("#ag"+field).oninput = upd;
  upd();
  $("#agOk").onclick = () => {
    const field=$("#prompt");
    if(board===B && node(n.id)===n && field._node===n.id && canvasCanEdit()){
      if(apply) apply(text());
      else{
        checkpoint(field._before||snap());
        field.value=text();
        field.dispatchEvent(new Event("input"));
        field._before=snap();
      }
      field.focus();
    }
    pop.classList.remove("on");
  };
  $("#agCancel").onclick = () => pop.classList.remove("on");
}

// ================================================================= image tools: 反推, 宫格拆分, 高清重绘, 资产
async function describeImage(n) {
  const v = curV(n); if (!v) return toast("还没有图片");
  await withBusy(n, "Qwen 看图反推中", async () => {
    const r = await api("/api/describe", { images: [{ ref: v.ref, name: n.name }], mode: "prompt" });
    checkpoint();
    if (!n.data.caption) n.data.caption = r.text.slice(0, 300);
    const at = placeRight(n, "text"), t = addNode("text", at.x, at.y, { text: r.text }, { name: n.name + " · 反推" });
    selectOnly(t.id); toast(`已反推出提示词（${r.seconds}s）${llmNote(r)}，连到图片或视频节点即可使用`, 3500);
  });
}
async function splitGrid(n, rows, cols) {
  const v = curV(n); if (!v) return toast("还没有图片");
  const board=B, angles=v.image_grid&&rows===3&&cols===3 ? GRID9_ANGLES : null;
  await withBusy(n, "拆分中", async () => {
    const r = await api("/api/split", { ref: v.ref, rows, cols });
    if(board!==B || node(n.id)!==n || !canvasCanEdit())return;
    checkpoint();
    const s = size(n), x0 = n.x + s.w + 110, made = [];
    let tw = 0, th = 0;
    for (const t of r.tiles) {
      const title=angles?.[t.row*cols+t.col] || `${t.row+1}-${t.col+1}`;
      const m = addNode("image", 0, 0, { caption: n.data.caption || (v.prompt || "").slice(0, 200), aspect: "auto" }, { name: `${n.name} · ${title}` });
      m.versions.push({ ref: t.ref, url: t.url, w: t.w, h: t.h, source: "tile", prompt: "" }); m.cur = 0;
      const z = size(m); tw = z.w; th = z.h; made.push([m, t]);
    }
    // park the whole grid to the right of the image, past anything already there
    const gw = cols * (tw + 30), gh = rows * (th + 56), mine = new Set(made.map(([m]) => m.id));
    let gx = x0;
    for (let k = 0; k < 50; k++) {
      const hit = B.nodes.find(o => !mine.has(o.id) && o.id !== n.id && (() => { const z = size(o); return gx < o.x + z.w + 40 && gx + gw > o.x && n.y < o.y + z.h + 40 && n.y + gh > o.y - 40; })());
      if (!hit) break; gx = hit.x + size(hit).w + 80;
    }
    for (const [m, t] of made) { m.x = Math.round(gx + t.col * (tw + 30)); m.y = Math.round(n.y + t.row * (th + 56)); render(m); }
    drawEdges(); save(); sel = new Set(made.map(([m]) => m.id)); updateSel();
    toast(`已拆成 ${rows}×${cols} 张，可以选中某一张点「高清」放大，或连到视频当首帧`, 3500);
  });
}
async function hdRedraw(n) {
  if (!curV(n)) return toast("还没有图片");
  checkpoint();
  const at = placeRight(n, "image");
  const m = addNode("image", at.x, at.y, { prompt: "高清重绘：保持 @图1 的构图、人物长相、表情、服装、场景和色彩完全一致，提升清晰度和细节，去除模糊、噪点和压缩痕迹", aspect: "auto", quality: "4mp" }, { name: n.name + " · 高清" });
  link(n, m, true); selectOnly(m.id); generate(m);
}
const removedAssetIds = new Set();

function clearDeletedAssetBindings(nodes) {
  const affected = [];
  for (const n of nodes) {
    let changed = false;
    if (removedAssetIds.has(n.data?.asset?.id)) {
      delete n.data.asset;
      changed = true;
    }
    if (removedAssetIds.has(n.data?.character_draft?.asset)) {
      delete n.data.character_draft;
      changed = true;
    }
    if (changed) affected.push(n);
  }
  return affected;
}

function unlinkDeletedAsset(id) {
  removedAssetIds.add(id);
  if (!B) return;
  const affected = clearDeletedAssetBindings(B.nodes);
  if (!affected.length) return;
  for (const n of affected) { render(n); refreshDownstream(n); }
  closeMenus();
  showPanel();
  save();
}

async function saveAsset(n, kind) {
  const v = curV(n); if (!v) return toast("还没有图片");
  const bid = boardId;
  const name = n.name.replace(/^图片 (\d+)$/, `${KIND_CN[kind]}$1`);
  try {
    await flushSave();
    if (bid !== boardId || node(n.id) !== n) return;
    const scope = n.data.asset?.id ? {} : cmNewScope();
    const a = await api("/api/library", { id: n.data.asset?.id, kind, name, desc: n.data.caption || (v.prompt || "").slice(0, 200), ref: v.ref, w: v.w, h: v.h, source_board: bid, node_id:n.id, ...scope, recreate_deleted:true });
    if (bid !== boardId || node(n.id) !== n) return;
    checkpoint(); n.name = a.name; n.data.asset = { id: a.id, kind }; save(); render(n); refreshDownstream(n); drawEdges();
    toast(`已存入资产库 · ${KIND_CN[kind]}「${a.name}」${kind === "character" ? "。之后新连到视频时默认作为人物设定" : ""}`, 3000);
    cmInvalidate(); loadAssets();
    if (kind === "character") cmEdit(a, kind);
  } catch (e) { toast("保存失败：" + e.message); }
}

// ================================================================= video tools: 拉片, 看图填写, 拼接
async function analyzeVideo(n) {
  const v = curV(n); if (!v) return toast("还没有视频");
  await withBusy(n, "拉片中：切镜头 + Qwen 分析", async () => {
    const r = await api("/api/analyze", { ref: v.ref });
    checkpoint();
    const at = placeRight(n, "script");
    const s = addNode("script", at.x, at.y, { prompt: `拉片：${r.title || n.name}`, title: r.title, style: r.style, characters: r.characters, shots: r.shots, aspect: v.w && v.h ? nearestAspect(v.w / v.h) : "16:9" }, { name: `拉片 · ${n.name}` });
    selectOnly(s.id);
    toast(`拆出 ${r.shots.length} 个镜头（${r.seconds}s）${llmNote(r)}。点「展开到画布」逐镜复刻；人物叫 人物1、人物2，可把自己的角色图改成这个名字连进来替换`, 6000);
  });
}
function nearestAspect(r) { return Object.entries(AR).reduce((a, b) => Math.abs(Math.log(b[1] / r)) < Math.abs(Math.log(a[1] / r)) ? b : a)[0]; }
async function fillFieldsFromImages(n) {
  const imgs = plan(n).imgs.map(m => ({ m, v: curV(m) })).filter(x => x.v).map(x => ({ ref: x.v.ref, name: x.m.name }));
  if (!imgs.length) return toast("先把首帧或人物图连到这个视频节点");
  await withBusy(n, "Qwen 看图填写中", async () => {
    const r = await api("/api/describe", { images: imgs, mode: "fields" });
    checkpoint(); const f = n.data.fields || (n.data.fields = {}); let c = 0;
    for (const [k, val] of Object.entries(r.fields)) if (val && !(f[k] || "").trim()) { f[k] = val; c++; }
    save(); $("#pfields")._node = null;
    toast(c ? `已按图片填好 ${c} 栏（只填空着的栏）${llmNote(r)}，动作和对话还需要你来写` : "这些栏都已经有内容了，没有覆盖", 3500);
  });
}
async function concatVideos(list) {
  const vids = list.filter(m => m && m.type === "video" && curV(m));
  if (!vids.length) return toast("还没有已生成的视频");
  openFilm(vids);
}
async function concatVideosNow(list, anchor) {
  const vids = list.filter(m => m && m.type === "video" && curV(m));
  if (vids.length < 2) return toast("至少需要两段已生成的视频");
  const host = anchor || vids[vids.length - 1];
  await withBusy(host, `拼接 ${vids.length} 段视频中`, async () => {
    const r = await api("/api/concat", { refs: vids.map(m => curV(m).ref) });
    checkpoint();
    const right = vids.reduce((a, b) => (b.x + size(b).w > a.x + size(a).w ? b : a));
    const at = freeSpot(right.x + size(right).w + 110, right.y, "video");
    const out = addNode("video", at.x, at.y, {}, { name: `成片（${vids.length} 段）` });
    out.versions.push(mediaVersion(r, { source: "concat", mode: "拼接" })); out.cur = 0; render(out); save(); selectOnly(out.id);
    toast(`已拼成 ${r.seconds.toFixed(1)} 秒成片，顺序：${vids.map(m => m.name).join(" → ")}`, 4000);
  });
}
const byPosition = ids => ids.map(node).filter(Boolean).sort((a, b) => (Math.abs(a.y - b.y) > 300 ? a.y - b.y : a.x - b.x));

// ================================================================= storyboard script node
function scriptRefs(n) {
  return imageInputs(n).filter(({version})=>version?.ref).map(({source,version,edge})=>({
    node:source,name:source.name,ref:version.ref,pinned:!!edge.ref,desc:source.data.caption||"",kind:source.data.asset?.kind||"",
  }));
}

function scriptShotIndex(shots,pair,index,length) {
  if(!shots.length)return -1;
  if(pair.shot_id)return shots.findIndex(shot=>shot.id===pair.shot_id);
  for(const id of [pair.img,pair.vid]){
    const label=node(id)?.name?.match(/^镜(\d+)(?: · 分镜图)?$/);
    const position=label?Number(label[1])-1:-1;
    if(shots[position])return position;
  }
  return length%shots.length===0?index%shots.length:-1;
}

function ensureScriptShotIds(n) {
  const shots=n.data.shots||[], records=n.data.made||[];
  for(const shot of shots)shot.id ||= newCanvasNodeId();
  records.forEach((pair,index)=>{
    const shot=shots[scriptShotIndex(shots,pair,index,records.length)];
    if(shot&&!pair.shot_id)pair.shot_id=shot.id;
  });
}

function scriptShotLinks(n) {
  const shots=n.data.shots||[], records=n.data.made||[];
  const links=Array(shots.length).fill(null);
  records.forEach((pair,index)=>{
    const position=scriptShotIndex(shots,pair,index,records.length);
    if(position>=0&&(node(pair.img)||node(pair.vid)))links[position]=pair;
  });
  return links;
}

function shotNeedsNodes(pair) {
  return !node(pair?.img)||!node(pair?.vid);
}

function scriptTailEdges() {
  const edges=new Map();
  for(const edge of B.edges)if(edge.story_continuity&&!edges.has(edge.to))edges.set(edge.to,edge);
  return edges;
}

function scriptContinuityStatus(links,index,edges) {
  const edge=edges.get(links[index]?.img);
  if(!edge)return null;
  if(index===0)return {text:"首镜仍引用旧的上一镜尾帧",warning:true};
  const previous=node(links[index-1]?.vid), source=node(edge.from), picture=node(edge.to);
  const capture=source?.versions.find(v=>v.ref===edge.ref)?.capture;
  const requested=curV(previous)?.ref;
  const used=curV(picture)?.generation_record?.inputs;
  if(!capture?.source_ref || capture.position!=="last")return {text:"尾帧来源无法确认",warning:true,relink:!!requested};
  if(!requested)return {text:"上一镜当前没有可用视频",warning:true};
  if(capture.source_node!==previous.id || capture.source_ref!==requested)return {text:"尾帧与上一镜当前版本不一致",warning:true,relink:true};
  if(Array.isArray(used)&&!used.some(item=>item.ref===edge.ref))return {text:"尾帧已对齐，当前分镜图尚未使用",warning:true};
  return {text:`尾帧已对齐 · 上一镜版本 ${previous.cur+1}`,warning:false};
}

function paintScriptContinuity(script,root,links=scriptShotLinks(script),edges=scriptTailEdges()) {
  const editable=canvasCanEdit()&&!nodeLocked(script);
  for(const badge of $$("[data-script-tail-status]",root)){
    const index=Number(badge.dataset.scriptTailStatus);
    const status=scriptContinuityStatus(links,index,edges);
    badge.hidden=!status;
    if(badge.textContent!==(status?.text||""))badge.textContent=status?.text||"";
    badge.dataset.warning=String(!!status?.warning);
    const actions=$("[data-shot-tail-actions]",badge.parentElement);
    if(!actions)continue;
    const edge=edges.get(links[index]?.img);
    const picture=node(links[index]?.img), previous=node(links[index-1]?.vid);
    const link=$("[data-tail-link]",actions), remove=$("[data-tail-remove]",actions);
    const canChange=editable&&picture?.type==="image"&&!nodeLocked(picture);
    link.hidden=!canChange||!curV(previous)?.ref||picture.data.model==="h3video"||!!edge&&!status?.relink;
    remove.hidden=!canChange||!edge;
    actions.hidden=link.hidden&&remove.hidden;
    const label=edge?"改用最新尾帧":"连接上一镜尾帧";
    if(link.textContent!==label)link.textContent=label;
    link.disabled=remove.disabled=!!(picture?.job||prepping.has(picture?.id)||scriptContinuityPending.has(picture));
  }
}

function refreshScriptContinuity() {
  const edges=scriptTailEdges();
  for(const script of B.nodes){
    if(script.type==="script"&&els.get(script.id))paintScriptContinuity(script,els.get(script.id),scriptShotLinks(script),edges);
  }
  const list=$("#shotList");
  const script=list&&!list.hidden?node($("[data-source]",list)?.value):null;
  if(script?.type==="script")paintScriptContinuity(script,list,scriptShotLinks(script),edges);
}

function openScriptShot(n,index) {
  if(node(n.id)!==n)return;
  const pair=scriptShotLinks(n)[index], targets=[node(pair?.img),node(pair?.vid)].filter(Boolean);
  if(!targets.length){expandScript(n,[index]);return;}
  sel=new Set(targets.map(target=>target.id));updateSel();fit(targets);
}

const scriptContinuityPending=new Set();

function scriptTailPrompt(slot) {
  return `参考上一镜尾帧 ${promptMediaToken("image",slot)} 的人物、道具位置和光线，按本镜的机位与首帧要求构图。`;
}

function removeScriptTailPrompt(picture, edge) {
  const slot=promptSlot(edge.prompt_slot);
  if(!slot || !picture.data.prompt || imageInputs(picture).some(input=>input.edge!==edge&&input.edge.prompt_slot===slot))return;
  const token=promptMediaToken("image",slot), instruction=scriptTailPrompt(slot);
  picture.data.prompt=picture.data.prompt.split("\n").filter(line=>line.trim()!==instruction).join("\n").replaceAll(token,"");
}

async function linkPreviousShotFrame(script,index,{batch=false,allowNew=!batch,select=!batch,active:keepRunning=()=>true}={}) {
  const fail=message=>{
    if(batch)throw new Error(message);
    toast(message);
    return false;
  };
  if(!canvasCanEdit() || node(script.id)!==script || nodeLocked(script))return;
  if(!batch&&scriptShotLinks(script)[index]?.shared_first)return useRenderedMotionTail(script,index);
  const pairs=scriptShotLinks(script), source=node(pairs[index-1]?.vid), picture=node(pairs[index]?.img);
  const version=curV(source);
  if(!version?.ref)return fail("请先为上一镜生成或选好视频版本");
  if(!picture)return fail("请先展开这一镜");
  if(nodeLocked(picture)||picture.job||prepping.has(picture.id))return fail("请等当前分镜图任务结束，或解锁节点后再连接");
  if(picture.data.model==="h3video")return fail("请为分镜图选择支持参考图片的模型");
  if(vtReferenceAncestors(source).has(picture.id))return fail("上一镜已依赖本镜分镜图，连接会形成循环");
  if(scriptContinuityPending.has(picture))return fail("上一镜尾帧正在截取，请稍后重试");
  const continuity=()=>B.edges.find(edge=>edge.to===picture.id&&edge.story_continuity);
  const prior=continuity();
  const bindingKey=edge=>edge&&JSON.stringify([edge.from,edge.ref,edge.prompt_slot]);
  const priorBinding=bindingKey(prior);
  const oldFrame=node(prior?.from)?.versions.find(item=>item.ref===prior.ref);
  if(!allowNew&&!prior)return false;
  if(oldFrame?.capture?.position==="last"&&oldFrame.capture.source_node===source.id&&oldFrame.capture.source_ref===version.ref){
    if(!batch)toast("已连接上一镜当前版本的尾帧");
    return true;
  }
  const previousShot=script.data.shots[index-1], shot=script.data.shots[index];
  const active=()=>{
    if(!keepRunning() || node(script.id)!==script || nodeLocked(script) || node(picture.id)!==picture ||
      nodeLocked(picture) || picture.job || prepping.has(picture.id) || picture.data.model==="h3video" ||
      node(source.id)!==source || curV(source)!==version || continuity()!==prior ||
      bindingKey(prior)!==priorBinding || vtReferenceAncestors(source).has(picture.id) ||
      script.data.shots[index]!==shot || script.data.shots[index-1]!==previousShot)return false;
    const linked=scriptShotLinks(script);
    return linked[index-1]?.vid===source.id&&linked[index]?.img===picture.id;
  };
  scriptContinuityPending.add(picture);
  if(!batch)toast("正在截取上一镜尾帧…");
  try{
    const frame=await captureOnCanvas(source.id,version,{position:"last",active,select,onCaptured:image=>{
      const sequence=promptSlot(picture.data.image_ref_seq);
      const slot=promptSlot(prior?.prompt_slot)||1+Math.max(sequence,...imageInputs(picture).map(({edge})=>promptSlot(edge.prompt_slot)));
      const binding={from:image.id,ref:curV(image).ref,prompt_slot:slot,story_continuity:true};
      if(prior)Object.assign(prior,binding);
      else {
        B.edges.push({...binding,to:picture.id});
        picture.data.prompt=[picture.data.prompt,scriptTailPrompt(slot)].filter(Boolean).join("\n");
      }
      picture.data.image_ref_seq=Math.max(sequence,slot);
      return picture;
    }});
    if(!batch)toast(frame?"已连接上一镜尾帧，可生成本镜分镜图":"镜头或素材已变化，请重新选择");
    return !!frame;
  }catch(error){
    if(batch)throw error;
    if(node(script.id)===script)toast("尾帧连接失败："+error.message);
    return false;
  }
  finally{scriptContinuityPending.delete(picture);}
}

async function useRenderedMotionTail(script,index) {
  const pair=scriptShotLinks(script)[index], previous=node(scriptShotLinks(script)[index-1]?.vid), video=node(pair?.vid);
  const version=curV(previous);
  const first=video&&B.edges.find(edge=>edge.to===video.id&&edge.role==="first");
  const middle=node(pair?.motion_frames?.middle);
  const previousFrame=first&&B.edges.find(edge=>edge.from===first.from&&edge.to===middle?.id&&edge.prompt_slot===1);
  if(!canvasCanEdit()||nodeLocked(script)||!pair?.shared_first||!version||!first||nodeLocked(video)||
     video.job||prepping.has(video.id)||middle?.job||prepping.has(middle?.id)||
     scriptContinuityPending.has(video)||vtReferenceAncestors(previous).has(video.id))return false;
  const originalSource=first.from, originalRef=first.ref;
  const priorCapture=node(first.from)?.versions.find(item=>item.ref===first.ref)?.capture;
  if(priorCapture?.source_ref===version.ref&&priorCapture.position==="last"){
    toast("已使用上一镜当前版本的成片尾帧");
    return true;
  }
  scriptContinuityPending.add(video);
  try{
    const frame=await captureOnCanvas(previous.id,version,{position:"last",select:false,
      active:()=>node(script.id)===script&&node(video.id)===video&&curV(previous)===version&&
        !video.job&&!prepping.has(video.id)&&!nodeLocked(video)&&B.edges.includes(first)&&
        first.from===originalSource&&first.ref===originalRef&&
        !middle?.job&&!prepping.has(middle?.id)&&
        scriptShotLinks(script)[index]===pair&&scriptShotLinks(script)[index-1]?.vid===previous.id&&
        !vtReferenceAncestors(previous).has(video.id),
      onCaptured:image=>{
        rememberVideoVersion(video);
        Object.assign(first,{from:image.id,ref:curV(image).ref});
        if(previousFrame&&B.edges.includes(previousFrame)&&previousFrame.from===originalSource&&!nodeLocked(middle))
          Object.assign(previousFrame,{from:image.id,ref:curV(image).ref});
        drawEdges();
        return video;
      }});
    toast(frame?"已用上一镜成片尾帧作为本镜首帧，可重生成本镜":"镜头或版本已经变化，请重试");
    return !!frame;
  }catch(error){
    toast("取得上一镜尾帧失败："+error.message);
    return false;
  }finally{scriptContinuityPending.delete(video);}
}

function renderScript(n, body) {
  const d = n.data, shots = d.shots || [];
  if (!shots.length) {
    body.innerHTML = `<div class="ph">${ico("script")}<div class="t">分镜脚本<br>选中后写剧情，连入角色 / 场景图片<br>由 Qwen 拆成一组镜头，再一键生成分镜图和视频</div></div>`;
    return;
  }
  const total = shots.reduce((a, s) => a + (s.duration || 0), 0);
  const links=scriptShotLinks(n);
  const seconds = duration => Number(Number(duration).toFixed(2));
  body.innerHTML = `<div class="sb"><div class="sbh"><b>${esc(d.title || "分镜")}</b><span>${shots.length} 镜 · ${seconds(total)}s</span></div>
    ${d.style ? `<div class="sbs">${esc(d.style)}</div>` : ""}
    ${shots.map((s, i) => `<div class="shot"><div class="sh1"><span class="no">${i + 1}</span>${s.frame ? `<img src="/media?ref=${encodeURIComponent(s.frame.ref)}">` : ""}<span>${esc(s.shot_size)}</span><span class="dim">${esc(s.camera)}</span><span class="du">${seconds(s.duration)}s</span>
      ${links[i]||canvasCanEdit()&&!nodeLocked(n)?`<button type="button" data-script-shot="${i}" aria-label="${links[i]?"定位":"展开"}第 ${i+1} 镜">${links[i]?"定位":"展开"}</button>`:""}</div>
      ${s.action.length ? `<div class="sa">${s.action.map(esc).join("<br>")}</div>` : ""}
      ${s.dialogue.length ? `<div class="sd">${s.dialogue.map(esc).join("<br>")}</div>` : ""}
      ${links[i]?.img?`<span class="story-tail-status" data-script-tail-status="${i}" hidden></span>`:""}
      ${links[i]?`<div class="script-shot-actions">
        ${canvasCanEdit()&&!nodeLocked(n)?`${i>0&&links[i].img?`<button type="button" data-script-tail="${i}" aria-label="第 ${i+1} 镜参考上一镜尾帧">参考上一镜尾帧</button>`:""}
          <button type="button" data-script-run="${i}" aria-label="第 ${i+1} 镜生成计划">生成计划</button>`:""}
        ${i>0&&links[i-1]?`<button type="button" data-script-review="${i}" aria-label="对比镜头 ${i} 与镜头 ${i+1}">对比衔接</button>`:""}</div>`:""}</div>`).join("")}</div>`;
  $$("[data-script-shot],[data-script-tail],[data-script-run],[data-script-review]",body).forEach(button=>{
    const {scriptShot,scriptTail,scriptRun,scriptReview}=button.dataset;
    button.onpointerdown=event=>event.stopPropagation();
    button.ondblclick=event=>event.stopPropagation();
    button.onclick=()=>{
      if(scriptRun!==undefined)openScriptShotRun(n,Number(scriptRun));
      else if(scriptTail!==undefined)void linkPreviousShotFrame(n,Number(scriptTail));
      else if(scriptReview!==undefined)openShotContinuityReview(n,Number(scriptReview));
      else openScriptShot(n,Number(scriptShot));
    };
  });
  paintScriptContinuity(n,body,links);
}
function scriptCtl(n) {
  const d = n.data, has = (d.shots || []).length > 0, made = scriptShotLinks(n).filter(Boolean);
  const pill = (k, opts, label) => `<span class="pill">${label}<select data-k="${k}">${Object.entries(opts).map(([a, t]) => `<option value="${a}" ${String(a) === String(d[k]) ? "selected" : ""}>${t}</option>`).join("")}</select></span>`;
  let h = `<span class="pill model"><span class="dot" style="background:#bdbdc6"></span>Qwen 分镜</span>`;
  h += pill("nshots", { auto: "镜头数：自动", 3: "3 个镜头", 4: "4 个镜头", 6: "6 个镜头", 8: "8 个镜头" }, d.nshots === "auto" ? "自动镜数" : d.nshots + " 镜");
  h += pill("shotlen", { auto: "按动作和台词估算", 3: "偏好短镜", 5: "偏好约 5 秒", 8: "偏好约 8 秒", 10: "偏好约 10 秒", 14: "偏好约 14 秒" }, d.shotlen === "auto" ? "自动时长" : "偏好 "+d.shotlen+"s");
  h += pill("aspect", { "16:9": "16:9", "9:16": "9:16", "4:3": "4:3", "1:1": "1:1", "21:9": "21:9" }, d.aspect);
  h += pill("quality", { hd: "视频 768P", std: "视频 480P" }, d.quality === "hd" ? "768P" : "480P");
  if (has) {
    h += `<button class="pill" data-sa="expand" title="每个镜头建一张分镜图 + 一个视频节点（分栏已填好、连好人物设定）">${made.length ? "再展开一组" : "展开到画布"}</button>`;
    if (made.length) {
      if(scriptShotLinks(n).some(shotNeedsNodes))h += '<button class="pill" data-sa="missing">补齐画布节点</button>';
      h += `<button class="pill" data-sa="imgs" title="补齐未生成的分镜图，沿用已启用的白模构图参考">批量出分镜图</button>`;
      h += `<button class="pill" data-sa="vids" title="分镜图就绪的镜头依次生成视频">批量生成视频</button>`;
      h += `<button class="pill" data-sa="cat" title="打开剪辑台：调整顺序、裁剪、字幕、音乐，再导出成片">剪辑成片</button>`;
    }
  }
  return h;
}
function wireScriptCtl(n, ctl) {
  $$("button[data-sa]", ctl).forEach(b => b.onclick = () => ({ expand: expandScript, missing:expandMissingScriptShots,
    imgs: batchImages, vids: batchVideos, cat: openStoryFilm })[b.dataset.sa](n));
}
function madeShots(n) {
  const shots=n.data.shots||[];
  const positions=new Map(shots.map((shot,index)=>[shot.id,index]).filter(([id])=>id));
  return (n.data.made||[]).filter(pair=>(!pair.shot_id||positions.has(pair.shot_id))&&(node(pair.img)||node(pair.vid)))
    .sort((a,b)=>(positions.get(a.shot_id)??shots.length)-(positions.get(b.shot_id)??shots.length));
}
async function planStoryboard(n, {targetSeconds, resetLinks=false, motionFrames=false}={}) {
  const d = n.data, story = fullPrompt(n);
  if (!story.trim()) { toast("先写一段剧情"); $("#prompt").focus(); return; }
  const refs = scriptRefs(n);
  await withBusy(n, "Qwen 拆分镜中", async () => {
    const bid=boardId;
    await flushSave();
    if(boardId!==bid||node(n.id)!==n)return;
    const r = await api("/api/storyboard", { board:bid, story, refs: refs.map(({ node, pinned, ...x }) => x), shots: d.nshots === "auto" ? null : +d.nshots,
      seconds: d.shotlen === "auto" ? null : +d.shotlen, style: "", aspect: d.aspect,
      ...(motionFrames ? {motion_frames:true} : {}),
      ...(targetSeconds ? {target_seconds:targetSeconds} : {}) });
    if(node(n.id)!==n)return;
    checkpoint();ensureScriptShotIds(n);
    if(resetLinks)d.made=[];
    Object.assign(d,{title:r.title,style:r.style,characters:r.characters,shots:r.shots.map(shot=>({...shot,id:newCanvasNodeId()}))});
    save(); render(n); drawEdges();
    const total = r.planned_seconds ?? r.shots.reduce((sum,shot)=>sum+shot.duration,0);
    toast(`拆成 ${r.shots.length} 镜，计划约 ${total} 秒${llmNote(r)}`, 4000);
  });
}
function expandMissingScriptShots(n) {
  const indexes=scriptShotLinks(n).flatMap((pair,i)=>shotNeedsNodes(pair)||missingMotionFrames(n.data.shots[i],pair)?[i]:[]);
  expandScript(n,indexes);
}

function shotFrameIds(pair) {
  return [pair.img,pair.motion_frames?.middle,pair.motion_frames?.end].filter(Boolean);
}

function missingMotionFrames(shot,pair) {
  return !!shot?.motion_frames&&["middle","end"].some(phase=>!node(pair?.motion_frames?.[phase]));
}

function shotMotionFrameSettings(script,shot,phase) {
  const description=shot.motion_frames[phase]?.trim()||[...(shot.action||[]),
    phase==="end"?"动作已结束，保持最终站位和道具状态":"动作进行到中间时的姿态"].join("，");
  const moment=phase==="end"?"尾帧":"中帧";
  const assets=(shot.asset_refs||[]).filter(ref=>ref.kind!=="world"||ref.explicit).map(ref=>cmLabelledToken(ref,ref.view)).join(" ");
  const prompt=[`参考 @图{1} 延续同一镜头。锁定机位、构图、角色身份、服装、道具位置及光线，只推进动作到本帧状态。`,
    script.data.style,shot.scene,[shot.shot_size,shot.camera].filter(Boolean).join("，"),
    `${moment}画面：${description}`,assets&&"参考资产 "+assets].filter(Boolean).join("\n");
  return {prompt,caption:description,moment};
}

function makeShotMotionFrame(script,shot,settings,index,phase,prior,x,y) {
  const {moment,...data}=shotMotionFrameSettings(script,shot,phase);
  const image=addNode("image",x,y,{...data,aspect:script.data.aspect,quality:"4mp",image_ref_seq:1},
    {name:`镜${index+1} · ${moment}`});
  B.edges.push({from:prior.id,to:image.id,prompt_slot:1});
  settings.references.forEach(ref=>B.edges.push({from:ref.node.id,to:image.id,story_cast:!ref.pinned,...(ref.pinned?{ref:ref.ref}:{})}));
  return image;
}

const SCRIPT_VIDEO_DURATIONS = [5,8,10,14];
const scriptVideoDuration = desired => SCRIPT_VIDEO_DURATIONS.find(seconds=>seconds>=Number(desired||5)) ?? 14;
function scriptShotSettings(script,shot,refs=scriptRefs(script)) {
  const data=script.data;
  const refOf=name=>refs.find(ref=>ref.name===name)||refs.find(ref=>ref.name.includes(name)||name.includes(ref.name));
  const characters=shot.characters||[], cast=data.characters||[];
  const references=[...new Map(characters.map(refOf).filter(Boolean).map(ref=>[ref.node.id,ref])).values()];
  const intro=references.map((ref,i)=>`@图${i+1} 是${ref.name}`).join("，");
  const assets=(shot.asset_refs||[]).filter(ref=>ref.kind!=="world"||ref.explicit).map(ref=>cmLabelledToken(ref,ref.view)).join(" ");
  const assetLine=assets&&"参考资产 "+assets;
  const prompt=[intro&&intro+"。",data.style,shot.scene,shot.keyframe,shot.shot_size&&`${shot.shot_size}镜头`,assetLine]
    .filter(Boolean).join("，").replace(/。，/g,"。");
  const people=characters.map(name=>{
    const character=cast.find(item=>item.name===name);
    const look=character?.look||refOf(name)?.desc||"", voice=character?.voice;
    return `${name}：${look}${voice?"，声音："+voice:""}`.replace(/：$/,"");
  }).join("\n");
  const duration=scriptVideoDuration(shot.duration);
  return {references,image:{prompt,caption:shot.keyframe||""},video:{
    duration,fields:{style:data.style,scene:assetLine?[shot.scene,assetLine].filter(Boolean).join("\n"):shot.scene,people,camera:[shot.shot_size,shot.camera].filter(Boolean).join("，"),
      action:(shot.action||[]).join("\n"),dialogue:(shot.dialogue||[]).join("\n"),sound:shot.sound,music:""},
  }};
}

function applyScriptShotRevision(script,plan,{wizard=false,recordUndo=true}={}) {
  if(!canvasCanEdit())throw new Error("当前画布仅可查看");
  if(node(script.id)!==script || nodeLocked(script) || toolBusy.has(script.id))throw new Error("分镜已锁定或正在改写");
  const shots=script.data.shots||[];
  const index=plan.shot_id?shots.findIndex(shot=>shot.id===plan.shot_id):plan.shot-1;
  const shot=shots[index], same=(value,expected)=>JSON.stringify(value??null)===JSON.stringify(expected);
  if(!shot)throw new Error("镜头已移除");
  if(Object.entries(plan.changes).every(([key,value])=>same(shot[key],value)))return {index,updated:[],retained:[],already:true};
  if(!Object.entries(plan.before).every(([key,value])=>same(shot[key],value)))throw new Error("镜头内容已变化，请重新准备修改方案");
  const next={...shot,...plan.changes}, previous=scriptShotSettings(script,shot), settings=scriptShotSettings(script,next);
  const pair=scriptShotLinks(script)[index], image=node(pair?.img), video=node(pair?.vid);
  const videoPatch={}, fieldPatch={}, retained=new Set();
  const stage=(n,patch,key,current,before,after)=>{
    if(!n||before===after||current===after)return;
    if(n.job||prepping.has(n.id)||toolBusy.has(n.id))throw new Error("请等本镜的生成任务结束后再应用修改");
    if(nodeLocked(n)||current!==before){retained.add(n.name);return;}
    patch[key]=after;
  };
  const imageChanges=new Map();
  const stageImage=(target,oldSettings,newSettings)=>{
    if(!target)return;
    const patch={};
    const before=oldSettings.prompt, after=newSettings.prompt, current=target.data.prompt;
    const suffix=before&&current?.startsWith(before+"\n")?current.slice(before.length):"";
    const base=target.data.base_prompt;
    stage(target,patch,"prompt",current,before+suffix,after+suffix);
    if(base===before&&patch.prompt)patch.base_prompt=after;
    stage(target,patch,"caption",target.data.caption,oldSettings.caption,newSettings.caption);
    if(Object.keys(patch).length)imageChanges.set(target,patch);
  };
  const detach=wizard&&pair?.shared_first&&image&&previous.image.caption!==settings.image.caption;
  const middle=node(pair?.motion_frames?.middle);
  if(detach&&[video,middle].some(target=>target&&(nodeLocked(target)||target.job||prepping.has(target.id))))
    throw new Error("请先解锁镜头并等待生成完成，再修改共用首帧");
  if(pair?.shared_first&&!detach){
    if(previous.image.caption!==settings.image.caption)retained.add(image?.name||"共用首帧");
  }else if(!detach)stageImage(image,previous.image,settings.image);
  if(wizard&&shot.motion_frames&&next.motion_frames){
    for(const phase of ["middle","end"]){
      stageImage(node(pair?.motion_frames?.[phase]),shotMotionFrameSettings(script,shot,phase),
        shotMotionFrameSettings(script,next,phase));
    }
  }
  if(video){
    stage(video,videoPatch,"duration",video.data.duration,previous.video.duration,settings.video.duration);
    for(const [key,value] of Object.entries(settings.video.fields)){
      if(previous.video.fields[key]===value)continue;
      if(video.data.pmode==="fields")stage(video,fieldPatch,key,video.data.fields?.[key],previous.video.fields[key],value);
      else retained.add(video.name);
    }
  }
  if(recordUndo)checkpoint();
  ensureScriptShotIds(script);
  Object.assign(shot,plan.changes);
  const updated=[];
  const stale=new Set();
  if(detach){
    const first=addNode("image",middle?.x??image.x,(middle?.y??image.y)-size(image).h-110,
      {...settings.image,aspect:script.data.aspect,quality:"4mp"},{name:`镜${index+1} · 分镜图`});
    settings.references.forEach(ref=>B.edges.push({from:ref.node.id,to:first.id,story_cast:!ref.pinned,...(ref.pinned?{ref:ref.ref}:{})}));
    if(video){
      rememberVideoVersion(video);
      const edge=B.edges.find(entry=>entry.to===video.id&&entry.role==="first");
      if(edge){edge.from=first.id;delete edge.ref;}
      else B.edges.push({from:first.id,to:video.id,role:"first"});
    }
    if(middle){
      const guide=B.edges.find(entry=>entry.to===middle.id&&entry.prompt_slot===1);
      if(guide){guide.from=first.id;delete guide.ref;}
      else B.edges.push({from:first.id,to:middle.id,prompt_slot:1});
      stale.add(middle);
    }
    pair.img=first.id;
    pair.shared_first=false;
    updated.push(first);
  }
  for(const [target,patch] of imageChanges){
    Object.assign(target.data,patch);
    if(wizard&&patch.prompt)stale.add(target);
    updated.push(target);
  }
  const affectedPairs=wizard&&stale.size?scriptShotLinks(script).filter(Boolean):[];
  if(affectedPairs.length){
    const motionIds=new Set(affectedPairs.flatMap(item=>Object.values(item.motion_frames||{})));
    for(const source of stale)
      for(const edge of B.edges)
        if(edge.from===source.id&&edge.prompt_slot===1&&!edge.ref&&motionIds.has(edge.to)&&node(edge.to))
          stale.add(node(edge.to));
  }
  for(const target of stale)if(target.versions.length)
    target.data.storyboard_stale_refs=target.versions.map(version=>version.ref);
  if(Object.keys(videoPatch).length||Object.keys(fieldPatch).length){
    rememberVideoVersion(video);
    Object.assign(video.data,videoPatch);
    if(Object.keys(fieldPatch).length)video.data.fields={...video.data.fields,...fieldPatch};
    updated.push(video);
  }
  if(wizard){
    const staleIds=new Set([...stale].map(target=>target.id));
    const staleVideos=new Set(affectedPairs.filter(item=>shotFrameIds(item).some(id=>staleIds.has(id))).map(item=>node(item.vid)));
    if(video&&(updated.includes(video)||stale.size||detach))staleVideos.add(video);
    for(const target of staleVideos)if(target?.versions.length){
      rememberVideoVersion(target);
      target.data.storyboard_stale_refs=target.versions.map(version=>version.ref);
    }
  }
  render(script);updated.forEach(render);
  if(sel.size===1&&[script,...updated].some(n=>sel.has(n.id)))showPanel();
  drawEdges();save();
  return {index,updated,retained:[...retained],already:false};
}

function expandScript(n, indexes=null, {recordUndo=true}={}) {
  if(!canvasCanEdit() || node(n.id)!==n || nodeLocked(n))return;
  const d = n.data, shots = d.shots || []; if (!shots.length) return;
  const links=indexes?scriptShotLinks(n):null;
  const selected=indexes?[...new Set(indexes)].filter(i=>shots[i]&&(shotNeedsNodes(links[i])||missingMotionFrames(shots[i],links[i]))).sort((a,b)=>a-b):shots.map((_,i)=>i);
  if(!selected.length)return;
  if(recordUndo)checkpoint();
  ensureScriptShotIds(n);
  const refs=scriptRefs(n);
  const s0 = size(n), x0 = n.x + s0.w + 140;
  let y0 = n.y;
  (d.made||[]).forEach(x => [...shotFrameIds(x),x.vid].map(node).filter(Boolean).forEach(m => { y0 = Math.max(y0, m.y + size(m).h + 120); }));
  const made = [], newRecords=[];
  const assembled=new Map();
  let x = x0;
  selected.forEach(i => {
    const s=shots[i], pair=links?.[i];
    const settings=scriptShotSettings(n,s,refs);
    const created=[];
    let img=node(pair?.img), vid=node(pair?.vid);
    const prior=shots[i-1], previousPair=assembled.get(i-1)||links?.[i-1];
    const previousTail=node(previousPair?.motion_frames?.end);
    const continuous=s.motion_frames&&s.continues_previous===true&&prior&&previousTail&&s.scene&&
      ["scene","shot_size","camera"].every(key=>s[key]===prior[key]);
    if(!img&&continuous)img=previousTail;
    if(!img){
      const composition=s.frame?.source==="previs-frame" ? {previs_composition:{ref:s.frame.ref}} : {};
      img=addNode("image",x,y0,{...settings.image,...composition,aspect:d.aspect,quality:"4mp"},{name:`镜${i+1} · 分镜图`});
      if(s.frame){
        const {ref,w,h}=s.frame;
        const source=s.frame.source==="previs-frame" ? "previs-frame" : "frame";
        img.versions.push({ref,url:"/media?ref="+encodeURIComponent(ref),w,h,source,prompt:""});
        img.cur=0;
      }
      settings.references.forEach(r=>B.edges.push({from:r.node.id,to:img.id,story_cast:!r.pinned,...(r.pinned?{ref:r.ref}:{})}));
      created.push(img);
    }
    let nextY=y0+(created.length?Math.max(size(img).h,300)+110:0);
    const motionFrames={};
    let priorFrame=img;
    for(const phase of ["middle","end"]){
      if(!s.motion_frames)break;
      const frame=node(pair?.motion_frames?.[phase])||
        makeShotMotionFrame(n,s,settings,i,phase,priorFrame,x,nextY);
      if(!node(pair?.motion_frames?.[phase])){
        created.push(frame);
        nextY+=Math.max(size(frame).h,300)+110;
      }else if(!B.edges.some(edge=>edge.to===frame.id&&edge.prompt_slot===1)){
        B.edges.push({from:priorFrame.id,to:frame.id,prompt_slot:1});
      }
      motionFrames[phase]=frame.id;
      priorFrame=frame;
    }
    if(!vid){
      const provider=s.motion_frames&&CAPS_LIST.video?.some(item=>item.id==="local_h3")?"local_h3":undefined;
      vid=addNode("video",x,nextY,{...settings.video,quality:d.quality,aspect:d.aspect,pmode:"fields",
        ...(provider?{provider}:{})},{name:`镜${i+1}`});
      B.edges.push({from:img.id,to:vid.id,role:"first"});
      for(const r of settings.references){
        if(r.node.id!==img.id)B.edges.push({from:r.node.id,to:vid.id,role:"subject",story_cast:!r.pinned,...(r.pinned?{ref:r.ref}:{})});
      }
      created.push(vid);
    }
    if(s.motion_frames){
      for(const [id,role,time] of [[img.id,"first"],[motionFrames.middle,"keyframe",Math.floor(settings.video.duration/2)],[motionFrames.end,"last"]]){
        if(id&&!B.edges.some(edge=>edge.to===vid.id&&(edge.from===id||role==="first"&&edge.role==="first")))
          B.edges.push({from:id,to:vid.id,role,...(time!=null?{time}:{})});
      }
    }
    const record={img:img.id,vid:vid.id,shot_id:s.id,
      ...(s.motion_frames?{motion_frames:motionFrames,shared_first:img===previousTail}:{})};
    if(pair)Object.assign(pair,record);
    else newRecords.push(record);
    made.push(record);
    assembled.set(i,record);
    x+=Math.max(...created.map(m=>size(m).w),size(img).w)+80;
  });
  d.made = [...(d.made||[]).filter(pair=>node(pair.img)||node(pair.vid)), ...newRecords];
  B.nodes.forEach(m => render(m)); drawEdges(); save();
  sel = new Set(made.flatMap(m => [m.img, m.vid])); updateSel();
  fit([n, ...made.flatMap(m => [node(m.img), node(m.vid)])]);
  const need = made.some(m => shotFrameIds(m).some(id=>!storyboardFrameReady(node(id))));
  toast(`已展开 ${made.length} 个镜头。${need ? "点「批量出分镜图」生成分镜图，满意后" : "分镜图已就位，"}点「批量生成视频」。每个镜头的分栏都可以单独改`, 5000);
}
async function batchImages(n) {
  const board=B;
  const shots=madeShots(n);
  const todo = [...new Set(shots.flatMap(shotFrameIds))].map(node)
    .filter(m => m && !storyboardFrameReady(m) && !m.job && !prepping.has(m.id));
  if (!todo.length) return toast("分镜图都已经生成了；想重画某一张就选中它单独生成");
  if(shots.some(pair=>pair.motion_frames))return openCanvasSelectionRun(todo);
  let queued=0;
  for (const m of todo){
    if(B!==board || node(n.id)!==n)return;
    if(node(m.id)!==m || !fullPrompt(m))continue;
    await generate(m);
    if(m.job)queued++;
  }
  if(B!==board || node(n.id)!==n)return;
  const skipped=todo.length-queued;
  toast(`已提交 ${queued} 张分镜图${skipped?`，${skipped} 张未提交，请检查提示词或参考图`:""}`,3000);
}
async function batchVideos(n) {
  const board=B, all = madeShots(n), ready = [], wait = [];
  for (const x of all) { const v = node(x.vid); if (!v || v.job || storyboardVersionReady(v)) continue;
    const shot=n.data.shots.find(item=>item.id===x.shot_id);
    (node(x.img)&&!missingMotionFrames(shot,x)&&shotFrameIds(x).every(id=>node(id)&&storyboardFrameReady(node(id))) ? ready : wait).push(v); }
  if (!ready.length) return toast(wait.length ? "分镜图还没生成好，先点「批量出分镜图」" : "视频都已经生成了；想重做某一镜就选中它单独生成");
  let queued=0;
  for (const v of ready) {
    if(B!==board||node(n.id)!==n)return;
    if(node(v.id)!==v)continue;
    await generate(v);
    if(v.job)queued++;
  }
  if(B!==board||node(n.id)!==n)return;
  const failed=ready.length-queued;
  const status=[queued?`已排队 ${queued} 段视频`:"",failed?`${failed} 段未提交，可查看失败原因后重试`:"",wait.length?`${wait.length} 镜等待分镜图`:""];
  toast(status.filter(Boolean).join("，"),4000);
}

// ================================================================= asset library (characters / scenes / props)
let libCache = null;
async function loadLibrary() { return cmList(); }
async function renderLibrary(kind) { return cmRenderLibrary(kind); }

const libraryPlacementRequests = new Set();
function placeLibraryAsset(asset, at, onPlaced, onError=message=>toast(message)) {
  const bid = boardId, board = B;
  const place = current => {
    if (B !== board || !canvasCanEdit()) return;
    try { const placed = placeLibAsset(current,at); onPlaced?.(); return placed; }
    catch (error) { onError(error.message); }
  };
  if (!asset.team && (asset.ref || !asset.document || typeof asset.document.text === "string")) return place(asset);
  const path = "/api/memory/" + encodeURIComponent(asset.id) + "?board=" + encodeURIComponent(bid);
  if (libraryPlacementRequests.has(path)) return;
  libraryPlacementRequests.add(path);
  return boardRequest(path).then(detail=>{
    if (!detail.ref && detail.document && typeof detail.document.text !== "string") throw new Error("资产正文已变更，请刷新资产库");
    return place(detail);
  }).catch(error=>{if (B === board) onError(error.message);})
    .finally(()=>libraryPlacementRequests.delete(path));
}

function libraryPrimary(a) {
  return a.ref ? a : (a.media || []).find(m=>["video","audio"].includes(cmMediaType(m.ref,m)));
}

function libraryNodeSpec(a, media=libraryPrimary(a)) {
  const ref=media?.ref;
  const asset={id:a.id,kind:a.kind};
  if (!ref) {
    const sourceDoc = a.document;
    const content = sourceDoc?.format ? sourceDoc.text : [a.desc, sourceDoc?.text, a.constraints && "使用约束：" + a.constraints].filter(Boolean).join("\n\n");
    if (content.length > 20_000) throw new Error("正文超过单个画布文档的 20,000 字符上限，可在资产库查看全文");
    const data={text:content,...(sourceDoc?.format==="markdown"?{text_format:"markdown"}:{}),asset};
    return {type:"text",name:a.name,data,versions:[],cur:-1};
  }
  const type=a.ref===ref?"image":cmMediaType(ref,media);
  const data={caption:a.desc||"",aspect:"auto",asset};
  const version={ref,url:"/media?ref="+encodeURIComponent(ref),w:media.w,h:media.h,seconds:media.seconds,source:"asset",prompt:""};
  return {type,name:a.name,data,versions:[version],cur:0};
}

function buildCanvasMediaNode(spec, at) {
  const {type,data,name,versions,cur,id}=spec;
  const n=addNode(type,at.x,at.y,data,{name,versions,cur,...(id?{id}:{})});
  const version=curV(n);
  if (type==="video" && (!version.w || !version.h || !version.seconds)
    || type==="audio" && !version.seconds) {
    const probe = document.createElement(type), bid = boardId;
    probe.preload = "metadata";
    probe.onloadedmetadata = () => {
      if (boardId === bid && node(n.id) === n) {
        if(probe.videoWidth && probe.videoHeight){version.w=probe.videoWidth;version.h=probe.videoHeight;}
        if(Number.isFinite(probe.duration) && probe.duration>0)version.seconds=probe.duration;
        render(n);save();
      }
      probe.onloadedmetadata = probe.onerror = null; probe.removeAttribute("src");
    };
    probe.onerror = () => { probe.onloadedmetadata = probe.onerror = null; probe.removeAttribute("src"); };
    probe.src = version.url;
  }
  return n;
}

function placeLibAsset(a, at) {
  const spec=libraryNodeSpec(a);
  checkpoint();
  const n=buildCanvasMediaNode(spec,at);
  selectOnly(n.id);
  return n;
}

function placeLibraryBatch(items, at) {
  return placeCanvasNodeBatch(items.map(libraryNodeSpec),at);
}
function placeCanvasNodeBatch(specs, at) {
  if(!specs.length)return [];
  checkpoint();
  const made=[];
  let x=at.x,y=at.y,rowEnd=y;
  for(const spec of specs){
    const version=spec.versions[spec.cur];
    const dims=spec.type==="video" && (!version?.w || !version?.h)
      ? {w:520,h:970}:size({...spec,data:{...defaults(spec.type),...spec.data}});
    const spot=freeSpot(x,y,spec.type,dims);
    made.push(buildCanvasMediaNode(spec,spot));
    x=spot.x+dims.w+100;
    rowEnd=Math.max(rowEnd,spot.y+dims.h+90);
    if(made.length%3===0){x=at.x;y=rowEnd;}
  }
  sel=new Set(made.map(n=>n.id));
  updateSel();drawEdges();save();
  return made;
}
// ================================================================= wiring (called by the main script)
function initTools() {
  cmInit();
  // "/" in an image node's prompt opens the tool menu
  $("#prompt").addEventListener("input", e => {
    const n = node(e.target._node); if (!n || n.type !== "image") return;
    const ta = e.target, i = ta.selectionStart;
    if (e.isComposing) return;
    if (e.inputType === "insertText" && e.data === "/" && (i === 1 || /\s/.test(ta.value[i - 2]))) openSlash(n, true);
    else if (slashState) renderSlash();
  });
  $("#prompt").addEventListener("keydown",slashKeys,true);
  document.addEventListener("pointerdown",event=>{
    if(slashState && !event.target.closest("#prompt,#slashBtn,#slashMenu"))closeSlash();
  });
  document.addEventListener("pointerdown", e => { if (!e.target.closest("#anglePop, [data-sa], #slashBtn")) $("#anglePop").classList.remove("on"); });
  // drop a library asset on the canvas
  vp.addEventListener("drop", e => { const a = e.dataTransfer.getData("application/x-h3-lib"); if (a) { e.stopImmediatePropagation(); e.preventDefault(); placeLibraryAsset(JSON.parse(a), toW(e.clientX, e.clientY)); } }, true);
}
