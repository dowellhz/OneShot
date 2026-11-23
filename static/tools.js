"use strict";
// Canvas tools: storyboard script node, "/" image tools, grid split, HD redraw, 反推, 拉片, concat, asset library.
// Loaded before the main script; only declarations here. The main script calls initTools() before it boots.

const KIND_CN = { character: "角色", scene: "场景", prop: "道具", style: "风格", document: "资料" };
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

function renderScript(n, body) {
  const d = n.data, shots = d.shots || [];
  if (!shots.length) {
    body.innerHTML = `<div class="ph">${ico("script")}<div class="t">分镜脚本<br>选中后写剧情，连入角色 / 场景图片<br>由 Qwen 拆成一组镜头，再一键生成分镜图和视频</div></div>`;
    return;
  }
  const total = shots.reduce((a, s) => a + (s.duration || 0), 0);
  const links=scriptShotLinks(n);
  body.innerHTML = `<div class="sb"><div class="sbh"><b>${esc(d.title || "分镜")}</b><span>${shots.length} 镜 · ${total}s</span></div>
    ${d.style ? `<div class="sbs">${esc(d.style)}</div>` : ""}
    ${shots.map((s, i) => `<div class="shot"><div class="sh1"><span class="no">${i + 1}</span>${s.frame ? `<img src="/media?ref=${encodeURIComponent(s.frame.ref)}">` : ""}<span>${esc(s.shot_size)}</span><span class="dim">${esc(s.camera)}</span><span class="du">${s.duration}s</span>
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
      h += `<button class="pill" data-sa="imgs" title="依次生成还没有画面的分镜图">批量出分镜图</button>`;
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
async function planStoryboard(n, {targetSeconds, resetLinks=false}={}) {
  const d = n.data, story = fullPrompt(n);
  if (!story.trim()) { toast("先写一段剧情"); $("#prompt").focus(); return; }
  const refs = scriptRefs(n);
  await withBusy(n, "Qwen 拆分镜中", async () => {
    const r = await api("/api/storyboard", { story, refs: refs.map(({ node, pinned, ...x }) => x), shots: d.nshots === "auto" ? null : +d.nshots,
      seconds: d.shotlen === "auto" ? null : +d.shotlen, style: "", aspect: d.aspect,
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
  const indexes=scriptShotLinks(n).flatMap((pair,i)=>shotNeedsNodes(pair)?[i]:[]);
  expandScript(n,indexes);
}

const SCRIPT_VIDEO_DURATIONS = [5,8,10,14];
const scriptVideoDuration = desired => SCRIPT_VIDEO_DURATIONS.find(seconds=>seconds>=Number(desired||5)) ?? 14;
function scriptShotSettings(script,shot,refs=scriptRefs(script)) {
  const data=script.data;
  const refOf=name=>refs.find(ref=>ref.name===name)||refs.find(ref=>ref.name.includes(name)||name.includes(ref.name));
  const characters=shot.characters||[], cast=data.characters||[];
  const references=[...new Map(characters.map(refOf).filter(Boolean).map(ref=>[ref.node.id,ref])).values()];
  const intro=references.map((ref,i)=>`@图${i+1} 是${ref.name}`).join("，");
  const prompt=[intro&&intro+"。",data.style,shot.scene,shot.keyframe,shot.shot_size&&`${shot.shot_size}镜头`]
    .filter(Boolean).join("，").replace(/。，/g,"。");
  const people=characters.map(name=>{
    const character=cast.find(item=>item.name===name);
    const look=character?.look||refOf(name)?.desc||"", voice=character?.voice;
    return `${name}：${look}${voice?"，声音："+voice:""}`.replace(/：$/,"");
  }).join("\n");
  const duration=scriptVideoDuration(shot.duration);
  return {references,image:{prompt,caption:shot.keyframe||""},video:{
    duration,fields:{style:data.style,scene:shot.scene,people,camera:[shot.shot_size,shot.camera].filter(Boolean).join("，"),
      action:(shot.action||[]).join("\n"),dialogue:(shot.dialogue||[]).join("\n"),sound:shot.sound,music:""},
  }};
}

function applyScriptShotRevision(script,plan) {
  if(node(script.id)!==script || nodeLocked(script) || toolBusy.has(script.id))throw new Error("分镜已锁定或正在改写");
  const shots=script.data.shots||[];
  const index=plan.shot_id?shots.findIndex(shot=>shot.id===plan.shot_id):plan.shot-1;
  const shot=shots[index], same=(value,expected)=>JSON.stringify(value??null)===JSON.stringify(expected);
  if(!shot)throw new Error("镜头已移除");
  if(Object.entries(plan.changes).every(([key,value])=>same(shot[key],value)))return {index,updated:[],retained:[],already:true};
  if(!Object.entries(plan.before).every(([key,value])=>same(shot[key],value)))throw new Error("镜头内容已变化，请重新准备修改方案");
  const next={...shot,...plan.changes}, previous=scriptShotSettings(script,shot), settings=scriptShotSettings(script,next);
  const pair=scriptShotLinks(script)[index], image=node(pair?.img), video=node(pair?.vid);
  const imagePatch={}, videoPatch={}, fieldPatch={}, retained=new Set();
  const stage=(n,patch,key,current,before,after)=>{
    if(!n||before===after||current===after)return;
    if(n.job||prepping.has(n.id)||toolBusy.has(n.id))throw new Error("请等本镜的生成任务结束后再应用修改");
    if(nodeLocked(n)||current!==before){retained.add(n.name);return;}
    patch[key]=after;
  };
  if(image){
    const before=previous.image.prompt, after=settings.image.prompt, current=image.data.prompt;
    const suffix=before&&current?.startsWith(before+"\n")?current.slice(before.length):"";
    stage(image,imagePatch,"prompt",current,before+suffix,after+suffix);
    stage(image,imagePatch,"caption",image.data.caption,previous.image.caption,settings.image.caption);
  }
  if(video){
    stage(video,videoPatch,"duration",video.data.duration,previous.video.duration,settings.video.duration);
    for(const [key,value] of Object.entries(settings.video.fields)){
      if(previous.video.fields[key]===value)continue;
      if(video.data.pmode==="fields")stage(video,fieldPatch,key,video.data.fields?.[key],previous.video.fields[key],value);
      else retained.add(video.name);
    }
  }
  checkpoint();ensureScriptShotIds(script);
  Object.assign(shot,plan.changes);
  const updated=[];
  if(Object.keys(imagePatch).length){Object.assign(image.data,imagePatch);updated.push(image);}
  if(Object.keys(videoPatch).length||Object.keys(fieldPatch).length){
    rememberVideoVersion(video);
    Object.assign(video.data,videoPatch);
    if(Object.keys(fieldPatch).length)video.data.fields={...video.data.fields,...fieldPatch};
    updated.push(video);
  }
  render(script);updated.forEach(render);
  if(sel.size===1&&[script,...updated].some(n=>sel.has(n.id)))showPanel();
  drawEdges();save();
  return {index,updated,retained:[...retained],already:false};
}

function expandScript(n, indexes=null) {
  if(!canvasCanEdit() || node(n.id)!==n || nodeLocked(n))return;
  const d = n.data, shots = d.shots || []; if (!shots.length) return;
  const links=indexes?scriptShotLinks(n):null;
  const selected=indexes?[...new Set(indexes)].filter(i=>shots[i]&&shotNeedsNodes(links[i])):shots.map((_,i)=>i);
  if(!selected.length)return;
  checkpoint();ensureScriptShotIds(n);
  const refs=scriptRefs(n);
  const s0 = size(n), x0 = n.x + s0.w + 140;
  let y0 = n.y;
  (d.made||[]).forEach(x => [x.img, x.vid].map(node).filter(Boolean).forEach(m => { y0 = Math.max(y0, m.y + size(m).h + 120); }));
  const made = [], newRecords=[];
  let x = x0;
  selected.forEach(i => {
    const s=shots[i], pair=links?.[i];
    const settings=scriptShotSettings(n,s,refs);
    const created=[];
    let img=node(pair?.img), vid=node(pair?.vid);
    if(!img){
      img=addNode("image",x,y0,{...settings.image,aspect:d.aspect,quality:"4mp"},{name:`镜${i+1} · 分镜图`});
      if(s.frame){img.versions.push({ref:s.frame.ref,url:"/media?ref="+encodeURIComponent(s.frame.ref),w:s.frame.w,h:s.frame.h,source:"frame",prompt:""});img.cur=0;}
      settings.references.forEach(r=>B.edges.push({from:r.node.id,to:img.id,...(r.pinned?{ref:r.ref}:{})}));
      created.push(img);
    }
    if(!vid){
      const offset=created.length?Math.max(size(img).h,300)+110:0;
      vid=addNode("video",x,y0+offset,{...settings.video,quality:d.quality,aspect:d.aspect,pmode:"fields"},{name:`镜${i+1}`});
      B.edges.push({from:img.id,to:vid.id,role:"first"});
      for(const r of settings.references){
        if(r.node.id!==img.id)B.edges.push({from:r.node.id,to:vid.id,role:"subject",...(r.pinned?{ref:r.ref}:{})});
      }
      created.push(vid);
    }
    const record={img:img.id,vid:vid.id,shot_id:s.id};
    if(pair)Object.assign(pair,record);
    else newRecords.push(record);
    made.push(record);
    x+=Math.max(...created.map(m=>size(m).w))+80;
  });
  d.made = [...(d.made||[]).filter(pair=>node(pair.img)||node(pair.vid)), ...newRecords];
  B.nodes.forEach(m => render(m)); drawEdges(); save();
  sel = new Set(made.flatMap(m => [m.img, m.vid])); updateSel();
  fit([n, ...made.flatMap(m => [node(m.img), node(m.vid)])]);
  const need = made.filter(m => !curV(node(m.img))).length;
  toast(`已展开 ${made.length} 个镜头。${need ? "点「批量出分镜图」生成分镜图，满意后" : "分镜图已就位，"}点「批量生成视频」。每个镜头的分栏都可以单独改`, 5000);
}
async function batchImages(n) {
  const todo = madeShots(n).map(x => node(x.img)).filter(m => m && !curV(m) && !m.job);
  if (!todo.length) return toast("分镜图都已经生成了；想重画某一张就选中它单独生成");
  for (const m of todo) await generate(m);
  toast(`已排队 ${todo.length} 张分镜图（每张约 ${IMG_T.mp4} 秒）`, 3000);
}
async function batchVideos(n) {
  const all = madeShots(n), ready = [], wait = [];
  for (const x of all) { const v = node(x.vid), im = node(x.img); if (!v || v.job || curV(v)) continue; (im && curV(im) ? ready : wait).push(v); }
  if (!ready.length) return toast(wait.length ? "分镜图还没生成好，先点「批量出分镜图」" : "视频都已经生成了；想重做某一镜就选中它单独生成");
  for (const v of ready) await generate(v);
  toast(`已排队 ${ready.length} 段视频${wait.length ? `，另有 ${wait.length} 镜等分镜图` : ""}；全部完成后点「拼接成片」`, 4000);
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
