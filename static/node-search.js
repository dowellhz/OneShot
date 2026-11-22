"use strict";

function nodeSearchContent(n) {
  const data = n.data || {};
  const lines = value => Array.isArray(value) ? value : [value];
  const shots = (Array.isArray(data.shots) ? data.shots : []).filter(Boolean)
    .flatMap(s => [s.scene, s.camera, s.shot_size, s.keyframe,
      ...lines(s.action), ...lines(s.dialogue), ...lines(s.characters)]);
  return [data.text, data.title, data.style, data.prompt, data.caption,
    ...Object.values(data.fields || {}), ...shots,
    ...(n.versions || []).filter(Boolean).flatMap(v => [v.label, v.prompt])]
    .filter(v => typeof v === "string" && v.trim()).join(" · ");
}

function initNodeSearch() {
  const trigger = $("#nodeSearchBtn");
  const panel = document.createElement("dialog");
  panel.id = "nodeSearch";
  panel.setAttribute("aria-labelledby", "nodeSearchTitle");
  panel.innerHTML = `<header><h2 id="nodeSearchTitle">搜索画布节点</h2><button type="button" class="pill" data-close>关闭</button></header>
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
  let type = "", sourceBoard = null;

  function close() {
    if (panel.close) panel.close(); else panel.removeAttribute("open");
    trigger.focus();
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
  }
  function renderSearch() {
    const query = input.value.trim().toLocaleLowerCase();
    const words = query.split(/\s+/).filter(Boolean);
    const counts = {};
    const rows = [];
    for (const n of B.nodes) {
      const color = NODE_PINS.get(n.pin);
      if (!matchesStatus(n,color)) continue;
      counts[n.type] = (counts[n.type] || 0) + 1;
      if (type && n.type !== type) continue;
      const content = nodeSearchContent(n);
      const title = n.name || TYPE_CN[n.type];
      const name = title.toLocaleLowerCase();
      const body = content.toLocaleLowerCase();
      if (!words.every(word => name.includes(word) || body.includes(word))) continue;
      const match = words.length ? body.indexOf(words.find(word => body.includes(word)) || query) : -1;
      const start = Math.max(0, match - 30);
      rows.push({n, title, color, rank:query && name.startsWith(query) ? 0 : words.some(word => name.includes(word)) ? 1 : 2,
        excerpt:(start ? "…" : "") + content.slice(start, start + 120) + (content.length > start + 120 ? "…" : "")});
    }
    rows.sort((a,b) => a.rank - b.rank);
    filters.replaceChildren(...[["","全部"], ...Object.entries(TYPE_CN)].map(([value,label]) => {
      const button = document.createElement("button");
      button.type = "button"; button.className = "pill";
      button.textContent = `${label} ${value ? counts[value] || 0 : Object.values(counts).reduce((total,n)=>total+n,0)}`;
      button.setAttribute("aria-pressed", String(type === value));
      button.onclick = () => { type = value; renderSearch(); input.focus(); };
      return button;
    }));
    list.replaceChildren(...rows.slice(0, 100).map(({n,title,color,excerpt}) => {
      const row = document.createElement("li"), open = document.createElement("button"), check = document.createElement("input");
      check.type = "checkbox"; check.checked = chosen.has(n.id);
      check.setAttribute("aria-label", `选择 ${title}`);
      check.onchange = () => { if (check.checked) chosen.add(n.id); else chosen.delete(n.id); updateCount(rows.length); };
      open.type = "button";
      const name = document.createElement("strong"), detail = document.createElement("span");
      name.textContent = title;
      detail.textContent = [TYPE_CN[n.type], color && color+"标记", nodeLocked(n) && "已锁定", excerpt].filter(Boolean).join(" · ");
      if (color) {
        const dot = document.createElement("span");
        dot.className = "node-pin"; dot.dataset.color = n.pin;
        dot.setAttribute("aria-hidden","true");
        name.append(" ",dot);
      }
      open.append(name, detail);
      open.onclick = () => focusNodes([n.id]);
      row.append(check, open);
      return row;
    }));
    updateCount(rows.length);
  }
  function matchesStatus(n,color) {
    if (!status.value) return true;
    if (status.value === "locked") return nodeLocked(n);
    if (status.value === "marked") return !!color;
    return n.pin === status.value;
  }
  function updateCount(total) {
    locate.disabled = chosen.size === 0;
    count.textContent = total ? `${total > 100 ? "显示前 100 项 · " : ""}${total} 个结果${chosen.size ? ` · 已选 ${chosen.size} 个` : ""}` : "没有匹配的节点";
  }
  function open() {
    if (panel.open || !boardId || !B) return;
    sourceBoard = boardId;
    type = ""; chosen.clear(); input.value = ""; status.value = "";
    renderSearch();
    if (panel.showModal) panel.showModal(); else panel.setAttribute("open", "");
    input.focus();
  }
  trigger.onclick = open;
  locate.onclick = () => focusNodes([...chosen]);
  $("[data-close]", panel).onclick = close;
  input.oninput = renderSearch;
  status.onchange = renderSearch;
  panel.addEventListener("cancel", e => { e.preventDefault(); close(); });
  panel.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); close(); }
    if (e.target === input && e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      if (chosen.size) locate.click(); else $("li button", list)?.click();
    }
  });
  addEventListener("keydown", e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" &&
        !document.querySelector("dialog[open], #film.on, #wiz.on, #assetLibrary:not([hidden]), #pv.on, #settings.on")) {
      e.preventDefault();
      open();
    }
  });
}
