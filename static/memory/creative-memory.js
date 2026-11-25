"use strict";
// The library and both prompt composers share the same memory records.
const CM={loaded:0,board:null,items:[],epoch:0,popup:null,target:null,start:0,index:0,matches:[],timer:null,editor:null};
let cmFolderCache = null;
let cmFolderSelection = null;
async function cmList(force=false) {
 const bid=boardId;
 if(!force&&CM.board===bid&&Date.now()-CM.loaded<15000)return CM.items;
 const epoch=++CM.epoch, url='/api/memory?board='+encodeURIComponent(bid);
 const [current, available]=await Promise.all([boardRequest(url+'&scope=current'),boardRequest(url)]);
 if(bid!==boardId||epoch!==CM.epoch)return [];
 const items=new Map([...available,...current].map(asset=>[asset.id,asset]));
 CM.board=bid;
 CM.loaded=Date.now();
 CM.items=[...items.values()];
 return CM.items;
}
function cmInvalidate(){CM.board=null;CM.epoch++;libCache=null;cmFolderCache=null;}
function cmKind(a){return OneShotI18n.t(KIND_CN[a.kind]||'资料');}
const CM_DOCUMENT_EXT = /\.(txt|md|markdown|csv|json|docx|pdf)$/i;
function cmMediaType(ref, media) {
  if(media?.type==="audio" || /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i.test(ref))return "audio";
  if(media?.type==="video" || /\.(mp4|mov|webm|m4v|mkv)$/i.test(ref))return "video";
  if(/\.(png|jpe?g|webp)$/i.test(ref))return "image";
  return "";
}
function cmScopeLabel(a){return a.team ? '团队 · '+(canvasTeams.find(t=>t.id===a.team)?.name || '团队素材') :
  a.project?'项目素材':a.board?'画布素材':a.shared?'共享素材':'个人素材库';}
function cmNewScope(){
  const project=currentProject()?.id||'';
  const team=B?.team||'';
  return {board:project||team?'':boardId,project,team};
}
function cmToken(asset) {
 const name = asset.name.toLocaleLowerCase();
 const ambiguous = asset.reference_ambiguous ?? CM.items.some(other=>other.id!==asset.id &&
  [other.name,...(other.aliases||[])].some(label=>label.toLocaleLowerCase()===name));
 return ambiguous ? cmLabelledToken(asset) : "@"+asset.name;
}
function cmReferenceSearch(q, view) {
 const params = new URLSearchParams({board:boardId,q});
 if(view!==undefined)params.set("view",view);
 return boardRequest('/api/memory/mentions?'+params);
}
async function cmFolders() {
 const bid=boardId;
 if(cmFolderCache?.bid===bid && cmFolderCache.until>Date.now())return cmFolderCache.items;
 const result=await boardRequest('/api/asset-folders/references?board='+encodeURIComponent(bid));
 const items=Array.isArray(result)?result:[];
 if(boardId===bid)cmFolderCache={bid,until:Date.now()+15000,items};
 return items;
}

function cmLabelledToken(asset, view = "") {
 const safe=asset.name.replace(/[{}@\r\n]/g,char=>({'{':'｛','}':'｝','@':'＠','\r':' ','\n':' '})[char]).trim();
 const label=Array.from(safe).slice(0,60).join('')||'素材';
 return `@{${asset.id}${view ? "#"+view : ""}|${label}}`;
}
function cmReadableReferences(text) {
 return String(text||'').replace(/@\{[A-Za-z0-9_-]{1,80}(?:#(main|face|side|back|detail))?\|([^{}\r\n@]{1,60})\}/g,
  (_match,view,label)=>'@'+label.replace(/[\\`*_\[\]<>]/g,'\\$&')+(view?' · '+CHARACTER_VIEWS[view][0]:''));
}

function cmFolderClose() {
 const dialog=$('#cmFolderPicker'), previous=cmFolderSelection;
 cmFolderSelection=null;
 if(dialog.open)dialog.close?.();
 dialog.removeAttribute('open');
 if(previous?.ta.isConnected && boardId===previous.bid)previous.ta.focus();
}

async function cmFolderOpen(ta,folder,start,end) {
 cmClose();
 const dialog=$('#cmFolderPicker'), status=$('[data-cf-status]',dialog), apply=$('[data-cf-apply]',dialog);
 const selection=cmFolderSelection={ta,bid:boardId,text:ta.value,start,end,items:[],chosen:new Set()};
 $('[data-cf-title]',dialog).textContent=folder.name;
 $('[data-cf-scope]',dialog).textContent=cmScopeLabel(folder);
 $('[data-cf-query]',dialog).value='';
 $('[data-cf-items]',dialog).replaceChildren();
 apply.disabled=true;
 status.textContent=OneShotI18n.t('正在读取文件夹…');
 if(dialog.showModal)dialog.showModal();else dialog.setAttribute('open','');
 try{
  const response=await boardRequest('/api/asset-folders/references?'+new URLSearchParams({board:selection.bid,folder:folder.id}));
  if(selection!==cmFolderSelection)return;
  if(selection.bid!==boardId){cmFolderClose();return;}
  selection.items=response.assets;
  if(selection.items.length<=8)selection.chosen=new Set(selection.items.map(item=>item.id));
  cmFolderDraw();
 }catch(error){if(selection===cmFolderSelection)status.textContent=error.message;}
}

function cmFolderDraw() {
 const S=cmFolderSelection;
 if(!S)return;
 const dialog=$('#cmFolderPicker'), list=$('[data-cf-items]',dialog), status=$('[data-cf-status]',dialog);
 const query=$('[data-cf-query]',dialog).value.trim().toLocaleLowerCase();
 const update=()=>{
  status.textContent=S.items.length ? `已选 ${S.chosen.size} 项 · 一次最多 8 项` : '此文件夹没有当前画布可引用的素材';
  $('[data-cf-apply]',dialog).disabled=!S.chosen.size;
  $$('.cm-folder-items input',dialog).forEach(input=>input.disabled=!input.checked&&S.chosen.size>=8);
 };
 list.replaceChildren();
 for(const item of S.items.filter(asset=>[asset.name,cmKind(asset)].some(value=>value.toLocaleLowerCase().includes(query)))){
  const label=document.createElement('label'), check=document.createElement('input');
  check.type='checkbox';check.checked=S.chosen.has(item.id);
  check.onchange=()=>{if(check.checked)S.chosen.add(item.id);else S.chosen.delete(item.id);update();};
  label.append(check);
  if(item.ref && cmMediaType(item.ref)==='image'){
   const img=document.createElement('img');img.src='/media?ref='+encodeURIComponent(item.ref);img.loading='lazy';img.alt='';label.append(img);
  }
  const name=document.createElement('span');name.textContent=item.name;
  const kind=document.createElement('small');kind.textContent=cmKind(item);
  label.append(name,kind);list.append(label);
 }
 if(!list.childElementCount&&S.items.length){const empty=document.createElement('p');empty.textContent=OneShotI18n.t('没有匹配的素材');list.append(empty);}
 update();
}

function cmFolderApply() {
 const S=cmFolderSelection;
 if(!S?.chosen.size)return;
 const status=$('#cmFolderPicker [data-cf-status]');
 if(S.bid!==boardId||!S.ta.isConnected||S.ta.value!==S.text){status.textContent='输入内容已变化，请重新引用文件夹';return;}
 const inserted=S.items.filter(item=>S.chosen.has(item.id)).map(item=>cmLabelledToken(item)).join(' ')+' ';
 if(S.ta.maxLength>=0&&S.text.length-(S.end-S.start)+inserted.length>S.ta.maxLength){status.textContent='插入后超出输入长度，请减少引用';return;}
 S.ta.setRangeText(inserted,S.start,S.end,'end');
 cmFolderClose();
 S.ta.dispatchEvent(new Event('input',{bubbles:true}));
}

function cmInsert(ta,a,start=ta.selectionStart,end=ta.selectionStart){
 if(a.assetFolder)return cmFolderOpen(ta,a,start,end);
 let token;
 if(a.canvasNode){
  const n=node(a.id);
  if(ta.id==="acInput"){
   if(!n || !acAttachNodeReference(n,a.ref??null)){cmClose();return;}
   const name=n.name.replaceAll("@","＠").replace(/\s+/g," ");
   const duplicate=B.nodes.some(other=>other!==n&&other.name===n.name);
   token="「"+name+"」"+(duplicate?"（"+n.id+"）":"")+(a.explicitVersion?" · 版本 "+a.version:"");
  }else{
   token=attachPromptMedia(ta,n,a.ref);
   if(!token){cmClose();return;}
  }
 }else token=a.characterView?cmLabelledToken(a,a.characterView):cmToken(a);
 ta.setRangeText(token+' ',start,end,'end');ta.dispatchEvent(new Event('input',{bubbles:true}));ta.focus();cmClose();
 if(a.canvasNode&&ta.id!=="acInput")ta._before=snap();
}
function cmClose(){if(CM.popup){CM.popup.hidden=true;if(CM.popup.parentElement!==document.body)document.body.append(CM.popup);}CM.target?.setAttribute('aria-expanded','false');CM.target?.removeAttribute('aria-activedescendant');CM.target=null;}
function cmCurrentQuery() {
 const ta=CM.target;
 return ta && CM.part===ta.value.slice(0,ta.selectionStart);
}
function cmEnsure(){if(CM.popup)return;const box=document.createElement('div');box.id='memoryMention';box.className='cm-mention';box.role='listbox';box.hidden=true;box.setAttribute('aria-label','素材引用补全');document.body.append(box);CM.popup=box;box.addEventListener('pointerdown',e=>e.preventDefault());box.addEventListener('click',e=>{const b=e.target.closest('[data-option]');if(b&&cmCurrentQuery()){const a=CM.matches[Number(b.dataset.option)];if(a)cmInsert(CM.target,a,CM.start,CM.target.selectionStart);}});}
function cmDraw(){
 const box=CM.popup;box.replaceChildren();
 if(!CM.matches.length){const empty=document.createElement('div');empty.className='cm-empty';empty.textContent='没有匹配素材，可在素材库新建记忆';box.append(empty);return;}
 CM.matches.forEach((a,i)=>{
  const b=document.createElement('button');b.type='button';b.id='cm-option-'+i;b.role='option';b.dataset.option=i;
  b.dataset[a.assetFolder?'assetFolder':a.canvasNode?'canvasNode':'memory']=a.id;
  if(a.characterView)b.dataset.characterView=a.characterView;
  b.setAttribute('aria-selected',String(i===CM.index));
  if(a.assetFolder)b.insertAdjacentHTML('beforeend',ico('assets'));
  else if(a.ref&&(!a.canvasNode||a.type==="image")){const im=document.createElement('img');im.src='/media?ref='+encodeURIComponent(a.ref);im.alt='';b.append(im);}
  const info=document.createElement('span'),name=document.createElement('strong'),sub=document.createElement('small');
  name.textContent=a.name;
  sub.textContent=a.assetFolder ? `文件夹 · ${cmScopeLabel(a)} · ${a.count} 项` : a.canvasNode
   ?'画布 · '+(TYPE_CN[a.type]||'节点')+(a.version?' · 版本 '+a.version:'')+(a.duplicate?' · '+a.id:'')
   :cmKind(a)+' · '+cmScopeLabel(a)+(a.characterView?' · '+CHARACTER_VIEWS[a.characterView][0]:
     (a.generation_media || a.generation_images)?.length?' · '+(a.generation_media || a.generation_images).length+' 项生成参考':a.desc?' · '+a.desc.slice(0,55):'');
  info.append(name,sub);b.append(info);box.append(b);
 });
 CM.target?.setAttribute('aria-activedescendant','cm-option-'+CM.index);
 box.children[CM.index]?.scrollIntoView?.({block:'nearest'});
}
function cmCanvasMatches(ta,query,versionQuery,bid){
 const chat=ta.id==="acInput",target=chat?null:canvasPromptNode(ta);
 if(chat&&(AC.board!==bid||!AC.session))return [];
 const matching=B.nodes.filter(n=>n.name.toLocaleLowerCase().includes(query)||n.id.toLocaleLowerCase().includes(query));
 const results=[];
 for(const n of matching){
  const indexes=versionQuery===undefined?[n.cur]:versionQuery?[Number(versionQuery)-1]:
    n.versions.map((_,i)=>n.versions.length-i-1);
  for(const i of indexes){
   const ref=n.versions[i]?.ref;
   if((versionQuery!==undefined&&!ref) || (!chat&&!canPromptMedia(n,target,ref)))continue;
   results.push({id:n.id,name:n.name,type:n.type,canvasNode:true,ref,version:i+1,
    explicitVersion:versionQuery!==undefined,duplicate:matching.some(other=>other!==n&&other.name===n.name)});
   if(results.length===20)return results;
  }
 }
 return results;
}
async function cmSuggest(ta){
 const pos=ta.selectionStart,part=ta.value.slice(0,pos),match=part.match(/[@＠]([^@＠\s，。！？、；：,.!?;:()（）\[\]【】]{0,80})$/);if(!match){cmClose();return;}
 const start=pos-match[0].length;if(start&&/[A-Za-z0-9_.]/.test(part[start-1])){cmClose();return;}cmEnsure();CM.target=ta;CM.start=start;const query=match[1].toLocaleLowerCase(),bid=boardId;
 const versionSearch=query.match(/^(.+)[#＃](\d*)$/);
 const viewSearch=query.match(/^(.+)[#＃]([^#＃]*)$/);
 let memoryError;
 const [items, folders]=await Promise.all([
  cmReferenceSearch(viewSearch?.[1]??query,viewSearch?.[2]).catch(error=>{memoryError=error;return [];}),
  cmFolders().catch(()=>[]),
 ]);
 if(boardId!==bid||CM.target!==ta||document.activeElement!==ta||ta.selectionStart!==pos||ta.value.slice(0,pos)!==part)return;
 const nodes=cmCanvasMatches(ta,versionSearch?.[1]??query,versionSearch?.[2],bid);
 const targetType=canvasPromptNode(ta)?.type;
 const views = viewSearch && (ta.id==="acInput" || targetType==="image" || targetType==="video")
  ? items.flatMap(asset=>Object.entries(CHARACTER_VIEWS)
     .filter(([slot,[label]])=>asset.character_views?.[slot] && (slot.includes(viewSearch[2])||label.includes(viewSearch[2])))
     .map(([slot])=>({...asset,characterView:slot,ref:asset.character_views[slot]}))) : [];
 const matchingFolders=folders.filter(folder=>folder.name.toLocaleLowerCase().includes(query)).slice(0,6).map(folder=>({...folder,assetFolder:true}));
 const slots=20-matchingFolders.length;
 const visibleMemory=viewSearch?[]:items.slice(0,nodes.length?Math.max(8,slots-nodes.length):slots);
 CM.matches=(viewSearch?[...views,...nodes,...matchingFolders,...visibleMemory]:
  [...matchingFolders,...visibleMemory,...nodes]).slice(0,20);
 CM.part=part;
 CM.index=0;cmDraw();
 if(!CM.matches.length&&memoryError)CM.popup.firstChild.textContent=memoryError.message;
 if(!CM.matches.length&&viewSearch&&!memoryError)CM.popup.firstChild.textContent='没有可引用的角色视角或画布版本';
 const r=ta.getBoundingClientRect(),width=Math.min(360,innerWidth-24);
 const host=ta.closest('dialog[open]')||document.body;
 if(CM.popup.parentElement!==host)host.append(CM.popup);
 Object.assign(CM.popup.style,{width:width+'px',left:Math.max(12,Math.min(r.left,innerWidth-width-12))+'px',top:'',bottom:''});
 if(innerHeight-r.bottom>240)CM.popup.style.top=Math.min(innerHeight-240,r.bottom+5)+'px';else CM.popup.style.bottom=Math.max(12,innerHeight-r.top+5)+'px';
 CM.popup.hidden=false;ta.setAttribute('aria-controls','memoryMention');ta.setAttribute('aria-autocomplete','list');ta.setAttribute('aria-expanded','true');
}
function cmInit(){
 const folderPicker=$('#cmFolderPicker');
 $('[data-cf-close]',folderPicker).onclick=cmFolderClose;
 $('[data-cf-apply]',folderPicker).onclick=cmFolderApply;
 $('[data-cf-query]',folderPicker).oninput=cmFolderDraw;
 folderPicker.addEventListener('cancel',event=>{event.preventDefault();cmFolderClose();});
 folderPicker.addEventListener('keydown',event=>event.stopPropagation());
 const mentionInput=target=>target.matches('#prompt,#acInput,#pfields textarea[data-k]');
 document.addEventListener('input',e=>{if(!mentionInput(e.target))return;clearTimeout(CM.timer);CM.timer=setTimeout(()=>cmSuggest(e.target),60);});
 document.addEventListener('keydown',e=>{
  if(e.target!==CM.target||CM.popup?.hidden||e.isComposing||!['ArrowDown','ArrowUp','Enter','Tab','Escape'].includes(e.key))return;
  e.stopImmediatePropagation();
  e.preventDefault();
  if(e.key==='Escape'){cmClose();return;}
  if(!cmCurrentQuery())return;
  if(e.key==='Enter'||e.key==='Tab'){
   const asset=CM.matches[CM.index];
   if(asset)cmInsert(e.target,asset,CM.start,e.target.selectionStart);
  }else if(CM.matches.length){
   CM.index=(CM.index+(e.key==='ArrowDown'?1:-1)+CM.matches.length)%CM.matches.length;
   cmDraw();
  }
 },true);
 document.addEventListener('compositionend',e=>{if(mentionInput(e.target))cmSuggest(e.target);});
 document.addEventListener('pointerdown',e=>{if(!e.target.closest('#memoryMention')&&e.target!==CM.target)cmClose();});
 window.addEventListener('resize',cmClose);document.addEventListener('scroll',e=>{if(!e.target.closest?.('#memoryMention'))cmClose();},true);
 const search=document.querySelector('#memorySearch');search?.addEventListener('input',()=>{if(KIND_CN[afilter])renderLibrary(afilter);});document.querySelector('#memoryNew')?.addEventListener('click',()=>cmEdit(null,afilter in KIND_CN?afilter:'character'));
}
async function cmRenderLibrary(kind){
 const bid=boardId,g=$('#agrid');try{const list=(await cmList(true)).filter(a=>a.kind===kind&&[a.name,a.desc,...(a.aliases||[]),...(a.tags||[])].join(' ').toLocaleLowerCase().includes(($('#memorySearch')?.value||'').toLocaleLowerCase()));if(bid!==boardId||afilter!==kind)return;
 g.replaceChildren();if(!list.length){g.innerHTML='<div class="h" style="grid-column:1/-1">暂无匹配记忆。新建记忆可添加设定、上传素材，或采用画布上的图片和视频。</div>';return;}
 for(const a of list){const card=document.createElement('div');card.className='as lib';card.draggable=!!a.ref;card.dataset.id=a.id;card.innerHTML=(a.ref?`<img src="/media?ref=${encodeURIComponent(a.ref)}" loading="lazy" alt="">`:'<div class="cm-doc">'+ico('script')+'</div>')+OneShotI18n.html`<span class="ty">${esc(cmKind(a))}</span><button class="cm-detail" title="查看设定与参考版本" aria-label="查看${esc(a.name)}的记忆">${ico('more')}</button><div class="nm">${esc(a.name)}</div>`;card.ondragstart=e=>e.dataTransfer.setData('application/x-h3-lib',JSON.stringify(a));card.onclick=e=>{if(e.target.closest('.cm-detail')){cmEdit(a);return;}placeLibraryAsset(a,toW(innerWidth/2-150,innerHeight/2-180));};g.append(card);}
 }catch(e){g.textContent=e.message;}
}
