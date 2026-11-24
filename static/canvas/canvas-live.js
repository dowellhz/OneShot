"use strict";

let liveCanvas=null;
const LIVE_CURSOR_COLORS=["#ac98ca","#8da9c5","#c3a17d","#c695a1","#a9ad81"];
const liveCursorElements=new Map();
const livePath=bid=>"/api/board/"+encodeURIComponent(bid)+"/live";
const livePresenter=state=>state?.people.find(p=>p.id!==state.self&&p.presenting);

function liveSaveView(board) {
  return liveCanvas?.bid===boardId && board===B && liveCanvas.beforeFollow ? liveCanvas.beforeFollow : board.view;
}
const liveBoardData=board=>({...board,view:liveSaveView(board)});

function liveDrawCursors() {
  const state=liveCanvas, overlay=$("#liveCursors"), visible=new Set();
  if(!overlay)return;
  if(state?.bid===boardId && !state.error && !document.hidden) {
    const view=B.view;
    for(const person of state.people) {
      if(person.id===state.self || !person.cursor)continue;
      const x=person.cursor.x*view.k+view.x,y=person.cursor.y*view.k+view.y;
      if(x<0||y<0||x>=innerWidth||y>=innerHeight)continue;
      visible.add(person.id);
      let cursor=liveCursorElements.get(person.id);
      if(!cursor){
        cursor=document.createElement("div");cursor.className="live-cursor";
        const color=[...person.id].reduce((sum,ch)=>sum+ch.charCodeAt(0),0)%LIVE_CURSOR_COLORS.length;
        cursor.style.setProperty("--live-cursor",LIVE_CURSOR_COLORS[color]);
        cursor.append(document.createElement("span"));overlay.append(cursor);
        liveCursorElements.set(person.id,cursor);
      }
      cursor.firstChild.textContent=person.name;
      cursor.style.transform=`translate(${x}px,${y}px)`;
    }
  }
  for(const [id,cursor] of liveCursorElements)if(!visible.has(id)){cursor.remove();liveCursorElements.delete(id);}
}

function liveRecordPointer(event) {
  if(!liveCanvas?.shareCursor)return;
  const target=event?.target;
  const point=target?.closest?.("#vp")&&!target.closest("textarea,input,select,[contenteditable=true]")?
    toW(event.clientX,event.clientY):null;
  const prior=liveCanvas.cursor;
  if(prior?.x===point?.x&&prior?.y===point?.y)return;
  liveCanvas.cursor=point;liveCanvas.cursorDirty=true;
}

function liveStopFollow(restore=true) {
  const state=liveCanvas;
  if(!state?.following)return;
  const view=state.beforeFollow;
  state.following=null;state.beforeFollow=null;
  if(restore && state.bid===boardId && B){B.view=view;applyView();}
  liveRender();
}

function liveApplyFollow(state) {
  if(!state.following)return;
  const person=state.people.find(p=>p.id===state.following);
  if(!person){liveStopFollow();return;}
  const {cx,cy,k}=person.view;
  B.view={x:innerWidth/2-cx*k,y:innerHeight/2-cy*k,k};
  applyView();
}

function liveFollow(id) {
  const state=liveCanvas;
  if(!state?.people.some(p=>p.id===id&&id!==state.self))return;
  if(!state.beforeFollow)state.beforeFollow={...B.view};
  state.following=id;
  // Leave presentation mode while looking through another person's view.
  state.presenting=false;
  liveApplyFollow(state);liveRender();void livePulse();
}

function liveRender() {
  const state=liveCanvas, join=$("#liveJoin"), leave=$("#liveLeave"), present=$("#livePresent"), badge=$("#liveBadge");
  if(!join)return;
  const active=!!state&&state.bid===boardId;
  join.hidden=active;leave.hidden=present.hidden=badge.hidden=!active;
  $("#livePointerSettings").hidden=!active;
  liveDrawCursors();
  const list=$("#livePeople");
  if(!active){
    list._items="";list.replaceChildren();
    $("#liveNote").textContent="加入后，在线协作者可以看到你的画布光标并跟随视角。";
    return;
  }
  present.textContent=state.presenting?"结束演示":"邀请跟随";
  present.setAttribute("aria-pressed",String(state.presenting));
  const followed=state.people.find(p=>p.id===state.following);
  const speaker=state.presenting?null:livePresenter(state);
  badge.textContent=followed?"停止跟随 · "+followed.name:state.presenting?"正在演示":speaker?"跟随 "+speaker.name:"协作 "+state.people.length;
  badge.title=followed?"停止跟随":speaker?speaker.name+" 正在演示，点击跟随":"查看协作成员";
  $("#liveNote").textContent=state.error?"协作连接中断，正在重连":state.people.length>1?"可选择任一协作者跟随":state.self?"等待其他成员加入":"正在加入协作…";
  const items=state.people.map(p=>`<li><span>${esc(p.name)}${p.id===state.self?"（你）":""}${p.presenting?" · 正在演示":""}</span>${
    p.id===state.self?"":`<button type="button" data-live-follow="${esc(p.id)}">${p.id===state.following?"停止跟随":"跟随"}</button>`}</li>`).join("");
  if(list._items!==items){list._items=items;list.innerHTML=items;}
}

async function liveSyncComments(state, version) {
  if (typeof version !== "string" || state.commentsVersion === version || state.loadingComments ||
      performance.now() < (state.retryCommentsAt || 0)) return;
  state.loadingComments = true;
  try {
    if (await ccLoad(true)) state.commentsVersion = version;
    else state.retryCommentsAt = performance.now() + 2000;
  } finally {
    state.loadingComments = false;
  }
}

async function livePulse() {
  const state=liveCanvas;
  if(!state || state.busy || state.bid!==boardId || !B)return;
  const view=liveSaveView(B), k=view.k;
  const payload={tab:state.tab,presenting:state.presenting,cursor:state.shareCursor?state.cursor:null,
    view:{cx:(innerWidth/2-view.x)/k,cy:(innerHeight/2-view.y)/k,k}};
  state.busy=true;state.lastPulse=performance.now();state.cursorDirty=false;
  try{
    const response=await fetch(livePath(state.bid),{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
    if(liveCanvas!==state){liveDisconnect(state);return;}
    if([401,403,404].includes(response.status)){
      liveLeave();toast("当前账号已无法访问此画布的协作会话");return;
    }
    if(!response.ok)throw new Error("协作请求失败");
    const result=await response.json();
    if(liveCanvas!==state){liveDisconnect(state);return;}
    state.people=result.participants;state.self=result.self;state.error=false;
    liveApplyFollow(state);liveRender();
    void liveSyncComments(state,result.comments_version);
    if(!state.syncing&&result.rev>(B.rev||0)){
      state.syncing=true;
      void acSyncBoard(result.rev,true).catch(()=>{}).finally(()=>state.syncing=false);
    }
  }catch{
    if(liveCanvas===state){state.error=true;liveRender();}
  }finally{
    state.busy=false;
    if(liveCanvas===state&&document.hidden&&state.cursorDirty)void livePulse();
  }
}

function liveDisconnect(state) {
  void fetch(livePath(state.bid)+"?tab="+encodeURIComponent(state.tab),{method:"DELETE",keepalive:true}).catch(()=>{});
}

function liveLeave() {
  if(!liveCanvas)return;
  liveStopFollow();
  const state=liveCanvas;
  liveCanvas=null;
  liveDisconnect(state);liveRender();
}

function initCanvasLive() {
  $("#canvasShare .share-link").insertAdjacentHTML("afterend",`<section id="canvasLive" aria-labelledby="liveTitle">
    <h3 id="liveTitle">一起看画布</h3><p id="liveNote" role="status"></p>
    <div class="live-actions"><button type="button" id="liveJoin">加入协作</button><button type="button" id="livePresent" hidden>邀请跟随</button>
      <button type="button" id="liveLeave" hidden>离开协作</button></div>
    <label id="livePointerSettings" hidden><input type="checkbox" id="liveSharePointer">共享我的光标</label>
    <ul id="livePeople" aria-label="在线协作者"></ul></section>`);
  $("#shareBtn").insertAdjacentHTML("afterend",'<button type="button" id="liveBadge" hidden></button>');
  vp.insertAdjacentHTML("beforeend",'<div id="liveCursors" aria-hidden="true"></div>');
  $("#liveJoin").onclick=()=>{
    if(liveCanvas||!B)return;
    liveCanvas={bid:boardId,tab:crypto.randomUUID?.()||"tab-"+Date.now()+"-"+Math.random().toString(36).slice(2),
      people:[],presenting:false,shareCursor:true,cursor:null};
    $("#liveSharePointer").checked=true;
    liveRender();void livePulse();
  };
  $("#liveLeave").onclick=liveLeave;
  $("#liveSharePointer").onchange=event=>{
    if(!liveCanvas)return;
    liveCanvas.shareCursor=event.target.checked;
    liveCanvas.cursor=null;liveCanvas.cursorDirty=true;
    void livePulse();
  };
  $("#livePresent").onclick=()=>{
    if(!liveCanvas)return;
    liveStopFollow(false);
    liveCanvas.presenting=!liveCanvas.presenting;liveRender();void livePulse();
  };
  $("#liveBadge").onclick=()=>{
    if(liveCanvas?.following)liveStopFollow();
    else if(!liveCanvas?.presenting && livePresenter(liveCanvas))liveFollow(livePresenter(liveCanvas).id);
    else if($("#canvasShare").hidden)shareOpen();
  };
  $("#livePeople").onclick=event=>{
    const id=event.target.closest("[data-live-follow]")?.dataset.liveFollow;
    if(!id)return;
    if(liveCanvas?.following===id)liveStopFollow();
    else liveFollow(id);
  };
  setInterval(()=>{
    const state=liveCanvas;
    if(!state||document.hidden)return;
    const active=state.people.length>1;
    const delay=active?(state.cursorDirty?180:360):1400;
    if(performance.now()-(state.lastPulse??-Infinity)>=delay)void livePulse();
  },120);
  addEventListener("pointermove",liveRecordPointer,{passive:true});
  vp.addEventListener("pointerleave",()=>liveRecordPointer(null));
  addEventListener("blur",()=>liveRecordPointer(null));
  addEventListener("pagehide",()=>{if(liveCanvas)liveDisconnect(liveCanvas);});
  addEventListener("pageshow",livePulse);
  document.addEventListener("visibilitychange",()=>{
    if(document.hidden){liveRecordPointer(null);liveDrawCursors();}
    void livePulse();
  });
  liveRender();
}
