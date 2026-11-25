"use strict";

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
  form.innerHTML=OneShotI18n.html`<strong>收录 ${entries.length} 项资产</strong>
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
    status.textContent=OneShotI18n.t("正在读取文件夹…");
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
    status.textContent=OneShotI18n.t("正在收录…");
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
