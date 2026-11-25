"use strict";

function publicResearchLink(value) {
 try {
  const url=new URL(value);
  return ["http:","https:"].includes(url.protocol)&&!url.username&&!url.password?url.href:"";
 } catch { return ""; }
}

function acWebSources(items) {
 return `<ol class="ac-web-sources">${items.map(item=>{
  const link=publicResearchLink(item.url), image=publicResearchLink(item.image);
  if(!link)return "";
  const thumbnail=image&&["upload.wikimedia.org","thumb.wikimedia.org"].includes(new URL(image).hostname)?
   `<img src="${esc(image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:"";
  return `<li>${thumbnail}<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>
   ${item.date||item.credit||item.license?`<small>${esc([item.date,item.credit,item.license].filter(Boolean).join(" · "))}</small>`:""}
   ${item.snippet?`<p>${esc(item.snippet)}</p>`:""}</li>`;
 }).join("")}</ol>`;
}

async function acFocus(ids,editor=false){
 if(AC.board!==boardId)return;
 const nodes=ids.map(id=>vtResolve(id)?.node).filter(Boolean);
 if(!nodes.length)return;
 sel=new Set(nodes.map(n=>n.id));updateSel();fit(nodes);
 if(editor&&nodes.length===1&&nodes[0].type==="image"){
  closeLightbox();
  await openImageEditor(nodes[0]);
 }
}
function acResultVersion(item){const resolved=vtResolve(item.id,item.ref);return resolved?.node.versions[resolved.index]||item;}
function acShotAssetNames(assets){
 return (assets||[]).map(asset=>{
  const view=CHARACTER_VIEWS[asset.view]?.[0];
  return asset.name+(view?"（"+view+"）":"");
 }).join("、");
}
function acResultCards(result){
 if(result.gif?.ref && /^output:h3studio\/gif_[\w-]+\.gif$/.test(result.gif.ref)){
  const gif=result.gif,url="/media?ref="+encodeURIComponent(gif.ref);
  return OneShotI18n.html`<div class="ac-gif-result"><img src="${url}" loading="lazy" alt="GIF 动图预览">
    <div>${esc(gif.width)}×${esc(gif.height)} · ${esc(gif.seconds)} 秒</div>
    <a href="${url}" download="${esc(gif.ref.split("/").pop())}">下载 GIF</a>
    ${showcaseCanPublish()?OneShotI18n.html`<button type="button" data-gif-showcase="${esc(gif.ref)}">发布到展映</button>`:""}</div>`;
 }
 if(result.creative_directions?.length){
  return result.creative_directions.map(direction=>OneShotI18n.html`<section class="ac-storyboard-plan ac-direction" data-creative-direction="${esc(JSON.stringify(direction))}">
    <strong>${esc(direction.title)}</strong><p>${esc(direction.premise)}</p>
    <dl><dt>执行方法</dt><dd>${esc(direction.approach)}</dd><dt>取舍</dt><dd>${esc(direction.tradeoff)}</dd>
    <dt>第一步</dt><dd>${esc(direction.first_step)}</dd></dl>
    <div class="ac-storyboard-actions"><button type="button" data-explore-direction>继续讨论这个方向</button>
    <button type="button" data-plan-direction>拟制作方案</button></div></section>`).join("");
 }
 if(result.previs_storyboard_plan){
  const p=result.previs_storyboard_plan;
  const time=tick=>Number((tick/p.fps).toFixed(2));
  return OneShotI18n.html`<section class="ac-storyboard-plan"><strong>${esc(p.name)} · ${p.boundaries.length-1} 镜 · ${esc(p.aspect)}</strong>
   <details><summary>查看切点与镜长</summary><ol>${p.boundaries.slice(0,-1).map((start,i)=>{
    const end=p.boundaries[i+1];
    return OneShotI18n.html`<li>${time(start)}–${time(end)} 秒 · ${time(end-start)} 秒</li>`;
   }).join("")}</ol></details>
   <button type="button" data-open-previs-storyboard="${esc(JSON.stringify(p))}">打开白模核对</button></section>`;
 }
 if(result.shot_range_plan){
  const plan=result.shot_range_plan;
  const modes={missing:"补齐未生成镜头",all:"运行所有选中的节点",missing_frame:"只补齐分镜图",missing_video:"只补齐视频",frame:"重生成分镜图",video:"重生成视频"};
  const tails={connect:"连接缺失的上一镜尾帧",refresh:"刷新已有的上一镜尾帧",connect_and_refresh:"连接缺失并刷新已有的上一镜尾帧"};
  const details=[modes[plan.mode],tails[plan.tail_mode]].filter(Boolean).join(" · ");
  return OneShotI18n.html`<section class="ac-storyboard-plan"><strong>${esc(plan.name)} · 第 ${esc(plan.first)}${plan.first===plan.last?"":"–"+esc(plan.last)} 镜</strong>
    <p>${esc(details)}</p><button type="button" data-open-shot-range="${esc(JSON.stringify(plan))}">核对生成范围</button></section>`;
 }
 if(result.template_fill_plan){
  const plan=result.template_fill_plan;
  return OneShotI18n.html`<div class="ac-template-results"><article><strong>${esc(plan.name)}</strong>
    <small>已填写 ${esc(plan.inputs.length)} 项</small>
    <button type="button" data-template-fill-plan="${esc(JSON.stringify(plan))}">核对填写草稿</button>
  </article></div>`;
 }
 if(result.workflow_templates?.length){
  const source={private:"我的模板",catalog:"共享模板",presets:"内置工作流",favorites:"收藏模板"};
  return `<div class="ac-template-results">${result.workflow_templates.map(row=>OneShotI18n.html`<article>
   <strong>${esc(row.name)}</strong><small>${esc([source[row.scope],row.category,row.author].filter(Boolean).join(" · "))} · ${esc(row.nodes)} 个节点</small>
   ${row.description?`<p>${esc(row.description)}</p>`:""}
   <button type="button" data-open-workflow-template="${esc(row.id)}" data-template-scope="${esc(row.scope)}" aria-label="预览与使用 ${esc(row.name)}">预览与使用</button>
  </article>`).join("")}</div>`;
 }
 if(result.shot_revision){
  const p=result.shot_revision;
  const labels={duration:"时长",shot_size:"景别",camera:"机位",scene:"场景",action:"动作",dialogue:"台词",sound:"声音",keyframe:"首帧",
   asset_refs:"参考资产"};
  const display=(key,value)=>esc(key==="asset_refs"?acShotAssetNames(value):Array.isArray(value)?value.join("\n"):value??"");
  return OneShotI18n.html`<section class="ac-storyboard-plan" data-shot-revision="${esc(JSON.stringify(p))}">
   <strong>${esc(p.name)} · 第 ${p.shot} 镜</strong>
   <dl>${Object.entries(p.changes).map(([key,value])=>OneShotI18n.html`<dt>${esc(labels[key])}</dt><dd>
     <span class="ac-revision-before">${display(key,p.before[key])||"未填写"}</span><span aria-label="改为"> → </span>${display(key,value)||"清空"}</dd>`).join("")}</dl>
   <div class="ac-storyboard-actions"><button type="button" data-apply-shot-revision>应用到原镜头</button>
    <button type="button" data-run-shot-revision hidden>查看重生成计划</button></div><span role="status"></span></section>`;
 }
 if(result.shot_review){
  const p=result.shot_review;
  return `<div class="ac-results" data-shot-review-card="${esc(JSON.stringify(p))}"><span>第 ${p.shot-1} 镜尾帧（版本 ${p.left.version}） · 第 ${p.shot} 镜${p.right.kind==="image"?"分镜图":"首帧"}（版本 ${p.right.version}）</span>
   <div class="ac-storyboard-actions"><button type="button" data-shot-review>${p.samples?"查看切点与取样":"打开双帧对比"}</button>
    ${canvasCanEdit()?OneShotI18n.markup('<button type="button" data-plan-review-revision>为当前镜头拟修改</button>'):""}</div><span role="status"></span></div>`;
 }
 if(result.storyboard_create){
  const p=result.storyboard_create;
  return OneShotI18n.html`<section class="ac-storyboard-plan" data-storyboard-create="${esc(JSON.stringify(p))}">
   <strong>${esc(p.title || "分镜脚本")} · ${p.shots.length} 镜 · ${p.planned_seconds} 秒</strong>
   ${p.refs.length?`<p>参考图：${esc(p.refs.map(item=>item.name).join("、"))}</p>`:""}
   <ol>${p.shots.map(s=>`<li><details><summary>${s.duration} 秒 · ${esc(s.shot_size || s.scene || "镜头")}</summary>
    <p>${[s.scene,s.camera,s.keyframe,...s.action,...s.dialogue].filter(Boolean).map(esc).join("<br>")}</p>
    ${s.asset_refs?.length?`<small>参考资产 · ${esc(acShotAssetNames(s.asset_refs))}</small>`:""}
   </details></li>`).join("")}</ol>
   <button type="button" data-create-storyboard>${node(p.id)?"定位分镜":"加入画布"}</button><span role="status"></span></section>`;
 }
 if(result.storyboard_plan){
  const p=result.storyboard_plan,s=p.shot;
  const fields=[["场景",s.scene],["机位",s.camera],["首帧",s.keyframe],["动作",s.action.join("\n")],
    ["角色",s.characters.join("、")],["台词",s.dialogue.join("\n")],["声音",s.sound],["参考资产",acShotAssetNames(s.asset_refs)]];
  return OneShotI18n.html`<section class="ac-storyboard-plan" data-storyboard-plan="${esc(JSON.stringify(p))}">
   <strong>${esc(p.name)} · 第 ${p.anchor.count+1} 镜 · ${esc(s.shot_size)} · ${s.duration} 秒</strong>
   <dl>${fields.filter(([,value])=>value).map(([label,value])=>`<dt>${label}</dt><dd>${esc(value)}</dd>`).join("")}</dl>
   <div class="ac-storyboard-actions"><button type="button" data-adopt-storyboard>加入分镜</button>
    <button type="button" data-open-approved-shot hidden>展开这一镜</button>
    <button type="button" data-link-previous-shot hidden>参考上一镜尾帧</button>
    <button type="button" data-run-approved-shot hidden>生成这一镜…</button></div><span role="status"></span></section>`;
 }
 if(result.group_run_plan){
  const p=result.group_run_plan;
  return OneShotI18n.html`<div class="ac-results"><span>${esc(p.name)} · ${p.targets.length} 个节点 · ${p.mode==="all"?"运行指定节点":"补齐未生成节点"}</span>
   <button type="button" data-group-run-plan="${esc(JSON.stringify(p))}">查看分组运行计划</button></div>`;
 }
 if(result.reference_plan){
  const p=result.reference_plan;
  return OneShotI18n.html`<div class="ac-results"><span>${esc(p.source_name)} → ${esc(p.replacement_name)}${p.version?" · 版本 "+esc(p.version):""}${p.group_name?" · "+esc(p.group_name):""}${p.targets?.length?" · "+p.targets.length+" 个指定节点":""}</span>
   <button type="button" data-reference-plan="${esc(JSON.stringify(p))}">预览参考替换</button></div>`;
 }
 if (result.remake) {
  const {node_id, source_ref, shot_number, shot_start, frame, preview_job, video_job} = result.remake;
  const locate = Number.isFinite(shot_start) && Number.isInteger(shot_number);
  const label = locate ? result.location ? `确认镜头 ${shot_number} 的人物位置` : `打开重制镜头 ${shot_number}` : "打开视频重制";
  const open = (text, job, start = shot_start) => {
   const target = locate ? ` data-remake-start="${esc(start)}" data-remake-frame="${esc(frame || "")}" data-remake-preview-job="${esc(preview_job || "")}" data-remake-video-job="${esc(job || "")}"` : "";
   return `<button type="button" data-remake-node="${esc(node_id)}" data-remake-ref="${esc(source_ref)}"${target}>${esc(text)}</button>`;
  };
  if (result.split_shots?.length) {
   const seconds = value => Number(value.toFixed(2));
   return `<div class="ac-results">${result.split_shots.map(shot =>
    open(`镜头 ${shot.number} · ${seconds(shot.start)}–${seconds(shot.end)} 秒`, null, shot.start)).join("")}</div>`;
  }
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
  const download = result.export_ref ? OneShotI18n.html`<a href="/media?ref=${encodeURIComponent(result.export_ref)}" download="${esc(result.export_ref.split("/").at(-1))}">下载成片</a>` : "";
  const plan = result.remake_plan;
  const planCard = plan ? OneShotI18n.html`<fieldset class="ac-remake-plan" data-plan="${esc(JSON.stringify({...plan, node_id, source_ref}))}">
    <legend>确认换角计划</legend><div><img src="${remakeMedia(plan.reference)}" alt="角色参考图"><strong>${esc(plan.person)} → ${esc(plan.asset_name)}</strong></div>
    ${plan.shots.map(s => OneShotI18n.html`<label><input type="checkbox" value="${s.shot}" ${s.keep ? "disabled" : "checked"}>镜头 ${s.shot} · ${s.keep ? "保留原片" : s.selection_ready ? "可生成预览" : "需要确认人物选区"}</label>`).join("")}
    <button type="button" data-apply-plan>确认所选镜头</button><output aria-live="polite"></output></fieldset>` : "";
  return `<div class="ac-results">${open(label, video_job)}${download}</div>${review}${planCard}`;
 }
 const made=result.nodes||[];
 const editor=result.previs_node ? OneShotI18n.html`<button type="button" data-previs-open="${esc(result.previs_node)}" data-previs-ref="${esc(made[0]?.ref || "")}">打开白模编辑器</button>`
  : result.playlist_node ? OneShotI18n.html`<button type="button" data-playlist-open="${esc(result.playlist_node)}" data-playlist-rev="${esc(result.board_rev || 0)}">打开播放列表</button>` : "";
 if(!made.length&&!editor)return "";
 const cards=made.map(item=>{
  const n=vtResolve(item.id,item.ref)?.node,v=acResultVersion(item),kind=item.type||n?.type;
  const media=v?.ref?"/media?ref="+encodeURIComponent(v.ref):"";
  const focus=`data-focus="${esc(item.id)}" data-version-ref="${esc(v?.ref||"")}"`;
  if(kind==="video"||kind==="audio"){
   const player=kind==="video"?`<video controls playsinline preload="metadata" src="${media}" aria-label="${editor?"白模预演视频":"生成的视频"}"></video>`
    :`<audio controls preload="metadata" src="${media}" aria-label="生成的音频"></audio>`;
   const cut=kind==="video"&&extensionInput(v)
    ?OneShotI18n.html`<button type="button" data-extension-clip="${esc(item.id)}" data-version-ref="${esc(v.ref)}">与原片一起剪辑</button>`:"";
   return `<div class="ac-result ac-${kind}">${player}<button type="button" ${focus}>${kind==="video"?"定位视频":"定位音频"}</button>${cut}</div>`;
  }
  return `<button type="button" class="ac-result" ${focus}>${media?OneShotI18n.html`<img loading="lazy" alt="生成结果" src="${media}">`:""}<span>${esc(n?.name||item.name||"查看结果")}</span></button>`;
 });
 return `<div class="ac-results">${cards.join("")}${editor}</div>`;}
