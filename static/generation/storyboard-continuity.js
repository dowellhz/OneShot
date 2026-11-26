"use strict";

function scriptTailEdges() {
  const edges=new Map();
  for(const edge of B.edges)if(edge.story_continuity&&!edges.has(edge.to))edges.set(edge.to,edge);
  return edges;
}

function scriptContinuityStatus(links,index,edges) {
  const edge=edges.get(links[index]?.img);
  if(!edge)return null;
  if(index===0)return {text:"首镜仍引用旧的上一镜尾帧",warning:true};
  const previous=node(links[index-1]?.vid), source=node(edge.from), picture=node(edge.to);
  const capture=source?.versions.find(v=>v.ref===edge.ref)?.capture;
  const requested=curV(previous)?.ref;
  const used=curV(picture)?.generation_record?.inputs;
  if(!capture?.source_ref || capture.position!=="last")return {text:"尾帧来源无法确认",warning:true,relink:!!requested};
  if(!requested)return {text:"上一镜当前没有可用视频",warning:true};
  if(capture.source_node!==previous.id || capture.source_ref!==requested)return {text:"尾帧与上一镜当前版本不一致",warning:true,relink:true};
  if(Array.isArray(used)&&!used.some(item=>item.ref===edge.ref))return {text:"尾帧已对齐，当前分镜图尚未使用",warning:true};
  return {text:`尾帧已对齐 · 上一镜版本 ${previous.cur+1}`,warning:false};
}

function paintScriptContinuity(script,root,links=scriptShotLinks(script),edges=scriptTailEdges()) {
  const editable=canvasCanEdit()&&!nodeLocked(script);
  for(const badge of $$("[data-script-tail-status]",root)){
    const index=Number(badge.dataset.scriptTailStatus);
    const status=scriptContinuityStatus(links,index,edges);
    badge.hidden=!status;
    if(badge.textContent!==(status?.text||""))badge.textContent=status?.text||"";
    badge.dataset.warning=String(!!status?.warning);
    const actions=$("[data-shot-tail-actions]",badge.parentElement);
    if(!actions)continue;
    const edge=edges.get(links[index]?.img);
    const picture=node(links[index]?.img), previous=node(links[index-1]?.vid);
    const link=$("[data-tail-link]",actions), remove=$("[data-tail-remove]",actions);
    const canChange=editable&&picture?.type==="image"&&!nodeLocked(picture);
    link.hidden=!canChange||!curV(previous)?.ref||picture.data.model==="h3video"||!!edge&&!status?.relink;
    remove.hidden=!canChange||!edge;
    actions.hidden=link.hidden&&remove.hidden;
    const label=edge?"改用最新尾帧":"连接上一镜尾帧";
    if(link.textContent!==label)link.textContent=label;
    link.disabled=remove.disabled=!!(picture?.job||prepping.has(picture?.id)||scriptContinuityPending.has(picture));
  }
}

function refreshScriptContinuity() {
  const edges=scriptTailEdges();
  for(const script of B.nodes){
    if(script.type==="script"&&els.get(script.id))paintScriptContinuity(script,els.get(script.id),scriptShotLinks(script),edges);
  }
  const list=$("#shotList");
  const script=list&&!list.hidden?node($("[data-source]",list)?.value):null;
  if(script?.type==="script")paintScriptContinuity(script,list,scriptShotLinks(script),edges);
}

const scriptContinuityPending=new Set();

function scriptTailPrompt(slot) {
  return `参考上一镜尾帧 ${promptMediaToken("image",slot)} 的人物、道具位置和光线，按本镜的机位与首帧要求构图。`;
}

function removeScriptTailPrompt(picture, edge) {
  const slot=promptSlot(edge.prompt_slot);
  if(!slot || !picture.data.prompt || imageInputs(picture).some(input=>input.edge!==edge&&input.edge.prompt_slot===slot))return;
  const token=promptMediaToken("image",slot), instruction=scriptTailPrompt(slot);
  picture.data.prompt=picture.data.prompt.split("\n").filter(line=>line.trim()!==instruction).join("\n").replaceAll(token,"");
}

async function linkPreviousShotFrame(script,index,{batch=false,allowNew=!batch,select=!batch,active:keepRunning=()=>true}={}) {
  const fail=message=>{
    if(batch)throw new Error(message);
    toast(message);
    return false;
  };
  if(!canvasCanEdit() || node(script.id)!==script || nodeLocked(script))return;
  if(!batch&&scriptShotLinks(script)[index]?.shared_first)return useRenderedMotionTail(script,index);
  const pairs=scriptShotLinks(script), source=node(pairs[index-1]?.vid), picture=node(pairs[index]?.img);
  const version=curV(source);
  if(!version?.ref)return fail("请先为上一镜生成或选好视频版本");
  if(!picture)return fail("请先展开这一镜");
  if(nodeLocked(picture)||picture.job||prepping.has(picture.id))return fail("请等当前分镜图任务结束，或解锁节点后再连接");
  if(picture.data.model==="h3video")return fail("请为分镜图选择支持参考图片的模型");
  if(vtReferenceAncestors(source).has(picture.id))return fail("上一镜已依赖本镜分镜图，连接会形成循环");
  if(scriptContinuityPending.has(picture))return fail("上一镜尾帧正在截取，请稍后重试");
  const continuity=()=>B.edges.find(edge=>edge.to===picture.id&&edge.story_continuity);
  const prior=continuity();
  const bindingKey=edge=>edge&&JSON.stringify([edge.from,edge.ref,edge.prompt_slot]);
  const priorBinding=bindingKey(prior);
  const oldFrame=node(prior?.from)?.versions.find(item=>item.ref===prior.ref);
  if(!allowNew&&!prior)return false;
  if(oldFrame?.capture?.position==="last"&&oldFrame.capture.source_node===source.id&&oldFrame.capture.source_ref===version.ref){
    if(!batch)toast("已连接上一镜当前版本的尾帧");
    return true;
  }
  const previousShot=script.data.shots[index-1], shot=script.data.shots[index];
  const active=()=>{
    if(!keepRunning() || node(script.id)!==script || nodeLocked(script) || node(picture.id)!==picture ||
      nodeLocked(picture) || picture.job || prepping.has(picture.id) || picture.data.model==="h3video" ||
      node(source.id)!==source || curV(source)!==version || continuity()!==prior ||
      bindingKey(prior)!==priorBinding || vtReferenceAncestors(source).has(picture.id) ||
      script.data.shots[index]!==shot || script.data.shots[index-1]!==previousShot)return false;
    const linked=scriptShotLinks(script);
    return linked[index-1]?.vid===source.id&&linked[index]?.img===picture.id;
  };
  scriptContinuityPending.add(picture);
  if(!batch)toast("正在截取上一镜尾帧…");
  try{
    const frame=await captureOnCanvas(source.id,version,{position:"last",active,select,onCaptured:image=>{
      const sequence=promptSlot(picture.data.image_ref_seq);
      const slot=promptSlot(prior?.prompt_slot)||1+Math.max(sequence,...imageInputs(picture).map(({edge})=>promptSlot(edge.prompt_slot)));
      const binding={from:image.id,ref:curV(image).ref,prompt_slot:slot,story_continuity:true};
      if(prior)Object.assign(prior,binding);
      else {
        B.edges.push({...binding,to:picture.id});
        picture.data.prompt=[picture.data.prompt,scriptTailPrompt(slot)].filter(Boolean).join("\n");
      }
      picture.data.image_ref_seq=Math.max(sequence,slot);
      return picture;
    }});
    if(!batch)toast(frame?"已连接上一镜尾帧，可生成本镜分镜图":"镜头或素材已变化，请重新选择");
    return !!frame;
  }catch(error){
    if(batch)throw error;
    if(node(script.id)===script)toast("尾帧连接失败："+error.message);
    return false;
  }
  finally{scriptContinuityPending.delete(picture);}
}

async function useRenderedMotionTail(script,index) {
  const pair=scriptShotLinks(script)[index], previous=node(scriptShotLinks(script)[index-1]?.vid), video=node(pair?.vid);
  const version=curV(previous);
  const first=video&&B.edges.find(edge=>edge.to===video.id&&edge.role==="first");
  const nextFrame=firstMotionFrame(pair);
  const previousFrame=first&&B.edges.find(edge=>edge.from===first.from&&edge.to===nextFrame?.id&&edge.prompt_slot===1);
  if(!canvasCanEdit()||nodeLocked(script)||!pair?.shared_first||!version||!first||nodeLocked(video)||
     video.job||prepping.has(video.id)||nextFrame?.job||prepping.has(nextFrame?.id)||
     scriptContinuityPending.has(video)||vtReferenceAncestors(previous).has(video.id))return false;
  const originalSource=first.from, originalRef=first.ref;
  const priorCapture=node(first.from)?.versions.find(item=>item.ref===first.ref)?.capture;
  if(priorCapture?.source_ref===version.ref&&priorCapture.position==="last"){
    toast("已使用上一镜当前版本的成片尾帧");
    return true;
  }
  scriptContinuityPending.add(video);
  try{
    const frame=await captureOnCanvas(previous.id,version,{position:"last",select:false,
      active:()=>node(script.id)===script&&node(video.id)===video&&curV(previous)===version&&
        !video.job&&!prepping.has(video.id)&&!nodeLocked(video)&&B.edges.includes(first)&&
        first.from===originalSource&&first.ref===originalRef&&
        !nextFrame?.job&&!prepping.has(nextFrame?.id)&&
        scriptShotLinks(script)[index]===pair&&scriptShotLinks(script)[index-1]?.vid===previous.id&&
        !vtReferenceAncestors(previous).has(video.id),
      onCaptured:image=>{
        rememberVideoVersion(video);
        Object.assign(first,{from:image.id,ref:curV(image).ref});
        if(previousFrame&&B.edges.includes(previousFrame)&&previousFrame.from===originalSource&&!nodeLocked(nextFrame))
          Object.assign(previousFrame,{from:image.id,ref:curV(image).ref});
        drawEdges();
        return video;
      }});
    toast(frame?"已用上一镜成片尾帧作为本镜首帧，可重生成本镜":"镜头或版本已经变化，请重试");
    return !!frame;
  }catch(error){
    toast("取得上一镜尾帧失败："+error.message);
    return false;
  }finally{scriptContinuityPending.delete(video);}
}
