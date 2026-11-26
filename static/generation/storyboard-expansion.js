"use strict";

function expandMissingScriptShots(n) {
  const indexes=scriptShotLinks(n).flatMap((pair,i)=>shotNeedsNodes(pair)||missingMotionFrames(n.data.shots[i],pair)?[i]:[]);
  expandScript(n,indexes);
}

function shotFrameIds(pair) {
  return [pair.img,pair.motion_frames?.middle,pair.motion_frames?.end].filter(Boolean);
}

function motionFramePhases(shot) {
  const frames=shot?.motion_frames;
  return !frames?[]:Object.hasOwn(frames,"middle")?["middle","end"]:["end"];
}

function firstMotionFrame(pair) {
  return node(pair?.motion_frames?.middle)||node(pair?.motion_frames?.end);
}

function shotMiddleTime(seconds,duration) {
  const lastFrame=vidFrames(duration)-4;
  return Math.min(lastFrame-1,Math.max(1,Math.round(seconds*24)))/24;
}

function missingMotionFrames(shot,pair) {
  return motionFramePhases(shot).some(phase=>!node(pair?.motion_frames?.[phase]));
}

function shotMotionFrameSettings(script,shot,phase,{legacy=false}={}) {
  const action=shot.action||[];
  const end=phase==="end";
  const description=shot.motion_frames[phase]?.trim()||[
    end?action.at(-1):action[Math.floor((action.length-1)/2)],
    end?"定格在动作完成之后，人物保持最终站位和姿态":"定格在动作进行到此处的瞬间"
  ].filter(Boolean).join("，");
  const moment=phase==="end"?"尾帧":"中帧";
  const assets=(shot.asset_refs||[]).filter(ref=>ref.kind!=="world"||ref.explicit).map(ref=>cmLabelledToken(ref,ref.view)).join(" ");
  const framing=[script.data.style,shot.scene,[shot.shot_size,shot.camera].filter(Boolean).join("，")];
  const pose=`${moment}画面：${description}`;
  const lines=legacy?[
    "参考 @图{1} 延续同一镜头。保持机位、景别、场景、角色身份、服装和光线。人物和道具的位置以本帧描述为准。",
    ...framing,pose
  ]:[pose,
    "参考 @图{1} 的机位、景别、场景、角色身份和光线。按本帧要求重新摆放发生移动的人物和道具，画出新的相对位置、接触点和姿态。发生移动的每件道具只出现一次，原位不留副本。",
    ...framing
  ];
  const prompt=[...lines,assets&&"参考资产 "+assets].filter(Boolean).join("\n");
  return {prompt,caption:description,moment};
}

function makeShotMotionFrame(script,shot,settings,index,phase,prior,x,y) {
  const {moment,...data}=shotMotionFrameSettings(script,shot,phase);
  const image=addNode("image",x,y,{...data,aspect:script.data.aspect,quality:"4mp",image_ref_seq:1},
    {name:`镜${index+1} · ${moment}`});
  B.edges.push({from:prior.id,to:image.id,prompt_slot:1,image_use:"camera"});
  addStoryboardImageReferences(image,settings.frameReferences);
  return image;
}

const SCRIPT_VIDEO_DURATIONS = [5,8,10,14];
const scriptVideoDuration = desired => SCRIPT_VIDEO_DURATIONS.find(seconds=>seconds>=Number(desired||5)) ?? 14;
function addStoryboardImageReferences(image,references) {
  for (const ref of references) {
    B.edges.push({from:ref.node.id,to:image.id,image_use:ref.kind||"character",
      ...(ref.pinned?{ref:ref.ref}:{story_cast:true})});
  }
}
function scriptShotSettings(script,shot,refs=scriptRefs(script)) {
  const data=script.data;
  const refOf=name=>refs.find(ref=>ref.name===name)||refs.find(ref=>ref.name.includes(name)||name.includes(ref.name));
  const characters=shot.characters||[], cast=data.characters||[];
  const references=[...new Map(characters.map(refOf).filter(Boolean).map(ref=>[ref.node.id,ref])).values()].slice(0,8);
  const visuals=(shot.visual_asset_keys||[]).flatMap(key=>{
    const asset=(data.visual_assets||[]).find(item=>item.key===key);
    const source=asset&&wizardVisualAssetNode(script,asset);
    const input=source&&imageInputs(script).find(({source:n,edge,version})=>n===source&&edge.ref&&version?.ref);
    return input?[{node:source,ref:input.version.ref,pinned:true,kind:asset.kind,look:asset.look,name:asset.name}]:[];
  }).slice(0,8-references.length);
  const intro=references.map((ref,i)=>`@图${i+1} 是${ref.name}`).join("，");
  const assets=(shot.asset_refs||[]).filter(ref=>ref.kind!=="world"||ref.explicit).map(ref=>cmLabelledToken(ref,ref.view)).join(" ");
  const assetLine=assets&&"参考资产 "+assets;
  const prompt=[intro&&intro+"。",data.style,shot.scene,shot.keyframe,shot.shot_size&&`${shot.shot_size}镜头`,assetLine]
    .filter(Boolean).join("，").replace(/。，/g,"。");
  const people=characters.map(name=>{
    const character=cast.find(item=>item.name===name);
    const look=character?.look||refOf(name)?.desc||"", voice=character?.voice;
    return `${name}：${look}${voice?"，声音："+voice:""}`.replace(/：$/,"");
  }).join("\n");
  const duration=scriptVideoDuration(shot.duration);
  const scene = [shot.scene,...visuals.map(asset=>`${asset.name}：${asset.look}`),assetLine].filter(Boolean).join("\n");
  return {references,frameReferences:[...references.map(ref=>({...ref,kind:"character"})),...visuals],image:{prompt,caption:shot.keyframe||""},video:{
    duration,fields:{style:data.style,scene,people,camera:[shot.shot_size,shot.camera].filter(Boolean).join("，"),
      action:(shot.action||[]).join("\n"),dialogue:(shot.dialogue||[]).join("\n"),sound:shot.sound,music:""},
  }};
}

function expandScript(n, indexes=null, {recordUndo=true}={}) {
  if(!canvasCanEdit() || node(n.id)!==n || nodeLocked(n))return;
  const d = n.data, shots = d.shots || []; if (!shots.length) return;
  const links=indexes?scriptShotLinks(n):null;
  const selected=indexes?[...new Set(indexes)].filter(i=>shots[i]&&(shotNeedsNodes(links[i])||missingMotionFrames(shots[i],links[i]))).sort((a,b)=>a-b):shots.map((_,i)=>i);
  if(!selected.length)return;
  if(recordUndo)checkpoint();
  ensureScriptShotIds(n);
  const refs=scriptRefs(n);
  const s0 = size(n), x0 = n.x + s0.w + 140;
  let y0 = n.y;
  (d.made||[]).forEach(x => [...shotFrameIds(x),x.vid].map(node).filter(Boolean).forEach(m => { y0 = Math.max(y0, m.y + size(m).h + 120); }));
  const made = [], newRecords=[];
  const assembled=new Map();
  let x = x0;
  selected.forEach(i => {
    const s=shots[i], pair=links?.[i];
    const settings=scriptShotSettings(n,s,refs);
    const created=[];
    let img=node(pair?.img), vid=node(pair?.vid);
    const prior=shots[i-1], previousPair=assembled.get(i-1)||links?.[i-1];
    const previousTail=node(previousPair?.motion_frames?.end);
    const continuous=s.motion_frames&&s.continues_previous===true&&prior&&previousTail&&s.scene&&
      ["scene","shot_size","camera"].every(key=>s[key]===prior[key])&&
      [...(s.visual_asset_keys||[])].sort().join("|")===[...(prior.visual_asset_keys||[])].sort().join("|");
    if(!img&&continuous)img=previousTail;
    if(!img){
      const composition=s.frame?.source==="previs-frame" ? {previs_composition:{ref:s.frame.ref}} : {};
      img=addNode("image",x,y0,{...settings.image,...composition,aspect:d.aspect,quality:"4mp"},{name:`镜${i+1} · 分镜图`});
      if(s.frame){
        const {ref,w,h}=s.frame;
        const source=s.frame.source==="previs-frame" ? "previs-frame" : "frame";
        img.versions.push({ref,url:"/media?ref="+encodeURIComponent(ref),w,h,source,prompt:""});
        img.cur=0;
      }
      addStoryboardImageReferences(img,settings.frameReferences);
      created.push(img);
    }
    let nextY=y0+(created.length?Math.max(size(img).h,300)+110:0);
    const motionFrames={};
    let priorFrame=img;
    for(const phase of motionFramePhases(s)){
      const frame=node(pair?.motion_frames?.[phase])||
        makeShotMotionFrame(n,s,settings,i,phase,priorFrame,x,nextY);
      if(!node(pair?.motion_frames?.[phase])){
        created.push(frame);
        nextY+=Math.max(size(frame).h,300)+110;
      }else if(!B.edges.some(edge=>edge.to===frame.id&&edge.prompt_slot===1)){
        B.edges.push({from:priorFrame.id,to:frame.id,prompt_slot:1,image_use:"camera"});
      }
      motionFrames[phase]=frame.id;
      priorFrame=frame;
    }
    if(!vid){
      const provider=s.motion_frames&&CAPS_LIST.video?.some(item=>item.id==="local_h3")?"local_h3":undefined;
      vid=addNode("video",x,nextY,{...settings.video,quality:d.quality,aspect:d.aspect,pmode:"fields",
        ...(provider?{provider}:{})},{name:`镜${i+1}`});
      B.edges.push({from:img.id,to:vid.id,role:"first"});
      for(const r of settings.references){
        if(r.node.id!==img.id)B.edges.push({from:r.node.id,to:vid.id,role:"subject",story_cast:!r.pinned,...(r.pinned?{ref:r.ref}:{})});
      }
      created.push(vid);
    }
    if(s.motion_frames){
      const duration=settings.video.duration;
      const middleTime=shotMiddleTime(s.motion_frames.middle_time??Math.floor(duration/2),duration);
      for(const [id,role,time] of [[img.id,"first"],[motionFrames.middle,"keyframe",middleTime],[motionFrames.end,"last"]]){
        if(id&&!B.edges.some(edge=>edge.to===vid.id&&(edge.from===id||role==="first"&&edge.role==="first")))
          B.edges.push({from:id,to:vid.id,role,...(time!=null?{time}:{})});
      }
    }
    const record={img:img.id,vid:vid.id,shot_id:s.id,
      ...(s.motion_frames?{motion_frames:motionFrames,shared_first:img===previousTail}:{})};
    if(pair)Object.assign(pair,record);
    else newRecords.push(record);
    made.push(record);
    assembled.set(i,record);
    x+=Math.max(...created.map(m=>size(m).w),size(img).w)+80;
  });
  d.made = [...(d.made||[]).filter(pair=>node(pair.img)||node(pair.vid)), ...newRecords];
  B.nodes.forEach(m => render(m)); drawEdges(); save();
  sel = new Set(made.flatMap(m => [m.img, m.vid])); updateSel();
  fit([n, ...made.flatMap(m => [node(m.img), node(m.vid)])]);
  const need = made.some(m => shotFrameIds(m).some(id=>!storyboardFrameReady(node(id))));
  toast(`已展开 ${made.length} 个镜头。${need ? "点「批量出分镜图」生成分镜图，满意后" : "分镜图已就位，"}点「批量生成视频」。每个镜头的分栏都可以单独改`, 5000);
}
