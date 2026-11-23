"use strict";

// ================================================================= generation
async function api(path, body, method = "POST") {
  const r = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { error: t }; }
  if (!r.ok) throw new Error(j.error || t || r.statusText); return j;
}
function fullPrompt(n) {
  const parts = inputs(n, "text").map(t => t.data.text.trim()).filter(Boolean);
  if (!usesFields(n) && n.data.prompt.trim()) parts.push(n.data.prompt.trim());   // field mode: the fields replace the free text
  return parts.join("\n");
}
function showErr(n, msg) { const b = $(".errbox", els.get(n.id)); b.textContent = msg || ""; b.classList.toggle("on", !!msg); }
const usesFields = n => !!n && n.type === "video" && n.data.pmode === "fields";
const fieldsFilled = n => FIELDS.some(f => !["sound", "music"].includes(f.k) && (n.data.fields?.[f.k] || "").trim());
const prepping = new Set();   // nodes whose request is being submitted before it reaches the queue
const BATCH_LAYOUTS = {tabs:"同一节点的版本 Tab",spread:"在画布横向展开",fold:"收起为一组"};
function canvasBatchLayout() {
  return Object.hasOwn(BATCH_LAYOUTS,B?.batch_layout)?B.batch_layout:"tabs";
}
function canvasPromptBindings(images,sounds=[],clips=[],guide=null,special=false) {
  const bindings=new Map();
  for(const [type,inputs] of [["image",images],["audio",sounds],["video",clips]]) {
    inputs.forEach(({edge},i)=>{
      if(promptSlot(edge.prompt_slot)) {
        const position=type==="video"?promptVideoIndex(i,guide,special):i+1;
        bindings.set(promptMediaToken(type,edge.prompt_slot),"@"+PROMPT_MEDIA_TAG[type]+position);
      }
    });
  }
  return bindings;
}
function resolveCanvasPrompt(n,text,bindings) {
  let missing=false;
  const resolved=text.replace(/@(图|视频|音)\{\d+\}/g,(token,kind)=>{
    if(!bindings.has(token))missing=kind;
    return bindings.get(token)||token;
  });
  if(missing){showErr(n,`提示词中的 ${{图:"图片",视频:"视频",音:"音频"}[missing]}引用已断开，请重新选择或删除该引用`);return null;}
  return resolved;
}
function showPrep(n, on) {
  const el = els.get(n.id); if (!el) return;
  const g = $(".gen", el);
  if (!on) { renderJob(n); if (!n.job) g.classList.toggle("on", toolBusy.has(n.id)); return; }
  g.classList.add("on"); $(".pct", g).textContent = "译"; $(".bar i", g).style.width = "3%";
  $(".s", g).textContent = "提交中…";
}
function captureGenerationRecord(request, textInputs) {
  const settings = Object.fromEntries(["model","provider_model","provider","quality","ar","duration","seed","count","extension"]
    .filter(key => request[key] != null).map(key => [key,request[key]]));
  const images = (request.images || []).map(({node_id,ref,role,time,name,memory_id,memory_view}) => {
    const n = node_id ? node(node_id) : null;
    const index = n ? (curV(n)?.ref === ref ? n.cur : n.versions.findIndex(v=>v.ref===ref)) : -1;
    return {node_id, ref, role, time, name, memory_id, memory_view, version:index >= 0 ? index+1 : undefined};
  });
  if (request.previs_guide) images.push({...request.previs_guide, role:"previs"});
  for (const clip of request.video_refs || []) images.push({...clip,role:"video_ref"});
  for (const audio of request.audio_refs || []) images.push({...audio, role:"audio_ref"});
  return {settings, prompt:request.prompt, fields:request.fields, mode:request.mode, camera_plan:request.camera_plan,
    video_optics:request.video_optics,
    object_edit:request.object_edit,inputs:[...textInputs,...images]};
}

async function generate(n, {batchLayout=canvasBatchLayout(),groupRunId,imageGrid=false}={}) {
  if (n.type === "audio") return generateAudio(n,{groupRunId});
  if (n.data.previs) return openPrevis(n);
  if (n.type === "script") return planStoryboard(n);
  if (n.job) return toast("这个节点仍有生成任务，请等待完成或取消");
  if (prepping.has(n.id)) return toast("这个节点正在准备提交，请稍等");
  const grid = imageGrid && n.type==="image";
  const d = n.data, prompt = grid ? GRID9_PROMPT : fullPrompt(n); delete n.agent_error; showErr(n, "");
  const hasEditPlan=n.type==="video" && (d.camera_plan || d.object_edit) && videoInputs(n)[0]?.edge.segment_edit;
  if (!hasEditPlan && (usesFields(n) ? !fieldsFilled(n) : !prompt)) { toast(usesFields(n) ? "至少填写场景、动作或对话中的一项" : "先写提示词，或连入一个文本节点"); if (!usesFields(n)) $("#prompt").focus(); return; }
  let req, gridReference;
  if (n.type === "image") {
    const linked=imageInputs(n), images=[];
    if(grid){
      gridReference=linked.find(input=>input.version?.ref);
      if(!gridReference){toast("请先连入有图片的节点");return;}
    }
    const ins=grid?[gridReference]:linked, model=grid&&isRemote(n)?"h3img":d.model;
    if (ins.length && model === "h3video") { toast("以图改图需要 H3-Image 模型"); return; }
    for(const {edge,source,version} of ins){
      if(!version?.ref){showErr(n,edge.ref?`「${source.name}」引用的版本已移除`:`「${source.name}」还没有图片`);return;}
      images.push({ref:version.ref,node_id:source.id,name:source.name,...(edge.prompt_slot?{prompt_slot:edge.prompt_slot}:{})});
    }
    const resolved=resolveCanvasPrompt(n,prompt,canvasPromptBindings(ins));
    if(resolved===null)return;
    let ar = AR[d.aspect];
    if (d.aspect === "auto") { const v=ins[0]?.version; ar=v?.w&&v.h?v.w/v.h:1; }
    req = { kind: "image", model, expand: d.expand, prompt:resolved, images, ar, quality: model === "h3video" ? (d.quality === "16mp" ? "hd" : "std") : d.quality, turbo: d.turbo, seed: d.seed, count: d.count };
  }
  else {
    req = videoReq(n, prompt); if (!req) return;
    applyVideoMemory(n,req);
  }
  req.label = n.name;
  req.board = boardId;
  if (req.previs_guide || req.audio_refs || req.video_refs) {
    if (!referenceServices(n).some(x => x.id === d.provider)) {
      showErr(n, needsReferenceVideo(n) ? "请选择已配置参考视频公网地址的 Seedance 服务" : "请选择支持音频参考的 Seedance 服务");
      return;
    }
    req.provider = d.provider;
  } else if (n.data.provider && (CAPS_LIST[n.type === "image" ? "image" : "video"] || []).some(x => x.id === n.data.provider)) req.provider = n.data.provider;
  const slow = n.type === "video";
  const textInputs = grid ? [] : inputs(n, "text").map(m => ({node_id:m.id,name:m.name,role:"text",text:(m.data.text || "").slice(0,5000)}));
  const generationRecord = captureGenerationRecord(req, textInputs);
  const history=grid ? {image_grid:true,input_edges:[{...gridReference.edge,ref:gridReference.version.ref}]} :
    slow||imageInputs(n).some(({edge})=>promptSlot(edge.prompt_slot))
    ? {input_edges:structuredClone(B.edges.filter(e=>e.to===n.id)),node_data:structuredClone(n.data),
       ...(slow?{video_recipe:structuredClone(req)}:{})}
    : null;
  const layout=batchLayout;
  const batch=req.count>1 && layout!=="tabs" && !req.draft && !req.segment_edit && !req.extension
    ? {layout,data:structuredClone(grid?{...d,prompt}:d),edges:structuredClone(B.edges.filter(e=>e.to===n.id))}
    : null;
  rememberVideoVersion(n);
  const sourceBoard=B;
  prepping.add(n.id); showPrep(n, true);
  try {
    if (req.previs_guide || req.audio_refs || req.video_refs) {
      await flushSave();
      if (B!==sourceBoard || node(n.id)!==n) return;
    }
    const r = await api("/api/generate", req);
    if (B!==sourceBoard || node(n.id)!==n) return;
    if(history?.video_recipe && r.memory_context)Object.assign(history.video_recipe,r.memory_context);
    if(history?.video_recipe && r.reference_context?.video_refs) {
      Object.assign(history.video_recipe,r.reference_context);
      const clips=r.reference_context.video_refs;
      for (const edge of history.input_edges) {
        const clip=edge.relation==="video_ref" && clips.find(c=>c.node_id===edge.from && c.ref===edge.ref);
        if (clip) Object.assign(edge,{start:clip.start,end:clip.end});
      }
      for (const entry of generationRecord.inputs) {
        const clip=entry.role==="video_ref" && clips.find(c=>c.node_id===entry.node_id && c.ref===entry.ref);
        if (clip) Object.assign(entry,{start:clip.start,end:clip.end});
      }
    }
    if (r.memory_context) {
      const resolved = captureGenerationRecord({...req, ...r.memory_context}, textInputs);
      generationRecord.prompt = resolved.prompt;
      generationRecord.fields = resolved.fields;
      generationRecord.inputs.push(...resolved.inputs.filter(item => item.ref && !generationRecord.inputs.some(old=>old.ref===item.ref)));
    }
    n.job = { ids: r.ids, prompt, t0: Date.now(), st: {}, memory_used:r.memory_used||[], generation_record:generationRecord,
      ...(groupRunId ? {group_run_id:groupRunId} : {}),
      ...(batch ? {batch} : {}),
      ...(history ? {history} : {}) }; save(); render(n); showPanel(); poll();
  } catch (e) { if(B===sourceBoard&&node(n.id)===n)showErr(n, e.message); }
  finally { prepping.delete(n.id); if(B===sourceBoard&&node(n.id)===n)showPrep(n, false); }
}
function inheritedVideoAssets(n) {
  const assets = curV(n)?.memory_used, ignored = n.data.ignored_memory_ids;
  return Array.isArray(assets) ? assets.filter(asset=>typeof asset?.id==="string" &&
    !(Array.isArray(ignored) && ignored.includes(asset.id))) : [];
}
function applyVideoMemory(n, request) {
  const ids = new Set(inheritedVideoAssets(n).map(asset=>asset.id));
  if (!ids.size) return;
  request.memory_ids = [...ids];
  const selection = curV(n)?.video_recipe?.memory_views;
  if (!Array.isArray(selection)) return;
  const content = [request.prompt,...Object.values(request.fields||{})].join("\n");
  const explicitlySelected = new Set([...content.matchAll(/@\{([A-Za-z0-9_-]{1,80})#[a-z]+\|/g)].map(match=>match[1]));
  const inherited = selection.filter(entry=>ids.has(entry?.memory_id)&&!explicitlySelected.has(entry.memory_id));
  if (inherited.length) request.memory_views = inherited;
}
function videoReq(n, prompt) {
  const d = n.data;
  const guide = previsInput(n);
  const sounds = audioInputs(n);
  const clips = videoInputs(n);
  if (guide && !guide.version) { showErr(n, "白模参考版本已移除，请改用当前版本或删除连线"); return null; }
  if (sounds.some(s=>!s.version)) { showErr(n, "音频参考版本已移除，请重新连接"); return null; }
  if (clips.some(s=>!s.version)) { showErr(n, "视频参考版本已移除，请重新选择"); return null; }
  let req;
  {
    const p = plan(n), imgs = [];
    for (const [i,{edge,source:m,version:v}] of p.inputs.entries()) {
      if(!v?.ref){showErr(n,edge.ref?`「${m.name}」引用的版本已移除`:`「${m.name}」还没有图片`);return null;}
      imgs.push({ node_id: m.id, ref: v.ref, name: m.name, caption: m.data.caption || (v.source === "gen" ? v.prompt : "") || "", index: i + 1, asset: m.data.asset?.id,
                  role: p.roles[i] === "subject" ? "subject" : "frame", time: p.times[i] ?? 0, w: v.w, h: v.h,
                  ...(edge.prompt_slot?{prompt_slot:edge.prompt_slot}:{}) });
    }
    // the video's shape: chosen, or the first frame's, or a character image's
    const lead = p.ordered.length ? imgs[p.ordered[0]] : null;
    const extension=clips[0]?.edge.extension;
    const visual = (extension?clips[0].version:guide?.version) || clips[0]?.version || lead || (sounds.length ? imgs[0] : null);
    let ar = AR[d.aspect]; if (d.aspect === "auto") ar = visual?.w && visual.h ? visual.w / visual.h : 16 / 9;
    const tokenOrder=guide||sounds.length||clips.length||p.useRef?p.inputs:p.ordered.map(i=>p.inputs[i]);
    const bindings=canvasPromptBindings(tokenOrder,sounds,clips,guide,extension||clips[0]?.edge.segment_edit);
    const resolved=resolveCanvasPrompt(n,prompt,bindings);
    if(resolved===null)return null;
    const common = { kind: "video", prompt:resolved, ar, duration: d.duration, quality: d.quality, turbo: d.turbo, seed: d.seed, sound: d.sound, music: d.music, count: d.count || 1 };
    if(d.video_optics&&Object.keys(d.video_optics).length)common.video_optics=structuredClone(d.video_optics);
    if (d.draft && videoDraftAvailable(n)) common.draft=true;
    if(usesFields(n)){
      common.fields={};
      for(const [k,value] of Object.entries(d.fields||{})){
        const field=typeof value==="string"?resolveCanvasPrompt(n,value,bindings):value;
        if(field===null)return null;
        common.fields[k]=field;
      }
    }
    if (guide || sounds.length || clips.length) {
      const max = guide&&!extension ? 14 : referenceDuration(n);
      req = {...common, duration:Math.min(max,Math.max(4,d.duration)), images:imgs, planned:true, mode:guide?"previs":"reference"};
      if (guide) req.previs_guide={node_id:guide.source.id, ref:guide.edge.ref, name:guide.source.name, version:guide.index+1};
      if (sounds.length) req.audio_refs=sounds.map(({source,edge,index})=>({node_id:source.id,ref:edge.ref,name:source.name,version:index+1,
        ...(promptSlot(edge.prompt_slot)?{prompt_slot:edge.prompt_slot}:{})}));
      if (clips.length) req.video_refs=clips.map(({source,edge,index,version})=>{
        return {node_id:source.id,ref:edge.ref,name:source.name,version:index+1,...videoReferenceRange(edge,version,referenceDuration(n)),
          ...(promptSlot(edge.prompt_slot)?{prompt_slot:edge.prompt_slot}:{})};
      });
      if (extension) Object.assign(req,{extension,mode:"extension"});
      if (clips[0]?.edge.segment_edit) {
        const clip=req.video_refs[0];
        Object.assign(req,{segment_edit:true,mode:"segment_edit",duration:Math.max(4,Math.min(30,clip.end-clip.start||4))});
        if (d.camera_plan) Object.assign(req,{camera_plan:d.camera_plan,mode:"camera_retake"});
        if (d.object_edit) Object.assign(req,{object_edit:d.object_edit,mode:"object_edit"});
      }
    }
    else if (p.useRef) req = { ...common, planned: true, images: imgs };
    else req = { ...common, images: p.ordered.map(i => imgs[i]), mode: "fl2v" };
  }
  return req;
}
async function rewritePrompt(n) {
  const prompt = fullPrompt(n);
  if (usesFields(n) ? !fieldsFilled(n) : !prompt) { toast(usesFields(n) ? "至少填写场景、动作或对话中的一项" : "先写一段中文描述"); return; }
  const req = videoReq(n, prompt); if (!req) return;
  const btn = $("#rwBtn"); btn.disabled = true; btn.innerHTML = `${ico("clock")}改写中…`;
  const t0 = Date.now(), tick = setInterval(() => { if ($("#rwBtn")) $("#rwBtn").innerHTML = `${ico("clock")}改写中 ${Math.round((Date.now() - t0) / 1000)}s`; }, 1000);
  try {
    const r = await api("/api/rewrite", req);
    checkpoint();
    if (!n.data.prompt_src) { n.data.prompt_src = n.data.prompt; if (usesFields(n)) n.data.rw_from = "fields"; }
    n.data.prompt = r.prompt; n.data.pmode = "free"; save();   // the English result is edited as free text; 还原原文 brings the fields back
    const ta = $("#prompt"); if (ta._node === n.id) { ta.value = r.prompt; autoGrow(ta); }
    toast(`已按官方格式改写（${r.mode}，${r.seconds}s，${r.device}）`, 3000);
  } catch (e) { toast("改写失败：" + e.message, 4000); }
  finally { clearInterval(tick); if (sel.has(n.id)) showPanel(); }
}
async function cancel(n) { if (n.job) try { await api("/api/cancel", { ids: n.job.ids }); } catch {} }
function renderJob(n) {
  const el = els.get(n.id); if (!el || n.type === "text") return;
  const g = $(".gen", el);
  if (!n.job) { g.classList.toggle("on", toolBusy.has(n.id)); return; }
  g.classList.add("on");
  const sts = n.job.ids.map(i => n.job.st?.[i]).filter(Boolean);
  const run = sts.find(s => s.state === "running"), q = sts.find(s => s.state === "queued"), done = sts.filter(s => s.state === "done").length;
  let pct = "", msg = "提交中…", frac = 0;
  if (run) {
    if (run.max > 1 && run.value != null) { frac = run.value / run.max; pct = Math.round(frac * 100) + "%"; msg = n.data.film ? "合成成片中" : run.value >= run.max ? "解码合成中" : `生成中 · 第 ${run.value}/${run.max} 步`; }
    else { pct = "…"; msg = "加载模型 / 处理输入"; }
    if (run.phase && EW_PHASES[run.phase] && run.phase !== "sampling") { pct = "…"; msg = EW_PHASES[run.phase]+"…"; }
  } else if (q) { pct = "排队"; msg = q.prep ? "已进入队列 · 正在把提示词翻译成英文" : q.ahead > 0 ? `前面还有 ${q.ahead} 个任务` : "即将开始"; }
  const eta = Math.max(0, ...sts.filter(s => s.state !== "done").map(s => s.eta || 0));
  if (eta && (run || q)) msg += ` · ${run ? "还要" : ""}约 ${fmtT(eta)}${run ? "" : "后完成"}`;
  if (n.job.ids.length > 1) msg += ` · ${done}/${n.job.ids.length}`;
  $(".pct", g).textContent = pct; $(".bar i", g).style.width = Math.max(3, frac * 100) + "%";
  $(".s", g).textContent = msg + " · " + Math.round((Date.now() - n.job.t0) / 1000) + "s";
}
let polling = false;
function placeCanvasBatch(n, versions, batch) {
  if (versions.length<2 || !["spread","fold"].includes(batch?.layout)) return false;
  checkpoint();
  const inGroup=(B.groups || []).some(g=>g.nodes.includes(n.id));
  const reuseSource=!n.versions.length && !(batch.layout==="fold" && inGroup);
  const created=[];
  if(reuseSource) {
    n.versions.push(versions[0]);
    n.cur=0;
    created.push(n.id);
  }
  const base=ctCanvasRects([n])[0];
  const data={...batch.data,count:1};
  delete data.asset;
  delete data.character_draft;
  let x=base.x+base.w+95;
  const incoming=versions[0].input_edges || batch.edges;
  for(let i=reuseSource?1:0;i<versions.length;i++) {
    const id=newCanvasNodeId();
    const version=versions[i];
    const inputEdges=incoming.filter(edge=>node(edge.from) && edge.from!==id)
      .map(edge=>({...edge,to:id}));
    if(n.type==="video" || version.input_edges) {
      version.input_edges=structuredClone(inputEdges);
      version.node_data=structuredClone(data);
      if(version.video_recipe)version.video_recipe={...version.video_recipe,count:1};
    }
    const result={id,type:n.type,name:`${n.name} · 结果 ${i+1}`,data:structuredClone(data),versions:[version],cur:0,job:null};
    const dimensions=size(result);
    Object.assign(result,freeSpot(x,base.y,n.type,dimensions));
    B.nodes.push(result); B.edges.push(...inputEdges); build(result);
    created.push(id);
    x=result.x+dimensions.w+95;
  }
  if(batch.layout==="fold") {
    const group=ctNewGroup(n.name.slice(0,53)+" · 批量结果",created), first=node(created[0]);
    ctSetFold(group,true,{recordUndo:false,anchor:{x:first.x-20,y:first.y-64}});
  }
  toast(batch.layout==="fold"?`已收起 ${created.length} 个生成结果`:`已在画布展开 ${created.length} 个生成结果`);
  return true;
}
async function poll() {
  if (polling) return; polling = true;
  try {
    for (;;) {
      const act = B.nodes.filter(n => n.job); if (!act.length) break;
      let st;
      try { st = await (await fetch("/api/jobs?ids=" + act.flatMap(n => n.job.ids).join(","))).json(); } catch { await sleep(3000); continue; }
      for (const n of act) {
        if(!n.job || node(n.id)!==n) continue;
        n.job.st = st;
        const sts = n.job.ids.map(i => st[i]).filter(Boolean);
        if (!(sts.length === n.job.ids.length && sts.every(s => s.state === "done" || s.state === "error"))) { renderJob(n); continue; }
        if (n.job.agent_call) { await acSyncAgentJobs(); if (node(n.id)?.job) renderJob(node(n.id)); continue; }
        const errs = sts.filter(s => s.state === "error").map(s => s.error);
        const actualSource = n.job.source || (n.data.film ? "film" : "gen");
        const finalizing=!!n.job.history?.draft_final;
        const restoreVersion = finalizing || !!n.job.history?.film_recipe?.timeline;
        const job=n.job;
        const versions=[];
        for (const s of sts.filter(s => s.state === "done")) for (const o of s.outputs || []) {
          const m = o.meta || {};
          const receipt = n.job.generation_record;
          const generation = receipt && {generation_record:{...receipt, service:s.meta?.provider || receipt.service,
            effective_prompt:s.meta?.prompt || receipt.effective_prompt,
            settings:{...receipt.settings,...(s.meta?.model ? {provider_model:s.meta.model} : {})}}};
          versions.push({ ref: o.ref, url: o.url, prompt: n.job.prompt, seed: s.meta?.seed, w: m.width || s.meta?.width, h: m.height || s.meta?.height, seconds: m.duration, source: actualSource, memory_used: n.job.memory_used||[], mode: s.meta?.mode_name, ...(o.extra || {}), ...(n.job.history || {}), ...generation, ...(job.group_run_id?{group_run_id:job.group_run_id}:{}) });
        }
        const batch=n.job.batch;
        n.job = null;
        if (finalizing) delete n.draft_finalize_attempt;
        if (versions.length && !placeCanvasBatch(n,versions,batch)) {
          n.versions.push(...versions);
          if(restoreVersion)switchVersion(n,n.versions.length-1,{recordUndo:false});
          else n.cur=n.versions.length-1;
        }
        groupRunJobFinished(n,job,versions,errs);
        if (n.type==="audio" && canvasCanEdit()) {
          versions.forEach(version=>addGeneratedAudioSubtitle(n,version));
          if (versions.some(version=>version.audio_recipe?.subtitles && !version.audio_transcript)) toast("配音已保存，服务未返回字幕时间码");
        }
        save(); render(n); refreshDownstream(n); drawEdges();
        if (actualSource === "previs") pvFinished(n,errs.join("\n"));
        if (sel.has(n.id)) showPanel();
        showErr(n, errs.length ? "生成失败：" + errs.join("\n") : "");
        if (!errs.length) loadAssets();
      }
      await sleep(1200);
    }
  } finally { polling = false; }
}

// ================================================================= uploads, assets, frames
let pickCb = null;
function pickFiles(cb) { pickCb = cb; $("#file").click(); }
$("#file").onchange = e => { const f = [...e.target.files]; e.target.value = ""; if (f.length && pickCb) pickCb(f); pickCb = null; };
const CANVAS_CLIPBOARD_EXT = {
  "image/png":"png","image/jpeg":"jpg","image/webp":"webp",
  "video/mp4":"mp4","video/quicktime":"mov","video/webm":"webm",
  "audio/mpeg":"mp3","audio/wav":"wav","audio/x-wav":"wav","audio/mp4":"m4a",
  "audio/aac":"aac","audio/flac":"flac","audio/ogg":"ogg",
};
function canvasUploadKind(file) {
  if (CM_DOCUMENT_EXT.test(file.name)) return "text";
  if (/\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(file.name)) return "audio";
  if (/\.(mp4|mov|webm|m4v|mkv)$/i.test(file.name)) return "video";
  if (/\.(png|jpe?g|webp)$/i.test(file.name)) return "image";
  if (file.type.startsWith("audio/") && CANVAS_CLIPBOARD_EXT[file.type]) return "audio";
  if (file.type.startsWith("video/")) return "video";
  return file.type.startsWith("image/") ? "image" : "";
}
const imgSize = url => new Promise(r => { const i = new Image(); i.onload = () => r([i.naturalWidth, i.naturalHeight]); i.onerror = () => r([0, 0]); i.src = url; });
function addVersion(n, v) {
  checkpoint(); n.versions.push(v); n.cur = n.versions.length - 1; save(); render(n); refreshDownstream(n); drawEdges(); if (sel.has(n.id)) showPanel();
}
async function uploadInto(n, file) {
  showErr(n, "");
  const board=B;
  try {
    const {name,data,version}=await readCanvasFile(file,n.type);
    if (B!==board || node(n.id)!==n) return;
    if (name && n.name.startsWith(TYPE_CN[n.type]+" ")) n.name=name;
    if (!n.data.caption && data.caption) n.data.caption=data.caption;
    addVersion(n,version);loadAssets();
  } catch (e) { if (B===board && node(n.id)===n) showErr(n, "上传失败：" + e.message); }
}
async function readCanvasFile(file, kind) {
  const body=new FormData(), stem=file.name.replace(/\.[^.]+$/,"");
  if(kind==="text"){
    body.append("file",file);
    const doc=await (await fetchOk("/api/document-import",{method:"POST",body})).json();
    if(doc.truncated || doc.text.length>20_000)throw new Error("正文超过单个画布文档的 20,000 字符上限");
    return {name:stem.slice(0,80),data:{text:doc.text,...(/\.(md|markdown)$/i.test(file.name)?{text_format:"markdown"}:{})}};
  }
  const extension=CANVAS_CLIPBOARD_EXT[file.type];
  const filename=/\.[^.]+$/.test(file.name) || !extension?file.name:`${stem||"paste"}.${extension}`;
  body.append(kind==="audio"?"file":"image",file,filename||"paste.png");
  const result=await (await fetchOk(kind==="audio"?"/api/upload_audio":"/api/upload",{method:"POST",body})).json();
  const [w,h]=kind==="image"?await imgSize(result.url):[result.w,result.h];
  const caption=stem.replace(/[-_ ]?\d+$/,"").replace(/^(image|paste|IMG|DSC|Screenshot).*$/i,"");
  return {name:stem.slice(0,kind==="audio"?40:24),data:kind==="image"?{caption}:{},
    version:{ref:result.ref,url:result.url,w,h,seconds:result.seconds,source:"upload",prompt:""}};
}
async function importCanvasFiles(files, at, target=null) {
  if (!canvasCanEdit() || !files.length) return;
  const board=B, epoch=boardOpenEpoch, imports=[], errors=[];
  const current=()=>B===board && boardOpenEpoch===epoch && canvasCanEdit();
  toast(`正在导入 ${files.length} 个文件…`);
  for(const file of files){
    if(!current())return;
    const kind=canvasUploadKind(file);
    if(!kind){errors.push(`${file.name}：不支持此格式`);continue;}
    try{imports.push({kind,...await readCanvasFile(file,kind)});}
    catch(error){errors.push(`${file.name}：${error.message}`);}
  }
  if(!current())return;
  if(imports.length){
    checkpoint();
    let x=at.x;
    for(const {kind,name,data,version} of imports){
      const extra=version?{versions:[version],cur:0}:{};
      const dims=size({type:kind,data:{...defaults(kind),...data},versions:extra.versions||[],cur:extra.cur??-1});
      const spot=freeSpot(x,at.y,kind,dims);
      const n=addNode(kind,spot.x,spot.y,data,{...extra,...(name?{name}:{})});
      if(target && node(target.id)===target && canLink(n,target))link(n,target,true);
      x=spot.x+dims.w+100;
    }
    if(imports.some(item=>item.version))loadAssets();
  }
  const completed=imports.length?`已导入 ${imports.length} 个文件`:"导入失败";
  toast(errors.length?`${completed} · ${errors.length} 个未导入 · ${errors[0]}`:completed,errors.length?5500:2200);
}
vp.addEventListener("dragover", e => e.preventDefault());
vp.addEventListener("drop", e => {
  e.preventDefault(); if (!canvasCanEdit()) return;
  const at = toW(e.clientX, e.clientY);
  const a = e.dataTransfer.getData("application/x-h3-asset");
  if (a) { placeAsset(JSON.parse(a), at); return; }
  void importCanvasFiles(Array.from(e.dataTransfer.files),at);
});
addEventListener("paste", e => {
  if (e.defaultPrevented || !canvasCanEdit() || e.target.closest?.("input, textarea, [contenteditable]:not([contenteditable=false]), [role=dialog]")) return;
  const files=Array.from(e.clipboardData?.files||[]);
  if(!files.some(canvasUploadKind))return;
  e.preventDefault();
  const kind=files.length===1&&canvasUploadKind(files[0]);
  const selected=sel.size===1?node([...sel][0]):null;
  if(kind!=="text" && selected?.type===kind && !curV(selected) && !selected.job && !prepping.has(selected.id)){
    void uploadInto(selected,files[0]);return;
  }
  void importCanvasFiles(files,toW(innerWidth/2-150,innerHeight/2-180));
});
function frameCaptureSuffix(position, at) {
  return position === "first" ? "首帧" : position === "last" ? "末帧" : at.toFixed(2) + " 秒";
}
async function captureOnCanvas(sourceId, version, {position, at, before=false, active=()=>true, allowDetached=false, onCaptured=null, select=true}={}) {
  if (!canvasCanEdit() || !version?.ref) return null;
  const board = boardId, epoch = boardOpenEpoch;
  const result = await api("/api/lastframe", {ref:version.ref, position, at});
  if (boardId !== board || epoch !== boardOpenEpoch || !canvasCanEdit() || !active()) return null;
  const source = vtResolve(sourceId, version.ref)?.node;
  if (!source && !allowDetached) throw new Error("取帧所用的原视频版本已移除");
  const anchor = source ? {x:before ? source.x-430 : source.x+size(source).w+110,y:source.y}
    : toW(innerWidth / 2 - 150, innerHeight / 2 - 160);
  const point = freeSpot(anchor.x, anchor.y, "image");
  const time = result.at ?? at ?? null;
  const title = source?.name || "剪辑片段";
  checkpoint();
  const image = addNode("image", point.x, point.y, {caption:(version.prompt || "").slice(0,200)},
    {name:title+" · "+frameCaptureSuffix(position,time)});
  const capture = {source_node:source?.id || "",source_ref:version.ref,position,at:time};
  image.versions.push({ref:result.ref,url:result.url,w:result.w,h:result.h,source:"frame",prompt:"",capture});
  image.cur=0;
  if (source) B.edges.push({from:source.id,to:image.id,relation:"capture",source_ref:version.ref,at:time});
  const selected=onCaptured?.(image)||image;
  render(image);if(selected!==image)render(selected);
  if(select)selectOnly(selected.id);
  save();loadAssets();
  return image;
}
async function continueFrom(n, extension) {
  const v = curV(n); if (!v) return toast("还没有视频");
  try {
    const before=extension.direction==="before";
    const img=await captureOnCanvas(n.id,v,{position:before?"first":"last",before});
    if (!img) return;
    const at2 = freeSpot(before?img.x-460:img.x+size(img).w+110,img.y,"video");
    const vid = addNode("video",at2.x,at2.y,{duration:extension?.duration || n.data.duration,quality:n.data.quality,turbo:n.data.turbo,aspect:n.data.aspect,
      ...(extension?{prompt:extension.prompt}: {})},extension?{name:n.name+" · "+extensionLabel(extension.direction)}:{});
    link(img,vid,true);
    if (before) {B.edges.find(edge=>edge.from===img.id&&edge.to===vid.id).role="last";refresh(vid);save();}
    selectOnly(vid.id); setTimeout(() => $("#prompt").focus(), 30);
    toast(before?"已用原视频首帧作为新片段尾帧":"已截取最后一帧，写下一段的提示词继续生成");
  } catch (e) { toast("截帧失败：" + e.message); }
}
function closeFrameCapture() {
  const dialog=$("#frameCapture");
  if (!dialog.open) return;
  const player=$("video",dialog);
  player.pause();player.removeAttribute("src");
  if (dialog.close) dialog.close(); else dialog.removeAttribute("open");
}
function openFrameCapture(source) {
  const version=curV(source), dialog=$("#frameCapture");
  if (!canvasCanEdit() || !version || dialog.open) return;
  const player=$("video",dialog), status=$("[data-capture-status]",dialog);
  const buttons=$$("[data-capture-position]",dialog);
  status.textContent="";
  player.src=version.url;
  $("[data-capture-source]",dialog).textContent=source.name+" · 版本 "+(source.cur+1);
  buttons.forEach(button=>{
    button.disabled=false;
    const capture=async()=>{
      const position=button.dataset.capturePosition;
      if (position==="time" && player.readyState<1) {status.textContent="视频正在加载，请稍后截取当前帧";return;}
      buttons.forEach(control=>control.disabled=true);
      status.textContent="正在截帧…";
      const active=()=>dialog.open && button.onclick===capture;
      try {
        const image=await captureOnCanvas(source.id,version,{position,at:position==="time"?player.currentTime:undefined,active});
        if (image && active()) closeFrameCapture();
      } catch(error) {
        if (active()) status.textContent=error.message;
      } finally {
        if (active()) buttons.forEach(control=>control.disabled=false);
      }
    };
    button.onclick=capture;
  });
  $("[data-capture-close]",dialog).onclick=closeFrameCapture;
  dialog.oncancel=event=>{event.preventDefault();closeFrameCapture();};
  if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open","");
}
let assetsCache = [], afilter = "all";
async function loadAssets() {
  if (!$("#drawer").classList.contains("on")) return;
  if (KIND_CN[afilter]) { $("#drawer .h").textContent = "点击或拖到画布上使用；输入 @ 采用设定与参考图；右上角查看记忆和版本"; return renderLibrary(afilter); }
  $("#drawer .h").textContent = "点击或拖到画布上使用";
  try { assetsCache = await (await fetch("/api/assets")).json(); } catch { return; }
  const g = $("#agrid"), list = assetsCache.filter(a => afilter === "all" || a.type === afilter);
  g.innerHTML = list.map(a => `<div class="as" draggable="true" data-i="${assetsCache.indexOf(a)}">${a.type === "video" ? `<video src="${a.url}#t=0.5" preload="metadata" muted></video>` : a.type==="audio" ? `<div class="asset-audio">${ico("audio")}</div>` : `<img src="${a.url}" loading="lazy">`}<span class="ty">${a.type === "audio" || a.type==="video" ? TYPE_CN[a.type] : a.source === "upload" ? "上传" : a.source === "frame" ? "截帧" : "生成"}</span></div>`).join("") || `<div class="h">还没有素材</div>`;
  $$(".as", g).forEach(d => {
    const a = assetsCache[+d.dataset.i];
    d.addEventListener("dragstart", e => e.dataTransfer.setData("application/x-h3-asset", JSON.stringify(a)));
    d.onclick = () => placeAsset(a, toW(innerWidth / 2 - 150, innerHeight / 2 - 180));
  });
}
async function placeAsset(a, at) {
  const n = addNode(a.type, at.x, at.y);
  let w = 0, h = 0, seconds;
  if (a.type === "image") [w, h] = await imgSize(a.url);
  else await new Promise(r => { const v = document.createElement(a.type); v.preload = "metadata"; v.onloadedmetadata = () => { w = v.videoWidth; h = v.videoHeight; seconds = Number.isFinite(v.duration) ? v.duration : undefined; r(); }; v.onerror = r; v.src = a.url; });
  if (node(n.id)!==n) return;
  n.versions.push({ ref:a.ref,url:a.url,w,h,seconds,source:a.source,prompt:"" }); n.cur = 0; render(n); save(); selectOnly(n.id);
}
$$("#drawer .tabs button").forEach(b => b.onclick = () => { $$("#drawer .tabs button").forEach(x => x.classList.remove("on")); b.classList.add("on"); afilter = b.dataset.f; loadAssets(); });
