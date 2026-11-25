"use strict";

let shareItemState = null;

function shareItemOpen(editable) {
  const fieldset=$("#shareItems");
  fieldset.hidden=!editable;
  $("#shareItemDetails").open=false;
  $("#shareItemLinks").replaceChildren();
  $("#shareItemPreview").replaceChildren();
  $("#shareItemURL").value="";
  $("#shareItemLink").hidden=true;
  $("#shareItemConfirm").checked=false;
  $("#shareItemPublish").disabled=true;
  if(!editable) { shareItemState=null; return; }
  const state={bid:boardId,endpoint:"/api/board/"+encodeURIComponent(boardId)+"/shared-items",attempt:0};
  shareItemState=state;
  const alive=()=>shareItemState===state&&boardId===state.bid&&!$("#canvasShare").hidden;
  const message=text=>{$("#shareStatus").textContent=text;};
  const mode=$("#shareItemMode"), source=$("#shareItemSource"), recent=$("#shareItemRecent");
  recent.value="0";
  const button=$("#shareItemPreviewBtn"), publish=$("#shareItemPublish"), confirm=$("#shareItemConfirm");
  const media=["image","video","audio"].flatMap(showcaseChoices);
  const selected=media.findIndex(item=>item.current&&sel.has(item.node));
  function invalidate(){
    state.attempt++;
    state.preview=null;
    $("#shareItemPreview").replaceChildren();
    $("#shareItemLink").hidden=true;
    confirm.checked=false;
    publish.disabled=true;
  }
  function populate(){
    invalidate();
    const options=mode.value==="media" ? media.map((item,index)=>[index,item.label]) :
      (state.conversations||[]).map(item=>[item.id,item.title]);
    source.replaceChildren(...options.map(([id,text])=>new Option(text,id)));
    if(mode.value==="media"&&selected>=0)source.value=String(selected);
    recent.closest("label").hidden=mode.value==="media";
    button.disabled=!options.length;
    if(!options.length)source.add(new Option("暂无可分享内容",""));
  }
  function sourceData(){
    if(mode.value==="media"){
      const item=media[Number(source.value)];
      return {kind:"media",node:item.node,ref:item.ref,version:item.version};
    }
    return {kind:"conversation",session:source.value,recent:Number(recent.value)};
  }
  function showLink(token){
    const input=$("#shareItemURL");
    input.value=new URL("/shared-item/"+encodeURIComponent(token),location.origin).href;
    $("#shareItemLink").hidden=false;
  }
  async function refresh(){
    const response=await boardRequest(state.endpoint);
    if(!alive())return;
    state.conversations=response.conversations;
    const list=$("#shareItemLinks");
    list.innerHTML=response.items.map(item=>OneShotI18n.html`<li><a href="/shared-item/${encodeURIComponent(item.token)}" target="_blank" rel="noopener">${esc(item.title)}</a>
      <button type="button" data-revoke-item="${esc(item.token)}">撤销</button></li>`).join("");
  }
  $("#shareItemDetails").ontoggle=async event=>{
    if(!event.target.open||!alive())return;
    try { await refresh(); if(alive())populate(); }
    catch(error) { if(alive())message(error.message); }
  };
  mode.value=selected>=0||media.length?"media":"conversation";
  mode.onchange=populate;
  source.onchange=recent.onchange=invalidate;
  confirm.onchange=()=>{publish.disabled=!confirm.checked||!state.preview;};
  button.onclick=async ()=>{
    invalidate();
    const attempt=state.attempt,data=sourceData();
    try {
      await flushSave();
      if(!alive()||attempt!==state.attempt)return;
      if(savePending?.id===state.bid||AC.pending.has(state.bid))throw new Error("画布正在保存，请稍后重试");
      const result=await boardRequest(state.endpoint+"/preview","POST",{source:data});
      if(!alive()||attempt!==state.attempt)return;
      state.preview={source:data,digest:result.digest};
      const pane=$("#shareItemPreview");
      pane.append(Object.assign(document.createElement("strong"),{textContent:result.title}));
      if(result.kind==="conversation"){
        for(const item of result.messages){
          const block=document.createElement("p");
          block.textContent=(item.role==="user"?"你":"创作助手")+" · "+item.text;
          pane.append(block);
        }
      }else{
        const element=document.createElement(result.media_type==="image"?"img":result.media_type);
        element.src=result.preview_url;
        if(result.media_type==="image")element.alt=result.title;
        else {element.controls=true;element.preload="metadata";}
        pane.append(element);
      }
      message("");
    } catch(error) { if(alive()&&attempt===state.attempt)message(error.message); }
  };
  publish.onclick=async ()=>{
    if(!state.preview||!confirm.checked||publish.disabled)return;
    publish.disabled=true;
    const reviewed=state.preview;
    try {
      const result=await boardRequest(state.endpoint,"POST",{...reviewed,confirmed:true});
      if(!alive())return;
      if(state.preview===reviewed)invalidate();
      showLink(result.token); message("链接已生成");
      await refresh();
    } catch(error) {
      if(alive()&&state.preview===reviewed){invalidate();message(error.message);}
    }
  };
  $("#shareItemLinks").onclick=async event=>{
    const control=event.target.closest("[data-revoke-item]");
    if(!control)return;
    if(!control.dataset.confirmed){control.dataset.confirmed="true";control.textContent=OneShotI18n.t("确认撤销");return;}
    control.disabled=true;
    try {
      await boardRequest(state.endpoint+"/"+encodeURIComponent(control.dataset.revokeItem),"DELETE");
      if(!alive())return;
      if($("#shareItemURL").value.endsWith("/"+control.dataset.revokeItem))$("#shareItemLink").hidden=true;
      message("链接已撤销"); await refresh();
    } catch(error) { if(alive())message(error.message); }
    finally {control.disabled=false;}
  };
  populate();
}
