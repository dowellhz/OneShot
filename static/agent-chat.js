"use strict";
const AC={session:null,board:null,events:[],runs:[],cursor:0,open:false,polling:false,sending:false,refs:null,base:new Map(),pending:new Map(),calls:new Map(),epoch:0};
const AC_LABELS={video_remake_plan:"确认换角计划",video_remake_status:"读取视频重制进度",video_remake_analyze:"分析重制原片",video_remake_map:"保存角色映射",video_remake_preview:"提交换角预览",video_remake_generate:"提交重制镜头视频",video_remake_export:"合成并保留原声",video_remake_review:"保存镜头审核决定",video_remake_locate:"定位原片人物",canvas_context:"读取画布",canvas_create_text:"创建文本",canvas_update:"更新节点",canvas_arrange:"整理排列",canvas_focus:"定位节点",media_describe:"理解图片",image_generate:"生成图片",image_edit:"编辑图片",image_cutout:"去除背景",image_segment:"识别选区",image_transform:"调整图片",memory_search:"检索创作记忆",memory_get:"读取创作记忆",memory_use:"采用记忆素材",memory_save:"保存创作记忆"};
const AC_STATES={thinking:"正在理解与规划…",running:"正在执行…",stopping:"正在停止，保留已完成结果…",stopped:"本轮已停止",done:"本轮已结束",error:"本轮执行中断"};
const AC_PHASES={queued:"排队",loading:"加载模型",encoding:"处理提示词与图片",sampling:"生成",decoding:"解码",compositing:"合成",done:"完成",error:"失败"};
const acClone=v=>JSON.parse(JSON.stringify(v));
function acActive(){return AC.runs.find(r=>!["done","error","stopped"].includes(r.state));}
async function acApi(url,body){const r=await fetch(url,body===undefined?{}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});let j;try{j=await r.json();}catch{throw new Error("服务返回异常，请稍后重试");}if(!r.ok)throw new Error(j.error||"请求失败");return j;}
function acRememberBoard(id,b){AC.base.set(id,acClone(b));if(!AC.pending.has(id)){try{const draft=JSON.parse(localStorage.getItem("h3.chat.conflict."+id));if(draft?.nodes){acHoldConflict({id,b:draft},b);if(id===boardId){Object.assign(B,draft);rebuild();applyView();}}}catch{}}}
function acGuardSave(){if(!AC.pending.has(boardId))return false;const draft=acClone(B);AC.pending.set(boardId,draft);try{localStorage.setItem("h3.chat.conflict."+boardId,JSON.stringify(draft));}catch{}return true;}
// Three-way merge only accepts disjoint changes. Conflicts keep both full versions available.
function acMerge(base,local,remote){
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),missing=Symbol("missing");
 function merge(a,l,r){if(same(l,r)||same(a,r))return l;if(same(a,l))return r;if(a&&l&&r&&typeof a==="object"&&typeof l==="object"&&typeof r==="object"&&!Array.isArray(a)&&!Array.isArray(l)&&!Array.isArray(r)){const out={};for(const key of new Set([...Object.keys(a),...Object.keys(l),...Object.keys(r)])){const v=merge(key in a?a[key]:missing,key in l?l[key]:missing,key in r?r[key]:missing);if(v!==missing)out[key]=v;}return out;}throw new Error("同一内容已被修改");}
 const out=acClone(remote);
 for(const key of new Set([...Object.keys(local),...Object.keys(remote)])){if(["rev","nodes","agent_ops"].includes(key))continue;const v=merge(base[key],local[key],remote[key]);if(v!==undefined)out[key]=v;else delete out[key];}
 const maps=[base,local,remote].map(b=>new Map((b.nodes||[]).map(n=>[n.id,n])));out.nodes=[];
 for(const id of new Set([...maps[2].keys(),...maps[1].keys()])){const v=merge(maps[0].get(id),maps[1].get(id),maps[2].get(id));if(v)out.nodes.push(v);}
 return out;
}
function acHoldConflict(p,remote){
  const backup=acClone(p.b);try{localStorage.setItem("h3.chat.conflict."+p.id,JSON.stringify(backup));}catch{}
  AC.pending.set(p.id,backup);let box=$("#acConflict");if(!box){box=document.createElement("div");box.id="acConflict";box.className="ac-conflict";document.body.append(box);}box.replaceChildren();
  const text=document.createElement("span");text.textContent="画布同一内容发生冲突，本地改动已暂存。";box.append(text);
  const button=document.createElement("button");button.textContent="将本地版本保存为副本";button.onclick=async()=>{try{const id="b"+Date.now().toString(36)+Math.random().toString(36).slice(2,5),copy=acClone(AC.pending.get(p.id)||backup);delete copy.rev;delete copy.agent_ops;copy.name=(copy.name||"画布")+" · 本地副本";const r=await fetch("/api/board/"+id,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(copy)});if(!r.ok)throw new Error("副本保存失败");AC.pending.delete(p.id);localStorage.removeItem("h3.chat.conflict."+p.id);box.remove();toast("本地改动已保存到画布列表中的副本",5000);if(boardId===p.id){const latest=await acApi("/api/board/"+p.id);acRememberBoard(p.id,latest);acApplyBoard(latest);}}catch(e){toast(e.message);}};box.append(button);toast("保存冲突，本地改动已暂存，请保存为副本",6000);return true;
}
async function acRecoverSave(p){
 const base=AC.base.get(p.id);if(!base)return false;
 const remote=await acApi("/api/board/"+p.id),local=acClone(p.b);let merged;
 try{merged=acMerge(base,local,remote);}catch{
  return acHoldConflict(p,remote);
 }
 const r=await fetch("/api/board/"+p.id,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(merged)});
 if(!r.ok){if(r.status===409){savePending=p;saveT=setTimeout(flushSave,1000);}else throw new Error("合并保存失败");return true;}
 const j=await r.json();merged.rev=j.rev;acRememberBoard(p.id,merged);
 if(p.b===B&&p.id===boardId){if(JSON.stringify(B)!==JSON.stringify(local)){try{const next=acMerge(local,B,merged);acApplyBoard(next);save();}catch{return acHoldConflict(p,merged);}}else acApplyBoard(merged);}return true;
}
async function acSyncBoard(rev,independent=false){
 if((!independent&&AC.board!==boardId)||!B||rev<=(B.rev||0)||AC.pending.has(boardId))return;
 const id=boardId;await flushSave();if(id!==boardId||AC.pending.has(id))return;
 const j=await acApi("/api/board/"+id);if(id!==boardId)return;
 if(savePending?.id===id)return;
 if(j.rev>(B.rev||0)){acRememberBoard(id,j);acApplyBoard(j,true);}
}
async function acSyncAgentJobs(){const id=boardId;const remote=await acApi("/api/board/"+id);if(id===boardId)await acSyncBoard(remote.rev,true);}
function acApplyBoard(data,keepView=false){const previous=new Map(B.nodes.map(n=>[n.id,n])),view=B.view;const nodes=data.nodes.map(n=>{const old=previous.get(n.id);if(!old)return n;for(const k of Object.keys(old))if(!(k in n))delete old[k];Object.assign(old,n);return old;});Object.assign(B,data,{nodes});if(keepView)B.view=view;sel=new Set([...sel].filter(id=>node(id)));rebuild();applyView();if(B.nodes.some(n=>n.job?.agent_call))poll();B.nodes.filter(n=>n.agent_error).forEach(n=>showErr(n,n.agent_error));if(IMAGE_EDITOR&&!node(IMAGE_EDITOR.n.id))closeImageEditor();}
function acRefs(){return (AC.refs===null?[...sel]:AC.refs).map(node).filter(Boolean);}
function acRenderRefs(){if(!$("#acRefs")||!B)return;$("#acRefs").innerHTML=acRefs().map(n=>`<span class="ac-ref">${esc(n.name)} · ${n.cur>=0?"版本 "+(n.cur+1):TYPE_CN[n.type]}<button type="button" data-remove="${esc(n.id)}" aria-label="移除引用">×</button></span>`).join("");$$("[data-remove]",$("#acRefs")).forEach(b=>b.onclick=()=>{AC.refs=acRefs().map(n=>n.id).filter(id=>id!==b.dataset.remove);acRenderRefs();});}
async function acPick(){const box=$("#acPicker");box.hidden=!box.hidden;if(box.hidden)return;const memories=await cmList(true).catch(()=>[]);box.innerHTML=memories.map(a=>`<button type="button" data-memory="${esc(a.id)}">@${esc(a.name)} · ${esc(cmKind(a))}</button>`).join("")+B.nodes.slice(0,200).map(n=>`<button type="button" data-node="${esc(n.id)}">${esc(n.name)} · ${TYPE_CN[n.type]}</button>`).join("")||"画布还没有节点";$$("[data-memory]",box).forEach(b=>b.onclick=()=>{const a=memories.find(a=>a.id===b.dataset.memory);if(a)cmInsert($("#acInput"),a);box.hidden=true;});$$("[data-node]",box).forEach(b=>b.onclick=()=>{AC.refs=[...new Set([...acRefs().map(n=>n.id),b.dataset.node])].slice(0,30);box.hidden=true;acRenderRefs();$("#acInput").focus();});}
async function acFocus(ids,editor=false){if(AC.board!==boardId)return;const nodes=ids.map(id=>vtResolve(id)?.node).filter(Boolean);if(!nodes.length)return;sel=new Set(nodes.map(n=>n.id));updateSel();fit(nodes);if(editor&&nodes.length===1&&nodes[0].type==="image")await openImageEditor(nodes[0]);}
function acResultVersion(item){const resolved=vtResolve(item.id,item.ref);return resolved?.node.versions[resolved.index]||item;}
function acResultCards(result){
 if (result.remake) {
  const {node_id, source_ref, shot_number, shot_start, frame, preview_job, video_job} = result.remake;
  const locate = Number.isFinite(shot_start) && Number.isInteger(shot_number);
  const label = locate ? result.location ? `确认镜头 ${shot_number} 的人物位置` : `打开重制镜头 ${shot_number}` : "打开视频重制";
  const open = (text, job) => {
   const target = locate ? ` data-remake-start="${shot_start}" data-remake-frame="${esc(frame || "")}" data-remake-preview-job="${esc(preview_job || "")}" data-remake-video-job="${esc(job || "")}"` : "";
   return `<button type="button" data-remake-node="${esc(node_id)}" data-remake-ref="${esc(source_ref)}"${target}>${esc(text)}</button>`;
  };
  let review = "";
  if (locate && result.review_board && Number.isInteger(result.cut_revision) && Array.isArray(result.review_versions)) {
   const decision = (text, job, pressed, issue) =>
    `<button type="button" data-remake-decision="${job ? "adopt" : "keep"}" data-review-job="${esc(job || "")}" aria-pressed="${!!pressed}"${issue ? ` disabled title="${esc(issue)}"` : ""}>${esc(text)}</button>`;
   const rows = result.review_versions.map(version =>
    `<div>${open(`查看版本 ${version.number}`, version.job)}${decision(`采用版本 ${version.number}`, version.job, version.adopted, version.review_issue)}</div>`).join("");
   review = `<div class="ac-remake-review" data-review-board="${esc(result.review_board)}" data-review-node="${esc(node_id)}"
    data-review-ref="${esc(source_ref)}" data-review-shot="${shot_number}" data-review-revision="${result.cut_revision}">
    ${rows}<div>${decision("保留原片", "", result.shots?.[shot_number - 1]?.keep_original)}</div>
    <span data-review-status role="status"></span></div>`;
  } else if (result.review_versions?.length) {
   review = `<div class="ac-results">${result.review_versions.map(version => open(`查看版本 ${version.number}`, version.job)).join("")}</div>`;
  }
  const download = result.export_ref ? `<a href="/media?ref=${encodeURIComponent(result.export_ref)}" download="${esc(result.export_ref.split("/").at(-1))}">下载成片</a>` : "";
  const plan = result.remake_plan;
  const planCard = plan ? `<fieldset class="ac-remake-plan" data-plan="${esc(JSON.stringify({...plan, node_id, source_ref}))}">
    <legend>确认换角计划</legend><div><img src="${remakeMedia(plan.reference)}" alt="角色参考图"><strong>${esc(plan.person)} → ${esc(plan.asset_name)}</strong></div>
    ${plan.shots.map(s => `<label><input type="checkbox" value="${s.shot}" ${s.keep ? "disabled" : "checked"}>镜头 ${s.shot} · ${s.keep ? "保留原片" : s.selection_ready ? "可生成预览" : "需要确认人物选区"}</label>`).join("")}
    <button type="button" data-apply-plan>确认所选镜头</button><output aria-live="polite"></output></fieldset>` : "";
  return `<div class="ac-results">${open(label, video_job)}${download}</div>${review}${planCard}`;
 }
 const made=result.nodes||[];if(!made.length)return "";return `<div class="ac-results">${made.map(item=>{const n=vtResolve(item.id,item.ref)?.node,v=acResultVersion(item);if(item.type==="video"||n?.type==="video")return `<div class="ac-result ac-video"><video controls playsinline preload="metadata" src="/media?ref=${encodeURIComponent(v.ref)}" aria-label="生成的视频"></video><button type="button" data-focus="${esc(item.id)}" data-version-ref="${esc(v?.ref||"")}">定位视频</button></div>`;return `<button type="button" class="ac-result" data-focus="${esc(item.id)}" data-version-ref="${esc(v?.ref||"")}">${v?.ref?`<img loading="lazy" alt="生成结果" src="/media?ref=${encodeURIComponent(v.ref)}">`:""}<span>${esc(n?.name||item.name||"查看结果")}</span></button>`;}).join("")}</div>`;}

async function acApplyRemakePlan(button) {
 const card = button.closest("[data-plan]");
 const plan = JSON.parse(card.dataset.plan);
 const shots = $$("input:checked:not(:disabled)", card).map(control => Number(control.value) - 1);
 const status = $("output", card);
 if (!shots.length) { status.textContent = "请至少勾选一个镜头"; return; }
 card.disabled = true;
 try {
  await flushSave();
  if (boardId !== plan.board) throw new Error("请回到对应画布");
  const target = vtResolve(plan.node_id, plan.source_ref);
  if (!target || target.node.versions[target.index]?.ref !== plan.source_ref) throw new Error("原片版本已不存在");
  const url = `/api/video-remake/${encodeURIComponent(plan.board)}/${encodeURIComponent(target.node.id)}?source=${encodeURIComponent(plan.source_ref)}`;
  const state = await remakeRequest(url, {"action":"apply_plan", shots, cut_revision:plan.cut_revision,
    person:plan.person, asset:plan.asset, reference:plan.reference, look:plan.look});
  const outcome = state.apply_plan;
  const summary = [`已提交 ${outcome.submitted.length} 个预览`, ...outcome.failed.map(s => `镜头 ${s.shot + 1} ${s.error}`)];
  if (outcome.needs_selection.length) summary.push(`请确认镜头 ${outcome.needs_selection.map(i => i + 1).join("、")} 的人物选区`);
  status.textContent = summary.join(" · ");
  const first = (outcome.needs_selection.length ? outcome.needs_selection : outcome.submitted)[0];
  if (first != null) {
   const link = document.createElement("button"); link.type = "button"; link.textContent = `打开镜头 ${first + 1}`;
   Object.assign(link.dataset, {remakeNode:target.node.id, remakeRef:plan.source_ref, remakeStart:state.shots[first].start});
   card.after(link);
  }
  if (outcome.submitted.length) {
   const results = document.createElement("div"); results.className = "ac-remake-plan";
   card.after(results);
   watchRemakePlan(results, url, plan, outcome.jobs || []);
  }
 } catch (e) {
  status.textContent = e.message;
  card.disabled = false;
 }
}

async function watchRemakePlan(results, url, plan, targets) {
 if (!targets.length) return;
 let allDone = false;
 const deadline = Date.now() + 30 * 60 * 1000;
 while (!allDone && results.isConnected && boardId === plan.board && Date.now() < deadline) {
  try {
   const jobs = await acApi("/api/jobs?ids=" + encodeURIComponent(targets.map(t => t.job).join(",")));
   const latest = await remakeRequest(url);
   if (!results.isConnected || boardId !== plan.board) return;
   allDone = targets.every(t => ["done","error"].includes(jobs[t.job]?.state));
   results.replaceChildren();
   for (const {index, frame, job} of targets) {
    const shot = latest.shots[index], preview = shot?.frames[frame]?.previews.find(p => p.job === job);
    const line = document.createElement("div");
    line.textContent = `镜头 ${index + 1} · ${preview?.ref ? "预览完成" : preview?.error || "生成中"}`;
    if (preview?.ref) {
     const view = document.createElement("img");
     view.src = remakeMedia(preview.ref); view.alt = `镜头 ${index + 1} 换角预览`;
     const accept = document.createElement("button"); accept.type = "button"; accept.textContent = "采用预览";
     accept.onclick = async () => {
      accept.disabled = true;
      try {
       await remakeRequest(url, {action:"approve", shot:index, frame, job, cut_revision:plan.cut_revision});
       accept.textContent = "已采用";
      } catch (e) { accept.disabled = false; toast(e.message); }
     };
     line.append(view, accept);
    }
    results.append(line);
   }
  } catch (e) {
   results.textContent = "进度暂不可用 · " + e.message;
  }
  if (!allDone) await new Promise(resolve => setTimeout(resolve, 1700));
 }
 if (!allDone && results.isConnected && boardId === plan.board) results.textContent = "等待超时，可在重制工作区继续查看任务";
}

async function acReviewRemake(button) {
 const card = button.closest("[data-review-board]");
 if (!card || button.disabled || card.getAttribute("aria-busy") === "true") return;
 const {reviewBoard, reviewNode, reviewRef, reviewShot, reviewRevision} = card.dataset;
 const info = $("[data-review-status]", card);
 const decisions = $$("[data-remake-decision]:not(:disabled)", card);
 const adopting = button.dataset.remakeDecision === "adopt";
 const shot = Number(reviewShot) - 1;
 const job = button.dataset.reviewJob;
 card.setAttribute("aria-busy", "true");
 decisions.forEach(control => { control.disabled = true; });
 info.textContent = "正在保存审核决定…";
 try {
  if (reviewBoard !== boardId) throw new Error("画布已切换，请重新打开对应对话");
  await flushSave();
  if (reviewBoard !== boardId) throw new Error("画布已切换，请重新打开对应对话");
  const target = vtResolve(reviewNode, reviewRef);
  if (!target || target.node.type !== "video" || target.node.versions[target.index]?.ref !== reviewRef) {
   throw new Error("原片版本已不存在");
  }
  const url = "/api/video-remake/" + encodeURIComponent(reviewBoard) + "/" + encodeURIComponent(target.node.id) +
   "?source=" + encodeURIComponent(reviewRef);
  const session = await remakeRequest(url, {
   action:adopting ? "approve_video" : "keep", shot, cut_revision:Number(reviewRevision), ...(adopting ? {job} : {}),
  });
  const selected = session.shots[shot];
  for (const control of decisions) {
   const pressed = selected.keep_original ? control.dataset.remakeDecision === "keep" : !!selected.adopted_video &&
    selected.adopted_video === control.dataset.reviewJob;
   control.setAttribute("aria-pressed", String(pressed));
  }
  info.textContent = adopting ? `镜头 ${reviewShot} 已采用所选版本。` : `镜头 ${reviewShot} 已设为保留原片。`;
 } catch (error) {
  info.textContent = error.message;
 } finally {
  decisions.forEach(control => { control.disabled = false; });
  card.removeAttribute("aria-busy");
 }
}

function acAddChoices(message, event) {
 const prose = Array.from(message.children).filter(el => !["OL","UL","PRE","BLOCKQUOTE"].includes(el.tagName));
 const prompt = prose.map(el => el.textContent).join(" ");
 if (!/(?:请选择|(?:你|您)(?:想|要|会)?选|选哪|选一个|哪[个种一]|二选一|回复\s*[12]|1\s*还是\s*2|choose|pick one|which option)/i.test(prompt)) return;
 const lists = Array.from(message.children).filter(el => el.tagName === "OL");
 const list = lists[0];
 let options;
 if (lists.length === 1) {
  const items = Array.from(list.children);
  if (list.start !== 1 || items.some(el => el.querySelector("ol,ul,pre,table,input,a,img"))) return;
  options = items.map(el => el.textContent.trim().replace(/\s+/g, " "));
 } else if (!lists.length && /(?:^|\D)1\s*还是\s*2(?:\D|$)/.test(prompt)) {
  options = ["", ""];
 } else return;
 if (options.length < 2 || options.length > 6 || options.some(label => label.length > 350)) return;
 const card = document.createElement("div");
 card.className = "ac-choices";
 card.dataset.event = event.id;
 card.setAttribute("role", "group");
 card.setAttribute("aria-label", "请选择一个方案");
 const title = document.createElement("strong");
 title.textContent = "请选择一个方案";
 card.append(title);
 options.forEach((label, index) => {
  const button = document.createElement("button");
  button.type = "button";
  const number = document.createElement("span");
  number.className = "ac-choice-number";
  number.textContent = index + 1;
  button.append(number, document.createTextNode(label || `选择 ${index + 1}`));
  button.disabled = true;
  button.onclick = () => {
   if (!button.disabled) acSend(label ? `我选择 ${index + 1}：${label}` : `我选择 ${index + 1}`);
  };
  card.append(button);
 });
 if (list) list.replaceWith(card);
 else message.append(card);
}

function acAppendEvent(e,replay=false){
 const box=$("#acMessages"),d=e.data;let el;
 if(["user","assistant","notice"].includes(e.kind)){
  el=document.createElement("div");el.className="ac-msg "+e.kind;
  if(e.kind!=="notice")acMarkdown(el,d.text);else el.textContent=d.text;
  if(e.kind==="assistant")acAddChoices(el,e);
 }
 if(e.kind==="tool_start"){el=document.createElement("details");el.className="ac-call";el.dataset.call=d.call_id;el.dataset.tool=d.name;el.innerHTML=`<summary>${esc(AC_LABELS[d.name]||d.name)} · 执行中</summary><div class="ac-progress"></div><div class="ac-output"></div>`;AC.calls.set(d.call_id,el);}
 if(e.kind==="tool_end"){el=AC.calls.get(d.call_id);if(el){if(d.result.remake_plan || d.result.review_versions?.length || d.result.preview?.completed?.length || d.result.video?.completed || d.name==="video_remake_export"&&d.result.export_ref)el.open=true;el.classList.add(d.result.error?"error":"done");$("summary",el).textContent=(AC_LABELS[d.name]||d.name)+" · "+(d.result.error?"未完成":"完成");$(".ac-progress",el).textContent="";const detail=document.createElement("pre");detail.textContent=d.result.error||d.result.text||(d.result.nodes?`已保存 ${d.result.nodes.length} 个结果，点击缩略图定位。`:d.result.total_nodes!=null?`已读取画布，共 ${d.result.total_nodes} 个节点。`:d.name==="image_segment"?"选区已准备好，可继续局部编辑。":d.name==="canvas_focus"?"已向页面发送定位请求。":d.result.adopted?"已采用："+d.result.adopted.map(a=>a.name).join("、"):d.result.memories?`找到 ${d.result.memories.length} 条创作记忆。`:d.result.memory?"已保存记忆："+d.result.memory.name:"画布操作已保存。");$(".ac-output",el).replaceChildren(detail);$(".ac-output",el).insertAdjacentHTML("beforeend",acResultCards(d.result));if(typeof aeResultExtras==="function")aeResultExtras($(".ac-output",el),d.result,d.name);}return;}
 if(e.kind==="progress"){
  el=AC.calls.get(d.call_id);
  if(el){
   const progress=d.jobs.map(j=>{const phase=AC_PHASES[j.phase]||AC_PHASES[j.state]||"处理中",pct=j.max?` · ${Math.min(j.state==="done"?100:99,Math.round((j.value||0)/j.max*100))}%`:"";return phase+pct+(j.ahead?` · 前方 ${j.ahead} 个任务`:"");}).join(" / ");
   $(".ac-progress",el).textContent=progress;
   if(["video_remake_export","video_remake_preview","video_remake_generate"].includes(el.dataset.tool))$("summary",el).textContent=`${AC_LABELS[el.dataset.tool]} · ${progress}`;
  }
  return;
 }
 if(e.kind==="focus"&&!replay){acFocus(d.node_ids,d.open_editor);return;}
 if(typeof aeAppendEvent==="function"&&aeAppendEvent(e,replay))return;
 if(el){$(".ac-empty",box)?.remove();box.append(el);}
}
function acRenderState(){
 const active=acActive(),latest=AC.runs[0];$("#acStatus").textContent=active?AC_STATES[active.state]:(latest?.error||AC_STATES[latest?.state]||"可以讨论，也可以直接操作当前画布");
 const lastMessage = AC.events.findLast(e => e.kind === "assistant" || e.kind === "user");
 let choosing = false;
 for (const card of $$("#acMessages .ac-choices")) {
  const current = AC.session && lastMessage?.kind === "assistant" && card.dataset.event === String(lastMessage.id);
  for (const button of card.querySelectorAll("button")) button.disabled = !current || !!active || AC.sending;
  choosing ||= !!current && !active && !AC.sending;
 }
 if (choosing) $("#acStatus").textContent = "请选择上方的方案，或输入你的回复";
 $("#acStop").hidden=!active;$("#acStop").disabled=active?.state==="stopping";$("#acSend").disabled=!!active||AC.sending||!$("#acInput").value.trim();$("#acUndo").hidden=!latest||!!active;$("#acNew").disabled=!!active;
 if(latest?.model)$("#acModel").textContent=latest.model.provider+" · "+latest.model.model;
 if(typeof aeRenderInputs==="function")aeRenderInputs();
}
async function acPoll(background=false){
 if(AC.polling||(!AC.open&&!background)||!AC.session)return;AC.polling=true;const sid=AC.session,epoch=AC.epoch;
 try{const j=await acApi(`/api/chat/sessions/${sid}?after=${AC.cursor}`);if(epoch!==AC.epoch||sid!==AC.session)return;await acSyncBoard(j.board_rev);if(epoch!==AC.epoch)return;
  AC.runs=j.runs;AC.inputs=j.inputs||[];const box=$("#acMessages"),bottom=box.scrollHeight-box.scrollTop-box.clientHeight<90;
  for(const e of j.events){AC.cursor=e.id;AC.events.push(e);acAppendEvent(e,AC.replaying);}AC.replaying=false;acRenderState();if(bottom)box.scrollTop=box.scrollHeight;$("#acError").hidden=true;
 }catch(e){if(epoch===AC.epoch){$("#acError").textContent="连接中断，将自动重连："+e.message;$("#acError").hidden=false;}}finally{AC.polling=false;}
}
async function acLoadSession(id){AC.epoch++;AC.session=id;AC.cursor=0;AC.events=[];AC.runs=[];AC.inputs=[];AC.calls.clear();AC.replaying=true;$("#acMessages").replaceChildren();localStorage.setItem("h3.chat.session."+boardId,id);try{const outbox=JSON.parse(localStorage.getItem("h3.chat.outbox."+id));if(outbox?.payload){$("#acInput").value=outbox.payload.text;AC.refs=outbox.payload.selected;AC.pending.set(outbox.key,outbox.payload);}else $("#acInput").value="";}catch{}await acPoll();acRenderRefs();}
async function acSessions(fresh=false){const id=boardId,epoch=++AC.epoch;AC.board=id;AC.session=null;AC.cursor=0;AC.runs=[];AC.refs=null;acRenderRefs();const j=await acApi("/api/chat/sessions?board="+encodeURIComponent(id));if(id!==boardId||epoch!==AC.epoch)return;
 let chosen=!fresh&&j.sessions.find(s=>s.id===localStorage.getItem("h3.chat.session."+id))?.id||(!fresh&&j.sessions[0]?.id);
 if(!chosen){const made=await acApi("/api/chat/sessions",{board:id});if(id!==boardId)return;chosen=made.id;j.sessions.unshift({id:chosen,title:"新对话"});}
 $("#acSessions").innerHTML=j.sessions.map(s=>`<option value="${esc(s.id)}">${esc(s.title)}</option>`).join("");$("#acSessions").value=chosen;await acLoadSession(chosen);acRenderEmpty();
}
function acRenderEmpty(){if(AC.events.some(e=>e.kind==="user"))return;const box=$("#acMessages");box.innerHTML=`<div class="ac-empty"><b>告诉我你想怎么创作</b><div>引用画布素材，我可以生成、编辑和整理结果。</div><button data-example="描述一下选中的图片">理解这张图片</button><button data-example="以选中图片为参考生成三个暖色版本，横向排列在原图右边">生成三个暖色版本</button><button data-example="把选中的节点横向排齐">整理选中的节点</button></div>`;$$("[data-example]",box).forEach(b=>b.onclick=()=>{$("#acInput").value=b.dataset.example;acRenderState();$("#acInput").focus();});}
async function acSend(choiceText){
 if(AC.sending||acActive()||!AC.session)return;
 const input = $("#acInput"), draft = input.value;
 const text = typeof choiceText === "string" ? choiceText : draft.trim();
 if(!text)return;
 const sid=AC.session,id=boardId,selected=acRefs().map(n=>n.id),key=id+"|"+sid+"|"+text+"|"+selected.join(",");
 let pending=AC.pending.get(key);if(!pending){pending={text,selected,request_key:crypto.randomUUID?.()||("req"+Date.now()+Math.random())};AC.pending.set(key,pending);try{localStorage.setItem("h3.chat.outbox."+sid,JSON.stringify({key,payload:pending}));}catch{}}
 AC.sending=true;acRenderState();try{await flushSave();if(id!==boardId||sid!==AC.session)throw new Error("画布已切换，请重新发送");if(AC.pending.has(id))throw new Error("请先将冲突的本地画布保存为副本");
  const sent=await acApi(`/api/chat/sessions/${sid}/messages`,pending);
  AC.pending.delete(key);localStorage.removeItem("h3.chat.outbox."+sid);
  if(id!==boardId||sid!==AC.session)return;
  if(!AC.runs.some(r=>r.id===sent.id))AC.runs.unshift(sent);
  const option=$("#acSessions").selectedOptions[0];if(option)option.textContent=text.slice(0,30);
  if(typeof choiceText!=="string"&&input.value===draft)input.value="";
  AC.refs=null;await acPoll();acRenderRefs();
 }catch(e){toast(e.message,6000);}finally{AC.sending=false;acRenderState();}
}
async function acOpen(){if(!B)return;AC.open=true;$("#agentChat").hidden=false;$("#chatLaunch").hidden=true;try{await flushSave();if(AC.board!==boardId||!AC.session)await acSessions();else await acPoll();}catch(e){$("#acError").textContent=e.message;$("#acError").hidden=false;}$("#acInput").focus();}
function acBoardChanged(){if(!AC.open)return;acSessions().catch(e=>toast(e.message));}
function initAgentChat(){
 const launch=document.createElement("button");launch.id="chatLaunch";launch.innerHTML=`${ico("script")}<span>创作助手</span>`;launch.setAttribute("aria-controls","agentChat");launch.onclick=acOpen;document.body.append(launch);
 const pane=document.createElement("section");pane.id="agentChat";pane.hidden=true;pane.setAttribute("role","region");pane.setAttribute("aria-label","创作助手");pane.innerHTML=`<header class="ac-head"><strong>创作助手</strong><button id="acDock" title="切换停靠 / 浮动" aria-label="切换停靠 / 浮动">${ico("full")}</button><button id="acClose" title="收起，任务继续运行" aria-label="收起助手">×</button></header><div class="ac-subhead"><select id="acSessions" aria-label="对话历史"></select><button id="acNew">新对话</button></div><div id="acModel" class="ac-model">使用平台配置的文本模型</div><div id="acMessages" class="ac-messages" role="log" aria-label="对话与操作记录"></div><div id="acError" class="ac-status" hidden></div><div id="acStatus" class="ac-status" role="status"></div><div class="ac-composer"><div id="acRefs" class="ac-refs"></div><div id="acPicker" class="ac-picker" hidden></div><textarea id="acInput" aria-label="告诉助手要做什么" placeholder="描述你想做什么，输入 @ 引用素材…" maxlength="8000"></textarea><div class="ac-actions"><button id="acReference" title="引用画布节点">@ 引用</button><button id="acUndo" hidden>撤销本轮</button><span class="ac-hint">Enter 发送</span><button id="acStop" hidden>停止</button><button id="acSend" disabled>发送</button></div></div>`;document.body.append(pane);
 $("#acClose").onclick=()=>{AC.open=false;pane.hidden=true;launch.hidden=false;};$("#acDock").onclick=()=>{pane.classList.toggle("floating");pane.style.left=pane.style.top=pane.style.height=pane.style.width="";acStoreWindow();};
 $("#acNew").onclick=()=>acSessions(true).catch(e=>toast(e.message));$("#acSessions").onchange=e=>acLoadSession(e.target.value).catch(e=>toast(e.message));$("#acReference").onclick=acPick;$("#acSend").onclick=acSend;
 $("#acInput").oninput=()=>{acRenderState();};$("#acInput").onkeydown=e=>{e.stopPropagation();if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing){e.preventDefault();acSend();}};
 $("#acStop").onclick=async()=>{const r=acActive();if(!r)return;try{await acApi(`/api/chat/runs/${r.id}/stop`,{});await acPoll();}catch(e){toast(e.message);}};
 $("#acUndo").onclick=async()=>{try{await flushSave();await acApi(`/api/chat/runs/${AC.runs[0].id}/undo`,{});await acPoll();toast("已撤销本轮画布改动，生成文件仍保留");}catch(e){toast(e.message,5000);}};
 $("#acMessages").onclick=e=>{
  const plan=e.target.closest("[data-apply-plan]");
  if(plan){acApplyRemakePlan(plan);return;}
  const decision=e.target.closest("[data-remake-decision]");
  if(decision){acReviewRemake(decision);return;}
  const remake=e.target.closest("[data-remake-node]");
  if(remake){
   const target=vtResolve(remake.dataset.remakeNode,remake.dataset.remakeRef);
   if(!target || target.node.type!=="video" || target.node.versions[target.index]?.ref!==remake.dataset.remakeRef){toast("原片版本已不存在");return;}
   if(target.node.cur!==target.index && !switchVersion(target.node,target.index))return;
   const start=remake.dataset.remakeStart;
   openVideoRemake(target.node,{shotStart:start===undefined ? undefined : Number(start), frame:remake.dataset.remakeFrame,
    previewJob:remake.dataset.remakePreviewJob,videoJob:remake.dataset.remakeVideoJob});
   return;
  }
  const b=e.target.closest("[data-focus]");if(b){const resolved=vtResolve(b.dataset.focus,b.dataset.versionRef);if(resolved){switchVersion(resolved.node,resolved.index);acFocus([resolved.node.id]);}}};
 pane.addEventListener("pointerdown",e=>e.stopPropagation());pane.addEventListener("wheel",e=>e.stopPropagation(),{passive:true});pane.addEventListener("keydown",e=>e.stopPropagation());
 $(".ac-head",pane).addEventListener("pointerdown",e=>{if(e.button!==0||e.target.closest("button"))return;e.preventDefault();const r=pane.getBoundingClientRect(),start={x:e.clientX,y:e.clientY};pane.classList.add("floating");pane.style.height=r.height+"px";pane.style.width=r.width+"px";pane.style.left=r.left+"px";pane.style.top=r.top+"px";const move=ev=>{pane.style.left=Math.max(0,Math.min(innerWidth-r.width, r.left+ev.clientX-start.x))+"px";pane.style.top=Math.max(8,Math.min(innerHeight-150,r.top+ev.clientY-start.y))+"px";};const end=()=>{removeEventListener("pointermove",move);removeEventListener("pointerup",end);removeEventListener("pointercancel",end);acStoreWindow();};addEventListener("pointermove",move);addEventListener("pointerup",end);addEventListener("pointercancel",end);});
 try{const layout=JSON.parse(localStorage.getItem("h3.chat.window"));if(layout?.floating){pane.classList.add("floating");for(const k of ["left","top","width","height"])if(Number.isFinite(layout[k]))pane.style[k]=Math.max(k==="width"?300:k==="height"?300:8,Math.min(layout[k],k==="left"?innerWidth-300:k==="top"?innerHeight-150:k==="width"?innerWidth-16:innerHeight-24))+"px";}}catch{}
 if(typeof aeInit==="function")aeInit();
 const resize=new ResizeObserver(()=>{if(pane.classList.contains("floating")&&!pane.hidden)acStoreWindow();});resize.observe(pane);
 setInterval(()=>{if(!AC.open&&AC.board===boardId&&acActive())acPoll(true);if(AC.open){if(AC.board!==boardId)acBoardChanged();else acPoll();acRenderRefs();}},1000);
}
function acStoreWindow(){const p=$("#agentChat"),r=p.getBoundingClientRect();try{localStorage.setItem("h3.chat.window",JSON.stringify({floating:p.classList.contains("floating"),left:r.left,top:r.top,width:r.width,height:r.height}));}catch{}}
