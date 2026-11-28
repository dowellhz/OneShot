"use strict";

const screenplayFields = {setup:"开场",action:"动作",result:"结果",evidence:"画面核对",dialogue:"对白"};
const screenplayIssues = {missing:"没有呈现",duplicate:"重复发生",order:"顺序或场次错误",premature:"首帧提前展示结果",evidence:"没有可靠的原文证据"};
const screenplayLines = value => value.split("\n").map(line=>line.trim()).filter(Boolean);
const screenplayDisabled = disabled => disabled ? "disabled" : "";

function screenplayOutlineMarkup(state, locked) {
  const {html} = OneShotI18n;
  const draft = state.outline || {goal:"",events:[],ending:"",fixed:[],seconds:state.source.target_seconds||15};
  const disabled = screenplayDisabled(locked);
  return html`<form class="sh wz-screenplay-form" data-screenplay-outline>
    <h3>确认故事大纲</h3>
    <label>主角或主题的目标<textarea name="goal" required maxlength="600" ${disabled}>${esc(draft.goal)}</textarea></label>
    <label>关键事件（每行一项）<textarea name="events" required ${disabled}>${esc(draft.events.join("\n"))}</textarea></label>
    <label>结尾<textarea name="ending" required maxlength="600" ${disabled}>${esc(draft.ending)}</textarea></label>
    <label>必须保留的角色、道具或事件（每行一项）<textarea name="fixed" ${disabled}>${esc(draft.fixed.join("\n"))}</textarea></label>
    <label>目标时长（秒）<input name="seconds" type="number" min="5" max="120" value="${draft.seconds}" required ${disabled}></label>
    <div class="nav"><button class="ghost" type="button" data-goto="0">← 想法</button>
      ${!state.outline && !state.pending ? html`<button class="ghost" type="button" data-screenplay="outline" ${disabled}>重新提取大纲</button>`:""}
      <button class="go" type="submit" ${disabled}>确认大纲并写剧本 →</button></div>
  </form>`;
}

function screenplayEditMarkup(state, number, scene, disabled) {
  const {t,html}=OneShotI18n;
  if (state.editing!==number) return html`<button class="ghost" data-screenplay="edit" ${disabled}>手动编辑这一场</button>`;
  const draft=state.edits?.[number] || scene;
  return html`<form class="wz-screenplay-form" data-screenplay-edit>
    ${Object.entries(screenplayFields).map(([field,label])=>`<label>${esc(t(label))}
      <textarea name="${field}" rows="2" ${field==="action"?"required":""} maxlength="${field==="dialogue"?8016:1200}" ${disabled}>${esc(field==="dialogue"?draft[field].join("\n"):draft[field])}</textarea></label>`).join("")}
    <button class="go" ${disabled}>保存场次</button>
    <button type="button" class="ghost" data-screenplay="cancel-edit" ${disabled}>取消编辑</button>
  </form>`;
}

function screenplayLocksMarkup(state, disabled) {
  return OneShotI18n.html`<form class="wz-screenplay-form" data-screenplay-locks>
    <label>必须保留的角色、道具或事件（每行一项）
      <textarea name="fixed" rows="3" ${disabled}>${esc((state.lockEdits||state.manuscript.fixed).join("\n"))}</textarea></label>
    <button class="ghost" ${disabled}>保存锁定设定</button>
  </form>`;
}

function screenplayVersionMarkup(state, disabled) {
  const {t,html}=OneShotI18n;
  const entries=state.versions||[], previous=entries.find(entry=>entry.revision===state.compare);
  if (!entries.length) return "";
  const changed=previous ? state.manuscript.beats.map((scene,index)=>
    JSON.stringify(scene)!==JSON.stringify(previous.manuscript.beats[index]) ? index : null).filter(index=>index!==null) : [];
  return html`<details class="sh" ${previous?"open":""}><summary>剧本版本</summary>
    <label>选择要比较的版本<select data-screenplay-compare ${disabled}>${html`<option value="">选择版本</option>`}
      ${entries.map(entry=>`<option value="${entry.revision}" ${entry===previous?"selected":""}>${esc(t("第 {number} 版",{number:entry.revision}))}</option>`).join("")}</select></label>
    ${previous?html`<div class="wz-screenplay-diff">
      ${JSON.stringify(previous.manuscript.fixed)===JSON.stringify(state.manuscript.fixed)?"":html`
        <section><h4>旧稿设定</h4>${screenplayFixedMarkup(previous.manuscript)}</section>
        <section><h4>当前设定</h4>${screenplayFixedMarkup(state.manuscript)}</section>`}
      ${changed.map(index=>html`<section><h4>旧稿 · ${esc(t("第 {number} 场",{number:index+1}))}</h4>
        ${screenplaySceneMarkup(previous.manuscript.beats[index])}</section>
        <section><h4>当前 · ${esc(t("第 {number} 场",{number:index+1}))}</h4>
        ${screenplaySceneMarkup(state.manuscript.beats[index])}</section>`).join("")}
      </div><button class="ghost" data-screenplay="restore" ${disabled}>恢复这一稿</button>`:""}</details>`;
}

function screenplayAuditMarkup(report) {
  if (!report) return "";
  const {t,html}=OneShotI18n;
  return html`<details class="sh" data-screenplay-audit ${report.ok?"":"open"}><summary>${esc(t(report.ok?"逐场拆镜核对已通过":"逐场拆镜核对有问题"))}</summary>
    ${report.issue?`<p>${esc(t(report.issue))}</p>`:""}
    <ul>${report.events.map(event=>`<li><b>${esc(t("第 {number} 场",{number:event.scene}))}</b> ${esc(event.text)}
      ${event.shots.map(number=>esc(t("镜头 {number}",{number}))).join(" · ")}
      ${event.issues.map(issue=>`<strong> · ${esc(t(screenplayIssues[issue]))}</strong>`).join("")}</li>`).join("")}</ul>
  </details>`;
}

function updateScreenplayDraft(state, draft) {
  if (JSON.stringify(state.manuscript)===JSON.stringify(draft)) return;
  state.versions=[{revision:state.revision,manuscript:state.manuscript},...(state.versions||[])].slice(0,12);
  state.manuscript=draft;
  state.revision++;
  delete state.suggestion;
  delete state.audit;
  delete state.error;
}

function replaceScreenplayScene(state, number, scene) {
  updateScreenplayDraft(state,{...state.manuscript,beats:state.manuscript.beats.map((old,index)=>index+1===number?scene:old)});
}

function screenplayValidLines(lines, max, length) {
  if (lines.length>max || lines.some(line=>line.length>length)) {
    toast(OneShotI18n.t("最多 {count} 项，每项不超过 {length} 个字符",{count:max,length}));
    return false;
  }
  return true;
}

function wireScreenplayEditor(body,state) {
  const outline=$("[data-screenplay-outline]",body), edit=$("[data-screenplay-edit]",body), locks=$("[data-screenplay-locks]",body);
  if (outline) {
    const form=()=>{
      const {goal,events,ending,fixed,seconds}=Object.fromEntries(new FormData(outline));
      return {goal,events:screenplayLines(events),ending,fixed:screenplayLines(fixed),seconds:Number(seconds)};
    };
    outline.oninput=()=>{state.outline=form();wizSave();};
    outline.onsubmit=event=>{
      event.preventDefault();
      const value=form();
      if (!value.goal.trim() || !value.ending.trim() || !value.events.length) return toast("请补齐大纲");
      if (!screenplayValidLines(value.events,12,600) || !screenplayValidLines(value.fixed,30,600)) return;
      state.outline=value;
      void wizardScreenplayRequest(state,"write",{outline:value,target_seconds:value.seconds});
    };
  }
  if (edit) {
    const number=state.editing;
    const form=()=>{
      const data=Object.fromEntries(new FormData(edit));
      return {...data,dialogue:screenplayLines(data.dialogue)};
    };
    edit.oninput=()=>{(state.edits||={})[number]=form();wizSave();};
    edit.onsubmit=event=>{
      event.preventDefault();
      const value=form();
      if (!value.action.trim()) return toast("请填写这一场的动作");
      if (!screenplayValidLines(value.dialogue,16,500)) return;
      if (value.dialogue.length && screenplaySilentBrief(state.source.story)) return toast("原始要求为全片无对白，请保留这一设定");
      replaceScreenplayScene(state,number,value);
      delete state.editing;
      delete state.edits?.[number];
      wizSave();refreshWizardScreenplay();
    };
  }
  if (locks) {
    const lines=()=>screenplayLines(locks.elements.fixed.value);
    locks.oninput=()=>{state.lockEdits=lines();wizSave();};
    locks.onsubmit=event=>{
      event.preventDefault();
      const fixed=lines();
      if (!screenplayValidLines(fixed,30,600)) return;
      updateScreenplayDraft(state,{...state.manuscript,fixed});
      delete state.lockEdits;
      wizSave();refreshWizardScreenplay();
    };
  }
  const select=$("[data-screenplay-compare]",body);
  if (select) select.onchange=()=>{state.compare=Number(select.value)||null;wizSave();refreshWizardScreenplay();};
}

function screenplaySilentBrief(story) {
  return /(?:全程|全片|整片)\s*(?:无|没有|不加|不要)(?:任何)?(?:台词|对白|对话)|\b(?:film|video|clip) (?:has )?(?:no|without) (?:spoken )?(?:dialogue|dialog|speech)\b/i.test(story||"");
}
