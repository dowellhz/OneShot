"use strict";

const CREATIVE_APPS = [
  {id:"storyboard", name:"短片分镜策划", category:"策划", icon:"script", template:"starter-storyboard", templateBrief:["n1","text"],
    description:"把创作简报拆成带时长和镜头动作的分镜表。",
    fields:["故事或创作目的","目标时长与镜头数","画幅和风格"],
    example:["凌晨最后一班渡船启程。一位修伞师把修好的旧伞送到码头，乘客在舷梯前接过伞。","15 秒，3 个镜头","16:9，冷色调，安静的纪实感"],
    output:["第 1 镜 · 4 秒 · 远景建立码头和即将离开的渡船。","第 2 镜 · 6 秒 · 中近景跟随修伞师奔向舷梯。","第 3 镜 · 5 秒 · 手部特写完成交接，切到船缓缓离岸。"],
    work:"按镜头给出时长、景别、机位、动作、声音及首帧要点，合计时长须符合要求。将 Markdown 分镜表保存为一个文本节点。先交付分镜，不提交生图或生视频。"},
  {id:"product", name:"商品主视觉套图", category:"图片", icon:"image", template:"starter-product", templateBrief:["n1","text"], media:["image","product.webp"],
    description:"从同一商品参考规划并生成主图、横幅和竖版图。",
    fields:["商品名称和已确认的卖点","投放渠道与画幅","必须保留的外观、颜色或标识"],
    example:["蓝橙配色的桌面产品，突出清楚的轮廓和材质。","电商主图 1:1、横幅 16:9、竖版 9:16","白色影棚，保留蓝橙配色，留出文案空间。"],
    output:["方形主图突出完整轮廓，横幅把产品放在画面右侧，竖图保留上方文案区。"],
    work:"优先使用本轮引用的商品图；没有参考图且要求外观一致时，先请我引用。为各画幅分别写构图，保持真实卖点和包装一致。提交套图前显示确认卡。"},
  {id:"character", name:"角色造型与连续性", category:"图片", icon:"assets", template:"starter-character", templateBrief:["n1","prompt"],
    description:"制定角色卡与参考图清单，或核对已有镜头的造型。",
    fields:["角色、参考素材或需要核对的镜头","需要保持一致的细节"],
    example:["为渡船修伞师制定角色资料。她约三十岁，穿深蓝工装，佩戴左手银戒指。","坚持短发和深蓝工装。戒指位置以角色本人的左右为准。"],
    output:["一张标准全身主图，一个包含固定细节和允许变化的角色卡，一份头肩、侧面、背面与细节参考清单。"],
    work:"如有引用角色资产，先读取角色卡和已定稿主图。分开记录固定锚点与可变表演，并按约定规格设计各角度。在画布保存角色卡与参考清单，等我确认后再生成图片。"},
  {id:"previs", name:"机位与走位白模", category:"视频", icon:"motion", media:["video","previs.mp4"],
    description:"搭出可编辑的 3D 白模，检查人物位置和镜头路径。",
    fields:["场景、演员、道具与动作","时长、画幅和机位运动"],
    example:["两名演员在长桌两侧碰面，左侧演员沿桌边走向出口，右侧演员留在原地。","3 秒，16:9。相机缓慢向右平移，持续看到两人和桌子。"],
    output:["可编辑的白模场景带人物、桌子、相机及时间轴关键帧。"],
    work:"使用画布白模工具创建可编辑场景，按时间写出人物走位和相机关键帧。保留素材、解释机位与构图取舍。先保存白模场景，等我检查后再渲染。"},
  {id:"broll", name:"动态字幕与图表", category:"视频", icon:"motion", media:["video","broll.mp4"],
    description:"在来源视频上加动态图形，也可把静止图片做成推拉镜头。",
    fields:["画面内容和图表数据","显示时段和样式"],
    example:["为本轮引用的视频制作条形图，标题为月度订单。三月 10，四月 20，五月 30。","在第 0.25–1.5 秒显示，深色卡片，保留原片时长和原声。"],
    output:["独立视频节点连回所选版本，图表只在指定时段显示。"],
    work:"需要来源时先让我引用具体图片或视频版本。图表只采用给出的数字。确认卡列出来源版本、时间、类型和内容，确认后生成相连的新视频。"},
  {id:"remake", name:"视频换角重制", category:"视频", icon:"video",
    description:"分析已有视频并制定换角计划，分镜审核后逐步重制。",
    fields:["要换掉的人物与目标角色资产","需要保留的镜头、动作和声音"],
    example:["把已引用原片里的吧台店员替换成资产库中的修伞师。","保留机位、手部动作、道具和原声。先列出需要换角的镜头。"],
    output:["逐镜列出角色位置、待核对的选区、保留原片的镜头和首帧检查项。"],
    work:"先核对明确引用的源片及目标角色，资料缺失时向我确认。使用重制流程分析并展示计划，让我选镜头和校正选区。没有确认前不要提交首帧或视频生成。"},
  {id:"review", name:"逐镜制作复盘", category:"策划", icon:"script",
    description:"从保存的版本和输入连线追溯制作步骤。",
    fields:["需要复盘的镜头或版本","输出用途和关注点"],
    example:["复盘本轮引用的两个视频版本，说明各自的输入、生成参数和剪辑改动。","写成可交接的 Markdown，标记无法追溯的项目。"],
    output:["按镜头列出来源版本、实际保存的参数、有效素材、结果差异和下一轮建议。"],
    work:"读取画布制作复盘记录，区分保存的生成依据与当前连线，缺失时明确标注。将交接说明写入一个文本节点，不改动来源素材。"},
];

const creativeApps = $("#creativeApps");
const appsField = selector => $(selector,creativeApps);
const appDrafts = new Map();
let appBoard, currentApp, appBusy = false;

function creativeAppKey(app) { return `${appBoard}:${app.id}`; }
function creativeAppBrief(app,values) {
  return app.fields.map((label,i)=>values[i]&&`${label} · ${values[i]}`).filter(Boolean).join("\n");
}

function creativeAppPrefill(app,values) {
  const brief=creativeAppBrief(app,values);
  if(!brief)return [];
  const [node,field]=app.templateBrief;
  const value=app.id==="character"?brief+"\n单人全身、正面略转约 30°，自然站姿，浅灰背景和均匀光线。":brief;
  const edits=[{node,field,value}];
  if(app.id==="storyboard"){
    if(values[1])edits.push({node:"n2",field:"nshots",value:"auto"},{node:"n2",field:"shotlen",value:"auto"});
    const aspect=values[2]?.match(/(?:^|[^\d])(16:9|9:16|4:3|1:1|21:9)(?!\d)/)?.[1];
    if(aspect)edits.push({node:"n2",field:"aspect",value:aspect});
  }
  return edits;
}

function creativeAppMedia(app) {
  const assistant=AC.open&&AC.board===boardId;
  const preferred=assistant&&AC.refs!==null?AC.refs:[...sel];
  const candidates=B.nodes.flatMap(n=>{
    const pinned=assistant&&AC.referencePins.get(n.id)?.ref;
    const v=pinned?n.versions.find(version=>version.ref===pinned):curV(n);
    const valid=app.id==="previs"?n.type==="video"&&n.data.previs:
      v?.ref&&(app.id==="review"||!n.data.previs&&(n.type==="video"||app.id==="broll"&&n.type==="image"));
    return valid?[{id:n.id,ref:v?.ref,version:n.versions.indexOf(v)+1,name:n.name}]:[];
  });
  const selected=candidates.filter(item=>preferred.includes(item.id));
  const initial=selected.length===1?selected[0].id:candidates.length===1?candidates[0].id:"";
  return {candidates,initial};
}

const appWorkspaces={
  previs:"打开白模编辑器",broll:"打开动态画面工具",remake:"打开视频重制",review:"打开制作复盘",
};

function showCreativeApps() {
  if (!B || creativeApps.open) return;
  closeMenus();
  appBoard = boardId;
  appsField("[data-app-skills]").disabled = !canvasCanEdit();
  appsField("[data-app-search]").value = "";
  appsField("[data-app-category]").value = "";
  currentApp = CREATIVE_APPS[0];
  renderCreativeApps();
  if (creativeApps.showModal) creativeApps.showModal();
  else creativeApps.setAttribute("open","");
}

function closeCreativeApps() {
  if (creativeApps.open) creativeApps.close?.();
  creativeApps.removeAttribute("open");
}

function renderCreativeApps() {
  const query = appsField("[data-app-search]").value.trim().toLocaleLowerCase();
  const category = appsField("[data-app-category]").value;
  const matches = CREATIVE_APPS.filter(app=>(!category || app.category===category) &&
    `${app.name} ${app.category} ${app.description}`.toLocaleLowerCase().includes(query));
  if (!matches.includes(currentApp)) currentApp = matches[0];
  appsField("[data-app-list]").innerHTML = matches.map(app=>`<button type="button" data-app-id="${app.id}" aria-pressed="${app===currentApp}">
    ${ico(app.icon)}<span><strong>${esc(app.name)}</strong><small>${esc(app.category)}</small></span></button>`).join("") || "<p>没有匹配的应用</p>";
  renderCreativeAppDetail();
}

function renderCreativeAppDetail() {
  const host = appsField("[data-app-detail]"), app = currentApp;
  if (!app) { host.replaceChildren(); return; }
  const values = appDrafts.get(creativeAppKey(app)) || [];
  const direct=appWorkspaces[app.id], mediaChoice=direct?creativeAppMedia(app):null;
  const media = app.media && (app.media[0]==="image" ? `<img src="/static/creative-examples/${app.media[1]}" alt="${esc(app.name)}示例">` :
    `<video src="/static/creative-examples/${app.media[1]}" controls playsinline preload="metadata" aria-label="${esc(app.name)}示例"></video>`);
  host.innerHTML = `<h2>${esc(app.name)}</h2><p>${esc(app.description)}</p>
    <details ${media?"open":""}><summary>查看示例</summary>${media||""}<div class="app-example"><strong>示例输入</strong><p>${esc(app.example.join(" · "))}</p>
      <strong>示例交付</strong><ul>${app.output.map(line=>`<li>${esc(line)}</li>`).join("")}</ul></div></details>
    <form>${app.fields.map((label,index)=>`<label>${esc(label)}${index===0 ? `<textarea name="app-${index}" rows="2" maxlength="1600" required>${esc(values[index]||"")}</textarea>` :
      `<input name="app-${index}" maxlength="400" value="${esc(values[index]||"")}">`}</label>`).join("")}
      ${direct?`<label>${app.id==="previs"?"白模场景":"素材版本"}<select data-app-source><option value="">${app.id==="previs"?"新建白模场景":app.id==="review"?"整张画布":"选择素材版本"}</option>
        ${mediaChoice.candidates.map(item=>`<option value="${esc(item.id)}">${esc(item.name)}${item.version?" · 版本 "+item.version:""}</option>`).join("")}</select></label>`:""}
      <div class="app-actions"><button type="submit" ${canvasCanEdit()?"":"disabled"}>加入对话草稿</button>
      <button type="button" data-app-example ${canvasCanEdit()?"":"disabled"}>在对话试用示例</button>
      ${app.template?'<button type="button" data-app-template>打开画布模板</button>':""}
      ${direct?`<button type="button" data-app-workspace ${!canvasCanEdit()&&app.id!=="review"?"disabled":""}>${direct}</button>`:""}</div>
      <div role="status" data-app-status></div></form>`;
  const form = $("form",host);
  const readInputs=()=>app.fields.map((_,index)=>form.elements[index].value.trim());
  form.oninput = () => appDrafts.set(creativeAppKey(app),app.fields.map((_,index)=>form.elements[index].value));
  form.onsubmit = event => {
    event.preventDefault();
    const inputs=readInputs();
    if (!inputs[0]) { $("[data-app-status]",host).textContent = "请填写创作需求"; return; }
    useCreativeApp(app,inputs);
  };
  $("[data-app-example]",host).onclick = () => useCreativeApp(app,app.example);
  const template = $("[data-app-template]",host);
  if (template) template.onclick = boardAction(async()=>{
    if(appBoard!==boardId)return;
    const prefill=creativeAppPrefill(app,readInputs());
    closeCreativeApps();
    await openWorkflowTemplates(false,null,{id:app.template,scope:"presets",prefill});
  });
  if(direct){
    const select=$("[data-app-source]",form), workspace=$("[data-app-workspace]",form);
    select.value=mediaChoice.initial;
    const sourceRequired=app.id==="broll"||app.id==="remake";
    const update=()=>{workspace.disabled=(!canvasCanEdit()&&app.id!=="review")||(sourceRequired&&!select.value);};
    select.onchange=update;update();
    workspace.onclick=boardAction(async()=>{
      if(appBoard!==boardId||(sourceRequired&&!select.value)||(!canvasCanEdit()&&app.id!=="review"))return;
      const target=mediaChoice.candidates.find(item=>item.id===select.value);
      const source=node(target?.id), version=source?.versions.find(v=>v.ref===target?.ref);
      if(target&&(!source||target.ref&&!version)){
        $("[data-app-status]",host).textContent="素材或版本已移除，请重新打开应用选择";return;
      }
      const brief=creativeAppBrief(app,readInputs());
      if(app.id==="broll"&&brief.length>1000){
        $("[data-app-status]",host).textContent="动态画面工具的需求最多 1000 字，请精简后打开";return;
      }
      closeCreativeApps();
      if(app.id==="previs"){
        if(source)openPrevis(source);
        else addPrevisNode(toW(innerWidth/2-150,innerHeight/2-180));
      }else if(app.id==="broll")openBroll(source,{sourceRef:target.ref,brief});
      else if(app.id==="remake")await openVideoRemake(source,{sourceRef:target.ref,brief});
      else await openWorkflowReview(source?.id||null,version?source.versions.indexOf(version)+1:null);
    });
  }
}

async function useCreativeApp(app, values) {
  const bid = appBoard;
  if (appBusy || bid!==boardId || !canvasCanEdit()) return;
  appBusy = true;
  try {
    const draft = [`创作任务 · ${app.name}`,creativeAppBrief(app,values),app.work].filter(Boolean).join("\n");
    closeCreativeApps();
    await acOpen();
    if (bid!==boardId || AC.board!==bid || !AC.session || !AC.open) return;
    const input = $("#acInput"), prefix = input.value.trimEnd();
    const merged = prefix ? `${prefix}\n\n${draft}` : draft;
    if (merged.length>input.maxLength) throw new Error("草稿超过输入长度，原对话内容已保留");
    input.value = merged;
    input.setSelectionRange(merged.length,merged.length);
    input.dispatchEvent(new Event("input",{bubbles:true}));
    input.focus();
    toast("已加入对话草稿");
  } catch(error) { toast(error.message || "无法打开创作助手"); }
  finally { appBusy = false; }
}

$("#creativeAppsBtn").onclick = showCreativeApps;
$("#acSkills").insertAdjacentHTML("beforebegin",'<button type="button" id="acApps" aria-haspopup="dialog">应用</button>');
$("#acApps").onclick = showCreativeApps;
appsField("[data-app-close]").onclick = closeCreativeApps;
appsField("[data-app-search]").oninput = renderCreativeApps;
appsField("[data-app-category]").onchange = renderCreativeApps;
appsField("[data-app-list]").onclick = event=>{
  const button = event.target.closest("[data-app-id]");
  if (!button) return;
  currentApp = CREATIVE_APPS.find(app=>app.id===button.dataset.appId);
  for (const item of $$("[data-app-id]",creativeApps)) item.setAttribute("aria-pressed",String(item===button));
  renderCreativeAppDetail();
  if (innerWidth<680) appsField("[data-app-detail]").scrollIntoView({block:"nearest"});
};
appsField("[data-app-skills]").onclick = async()=>{
  const bid = appBoard;
  closeCreativeApps();
  await acOpen();
  if (boardId===bid && AC.board===bid && AC.session) await csOpen();
};
creativeApps.addEventListener("keydown",event=>event.stopPropagation());
creativeApps.addEventListener("cancel",event=>{event.preventDefault();closeCreativeApps();});
