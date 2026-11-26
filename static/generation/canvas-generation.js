"use strict";

// ================================================================= generation
async function api(path, body, method = "POST") {
  const r = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { error: t }; }
  if (!r.ok) throw new Error(j.error || t || r.statusText); return j;
}
function fullPrompt(n) {
  const parts = inputs(n, "text").map(t => typeof t.data.text === "string" ? t.data.text.trim() : "").filter(Boolean);
  const prompt = typeof n.data.prompt === "string" ? n.data.prompt.trim() : "";
  if (!usesFields(n) && prompt) parts.push(prompt);   // field mode: the fields replace the free text
  return parts.join("\n");
}
function showErr(n, msg) { const b = $(".errbox", els.get(n.id)); b.textContent = msg || ""; b.classList.toggle("on", !!msg); }
function canvasGenerationError(n) { return els.get(n.id)?.querySelector(".errbox")?.textContent || ""; }
const usesFields = n => !!n && n.type === "video" && n.data.pmode === "fields";
const fieldsFilled = n => FIELDS.some(f => !["sound", "music"].includes(f.k) && (n.data.fields?.[f.k] || "").trim());
const prepping = new Set();   // nodes whose request is being submitted before it reaches the queue
const generationPreviews = new WeakMap();

function generationPreviewSignature(request) {
  return JSON.stringify(Object.keys(request).filter(key=>key!=="label").sort().map(key=>[key,request[key]]));
}
const BATCH_LAYOUTS = {tabs:"同一节点的版本 Tab",spread:"在画布横向展开",fold:"收起为一组"};
function canvasBatchLayout() {
  return Object.hasOwn(BATCH_LAYOUTS,B?.batch_layout)?B.batch_layout:"tabs";
}

function canvasGenerationCount(n) {
  if (n.data.quality_precheck && videoQualityPrecheckAvailable(n)) return 1;
  const max = n.type === "audio" ? 1 : n.type === "video" ? 3 : 4;
  return Math.max(1,Math.min(max,Math.trunc(Number(n.data.count)) || 1));
}

function canvasCostRequest(n) {
  const data = n.data;
  if (n.type === "audio") return {kind:"audio",mode:audioMode(data),provider:data.provider};
  const request = {kind:n.type,count:canvasGenerationCount(n),
    provider:(CAPS_LIST[n.type] || []).find(service=>service.id===data.provider)?.id,
    selected_model:data.selected_model};
  if (data.selected_model || (n.type==="video" && data.provider==="local_h3")) request.provider = data.provider;
  if (n.type === "video") {
    const prompt=fullPrompt(n), inputs=plan(n);
    Object.assign(request,{
      duration:canvasVideoDuration(n),quality:canvasVideoQuality(n),draft:data.draft && videoDraftAvailable(n),
      images:(inputs.useRef?inputs.roles:inputs.ordered.map(index=>inputs.roles[index]))
        .map(role=>({role:role==="subject"?"subject":"frame"})),
      has_asset:!!data.replay_memory_ref || inheritedVideoAssets(n).length>0 ||
        /@/.test([prompt,...Object.values(data.fields || {})].join("\n")
          .replace(/@(?:图|视频|音频|音)(?:\{\d{1,16}\}|\d+)/g,"")),
      previs_guide:!!previsInput(n),audio_refs:!!audioInputs(n).length,video_refs:!!videoInputs(n).length
    });
    if (request.has_asset || request.previs_guide || request.audio_refs || request.video_refs) {
      const video=videoReq(n,prompt,{silent:true});
      if (video) {
        applyVideoMemory(n,video);
        return {...video,board:boardId,provider:request.provider,selected_model:request.selected_model};
      }
      return {...request,has_asset:true};
    }
  }
  return request;
}

async function canvasGenerationCosts(requests) {
  const amounts = [];
  for (let i = 0; i < requests.length; i += 200) {
    const batch = requests.slice(i,i+200);
    try {
      const response = await api("/api/generation-cost",{requests:batch});
      amounts.push(...response.amounts);
    } catch {
      amounts.push(...batch.map(()=>null));
    }
  }
  return amounts;
}

function displayGenerationCost(amount) {
  if (!Number.isFinite(amount)) return "费用暂无法估算";
  return "预计费用 ¥" + amount.toLocaleString("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:4});
}

let canvasCostTimer, canvasCostRevision=0;
function renderCanvasCost(n, output) {
  clearTimeout(canvasCostTimer);
  const revision=++canvasCostRevision;
  if (!output) return;
  output.textContent=OneShotI18n.t("正在估算费用…");
  canvasCostTimer = setTimeout(async ()=>{
    if (!output.isConnected || !sel.has(n.id)) return;
    const [amount] = await canvasGenerationCosts([canvasCostRequest(n)]);
    if (revision===canvasCostRevision && output.isConnected && sel.has(n.id)) output.textContent = displayGenerationCost(amount);
  },250);
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
function resolveCanvasPrompt(n,text,bindings,{silent=false}={}) {
  let missing=false;
  const resolved=text.replace(/@(图|视频|音)\{\d+\}/g,(token,kind)=>{
    if(!bindings.has(token))missing=kind;
    return bindings.get(token)||token;
  });
  if(missing){
    if(!silent)showErr(n,`提示词中的 ${{图:"图片",视频:"视频",音:"音频"}[missing]}引用已断开，请重新选择或删除该引用`);
    return null;
  }
  return resolved;
}
function showPrep(n, on) {
  const el = els.get(n.id); if (!el) return;
  const g = $(".gen", el);
  if (!on) { renderJob(n); if (!n.job) g.classList.toggle("on", toolBusy.has(n.id)); return; }
  g.classList.add("on"); $(".pct", g).textContent = OneShotI18n.t("译"); $(".bar i", g).style.width = "3%";
  $(".s", g).textContent = OneShotI18n.t("提交中…");
}
function captureGenerationRecord(request, textInputs) {
  const settings = Object.fromEntries(["model","provider_model","provider","quality","ar","duration","seed","count","extension"]
    .filter(key => request[key] != null).map(key => [key,request[key]]));
  if (request.selected_model) settings.provider_model = request.selected_model;
  const images = (request.images || []).map(({node_id,ref,role,time,name,memory_id,memory_view,image_use}) => {
    const n = node_id ? node(node_id) : null;
    const index = n ? (curV(n)?.ref === ref ? n.cur : n.versions.findIndex(v=>v.ref===ref)) : -1;
    return {node_id, ref, role, time, name, memory_id, memory_view, image_use, version:index >= 0 ? index+1 : undefined};
  });
  if (request.previs_guide) images.push({...request.previs_guide, role:"previs"});
  for (const clip of request.video_refs || []) images.push({...clip,role:"video_ref"});
  for (const audio of request.audio_refs || []) images.push({...audio, role:"audio_ref"});
  return {settings, prompt:request.prompt, fields:request.fields, mode:request.mode, camera_plan:request.camera_plan,
    video_optics:request.video_optics,
    object_edit:request.object_edit,inputs:[...textInputs,...images]};
}

function previsComposition(n) {
  const guide=n?.type==="image" && n.data.previs_composition;
  if (!guide?.ref) return null;
  const version=n.versions.find(v=>v.ref===guide.ref && v.source==="previs-frame");
  return {ref:guide.ref,enabled:guide.enabled!==false,version};
}

function storyboardFrameReady(n) {
  const current=curV(n), guide=previsComposition(n);
  return storyboardVersionReady(n) &&
    !(guide?.enabled && current.ref===guide.ref && current.source==="previs-frame");
}
function storyboardVersionReady(n) {
  const version=curV(n);
  return !!version&&!n.data.storyboard_stale_refs?.includes(version.ref);
}

function previsCompositionHasRoom(n, guide, refs) {
  return isRemote(n) || refs.length<9 || refs.slice(0,9).includes(guide.ref);
}

function canBranchGeneration(n) {
  return canvasCanEdit() && canvasMediaUploadTarget(n) && n.type!=="audio" &&
    !!curV(n) && !n.job && !prepping.has(n.id) && !previsComposition(n)?.enabled;
}

async function generate(n, {batchLayout=canvasBatchLayout(),groupRunId,imageGrid=false,assetReviewKey,branch=false,reviewedImage=false}={}) {
  if (branch && !canBranchGeneration(n)) return;
  if (n.type === "audio") return generateAudio(n,{groupRunId});
  if (n.data.previs) return openPrevis(n);
  if (n.type === "script") return planStoryboard(n);
  if (n.job) return toast("这个节点仍有生成任务，请等待完成或取消");
  if (prepping.has(n.id)) return toast("这个节点正在准备提交，请稍等");
  if (draftFinalEdge(n)) return openVideoDraftFinal(n);
  const grid = imageGrid && n.type==="image";
  const d = n.data, prompt = grid ? GRID9_PROMPT : fullPrompt(n); delete n.agent_error; showErr(n, "");
  const hasEditPlan=n.type==="video" && (d.camera_plan || d.object_edit) && videoInputs(n)[0]?.edge.segment_edit;
  if (!hasEditPlan && (usesFields(n) ? !fieldsFilled(n) : !prompt)) { toast(usesFields(n) ? "至少填写场景、动作或对话中的一项" : OneShotI18n.t("先写提示词，或连入一个文本节点")); if (!usesFields(n)) $("#prompt").focus(); return; }
  let req, gridReference;
  if (n.type === "image") {
    const image=imageCanvasRequest(n,prompt,{grid});
    if (!image) return;
    ({request:req,gridReference}=image);
  }
  else {
    req = videoReq(n, prompt); if (!req) return;
    applyVideoMemory(n,req);
  }
  if (branch) req.count=1;
  req.label = n.name;
  req.board = boardId;
  if (d.replay_memory_ref) req.replay_memory_ref=d.replay_memory_ref;
  if (req.previs_guide || req.audio_refs || req.video_refs) {
    const services=referenceServices(n);
    if (!services.length || d.provider && !services.some(x=>x.id===d.provider)) {
      showErr(n, needsReferenceVideo(n) ? "请选择已配置公网地址的视频参考服务" : "请选择支持音频参考的视频服务");
      return;
    }
    if (d.provider) req.provider=d.provider;
  } else if ((n.type==="video" && d.provider==="local_h3") ||
             (CAPS_LIST[n.type] || []).some(x => x.id === d.provider)) req.provider=d.provider;
  if (d.selected_model) Object.assign(req,{provider:d.provider,selected_model:d.selected_model});
  const slow = n.type === "video";
  const textInputs = grid ? [] : inputs(n, "text").map(m => ({node_id:m.id,name:m.name,role:"text",text:(m.data.text || "").slice(0,5000)}));
  const generationRecord = captureGenerationRecord(req, textInputs);
  const history=grid ? {image_grid:true,input_edges:[{...gridReference.edge,ref:gridReference.version.ref}]} :
    {input_edges:structuredClone(B.edges.filter(e=>e.to===n.id)),node_data:structuredClone(n.data),
     ...(slow?{video_recipe:structuredClone(req)}:{})};
  const layout=branch?"branch":previsComposition(n)?"tabs":batchLayout;
  const batch=branch || (req.count>1 && layout!=="tabs" && !req.draft && !req.segment_edit && !req.extension)
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
    const preview=generationPreviews.get(n);
    const checked=preview?.signature===generationPreviewSignature(req);
    if (reviewedImage && (!checked || !preview.imageKey)) {
      showErr(n,OneShotI18n.t("生成设置已变化，请重新预览"));
      return;
    }
    const rememberedAssetKey=assetReviewKey|| (checked?preview.assetKey:null);
    const r = await api("/api/generate",{...req,...(checked&&preview.key?{reference_preview:preview.key}:{}),
      ...(reviewedImage?{image_preview:preview.imageKey}:{}),
      ...(rememberedAssetKey?{asset_review_key:rememberedAssetKey}:{})});
    if (B!==sourceBoard || node(n.id)!==n) return;
    if (r.image_story_context === "unavailable") toast("世界观细节暂时无法提取，本次按镜头描述生图", 4500);
    if(history?.video_recipe && r.memory_context)Object.assign(history.video_recipe,r.memory_context);
    if(history?.video_recipe && r.video_model) {
      Object.assign(history.video_recipe,r.video_model);
      Object.assign(history.node_data,r.video_model);
    }
    if(history?.video_recipe && r.reference_context) {
      Object.assign(history.video_recipe,r.reference_context);
      history.input_edges=vtEdgesWithReferenceRanges(history.input_edges,r.reference_context);
    }
    if (r.memory_context || r.reference_context || r.video_model) {
      Object.assign(generationRecord,captureGenerationRecord({...req,...r.memory_context,...r.reference_context,...r.video_model},textInputs));
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
  return Array.isArray(assets) ? assets.filter(asset=>typeof asset?.id==="string" && !asset.story_auto &&
    !(Array.isArray(ignored) && ignored.includes(asset.id))) : [];
}
function applyVideoMemory(n, request) {
  if (n.data.replay_memory_ref) {
    request.replay_memory_ref=n.data.replay_memory_ref;
    return;
  }
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
function videoReq(n, prompt, {silent=false}={}) {
  const d = n.data;
  const guide = previsInput(n);
  const sounds = audioInputs(n);
  const clips = videoInputs(n);
  const missingReference = message => { if(!silent)showErr(n,message); return null; };
  if (d.quality_precheck && !videoQualityPrecheckAvailable(n))
    return missingReference(OneShotI18n.t("当前设置无法预检，请选择本地 H3 BF16 或关闭质量预检"));
  if (guide && !guide.version) return missingReference("白模参考版本已移除，请改用当前版本或删除连线");
  if (sounds.some(s=>!s.version)) return missingReference("音频参考版本已移除，请重新连接");
  if (clips.some(s=>!s.version)) return missingReference("视频参考版本已移除，请重新选择");
  let req;
  {
    const p = plan(n), imgs = [];
    for (const [i,{edge,source:m,version:v}] of p.inputs.entries()) {
      if(!v?.ref)return missingReference(edge.ref?`「${m.name}」引用的版本已移除`:`「${m.name}」还没有图片`);
      imgs.push({ node_id: m.id, ref: v.ref, name: m.name, caption: m.data.caption || (v.source === "gen" ? v.prompt : "") || "", index: i + 1, asset: m.data.asset?.id,
                  role: p.roles[i] === "subject" ? "subject" : "frame", time: p.times[i] ?? 0, w: v.w, h: v.h,
                  ...(edge.story_cast&&!edge.ref?{story_cast:true}:{}),
                  ...(edge.prompt_slot?{prompt_slot:edge.prompt_slot}:{}) });
    }
    // the video's shape: chosen, or the first frame's, or a character image's
    const lead = p.ordered.length ? imgs[p.ordered[0]] : null;
    const extension=clips[0]?.edge.extension;
    const visual = (extension?clips[0].version:guide?.version) || clips[0]?.version || lead || (sounds.length ? imgs[0] : null);
    let ar = AR[d.aspect]; if (d.aspect === "auto") ar = visual?.w && visual.h ? visual.w / visual.h : 16 / 9;
    const tokenOrder=guide||sounds.length||clips.length||p.useRef?p.inputs:p.ordered.map(i=>p.inputs[i]);
    const bindings=canvasPromptBindings(tokenOrder,sounds,clips,guide,extension||clips[0]?.edge.segment_edit);
    const resolved=resolveCanvasPrompt(n,prompt,bindings,{silent});
    if(resolved===null)return null;
    const common = { kind: "video", prompt:resolved, ar, duration:canvasVideoDuration(n), quality:canvasVideoQuality(n), turbo: d.turbo, seed: d.seed, sound: d.sound, music: d.music, count: canvasGenerationCount(n) };
    if (d.quality_precheck) common.quality_precheck=true;
    if(d.video_optics&&Object.keys(d.video_optics).length)common.video_optics=structuredClone(d.video_optics);
    if (d.draft && videoDraftAvailable(n)) Object.assign(common,{draft:true,quality:"std"});
    if(usesFields(n)){
      common.fields={};
      for(const [k,value] of Object.entries(d.fields||{})){
        const field=typeof value==="string"?resolveCanvasPrompt(n,value,bindings,{silent}):value;
        if(field===null)return null;
        common.fields[k]=field;
      }
    }
    if (guide || sounds.length || clips.length) {
      const max = guide&&!extension ? 14 : referenceDuration(n);
      req = {...common, duration:Math.min(max,Math.max(4,common.duration)), images:imgs, planned:true, mode:guide?"previs":"reference"};
      if (guide) req.previs_guide={node_id:guide.source.id, ref:guide.edge.ref, name:guide.source.name, version:guide.index+1};
      if (sounds.length) req.audio_refs=sounds.map(({source,edge,index})=>({node_id:source.id,ref:edge.ref,name:source.name,version:index+1,
        start:edge.start,end:edge.end,
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
  if (usesFields(n) ? !fieldsFilled(n) : !prompt) { toast(usesFields(n) ? "至少填写场景、动作或对话中的一项" : OneShotI18n.t("先写一段中文描述")); return; }
  const req = videoReq(n, prompt); if (!req) return;
  if (n.data.selected_model) Object.assign(req, {provider: n.data.provider, selected_model: n.data.selected_model});
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
  const tr = OneShotI18n.t;
  let pct = "", msg = tr("提交中…"), frac = 0;
  if (run) {
    if (run.max > 1 && run.value != null) { frac = run.value / run.max; pct = Math.round(frac * 100) + "%"; msg = n.data.film ? tr("合成成片中") : run.value >= run.max ? tr("解码合成中") : tr("生成中 · 第 {step}/{total} 步", {step:run.value,total:run.max}); }
    else { pct = "…"; msg = tr("加载模型 / 处理输入"); }
    if (run.phase && EW_PHASES[run.phase] && run.phase !== "sampling") { pct = "…"; msg = tr(EW_PHASES[run.phase])+"…"; }
  } else if (q) { pct = tr("排队"); msg = q.prep ? tr("已进入队列 · 正在把提示词翻译成英文") : q.ahead > 0 ? tr(q.ahead === 1 ? "前面还有 1 个任务" : "前面还有 {count} 个任务",{count:q.ahead}) : tr("即将开始"); }
  const review=(run||q)?.meta?.quality_review;
  if (review) {
    msg = videoQualityProgress(review,run||q);
    if (Number.isInteger((run||q).engine_queue)) pct = tr("排队");
  }
  const eta = review ? 0 : Math.max(0, ...sts.filter(s => s.state !== "done").map(s => s.eta || 0));
  if (eta && (run || q)) msg += " · " + tr(run ? "还要约 {duration}" : "约 {duration} 后完成", {duration:fmtT(eta)});
  if (n.job.ids.length > 1) msg += ` · ${done}/${n.job.ids.length}`;
  $(".pct", g).textContent = pct; $(".bar i", g).style.width = Math.max(3, frac * 100) + "%";
  $(".s", g).textContent = msg + " · " + Math.round((Date.now() - n.job.t0) / 1000) + "s";
}
let polling = false;
function placeCanvasBatch(n, versions, batch) {
  const branch = batch?.layout==="branch";
  if (!branch && (versions.length<2 || !["spread","fold"].includes(batch?.layout))) return false;
  checkpoint();
  const inGroup=(B.groups || []).some(g=>g.nodes.includes(n.id));
  const reuseSource=!branch && !n.versions.length && !(batch.layout==="fold" && inGroup);
  const created=[];
  if(reuseSource) {
    n.versions.push(versions[0]);
    n.cur=0;
    created.push(n.id);
  }
  const base=ctCanvasRects([n])[0];
  const data={...(branch && versions[0].node_data || batch.data),count:1};
  delete data.asset;
  delete data.character_draft;
  let x=base.x+base.w+95;
  const incoming=versions[0].input_edges || batch.edges;
  for(let i=reuseSource?1:0;i<versions.length;i++) {
    const id=newCanvasNodeId();
    const version=versions[i];
    const recordedImages = branch ? new Map((version.generation_record?.inputs || [])
      .filter(input=>input.node_id && input.ref && node(input.node_id)?.type==="image")
      .map(input=>[input.node_id,input.ref])) : new Map();
    const inputEdges=incoming.filter(edge=>node(edge.from) && edge.from!==id)
      .map(edge=>({...edge,to:id,...(recordedImages.has(edge.from)?{ref:recordedImages.get(edge.from)}:{})}));
    if(n.type==="video" || version.input_edges) {
      version.input_edges=structuredClone(inputEdges);
      version.node_data=structuredClone(data);
      if(version.video_recipe)version.video_recipe={...version.video_recipe,count:1};
    }
    const result={id,type:n.type,name:branch && versions.length===1?`${n.name} · 新结果`:`${n.name} · 结果 ${i+1}`,data:structuredClone(data),versions:[version],cur:0,job:null};
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
  if (branch && sel.size===1 && sel.has(n.id)) selectOnly(created[0]);
  toast(branch?"结果已放入新节点":batch.layout==="fold"?`已收起 ${created.length} 个生成结果`:`已在画布展开 ${created.length} 个生成结果`);
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
            mode:s.meta?.mode || receipt.mode,
            effective_prompt:s.meta?.full_prompt || s.meta?.prompt || receipt.effective_prompt,
            ...(s.meta?.quality_review ? {quality_review:s.meta.quality_review} : {}),
            settings:{...receipt.settings,...(s.meta?.model ? {provider_model:s.meta.model} : {}),
              ...(s.meta?.resolution ? {resolution:s.meta.resolution} : {})}}};
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

function addVersion(n, v, before) {
  checkpoint(before); n.versions.push(v); n.cur = n.versions.length - 1; save(); render(n); refreshDownstream(n); drawEdges(); if (sel.has(n.id)) showPanel();
}
