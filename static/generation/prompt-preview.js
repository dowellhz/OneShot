"use strict";

let previewSequence = 0;
function renderPreviewInputs(items, duration, memory=[]) {
  const list = $("#pvInputs");
  list.replaceChildren();
  const labels = {
    subject:"人物设定", image_ref:"参考图", first_frame:"首帧", last_frame:"尾帧",
    previs:"白模参考", video_ref:"视频参考", audio_ref:"音频参考", unused_image:"当前服务未采用"
  };
  for (const item of items) {
    const {role, image_role, ref, time, start, end} = item;
    if (!ref) continue;
    const label = labels[image_role || role] || (time > 0.01 ? time >= (vidFrames(duration)-4)/24-.05 ? "尾帧" : "关键帧" : "首帧");
    const details = item.prompt_reference ? [item.prompt_reference] : [];
    const version = item.version ?? (node(item.node_id)?.versions.findIndex(v => v.ref === ref) ?? -1)+1;
    if (version > 0) details.push("版本 "+version);
    if (label === "关键帧") details.push(Number(time.toFixed(2))+" 秒");
    if (image_role === "frame") details.push("构图参考");
    if (Number.isFinite(start) && Number.isFinite(end)) details.push(start+"–"+end+" 秒");
    const row = document.createElement("li");
    if (role === "audio_ref" || role === "video_ref" || role === "previs") {
      row.insertAdjacentHTML("afterbegin",ico(role === "audio_ref" ? "audio" : "video"));
    } else {
      const picture = document.createElement("img");
      picture.src = "/media?ref="+encodeURIComponent(ref);
      picture.loading = "lazy";
      picture.alt = "";
      row.append(picture);
    }
    const description = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = item.name || "素材";
    const meta = document.createElement("small");
    meta.textContent = [label,...details].join(" · ");
    description.append(name, meta);
    row.append(description);
    list.append(row);
  }
  for(const asset of memory){
    const row=document.createElement("li"), details=document.createElement("div");
    const name=document.createElement("strong"), label=document.createElement("small");
    row.insertAdjacentHTML("afterbegin",ico("script"));
    name.textContent=asset.name;
    label.textContent=[KIND_CN[asset.kind]||"创作记忆",asset.story_state].filter(Boolean).join(" · ");
    details.append(name,label);
    row.append(details);
    list.append(row);
  }
  list.hidden = !list.childElementCount;
}
function videoPreviewRequest(n, silent=false) {
  const req = videoReq(n,fullPrompt(n),{silent});
  if (!req) return null;
  req.board = boardId;
  applyVideoMemory(n, req);
  const services = req.previs_guide || req.audio_refs || req.video_refs ? referenceServices(n) : CAPS_LIST.video;
  if (n.data.provider==="local_h3" || services?.some(service => service.id === n.data.provider)) req.provider = n.data.provider;
  if (n.data.selected_model) Object.assign(req,{provider:n.data.provider,selected_model:n.data.selected_model});
  return req;
}

async function checkVideoModels(n, request, current, {branch=false}={}) {
  const button=$("#pvModelCheck"), panel=$("#pvModels"), status=$("#pvModelStatus"), list=$("#pvModelList");
  const candidate=structuredClone(request);
  const edges=videoInputs(n);
  for (const [index,input] of (candidate.video_refs||[]).entries()) {
    const edge=edges[index]?.edge;
    if (!edge || edge.extension || edge.segment_edit) continue;
    if (!Number.isFinite(edge.start)) delete input.start;
    if (!Number.isFinite(edge.end)) delete input.end;
  }
  if (!candidate.segment_edit) candidate.duration=Number(n.data.duration)||candidate.duration;
  candidate.quality=n.data.quality||candidate.quality;
  if (n.data.draft) candidate.draft=true;
  const signature=videoPreviewSignature(request);
  panel.hidden=false;
  button.disabled=true;
  list.replaceChildren();
  status.textContent=OneShotI18n.t("正在检查素材与模型…");
  try {
    const result=await api("/api/video/reference-models",candidate);
    if (!current()) return;
    const ready=result.models.filter(model=>!model.error).length;
    status.textContent=result.message || `${ready} / ${result.models.length} 个模型可用`;
    for (const model of result.models) {
      const entry=document.createElement("li"), details=document.createElement("div");
      const title=document.createElement("strong"), info=document.createElement("small");
      title.textContent=[model.provider,model.model,model.endpoint_model,model.selected?"当前":""].filter(Boolean).join(" · ");
      const limits=model.limits, counts=result.counts;
      const usage=[counts.images&&`图 ${counts.images}/${limits.images}`,
        counts.videos&&`视频 ${counts.videos}/${limits.videos}${Number.isFinite(model.video_seconds)?`，${model.video_seconds}/${limits.seconds} 秒`:""}`,
        counts.audio&&`音频 ${counts.audio}/${limits.audio}${Number.isFinite(model.audio_seconds)?`，${model.audio_seconds}/${limits.seconds} 秒`:""}`,
        limits.total&&`合计 ${counts.images+counts.videos+counts.audio}/${limits.total}`].filter(Boolean);
      info.textContent=[model.error || `${model.duration} 秒 · ${model.resolution}${model.draft?" 样片":""}`,...usage].join(" · ");
      details.append(title,info);entry.append(details);
      if (!model.error) {
        const use=document.createElement("button");use.type="button";use.className="pill";
        use.textContent=OneShotI18n.t("采用");
        use.onclick=()=>{
          const latest=videoPreviewRequest(n,true);
          if (latest && branch) latest.count=1;
          if (!current() || !latest || videoPreviewSignature(latest)!==signature || n.job || prepping.has(n.id) ||
              !canvasCanEdit() || nodeLocked(n)) {
            status.textContent=OneShotI18n.t("生成设置已变化，请重新预览后再选择。");
            return;
          }
          checkpoint();rememberVideoVersion(n);
          Object.assign(n.data,{provider:model.provider_id,selected_model:model.model,quality:model.quality,draft:model.draft});
          if (!candidate.segment_edit) n.data.duration=model.duration;
          save();render(n);showPanel();
          void previewPrompt(n,{branch});
        };
        entry.append(use);
      }
      list.append(entry);
    }
  } catch(error) {
    if (current()) status.textContent=error.message;
  } finally {
    if (current()) button.disabled=false;
  }
}

async function previewPrompt(n,{branch=false}={}) {
  const req=videoPreviewRequest(n);
  if (!req) return;
  if (branch) req.count=1;
  const board = B, sequence = ++previewSequence;
  const current = () => sequence === previewSequence && B === board && node(n.id) === n && sel.has(n.id);
  const render = r => {
    if (!current()) return;
    if (r.reference_preview||r.asset_review_key) videoReferencePreviews.set(n,{key:r.reference_preview,assetKey:r.asset_review_key,signature:videoPreviewSignature(req)});
    else videoReferencePreviews.delete(n);
    renderPreviewInputs(r.inputs || [], r.duration ?? req.duration,r.memory_context||[]);
    $("#pvt").textContent = r.prompt || "";
    $("#pvt").hidden = $("#pvCopy").hidden = !r.prompt;
    $("#pvm").textContent = r.mode || "";
    $("#pvModels").hidden = true;
    const check=$("#pvModelCheck");
    check.disabled=false;
    check.onclick=()=>checkVideoModels(n,req,current,{branch});
    const submit=$("#pvBranchCommit");
    submit.hidden=!branch || !r.prompt;
    submit.onclick=()=>{
      const latest=videoPreviewRequest(n,true);
      if (latest) latest.count=1;
      if (!current() || !latest || videoPreviewSignature(latest)!==videoPreviewSignature(req) || !canBranchGeneration(n)) {
        toast(OneShotI18n.t("生成设置已变化，请重新预览"));
        return;
      }
      closePromptPreview();
      void generate(n,{branch:true});
    };
    $("#pv").classList.add("on");
    $("#pvClose").focus();
  };
  try {
    if (req.previs_guide || req.audio_refs || req.video_refs) {
      await flushSave();
      if (!current()) return;
    }
    render(await api("/api/preview", req));
  } catch (error) {
    render({mode:"预览失败 · "+error.message});
  }
}
function closePromptPreview() {
  previewSequence++;
  $("#pv").classList.remove("on");
  $("#pvBtn")?.focus();
}
$("#pvClose").onclick = closePromptPreview;
$("#pv").addEventListener("click", e => { if (e.target.id === "pv") closePromptPreview(); });
$("#pv").addEventListener("keydown", e => {
  if (e.key === "Escape") { e.stopPropagation(); closePromptPreview(); }
});
$("#pvCopy").onclick = () => { navigator.clipboard?.writeText($("#pvt").textContent).then(() => toast(OneShotI18n.t("已复制"), 1000), () => toast(OneShotI18n.t("复制失败"))); };
