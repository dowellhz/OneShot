"use strict";

function remakeTimelineSpec(video, source, session) {
  const spec = newSpec([]);
  spec.fit = "pad";
  spec.subtitles = false;
  spec.remake_audio = source.ref;
  spec.clips = session.shots.map((shot, index) => {
    const inScope = !session.mapping || session.mapping.shots.includes(index);
    const job = session.reviewed_jobs ? session.reviewed_jobs[index] : inScope && !shot.keep_original ? shot.adopted_video : null;
    const adopted = shot.videos?.find(v => v.job === job && v.state === "done" && v.ref);
    const elapsed = (Math.round(shot.end * RM_FPS) - Math.round(shot.start * RM_FPS)) / RM_FPS;
    const take = adopted ? {ref:adopted.ref, in:0, out:elapsed, audio_start:shot.start, media_seconds:adopted.duration || elapsed}
      : {ref:source.ref, in:shot.start, out:shot.end, audio_start:0, media_seconds:session.duration};
    return {node:video.id, ...take, name:`镜头 ${index + 1}`, trans:"cut", subs:[], volume:1,
      remake_shot:{source:source.ref, start:shot.start, end:shot.end}};
  });
  return spec;
}

function sendRemakeToFilm(video, source, session) {
  if (!session?.shots.length || session.export_review?.remaining?.length) return toast("请先完成镜头审核");
  showFilm(remakeTimelineSpec(video, source, session));
}

function closeShotContinuityReview() {
  const dialog=$("#shotContinuityReview");
  if(!dialog?.open)return;
  if(dialog.close)dialog.close();else dialog.removeAttribute("open");
}

function openShotContinuityReview(script,index,evidence=null) {
  if(node(script.id)!==script||index<1)return;
  const links=scriptShotLinks(script);
  const previous=node(links[index-1]?.vid), video=node(links[index]?.vid), still=node(links[index]?.img);
  const choices=(n,kind,position)=>n?.versions.flatMap((version,i)=>{
    if(!version.ref)return [];
    const params=new URLSearchParams({ref:version.ref});
    if(position)params.set("position",position);
    return [{node:n.id,ref:version.ref,version:i+1,url:`${position?"/api/video/frame-preview":"/media"}?${params}`,
      label:`${kind} · 版本 ${i+1}${n.cur===i?"（当前）":""}`,current:n.cur===i}];
  })||[];
  const left=choices(previous,"视频","last");
  const right=[...choices(video,"视频首帧","first"),...choices(still,"分镜图")];
  const evidenceIndex=(items,version)=>{
    const matches=item=>item.node===version.node&&item.ref===version.ref;
    const exact=items.findIndex(item=>matches(item)&&item.version===version.version);
    return exact<0?items.findIndex(matches):exact;
  };
  const leftIndex=evidence?evidenceIndex(left,evidence.left):left.findIndex(item=>item.current);
  const rightIndex=evidence?evidenceIndex(right,evidence.right):right.findIndex(item=>item.current);
  if(evidence&&(leftIndex<0||rightIndex<0))return toast("审阅的镜头或版本已变化，请重新分析");
  if(!left.length)return toast("上一镜还没有可对比的视频");
  if(!right.length)return toast("请先为当前镜头准备分镜图或视频");
  const dialog=$("#shotContinuityReview");
  if(dialog.open)return;
  $("#shotContinuityTitle").textContent=`${script.name} · 镜头 ${index} 与镜头 ${index+1}`;
  const fill=(selector,media,index)=>{
    const pane=$(selector,dialog), pick=$("select",pane), img=$("img",pane), status=$("[role=status]",pane);
    pick.replaceChildren(...media.map(({label},i)=>new Option(label,String(i))));
    pick.selectedIndex=Math.max(0,index);
    pick.onchange=()=>{
      const selected=media[pick.selectedIndex];
      img.hidden=true;
      status.textContent="正在读取画面…";
      img.onload=()=>{img.hidden=false;status.textContent="";};
      img.onerror=()=>{status.textContent="画面暂时无法读取";};
      img.src=selected.url;
    };
    pick.onchange();
  };
  fill("[data-left-frame]",left,leftIndex);
  fill("[data-right-frame]",right,rightIndex);
  if(dialog.showModal)dialog.showModal();else dialog.setAttribute("open","");
}

function initShotList() {
  const button = $("#shotListBtn");
  if (!button) return;
  const panel = document.createElement("aside");
  panel.id = "shotList";
  panel.hidden = true;
  panel.setAttribute("aria-labelledby","shotListTitle");
  panel.innerHTML = `<header><h2 id="shotListTitle">镜头清单</h2><button class="pill" data-close>收起</button></header>
    <div class="sl-controls"><select data-source aria-label="镜头来源"></select><button class="pill" data-reload>刷新</button>
    <button class="pill" data-film disabled>送入剪辑</button><button class="pill" data-draft>恢复剪辑</button></div><output aria-live="polite"></output><ol></ol>`;
  document.body.append(panel);
  document.body.insertAdjacentHTML("beforeend",`<dialog id="shotContinuityReview" aria-labelledby="shotContinuityTitle">
    <header><h2 id="shotContinuityTitle"></h2><button type="button" data-close>关闭</button></header>
    <div class="shot-continuity-frames">
      <figure data-left-frame><figcaption>前一镜尾帧</figcaption><select aria-label="前一镜版本"></select>
        <div><img alt="前一镜尾帧" hidden><span role="status"></span></div></figure>
      <figure data-right-frame><figcaption>当前镜头</figcaption><select aria-label="当前镜头版本"></select>
        <div><img alt="当前镜头画面" hidden><span role="status"></span></div></figure>
    </div></dialog>`);
  const review=$("#shotContinuityReview");
  $("[data-close]",review).onclick=closeShotContinuityReview;
  review.onkeydown=event=>event.stopPropagation();
  review.onclose=()=>{if(!review.open)$$("img",review).forEach(img=>img.removeAttribute("src"));};
  let epoch = 0;
  const sourceSelect = $("[data-source]", panel);
  const list = $("ol", panel), message = $("output", panel), film = $("[data-film]", panel);

  function toggle(show) {
    panel.hidden = !show;
    button.setAttribute("aria-expanded", String(show));
    if (!show) { epoch++; return; }
    const sources = B.nodes.filter(n => n.type === "script" && n.data.shots?.length ||
      n.type === "video" && curV(n)?.ref && !n.data.film && !curV(n).remake);
    const selected = sources.find(n => sel.has(n.id))?.id || sourceSelect.value;
    sourceSelect.replaceChildren(...sources.map(n => new Option(n.name, n.id)));
    if (sources.some(n => n.id === selected)) sourceSelect.value = selected;
    refresh();
  }
  function locate(target) {
    if (!target) return;
    selectOnly(target.id);
    fit([target]);
  }
  function row(title, details, onOpen, versions, selected, onVersion, shotIndex=null, onCompare=null) {
    const el = document.createElement("li"), info = document.createElement("div"), open = document.createElement("button");
    open.type = "button"; open.className = "pill"; open.textContent = title; open.onclick = onOpen;
    const subtitle = document.createElement("span"); subtitle.textContent = details;
    info.append(open, subtitle); el.append(info);
    if(shotIndex>0){
      const tail=document.createElement("span");tail.className="story-tail-status";
      tail.dataset.scriptTailStatus=String(shotIndex);tail.hidden=true;info.append(tail);
    }
    if(onCompare){
      const compare=document.createElement("button");compare.className="pill";compare.type="button";
      compare.textContent="对比衔接";compare.onclick=onCompare;info.append(compare);
    }
    if (versions.length) {
      const input = document.createElement("select");
      input.setAttribute("aria-label", `${title}版本`);
      input.replaceChildren(...versions.map(([value, label]) => new Option(label, value)));
      input.value = selected || "";
      input.onchange = () => onVersion(input.value);
      el.append(input);
    }
    list.append(el);
  }
  async function refresh() {
    const request = ++epoch, board = boardId, target = node(sourceSelect.value);
    list.replaceChildren(); message.textContent = ""; film.disabled = true; film.onclick = null;
    if (!target) { message.textContent = "添加原片或生成分镜后，可在这里查看镜头。"; return; }
    if (target.type === "script") {
      const connected = scriptShotLinks(target);
      const vids = [];
      target.data.shots.forEach((shot, i) => {
        const v = node(connected[i]?.vid); vids.push(v);
        row(`镜头 ${i + 1}`, [`${shot.duration || "—"} 秒`, ...(shot.characters || []),
          v?.job ? "生成中" : curV(v) ? "已生成" : connected[i]?"待生成":"未展开"].join(" · "),
          () => locate(v || node(connected[i]?.img) || target),
          v?.versions.map((_, index) => [String(index), `版本 ${index + 1}`]) || [], String(v?.cur ?? ""),
          value => { if (switchVersion(v, +value)) locate(v); refresh(); },i,
          i>0&&connected[i-1]&&connected[i]?()=>openShotContinuityReview(target,i):null);
      });
      paintScriptContinuity(target,list,connected);
      film.disabled = !vids.length || vids.some(v => !curV(v));
      film.onclick = () => {
        if (vids.some(v => !curV(v) || node(v.id) !== v)) return refresh();
        const spec = newSpec(vids);
        spec.clips = spec.clips.map((clip, i) => ({...clip, ref:curV(vids[i]).ref, media_seconds:vlen(vids[i])}));
        showFilm(spec);
      };
      return;
    }
    const source = curV(target);
    message.textContent = "读取镜头…";
    try {
      await flushSave();
      const url = `/api/video-remake/${encodeURIComponent(board)}/${encodeURIComponent(target.id)}?source=${encodeURIComponent(source.ref)}`;
      const session = await remakeRequest(url);
      if (request !== epoch || board !== boardId || panel.hidden) return;
      message.textContent = "";
      if (!session?.shots.length) {
        row("分析原片", "待分析", () => openVideoRemake(target), [], "", null);
        return;
      }
      const issues = new Set(session.export_review?.remaining.map(x => x.shot));
      session.shots.forEach((shot, i) => {
        const versions = (shot.videos || []).filter(v => v.state === "done" && v.ref);
        const adopted = !issues.has(i) && versions.some(v => v.job === (session.reviewed_jobs ? session.reviewed_jobs[i] : shot.adopted_video));
        const kept = !adopted && !issues.has(i) && (shot.keep_original || session.mapping && !session.mapping.shots.includes(i));
        const state = kept ? "保留原片" : adopted ? "已采用" : shot.videos?.some(v => !["done","error"].includes(v.state)) ? "生成中" : versions.length ? "待审核" : "待生成";
        const open = videoJob => openVideoRemake(target, {shotStart:shot.start, videoJob});
        row(`镜头 ${i + 1}`, [`${(shot.end - shot.start).toFixed(1)} 秒`, ...(shot.summary?.characters || []), state].join(" · "),
          () => open(adopted && !kept ? shot.adopted_video : undefined),
          versions.length ? [["","查看版本"], ...versions.map(v => [v.job,`版本 ${shot.videos.indexOf(v) + 1}`])] : [],
          adopted && !kept ? shot.adopted_video : "", value => { if (value) open(value); });
      });
      film.disabled = issues.size > 0;
      film.onclick = () => sendRemakeToFilm(target, source, session);
    } catch (error) {
      if (request === epoch && board === boardId) message.textContent = error.message;
    }
  }
  button.onclick = () => toggle(panel.hidden);
  $("[data-close]", panel).onclick = () => toggle(false);
  $("[data-reload]", panel).onclick = () => toggle(true);
  $("[data-draft]", panel).onclick = resumeFilmDraft;
  sourceSelect.onchange = refresh;
  panel.addEventListener("keydown", event => {
    event.stopPropagation();
    if (event.key === "Escape") { toggle(false); button.focus(); }
  });
}
