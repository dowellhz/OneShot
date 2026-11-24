"use strict";

const CC = {board:null, threads:[], selected:new Set(), epoch:0, reply:null, anchor:null, pointer:null, request:null, busy:false};
const ccPath = (id=boardId) => "/api/board/" + encodeURIComponent(id) + "/comments";
function ccAnchorLabel(anchor) {
  if (!anchor) return "整张画布";
  const name=anchor.name || "画布标注";
  if (anchor.passage) return name+" · 文本选区";
  if (anchor.box) return name+" · 图片区域";
  if (!Number.isFinite(anchor.at)) return name;
  const end = Number.isFinite(anchor.end) ? `–${anchor.end.toFixed(2)}` : "";
  return `${name} · ${anchor.at.toFixed(2)}${end} 秒`;
}

async function ccLoad(silent=false) {
  const bid = boardId, epoch = ++CC.epoch;
  try {
    const data = await boardRequest(ccPath(bid));
    if (boardId !== bid || CC.epoch !== epoch) return;
    CC.threads = Array.isArray(data) ? data : [];
    if (!silent) $("#ccError").textContent = "";
    ccRender();
    return true;
  } catch (error) {
    if (!silent && boardId === bid && CC.epoch === epoch) $("#ccError").textContent = error.message || "评论暂时无法读取";
    return false;
  }
}

function ccRender() {
  const filter = $("#ccFilter").value;
  const threads = CC.threads.filter(t => filter === "all" || t.resolved === (filter === "resolved"));
  const message = m => `<div class="cc-message"><b>${esc(m.author)}</b><time>${esc(new Date(m.created * 1000).toLocaleString())}</time><p>${esc(m.body)}</p></div>`;
  const list = $("#ccList");
  const content = threads.map(t => `<article data-thread="${esc(t.id)}">
    <header><input type="checkbox" data-cc-select="${esc(t.id)}" aria-label="${esc("选中审阅评论："+t.body.slice(0,40))}">
    ${t.anchor ? `<button type="button" data-cc-locate="${esc(t.id)}">${esc(ccAnchorLabel(t.anchor))}</button>` : "<span>整张画布</span>"}
    <span>${t.resolved ? "已解决" : "待处理"}</span></header>
    ${t.anchor?.passage ? `<blockquote class="cc-quote">${esc(t.anchor.passage.quote)}</blockquote>` : ""}
    ${message(t)}${t.replies.map(r=>`<div class="cc-reply">${message(r)}</div>`).join("")}
    <footer>${t.anchor?.ref ? `<button type="button" data-cc-version="${esc(t.id)}">${t.anchor.box ? "查看标记区域" : Number.isFinite(t.anchor.end) ? "查看批注片段" : "查看当时版本"}</button>` : ""}
    ${t.anchor?.passage ? t.passage_location ? `<button type="button" data-cc-passage="${esc(t.id)}">查看批注原文</button>` : '<span class="cc-stale">原文已变更</span>' : ""}
    <button type="button" data-cc-agent="${esc(t.id)}">带到助手</button>
    ${!t.resolved ? `<button type="button" data-cc-reply="${esc(t.id)}">回复</button>` : ""}
    ${t.can_resolve ? `<button type="button" data-cc-toggle="${esc(t.id)}">${t.resolved ? "重新打开" : "标为已解决"}</button>` : ""}</footer></article>`).join("")
    || "<p class='cc-empty'>没有符合条件的评论。</p>";
  if (list._content !== content) { list._content = content; list.innerHTML = content; }
  const known = new Set(CC.threads.map(t=>t.id));
  for(const id of CC.selected)if(!known.has(id))CC.selected.delete(id);
  for(const input of $$("[data-cc-select]",list))input.checked=CC.selected.has(input.dataset.ccSelect);
  ccRenderBatch();
  const pins = $("#commentPins");
  const pinMarkup = CC.threads.filter(t=>!t.resolved && t.anchor && Number.isFinite(t.anchor.x) && Number.isFinite(t.anchor.y))
    .map(t=>`<button type="button" data-cc-pin="${esc(t.id)}" style="left:${t.anchor.x}px;top:${t.anchor.y}px" aria-label="查看画布标注：${esc(t.author)}">${ico("comment")}</button>`).join("");
  if (pins._content !== pinMarkup) { pins._content = pinMarkup; pins.innerHTML = pinMarkup; }
}

function ccRenderBatch() {
  const header=$("#ccBatch");
  header.hidden=!CC.selected.size;
  $("[data-cc-batch-send]",header).textContent=`带到助手（${CC.selected.size}）`;
}

function ccShow() {
  if (!B) return;
  $("#shotList [data-close]")?.click();
  if (AC.open) $("#acClose").click();
  $("#canvasComments").hidden = false;
  $("#commentBtn").setAttribute("aria-expanded", "true");
}

async function ccOpenReview(id) {
  const bid = boardId;
  ccShow();
  $("#ccFilter").value = "all";
  ccRender(); await ccLoad();
  if (bid === boardId) $$("#ccList [data-thread]").find(item => item.dataset.thread === id)?.scrollIntoView?.({block:"nearest"});
}

function ccTarget(anchor=null, reply=null, focus=true) {
  if (CC.busy) return;
  if (focus) ccShow();
  CC.anchor = anchor; CC.reply = reply;
  $("#ccTarget").textContent = reply ? "回复 " + reply.author : ccAnchorLabel(anchor);
  $("#ccUntarget").hidden = !anchor && !reply;
  $("#ccQuote").textContent = anchor?.passage?.quote || "";
  $("#ccQuote").hidden = !anchor?.passage;
  if (focus) $("#ccBody").focus();
}
function ccNode(n, version=curV(n), at, end, box) {
  const time = Number.isFinite(at) ? {at,...(Number.isFinite(end)?{end}:{})} : {};
  ccTarget({node:n.id,name:n.name,ref:version?.ref||null,...time,...(box?{box}:{})});
  ccLoad();
}
function ccTextPassage(n,passage) {
  ccTarget({node:n.id,name:n.name,passage});
  ccLoad();
}
function ccPoint(point) {
  ccTarget(point);
  ccLoad();
}
function ccShortcut() {
  if (document.querySelector("#assetLibrary:not([hidden]), #imageEditor.on, #videoRemake")) return;
  const p = CC.pointer || {x:innerWidth/2,y:innerHeight/2};
  ccPoint(toW(p.x,p.y));
}

function ccLocate(thread) {
  const a = thread.anchor;
  if (a.node) {
    const n = vtResolve(a.node, a.ref)?.node || node(a.node);
    if (!n) return toast("评论对应的节点已移除");
    selectOnly(n.id); fit([n]);
  } else {
    B.view.x = innerWidth / 2 - a.x * B.view.k;
    B.view.y = innerHeight / 2 - a.y * B.view.k;
    applyView(); save();
  }
}

async function ccSend(e) {
  e.preventDefault();
  if (CC.busy) return;
  const bid = boardId, input = $("#ccBody"), body = input.value.trim();
  if (!body) return;
  const data = {body, anchor:CC.anchor, thread_id:CC.reply?.id || null};
  const key = JSON.stringify([bid,data]);
  if (CC.request?.key !== key) CC.request = {key, id:crypto.randomUUID?.() || "comment-" + Date.now() + Math.random().toString(36).slice(2)};
  const requestKey = CC.request.id;
  CC.busy = true; $("#ccSend").disabled = true;
  try {
    if (CC.anchor?.node) await flushSave();
    if (boardId !== bid) return;
    await boardRequest(ccPath(bid), "POST", {...data,request_key:requestKey});
    if (boardId !== bid) return;
    CC.request = null;
    if (input.value.trim() === body) input.value = "";
    CC.busy = false;
    ccTarget(null, null, false);
    $("#ccFilter").value = "open";
    await ccLoad();
  } catch (error) {
    if (boardId === bid) $("#ccError").textContent = error.message || "评论发送失败";
  } finally { CC.busy = false; $("#ccSend").disabled = false; }
}

function ccBoardChanged() {
  CC.board = boardId; CC.anchor = CC.reply = CC.request = CC.pointer = null; CC.threads = [];
  CC.selected.clear();
  $("#ccBody").value = ""; $("#ccError").textContent = ""; $("#ccTarget").textContent = "整张画布";
  $("#ccUntarget").hidden = true;
  $("#ccQuote").hidden = true;$("#ccQuote").textContent = "";
  ccRender(); ccLoad();
}

function initCanvasComments() {
  document.body.insertAdjacentHTML("beforeend", OneShotI18n.html`<section id="canvasComments" aria-labelledby="ccTitle" hidden>
    <header><strong id="ccTitle">评论</strong><select id="ccFilter" aria-label="过滤评论"><option value="open">待处理</option><option value="resolved">已解决</option><option value="all">全部</option></select>
      <button type="button" id="ccClose" aria-label="收起评论">×</button></header>
    <div id="ccBatch" hidden><button type="button" data-cc-batch-send>带到助手</button><button type="button" data-cc-batch-clear>取消选择</button></div>
    <div id="ccList"></div>
    <form><div class="cc-compose-label"><span id="ccTarget">整张画布</span><button type="button" id="ccUntarget" hidden>取消定位</button></div>
      <blockquote id="ccQuote" class="cc-quote" hidden></blockquote>
      <textarea id="ccBody" aria-label="评论内容" placeholder="写评论。也可在画布上按 C 标注位置。" maxlength="2000" required></textarea>
      <div id="ccError" role="alert"></div><button type="submit" id="ccSend">发送评论</button>
    </form>
  </section>`);
  world.insertAdjacentHTML("beforeend", '<div id="commentPins"></div>');
  $("#commentBtn").onclick = () => {
    if (!$("#canvasComments").hidden) { $("#ccClose").click(); return; }
    ccShow(); ccLoad();
  };
  $("#ccClose").onclick = () => { $("#canvasComments").hidden = true; $("#commentBtn").setAttribute("aria-expanded","false"); };
  $("#ccFilter").onchange = ccRender;
  $("#ccUntarget").onclick = () => ccTarget();
  $("#canvasComments form").onsubmit = ccSend;
  $("#canvasComments").onkeydown = e => {
    e.stopPropagation();
    if (e.key === "Escape") $("#ccClose").click();
  };
  $("#ccList").onchange = e => {
    const input=e.target.closest("[data-cc-select]");
    if (!input) return;
    const id=input.dataset.ccSelect;
    if (input.checked && !CC.selected.has(id) && CC.selected.size >= AC_REVIEW_LIMIT) {
      input.checked=false;toast(`每条消息最多引用 ${AC_REVIEW_LIMIT} 条审阅评论`);return;
    }
    if (input.checked) CC.selected.add(id); else CC.selected.delete(id);
    ccRenderBatch();
  };
  $("[data-cc-batch-clear]").onclick=()=>{CC.selected.clear();ccRender();};
  $("[data-cc-batch-send]").onclick=boardAction(async e=>{
    const button=e.currentTarget, bid=boardId, selected=CC.selected;
    const threads=[...selected].map(id=>CC.threads.find(t=>t.id===id)).filter(Boolean);
    if(!threads.length)return;
    button.disabled=true;
    try {
      if(await acAttachReviews(threads) && boardId===bid) {
        for(const thread of threads)selected.delete(thread.id);
        ccRender();
        $("#ccClose").click();
      }
    } finally { button.disabled=false; }
  });
  $("#ccList").onclick = boardAction(async e => {
    const button = e.target.closest("button");
    if (!button) return;
    const id = button.dataset.ccLocate || button.dataset.ccReply || button.dataset.ccToggle || button.dataset.ccVersion || button.dataset.ccPassage || button.dataset.ccAgent;
    const t = CC.threads.find(x=>x.id === id);
    if (!t) return;
    if (button.dataset.ccLocate) ccLocate(t);
    if (button.dataset.ccPassage) {
      const bid=boardId;
      await flushSave();
      if (boardId!==bid || !await ccLoad(true)) return;
      const latest=CC.threads.find(item=>item.id===id);
      const target=latest?.anchor?.node && node(latest.anchor.node);
      if (!target || !latest.passage_location) return toast("批注原文已变更，可在评论中查看已保存的引用");
      openTextDocument(target,{location:latest.passage_location,quote:latest.anchor.passage.quote});
    }
    if (button.dataset.ccVersion) {
      const target = vtResolve(t.anchor.node, t.anchor.ref);
      const v = target?.node.versions[target.index];
      if (!v) return toast("评论对应的素材版本已移除");
      $("#ccClose").click(); lightbox(v,target.node,t.anchor);
    }
    if (button.dataset.ccReply) ccTarget(null, t);
    if (button.dataset.ccAgent && await acAttachReview(t)) $("#ccClose").click();
    if (button.dataset.ccToggle) {
      button.disabled = true;
      try { await boardRequest(ccPath() + "/" + encodeURIComponent(t.id),"PATCH",{resolved:!t.resolved}); await ccLoad(); }
      finally { button.disabled = false; }
    }
  });
  const pins = $("#commentPins");
  pins.onpointerdown = e => e.stopPropagation();
  pins.onclick = e => {
    const button=e.target.closest("[data-cc-pin]");
    if (!button) return;
    ccShow(); $("#ccFilter").value="open"; ccRender();
    $$("#ccList [data-thread]").find(item => item.dataset.thread === button.dataset.ccPin)?.scrollIntoView?.({block:"nearest"});
  };
  vp.addEventListener("pointermove", e=>{ CC.pointer={x:e.clientX,y:e.clientY}; });
  setInterval(()=>{
    if (B && !document.hidden && !$("#canvasComments").hidden && (!liveCanvas?.commentsVersion || liveCanvas.error)) ccLoad();
  }, 5500);
}
