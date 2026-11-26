"use strict";

let consoleCanvasDirectory = null;
const canvasDirectoryPrefs = {query:"",scope:"all",team:"",type:"all",folder:"",sort:"newest"};
const directorySorts = {
  newest:"最近修改",oldest:"最早修改",created:"最新创建",first:"最早创建",name:"按名称"
};

const directoryText = (label, values) => OneShotI18n.t(label, values);

function directoryCanvasCount(count) {
  return directoryText(count===1?"1 张画布":"{count} 张画布",{count});
}

function directoryMessage(text) {
  const status=$("#directoryStatus");
  if (status) status.textContent=directoryText(text);
}

async function pgProjects() {
  const state={all:ME.role==="admin"&&localStorage.getItem("c.allp")==="1",selected:new Set(),selecting:false};
  consoleCanvasDirectory=state;
  const active=()=>consoleCanvasDirectory===state;
  const run=fn=>async event=>{
    try { await fn(event); }
    catch(error) { if(active())directoryMessage(error.message||"操作失败"); }
  };
  async function refresh(){
    const [boards,projects,teams]=await Promise.all([
      api("/api/boards"+(state.all?"?all=1":"")),api("/api/canvas-projects"),api("/api/canvas-teams")
    ]);
    if(!active())return;
    Object.assign(state,{boards,projects,teams});
    if(!state.projects.some(project=>project.id===canvasDirectoryPrefs.folder))canvasDirectoryPrefs.folder="";
    if(!state.teams.some(team=>team.id===canvasDirectoryPrefs.team))canvasDirectoryPrefs.team="";
    $("#directoryTeam").replaceChildren(new Option(directoryText("所有团队"),""),...teams.map(team=>new Option(team.name,team.id)));
    $("#directoryTeam").value=canvasDirectoryPrefs.team;
    renderDirectory(state);
  }
  const [samples,users]=await Promise.all([api("/api/samples").catch(()=>[]),
    ME.role==="admin"?api("/api/admin/users").catch(()=>[]):[]]);
  if(!active())return;
  state.users=new Map(users.map(user=>[user.id,user.name||user.username]));
  $("#main").innerHTML=OneShotI18n.html`<h1>项目和画布</h1>
    <div class="grid newcards">
      <button class="nc grad" type="button" data-directory-new="wiz"><b>一句话成片</b><small>从一句想法开始制作短片</small></button>
      <button class="nc" type="button" data-directory-new="blank"><b>＋ 空白画布</b><small>自由搭建工作流</small></button>
      <button class="nc" type="button" data-directory-new="brief"><b>从创作需求开始</b><small>新建画布并交给创作助手</small></button>
      ${samples.length?OneShotI18n.html`<button class="nc" type="button" data-directory-new="samples"><b>看示例</b></button>`:""}
    </div>
    <div class="directory-filters">
      <input class="in" type="search" id="directoryQuery" aria-label="搜索画布和项目" placeholder="搜索画布和项目" maxlength="120">
      <select class="in" id="directoryScope" aria-label="画布范围"><option value="all">所有可见画布</option><option value="personal">我的个人画布</option><option value="team">团队画布</option><option value="shared">共享给我的画布</option></select>
      <select class="in" id="directoryTeam" aria-label="筛选团队" hidden></select>
      <select class="in" id="directoryType" aria-label="筛选类型"><option value="all">项目和画布</option><option value="boards">仅画布</option><option value="projects">仅项目</option></select>
      <select class="in" id="directorySort" aria-label="排序">${Object.entries(directorySorts).map(([key,label])=>`<option value="${key}">${directoryText(label)}</option>`).join("")}</select>
      <button class="btn" id="directoryLayout" type="button">列表视图</button>
      <button class="btn" id="directoryCreate" type="button">新建项目</button>
      ${ME.role==="admin"?OneShotI18n.html`<label><input id="directoryAll" type="checkbox" ${state.all?"checked":""}> 显示全部成员的画布</label>`:""}
    </div>
    <div class="directory-actions">
      <button class="btn" type="button" id="directoryBack" hidden>返回所有项目和画布</button>
      <strong id="directoryHeading"></strong><span class="dim" id="directoryCount"></span><span class="grow"></span>
      <button class="btn" type="button" id="directorySelect">批量选择</button>
      <div id="directoryBatch" hidden>
        <button class="btn" type="button" id="directorySelectAll">选中全部可管理项</button>
        <button class="btn" type="button" id="directoryMove" disabled>移动到项目</button>
        <button class="btn danger" type="button" id="directoryDelete" disabled>删除所选</button>
      </div>
    </div>
    <p role="status" id="directoryStatus"></p>
    <div class="grid projects" id="directoryItems"></div>`;
  const query=$("#directoryQuery");
  query.value=canvasDirectoryPrefs.query;
  query.oninput=()=>{canvasDirectoryPrefs.query=query.value;renderDirectory(state);};
  for(const [element,key] of [["directoryScope","scope"],["directoryTeam","team"],["directoryType","type"],["directorySort","sort"]]){
    const control=$("#"+element);
    control.value=canvasDirectoryPrefs[key];
    control.onchange=()=>{
      canvasDirectoryPrefs[key]=control.value;
      if(key==="scope"){canvasDirectoryPrefs.folder="";canvasDirectoryPrefs.team="";$("#directoryTeam").value="";}
      renderDirectory(state);
    };
  }
  $("#directoryLayout").onclick=()=>{
    const next=localStorage.getItem("c.directoryLayout")==="list"?"grid":"list";
    localStorage.setItem("c.directoryLayout",next);renderDirectory(state);
  };
  $("#directoryBack").onclick=()=>{canvasDirectoryPrefs.folder="";renderDirectory(state);};
  $("#directorySelect").onclick=()=>{state.selecting=!state.selecting;state.selected.clear();renderDirectory(state);};
  $("#directorySelectAll").onclick=()=>{
    const eligible=directoryFilter(state).boards.filter(board=>board.owner===ME.id);
    const toggle=eligible.some(board=>!state.selected.has(board.id));
    state.selected=new Set(toggle?eligible.map(board=>board.id):[]);renderDirectory(state);
  };
  $("#directoryMove").onclick=()=>openDirectoryMove(state,[...state.selected],refresh);
  $("#directoryDelete").onclick=()=>openDirectoryDelete(state,[...state.selected],refresh);
  $("#directoryCreate").onclick=()=>directoryNameDialog("新建项目","",async name=>{
    await api("/api/canvas-projects",{name},"POST");await refresh();directoryMessage("项目已创建");
  });
  $("#directoryAll")?.addEventListener("change",run(async event=>{
    state.all=event.target.checked;localStorage.setItem("c.allp",state.all?"1":"0");state.selected.clear();await refresh();
  }));
  $$("[data-directory-new]").forEach(button=>button.onclick=run(async ()=>{
    const mode=button.dataset.directoryNew;
    if(mode==="samples"){location.href="/?samples=1";return;}
    await startDirectoryCanvas(state,mode);
  }));
  const grid=$("#directoryItems");
  grid.onchange=event=>{
    const check=event.target.closest("[data-directory-check]");
    if(!check)return;
    state.selected[check.checked?"add":"delete"](check.value);renderDirectoryStatus(state);
  };
  grid.onclick=run(async event=>{
    const choice=event.target.closest("[data-directory-action]");
    if(!choice)return;
    const {directoryAction:action,id}=choice.dataset;
    const board=state.boards.find(item=>item.id===id);
    const project=state.projects.find(item=>item.id===id);
    if(action==="folder"){
      canvasDirectoryPrefs.folder=id;canvasDirectoryPrefs.query="";canvasDirectoryPrefs.type="all";
      query.value="";$("#directoryType").value="all";renderDirectory(state);
    }else if(action==="project-rename"){
      directoryNameDialog("重命名项目",project.name,async name=>{
        await api("/api/canvas-projects/"+encodeURIComponent(id),{name},"PATCH");await refresh();
      });
    }else if(action==="project-dissolve"){
      directoryConfirm("解散项目","画布会移回未归档列表。","解散项目",async ()=>{
        await api("/api/canvas-projects/"+encodeURIComponent(id),null,"DELETE");await refresh();
      });
    }else if(action==="rename"){
      directoryNameDialog("重命名画布",board.name,async name=>{
        const current=await api("/api/board/"+encodeURIComponent(id));
        await api("/api/board/"+encodeURIComponent(id),{...current,name,auto_name:false},"PUT");
        await refresh();
      });
    }else if(action==="move"){
      openDirectoryMove(state,[id],refresh);
    }else if(action==="team"){
      openDirectoryTeam(state,board,refresh);
    }else if(action==="share"){
      await api("/api/board/"+encodeURIComponent(id)+"/access",{shared:!board.shared},"PATCH");
      await refresh();directoryMessage(board.shared?"已取消平台共享":"已共享给平台成员");
    }else if(action==="delete"){
      openDirectoryDelete(state,[id],refresh);
    }
  });
  grid.ondragstart=event=>{
    const source=event.target.closest("[data-drag-board]");
    if(!source)return;
    state.drag=source.dataset.dragBoard;
    event.dataTransfer.setData("text/plain",state.drag);
    event.dataTransfer.effectAllowed="move";
  };
  grid.ondragover=event=>{
    if(state.drag&&event.target.closest("[data-drop-project],[data-drag-board]"))event.preventDefault();
  };
  grid.ondragend=()=>{state.drag=null;};
  grid.ondrop=run(async event=>{
    const target=event.target.closest("[data-drop-project],[data-drag-board]");
    const source=state.drag;
    if(!source||!target)return;
    event.preventDefault();state.drag=null;
    if(target.dataset.dropProject){
      await moveDirectoryBoards([source],{project:target.dataset.dropProject});
      await refresh();directoryMessage("画布已移入项目");
    }else if(target.dataset.dragBoard!==source){
      openDirectoryMove(state,[source,target.dataset.dragBoard],refresh,true);
    }
  });
  await refresh();
}

function directoryBoardURL(id) {
  return "/?board="+encodeURIComponent(id);
}

function directoryRequestKey() {
  return Array.from(crypto.getRandomValues(new Uint32Array(4)),value=>value.toString(16).padStart(8,"0")).join("");
}

async function startDirectoryCanvas(state,mode) {
  const preferences=canvasDirectoryPrefs;
  const inTeam=preferences.scope==="team";
  const teams=state.teams||[];
  if(inTeam&&!teams.length)throw new Error("请先加入团队，或切换到个人画布");
  const team=inTeam&&teams.find(item=>item.id===preferences.team);
  const project=!inTeam&&(state.projects||[]).find(item=>item.id===preferences.folder);
  const locationLabel=team?team.name:project?project.name:directoryText("个人空间");
  const destination=team?{team:team.id}:project?{project:project.id}:{};
  let attempt;
  const open=async fields=>{
    const chosen=fields?.get("team")?{team:fields.get("team")}:destination;
    if(mode==="brief"){
      const text=fields.get("text").trim(),title=fields.get("title").trim();
      if(!text)throw new Error("请输入创作需求");
      const payload={text,title,...chosen},signature=JSON.stringify(payload);
      if(attempt?.signature!==signature)attempt={signature,key:directoryRequestKey()};
      const reply=await api("/api/chat/start-canvas",{...payload,request_key:attempt.key},"POST");
      location.href=directoryBoardURL(reply.board)+"&session="+encodeURIComponent(reply.session);
    }else{
      const id="b"+directoryRequestKey();
      const query=new URLSearchParams(chosen).toString();
      await api("/api/board/"+id+(query?"?"+query:""),{name:directoryText(mode==="wiz"?"新项目":"新画布"),nodes:[],edges:[],groups:[],
        view:{x:0,y:0,k:1},seq:1,...(mode==="wiz"?{auto_name:"project"}:{})},"PUT");
      location.href=directoryBoardURL(id)+(mode==="wiz"?"&wizard=1":"");
    }
  };
  const chooseTeam=inTeam&&!team;
  if(mode!=="brief"&&!chooseTeam)return open();
  const locationControl=chooseTeam?OneShotI18n.html`<label>团队空间<select class="in" name="team" required>
    <option value="">请选择团队</option>${teams.map(item=>`<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("")}
    </select></label>`:`<p>${esc(directoryText("创建位置 · {location}",{location:locationLabel}))}</p>`;
  const brief=mode==="brief"?OneShotI18n.html`<label>画布名称（选填）<input class="in" name="title" maxlength="80" placeholder="留空时使用需求首行"></label>
    <label>创作需求<textarea class="in" name="text" required maxlength="3000" rows="5" placeholder="例如：为春季新品写一个 4 镜头短片分镜"></textarea></label>
    <p>${inTeam?directoryText("团队成员可查看画布名称和画布上的结果。"):""}图片与视频生成需要你确认。</p>`:"";
  directoryDialog(mode==="brief"?"从创作需求开始":"新建团队画布",locationControl+brief,
    mode==="brief"?"新建画布并发送":"新建画布",open);
}

function directoryFilter(state) {
  const {scope,team,type,folder,query,sort}=canvasDirectoryPrefs;
  const match=name=>String(name||"").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const names=(a,b)=>a.name.localeCompare(b.name,OneShotI18n.locale);
  function order(a,b){
    if(sort==="name")return names(a,b);
    if(sort==="oldest")return a.mtime-b.mtime||names(a,b);
    if(sort==="created"||sort==="first"){
      if(!a.created||!b.created)return Number(Boolean(b.created))-Number(Boolean(a.created))||b.mtime-a.mtime;
      return (a.created-b.created)*(sort==="first"?1:-1)||names(a,b);
    }
    return b.mtime-a.mtime||names(a,b);
  }
  const scoped=state.boards.filter(board=>{
    if(scope==="personal")return board.owner===ME.id&&!board.team;
    if(scope==="team")return board.team&&(!team||board.team===team);
    if(scope==="shared")return board.owner!==ME.id&&!board.team&&(board.shared||board.access==="reviewer"||board.access==="editor");
    return true;
  });
  const hideArchived=!folder&&!query.trim()&&type==="all"&&(scope==="all"||scope==="personal");
  const matched=type==="projects"?[]:scoped.filter(board=>{
    if(folder && (board.project!==folder||board.team))return false;
    if(hideArchived && board.project&&!board.team)return false;
    return match(board.name)||match(OneShotI18n.canvasName(board));
  }).sort(order);
  const projects=folder||scope==="team"||scope==="shared"||type==="boards"?[]:state.projects.filter(project=>match(project.name));
  return {boards:matched,projects,scoped};
}

function renderDirectory(state) {
  if(consoleCanvasDirectory!==state||!state.boards)return;
  const {boards,projects,scoped}=directoryFilter(state);
  const current=state.projects.find(project=>project.id===canvasDirectoryPrefs.folder);
  const visible=new Set(boards.map(board=>board.id));
  for(const id of state.selected)if(!visible.has(id))state.selected.delete(id);
  $("#directoryHeading").textContent=current?.name||directoryText("画布目录");
  $("#directoryBack").hidden=!current;
  $("#directoryTeam").hidden=canvasDirectoryPrefs.scope!=="team";
  const list=localStorage.getItem("c.directoryLayout")==="list";
  $("#directoryLayout").textContent=directoryText(list?"网格视图":"列表视图");
  $("#directoryCount").textContent=[directoryCanvasCount(boards.length),projects.length&&directoryText(projects.length===1?"1 个项目":"{count} 个项目",{count:projects.length})].filter(Boolean).join(" · ");
  const grid=$("#directoryItems");
  grid.classList.toggle("directory-list",list);
  grid.innerHTML=projects.map(project=>`<article class="pj directory-project" data-drop-project="${esc(project.id)}">
    <button class="directory-folder-name" type="button" data-directory-action="folder" data-id="${esc(project.id)}">${esc(project.name)}</button>
    <div class="bd dim">${directoryCanvasCount(scoped.filter(board=>board.project===project.id&&!board.team).length)}</div>
    <div class="acts">${directoryButton("project-rename",project.id,"改名")}${directoryButton("project-dissolve",project.id,"解散")}</div>
  </article>`).concat(boards.map(board=>directoryCard(state,board,list))).join("")||OneShotI18n.html`<p class="dim">没有符合条件的项目或画布</p>`;
  renderDirectoryStatus(state);
}

function directoryButton(action,id,label,extra="") {
  return `<button class="btn sm ${extra}" type="button" data-directory-action="${action}" data-id="${esc(id)}">${esc(directoryText(label))}</button>`;
}

function directoryCard(state,board,list) {
  const owned=board.owner===ME.id,manageable=owned||ME.role==="admin";
  const team=state.teams.find(item=>item.id===board.team);
  const cover=typeof board.cover==="string"&&board.cover.startsWith("/media?")?esc(board.cover):"";
  const date=canvasDirectoryPrefs.sort==="created"||canvasDirectoryPrefs.sort==="first"?
    board.created?new Date(board.created*1000).toLocaleDateString(OneShotI18n.locale):directoryText("创建日期未知"):ago(board.mtime);
  const share=team?.name||(board.team?directoryText("团队"):board.shared?directoryText("已共享给平台成员"):null);
  return `<article class="pj" data-board="${esc(board.id)}" ${owned&&!board.team?'draggable="true" data-drag-board="'+esc(board.id)+'"':""}>
    ${state.selecting&&owned?`<label class="directory-check"><input type="checkbox" data-directory-check value="${esc(board.id)}" ${state.selected.has(board.id)?"checked":""}>${esc(directoryText("选中 {name}",{name:board.name}))}</label>`:""}
    ${list?"":`<a class="cv" href="${directoryBoardURL(board.id)}" tabindex="-1" aria-hidden="true">${cover?(cover.includes("cover_")?`<img src="${cover}" loading="lazy" alt="">`:`<video src="${cover}#t=1" muted preload="metadata"></video>`):directoryText("空白")}</a>`}
    <div class="bd"><a class="nm" href="${directoryBoardURL(board.id)}">${esc(OneShotI18n.canvasName(board))}</a>
      <div class="mt"><span>${esc(date)}</span><span>${directoryText(board.nodes===1?"1 个节点":"{count} 个节点",{count:board.nodes})}</span>
      ${share?`<span class="tag">${esc(share)}</span>`:""}${!owned&&state.users.has(board.owner)?`<span>${esc(state.users.get(board.owner))}</span>`:""}</div></div>
    ${manageable?`<div class="acts">${directoryButton("rename",board.id,"改名")}
      ${owned&&!board.team?directoryButton("move",board.id,"移到项目"):""}
      ${owned&&(board.team||state.teams.length)?directoryButton("team",board.id,"团队空间"):""}
      ${!board.team?directoryButton("share",board.id,board.shared?"取消平台共享":"平台共享"):""}
      ${directoryButton("delete",board.id,"删除","danger")}</div>`:""}</article>`;
}

function renderDirectoryStatus(state) {
  $("#directorySelect").textContent=directoryText(state.selecting?"结束选择":"批量选择");
  $("#directoryBatch").hidden=!state.selecting;
  $("#directoryDelete").disabled=!state.selected.size;
  $("#directoryMove").disabled=!state.selected.size||state.boards.some(board=>state.selected.has(board.id)&&board.team);
  $("#directoryDelete").textContent=state.selected.size?directoryText("删除所选（{count}）",{count:state.selected.size}):directoryText("删除所选");
}

function directoryDialog(title,content,button,action) {
  const box=modal(OneShotI18n.html`<h3>${esc(directoryText(title))}</h3><form class="directory-dialog">
    ${content}<p class="directory-error" role="status"></p><div class="row"><span class="grow"></span>
    <button class="btn" type="button" data-directory-cancel>取消</button><button class="btn pri" type="submit">${esc(directoryText(button))}</button></div></form>`);
  $("[data-directory-cancel]",box).onclick=closeModal;
  const form=$("form",box);
  form.onsubmit=async event=>{
    event.preventDefault();
    const submit=$("[type=submit]",form);
    if(submit.disabled)return;
    submit.disabled=true;
    try { await action(new FormData(form));if(form.isConnected)closeModal(); }
    catch(error) { $(".directory-error",form).textContent=directoryText(error.message||"操作失败"); }
    finally {submit.disabled=false;}
  };
  $("input,select,button",form)?.focus();
  return form;
}

function directoryNameDialog(title,current,action) {
  directoryDialog(title,OneShotI18n.html`<label>名称<input class="in" name="name" value="${esc(current)}" maxlength="60" required></label>`,"保存",
    fields=>{
      const name=fields.get("name").trim();
      if(!name)throw new Error("请输入名称");
      return action(name);
    });
}

function directoryConfirm(title,text,button,action) {
  directoryDialog(title,`<p>${esc(directoryText(text))}</p>`,button,action);
}

function moveDirectoryBoards(boards,target) {
  return api("/api/boards/batch-project",{boards,...target},"POST");
}

function openDirectoryMove(state,ids,refresh,newOnly=false) {
  if(!ids.length)return;
  const options=state.projects.map(project=>`<option value="${esc(project.id)}">${esc(project.name)}</option>`).join("");
  const form=directoryDialog(directoryText("将 {canvases} 移到项目",{canvases:directoryCanvasCount(ids.length)}),
    OneShotI18n.html`<label ${newOnly?"hidden":""}>目标项目<select class="in" name="target"><option value="new">新建项目</option><option value="">移出项目</option>${options}</select></label>
    <label>新项目名称<input class="in" name="name" maxlength="60" required></label>`,"移动",async fields=>{
    const target=fields.get("target");
    await moveDirectoryBoards(ids,target==="new"?{name:fields.get("name")}:{project:target||null});
    state.selected.clear();await refresh();directoryMessage(directoryText("已移动 {canvases}",{canvases:directoryCanvasCount(ids.length)}));
  });
  $("[name=target]",form).onchange=event=>{
    const name=$("[name=name]",form);
    name.required=event.target.value==="new";
    name.closest("label").hidden=!name.required;
  };
}

function openDirectoryTeam(state,board,refresh) {
  directoryDialog("移动画布到团队空间",OneShotI18n.html`<label>工作空间<select class="in" name="team"><option value="">个人空间</option>
    ${state.teams.map(team=>`<option value="${esc(team.id)}" ${board.team===team.id?"selected":""}>${esc(team.name)}</option>`).join("")}
    </select></label><p>移入后，所选团队的成员可以打开并编辑此画布。</p>`,"确认移动",async fields=>{
    await api("/api/board/"+encodeURIComponent(board.id)+"/access",{team:fields.get("team")||null},"PATCH");
    await refresh();directoryMessage("画布空间已更新");
  });
}

function openDirectoryDelete(state,ids,refresh) {
  if(!ids.length)return;
  const names=ids.map(id=>state.boards.find(board=>board.id===id)?.name||id);
  directoryDialog(directoryText("删除 {canvases}",{canvases:directoryCanvasCount(ids.length)}),OneShotI18n.html`<ul>${names.map(name=>`<li>${esc(name)}</li>`).join("")}</ul>
      <p>这些画布将从目录中移除，相关公开链接会失效。</p>`,"确认删除",async ()=>{
    const failed=[];
    for(const [index,id] of ids.entries()){
      try { await api("/api/board/"+encodeURIComponent(id),null,"DELETE"); }
      catch { failed.push(names[index]); }
    }
    state.selected.clear();await refresh();
    directoryMessage(directoryText("已删除 {canvases}",{canvases:directoryCanvasCount(ids.length-failed.length)})+
      (failed.length?directoryText("。删除失败：{names}",{names:failed.join(OneShotI18n.locale==="en"?", ":"、")}):""));
  });
}
