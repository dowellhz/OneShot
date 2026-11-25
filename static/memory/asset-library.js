"use strict";
// A dedicated asset workspace; the canvas drawer remains the quick media picker.
const AL = {open:false, board:null, items:[], kind:'all', query:'', scope:'current', source:'all', sort:'recent', selected:null, epoch:0, returnFocus:null};
const AL_KINDS = {all:'所有资产', ...KIND_CN};
const AL_DRAG_TYPE = "application/x-oneshot-library";
Object.assign(AL,{folders:[],folder:'all',marked:new Set(),filing:false});
const alCurrentTeam = () => B?.team || boardDirectory.find(b=>b.id===boardId)?.team || "";
function alCurrentName() {
  const team = alCurrentTeam();
  return team ? canvasTeams.find(t=>t.id===team)?.name || "团队" : currentProject()?.name || B?.name || "未命名画布";
}
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
function alEmptyDetail() {
  const host = $('#alDetail'); if (!host) return;
  host.innerHTML = OneShotI18n.html`<div class="al-detail-empty">${ico('assets')}<strong>资产详情</strong><p>选择一项资产，查看设定、参考素材和生成历史。</p><span>在对话或提示词中输入 @，即可采用资产。</span></div>`;
}
function alRender() {
  if (!AL.open || AL.drag) return;
  alRenderFolders();
  const currentLabel = OneShotI18n.t("当前资产库") + " · " + alCurrentName();
  $("#alScope option[value=current]").textContent = currentLabel;
  $("#alTitle").textContent = AL.scope === "current" ? currentLabel : OneShotI18n.t("资产库");
  const base = alBaseItems(), list = base.filter(a => AL.kind === 'all' || a.kind === AL.kind);
  if(AL.sort!=="relevance")list.sort((a,b) => AL.sort === 'name' ? a.name.localeCompare(b.name,'zh-CN') : (b.mtime||0)-(a.mtime||0));
  $("#alSort option[value=relevance]").hidden = !AL.semantic?.ids;
  $("#alSort").value = AL.sort;
  $("#alSemantic").disabled = !alCanFindByDescription();
  const status = $("#alSemanticStatus");
  status.textContent = AL.semantic?.pending ? OneShotI18n.t("正在按描述查找…") : AL.semantic?.error || ({
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
  more.textContent = AL.loadingMore ? OneShotI18n.t('正在加载…') : OneShotI18n.t('加载更多资产');
  $('#alCount').textContent = `${more.hidden ? '' : '已显示 '}${list.length} 项资产`;
  $('#alHeading').textContent = AL_KINDS[AL.kind];
  $('#alGrid').replaceChildren(); $('#alEmpty').hidden = !!list.length || !$('#alLoading').hidden;
  const filtered = AL.query || AL.scope !== 'current' || AL.source !== 'all';
  $('#alEmptyTitle').textContent = !more.hidden ? OneShotI18n.t('已加载的资产中没有匹配项') : filtered ? OneShotI18n.t('没有匹配的资产') : AL.folder!=='all' ? OneShotI18n.t('这个文件夹暂无资产') : `还没有${AL.kind === 'all' ? '资产' : AL_KINDS[AL.kind]}`;
  $('#alEmptyText').textContent = !more.hidden ? OneShotI18n.t('可继续加载这个资产库中的较早素材。') : filtered ? OneShotI18n.t('试试其他关键词，或重置筛选条件。') : AL.folder!=='all' ? OneShotI18n.t('从全部资产选择要归档的素材，再移动到此文件夹。') : OneShotI18n.t('上传素材、从画布收录，或新建一份背景资料。');
  for (const a of list) {
    const card = document.createElement('article'); card.className = 'al-card' + (AL.selected === a.id ? ' selected' : ''); card.dataset.id = a.id;
    const draftMain = a.kind === 'character' && characterResult(a, 'main', boardId);
    const hasDraft = a.kind === 'character' && Object.keys(CHARACTER_VIEWS).some(slot => characterResult(a, slot, boardId));
    const showDraftCover = draftMain && !a.character_views?.main;
    const ref=showDraftCover?draftMain:alThumb(a), type=cmMediaType(ref,a.media?.find(m=>m.ref===ref)), video=type==="video";
    const image=video?`<video src="/media?ref=${encodeURIComponent(ref)}#t=0.1" preload="metadata" muted playsinline></video>`
      :type==="image"?`<img src="/media?ref=${encodeURIComponent(ref)}" draggable="false" loading="lazy" alt="${esc(a.name)}">`
      :`<div class="al-text-preview">${ico(type==="audio"?'audio':'script')}<p>${esc((a.desc || a.document?.excerpt || a.document?.text || (type==="audio"?'音频素材':'背景资料')).slice(0,180))}</p></div>`;
    card.innerHTML = OneShotI18n.html`<button type="button" class="al-card-main" aria-label="${esc(OneShotI18n.t("查看资产 {name}", {name:a.name}))}" aria-pressed="${AL.selected === a.id}"><div class="al-cover">${image}<span class="al-type">${esc(cmKind(a))}</span>${hasDraft ? '<span class="al-reference">新图待定稿</span>' : a.ref ? OneShotI18n.markup('<span class="al-reference">默认参考</span>') : video ? OneShotI18n.markup('<span class="al-reference">视频资料</span>') : ''}</div><div class="al-card-info"><strong>${esc(a.name)}</strong><p>${esc(a.desc || OneShotI18n.t('尚未填写设定'))}</p><div class="al-card-meta"><span>${esc(OneShotI18n.t(alSourceLabel(a)))}</span><span>${esc(cmScopeLabel(a))}</span></div><div class="al-tags">${(a.tags||[]).slice(0,3).map(t=>`<span>${esc(t)}</span>`).join('')}</div></div></button><div class="al-card-actions"><button type="button" data-action="canvas" title="放入当前画布">${ico('plus')}放入画布</button><button type="button" data-action="reference" title="在创作助手中引用此资产">@ 引用</button></div>`;
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
    const bid=boardId, candidates=await cmReferenceSearch(a.name);
    if(bid!==boardId)return;
    const asset = candidates.find(item=>item.id===a.id) || {...a,reference_ambiguous:true};
    alClose();await acOpen();if(bid!==boardId)return;const ta=$('#acInput');
    if(ta.value&&!/\s$/.test(ta.value))ta.value+=' ';
    ta.setSelectionRange(ta.value.length,ta.value.length);cmInsert(ta,asset);toast('已引用「'+a.name+'」，继续描述创作要求');
  }catch(e){toast('引用失败：'+e.message);}
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
  pane.innerHTML=OneShotI18n.html`<header class="al-head"><div class="al-title">${ico('assets')}<div><h1 id="alTitle">当前资产库</h1></div></div><button type="button" id="alClose" aria-label="返回画布">${ico('left')}返回画布</button></header><div class="al-body"><nav class="al-sidebar" aria-label="资产分类"><div class="al-nav-label">创作资产</div><div id="alCategories">${Object.entries(AL_KINDS).map(([k,v])=>`<button type="button" data-kind="${k}" aria-pressed="${k==='all'}"><span>${OneShotI18n.t(v)}</span><small>0</small></button>`).join('')}</div><div class="al-sidebar-note">资产可包含图片、视频、音频和文字设定。<br>输入 @ 自动引用，生成历史持续保留。</div><button type="button" id="alTemplate">工作流模板</button><button type="button" id="alHistory">${ico('clock')}素材历史</button></nav><main class="al-main"><div class="al-toolbar"><label class="al-search">${ico('search')}<input id="alSearch" maxlength="1000" placeholder="输入名称、标签或镜头描述" aria-label="搜索资产"></label><button type="button" id="alSemantic">按描述找</button><button type="button" id="alUpload">${ico('upload')}上传素材</button><button type="button" id="alNew">${ico('plus')}新建资产</button><input id="alFile" type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm,.mp3,.wav,.m4a,.aac,.flac,.ogg,.txt,.md,.markdown,.csv,.json,.docx,.pdf" hidden></div><div class="al-filterbar"><h2 id="alHeading">所有资产</h2><span id="alCount">0 项资产</span><div class="al-filters"><select id="alScope" aria-label="资产范围"><option value="current">当前资产库</option><option value="personal">个人资产库</option><option value="shared">共享素材</option></select><select id="alSource" aria-label="资产来源"><option value="all">所有来源</option><option value="upload">用户上传</option><option value="generated">生成素材</option><option value="mixed">多种来源</option><option value="text">文本资料</option><option value="other">已有素材</option></select><select id="alSort" aria-label="资产排序"><option value="relevance" hidden>按相关性</option><option value="recent">最近更新</option><option value="name">名称排序</option></select><button type="button" id="alReset" title="重置筛选">重置</button><button type="button" id="alRefresh" title="刷新资产库" aria-label="刷新资产库">${ico('redo')}</button></div></div><div class="al-feedback"><span id="alLoading" hidden>正在读取资产…</span><span id="alError" role="alert" hidden></span><span id="alSemanticStatus" role="status" hidden></span></div><div class="al-content"><div id="alGrid" class="al-grid"></div><div id="alEmpty" class="al-empty">${ico('assets')}<h3 id="alEmptyTitle">还没有资产</h3><p id="alEmptyText"></p><div><button type="button" id="alEmptyNew">新建资产</button><button type="button" id="alFromCanvas">从画布收录</button></div></div><button type="button" id="alLoadMore" hidden>加载更多资产</button></div><div class="al-foot"><span>拖动资产卡片可放入画布。</span><button type="button" id="alImportBtn">从画布收录</button></div><div id="alImport" class="al-import" hidden></div></main><aside id="alDetail" class="al-detail" aria-label="资产详情"></aside></div>`;
  document.body.append(pane);alEmptyDetail();
  pane.insertAdjacentHTML("afterend",OneShotI18n.html`<dialog id="alCanvasImport" aria-labelledby="alCanvasImportTitle"><h2 id="alCanvasImportTitle">收录到资产库</h2><div data-canvas-import-form></div></dialog>`);
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
  $(".al-toolbar",pane).insertAdjacentHTML("afterend",OneShotI18n.html`<div class="al-folder-bar">
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
