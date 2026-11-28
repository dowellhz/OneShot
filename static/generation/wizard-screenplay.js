"use strict";

const activeScreenplays = new WeakSet();
const screenplayKinds = {motivation:"人物动机",causality:"剧情因果",dialogue:"对白",filmability:"可拍性"};

function wizardScreenplay() {
  return W?.script && W.screenplay?.script === W.script ? W.screenplay : null;
}

function refreshWizardScreenplay() {
  if ($("#wiz").classList.contains("on")) renderWiz();
}

async function wizardStartScreenplay(complete=false) {
  const wizard = W, board = B;
  if (!canvasCanEdit() || activeScreenplays.has(wizard) || wizard.production && wizard.production.status !== "done") return;
  activeScreenplays.add(wizard);
  refreshWizardScreenplay();
  try {
    const prepared = await prepareWizardScreenplaySource();
    if (!prepared || W !== wizard || B !== board) return;
    const {script,media} = prepared;
    const source = storyboardRequest(script,{targetSeconds:wizard.dur,motionFrames:true,wizardMedia:media});
    wizard.screenplay = {script:script.id, source, media, revision:1, complete};
    refreshWizardScreenplay();
    await wizardScreenplayRequest(wizard.screenplay,complete?"write":"outline");
  } finally {
    activeScreenplays.delete(wizard);
    if (B === board && W === wizard) refreshWizardScreenplay();
  }
}

async function wizardScreenplayRequest(state, operation, fields={}) {
  const board = B, script = wizScript(), bid = boardId;
  const current = () => B === board && boardId === bid && wizardScreenplay() === state &&
    wizScript() === script && canvasCanEdit();
  if (!current() || activeScreenplays.has(state) || toolBusy.has(script.id)) return;
  state.pending ||= { ...state.source, ...(state.outline?.seconds ? {target_seconds:state.outline.seconds} : {}),
    ...(state.complete ? {complete_script:true} : {}), ...fields, script:script.id, operation, key:filmExportKey(),
    ...(state.manuscript ? {manuscript:state.manuscript} : {}) };
  activeScreenplays.add(state);
  delete state.error;
  refreshWizardScreenplay();
  try {
    while (current() && state.pending) {
      wizSave();
      await flushSave();
      if (!current()) return;
      if (savePending?.id === bid || AC.pending.has(bid) || !boardSaveRetry.hidden)
        throw new Error("制作进度未保存，请检查连接后继续。");
      const pending = state.pending;
      let receipt = await api("/api/wizard/screenplay",pending);
      while (current() && receipt.state === "running") {
        await sleep(1500);
        if (!current()) return;
        receipt = await api("/api/wizard/screenplay",pending);
      }
      if (!current()) return;
      if (receipt.state === "error") {
        delete state.pending;
        throw new Error(receipt.error);
      }
      if (receipt.state !== "done") throw new Error("剧本任务暂时无法读取");
      const result = receipt.result;
      if (pending.operation === "write") {
        state.manuscript = result.manuscript;
        state.pending = {...state.source,script:script.id,operation:"review",key:filmExportKey(),manuscript:state.manuscript};
        refreshWizardScreenplay();
        continue;
      }
      delete state.pending;
      if (pending.operation === "outline") {
        state.outline = result.outline;
      } else if (pending.operation === "review") {
        state.notes = result.notes;
        state.reviewed = state.revision;
      } else if (pending.operation === "revise") {
        state.suggestion = {scene:result.scene, data:result.scene_data};
      } else if (pending.operation === "compile") {
        state.audit = result.screenplay_audit;
        if (state.audit?.ok) {
          applyStoryboardResult(script,result,{resetLinks:true,wizardMedia:state.media,approvedScreenplay:pending.manuscript});
          script.data.screenplay_audit = state.audit;
          script.data.screenplay_versions = state.versions || [];
          script.data.screenplay_outline = state.outline || null;
          script.data.screenplay_source = state.source;
          script.data.screenplay_revision = state.revision;
          delete W.screenplay;
        }
      }
      wizSave();
    }
  } catch (error) {
    if (current()) { state.error = error.message; wizSave(); }
  } finally {
    activeScreenplays.delete(state);
    if (B === board && wizScript() === script) refreshWizardScreenplay();
  }
}

function screenplaySceneMarkup(scene) {
  const entries = [["开场",scene.setup],["动作",scene.action],["结果",scene.result],["画面核对",scene.evidence]];
  const t = OneShotI18n.t;
  return entries.filter(([,value])=>value).map(([label,value])=>`<p><b>${esc(t(label))}</b> ${esc(value)}</p>`).join("") +
    scene.dialogue.map(line=>`<p class="wz-screenplay-dialogue">${esc(line)}</p>`).join("");
}

function screenplayFixedMarkup(draft) {
  return draft.fixed.length ? OneShotI18n.html`<details open><summary>锁定设定</summary><ul>${draft.fixed.map(line=>`<li>${esc(line)}</li>`).join("")}</ul></details>` : "";
}

function screenplayApprovedMarkup(draft) {
  return draft ? OneShotI18n.html`<details class="sh wz-screenplay-approved"><summary>查看定稿剧本</summary>
    ${screenplayFixedMarkup(draft)}${draft.beats.map((scene,index)=>`<h3>${esc(OneShotI18n.t("第 {number} 场",{number:index+1}))}</h3>${screenplaySceneMarkup(scene)}`).join("")}</details>` : "";
}

function renderWizardScreenplay(state) {
  const { t, html } = OneShotI18n;
  const busy = activeScreenplays.has(state) || toolBusy.has(state.script), draft = state.manuscript;
  const locked = !canvasCanEdit() || !!state.pending || busy;
  const disabled = locked ? "disabled" : "";
  const reviewed = state.reviewed === state.revision;
  const jobs = {outline:"正在提取大纲…",write:"正在写剧本…",review:"正在独立审稿…",revise:"正在修订这一场…",compile:"正在按定稿拆分镜…"};
  const status = busy && state.pending ? `<p role="status">${esc(t(jobs[state.pending.operation]))}</p>` : "";
  const resume = state.pending && !busy && canvasCanEdit() ? html`<button class="go" data-screenplay="resume">恢复剧本任务</button>` : "";
  const button = () => html`<button class="go" data-screenplay="write" ${disabled}>重试写剧本</button>`;
  return html`<section class="wz2 wz-screenplay">
    <h2>剧本初稿</h2>
    ${state.error&&!busy?`<p role="alert">${esc(t(state.error))}</p>`:""}${status}${resume}
    ${draft ? html`
      ${screenplayAuditMarkup(state.audit)}
      ${draft.intent?`<p>${esc(draft.intent)}</p>`:""}
      ${screenplayLocksMarkup(state,disabled)}
      ${screenplayVersionMarkup(state,disabled)}
      ${reviewed && !state.notes.length?html`<p class="est">审稿未发现能定位到正文的问题。</p>`:""}
      <div class="shots">${draft.beats.map((scene,index)=>{
        const number=index+1, suggestion=state.suggestion?.scene===number ? state.suggestion.data : null;
        const notes=reviewed ? state.notes.filter(note=>note.scene===number) : [];
        return html`<article class="sh" data-screenplay-scene="${number}">
          <h3>${esc(t("第 {number} 场",{number}))}</h3>${screenplaySceneMarkup(scene)}
          ${notes.length?html`<ul class="wz-screenplay-notes">${notes.map(note=>html`<li><b>${esc(t(screenplayKinds[note.kind]))}</b>
            <q>${esc(note.evidence)}</q><p>${esc(note.problem)}</p><p>${esc(note.suggestion)}</p></li>`).join("")}</ul>`:""}
          ${canvasCanEdit()?suggestion?html`<section class="wz-screenplay-proposal"><h4>建议修订稿</h4>
            ${screenplaySceneMarkup(suggestion)}
            <button class="go" data-screenplay="adopt" ${disabled}>采用这一场</button>
            <button class="ghost" data-screenplay="discard" ${disabled}>保留原稿</button></section>`:
            html`<label>这一场怎么改？<textarea data-screenplay-note rows="2" maxlength="1600" ${disabled}>${esc(state.instructions?.[number]||"")}</textarea></label>
            <button class="ghost" data-screenplay="revise" ${disabled}>建议修订这一场</button>
            ${screenplayEditMarkup(state,number,scene,disabled)}`:""}</article>`;
      }).join("")}</div>
      <div class="nav"><button class="ghost" data-goto="0">← 想法</button>
        <button class="ghost" data-screenplay="review" ${disabled}>独立审稿</button>
        <button class="go" data-screenplay="compile" ${locked||!reviewed||state.suggestion||state.editing?"disabled":""}>确认定稿并拆分镜 →</button></div>`
    : state.complete ? html`<div class="nav"><button class="ghost" data-goto="0">← 想法</button>${!state.pending?button():""}</div>`
      : screenplayOutlineMarkup(state,locked)}
  </section>`;
}

function wireWizardScreenplay(body) {
  if (!canvasCanEdit()) return;
  $$("[data-screenplay-start]",body).forEach(start=>start.onclick=()=>void wizardStartScreenplay(start.dataset.screenplayStart==="complete"));
  const reopen = $("[data-screenplay-reopen]",body);
  if (reopen) reopen.onclick=()=>{
    const script=wizScript(), d=script?.data;
    if (!d?.approved_screenplay || !d.screenplay_source || wizardProductionVisible()) return;
    W.screenplay={script:script.id,source:{...d.screenplay_source,board:boardId},media:d.wizard_media||{},
      manuscript:d.approved_screenplay,outline:d.screenplay_outline,versions:d.screenplay_versions,
      revision:d.screenplay_revision||1,complete:!d.screenplay_outline};
    wizSave();refreshWizardScreenplay();
  };
  const state = wizardScreenplay();
  if (!state) return;
  wireScreenplayEditor(body,state);
  $$("[data-screenplay-note]",body).forEach(input=>input.oninput=()=>{
    const number = input.closest("[data-screenplay-scene]").dataset.screenplayScene;
    (state.instructions ||= {})[number] = input.value;
    wizSave();
  });
  $$("[data-screenplay]",body).forEach(button=>button.onclick=()=>{
    const action = button.dataset.screenplay;
    const number = Number(button.closest("[data-screenplay-scene]")?.dataset.screenplayScene);
    if (["adopt","discard"].includes(action)) {
      if (action === "adopt" && state.suggestion?.scene === number) {
        replaceScreenplayScene(state,number,state.suggestion.data);
        delete state.instructions?.[number];
      }
      delete state.suggestion;
      wizSave();
      refreshWizardScreenplay();
    } else if (["edit","cancel-edit","restore"].includes(action)) {
      if (action==="edit") state.editing=number;
      else if (action==="cancel-edit") {delete state.edits?.[state.editing];delete state.editing;}
      else {
        const previous=state.versions?.find(entry=>entry.revision===state.compare);
        if (previous) updateScreenplayDraft(state,previous.manuscript);
        delete state.editing;
        delete state.edits;
        delete state.lockEdits;
        delete state.compare;
      }
      wizSave();refreshWizardScreenplay();
    } else if (action === "revise") {
      const notes = state.instructions?.[number]?.trim() || (state.reviewed === state.revision ?
        state.notes.filter(note=>note.scene===number).map(note=>note.suggestion).join("\n").slice(0,1600) : "");
      if (notes) void wizardScreenplayRequest(state,action,{scene:number,notes});
      else toast("请填写这一场的修改意见");
    } else if (action === "resume" && state.pending) void wizardScreenplayRequest(state,state.pending.operation);
    else if (action !== "compile" || state.reviewed === state.revision && !state.suggestion && !state.editing)
      void wizardScreenplayRequest(state,action);
  });
}
