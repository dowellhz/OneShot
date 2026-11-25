"use strict";

const alFolderTeam = () => AL.scope === "current" ? alCurrentTeam() :
  AL.scope.startsWith("team:") ? AL.scope.slice(5) : "";
const alFolderList = () => alFolderTeam() ? (AL.teamFolders?.team===alFolderTeam()?AL.teamFolders.items:[]) : AL.folders;
const alFolderURL = (id="",team=alFolderTeam()) =>
  "/api/asset-folders"+(id?"/"+encodeURIComponent(id):"")+(team?"?team="+encodeURIComponent(team):"");
const alFolderSlot = asset => alFolderTeam() ? asset.team_folder_id : asset.folder_id;
const alManageTeamFolders = () => !alFolderTeam() || canvasTeams.some(t=>t.id===alFolderTeam() && t.managed);

function alRenderFolders() {
  const folders = alFolderList(), managed = alManageTeamFolders();
  const tabs = [{id:'all',name:'全部文件夹'},{id:'none',name:'未归档'},...folders];
  $("#alFolders").innerHTML=tabs.map(f=>`<button type="button" data-folder="${esc(f.id)}" aria-pressed="${AL.folder===f.id}">${esc(f.name)}</button>`).join("");
  const selected = folders.some(f=>f.id===AL.folder);
  $("#alNewFolder").hidden = !managed;
  $("#alRenameFolder").hidden = $("#alDeleteFolder").hidden = !selected || !managed;
  $("#alFileActions").hidden = !AL.filing;
  $("#alFileMode").setAttribute("aria-pressed",String(AL.filing));
  $("#alSelectedCount").textContent = `已选 ${AL.marked.size} 项`;
  const target = $("#alTargetFolder"), previous = target.value;
  target.innerHTML = '<option value="" disabled>选择目标</option><option value="none">移回未归档</option>' +
    folders.map(f=>`<option value="${esc(f.id)}">${esc(f.name)}</option>`).join("");
  target.value = tabs.some(f=>f.id===previous) ? previous : "";
  const items=AL.items.filter(item=>AL.marked.has(item.id));
  const busy=!!(AL.folderBusy||AL.batchBusy);
  $("#alApplyFolder").disabled = !items.length || !target.value || busy ||
    !managed && items.some(item=>item.owner!==ME_USER?.id);
  $("#alApplyBatch").disabled = busy || !items.length || !canvasCanEdit();
  $("#alDownloadBatch").disabled = busy || !items.some(libraryPrimary);
}

async function alFolderChange(action) {
  if (AL.folderBusy) return;
  const bid=boardId;
  AL.folderBusy=true; alRenderFolders();
  try {
    await action();
    if (bid === boardId && AL.open) await alRefresh();
  } catch (error) { if(bid===boardId)toast(error.message,4500); }
  finally { AL.folderBusy=false; if(AL.open)alRenderFolders(); }
}

function alFolderEditor(mode) {
  if (!alManageTeamFolders()) return;
  const folder=alFolderList().find(f=>f.id===AL.folder), host=$("#alFolderEditor");
  if (mode!=="create" && !folder) return;
  if (mode==="delete") {
    host.innerHTML=OneShotI18n.html`<span>删除「${esc(folder.name)}」后，其中的资产会回到未归档。</span><button type="button" data-confirm>删除文件夹</button><button type="button" data-cancel>取消</button>`;
    $("[data-confirm]",host).onclick=()=>alFolderChange(async()=>{await boardRequest(alFolderURL(folder.id),"DELETE");AL.folder="all";host.replaceChildren();});
  } else {
    host.innerHTML=OneShotI18n.html`<form><input aria-label="文件夹名称" maxlength="60" required value="${esc(mode==="rename"?folder.name:"")}"><button type="submit">保存</button><button type="button" data-cancel>取消</button></form>`;
    const input=$("input",host);input.focus();input.select();
    $("form",host).onsubmit=e=>{
      e.preventDefault();
      alFolderChange(async()=>{
        const row=await boardRequest(alFolderURL(mode==="rename"?folder.id:""),mode==="rename"?"PATCH":"POST",{name:input.value});
        AL.folder=row.id;AL.marked.clear();host.replaceChildren();
      });
    };
  }
  $("[data-cancel]",host).onclick=()=>host.replaceChildren();
}
