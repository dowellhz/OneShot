"use strict";

document.getElementById("mediaToolDialogs").insertAdjacentHTML("beforebegin", OneShotI18n.html`
<dialog id="segmentReview" aria-labelledby="segmentReviewTitle">
  <header><strong id="segmentReviewTitle">审核修改片段</strong><button type="button" data-sr-close aria-label="关闭">×</button></header>
  <p data-sr-name></p>
  <div data-sr-list></div>
  <p><label><input type="checkbox" data-sr-original-audio> 保留原片声音</label></p>
  <p data-sr-preview></p><video controls playsinline preload="metadata" hidden></video>
  <p data-sr-status role="status"></p>
  <footer><button type="button" data-sr-save>保存决定</button><button type="button" data-sr-send>送入剪辑台</button></footer>
</dialog>
`);

function closeSegmentReview() {
  const dialog=$("#segmentReview"), player=$("video",dialog);
  if (!dialog.open) return;
  player.pause();player.removeAttribute("src");
  player.onloadedmetadata=player.ontimeupdate=null;
  if (dialog.close) dialog.close(); else dialog.removeAttribute("open");
}

function openSegmentReview(sourceNode, useParent=false) {
  if (!canvasCanEdit()) return;
  const v=curV(sourceNode);
  const clip=useParent && v?.video_recipe?.segment_edit && v.video_recipe.video_refs?.[0];
  const source=clip ? vtResolve(clip.node_id,clip.ref) : {node:sourceNode,index:sourceNode.cur};
  if (!source?.node.versions[source.index]) return toast("修改所对应的原片版本已移除");
  const board=boardId, original=source.node.versions[source.index], originalId=source.node.id;
  const dialog=$("#segmentReview"), player=$("video",dialog), list=$("[data-sr-list]",dialog), status=$("[data-sr-status]",dialog);
  if (dialog.open) return;
  const rows=collectSegmentVersions(source);
  if (!rows.length) return toast("这个原片版本还没有生成完成的修改片段");
  const reviewState=version=>JSON.stringify([version.segment_review ?? null,version.segment_review_original_audio===true]);
  const initialReview=reviewState(original), keepAudio=$("[data-sr-original-audio]",dialog);
  keepAudio.checked=original.segment_review_original_audio===true;
  const prior=Array.isArray(original.segment_review)?original.segment_review:[];
  const picks=new Map();
  const entryKey=entry=>JSON.stringify([entry.node.id,entry.version.ref,entry.start,entry.end]);
  const options=new Map(rows.flatMap(row=>row.entries.map(entry=>[entryKey(entry),entry])));
  const read=()=>[...picks.values()].filter(Boolean).map(key=>options.get(key));
  let missing=0;
  for (const choice of prior) {
    const row=rows.find(row=>row.start===choice?.start_frame && row.end===choice.end_frame);
    const entry=row?.entries.find(entry=>entry.node.id===choice.node_id&&entry.version.ref===choice.ref) ||
      row?.entries.find(entry=>entry.version.ref===choice.ref);
    if (entry && !entry.short) picks.set(row.key,entryKey(entry));
    else missing++;
  }
  if (clip && !Array.isArray(original.segment_review)) {
    const match=segmentCandidate(sourceNode,sourceNode.cur);
    if (match && !match.short && options.has(entryKey(match))) picks.set(`${match.start}:${match.end}`,entryKey(match));
  }
  $("[data-sr-name]",dialog).textContent=`${source.node.name} · 版本 ${source.index+1}`;
  const hint=$("[data-sr-preview]",dialog);
  hint.textContent="";
  player.hidden=true;
  const preview=(version,start,end,label)=>{
    player.pause();player.hidden=false;hint.textContent=label;
    const startTime=start/SEGMENT_FPS, endTime=end/SEGMENT_FPS;
    player.onloadedmetadata=()=>{player.currentTime=startTime;};
    player.ontimeupdate=()=>{
      if (player.currentTime>=endTime) {player.pause();if (player.currentTime>endTime) player.currentTime=endTime;}
    };
    if (player.getAttribute("src")!==version.url) player.src=version.url || "";
    else if (player.readyState>=1) player.currentTime=startTime;
  };
  const button=(label, action)=>{
    const element=document.createElement("button");element.type="button";element.textContent=label;element.onclick=action;return element;
  };
  const send=$("[data-sr-send]",dialog),saveButton=$("[data-sr-save]",dialog);
  const update=()=>{
    const selected=read();
    try {
      segmentTimelineSpec(source,selected);
      status.textContent=`采用 ${selected.length} 个区间`+(missing?`，${missing} 个已保存结果不可用`:"");
      send.disabled=saveButton.disabled=false;
    } catch (error) {status.textContent=error.message;send.disabled=saveButton.disabled=true;}
  };
  list.replaceChildren(...rows.map(row=>{
    const group=document.createElement("fieldset"); group.className="segment-review-row";
    const title=document.createElement("legend");title.textContent=`${segmentTime(row.start)} – ${segmentTime(row.end)}`;
    const select=document.createElement("select");select.setAttribute("aria-label",`采用 ${title.textContent} 的版本`);
    select.append(new Option("保留原片",""));
    for (const entry of row.entries) {
      const option=new Option(`${entry.node.name} · 版本 ${entry.index+1}${entry.short?"（时长不足）":""}`,entryKey(entry));
      option.disabled=entry.short;select.append(option);
    }
    select.value=picks.get(row.key)||"";
    select.onchange=()=>{picks.set(row.key,select.value);update();};
    group.append(title,select,button("预览原片",()=>preview(original,row.start,row.end,title.textContent+" · 原片")),
      button("预览候选",()=>{
        const candidate=options.get(select.value)||row.entries.find(entry=>!entry.short);
        if (!candidate) return;
        preview(candidate.version,0,candidate.end-candidate.start,candidate.node.name+` · 版本 ${candidate.index+1}`);
      }));
    return group;
  }));
  const commit=editing=>{
    const current=vtResolve(originalId,original.ref);
    const ver=current?.node.versions[current.index];
    if (!canvasCanEdit() || board!==boardId || !ver || reviewState(ver)!==initialReview) {
      status.textContent="画布中的审核决定已变更，请关闭后重新打开。";return;
    }
    const live=collectSegmentVersions(current), valid=new Map(live.flatMap(row=>row.entries.map(entry=>[entryKey(entry),entry])));
    const selected=read().map(entry=>valid.get(entryKey(entry)));
    if (selected.some(entry=>!entry)) {status.textContent="有候选版本已变更，请关闭后重新打开。";return;}
    try { segmentTimelineSpec(current,selected); } catch (error) {status.textContent=error.message;return;}
    const review=selected.sort((a,b)=>a.start-b.start)
      .map(entry=>({node_id:entry.node.id,ref:entry.version.ref,start_frame:entry.start,end_frame:entry.end}));
    const audio=keepAudio.checked;
    if (JSON.stringify([review,audio])!==initialReview) {
      checkpoint();ver.segment_review=review;ver.segment_review_original_audio=audio;save();
    }
    closeSegmentReview();
    if (editing) showSegmentCut(current,selected,audio);
  };
  $("[data-sr-close]",dialog).onclick=closeSegmentReview;
  dialog.oncancel=event=>{event.preventDefault();closeSegmentReview();};
  send.onclick=()=>commit(true);saveButton.onclick=()=>commit(false);
  update();
  if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open","");
}
