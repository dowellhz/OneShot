"use strict";

const AC_CHOICE_PROMPT = /(?:请选择|(?:你|您)(?:想|要|会)?选|选哪|选一个|哪[个种一]|二选一|回复\s*[12]|1\s*还是\s*2|choose|pick one|which option)/i;
const acChoiceProse = el => el?.matches("p,h1,h2,h3,h4,h5,h6") && AC_CHOICE_PROMPT.test(el.textContent);

function acChoiceLabels(block) {
 if (block.querySelector("ol,ul,pre,table,input,a,img")) return null;
 if (block.tagName==="OL") {
  return block.start===1 ? [...block.children].map(el=>el.textContent.trim().replace(/\s+/g," ")) : null;
 }
 if (block.tagName!=="P") return null;
 const lines=[...block.childNodes].map(child=>child.nodeName==="BR"?"\n":child.textContent).join("").trim().split(/\n+/);
 const numbered=lines.map(line=>line.match(/^\s*([1-6])[、）．]\s*(\S.*?)\s*$/));
 return numbered.length>1 && numbered.every((entry,i)=>Number(entry?.[1])===i+1) ? numbered.map(entry=>entry[2]) : null;
}

function acAddChoices(message, event) {
 const blocks = Array.from(message.children);
 if (!blocks.some(acChoiceProse)) return;
 const candidates = blocks.map(block=>({block,labels:acChoiceLabels(block)}))
  .filter(({labels})=>labels && labels.length>=2 && labels.length<=6 && labels.every(label=>label && label.length<=350));
 const following = candidates.filter(({block})=>acChoiceProse(block.previousElementSibling));
 const attached = following.length ? following : candidates.filter(({block})=>acChoiceProse(block.nextElementSibling));
 const choice = candidates.length===1 ? candidates[0] : attached.length===1 ? attached[0] : null;
 const binary = !candidates.length && blocks.some(el=>acChoiceProse(el) && /(?:^|\D)1\s*还是\s*2(?:\D|$)/.test(el.textContent));
 const options = choice?.labels || (binary ? ["",""] : []);
 if (options.length < 2 || options.length > 6 || options.some(label => label.length > 350)) return;
 const card = document.createElement("div");
 card.className = "ac-choices";
 card.dataset.event = event.id;
 card.setAttribute("role", "group");
 card.setAttribute("aria-label", OneShotI18n.t("请选择一个方案"));
 const title = document.createElement("strong");
 title.textContent = OneShotI18n.t("请选择一个方案");
 card.append(title);
 options.forEach((label, index) => {
  const button = document.createElement("button");
  button.type = "button";
  const number = document.createElement("span");
  number.className = "ac-choice-number";
  number.textContent = index + 1;
  button.append(number, document.createTextNode(label || `选择 ${index + 1}`));
  button.disabled = true;
  button.onclick = () => {
   if (!button.disabled) acSend(label ? `我选择 ${index + 1}：${label}` : `我选择 ${index + 1}`);
  };
  card.append(button);
 });
 if (choice) choice.block.replaceWith(card);
 else message.append(card);
}

function acRenderQuestions(){
 const panel=$("#acQuestions"), card=AC.questionnaires[0];
 if(!card){panel.hidden=true;panel.replaceChildren();panel._step=null;return;}
 if(!acQuestionDrafts.has(card.id))acQuestionDrafts.set(card.id,{
  step:0,answers:card.questions.map(question=>({pick:question.options.length?null:-1,value:""}))
 });
 const draft=acQuestionDrafts.get(card.id), {step,answers}=draft;
 if(draft.sent){panel.hidden=true;return;}
 panel.hidden=false;
 const key=card.id+":"+step;
 if(panel._step===key)return;
 panel._step=key;
 const item=card.questions[step], selection=answers[step];
 const options=item?.options||[];
 panel.innerHTML=OneShotI18n.html`<form>
  <header><strong>需要你的确认</strong><span>${item?`第 ${step+1} 项，共 ${answers.length} 项`:"核对答案"}</span></header>
  ${item?OneShotI18n.html`<fieldset><legend>${esc(item.prompt)}</legend>
    ${options.map((text,i)=>`<label><input type="radio" name="choice" value="${i}" ${selection.pick===i?"checked":""}>${esc(text)}</label>`).join("")}
    ${options.length?OneShotI18n.html`<label><input type="radio" name="choice" value="-1" ${selection.pick===-1?"checked":""}>自填答案</label>`:""}
    <textarea maxlength="500" aria-label="填写答案" rows="2" ${selection.pick===-1?"":"hidden"}>${esc(selection.pick===-1?selection.value:"")}</textarea>
  </fieldset>`:`<dl>${card.questions.map(({prompt},i)=>`<div><dt>${esc(prompt)}</dt><dd>${esc(answers[i].value)}</dd></div>`).join("")}</dl>`}
  <footer>${step?OneShotI18n.markup('<button type="button" data-question-back>上一步</button>'):""}
  ${item?`<button type="button" data-question-next ${selection.value.trim()?"":"disabled"}>${step+1===answers.length?"核对答案":"下一项"}</button>`:
    OneShotI18n.markup('<button type="submit">提交答案</button>')}</footer></form>`;
 const form=$("form",panel), next=$("[data-question-next]",form);
 const move=offset=>{
  draft.step+=offset;acRenderQuestions();
  const heading=$("legend",panel)||$("header strong",panel);
  heading.setAttribute("tabindex","-1");heading.focus();
 };
 $("[data-question-back]",form)?.addEventListener("click",()=>move(-1));
 if(item){
  const source=$("textarea",form), update=()=>{next.disabled=!selection.value.trim();};
  form.onchange=e=>{
   if(e.target.name!=="choice")return;
   selection.pick=Number(e.target.value);
   source.hidden=selection.pick!==-1;
   selection.value=source.hidden?options[selection.pick]:source.value;
   if(!source.hidden)source.focus();
   update();
  };
  source.oninput=()=>{selection.value=source.value;update();};
  next.onclick=()=>move(1);
 }
 form.onsubmit=async e=>{
  e.preventDefault();
  if(item||draft.sending)return;
  const epoch=AC.epoch, button=$("button[type=submit]",form);
  button.disabled=true;draft.sending=true;
  try{
   await acApi(`/api/chat/runs/${encodeURIComponent(card.run_id)}/questions/${encodeURIComponent(card.id)}`,
    {answers:answers.map(answer=>answer.value.trim())});
   draft.sent=true;
   if(epoch===AC.epoch){acRenderQuestions();await acPoll();}
  }catch(error){if(epoch===AC.epoch){toast(error.message);await acPoll();}}
  finally{draft.sending=false;button.disabled=false;}
 };
}
