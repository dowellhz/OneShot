"use strict";
// Parse Markdown locally; never insert unsanitized model or user HTML.
function acMarkdown(host,text,{images=true}={}){
  host.classList.add("ac-markdown");
  if(!globalThis.marked || !globalThis.DOMPurify){host.textContent=text;return;}
  const parsed=marked.parse(String(text||""),{gfm:true,breaks:true,async:false});
  const fragment=DOMPurify.sanitize(parsed,{RETURN_DOM_FRAGMENT:true,
    ALLOWED_TAGS:["p","br","hr","h1","h2","h3","h4","h5","h6","strong","em","del","s","ul","ol","li","blockquote","pre","code","a","img","table","thead","tbody","tr","th","td","input"],
    ALLOWED_ATTR:["href","title","src","alt","class","align","start","type","checked","disabled"],
    ALLOW_DATA_ATTR:false,ALLOW_ARIA_ATTR:false});
  for(const el of fragment.querySelectorAll("[class]")){const cls=el.getAttribute("class");if(el.tagName!=="CODE"||!/^language-[a-z0-9_-]{1,30}$/i.test(cls))el.removeAttribute("class");}
  for(const anchor of fragment.querySelectorAll("a")){
    try{const u=new URL(anchor.getAttribute("href"),location.href);if(!["http:","https:","mailto:"].includes(u.protocol))anchor.removeAttribute("href");else{anchor.target="_blank";anchor.rel="noopener noreferrer";}}
    catch{anchor.removeAttribute("href");}
  }
  for(const image of fragment.querySelectorAll("img")){
    if(!images){image.replaceWith(document.createTextNode(image.alt));continue;}
    try{const u=new URL(image.getAttribute("src"),location.href);if(!["http:","https:"].includes(u.protocol)){image.remove();continue;}image.loading="lazy";image.referrerPolicy="no-referrer";}
    catch{image.remove();}
  }
  for(const input of fragment.querySelectorAll("input")){if(input.type!=="checkbox")input.remove();else input.disabled=true;}
  for(const table of [...fragment.querySelectorAll("table")]){const wrap=document.createElement("div");wrap.className="ac-table";table.replaceWith(wrap);wrap.append(table);}
  for(const pre of fragment.querySelectorAll("pre")){
    const code=pre.querySelector("code");if(!code)continue;
    const copy=document.createElement("button");copy.type="button";copy.className="ac-code-copy";copy.textContent=OneShotI18n.t("复制");copy.setAttribute("aria-label","复制代码");
    copy.onclick=async()=>{try{await acCopyText(code.textContent);copy.textContent=OneShotI18n.t("已复制");}catch{copy.textContent=OneShotI18n.t("复制失败");}setTimeout(()=>copy.textContent=OneShotI18n.t("复制"),1800);};pre.prepend(copy);
  }
  host.replaceChildren(fragment);
}
async function acCopyText(text){
  if(navigator.clipboard?.writeText)return navigator.clipboard.writeText(text);
  const active=document.activeElement,area=document.createElement("textarea");area.value=text;area.style.cssText="position:fixed;left:-9999px;top:0";(active?.closest("dialog[open]") || document.body).append(area);area.select();
  const copied=document.execCommand?.("copy");area.remove();active?.focus();if(!copied)throw new Error("复制失败");
}
