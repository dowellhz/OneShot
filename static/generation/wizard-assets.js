"use strict";

const wizardAssetRuns = new WeakSet();
const wizardAssetUploads = new WeakSet();

function wizardVisualAssetNodes(script) {
  return imgInputs(script).filter(n => n.data.story_asset_key);
}

function wizardVisualAssetNode(script, asset) {
  return wizardVisualAssetNodes(script).find(n => n.data.story_asset_key===asset.key &&
    (n.data.caption===asset.look || (n.name===asset.name && curV(n)?.source==="upload")));
}

function wizardAssetCards(script) {
  return (script.data.visual_assets||[]).map(asset => {
    const n=wizardVisualAssetNode(script,asset);
    const original=wizardMediaSource(wizardSuppliedAsset(script,asset,asset.kind,n))?.version;
    const version=original||curV(n);
    const uploading=wizardAssetUploads.has(n);
    const error=n&&canvasGenerationError(n);
    const status=uploading?"正在上传图片…":n?.job?jobText(n):!version?"可上传图片，或在准备素材时生成。":"";
    return OneShotI18n.html`<div class="cc" data-wz-visual-card="${esc(asset.key)}"><div class="pics">
      ${version?`<img class="on" src="${esc(version.url||remakeMedia(version.ref))}" alt="${esc(asset.name)}">`:""}
      ${status?`<div class="pend" role="status">${esc(OneShotI18n.t(status))}</div>`:""}
      </div><div class="info"><strong>${esc(asset.name)}</strong><div>${esc(asset.look)}</div>
      ${original||version?.source==="upload"?OneShotI18n.html`<small class="est">已选用上传的原图</small>`:""}
      ${error?`<div class="est" role="alert">${esc(OneShotI18n.t(error))}</div>`:""}
      ${wizardSuppliedAssetFields(script,asset,asset.kind)}
      ${canvasCanEdit()?OneShotI18n.html`<button class="ghost sm" data-wz-visual-upload="${esc(asset.key)}"
        ${wizardAssetRuns.has(script)||n?.job||prepping.has(n?.id)?"disabled":""}>上传图片</button>`:""}</div></div>`;
  }).join("");
}

function wizardSuppliedAssetFields(script, asset, kind) {
  const inputs=(W.media||[]).filter(item=>item.kind==="image"&&wizardMediaSource(item));
  if (!inputs.length) return "";
  const match=wizardSuppliedAsset(script,asset,kind);
  return OneShotI18n.html`<label>直接使用已上传原图<select data-wz-supplied-image data-key="${esc(asset.key||"")}"
    ${!canvasCanEdit()||wizardAssetRuns.has(script)?"disabled":""}>
    <option value="">自动匹配同名素材</option>
    ${inputs.map(item=>`<option value="${esc(item.node)}" ${item.node===match?.node?"selected":""}>${esc(item.name)}</option>`).join("")}
  </select></label>`;
}

function wireWizardSuppliedAssets(body) {
  const script=wizScript();
  $$("[data-wz-supplied-image]",body).forEach(select=>select.onchange=()=>{
    const asset=select.dataset.key ? script.data.visual_assets.find(item=>item.key===select.dataset.key) :
      script.data.characters[Number(select.closest("[data-i]").dataset.i)];
    const input=W.media?.find(item=>item.node===select.value);
    checkpoint();
    if (input) asset.wizard_source={node:input.node,ref:input.ref};
    else delete asset.wizard_source;
    save();
    renderWiz();
  });
  $$("[data-wz-visual-upload]",body).forEach(button=>button.onclick=()=>pickFiles(async files=>{
    if (script!==wizScript() || !files.length) return;
    const asset=script.data.visual_assets.find(item=>item.key===button.dataset.wzVisualUpload);
    const target=wizardVisualAssetNode(script,asset)||createWizardVisualAsset(script,asset);
    await uploadWizardProductionAsset(script,asset,target,files[0]);
  }));
}

async function uploadWizardProductionAsset(script,asset,target,file) {
  if (!file || wizardAssetUploads.has(target)) return;
  const before=curV(target)?.ref;
  wizardAssetUploads.add(target);
  try {
    const upload=uploadInto(target,file);
    renderWiz();
    await upload;
    if (script!==wizScript()) return;
    if (curV(target)?.source==="upload" && curV(target)?.ref!==before) {
      delete asset.wizard_source;
      if (!asset.kind) target.data.caption=asset.look||"";
      save();
    }
  } finally {
    wizardAssetUploads.delete(target);
    if (script===wizScript() && W.step===2) renderWiz();
  }
}

function createWizardVisualAsset(script, asset) {
  const at=freeSpot(script.x-420,script.y+imgInputs(script).length*420,"image");
  const look=asset.kind==="scene" ? "空场景设定图，展示空间布局和固定陈设，无人物。" : "单个道具设定图，外形清楚，纯色背景。";
  const n=addNode("image",at.x,at.y,{story_asset_key:asset.key,aspect:asset.kind==="scene"?(script.data.aspect||"16:9"):"1:1",
    quality:"4mp",count:1,caption:asset.look,prompt:[script.data.style,look,asset.look].filter(Boolean).join("。")},
    {name:asset.name});
  link(n,script,true);
  return n;
}

function wizardCharacterLook(script, character) {
  const others=(script.data.characters||[]).map(c=>c.name).filter(name=>name?.length>1&&name!==character.name);
  return (character.look||"").split(/[，,。；;、\n]+/).map(text=>{
    const interaction=text.search(/怀里|怀中|怀抱|抱着|搂着|牵着|背着|带着|身旁|旁边|同框|一起|\b(?:holding|carrying|hugging|alongside|beside|accompanied by)\b/i);
    const mentions=Math.min(...others.map(name=>text.indexOf(name)).filter(index=>index>=0));
    const end=Math.min(interaction<0?text.length:interaction,mentions);
    return text.slice(0,end).replace(/[和与跟及、（(\s]+$/,"").trim();
  }).filter(Boolean).join("，");
}

function setWizardCharacterPrompt(n,script,character) {
  const look=wizardCharacterLook(script,character);
  const style=W.style||script.data.style||"";
  const description=look||wizardCharacterLook(script,{...character,look:character.name});
  const reference=bindWizardCharacterRef(n,selectedWizardCharacterRef(script,character));
  n.data.character_sheet=true;
  n.data.caption=look;
  n.data.prompt=[
    reference,
    "单角色定妆照，整张图只出现一个独立角色、一个身体、一张脸，只出现一次",
    style&&`${style}风格`,description,
    "肢体自然放松，空手，浅灰纯色背景，全身正面，主体居中",
    "单张独立肖像，无其他主体、倒影、拼版、附加角度或文字",
  ].filter(Boolean).join("。");
  return look;
}

async function checkWizardCharacter(n, active) {
  const version=curV(n);
  if(!version)return false;
  if(n.data.character_sheet_review===version.ref)return true;
  const result=await api("/api/character-sheet/review",{ref:version.ref});
  if(!active())return false;
  if(curV(n)?.ref!==version.ref)throw new Error(OneShotI18n.t("准备期间素材版本已切换，请重新确认"));
  if(result.checked&&result.passed)n.data.character_sheet_review=version.ref;
  return result.checked===false||result.passed===true;
}

async function saveWizardAsset(item, bid, library, active) {
  const {n,kind,name,desc,voice}=item, version=curV(n);
  let asset=n.data.wizard_saved_asset;
  if (asset&&removedAssetIds.has(asset.id)) asset=null;
  const known=library.find(a=>a.ref===version.ref&&a.kind===kind&&a.name===name&&a.desc===desc);
  const existing=version.asset_id || known?.id || (version.source==="asset" && n.data.asset?.id);
  if (asset?.ref!==version.ref && existing && !removedAssetIds.has(existing)) {
    asset={id:existing,ref:version.ref};
  }
  if (asset?.ref!==version.ref) {
    const saved=await api("/api/library",{kind,name,desc,voice,ref:version.ref,w:version.w,h:version.h,
      source_board:bid,node_id:n.id,...cmNewScope()});
    asset={id:saved.id,ref:version.ref};
    if(!active())return false;
  }
  if (curV(n)?.ref!==version.ref) throw new Error(OneShotI18n.t("准备期间素材版本已切换，请重新确认"));
  n.data.wizard_saved_asset=asset;
  n.data.asset={id:asset.id,kind};
  return true;
}

async function prepareWizardAssets(script) {
  if (wizardAssetRuns.has(script)) return false;
  if (!script.data.characters?.length && !script.data.visual_assets?.length) return true;
  const board=B, bid=boardId, state=W;
  const active=()=>B===board&&boardId===bid&&W===state&&node(script.id)===script;
  wizardAssetRuns.add(script);
  try {
    const style=script.data.style||state.style||"";
    const describe=look=>[look,style].filter(Boolean).join("\n");
    const library=await loadLibrary();
    if (!active()) return false;
    const items=[];
    for (const c of script.data.characters||[]) {
      const n=castNode(c);
      adoptWizardUpload(n,wizardSuppliedAsset(script,c,"character",n),"character");
      const selection=curV(n)?.source==="upload"?null:selectedWizardCharacterRef(script,c);
      const look=wizardCharacterLook(script,c);
      if (!wizardCharacterReferenceReady(n,selection) && !n.job && !prepping.has(n.id)) {
        setWizardCharacterPrompt(n,script,c);
        n.data.count=1;
      }
      items.push({n,kind:"character",name:c.name,desc:describe(look),voice:c.voice||"",character:c,selection});
    }
    for (const asset of script.data.visual_assets||[]) {
      const n=wizardVisualAssetNode(script,asset)||createWizardVisualAsset(script,asset);
      adoptWizardUpload(n,wizardSuppliedAsset(script,asset,asset.kind,n),asset.kind);
      items.push({n,kind:asset.kind,name:asset.name,desc:describe(asset.look)});
    }
    for(const {n,kind,name,desc,selection} of items){
      if (selection||curV(n)||n.job||prepping.has(n.id)) continue;
      const matches=library.filter(asset=>asset.kind===kind&&asset.name===name&&asset.desc===desc&&asset.ref&&asset.url);
      if(matches.length!==1)continue;
      const a=matches[0];
      n.versions.push({ref:a.ref,url:a.url,w:a.w,h:a.h,asset_id:a.id,source:"asset",prompt:""});
      n.cur=n.versions.length-1;
      n.data.asset={id:a.id,kind};
      render(n);
    }
    save();
    wizSig=""; renderWiz();
    for (const {n,selection} of items) {
      if (!active()) return false;
      if (!wizardCharacterReferenceReady(n,selection) && !n.job && !prepping.has(n.id)) await generate(n,{batchLayout:"tabs"});
    }
    while (active() && items.some(({n}) => n.job||prepping.has(n.id))) await sleep(750);
    if (!active()) return false;
    const missing=items.find(({n,selection})=>!wizardCharacterReferenceReady(n,selection));
    if (missing) throw new Error(OneShotI18n.t("素材「{name}」尚未生成",{name:missing.name}));
    await flushSave();
    for (const item of items) {
      if (item.character && curV(item.n)?.source!=="upload" && !await checkWizardCharacter(item.n,active)) {
        if (!active()) return false;
        if (curV(item.n)?.source!=="asset") {
          setWizardCharacterPrompt(item.n,script,item.character);
          item.n.data.count=1;
          await generate(item.n,{batchLayout:"tabs"});
          while(active()&&(item.n.job||prepping.has(item.n.id)))await sleep(750);
        }
        if(!active())return false;
        if(!await checkWizardCharacter(item.n,active)) {
          throw new Error(OneShotI18n.t("「{name}」的参考图必须只包含一个角色",{name:item.name}));
        }
        await flushSave();
      }
      if (!active() || !await saveWizardAsset(item,bid,library,active)) return false;
      const edge=B.edges.find(e=>e.from===item.n.id&&e.to===script.id);
      if((item.selection || edge?.ref) && edge?.ref!==curV(item.n).ref) updateWizardAssetShots(script,item.n,curV(item.n).ref);
      if (edge) edge.ref=curV(item.n).ref;
      save();
    }
    await flushSave();
    libCache=null;
    cmInvalidate();
    return active()&&W.step===2;
  } catch (error) {
    if (active()) toast(OneShotI18n.t("素材准备失败：{message}",{message:error.message}),5000);
    return false;
  } finally {
    wizardAssetRuns.delete(script);
    if (active()) { wizSig=""; renderWiz(); }
  }
}
