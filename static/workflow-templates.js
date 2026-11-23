"use strict";

const WT = {epoch:0,previewEpoch:0,busy:false,rows:[],scope:"private",rename:null,attempt:null};
const TEMPLATE_API = "/api/canvas-templates";

function closeWorkflowTemplates() {
  WT.epoch++;
  closeTemplatePreview();
  $("#workflowTemplates").hidden = true;
}

function templateCanSave() {
  return B?.nodes.length > 0 &&
    (B.access === "owner" || !B.access && B.owner === ME_USER?.id);
}

function setupTemplateForm(row=null) {
  WT.rename = row;
  $("#templateForm").hidden = WT.scope !== "private" || !row && !templateCanSave();
  $("#templateName").value = row?.name || WT.selectionName || B?.name || "";
  $("#templateDescription").value = row?.description || "";
  $("#templateSave").textContent = row ? "保存修改" : "保存模板";
  $("#templateCancel").hidden = !row;
  $("#templateScope").hidden = !!row || !WT.selected?.length;
}

function templateUseButtons() {
  return `${canvasCanEdit() ? '<button type="button" data-template-action="insert">插入画布</button>' : ""}
    <button type="button" data-template-action="open">新建画布</button>`;
}

function renderTemplateRows() {
  const query = $("#templateSearch").value.trim().toLowerCase();
  const category = $("#templateCategory").value;
  const rows = WT.rows.filter(row=>(!category || row.category === category) &&
    `${row.name} ${row.author || ""} ${row.description || ""} ${row.category || ""}`.toLowerCase().includes(query));
  $("#templateRows").innerHTML = rows.map(row=>`
    <article data-template="${esc(row.id)}"><div><strong>${esc(row.name)}</strong>
      <span>${row.nodes} 个节点${row.category ? " · " + esc(row.category) :
        row.author ? " · " + esc(row.author) : row.published ? " · 已共享" : ""}</span>
      ${row.description ? `<p>${esc(row.description)}</p>` : ""}</div>
      <button type="button" data-template-action="preview">预览</button>
      ${WT.scope === "private" ? `${templateUseButtons()}
        <button type="button" data-template-action="rename">改名</button>
        <button type="button" data-template-action="delete">删除</button>` : ""}
    </article>`).join("") || `<p class="template-empty">${query ? "没有匹配的模板" :
      WT.scope === "catalog" ? "还没有共享模板" : "还没有私有模板"}</p>`;
}

async function refreshTemplates() {
  const epoch = ++WT.epoch;
  const data = await boardRequest(TEMPLATE_API + (WT.scope === "private" ? "" : "/" + WT.scope));
  if (epoch !== WT.epoch) return;
  WT.rows = Array.isArray(data) ? data : [];
  const category = $("#templateCategory"), current = category.value;
  const options = new Set(WT.rows.map(row=>row.category).filter(Boolean));
  category.innerHTML = '<option value="">所有分类</option>' +
    [...options].map(name=>`<option value="${esc(name)}">${esc(name)}</option>`).join("");
  category.value = options.has(current) ? current : "";
  renderTemplateRows();
}

async function showTemplateScope(scope) {
  WT.scope = scope;
  closeTemplatePreview();
  setupTemplateForm();
  for (const button of $("#templateScopes").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.scope === scope));
  }
  WT.rows = [];
  $("#templateRows").replaceChildren();
  $("#templateSearch").value = "";
  $("#templateCategory").value = "";
  $("#templateCategory").hidden = scope !== "presets";
  $("#templateStatus").textContent = "正在读取模板…";
  const epoch = WT.epoch + 1;
  try {
    await refreshTemplates();
    if (WT.epoch === epoch) $("#templateStatus").textContent = "";
  } catch (error) {
    if (WT.epoch === epoch) $("#templateStatus").textContent = error.message;
  }
}

function closeTemplatePreview() {
  WT.previewEpoch++;
  $("#templatePreview").replaceChildren();
  $("#templatePreview").hidden = true;
}

function templateMedia(url,index,type,name,edge=null) {
  if(!Number.isInteger(index))return "";
  let src=url+"/preview/media/"+index;
  if(type==="video" && edge && (Number.isFinite(edge.start)||Number.isFinite(edge.end))){
    const start=edge.start??0;
    src+="#t="+start+(Number.isFinite(edge.end)&&edge.end>start?","+edge.end:"");
  }
  if(type==="image")return `<img loading="lazy" src="${src}" alt="${esc(name)}">`;
  if(type==="video")return `<video controls preload="none" src="${src}" aria-label="${esc(name)}"></video>`;
  if(type==="audio")return `<audio controls preload="none" src="${src}" aria-label="${esc(name)}"></audio>`;
  return "";
}

async function showTemplatePreview(row) {
  const epoch = ++WT.previewEpoch;
  const panel = $("#templatePreview");
  const url = TEMPLATE_API + "/" + encodeURIComponent(row.id);
  panel.hidden = false;
  panel.innerHTML = '<p role="status">正在读取预览…</p>';
  try {
    const preview = await boardRequest(url + "/preview");
    if (epoch !== WT.previewEpoch) return;
    const nodes = new Map(preview.nodes.map(n=>[n.id,n]));
    const types = {text:"文本",image:"图片",video:"视频",audio:"音频",script:"分镜"};
    const tokenNames={image:"图",video:"视频",audio:"音"};
    const roles = new Map([["first","首帧"],["last","尾帧"],["keyframe","关键帧"],["subject","主体参考"],
      ["audio_ref","音频参考"],["video_ref","视频参考"],["seed_audio_ref","生成参考"],["previs","白模动作参考"],
      ["trim","裁剪自原片"],["capture","截帧"],["transcript","转写来源"],["audio_cut","音频剪辑来源"]]);
    const canPublish = !row.builtin && (WT.scope === "private" || row.owned);
    panel.innerHTML = `
      <header><strong>${esc(preview.name)}</strong><button type="button" data-template-action="back">关闭预览</button></header>
      <div data-template="${esc(row.id)}">
        ${preview.description ? `<p class="template-description">${esc(preview.description)}</p>` : ""}
        <div class="template-preview-actions">${templateUseButtons()}
          ${canPublish ? `<button type="button" data-template-action="${row.published ? "unpublish" : "confirm"}">${row.published ? "取消共享" : "共享到模板库"}</button>` : ""}
        </div>
        <div id="templatePublishConfirm" hidden><p>所有登录用户都可以复制这个模板，包括提示词、工作流设置和保存的素材。</p>
          <button type="button" data-template-action="publish">确认共享</button>
          <button type="button" data-template-action="cancel">取消</button>
        </div>
        <ul class="template-preview-nodes">${preview.nodes.map(n=>{
          const content = templateMedia(url,n.media,n.type,n.name);
          return `<li><strong>${esc(n.name)}</strong> <span>${types[n.type] || ""}</span>${content}
            ${n.text || n.prompt ? `<p>${esc(n.text || n.prompt)}</p>` : ""}</li>`;
        }).join("")}</ul>
        ${preview.edges.length ? `<ul class="template-preview-edges" aria-label="节点连线">${preview.edges.map(edge=>{
          const source=nodes.get(edge.from), target=nodes.get(edge.to), role=roles.get(edge.relation)||roles.get(edge.role);
          const token=edge.relation==="seed_audio_ref" && source.type==="audio" && edge.slot ?
            "@音频"+edge.slot : edge.prompt_slot&&tokenNames[source.type]?"@"+tokenNames[source.type]+"{"+edge.prompt_slot+"}":"";
          const version=edge.version?"版本 "+edge.version:edge.reference_unavailable?"指定版本不可用":"";
          const seconds=value=>Number(value.toFixed(2));
          const range=Number.isFinite(edge.end)?seconds(edge.start??0)+"–"+seconds(edge.end)+" 秒":
            Number.isFinite(edge.start)?seconds(edge.start)+" 秒起":
            Number.isFinite(edge.time??edge.at)?seconds(edge.time??edge.at)+" 秒":"";
          const caption=[role,token,version,range].filter(Boolean).join(" · ");
          const summary=esc(source.name)+" → "+esc(target.name)+(caption?" · "+esc(caption):"");
          const player=templateMedia(url,edge.media,source.type,source.name+(version?" · "+version:""),edge);
          return player?`<li><details><summary>${summary}</summary>${player}</details></li>`:`<li>${summary}</li>`;
        }).join("")}</ul>` : ""}
      </div>`;
    panel.querySelector("header button").focus();
  } catch (error) {
    if (epoch === WT.previewEpoch) {
      panel.innerHTML = '<header><p role="status"></p><button type="button" data-template-action="back">关闭预览</button></header>';
      panel.querySelector("p").textContent = error.message;
    }
  }
}

async function openWorkflowTemplates(selectionOnly=false, group=null, sharedTemplate=null) {
  closeMenus();
  if ($("#assetLibrary") && !$("#assetLibrary").hidden) alClose();
  const panel = $("#workflowTemplates");
  WT.selected = group ? [...group.nodes] : [...sel];
  WT.selectionName = group?.name;
  const projects = $("#templateProject");
  projects.innerHTML = '<option value="">新建独立画布</option>' + canvasProjects.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  projects.value = currentProject()?.id || "";
  panel.hidden = false;
  const loading = showTemplateScope(sharedTemplate ? "catalog" : selectionOnly === true ? "private" : "presets");
  $("#templateScope").value = selectionOnly === true && WT.selected.length ? "selection" : "board";
  await loading;
  if (panel.hidden) return;
  $("#templateClose").focus();
  if (sharedTemplate && WT.scope === "catalog") {
    const row = WT.rows.find(item=>item.id===sharedTemplate);
    if (row) await showTemplatePreview(row);
    else if (!$("#templateStatus").textContent) $("#templateStatus").textContent = "此工作流模板已取消共享或不可用";
  }
}

async function templateChange(action) {
  if (WT.busy) return;
  const bid = boardId, panel = $("#workflowTemplates");
  WT.busy = true; panel.setAttribute("aria-busy","true");
  try { await action(bid); }
  catch (error) { if (boardId === bid && !panel.hidden) $("#templateStatus").textContent = error.message; }
  finally { WT.busy = false; panel.setAttribute("aria-busy","false"); }
}

function initWorkflowTemplates() {
  document.body.insertAdjacentHTML("beforeend",`<section id="workflowTemplates" aria-labelledby="templateHeading" hidden>
    <header><strong id="templateHeading">工作流模板</strong><button type="button" id="templateClose" aria-label="收起工作流模板">×</button></header>
    <div id="templateScopes" role="group" aria-label="模板范围">
      <button type="button" data-scope="presets" aria-pressed="true">内置工作流</button>
      <button type="button" data-scope="catalog" aria-pressed="false">共享模板库</button>
      <button type="button" data-scope="private" aria-pressed="false">我的模板</button>
    </div>
    <div class="template-filters">
      <input type="search" id="templateSearch" aria-label="搜索模板" placeholder="搜索模板">
      <select id="templateCategory" aria-label="按分类筛选"></select>
    </div>
    <form id="templateForm"><label for="templateName">模板名称</label><input id="templateName" maxlength="60" required>
      <label class="template-summary">模板说明 <input id="templateDescription" maxlength="300" placeholder="选填"></label>
      <select id="templateScope" aria-label="保存模板范围"><option value="board">整张画布</option><option value="selection">选中节点</option><option value="upstream">选中节点及上游素材</option></select>
      <button type="submit" id="templateSave">保存模板</button><button type="button" id="templateCancel" hidden>取消修改</button></form>
    <label class="template-project">新画布所在项目 <select id="templateProject"></select></label>
    <p id="templateStatus" role="status"></p>
    <section id="templatePreview" aria-label="工作流预览" hidden></section>
    <div id="templateRows"></div>
  </section>`);
  $("#templateClose").onclick = closeWorkflowTemplates;
  $("#templateBtn").onclick = ()=>$("#workflowTemplates").hidden ? openWorkflowTemplates() : closeWorkflowTemplates();
  $("#templateCancel").onclick = ()=>setupTemplateForm();
  $("#templateScopes").onclick = e=>{
    const scope=e.target.closest("[data-scope]")?.dataset.scope;
    if(scope && scope!==WT.scope && !WT.busy) showTemplateScope(scope);
  };
  $("#templateSearch").oninput = renderTemplateRows;
  $("#templateCategory").onchange = renderTemplateRows;
  $("#workflowTemplates").onkeydown = e=>{e.stopPropagation();if(e.key==="Escape")closeWorkflowTemplates();};
  $("#templateForm").onsubmit = e=>{
    e.preventDefault();
    const name = $("#templateName").value.trim(), description = $("#templateDescription").value.trim(), row = WT.rename;
    const scope = $("#templateScope").value;
    const selected = scope === "board" ? null : WT.selected;
    const include_upstream = scope === "upstream";
    templateChange(async bid=>{
      if (row) await boardRequest(TEMPLATE_API+"/"+encodeURIComponent(row.id),"PATCH",{name,description});
      else {
        await flushSave();
        if (bid !== boardId) return;
        if (savePending?.id === bid || AC.pending.has(bid)) throw new Error("请先保存当前画布，再创建模板");
        await boardRequest(TEMPLATE_API,"POST",{name,description,board:bid,selected,include_upstream,revision:B.rev});
      }
      if (bid !== boardId || $("#workflowTemplates").hidden) return;
      setupTemplateForm(); await refreshTemplates();
      $("#templateStatus").textContent = "模板已保存";
    });
  };
  const handleAction = e=>{
    const button=e.target.closest("[data-template-action]");
    const action=button?.dataset.templateAction;
    const id=button?.closest("[data-template]")?.dataset.template;
    const row=WT.rows.find(item=>item.id===id);
    if(action==="back"){closeTemplatePreview();return;}
    if(!row || WT.busy)return;
    const url=TEMPLATE_API+"/"+encodeURIComponent(id);
    if(action==="preview"){showTemplatePreview(row);return;}
    if(action==="confirm" || action==="cancel"){
      const confirmation=$("#templatePublishConfirm");
      confirmation.hidden=action==="cancel";
      (confirmation.hidden ? $("#templatePreview [data-template-action=confirm]") :
        confirmation.querySelector("button")).focus();
      return;
    }
    if(action==="rename"){setupTemplateForm(row);$("#templateName").focus();$("#templateName").select();return;}
    if(action==="delete" && button.textContent!=="确认删除"){button.textContent="确认删除";return;}
    templateChange(async bid=>{
      if(action==="delete"){
        await boardRequest(url,"DELETE");
        if(bid===boardId&&!$("#workflowTemplates").hidden){closeTemplatePreview();setupTemplateForm();await refreshTemplates();}
        return;
      }
      if(action==="publish" || action==="unpublish"){
        if(action==="publish") await boardRequest(url+"/publication","PUT",{confirmed:true});
        else await boardRequest(url+"/publication","DELETE");
        if(bid!==boardId || $("#workflowTemplates").hidden)return;
        closeTemplatePreview();
        await refreshTemplates();
        if(bid===boardId && !$("#workflowTemplates").hidden) $("#templateStatus").textContent =
          action==="publish" ? "已加入共享模板库" : "已取消共享，已有副本仍可使用";
        return;
      }
      if(action==="insert") {
        const fragment = await boardRequest(url+"/fragment","POST",{});
        if (bid !== boardId || $("#workflowTemplates").hidden || !canvasCanEdit()) return;
        const nodes = fragment.nodes;
        if (!nodes.length) return;
        const x = B.nodes.length ? Math.max(...B.nodes.map(n=>n.x+size(n).w))+120 : toW(innerWidth/3,innerHeight/3).x;
        const y = toW(0,innerHeight/3).y;
        const ids = paste(nodes,x-Math.min(...nodes.map(n=>n.x)),y-Math.min(...nodes.map(n=>n.y)),fragment);
        closeWorkflowTemplates(); fit(ids.map(node));
        return;
      }
      if(action!=="open")return;
      const project=$("#templateProject").value || null;
      const target=JSON.stringify([id,project]);
      if(WT.attempt?.target!==target)WT.attempt={target,key:crypto.randomUUID?.() || "template-"+Date.now()+Math.random().toString(36).slice(2)};
      const result=await boardRequest(url+"/open","POST",{project,request_key:WT.attempt.key});
      if(bid===boardId && !$("#workflowTemplates").hidden){
        await openBoard(result.id);
        WT.attempt=null;
      }
    });
  };
  $("#templateRows").onclick = handleAction;
  $("#templatePreview").onclick = handleAction;
}
