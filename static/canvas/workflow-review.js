"use strict";

const WR = {epoch:0, board:null, node:null, version:null, report:null};

function closeWorkflowReview() {
  const panel = $("#workflowReview");
  if (!panel?.open) return;
  WR.epoch++;
  WR.report = null;
  if (panel.close) panel.close();
  else panel.removeAttribute("open");
}

function wrVersions(nodeId, version) {
  const picker = $("#wrVersion"), target = nodeId ? node(nodeId) : null;
  const length = target?.versions.length || 0;
  picker.closest("label").hidden = !length;
  picker.replaceChildren(new Option("当前版本", ""));
  for (let number = length; number >= 1; number--) picker.add(new Option("版本 " + number, String(number)));
  picker.value = version == null ? "" : String(version);
}

function wrText(label, content) {
  const details = document.createElement("details"), summary = document.createElement("summary"), pre = document.createElement("pre");
  summary.textContent = label;
  pre.textContent = content;
  details.append(summary, pre);
  return details;
}

function wrStep(step) {
  const item = document.createElement("li");
  item.className = "wr-step";
  item.innerHTML = `<header><div><strong>${esc(step.name)}</strong>
    <span>${esc(step.operation)}${step.version ? ` · 版本 ${step.version}/${step.versions}` : ""}${step.in_progress ? " · 生成中" : ""}</span></div>
    <button type="button" data-wr-locate>定位</button>${step.ref ? '<button type="button" data-wr-preview>查看版本</button>' : ""}</header>`;
  $("[data-wr-locate]",item).onclick = () => {
    const target = WR.board === boardId && node(step.node);
    if (!target) return toast("节点已不存在，请刷新复盘");
    closeWorkflowReview();
    selectOnly(target.id);
    fit([target], false);
  };
  const preview = $("[data-wr-preview]",item);
  if (preview) preview.onclick = () => {
    const target = WR.board === boardId ? node(step.node) : null;
    const v = target?.versions[step.version-1];
    if (v?.ref !== step.ref || !v.url) return toast("版本已变更，请刷新复盘");
    closeWorkflowReview();
    lightbox(v,target);
  };
  if (step.inputs.length) {
    const list = document.createElement("ul");
    list.className = "wr-inputs";
    for (const input of step.inputs) {
      const row = document.createElement("li"), label = document.createElement(input.node ? "button" : "span");
      if (input.node) {
        label.type = "button";
        label.onclick = () => openWorkflowReview(input.node, input.version);
      }
      label.textContent = input.name + (input.version ? " · 版本 " + input.version : "");
      const meta = document.createElement("span");
      const end = input.end == null ? "" : "–" + Number(input.end.toFixed(3));
      const time = input.time == null ? "" : " · " + Number(input.time.toFixed(3)) + end + " 秒";
      const reference = input.token ? input.role + " " + input.token : input.role;
      meta.textContent = [reference + time,input.transition,input.speed ? input.speed + "×" : "",input.evidence,input.ambiguous ? "多处引用" : ""].filter(Boolean).join(" · ");
      row.append(label, meta);
      if (input.text) row.append(wrText("生成时的文字输入", input.text));
      list.append(row);
    }
    item.append(list);
  }
  if (step.settings.length || step.memory.length) {
    const settings = document.createElement("dl");
    for (const {label,value} of [...step.settings, ...(step.memory.length ? [{label:"资产库",value:step.memory.join("、")}] : [])]) {
      const key = document.createElement("dt"), val = document.createElement("dd");
      key.textContent = label;
      val.textContent = value;
      settings.append(key,val);
    }
    item.append(settings);
  }
  if ((step.operation === "生成" || step.operation === "编辑") && !step.recorded) {
    const note = document.createElement("p");
    note.textContent = "这个历史版本只保存了部分制作信息。";
    item.append(note);
  }
  if (step.prompt) item.append(wrText("提示词", step.prompt));
  if (step.text) item.append(wrText("节点文字", step.text));
  return item;
}

async function openWorkflowReview(nodeId = null, version = null) {
  if (!boardId || !B) return;
  closeMenus();
  const epoch = ++WR.epoch;
  Object.assign(WR, {board:boardId, node:nodeId, version, report:null});
  const panel = $("#workflowReview");
  if (!panel.open) {
    if (panel.showModal) panel.showModal();
    else panel.setAttribute("open", "");
  }
  $("#wrContext").textContent = nodeId ? node(nodeId)?.name || "节点" : B.name || "画布";
  $("#wrAll").hidden = !nodeId;
  $("#wrDownload").disabled = true;
  $("#wrSteps").replaceChildren();
  $("#wrStatus").textContent = "正在读取已保存的制作记录…";
  wrVersions(nodeId, version);
  try {
    await flushSave();
    if (epoch !== WR.epoch || WR.board !== boardId) return;
    const query = new URLSearchParams();
    if (nodeId) query.set("node", nodeId);
    if (version != null) query.set("version", version);
    const result = await boardRequest(`/api/board/${encodeURIComponent(WR.board)}/workflow-review?${query}`);
    if (epoch !== WR.epoch || WR.board !== boardId) return;
    WR.report = result;
    $("#wrSteps").replaceChildren(...result.steps.map(wrStep));
    $("#wrStatus").textContent = !result.steps.length ? "画布还没有制作记录。" :
      `${result.steps.length} 个步骤 · 画布修订 ${result.rev ?? 0}` +
      (result.truncated ? " · 已截取部分步骤" : "") + (result.has_cycle ? " · 存在环形关系" : "");
    $("#wrDownload").disabled = !result.steps.length;
  } catch (error) {
    if (epoch === WR.epoch) $("#wrStatus").textContent = error.message;
  }
}

function initWorkflowReview() {
  document.body.insertAdjacentHTML("beforeend", `<dialog id="workflowReview" aria-labelledby="wrTitle">
    <header class="wr-head"><div><strong id="wrTitle">制作复盘</strong><div id="wrContext"></div></div>
      <button type="button" id="wrAll" hidden>整张画布</button><button type="button" id="wrRefresh">刷新</button>
      <button type="button" id="wrDownload" disabled>导出 Markdown</button><button type="button" id="wrClose">关闭</button></header>
    <div class="wr-subhead"><label hidden>查看版本<select id="wrVersion"></select></label><div id="wrStatus" role="status"></div></div>
    <ol id="wrSteps"></ol></dialog>`);
  const panel = $("#workflowReview");
  panel.addEventListener("keydown", event => event.stopPropagation());
  panel.addEventListener("cancel", event => {event.preventDefault(); closeWorkflowReview();});
  $("#wrClose").onclick = closeWorkflowReview;
  $("#wrRefresh").onclick = () => openWorkflowReview(WR.node, WR.version);
  $("#wrAll").onclick = () => openWorkflowReview();
  $("#wrVersion").onchange = event => openWorkflowReview(WR.node, Number(event.target.value) || null);
  $("#wrDownload").onclick = () => {
    const report = WR.report;
    if (!report || WR.board !== boardId) return;
    const url = URL.createObjectURL(new Blob([report.markdown], {type:"text/markdown;charset=utf-8"}));
    const link = document.createElement("a");
    link.href = url;
    link.download = (report.name.replace(/[<>:"/\\|?*]/g, "_") || "画布") + " · 制作复盘.md";
    link.click();
    setTimeout(()=>URL.revokeObjectURL(url), 1000);
  };
}
