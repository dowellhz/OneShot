"use strict";

const SHARE_ROLES = {reviewer:"可审阅", editor:"可编辑"};
const sharePath = () => "/api/board/" + encodeURIComponent(boardId) + "/access";
const snapshotPath = () => "/api/board/" + encodeURIComponent(boardId) + "/snapshot";
function shareClose() {
  shareItemState = null;
  $("#canvasShare").hidden = true;
  $("#shareBtn").setAttribute("aria-expanded","false");
}

function drawSharePermissions(data) {
  $("#shareTeam").checked = data.shared;
  $("#shareTeam").disabled = !!data.team;
  const destination = $("#shareTeamTarget");
  const options = canvasTeams.map(team=>`<option value="${esc(team.id)}">${esc(team.name)}</option>`).join("");
  destination.innerHTML = '<option value="">个人空间</option>'+options;
  if (data.team && !canvasTeams.some(team=>team.id===data.team)) {
    destination.add(new Option("当前所属团队",data.team));
  }
  destination.value = data.team || "";
  destination.disabled = $("#shareTeamMove button").disabled = B.owner !== ME_USER?.id;
  const list = $("#sharePeople");
  list.innerHTML = data.collaborators.map(a=>OneShotI18n.html`<div class="share-account" data-username="${esc(a.username)}">
    <span title="${esc(a.username)}">${esc(a.name || a.username)}${a.disabled ? " · 已停用" : ""}</span>
    <select aria-label="${esc(a.username)}的权限">${Object.entries(SHARE_ROLES).map(([role,label])=>
      `<option value="${role}" ${a.role===role?"selected":""}>${label}</option>`).join("")}</select>
    <button type="button" aria-label="移除 ${esc(a.username)}">移除</button></div>`).join("");
  $$(".share-account",list).forEach(row=>{
    const username = row.dataset.username;
    $("select",row).onchange = e=>changeSharePermissions({username,role:e.target.value});
    $("button",row).onclick = ()=>changeSharePermissions({username,role:null});
  });
}

async function showShareTeamMembers() {
  const select=$("#shareManagedTeam"), team=canvasTeams.find(item=>item.id===select.value);
  const list=$("#shareTeamRoster"), invite=$("#shareTeamInvite"), bid=boardId;
  invite.hidden=true;
  list.replaceChildren();
  if (!team) return;
  try {
    const url="/api/canvas-teams/"+encodeURIComponent(team.id)+"/members";
    const members=await boardRequest(url);
    if (bid!==boardId || select.value!==team.id) return;
    list.innerHTML=members.map(member=>`<li><span>${esc(member.name || member.username)}${member.manager?" · 管理员":""}</span>
      ${team.managed && !member.manager ? OneShotI18n.html`<button type="button" data-team-remove="${esc(member.username)}">移除</button>`:""}</li>`).join("");
    invite.hidden=!team.managed;
  } catch(error) { if(bid===boardId)$("#shareStatus").textContent=error.message; }
}

async function changeTeamRoster(payload) {
  const team = $("#shareManagedTeam").value, bid=boardId;
  if (!team) return;
  const controls=$("#shareTeamSettings");
  controls.disabled=true;
  try {
    await boardRequest("/api/canvas-teams/"+encodeURIComponent(team)+"/members","PATCH",payload);
    if(bid!==boardId)return;
    await showShareTeamMembers();
    $("#shareStatus").textContent="团队成员已更新";
    $("#shareTeamUsername").value="";
  } catch(error) { if(bid===boardId)$("#shareStatus").textContent=error.message; }
  finally { controls.disabled=false; }
}

function drawManagedTeams(selected) {
  const select=$("#shareManagedTeam");
  const current=selected || select.value;
  select.innerHTML='<option value="">选择团队</option>'+canvasTeams.map(team=>
    `<option value="${esc(team.id)}">${esc(team.name)}</option>`).join("");
  select.value=canvasTeams.some(team=>team.id===current)?current:"";
  return showShareTeamMembers();
}

function drawPublicSnapshot(data) {
  const active = !!data?.token;
  $("#publicLink").hidden = !active;
  $("#publicPublish").hidden = active;
  $("#publicRevoke").hidden = !active;
  $("#publicURL").value = active ? new URL("/share/"+data.token,location.origin).href : "";
  $("#publicState").textContent = active ? "发布于 " + new Date(data.created*1000).toLocaleString() : "";
}

async function changePublicSnapshot(method) {
  const bid = boardId, controls = $("#sharePublic"), url = snapshotPath();
  if (controls.disabled) return;
  controls.disabled = true;
  try {
    if (method === "PUT") await flushSave();
    if (boardId !== bid) return;
    const data = await boardRequest(url,method);
    if (boardId !== bid) return;
    drawPublicSnapshot(data);
    $("#shareStatus").textContent = method === "DELETE" ? "公开链接已撤销" : "公开快照已发布";
  } catch (error) {
    if (boardId === bid) $("#shareStatus").textContent=error.message;
  } finally { if(boardId === bid) controls.disabled=false; }
}

async function changeSharePermissions(payload) {
  const bid = boardId, url = sharePath(), controls = $("#shareManage");
  if (controls.disabled) return false;
  controls.disabled = true;
  try {
    await flushSave();
    if (boardId !== bid) return false;
    const data = await boardRequest(url,"PATCH",payload);
    if (boardId !== bid) return false;
    await acSyncBoard(data.rev,true);
    if (Object.hasOwn(payload,"team")) await loadBoardDirectory();
    if (boardId !== bid) return false;
    drawSharePermissions(data);
    $("#shareStatus").textContent = "权限已更新";
    return true;
  } catch (error) {
    if (boardId === bid) {
      $("#shareStatus").textContent = error.message;
      await boardRequest(url).then(data=>{if(boardId===bid)drawSharePermissions(data);}).catch(()=>{});
    }
    return false;
  } finally { controls.disabled = false; }
}

async function shareOpen() {
  if (!B) return;
  const bid = boardId, panel = $("#canvasShare"), link = $("#shareURL");
  link.value = new URL("/?board="+encodeURIComponent(bid),location.origin).href;
  $("#shareStatus").textContent = "";
  $("#shareMode").textContent = B.access === "reviewer" ? "你可以查看画布并参与评论。" : "使用已获授权的 OneShot 账号登录后打开链接。";
  const editable = showcaseCanPublish();
  const connector = $("#shareConnector");
  connector.hidden = !editable || B.owner !== ME_USER?.id;
  connector.href = "/connect-agents?board="+encodeURIComponent(bid);
  const controls = $("#shareManage");
  controls.hidden = !editable; controls.disabled = true;
  const publicControls = $("#sharePublic");
  publicControls.hidden = !editable; publicControls.disabled = true;
  const showcaseControls = $("#shareShowcase");
  showcaseControls.hidden = !editable; showcaseControls.disabled = true;
  $("#shareShowcaseForm").hidden = true;
  $("#shareShowcaseProgress").hidden = true;
  $("#shareShowcaseEntries").replaceChildren();
  $("#sharePeople").replaceChildren(); $("#shareUser").value="";
  panel.hidden = false;
  shareItemOpen(editable && B.owner===ME_USER?.id);
  $("#shareBtn").setAttribute("aria-expanded","true");
  $("#shareCopy").focus();
  if (!editable) return;
  const [accounts, snapshot, entries, teams] = await Promise.allSettled([
    boardRequest(sharePath()),boardRequest(snapshotPath()),boardRequest(showcasePath()),boardRequest("/api/canvas-teams")
  ]);
  if (boardId !== bid || panel.hidden) return;
  if (teams.status==="fulfilled" && Array.isArray(teams.value)) canvasTeams=teams.value;
  if (accounts.status === "fulfilled") { drawSharePermissions(accounts.value); controls.disabled = false; }
  if (accounts.status==="fulfilled") void drawManagedTeams(accounts.value.team);
  if (snapshot.status === "fulfilled") { drawPublicSnapshot(snapshot.value); publicControls.disabled = false; }
  if (entries.status === "fulfilled" && Array.isArray(entries.value)) {
    drawShowcase(entries.value); showcaseControls.disabled = false;
  }
  if ([accounts,snapshot,entries].some(result=>result.status === "rejected")) $("#shareStatus").textContent = "部分分享设置读取失败，可以关闭后重试";
}

async function copyShareURL(link) {
  try { await navigator.clipboard.writeText(link.value); $("#shareStatus").textContent="已复制链接"; }
  catch { link.focus(); link.select(); $("#shareStatus").textContent="链接已选中，可以手动复制"; }
}

function initCanvasShare() {
  document.body.insertAdjacentHTML("beforeend",OneShotI18n.html`<section id="canvasShare" aria-labelledby="shareTitle" hidden>
    <header><strong id="shareTitle">分享画布</strong><a href="/showcase" target="_blank" rel="noopener">成片展映</a><a href="/connect-agents" id="shareConnector" target="_blank" rel="noopener" hidden>连接外部助手</a><button type="button" id="shareClose" aria-label="收起分享">×</button></header>
    <div id="shareMode"></div>
    <div class="share-link"><input id="shareURL" aria-label="画布链接" readonly><button type="button" id="shareCopy">复制链接</button></div>
    <fieldset id="shareManage" hidden>
      <form class="share-form" id="shareTeamMove"><select id="shareTeamTarget" aria-label="画布所在团队"></select>
        <button type="submit">应用共享范围</button></form>
      <details id="shareTeamEditor"><summary>管理团队</summary>
        <fieldset id="shareTeamSettings"><form class="share-form" id="shareTeamCreate">
          <input id="shareTeamName" placeholder="团队名称" aria-label="团队名称" maxlength="60" required><button>创建团队</button>
        </form>
        <label>成员名单 <select id="shareManagedTeam" aria-label="查看团队成员"></select></label><ul id="shareTeamRoster"></ul>
        <form class="share-form" id="shareTeamInvite" hidden>
          <input id="shareTeamUsername" placeholder="输入已有账号" aria-label="团队成员账号" required>
          <button>添加成员</button>
        </form></fieldset>
      </details>
      <label class="share-team"><input type="checkbox" id="shareTeam">所有平台账号可编辑</label>
      <p>单独邀请设置的权限优先。团队成员可编辑团队画布。</p>
      <div id="sharePeople"></div>
      <form class="share-form" id="shareDirectInvite"><input id="shareUser" placeholder="输入 OneShot 账号" aria-label="邀请账号" maxlength="120" required>
        <select id="shareRole" aria-label="邀请权限"><option value="reviewer">可审阅</option><option value="editor">可编辑</option></select>
        <button type="submit">添加</button></form>
    </fieldset>
    <fieldset id="shareItems" hidden><details id="shareItemDetails"><summary>分享作品或对话</summary>
      <label>内容类型 <select id="shareItemMode" aria-label="内容类型"><option value="media">单个作品</option><option value="conversation">创作对话</option></select></label>
      <label>选择内容 <select id="shareItemSource" aria-label="选择内容"></select></label>
      <label>消息范围 <select id="shareItemRecent" aria-label="消息范围"><option value="0">全部</option><option value="20">最近 20 条</option><option value="50">最近 50 条</option></select></label>
      <button type="button" id="shareItemPreviewBtn">预览公开内容</button>
      <div id="shareItemPreview"></div>
      <label class="share-team"><input type="checkbox" id="shareItemConfirm">我确认持链接者可以查看所预览的内容</label>
      <button type="button" id="shareItemPublish" disabled>生成公开链接</button>
      <div id="shareItemLink" class="share-link" hidden><input readonly id="shareItemURL" aria-label="作品或对话链接"><button id="shareItemCopy" type="button">复制链接</button></div>
      <ul id="shareItemLinks"></ul>
    </details></fieldset>
    <fieldset id="sharePublic" hidden>
      <legend>公开快照</legend>
      <p>任何获得链接的人都能查看发布时显示的画布内容，登录后可以复制。发布后可以撤销链接。</p>
      <button type="button" id="publicPublish">发布公开快照</button>
      <div id="publicLink" class="share-link" hidden><input readonly id="publicURL" aria-label="公开快照链接">
        <button type="button" id="publicCopy">复制链接</button></div>
      <div id="publicState"></div>
      <button type="button" id="publicRevoke" hidden>撤销公开链接</button>
    </fieldset>
    <fieldset id="shareShowcase" hidden>
      <legend>成片展映</legend>
      <button type="button" id="shareShowcaseOpen">发布作品</button>
      <form id="shareShowcaseForm" hidden>
        <label>作品<select id="shareShowcaseVideo" required></select></label>
        <label hidden>视频或 GIF（最多 300 MB）<input type="file" id="shareShowcaseVideoFile" accept=".mp4,.mov,.webm,.gif"></label>
        <label>封面<select id="shareShowcaseCover"></select></label>
        <label hidden>封面文件（最多 20 MB）<input type="file" id="shareShowcaseCoverFile" accept=".png,.jpg,.jpeg,.webp"></label>
        <label>标题<input id="shareShowcaseTitle" maxlength="80" required></label>
        <label>简介<textarea id="shareShowcaseDescription" maxlength="500" rows="3"></textarea></label>
        <label class="share-team"><input type="checkbox" id="shareShowcaseAttach">附上可公开查看和复制的画布</label>
        <label class="share-team"><input type="checkbox" id="shareShowcaseAttachPrompt">公开一段可复用的提示词</label>
        <label hidden>访客可查看和复制以下文字<textarea id="shareShowcasePrompt" maxlength="5000" rows="4"></textarea></label>
        <label>已共享的工作流模板<select id="shareShowcaseTemplate"></select></label>
        <p>审核通过后，访客可观看作品。勾选附上画布时，访客也能查看画布中的文本和当前素材。</p>
        <progress id="shareShowcaseProgress" max="100" value="0" aria-label="上传进度" hidden></progress>
        <div class="share-form"><button type="submit" id="shareShowcasePublish">提交审核</button>
          <button type="button" id="shareShowcaseCancel">取消</button></div>
      </form>
      <ul id="shareShowcaseEntries"></ul>
    </fieldset>
    <p id="shareStatus" role="status"></p>
  </section>`);
  $("#shareBtn").onclick = ()=>$("#canvasShare").hidden ? shareOpen() : shareClose();
  $("#shareClose").onclick = shareClose;
  $("#canvasShare").onkeydown = e=>{e.stopPropagation();if(e.key==="Escape")shareClose();};
  $("#shareCopy").onclick = ()=>copyShareURL($("#shareURL"));
  $("#shareItemCopy").onclick = ()=>copyShareURL($("#shareItemURL"));
  $("#publicCopy").onclick = ()=>copyShareURL($("#publicURL"));
  $("#publicPublish").onclick = ()=>changePublicSnapshot("PUT");
  $("#publicRevoke").onclick = ()=>changePublicSnapshot("DELETE");
  $("#shareShowcaseOpen").onclick = () => setupShowcaseForm();
  $("#shareShowcaseCancel").onclick = ()=>{$("#shareShowcaseForm").hidden=true;$("#shareShowcaseOpen").focus();};
  $("#shareShowcaseEntries").onclick = e=>{
    const button=e.target.closest("[data-withdraw]");
    if(!button)return;
    if(!button.dataset.confirmed) { button.dataset.confirmed="true";button.textContent=OneShotI18n.t("确认撤回"); return; }
    changeShowcase("DELETE",button.dataset.withdraw);
  };
  $("#shareTeam").onchange = e=>changeSharePermissions({shared:e.target.checked});
  $("#shareTeamMove").onsubmit = e=>{
    e.preventDefault();
    if(B.owner===ME_USER?.id) changeSharePermissions({team:$("#shareTeamTarget").value || null});
  };
  $("#shareManagedTeam").onchange = showShareTeamMembers;
  $("#shareTeamCreate").onsubmit = async e=>{
    e.preventDefault();
    const bid=boardId, input=$("#shareTeamName"), controls=$("#shareTeamSettings");
    controls.disabled=true;
    try {
      const team=await boardRequest("/api/canvas-teams","POST",{name:input.value});
      if (bid!==boardId) return;
      canvasTeams.push(team);
      input.value="";
      drawSharePermissions(await boardRequest(sharePath()));
      await drawManagedTeams(team.id);
      $("#shareStatus").textContent="团队已创建";
    } catch(error) { if(bid===boardId)$("#shareStatus").textContent=error.message; }
    finally { controls.disabled=false; }
  };
  $("#shareTeamInvite").onsubmit = e=>{
    e.preventDefault();
    changeTeamRoster({username:$("#shareTeamUsername").value,action:"add"});
  };
  $("#shareTeamRoster").onclick = e=>{
    const button=e.target.closest("[data-team-remove]");
    if(button)changeTeamRoster({username:button.dataset.teamRemove,action:"remove"});
  };
  $("#shareDirectInvite").onsubmit = async e=>{
    e.preventDefault();
    const input = $("#shareUser"), username = input.value.trim();
    if(username && await changeSharePermissions({username,role:$("#shareRole").value})) input.value="";
  };
  initCanvasLive();
}
