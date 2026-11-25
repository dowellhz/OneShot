"use strict";

module.exports = async function pinnedMediaAndLibraryReplacement(workspace) {
 const { assert, equal, evaluate, ready, w } = workspace;
 equal(evaluate('CM.matches.map(item=>item.version)'),[2],'a numbered search returns the requested audio version');
 evaluate('versionMention.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",bubbles:true,cancelable:true}))');
 equal(evaluate('[versionMention.value,seedVersionTarget.data.references.map(item=>item.ref)]'),
 ['@音频2 ',['output:h3studio/voice-old.wav','output:h3studio/music-now.wav']],'Seed Audio completion inserts the correct numbered reference');
 evaluate(`const pinnedVoice={node_id:versionCopyAudio.id,ref:versionCopyAudio.versions[0].ref,kind:"audio"};
  const seedBulkTarget=addNode("audio",3660,1050,{mode:"seed_audio",references:[pinnedVoice]},
    {versions:[copyAsset("recorded-dialogue.wav",{audio_recipe:{mode:"seed_audio",references:[pinnedVoice]}})],cur:0});
  drawEdges();
  vtTabMenu(versionCopyAudio,1,120,120);
  $("#videoTabMenu [data-version-update]").click();`);
 assert.match(evaluate('$("#versionRefUpdate [data-summary]").textContent'),/版本 2 · 更新 1 个节点/);
 evaluate('$("#versionRefUpdate form").dispatchEvent(new Event("submit",{cancelable:true}))');
 equal(evaluate(`[seedBulkTarget.data.references[0].ref,curV(seedBulkTarget).audio_recipe.references[0].ref,
  seedVersionTarget.data.references.map(ref=>ref.ref)]`),
 ['output:h3studio/music-now.wav','output:h3studio/voice-old.wav',['output:h3studio/voice-old.wav','output:h3studio/music-now.wav']],
 'bulk reference update preserves the generation recipe and skips a target using multiple versions of the source');
 evaluate('vtOpenReferenceUpdate(versionCopyVideo,1)');
 assert.match(evaluate('$("#versionRefUpdate [data-summary]").textContent'),/更新 1 个节点/);
 evaluate('$("#versionRefUpdate form").dispatchEvent(new Event("submit",{cancelable:true}))');
 equal(evaluate('[videoRefEdge.ref,videoRefEdge.prompt_slot,versionCopyVideo.cur]'),
 ['output:h3studio/video-new.mp4',3,1],'bulk update keeps the stable slot while pinning the chosen video');
 evaluate(`const replacementVideo=addNode("video",3920,1200,{},
   {name:"替换素材",versions:[copyAsset("replacement-old.mp4",{seconds:6}),copyAsset("replacement-new.mp4",{seconds:8})],cur:1});
  const upstreamVideo=addNode("video",3880,1000,{},
   {versions:[copyAsset("upstream.mp4",{seconds:6})],cur:0});
  const duplicateTarget=addNode("video",4200,1200);
  link(versionCopyVideo,upstreamVideo,true);
  link(upstreamVideo,replacementVideo,true);
  link(versionCopyVideo,duplicateTarget,true);
  link(replacementVideo,duplicateTarget,true);
  videoRefTarget.versions=[copyAsset("already-generated.mp4",{seconds:5})];videoRefTarget.cur=0;
  Object.assign(videoRefEdge,{start:1,end:3});
  const originalCard=$(".card",els.get(versionCopyVideo.id));
  ctxMenu({target:originalCard,clientX:120,clientY:120});
  $("#ctxMenu [data-a=replace-reference]").click();
  const replacementSelect=$("#versionRefUpdate [name=replacement]");
  replacementSelect.value=replacementVideo.id;
  replacementSelect.dispatchEvent(new Event("change"));
  const replacementVersion=$("#versionRefUpdate [name=replacementVersion]");
  replacementVersion.value="0";
  replacementVersion.dispatchEvent(new Event("change"));`);
 assert.match(evaluate('$("#versionRefUpdate [data-summary]").textContent'),/→ 替换素材 · 版本 1 · 更新 1 个节点/);
 assert.match(evaluate('$("#versionRefUpdate ol").textContent'),/参考区间将重置/);
 evaluate('$("#versionRefUpdate form").dispatchEvent(new Event("submit",{cancelable:true}))');
 equal(evaluate(`[videoRefEdge.from===replacementVideo.id,videoRefEdge.ref,videoRefEdge.prompt_slot,videoRefEdge.start??null,
  curV(videoRefTarget).input_edges[0].from===versionCopyVideo.id,curV(videoRefTarget).input_edges[0].ref,
  videoInputs(upstreamVideo)[0].source===versionCopyVideo,videoInputs(duplicateTarget).length,replacementVideo.cur]`),
 [true,"output:h3studio/replacement-old.mp4",3,null,true,"output:h3studio/video-new.mp4",true,2,1],
 'cross-node replacement pins the selected source, preserves history and skips cycles and duplicate links');
 evaluate(`const replacementAudio=addNode("audio",3900,1050,{},
   {versions:[copyAsset("replacement.wav")],cur:0});
  vtOpenReferenceUpdate(versionCopyAudio);
  const audioReplacement=$("#versionRefUpdate [name=replacement]");
  audioReplacement.value=replacementAudio.id;audioReplacement.dispatchEvent(new Event("change"));
  $("#versionRefUpdate form").dispatchEvent(new Event("submit",{cancelable:true}));`);
 equal(evaluate(`[seedBulkTarget.data.references[0].node_id===replacementAudio.id,
  B.edges.find(e=>e.to===seedBulkTarget.id).from===replacementAudio.id,
  curV(seedBulkTarget).audio_recipe.references[0].node_id===versionCopyAudio.id]`),
 [true,true,true],'reference audio keeps the current slots and leaves the historical recipe intact');
 evaluate(`const groupShot=addNode("video",4150,1200);
  link(versionCopyVideo,groupShot,true,{prompt_slot:6});
  const groupReplacement=addNode("video",3980,1420,{},
    {name:"新镜头素材",versions:[copyAsset("group-alternative.mp4",{seconds:5})],cur:0});
  const referenceGroup=ctNewGroup("复用模板",[videoRefTarget.id,groupShot.id]);
  ctSetFold(referenceGroup,true);
  $("[data-group-replace]",CT_GROUPS.get(referenceGroup.id)).click();
  const groupOriginal=$("#versionRefUpdate [name=original]");
  groupOriginal.value=versionCopyVideo.id;groupOriginal.dispatchEvent(new Event("change"));
  const groupNew=$("#versionRefUpdate [name=replacement]");
  groupNew.value=groupReplacement.id;groupNew.dispatchEvent(new Event("change"));`);
 equal(evaluate('Array.from(groupOriginal.options,option=>option.value).sort()'),
   [evaluate('versionCopyVideo.id'),evaluate('replacementVideo.id')].sort(),'the group lists its existing references, including external source nodes');
 assert.match(evaluate('$("#versionRefUpdate ol").textContent'),/版本 1/);
 evaluate('$("#versionRefUpdate form").dispatchEvent(new Event("submit",{cancelable:true}))');
 equal(evaluate(`[referenceGroup.collapsed,videoInputs(groupShot)[0].source===groupReplacement,
  videoInputs(groupShot)[0].edge.prompt_slot,videoInputs(upstreamVideo)[0].source===versionCopyVideo,
  videoInputs(videoRefTarget)[0].source===replacementVideo]`),
  [true,true,6,true,true],'a folded group replacement only changes matching links that enter the group');
 evaluate('Object.assign(videoRefEdge,{start:0.5,end:2})');
 assert.match(evaluate('groupGenerationNodes(referenceGroup,true).find(step=>step.id===videoRefTarget.id).references[0].label'),
  /视频参考 · 版本 1（固定） · 0\.5–2 秒/);
 evaluate(`const referenceCardBoard=AC.board;AC.board=boardId;
  acAppendEvent({kind:"tool_start",data:{name:"canvas_reference_plan",call_id:"reference-plan-card"}});
  acAppendEvent({kind:"tool_end",data:{name:"canvas_reference_plan",call_id:"reference-plan-card",result:{reference_plan:{
    board:boardId,source:groupReplacement.id,source_name:groupReplacement.name,replacement:replacementVideo.id,
    replacement_name:replacementVideo.name,ref:replacementVideo.versions[0].ref,version:1,group:referenceGroup.id,group_name:referenceGroup.name}}}});
  $("[data-call=reference-plan-card] [data-reference-plan]").click();`);
 equal(evaluate(`[$("#versionRefUpdate [name=original]").value===groupReplacement.id,
  $("#versionRefUpdate [name=replacement]").value===replacementVideo.id,$("#versionRefUpdate [name=replacementVersion]").value,
  replacementVideo.cur,videoInputs(groupShot)[0].source===groupReplacement]`),
  [true,true,"0",1,true],'the assistant card preselects the exact historical version without applying the plan or switching the source');
 assert.match(evaluate('$("#versionRefUpdate ol").textContent'),/版本 1/);
 evaluate('$("#versionRefUpdate [data-cancel]").click();AC.board=referenceCardBoard');
 evaluate(`const focusedVersion=$(".vtabs button.on",els.get(versionCopyVideo.id));focusedVersion.focus();
  focusedVersion.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowUp",bubbles:true,cancelable:true}));`);
 equal(evaluate('[versionCopyVideo.cur,document.activeElement.dataset.i,document.activeElement.tabIndex]'),[0,"0",0],'arrow navigation keeps keyboard focus on the activated tab');
 equal(evaluate(`{
  const strip=$(".vtabs",els.get(versionCopyVideo.id));
  Object.defineProperties(strip,{clientHeight:{value:24},scrollHeight:{value:52}});
  const wheel=new WheelEvent("wheel",{deltaY:80,bubbles:true,cancelable:true});
  document.activeElement.dispatchEvent(wheel);
  strip.scrollTop=28;
  render(versionCopyVideo);
  [wheel.defaultPrevented,strip.scrollTop,document.activeElement.dataset.i];
 }`),[false,28,"0"],'an overflowing version list handles wheel input without moving the canvas and keeps its scroll and focus on refresh');
 const referenceLibraryFetch=w.fetch;
 const replacementAssets=[
  {id:'lin-memory',kind:'character',name:'林森',aliases:['远林'],tags:['近代'],ref:'input:h3studio/old-lin.png',
   character_views:{main:'input:h3studio/lin-main.png',side:'input:h3studio/lin-side.png'},
   media:[{ref:'input:h3studio/lin-main.png'},{ref:'input:h3studio/lin-side.png',w:512,h:768}]},
  {id:'sound-memory',kind:'prop',name:'声音',media:[{ref:'input:h3studio/voice.wav',type:'audio'}]},
 ];
 w.fetch=(url,options)=>{
  const path=new URL(url,'http://oneshot.test').pathname;
  if(path==='/api/memory'&&options?.method==='GET')return Promise.resolve({ok:true,json:async()=>replacementAssets});
  if(path==='/api/memory/lin-memory'&&options?.method==='GET')return Promise.resolve({ok:true,json:async()=>replacementAssets[0]});
  return referenceLibraryFetch(url,options);
 };
 await evaluate(`vtOpenReferenceUpdate(node(originalImage.id));$("#versionRefUpdate [data-library-source]").onclick()`);
 assert.equal(evaluate('$("#versionRefUpdate [data-library-picker] [role=status]").textContent'),"");
 equal(evaluate('Array.from($("#versionRefUpdate [data-library-picker] select").options,option=>option.textContent)'),
   ['选择素材…','林森 · 标准主图 · 个人素材库','林森 · 全身侧面 · 个人素材库'],
   'only compatible assets are offered, with approved character views labelled separately');
 evaluate(`const librarySearch=$("#versionRefUpdate [data-library-picker] input");
  librarySearch.value="不匹配";librarySearch.dispatchEvent(new Event("input"));`);
 assert.match(evaluate('$("#versionRefUpdate [data-library-picker] [role=status]").textContent'),/没有匹配/);
 evaluate(`librarySearch.value="远林";librarySearch.dispatchEvent(new Event("input"));
  const librarySelect=$("#versionRefUpdate [data-library-picker] select");
  librarySelect.value="1";librarySelect.dispatchEvent(new Event("change"));`);
 assert.match(evaluate('$("#versionRefUpdate [data-reference-media] img").src'),/lin-side\.png/);
 evaluate('$("#versionRefUpdate form").dispatchEvent(new Event("submit",{cancelable:true}))');
 equal(evaluate(`[imageInputs(imageRefTarget)[0].source.name,imageInputs(imageRefTarget)[0].source.data.asset.id,
  imageInputs(imageRefTarget)[0].version.ref,imageInputs(imageRefTarget)[0].edge.prompt_slot]`),
  ['林森 · 全身侧面','lin-memory','input:h3studio/lin-side.png',1],
  'a library view becomes an asset-linked source and retains the prompt slot');
 await evaluate(`const scopedAssetShot=addNode("video",4220,1550,{},{name:"只替换此镜头"});
  link(node(originalImage.id),scopedAssetShot,true,{role:"subject",prompt_slot:7});
  const otherAssetShot=addNode("video",4500,1550);
  link(node(originalImage.id),otherAssetShot,true);
  AC.board=boardId;
  const scopedAssetCall="reference-library-plan";
  acAppendEvent({kind:"tool_start",data:{name:"canvas_reference_plan",call_id:scopedAssetCall}});
  acAppendEvent({kind:"tool_end",data:{name:"canvas_reference_plan",call_id:scopedAssetCall,result:{reference_plan:{
    board:boardId,source:originalImage.id,source_name:originalImage.name,memory:"lin-memory",
    replacement_name:"林森 · 全身侧面",ref:"input:h3studio/lin-side.png",character_view:"side",targets:[scopedAssetShot.id]}}}});
  $("#acMessages").onclick({target:$("[data-call=reference-library-plan] [data-reference-plan]")});`);
 assert.match(evaluate('$("#versionRefUpdate [data-reference-media] img").src'),/lin-side\.png/);
 equal(evaluate('$$("#versionRefUpdate ol li").map(li=>li.firstChild.textContent)'),['只替换此镜头'],
  'the assistant preview narrows the asset replacement to the requested shot');
 evaluate('$("#versionRefUpdate form").dispatchEvent(new Event("submit",{cancelable:true}));AC.board=referenceCardBoard;');
 equal(evaluate(`[imageInputs(scopedAssetShot)[0].source.data.asset.id,imageInputs(scopedAssetShot)[0].edge.prompt_slot,
  imageInputs(otherAssetShot)[0].source.id===originalImage.id]`),['lin-memory',7,true],
  'choosing one shot preserves the other shot even when both originally shared the reference');
 w.fetch=referenceLibraryFetch;
 evaluate(`const countBeforeReferenceUpload=B.nodes.length;
  const referenceUpload=filename=>{
    const field=$("#versionRefUpdate [name=replacementFile]");
    Object.defineProperty(field,"files",{configurable:true,value:[new File(["fixture"],filename)]});
    return field.onchange();
  };
  vtOpenReferenceUpdate(groupReplacement);`);
 await evaluate('referenceUpload("wrong-type.png")');
 assert.match(evaluate('$("#versionRefUpdate [data-upload-status]").textContent'),/请选择视频文件/);
 await evaluate('referenceUpload("模板取景.mkv")');
 assert.match(evaluate('$("#versionRefUpdate [name=replacement] option:checked").textContent'),/模板取景（新上传）/);
 equal(evaluate('[B.nodes.length===countBeforeReferenceUpload,videoInputs(groupShot)[0].source===groupReplacement]'),
  [true,true],'uploading is staged until the replacement is confirmed');
 evaluate('$("#versionRefUpdate [data-cancel]").click();vtOpenReferenceUpdate(groupReplacement)');
 assert.doesNotMatch(evaluate('$("#versionRefUpdate [name=replacement]").textContent'),/新上传/);
 await evaluate('referenceUpload("模板取景.mkv")');
 evaluate('$("#versionRefUpdate form").dispatchEvent(new Event("submit",{cancelable:true}))');
 equal(evaluate(`[B.nodes.length===countBeforeReferenceUpload+1,videoInputs(groupShot)[0].source.name,
  videoInputs(groupShot)[0].edge.prompt_slot,videoInputs(groupShot)[0].version.source]`),
  [true,"模板取景",6,"upload"],'confirming creates the new source node and moves the reference to it');
 evaluate('undo()');
 equal(evaluate(`[B.nodes.length===countBeforeReferenceUpload,videoInputs(node(groupShot.id))[0].source.id===groupReplacement.id]`),
  [true,true],'undo restores the original reference and removes the node created in the same operation');
 const audioLibraryFetch=w.fetch, resolvedAudioAssets=[];
 const libraryAudio=[{id:"cast-voice",name:"演员声线",kind:"character",aliases:["渡船"],media:[
  {ref:"output:h3studio/voice-old.wav",type:"audio",seconds:2},
  {ref:"input:h3studio/alternate-voice.wav",type:"audio",seconds:7},
  {ref:"input:h3studio/full-interview.wav",type:"audio",seconds:80},
 ]},{id:"station-motion",name:"站台运镜",kind:"scene",tags:["环绕"],media:[
  {ref:"input:h3studio/station-motion.mp4",type:"video",w:864,h:480,seconds:9},
 ]}];
 w.fetch=async(url,options={})=>{
  const path=new URL(url,"http://oneshot.test").pathname;
  if(path==="/api/memory")return {ok:true,json:async()=>libraryAudio};
  if(path==="/api/memory/resolve"){
   const payload=JSON.parse(options.body);
   resolvedAudioAssets.push(payload);
   return {ok:true,json:async()=>libraryAudio.filter(asset=>payload.ids.includes(asset.id))};
  }
  return audioLibraryFetch(url,options);
 };
 evaluate(`const libraryAudioTarget=addNode("audio",4300,1650,{mode:"seed_audio"});
  selectOnly(libraryAudioTarget.id);
  const audioLibraryNodeCount=B.nodes.length;
  $("#refs [data-seed-library]").click();`);
 await ready('$("#referenceLibrary select").options.length===3','audio picker lists reusable clips under the duration limit');
 evaluate(`const audioLibraryQuery=$("#referenceLibrary input");
  audioLibraryQuery.value="渡船";audioLibraryQuery.dispatchEvent(new Event("input"));
  const audioLibraryPick=index=>{
    const choice=$("#referenceLibrary select");choice.selectedIndex=index;
    choice.dispatchEvent(new Event("change"));
  };
  audioLibraryPick(1);`);
 assert.match(evaluate('$("#referenceLibrary audio").src'),/voice-old\.wav/);
 await evaluate('$("#referenceLibrary form").onsubmit(new Event("submit"))');
 equal(evaluate('[B.nodes.length===audioLibraryNodeCount,libraryAudioTarget.data.references[0].node_id===versionCopyAudio.id,libraryAudioTarget.data.references[0].ref,node(versionCopyAudio.id).cur]'),
  [true,true,"output:h3studio/voice-old.wav",1],'reuse the historical canvas version without adding a duplicate or changing the current version');
 await evaluate('openReferenceLibrary(libraryAudioTarget,"audio")');
 equal(evaluate('$("#referenceLibrary select").options.length'),2,'an already linked audio version is omitted');
 await evaluate('audioLibraryPick(1);$("#referenceLibrary form").onsubmit(new Event("submit"))');
 equal(evaluate(`(()=>{
   const ref=libraryAudioTarget.data.references[1], source=node(ref.node_id);
   return [B.nodes.length,source.data.asset.id,curV(source).ref,B.edges.some(e=>e.from===source.id&&e.to===libraryAudioTarget.id&&e.slot===2)];
 })()`),[evaluate('audioLibraryNodeCount+1'),"cast-voice","input:h3studio/alternate-voice.wav",true]);
 assert.deepEqual(resolvedAudioAssets.map(body=>body.ids),[["cast-voice"],["cast-voice"]]);
 evaluate('undo()');
 equal(evaluate('[B.nodes.length===audioLibraryNodeCount,node(libraryAudioTarget.id).data.references.length]'),[true,1]);
 evaluate(`const libraryVideoTarget=addNode("video",4650,1650);
   const libraryVideoNodeCount=B.nodes.length;
   const openLibraryInput=kind=>{
     openAddMenu(110,150,{to:libraryVideoTarget});
     $("#addMenu [data-library-reference='"+kind+"']").click();
   };
   openLibraryInput("video");`);
 await ready('$("#referenceLibrary select").options.length===2','video picker lists saved footage');
 evaluate(`audioLibraryQuery.value="环绕";audioLibraryQuery.dispatchEvent(new Event("input"));audioLibraryPick(1);`);
 assert.match(evaluate('$("#referenceLibrary video").src'),/station-motion\.mp4/);
 assert.equal(evaluate('$("#referenceLibrary audio").hidden'),true);
 await evaluate('$("#referenceLibrary form").onsubmit(new Event("submit"))');
 equal(evaluate('[B.nodes.length===libraryVideoNodeCount+1,videoInputs(libraryVideoTarget)[0].edge.prompt_slot]'),[true,1]);
 evaluate('openLibraryInput("audio")');
 await ready('$("#referenceLibrary select").options.length===4','video node can pick an audio reference');
 evaluate('audioLibraryPick(1)');
 await evaluate('$("#referenceLibrary form").onsubmit(new Event("submit"))');
 equal(evaluate(`(()=>{
   const request=videoReq(libraryVideoTarget,"沿用 @视频{1} 的运镜和 @音{1} 的旁白");
   const [clip]=request.video_refs,[sound]=request.audio_refs;
   return [clip.ref,clip.start,clip.end,clip.prompt_slot,sound.node_id===versionCopyAudio.id,sound.version,sound.prompt_slot,
     B.nodes.length===libraryVideoNodeCount+1,request.prompt];
 })()`),["input:h3studio/station-motion.mp4",0,9,1,true,1,1,true,"沿用 @视频1 的运镜和 @音1 的旁白"]);
 evaluate('undo();undo()');
 equal(evaluate('[B.nodes.length===libraryVideoNodeCount,videoInputs(node(libraryVideoTarget.id)).length,audioInputs(node(libraryVideoTarget.id)).length]'),[true,0,0]);
 w.fetch=audioLibraryFetch;
 console.log('Library media references DOM passed: audio and video pickers, preview, pinned versions, request bindings and undo.');
 evaluate('restore(copyFlowBase)');
 console.log('Version copies and references DOM passed: keyboard menu, drag, pinned audio reference, read-only guard, provenance, video inputs and undo.');
};
