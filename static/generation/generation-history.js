"use strict";

const ghText = OneShotI18n.t;

const generationHistoryDialog = $("#generationHistory");
const GH = {epoch:0, cursor:null, chosen:new Map(), board:null, timer:null, downloading:false};
const gh = selector => $(selector,generationHistoryDialog);
const ghCards = () => $$("[data-gh-grid] article",generationHistoryDialog);
const GH_SELECTION_LIMIT = 100;
const mediaFavoriteStates = new Map();
const ghFavorites = () => gh("[data-gh-view]").value === "favorites";

function mediaFavoriteLabel(button, selected) {
  const title = selected ? "取消收藏此版本" : "收藏此版本";
  button.setAttribute("aria-pressed",String(selected));
  button.setAttribute("aria-label",title);
  button.title = button.dataset.tip = title;
}

function mediaFavoriteState(ref, selected) {
  mediaFavoriteStates.set(ref,{selected,until:Date.now()+30000});
  for (const button of $$("[data-favorite-ref]")) {
    if (button.dataset.favoriteRef === ref) mediaFavoriteLabel(button,selected);
  }
}

async function readMediaFavorite(ref) {
  const prior = mediaFavoriteStates.get(ref);
  if (prior?.until > Date.now()) return prior.selected;
  if (prior?.loading) return prior.loading;
  const loading = boardRequest("/api/media-favorites?ref="+encodeURIComponent(ref)).then(result=>{
    if (mediaFavoriteStates.get(ref)?.loading === loading) mediaFavoriteState(ref,!!result.favorite);
    return mediaFavoriteStates.get(ref)?.selected ?? !!result.favorite;
  }).catch(error=>{
    if (mediaFavoriteStates.get(ref)?.loading === loading) mediaFavoriteStates.delete(ref);
    throw error;
  });
  mediaFavoriteStates.set(ref,{loading});
  return loading;
}

function mediaFavoriteButton(button,item,{saveFirst=false,after}={}) {
  button.dataset.favoriteRef = item.ref;
  if (typeof item.favorite === "boolean") {
    mediaFavoriteState(item.ref,item.favorite);
    mediaFavoriteLabel(button,item.favorite);
  } else readMediaFavorite(item.ref).then(selected=>mediaFavoriteLabel(button,selected)).catch(()=>{});
  button.onclick = async () => {
    hideNodeToolTip();
    button.disabled = true;
    try {
      const favorite = !await readMediaFavorite(item.ref);
      if (favorite && saveFirst) await flushSave();
      const {favorite:selected} = await boardRequest("/api/media-favorites","POST",{...item,favorite});
      mediaFavoriteState(item.ref,selected);
      if (after) after(selected);
      else toast(selected ? ghText("已收藏此版本") : ghText("已取消收藏"));
    } catch (error) {
      if (generationHistoryDialog.open) gh("[data-gh-status]").textContent = error.message;
      else toast(error.message || "收藏操作失败",4500);
    } finally { button.disabled = false; }
  };
}

function nodeMediaFavorite(button,node,version) {
  const multiple = node.versions.length > 1;
  const label = multiple ? `${node.name} · 版本 ${node.cur+1}` : node.name;
  const prompt = version.prompt || version.node_data?.prompt || (multiple ? "" : node.data.prompt);
  mediaFavoriteButton(button,{ref:version.ref,label,prompt,
    model:version.mode_name || version.mode,width:version.w,height:version.h,seed:version.seed,source:version.source,
    audio_recipe:version.audio_recipe},{saveFirst:true});
}

function ghActions() {
  const visible=ghCards().map(card=>card._historyItem);
  const visibleSelected=visible.filter(item=>GH.chosen.has(item.id)).length;
  const outside=GH.chosen.size-visibleSelected;
  gh("[data-gh-count]").textContent = ghText("已选 {count}", {count:GH.chosen.size}) + (outside ? " · " + ghText("筛选外 {count}", {count:outside}) : "");
  gh("[data-gh-select-visible]").disabled=GH.chosen.size>=GH_SELECTION_LIMIT || !visible.some(item=>item.available&&!GH.chosen.has(item.id));
  gh("[data-gh-clear]").disabled=!GH.chosen.size;
  gh("[data-gh-apply]").disabled = !GH.chosen.size || !canvasCanEdit();
  gh("[data-gh-download]").disabled = !GH.chosen.size || GH.downloading;
}

function ghReset({keepSelection=false}={}) {
  GH.epoch++;
  GH.cursor = null;
  if(!keepSelection)GH.chosen.clear();
  clearTimeout(GH.timer);
  gh("[data-gh-grid]").replaceChildren();
  gh("[data-gh-more]").hidden = true;
  gh("[data-gh-status]").textContent = "";
  ghActions();
}

function ghClose() {
  if (generationHistoryDialog.open) generationHistoryDialog.close?.();
  generationHistoryDialog.removeAttribute("open");
  ghReset();
  GH.board = null;
}

function ghOpen() {
  ghReset();
  GH.board = boardId;
  if (generationHistoryDialog.showModal) generationHistoryDialog.showModal();
  else generationHistoryDialog.setAttribute("open", "");
  ghLoad();
}

function ghCurrent(epoch) {
  return generationHistoryDialog.open && GH.epoch === epoch && boardId === GH.board;
}

async function ghLoad(append=false) {
  const epoch = ++GH.epoch, status = gh("[data-gh-status]"), more = gh("[data-gh-more]");
  const favorites = ghFavorites();
  const params = new URLSearchParams({kind:gh("[data-gh-kind]").value,q:gh("[data-gh-query]").value.trim()});
  gh("[data-gh-scope]").disabled = favorites;
  if (!favorites && gh("[data-gh-scope]").value === "canvas") params.set("board",GH.board);
  if (append && GH.cursor) params.set("before",GH.cursor);
  more.disabled = true;
  status.textContent = ghText("正在读取生成记录…");
  try {
    const page = await boardRequest((favorites ? "/api/media-favorites?" : "/api/generation-history?")+params);
    if (!ghCurrent(epoch)) return;
    const grid = gh("[data-gh-grid]");
    grid.append(...page.items.map(ghCard));
    ghActions();
    GH.cursor = page.next;
    more.hidden = !GH.cursor;
    status.textContent = grid.childElementCount ? "" : GH.cursor ? ghText("这一页没有可显示的结果") : favorites ? ghText("没有匹配的收藏") : ghText("没有匹配的生成记录");
  } catch (error) {
    if (ghCurrent(epoch)) status.textContent = error.message || ghText("读取生成历史失败");
  } finally {
    if (ghCurrent(epoch)) more.disabled = false;
  }
}

function ghCard(item) {
  const card = document.createElement("article");
  card._historyItem=item;
  if(GH.chosen.has(item.id)){
    if(item.available)GH.chosen.set(item.id,item);
    else GH.chosen.delete(item.id);
  }
  const title = esc(item.label), kind = ghText(TYPE_CN[item.type]);
  const preview = !item.available ? OneShotI18n.html`<span>原文件已不可用</span>` : item.type === "image" ?
    `<img src="${esc(item.url)}" alt="${title}" loading="lazy">` : item.type === "video" ?
    `<video src="${esc(item.url)}" controls muted playsinline preload="none" aria-label="${title}"></video>` :
    `<audio src="${esc(item.url)}" controls preload="none" aria-label="${title}"></audio>`;
  const date = Number.isFinite(item.created) ? new Date(item.created*1000).toLocaleString(OneShotI18n.locale) : "";
  const references = seedAudioRefs({data:item.audio_recipe}).length, missing = item.missing_audio_references || 0;
  card.innerHTML = OneShotI18n.html`<div class="gh-preview">${preview}</div><strong title="${title}">${title}</strong>
    <span>${esc([kind,item.model,date].filter(Boolean).join(" · "))}</span>
    ${item.prompt ? `<p title="${esc(item.prompt)}">${esc(item.prompt)}</p>` : ""}
    ${item.image_edit ? OneShotI18n.html`<span>可复用编辑参数和图层</span>` : item.image_edit_unavailable ? OneShotI18n.html`<span>编辑来源或图层已不可用</span>` : ""}
    ${references ? `<span>${esc(ghText("随结果恢复 {count} 个参考", {count:references}))}</span>` : ""}
    ${missing ? `<span>${esc(ghText("{count} 个参考已不可用", {count:missing}))}</span>` : ""}
    <div class="gh-card-actions"><label><input type="checkbox" aria-label="${esc(ghText("选择 {name}", {name:item.label}))}" ${item.available ? "" : "disabled"}>选择</label>
    ${item.available || item.favorite ? `<button type="button" data-gh-favorite>${ico("star")}</button>` : ""}
    <button type="button" data-gh-card-apply ${item.available && canvasCanEdit() ? "" : "disabled"}>放入画布</button></div>`;
  const select = $("input",card);
  select.checked=GH.chosen.has(item.id);
  select.onchange = () => {
    if (select.checked && GH.chosen.size >= GH_SELECTION_LIMIT) {
      select.checked = false;
      gh("[data-gh-status]").textContent = ghText("每次最多选择 100 个结果");
      return;
    }
    if (select.checked) GH.chosen.set(item.id,item);
    else GH.chosen.delete(item.id);
    ghActions();
  };
  $("[data-gh-card-apply]",card).onclick = () => ghApply([item]);
  const favorite = $("[data-gh-favorite]",card);
  if (favorite) mediaFavoriteButton(favorite,item,{after:selected=>{
    if (!card.isConnected) return;
    if (!selected && ghFavorites()) {
      GH.chosen.delete(item.id);
      card.remove();
      ghActions();
    }
    gh("[data-gh-status]").textContent = selected ? ghText("已收藏此版本") : ghText("已取消收藏");
  }});
  return card;
}

function ghApply(items) {
  if (GH.board !== boardId || !canvasCanEdit() || !items.length) return;
  const origin = toW(innerWidth/2-150,innerHeight/2-180);
  const specs = items.filter(item=>item.available).map(item => {
    const width = item.width > 0 ? item.width : undefined, height = item.height > 0 ? item.height : undefined;
    const version = {ref:item.ref,url:item.url,prompt:item.prompt,source:item.source || "gen",mode_name:item.model,w:width,h:height,
      seconds:item.seconds>0?item.seconds:undefined};
    if (item.broll_recipe) version.broll_recipe = item.broll_recipe;
    if (item.image_edit) version.edit = item.image_edit;
    const data = {prompt:item.prompt,...(item.type==="video"?{aspect:"auto"}:{})};
    if (item.audio_recipe) {
      version.audio_recipe = item.audio_recipe;
      Object.assign(data,item.audio_recipe);
    }
    if (item.audio_transcript) {
      version.audio_transcript=item.audio_transcript;
      version.seconds ??= item.audio_transcript.end;
    }
    if (Number.isSafeInteger(item.seed)) data.seed = version.seed = item.seed;
    return {type:item.type,name:item.label,data,versions:[version],cur:0};
  });
  if(!specs.length)return;
  const resultCount=specs.length, bindings=[];
  const sources=new Map();
  const key=(type,ref)=>JSON.stringify([type,ref]);
  B.nodes.forEach(n=>n.versions.forEach(v=>sources.set(key(n.type,v.ref),n)));
  specs.forEach((spec,index)=>sources.set(key(spec.type,spec.versions[0].ref),sources.get(key(spec.type,spec.versions[0].ref))??index));
  for(const [index,spec] of specs.slice().entries()){
    if(spec.data.mode!=="seed_audio")continue;
    const refs=seedAudioRefs(spec);
    spec.data.references=[];
    spec.versions[0].audio_recipe={...spec.versions[0].audio_recipe,references:[]};
    for(const ref of refs){
      const identity=key(ref.kind,ref.ref), original=node(ref.node_id);
      let source=original?.type===ref.kind&&original.versions.some(v=>v.ref===ref.ref)?original:sources.get(identity);
      if(source===undefined || source===index){
        source=specs.length;
        const version={ref:ref.ref,url:"/media?ref="+encodeURIComponent(ref.ref),source:"history"};
        specs.push({type:ref.kind,name:ref.kind==="audio"?"参考音频":"参考图",data:{},versions:[version],cur:0});
        sources.set(identity,source);
      }
      bindings.push({index,source,ref});
    }
  }
  const placed=placeCanvasNodeBatch(specs,origin);
  for(const {index,source,ref} of bindings){
    const target=placed[index], from=typeof source==="number"?placed[source]:source;
    const bound={...ref,node_id:from.id};
    target.data.references.push(bound);
    curV(target).audio_recipe.references.push(bound);
  }
  if(bindings.length){
    sel=new Set(placed.slice(0,resultCount).map(n=>n.id));
    updateSel();drawEdges();save();
  }
  ghClose();
  const added=placed.length-resultCount;
  toast(`已放入 ${resultCount} 个素材${added?`，并恢复 ${added} 个参考素材`:""}`);
}

async function ghDownload() {
  const items = [...GH.chosen.values()];
  if (!items.length || GH.downloading) return;
  GH.downloading = true;
  const status = gh("[data-gh-status]"), epoch = GH.epoch;
  status.textContent = ghText("请查看下载进度");
  ghActions();
  try {
    await downloadAssetRefs(items.map(item=>item.ref),ghFavorites() ? "OneShot-收藏.zip" : "OneShot-生成历史.zip");
    if (ghCurrent(epoch)) status.textContent = ghText("所选文件已发送到浏览器");
  } catch (error) {
    if (ghCurrent(epoch)) status.textContent = error.message || "下载失败";
  } finally {
    GH.downloading = false;
    ghActions();
  }
}

$("#generationHistoryBtn").onclick = ghOpen;
gh("[data-gh-close]").onclick = ghClose;
gh("[data-gh-apply]").onclick = () => ghApply([...GH.chosen.values()]);
gh("[data-gh-download]").onclick = ghDownload;
gh("[data-gh-more]").onclick = () => ghLoad(true);
gh("[data-gh-select-visible]").onclick = () => {
  for(const card of ghCards()){
    if(GH.chosen.size>=GH_SELECTION_LIMIT)break;
    const item=card._historyItem;
    if(!item.available || GH.chosen.has(item.id))continue;
    GH.chosen.set(item.id,item);
    $("input",card).checked=true;
  }
  if(GH.chosen.size>=GH_SELECTION_LIMIT && ghCards().some(card=>!$("input",card).checked&&card._historyItem.available))
    gh("[data-gh-status]").textContent=ghText("每次最多选择 100 个结果");
  ghActions();
};
gh("[data-gh-clear]").onclick = () => {
  GH.chosen.clear();
  for(const card of ghCards())$("input",card).checked=false;
  ghActions();
};
generationHistoryDialog.addEventListener("cancel",event=>{ event.preventDefault(); ghClose(); });
generationHistoryDialog.addEventListener("keydown",event=>event.stopPropagation());
gh("[data-gh-query]").oninput = () => {
  ghReset({keepSelection:true});
  GH.timer = setTimeout(ghLoad,250);
};
for (const selector of ["[data-gh-view]","[data-gh-kind]","[data-gh-scope]"]) gh(selector).onchange = () => {
  ghReset({keepSelection:selector!=="[data-gh-view]"}); ghLoad();
};
