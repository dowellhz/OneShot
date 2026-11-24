"use strict";

const CS = {rows:[], entry:null, epoch:0, busy:false};

function csShowSelection() {
 const button = $("#acSkills");
 const skill = AC.skill;
 button.textContent = skill ? "技能 · " + skill.name : "技能";
 button.title = skill ? "本条消息使用「" + skill.name + "」" : "管理和选择创作技能";
 button.setAttribute("aria-label", button.title);
 $("#acSkillClear").hidden = !skill;
}

function csChoose(skill) {
 AC.skill = skill ? {id:skill.id, name:skill.name} : null;
 csShowSelection();
}

function csClose() {
 const panel = $("#creativeSkills");
 if (!panel.open) return;
 CS.epoch++;
 CS.entry = null;
 CS.busy = false;
 $("#csEditor fieldset").disabled = false;
 $("#csLibrary").inert = false;
 if (typeof panel.close === "function") panel.close();
 else panel.removeAttribute("open");
}

function csList() {
 const query = $("#csSearch").value.trim().toLowerCase();
 const rows = CS.rows.filter(skill => (skill.name + "\n" + skill.description).toLowerCase().includes(query));
 $("#csRows").innerHTML = rows.map(skill => `
  <article data-skill="${esc(skill.id)}">
   <div><strong>${esc(skill.name)}</strong><span>${skill.builtin ? "内置" : "个人"} · ${skill.automatic ? "自动匹配" : "手动使用"}</span>
    <p>${esc(skill.description)}</p></div>
   <button type="button" data-cs-action="choose">本轮使用</button>
   <button type="button" data-cs-action="edit">${skill.builtin ? "查看" : "编辑"}</button>
  </article>`).join("") || "<p>没有匹配的技能</p>";
}

async function csRefresh(epoch) {
 const rows = await acApi("/api/chat/skills");
 if (epoch !== CS.epoch) return;
 CS.rows = rows;
 if (AC.skill) csChoose(rows.find(row => row.id === AC.skill.id));
 csList();
}

async function csOpen(fromComposer=false) {
 const panel = $("#creativeSkills");
 if (panel.open) return;
 if (typeof panel.showModal === "function") panel.showModal();
 else panel.setAttribute("open", "");
 const epoch = ++CS.epoch;
 CS.fromComposer=fromComposer===true;
 csBack();
 $("#csSearch").value = "";
 $("#csSearch").focus();
 $("#csRows").replaceChildren();
 $("#csStatus").textContent = "正在读取技能…";
 try {
  await csRefresh(epoch);
  if (epoch === CS.epoch) $("#csStatus").textContent = "";
 } catch (error) {
  if (epoch === CS.epoch) $("#csStatus").textContent = error.message;
 }
}

function csBack() {
 CS.entry = null;
 $("#csEditor").hidden = true;
 $("#csLibrary").hidden = false;
 $("#csStatus").textContent = "";
}

function csEdit(skill = {references:{}, automatic:true}) {
 CS.entry = skill;
 $("#csLibrary").hidden = true;
 $("#csEditor").hidden = false;
 $("#csName").value = skill.name || "";
 $("#csDescription").value = skill.description || "";
 $("#csInstructions").value = skill.instructions || "";
 $("#csAuto").checked = skill.automatic;
 for (const id of ["csName", "csDescription", "csInstructions"]) $("#" + id).readOnly = !!skill.builtin;
 $("#csDelete").hidden = !skill.id || !!skill.builtin;
 $("#csConfirmDelete").hidden = true;
 $("#csReferences").innerHTML = Object.entries(skill.references).map(([filename, content]) => `
  <details><summary>${esc(filename)}</summary>
   <textarea aria-label="${esc(filename)}" data-cs-reference maxlength="6000">${esc(content)}</textarea>
   <button type="button" data-cs-remove-reference>移除资料</button>
  </details>`).join("");
 $("#csStatus").textContent = "";
 $("#csName").focus();
}

function csStatus(error) {
 $("#csStatus").textContent = error.message || String(error);
}

async function csAction(action) {
 if (CS.busy) return;
 CS.busy = true;
 const epoch = CS.epoch, fieldset = $("#csEditor fieldset");
 fieldset.disabled = true;
 $("#csLibrary").inert = true;
 try {
  await action(epoch);
 } catch (error) {
  if (epoch === CS.epoch) csStatus(error);
 } finally {
  if (epoch === CS.epoch) {
   CS.busy = false;
   fieldset.disabled = false;
   $("#csLibrary").inert = false;
  }
 }
}

function csRead(file, limit) {
 if (file.size > limit * 4) throw new Error(file.name + " 超过可导入大小");
 return new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
   const text = reader.result.trim();
   if (!text || text.length > limit) reject(new Error(file.name + " 为空或超过字符上限"));
   else resolve(text);
  };
  reader.onerror = () => reject(new Error("无法读取 " + file.name));
  reader.readAsText(file, "UTF-8");
 });
}

function csMarkdown(text, filename) {
 const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
 const body = header ? text.slice(header[0].length).trim() : text;
 function scalar(key) {
  const value = header?.[1].match(new RegExp("^" + key + ":[ \\t]*(.*)$", "m"))?.[1]?.trim() || "";
  if (/^[|>][+-]?$/.test(value)) {
   const start = header[1].search(new RegExp("^" + key + ":", "m"));
   const lines = header[1].slice(start).split(/\r?\n/).slice(1);
   const end = lines.findIndex(line => line.trim() && !/^\s/.test(line));
   return (end === -1 ? lines : lines.slice(0, end)).map(line => line.trim()).join(" ").trim();
  }
  return value.replace(/^(["'])(.*)\1$/, "$2");
 }
 return {name:(scalar("name") || body.match(/^#\s+(.+)$/m)?.[1] || filename.replace(/\.[^.]+$/, "")).slice(0,60),
  description:scalar("description").slice(0,240), instructions:body, automatic:true, references:{}};
}

async function csImport(files, folder, epoch) {
 const markdown = files.filter(file => /\.m(?:d|arkdown)$/i.test(file.name));
 const entry = folder ? markdown.find(file => /^[^/]+\/skill\.md$/i.test(file.webkitRelativePath)) : markdown[0];
 if (!entry) throw new Error(folder ? "文件夹根目录需要 SKILL.md" : "请选择 Markdown 文件");
 if (markdown.length > 9) throw new Error("每项技能最多附带 8 份 Markdown 参考资料");
 const skill = csMarkdown(await csRead(entry, 12000), entry.name);
 if (skill.instructions.length > 8000) throw new Error("技能指令最多 8000 个字符");
 if (folder && /^skill$/i.test(skill.name)) skill.name = entry.webkitRelativePath.split("/")[0].slice(0,60);
 for (const file of markdown) {
  if (file === entry) continue;
  const path = file.webkitRelativePath.split("/").slice(1).join("/");
  skill.references[path] = await csRead(file, 6000);
 }
 if (epoch === CS.epoch) csEdit(skill);
}

function initCreativeSkills() {
 $("#acReference").insertAdjacentHTML("afterend", `<span class="ac-skill-controls">
  <button type="button" id="acSkills" aria-haspopup="dialog">技能</button>
  <button type="button" id="acSkillClear" aria-label="取消本轮技能" title="取消本轮技能" hidden>×</button>
 </span>`);
 document.body.insertAdjacentHTML("beforeend", `<dialog id="creativeSkills" aria-labelledby="csTitle">
  <header><strong id="csTitle">创作技能</strong><button type="button" id="csClose">关闭</button></header>
  <section id="csLibrary">
   <div class="cs-top">
    <input type="search" id="csSearch" aria-label="搜索技能" placeholder="搜索技能">
    <button type="button" id="csNew">新建</button>
    <button type="button" id="csImport">导入 Markdown</button>
    <button type="button" id="csImportFolder">导入文件夹</button>
    <input id="csMarkdownFile" type="file" accept=".md,.markdown" hidden>
    <input id="csFolder" type="file" webkitdirectory multiple hidden>
   </div>
   <div id="csRows"></div>
  </section>
  <form id="csEditor" hidden>
   <fieldset>
    <label>名称<input id="csName" maxlength="60" required></label>
    <label>适用情境<textarea id="csDescription" rows="2" maxlength="240" required></textarea></label>
    <label>创作步骤<textarea id="csInstructions" rows="7" maxlength="8000" required></textarea></label>
    <div id="csReferences"></div>
    <label class="cs-check"><input type="checkbox" id="csAuto"> 允许助手按情境自动匹配</label>
    <div class="cs-top">
     <button id="csBack" type="button">返回列表</button>
     <button id="csDelete" type="button">删除</button>
     <button id="csConfirmDelete" type="button" hidden>确认删除</button>
     <button id="csSave" type="submit">保存</button>
    </div>
   </fieldset>
  </form>
  <div id="csStatus" role="status"></div>
 </dialog>`);
 const panel = $("#creativeSkills");
 panel.addEventListener("keydown", event => event.stopPropagation());
 panel.addEventListener("cancel", event => {event.preventDefault(); csClose();});
 $("#csClose").onclick = csClose;
 $("#acSkills").onclick = csOpen;
 $("#acSkillClear").onclick = () => csChoose(null);
 $("#csSearch").oninput = csList;
 $("#csSearch").onkeydown = event => {
  if(event.key!=="Enter"||event.isComposing||CS.busy)return;
  const choice=$('#csRows [data-cs-action="choose"]');
  if(choice){event.preventDefault();choice.click();}
 };
 $("#csNew").onclick = () => {if (!CS.busy) csEdit();};
 $("#csBack").onclick = csBack;
 $("#csDelete").onclick = () => {$("#csConfirmDelete").hidden = false;};
 $("#csConfirmDelete").onclick = () => csAction(async epoch => {
  await boardRequest("/api/chat/skills/" + encodeURIComponent(CS.entry.id), "DELETE");
  if (epoch !== CS.epoch) return;
  csBack();
  await csRefresh(epoch);
 });
 for (const [button, input, folder] of [["csImport","csMarkdownFile",false], ["csImportFolder","csFolder",true]]) {
  const picker = $("#" + input);
  $("#" + button).onclick = () => {if (!CS.busy) picker.click();};
  picker.onchange = () => {
   const files = [...picker.files];
   picker.value = "";
   if (files.length) csAction(epoch => csImport(files, folder, epoch));
  };
 }
 $("#csRows").onclick = event => {
  const action = event.target.closest("button[data-cs-action]");
  if (!action || CS.busy) return;
  const skill = CS.rows.find(row => row.id === action.closest("article").dataset.skill);
  if (!skill) return;
  if (action.dataset.csAction === "choose") {
   csChoose(skill);
   const input=$("#acInput");
   if(CS.fromComposer&&input.value==="/")input.value="";
   csClose();
   acRenderState();
   input.focus();
  } else {
   csAction(async epoch => {
    const detail = await acApi("/api/chat/skills/" + encodeURIComponent(skill.id));
    if (epoch === CS.epoch) csEdit(detail);
   });
  }
 };
 $("#csReferences").onclick = event => {
  if (event.target.closest("[data-cs-remove-reference]")) event.target.closest("details").remove();
 };
 $("#csEditor").onsubmit = event => {
  event.preventDefault();
  if (!CS.entry) return;
  csAction(async epoch => {
   const references = Object.fromEntries($$("textarea[data-cs-reference]", $("#csReferences")).map(input => [input.getAttribute("aria-label"),input.value]));
   await acApi("/api/chat/skills", {id:CS.entry.id, name:$("#csName").value,
    description:$("#csDescription").value, instructions:$("#csInstructions").value,
    automatic:$("#csAuto").checked, references});
   if (epoch !== CS.epoch) return;
   csBack();
   await csRefresh(epoch);
  });
 };
}
