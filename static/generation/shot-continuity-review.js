"use strict";

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
