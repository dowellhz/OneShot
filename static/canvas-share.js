"use strict";

const SHARE_ROLES = {reviewer:"可审阅", editor:"可编辑"};
const sharePath = () => "/api/board/" + encodeURIComponent(boardId) + "/access";
const snapshotPath = () => "/api/board/" + encodeURIComponent(boardId) + "/snapshot";
const showcasePath = () => "/api/board/" + encodeURIComponent(boardId) + "/showcase";
let shareItemState = null;

function shareClose() {
  shareItemState = null;
  $("#canvasShare").hidden = true;
  $("#shareBtn").setAttribute("aria-expanded","false");
}

function showcaseChoices(type) {
  return B.nodes.filter(n=>n.type === type).flatMap(n=>n.versions.map((v,i)=>({
    node:n.id,ref:v.ref,version:i+1,label:n.name+(n.versions.length > 1 ? " · 版本 "+(i+1) : ""),current:i===n.cur
  })).filter(v=>v.ref));
}

function shareItemOpen(editable) {
  const fieldset=$("#shareItems");
  fieldset.hidden=!editable;
  $("#shareItemDetails").open=false;
  $("#shareItemLinks").replaceChildren();
  $("#shareItemPreview").replaceChildren();
  $("#shareItemURL").value="";
  $("#shareItemLink").hidden=true;
  $("#shareItemConfirm").checked=false;
  $("#shareItemPublish").disabled=true;
  if(!editable) { shareItemState=null; return; }
  const state={bid:boardId,endpoint:"/api/board/"+encodeURIComponent(boardId)+"/shared-items",attempt:0};
  shareItemState=state;
  const alive=()=>shareItemState===state&&boardId===state.bid&&!$("#canvasShare").hidden;
  const message=text=>{$("#shareStatus").textContent=text;};
  const mode=$("#shareItemMode"), source=$("#shareItemSource"), recent=$("#shareItemRecent");
  recent.value="0";
  const button=$("#shareItemPreviewBtn"), publish=$("#shareItemPublish"), confirm=$("#shareItemConfirm");
  const media=["image","video","audio"].flatMap(showcaseChoices);
  const selected=media.findIndex(item=>item.current&&sel.has(item.node));
  function invalidate(){
    state.attempt++;
    state.preview=null;
    $("#shareItemPreview").replaceChildren();
    $("#shareItemLink").hidden=true;
    confirm.checked=false;
    publish.disabled=true;
  }
  function populate(){
    invalidate();
    const options=mode.value==="media" ? media.map((item,index)=>[index,item.label]) :
      (state.conversations||[]).map(item=>[item.id,item.title]);
    source.replaceChildren(...options.map(([id,text])=>new Option(text,id)));
    if(mode.value==="media"&&selected>=0)source.value=String(selected);
    recent.closest("label").hidden=mode.value==="media";
    button.disabled=!options.length;
    if(!options.length)source.add(new Option("暂无可分享内容",""));
  }
  function sourceData(){
    if(mode.value==="media"){
      const item=media[Number(source.value)];
      return {kind:"media",node:item.node,ref:item.ref,version:item.version};
    }
    return {kind:"conversation",session:source.value,recent:Number(recent.value)};
  }
  function showLink(token){
    const input=$("#shareItemURL");
    input.value=new URL("/shared-item/"+encodeURIComponent(token),location.origin).href;
    $("#shareItemLink").hidden=false;
  }
  async function refresh(){
    const response=await boardRequest(state.endpoint);
    if(!alive())return;
    state.conversations=response.conversations;
    const list=$("#shareItemLinks");
    list.innerHTML=response.items.map(item=>`<li><a href="/shared-item/${encodeURIComponent(item.token)}" target="_blank" rel="noopener">${esc(item.title)}</a>
      <button type="button" data-revoke-item="${esc(item.token)}">撤销</button></li>`).join("");
  }
  $("#shareItemDetails").ontoggle=async event=>{
    if(!event.target.open||!alive())return;
    try { await refresh(); if(alive())populate(); }
    catch(error) { if(alive())message(error.message); }
  };
  mode.value=selected>=0||media.length?"media":"conversation";
  mode.onchange=populate;
  source.onchange=recent.onchange=invalidate;
  confirm.onchange=()=>{publish.disabled=!confirm.checked||!state.preview;};
  button.onclick=async ()=>{
    invalidate();
    const attempt=state.attempt,data=sourceData();
    try {
      await flushSave();
      if(!alive()||attempt!==state.attempt)return;
      if(savePending?.id===state.bid||AC.pending.has(state.bid))throw new Error("画布正在保存，请稍后重试");
      const result=await boardRequest(state.endpoint+"/preview","POST",{source:data});
      if(!alive()||attempt!==state.attempt)return;
      state.preview={source:data,digest:result.digest};
      const pane=$("#shareItemPreview");
      pane.append(Object.assign(document.createElement("strong"),{textContent:result.title}));
      if(result.kind==="conversation"){
        for(const item of result.messages){
          const block=document.createElement("p");
          block.textContent=(item.role==="user"?"你":"创作助手")+" · "+item.text;
          pane.append(block);
        }
      }else{
        const element=document.createElement(result.media_type==="image"?"img":result.media_type);
        element.src=result.preview_url;
        if(result.media_type==="image")element.alt=result.title;
        else {element.controls=true;element.preload="metadata";}
        pane.append(element);
      }
      message("");
    } catch(error) { if(alive()&&attempt===state.attempt)message(error.message); }
  };
  publish.onclick=async ()=>{
    if(!state.preview||!confirm.checked||publish.disabled)return;
    publish.disabled=true;
    const reviewed=state.preview;
    try {
      const result=await boardRequest(state.endpoint,"POST",{...reviewed,confirmed:true});
      if(!alive())return;
      if(state.preview===reviewed)invalidate();
      showLink(result.token); message("链接已生成");
      await refresh();
    } catch(error) {
      if(alive()&&state.preview===reviewed){invalidate();message(error.message);}
    }
  };
  $("#shareItemLinks").onclick=async event=>{
    const control=event.target.closest("[data-revoke-item]");
    if(!control)return;
    if(control.textContent==="撤销"){control.textContent="确认撤销";return;}
    control.disabled=true;
    try {
      await boardRequest(state.endpoint+"/"+encodeURIComponent(control.dataset.revokeItem),"DELETE");
      if(!alive())return;
      if($("#shareItemURL").value.endsWith("/"+control.dataset.revokeItem))$("#shareItemLink").hidden=true;
      message("链接已撤销"); await refresh();
    } catch(error) { if(alive())message(error.message); }
    finally {control.disabled=false;}
  };
  populate();
}

function drawShowcase(entries) {
  const states = {pending:"待审核",approved:"已发布",rejected:"已退回"};
  $("#shareShowcaseEntries").innerHTML = entries.map(entry=>`<li>
    <span>${esc(entry.title)} · ${states[entry.state] || ""}</span>
    ${entry.reason ? `<p>${esc(entry.reason)}</p>` : ""}
    ${entry.state === "approved" ? `<a href="/showcase/${encodeURIComponent(entry.token)}" target="_blank" rel="noopener">查看作品</a>` : ""}
    <button type="button" data-withdraw="${esc(entry.token)}">撤回</button>
    ${entry.state==="approved" && entry.can_link_template ? `<details data-showcase-template-editor="${esc(entry.token)}">
      <summary>${entry.template_name ? (entry.template_published ? "工作流 · "+esc(entry.template_name) : "工作流 · 已取消共享") : "关联工作流"}</summary>
      <form class="share-form"><select aria-label="已共享的工作流模板" disabled></select><button type="submit" disabled>保存链接</button></form>
    </details>` : ""}
  </li>`).join("");
  for(const details of $$("[data-showcase-template-editor]",$("#shareShowcaseEntries"))){
    const token=details.dataset.showcaseTemplateEditor, entry=entries.find(item=>item.token===token);
    const form=$("form",details), select=$("select",form), saveLink=$("button",form), bid=boardId;
    const sync=()=>{saveLink.disabled=select.disabled || select.value===(entry.template_id||"");};
    details.ontoggle=async()=>{
      if(!details.open)return;
      select.disabled=true;sync();
      try { await populateShowcaseTemplates(select,entry); }
      catch(error){if(boardId===bid&&details.isConnected)$("#shareStatus").textContent=error.message;}
      sync();
    };
    select.onchange=sync;
    form.onsubmit=event=>{
      event.preventDefault();
      if(boardId===bid && !saveLink.disabled)void changeShowcase("PUT",token,{template:select.value||null});
    };
  }
}

async function populateShowcaseTemplates(select, linked=null) {
  const bid=boardId, options=await boardRequest("/api/canvas-templates");
  if(bid!==boardId || !select.isConnected)return;
  select.replaceChildren(new Option("不附工作流",""));
  for(const row of options.filter(item=>item.published))select.add(new Option(row.name,row.id));
  if(linked?.template_id){
    if(![...select.options].some(option=>option.value===linked.template_id)){
      const unavailable=new Option("当前模板已取消共享",linked.template_id);
      unavailable.disabled=true;
      select.add(unavailable);
    }
    select.value=linked.template_id;
  }
  select.disabled=select.options.length<2;
}

function setupShowcaseForm() {
  const videos = showcaseChoices("video"), images = showcaseChoices("image");
  const match = videos.findIndex(v=>v.current && sel.has(v.node));
  const selected = match >= 0 ? match : videos.findIndex(v=>v.current);
  const options = values => values.map((value,i)=>`<option value="${i}">${esc(value.label)}</option>`).join("");
  const video = $("#shareShowcaseVideo");
  const cover = $("#shareShowcaseCover");
  const template = $("#shareShowcaseTemplate");
  const videoInput = $("#shareShowcaseVideoFile"), coverInput = $("#shareShowcaseCoverFile");
  const upload = '<option value="upload">从本地上传</option>';
  video.innerHTML = options(videos) + upload;
  video.value = videos.length ? String(Math.max(0,selected)) : "upload";
  cover.innerHTML = '<option value="">使用视频首帧</option>' + options(images) + upload;
  videoInput.value = coverInput.value = "";
  const syncInput = (select,input)=>{
    input.required = select.value === "upload";
    input.closest("label").hidden = !input.required;
  };
  video.onchange = ()=>syncInput(video,videoInput);
  cover.onchange = ()=>syncInput(cover,coverInput);
  video.onchange(); cover.onchange();
  $("#shareShowcaseTitle").value = B.name.slice(0,80);
  $("#shareShowcaseDescription").value = "";
  $("#shareShowcaseAttach").checked = false;
  $("#shareShowcaseForm").hidden = false;
  template.replaceChildren(new Option("不附工作流",""));
  template.disabled = true;
  populateShowcaseTemplates(template).catch(()=>{});
  $("#shareShowcaseForm").onsubmit = e=>{
    e.preventDefault();
    const choice = values => ({node:values.node,ref:values.ref});
    const videoFile = video.value === "upload" ? videoInput.files[0] : null;
    const coverFile = cover.value === "upload" ? coverInput.files[0] : null;
    if (videoFile?.size > 300000000 || coverFile?.size > 20000000) {
      $("#shareStatus").textContent = "成片最多 300 MB，封面最多 20 MB";
      return;
    }
    changeShowcase("POST","",{
      video:videoFile ? null : choice(videos[Number(video.value)]),
      cover:coverFile || cover.value === "" ? null : choice(images[Number(cover.value)]),
      title:$("#shareShowcaseTitle").value,description:$("#shareShowcaseDescription").value,
      attach_canvas:$("#shareShowcaseAttach").checked,template:template.value || null,confirmed:true
    },{video:videoFile,cover:coverFile});
  };
  $("#shareShowcaseTitle").focus();
}

function sendShowcaseFiles(url,payload,files,onProgress) {
  const form = new FormData();
  form.append("metadata",JSON.stringify(payload));
  for (const [kind,file] of Object.entries(files)) if (file) form.append(kind,file);
  return new Promise((resolve,reject)=>{
    const xhr = new XMLHttpRequest();
    xhr.open("POST",url);
    xhr.responseType = "json";
    xhr.upload.onprogress = e=>{if (e.lengthComputable) onProgress(Math.round(100*e.loaded/e.total));};
    xhr.onload = ()=>{
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
      else reject(new Error(xhr.response?.error || (xhr.status === 413 ? "文件超过上传大小限制" : "发布失败，请稍后重试")));
    };
    xhr.onerror = ()=>reject(new Error("上传中断，请检查网络后重试"));
    xhr.send(form);
  });
}

async function changeShowcase(method, token, payload, files={}) {
  const bid = boardId, fieldset = $("#shareShowcase"), url = showcasePath();
  const progress = $("#shareShowcaseProgress");
  if (fieldset.disabled) return;
  fieldset.disabled = true;
  try {
    if (method === "POST") {
      await flushSave();
      if (bid !== boardId) return;
      if (savePending?.id === bid || AC.pending.has(bid)) throw new Error("画布尚未保存，请先保存再提交");
    }
    const body = payload && {...payload,revision:B.rev};
    if (files.video || files.cover) {
      progress.value = 0; progress.hidden = false;
      $("#shareStatus").textContent = "正在上传文件…";
      await sendShowcaseFiles(url,body,files,value=>{
        if (bid !== boardId) return;
        progress.value = value;
        if (value === 100) $("#shareStatus").textContent = "正在检查成片和封面…";
      });
    } else {
      const target=token?url+"/"+encodeURIComponent(token):url;
      await boardRequest(method==="PUT"?target+"/template":target,method,body);
    }
    const entries = await boardRequest(url);
    if (bid !== boardId || $("#canvasShare").hidden) return;
    drawShowcase(entries);
    if (method === "POST") $("#shareShowcaseForm").hidden = true;
    if(method==="PUT")$("[data-showcase-template-editor='"+token+"'] summary")?.focus();
    $("#shareStatus").textContent = method === "PUT" ? "工作流链接已更新" : method === "DELETE" ? "作品已撤回" : "作品已提交审核";
  } catch (error) {
    if (bid === boardId) $("#shareStatus").textContent = error.message;
  } finally {
    if (bid === boardId) { fieldset.disabled = false; progress.hidden = true; }
  }
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
  list.innerHTML = data.collaborators.map(a=>`<div class="share-account" data-username="${esc(a.username)}">
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
      ${team.managed && !member.manager ? `<button type="button" data-team-remove="${esc(member.username)}">移除</button>`:""}</li>`).join("");
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
  const editable = B.access === "owner" || !B.access && B.owner === ME_USER?.id;
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
  document.body.insertAdjacentHTML("beforeend",`<section id="canvasShare" aria-labelledby="shareTitle" hidden>
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
      <button type="button" id="shareShowcaseOpen">发布成片</button>
      <form id="shareShowcaseForm" hidden>
        <label>成片<select id="shareShowcaseVideo" required></select></label>
        <label hidden>视频文件（最多 300 MB）<input type="file" id="shareShowcaseVideoFile" accept=".mp4,.mov,.webm"></label>
        <label>封面<select id="shareShowcaseCover"></select></label>
        <label hidden>封面文件（最多 20 MB）<input type="file" id="shareShowcaseCoverFile" accept=".png,.jpg,.jpeg,.webp"></label>
        <label>标题<input id="shareShowcaseTitle" maxlength="80" required></label>
        <label>简介<textarea id="shareShowcaseDescription" maxlength="500" rows="3"></textarea></label>
        <label class="share-team"><input type="checkbox" id="shareShowcaseAttach">附上可公开查看和复制的画布</label>
        <label>已共享的工作流模板<select id="shareShowcaseTemplate"></select></label>
        <p>审核通过后，访客可观看视频。勾选附上画布时，访客也能查看画布中的文本和当前素材。</p>
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
  $("#shareShowcaseOpen").onclick = setupShowcaseForm;
  $("#shareShowcaseCancel").onclick = ()=>{$("#shareShowcaseForm").hidden=true;$("#shareShowcaseOpen").focus();};
  $("#shareShowcaseEntries").onclick = e=>{
    const button=e.target.closest("[data-withdraw]");
    if(!button)return;
    if(button.textContent === "撤回") { button.textContent="确认撤回"; return; }
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
