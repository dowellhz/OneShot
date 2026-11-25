"use strict";

function closeShotMediaPicker() {
  const dialog=$("#shotMediaPicker");
  if(dialog.open){if(dialog.close)dialog.close();else dialog.removeAttribute("open");}
}

function openShotMediaPicker(script, shot, onSaved) {
  const index=script.data.shots.indexOf(shot);
  if(index<0||!canvasCanEdit()||nodeLocked(script)||node(script.id)!==script)return;
  const dialog=$("#shotMediaPicker"), form=$("form",dialog), board=boardId;
  if(dialog.open)return;
  const selects=$$("select",form), status=$("[role=status]",form), submit=$("[type=submit]",form);
  const pair=scriptShotLinks(script)[index], binding=[pair?.img||"",pair?.vid||""];
  const usedByOtherShots=()=>{
    const used=new Set();
    for(const source of B.nodes.filter(n=>n.type==="script")){
      scriptShotLinks(source).forEach((linked,i)=>{
        if(linked&&(source!==script||source.data.shots[i]!==shot)){
          used.add(linked.img);used.add(linked.vid);
        }
      });
    }
    return used;
  };
  const types=["image","video"], permitted=(n,i,used)=>n?.type===types[i]&&
    (n.id===binding[i]||!!curV(n)?.ref&&!used.has(n.id)&&!n.data.previs&&!n.data.film&&!n.job&&!prepping.has(n.id));
  const used=usedByOtherShots();
  $("#shotMediaTitle").textContent=`关联第 ${index+1} 镜的素材`;
  status.textContent="";
  selects.forEach((select,i)=>{
    const candidates=B.nodes.filter(n=>permitted(n,i,used));
    select.replaceChildren(new Option("未关联",""),...candidates.map(n=>{
      const version=curV(n)?.ref?`版本 ${n.cur+1}`:"待生成";
      return new Option(`${n.name} · ${version}`,n.id);
    }));
    select.value=binding[i];
    if(!select.value)select.selectedIndex=0;
  });
  const changed=()=>selects.some((select,i)=>select.value!==binding[i]);
  submit.disabled=true;
  form.onchange=()=>{submit.disabled=!changed();status.textContent="";};
  form.onsubmit=event=>{
    event.preventDefault();
    if(!dialog.open||!changed())return;
    const currentIndex=script.data.shots.indexOf(shot);
    if(board!==boardId||node(script.id)!==script||!canvasCanEdit()||nodeLocked(script)||currentIndex<0){
      status.textContent="分镜已变化，请重新选择镜头";return;
    }
    if(groupRun?.active&&groupRun.board===B&&groupRun.story?.scriptId===script.id){
      status.textContent="请等此分镜的批量生成结束后再修改";return;
    }
    const current=scriptShotLinks(script)[currentIndex], next=selects.map(select=>select.value);
    if((current?.img||"")!==binding[0]||(current?.vid||"")!==binding[1]){
      status.textContent="素材关联已变化，请重新打开";return;
    }
    const occupied=usedByOtherShots();
    if(next.some((id,i)=>id&&!permitted(node(id),i,occupied))){
      status.textContent="所选素材已不可用或已关联其他镜头";return;
    }
    if(binding.some((id,i)=>id!==next[i]&&(node(id)?.job||prepping.has(id)))){
      status.textContent="请等原素材的生成任务结束后再修改";return;
    }
    checkpoint();
    ensureScriptShotIds(script);
    script.data.made=(script.data.made||[]).filter(record=>record.shot_id!==shot.id);
    if(next.some(Boolean))script.data.made.push({shot_id:shot.id,...(next[0]?{img:next[0]}:{}),...(next[1]?{vid:next[1]}:{})});
    refresh(script);save();
    closeShotMediaPicker();
    onSaved();
    toast("已更新镜头素材，可撤销");
  };
  if(dialog.showModal)dialog.showModal();else dialog.setAttribute("open","");
}
