"use strict";

const content = document.querySelector("#showcaseContent");
const statusLine = document.querySelector("#showcaseStatus");
const title = document.querySelector("#showcaseTitle");
const search = document.querySelector("#showcaseSearch");
const more = document.querySelector("#showcaseMore");
const [, , segment, creator] = location.pathname.split("/");
const token = creator ? "" : segment;
const params = new URLSearchParams(location.search);
const reviewMode = !segment && params.get("review") === "1";
const mine = !segment && !reviewMode && params.get("mine") === "1";
let page = 0;
let request = 0;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function link(text, href) {
  const anchor = element("a",text);
  anchor.href = href;
  return anchor;
}

async function loadJSON(url, options) {
  const result = await fetch(url,options);
  if (!result.ok) {
    const fallback = {403:"需要管理员权限",401:"请先登录",404:"作品已撤回或不存在"};
    const detail = await result.json().catch(()=>null);
    throw new Error(detail?.error || fallback[result.status] || "请求失败，请重试");
  }
  return result.json();
}

function workMedia(item, prefix) {
  if (item.media_kind==="gif") {
    const image = element("img");
    image.src = prefix + "/" + item.token + "/gif";
    image.alt = item.title;
    image.decoding = "async";
    if (prefix==="/api/admin/showcase") image.loading = "lazy";
    return image;
  }
  const player = element("video");
  player.controls = true;
  player.playsInline = true;
  player.preload = "none";
  player.poster = prefix + "/" + item.token + "/cover";
  player.src = prefix + "/" + item.token + "/video";
  return player;
}

function card(item) {
  const article = element("article",null,"showcase-card");
  const url = "/showcase/" + item.token;
  const anchor = link("",url);
  anchor.tabIndex = -1;
  anchor.setAttribute("aria-hidden","true");
  const cover = element("img");
  cover.src = "/api/showcase/" + item.token + "/cover";
  cover.alt = "";
  cover.loading = "lazy";
  const copy = element("div",null,"showcase-copy");
  const heading = element("h2");
  heading.append(link(item.title,url));
  copy.append(heading,creatorLink(item));
  anchor.append(cover);
  article.append(anchor,copy);
  return article;
}

function creatorLink(item) {
  const author = link(item.author,"/showcase/creator/"+item.creator);
  author.className = "showcase-author";
  return author;
}

function ownCard(item) {
  const article = element("article",null,"showcase-card");
  const copy = element("div",null,"showcase-copy");
  const status = {pending:"待审核",approved:"已发布",rejected:"已退回"};
  const actions = element("div",null,"showcase-entry-actions");
  actions.append(link("打开来源画布","/?board="+encodeURIComponent(item.board_id)));
  if (item.state === "approved") actions.append(link("查看公开作品","/showcase/"+item.token));
  copy.append(element("h2",item.title),element("p",status[item.state]));
  if (item.reason) copy.append(element("p",item.reason));
  copy.append(actions);
  article.append(copy);
  return article;
}

async function list(reset) {
  const id = ++request, target = reset ? 1 : page+1;
  const q = mine ? "" : new FormData(search).get("q").trim();
  const kind = mine ? "" : search.elements.kind.value;
  if (reset) content.replaceChildren();
  content.className = "showcase-grid";
  more.hidden = true;
  statusLine.textContent = OneShotI18n.t("正在读取作品…");
  try {
    const endpoint = mine ? "/api/showcase/me" : creator ? "/api/showcase/creator/"+creator : "/api/showcase";
    const response = await loadJSON(endpoint+"?" + new URLSearchParams({page:target,q,kind}));
    if (id !== request) return;
    if (creator) {
      title.textContent = response.name + "的作品";
      document.title = title.textContent + " · OneShot";
    }
    if (mine && response.creator) {
      const profile = document.querySelector("#creatorProfile");
      profile.href = "/showcase/creator/" + response.creator;
      profile.hidden = false;
    }
    page = target;
    content.append(...response.items.map(mine ? ownCard : card));
    more.hidden = !response.more;
    statusLine.textContent = content.childElementCount ? "" : q || kind ? OneShotI18n.t("没有匹配的作品") : OneShotI18n.t("还没有发布的作品");
  } catch (error) {
    if (id !== request) return;
    more.hidden = reset;
    statusLine.textContent = error.message;
    if (mine && error.message === "请先登录") {
      content.append(link("登录后查看我的作品","/login?next="+encodeURIComponent(location.pathname+location.search)));
    }
  }
}

async function watch() {
  search.hidden = true;
  const item = await loadJSON("/api/showcase/" + token);
  title.textContent = item.title;
  document.title = item.title + " · OneShot";
  content.className = "showcase-watch";
  content.append(workMedia(item,"/api/showcase"),creatorLink(item));
  if (item.description) content.append(element("p",item.description));
  if (item.media_kind==="gif") {
    const gif = link("下载 GIF","/api/showcase/"+item.token+"/gif");
    gif.download = item.title+".gif";
    content.append(gif);
  }
  if (item.prompt) content.append(showcasePrompt(item));
  if (item.has_canvas) content.append(link("查看或复制制作画布","/share/" + item.token));
  if (item.template) content.append(link("使用工作流模板 · " + item.template.name,"/?template=" + encodeURIComponent(item.template.id)));
  statusLine.textContent = "";
}

function showcasePrompt(item) {
  const section = element("section",null,"showcase-prompt");
  section.append(element("h2","创作提示词"));
  const text = element("textarea");
  text.readOnly = true;
  text.value = item.prompt;
  text.rows = 6;
  text.setAttribute("aria-label",OneShotI18n.t("公开提示词"));
  const actions = element("div",null,"showcase-entry-actions");
  const copy = element("button","复制提示词"), use = element("button","用提示词新建画布");
  const status = element("span");
  status.setAttribute("role","status");
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(item.prompt);
      status.textContent = OneShotI18n.t("已复制提示词");
    } catch {
      text.focus(); text.select();
      status.textContent = OneShotI18n.t("提示词已选中，可以手动复制");
    }
  };
  let key;
  use.onclick = async () => {
    if (use.disabled) return;
    use.disabled = true;
    key ||= Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,"0")).join("");
    try {
      const result = await loadJSON("/api/showcase/"+item.token+"/use-prompt",{
        method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({request_key:key})
      });
      location.assign("/?board="+encodeURIComponent(result.id));
    } catch (error) {
      status.textContent = error.message;
      if (error.message === "请先登录") {
        status.append(" ",link("登录","/login?next="+encodeURIComponent(location.pathname)));
      }
      use.disabled = false;
    }
  };
  actions.append(copy,use);
  section.append(text,actions,status);
  return section;
}

function reviewCard(item) {
  const article = element("article",null,"showcase-card");
  const copy = element("div",null,"showcase-copy");
  const form = element("form"), actions = element("div");
  const reason = element("textarea");
  reason.placeholder = OneShotI18n.t("退回原因");
  reason.setAttribute("aria-label",OneShotI18n.t("退回原因"));
  reason.maxLength = 500;
  reason.rows = 2;
  const accept = element("button","通过"), reject = element("button","退回");
  accept.value = "approved"; reject.value = "rejected";
  actions.append(accept,reject);
  form.append(reason,actions);
  form.onsubmit = async event=>{
    event.preventDefault();
    const state = event.submitter?.value;
    if (!state) return;
    const comment = reason.value.trim();
    if (state === "rejected" && !comment) {
      statusLine.textContent = OneShotI18n.t("退回时请填写原因");
      reason.focus();
      return;
    }
    accept.disabled = reject.disabled = true;
    try {
      await loadJSON("/api/admin/showcase/" + item.token,{
        method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({state,reason:comment})
      });
      article.remove();
      statusLine.textContent = content.childElementCount ? OneShotI18n.t("审核结果已保存") : OneShotI18n.t("没有待审核的作品");
    } catch (error) { statusLine.textContent = error.message; }
    finally { accept.disabled = reject.disabled = false; }
  };
  copy.append(element("h2",item.title),element("p",item.author));
  if (item.description) copy.append(element("p",item.description));
  if (item.prompt) {
    const prompt = element("details",null,"showcase-review-prompt");
    prompt.append(element("summary","随作品公开的提示词"),element("p",item.prompt));
    copy.append(prompt);
  }
  if (item.has_canvas) {
    const preview = link("审核附带画布","/showcase-review/" + item.token);
    preview.target = "_blank";
    preview.rel = "noopener";
    copy.append(preview);
  }
  copy.append(form);
  article.append(workMedia(item,"/api/admin/showcase"),copy);
  return article;
}

async function review() {
  title.textContent = OneShotI18n.t("审核作品");
  search.hidden = true;
  const items = await loadJSON("/api/admin/showcase");
  content.className = "showcase-grid";
  content.append(...items.map(reviewCard));
  statusLine.textContent = items.length ? "" : OneShotI18n.t("没有待审核的作品");
}

search.onsubmit = event=>{ event.preventDefault(); list(true); };
search.elements.kind.onchange = ()=>list(true);
more.onclick = ()=>list(false);
const renderPage = reviewMode ? review : token ? watch : ()=>list(true);
if (mine) {
  title.textContent = OneShotI18n.t("我的作品");
  search.hidden = true;
}
renderPage().catch(error=>{ statusLine.textContent = error.message; });
loadJSON("/api/auth/state").then(data=>{
  document.querySelector("#reviewLink").hidden = reviewMode || data.user?.role !== "admin";
  document.querySelector("#myShowcaseLink").hidden = mine || !data.user;
}).catch(()=>{});
