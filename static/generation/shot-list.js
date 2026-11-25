"use strict";

function initShotList() {
  const button = $("#shotListBtn");
  if (!button) return;
  const panel = document.createElement("aside");
  panel.id = "shotList";
  panel.hidden = true;
  panel.setAttribute("aria-labelledby","shotListTitle");
  panel.innerHTML = OneShotI18n.html`<header><h2 id="shotListTitle">镜头清单</h2><button class="pill" data-close>收起</button></header>
    <div class="sl-controls"><select data-source aria-label="镜头来源"></select><button class="pill" data-reload>刷新</button>
    <button class="pill" data-add-shot hidden>新增镜头</button><button class="pill" data-sort-shots hidden aria-pressed="false">排序</button><button class="pill" data-run-range hidden>批量生成</button><button class="pill" data-film disabled>送入剪辑</button><button class="pill" data-draft>恢复剪辑</button></div>
    <div class="sl-film-range" hidden><label>从<select data-film-from aria-label="剪辑起始镜头"></select></label>
      <label>到<select data-film-to aria-label="剪辑结束镜头"></select></label><span role="status" data-film-count></span></div>
    <output aria-live="polite"></output><ol></ol>`;
  document.body.append(panel);
  document.body.insertAdjacentHTML("beforeend",OneShotI18n.html`<dialog id="shotContinuityReview" aria-labelledby="shotContinuityTitle">
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
    </form></dialog>
    <dialog id="shotEditor" aria-labelledby="shotEditorTitle"><form>
    <header><h2 id="shotEditorTitle"></h2><button type="button" data-close>关闭</button></header>
    <div class="sl-edit-fields">
      <label class="sl-wide" data-shot-placement hidden>插入位置<select></select></label>
      <label>时长<select name="duration"></select></label>
      <label>景别<input name="shot_size" maxlength="60"></label>
      <label class="sl-wide">场景<textarea name="scene" rows="2" maxlength="800"></textarea></label>
      <label class="sl-wide" hidden>人物<input name="characters" placeholder="用逗号分隔人物名称"></label>
      <label class="sl-wide">首帧描述<textarea name="keyframe" rows="2" maxlength="800"></textarea></label>
      <label class="sl-wide">运镜<textarea name="camera" rows="2" maxlength="400"></textarea></label>
      <label>动作<textarea name="action" rows="4" placeholder="一行一个动作"></textarea></label>
      <label>台词<textarea name="dialogue" rows="4" placeholder="一行一句台词"></textarea></label>
      <label class="sl-wide">声音<textarea name="sound" rows="2" maxlength="600"></textarea></label>
      <details class="sl-wide sl-shot-assets" data-shot-assets><summary>参考资产</summary>
        <ul data-shot-asset-selected aria-label="已选参考资产"></ul>
        <label>查找资产<input type="search" data-shot-asset-query maxlength="80" placeholder="名称、别名或标签"></label>
        <p aria-live="polite" data-shot-asset-status></p><ul data-shot-asset-results aria-label="可选参考资产"></ul>
      </details>
    </div>
    <p role="status"></p>
    <div class="sl-remove-actions" data-shot-remove-actions hidden><button type="button" data-cancel-shot-remove>取消</button><button type="button" data-confirm-shot-remove>确认移出</button></div>
    <footer><button type="button" data-duplicate-shot>复制设定</button><button type="button" data-remove-shot>移出分镜</button>
      <button type="button" data-run-shot-edit hidden>查看重生成计划</button><button type="submit">保存修改</button></footer>
    </form></dialog>
    <dialog id="shotMediaPicker" aria-labelledby="shotMediaTitle"><form>
    <header><h2 id="shotMediaTitle"></h2><button type="button" data-close>关闭</button></header>
    <div class="sl-edit-fields">
      <label class="sl-wide">分镜图节点<select></select></label>
      <label class="sl-wide">视频节点<select></select></label>
    </div>
    <p>分镜使用所选节点的当前版本。</p><p role="status"></p>
    <footer><button type="submit">保存关联</button></footer>
    </form></dialog>`);
  const review=$("#shotContinuityReview");
  $("[data-close]",review).onclick=closeShotContinuityReview;
  review.onkeydown=event=>event.stopPropagation();
  review.onclose=()=>{if(!review.open)$$("img",review).forEach(img=>img.removeAttribute("src"));};
  const picker=$("#shotRangePicker");
  $("[data-close]",picker).onclick=closeShotRangePicker;
  picker.onkeydown=event=>event.stopPropagation();
  const editor=$("#shotEditor");
  $("[data-close]",editor).onclick=closeShotEditor;
  editor.onkeydown=event=>event.stopPropagation();
  const mediaPicker=$("#shotMediaPicker");
  $("[data-close]",mediaPicker).onclick=closeShotMediaPicker;
  mediaPicker.onkeydown=event=>event.stopPropagation();
  let epoch = 0;
  const sourceSelect = $("[data-source]", panel);
  const list = $("ol", panel), message = $("output", panel), film = $("[data-film]", panel);
  const run=$("[data-run-range]",panel), sort=$("[data-sort-shots]",panel), add=$("[data-add-shot]",panel);
  const range=$(".sl-film-range",panel), from=$("[data-film-from]",range), to=$("[data-film-to]",range), count=$("[data-film-count]",range);
  let filmRange = null, sorting=false, dragged=null;

  function toggle(show) {
    panel.hidden = !show;
    button.setAttribute("aria-expanded", String(show));
    if (!show) { epoch++;sorting=false;dragged=null;return; }
    const sources = B.nodes.filter(n => n.type === "script" ||
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
    if(shotIndex!==null){
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
  function shotTailActions(el, script, shot, index) {
    const actions=document.createElement("div");
    actions.className="sl-tail-actions";actions.dataset.shotTailActions=String(index);actions.hidden=true;
    actions.innerHTML='<button class="pill" type="button" data-tail-link></button><button class="pill" type="button" data-tail-remove>移除尾帧引用</button>';
    actions.onclick=async event=>{
      const control=event.target.closest("button");
      if(!control||control.hidden||control.disabled||sourceSelect.value!==script.id||
        node(script.id)!==script||script.data.shots[index]!==shot||!canvasCanEdit()||nodeLocked(script))return;
      if(groupRun?.active&&groupRun.board===B&&groupRun.story?.scriptId===script.id){
        return toast("请等此分镜的批量生成结束后再修改尾帧");
      }
      if(control.hasAttribute("data-tail-remove")){
        const edge=scriptTailEdges().get(scriptShotLinks(script)[index]?.img);
        if(edge&&cutEdge(edge))toast("已移除尾帧引用，可撤销");
        return;
      }
      const pending=linkPreviousShotFrame(script,index,{select:false});
      paintScriptContinuity(script,list);
      await pending;
      if(node(script.id)===script&&sourceSelect.value===script.id)paintScriptContinuity(script,list);
    };
    el.firstElementChild.append(actions);
  }
  function moveShot(script, shots, from, to, focus) {
    if(panel.hidden || sourceSelect.value!==script.id || node(script.id)!==script || !canvasCanEdit() || nodeLocked(script))return;
    if(groupRun?.active && groupRun.board===B && groupRun.story?.scriptId===script.id){
      message.textContent="请等此分镜的批量生成结束后再排序";
      return;
    }
    const order=script.data.shots;
    if(order.length!==shots.length || shots.some((shot,i)=>shot!==order[i]))return refresh();
    if(from===to || !shots[from] || !shots[to])return;
    checkpoint();
    ensureScriptShotIds(script);
    const [shot]=order.splice(from,1);
    order.splice(to,0,shot);
    render(script);
    if(sel.size===1&&sel.has(script.id))showPanel();
    drawEdges();
    save();
    refresh();
    const edge=scriptTailEdges(), links=scriptShotLinks(script);
    const warnings=links.filter((_,i)=>scriptContinuityStatus(links,i,edge)?.warning).length;
    message.textContent=`已把第 ${from+1} 镜移到第 ${to+1} 镜${warnings?`，有 ${warnings} 处尾帧引用待核对`:""}`;
    const controls=$$("[data-shot-order]",list)[to];
    ($(`[data-step="${focus}"]:not(:disabled)`,controls) || $("button:not(:disabled)",controls))?.focus();
  }
  function shotOrderControls(el, script, shots, index) {
    const controls=document.createElement("div");
    controls.className="sl-shot-order";controls.dataset.shotOrder=String(index);
    const grip=document.createElement("span");
    grip.className="sl-sort-grip";grip.textContent="⠿";grip.title="拖动调整顺序";grip.draggable=true;grip.setAttribute("aria-hidden","true");
    controls.append(grip);
    for(const [step,label] of [[-1,"上移"],[1,"下移"]]){
      const move=document.createElement("button");
      move.type="button";move.className="pill";move.dataset.step=String(step);
      move.textContent=step<0?"↑":"↓";move.title=label;move.setAttribute("aria-label",`${label}第 ${index+1} 镜`);
      move.disabled=!shots[index+step];
      move.onclick=()=>moveShot(script,shots,index,index+step,step);
      controls.append(move);
    }
    el.append(controls);
    grip.ondragstart=event=>{
      dragged={script,shots,index};
      event.dataTransfer.setData("application/x-oneshot-shot-order",String(index));
      event.dataTransfer.effectAllowed="move";
    };
    grip.ondragend=()=>{
      dragged=null;
      for(const row of $$("[data-shot-drop]",list))row.removeAttribute("data-shot-drop");
    };
    const targetAt=event=>{
      const {top,height}=el.getBoundingClientRect(), after=event.clientY>=top+height/2;
      const insert=index+Number(after);
      return {after,to:insert-Number(insert>dragged.index)};
    };
    el.ondragover=event=>{
      if(dragged?.shots!==shots)return;
      event.preventDefault();
      event.dataTransfer.dropEffect="move";
      for(const row of $$("[data-shot-drop]",list))row.removeAttribute("data-shot-drop");
      el.dataset.shotDrop=targetAt(event).after?"after":"before";
    };
    el.ondragleave=event=>{if(!el.contains(event.relatedTarget))el.removeAttribute("data-shot-drop");};
    el.ondrop=event=>{
      if(dragged?.shots!==shots)return;
      event.preventDefault();
      const origin=dragged.index, {to}=targetAt(event);
      grip.ondragend();
      moveShot(script,shots,origin,to,-1);
    };
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
      openStoryFilm(target,start,end);
    };
    range.hidden=false;
  }
  async function refresh() {
    const request = ++epoch, board = boardId, target = node(sourceSelect.value);
    list.replaceChildren(); message.textContent = ""; film.disabled = true; film.onclick = null; range.hidden=true;
    add.hidden=target?.type!=="script" || !canvasCanEdit() || nodeLocked(target);
    run.hidden=add.hidden||!target.data.shots?.length;
    sort.hidden=run.hidden||target.data.shots.length<2;
    if(sort.hidden)sorting=false;
    sort.setAttribute("aria-pressed",String(sorting));
    sort.textContent=sorting?"完成排序":"排序";
    if (!target) { message.textContent = "添加原片或生成分镜后，可在这里查看镜头。"; return; }
    if (target.type === "script") {
      if(!target.data.shots?.length){message.textContent="分镜还没有镜头";return;}
      const connected = scriptShotLinks(target);
      const shots=target.data.shots.slice();
      const rows=shots.map((shot, i) => {
        const v = node(connected[i]?.vid);
        const el=row(`镜头 ${i + 1}`, [`${shot.duration || "—"} 秒`, ...(shot.characters || []),
          shot.asset_refs?.length?`${new Set(shot.asset_refs.map(asset=>asset.id)).size} 项参考资产`:"",
          v?.job ? "生成中" : curV(v) ? "已生成" : connected[i]?"待生成":"未展开"].filter(Boolean).join(" · "),
          () => locate(v || node(connected[i]?.img) || target),
          v?.versions.map((_, index) => [String(index), `版本 ${index + 1}`]) || [], String(v?.cur ?? ""),
          value => { if (switchVersion(v, +value)) locate(v); refresh(); },i,
          i>0&&connected[i-1]&&connected[i]?()=>openShotContinuityReview(target,i):null);
        if(connected[i]?.img)shotTailActions(el,target,shot,i);
        if(!sorting&&canvasCanEdit()&&!nodeLocked(target)){
          const edit=document.createElement("button");
          edit.type="button";edit.className="pill sl-edit-shot";edit.dataset.editShot=String(i);
          edit.textContent=OneShotI18n.t("编辑");edit.setAttribute("aria-label",`编辑第 ${i+1} 镜`);
          edit.onclick=()=>openShotEditor(target,target.data.shots.indexOf(shot),refresh);
          const media=document.createElement("button");
          media.type="button";media.className="pill sl-edit-shot";media.dataset.shotMedia=String(i);
          media.textContent="关联素材";media.setAttribute("aria-label",`关联第 ${i+1} 镜的素材`);
          media.onclick=()=>openShotMediaPicker(target,shot,refresh);
          el.firstElementChild.firstElementChild.after(edit,media);
        }
        if(sorting){
          const summary=shot.keyframe || shot.action?.[0] || shot.scene;
          if(summary){
            const text=document.createElement("span");
            text.className="sl-shot-summary";text.textContent=summary;el.firstElementChild.append(text);
          }
          shotOrderControls(el,target,shots,i);
        }
        return el;
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
  add.onclick=()=>{
    const script=node(sourceSelect.value);
    if(script?.type!=="script")return;
    const shots=script.data.shots||[], adjacent=shots.at(-1);
    openShotEditor(script,shots.length,refresh,{duration:5,shot_size:"中景",scene:adjacent?.scene,characters:adjacent?.characters});
  };
  sort.onclick=()=>{sorting=!sorting;dragged=null;refresh();};
  sourceSelect.onchange = ()=>{sorting=false;dragged=null;refresh();};
  panel.addEventListener("canvas-restored",()=>{if(!panel.hidden&&node(sourceSelect.value)?.type==="script")refresh();});
  panel.addEventListener("keydown", event => {
    event.stopPropagation();
    if(event.key==="Escape"){toggle(false);button.focus();return;}
    if(node(sourceSelect.value)?.type==="script" && canvasCanEdit() && (event.metaKey||event.ctrlKey) && event.key.toLowerCase()==="z"){
      event.preventDefault();
      if(event.shiftKey)redo();else undo();
      (sort.hidden?$("[data-close]",panel):sort).focus();
    }
  });
}
