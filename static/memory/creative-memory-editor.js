"use strict";

async function cmEdit(a=null, kind='character', options={}) {
  if (CM.editor?.dataset.busy === 'true') { toast('正在保存或上传，请稍等'); return; }
  const host=options.host||null, readonly=!!options.readonly, initialBoard=boardId;
  const project = currentProject();
  const projectOptions = [project, a?.project && canvasProjects.find(p => p.id === a.project && p.id !== project?.id)].filter(Boolean);
  cmClose(); CM.editor?.remove();
  const panel=document.createElement('section'); panel.id='memoryEditor'; panel.className='cm-editor'; panel.role='dialog';
  panel.setAttribute('aria-modal','false'); panel.setAttribute('aria-label',OneShotI18n.t('资产详情'));
  panel.innerHTML=OneShotI18n.html`<header><strong>${OneShotI18n.t(a?'编辑资产':'新建资产')}</strong><button type="button" data-close aria-label="关闭资产详情">×</button></header><form><div class="cm-fields"><div class="cm-hero" hidden></div><label>名称<input name="name" required maxlength="80"></label><div class="cm-row"><label>分类<select name="kind">${Object.entries(KIND_CN).map(([k,v])=>`<option value="${k}">${OneShotI18n.t(v)}</option>`).join('')}</select></label><label>保存到<select name="board">${projectOptions.map(p=>`<option value="project:${esc(p.id)}">项目 · ${esc(p.name)}</option>`).join("")}<option value="">个人资产库</option></select></label></div><label>别名<input name="aliases" placeholder="用逗号分隔，支持 @别名"></label><label>标签<input name="tags" placeholder="如：主角、森林、夜景"></label><label>设定 / 背景资料<textarea name="desc" rows="5" maxlength="6000" placeholder="人物外观、场景背景、故事设定等"></textarea></label><label>使用约束<textarea name="constraints" rows="2" maxlength="6000" placeholder="如：眼镜和服装保持一致"></textarea></label><label class="cm-check"><input name="shared" type="checkbox">共享给所有平台账号（个人素材库范围）</label><div class="cm-row"><label class="cm-upload">上传图片、视频、音频或文档<input name="upload" type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm,.mp3,.wav,.m4a,.aac,.flac,.ogg,.txt,.md,.markdown,.csv,.json,.docx,.pdf"></label><button type="button" data-current>采用当前选中素材</button></div><div class="cm-help">参考素材保留多个版本；点击图片可指定默认参考。生成历史不会自动替换默认图。</div><div class="cm-media"></div><details class="cm-history"><summary>生成历史</summary><div></div></details><div class="cm-error" role="status"></div></div><footer><button type="button" data-delete ${a?'':'hidden'}>删除资产</button><button type="button" data-canvas>放入画布</button><button type="submit">保存资产</button></footer></form>`;
  if(host)host.replaceChildren(panel); else document.body.append(panel); CM.editor=panel;
  const character = document.createElement("section");
  character.className = "cm-character";
  character.innerHTML = OneShotI18n.html`<strong>标准角色图</strong><p>先生成并定稿主图，再补其他角度。</p><div class="cm-character-views"></div><details><summary>角色卡</summary><div class="cm-character-fields">${Object.entries(CHARACTER_FIELDS).map(([key,label]) => `<label>${label}<input name="character_${key}" maxlength="800"></label>`).join("")}</div></details>`;
  panel.querySelector(".cm-hero").after(character);
  const form=panel.querySelector('form'), field=name=>form.elements.namedItem(name);
  let data=a?acClone(a):{kind:options.kind||kind,...cmNewScope(),name:'',desc:'',constraints:'',aliases:[],tags:[],shared:false,media:[],default_ref:''};
  if(data.conversation_source){
    const hint=document.createElement("p");
    hint.className="cm-help";
    hint.textContent="私人对话存档。助手中再次收录同一对话会更新这里的正文。";
    field("kind").closest(".cm-row").after(hint);
    field("kind").disabled=true;
    field("board").disabled=true;
  }
  let pending=options.preset?.pending||null, selectedRef=data.default_ref||data.ref||'', busy=false;
  let storyStates=acClone(data.story_states||[]);
  const storyBox=document.createElement("details");
  storyBox.innerHTML=OneShotI18n.html`<summary>用于剧本与视频</summary>
    <label class="cm-check"><input type="checkbox" name="story_draft">草稿，仅在明确引用时采用</label>
    <label data-world-scenes>适用场次<input name="story_scenes" placeholder="如：画市十七号、夜间仓库。留空适用整个项目"></label>
    <div data-character-states><p class="cm-help">按场次关键词指定角色的服装或状态，可从参考素材选图。</p>
    <div data-state-rows></div><button type="button" data-state-add>添加场次状态</button></div>`;
  field("desc").closest("label").after(storyBox);
  field("story_draft").checked=!!data.story_draft;
  field("story_draft").disabled=readonly;
  field("story_scenes").value=(data.story_scenes||[]).join("，");
  field("story_scenes").readOnly=readonly;
  const stateAdd=$("[data-state-add]",storyBox);
  stateAdd.hidden=readonly;
  stateAdd.onclick=()=>{
    if(storyStates.length>=12||busy||readonly)return;
    storyStates.push({scene:"",notes:"",ref:""});
    paintStoryStates();
    $("[data-state-rows]",storyBox).lastElementChild?.querySelector("input").focus();
  };
  function paintStoryStates(){
    const role=field("kind").value;
    $("[data-world-scenes]",storyBox).hidden=role!=="world";
    $("[data-character-states]",storyBox).hidden=role!=="character";
    const options=[...data.media,...(pending&&!data.media.some(item=>item.ref===pending.ref)?[pending]:[])]
      .filter(item=>cmMediaType(item.ref,item)==="image");
    const box=$("[data-state-rows]",storyBox); box.replaceChildren();
    for(const [index,state] of storyStates.entries()){
      const row=document.createElement("fieldset");
      row.innerHTML=OneShotI18n.html`<legend>场次状态 ${index+1}</legend>
        <label>场次关键词<input data-story="scene" maxlength="80"></label>
        <label>本场状态<textarea data-story="notes" rows="2" maxlength="1200"></textarea></label>
        <label>本场参考图<select data-story="ref"></select></label><button type="button" data-state-remove>移除此状态</button>`;
      const select=$("select",row);
      select.add(new Option("沿用角色默认参考图",""));
      options.forEach((item,i)=>select.add(new Option(`${i+1}. ${item.ref.split("/").at(-1)}`,item.ref)));
      for(const input of $$("[data-story]",row)){
        const key=input.dataset.story;
        input.value=state[key]||"";
        input.disabled=readonly;
        input.oninput=input.onchange=()=>{state[key]=input.value;};
      }
      const remove=$("[data-state-remove]",row);
      remove.hidden=readonly;
      remove.onclick=()=>{if(!busy&&!readonly){storyStates.splice(index,1);paintStoryStates();}};
      box.append(row);
    }
    stateAdd.disabled=storyStates.length>=12;
  }
  field("kind").addEventListener("change",paintStoryStates);
  let generationMedia=[...(data.generation_media || data.generation_images || [])];
  const mediaRanges={
    video:new Map(Object.entries(data.generation_video_ranges || {})),
    audio:new Map(Object.entries(data.generation_audio_ranges || {}))
  };
  const generationBox=document.createElement("details");
  generationBox.className="cm-generation-images";
  generationBox.innerHTML=OneShotI18n.markup('<summary>生成参考素材</summary><p class="cm-help">@资产 会采用选中的素材和资产正文。图片生成采用图片和文字。视频和音频参考需要支持全模态的视频服务。留空采用默认参考图。</p><ol></ol>');
  $(".cm-media",panel).after(generationBox);
 let documentData=options.preset?.document||data.document||null, documentDirty=!!options.preset?.document;
  const docBox=document.createElement("details");
  docBox.className="cm-document";docBox.hidden=true;
  docBox.innerHTML=OneShotI18n.markup('<summary>文档正文</summary><pre></pre><button type="button">移除文档</button>');
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
        download.textContent = OneShotI18n.t("下载");
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
          tag.textContent = OneShotI18n.t("待定稿");
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
    link.title = OneShotI18n.t("查看原图");
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
  function paintGenerationMedia(media,focusRef) {
    const allowed=media.filter(item=>cmMediaType(item.ref,item));
    generationMedia=generationMedia.filter(ref=>allowed.some(item=>item.ref===ref));
    generationBox.hidden=!allowed.length;
    $("summary",generationBox).textContent="生成参考素材"+(generationMedia.length?" · "+generationMedia.length+" 项":"");
    const list=$("ol",generationBox);
    list.replaceChildren();
    const ordered=[...generationMedia,...allowed.map(item=>item.ref).filter(ref=>!generationMedia.includes(ref))];
    for(const ref of ordered) {
      const item=document.createElement("li"), caption=document.createElement("label");
      const entry=allowed.find(item=>item.ref===ref), type=cmMediaType(ref,entry);
      const check=document.createElement("input"), index=generationMedia.indexOf(ref);
      check.type="checkbox";check.checked=index>=0;check.disabled=readonly;
      check.dataset.generationMedia=ref;
      const label=index>=0?"参考 "+(index+1):"加入生成参考";
      const detail=TYPE_CN[type]+(Number.isFinite(entry.seconds)?" · "+entry.seconds.toFixed(1)+" 秒":"");
      caption.append(check);
      if(type==="image"){
        const picture=document.createElement("img");picture.src="/media?ref="+encodeURIComponent(ref);picture.alt="";
        caption.append(picture);
      } else caption.insertAdjacentHTML("beforeend",ico(type));
      caption.append(label+" · "+detail);
      check.setAttribute("aria-label",label+" · "+detail+" · 素材 "+(allowed.indexOf(entry)+1));
      check.onchange=()=>{
        const max=type==="image"?30:10;
        if(busy||check.checked&&generationMedia.filter(ref=>cmMediaType(ref,allowed.find(item=>item.ref===ref))===type).length>=max){
          check.checked=index>=0;
          if(!busy)status(`每组最多选择 ${max} 项${TYPE_CN[type]}参考`);
          return;
        }
        if(check.checked) generationMedia.push(ref); else generationMedia.splice(index,1);
        paintGenerationMedia(media,ref);
      };
      item.append(caption);
      if(index>=0&&!readonly) for(const [offset,title] of [[-1,"上移"],[1,"下移"]]){
        const next=index+offset;
        const button=action(title,()=>{
          if(busy) return;
          [generationMedia[index],generationMedia[next]]=[generationMedia[next],generationMedia[index]];
          paintGenerationMedia(media,ref);
        });
        button.disabled=next<0||next>=generationMedia.length;
        button.setAttribute("aria-label",title+"参考 "+(index+1));
        item.append(button);
      }
      const ranges=mediaRanges[type];
      if(index>=0&&ranges&&(!readonly||ranges.has(ref))){
        const range=document.createElement("div");
        range.className="cm-reference-range";
        const values=ranges.get(ref)||["",""];
        for(const [bound,title] of ["入点（秒）","出点（秒）"].entries()){
          const field=document.createElement("label"), input=document.createElement("input");
          input.type="number";input.min="0";input.step="any";input.disabled=readonly;
          input.value=values[bound];input.placeholder=bound===0?"0":String(entry.seconds??"原片结尾");
          input.setAttribute("aria-label",`参考 ${index+1} 的${title}`);
          input.oninput=()=>{values[bound]=input.value;ranges.set(ref,values);};
          field.append(title,input);range.append(field);
        }
        item.append(range);
      }
      list.append(item);
      if(ref===focusRef) check.focus();
    }
  }
  function paint() {
    const grid=panel.querySelector('.cm-media');grid.replaceChildren();
    const media=[...(data.media||[]),...(pending&&!data.media?.some(m=>m.ref===pending.ref)?[pending]:[])];
    paintGenerationMedia(media);
    const hero=panel.querySelector('.cm-hero'), lead=selectedRef||media[0]?.ref;
    hero.hidden=!host||!lead;hero.replaceChildren();
    if(host&&lead){
      const type=cmMediaType(lead,media.find(m=>m.ref===lead)), image=type==="image";
      const el=document.createElement(image?'img':type==="audio"?'audio':'video');
      el.src='/media?ref='+encodeURIComponent(lead);if(image)el.alt=data.name||'资产预览';else {el.controls=true;el.playsInline=true;el.preload='metadata';}
      hero.append(el);if(image){const link=document.createElement('a');link.href=el.src;link.target='_blank';link.rel='noopener';link.textContent=OneShotI18n.t('查看原图');hero.append(link);}
    }
    for(const m of media){
      const type=cmMediaType(m.ref,m), image=type==="image", b=document.createElement(image?'button':'div');if(image)b.type='button';
      b.className='cm-media-item'+(m.ref===selectedRef?' on':'');
      const url="/media?ref="+encodeURIComponent(m.ref);
      b.innerHTML=image?OneShotI18n.html`<img src="${url}" alt="参考图">`:type==="audio"?`<audio src="${url}" preload="none" controls></audio>`:`<video src="${url}" preload="metadata" controls playsinline></video>`;
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
  const syncSharing=()=>{field('shared').disabled=readonly||!!data.conversation_source||!!field('board').value;};
  field('board').onchange=syncSharing;
  field('aliases').value=(data.aliases||[]).join('，');field('tags').value=(data.tags||[]).join('，');field('shared').checked=!!data.shared;syncSharing();paint();paintCharacter();paintStoryStates();
  panel.querySelector('[data-close]').onclick=()=>{
    if(busy)return status('正在保存或上传，请稍等');panel.remove();if(CM.editor===panel)CM.editor=null;
    if(host&&typeof alEmptyDetail==='function'){AL.selected=null;alEmptyDetail();alRender();}
  };
  panel.addEventListener('pointerdown',e=>e.stopPropagation());panel.addEventListener('wheel',e=>e.stopPropagation(),{passive:true});
  panel.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Escape')panel.querySelector('[data-close]').click();});
  panel.querySelector('[data-current]').onclick=async()=>{
    if(busy||readonly)return;
    try{const n=[...sel].map(node).find(n=>['image','video','audio'].includes(n?.type)&&curV(n));if(!n)throw new Error('先在画布选中已完成的图片、视频或音频');await flushSave();if(boardId!==initialBoard)return;const v=curV(n);pending={...v,type:n.type,source_board:initialBoard,node_id:n.id,source:v.source||'generated'};if(!selectedRef&&n.type==='image')selectedRef=v.ref;paint();paintStoryStates();status('已选用「'+n.name+'」，保存后生效');}catch(e){status(e.message);}
  };
  async function receiveFile(file) {
    if(!file||busy||readonly)return;setBusy(true);status('正在上传…');
    try{
      const body=new FormData();body.append('file',file);
      const isDocument=CM_DOCUMENT_EXT.test(file.name);
      const audio=/\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(file.name);
      const r=await fetch(isDocument?'/api/document-import':audio?'/api/upload_audio':'/api/upload',{method:'POST',body}),v=await r.json();
      if(!r.ok)throw new Error(v.error||'上传失败');
      if(isDocument){
        documentData=v;documentDirty=true;
        if(!a&&field('kind').value!=='world')field('kind').value='document';
        if(!field('name').value.trim())field('name').value=file.name.replace(CM_DOCUMENT_EXT,'');
        paintDocument();paintCharacter();paintStoryStates();docBox.open=true;status('已提取正文，保存后可搜索和引用');
      }else{
        pending={...v,source:'upload'};if(!selectedRef&&file.type.startsWith('image/'))selectedRef=v.ref;
        paint();paintStoryStates();status('已上传，保存后加入资产');
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
      p.story_draft=field("story_draft").checked;
      p.story_scenes=p.kind==="world"?field("story_scenes").value.split(/[,，\n]/).map(value=>value.trim()).filter(Boolean):[];
      p.generation_media=generationMedia;
      if(pending)Object.assign(p,{ref:pending.ref,source_board:pending.source_board||'',node_id:pending.node_id});
      if(p.kind === "character") {
        p.character_card = readCard();
        p.story_states=storyStates.filter(state=>state.scene.trim()||state.notes.trim()||state.ref);
        if(approval) {
          await flushSave();
          if (boardId !== initialBoard) return;
          Object.assign(p, {ref:approval.version.ref, source_board:initialBoard, node_id:approval.nodeId, character_view:approval.slot});
          if(pending && pending.ref!==p.ref && !data.media.some(item=>item.ref===pending.ref))
            p.generation_media=p.generation_media.filter(ref=>ref!==pending.ref);
        }
      }
      for(const [type,ranges] of Object.entries(mediaRanges)){
        const saved={};
        for(const ref of p.generation_media){
          const values=ranges.get(ref);
          if(!values||values.every(value=>value===""))continue;
          if(values.some(value=>value==="")||Number(values[1])-Number(values[0])<2-1e-8)
            throw new Error(`请填写参考${TYPE_CN[type]}的入点和出点，片段至少 2 秒`);
          saved[ref]=values.map(Number);
        }
        p[`generation_${type}_ranges`]=saved;
      }
      data=await api('/api/memory',p);if(!approval||pending?.ref===p.ref)pending=null;
      documentDirty=false;documentData=data.document||null;paintDocument();
      if (approval?.draftKey && readCharacterDraft(approval.draftKey)?.ref === p.ref) writeCharacterDraft(approval.draftKey, null);
      generationMedia=[...new Set([...(data.generation_media || data.generation_images || []),
        ...(pending && generationMedia.includes(pending.ref) ? [pending.ref] : [])])];
      storyStates=acClone(data.story_states||[]);
      selectedRef=data.default_ref||data.ref||"";cmInvalidate();paint();paintCharacter();paintStoryStates();status('已保存。可在提示词或对话中输入 @'+data.name+' 使用');
      panel.querySelector('header strong').textContent=OneShotI18n.t('编辑资产');panel.querySelector('[data-delete]').hidden=false;
      if(typeof alChanged==='function')alChanged(data);if(KIND_CN[afilter])await cmRenderLibrary(afilter);
    }catch(e){status(e.message);}finally{setBusy(false);}
  };
  panel.querySelector('[data-delete]').onclick=async()=>{
    if(busy||readonly)return;const b=panel.querySelector('[data-delete]');
    if(!b.dataset.armed){b.dataset.armed='1';b.textContent=OneShotI18n.t('再次点击删除');setTimeout(()=>{delete b.dataset.armed;b.textContent=OneShotI18n.t('删除资产');},3000);return;}
    setBusy(true);
    try{const r=await fetch('/api/memory/'+encodeURIComponent(data.id),{method:'DELETE'});if(!r.ok)throw new Error((await r.json()).error||'删除失败');unlinkDeletedAsset(data.id);cmInvalidate();panel.remove();if(CM.editor===panel)CM.editor=null;if(typeof alChanged==='function')alChanged(data,true);await loadAssets();}catch(e){status(e.message);}finally{setBusy(false);}
  };
  panel.querySelector('[data-canvas]').onclick=()=>{
    if(!data.id)return status('请先保存资产');
    placeLibraryAsset(data,toW(innerWidth/2-150,innerHeight/2-180),()=>{if(host&&typeof alClose==='function')alClose();},status);
  };
  if(readonly){for(const el of panel.querySelectorAll('input,textarea,select'))el.disabled=true;panel.querySelector('[type=submit]').hidden=true;panel.querySelector('[data-delete]').hidden=true;panel.querySelector('[data-current]').hidden=true;status('共享资产可查看和引用，修改请由资产所有者操作');}else field('name').focus();
  if(a){
    const history=panel.querySelector('.cm-history>div');history.textContent=OneShotI18n.t('正在读取生成历史…');
    try{
      const r=await fetch('/api/memory/'+encodeURIComponent(a.id)+'?board='+encodeURIComponent(initialBoard));if(!r.ok)throw new Error('读取生成历史失败');const detail=await r.json();if(!panel.isConnected)return;history.replaceChildren();
      if(!documentDirty && typeof detail.document?.text === "string"){data.document=documentData=detail.document;paintDocument();}
      data.character_drafts = detail.character_drafts;
      paintCharacter();
      for(const v of detail.history||[]){
        const tile=document.createElement('div');tile.className='cm-media-item';
        tile.innerHTML=/\.(png|jpe?g|webp)$/i.test(v.ref)?OneShotI18n.html`<img src="/media?ref=${encodeURIComponent(v.ref)}" alt="生成历史">`:`<video src="/media?ref=${encodeURIComponent(v.ref)}" preload="metadata" controls playsinline></video>`;
        if(!readonly){const button=document.createElement('button');button.type='button';button.textContent=OneShotI18n.t('加入参考素材');button.onclick=()=>{if(busy)return;pending={ref:v.ref,source:'generated',source_board:v.board};paint();status('已选择生成历史，保存后加入参考；默认图保持不变');};tile.append(button);}history.append(tile);
      }
      if(!history.children.length)history.textContent='还没有采用此资产的生成记录';
    }catch(e){history.textContent=e.message;}
  }
  if(options.file)await receiveFile(options.file);
  return panel;
}
