"use strict";

const conflictKey = id => "h3.chat.conflict." + id;
const conflictPath = id => "/api/board/" + encodeURIComponent(id);

function persistCanvasConflict(id, state) {
  try { localStorage.setItem(conflictKey(id), JSON.stringify({base:state.base,draft:state.draft})); } catch {}
}

function acGuardSave() {
  const state = AC.pending.get(boardId);
  if (!state) return false;
  state.draft = acClone(liveBoardData(B));
  persistCanvasConflict(boardId, state);
  return true;
}

function acHoldConflict(p, base) {
  const state = {base,draft:acClone(liveBoardData(p.b))};
  AC.pending.set(p.id, state);
  persistCanvasConflict(p.id, state);
  renderCanvasConflict();
  return true;
}

function renderCanvasConflict() {
  const banner = $("#acConflict");
  banner.hidden = !AC.pending.has(boardId);
  $("button",banner).onclick = () => showCanvasConflict(boardId);
}

function restoreCanvasConflict() {
  closeCanvasConflict();
  const id = boardId;
  let state = AC.pending.get(id);
  if (!state) {
    try {
      const saved = JSON.parse(localStorage.getItem(conflictKey(id)));
      if (Array.isArray(saved?.draft?.nodes)) state = saved;
      else if (Array.isArray(saved?.nodes)) state = {base:null,draft:saved};
      if (state) AC.pending.set(id,state);
    } catch {}
  }
  if (state && canvasCanEdit()) {
    const {access,owner,shared,rev,agent_ops} = B;
    acApplyBoard({...acClone(state.draft),access,owner,shared,rev,agent_ops});
    $("#bname").textContent = B.name;
  }
  renderCanvasConflict();
}

const conflictFields = {name:"名称",x:"横向位置",y:"纵向位置",prompt:"提示词",text:"文本",versions:"历史版本",cur:"所选版本",data:"设置",groups:"分组",edges:"输入连线",shared:"共享状态"};

function canvasConflictLabel(path, nodes) {
  const [kind,id,...field] = path;
  if (kind === "nodes") return [nodes.get(id) || id, field.length ? field.map(k=>conflictFields[k]||k).join(" · ") : "整个节点"].join(" · ");
  if (kind === "edges" && id) return (nodes.get(id) || id) + " · 输入连线";
  return path.map(k=>conflictFields[k]||k).join(" · ");
}

function canvasConflictValue(value) {
  if (typeof value === "symbol" || value === undefined) return "已移除";
  const text = typeof value === "string" ? value : JSON.stringify(value,null,2);
  return text || "空白";
}

function closeCanvasConflict() {
  const dialog = $("#canvasConflictReview");
  if (dialog.open) dialog.close?.();
  dialog.removeAttribute("open");
}

async function showCanvasConflict(id, notice="") {
  const state = AC.pending.get(id);
  if (id !== boardId || !state) return;
  const dialog = $("#canvasConflictReview"), status = $("[role=status]",dialog), list = $("ol",dialog);
  const close = $("[data-conflict-close]",dialog), copy = $("[data-conflict-copy]",dialog);
  const saveChoice = $("[data-conflict-save]",dialog), bulk = $("[data-conflict-bulk]",dialog);
  const bulkButtons = $$("button",bulk);
  const draft = state.draft;
  const conflicts = [];
  let canMerge = false;
  let latest;
  const selected = () => $$("input:checked",list);
  const updateActions = () => {
    saveChoice.disabled = state.saving || !canMerge || selected().length !== conflicts.length;
    for (const button of bulkButtons) button.disabled = !!state.saving;
  };
  const stillOpen = () => dialog.open && boardId===id && AC.pending.get(id)===state && close.onclick===closeReview;
  const closeReview = () => closeCanvasConflict();
  close.onclick = closeReview;
  close.disabled = false;
  dialog.oncancel = event => { if (state.saving) event.preventDefault(); };
  dialog.onkeydown = event => event.stopPropagation();
  copy.onclick = () => {
    const candidate = {...draft,rev:undefined,agent_ops:undefined,shared:false,collaborators:undefined,name:(draft.name || "画布")+" · 本地副本"};
    return submit(candidate,true);
  };
  status.textContent = "正在读取共享画布…";
  list.replaceChildren();
  bulk.hidden = true;
  saveChoice.disabled = copy.disabled = true;
  if (!dialog.open) {
    if (dialog.showModal) dialog.showModal();
    else dialog.setAttribute("open", "");
  }
  try {
    const remote = await acApi(conflictPath(id));
    if (!Array.isArray(remote?.nodes)) throw new Error("共享画布已无法读取");
    latest = remote;
  } catch (error) {
    if (stillOpen()) {
      status.textContent = error.message + "。可将本地改动保存为副本。";
      copy.disabled = false;
    }
    return;
  }
  if (!stillOpen()) return;

  if (Array.isArray(state.base?.nodes) && latest.access !== "reviewer") {
    try {
      acMerge(state.base,draft,latest,(path,left,right)=>{
        conflicts.push({path,left,right});
        return left;
      });
      canMerge = true;
    } catch { canMerge = conflicts.length > 0; }
  }
  const names = new Map([...latest.nodes,...draft.nodes].map(n=>[n.id,n.name]));
  list.innerHTML = conflicts.map(({path,left,right},index)=>`<li><fieldset><legend>${esc(canvasConflictLabel(path,names))}</legend>
    <div>${[["local","我的改动",left],["remote","共享版本",right]].map(([side,title,value])=>`<section>
      <label><input type="radio" name="canvas-conflict-${index}" data-conflict-key="${esc(JSON.stringify(path))}" value="${side}"> ${title}</label>
      <pre tabindex="0">${esc(canvasConflictValue(value))}</pre></section>`).join("")}</div></fieldset></li>`).join("");
  status.textContent = notice || (canMerge ? (conflicts.length ? "逐项选择要保留的内容。双方互不冲突的改动会一并保存。" : "当前改动已可合并，可以直接保存到画布。") : "这一处暂时无法在原画布合并，可以将我的改动保存为副本。");
  bulk.hidden = conflicts.length < 2;
  list.onchange = updateActions;
  for (const button of bulkButtons) button.onclick = () => {
    for (const input of $$("input",list)) input.checked = input.value === button.dataset.selectSide;
    updateActions();
  };
  saveChoice.onclick = () => {
    if (!stillOpen() || saveChoice.disabled) return;
    if (draft !== state.draft) return showCanvasConflict(id,"本地草稿已更新，请重新核对。");
    const decisions = new Map(selected().map(input=>[input.dataset.conflictKey,input.value]));
    let candidate;
    try {
      candidate = acMerge(state.base,draft,latest,(path,left,right)=>{
        const side = decisions.get(JSON.stringify(path));
        if (!side) throw new Error("请选择要保留的内容");
        return side === "local" ? left : right;
      });
    } catch (error) {
      status.textContent = error.message + "。可调整选项或保存私有副本。";
      return;
    }
    return submit(candidate,false);
  };
  updateActions();

  async function submit(candidate, asCopy) {
    if (!stillOpen() || state.saving || !candidate) return;
    if (draft !== state.draft) return showCanvasConflict(id,"本地草稿已更新，请重新核对。");
    const target = asCopy ? "b" + newCanvasNodeId().slice(1) : id;
    state.saving = true;
    for (const control of [saveChoice,...bulkButtons,...$$("input",list),copy,close]) control.disabled = true;
    try {
      const response = await fetch(conflictPath(target),{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(candidate)});
      if (response.status === 409 && !asCopy) {
        if (stillOpen()) return showCanvasConflict(id,"共享画布又有更新，请重新核对。");
        return;
      }
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "保存失败");
      if (asCopy && !latest && boardId === id && state.draft === draft) {
        if (!await openBoard(target,draft) && boardId === id) throw new Error("副本已保存，请从画布列表打开");
      }
      if (state.draft !== draft) {
        if (!asCopy) state.base = draft;
        persistCanvasConflict(id,state);
        if (stillOpen()) return showCanvasConflict(id,"已保存所选版本。本地还有新增改动，请重新核对。");
        return;
      }
      AC.pending.delete(id);
      try { localStorage.removeItem(conflictKey(id)); } catch {}
      const saved = asCopy ? latest : {...candidate,rev:result.rev};
      if (saved) acRememberBoard(id,saved);
      else AC.base.delete(id);
      if (saved && boardId === id) {
        acApplyBoard(saved,true);
        $("#bname").textContent = B.name;
        closeCanvasConflict();
        renderCanvasConflict();
      }
      if (asCopy) loadBoardDirectory().catch(()=>{});
      toast(asCopy ? "本地改动已保存为私有画布副本" : "画布冲突已处理");
    } catch (error) {
      if (stillOpen()) {
        status.textContent = error.message;
        copy.disabled = false;
      }
    } finally {
      state.saving = false;
      if (stillOpen()) {
        close.disabled = false;
        for (const input of $$("input",list)) input.disabled = false;
        updateActions();
      }
    }
  }
  copy.disabled = false;
}
