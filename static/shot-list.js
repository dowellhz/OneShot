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
    return [{node:n.id,ref:version.ref,version:i+1,type:n.type,url:`${position?"/api/video/frame-preview":"/media"}?${params}`,
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
  const board=boardId, request=$("[data-request-review]",dialog), requestStatus=$("footer [role=status]",dialog);
  const attempts=new Map();
  request.disabled=false;request.hidden=!canvasCanEdit();requestStatus.textContent="";
  $("#shotContinuityTitle").textContent=`${script.name} · 镜头 ${index} 与镜头 ${index+1}`;
  const fill=(selector,media,index,side)=>{
    const pane=$(selector,dialog), pick=$("select",pane), img=$("img",pane), status=$("[role=status]",pane);
    const samples=$("[data-samples]",pane);
    pick.replaceChildren(...media.map(({label},i)=>new Option(label,String(i))));
    pick.selectedIndex=Math.max(0,index);
    const show=url=>{
      img.hidden=true;
      status.textContent="正在读取画面…";
      img.onload=()=>{img.hidden=false;status.textContent="";};
      img.onerror=()=>{status.textContent="画面暂时无法读取";};
      img.src=url;
    };
    pick.onchange=()=>{
      const selected=media[pick.selectedIndex];
      const frames=pick.selectedIndex===index?evidence?.samples?.[side]||[]:[];
      samples.replaceChildren();samples.hidden=!frames.some(frame=>frame.position==="time");
      for(const frame of samples.hidden?[]:frames){
        const button=document.createElement("button");
        button.type="button";
        button.textContent=frame.position==="time"?`${frame.seconds.toFixed(2)}s`:frame.position==="last"?"尾帧":"首帧";
        button.setAttribute("aria-pressed",String(frame.position!=="time"));
        button.onclick=()=>{
          for(const item of samples.children)item.setAttribute("aria-pressed",String(item===button));
          const url=new URL(selected.url,location.href);
          url.searchParams.set("position",frame.position);
          if(frame.position==="time")url.searchParams.set("at",frame.at);
          show(url.pathname+url.search);
        };
        samples.append(button);
      }
      show(selected.url);
      if(side==="right")request.textContent=selected.type==="video"?"交给助手审阅动作衔接":"交给助手审阅画面衔接";
    };
    pick.onchange();
    return ()=>media[pick.selectedIndex];
  };
  const pickLeft=fill("[data-left-frame]",left,leftIndex,"left");
  const pickRight=fill("[data-right-frame]",right,rightIndex,"right");
  const submit=async()=>{
    const from=pickLeft(), to=pickRight();
    const pin=({node,ref,version})=>({node,ref,version});
    const shot_review={node_id:script.id,shot:index+1,left:pin(from),right:pin(to),current_type:to.type};
    const key=JSON.stringify(shot_review);
    if(!attempts.has(key))attempts.set(key,crypto.randomUUID?.()||("shot-review-"+Date.now()+Math.random()));
    request.disabled=true;requestStatus.textContent="正在提交审阅…";
    try{
      await acSendShotRequest(board,{shot_review,request_key:attempts.get(key),enqueue:true,
        text:`审阅第 ${index} 镜（版本 ${from.version}）到第 ${index+1} 镜${to.type==="image"?"分镜图":""}（版本 ${to.version}）的${to.type==="video"?"动作":"画面"}衔接`});
      if(request.onclick===submit && dialog.open){closeShotContinuityReview();$("#acInput").focus();}
    }catch(error){if(request.onclick===submit)requestStatus.textContent=error.message;}
    finally{if(request.onclick===submit)request.disabled=false;}
  };
  request.onclick=submit;
  if(dialog.showModal)dialog.showModal();else dialog.setAttribute("open","");
}

function openPlannedShotRange(plan) {
  const script=node(plan.script);
  if(plan.board!==boardId || !canvasCanEdit() || script?.type!=="script")return toast("请回到对应的可编辑分镜");
  const shots=script.data.shots||[];
  const indices=plan.anchors.map((anchor,offset)=>{
    if(anchor.id)return shots.findIndex(shot=>shot.id===anchor.id);
    const i=plan.first-1+offset, shot=shots[i];
    return shot&&Object.entries(anchor.fields).every(([key,value])=>JSON.stringify(shot[key]??null)===JSON.stringify(value))?i:-1;
  });
  if(!indices.length||indices.some((index,i)=>index<0||i>0&&index!==indices[i-1]+1))return toast("镜头范围已变化，请让助手重新准备");
  openShotRangePicker(script,null,{firstIndex:indices[0],lastIndex:indices.at(-1),mode:plan.mode});
}

function openShotRangePicker(script, onExpanded, {firstIndex=0,lastIndex=null,mode="missing"}={}) {
  if(!canvasCanEdit() || node(script.id)!==script || nodeLocked(script))return;
  const dialog=$("#shotRangePicker"), form=$("form",dialog), board=boardId, shots=script.data.shots.slice();
  if(dialog.open || !shots.length)return;
  const first=$("[name=first]",form), last=$("[name=last]",form), submit=$("[type=submit]",form), status=$("[role=status]",form);
  const label=(shot,i)=>`镜头 ${i+1}${shot.shot_size?" · "+shot.shot_size:""}`;
  first.replaceChildren(...shots.map((shot,i)=>new Option(label(shot,i),String(i))));
  first.value=String(firstIndex);
  const missing=()=>{
    const linked=scriptShotLinks(script);
    return shots.flatMap((_,i)=>i>=Number(first.value) && i<=Number(last.value) && !linked[i]?[i]:[]);
  };
  const update=()=>{
    const amount=Number(last.value)-Number(first.value)+1, pending=missing().length;
    status.textContent=`已选 ${amount} 镜${pending?`，其中 ${pending} 镜待展开`:""}`;
    submit.textContent=pending?"展开并查看计划":"查看生成计划";
  };
  first.onchange=()=>{
    const start=Number(first.value), end=last.value===""?shots.length-1:Number(last.value);
    last.replaceChildren(...shots.slice(start).map((shot,i)=>new Option(label(shot,start+i),String(start+i))));
    last.value=String(end>=start&&end<shots.length?end:shots.length-1);
    update();
  };
  last.replaceChildren();last.onchange=update;first.onchange();
  if(lastIndex!=null){last.value=String(lastIndex);update();}
  form.onsubmit=event=>{
    event.preventDefault();
    if(board!==boardId || !canvasCanEdit() || node(script.id)!==script || nodeLocked(script) ||
       shots.length!==script.data.shots.length || shots.some((shot,i)=>shot!==script.data.shots[i])){
      status.textContent="分镜已更新，请重新选择镜头范围";submit.disabled=true;return;
    }
    if(groupRun?.active){status.textContent="当前有运行计划正在生成";return;}
    const pending=missing();
    if(pending.length){expandScript(script,pending);onExpanded?.();}
    closeShotRangePicker();
    openScriptShotRangeRun(script,Number(first.value),Number(last.value),mode);
  };
  submit.disabled=false;
  if(dialog.showModal)dialog.showModal();else dialog.setAttribute("open","");
}

function closeShotRangePicker() {
  const dialog=$("#shotRangePicker");
  if(dialog.close)dialog.close();else dialog.removeAttribute("open");
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
    <button class="pill" data-run-range hidden>批量生成</button><button class="pill" data-film disabled>送入剪辑</button><button class="pill" data-draft>恢复剪辑</button></div>
    <div class="sl-film-range" hidden><label>从<select data-film-from aria-label="剪辑起始镜头"></select></label>
      <label>到<select data-film-to aria-label="剪辑结束镜头"></select></label><span role="status" data-film-count></span></div>
    <output aria-live="polite"></output><ol></ol>`;
  document.body.append(panel);
  document.body.insertAdjacentHTML("beforeend",`<dialog id="shotContinuityReview" aria-labelledby="shotContinuityTitle">
    <header><h2 id="shotContinuityTitle"></h2><button type="button" data-close>关闭</button></header>
    <div class="shot-continuity-frames">
      <figure data-left-frame><figcaption>前一镜尾帧</figcaption><select aria-label="前一镜版本"></select>
        <div><img alt="前一镜画面" hidden><span role="status"></span></div><nav data-samples aria-label="前一镜取样" hidden></nav></figure>
      <figure data-right-frame><figcaption>当前镜头</figcaption><select aria-label="当前镜头版本"></select>
        <div><img alt="当前镜头画面" hidden><span role="status"></span></div><nav data-samples aria-label="当前镜头取样" hidden></nav></figure>
    </div><footer><span role="status"></span><button type="button" data-request-review>交给助手审阅</button></footer></dialog>
    <dialog id="shotRangePicker" aria-labelledby="shotRangeTitle"><form>
      <header><h2 id="shotRangeTitle">批量生成镜头</h2></header>
      <div class="sl-run-range"><label>开始镜头<select name="first"></select></label><label>结束镜头<select name="last"></select></label></div>
      <p role="status"></p><footer><button type="button" data-close>取消</button><button type="submit">查看生成计划</button></footer>
    </form></dialog>`);
  const review=$("#shotContinuityReview");
  $("[data-close]",review).onclick=closeShotContinuityReview;
  review.onkeydown=event=>event.stopPropagation();
  review.onclose=()=>{if(!review.open)$$("img",review).forEach(img=>img.removeAttribute("src"));};
  const picker=$("#shotRangePicker");
  $("[data-close]",picker).onclick=closeShotRangePicker;
  picker.onkeydown=event=>event.stopPropagation();
  let epoch = 0;
  const sourceSelect = $("[data-source]", panel);
  const list = $("ol", panel), message = $("output", panel), film = $("[data-film]", panel);
  const run=$("[data-run-range]",panel);
  const range=$(".sl-film-range",panel), from=$("[data-film-from]",range), to=$("[data-film-to]",range), count=$("[data-film-count]",range);
  let filmRange = null;

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
    return el;
  }
  function scriptFilmRange(target, connected, rows) {
    const board=boardId, shots=target.data.shots.slice();
    const keys=shots.map((shot,i)=>shot.id || `index:${i}`);
    const isReady=pair=>!!curV(node(pair?.vid))?.ref;
    const options=keys.map((key,i)=>new Option(`镜头 ${i+1}`,key));
    options.forEach((option,i)=>option.disabled=!isReady(connected[i]));
    from.replaceChildren(...options);
    from.selectedIndex=options.findIndex(option=>!option.disabled);
    if(filmRange?.board===board && filmRange.script===target.id && options.some(option=>option.value===filmRange.from&&!option.disabled)){
      from.value=filmRange.from;
    }
    const update=()=>{
      const start=from.selectedIndex, end=keys.indexOf(to.value);
      const amount=start>=0&&end>=start?end-start+1:0;
      film.disabled=!amount;
      count.textContent=amount?`已选 ${amount} 镜`:"暂无可剪辑的镜头";
      rows.forEach((row,i)=>row.toggleAttribute("data-clip-range",amount>0&&i>=start&&i<=end));
    };
    const chooseEnd=preferred=>{
      const start=from.selectedIndex, ends=[];
      for(let i=start;i>=0&&i<keys.length&&isReady(connected[i]);i++)ends.push(new Option(`镜头 ${i+1}`,keys[i]));
      to.replaceChildren(...ends);
      to.selectedIndex=ends.length-1;
      if(ends.some(option=>option.value===preferred))to.value=preferred;
      from.disabled=to.disabled=!ends.length;
      update();
    };
    const remember=()=>{filmRange={board,script:target.id,from:from.value,to:to.value};};
    from.onchange=()=>{chooseEnd(to.value);remember();};
    to.onchange=()=>{update();remember();};
    chooseEnd(filmRange?.board===board && filmRange.script===target.id?filmRange.to:null);
    film.onclick=()=>{
      if(board!==boardId || node(target.id)!==target)return refresh();
      const current=target.data.shots, start=from.selectedIndex, end=keys.indexOf(to.value);
      const latest=scriptShotLinks(target);
      if(start<0 || end<start || keys.length!==current.length || shots.slice(start,end+1).some((shot,i)=>shot!==current[start+i]))return refresh();
      const pairs=latest.slice(start,end+1);
      if(pairs.length!==end-start+1 || pairs.some((pair,i)=>pair?.vid!==connected[start+i]?.vid || !isReady(pair)))return refresh();
      const spec=newSpec(pairs.map(pair=>node(pair.vid)));
      const key=filmDraftPrefix()+"story:"+JSON.stringify([target.id,keys.slice(start,end+1),spec.clips.map(clip=>[clip.node,clip.ref])]);
      showFilm(spec,null,key);
    };
    range.hidden=false;
  }
  async function refresh() {
    const request = ++epoch, board = boardId, target = node(sourceSelect.value);
    list.replaceChildren(); message.textContent = ""; film.disabled = true; film.onclick = null; range.hidden=true;
    run.hidden=target?.type!=="script" || !canvasCanEdit() || nodeLocked(target);
    if (!target) { message.textContent = "添加原片或生成分镜后，可在这里查看镜头。"; return; }
    if (target.type === "script") {
      const connected = scriptShotLinks(target);
      const rows=target.data.shots.map((shot, i) => {
        const v = node(connected[i]?.vid);
        return row(`镜头 ${i + 1}`, [`${shot.duration || "—"} 秒`, ...(shot.characters || []),
          v?.job ? "生成中" : curV(v) ? "已生成" : connected[i]?"待生成":"未展开"].join(" · "),
          () => locate(v || node(connected[i]?.img) || target),
          v?.versions.map((_, index) => [String(index), `版本 ${index + 1}`]) || [], String(v?.cur ?? ""),
          value => { if (switchVersion(v, +value)) locate(v); refresh(); },i,
          i>0&&connected[i-1]&&connected[i]?()=>openShotContinuityReview(target,i):null);
      });
      paintScriptContinuity(target,list,connected);
      scriptFilmRange(target,connected,rows);
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
  run.onclick=()=>{const target=node(sourceSelect.value);if(target?.type==="script")openShotRangePicker(target,refresh);};
  sourceSelect.onchange = refresh;
  panel.addEventListener("keydown", event => {
    event.stopPropagation();
    if (event.key === "Escape") { toggle(false); button.focus(); }
  });
}
