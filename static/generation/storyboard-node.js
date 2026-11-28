"use strict";

// ================================================================= storyboard script node
function scriptRefs(n) {
  return imageInputs(n).filter(({version,source})=>version?.ref&&!source.data.story_asset_key).map(({source,version,edge})=>({
    node:source,name:source.name,ref:version.ref,pinned:!!edge.ref,desc:source.data.caption||"",kind:source.data.asset?.kind||"",
  }));
}

function scriptShotIndex(shots,pair,index,length) {
  if(!shots.length)return -1;
  if(pair.shot_id)return shots.findIndex(shot=>shot.id===pair.shot_id);
  for(const id of [pair.img,pair.vid]){
    const label=node(id)?.name?.match(/^镜(\d+)(?: · 分镜图)?$/);
    const position=label?Number(label[1])-1:-1;
    if(shots[position])return position;
  }
  return length%shots.length===0?index%shots.length:-1;
}

function ensureScriptShotIds(n) {
  const shots=n.data.shots||[], records=n.data.made||[];
  for(const shot of shots)shot.id ||= newCanvasNodeId();
  records.forEach((pair,index)=>{
    const shot=shots[scriptShotIndex(shots,pair,index,records.length)];
    if(shot&&!pair.shot_id)pair.shot_id=shot.id;
  });
}

function scriptShotLinks(n) {
  const shots=n.data.shots||[], records=n.data.made||[];
  const links=Array(shots.length).fill(null);
  records.forEach((pair,index)=>{
    const position=scriptShotIndex(shots,pair,index,records.length);
    if(position>=0&&(node(pair.img)||node(pair.vid)))links[position]=pair;
  });
  return links;
}

function shotNeedsNodes(pair) {
  return !node(pair?.img)||!node(pair?.vid);
}

function renderScript(n, body) {
  const d = n.data, shots = d.shots || [];
  if (!shots.length) {
    body.innerHTML = OneShotI18n.html`<div class="ph">${ico("script")}<div class="t">分镜脚本<br>选中后写剧情，连入角色 / 场景图片<br>由 Qwen 拆成一组镜头，再一键生成分镜图和视频</div></div>`;
    return;
  }
  const total = shots.reduce((a, s) => a + (s.duration || 0), 0);
  const links=scriptShotLinks(n);
  const seconds = duration => Number(Number(duration).toFixed(2));
  body.innerHTML = `<div class="sb"><div class="sbh"><b>${esc(d.title || "分镜")}</b><span>${shots.length} 镜 · ${seconds(total)}s</span></div>
    ${d.style ? `<div class="sbs">${esc(d.style)}</div>` : ""}
    ${shots.map((s, i) => `<div class="shot"><div class="sh1"><span class="no">${i + 1}</span>${s.frame ? `<img src="/media?ref=${encodeURIComponent(s.frame.ref)}">` : ""}<span>${esc(s.shot_size)}</span><span class="dim">${esc(s.camera)}</span><span class="du">${seconds(s.duration)}s</span>
      ${links[i]||canvasCanEdit()&&!nodeLocked(n)?`<button type="button" data-script-shot="${i}" aria-label="${links[i]?"定位":"展开"}第 ${i+1} 镜">${links[i]?"定位":"展开"}</button>`:""}</div>
      ${s.action.length ? `<div class="sa">${s.action.map(esc).join("<br>")}</div>` : ""}
      ${s.dialogue.length ? `<div class="sd">${s.dialogue.map(esc).join("<br>")}</div>` : ""}
      ${links[i]?.img?`<span class="story-tail-status" data-script-tail-status="${i}" hidden></span>`:""}
      ${links[i]?`<div class="script-shot-actions">
        ${canvasCanEdit()&&!nodeLocked(n)?`${i>0&&links[i].img?OneShotI18n.html`<button type="button" data-script-tail="${i}" aria-label="第 ${i+1} 镜参考上一镜尾帧">参考上一镜尾帧</button>`:""}
          <button type="button" data-script-run="${i}" aria-label="第 ${i+1} 镜生成计划">生成计划</button>`:""}
        ${i>0&&links[i-1]?`<button type="button" data-script-review="${i}" aria-label="对比镜头 ${i} 与镜头 ${i+1}">对比衔接</button>`:""}</div>`:""}</div>`).join("")}</div>`;
  $$("[data-script-shot],[data-script-tail],[data-script-run],[data-script-review]",body).forEach(button=>{
    const {scriptShot,scriptTail,scriptRun,scriptReview}=button.dataset;
    button.onpointerdown=event=>event.stopPropagation();
    button.ondblclick=event=>event.stopPropagation();
    button.onclick=()=>{
      if(scriptRun!==undefined)openScriptShotRun(n,Number(scriptRun));
      else if(scriptTail!==undefined)void linkPreviousShotFrame(n,Number(scriptTail));
      else if(scriptReview!==undefined)openShotContinuityReview(n,Number(scriptReview));
      else openScriptShot(n,Number(scriptShot));
    };
  });
  paintScriptContinuity(n,body,links);
}
function scriptCtl(n) {
  const d = n.data, has = (d.shots || []).length > 0, made = scriptShotLinks(n).filter(Boolean);
  const pill = (k, opts, label) => `<span class="pill">${label}<select data-k="${k}">${Object.entries(opts).map(([a, t]) => `<option value="${a}" ${String(a) === String(d[k]) ? "selected" : ""}>${t}</option>`).join("")}</select></span>`;
  let h = `<span class="pill model"><span class="dot" style="background:#bdbdc6"></span>Qwen 分镜</span>`;
  h += pill("nshots", { auto: "镜头数：自动", 3: "3 个镜头", 4: "4 个镜头", 6: "6 个镜头", 8: "8 个镜头" }, d.nshots === "auto" ? "自动镜数" : d.nshots + " 镜");
  h += pill("shotlen", { auto: "按动作和台词估算", 3: "偏好短镜", 5: "偏好约 5 秒", 8: "偏好约 8 秒", 10: "偏好约 10 秒", 14: "偏好约 14 秒" }, d.shotlen === "auto" ? "自动时长" : "偏好 "+d.shotlen+"s");
  h += pill("aspect", { "16:9": "16:9", "9:16": "9:16", "4:3": "4:3", "1:1": "1:1", "21:9": "21:9" }, d.aspect);
  h += pill("quality", { hd: "视频 768P", std: "视频 480P" }, d.quality === "hd" ? "768P" : "480P");
  if (has) {
    h += `<button class="pill" data-sa="expand" title="每个镜头建一张分镜图 + 一个视频节点（分栏已填好、连好人物设定）">${made.length ? "再展开一组" : "展开到画布"}</button>`;
    if (made.length) {
      if(scriptShotLinks(n).some(shotNeedsNodes))h += '<button class="pill" data-sa="missing">补齐画布节点</button>';
      h += `<button class="pill" data-sa="imgs" title="补齐未生成的分镜图，沿用已启用的白模构图参考">批量出分镜图</button>`;
      h += `<button class="pill" data-sa="vids" title="分镜图就绪的镜头依次生成视频">批量生成视频</button>`;
      h += `<button class="pill" data-sa="cat" title="打开剪辑台：调整顺序、裁剪、字幕、音乐，再导出成片">剪辑成片</button>`;
    }
  }
  return h;
}
function wireScriptCtl(n, ctl) {
  $$("button[data-sa]", ctl).forEach(b => b.onclick = () => ({ expand: expandScript, missing:expandMissingScriptShots,
    imgs: batchImages, vids: batchVideos, cat: openStoryFilm })[b.dataset.sa](n));
}
function madeShots(n) {
  const shots=n.data.shots||[];
  const positions=new Map(shots.map((shot,index)=>[shot.id,index]).filter(([id])=>id));
  return (n.data.made||[]).filter(pair=>(!pair.shot_id||positions.has(pair.shot_id))&&(node(pair.img)||node(pair.vid)))
    .sort((a,b)=>(positions.get(a.shot_id)??shots.length)-(positions.get(b.shot_id)??shots.length));
}
async function planStoryboard(n, {targetSeconds, resetLinks=false, motionFrames=false, wizardMedia, requestDraft}={}) {
  const d = n.data, story = fullPrompt(n);
  if (!story.trim()) { toast("先写一段剧情"); $("#prompt").focus(); return; }
  const uploads=wizardMedia?wizardUploadedReferences(wizardMedia):[];
  const refs=[...uploads,...scriptRefs(n).filter(item=>!uploads.some(upload=>upload.ref===item.ref))];
  return withBusy(n, "Qwen 拆分镜中", async () => {
    const bid=boardId;
    await flushSave();
    if(boardId!==bid||node(n.id)!==n)return;
    const payload = { board:bid, story, refs: refs.map(({ node, pinned, ...x }) => x), shots: d.nshots === "auto" ? null : +d.nshots,
      seconds: d.shotlen === "auto" ? null : +d.shotlen, style: "", aspect: d.aspect,
      ...(motionFrames ? {motion_frames:true,prepare_assets:true} : {}),
      ...(targetSeconds ? {target_seconds:targetSeconds} : {}) };
    const r = await (requestDraft ? requestDraft(payload) : api("/api/storyboard",payload));
    if(!r||boardId!==bid||node(n.id)!==n)return;
    checkpoint();ensureScriptShotIds(n);
    if(resetLinks)d.made=[];
    Object.assign(d,{title:r.title,style:r.style,characters:r.characters,visual_assets:r.visual_assets||[],
      shots:r.shots.map(shot=>({...shot,id:newCanvasNodeId()}))});
    if (wizardMedia) applyWizardUploadPlan(n,wizardMedia);
    save(); render(n); drawEdges();
    const total = r.planned_seconds ?? r.shots.reduce((sum,shot)=>sum+shot.duration,0);
    toast(`拆成 ${r.shots.length} 镜，计划约 ${total} 秒${llmNote(r)}`, 4000);
    return true;
  });
}

function openScriptShot(n,index) {
  if(node(n.id)!==n)return;
  const pair=scriptShotLinks(n)[index], targets=[node(pair?.img),node(pair?.vid)].filter(Boolean);
  if(!targets.length){expandScript(n,[index]);return;}
  sel=new Set(targets.map(target=>target.id));updateSel();fit(targets);
}
