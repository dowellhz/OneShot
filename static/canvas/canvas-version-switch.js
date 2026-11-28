"use strict";

// Media versions stay in one node; video versions also retain their input graph and settings.
function rememberVideoVersion(n) {
  const v = curV(n); if (n.type !== "video" || !v) return;
  if (!Array.isArray(v.input_edges)) v.input_edges = JSON.parse(JSON.stringify(B.edges.filter(e => e.to === n.id)));
  if (!v.node_data) v.node_data = JSON.parse(JSON.stringify(n.data));
}
function validVideoInput(edge) {
  const type = node(edge.from)?.type;
  return type === "image" || type === "text" || (type === "audio" && edge.relation === "audio_ref") ||
    (type === "video" && ["remake", "previs", "video_ref", "trim", "draft_final"].includes(edge.relation));
}
function switchVersion(n, i, {recordUndo = true} = {}) {
  if (!Number.isInteger(i) || !n.versions[i] || i === n.cur) return false;
  if (n.job || prepping.has(n.id) || (IMAGE_EDITOR?.n === n && (IMAGE_EDITOR.busy || IMAGE_EDITOR.agentSelection))) { toast(OneShotI18n.t("请等待当前任务完成后再切换版本")); return false; }
  if (recordUndo) checkpoint();
  rememberVideoVersion(n);
  const v = n.versions[i];
  if (n.type === "video") {
    const snapshot = v.video_recipe && (!v.node_data || !Array.isArray(v.input_edges)) ? vtSnapshot(n,i) : v;
    if (Array.isArray(snapshot.input_edges)) {
      const edges = vtEdgesWithReferenceRanges(snapshot.input_edges,snapshot.video_recipe)
        .filter(e => e.to === n.id && e.from !== n.id && validVideoInput(e));
      B.edges = B.edges.filter(e => e.to !== n.id).concat(JSON.parse(JSON.stringify(edges)));
      if (edges.length !== snapshot.input_edges.length) toast("部分历史输入节点已删除，已恢复仍存在的连线");
    }
    if (snapshot.node_data) n.data = JSON.parse(JSON.stringify(snapshot.node_data));
    else if(v.video_recipe?.video_optics)n.data.video_optics=structuredClone(v.video_recipe.video_optics);
    else delete n.data.video_optics;
    vtRestoreVideoModel(n.data,v);
    const prompt = v.generation_record?.prompt ?? v.prompt;
    if (!snapshot.node_data && versionGenerationModel(v,n.type) && typeof prompt==="string") n.data.prompt = prompt;
  }
  if (n.type === "audio") {
    if (v.audio_recipe) Object.assign(n.data,{...defaults("audio"),...v.audio_recipe});
    else if (isSeedAudio(n)) n.data.references=[];
  }
  if (n.type === "image") {
    if (v.node_data?.model) n.data.model = v.node_data.model;
    if (v.generation_record?.settings?.model) n.data.model = v.generation_record.settings.model;
    restoreVersionGenerationModel(n.data,v,"image");
    const prompt = v.node_data?.prompt ?? v.generation_record?.prompt ?? v.prompt;
    if (versionGenerationModel(v,n.type) && typeof prompt==="string") n.data.prompt = prompt;
  }
  delete n.data.model_selection_ref;
  if ($("#prompt")._node===n.id) $("#prompt")._node=null;
  n.cur = i; save(); render(n); refreshDownstream(n); if (sel.size === 1 && sel.has(n.id)) showPanel(); drawEdges();
  if (AC.open) acRenderRefs();
  return true;
}
function renderVTabs(n, el) {
  let t = $(".vtabs", el);
  if (!["image", "video", "audio"].includes(n.type) || n.versions.length < 2) { t?.remove(); return; }
  if (!t) {
    t = document.createElement("div"); t.className = "vtabs"; el.appendChild(t);
    t.setAttribute("role", "tablist"); t.setAttribute("aria-label", OneShotI18n.t("历史版本")); t.setAttribute("aria-orientation", "vertical");
    t.addEventListener("pointerdown", e => e.stopPropagation());
    t.addEventListener("dblclick", e => e.stopPropagation());
  }
  const previousTab=$(".on",t)?.dataset.i, scrollTop=t.scrollTop;
  const focusedTab=t.contains(document.activeElement)?document.activeElement.dataset.i:null;
  t.innerHTML = n.versions.map((v, i) => {
    const tip = [`版本 ${i + 1}`, v.label, versionGenerationModel(v,n.type)?.label || v.mode, v.seconds ? v.seconds.toFixed(1) + "s" : "", v.seed != null ? "seed " + v.seed : ""].filter(Boolean).join(" · ");
    const thumbnail=n.type==="image"&&v.url
      ? `<img src="${esc(v.url)}" alt="" loading="lazy" draggable="false">`
      : ico(n.type);
    return `<button role="tab" aria-selected="${i === n.cur}" aria-label="版本 ${i + 1}" data-i="${i}" tabindex="${i===n.cur?0:-1}" class="${i === n.cur ? "on" : ""}" title="${esc(tip)}" ${n.job ? "disabled" : ""}>
      <span class="vt-thumb" aria-hidden="true">${thumbnail}</span><span class="vt-number">${i + 1}</span></button>`;
  }).join("");
  $$("button",t).forEach(button=>vtWireTab(button,n));
  const active=$(".on",t);
  t.scrollTop=scrollTop;
  if(active && previousTab!==active.dataset.i){
    const top=active.offsetTop,bottom=top+active.offsetHeight;
    if(top<t.scrollTop)t.scrollTop=top;
    else if(bottom>t.scrollTop+t.clientHeight)t.scrollTop=bottom-t.clientHeight;
  }
  if(focusedTab!=null){
    const focus=previousTab===active?.dataset.i?$('[data-i="'+focusedTab+'"]',t):active;
    focus?.focus({preventScroll:true});
  }
}
