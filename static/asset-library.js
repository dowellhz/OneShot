"use strict";
// A dedicated asset workspace; the canvas drawer remains the quick media picker.
const AL = {open:false, board:null, items:[], kind:'all', query:'', scope:'current', source:'all', sort:'recent', selected:null, epoch:0, returnFocus:null};
const AL_KINDS = {all:'所有资产', ...KIND_CN};
const AL_DRAG_TYPE = "application/x-oneshot-library";
Object.assign(AL,{folders:[],folder:'all',marked:new Set(),filing:false});
const alCurrentTeam = () => B?.team || boardDirectory.find(b=>b.id===boardId)?.team || "";
const alFolderTeam = () => AL.scope === "current" ? alCurrentTeam() :
  AL.scope.startsWith("team:") ? AL.scope.slice(5) : "";
function alCurrentName() {
  const team = alCurrentTeam();
  return team ? canvasTeams.find(t=>t.id===team)?.name || "团队" : currentProject()?.name || B?.name || "未命名画布";
}
const alFolderList = () => alFolderTeam() ? (AL.teamFolders?.team===alFolderTeam()?AL.teamFolders.items:[]) : AL.folders;
const alFolderURL = (id="",team=alFolderTeam()) =>
  "/api/asset-folders"+(id?"/"+encodeURIComponent(id):"")+(team?"?team="+encodeURIComponent(team):"");
const alFolderSlot = asset => alFolderTeam() ? asset.team_folder_id : asset.folder_id;
const alManageTeamFolders = () => !alFolderTeam() || canvasTeams.some(t=>t.id===alFolderTeam() && t.managed);
function alSource(a) {
  const sources = new Set((a.media || []).map(m => m.source === 'upload' ? 'upload' : ['gen','generated','edit','film'].includes(m.source) ? 'generated' : 'other'));
  if (sources.size > 1) return 'mixed';
  return sources.values().next().value || 'text';
}
function alSourceLabel(a) { return {upload:'用户上传',generated:'生成素材',mixed:'多种来源',text:'文本资料',other:'已有素材'}[alSource(a)]; }
function alEditable(a) { return !a || !ME_USER || ME_USER.role === 'admin' || a.owner == null || a.owner === ME_USER.id; }
function alThumb(a) { return a.ref || (a.media || []).find(m => cmMediaType(m.ref,m))?.ref || ''; }
function alPersonal(a) {
  return !a.board && !a.project && !a.team && (a.owner == null || a.owner === ME_USER?.id);
}
function alBoardInLibrary(bid) {
  const project = currentProject()?.id;
  return bid === boardId || !!(project && boardDirectory.some(board=>board.id===bid&&board.project===project));
}
function alInCurrent(asset) {
  const team = alCurrentTeam(), project = currentProject()?.id;
  return asset.board && alBoardInLibrary(asset.board) ||
    (team ? asset.team === team : project && asset.project === project);
}
function alBaseItems() {
  const q = AL.query.trim().toLocaleLowerCase();
  const found = AL.documentQuery===q ? AL.documentResults : new Map();
  const items = new Map(AL.items.map(a=>[a.id,a]));
  for(const [id,a] of found)items.set(id,a);
  const ranked = AL.semantic?.ids;
  const candidates = ranked ? ranked.map(id=>items.get(id)).filter(Boolean) : [...items.values()];
  return candidates.filter(a => (ranked || !q || found.get(a.id)?.document_match ||
    [a.name,a.desc,a.document?.name,a.document?.text||a.document?.excerpt,...(a.aliases||[]),...(a.tags||[])].join(' ').toLocaleLowerCase().includes(q))
    && (AL.scope === 'current' && alInCurrent(a) ||
      AL.scope === 'personal' && alPersonal(a) || AL.scope === 'shared' && a.shared || AL.scope.startsWith('team:') && a.team === AL.scope.slice(5))
    && (AL.source === 'all' || alSource(a) === AL.source)
    && (AL.folder === 'all' || (AL.folder === 'none' ? !alFolderSlot(a) : alFolderSlot(a) === AL.folder)));
}
function alClearSemantic() {
  AL.semantic = null;
  if(AL.sort==="relevance")AL.sort="recent";
}
function alCanFindByDescription() {
  return AL.open && $("#alLoading").hidden && !!AL.query.trim() && !AL.semantic?.pending;
}
async function alFindByDescription() {
  if (!alCanFindByDescription()) return;
  const bid = boardId, query = AL.query.trim();
  const search = AL.semantic = {pending:true,ids:null};
  alRender();
  try {
    const {items,method} = await boardRequest("/api/memory/search","POST",{
      board:bid,query,scope:AL.scope,...(AL.kind==="all"?{}:{kind:AL.kind}),
    });
    if (!AL.open || AL.semantic!==search || boardId!==bid) return;
    const merged = new Map(AL.items.map(asset=>[asset.id,asset]));
    for (const asset of items) merged.set(asset.id,asset);
    AL.items = [...merged.values()];
    search.ids = items.map(asset=>asset.id);
    search.method = method;
    AL.sort = "relevance";
    AL.marked.clear();
  } catch(e) {
    if(AL.semantic===search)search.error=e.message || "按描述查找失败";
  } finally {
    if(AL.semantic===search){search.pending=false;alRender();}
  }
}
function alSearchDocuments() {
  clearTimeout(AL.documentTimer);
  const bid=boardId, scope=AL.scope, query=AL.query.trim().toLocaleLowerCase();
  AL.documentQuery="";AL.documentResults=new Map();
  if (!query) return;
  AL.documentTimer=setTimeout(async()=>{
    try{
      const result=await boardRequest("/api/memory?"+new URLSearchParams({board:bid,scope,q:query}));
      if(!AL.open||bid!==boardId||scope!==AL.scope||query!==AL.query.trim().toLocaleLowerCase()||!Array.isArray(result))return;
      AL.documentQuery=query;
      AL.documentResults=new Map(result.map(a=>[a.id,a]));
      alRender();
    }catch{}
  },220);
}
function alRenderFolders() {
  const folders = alFolderList(), managed = alManageTeamFolders();
  const tabs = [{id:'all',name:'全部文件夹'},{id:'none',name:'未归档'},...folders];
  $("#alFolders").innerHTML=tabs.map(f=>`<button type="button" data-folder="${esc(f.id)}" aria-pressed="${AL.folder===f.id}">${esc(f.name)}</button>`).join("");
  const selected = folders.some(f=>f.id===AL.folder);
  $("#alNewFolder").hidden = !managed;
  $("#alRenameFolder").hidden = $("#alDeleteFolder").hidden = !selected || !managed;
  $("#alFileActions").hidden = !AL.filing;
  $("#alFileMode").setAttribute("aria-pressed",String(AL.filing));
  $("#alSelectedCount").textContent = `已选 ${AL.marked.size} 项`;
  const target = $("#alTargetFolder"), previous = target.value;
  target.innerHTML = '<option value="" disabled>选择目标</option><option value="none">移回未归档</option>' +
    folders.map(f=>`<option value="${esc(f.id)}">${esc(f.name)}</option>`).join("");
  target.value = tabs.some(f=>f.id===previous) ? previous : "";
  const items=AL.items.filter(item=>AL.marked.has(item.id));
  const busy=!!(AL.folderBusy||AL.batchBusy);
  $("#alApplyFolder").disabled = !items.length || !target.value || busy ||
    !managed && items.some(item=>item.owner!==ME_USER?.id);
  $("#alApplyBatch").disabled = busy || !items.length || !canvasCanEdit();
  $("#alDownloadBatch").disabled = busy || !items.some(libraryPrimary);
}

async function alFolderChange(action) {
  if (AL.folderBusy) return;
  const bid=boardId;
  AL.folderBusy=true; alRenderFolders();
  try {
    await action();
    if (bid === boardId && AL.open) await alRefresh();
  } catch (error) { if(bid===boardId)toast(error.message,4500); }
  finally { AL.folderBusy=false; if(AL.open)alRenderFolders(); }
}

function alFolderEditor(mode) {
  if (!alManageTeamFolders()) return;
  const folder=alFolderList().find(f=>f.id===AL.folder), host=$("#alFolderEditor");
  if (mode!=="create" && !folder) return;
  if (mode==="delete") {
    host.innerHTML=`<span>删除「${esc(folder.name)}」后，其中的资产会回到未归档。</span><button type="button" data-confirm>删除文件夹</button><button type="button" data-cancel>取消</button>`;
    $("[data-confirm]",host).onclick=()=>alFolderChange(async()=>{await boardRequest(alFolderURL(folder.id),"DELETE");AL.folder="all";host.replaceChildren();});
  } else {
    host.innerHTML=`<form><input aria-label="文件夹名称" maxlength="60" required value="${esc(mode==="rename"?folder.name:"")}"><button type="submit">保存</button><button type="button" data-cancel>取消</button></form>`;
    const input=$("input",host);input.focus();input.select();
    $("form",host).onsubmit=e=>{
      e.preventDefault();
      alFolderChange(async()=>{
        const row=await boardRequest(alFolderURL(mode==="rename"?folder.id:""),mode==="rename"?"PATCH":"POST",{name:input.value});
        AL.folder=row.id;AL.marked.clear();host.replaceChildren();
      });
    };
  }
  $("[data-cancel]",host).onclick=()=>host.replaceChildren();
}
function alEmptyDetail() {
  const host = $('#alDetail'); if (!host) return;
  host.innerHTML = `<div class="al-detail-empty">${ico('assets')}<strong>资产详情</strong><p>选择一项资产，查看设定、参考素材和生成历史。</p><span>在对话或提示词中输入 @，即可采用资产。</span></div>`;
}
function alRender() {
  if (!AL.open || AL.drag) return;
  alRenderFolders();
  const currentLabel = "当前资产库 · " + alCurrentName();
  $("#alScope option[value=current]").textContent = currentLabel;
  $("#alTitle").textContent = AL.scope === "current" ? currentLabel : "资产库";
  const base = alBaseItems(), list = base.filter(a => AL.kind === 'all' || a.kind === AL.kind);
  if(AL.sort!=="relevance")list.sort((a,b) => AL.sort === 'name' ? a.name.localeCompare(b.name,'zh-CN') : (b.mtime||0)-(a.mtime||0));
  $("#alSort option[value=relevance]").hidden = !AL.semantic?.ids;
  $("#alSort").value = AL.sort;
  $("#alSemantic").disabled = !alCanFindByDescription();
  const status = $("#alSemanticStatus");
  status.textContent = AL.semantic?.pending ? "正在按描述查找…" : AL.semantic?.error || ({
    semantic:"按描述匹配", exact:"名称匹配", keyword:"已使用关键词查找",
  })[AL.semantic?.method] || "";
  status.hidden = !status.textContent;
  for (const b of $$('#alCategories [data-kind]')) {
    b.classList.toggle('on', b.dataset.kind === AL.kind); b.setAttribute('aria-pressed', String(b.dataset.kind === AL.kind));
    b.querySelector('small').textContent = base.filter(a => b.dataset.kind === 'all' || a.kind === b.dataset.kind).length;
  }
  const more = $('#alLoadMore');
  more.hidden = !AL.nextCursor || !!AL.semantic?.ids;
  more.disabled = !!AL.loadingMore;
  more.textContent = AL.loadingMore ? '正在加载…' : '加载更多资产';
  $('#alCount').textContent = `${more.hidden ? '' : '已显示 '}${list.length} 项资产`;
  $('#alHeading').textContent = AL_KINDS[AL.kind];
  $('#alGrid').replaceChildren(); $('#alEmpty').hidden = !!list.length || !$('#alLoading').hidden;
  const filtered = AL.query || AL.scope !== 'current' || AL.source !== 'all';
  $('#alEmptyTitle').textContent = !more.hidden ? '已加载的资产中没有匹配项' : filtered ? '没有匹配的资产' : AL.folder!=='all' ? '这个文件夹暂无资产' : `还没有${AL.kind === 'all' ? '资产' : AL_KINDS[AL.kind]}`;
  $('#alEmptyText').textContent = !more.hidden ? '可继续加载这个资产库中的较早素材。' : filtered ? '试试其他关键词，或重置筛选条件。' : AL.folder!=='all' ? '从全部资产选择要归档的素材，再移动到此文件夹。' : '上传素材、从画布收录，或新建一份背景资料。';
  for (const a of list) {
    const card = document.createElement('article'); card.className = 'al-card' + (AL.selected === a.id ? ' selected' : ''); card.dataset.id = a.id;
    const draftMain = a.kind === 'character' && characterResult(a, 'main', boardId);
    const hasDraft = a.kind === 'character' && Object.keys(CHARACTER_VIEWS).some(slot => characterResult(a, slot, boardId));
    const showDraftCover = draftMain && !a.character_views?.main;
    const ref=showDraftCover?draftMain:alThumb(a), type=cmMediaType(ref,a.media?.find(m=>m.ref===ref)), video=type==="video";
    const image=video?`<video src="/media?ref=${encodeURIComponent(ref)}#t=0.1" preload="metadata" muted playsinline></video>`
      :type==="image"?`<img src="/media?ref=${encodeURIComponent(ref)}" draggable="false" loading="lazy" alt="${esc(a.name)}">`
      :`<div class="al-text-preview">${ico(type==="audio"?'audio':'script')}<p>${esc((a.desc || a.document?.excerpt || a.document?.text || (type==="audio"?'音频素材':'背景资料')).slice(0,180))}</p></div>`;
    card.innerHTML = `<button type="button" class="al-card-main" aria-label="查看资产 ${esc(a.name)}" aria-pressed="${AL.selected === a.id}"><div class="al-cover">${image}<span class="al-type">${esc(cmKind(a))}</span>${hasDraft ? '<span class="al-reference">新图待定稿</span>' : a.ref ? '<span class="al-reference">默认参考</span>' : video ? '<span class="al-reference">视频资料</span>' : ''}</div><div class="al-card-info"><strong>${esc(a.name)}</strong><p>${esc(a.desc || '尚未填写设定')}</p><div class="al-card-meta"><span>${esc(alSourceLabel(a))}</span><span>${esc(cmScopeLabel(a))}</span></div><div class="al-tags">${(a.tags||[]).slice(0,3).map(t=>`<span>${esc(t)}</span>`).join('')}</div></div></button><div class="al-card-actions"><button type="button" data-action="canvas" title="放入当前画布">${ico('plus')}放入画布</button><button type="button" data-action="reference" title="在创作助手中引用此资产">@ 引用</button></div>`;
    card.querySelector('.al-card-main').onclick = () => alSelect(a);
    card.querySelector('[data-action=canvas]').onclick = () => alPlace(a);
    card.querySelector('[data-action=reference]').onclick = () => alReference(a);
    if(AL.filing){
      const label=document.createElement("label");label.className="al-file-check";
      const check=document.createElement("input");check.type="checkbox";check.checked=AL.marked.has(a.id);
      check.setAttribute("aria-label","选取 "+a.name);
      check.onchange=()=>{if(check.checked&&AL.marked.size>=100){check.checked=false;return toast("一次最多选择 100 个资产");}
        if(check.checked)AL.marked.add(a.id);else AL.marked.delete(a.id);alRenderFolders();};
      label.append(check);card.prepend(label);
    }
    card.draggable = canvasCanEdit();
    $('#alGrid').append(card);
  }
}
async function alRefresh() {
  alClearSemantic();
  const epoch = ++AL.epoch, bid = boardId, scope = AL.scope; $('#alError').hidden = true; $('#alLoading').hidden = false;
  AL.nextCursor = null;
  AL.loadingMore = false;
  $("#alSemantic").disabled = true;
  const team = alFolderTeam();
  try {
    const [page,folders,teams,teamFolders] = await Promise.all([alFetchPage(bid,scope),
      boardRequest("/api/asset-folders").catch(()=>null),boardRequest("/api/canvas-teams").catch(()=>null),
      team ? boardRequest(alFolderURL("",team)).catch(()=>null) : null]);
    if (!AL.open || AL.epoch !== epoch || bid !== boardId) return;
    const {items,next_cursor} = page;
    if(Array.isArray(teams)){
      canvasTeams=teams;
      const picker=$("#alScope");
      for(const option of picker.querySelectorAll("[data-team-scope]"))option.remove();
      for(const team of teams){
        const option=new Option("团队 · "+team.name,"team:"+team.id);
        option.dataset.teamScope="";
        picker.add(option);
      }
      if(scope.startsWith("team:") && !teams.some(t=>"team:"+t.id===scope)){
        alResetFilters();
        return await alRefresh();
      }
      picker.value=AL.scope;
    }
    if(Array.isArray(folders))AL.folders=folders;
    AL.teamFolders = team && Array.isArray(teamFolders) ? {team,items:teamFolders} : null;
    if(!["all","none"].includes(AL.folder)&&!alFolderList().some(f=>f.id===AL.folder))AL.folder="all";
    const ids=new Set(items.map(a=>a.id));
    if(AL.selected && !ids.has(AL.selected)){
      AL.selected=null;
      if(CM.editor?.closest('#alDetail'))CM.editor=null;
      alEmptyDetail();
    }
    AL.marked=new Set([...AL.marked].filter(id=>ids.has(id)));
    AL.nextCursor = next_cursor;
    AL.items = items; AL.board = bid; cmInvalidate(); alRender();
    if(AL.query.trim())alSearchDocuments();
    await refreshCharacterResults(items, bid);
  } catch (e) {
    if (AL.open && AL.epoch === epoch) { $('#alError').textContent = e.message + '，可点击刷新重试。'; $('#alError').hidden = false; }
  } finally {
    if (AL.epoch === epoch) {
      $("#alLoading").hidden = true;
      alRender();
    }
  }
}
function alFetchPage(bid, scope, cursor="") {
  return boardRequest('/api/memory?' + new URLSearchParams({board:bid,scope,cursor}));
}
async function alLoadMore() {
  if (!AL.open || AL.loadingMore || !AL.nextCursor) return;
  const epoch = AL.epoch, bid = boardId, scope = AL.scope;
  const active = () => AL.open && AL.epoch === epoch && boardId === bid && AL.scope === scope;
  AL.loadingMore = true;
  $('#alError').hidden = true;
  alRender();
  try {
    const {items,next_cursor} = await alFetchPage(bid,scope,AL.nextCursor);
    if (!active()) return;
    const known = new Set(AL.items.map(asset=>asset.id));
    AL.items.push(...items.filter(asset=>!known.has(asset.id)));
    AL.nextCursor = next_cursor;
    await refreshCharacterResults(items,bid);
  } catch (error) {
    if (active()) {
      $('#alError').textContent = error.message + '，可重新加载更多资产。';
      $('#alError').hidden = false;
    }
  } finally {
    if (active()) {
      AL.loadingMore = false;
      alRender();
    }
  }
}
function alResetFilters(scope='current',folder='all') {
  alClearSemantic();
  AL.query='';AL.scope=scope;AL.source='all';AL.folder=folder;
  AL.marked.clear();AL.filing=false;
  $('#alSearch').value='';$('#alScope').value=scope;$('#alSource').value='all';
  $('#alFolderEditor').replaceChildren();
  alSearchDocuments();
}
async function alOpen(destination=null) {
  if (!B) return;
  if(CM.editor && !CM.editor.closest("#assetLibrary")){if(CM.editor.dataset.busy==="true")return toast("正在保存或上传，请稍等");CM.editor.remove();CM.editor=null;}
  if (!AL.open || destination) {
    if(!AL.open)AL.returnFocus=document.activeElement;
    AL.kind='all';
    alResetFilters(destination?.scope,destination?.folder);
    if(destination || AL.board!==boardId){
      AL.selected=null;
      if(CM.editor?.closest('#alDetail'))CM.editor=null;
      alEmptyDetail();
    }
  }
  AL.open = true; $('#assetLibrary').hidden = false; $('#assetBtn').classList.add('on'); $('#assetLibraryBtn').setAttribute('aria-expanded','true');
  $('#drawer').classList.remove('on'); cmClose(); closeMenus();
  if (AL.board !== boardId) { AL.items=[]; AL.selected=null; alEmptyDetail(); }
  alRender(); $('#alSearch').focus(); await alRefresh();
}
function alClose() {
  if (!AL.open) return;
  alClearSemantic();
  clearTimeout(AL.documentTimer);AL.documentQuery="";AL.documentResults=new Map();
  AL.open=false; AL.epoch++; $('#assetLibrary').hidden=true; $('#assetBtn').classList.remove('on'); $('#assetLibraryBtn').setAttribute('aria-expanded','false');
  alEndDrag();
  $('#alImport').hidden=true; cmClose(); AL.returnFocus?.focus();
  const transfer=$("#assetTransferPanel");
  if(transfer?.parentNode===$("#assetLibrary"))document.body.appendChild(transfer);
}
function alCanvasCollectable(n) {
  return !n.job && !prepping.has(n.id) && (n.type==="text"?!!n.data.text?.trim():
    ["image","video","audio"].includes(n.type)&&!!curV(n)?.ref);
}
function alCloseCanvasImport() {
  const dialog=$("#alCanvasImport");
  if(!dialog?.open)return;
  if(dialog.close)dialog.close();
  else dialog.removeAttribute("open");
  $("[data-canvas-import-form]",dialog).replaceChildren();
}
function alOpenCanvasImport(nodes) {
  if(!canvasCanEdit())return;
  const eligible=nodes.filter(alCanvasCollectable);
  if(!eligible.length)return toast("选区没有可收录的素材");
  if(eligible.length>100)return toast("每次最多收录 100 项资产");
  const dialog=$("#alCanvasImport");
  if(dialog.open)return;
  void alImportCanvasAssets($("[data-canvas-import-form]",dialog),eligible,alCloseCanvasImport,
    {onCancel:alCloseCanvasImport,skipped:nodes.length-eligible.length});
  if(dialog.showModal)dialog.showModal();
  else dialog.setAttribute("open","");
}
async function alImportCanvasAssets(host, nodes, onSaved, {onCancel,skipped=0}={}) {
  const bid=boardId;
  const entries=nodes.map(n=>({id:n.id,ref:curV(n)?.ref||null}));
  const project=currentProject();
  const form=document.createElement("form");
  form.className="al-group-import";
  form.innerHTML=`<strong>收录 ${entries.length} 项资产</strong>
    <ul class="al-import-selection" aria-label="收录清单">${nodes.map(n=>`<li><span>${esc(n.name)}</span><small>${TYPE_CN[n.type]}${curV(n)?.ref?` · 版本 ${n.cur+1}`:""}</small></li>`).join("")}</ul>
    ${skipped?`<p>另有 ${skipped} 个节点暂不可收录。</p>`:""}
    <label>保存到 <select name="scope">${project?`<option value="project">项目资产库 · ${esc(project.name)}</option>`:alCurrentTeam()?"":`<option value="canvas">当前画布 · ${esc(B.name)}</option>`}<option value="personal">个人资产库</option>${canvasTeams.map(t=>`<option value="team:${esc(t.id)}">团队 · ${esc(t.name)}</option>`).join("")}</select></label>
    <label>文件夹 <select name="folder"><option value="">未归档</option></select></label>
    <span role="status">正在读取文件夹…</span>
    <button type="button" data-cancel>取消</button><button type="submit" disabled>确认收录</button>`;
  host.replaceChildren(form);
  const [scope,folder]=$$("select",form), submit=$("[type=submit]",form), status=$("[role=status]",form);
  const targetTeam = AL.open ? alFolderTeam() : alCurrentTeam();
  const target = targetTeam ? "team:"+targetTeam : AL.open && AL.scope==="personal" ? "personal" : "";
  if ([...scope.options].some(option=>option.value===target)) scope.value=target;
  let key=null, previous=null, busy=false;
  $("[data-cancel]",form).onclick=()=>{if(!busy){form.remove();onCancel?.();}};
  let folderRequest=0;
  const loadFolders=async()=>{
    const ticket=++folderRequest;
    const team=scope.value.startsWith("team:")?scope.value.slice(5):"";
    folder.replaceChildren(new Option("未归档",""));
    status.textContent="正在读取文件夹…";
    submit.disabled=true;
    try {
      const folders=await boardRequest(alFolderURL("",team));
      if(!form.isConnected || bid!==boardId || ticket!==folderRequest)return;
      for(const entry of folders)folder.add(new Option(entry.name,entry.id));
      status.textContent="";
    } catch(e) { if(ticket===folderRequest)status.textContent=e.message+"。可存为未归档。"; }
    finally { if(ticket===folderRequest)submit.disabled=false; }
  };
  scope.onchange=loadFolders;
  await loadFolders();
  form.onsubmit=async e=>{
    e.preventDefault();
    if(busy || bid!==boardId || !canvasCanEdit())return;
    const team=scope.value.startsWith("team:")?scope.value.slice(5):"";
    const payload={board:bid,nodes:entries,folder:folder.value||null,scope:team?"team":scope.value,
      ...(team?{team}:scope.value==="project"?{project:project.id}:{})};
    const selection=JSON.stringify(payload);
    if(previous!==selection) {
      previous=selection;
      key=crypto.randomUUID?.() || "import-"+Date.now()+"-"+Math.random().toString(36).slice(2);
    }
    busy=true;submit.disabled=scope.disabled=folder.disabled=true;
    form.setAttribute("aria-busy","true");
    status.textContent="正在收录…";
    try {
      await flushSave();
      if(bid!==boardId || !form.isConnected)return;
      const result=await boardRequest("/api/memory/import-canvas","POST",{...payload,request_key:key});
      cmInvalidate();
      if(bid!==boardId || !form.isConnected)return;
      onSaved();
      await alOpen({scope:team?"team:"+team:payload.scope==="personal"?"personal":"current",folder:payload.folder||"none"});
      toast("已收录 "+result.ids.length+" 项资产");
    } catch(err) { status.textContent=err.message; }
    finally { busy=false;submit.disabled=scope.disabled=folder.disabled=false;form.removeAttribute("aria-busy"); }
  };
}
async function alSelect(a) {
  if (CM.editor?.dataset.busy === 'true') return toast('正在保存或上传，请稍等');
  const bid = boardId;
  AL.selected=a.id; alRender(); await cmEdit(a, a.kind, {host:$('#alDetail'), readonly:!alEditable(a)});
  if (!AL.open || AL.selected !== a.id || bid !== boardId) return;
  const fields=$('.cm-fields',$('#alDetail'));
  if (fields) alAssetActions(fields,a,bid);
  if (a.kind === 'character') alImpact(a);
}

function alAssetActions(fields, asset, bid) {
  $('.al-asset-actions',fields)?.remove();
  const route = '/api/memory/'+encodeURIComponent(asset.id);
  const actions = document.createElement('div');
  actions.className = 'al-asset-actions';
  actions.innerHTML = `<button type="button">复制到个人库</button><a download>下载素材包</a>`;
  const button = $('button',actions);
  $('a',actions).href = route+'/download?'+new URLSearchParams({board:bid});
  let attempt;
  button.onclick = async()=>{
    if (button.disabled || CM.editor?.dataset.busy === 'true') return;
    attempt ||= crypto.randomUUID?.() || "asset-copy-"+Date.now()+Math.random().toString(36).slice(2);
    button.disabled = true;
    try {
      const copied = await boardRequest(route+'/duplicate','POST',{board:bid,request_key:attempt});
      attempt = null;
      if (!AL.open || bid!==boardId) return;
      AL.scope = $('#alScope').value = 'personal';
      AL.folder = 'all';
      AL.query = $('#alSearch').value = '';
      AL.marked.clear();
      alChanged(copied);
      await alRefresh();
      if (!AL.open || bid!==boardId || AL.scope!=='personal') return;
      await alSelect(copied);
      toast('已复制到个人素材库');
    } catch (error) {
      if (bid===boardId) toast(error.message);
    } finally { button.disabled = false; }
  };
  fields.prepend(actions);
}
function alImpact(asset) {
  const host = $("#alDetail");
  $(".al-impact", host)?.remove();
  const section = document.createElement("details");
  section.className = "al-impact";
  section.innerHTML = `<summary>参考图更新影响</summary><div><output aria-live="polite"></output><ul></ul><button type="button" hidden>用当前参考图重做所选预览</button></div>`;
  host.append(section);
  const status = $("output", section), list = $("ul", section), redo = $("button", section);
  section.ontoggle = async () => {
    if (!section.open || !section.isConnected) return;
    const bid = boardId;
    list.replaceChildren(); redo.hidden = true; status.textContent = "正在检查有权限的项目…";
    try {
      await flushSave();
      const response = await fetch(`/api/memory/${encodeURIComponent(asset.id)}/impact?board=${encodeURIComponent(bid)}&all=1`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "无法读取参考图影响");
      if (boardId !== bid || !section.isConnected) return;
      status.textContent = result.canvas.length || result.remake.length ? "这些版本使用的参考图已更新或需要重新定稿。" : "可访问的项目没有受影响的版本。";
      const chosen = [];
      const show = (entry, label, remake) => {
        const li = document.createElement("li"), button = document.createElement("button");
        button.type = "button"; button.textContent = label;
        button.onclick = async () => {
          if (entry.board && entry.board !== boardId) {
            alClose();
            await openBoard(entry.board);
            if (boardId !== entry.board) return;
          }
          const target = vtResolve(entry.node, entry.ref);
          if (!target) return toast("原版本已不存在");
          if (target.node.cur !== target.index && !switchVersion(target.node, target.index)) return;
          alClose(); selectOnly(target.node.id); fit([target.node]);
          if (remake) openVideoRemake(target.node, {shotStart:entry.start});
        };
        if (entry.person) {
          const check = document.createElement("input");
          check.type = "checkbox"; check.setAttribute("aria-label", `重做${label}`);
          chosen.push([entry, check]); li.append(check);
        }
        li.append(button); list.append(li);
      };
      const label = e => [e.project, e.name].filter(Boolean).join(" · ");
      result.remake.forEach(entry => show(entry, `${label(entry)} · 镜头 ${entry.shot + 1}`, true));
      result.canvas.forEach(entry => {
        const views = (entry.views || []).map(change=>`${CHARACTER_VIEWS[change.view]?.[0] || "默认参考图"}${change.reference ? "" : "待定稿"}`);
        show(entry, [label(entry),`版本 ${entry.version}`,...views].join(" · "), false);
      });
      redo.hidden = !chosen.length;
      redo.onclick = async () => {
        const selected = chosen.filter(([, check]) => check.checked).map(([entry]) => entry);
        if (!selected.length) { status.textContent = "请先勾选要重做的镜头"; return; }
        const groups = new Map(), messages = [];
        for (const entry of selected) {
          const key = JSON.stringify([entry.board, entry.node, entry.ref, entry.revision, entry.person]);
          const group = groups.get(key) || [];
          group.push(entry); groups.set(key, group);
        }
        redo.disabled = true;
        try {
          for (const entries of groups.values()) {
            if (boardId !== bid) throw new Error("画布已切换");
            const {board:project,node,ref,revision,person} = entries[0];
            const state = await remakeRequest(`/api/video-remake/${encodeURIComponent(project || bid)}/${encodeURIComponent(node)}?source=${encodeURIComponent(ref)}`, {
              action:"batch_previews", cut_revision:revision, asset:asset.id, person,
              shots:entries.map(e => ({shot:e.shot, frame:e.frame, view:e.view, reference:e.reference})),
            });
            const result = state.batch_previews;
            messages.push(`${entries[0].project || ""} 已提交 ${result.submitted.length} 镜 · 跳过 ${result.skipped.length} 镜`, ...result.failed.map(f => `镜头 ${f.shot + 1} ${f.error}`));
          }
          status.textContent = messages.join("。") + "。旧版仍可继续使用。";
        } catch (error) { status.textContent = [...messages,error.message].join("。"); }
        finally { redo.disabled = false; }
      };
    } catch (error) { status.textContent = error.message; }
  };
}
async function alNew(options={}) {
  if (CM.editor?.dataset.busy === 'true') return toast('正在保存或上传，请稍等');
  AL.selected=null; alRender();
  const team=alFolderTeam();
  const personal=AL.scope==="personal"||AL.scope==="shared";
  const preset=team||personal?{team,board:"",project:"",shared:AL.scope==="shared",...options.preset}:options.preset;
  await cmEdit(null, AL.kind === 'all' ? 'character' : AL.kind, {host:$('#alDetail'), ...options, preset});
}
function alPlace(a) {
  return placeLibraryAsset(a, toW(innerWidth/2-150,innerHeight/2-180),()=>{
    alClose(); toast('已将「'+a.name+'」放入画布');
  });
}
async function openReferenceLibrary(target, kind) {
  const seed=isSeedAudio(target), label=TYPE_CN[kind];
  const dialog=$("#referenceLibrary"), board=B, bid=boardId, epoch=boardOpenEpoch;
  const current=()=>B===board && boardOpenEpoch===epoch && canvasCanEdit() &&
    node(target.id)===target && !target.job && !prepping.has(target.id) &&
    (seed?isSeedAudio(target):target.type==="video" && !target.data.previs && !target.data.film);
  if (dialog.open || !current()) return;
  const form=$("form",dialog), query=$('input[type="search"]',form), list=$("select",form);
  const preview=$(kind,form), status=$("[role=status]",form), apply=$('[type="submit"]',form);
  $("#referenceLibraryTitle",form).textContent="从资产库选用"+label;
  apply.textContent="添加参考"+label;
  let choices=[], busy=false;
  const stopPreview=()=>{
    preview.pause();
    preview.removeAttribute("src");
    preview.hidden=true;
  };
  const close=()=>{
    if(dialog.close)dialog.close();
    else dialog.removeAttribute("open");
    stopPreview();
  };
  const available=({spec})=>{
    const version=curV(spec);
    if (seed) return canSeedAudioReference(target,spec,version) && !(version.seconds>30.001);
    return !target.versions.some(v=>v.ref===version.ref) &&
      !promptMediaInputs(kind,target).some(input=>input.edge.ref===version.ref);
  };
  const picked=()=>choices[list.value];
  const updatePreview=()=>{
    const version=curV(picked()?.spec);
    preview.pause();
    preview.hidden=!version;
    if (version) preview.src=version.url;
    else preview.removeAttribute("src");
    apply.disabled=!version || busy;
  };
  const filter=()=>{
    const q=query.value.trim().toLocaleLowerCase();
    const matches=choices.flatMap((choice,index)=>choice.search.includes(q)&&available(choice)?
      [new Option(choice.label,String(index))]:[]);
    list.replaceChildren(new Option("请选择"+label,""),...matches);
    list.disabled=!matches.length;
    status.textContent=matches.length?"":"没有可添加的"+label+"参考";
    updatePreview();
  };
  const active=()=>dialog.open && form.onsubmit===submit && current();
  const submit=async event=>{
    event.preventDefault();
    const choice=picked();
    if (busy || !choice || !active() || !available(choice)) return;
    const id=choice.spec.data.asset.id, ref=curV(choice.spec).ref;
    busy=query.disabled=list.disabled=apply.disabled=true;
    status.textContent="正在核对素材…";
    try {
      const [asset]=await boardRequest("/api/memory/resolve","POST",{board:bid,ids:[id]});
      if (!active()) return;
      const resolved=asset && vtLibraryReferences([asset],kind).find(({spec})=>curV(spec).ref===ref);
      if (!resolved || !available(resolved)) throw new Error("资产或参考列表已更新，请重新选择");
      const {spec}=resolved;
      const existing=B.nodes.find(n=>n!==target && n.type===kind &&
        n.versions.some(v=>v.ref===ref && v.source!=="previs" && (seed || canLink(n,target,v))) &&
        !vtReferenceAncestors(n).has(target.id));
      checkpoint();
      const dimensions=size(spec);
      const source=existing || buildCanvasMediaNode(spec,
        freeSpot(target.x-dimensions.w-CT_LAYOUT_GAP.x,target.y,kind,dimensions));
      if (seed) addSeedAudioReference(target,source,source.versions.find(v=>v.ref===ref),false);
      else bindPromptMedia(source,target,ref,false);
      close();
      toast("已添加参考"+label);
    } catch(error) {
      if (active()) status.textContent=error.message;
    } finally {
      if (active()) {
        busy=query.disabled=list.disabled=false;
        apply.disabled=!picked();
      }
    }
  };
  form.onsubmit=submit;
  $("[data-cancel]",form).onclick=close;
  dialog.onclose=()=>{if(!dialog.open)stopPreview();};
  dialog.onkeydown=event=>event.stopPropagation();
  query.value="";
  query.disabled=list.disabled=true;
  query.oninput=filter;
  list.onchange=updatePreview;
  list.replaceChildren();
  status.textContent="正在读取资产库…";
  updatePreview();
  if(dialog.showModal)dialog.showModal();
  else dialog.setAttribute("open","");
  try {
    const items=await boardRequest("/api/memory?board="+encodeURIComponent(bid));
    if (!active()) return;
    choices=vtLibraryReferences(items,kind);
    query.disabled=false;
    filter();
    query.focus();
  } catch(error) {
    if (active()) status.textContent=error.message;
  }
}

function alStartDrag(event) {
  const card=event.target.closest(".al-card");
  if(!card || event.target!==card || !canvasCanEdit() || AL.batchBusy || AL.folderBusy)return;
  const id=card.dataset.id;
  const ids=AL.marked.has(id)?[id,...[...AL.marked].filter(item=>item!==id)]:[id];
  event.dataTransfer.setData(AL_DRAG_TYPE,id);
  event.dataTransfer.effectAllowed="copy";
  AL.drag={ids,board:B};
  // Keep the card painted until the browser has captured the drag preview.
  requestAnimationFrame(()=>{
    if(AL.drag?.ids===ids)$("#assetLibrary").classList.add("al-dragging");
  });
}
function alEndDrag() {
  if(!AL.drag)return;
  AL.drag=null;
  $("#assetLibrary").classList.remove("al-dragging");
  alRender();
}
async function alBatch(action, ids=[...AL.marked], at=null) {
  if (AL.batchBusy || AL.folderBusy || !ids.length) return;
  if(action==="place" && !canvasCanEdit())return;
  const bid=boardId, board=B;
  AL.batchBusy=true;alRenderFolders();
  try{
    const items=await boardRequest("/api/memory/resolve","POST",{board:bid,ids});
    if(!AL.open||boardId!==bid||B!==board)return;
    if(action==="place"){
      if(!canvasCanEdit())return;
      const made=placeLibraryBatch(items,at||toW(innerWidth*.36,innerHeight*.28));
      AL.marked.clear();
      alClose();
      toast(`已放入 ${made.length} 项资产`);
    }else{
      const refs=items.map(libraryPrimary).filter(Boolean).map(media=>media.ref);
      if(!refs.length)throw new Error("所选资产没有可下载的媒体");
      await downloadAssetRefs(refs,"OneShot-资产库.zip",{host:$("#assetLibrary")});
    }
  }catch(error){if(boardId===bid)toast(error.message,4500);}
  finally{AL.batchBusy=false;if(AL.open)alRenderFolders();}
}
async function alReference(a) {
  try {
    const bid=boardId;await cmList(true);if(bid!==boardId)return;alClose();await acOpen();if(bid!==boardId)return;const ta=$('#acInput');
    if(ta.value&&!/\s$/.test(ta.value))ta.value+=' ';
    ta.setSelectionRange(ta.value.length,ta.value.length);cmInsert(ta,a);toast('已引用「'+a.name+'」，继续描述创作要求');
  }catch(e){toast('引用失败：'+e.message);}
}
function alImportMenu() {
  const box=$('#alImport'); box.hidden=!box.hidden; if(box.hidden)return; box.replaceChildren();
  const nodes=B.nodes.filter(n=>n.type==='text'&&n.data.text?.trim() || ['image','video','audio'].includes(n.type)&&curV(n));
  if(!nodes.length){box.textContent='画布还没有可收录的素材';return;}
  for(const n of nodes){
    const button=document.createElement('button');button.type='button';button.textContent=n.name+' · '+TYPE_CN[n.type];
    button.onclick=boardAction(async()=>{
      box.hidden=true;
      const bid=boardId;await flushSave();if(bid!==boardId||node(n.id)!==n)return;
      if(n.type==='text')return alNew({preset:documentAssetPreset(n.name,documentText(n)),kind:'document'});
      const v=curV(n);
      if(v)await alNew({preset:{name:n.name,desc:n.data.caption||v.prompt||'',pending:{...v,type:n.type,source_board:bid,node_id:n.id}},
        kind:AL.kind==='all'?'character':AL.kind});
    });
    box.append(button);
  }
}
function alChanged(a, removed=false) {
  if (!AL.open) return;
  if (removed || a.board && !alBoardInLibrary(a.board) || a.project && a.project !== currentProject()?.id) {
    AL.items=AL.items.filter(x=>x.id!==a.id); AL.selected=null; alEmptyDetail();
  }
  else {
    const prior=AL.items.find(x=>x.id===a.id);
    if (prior && !Object.hasOwn(a,"folder_id")) a={...a,folder_id:prior.folder_id};
    if (prior?.team && prior.team===a.team && !Object.hasOwn(a,"team_folder_id"))a={...a,team_folder_id:prior.team_folder_id};
    AL.items=AL.items.filter(x=>x.id!==a.id).concat(a); AL.selected=a.id;
  }
  if(AL.query.trim())alSearchDocuments();
  alRender();
}
function alBoardChanged() { alClose(); alCloseCanvasImport(); AL.board=null; AL.items=[]; AL.selected=null; AL.marked.clear(); AL.filing=false; $("#alFolderEditor").replaceChildren(); CM.editor?.remove(); CM.editor=null; alEmptyDetail(); }
function initAssetLibrary() {
  const pane=document.createElement('section');pane.id='assetLibrary';pane.hidden=true;pane.setAttribute('role','dialog');pane.setAttribute('aria-modal','false');pane.setAttribute('aria-labelledby','alTitle');
  pane.innerHTML=`<header class="al-head"><div class="al-title">${ico('assets')}<div><h1 id="alTitle">当前资产库</h1></div></div><button type="button" id="alClose" aria-label="返回画布">${ico('left')}返回画布</button></header><div class="al-body"><nav class="al-sidebar" aria-label="资产分类"><div class="al-nav-label">创作资产</div><div id="alCategories">${Object.entries(AL_KINDS).map(([k,v])=>`<button type="button" data-kind="${k}" aria-pressed="${k==='all'}"><span>${v}</span><small>0</small></button>`).join('')}</div><div class="al-sidebar-note">资产可包含图片、视频、音频和文字设定。<br>输入 @ 自动引用，生成历史持续保留。</div><button type="button" id="alTemplate">工作流模板</button><button type="button" id="alHistory">${ico('clock')}素材历史</button></nav><main class="al-main"><div class="al-toolbar"><label class="al-search">${ico('search')}<input id="alSearch" maxlength="1000" placeholder="输入名称、标签或镜头描述" aria-label="搜索资产"></label><button type="button" id="alSemantic">按描述找</button><button type="button" id="alUpload">${ico('upload')}上传素材</button><button type="button" id="alNew">${ico('plus')}新建资产</button><input id="alFile" type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm,.mp3,.wav,.m4a,.aac,.flac,.ogg,.txt,.md,.markdown,.csv,.json,.docx,.pdf" hidden></div><div class="al-filterbar"><h2 id="alHeading">所有资产</h2><span id="alCount">0 项资产</span><div class="al-filters"><select id="alScope" aria-label="资产范围"><option value="current">当前资产库</option><option value="personal">个人资产库</option><option value="shared">共享素材</option></select><select id="alSource" aria-label="资产来源"><option value="all">所有来源</option><option value="upload">用户上传</option><option value="generated">生成素材</option><option value="mixed">多种来源</option><option value="text">文本资料</option><option value="other">已有素材</option></select><select id="alSort" aria-label="资产排序"><option value="relevance" hidden>按相关性</option><option value="recent">最近更新</option><option value="name">名称排序</option></select><button type="button" id="alReset" title="重置筛选">重置</button><button type="button" id="alRefresh" title="刷新资产库" aria-label="刷新资产库">${ico('redo')}</button></div></div><div class="al-feedback"><span id="alLoading" hidden>正在读取资产…</span><span id="alError" role="alert" hidden></span><span id="alSemanticStatus" role="status" hidden></span></div><div class="al-content"><div id="alGrid" class="al-grid"></div><div id="alEmpty" class="al-empty">${ico('assets')}<h3 id="alEmptyTitle">还没有资产</h3><p id="alEmptyText"></p><div><button type="button" id="alEmptyNew">新建资产</button><button type="button" id="alFromCanvas">从画布收录</button></div></div><button type="button" id="alLoadMore" hidden>加载更多资产</button></div><div class="al-foot"><span>拖动资产卡片可放入画布。</span><button type="button" id="alImportBtn">从画布收录</button></div><div id="alImport" class="al-import" hidden></div></main><aside id="alDetail" class="al-detail" aria-label="资产详情"></aside></div>`;
  document.body.append(pane);alEmptyDetail();
  pane.insertAdjacentHTML("afterend",`<dialog id="alCanvasImport" aria-labelledby="alCanvasImportTitle"><h2 id="alCanvasImportTitle">收录到资产库</h2><div data-canvas-import-form></div></dialog>`);
  const canvasImport=$("#alCanvasImport"), importForm=$("[data-canvas-import-form]",canvasImport);
  canvasImport.addEventListener("cancel",event=>{if($('form[aria-busy="true"]',importForm))event.preventDefault();});
  canvasImport.addEventListener("close",()=>{if(!canvasImport.open)importForm.replaceChildren();});
  pane.addEventListener("dragstart",alStartDrag);
  pane.addEventListener("dragend",alEndDrag);
  vp.addEventListener("dragover",event=>{
    if(!AL.drag || !event.dataTransfer.types.includes(AL_DRAG_TYPE))return;
    event.preventDefault();event.stopPropagation();
    event.dataTransfer.dropEffect=canvasCanEdit()?"copy":"none";
  },true);
  vp.addEventListener("drop",event=>{
    if(!AL.drag || !event.dataTransfer.types.includes(AL_DRAG_TYPE))return;
    event.preventDefault();event.stopImmediatePropagation();
    const {ids,board}=AL.drag;
    const valid=B===board && event.dataTransfer.getData(AL_DRAG_TYPE)===ids[0];
    alEndDrag();
    if(valid)void alBatch("place",ids,toW(event.clientX,event.clientY));
  },true);
  $(".al-toolbar",pane).insertAdjacentHTML("afterend",`<div class="al-folder-bar">
    <div id="alFolders" aria-label="素材文件夹"></div><div class="al-folder-actions">
    <button type="button" id="alNewFolder">＋ 文件夹</button><button type="button" id="alRenameFolder" hidden>改名</button>
    <button type="button" id="alDeleteFolder" hidden>删除</button><button type="button" id="alFileMode" aria-pressed="false">多选资产</button></div>
    <div id="alFolderEditor"></div>
    <div id="alFileActions" hidden><span id="alSelectedCount"></span><button type="button" id="alApplyBatch">放入画布</button>
    <button type="button" id="alDownloadBatch">下载媒体</button><select id="alTargetFolder" aria-label="归档目标"></select><button type="button" id="alApplyFolder">移动</button></div>
  </div>`);
  $("#alFolders").onclick=e=>{
    const value=e.target.closest("[data-folder]")?.dataset.folder;
    if(value){AL.folder=value;AL.marked.clear();$("#alFolderEditor").replaceChildren();alRender();}
  };
  $("#alNewFolder").onclick=()=>alFolderEditor("create");
  $("#alRenameFolder").onclick=()=>alFolderEditor("rename");
  $("#alDeleteFolder").onclick=()=>alFolderEditor("delete");
  $("#alFileMode").onclick=e=>{AL.filing=!AL.filing;AL.marked.clear();e.target.setAttribute("aria-pressed",String(AL.filing));alRender();};
  $("#alApplyBatch").onclick=()=>alBatch("place");
  $("#alDownloadBatch").onclick=()=>alBatch("download");
  $("#alTargetFolder").onchange=alRenderFolders;
  $("#alApplyFolder").onclick=()=>alFolderChange(async()=>{
    const value=$("#alTargetFolder").value;
    const team=alFolderTeam();
    await boardRequest("/api/asset-folders/members","POST",{board:boardId,assets:[...AL.marked],folder:value==="none"?null:value,
      ...(team?{team}:{})});
    AL.marked.clear();
  });
  pane.addEventListener('pointerdown',e=>e.stopPropagation());pane.addEventListener('wheel',e=>e.stopPropagation(),{passive:true});pane.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Escape'){if(!$('#alImport').hidden){$('#alImport').hidden=true;return;}if(CM.editor?.closest('#assetLibrary')){CM.editor.querySelector('[data-close]').click();return;}alClose();}});
  $('#alClose').onclick=alClose;$('#alNew').onclick=()=>alNew();$('#alEmptyNew').onclick=()=>alNew();$('#alRefresh').onclick=alRefresh;
  $('#alLoadMore').onclick=alLoadMore;
  $('#alSearch').oninput=e=>{AL.query=e.target.value;alClearSemantic();alSearchDocuments();alRender();};
  $('#alSearch').onkeydown=e=>{if(e.key==="Enter"&&!e.isComposing){e.preventDefault();void alFindByDescription();}};
  $('#alSemantic').onclick=alFindByDescription;
  $('#alScope').onchange=e=>{
    if(AL.scope===e.target.value)return;
    AL.scope=e.target.value;
    AL.folder='all'; AL.marked.clear(); AL.filing=false; $("#alFolderEditor").replaceChildren();
    alSearchDocuments();
    void alRefresh();
    alRender();
  };
  for(const [id,field] of [['alSource','source'],['alSort','sort']])$('#'+id).onchange=e=>{AL[field]=e.target.value;alRender();};
  $$('#alCategories [data-kind]').forEach(b=>b.onclick=()=>{AL.kind=b.dataset.kind;alClearSemantic();alRender();});
  $('#alReset').onclick=()=>{const changed=AL.scope!=="current";alResetFilters();if(changed)void alRefresh();alRender();};
  $('#alFromCanvas').onclick=$('#alImportBtn').onclick=alImportMenu;
  $('#alUpload').onclick=()=>$('#alFile').click();$('#alFile').onchange=e=>{const file=e.target.files[0];if(file)alNew({file,kind:CM_DOCUMENT_EXT.test(file.name)?'document':undefined,preset:{name:file.name.replace(/\.[^.]+$/,'')}});e.target.value='';};
  $('#alTemplate').onclick=openWorkflowTemplates;
  $('#alHistory').onclick=()=>{alClose();$('#drawer').classList.add('on');loadAssets();};
  const openCurrent = () => alOpen(AL.open && AL.scope !== "current" ? {scope:"current"} : null);
  $('#assetLibraryBtn').onclick=$('#assetBtn').onclick=openCurrent;
  document.addEventListener('pointerdown',e=>{if(!e.target.closest('#alImport,#alImportBtn,#alFromCanvas'))$('#alImport').hidden=true;});
}
