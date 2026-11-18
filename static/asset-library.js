"use strict";
// A dedicated asset workspace; the canvas drawer remains the quick media picker.
const AL = {open:false, board:null, items:[], kind:'all', query:'', scope:'all', source:'all', sort:'recent', selected:null, epoch:0, returnFocus:null};
const AL_KINDS = {all:'所有资产', ...KIND_CN};
function alSource(a) {
  const sources = new Set((a.media || []).map(m => m.source === 'upload' ? 'upload' : ['gen','generated','edit','film'].includes(m.source) ? 'generated' : 'other'));
  if (sources.size > 1) return 'mixed';
  return sources.values().next().value || 'text';
}
function alSourceLabel(a) { return {upload:'用户上传',generated:'生成素材',mixed:'多种来源',text:'文本资料',other:'已有素材'}[alSource(a)]; }
function alEditable(a) { return !a || !ME_USER || ME_USER.role === 'admin' || a.owner == null || a.owner === ME_USER.id; }
function alThumb(a) { return a.ref || (a.media || []).find(m => /\.(png|jpe?g|webp|mp4|mov|webm)$/i.test(m.ref))?.ref || ''; }
function alBaseItems() {
  const q = AL.query.trim().toLocaleLowerCase();
  return AL.items.filter(a => (!q || [a.name,a.desc,...(a.aliases||[]),...(a.tags||[])].join(' ').toLocaleLowerCase().includes(q))
    && (AL.scope === 'all' || AL.scope === 'project' && a.board === boardId || AL.scope === 'personal' && !a.board && (a.owner == null || a.owner === ME_USER?.id) || AL.scope === 'shared' && a.shared)
    && (AL.source === 'all' || alSource(a) === AL.source));
}
function alEmptyDetail() {
  const host = $('#alDetail'); if (!host) return;
  host.innerHTML = `<div class="al-detail-empty">${ico('assets')}<strong>资产详情</strong><p>选择一项资产，查看设定、参考素材和生成历史。</p><span>在对话或提示词中输入 @，即可采用资产。</span></div>`;
}
function alRender() {
  if (!AL.open) return;
  const base = alBaseItems(), list = base.filter(a => AL.kind === 'all' || a.kind === AL.kind);
  list.sort((a,b) => AL.sort === 'name' ? a.name.localeCompare(b.name,'zh-CN') : (b.mtime||0)-(a.mtime||0));
  for (const b of $$('#alCategories [data-kind]')) {
    b.classList.toggle('on', b.dataset.kind === AL.kind); b.setAttribute('aria-pressed', String(b.dataset.kind === AL.kind));
    b.querySelector('small').textContent = base.filter(a => b.dataset.kind === 'all' || a.kind === b.dataset.kind).length;
  }
  $('#alCount').textContent = `${list.length} 项资产`;
  $('#alHeading').textContent = AL_KINDS[AL.kind];
  $('#alGrid').replaceChildren(); $('#alEmpty').hidden = !!list.length;
  $('#alEmptyTitle').textContent = AL.query || AL.scope !== 'all' || AL.source !== 'all' ? '没有匹配的资产' : `还没有${AL.kind === 'all' ? '资产' : AL_KINDS[AL.kind]}`;
  $('#alEmptyText').textContent = AL.query || AL.scope !== 'all' || AL.source !== 'all' ? '试试其他关键词，或重置筛选条件。' : '上传素材、从画布收录，或新建一份背景资料。';
  for (const a of list) {
    const card = document.createElement('article'); card.className = 'al-card' + (AL.selected === a.id ? ' selected' : ''); card.dataset.id = a.id;
    const draftMain = a.kind === 'character' && characterResult(a, 'main', boardId);
    const hasDraft = a.kind === 'character' && Object.keys(CHARACTER_VIEWS).some(slot => characterResult(a, slot, boardId));
    const showDraftCover = draftMain && !a.character_views?.main;
    const ref = showDraftCover ? draftMain : alThumb(a), video = /\.(mp4|mov|webm)$/i.test(ref);
    const image = ref ? video ? `<video src="/media?ref=${encodeURIComponent(ref)}#t=0.1" preload="metadata" muted playsinline></video>` : `<img src="/media?ref=${encodeURIComponent(ref)}" loading="lazy" alt="${esc(a.name)}">` : `<div class="al-text-preview">${ico('script')}<p>${esc((a.desc || '背景资料').slice(0,180))}</p></div>`;
    card.innerHTML = `<button type="button" class="al-card-main" aria-label="查看资产 ${esc(a.name)}" aria-pressed="${AL.selected === a.id}"><div class="al-cover">${image}<span class="al-type">${esc(cmKind(a))}</span>${hasDraft ? '<span class="al-reference">新图待定稿</span>' : a.ref ? '<span class="al-reference">默认参考</span>' : video ? '<span class="al-reference">视频资料</span>' : ''}</div><div class="al-card-info"><strong>${esc(a.name)}</strong><p>${esc(a.desc || '尚未填写设定')}</p><div class="al-card-meta"><span>${esc(alSourceLabel(a))}</span><span>${a.board ? '当前项目' : a.shared ? '共享素材' : '个人素材库'}</span></div><div class="al-tags">${(a.tags||[]).slice(0,3).map(t=>`<span>${esc(t)}</span>`).join('')}</div></div></button><div class="al-card-actions"><button type="button" data-action="canvas" title="放入当前画布">${ico('plus')}放入画布</button><button type="button" data-action="reference" title="在创作助手中引用此资产">@ 引用</button></div>`;
    card.querySelector('.al-card-main').onclick = () => alSelect(a);
    card.querySelector('[data-action=canvas]').onclick = () => alPlace(a);
    card.querySelector('[data-action=reference]').onclick = () => alReference(a);
    card.draggable = true; card.ondragstart = e => e.dataTransfer.setData('application/x-h3-lib', JSON.stringify(a));
    $('#alGrid').append(card);
  }
}
async function alRefresh() {
  const epoch = ++AL.epoch, bid = boardId; $('#alError').hidden = true; $('#alLoading').hidden = false;
  try {
    const r = await fetch('/api/memory?board=' + encodeURIComponent(bid)); const items = await r.json();
    if (!r.ok) throw new Error(items.error || '读取资产库失败');
    if (!AL.open || AL.epoch !== epoch || bid !== boardId) return;
    AL.items = items; AL.board = bid; cmInvalidate(); alRender();
    await refreshCharacterResults(items, bid);
    if (AL.open && AL.epoch === epoch && bid === boardId) alRender();
  } catch (e) {
    if (AL.open && AL.epoch === epoch) { $('#alError').textContent = e.message + '，可点击刷新重试。'; $('#alError').hidden = false; }
  } finally { if (AL.epoch === epoch) $('#alLoading').hidden = true; }
}
async function alOpen() {
  if (!B) return;
  if(CM.editor && !CM.editor.closest("#assetLibrary")){if(CM.editor.dataset.busy==="true")return toast("正在保存或上传，请稍等");CM.editor.remove();CM.editor=null;}
  if (!AL.open) AL.returnFocus = document.activeElement;
  AL.open = true; $('#assetLibrary').hidden = false; $('#assetBtn').classList.add('on'); $('#assetLibraryBtn').setAttribute('aria-expanded','true');
  $('#drawer').classList.remove('on'); cmClose(); closeMenus();
  if (AL.board !== boardId) { AL.items=[]; AL.selected=null; alEmptyDetail(); }
  alRender(); $('#alSearch').focus(); await alRefresh();
}
function alClose() {
  if (!AL.open) return;
  AL.open=false; AL.epoch++; $('#assetLibrary').hidden=true; $('#assetBtn').classList.remove('on'); $('#assetLibraryBtn').setAttribute('aria-expanded','false');
  $('#alImport').hidden=true; cmClose(); AL.returnFocus?.focus();
}
async function alSelect(a) {
  if (CM.editor?.dataset.busy === 'true') return toast('正在保存或上传，请稍等');
  AL.selected=a.id; alRender(); await cmEdit(a, a.kind, {host:$('#alDetail'), readonly:!alEditable(a)});
}
async function alNew(options={}) {
  if (CM.editor?.dataset.busy === 'true') return toast('正在保存或上传，请稍等');
  AL.selected=null; alRender();
  await cmEdit(null, AL.kind === 'all' ? 'character' : AL.kind, {host:$('#alDetail'), ...options});
}
function alPlace(a) { placeLibAsset(a, toW(innerWidth/2-150,innerHeight/2-180)); alClose(); toast('已将「'+a.name+'」放入画布'); }
async function alReference(a) {
  try {
    const bid=boardId;await cmList(true);if(bid!==boardId)return;alClose();await acOpen();if(bid!==boardId)return;const ta=$('#acInput');
    if(ta.value&&!/\s$/.test(ta.value))ta.value+=' ';
    ta.setSelectionRange(ta.value.length,ta.value.length);cmInsert(ta,a);toast('已引用「'+a.name+'」，继续描述创作要求');
  }catch(e){toast('引用失败：'+e.message);}
}
function alImportMenu() {
  const box=$('#alImport'); box.hidden=!box.hidden; if(box.hidden)return; box.replaceChildren();
  const nodes=B.nodes.filter(n=>n.type==='text'&&n.data.text?.trim() || ['image','video'].includes(n.type)&&curV(n));
  if(!nodes.length){box.textContent='画布还没有可收录的素材';return;}
  for(const n of nodes){const b=document.createElement('button');b.type='button';b.textContent=n.name+' · '+TYPE_CN[n.type];b.onclick=async()=>{box.hidden=true;try{const bid=boardId;await flushSave();if(bid!==boardId)return;const v=curV(n);await alNew({preset:{name:n.name,desc:n.data.caption||n.data.text||v?.prompt||'',...(v?{pending:{...v,source_board:boardId,node_id:n.id}}:{} )},kind:n.type==='text'?'document':(AL.kind==='all'?'character':AL.kind)});}catch(e){toast(e.message);}};box.append(b);}
}
function alChanged(a, removed=false) {
  if (!AL.open || a.board && a.board !== boardId) return;
  if (removed) { AL.items=AL.items.filter(x=>x.id!==a.id); AL.selected=null; alEmptyDetail(); }
  else { AL.items=AL.items.filter(x=>x.id!==a.id).concat(a); AL.selected=a.id; }
  alRender();
}
function alBoardChanged() { alClose(); AL.board=null; AL.items=[]; AL.selected=null; CM.editor?.remove(); CM.editor=null; alEmptyDetail(); }
function initAssetLibrary() {
  const pane=document.createElement('section');pane.id='assetLibrary';pane.hidden=true;pane.setAttribute('role','dialog');pane.setAttribute('aria-modal','false');pane.setAttribute('aria-labelledby','alTitle');
  pane.innerHTML=`<header class="al-head"><div class="al-title">${ico('assets')}<div><h1 id="alTitle">资产库</h1><p>让人物、场景和故事设定成为可复用的创作资产</p></div></div><button type="button" id="alClose" aria-label="返回画布">${ico('left')}返回画布</button></header><div class="al-body"><nav class="al-sidebar" aria-label="资产分类"><div class="al-nav-label">创作资产</div><div id="alCategories">${Object.entries(AL_KINDS).map(([k,v])=>`<button type="button" data-kind="${k}" aria-pressed="${k==='all'}"><span>${v}</span><small>0</small></button>`).join('')}</div><div class="al-sidebar-note">资产可包含参考图、视频和文字设定。<br>输入 @ 自动引用，生成历史持续保留。</div><button type="button" id="alHistory">${ico('clock')}素材历史</button></nav><main class="al-main"><div class="al-toolbar"><label class="al-search">${ico('search')}<input id="alSearch" placeholder="搜索名称、别名、标签和设定" aria-label="搜索资产"></label><button type="button" id="alUpload">${ico('upload')}上传素材</button><button type="button" id="alNew">${ico('plus')}新建资产</button><input id="alFile" type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm" hidden></div><div class="al-filterbar"><h2 id="alHeading">所有资产</h2><span id="alCount">0 项资产</span><div class="al-filters"><select id="alScope" aria-label="资产范围"><option value="all">所有范围</option><option value="project">当前项目</option><option value="personal">个人素材库</option><option value="shared">共享素材</option></select><select id="alSource" aria-label="资产来源"><option value="all">所有来源</option><option value="upload">用户上传</option><option value="generated">生成素材</option><option value="mixed">多种来源</option><option value="text">文本资料</option><option value="other">已有素材</option></select><select id="alSort" aria-label="资产排序"><option value="recent">最近更新</option><option value="name">名称排序</option></select><button type="button" id="alReset" title="重置筛选">重置</button><button type="button" id="alRefresh" title="刷新资产库" aria-label="刷新资产库">${ico('redo')}</button></div></div><div class="al-feedback"><span id="alLoading" hidden>正在读取资产…</span><span id="alError" role="alert" hidden></span></div><div class="al-content"><div id="alGrid" class="al-grid"></div><div id="alEmpty" class="al-empty">${ico('assets')}<h3 id="alEmptyTitle">还没有资产</h3><p id="alEmptyText"></p><div><button type="button" id="alEmptyNew">新建资产</button><button type="button" id="alFromCanvas">从画布收录</button></div></div></div><div class="al-foot"><span>上传和生成素材统一管理，默认参考图由你指定。</span><button type="button" id="alImportBtn">从画布收录</button></div><div id="alImport" class="al-import" hidden></div></main><aside id="alDetail" class="al-detail" aria-label="资产详情"></aside></div>`;
  document.body.append(pane);alEmptyDetail();
  pane.addEventListener('pointerdown',e=>e.stopPropagation());pane.addEventListener('wheel',e=>e.stopPropagation(),{passive:true});pane.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Escape'){if(!$('#alImport').hidden){$('#alImport').hidden=true;return;}if(CM.editor?.closest('#assetLibrary')){CM.editor.querySelector('[data-close]').click();return;}alClose();}});
  $('#alClose').onclick=alClose;$('#alNew').onclick=()=>alNew();$('#alEmptyNew').onclick=()=>alNew();$('#alRefresh').onclick=alRefresh;
  $('#alSearch').oninput=e=>{AL.query=e.target.value;alRender();};
  for(const [id,field] of [['alScope','scope'],['alSource','source'],['alSort','sort']])$('#'+id).onchange=e=>{AL[field]=e.target.value;alRender();};
  $$('#alCategories [data-kind]').forEach(b=>b.onclick=()=>{AL.kind=b.dataset.kind;alRender();});
  $('#alReset').onclick=()=>{AL.query='';AL.scope=AL.source='all';$('#alSearch').value='';$('#alScope').value=$('#alSource').value='all';alRender();};
  $('#alFromCanvas').onclick=$('#alImportBtn').onclick=alImportMenu;
  $('#alUpload').onclick=()=>$('#alFile').click();$('#alFile').onchange=e=>{const file=e.target.files[0];if(file)alNew({file,preset:{name:file.name.replace(/\.[^.]+$/,'')}});e.target.value='';};
  $('#alHistory').onclick=()=>{alClose();$('#drawer').classList.add('on');loadAssets();};
  $('#assetLibraryBtn').onclick=()=>AL.open?alClose():alOpen();$('#assetBtn').onclick=()=>AL.open?alClose():alOpen();
  document.addEventListener('pointerdown',e=>{if(!e.target.closest('#alImport,#alImportBtn,#alFromCanvas'))$('#alImport').hidden=true;});
}
