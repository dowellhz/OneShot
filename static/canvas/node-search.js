"use strict";

function nodeSearchContent(n) {
  const data = n.data || {};
  const lines = value => Array.isArray(value) ? value : [value];
  const shots = (Array.isArray(data.shots) ? data.shots : []).filter(Boolean)
    .flatMap(s => [s.scene, s.camera, s.shot_size, s.keyframe,
      ...lines(s.action), ...lines(s.dialogue), ...lines(s.characters)]);
  return [data.text, data.title, data.style, data.prompt, data.caption,
    ...Object.values(data.fields || {}), ...shots]
    .filter(v => typeof v === "string" && v.trim()).join(" · ");
}

function nodeSearchHighlight(element) {
  if(!element)return;
  clearTimeout(element._searchHighlight);
  element.classList.add("ns-located");
  element._searchHighlight=setTimeout(()=>element.classList.remove("ns-located"),1400);
}

function initNodeSearch() {
  const trigger = $("#nodeSearchBtn");
  const panel = document.createElement("dialog");
  panel.id = "nodeSearch";
  panel.setAttribute("aria-labelledby", "nodeSearchTitle");
  panel.innerHTML = OneShotI18n.html`<header><h2 id="nodeSearchTitle">搜索画布节点</h2><button type="button" class="pill" data-close>关闭</button></header>
    <input type="search" aria-label="搜索节点名称和内容" placeholder="搜索节点名称、内容或提示词">
    <select class="pill ns-status" aria-label="按节点状态筛选">
      <option value="">全部状态</option><option value="marked">已标记</option><option value="locked">已锁定</option>
      <optgroup label="标记颜色">${[...NODE_PINS].map(([key,label]) => `<option value="${key}">${label}</option>`).join("")}</optgroup>
    </select>
    <div class="ns-filters" aria-label="节点类型"></div><ol aria-label="搜索结果"></ol>
    <footer><output aria-live="polite"></output><button class="pill" type="button" data-locate disabled>定位所选节点</button></footer>`;
  document.body.append(panel);
  const input = $("input", panel), list = $("ol", panel), count = $("output", panel), locate = $("[data-locate]", panel);
  const filters = $(".ns-filters", panel), status = $(".ns-status",panel);
  const chosen = new Set();
  let type = "", sourceBoard = null, returnFocus=trigger;

  function close() {
    if (panel.close) panel.close(); else panel.removeAttribute("open");
    (returnFocus.isConnected?returnFocus:trigger).focus();
  }
  function focusNodes(ids) {
    if (sourceBoard !== boardId) return close();
    const found = ids.map(node).filter(Boolean);
    if (!found.length) return;
    close();
    sel = new Set(found.map(n => n.id));
    selEdge = null;
    updateSel();
    fit(found);
    for(const n of found)nodeSearchHighlight(els.get(n.id));
  }
  function focusGroup(id) {
    if(sourceBoard!==boardId)return close();
    const group=(B.groups||[]).find(g=>g.id===id);
    const members=group?.nodes.map(node).filter(Boolean);
    if(!members?.length)return;
    close();
    fit(members);
    nodeSearchHighlight(CT_GROUPS.get(id));
  }
  function renderSearch() {
    const query = input.value.trim().toLocaleLowerCase();
    const words = query.split(/\s+/).filter(Boolean);
    const counts = {};
    const rows = [];
    const nodesById=new Map(B.nodes.map(n=>[n.id,n]));
    const groups=(B.groups||[]).filter(g=>g.nodes.some(id=>nodesById.has(id)));
    const groupNames=new Map();
    for(const group of groups)for(const id of group.nodes){
      if(!groupNames.has(id))groupNames.set(id,[]);
      groupNames.get(id).push(group.name);
    }
    function addRow(title,kind,content,extra) {
      const name=title.toLocaleLowerCase();
      const body = content.toLocaleLowerCase();
      if (!words.every(word => name.includes(word) || body.includes(word))) return;
      counts[kind]=(counts[kind]||0)+1;
      if(type && kind!==type)return;
      const match = words.length ? body.indexOf(words.find(word => body.includes(word)) || query) : -1;
      const start = Math.max(0, match - 30);
      rows.push({title,kind,...extra,rank:query && name.startsWith(query) ? 0 : words.some(word => name.includes(word)) ? 1 : 2,
        excerpt:(start ? "…" : "") + content.slice(start, start + 120) + (content.length > start + 120 ? "…" : "")});
    }
    for (const n of B.nodes) {
      const colors=nodePins(n);
      if(!matchesStatus(n,colors))continue;
      const title=n.name||TYPE_CN[n.type]||"节点", metadata=(groupNames.get(n.id)||[]).join(" · ");
      const content=[nodeSearchContent(n),metadata].filter(Boolean).join(" · ");
      const versions=n.versions||[];
      const versionTexts=versions.map(v=>[v?.label,v?.prompt,v?.generation_record?.prompt].filter(Boolean).join(" · "));
      const current=[title,content,versionTexts[n.cur]].join(" ").toLocaleLowerCase();
      const version=words.length && !words.every(word=>current.includes(word))
        ? versionTexts.findIndex((line,i)=>i!==n.cur&&versions[i]?.ref&&versions[i].url&&
            words.every(word=>(current+" "+line.toLocaleLowerCase()).includes(word)))
        : -1;
      addRow(title,n.type,[content,...versionTexts].filter(Boolean).join(" · "),{n,colors,version,metadata});
    }
    if(!status.value)for(const group of groups)addRow(group.name||"分组","group",
      group.nodes.map(id=>nodesById.get(id)?.name).filter(Boolean).join(" · "),{group});
    rows.sort((a,b) => a.rank - b.rank);
    filters.replaceChildren(...[["","全部"], ...Object.entries(TYPE_CN),["group","分组"]].map(([value,label]) => {
      const button = document.createElement("button");
      button.type = "button"; button.className = "pill";
      button.textContent = `${label} ${value ? counts[value] || 0 : Object.values(counts).reduce((total,n)=>total+n,0)}`;
      button.setAttribute("aria-pressed", String(type === value));
      button.onclick = () => { type = value; renderSearch(); input.focus(); };
      return button;
    }));
    list.replaceChildren(...rows.slice(0, 100).map(({n,group,title,kind,colors=[],excerpt,version,metadata}) => {
      const row=document.createElement("li"),open=document.createElement("button");
      if(n){
        const check=document.createElement("input");
        check.type="checkbox";check.checked=chosen.has(n.id);
        check.setAttribute("aria-label",`选择 ${title}`);
        check.onchange=()=>{if(check.checked)chosen.add(n.id);else chosen.delete(n.id);updateCount(rows.length);};
        row.append(check);
      }
      open.type = "button";
      const name = document.createElement("strong"), detail = document.createElement("span");
      name.textContent = title;
      detail.textContent = [group?"分组":TYPE_CN[kind],metadata,colors.length&&colors.map(c=>NODE_PINS.get(c)).join("、")+"标记",n&&nodeLocked(n)&&"已锁定",version>=0&&`匹配版本 ${version+1}`,excerpt]
        .filter(Boolean).join(" · ");
      for (const color of colors) {
        const dot = document.createElement("span");
        dot.className = "node-pin"; dot.dataset.color = color;
        dot.setAttribute("aria-hidden","true");
        name.append(" ",dot);
      }
      open.append(name, detail);
      open.dataset.nsOpen="";
      open.onclick = () => group?focusGroup(group.id):focusNodes([n.id]);
      row.append(open);
      if(version>=0){
        const preview=document.createElement("button");
        preview.type="button";preview.className="pill ns-preview";preview.textContent="预览匹配版本";
        const ref=n.versions[version].ref;
        preview.onclick=()=>{
          if(sourceBoard!==boardId)return close();
          const found=vtResolve(n.id,ref);
          if(!found)return toast("找到的历史版本已移除");
          close();
          lightbox(found.node.versions[found.index],found.node);
        };
        row.append(preview);
      }
      return row;
    }));
    updateCount(rows.length);
  }
  function matchesStatus(n,colors) {
    if (!status.value) return true;
    if (status.value === "locked") return nodeLocked(n);
    if (status.value === "marked") return !!colors.length;
    return colors.includes(status.value);
  }
  function updateCount(total) {
    locate.disabled = chosen.size === 0;
    count.textContent = (total ? `${total > 100 ? "显示前 100 项 · " : ""}${total} 个结果` : "没有匹配的节点")+
      (chosen.size?` · 已选 ${chosen.size} 个`:"");
  }
  function open(filter="",focus=trigger) {
    if (panel.open || !boardId || !B) return;
    sourceBoard = boardId;
    returnFocus=focus;
    type = ""; chosen.clear(); input.value = ""; status.value = filter;
    renderSearch();
    if (panel.showModal) panel.showModal(); else panel.setAttribute("open", "");
    input.focus();
  }
  trigger.onclick = () => open();
  $("#nodePinBar").onclick=e=>{
    const button=e.target.closest("button[data-pin-color]");
    if(button)open(button.dataset.pinColor,button);
  };
  locate.onclick = () => focusNodes([...chosen]);
  $("[data-close]", panel).onclick = close;
  input.oninput = renderSearch;
  status.onchange = renderSearch;
  function escapeSearch() {
    if(!input.value)return close();
    input.value="";renderSearch();input.focus();
  }
  panel.addEventListener("cancel", e => { e.preventDefault(); escapeSearch(); });
  panel.addEventListener("keydown", e => {
    e.stopPropagation();
    if(e.isComposing)return;
    if (e.key === "Escape") { e.preventDefault(); escapeSearch(); }
    if(["ArrowDown","ArrowUp"].includes(e.key) && (e.target===input||e.target.closest("[data-ns-open]"))){
      const results=$$("[data-ns-open]",list);
      if(!results.length)return;
      e.preventDefault();
      const index=results.indexOf(e.target), up=e.key==="ArrowUp";
      if(index===0&&up || index===results.length-1&&!up)input.focus();
      else results[index<0?(up?results.length-1:0):index+(up?-1:1)].focus();
    }
    if (e.target === input && e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      if (chosen.size) locate.click(); else $("[data-ns-open]",list)?.click();
    }
  });
  addEventListener("keydown", e => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && !e.isComposing && ["f","k"].includes(e.key.toLowerCase()) &&
        !e.target.closest?.("input,textarea,select,[contenteditable]:not([contenteditable=false]),#agentChat") &&
        !document.querySelector("dialog[open], #film.on, #wiz.on, #assetLibrary:not([hidden]), #pv.on, #settings.on, .playlist-picking")) {
      e.preventDefault();
      open();
    }
  });
}
