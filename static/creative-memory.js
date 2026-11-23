"use strict";
// The library and both prompt composers share the same memory records.
const CM={loaded:0,board:null,items:[],epoch:0,popup:null,target:null,start:0,index:0,matches:[],timer:null,editor:null};
let cmFolderCache = null;
let cmFolderSelection = null;
async function cmList(force=false){const bid=boardId;if(!force&&CM.board===bid&&Date.now()-CM.loaded<15000)return CM.items;const epoch=++CM.epoch;const r=await fetch('/api/memory?board='+encodeURIComponent(bid));if(!r.ok)throw new Error('读取创作记忆失败');const items=await r.json();if(bid!==boardId||epoch!==CM.epoch)return [];CM.board=bid;CM.loaded=Date.now();CM.items=items;return items;}
function cmInvalidate(){CM.board=null;CM.epoch++;libCache=null;cmFolderCache=null;}
function cmKind(a){return KIND_CN[a.kind]||'资料';}
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
function cmToken(a){const names=CM.items.filter(b=>[b.name,...(b.aliases||[])].some(n=>n.toLocaleLowerCase()===a.name.toLocaleLowerCase()));return names.length>1?'@{'+a.id+'}':'@'+a.name;}
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
 status.textContent='正在读取文件夹…';
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
 if(!list.childElementCount&&S.items.length){const empty=document.createElement('p');empty.textContent='没有匹配的素材';list.append(empty);}
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
function cmEnsure(){if(CM.popup)return;const box=document.createElement('div');box.id='memoryMention';box.className='cm-mention';box.role='listbox';box.hidden=true;box.setAttribute('aria-label','素材引用补全');document.body.append(box);CM.popup=box;box.addEventListener('pointerdown',e=>e.preventDefault());box.addEventListener('click',e=>{const b=e.target.closest('[data-option]');if(b&&CM.target){const a=CM.matches[Number(b.dataset.option)];if(a)cmInsert(CM.target,a,CM.start,CM.target.selectionStart);}});}
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
     a.generation_images?.length?' · '+a.generation_images.length+' 张生成参考图':a.desc?' · '+a.desc.slice(0,55):'');
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
async function cmSuggest(ta,force=false){
 const pos=ta.selectionStart,part=ta.value.slice(0,pos),match=part.match(/[@＠]([^@＠\s，。！？、；：,.!?;:()（）\[\]【】]{0,80})$/);if(!match){cmClose();return;}
 const start=pos-match[0].length;if(start&&/[A-Za-z0-9_.]/.test(part[start-1])){cmClose();return;}cmEnsure();CM.target=ta;CM.start=start;const query=match[1].toLocaleLowerCase(),bid=boardId;
 const versionSearch=query.match(/^(.+)[#＃](\d*)$/);
 const viewSearch=query.match(/^(.+)[#＃]([^#＃]*)$/);
 let memoryError;
 const [items, folders]=await Promise.all([cmList(force).catch(error=>{memoryError=error;return [];}),cmFolders().catch(()=>[])]);
 if(boardId!==bid||CM.target!==ta||document.activeElement!==ta||ta.selectionStart!==pos||ta.value.slice(0,pos)!==part)return;
 const nodes=cmCanvasMatches(ta,versionSearch?.[1]??query,versionSearch?.[2],bid);
 const memory=items.filter(a=>[a.name,...(a.aliases||[]),...(a.tags||[])].some(v=>v.toLocaleLowerCase().includes(query)));
 const targetType=canvasPromptNode(ta)?.type;
 const views = viewSearch && (ta.id==="acInput" || targetType==="image" || targetType==="video")
  ? items.filter(asset=>asset.kind==="character" && [asset.name,...(asset.aliases||[])]
    .some(name=>name.toLocaleLowerCase().includes(viewSearch[1])))
    .flatMap(asset=>Object.entries(CHARACTER_VIEWS)
     .filter(([slot,[label]])=>asset.character_views?.[slot] && (slot.includes(viewSearch[2])||label.includes(viewSearch[2])))
     .map(([slot])=>({...asset,characterView:slot,ref:asset.character_views[slot]}))) : [];
 const matchingFolders=folders.filter(folder=>folder.name.toLocaleLowerCase().includes(query)).slice(0,6).map(folder=>({...folder,assetFolder:true}));
 const slots=20-matchingFolders.length;
 const visibleMemory=memory.slice(0,nodes.length?Math.max(8,slots-nodes.length):slots);
 CM.matches=(viewSearch?[...views,...nodes,...matchingFolders,...visibleMemory]:
  [...matchingFolders,...visibleMemory,...nodes]).slice(0,20);
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
 document.addEventListener('keydown',e=>{if(e.target!==CM.target||CM.popup?.hidden||e.isComposing)return;if(['ArrowDown','ArrowUp','Enter','Tab','Escape'].includes(e.key)){e.stopImmediatePropagation();e.preventDefault();if(e.key==='Escape'){cmClose();return;}if(e.key==='Enter'||e.key==='Tab'){const a=CM.matches[CM.index];if(a)cmInsert(e.target,a,CM.start,e.target.selectionStart);return;}if(CM.matches.length){CM.index=(CM.index+(e.key==='ArrowDown'?1:-1)+CM.matches.length)%CM.matches.length;cmDraw();}}},true);
 document.addEventListener('compositionend',e=>{if(mentionInput(e.target))cmSuggest(e.target);});
 document.addEventListener('pointerdown',e=>{if(!e.target.closest('#memoryMention')&&e.target!==CM.target)cmClose();});
 window.addEventListener('resize',cmClose);document.addEventListener('scroll',e=>{if(!e.target.closest?.('#memoryMention'))cmClose();},true);
 const search=document.querySelector('#memorySearch');search?.addEventListener('input',()=>{if(KIND_CN[afilter])renderLibrary(afilter);});document.querySelector('#memoryNew')?.addEventListener('click',()=>cmEdit(null,afilter in KIND_CN?afilter:'character'));
}
async function cmRenderLibrary(kind){
 const bid=boardId,g=$('#agrid');try{const list=(await cmList(true)).filter(a=>a.kind===kind&&[a.name,a.desc,...(a.aliases||[]),...(a.tags||[])].join(' ').toLocaleLowerCase().includes(($('#memorySearch')?.value||'').toLocaleLowerCase()));if(bid!==boardId||afilter!==kind)return;
 g.replaceChildren();if(!list.length){g.innerHTML='<div class="h" style="grid-column:1/-1">暂无匹配记忆。新建记忆可添加设定、上传素材，或采用画布上的图片和视频。</div>';return;}
 for(const a of list){const card=document.createElement('div');card.className='as lib';card.draggable=!!a.ref;card.dataset.id=a.id;card.innerHTML=(a.ref?`<img src="/media?ref=${encodeURIComponent(a.ref)}" loading="lazy" alt="">`:'<div class="cm-doc">'+ico('script')+'</div>')+`<span class="ty">${esc(cmKind(a))}</span><button class="cm-detail" title="查看设定与参考版本" aria-label="查看${esc(a.name)}的记忆">${ico('more')}</button><div class="nm">${esc(a.name)}</div>`;card.ondragstart=e=>e.dataTransfer.setData('application/x-h3-lib',JSON.stringify(a));card.onclick=e=>{if(e.target.closest('.cm-detail')){cmEdit(a);return;}placeLibraryAsset(a,toW(innerWidth/2-150,innerHeight/2-180));};g.append(card);}
 }catch(e){g.textContent=e.message;}
}

async function cmEdit(a=null, kind='character', options={}) {
  if (CM.editor?.dataset.busy === 'true') { toast('正在保存或上传，请稍等'); return; }
  const host=options.host||null, readonly=!!options.readonly, initialBoard=boardId;
  const project = currentProject();
  const projectOptions = [project, a?.project && canvasProjects.find(p => p.id === a.project && p.id !== project?.id)].filter(Boolean);
  cmClose(); CM.editor?.remove();
  const panel=document.createElement('section'); panel.id='memoryEditor'; panel.className='cm-editor'; panel.role='dialog';
  panel.setAttribute('aria-modal','false'); panel.setAttribute('aria-label','资产详情');
  panel.innerHTML=`<header><strong>${a?'编辑资产':'新建资产'}</strong><button type="button" data-close aria-label="关闭资产详情">×</button></header><form><div class="cm-fields"><div class="cm-hero" hidden></div><label>名称<input name="name" required maxlength="80"></label><div class="cm-row"><label>分类<select name="kind">${Object.entries(KIND_CN).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label><label>保存到<select name="board">${projectOptions.map(p=>`<option value="project:${esc(p.id)}">项目 · ${esc(p.name)}</option>`).join("")}<option value="">个人资产库</option></select></label></div><label>别名<input name="aliases" placeholder="用逗号分隔，支持 @别名"></label><label>标签<input name="tags" placeholder="如：主角、森林、夜景"></label><label>设定 / 背景资料<textarea name="desc" rows="5" maxlength="6000" placeholder="人物外观、场景背景、故事设定等"></textarea></label><label>使用约束<textarea name="constraints" rows="2" maxlength="6000" placeholder="如：眼镜和服装保持一致"></textarea></label><label class="cm-check"><input name="shared" type="checkbox">共享给所有平台账号（个人素材库范围）</label><div class="cm-row"><label class="cm-upload">上传图片、视频或文档<input name="upload" type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm,.txt,.md,.markdown,.csv,.json,.docx,.pdf"></label><button type="button" data-current>采用当前选中素材</button></div><div class="cm-help">参考素材保留多个版本；点击图片可指定默认参考。生成历史不会自动替换默认图。</div><div class="cm-media"></div><details class="cm-history"><summary>生成历史</summary><div></div></details><div class="cm-error" role="status"></div></div><footer><button type="button" data-delete ${a?'':'hidden'}>删除资产</button><button type="button" data-canvas>放入画布</button><button type="submit">保存资产</button></footer></form>`;
  if(host)host.replaceChildren(panel); else document.body.append(panel); CM.editor=panel;
  const character = document.createElement("section");
  character.className = "cm-character";
  character.innerHTML = `<strong>标准角色图</strong><p>先生成并定稿主图，再补其他角度。</p><div class="cm-character-views"></div><details><summary>角色卡</summary><div class="cm-character-fields">${Object.entries(CHARACTER_FIELDS).map(([key,label]) => `<label>${label}<input name="character_${key}" maxlength="800"></label>`).join("")}</div></details>`;
  panel.querySelector(".cm-hero").after(character);
  const form=panel.querySelector('form'), field=name=>form.elements.namedItem(name);
  let data=a?acClone(a):{kind:options.kind||kind,...cmNewScope(),name:'',desc:'',constraints:'',aliases:[],tags:[],shared:false,media:[],default_ref:''};
  let pending=options.preset?.pending||null, selectedRef=data.default_ref||data.ref||'', busy=false;
  let generationImages=[...(data.generation_images||[])];
  const generationBox=document.createElement("details");
  generationBox.className="cm-generation-images";
  generationBox.innerHTML='<summary>生成参考图</summary><p class="cm-help">选中的图片会随 @资产 一起发送。留空时采用默认参考图。</p><ol></ol>';
  $(".cm-media",panel).after(generationBox);
 let documentData=options.preset?.document||data.document||null, documentDirty=!!options.preset?.document;
  const docBox=document.createElement("details");
  docBox.className="cm-document";docBox.hidden=true;
  docBox.innerHTML='<summary>文档正文</summary><pre></pre><button type="button">移除文档</button>';
  field('desc').closest("label").after(docBox);
  function paintDocument(){
    docBox.hidden=!documentData;
    if(!documentData)return;
    $("summary",docBox).textContent=documentData.name+(documentData.truncated?" · 已截取可导入部分":"");
    $("pre",docBox).textContent=documentData.text??documentData.excerpt??"";
  }
  $("button",docBox).hidden=readonly;
  $("button",docBox).onclick=()=>{if(!busy){documentData=null;documentDirty=true;paintDocument();}};
  paintDocument();
  if(options.preset)Object.assign(data,Object.fromEntries(Object.entries(options.preset).filter(([k])=>k!=='pending')));
  if(pending&&!selectedRef&&/\.(png|jpe?g|webp)$/i.test(pending.ref))selectedRef=pending.ref;
  let approvingView = null;
  const readCard = () => Object.fromEntries(Object.keys(CHARACTER_FIELDS).map(key => [key, field("character_" + key).value.trim()]));
  for (const key of Object.keys(CHARACTER_FIELDS)) field("character_" + key).value = data.character_card?.[key] || "";
  field("kind").addEventListener("change", paintCharacter);
  const watchedDrafts = new Set();
  function refreshCharacter() {
    if (panel.isConnected) paintCharacter();
    if (typeof AL !== "undefined" && AL.open && boardId === initialBoard) alRender();
  }
  function paintCharacter() {
    character.hidden = field("kind").value !== "character";
    if (character.hidden) return;
    const views = data.character_views || {};
    const rows = character.querySelector(".cm-character-views");
    rows.replaceChildren();
    for (const [slot, [label, filename]] of Object.entries(CHARACTER_VIEWS)) {
      const row = document.createElement("div");
      row.className = "cm-character-view";
      const heading = document.createElement("strong");
      heading.textContent = label + (views[slot] ? " · 已定稿" : "");
      row.append(heading);
      if (views[slot]) {
        const media = data.media.find(item => item.ref === views[slot]);
        const download = document.createElement("a");
        download.href = "/media?ref=" + encodeURIComponent(views[slot]);
        download.download = /\.jpe?g$/i.test(views[slot]) ? filename.replace(/\.png$/, ".jpg") : /\.webp$/i.test(views[slot]) ? filename.replace(/\.png$/, ".webp") : filename;
        download.textContent = "下载";
        const preview = characterPreview(views[slot], label + "已定稿");
        row.append(preview, download, action("放入画布", () => {
          placeCharacterReference(data, media.ref);
          alClose();
          panel.querySelector("[data-close]").click();
        }));
      }
      if (!readonly) {
        if (slot !== "main" && !views.main) {
          const hint = document.createElement("small");
          hint.className = "cm-character-hint";
          hint.textContent = "主图定稿后可生成";
          row.append(hint);
          rows.append(row);
          continue;
        }
        if (!data.id || (slot === "main" && !data.ref)) {
          const hint = document.createElement("small");
          hint.className = "cm-character-hint";
          hint.textContent = "请先保存一张角色图片";
          row.append(hint);
          rows.append(row);
          continue;
        }
        const key = characterDraftKey(data, slot, initialBoard);
        let draft = readCharacterDraft(key);
        if (!draft && data.character_drafts?.[slot]) {
          draft = data.character_drafts[slot];
          if (draft.ids?.length) writeCharacterDraft(key, draft);
        }
        const active = draft?.submitting || !!draft?.ids?.length;
        if (draft?.ids?.length && !watchedDrafts.has(key)) {
          watchedDrafts.add(key);
          pollCharacterDraft(key, panel, refreshCharacter).finally(() => watchedDrafts.delete(key));
        }
        const matchesSource = draft?.source === characterSource(data, slot);
        const legacy = !draft && !views[slot] && [...B.nodes].reverse().find(n => {
          const saved = n.data.character_draft;
          return n.type === "image" && saved?.asset === data.id && saved?.slot === slot &&
            (slot === "main" || saved.source === views.main) && curV(n)?.ref !== views[slot] && curV(n);
        });
        const candidateRef = !active && (matchesSource && draft?.ref || (legacy && curV(legacy).ref));
        const create = action(candidateRef || views[slot] ? "重新生成" : slot === "main" ? "生成主图" : "生成", () => {
          if (!busy) generateCharacterView(data, slot, readCard(), initialBoard, refreshCharacter);
        });
        if (slot === "main" && !views.main) create.classList.add("cm-character-primary");
        create.disabled = !!active;
        row.append(create);
        if (active || (matchesSource && draft?.error)) {
          const message = document.createElement("small");
          message.className = "cm-character-status";
          message.setAttribute("role", "status");
          message.textContent = draft.submitting ? "提交中…" : draft.progress || draft.error || "排队中…";
          row.append(message);
        }
        if (slot === "main" && !views.main && !active && !candidateRef) {
          row.append(action("用现有图片定稿", () => {
            if (busy) return;
            approvingView = {slot, version: {ref: data.ref}};
            form.requestSubmit();
          }));
        }
        if (candidateRef && candidateRef !== views[slot]) {
          const candidate = document.createElement("div");
          candidate.className = "cm-character-candidate";
          const tag = document.createElement("small");
          tag.className = "cm-character-status";
          tag.textContent = "待定稿";
          candidate.append(characterPreview(candidateRef, label + "草稿"), tag, action("定稿", () => {
            if (busy) return;
            approvingView = {slot, version: {ref:candidateRef}, nodeId: draft?.ref === candidateRef ? undefined : legacy?.id, draftKey:key};
            form.requestSubmit();
          }));
          row.append(candidate);
        }
      }
      rows.append(row);
    }
  }
  function characterPreview(ref, label) {
    const link = document.createElement("a");
    link.className = "cm-character-preview";
    link.href = "/media?ref=" + encodeURIComponent(ref);
    link.target = "_blank";
    link.rel = "noopener";
    link.title = "查看原图";
    const image = document.createElement("img");
    image.src = link.href;
    image.alt = label + "，点击查看原图";
    image.loading = "lazy";
    link.append(image);
    return link;
  }
  function action(label, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.onclick = handler;
    return button;
  }
  const status=msg=>panel.querySelector('.cm-error').textContent=msg;
  function setBusy(value) {busy=value;panel.dataset.busy=String(value);panel.querySelector('[type=submit]').disabled=value;field('upload').disabled=value||readonly;panel.querySelector('[data-current]').disabled=value;}
  function paintGenerationImages(media,focusRef) {
    const allowed=media.filter(item=>cmMediaType(item.ref,item)==="image");
    generationImages=generationImages.filter(ref=>allowed.some(item=>item.ref===ref));
    generationBox.hidden=!allowed.length;
    $("summary",generationBox).textContent="生成参考图"+(generationImages.length?" · "+generationImages.length+" 张":"");
    const list=$("ol",generationBox);
    list.replaceChildren();
    const ordered=[...generationImages,...allowed.map(item=>item.ref).filter(ref=>!generationImages.includes(ref))];
    for(const ref of ordered) {
      const item=document.createElement("li"), caption=document.createElement("label");
      const check=document.createElement("input"), index=generationImages.indexOf(ref);
      check.type="checkbox";check.checked=index>=0;check.disabled=readonly;
      check.dataset.generationImage=ref;
      const label=index>=0?"参考图 "+(index+1):"加入生成参考";
      const picture=document.createElement("img");
      picture.src="/media?ref="+encodeURIComponent(ref);picture.alt="";
      caption.append(check,picture,label);
      check.setAttribute("aria-label",label+" · 图片 "+(allowed.findIndex(entry=>entry.ref===ref)+1));
      check.onchange=()=>{
        if(busy||check.checked&&generationImages.length>=9){
          check.checked=index>=0;
          if(!busy)status("一次最多添加 9 张生成参考图");
          return;
        }
        if(check.checked) generationImages.push(ref); else generationImages.splice(index,1);
        paintGenerationImages(media,ref);
      };
      item.append(caption);
      if(index>=0&&!readonly) for(const [offset,title] of [[-1,"上移"],[1,"下移"]]){
        const next=index+offset;
        const button=action(title,()=>{
          if(busy) return;
          [generationImages[index],generationImages[next]]=[generationImages[next],generationImages[index]];
          paintGenerationImages(media,ref);
        });
        button.disabled=next<0||next>=generationImages.length;
        button.setAttribute("aria-label",title+"参考图 "+(index+1));
        item.append(button);
      }
      list.append(item);
      if(ref===focusRef) check.focus();
    }
  }
  function paint() {
    const grid=panel.querySelector('.cm-media');grid.replaceChildren();
    const media=[...(data.media||[]),...(pending&&!data.media?.some(m=>m.ref===pending.ref)?[pending]:[])];
    paintGenerationImages(media);
    const hero=panel.querySelector('.cm-hero'), lead=selectedRef||media[0]?.ref;
    hero.hidden=!host||!lead;hero.replaceChildren();
    if(host&&lead){
      const type=cmMediaType(lead,media.find(m=>m.ref===lead)), image=type==="image";
      const el=document.createElement(image?'img':type==="audio"?'audio':'video');
      el.src='/media?ref='+encodeURIComponent(lead);if(image)el.alt=data.name||'资产预览';else {el.controls=true;el.playsInline=true;el.preload='metadata';}
      hero.append(el);if(image){const link=document.createElement('a');link.href=el.src;link.target='_blank';link.rel='noopener';link.textContent='查看原图';hero.append(link);}
    }
    for(const m of media){
      const type=cmMediaType(m.ref,m), image=type==="image", b=document.createElement(image?'button':'div');if(image)b.type='button';
      b.className='cm-media-item'+(m.ref===selectedRef?' on':'');
      const url="/media?ref="+encodeURIComponent(m.ref);
      b.innerHTML=image?`<img src="${url}" alt="参考图">`:type==="audio"?`<audio src="${url}" preload="none" controls></audio>`:`<video src="${url}" preload="metadata" controls playsinline></video>`;
      const label=document.createElement('small');label.textContent=(m.ref===selectedRef?'默认参考 · ':'')+({upload:'用户上传',gen:'生成素材',generated:'生成素材',legacy:'原有素材'}[m.source]||'参考素材');b.append(label);
      if(image){b.setAttribute('aria-pressed',String(m.ref===selectedRef));b.onclick=()=>{if(!readonly&&!busy){selectedRef=m.ref;paint();}};}
      grid.append(b);
    }
  }
  for(const k of ['name','kind','desc','constraints'])field(k).value=data[k]||'';
  if(!currentProject() && !B?.team)field('board').add(new Option('当前画布 · '+(B?.name||'未命名画布'),initialBoard));
  if(data.board && ![...field('board').options].some(option=>option.value===data.board))
    field('board').add(new Option('原有画布范围',data.board));
  for(const team of canvasTeams)field('board').add(new Option('团队 · '+team.name,'team:'+team.id));
  if(data.team && !canvasTeams.some(t=>t.id===data.team))field('board').add(new Option('原团队','team:'+data.team));
  field('board').value=data.team?'team:'+data.team:data.project?'project:'+data.project:data.board||'';
  const syncSharing=()=>{field('shared').disabled=readonly||!!field('board').value;};
  field('board').onchange=syncSharing;
  field('aliases').value=(data.aliases||[]).join('，');field('tags').value=(data.tags||[]).join('，');field('shared').checked=!!data.shared;syncSharing();paint();paintCharacter();
  panel.querySelector('[data-close]').onclick=()=>{
    if(busy)return status('正在保存或上传，请稍等');panel.remove();if(CM.editor===panel)CM.editor=null;
    if(host&&typeof alEmptyDetail==='function'){AL.selected=null;alEmptyDetail();alRender();}
  };
  panel.addEventListener('pointerdown',e=>e.stopPropagation());panel.addEventListener('wheel',e=>e.stopPropagation(),{passive:true});
  panel.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Escape')panel.querySelector('[data-close]').click();});
  panel.querySelector('[data-current]').onclick=async()=>{
    if(busy||readonly)return;
    try{const n=[...sel].map(node).find(n=>['image','video'].includes(n?.type)&&curV(n));if(!n)throw new Error('先在画布选中已完成的图片或视频');await flushSave();if(boardId!==initialBoard)return;const v=curV(n);pending={...v,source_board:initialBoard,node_id:n.id,source:v.source||'generated'};if(!selectedRef&&n.type==='image')selectedRef=v.ref;paint();status('已选用「'+n.name+'」，保存后生效');}catch(e){status(e.message);}
  };
  async function receiveFile(file) {
    if(!file||busy||readonly)return;setBusy(true);status('正在上传…');
    try{
      const body=new FormData();body.append('file',file);
      const isDocument=CM_DOCUMENT_EXT.test(file.name);
      const r=await fetch(isDocument?'/api/document-import':'/api/upload',{method:'POST',body}),v=await r.json();
      if(!r.ok)throw new Error(v.error||'上传失败');
      if(isDocument){
        documentData=v;documentDirty=true;
        if(!a)field('kind').value='document';
        if(!field('name').value.trim())field('name').value=file.name.replace(CM_DOCUMENT_EXT,'');
        paintDocument();paintCharacter();docBox.open=true;status('已提取正文，保存后可搜索和引用');
      }else{
        pending={...v,source:'upload'};if(!selectedRef&&file.type.startsWith('image/'))selectedRef=v.ref;
        paint();status('已上传，保存后加入资产');
      }
    }catch(e){status(e.message);}finally{setBusy(false);}
  }
  field('upload').onchange=()=>receiveFile(field('upload').files[0]);
  form.onsubmit=async e=>{
    e.preventDefault();if(busy||readonly)return;const approval=approvingView;approvingView=null;setBusy(true);status('正在保存…');
    try{
      const target=field('board').value;
      const project=target.startsWith('project:')?target.slice(8):'';
      const team=target.startsWith('team:')?target.slice(5):'';
      const p={id:data.id,mtime:data.mtime,name:field('name').value,kind:field('kind').value,board:project||team?'':target,project,team,desc:field('desc').value,constraints:field('constraints').value,aliases:field('aliases').value.split(/[,，\n]/).map(x=>x.trim()).filter(Boolean),tags:field('tags').value.split(/[,，\n]/).map(x=>x.trim()).filter(Boolean),shared:!target&&field('shared').checked,default_ref:selectedRef};
      if(documentDirty)p.document=documentData;
      p.generation_images=generationImages;
      if(pending)Object.assign(p,{ref:pending.ref,source_board:pending.source_board||'',node_id:pending.node_id});
      if(p.kind === "character") {
        p.character_card = readCard();
        if(approval) {
          await flushSave();
          if (boardId !== initialBoard) return;
          Object.assign(p, {ref:approval.version.ref, source_board:initialBoard, node_id:approval.nodeId, character_view:approval.slot});
          if(pending && pending.ref!==p.ref && !data.media.some(item=>item.ref===pending.ref))
            p.generation_images=p.generation_images.filter(ref=>ref!==pending.ref);
        }
      }
      data=await api('/api/memory',p);if(!approval||pending?.ref===p.ref)pending=null;
      documentDirty=false;documentData=data.document||null;paintDocument();
      if (approval?.draftKey && readCharacterDraft(approval.draftKey)?.ref === p.ref) writeCharacterDraft(approval.draftKey, null);
      generationImages=[...new Set([...(data.generation_images||[]),
        ...(pending && generationImages.includes(pending.ref) ? [pending.ref] : [])])];
      selectedRef=data.default_ref||data.ref||"";cmInvalidate();paint();paintCharacter();status('已保存。可在提示词或对话中输入 @'+data.name+' 使用');
      panel.querySelector('header strong').textContent='编辑资产';panel.querySelector('[data-delete]').hidden=false;
      if(typeof alChanged==='function')alChanged(data);if(KIND_CN[afilter])await cmRenderLibrary(afilter);
    }catch(e){status(e.message);}finally{setBusy(false);}
  };
  panel.querySelector('[data-delete]').onclick=async()=>{
    if(busy||readonly)return;const b=panel.querySelector('[data-delete]');
    if(!b.dataset.armed){b.dataset.armed='1';b.textContent='再次点击删除';setTimeout(()=>{delete b.dataset.armed;b.textContent='删除资产';},3000);return;}
    setBusy(true);
    try{const r=await fetch('/api/memory/'+encodeURIComponent(data.id),{method:'DELETE'});if(!r.ok)throw new Error((await r.json()).error||'删除失败');unlinkDeletedAsset(data.id);cmInvalidate();panel.remove();if(CM.editor===panel)CM.editor=null;if(typeof alChanged==='function')alChanged(data,true);await loadAssets();}catch(e){status(e.message);}finally{setBusy(false);}
  };
  panel.querySelector('[data-canvas]').onclick=()=>{
    if(!data.id)return status('请先保存资产');
    placeLibraryAsset(data,toW(innerWidth/2-150,innerHeight/2-180),()=>{if(host&&typeof alClose==='function')alClose();},status);
  };
  if(readonly){for(const el of panel.querySelectorAll('input,textarea,select'))el.disabled=true;panel.querySelector('[type=submit]').hidden=true;panel.querySelector('[data-delete]').hidden=true;panel.querySelector('[data-current]').hidden=true;status('共享资产可查看和引用，修改请由资产所有者操作');}else field('name').focus();
  if(a){
    const history=panel.querySelector('.cm-history>div');history.textContent='正在读取生成历史…';
    try{
      const r=await fetch('/api/memory/'+encodeURIComponent(a.id)+'?board='+encodeURIComponent(initialBoard));if(!r.ok)throw new Error('读取生成历史失败');const detail=await r.json();if(!panel.isConnected)return;history.replaceChildren();
      if(!documentDirty && typeof detail.document?.text === "string"){data.document=documentData=detail.document;paintDocument();}
      data.character_drafts = detail.character_drafts;
      paintCharacter();
      for(const v of detail.history||[]){
        const tile=document.createElement('div');tile.className='cm-media-item';
        tile.innerHTML=/\.(png|jpe?g|webp)$/i.test(v.ref)?`<img src="/media?ref=${encodeURIComponent(v.ref)}" alt="生成历史">`:`<video src="/media?ref=${encodeURIComponent(v.ref)}" preload="metadata" controls playsinline></video>`;
        if(!readonly){const button=document.createElement('button');button.type='button';button.textContent='加入参考素材';button.onclick=()=>{if(busy)return;pending={ref:v.ref,source:'generated',source_board:v.board};paint();status('已选择生成历史，保存后加入参考；默认图保持不变');};tile.append(button);}history.append(tile);
      }
      if(!history.children.length)history.textContent='还没有采用此资产的生成记录';
    }catch(e){history.textContent=e.message;}
  }
  if(options.file)await receiveFile(options.file);
  return panel;
}
