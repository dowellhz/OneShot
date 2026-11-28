"use strict";

const WIZARD_IMAGE_USES = {asset:"存入资产库",character_ref:"生成人物参考",first:"设为起始帧",keep:"仅保留在画布"};
const WIZARD_VIDEO_USES = {motion:"参考动作和运镜",remake:"按原片重制",clip:"直接剪入成片",frame:"截一帧作为起始帧",keep:"仅保留在画布"};
const WIZARD_ASSET_KINDS = {character:"角色",scene:"场景",prop:"道具"};
const wizardMediaRuns = new WeakSet();
const wizardMediaUploadPhase = new WeakMap();

function wizardMediaSource(item) {
  const source = node(item?.node);
  const version = source?.versions.find(version => version.ref === item.ref);
  return source && version ? {source,version} : null;
}

function wizardMotionModel(seconds=0) {
  for (const service of CAPS_LIST.previs || []) {
    const model = (service.models || []).find(model => model.accepts_video && model.reference_limits?.videos > 0 &&
      model.reference_limits.seconds >= seconds);
    if (model) return {provider:service.id, selected_model:model.id};
  }
  return null;
}

function wizardMediaRange(item, version) {
  const start = Number(item.start), end = Number(item.end);
  const max = Number(version.seconds);
  if (!Number.isFinite(max) || max <= 0 || item.start==null || item.end==null || !Number.isFinite(start) || !Number.isFinite(end) ||
      start < 0 || end <= start || end > max + .001) {
    throw new Error(OneShotI18n.t("请检查视频的入点和出点"));
  }
  return {start,end:Math.min(end,max)};
}

function wizardMediaOptions(options, selected) {
  return Object.entries(options).map(([value,label]) =>
    `<option value="${value}" ${value===selected?"selected":""}>${esc(OneShotI18n.t(label))}</option>`).join("");
}

function wizardMediaUI() {
  const editable = canvasCanEdit(), busy = wizardMediaRuns.has(W);
  const phase=wizardMediaUploadPhase.get(W);
  const status=phase==="upload"?"正在上传素材…":phase==="analysis"?"":busy?"正在准备上传素材…":"";
  const mixed = wizardMotionModel() && W.media?.some(item=>item.use==="motion") &&
    W.media?.some(item=>item.use==="first" || item.use==="frame");
  return OneShotI18n.html`<section class="wz-media" aria-labelledby="wzMediaHeading">
    <header><h3 id="wzMediaHeading">图片和视频素材</h3>
      ${editable ? OneShotI18n.html`<button class="ghost sm" type="button" data-wz-upload ${busy?"disabled":""}>上传图片或视频</button>`:""}
    </header>
    <input type="file" data-wz-files hidden multiple accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp,.mp4,.mov,.webm,.m4v,.mkv">
    <div class="est" data-wz-media-status role="status">${esc(OneShotI18n.t(status))}</div>
    ${mixed?OneShotI18n.html`<div class="est">同时使用动作参考时，视频模型会把起始帧作为构图参考。要锁定首帧，请移除动作参考。</div>`:""}
    <div class="wz-media-list">${(W.media || []).map((item,index) => wizardMediaCard(item,index,editable&&!busy)).join("")}</div>
  </section>`;
}

function wizardMediaCard(item, index, editable) {
  const media = wizardMediaSource(item);
  const blocked = !editable || !media ? "disabled" : "";
  const ready = item.kind==="image" && item.saved?.kind===item.category && item.saved?.name===item.name;
  const preview = media ? item.kind==="image" ? `<img src="${esc(remakeMedia(item.ref))}" alt="">` :
    `<video src="${esc(remakeMedia(item.ref))}" controls muted playsinline preload="metadata"></video>` : "";
  const range = media && (item.use==="motion" || item.use==="clip") ? OneShotI18n.html`<div class="wz-media-range">
    <label>入点（秒）<input type="number" step="any" min="0" max="${media.version.seconds}" data-wz-field="start" value="${Number(item.start)}" ${blocked}></label>
    <label>出点（秒）<input type="number" step="any" min="0" max="${media.version.seconds}" data-wz-field="end" value="${Number(item.end)}" ${blocked}></label>
  </div>` : "";
  const asset = item.kind==="image" && (item.use==="asset" || item.use==="first" && item.alsoSave);
  return OneShotI18n.html`<article class="wz-media-card" data-wz-media="${index}">
    <div class="wz-media-preview">${preview}</div>
    <div class="wz-media-fields"><b title="${esc(media?.source.name || item.name)}">${esc(media?.source.name || item.name)}</b>
      ${media&&item.kind==="image"?wizardImageAnalysisCard(item,blocked):""}
      <label>用途<select data-wz-field="use" ${blocked}>${wizardMediaOptions(item.kind==="image"?WIZARD_IMAGE_USES:WIZARD_VIDEO_USES,item.use)}</select></label>
      ${item.use==="character_ref"?wizardCharacterUploadFields(item,blocked):""}
      ${item.kind==="image" && item.use==="first"?OneShotI18n.html`<small class="est">起始帧也会作为人物生图参考，可在制作素材时选择角色主体。</small>
        <label class="wz-media-check"><input type="checkbox" data-wz-field="alsoSave" ${item.alsoSave?"checked":""} ${blocked}>同时存入资产库</label>`:""}
      ${asset?OneShotI18n.html`<label>素材类别<select data-wz-field="category" ${blocked}>${wizardMediaOptions(WIZARD_ASSET_KINDS,item.category)}</select></label>
        <label>素材名称<input maxlength="60" data-wz-field="name" value="${esc(item.name)}" ${blocked}></label>
        <button type="button" class="ghost sm" data-wz-action="save" ${ready?"disabled":blocked}>${esc(OneShotI18n.t(ready?"已存入资产库":"保存到资产库"))}</button>`:""}
      ${range}
      ${item.use==="motion"?OneShotI18n.html`<small class="est">${esc(OneShotI18n.t(wizardMotionModel()?"作为第一镜的动作与运镜参考。":"请先接入支持参考视频的模型，或改用截帧或剪入。"))}</small>`:""}
      ${item.use==="clip"?OneShotI18n.html`<small class="est">加入成片结尾，之后可在剪辑台调整顺序。</small>`:""}
      ${item.use==="frame" && media?OneShotI18n.html`<label>截帧位置（秒）<input type="number" step="any" min="0" max="${media.version.seconds}" data-wz-field="at" value="${Number(item.at)||0}" ${blocked}></label>
        <button type="button" class="ghost sm" data-wz-action="playhead" ${blocked}>使用视频当前画面</button>`:""}
      ${item.use==="remake"?OneShotI18n.html`<button type="button" class="ghost sm" data-wz-action="remake" ${blocked}>打开视频重制</button>`:""}
      ${media?"":OneShotI18n.html`<small role="status">素材版本已移除</small>`}
      ${editable?OneShotI18n.html`<button type="button" class="ghost sm" data-wz-action="remove">移除</button>`:""}
    </div></article>`;
}

function wizardSetMediaUse(item,use) {
  if (["first","frame","motion"].includes(use)) {
    for (const previous of W.media || []) {
      if (previous!==item && (use==="motion" ? previous.use==="motion" : ["first","frame"].includes(previous.use))) {
        previous.use = previous.alsoSave ? "asset" : "keep";
      }
    }
  }
  item.use=use;
}

function wireWizardMedia(body) {
  const section = $(".wz-media",body);
  if (!section || !canvasCanEdit()) return;
  const writeScript=$('[data-go="script"]',body);
  if (writeScript) writeScript.disabled=wizardMediaRuns.has(W);
  $$("[data-screenplay-start]",body).forEach(button=>{
    button.disabled=wizardMediaRuns.has(W) || activeScreenplays.has(W) || !!(W.production && W.production.status!=="done");
  });
  $("[data-wz-upload]",section).onclick=()=>$("[data-wz-files]",section).click();
  $("[data-wz-files]",section).onchange=event=>{ const files=[...event.target.files]; event.target.value=""; void uploadWizardMedia(files); };
  $$("[data-wz-media]",section).forEach(card=>{
    const item=W.media[Number(card.dataset.wzMedia)];
    $$("[data-wz-field]",card).forEach(field=>field.onchange=()=>{
      const key=field.dataset.wzField;
      if (key==="use") wizardSetMediaUse(item,field.value);
      else if (key==="subject") item.subject=field.value===""?null:Number(field.value);
      else if (field.type==="number") item[key]=Number.isFinite(field.valueAsNumber)?field.valueAsNumber:null;
      else item[key]=field.type==="checkbox"?field.checked:field.value;
      wizSave();
      if (key==="use" && item.use==="character_ref" && item.analysis?.ref!==item.ref)
        void runWizardMedia(active=>analyzeWizardCharacterUpload(item,active));
      else if (["use","category","alsoSave","name","subject"].includes(key)) refreshWizardMedia();
    });
    $$("[data-wz-action]",card).forEach(button=>button.onclick=()=>{
      const action=button.dataset.wzAction;
      if (action==="remove") {
        W.media=W.media.filter(entry=>entry!==item); wizSave(); refreshWizardMedia();
      } else if (action==="playhead") {
        item.at=Math.round($("video",card).currentTime*100)/100;
        $("[data-wz-field=at]",card).value=item.at; wizSave();
      } else if (action==="save") {
        void runWizardMedia(async active=>{await saveWizardMediaAsset(item,active);});
      } else if (action==="analyze-character") {
        void runWizardMedia(active=>analyzeWizardCharacterUpload(item,active,{retry:true}));
      } else if (action==="remake") {
        void launchWizardRemake(item);
      }
    });
  });
}

function refreshWizardMedia() {
  const section = $("#wzBody .wz-media");
  if (W?.step===0 && section && $("#wiz").classList.contains("on")) {
    section.outerHTML=wizardMediaUI();
    wireWizardMedia($("#wzBody"));
  }
}

async function runWizardMedia(work) {
  const state=W, board=B, epoch=boardOpenEpoch;
  if (!state || wizardMediaRuns.has(state) || !canvasCanEdit()) return;
  const active=()=>W===state && B===board && boardOpenEpoch===epoch && canvasCanEdit();
  wizardMediaRuns.add(state);
  refreshWizardMedia();
  try { return await work(active); }
  catch (error) { if (active()) toast(OneShotI18n.t(error.message),4500); }
  finally { wizardMediaRuns.delete(state); wizardMediaUploadPhase.delete(state); if(active()) refreshWizardMedia(); }
}

async function uploadWizardMedia(files) {
  if (!files.length) return;
  await runWizardMedia(async active=>{
    const images=[];
    wizardMediaUploadPhase.set(W,"upload");
    refreshWizardMedia();
    for (const file of files) {
      if (!active()) return;
      if (file.size>64*1024*1024 || !/\.(png|jpe?g|webp|mp4|mov|webm|m4v|mkv)$/i.test(file.name)) {
        toast(OneShotI18n.t("请选择 64 MB 以内的图片或视频"),4000); continue;
      }
      const kind=canvasUploadKind(file);
      if (!["image","video"].includes(kind)) continue;
      let result;
      try { result=await readCanvasFile(file,kind); }
      catch (error) { if(active())toast(error.message,4000); continue; }
      if (!active()) return;
      const {name,data,version}=result, origin=freeSpot(0,(W.media?.length||0)*260,kind);
      checkpoint();
      const source=addNode(kind,origin.x,origin.y,data,{name,versions:[version],cur:0});
      const use=kind==="image"?"asset":"clip";
      const item={node:source.id,ref:version.ref,kind,use,name:source.name,category:"character",
        ...(kind==="video"?{start:0,end:version.seconds||0,at:0}:{})};
      (W.media ||= []).push(item);
      if (kind==="image") images.push(item);
      render(source); wizSave();
      refreshWizardMedia();
    }
    if (!active() || !images.length) return;
    wizardMediaUploadPhase.set(W,"analysis");
    for (const item of images) {
      if (!active()) return;
      try { await analyzeWizardCharacterUpload(item,active); }
      catch { /* The image card offers a retry while retaining the uploaded file. */ }
    }
  });
}

async function saveWizardMediaAsset(item, active) {
  const media=wizardMediaSource(item);
  if (!media) throw new Error("素材版本已移除");
  const {source,version}=media, kind=item.category, name=item.name.trim() || source.name;
  if (item.saved?.kind===kind && item.saved.name===name && !removedAssetIds.has(item.saved.id)) return item.saved;
  await flushSave();
  if (!active()) return;
  const saved=await api("/api/library",{kind,name,desc:source.data.caption || "",ref:version.ref,w:version.w,h:version.h,
    source_board:boardId,node_id:source.id,...cmNewScope()});
  if (!active()) return;
  item.saved={id:saved.id,kind,name};
  libCache=null;
  wizSave();
  return item.saved;
}

async function launchWizardRemake(item) {
  const media=wizardMediaSource(item);
  if (!media) return toast(OneShotI18n.t("素材版本已移除"));
  const summary=W.idea?.trim() || "";
  closeWizard();
  try { await openVideoRemake(media.source,{sourceRef:media.version.ref,brief:summary}); }
  catch (error) { toast(OneShotI18n.t(error.message),4500); }
}

async function prepareWizardUploads() {
  if (!W.media?.length) return {};
  return runWizardMedia(async active=>{
    const result={assets:[],clips:[]};
    for (const item of W.media) {
      if (item.use==="keep" || item.use==="remake") continue;
      const media=wizardMediaSource(item);
      if (!media) throw new Error("素材版本已移除");
      const pinned={node:item.node,ref:item.ref};
      if (item.use==="character_ref") {
        const subjects=await analyzeWizardCharacterUpload(item,active);
        if (!subjects || !active()) return;
        const subject=subjects[item.subject];
        if (!subject) throw new Error(subjects.length?"请先选择要生成的主体":"没有识别到清晰的角色主体。");
        (result.characterRefs ||= []).push({...pinned,...subject,name:(item.characterName||"").trim()});
      }
      if (item.use==="asset" || item.alsoSave && item.use==="first") {
        const saved=await saveWizardMediaAsset(item,active);
        if (!saved || !active()) return;
        result.assets.push({...pinned,...saved});
      }
      if (item.use==="first") result.opening=pinned;
      if (item.use==="frame") {
        const at=Number(item.at);
        if (!Number.isFinite(at) || at<0 || at>media.version.seconds) throw new Error("请检查截帧位置");
        const prior=wizardMediaSource(item.captured);
        if (prior && item.captured.at===at) result.opening=item.captured;
        else {
          const captured=await captureOnCanvas(item.node,media.version,{position:at?"time":"first",at,active,select:false});
          if (!captured || !active()) return;
          result.opening=item.captured={node:captured.id,ref:curV(captured).ref,at};
          wizSave();
        }
      }
      if (item.use==="motion" || item.use==="clip") {
        const range=wizardMediaRange(item,media.version);
        if (item.use==="clip") result.clips.push({...pinned,...range});
        else {
          const seconds=range.end-range.start;
          const model=wizardMotionModel(seconds);
          if (!model || seconds<2 || !(.4<=media.version.w/media.version.h && media.version.w/media.version.h<=2.5))
            throw new Error("动作参考需要兼容的模型、至少 2 秒的视频和合适的画幅");
          result.motion={...pinned,...range,...model};
        }
      }
    }
    return result;
  });
}

function wizardUploadedReferences(media) {
  const characters=(media.characterRefs || []).map(item=>({...item,kind:"character",
    name:item.name || OneShotI18n.t("角色参考"),desc:[item.position,item.appearance].filter(Boolean).join(" · ")}));
  const picks=[...(media.opening?[{...media.opening,name:OneShotI18n.t("指定起始帧"),kind:"opening"}]:[]),...characters,...(media.assets || [])];
  return picks.flatMap(item=>{
    const pinned=wizardMediaSource(item);
    if (!pinned) return [];
    const note=item.kind==="opening"?OneShotI18n.t("请以这张图作为第一镜开场构图。"):
      item.id?OneShotI18n.t("这是用户已提供的成品素材。使用它时，剧本和素材清单保留原名，以便直接复用。"):"";
    const analysis=W.media?.find(input=>input.node===item.node && input.analysis?.ref===item.ref)?.analysis;
    return [{...item,desc:[note,item.desc||analysis?.summary||pinned.source.data.caption].filter(Boolean).join(" ")}];
  });
}

function applyWizardUploadPlan(script, media) {
  script.data.wizard_media=media;
  syncWizardOpeningShot(script);
}

function syncWizardOpeningShot(script) {
  const {shots, wizard_media:media}=script.data;
  if (!media) return;
  for (const shot of shots) if (shot.frame?.source==="wizard-opening") delete shot.frame;
  const first = shots[0], opening=wizardMediaSource(media.opening);
  if (first && opening) first.frame={ref:opening.version.ref,w:opening.version.w,h:opening.version.h,source:"wizard-opening"};
  if (media.motion) media.motion.shot_id=first?.id;
}

function wizardSuppliedAsset(script, asset, kind, target) {
  if (asset.wizard_source) return asset.wizard_source;
  if (curV(target)?.source==="upload") return null;
  const name=asset.name?.trim().normalize("NFKC").toLowerCase();
  const matches=(script.data.wizard_media?.assets || []).filter(item=>
    item.kind===kind && item.name.trim().normalize("NFKC").toLowerCase()===name && wizardMediaSource(item));
  return matches.length===1 ? matches[0] : null;
}

function adoptWizardUpload(target, match, kind) {
  if (!match) return;
  if (target.job || prepping.has(target.id)) throw new Error(OneShotI18n.t("请等当前素材任务完成后再试"));
  const media=wizardMediaSource(match);
  if (!media) throw new Error(OneShotI18n.t("素材版本已移除"));
  let index=target.versions.findIndex(version=>version.ref===match.ref);
  if (index===-1) {
    index=target.versions.length;
    target.versions.push({...media.version,asset_id:removedAssetIds.has(match.id)?undefined:match.id});
  }
  target.cur=index;
  curV(target).source="upload";
  if (curV(target).asset_id) target.data.asset={kind,id:curV(target).asset_id};
  render(target);
}
