"use strict";

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
