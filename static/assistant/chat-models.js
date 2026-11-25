"use strict";

function acRenderModelPicker(){
 const state=AC.modelSelection, picker=$("#acModelChoice"), thinking=$("#acThinkingLevel");
 const models=AC.models.slice();
 if(state.locked?.id&&!models.some(model=>model.id===state.locked.id)){
  models.push({...state.locked,name:state.locked.name+"（已停用）",levels:[]});
 }
 const choice=state.locked?.id??state.choice??"";
 const option=models.find(model=>model.id===choice);
 const choices=OneShotI18n.html`<option value="">自动（平台路由）</option>`+models.map(model=>
  `<option value="${esc(model.id)}">${esc(model.name+" · "+model.model)}</option>`).join("");
 if(picker._options!==choices){picker._options=choices;picker.innerHTML=choices;}
 picker.value=option?.id||"";
 picker.disabled=!AC.session||AC.sending||!!AC.loadingSessions||!!state.locked||!models.length;
 picker.title=OneShotI18n.t(state.locked?"新建对话可切换模型":"选择本对话使用的文本模型");
 const levels=option?.levels||[];
 thinking.parentElement.hidden=levels.length<2;
 const options=levels.map(level=>`<option value="${level}">${OneShotI18n.t(AC_THINKING_LEVELS[level])}</option>`).join("");
 if(thinking._options!==options){thinking._options=options;thinking.innerHTML=options;}
 thinking.value=levels.includes(state.level)?state.level:"off";
 thinking.disabled=AC.sending||!!AC.loadingSessions;
}

function acRenderParallel(){
 const panel=$("#acParallel");
 const active=AC.sessions.filter(session=>session.run_state||session.queued_count>0);
 panel.hidden=!active.some(session=>session.id!==AC.session);
 const disabled=AC.sending||AC.documentUpload||AC.loadingSessions;
 const list=active.map(session=>{
  const current=session.id===AC.session;
  const phase=(AC_STATES[session.run_state]||"等待执行").replace(/…$/,"");
  const status=phase+(session.queued_count>0&&session.run_state?` · 排队 ${session.queued_count}`:"");
  return `<button type="button" data-parallel-session="${esc(session.id)}"${current?' aria-current="true"':""}${disabled?" disabled":""}>
   <span>${esc(session.title)}</span> <small>${esc(status)}</small></button>`;
 }).join("");
 if(panel._items!==list){panel._items=list;panel.innerHTML=list;}
}

function acInitModelControls(){
 $("#acModel").insertAdjacentHTML("afterend",OneShotI18n.markup('<section id="acParallel" aria-label="并行对话" hidden></section>'));
 $("#acModel").insertAdjacentHTML("beforebegin",OneShotI18n.html`<div class="ac-model-settings">
   <label>对话模型<select id="acModelChoice"></select></label>
   <label hidden>思考强度<select id="acThinkingLevel"></select></label>
 </div>`);
 $("#acModelChoice").onchange=event=>{
  AC.modelSelection.choice=event.target.value;
  AC.modelSelection.level="off";
  acRenderModelPicker();
 };
 $("#acThinkingLevel").onchange=event=>{AC.modelSelection.level=event.target.value;};
 $("#acParallel").onclick=event=>{
  const button=event.target.closest("[data-parallel-session]");
  if(button&&!button.disabled&&button.dataset.parallelSession!==AC.session)
   acLoadSession(button.dataset.parallelSession).catch(error=>toast(error.message));
 };
}
