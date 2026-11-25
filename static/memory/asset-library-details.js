"use strict";

async function alSelect(a) {
  if (CM.editor?.dataset.busy === 'true') return toast('正在保存或上传，请稍等');
  const bid = boardId;
  AL.selected=a.id; alRender(); await cmEdit(a, a.kind, {host:$('#alDetail'), readonly:!alEditable(a)});
  if (!AL.open || AL.selected !== a.id || bid !== boardId) return;
  const fields=$('.cm-fields',$('#alDetail'));
  if (fields) alAssetActions(fields,a,bid);
  if (a.kind === 'character') alImpact(a);
}

function alAssetActions(fields, asset, bid) {
  $('.al-asset-actions',fields)?.remove();
  const route = '/api/memory/'+encodeURIComponent(asset.id);
  const actions = document.createElement('div');
  actions.className = 'al-asset-actions';
  actions.innerHTML = OneShotI18n.html`<button type="button">复制到个人库</button><a download>下载素材包</a>`;
  const button = $('button',actions);
  $('a',actions).href = route+'/download?'+new URLSearchParams({board:bid});
  let attempt;
  button.onclick = async()=>{
    if (button.disabled || CM.editor?.dataset.busy === 'true') return;
    attempt ||= crypto.randomUUID?.() || "asset-copy-"+Date.now()+Math.random().toString(36).slice(2);
    button.disabled = true;
    try {
      const copied = await boardRequest(route+'/duplicate','POST',{board:bid,request_key:attempt});
      attempt = null;
      if (!AL.open || bid!==boardId) return;
      AL.scope = $('#alScope').value = 'personal';
      AL.folder = 'all';
      AL.query = $('#alSearch').value = '';
      AL.marked.clear();
      alChanged(copied);
      await alRefresh();
      if (!AL.open || bid!==boardId || AL.scope!=='personal') return;
      await alSelect(copied);
      toast('已复制到个人素材库');
    } catch (error) {
      if (bid===boardId) toast(error.message);
    } finally { button.disabled = false; }
  };
  fields.prepend(actions);
}
function alImpact(asset) {
  const host = $("#alDetail");
  $(".al-impact", host)?.remove();
  const section = document.createElement("details");
  section.className = "al-impact";
  section.innerHTML = `<summary>参考图更新影响</summary><div><output aria-live="polite"></output><ul></ul><button type="button" hidden>用当前参考图重做所选预览</button></div>`;
  host.append(section);
  const status = $("output", section), list = $("ul", section), redo = $("button", section);
  section.ontoggle = async () => {
    if (!section.open || !section.isConnected) return;
    const bid = boardId;
    list.replaceChildren(); redo.hidden = true; status.textContent = "正在检查有权限的项目…";
    try {
      await flushSave();
      const response = await fetch(`/api/memory/${encodeURIComponent(asset.id)}/impact?board=${encodeURIComponent(bid)}&all=1`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "无法读取参考图影响");
      if (boardId !== bid || !section.isConnected) return;
      status.textContent = result.canvas.length || result.remake.length ? "这些版本使用的参考图已更新或需要重新定稿。" : "可访问的项目没有受影响的版本。";
      const chosen = [];
      const show = (entry, label, remake) => {
        const li = document.createElement("li"), button = document.createElement("button");
        button.type = "button"; button.textContent = label;
        button.onclick = async () => {
          if (entry.board && entry.board !== boardId) {
            alClose();
            await openBoard(entry.board);
            if (boardId !== entry.board) return;
          }
          const target = vtResolve(entry.node, entry.ref);
          if (!target) return toast("原版本已不存在");
          if (target.node.cur !== target.index && !switchVersion(target.node, target.index)) return;
          alClose(); selectOnly(target.node.id); fit([target.node]);
          if (remake) openVideoRemake(target.node, {shotStart:entry.start});
        };
        if (entry.person) {
          const check = document.createElement("input");
          check.type = "checkbox"; check.setAttribute("aria-label", `重做${label}`);
          chosen.push([entry, check]); li.append(check);
        }
        li.append(button); list.append(li);
      };
      const label = e => [e.project, e.name].filter(Boolean).join(" · ");
      result.remake.forEach(entry => show(entry, `${label(entry)} · 镜头 ${entry.shot + 1}`, true));
      result.canvas.forEach(entry => {
        const views = (entry.views || []).map(change=>`${CHARACTER_VIEWS[change.view]?.[0] || "默认参考图"}${change.reference ? "" : "待定稿"}`);
        show(entry, [label(entry),`版本 ${entry.version}`,...views].join(" · "), false);
      });
      redo.hidden = !chosen.length;
      redo.onclick = async () => {
        const selected = chosen.filter(([, check]) => check.checked).map(([entry]) => entry);
        if (!selected.length) { status.textContent = "请先勾选要重做的镜头"; return; }
        const groups = new Map(), messages = [];
        for (const entry of selected) {
          const key = JSON.stringify([entry.board, entry.node, entry.ref, entry.revision, entry.person]);
          const group = groups.get(key) || [];
          group.push(entry); groups.set(key, group);
        }
        redo.disabled = true;
        try {
          for (const entries of groups.values()) {
            if (boardId !== bid) throw new Error("画布已切换");
            const {board:project,node,ref,revision,person} = entries[0];
            const state = await remakeRequest(`/api/video-remake/${encodeURIComponent(project || bid)}/${encodeURIComponent(node)}?source=${encodeURIComponent(ref)}`, {
              action:"batch_previews", cut_revision:revision, asset:asset.id, person,
              shots:entries.map(e => ({shot:e.shot, frame:e.frame, view:e.view, reference:e.reference})),
            });
            const result = state.batch_previews;
            messages.push(`${entries[0].project || ""} 已提交 ${result.submitted.length} 镜 · 跳过 ${result.skipped.length} 镜`, ...result.failed.map(f => `镜头 ${f.shot + 1} ${f.error}`));
          }
          status.textContent = messages.join("。") + "。旧版仍可继续使用。";
        } catch (error) { status.textContent = [...messages,error.message].join("。"); }
        finally { redo.disabled = false; }
      };
    } catch (error) { status.textContent = error.message; }
  };
}
