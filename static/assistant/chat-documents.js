"use strict";

function acDocumentUrl(sid,id) {
 return `/api/chat/sessions/${encodeURIComponent(sid)}/documents${id?"/"+encodeURIComponent(id):""}`;
}
async function acAddDocuments(files) {
 if(!AC.session || AC.board!==boardId || AC.documentUpload || AC.sending || !files.length)return;
 const limit=2-AC.documents.length;
 if(files.length>limit)return toast(OneShotI18n.t("每条消息最多添加 2 个文档"));
 if(files.some(file=>!CM_DOCUMENT_EXT.test(file.name)))return toast("支持 TXT、Markdown、CSV、JSON、DOCX 和 PDF 文档");
 if(files.some(file=>file.size>8*1024*1024))return toast(OneShotI18n.t("每个文档不能超过 8 MB"));
 const sid=AC.session, epoch=AC.epoch, operation={};
 AC.documentUpload=operation;
 acRenderState();
 try{
  for(const file of files){
   const form=new FormData();
   form.append("file",file,file.name);
   const result=await (await fetchOk(acDocumentUrl(sid),{method:"POST",body:form})).json();
   if(sid!==AC.session || epoch!==AC.epoch){
    void boardRequest(acDocumentUrl(sid,result.id),"DELETE").catch(()=>{});
    return;
   }
   AC.documents.push(result);
  }
 }catch(error){if(epoch===AC.epoch)toast(error.message,5000);}
 finally{if(AC.documentUpload===operation){AC.documentUpload=null;acRenderState();}}
}
function acRenderDocuments(){
 const pane=$("#acDocuments");
 const markup=AC.documents.map(doc=>OneShotI18n.html`<span class="ac-ref" title="${esc(doc.name)}">${ico("script")}<span>${esc(doc.name)}${doc.truncated?" · 已截取":""}</span><button type="button" data-remove-document="${esc(doc.id)}" aria-label="移除附件">×</button></span>`).join("");
 if(pane._items!==markup){pane._items=markup;pane.innerHTML=markup;}
 pane.hidden=!AC.documents.length;
 $("#acAttachDocs").disabled=!AC.session||AC.sending||!!AC.documentUpload||AC.documents.length>=2;
 $("#acAttachDocs").lastChild.textContent=AC.documentUpload?OneShotI18n.t("读取中…"):OneShotI18n.t("文档");
}

function acInitDocumentControls(pane){
 $("#acRefs").insertAdjacentHTML("afterend",OneShotI18n.html`<div id="acDocuments" class="ac-refs" aria-label="文档附件" hidden></div>`);
 $("#acReference").insertAdjacentHTML("afterend",OneShotI18n.html`<button type="button" id="acAttachDocs" title="添加文档附件" disabled>${ico("upload")}<span>文档</span></button>
   <button type="button" id="acPickPlacement" title="指定新结果放置位置" aria-label="指定新结果放置位置" aria-pressed="false">${ico("fit")}</button>
   <input type="file" id="acDocumentFile" accept=".txt,.md,.markdown,.csv,.json,.docx,.pdf" multiple hidden>`);
 const documentInput=$("#acDocumentFile"), composer=$(".ac-composer",pane);
 $("#acAttachDocs").onclick=()=>documentInput.click();
 documentInput.onchange=()=>{const files=[...documentInput.files];documentInput.value="";void acAddDocuments(files);};
 composer.ondragover=event=>{if(event.dataTransfer.types.includes("Files")){event.preventDefault();event.stopPropagation();}};
 composer.ondrop=event=>{
  const files=[...event.dataTransfer.files];
  if(files.length){event.preventDefault();event.stopPropagation();void acAddDocuments(files);}
 };
 $("#acDocuments").onclick=event=>{
  const button=event.target.closest("[data-remove-document]");
  if(!button || AC.sending)return;
  const id=button.dataset.removeDocument;
  AC.documents=AC.documents.filter(doc=>doc.id!==id);acRenderState();
  void boardRequest(acDocumentUrl(AC.session,id),"DELETE").catch(()=>{});
 };
}
