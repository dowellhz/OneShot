"use strict";
// The library and both prompt composers share the same memory records.
const CM={loaded:0,board:null,items:[],epoch:0,popup:null,target:null,start:0,index:0,matches:[],timer:null,editor:null};
async function cmList(force=false){const bid=boardId;if(!force&&CM.board===bid&&Date.now()-CM.loaded<15000)return CM.items;const epoch=++CM.epoch;const r=await fetch('/api/memory?board='+encodeURIComponent(bid));if(!r.ok)throw new Error('读取创作记忆失败');const items=await r.json();if(bid!==boardId||epoch!==CM.epoch)return [];CM.board=bid;CM.loaded=Date.now();CM.items=items;return items;}
function cmInvalidate(){CM.board=null;libCache=null;}
function cmKind(a){return KIND_CN[a.kind]||'资料';}
function cmToken(a){const names=CM.items.filter(b=>[b.name,...(b.aliases||[])].some(n=>n.toLocaleLowerCase()===a.name.toLocaleLowerCase()));return names.length>1?'@{'+a.id+'}':'@'+a.name;}
function cmInsert(ta,a,start=ta.selectionStart,end=ta.selectionStart){const token=cmToken(a);ta.setRangeText(token+' ',start,end,'end');ta.dispatchEvent(new Event('input',{bubbles:true}));ta.focus();cmClose();}
function cmClose(){if(CM.popup)CM.popup.hidden=true;CM.target?.setAttribute('aria-expanded','false');CM.target?.removeAttribute('aria-activedescendant');CM.target=null;}
function cmEnsure(){if(CM.popup)return;const box=document.createElement('div');box.id='memoryMention';box.className='cm-mention';box.role='listbox';box.hidden=true;box.setAttribute('aria-label','创作记忆补全');document.body.append(box);CM.popup=box;box.addEventListener('pointerdown',e=>e.preventDefault());box.addEventListener('click',e=>{const b=e.target.closest('[data-memory]');if(b&&CM.target){const a=CM.matches.find(a=>a.id===b.dataset.memory);if(a)cmInsert(CM.target,a,CM.start,CM.target.selectionStart);}});}
function cmDraw(){const box=CM.popup;box.replaceChildren();if(!CM.matches.length){const empty=document.createElement('div');empty.className='cm-empty';empty.textContent='没有匹配素材，可在素材库新建记忆';box.append(empty);return;}CM.matches.forEach((a,i)=>{const b=document.createElement('button');b.type='button';b.id='cm-option-'+i;b.role='option';b.dataset.memory=a.id;b.setAttribute('aria-selected',String(i===CM.index));if(a.ref){const im=document.createElement('img');im.src='/media?ref='+encodeURIComponent(a.ref);im.alt='';b.append(im);}const info=document.createElement('span'),name=document.createElement('strong'),sub=document.createElement('small');name.textContent=a.name;sub.textContent=cmKind(a)+' · '+(a.board?'当前项目':'素材库')+(a.desc?' · '+a.desc.slice(0,55):'');info.append(name,sub);b.append(info);box.append(b);});CM.target?.setAttribute('aria-activedescendant','cm-option-'+CM.index);box.children[CM.index]?.scrollIntoView?.({block:'nearest'});}
async function cmSuggest(ta,force=false){
 const pos=ta.selectionStart,part=ta.value.slice(0,pos),match=part.match(/@([^@\s，。！？、；：,.!?;:()（）\[\]【】]{0,80})$/);if(!match){cmClose();return;}
 const start=pos-match[0].length;if(start&&/[A-Za-z0-9_.]/.test(part[start-1])){cmClose();return;}cmEnsure();CM.target=ta;CM.start=start;const query=match[1].toLocaleLowerCase(),bid=boardId;
 try{const items=await cmList(force);if(boardId!==bid||document.activeElement!==ta||ta.selectionStart!==pos||ta.value.slice(0,pos)!==part)return;CM.target=ta;CM.start=start;CM.matches=items.filter(a=>[a.name,...(a.aliases||[]),...(a.tags||[])].some(v=>v.toLocaleLowerCase().includes(query))).slice(0,20);CM.index=0;cmDraw();const r=ta.getBoundingClientRect(),width=Math.min(360,innerWidth-24);Object.assign(CM.popup.style,{width:width+'px',left:Math.max(12,Math.min(r.left,innerWidth-width-12))+'px',top:'',bottom:''});if(innerHeight-r.bottom>240)CM.popup.style.top=Math.min(innerHeight-240,r.bottom+5)+'px';else CM.popup.style.bottom=Math.max(12,innerHeight-r.top+5)+'px';CM.popup.hidden=false;ta.setAttribute('aria-controls','memoryMention');ta.setAttribute('aria-autocomplete','list');ta.setAttribute('aria-expanded','true');}
 catch(e){if(CM.target===ta){CM.matches=[];cmDraw();CM.popup.firstChild.textContent=e.message;CM.popup.hidden=false;}}
}
function cmInit(){
 document.addEventListener('input',e=>{if(!e.target.matches('#prompt,#acInput'))return;clearTimeout(CM.timer);CM.timer=setTimeout(()=>cmSuggest(e.target),60);});
 document.addEventListener('keydown',e=>{if(e.target!==CM.target||CM.popup?.hidden||e.isComposing)return;if(['ArrowDown','ArrowUp','Enter','Tab','Escape'].includes(e.key)){e.stopImmediatePropagation();e.preventDefault();if(e.key==='Escape'){cmClose();return;}if(e.key==='Enter'||e.key==='Tab'){const a=CM.matches[CM.index];if(a)cmInsert(e.target,a,CM.start,e.target.selectionStart);return;}if(CM.matches.length){CM.index=(CM.index+(e.key==='ArrowDown'?1:-1)+CM.matches.length)%CM.matches.length;cmDraw();}}},true);
 document.addEventListener('compositionend',e=>{if(e.target.matches('#prompt,#acInput'))cmSuggest(e.target);});
 document.addEventListener('pointerdown',e=>{if(!e.target.closest('#memoryMention')&&e.target!==CM.target)cmClose();});
 window.addEventListener('resize',cmClose);document.addEventListener('scroll',e=>{if(!e.target.closest?.('#memoryMention'))cmClose();},true);
 const search=document.querySelector('#memorySearch');search?.addEventListener('input',()=>{if(KIND_CN[afilter])renderLibrary(afilter);});document.querySelector('#memoryNew')?.addEventListener('click',()=>cmEdit(null,afilter in KIND_CN?afilter:'character'));
}
async function cmRenderLibrary(kind){
 const bid=boardId,g=$('#agrid');try{const list=(await cmList(true)).filter(a=>a.kind===kind&&[a.name,a.desc,...(a.aliases||[]),...(a.tags||[])].join(' ').toLocaleLowerCase().includes(($('#memorySearch')?.value||'').toLocaleLowerCase()));if(bid!==boardId||afilter!==kind)return;
 g.replaceChildren();if(!list.length){g.innerHTML='<div class="h" style="grid-column:1/-1">暂无匹配记忆。新建记忆可添加设定、上传素材，或采用画布上的图片和视频。</div>';return;}
 for(const a of list){const card=document.createElement('div');card.className='as lib';card.draggable=!!a.ref;card.dataset.id=a.id;card.innerHTML=(a.ref?`<img src="/media?ref=${encodeURIComponent(a.ref)}" loading="lazy" alt="">`:'<div class="cm-doc">'+ico('script')+'</div>')+`<span class="ty">${esc(cmKind(a))}</span><button class="cm-detail" title="查看设定与参考版本" aria-label="查看${esc(a.name)}的记忆">${ico('more')}</button><div class="nm">${esc(a.name)}</div>`;card.ondragstart=e=>e.dataTransfer.setData('application/x-h3-lib',JSON.stringify(a));card.onclick=e=>{if(e.target.closest('.cm-detail')){cmEdit(a);return;}placeLibAsset(a,toW(innerWidth/2-150,innerHeight/2-180));};g.append(card);}
 }catch(e){g.textContent=e.message;}
}

async function cmEdit(a=null, kind='character', options={}) {
  if (CM.editor?.dataset.busy === 'true') { toast('正在保存或上传，请稍等'); return; }
  const host=options.host||null, readonly=!!options.readonly, initialBoard=boardId;
  cmClose(); CM.editor?.remove();
  const panel=document.createElement('section'); panel.id='memoryEditor'; panel.className='cm-editor'; panel.role='dialog';
  panel.setAttribute('aria-modal','false'); panel.setAttribute('aria-label','资产详情');
  panel.innerHTML=`<header><strong>${a?'编辑资产':'新建资产'}</strong><button type="button" data-close aria-label="关闭资产详情">×</button></header><form><div class="cm-fields"><div class="cm-hero" hidden></div><label>名称<input name="name" required maxlength="80"></label><div class="cm-row"><label>分类<select name="kind">${Object.entries(KIND_CN).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label><label>范围<select name="board"><option value="${esc(initialBoard)}">当前项目</option><option value="">个人素材库</option></select></label></div><label>别名<input name="aliases" placeholder="用逗号分隔，支持 @别名"></label><label>标签<input name="tags" placeholder="如：主角、森林、夜景"></label><label>设定 / 背景资料<textarea name="desc" rows="5" maxlength="6000" placeholder="人物外观、场景背景、故事设定等"></textarea></label><label>使用约束<textarea name="constraints" rows="2" maxlength="6000" placeholder="如：眼镜和服装保持一致"></textarea></label><label class="cm-check"><input name="shared" type="checkbox">共享到素材库（个人素材库范围）</label><div class="cm-row"><label class="cm-upload">上传图片或视频<input name="upload" type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm"></label><button type="button" data-current>采用当前选中素材</button></div><div class="cm-help">参考素材保留多个版本；点击图片可指定默认参考。生成历史不会自动替换默认图。</div><div class="cm-media"></div><details class="cm-history"><summary>生成历史</summary><div></div></details><div class="cm-error" role="status"></div></div><footer><button type="button" data-delete ${a?'':'hidden'}>删除资产</button><button type="button" data-canvas>放入画布</button><button type="submit">保存资产</button></footer></form>`;
  if(host)host.replaceChildren(panel); else document.body.append(panel); CM.editor=panel;
  const character = document.createElement("section");
  character.className = "cm-character";
  character.innerHTML = `<strong>标准角色图</strong><p>先定稿主图，再补其他角度。核对脸型、服装、鞋和配饰的左右位置。</p><div class="cm-character-views"></div><details><summary>角色卡</summary><div class="cm-character-fields">${Object.entries(CHARACTER_FIELDS).map(([key,label]) => `<label>${label}<input name="character_${key}" maxlength="800"></label>`).join("")}</div></details>`;
  panel.querySelector(".cm-hero").after(character);
  const form=panel.querySelector('form'), field=name=>form.elements.namedItem(name);
  let data=a?acClone(a):{kind:options.kind||kind,board:initialBoard,name:'',desc:'',constraints:'',aliases:[],tags:[],shared:false,media:[],default_ref:''};
  let pending=options.preset?.pending||null, selectedRef=data.default_ref||data.ref||'', busy=false;
  if(options.preset)Object.assign(data,Object.fromEntries(Object.entries(options.preset).filter(([k])=>k!=='pending')));
  if(pending&&!selectedRef&&/\.(png|jpe?g|webp)$/i.test(pending.ref))selectedRef=pending.ref;
  let approvingView = null;
  const readCard = () => Object.fromEntries(Object.keys(CHARACTER_FIELDS).map(key => [key, field("character_" + key).value.trim()]));
  for (const key of Object.keys(CHARACTER_FIELDS)) field("character_" + key).value = data.character_card?.[key] || "";
  field("kind").addEventListener("change", paintCharacter);
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
        const preview = document.createElement("img");
        preview.src = download.href;
        preview.alt = label;
        preview.loading = "lazy";
        row.append(preview, download, action("放入画布", () => {
          placeCharacterReference(data, media.ref);
          alClose();
          panel.querySelector("[data-close]").click();
        }));
      }
      if (!readonly) {
        const ready = !!data.id && (slot === "main" ? !!data.ref : !!views.main);
        const create = action("生成草稿", () => {
          if (!busy) generateCharacterView(data, slot, readCard());
        });
        create.disabled = !ready;
        row.append(create);
        const select = document.createElement("select");
        select.setAttribute("aria-label", label + "候选图");
        select.append(new Option("选择候选图", ""));
        for (const n of B.nodes) {
          const draft = n.data.character_draft;
          if (n.type === "image" && draft && draft.asset === data.id && draft.slot === slot &&
              (slot === "main" || draft.source === views.main) && curV(n)) {
            select.append(new Option(n.name + " · 版本 " + (n.cur + 1), n.id));
          }
        }
        if (slot === "main" && data.ref && data.ref !== views.main) select.append(new Option("现有默认参考", "current"));
        if (select.options.length > 1) {
          const approve = action(slot === "main" ? "定为主图" : "定稿", () => {
            if (busy || !select.value) return;
            const n = select.value === "current" ? null : node(select.value);
            const version = n ? curV(n) : data.media.find(item => item.ref === data.ref);
            if (!version) return status("候选图片已不存在");
            approvingView = {slot, version, nodeId:n?.id};
            form.requestSubmit();
          });
          const candidate = document.createElement("a");
          candidate.target = "_blank";
          candidate.rel = "noopener";
          candidate.textContent = "查看候选原图";
          candidate.hidden = true;
          approve.disabled = true;
          select.onchange = () => {
            const selected = node(select.value);
            const ref = select.value === "current" ? data.ref : selected && curV(selected)?.ref;
            approve.disabled = candidate.hidden = !ref;
            if (ref) candidate.href = "/media?ref=" + encodeURIComponent(ref);
          };
          row.append(select, candidate, approve);
        }
      }
      rows.append(row);
    }
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
  function paint() {
    const grid=panel.querySelector('.cm-media');grid.replaceChildren();
    const media=[...(data.media||[]),...(pending&&!data.media?.some(m=>m.ref===pending.ref)?[pending]:[])];
    const hero=panel.querySelector('.cm-hero'), lead=selectedRef||media[0]?.ref;
    hero.hidden=!host||!lead;hero.replaceChildren();
    if(host&&lead){
      const image=/\.(png|jpe?g|webp)$/i.test(lead), el=document.createElement(image?'img':'video');
      el.src='/media?ref='+encodeURIComponent(lead);if(image)el.alt=data.name||'资产预览';else {el.controls=true;el.playsInline=true;el.preload='metadata';}
      hero.append(el);if(image){const link=document.createElement('a');link.href=el.src;link.target='_blank';link.rel='noopener';link.textContent='查看原图';hero.append(link);}
    }
    for(const m of media){
      const image=/\.(png|jpe?g|webp)$/i.test(m.ref), b=document.createElement(image?'button':'div');if(image)b.type='button';
      b.className='cm-media-item'+(m.ref===selectedRef?' on':'');
      b.innerHTML=image?`<img src="/media?ref=${encodeURIComponent(m.ref)}" alt="参考图">`:`<video src="/media?ref=${encodeURIComponent(m.ref)}" preload="metadata" controls playsinline></video>`;
      const label=document.createElement('small');label.textContent=(m.ref===selectedRef?'默认参考 · ':'')+({upload:'用户上传',gen:'生成素材',generated:'生成素材',legacy:'原有素材'}[m.source]||'参考素材');b.append(label);
      if(image){b.setAttribute('aria-pressed',String(m.ref===selectedRef));b.onclick=()=>{if(!readonly&&!busy){selectedRef=m.ref;paint();}};}
      grid.append(b);
    }
  }
  for(const k of ['name','kind','board','desc','constraints'])field(k).value=data[k]||'';
  field('aliases').value=(data.aliases||[]).join('，');field('tags').value=(data.tags||[]).join('，');field('shared').checked=!!data.shared;paint();paintCharacter();
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
    try{const body=new FormData();body.append('file',file);const r=await fetch('/api/upload',{method:'POST',body}),v=await r.json();if(!r.ok)throw new Error(v.error||'上传失败');pending={...v,source:'upload'};if(!selectedRef&&file.type.startsWith('image/'))selectedRef=v.ref;paint();status('已上传，保存后加入资产');}catch(e){status(e.message);}finally{setBusy(false);}
  }
  field('upload').onchange=()=>receiveFile(field('upload').files[0]);
  form.onsubmit=async e=>{
    e.preventDefault();if(busy||readonly)return;const approval=approvingView;approvingView=null;setBusy(true);status('正在保存…');
    try{
      const p={id:data.id,mtime:data.mtime,name:field('name').value,kind:field('kind').value,board:field('board').value,desc:field('desc').value,constraints:field('constraints').value,aliases:field('aliases').value.split(/[,，\n]/).map(x=>x.trim()).filter(Boolean),tags:field('tags').value.split(/[,，\n]/).map(x=>x.trim()).filter(Boolean),shared:field('shared').checked,default_ref:selectedRef};
      if(pending)Object.assign(p,{ref:pending.ref,source_board:pending.source_board||'',node_id:pending.node_id});
      if(p.kind === "character") {
        p.character_card = readCard();
        if(approval) {
          await flushSave();
          if (boardId !== initialBoard) return;
          Object.assign(p, {ref:approval.version.ref, source_board:initialBoard, node_id:approval.nodeId, character_view:approval.slot});
        }
      }
      data=await api('/api/memory',p);if(!approval||pending?.ref===p.ref)pending=null;
      selectedRef=data.default_ref||data.ref||"";cmInvalidate();paint();paintCharacter();status('已保存。可在提示词或对话中输入 @'+data.name+' 使用');
      panel.querySelector('header strong').textContent='编辑资产';panel.querySelector('[data-delete]').hidden=false;
      if(typeof alChanged==='function')alChanged(data);if(KIND_CN[afilter])await cmRenderLibrary(afilter);
    }catch(e){status(e.message);}finally{setBusy(false);}
  };
  panel.querySelector('[data-delete]').onclick=async()=>{
    if(busy||readonly)return;const b=panel.querySelector('[data-delete]');
    if(!b.dataset.armed){b.dataset.armed='1';b.textContent='再次点击删除';setTimeout(()=>{delete b.dataset.armed;b.textContent='删除资产';},3000);return;}
    setBusy(true);
    try{const r=await fetch('/api/memory/'+encodeURIComponent(data.id),{method:'DELETE'});if(!r.ok)throw new Error((await r.json()).error||'删除失败');cmInvalidate();panel.remove();if(CM.editor===panel)CM.editor=null;if(typeof alChanged==='function')alChanged(data,true);await loadAssets();}catch(e){status(e.message);}finally{setBusy(false);}
  };
  panel.querySelector('[data-canvas]').onclick=()=>{if(!data.id)return status('请先保存资产');placeLibAsset(data,toW(innerWidth/2-150,innerHeight/2-180));if(host&&typeof alClose==='function')alClose();};
  if(readonly){for(const el of panel.querySelectorAll('input,textarea,select'))el.disabled=true;panel.querySelector('[type=submit]').hidden=true;panel.querySelector('[data-delete]').hidden=true;panel.querySelector('[data-current]').hidden=true;status('共享资产可查看和引用，修改请由资产所有者操作');}else field('name').focus();
  if(a){
    const history=panel.querySelector('.cm-history>div');history.textContent='正在读取生成历史…';
    try{
      const r=await fetch('/api/memory/'+encodeURIComponent(a.id)+'?board='+encodeURIComponent(initialBoard));if(!r.ok)throw new Error('读取生成历史失败');const detail=await r.json();if(!panel.isConnected)return;history.replaceChildren();
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
