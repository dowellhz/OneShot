"use strict";

const area = document.querySelector("#eventContent");
const statusLine = document.querySelector("#eventStatus");
const heading = document.querySelector("#eventTitle");
const eventId = location.pathname.split("/")[2];
const eventAPI = "/api/events" + (eventId ? "/"+eventId : "");
const labels = {upcoming:"尚未开放投稿",open:"开放投稿",closed:"投稿已截止 · 评审中",ended:"活动已结束",
  pending:"待审核",approved:"已通过",rejected:"已退回"};

function el(tag,text,className) {
  const node=document.createElement(tag);
  if(text)node.textContent=text;
  if(className)node.className=className;
  return node;
}
function link(text,href) {
  const result=el("a",text);
  result.href=href;
  return result;
}
function panel(title) {
  const section=el("section",null,"event-panel");
  section.append(el("h2",title));
  area.append(section);
  return section;
}
function dates(event) {
  return new Date(event.starts*1000).toLocaleString()+" 至 "+new Date(event.closes*1000).toLocaleString();
}
async function request(url,method="GET",body) {
  const data=body instanceof FormData ? {body} : body ? {headers:{"Content-Type":"application/json"},body:JSON.stringify(body)} : {};
  const result=await fetch(url,{method,...data});
  const value=await result.json().catch(()=>null);
  if(!result.ok)throw new Error(value?.error || "暂时无法读取活动信息");
  return value;
}
function action(form, method, url, makeBody, after) {
  form.onsubmit=async event=>{
    event.preventDefault();
    const buttons=[...form.querySelectorAll("button:not(:disabled)")];
    if(!buttons.length||event.submitter?.disabled)return;
    buttons.forEach(button=>button.disabled=true);
    try {
      await request(url,method,makeBody(new FormData(form),event.submitter));
      await after();
    } catch(error) { statusLine.textContent=error.message; }
    finally { buttons.forEach(button=>button.disabled=false); }
  };
}
function control(form,label,kind,name) {
  const field=el(kind), wrapper=el("label",label);
  field.name=name;
  wrapper.append(field);
  form.append(wrapper);
  return field;
}
function selectOptions(select,options) {
  for(const [value,text] of options)select.add(new Option(text,value));
}

function registrationForm(box) {
  const form=el("form");
  const note=control(form,"报名说明","textarea","note");
  note.maxLength=1000; note.required=true;
  form.append(el("button","提交报名"));
  box.append(form);
  action(form,"POST",eventAPI+"/registration",fields=>({note:fields.get("note")}),showEvent);
}

function entryForm(box,event,current,owner) {
  const active=current.entries.filter(entry=>entry.state!=="rejected"&&entry.publication_state!=="rejected");
  if(active.length>=event.slots) { box.append(el("p","已达到投稿上限")); return; }
  const used=new Set(active.map(entry=>entry.token));
  const choices=current.works.filter(work=>!used.has(work.token));
  if(choices.length) {
    const form=el("form");
    const video=control(form,"选择已发布作品","select","token");
    selectOptions(video,choices.map(work=>[work.token,work.title]));
    if(event.tracks.length)selectOptions(control(form,"赛道","select","track"),event.tracks.map(track=>[track,track]));
    form.append(el("button","提交作品"));
    box.append(form);
    action(form,"POST",eventAPI+"/entries",fields=>Object.fromEntries(fields),showEvent);
  }
  const publish=el("details",null,"event-publish");
  publish.append(el("summary","发布新作品并投稿"));
  box.append(publish);
  publish.ontoggle=async ()=>{
    if(!publish.open||publish.children.length>1)return;
    const hint=el("p","正在读取我的画布…");
    publish.append(hint);
    try {
      const boards=(await request("/api/boards")).filter(board=>board.owner===owner);
      hint.remove();
      if(boards.length)publishForm(publish,event,boards);
      else publish.append(el("p","请先创建一张自己的画布，再返回活动投稿。"),link("打开工作台","/"));
    } catch(error) {
      hint.remove();
      statusLine.textContent=error.message;
    }
  };
}

function publishForm(box,event,boards) {
  const form=el("form");
  const canvas=control(form,"来源画布","select","board");
  selectOptions(canvas,boards.map(board=>[board.id,board.name]));
  const refresh=el("button","刷新画布版本");
  refresh.type="button";
  form.append(refresh);
  const video=control(form,"成片来源","select","video");
  const upload=control(form,"视频文件","input","video_file");
  upload.type="file"; upload.accept="video/mp4,video/webm,video/quicktime";
  const title=control(form,"作品标题","input","title");
  title.required=true; title.maxLength=80;
  const description=control(form,"作品简介","textarea","description");
  description.maxLength=500;
  if(event.tracks.length)selectOptions(control(form,"投稿赛道","select","track"),event.tracks.map(track=>[track,track]));
  const confirmation=control(form,"确认提交审核，作品通过审核后可公开展示","input","confirmed");
  confirmation.type="checkbox"; confirmation.required=true;
  const message=el("p",null,"event-hint");
  message.setAttribute("role","status");
  const submit=el("button","发布并投稿");
  form.append(message,submit);
  box.append(form);
  let board, versions, pending=0;
  video.onchange=()=>{
    upload.required=video.value==="upload";
    upload.closest("label").hidden=!upload.required;
  };
  canvas.onchange=async ()=>{
    const attempt=++pending, id=canvas.value;
    refresh.disabled=true;
    submit.disabled=true;
    video.disabled=true;
    video.replaceChildren();
    upload.value="";
    video.onchange();
    message.textContent="正在读取画布版本…";
    try {
      const loaded=await request("/api/board/"+encodeURIComponent(id));
      if(attempt!==pending)return;
      if(loaded?.access!=="owner")throw new Error("请选择自己拥有的画布");
      board=loaded;
      versions=(board.nodes||[]).filter(node=>node.type==="video").flatMap(node=>(node.versions||[])
        .map((version,index)=>({node:node.id,ref:version.ref,current:index===node.cur,
          label:node.name+((node.versions||[]).length>1?" · 版本 "+(index+1):"")}))
        .filter(version=>version.ref));
      selectOptions(video,[...versions.map((version,index)=>[String(index),version.label]),["upload","从本地上传"]]);
      if(versions.length)video.value=String(Math.max(0,versions.findIndex(version=>version.current)));
      if(!title.value)title.value=(board.name||"").slice(0,80);
      message.textContent="";
      video.disabled=false;
      submit.disabled=false;
      video.onchange();
    } catch(error) {
      if(attempt===pending)message.textContent=error.message;
    } finally { if(attempt===pending)refresh.disabled=false; }
  };
  refresh.onclick=()=>void canvas.onchange();
  form.onsubmit=async e=>{
    e.preventDefault();
    if(submit.disabled)return;
    const data=new FormData(form), selected=versions[Number(video.value)];
    const payload={event:eventId,track:data.get("track")||"",title:data.get("title"),description:data.get("description"),
      revision:board.rev,confirmed:true,video:selected?{node:selected.node,ref:selected.ref}:null};
    const file=video.value==="upload"?upload.files[0]:null;
    if(file?.size>300000000) { message.textContent="成片最多 300 MB"; return; }
    let body=payload;
    if(file){
      body=new FormData();
      body.append("metadata",JSON.stringify(payload));
      body.append("video",file);
    }
    submit.disabled=canvas.disabled=refresh.disabled=true;
    message.textContent=file?"正在上传并投稿…":"正在检查作品并投稿…";
    try {
      await request("/api/board/"+encodeURIComponent(data.get("board"))+"/showcase","POST",body);
      await showEvent();
    } catch(error) { message.textContent=error.message; }
    finally { submit.disabled=canvas.disabled=refresh.disabled=false; }
  };
  void canvas.onchange();
}

function reviewForm(box,item,url) {
  const form=el("form");
  if(item.token)form.append(link(item.title,"/showcase/"+item.token));
  form.append(el("p",item.username+(item.track?" · "+item.track:"")));
  if(item.note)form.append(el("p",item.note));
  control(form,"退回原因","textarea","reason").maxLength=500;
  const actions=el("div",null,"event-review-actions");
  for(const [label,value] of [["通过","approved"],["退回","rejected"]]){
    const button=el("button",label);
    button.value=value;
    actions.append(button);
  }
  form.append(actions);
  box.append(form);
  action(form,"PATCH",url,(fields,button)=>({state:button.value,reason:fields.get("reason")}),showEvent);
}

function renderResults(results) {
  const box=panel("活动结果");
  const published=new Date(results.published*1000).toLocaleString();
  box.append(el("p","公布于 "+published,"event-dates"),el("p",results.summary));
  if(!results.awards.length)return;
  const list=el("ol",null,"event-result-list");
  for(const award of results.awards){
    const item=el("li");
    item.append(el("strong",award.label),link(award.title,"/showcase/"+award.token),
      document.createTextNode(" · "+award.author+(award.track?" · "+award.track:"")));
    list.append(item);
  }
  box.append(list);
}

async function manageResults() {
  const url="/api/admin/events/"+eventId+"/results";
  const {results,candidates,waiting,max_awards}=await request(url);
  const box=panel(results?"更新活动结果":"公布活动结果");
  if(waiting.total){
    box.append(el("p","还有 "+waiting.total+" 件作品待审核"));
    if(waiting.showcase)box.append(link("去处理展映审核（"+waiting.showcase+"）","/showcase?review=1"));
    return;
  }
  const form=el("form");
  const summary=control(form,"结果公告","textarea","summary");
  summary.required=true; summary.maxLength=3000; summary.rows=4; summary.value=results?.summary||"";
  const rows=el("div",null,"event-award-rows");
  const add=el("button","添加获奖作品");
  add.type="button";
  const syncAdd=()=>{ add.disabled=rows.children.length>=Math.min(max_awards,candidates.length); };
  const options=candidates.map(work=>[work.token,work.title+(work.track?" · "+work.track:"")]);
  const appendAward=(award={})=>{
    const row=el("div",null,"event-award-row");
    const label=control(row,"奖项名称","input","label");
    label.required=true; label.maxLength=80; label.value=award.label||"";
    const token=control(row,"获奖作品","select","token");
    selectOptions(token,[["","请选择作品"],...options]);
    token.required=true; token.value=award.token||"";
    const remove=el("button","移除奖项");
    remove.type="button";
    remove.onclick=()=>{ row.remove(); syncAdd(); };
    row.append(remove);
    rows.append(row);
    syncAdd();
    return label;
  };
  for(const award of results?.awards||[])appendAward(award);
  syncAdd();
  add.onclick=()=>appendAward().focus();
  form.append(rows);
  if(candidates.length)form.append(add);
  const confirm=control(form,"确认在活动页公开结果","input","confirm");
  confirm.type="checkbox"; confirm.required=true;
  confirm.closest("label").className="event-result-confirm";
  form.append(el("button",results?"发布更正":"公开结果"));
  box.append(form);
  action(form,"PUT",url,fields=>{
    const labels=fields.getAll("label");
    return {summary:fields.get("summary"),revision:results?.revision||0,confirmed:confirm.checked,
      awards:fields.getAll("token").map((token,index)=>({token,label:labels[index]}))};
  },showEvent);
}

async function showEvent() {
  const [event,identity]=await Promise.all([request(eventAPI),request("/api/auth/state")]);
  heading.textContent=event.title;
  area.replaceChildren();
  statusLine.textContent="";
  const rules=panel(labels[event.state]);
  rules.append(el("p",dates(event),"event-dates"),el("p",event.brief),el("p",event.rules));
  rules.append(el("p","每位创作者最多提交 "+event.slots+" 件作品"+(event.registration?" · 需要报名审核":"")));
  if(event.tracks.length)rules.append(el("p","赛道　"+event.tracks.join("、")));
  if(event.min_seconds||event.max_seconds)rules.append(el("p",[
    event.min_seconds&&"最短 "+event.min_seconds+" 秒",event.max_seconds&&"最长 "+event.max_seconds+" 秒"].filter(Boolean).join(" · ")));
  for(const [title,info] of [["评审标准",event.judging?.criteria],["奖项与奖品",event.judging?.prizes]]){
    if(info)rules.append(el("h3",title),el("p",info));
  }
  if(event.results)renderResults(event.results);
  if(event.entries.length){
    const list=el("ul");
    for(const item of event.entries){
      const row=el("li");
      row.append(link(item.title,"/showcase/"+item.token),document.createTextNode(" · "+item.author+(item.track?" · "+item.track:"")));
      list.append(row);
    }
    panel("已入选作品").append(list);
  }
  const accepting=event.state==="open"||event.state==="upcoming";
  if(!identity.user) {
    if(accepting)panel("参与活动").append(link("登录后参与","/login?next="+encodeURIComponent(location.pathname)));
    return;
  }
  const current=await request(eventAPI+"/me");
  const own=panel("我的参与");
  const status=current.registration?.state;
  if(event.registration){
    own.append(el("p",status?"报名 · "+labels[status]:"尚未报名"));
    if(current.registration?.reason)own.append(el("p",current.registration.reason));
    if(accepting && (!status||status==="rejected"))registrationForm(own);
  }
  if(current.entries.length){
    const entries=el("ul");
    const awards=new Map((event.results?.awards||[]).map(award=>[award.token,award.label]));
    for(const entry of current.entries){
      const publication=entry.publication_state==="rejected" ? "展映审核退回" :
        entry.state==="pending"&&entry.publication_state==="pending" ? "等待展映审核" : "";
      const reason=entry.publication_reason||entry.reason;
      entries.append(el("li",entry.title+" · "+(awards.get(entry.token)||publication||labels[entry.state])+(reason?" · "+reason:"")));
    }
    own.append(entries);
  }
  if(event.state==="open" && (!event.registration||status==="approved"))entryForm(own,event,current,identity.user.id);
  else if(event.state==="upcoming")own.append(el("p","投稿尚未开放"));
  else if(!accepting)own.append(el("p",labels[event.state]));
  if(identity.user.role!=="admin")return;
  const queue=await request("/api/admin/events/"+eventId);
  const review=panel("待审核");
  if(!queue.registrations.length&&!queue.entries.length)review.append(el("p","暂无待审核记录"));
  for(const item of queue.registrations)reviewForm(review,item,"/api/admin/events/"+eventId+"/registration/"+item.owner);
  for(const item of queue.entries)reviewForm(review,item,"/api/admin/events/"+eventId+"/entries/"+item.token);
  if(!accepting)await manageResults();
}

async function showList() {
  const [items,identity]=await Promise.all([request(eventAPI),request("/api/auth/state")]);
  area.className="event-list";
  for(const event of items){
    const article=el("article",null,"event-card"), h=el("h2");
    h.append(link(event.title,"/events/"+event.id));
    article.append(h,el("p",labels[event.state],"event-hint"),el("p",dates(event),"event-dates"),el("p",event.brief));
    area.append(article);
  }
  statusLine.textContent=items.length?"":"暂无创作活动";
  if(identity.user?.role!=="admin")return;
  const form=document.querySelector("#eventCreate");
  form.hidden=false;
  form.onsubmit=async e=>{
    e.preventDefault();
    const button=form.querySelector("button");
    if(button.disabled)return;
    button.disabled=true;
    try{
      const body=Object.fromEntries(new FormData(form));
      Object.assign(body,{starts:new Date(body.starts).getTime()/1000,closes:new Date(body.closes).getTime()/1000,
        slots:Number(body.slots),registration:body.registration==="on",tracks:body.tracks.split("\n").map(x=>x.trim()).filter(Boolean),
        min_seconds:body.min_seconds?Number(body.min_seconds):null,max_seconds:body.max_seconds?Number(body.max_seconds):null});
      const event=await request("/api/admin/events","POST",body);
      location.assign("/events/"+event.id);
    }catch(error) { statusLine.textContent=error.message; }
    finally { button.disabled=false; }
  };
}
(eventId?showEvent():showList()).catch(error=>{statusLine.textContent=error.message;});
