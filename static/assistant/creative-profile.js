"use strict";

let profileEpoch=0;
let profileSettings=null;

function cpSetFields(settings) {
 const project=settings.project;
 $("#cpPersonal").value=settings.personal.text;
 $("#cpProject").value=project?.text||"";
 $("#cpProjectScope").hidden=!project;
 $("#cpProjectName").textContent=project?"项目规则 · "+project.name:"";
 profileSettings=settings;
}

function cpClose() {
 const dialog=$("#creativeProfile");
 if(!dialog?.open)return;
 profileEpoch++;
 profileSettings=null;
 if(dialog.close)dialog.close();
 else dialog.removeAttribute("open");
}

async function cpOpen() {
 const dialog=$("#creativeProfile"), fieldset=$("fieldset",dialog);
 if(dialog.open)return;
 const epoch=++profileEpoch, board=boardId;
 profileSettings=null;
 fieldset.disabled=true;
 $("#cpProjectScope").hidden=true;
 $("#cpPersonal").value=$("#cpProject").value="";
 $("#cpStatus").textContent="正在读取记忆…";
 if(dialog.showModal)dialog.showModal();
 else dialog.setAttribute("open","");
 try{
  const settings=await acApi("/api/chat/profile?board="+encodeURIComponent(board));
  if(epoch!==profileEpoch||board!==boardId)return;
  cpSetFields(settings);
  fieldset.disabled=false;
  $("#cpStatus").textContent="";
  $("#cpPersonal").focus();
 }catch(error){if(epoch===profileEpoch)$("#cpStatus").textContent=error.message;}
}

async function cpSave(event) {
 event.preventDefault();
 const fieldset=$("fieldset",event.currentTarget), status=$("#cpStatus");
 if(!profileSettings||fieldset.disabled)return;
 const changes={};
 for(const [scope,input] of [["personal",$("#cpPersonal")],["project",$("#cpProject")]]){
  const entry=profileSettings[scope], text=input.value.trim();
  if(!entry||text===entry.text)continue;
  changes[scope]={text,revision:entry.revision,...(scope==="project"?{id:entry.id}:{})};
 }
 if(!Object.keys(changes).length){status.textContent="没有需要保存的改动";return;}
 const epoch=profileEpoch, board=boardId;
 fieldset.disabled=true;
 status.textContent="正在保存…";
 try{
  const saved=await boardRequest("/api/chat/profile","PUT",{board,changes});
  if(epoch!==profileEpoch||board!==boardId)return;
  cpSetFields(saved);
  status.textContent="已保存，后续对话会沿用当前记忆";
 }catch(error){if(epoch===profileEpoch)status.textContent=error.message;}
 finally{if(epoch===profileEpoch)fieldset.disabled=false;}
}

function cpApplyDecision(id, decision) {
 const host=AC.calls.get(id), card=host&&$(".ac-profile-suggestion",host);
 if(!card)return;
 for(const button of $$("button[data-profile-decision]",card))button.hidden=true;
 $("summary",host).textContent=host.dataset.label+" · "+(decision==="save"?"已保存":"已忽略");
 $("[role=status]",card).textContent=decision==="save"?"已保存到记忆":"已忽略建议";
}

function cpAddSuggestion(host, suggestion) {
 const card=document.createElement("section");
 card.className="ac-profile-suggestion";
 const title=document.createElement("strong"), text=document.createElement("p"),
       controls=document.createElement("div"), status=document.createElement("span");
 title.textContent=suggestion.scope==="project"?"保存为项目规则 · "+suggestion.project:"保存为个人偏好";
 text.textContent=suggestion.text;
 status.setAttribute("role","status");
 for(const [decision,label] of [["save","记住"],["dismiss","忽略"]]){
  const button=document.createElement("button");
  button.type="button";
  button.textContent=label;
  button.dataset.profileDecision=decision;
  button.onclick=async()=>{
   if(button.disabled||button.hidden||!AC.session)return;
   const sid=AC.session, buttons=$$("button",controls);
   buttons.forEach(control=>control.disabled=true);
   status.textContent="";
   try{
    await acApi(`/api/chat/sessions/${encodeURIComponent(sid)}/profile/${encodeURIComponent(suggestion.id)}`,{decision});
    if(sid===AC.session){cpApplyDecision(suggestion.id,decision);await acPoll();}
   }catch(error){if(sid===AC.session&&!button.hidden)status.textContent=error.message;}
   finally{buttons.forEach(control=>control.disabled=false);}
  };
  controls.append(button);
 }
 card.append(title,text,controls,status);
 host.append(card);
 if(suggestion.decision)cpApplyDecision(suggestion.id,suggestion.decision);
}

function initCreativeProfile() {
 AC_LABELS.creative_profile_suggest="建议保存创作记忆";
 $("#acNew").insertAdjacentHTML("afterend",'<button type="button" id="acProfile" aria-haspopup="dialog" aria-controls="creativeProfile">记忆</button>');
 $("#acProfile").onclick=cpOpen;
 document.body.insertAdjacentHTML("beforeend",`<dialog id="creativeProfile" aria-labelledby="cpTitle">
  <header><h2 id="cpTitle">创作助手记忆</h2><button type="button" id="cpClose" aria-label="关闭记忆设置">×</button></header>
  <form>
   <fieldset disabled>
    <label>个人偏好<textarea id="cpPersonal" maxlength="4000" rows="5" placeholder="字幕使用简体中文，分镜写清景别和运镜"></textarea></label>
    <label id="cpProjectScope" hidden><span id="cpProjectName"></span><textarea id="cpProject" maxlength="4000" rows="5" placeholder="项目固定 16:9，沿用已定稿角色参考图"></textarea></label>
    <button type="submit">保存记忆</button>
   </fieldset>
   <p id="cpStatus" role="status"></p>
  </form>
 </dialog>`);
 const dialog=$("#creativeProfile");
 $("#cpClose").onclick=cpClose;
 $("form",dialog).onsubmit=cpSave;
 dialog.addEventListener("cancel",event=>{event.preventDefault();cpClose();});
 dialog.addEventListener("keydown",event=>event.stopPropagation());
}
