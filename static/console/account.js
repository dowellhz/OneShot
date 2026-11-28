"use strict";
// Accounts and services on the canvas: login redirect, the console link, and the per-node 服务 picker
// (which provider runs this image / video: the default route, local H3, or a third-party API).

(() => {   // any 401 from the server means the session ended: go to the login page and come back
  const f = window.fetch.bind(window);
  window.fetch = async (...a) => {
    const r = await f(...a);
    if (r.status === 401 && !String(a[0]).startsWith("/api/auth/")) location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search);
    return r;
  };
})();

let CAPS_LIST = { image: [], video: [] };
let ME_USER = null;
let capabilityRequest = null, capabilitySignature = "", capabilityPanelDirty = false;
function refreshCapabilityPanel() {
  const panel = $("#pp"), active = document.activeElement;
  if (!capabilityPanelDirty || !panel.classList.contains("on") ||
      (panel.contains(active) && active.matches("input,textarea,select"))) return;
  capabilityPanelDirty = false;
  showPanel();
}
function loadCaps() {
  if (capabilityRequest) return capabilityRequest;
  capabilityRequest = (async () => {
    try {
      const response = await fetch("/api/capabilities", {cache:"no-store"});
      if (!response.ok) return CAPS_LIST;
      const capabilities = await response.json();
      const signature = JSON.stringify(capabilities);
      CAPS_LIST = capabilities;
      if (signature !== capabilitySignature) {
        capabilitySignature = signature;
        capabilityPanelDirty = true;
        refreshCapabilityPanel();
      }
    } catch {}
    return CAPS_LIST;
  })().finally(()=>{capabilityRequest=null;});
  return capabilityRequest;
}

// Select a default only when the node has no explicit service.
function nodeProvider(n) {
  const cap = n.type === "image" ? "image" : "video", list = CAPS_LIST[cap] || [];
  return n.data.provider ? list.find(x=>x.id===n.data.provider) || null : list.find(x=>x.default) || list[0] || null;
}
const isRemote = n => { const p = nodeProvider(n); return !!p && !p.local; };
function provPill(n, pill) {
  const cap = n.type === "image" ? "image" : "video", list = CAPS_LIST[cap] || [];
  const def = list.find(x => x.default) || list[0], cur = nodeProvider(n);
  const unavailable = n.data.provider && !cur;
  const tr = OneShotI18n.t;
  const providerName = p => p?.id === "local_h3" && p.name === "本地 H3" ? tr(p.name) : p?.name;
  const previous = versionGenerationModel(curV(n),n.type);
  const missingName = previous && previous.provider===n.data.provider ? previous.label : n.data.provider;
  const opts = { "": def ? tr("默认：{name}", {name:providerName(def)}) : tr("默认服务") };
  list.forEach(x => opts[x.id] = esc(x.local ? tr("{name}（本地，免费）", {name:providerName(x)}) : x.name));
  if (unavailable) opts[n.data.provider] = esc(tr("{name}（不可用）", {name:missingName}));
  opts[""] = esc(opts[""]);
  return pill("provider", opts, `<span class="dot" style="background:${cur && !cur.local ? "#b9b9c2" : "#d6d6dc"}"></span>${esc(unavailable?tr("{name}（不可用）",{name:missingName}):providerName(cur) || tr("服务"))}${ico("down")}`, "model");
}

function canvasNodeModel(n, service, reference = false) {
  if (n.data.selected_model) {
    return service?.models?.find(model => model.id === n.data.selected_model);
  }
  if (!service) return null;
  const id = reference || n.data.provider ? service.model : service.default_route_model || service.model;
  return service.models?.find(model => model.id === id) || {id,draft:service.draft};
}

function nodeModelPill(n, pill, service = nodeProvider(n), reference = false) {
  const options = service?.models || [];
  if (!service || (service.local && options.length < 2 && !n.data.selected_model) ||
      (n.data.selected_model && n.data.provider && n.data.provider!==service.id)) return "";
  const model = canvasNodeModel(n,service,reference);
  const fallback = reference || n.data.provider ? service.model : service.default_route_model || service.model;
  const name = item => item.label || (item.endpoint_model ? item.id+" · "+item.endpoint_model : item.id);
  const tr = OneShotI18n.t;
  const title = model?.id ? name(model) : n.data.selected_model ? tr("{name}（不可用）",{name:n.data.selected_model}) : tr("重新选择模型");
  if (!n.data.selected_model && options.length < 2) return model?.id ? `<span class="pill" title="${esc(title)}">${esc(title)}</span>` : "";
  const defaultName = options.find(item=>item.id===fallback);
  const choices = Object.fromEntries([["",esc(fallback ? tr("默认 · {name}", {name:defaultName ? name(defaultName) : fallback}) : tr("默认模型"))],
    ...options.filter(item => !service.local || item.id !== fallback || item.id === n.data.selected_model).map(item => [item.id,esc(name(item))])]);
  if (n.data.selected_model && !model) choices[n.data.selected_model] = esc(tr("{name}（不可用）", {name:n.data.selected_model}));
  return pill("selected_model", choices, esc(title)+ico("down"), "model", n.data.selected_model || "");
}

function initAccount() {
  fetch("/api/me").then(r => r.ok ? r.json() : null).then(u => {
    if (!u) return;
    ME_USER = u;
    $("#canvasMoreActions").insertAdjacentHTML("beforeend", OneShotI18n.html`<a href="/console" id="consoleLink">${ico("console")}<span>控制台</span></a>`);
    $("#canvasTopAccount").textContent = u.name || u.username;
  });
  loadCaps();
  window.addEventListener("focus",loadCaps);
  $("#pp").addEventListener("focusout",()=>queueMicrotask(refreshCapabilityPanel));
  setInterval(loadCaps, 60000);
}
