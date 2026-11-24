"use strict";

const brollDialog = $("#brollDialog");
const br = selector => $(selector,brollDialog);
let brollSession = null;

function closeBroll() {
  if (brollSession?.submitting) return;
  brollSession = null;
  br("[data-br-preview]").replaceChildren();
  if (brollDialog.open) brollDialog.close?.();
  brollDialog.removeAttribute("open");
}

function brollActive(session) {
  return session === brollSession && session.board === boardId && node(session.node.id) === session.node &&
    session.node.versions.some(version=>version.ref === session.ref) && canvasCanEdit();
}

function brollMode() {
  const mode = br("[name=mode]").value;
  for (const field of $$("[data-br-modes]",brollDialog)) {
    field.hidden = !field.dataset.brModes.split(" ").includes(mode);
  }
}

function openBroll(source,{sourceRef=null,brief=""}={}) {
  const version = sourceRef?source?.versions.find(v=>v.ref===sourceRef):curV(source);
  if (brollDialog.open || !canvasCanEdit() || !version?.ref || !["image","video"].includes(source.type)) return;
  brollSession = {board:boardId,node:source,ref:version.ref};
  br("form").reset();
  br("fieldset").disabled = false;
  br("[data-br-source]").textContent = `${source.name} · 版本 ${source.versions.indexOf(version)+1}`;
  br("[name=brief]").value=brief;
  const still = source.type === "image";
  br("[data-br-duration]").hidden = !still;
  br("[name=mode] option[value=motion]").hidden = !still;
  br("[name=mode]").value = still ? "motion" : "title";
  if (!still && version.seconds > 3) br("[name=end]").value = "3";
  br("[data-br-status]").textContent = "";
  const media = document.createElement(still ? "img" : "video");
  if (still) media.alt = source.name;
  else Object.assign(media,{controls:true,playsInline:true,preload:"metadata"});
  media.src = version.url || "/media?ref="+encodeURIComponent(version.ref);
  br("[data-br-preview]").replaceChildren(media);
  brollMode();
  if (brollDialog.showModal) brollDialog.showModal();
  else brollDialog.setAttribute("open","");
}

function brollOptions() {
  const values = {mode:br("[name=mode]").value,style:br("[name=style]").value};
  const numbers = brollSession.node.type === "image" ? ["start","end","duration"] : ["start","end"];
  for (const key of numbers) {
    const field = br(`[name=${key}]`);
    if (!field.validity.valid) throw new Error("请检查开始、结束和片段时长");
    if (field.value) values[key] = field.valueAsNumber;
  }
  return values;
}

function brollContent(mode) {
  const fields = {};
  if (mode === "motion") return {direction:br("[name=direction]").value};
  if (mode === "title" || mode === "chart") fields.title = br("[name=title]").value.trim();
  if (mode === "captions") fields.lines = br("[name=lines]").value.split("\n").map(s=>s.trim()).filter(Boolean);
  if (mode === "chart") {
    fields.bars = br("[name=bars]").value.split("\n").filter(line=>line.trim()).map(line=>{
      const match = line.match(/^(.+)[,，]\s*(\d+(?:\.\d+)?)\s*$/);
      if (!match) throw new Error("条形图每行填写名称和数值，用逗号隔开");
      return {label:match[1].trim(),value:Number(match[2])};
    });
  }
  return fields;
}

function brollUpdate(draft) {
  if (draft.title) br("[name=title]").value = draft.title;
  if (draft.lines) br("[name=lines]").value = draft.lines.join("\n");
  if (draft.bars) br("[name=bars]").value = draft.bars.map(bar=>`${bar.label}, ${bar.value}`).join("\n");
  if (draft.direction) br("[name=direction]").value = draft.direction;
}

async function brollAction(draft) {
  const S = brollSession;
  if (!S || S.busy || !brollActive(S)) return;
  const status = br("[data-br-status]"), controls = br("fieldset");
  try {
    const options = brollOptions();
    const values = draft ? {brief:br("[name=brief]").value.trim(),...options} : {...options,...brollContent(options.mode)};
    if (draft && !values.brief) throw new Error("请先描述要加的画面");
    S.busy = true;
    S.submitting = !draft;
    controls.disabled = true;
    status.textContent = draft ? "正在起草…" : "正在提交渲染…";
    await flushSave();
    if (!brollActive(S)) return;
    requireSavedBoard(S.board);
    const source = {board:S.board,node:S.node.id,ref:S.ref};
    if (draft) {
      const plan = await boardRequest("/api/broll/draft","POST",{...source,...values});
      if (brollActive(S)) {
        brollUpdate(plan);
        status.textContent = "草稿已填入，请核对后生成";
      }
      return;
    }
    const fingerprint = JSON.stringify(values);
    if (S.attempt?.fingerprint !== fingerprint) S.attempt = {fingerprint,key:newCanvasNodeId()};
    const result = await boardRequest("/api/broll/render","POST",{...source,recipe:values,request_key:S.attempt.key});
    if (!brollActive(S)) return;
    checkpoint();
    const at = freeSpot(S.node.x+size(S.node).w+110,S.node.y,"video");
    const output = addNode("video",at.x,at.y,{}, {name:`${S.node.name} · B-roll`,job:{ids:result.ids,t0:Date.now(),st:{},source:"broll",
      prompt:values.title || values.lines?.join("\n") || "",history:{broll_recipe:result.recipe,broll_source:{node:S.node.id,ref:S.ref}}}});
    B.edges.push({from:S.node.id,to:output.id,relation:"broll",ref:S.ref});
    selectOnly(output.id);
    drawEdges();
    save();
    poll();
    S.submitting = false;
    closeBroll();
  } catch (error) { if (S === brollSession) status.textContent = error.message || "B-roll 操作失败"; }
  finally {
    S.busy = false;
    S.submitting = false;
    if (S === brollSession) controls.disabled = false;
  }
}

br("[data-br-close]").onclick = closeBroll;
br("[name=mode]").onchange = brollMode;
br("[data-br-draft]").onclick = () => brollAction(true);
br("form").onsubmit = event => { event.preventDefault(); brollAction(false); };
brollDialog.addEventListener("cancel",event=>{ event.preventDefault(); closeBroll(); });
brollDialog.addEventListener("keydown",event=>event.stopPropagation());
