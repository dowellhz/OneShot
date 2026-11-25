"use strict";

const showcasePath = () => "/api/board/" + encodeURIComponent(boardId) + "/showcase";

function showcaseChoices(type) {
  return B.nodes.filter(n=>n.type === type).flatMap(n=>n.versions.map((v,i)=>({
    node:n.id,ref:v.ref,version:i+1,label:n.name+(n.versions.length > 1 ? " · 版本 "+(i+1) : ""),current:i===n.cur
  })).filter(v=>v.ref));
}

function drawShowcase(entries) {
  const states = {pending:"待审核",approved:"已发布",rejected:"已退回"};
  $("#shareShowcaseEntries").innerHTML = entries.map(entry=>OneShotI18n.html`<li>
    <span>${esc(entry.title)} · ${states[entry.state] || ""}</span>
    ${entry.reason ? `<p>${esc(entry.reason)}</p>` : ""}
    ${entry.state === "approved" ? `<a href="/showcase/${encodeURIComponent(entry.token)}" target="_blank" rel="noopener">查看作品</a>` : ""}
    ${entry.has_prompt && entry.can_link_template ? `<button type="button" data-revoke-prompt="${esc(entry.token)}">撤下提示词</button>` : ""}
    <button type="button" data-withdraw="${esc(entry.token)}">撤回</button>
    ${entry.state==="approved" && entry.can_link_template ? `<details data-showcase-template-editor="${esc(entry.token)}">
      <summary>${entry.template_name ? (entry.template_published ? "工作流 · "+esc(entry.template_name) : "工作流 · 已取消共享") : "关联工作流"}</summary>
      <form class="share-form"><select aria-label="已共享的工作流模板" disabled></select><button type="submit" disabled>保存链接</button></form>
    </details>` : ""}
  </li>`).join("");
  for (const button of $$("[data-revoke-prompt]",$("#shareShowcaseEntries"))) {
    button.onclick = () => changeShowcase("DELETE",button.dataset.revokePrompt,null,{},"prompt");
  }
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

function showcaseCanPublish() {
  return !!B && (B.access === "owner" || !B.access && B.owner === ME_USER?.id);
}

async function openGifShowcase(gif) {
  if (!showcaseCanPublish()) return;
  const bid=boardId;
  await shareOpen();
  if (boardId===bid && !$("#canvasShare").hidden && !$("#shareShowcase").disabled) setupShowcaseForm(gif);
}

function setupShowcaseForm(gif = null) {
  const videos = showcaseChoices("video"), images = showcaseChoices("image");
  const match = videos.findIndex(v=>v.current && sel.has(v.node));
  const selected = match >= 0 ? match : videos.findIndex(v=>v.current);
  const options = values => values.map((value,i)=>`<option value="${i}">${esc(value.label)}</option>`).join("");
  const video = $("#shareShowcaseVideo");
  const cover = $("#shareShowcaseCover");
  const template = $("#shareShowcaseTemplate");
  const attachPrompt = $("#shareShowcaseAttachPrompt"), prompt = $("#shareShowcasePrompt");
  const videoInput = $("#shareShowcaseVideoFile"), coverInput = $("#shareShowcaseCoverFile");
  const upload = '<option value="upload">从本地上传</option>';
  video.innerHTML = (gif?'<option value="gif-export">已生成的 GIF</option>':"") + options(videos) + upload;
  video.value = gif ? "gif-export" : videos.length ? String(Math.max(0,selected)) : "upload";
  cover.innerHTML = '<option value="">使用作品首帧</option>' + options(images) + upload;
  videoInput.value = coverInput.value = "";
  const syncInput = (select,input)=>{
    input.required = select.value === "upload";
    input.closest("label").hidden = !input.required;
  };
  function syncPrompt() {
    prompt.closest("label").hidden = !attachPrompt.checked;
    prompt.required = attachPrompt.checked;
  }
  attachPrompt.onchange = () => {
    if (attachPrompt.checked && !prompt.value) {
      const selection=video.value==="gif-export"?gif?.source:videos[Number(video.value)];
      const version=node(selection?.node)?.versions.find(item=>item.ref===selection?.ref);
      const original=[version?.generation_record?.prompt,version?.prompt]
        .find(value=>typeof value==="string" && value.trim());
      if (original && original.length<=prompt.maxLength) prompt.value=original;
    }
    syncPrompt();
    if (attachPrompt.checked) prompt.focus();
  };
  video.onchange = () => {
    syncInput(video,videoInput);
    attachPrompt.checked=false;
    prompt.value="";
    syncPrompt();
  };
  cover.onchange = ()=>syncInput(cover,coverInput);
  video.onchange(); cover.onchange();
  $("#shareShowcaseTitle").value = (gif?.name || B.name).slice(0,80);
  $("#shareShowcaseDescription").value = "";
  $("#shareShowcaseAttach").checked = false;
  $("#shareShowcaseForm").hidden = false;
  template.replaceChildren(new Option("不附工作流",""));
  template.disabled = true;
  populateShowcaseTemplates(template).catch(()=>{});
  $("#shareShowcaseForm").onsubmit = e=>{
    e.preventDefault();
    const choice = values => ({node:values.node,ref:values.ref});
    const gifRef = video.value==="gif-export" ? gif.ref : null;
    const videoFile = video.value === "upload" ? videoInput.files[0] : null;
    const coverFile = cover.value === "upload" ? coverInput.files[0] : null;
    if (video.value==="upload" && !videoFile || cover.value==="upload" && !coverFile) {
      $("#shareStatus").textContent = "请选择要上传的文件"; return;
    }
    if (videoFile?.size > 300000000 || coverFile?.size > 20000000) {
      $("#shareStatus").textContent = "成片最多 300 MB，封面最多 20 MB";
      return;
    }
    const publicPrompt = attachPrompt.checked ? prompt.value.trim() : null;
    if (attachPrompt.checked && !publicPrompt) {
      $("#shareStatus").textContent="请填写要公开的提示词";
      prompt.focus(); return;
    }
    changeShowcase("POST","",{
      video:videoFile || gifRef ? null : choice(videos[Number(video.value)]),
      ...(gifRef ? {gif_ref:gifRef} : {}),
      cover:coverFile || cover.value === "" ? null : choice(images[Number(cover.value)]),
      title:$("#shareShowcaseTitle").value,description:$("#shareShowcaseDescription").value,
      attach_canvas:$("#shareShowcaseAttach").checked,template:template.value || null,public_prompt:publicPrompt,confirmed:true
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

async function changeShowcase(method, token, payload, files={}, resource=method==="PUT"?"template":"") {
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
      await boardRequest(resource?target+"/"+resource:target,method,body);
    }
    const entries = await boardRequest(url);
    if (bid !== boardId || $("#canvasShare").hidden) return;
    drawShowcase(entries);
    if (method === "POST") $("#shareShowcaseForm").hidden = true;
    if(method==="PUT")$("[data-showcase-template-editor='"+token+"'] summary")?.focus();
    $("#shareStatus").textContent = resource==="prompt" ? "提示词已撤下" :
      method === "PUT" ? "工作流链接已更新" : method === "DELETE" ? "作品已撤回" : "作品已提交审核";
  } catch (error) {
    if (bid === boardId) $("#shareStatus").textContent = error.message;
  } finally {
    if (bid === boardId) { fieldset.disabled = false; progress.hidden = true; }
  }
}
