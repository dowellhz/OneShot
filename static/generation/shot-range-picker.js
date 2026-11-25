"use strict";

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
  openShotRangePicker(script,null,{firstIndex:indices[0],lastIndex:indices.at(-1),mode:plan.mode,tailMode:plan.tail_mode});
}

function openShotRangePicker(script, onExpanded, {firstIndex=0,lastIndex=null,mode="missing",tailMode="keep"}={}) {
  if(!canvasCanEdit() || node(script.id)!==script || nodeLocked(script))return;
  const dialog=$("#shotRangePicker"), form=$("form",dialog), board=boardId, shots=script.data.shots.slice();
  if(dialog.open || !shots.length)return;
  const first=$("[name=first]",form), last=$("[name=last]",form), submit=$("[type=submit]",form), status=$("[role=status]",form);
  const label=(shot,i)=>`镜头 ${i+1}${shot.shot_size?" · "+shot.shot_size:""}`;
  first.replaceChildren(...shots.map((shot,i)=>new Option(label(shot,i),String(i))));
  first.value=String(firstIndex);
  const missing=()=>{
    const linked=scriptShotLinks(script);
    return shots.flatMap((_,i)=>i>=Number(first.value) && i<=Number(last.value) && shotNeedsNodes(linked[i])?[i]:[]);
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
    openScriptShotRangeRun(script,Number(first.value),Number(last.value),mode,tailMode);
  };
  submit.disabled=false;
  if(dialog.showModal)dialog.showModal();else dialog.setAttribute("open","");
}

function closeShotRangePicker() {
  const dialog=$("#shotRangePicker");
  if(dialog.close)dialog.close();else dialog.removeAttribute("open");
}
