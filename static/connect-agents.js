"use strict";

const endpoint="/api/connector/tokens";
const byId=id=>document.getElementById(id);
const statusLine=byId("connectorStatus");
const secret=byId("connectorSecret"), token=byId("connectorToken");
const url=byId("connectorUrl"), handoff=byId("connectorHandoff");
const board=new URLSearchParams(location.search).get("board");
const canvas=board && /^[A-Za-z0-9_-]{1,40}$/.test(board) ? "/?board="+encodeURIComponent(board) : "/";
byId("connectorBack").href=canvas;
url.value=new URL("/mcp",location.origin).href;
handoff.value=(canvas!=="/"?"在 OneShot 的画布 "+new URL(canvas,location.origin).href+" 继续。":"先列出我拥有的 OneShot 画布，等我选择。")+
  "请确认 MCP 连接可用，再提出可选的创作方向。生成前先跟我确认内容和数量；发起任务后把 OneShot 确认链接发给我。";

async function request(path,method="GET",data) {
  const response=await fetch(path,{method,...(data?{headers:{"Content-Type":"application/json"},body:JSON.stringify(data)}:{})});
  if(response.status===401){
    location.href="/login?next="+encodeURIComponent(location.pathname+location.search);
    throw new Error("请先登录");
  }
  const value=await response.json().catch(()=>null);
  if(!response.ok)throw new Error(value?.error||"暂时无法读取连接");
  return value;
}

async function loadTokens() {
  const rows=await request(endpoint);
  byId("connectorList").replaceChildren(...rows.map(row=>{
    const item=document.createElement("li"), label=document.createElement("span"), revoke=document.createElement("button");
    label.textContent=row.label+(row.oauth?" · 浏览器授权":"")+" · "+new Date(row.expires*1000).toLocaleDateString()+" 到期";
    revoke.textContent="撤销";
    revoke.setAttribute("aria-label","撤销 "+row.label);
    revoke.onclick=async ()=>{
      revoke.disabled=true;
      try {
        await request(endpoint+"/"+row.id,"DELETE");
        if(token.dataset.id===row.id) { token.value=""; secret.hidden=true; }
        statusLine.textContent="连接已撤销";
        await loadTokens();
      } catch(error) { statusLine.textContent=error.message; }
      finally { revoke.disabled=false; }
    };
    item.append(label,revoke);
    return item;
  }));
}

const form=byId("connectorCreate");
form.onsubmit=async event=>{
  event.preventDefault();
  const submit=form.querySelector("button");
  if(submit.disabled)return;
  submit.disabled=true;
  try {
    const result=await request(endpoint,"POST",{label:new FormData(form).get("label")});
    token.value="Authorization: Bearer "+result.token;
    token.dataset.id=result.id;
    secret.hidden=false;
    form.reset();
    token.focus();
    token.select();
    statusLine.textContent="连接令牌已生成";
    await loadTokens();
  } catch(error) { statusLine.textContent=error.message; }
  finally { submit.disabled=false; }
};
for(const [id,input] of [["connectorCopyUrl",url],["connectorCopyToken",token],["connectorCopyHandoff",handoff]]){
  byId(id).onclick=async ()=>{
    try { await navigator.clipboard.writeText(input.value); statusLine.textContent="已复制"; }
    catch { input.focus(); input.select(); statusLine.textContent="已选中内容，可以手动复制"; }
  };
}
loadTokens().catch(error=>{statusLine.textContent=error.message;});
fetch("/.well-known/oauth-protected-resource/mcp").then(response=>{
  byId("connectorOAuth").hidden=!response.ok;
}).catch(()=>{});
