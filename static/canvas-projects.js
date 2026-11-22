"use strict";

// ================================================================= boards
let boardDirectory = [], canvasProjects = [], canvasTeams = [], boardOpenEpoch = 0, boardMenuEpoch = 0;
const currentProject = () => canvasProjects.find(p => p.id === boardDirectory.find(b => b.id === boardId)?.project);

async function boardRequest(url, method = "GET", body) {
  const response = await fetchOk(url, {method, ...(body === undefined ? {} : {
    headers:{"Content-Type":"application/json"}, body:JSON.stringify(body),
  })});
  return response.json();
}
async function loadBoardDirectory() {
  const [boards, projects, teams] = await Promise.all([boardRequest("/api/boards"), boardRequest("/api/canvas-projects"),
    boardRequest("/api/canvas-teams").catch(()=>[])]);
  const previousProject = currentProject()?.id;
  boardDirectory = Array.isArray(boards) ? boards : [];
  canvasProjects = Array.isArray(projects) ? projects : [];
  canvasTeams = Array.isArray(teams) ? teams : [];
  if (currentProject()?.id !== previousProject) { cmInvalidate(); cmClose(); }
  renderProjectCanvases();
}
function boardAction(action) {
  return async event => {
    try { await action(event); } catch (error) { toast(error.message || "画布操作失败", 4500); }
  };
}
function renderProjectCanvases() {
  const nav = $("#projectCanvases"), project = boardDirectory.find(b=>b.id===boardId)?.team ? null : currentProject();
  nav.hidden = !project;
  if (!project) { nav.replaceChildren(); return; }
  const siblings = boardDirectory.filter(b => b.project === project.id && !b.team).sort((a,b) => a.id.localeCompare(b.id));
  nav.innerHTML = `<strong title="${esc(project.name)}">${esc(project.name)}</strong><div class="project-links">${siblings.map(b =>
    `<button type="button" data-project-board="${esc(b.id)}" title="${esc(b.name)}" ${b.id === boardId ? 'aria-current="page"' : ""}>${esc(b.name)}</button>`).join("")}</div>
    <button type="button" data-project-add title="在此项目新建画布" aria-label="在此项目新建画布">${ico("plus")}</button>`;
  $$("[data-project-board]",nav).forEach(b => b.onclick = boardAction(() => b.dataset.projectBoard !== boardId && openBoard(b.dataset.projectBoard)));
  $("[data-project-add]",nav).onclick = boardAction(() => createCanvas(project.id));
  $("[aria-current=page]",nav)?.scrollIntoView?.({block:"nearest",inline:"nearest"});
}
function requireSavedBoard(id, savedConflictDraft) {
  const conflict = AC.pending.get(id);
  if (conflict && conflict.draft !== savedConflictDraft) throw new Error("请先处理当前画布的保存冲突");
  if (savePending?.id === id) throw new Error("当前画布尚未保存，请先重试保存");
}
async function openBoard(id, savedConflictDraft) {
  const epoch = ++boardOpenEpoch, source = boardId;
  const canSwitch = () => epoch === boardOpenEpoch && boardId === source;
  const load = async () => {
    const board = await boardRequest("/api/board/" + encodeURIComponent(id));
    if (!Array.isArray(board?.nodes)) throw new Error("画布已不存在");
    return board;
  };
  let b;
  if (source !== id) {
    await flushSave();
    if (!canSwitch()) return false;
    requireSavedBoard(source,savedConflictDraft);
    if (IMAGE_EDITOR?.busy) throw new Error("图片编辑正在保存，请稍候再切换");
    b = await load();
  }
  if (!canSwitch()) return false;
  if (IMAGE_EDITOR?.busy && source !== id) throw new Error("图片编辑正在保存，请稍候再切换");
  if (!closePrevis()) throw new Error("白模预演正在提交，请稍候");
  clearCanvasGuides();
  closeCanvasGroupRunDialog();
  if(id!==boardId && groupRun?.active)groupRun.stop=true;
  closeVideoExtension();
  closeSegmentEditor();
  closeSegmentReview();
  closeVideoTrim();
  closeFrameCapture();
  closeAudioTranscript();
  closeAudioSeparation();
  closeVideoDraftFinal();
  closeVideoCompare();
  closeTextDocument();
  ctCloseGroupGallery();
  closeLightbox();
  if (FILM) closeFilm();
  let settled = flushSave();
  await settled;
  while (canSwitch() && settled !== saveChain) { settled = saveChain; await settled; }
  if (!canSwitch()) return false;
  if (source !== id) requireSavedBoard(source,savedConflictDraft);
  if (source === id) {
    b = await load();
    if (!canSwitch() || savePending?.id === source || settled !== saveChain) return false;
  }
  if (IMAGE_EDITOR?.busy && boardId !== id) throw new Error("图片编辑正在保存，请稍候再切换");
  if (IMAGE_EDITOR && boardId !== id) closeImageEditor(false);
  if(boardId!==id)liveLeave();
  if (source !== id && $("#generationHistory").open) ghClose();
  if (source !== id && $("#creativeApps").open) closeCreativeApps();
  shareClose();
  closeWorkflowTemplates();
  closeWorkflowReview();
  boardId = id; localStorage.setItem("h3.board", id);
  showBoardSaveFailure();
  history.replaceState(null, "", "/?board=" + encodeURIComponent(id));
  B = Object.assign(emptyBoard(), b);
  renderCanvasGroupRun();
  canvasApplyAccess();
  B.groups = Array.isArray(B.groups) ? B.groups.filter(g => g && typeof g.id === "string" && Array.isArray(g.nodes)).map(g => ({...g,name:String(g.name || "分组"),nodes:g.nodes.filter(id => B.nodes.some(n => n.id === id))})) : [];
  const cnt = {};   // boards from the first version: names, defaults
  B.nodes.forEach(n => { cnt[n.type] = (cnt[n.type] || 0) + 1; n.name = n.name || `${TYPE_CN[n.type]} ${cnt[n.type]}`; n.data = { ...defaults(n.type), ...n.data }; n.versions = n.versions || []; delete n.w;
    if (n.type === "image" && !["4mp", "16mp"].includes(n.data.quality)) n.data.quality = "4mp"; });
  historyEpoch++;
  undoStack.length = redoStack.length = 0; sel.clear(); selEdge = null;
  $("#bname").textContent = B.name || "我的画布";
  rebuild();
  applyView();
  poll(); schedulePrewarm(3000);
  if (typeof acRememberBoard === "function") acRememberBoard(id, B);
  restoreCanvasConflict();
  if (typeof acBoardChanged === "function") acBoardChanged();
  if (typeof alBoardChanged === "function") alBoardChanged();
  if (CC.board !== id) ccBoardChanged();
  $("#shotList [data-close]")?.click();
  renderProjectCanvases();
  if (!boardDirectory.some(item => item.id === id)) loadBoardDirectory().catch(() => {});
  return true;
}
async function createCanvas(project = null, imported = null, team = null) {
  const source = boardId, epoch = boardOpenEpoch;
  await flushSave();
  if (boardId !== source || boardOpenEpoch !== epoch) return false;
  requireSavedBoard(source);
  const random = crypto.randomUUID?.().slice(0,8) || Math.random().toString(36).slice(2,10);
  const id = "b" + Date.now().toString(36) + random;
  const board = imported || emptyBoard(project ? "新画布" : "新画布 " + new Date().toLocaleDateString());
  const suffix = team ? "?team="+encodeURIComponent(team) : project ? "?project=" + encodeURIComponent(project) : "";
  await boardRequest("/api/board/"+id+suffix, "PUT", board);
  boardDirectory.unshift({id,name:board.name,nodes:board.nodes.length,project,team});
  return boardId === source && boardOpenEpoch === epoch && openBoard(id);
}
$("#bname").addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); e.target.blur(); } });
$("#bname").addEventListener("blur", e => {
  if (!B || !canvasCanEdit()) return;
  const t = e.target.textContent.trim() || "未命名画布";
  e.target.textContent = t;
  if (B.name === t) return;
  B.name = t; save();
  const entry = boardDirectory.find(b => b.id === boardId);
  if (entry) entry.name = t;
  const active = $("#projectCanvases [aria-current=page]");
  if (active) active.textContent = active.title = t;
});

function renderBoardMenu() {
  const m = $("#boards"), project = currentProject(), entry = boardDirectory.find(b => b.id === boardId);
  const teamId = entry?.team || B.team || null;
  const boardButtons = entries => entries.map(b => `<button type="button" data-id="${esc(b.id)}" ${b.id === boardId ? 'aria-current="page"' : ""}><span class="bp-name">${esc(b.name)}</span>${b.id === boardId ? ico("check") : ""}<span class="k">${b.nodes} 个节点</span></button>`).join("");
  const teamGroups = new Map(canvasTeams.map(team=>[team.id,{name:team.name,boards:[]}]));
  for (const board of boardDirectory.filter(b=>b.team)) {
    if (!teamGroups.has(board.team)) teamGroups.set(board.team,{name:"其他协作画布",boards:[]});
    teamGroups.get(board.team).boards.push(board);
  }
  const teamSection = [...teamGroups.entries()].map(([id,team])=>`
    <details class="bp-group" ${team.boards.some(b=>b.id===boardId)?"open":""}>
      <summary>团队 · ${esc(team.name)}<span class="k">${team.boards.length} 个画布</span></summary>${boardButtons(team.boards)}
      ${canvasTeams.some(member=>member.id===id)?`<button type="button" data-new-team="${esc(id)}">${ico("plus")}新建团队画布</button>`:""}
    </details>`).join("");
  m.innerHTML = `<label class="bp-search">${ico("search")}<input type="search" aria-label="搜索当前空间的画布" placeholder="搜索当前空间的画布" autocomplete="off"></label>
    <div class="bp-results" hidden></div><div class="bp-directory">` + teamSection + canvasProjects.map(p => {
    const entries = boardDirectory.filter(b => b.project === p.id && !b.team);
    return `<details class="bp-group" ${p.id === project?.id ? "open" : ""}>
      <summary>${esc(p.name)}<span class="k">${entries.length} 个画布</span></summary>
      ${boardButtons(entries)}
      <div class="bp-actions"><button type="button" data-new-in="${esc(p.id)}">${ico("plus")}新建画布</button>
      <button type="button" data-rename-project="${esc(p.id)}">改名</button>
      <button type="button" data-dissolve-project="${esc(p.id)}">解散</button></div>
    </details>`;
  }).join("") + `<div class="mt">独立画布</div>` + boardButtons(boardDirectory.filter(b => !b.project && !b.team)) +
    `${teamId ? `<button type="button" data-new-personal>${ico("plus")}新建独立画布</button>` : ""}<button type="button" data-new-project>${ico("assets")}新建项目</button>` +
    (B.owner === ME_USER?.id && canvasProjects.length ? `<form class="bp-move"><select aria-label="目标项目" required>
       <option value="" disabled selected>选择目标项目</option><option value="-">独立画布</option>
       ${canvasProjects.map(p => `<option value="${esc(p.id)}" ${p.id === entry?.project ? "disabled" : ""}>${esc(p.name)}</option>`).join("")}
     </select><button type="submit">移动当前画布</button></form>` : "") +
    `<div id="bpForm"></div><div class="sep"></div><label class="bp-batch">批量结果排布<select data-batch-layout ${canvasCanEdit()?"":"disabled"}>
     ${Object.entries(BATCH_LAYOUTS).map(([value,label])=>`<option value="${value}" ${canvasBatchLayout()===value?"selected":""}>${label}</option>`).join("")}</select></label>
     <label class="bp-batch" title="此设置适用于该账号之后提交的图片和视频生成任务">AI 生成水印<select data-ai-watermark ${ME_USER?"":"disabled"}>
     <option value="off" ${ME_USER?.ai_watermark?"":"selected"}>关闭</option><option value="on" ${ME_USER?.ai_watermark?"selected":""}>开启</option></select></label>
     <button data-qnew>${ico("video")}排队生成：还没生成的视频</button><button data-qall>${ico("video")}排队生成：全部视频</button>
     <div class="sep"></div><button data-templates>${ico("stack")}工作流模板</button><button data-workflow-review>${ico("script")}制作复盘</button><button data-export>${ico("dl")}导出当前画布</button><button data-import>${ico("upload")}导入画布 JSON</button><button data-del style="color:#ff8a8a">${ico("trash")}删除当前画布</button></div>
     <div class="bp-create"><button type="button" data-new ${teamId && !canvasTeams.some(team=>team.id===teamId) ? 'disabled title="只有团队成员可以新建团队画布"' : ""}>${ico("plus")}${teamId ? "在当前团队新建画布" : "在个人空间新建画布"}</button></div>`;
  const activateBoard = boardAction(async e => {
    const id = e.currentTarget.dataset.id;
    if (id === boardId || await openBoard(id)) closeMenus();
  });
  const wireBoards = root => $$("button[data-id]",root).forEach(button => button.onclick = activateBoard);
  wireBoards(m);
  const search = $(".bp-search input",m), results = $(".bp-results",m), directory = $(".bp-directory",m);
  search.oninput = () => {
    const query = search.value.trim().toLocaleLowerCase();
    results.hidden = !query;
    directory.hidden = !!query;
    if (!query) { results.replaceChildren(); return; }
    const matches = boardDirectory.filter(board => (board.team || null) === teamId && String(board.name).toLocaleLowerCase().includes(query));
    const actionable = matches.filter(board => board.id !== boardId);
    const active = matches.filter(board => board.id === boardId);
    results.innerHTML = boardButtons([...actionable, ...active]) || '<div class="mt" role="status">当前空间没有匹配的画布</div>';
    wireBoards(results);
  };
  search.onkeydown = e => {
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); $("button[data-id]",results)?.click(); }
  };
  const createFromMenu = (project,team) => boardAction(async e => {
    const button = e.currentTarget;
    button.disabled = true;
    try { if (await createCanvas(project,null,team)) closeMenus(); }
    finally { button.disabled = false; }
  });
  $("[data-new]",m).onclick = createFromMenu(null,teamId);
  const personal = $("[data-new-personal]",m);
  if (personal) personal.onclick = createFromMenu(null,null);
  $$("[data-new-in]",m).forEach(b => b.onclick = createFromMenu(b.dataset.newIn,null));
  $$("[data-new-team]",m).forEach(b => b.onclick = createFromMenu(null,b.dataset.newTeam));
  $("[data-new-project]",m).onclick = () => editProject();
  $$("[data-rename-project]",m).forEach(b => b.onclick = () => editProject(canvasProjects.find(p => p.id === b.dataset.renameProject)));
  $$("[data-dissolve-project]",m).forEach(b => b.onclick = () => dissolveProject(canvasProjects.find(p => p.id === b.dataset.dissolveProject)));
  const move = $(".bp-move",m);
  if (move) move.onsubmit = boardAction(async e => {
    e.preventDefault();
    const value = $("select",move).value;
    await boardRequest("/api/board/"+boardId+"/project","POST",{project:value === "-" ? null : value});
    await loadBoardDirectory(); renderBoardMenu();
  });
  const vidsOnBoard = () => B.nodes.filter(x => x.type === "video" && !x.data.film && !x.data.previs && !x.job);
  $("[data-batch-layout]",m).onchange = e => {
    if(!canvasCanEdit() || !Object.hasOwn(BATCH_LAYOUTS,e.target.value))return;
    B.batch_layout=e.target.value;
    save();
    toast("排布设置已应用于之后提交的批量生成");
  };
  $("[data-ai-watermark]",m).onchange = async e => {
    const control = e.currentTarget;
    if (!ME_USER) return;
    control.disabled = true;
    try {
      const setting = await boardRequest("/api/me/generation-preferences","PUT",{ai_watermark:control.value==="on"});
      ME_USER.ai_watermark = setting.ai_watermark;
      toast(setting.ai_watermark ? "之后提交的生成任务将添加 AI 水印" : "之后提交的生成任务已关闭 AI 水印");
    } catch (error) {
      toast(error.message);
    } finally {
      control.value = ME_USER.ai_watermark?"on":"off";
      control.disabled = false;
    }
  };
  $("[data-qnew]", m).onclick = () => { m.classList.remove("on"); queueVideos(vidsOnBoard().filter(x => !x.versions.length)); };
  $("[data-qall]", m).onclick = () => { m.classList.remove("on"); queueVideos(vidsOnBoard()); };
  $("[data-export]", m).onclick = () => { m.classList.remove("on"); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(B, null, 1)], { type: "application/json" })); a.download = (B.name || "board") + ".json"; a.click(); };
  $("[data-templates]",m).onclick = openWorkflowTemplates;
  $("[data-workflow-review]",m).onclick = () => openWorkflowReview();
  $("[data-import]", m).onclick = () => {
    m.classList.remove("on"); const i = document.createElement("input"); i.type = "file"; i.accept = ".json";
    i.onchange = boardAction(async () => {
      if (!i.files.length) return;
      const imported = JSON.parse(await i.files[0].text());
      if (!Array.isArray(imported?.nodes)) throw new Error("请选择有效的画布 JSON");
      imported.nodes.forEach(n => n.job = null);
      await createCanvas(null, imported);
    }); i.click();
  };
  $("[data-del]", m).onclick = boardAction(async () => {
    m.classList.remove("on"); await flushSave();
    if (savePending?.id === boardId || AC.pending.has(boardId)) throw new Error("请先保存当前画布，再删除");
    await boardRequest("/api/board/"+boardId,"DELETE"); await loadBoardDirectory();
    const next = boardDirectory.find(b => project && b.project === project.id) || boardDirectory[0];
    if (next) await openBoard(next.id); else await createCanvas();
  });
}
function editProject(project) {
  const host = $("#bpForm");
  host.innerHTML = `<form class="bp-editor"><label>项目名称<input name="name" value="${esc(project?.name || "")}" maxlength="60" required></label>
    ${!project && B.owner === ME_USER?.id ? '<label class="bp-check"><input name="attach" type="checkbox">将当前画布移入项目</label>' : ""}
    <div class="bp-actions"><button type="submit">${project ? "保存名称" : "创建项目"}</button><button type="button" data-cancel>取消</button></div></form>`;
  const form = $("form",host), input = $("input[name=name]",form), id = boardId;
  $("[data-cancel]",form).onclick = () => host.replaceChildren();
  form.onsubmit = boardAction(async event => {
    event.preventDefault();
    const body = {name:input.value};
    if ($("input[name=attach]",form)?.checked) body.board = id;
    await boardRequest("/api/canvas-projects" + (project ? "/"+project.id : ""),project ? "PATCH" : "POST",body);
    await loadBoardDirectory(); renderBoardMenu();
  });
  input.focus(); input.select();
}
function dissolveProject(project) {
  const host = $("#bpForm");
  host.innerHTML = `<div class="bp-editor"><span>解散「${esc(project.name)}」后，画布移回独立列表，项目素材移入个人素材库。</span>
    <div class="bp-actions"><button type="button" data-confirm>解散项目</button><button type="button" data-cancel>取消</button></div></div>`;
  $("[data-cancel]",host).onclick = () => host.replaceChildren();
  $("[data-confirm]",host).onclick = boardAction(async () => {
    await boardRequest("/api/canvas-projects/"+project.id,"DELETE");
    await loadBoardDirectory(); renderBoardMenu();
  });
  $("[data-cancel]",host).focus();
}
$("#bmenuBtn").onclick = boardAction(async e => {
  e.stopPropagation(); const m = $("#boards"), epoch = ++boardMenuEpoch;
  if (m.classList.contains("on")) { m.classList.remove("on"); return; }
  closeMenus(); m.innerHTML = '<div class="mt">正在读取项目和画布…</div>'; m.classList.add("on");
  await loadBoardDirectory();
  if (epoch === boardMenuEpoch && m.classList.contains("on")) renderBoardMenu();
});
document.addEventListener("pointerdown", e => { if (!e.target.closest(".menu, #bmenuBtn, #addBtn, #canvasLayoutBtn, .plus")) closeMenus(); });

// ================================================================= status, boot
async function status() {
  try {
    const s = await (await fetch("/api/status")).json(), q = (s.running || 0) + (s.pending || 0);
    $("#sd").className = "sd " + (!s.comfy ? "bad" : q ? "busy" : "ok");
    let qt = "";
    if (q || B?.nodes.some(n => n.job)) { try { const Q = await (await fetch("/api/queue")).json(); if (Q.jobs.length) qt = `${Q.jobs.length} 个任务 · 约 ${fmtT(Q.total)}`; } catch {} }
    $("#stt").textContent = (!s.comfy ? (s.loading ? "H3 引擎启动中…" : "生成引擎未启动") : qt ? `生成中 · ${qt}` : q ? `生成中 · 队列 ${q}` : "H3 引擎就绪") + (s.llm_running ? ` · 改写模型(${s.llm_device})` : "") + (s.remote ? ` · 文本：${s.remote}` : "") + (qt || q ? " ▾" : "");
  } catch { $("#sd").className = "sd bad"; $("#stt").textContent = "画布服务断开"; }
}
function updateEmpty() { $("#empty").classList.toggle("on", !B.nodes.length); }
addEventListener("resize", placeOverlays);
setInterval(() => B && B.nodes.forEach(n => n.job && renderJob(n)), 1000);
initTools();
initImageEditor();
initCanvasTools();
initAgentChat();
initFilm();
if (typeof initShotList === "function") initShotList();
initNodeSearch();
initCanvasComments();
initCanvasShare();
initWorkflowTemplates();
initWorkflowReview();
initPrevis();
initWizard();
initSettings();
initAccount();
initAssetLibrary();
(async () => {
  const qs = new URLSearchParams(location.search);
  const requested = qs.get("board");
  if (qs.get("board")) boardId = qs.get("board");
  await loadBoardDirectory();
  if (!boardDirectory.find(b => b.id === boardId)) {
    boardId = boardDirectory[0]?.id;
    if (!boardId) {   // a new member: start with an empty board of their own
      boardId = "b" + Date.now().toString(36);
      await boardRequest("/api/board/" + boardId, "PUT", emptyBoard());
    }
  }
  await loadCaps();
  await openBoard(boardId);
  if (requested && boardId !== requested) toast("画布链接不可用，或当前账号尚未获得访问权限",5000);
  const session = qs.get("session");
  if (requested === boardId && canvasCanEdit() && /^s[a-f0-9]{20}$/.test(session || "")) {
    localStorage.setItem("h3.chat.session."+boardId,session);
    await acOpen({focus:false});
  }
  if (qs.get("wizard") && canvasCanEdit()) openWizard();
  if (qs.get("samples")) showGallery();
  status(); setInterval(status, 4000);
})().catch(error => toast(error.message || "无法读取画布", 5000));
