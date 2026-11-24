"use strict";

async function loadSharedItem(){
  const status=document.querySelector("#sharedStatus");
  const title=document.querySelector("#sharedTitle"), content=document.querySelector("#sharedContent");
  try{
    const token=location.pathname.split("/").pop();
    const response=await fetch("/api/shared-item/"+encodeURIComponent(token));
    if(!response.ok)throw new Error();
    const value=await response.json();
    title.textContent=value.title;
    document.title=value.title+" · OneShot";
    if(value.kind==="media"){
      const element=document.createElement(value.media_type==="image"?"img":value.media_type);
      element.src=value.media_url;
      if(value.media_type==="image")element.alt=value.title;
      else {element.controls=true;element.preload="metadata";}
      element.addEventListener("error",()=>{status.textContent=OneShotI18n.t("这份媒体已不可用");});
      content.append(element);
    }else{
      for(const message of value.messages){
        const answer=document.createElement("article");
        const label=document.createElement("h2"), body=document.createElement("div");
        label.textContent=message.role==="user"?OneShotI18n.t("用户"):OneShotI18n.t("创作助手");
        acMarkdown(body,message.text,{images:false});
        answer.append(label,body);
        content.append(answer);
      }
    }
    status.textContent="";
  }catch{ status.textContent=OneShotI18n.t("分享内容已撤销或暂时无法访问"); }
}
void loadSharedItem();
