"use strict";

function dragLink(a, e, onClick) {
  e.currentTarget.setPointerCapture(e.pointerId);
  const tmp = document.createElementNS("http://www.w3.org/2000/svg", "path"); tmp.setAttribute("class", "tmp"); svg.appendChild(tmp);
  const p0 = port(a, "out"), sx = e.clientX, sy = e.clientY; let moved = false;
  const targets = B.nodes.filter(m => m.id !== a.id && !ctFolded(m.id));
  let last = e; const ap = autoPan(() => mv(last));
  const mv = ev => {
    last = ev;
    if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 4) return;
    if (!moved) { moved = true; targets.forEach(m => els.get(m.id).classList.add(canLink(a, m) ? "ok-target" : "bad-target")); }
    ap.move(ev);
    tmp.setAttribute("d", curve(p0, toW(ev.clientX, ev.clientY)));
  };
  const stop = () => {
    ap.stop(); removeEventListener("pointermove", mv); removeEventListener("pointerup", up); tmp.remove();
    removeEventListener("pointercancel", stop);
    targets.forEach(m => els.get(m.id)?.classList.remove("ok-target", "bad-target"));
  };
  const up = ev => {
    stop();
    if (!moved) { onClick && onClick(); return; }
    const t = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".node");
    if (t) link(a, node(t.dataset.id));
    else { const w = toW(ev.clientX, ev.clientY); openAddMenu(ev.clientX, ev.clientY, { from: a, at: w }); }
  };
  addEventListener("pointermove", mv); addEventListener("pointerup", up); addEventListener("pointercancel", stop);
}

// ================================================================= edges
function port(n, side) {
  const group = ctFolded(n.id), folded = group && CT_FOLD_BOXES.get(group.id);
  const {x,y,w,h} = folded || {x:n.x,y:n.y,...size(n)};
  return {x:side === "out" ? x+w : x,y:y+h/2};
}
function curve(a, b) { const dx = Math.max(50, Math.abs(b.x - a.x) * 0.45); return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`; }

function edgeDescription(edge,source,target,relation) {
  const ref=edge.source_ref||edge.ref;
  const version=ref?source.versions.findIndex(item=>item.ref===ref):-1;
  const binding=ref?(version<0?" · 引用版本已移除":" · 固定版本 "+(version+1)):"";
  return source.name+binding+" → "+target.name+" · "+relation;
}

function edgeInspector(edge,description,a,b) {
  const panel=document.createElement("div");
  panel.className="elabel edge-inspector";
  panel.style.left=(a.x+b.x)/2+"px";
  panel.style.top=(a.y+b.y)/2+28+"px";
  panel.innerHTML=`<span>${esc(description)}</span>`;
  world.appendChild(panel);
  if(!canvasCanEdit())return panel;
  panel.insertAdjacentHTML("beforeend",OneShotI18n.html`<button type="button" data-edge-cut title="点击或向下拖动以断开连线" aria-label="断开所选连线">${ico("scissors")}</button>`);
  const scissors=$("[data-edge-cut]",panel);
  let drag, moved=false;
  panel.onpointerdown=event=>event.stopPropagation();
  scissors.onpointerdown=event=>{
    if(event.button!==0)return;
    drag={id:event.pointerId,x:event.clientX,y:event.clientY};
    moved=false;
    if(Number.isInteger(event.pointerId))scissors.setPointerCapture?.(event.pointerId);
  };
  scissors.onpointermove=event=>{
    if(!drag||event.pointerId!==drag.id)return;
    moved||=Math.hypot(event.clientX-drag.x,event.clientY-drag.y)>6;
    if(moved)scissors.style.transform=`translateY(${Math.max(0,Math.min(38,event.clientY-drag.y))}px)`;
  };
  scissors.onpointerup=scissors.onpointercancel=event=>{
    if(!drag||event.pointerId!==drag.id)return;
    const distance=event.clientY-drag.y, sideways=event.clientX-drag.x;
    moved||=Math.hypot(sideways,distance)>6||event.type==="pointercancel";
    drag=null;
    scissors.style.transform="";
    if(event.type==="pointerup"&&distance>=24&&distance>=Math.abs(sideways))cutEdge(edge);
  };
  scissors.onclick=event=>{
    if(!moved||event.detail===0)cutEdge(edge);
    moved=false;
  };
  return panel;
}

function drawEdges() {
  syncSeedAudioEdges();
  ctRenderGroups();
  drawMini();
  $$("g", svg).forEach(g => g.remove());
  $$(".elabel", world).forEach(x => x.remove());
  const plans = {};
  const foldedEdges = new Map();
  B.edges.forEach(e => {
    const a = node(e.from), b = node(e.to); if (!a || !b) return;
    const fromGroup = ctFolded(a.id), toGroup = ctFolded(b.id);
    if (fromGroup || toGroup) {
      if (fromGroup === toGroup) return;
      const key = JSON.stringify([fromGroup?.id || a.id,toGroup?.id || b.id,!!fromGroup,!!toGroup]);
      if (!foldedEdges.has(key)) foldedEdges.set(key,{a:port(a,"out"),b:port(b,"in"),count:0});
      foldedEdges.get(key).count++;
      return;
    }
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    const pa=port(a,"out"),pb=port(b,"in");
    if (e.relation==="seed_audio_ref") { pa.y+=(e.slot-2)*26; pb.y+=(e.slot-2)*26; }
    const d = curve(pa,pb);
    g.innerHTML = `<path class="hit" d="${d}"></path><path class="vis" d="${d}"></path>`;
    if (selEdge === e) g.classList.add("sel");
    let relation="输入素材";
    if (e.story_continuity || ["remake","previs","audio_ref","video_ref","trim","capture","transcript","audio_cut","broll","seed_audio_ref","draft_final"].includes(e.relation)) {
      g.classList.add("remake-edge");
      const label = document.createElement("div");
      label.className = "elabel remake-label";
      label.style.left = (pa.x + pb.x) / 2 + "px"; label.style.top = (pa.y + pb.y) / 2 + "px";
      const seedLabel = e.relation==="seed_audio_ref" ? (a.type==="image"?"参考图":`@音频${e.slot}`) +
        ` · 版本 ${a.versions.findIndex(v=>v.ref===e.ref)+1}` : "";
      label.textContent = e.story_continuity?"上一镜尾帧":seedLabel || (e.segment_edit ? "修改片段" : e.extension ? extensionLabel(e.extension) : {previs:"白模动作参考",audio_ref:"音频参考",video_ref:"视频参考",remake:"原片",trim:"裁剪自原片",capture:"视频截帧",transcript:"音频转写",audio_cut:"台词剪辑",broll:"B-roll 来源",draft_final:"定稿样片"}[e.relation]);
      relation=label.textContent;
      world.appendChild(label);
    } else if (a.type === "image" && b.type === "video") {
      const p = plans[b.id] || (plans[b.id] = plan(b)), k = p.es.indexOf(e);
      const pa = port(a, "out"), pb = port(b, "in"), lb = document.createElement("div");
      lb.className = "elabel" + (p.roles[k] === "subject" ? " subj" : "");
      lb.style.left = (pa.x + pb.x) / 2 + "px"; lb.style.top = (pa.y + pb.y) / 2 + "px";
      lb.innerHTML = esc(OneShotI18n.t(p.labels[k] || "未使用")) + ` ▾${roleSelect(e)}`;
      relation=p.labels[k]||"未使用";
      world.appendChild(lb); wireRoleSelects(lb);
    }
    const description=edgeDescription(e,a,b,relation), hit=$(".hit",g);
    const title=document.createElementNS("http://www.w3.org/2000/svg","title");
    title.textContent=description;
    hit.appendChild(title);
    hit.setAttribute("role","button");
    hit.setAttribute("aria-label",description);
    hit.setAttribute("tabindex","0");
    if(selEdge===e)edgeInspector(e,description,pa,pb);
    const select=ev=>{
      ev.stopPropagation();selEdge=e;sel.clear();updateSel();drawEdges();
    };
    hit.addEventListener("pointerdown",select);
    hit.addEventListener("keydown",ev=>{
      if(!["Enter"," "].includes(ev.key))return;
      ev.preventDefault();select(ev);
      ($("[data-edge-cut]",world)||$("#edges .sel .hit"))?.focus({preventScroll:true});
    });
    hit.addEventListener("dblclick",ev=>{ev.stopPropagation();cutEdge(e);});
    svg.appendChild(g);
  });
  for (const {a,b,count} of foldedEdges.values()) {
    const g=document.createElementNS("http://www.w3.org/2000/svg","g");
    g.classList.add("folded-edge");
    g.innerHTML=`<path class="vis" d="${curve(a,b)}"></path>`;
    svg.appendChild(g);
    if (count>1) {
      const label=document.createElement("div");
      label.className="elabel folded-edge-count";
      Object.assign(label.style,{left:(a.x+b.x)/2+"px",top:(a.y+b.y)/2+"px"});
      label.textContent=`${count} 条连线`;
      world.appendChild(label);
    }
  }
  refreshScriptContinuity();
}
function cutEdge(e) {
  if (!canvasCanEdit() || !B.edges.includes(e)) return;
  const target=node(e.to);
  if (e.relation==="seed_audio_ref") {
    if (target) removeSeedAudioReference(target,seedAudioRefs(target).findIndex(ref=>ref.node_id===e.from&&ref.ref===e.ref));
    return;
  }
  if(e.story_continuity&&target&&(nodeLocked(target)||target.job||prepping.has(target.id)||scriptContinuityPending.has(target))){
    return toast("请等分镜图任务结束，或解锁节点后再移除尾帧");
  }
  checkpoint();
  if (target?.type === "video" && node(e.from)?.type === "image") rememberVideoVersion(target);
  if(e.story_continuity&&target)removeScriptTailPrompt(target,e);
  B.edges=B.edges.filter(x=>x!==e);
  if(selEdge===e)selEdge=null;
  refresh(target);
  if(!target)drawEdges();
  save();
  return true;
}
