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
    const scope = n.data.asset?.id ? {} : cmNewScope(bid);
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
  return imgInputs(n).map(m => ({ m, v: curV(m) })).filter(x => x.v)
    .map(x => ({ node: x.m, name: x.m.name, ref: x.v.ref, desc: x.m.data.caption || "", kind: x.m.data.asset?.kind || "" }));
}
function renderScript(n, body) {
  const d = n.data, shots = d.shots || [];
  if (!shots.length) {
    body.innerHTML = `<div class="ph">${ico("script")}<div class="t">分镜脚本<br>选中后写剧情，连入角色 / 场景图片<br>由 Qwen 拆成一组镜头，再一键生成分镜图和视频</div></div>`;
    return;
  }
  const total = shots.reduce((a, s) => a + (s.duration || 0), 0);
  body.innerHTML = `<div class="sb"><div class="sbh"><b>${esc(d.title || "分镜")}</b><span>${shots.length} 镜 · ${total}s</span></div>
    ${d.style ? `<div class="sbs">${esc(d.style)}</div>` : ""}
    ${shots.map((s, i) => `<div class="shot"><div class="sh1"><span class="no">${i + 1}</span>${s.frame ? `<img src="/media?ref=${encodeURIComponent(s.frame.ref)}">` : ""}<span>${esc(s.shot_size)}</span><span class="dim">${esc(s.camera)}</span><span class="du">${s.duration}s</span></div>
      ${s.action.length ? `<div class="sa">${s.action.map(esc).join("<br>")}</div>` : ""}
      ${s.dialogue.length ? `<div class="sd">${s.dialogue.map(esc).join("<br>")}</div>` : ""}</div>`).join("")}</div>`;
}
function scriptCtl(n) {
  const d = n.data, has = (d.shots || []).length > 0, made = madeShots(n);
  const pill = (k, opts, label) => `<span class="pill">${label}<select data-k="${k}">${Object.entries(opts).map(([a, t]) => `<option value="${a}" ${String(a) === String(d[k]) ? "selected" : ""}>${t}</option>`).join("")}</select></span>`;
  let h = `<span class="pill model"><span class="dot" style="background:#bdbdc6"></span>Qwen 分镜</span>`;
  h += pill("nshots", { auto: "镜头数：自动", 3: "3 个镜头", 4: "4 个镜头", 6: "6 个镜头", 8: "8 个镜头" }, d.nshots === "auto" ? "自动镜数" : d.nshots + " 镜");
  h += pill("shotlen", { auto: "每镜时长：自动", 3: "每镜 3 秒", 5: "每镜 5 秒", 8: "每镜 8 秒" }, d.shotlen === "auto" ? "自动时长" : d.shotlen + "s/镜");
  h += pill("aspect", { "16:9": "16:9", "9:16": "9:16", "4:3": "4:3", "1:1": "1:1", "21:9": "21:9" }, d.aspect);
  h += pill("quality", { hd: "视频 768P", std: "视频 480P" }, d.quality === "hd" ? "768P" : "480P");
  if (has) {
    h += `<button class="pill" data-sa="expand" title="每个镜头建一张分镜图 + 一个视频节点（分栏已填好、连好人物设定）">${made.length ? "再展开一组" : "展开到画布"}</button>`;
    if (made.length) {
      h += `<button class="pill" data-sa="imgs" title="依次生成还没有画面的分镜图">批量出分镜图</button>`;
      h += `<button class="pill" data-sa="vids" title="分镜图就绪的镜头依次生成视频">批量生成视频</button>`;
      h += `<button class="pill" data-sa="cat" title="打开剪辑台：调整顺序、裁剪、字幕、音乐，再导出成片">剪辑成片</button>`;
    }
  }
  return h;
}
function wireScriptCtl(n, ctl) {
  $$("button[data-sa]", ctl).forEach(b => b.onclick = () => ({ expand: expandScript, imgs: batchImages, vids: batchVideos, cat: s => concatVideos(madeShots(s).map(x => node(x.vid)), s) })[b.dataset.sa](n));
}
const madeShots = n => (n.data.made || []).filter(x => node(x.img) || node(x.vid));
async function planStoryboard(n) {
  const d = n.data, story = fullPrompt(n);
  if (!story.trim()) { toast("先写一段剧情"); $("#prompt").focus(); return; }
  const refs = scriptRefs(n);
  await withBusy(n, "Qwen 拆分镜中", async () => {
    const r = await api("/api/storyboard", { story, refs: refs.map(({ node, ...x }) => x), shots: d.nshots === "auto" ? null : +d.nshots,
      seconds: d.shotlen === "auto" ? null : +d.shotlen, style: "", aspect: d.aspect });
    checkpoint(); Object.assign(d, { title: r.title, style: r.style, characters: r.characters, shots: r.shots });
    save(); render(n); drawEdges();
    toast(`拆成 ${r.shots.length} 个镜头（${r.seconds}s）${llmNote(r)}${$("#wiz")?.classList.contains("on") ? "，可以直接修改每个镜头" : "，满意就点「展开到画布」"}`, 4000);
  });
}
function expandScript(n) {
  const d = n.data, shots = d.shots || []; if (!shots.length) return;
  checkpoint();
  const refs = scriptRefs(n), look = Object.fromEntries((d.characters || []).map(c => [c.name, c.look])), voice = Object.fromEntries((d.characters || []).map(c => [c.name, c.voice]));
  const refOf = name => refs.find(r => r.name === name || r.name.includes(name) || name.includes(r.name));
  const s0 = size(n), x0 = n.x + s0.w + 140;
  let y0 = n.y;
  madeShots(n).forEach(x => [x.img, x.vid].map(node).filter(Boolean).forEach(m => { y0 = Math.max(y0, m.y + size(m).h + 120); }));
  const vlen = s => [5, 8, 10, 14].reduce((a, b) => Math.abs(b - s) < Math.abs(a - s) ? b : a);   // H3: 5.2 .. 14.4 s
  const made = [];
  let x = x0;
  shots.forEach((s, i) => {
    const who = (s.characters || []).map(refOf).filter(Boolean);
    const uniq = [...new Map(who.map(r => [r.node.id, r])).values()];
    // keyframe image: references (@图k) are the linked character images, in link order
    const intro = uniq.map((r, k) => `@图${k + 1} 是${r.name}`).join("，");
    const imgPrompt = [intro && intro + "。", d.style, s.scene, s.keyframe, s.shot_size && `${s.shot_size}镜头`].filter(Boolean).join("，").replace(/。，/g, "。");
    const img = addNode("image", x, y0, { prompt: imgPrompt, aspect: d.aspect, quality: "4mp", caption: s.keyframe }, { name: `镜${i + 1} · 分镜图` });
    if (s.frame) { img.versions.push({ ref: s.frame.ref, url: "/media?ref=" + encodeURIComponent(s.frame.ref), w: s.frame.w, h: s.frame.h, source: "frame", prompt: "" }); img.cur = 0; }
    uniq.forEach(r => B.edges.push({ from: r.node.id, to: img.id }));
    const people = (s.characters || []).map(c => `${c}：${look[c] || refOf(c)?.desc || ""}${voice[c] ? "，声音：" + voice[c] : ""}`.replace(/：$/, "")).join("\n");
    const vid = addNode("video", x, y0 + Math.max(size(img).h, 300) + 110, {
      duration: vlen(s.duration || 5), quality: d.quality, aspect: d.aspect, pmode: "fields",
      fields: { style: d.style, scene: s.scene, people, camera: [s.shot_size, s.camera].filter(Boolean).join("，"), action: s.action.join("\n"), dialogue: s.dialogue.join("\n"), sound: s.sound, music: "" },
    }, { name: `镜${i + 1}` });
    B.edges.push({ from: img.id, to: vid.id, role: "first" });
    uniq.forEach(r => B.edges.push({ from: r.node.id, to: vid.id, role: "subject" }));
    made.push({ img: img.id, vid: vid.id });
    x += Math.max(size(img).w, size(vid).w) + 80;
  });
  d.made = [...madeShots(n), ...made];
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

function placeLibAsset(a, at) {
  const playable=!a.ref && (a.media || []).find(m=>["video","audio"].includes(cmMediaType(m.ref,m)));
  const ref=a.ref || playable?.ref;
  if (!ref) {
    const sourceDoc = a.document;
    const content = sourceDoc?.format ? sourceDoc.text : [a.desc, sourceDoc?.text, a.constraints && "使用约束：" + a.constraints].filter(Boolean).join("\n\n");
    if (content.length > 20_000) throw new Error("正文超过单个画布文档的 20,000 字符上限，可在资产库查看全文");
    checkpoint();
    const n = addNode("text", at.x, at.y, {text:content,...(sourceDoc?.format === "markdown" ? {text_format:"markdown"} : {}),asset:{id:a.id,kind:a.kind}}, {name:a.name});
    render(n); save(); selectOnly(n.id); return n;
  }
  checkpoint();
  const type=playable?cmMediaType(ref,playable):"image";
  const n = addNode(type, at.x, at.y, { caption: a.desc || "", aspect: "auto" }, { name: a.name });
  n.data.asset = { id: a.id, kind: a.kind };
  const version = { ref, url: "/media?ref=" + encodeURIComponent(ref), w: a.w || playable?.w, h: a.h || playable?.h, seconds:playable?.seconds, source: "asset", prompt: "" };
  n.versions.push(version); n.cur = 0;
  render(n); save(); selectOnly(n.id);
  if (type==="video" && (!version.w || !version.h)) {
    const probe = document.createElement("video"), bid = boardId;
    probe.preload = "metadata";
    probe.onloadedmetadata = () => {
      if (boardId === bid && node(n.id) === n) { version.w = probe.videoWidth; version.h = probe.videoHeight; if(Number.isFinite(probe.duration))version.seconds = probe.duration; render(n); save(); }
      probe.onloadedmetadata = probe.onerror = null; probe.removeAttribute("src");
    };
    probe.onerror = () => { probe.onloadedmetadata = probe.onerror = null; probe.removeAttribute("src"); };
    probe.src = version.url;
  }
  return n;
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
