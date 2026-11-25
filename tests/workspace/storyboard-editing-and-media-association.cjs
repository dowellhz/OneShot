"use strict";

module.exports = async function storyboardEditingAndMediaAssociation(workspace, scenarioState) {
 const { assert, equal, evaluate, ready, w } = workspace;
 evaluate(`sortShotsButton.click();
  const currentRangeFrame=()=>node(rangeFollowingFrame.id);
  const rangeTail=()=>scriptTailEdges().get(rangeFollowingFrame.id);
  const tailRemoveBefore={prompt:currentRangeFrame().data.prompt,versions:JSON.stringify(currentRangeFrame().versions),ref:rangeTail().ref,source:rangeTail().from};
  const firstTailControls=$('[data-shot-tail-actions="0"]',$("#shotList"));
  $("[data-tail-remove]",firstTailControls).click();`);
 equal(evaluate(`[!!rangeTail(),currentRangeFrame().data.prompt===rangeFramePrompt,
  JSON.stringify(currentRangeFrame().versions)===tailRemoveBefore.versions,curV(node(tailRemoveBefore.source)).ref===tailRemoveBefore.ref]`),
  [false,true,true,true],'removing the first-shot tail clears just its generated instruction and retains the capture and history');
 evaluate(`sortShotsButton.dispatchEvent(new KeyboardEvent("keydown",{key:"z",ctrlKey:true,bubbles:true,cancelable:true}));`);
 equal(evaluate('[currentRangeFrame().data.prompt===tailRemoveBefore.prompt,rangeTail().ref===tailRemoveBefore.ref]'),
  [true,true],'undo restores the exact tail binding and prompt');
 evaluate(`sortShotsButton.click();
  $('[data-shot-order="0"] [data-step="1"]').click();
  $('[data-shot-order="1"] [data-step="1"]').click();
  node(rangePriorVideo.id).cur=0;drawEdges();`);
 const repairFetch=w.fetch, repairRequests=[];
 w.fetch=(url,options)=>{
  if(String(url)!=="/api/lastframe")return repairFetch(url,options);
  repairRequests.push(JSON.parse(options.body));
  return Promise.resolve({ok:true,text:async()=>JSON.stringify({ref:"input:h3studio/repaired-tail.png",w:64,h:64,at:4.9})});
 };
 const relinkButton=`$('[data-shot-tail-actions="2"] [data-tail-link]',$("#shotList"))`;
 assert.equal(evaluate(relinkButton+'.hidden'),false,'switching the prior version reveals a repair action');
 const beforeRepairSelection=evaluate('JSON.stringify([...sel])');
 evaluate(relinkButton+'.click()');
 await ready('rangeTail()?.ref==="input:h3studio/repaired-tail.png"','repair uses the new selected prior version');
 assert.equal(repairRequests[0].ref,evaluate('curV(node(rangePriorVideo.id)).ref'));
 equal(evaluate('[rangeTail().prompt_slot,currentRangeFrame().data.prompt===tailRemoveBefore.prompt,JSON.stringify([...sel])]'),
  [3,true,beforeRepairSelection],'repair keeps the slot, prompt and canvas selection stable');
 assert.match(evaluate('$("[data-script-tail-status=\'2\']",$("#shotList")).textContent'),/当前分镜图尚未使用/);
 w.fetch=repairFetch;
 console.log('Storyboard tail repair DOM passed: in-list refresh, targeted removal, original media retention and undo.');
 evaluate(`sortShotsButton.click();
  const liveRangeScript=node(runRangeScript.id), editedRangeShot=liveRangeScript.data.shots[2];
  const editedRangeVideo=node(rangeFollowingVideo.id);
  editedRangeVideo.data.fields.dialogue="节点独立台词";
  const editorHistory=JSON.stringify([currentRangeFrame().versions,editedRangeVideo.versions]);
  const editorLink=rangeTail().ref, editorAction=editedRangeShot.action;
  $('[data-edit-shot="2"]',$("#shotList")).click();
  const shotEditDialog=$("#shotEditor"), shotEditForm=$("form",shotEditDialog), shotEditSubmit=$("[type=submit]",shotEditForm);
  const shotEditValue=(name,value)=>{
    const field=shotEditForm.elements.namedItem(name);field.value=value;field.dispatchEvent(new Event("input",{bubbles:true}));
  };
  shotEditValue("keyframe","木盒已经打开");
  shotEditValue("action","推近木盒\\n抬头看窗外");
  shotEditValue("dialogue","林森：走吧。");
  editedRangeShot.action=["他人刚修改了动作"];
  shotEditSubmit.click();`);
 assert.match(evaluate('$("[role=status]",shotEditForm).textContent'),/镜头内容已变化/);
 equal(evaluate('[shotEditForm.elements.action.value,currentRangeFrame().data.prompt.includes("木盒已经打开")]'),
  ['推近木盒\n抬头看窗外',false],'conflicting edits preserve the form draft without overwriting the graph');
 evaluate('editedRangeShot.action=editorAction;shotEditSubmit.click()');
 equal(evaluate(`[editedRangeShot.action,editedRangeShot.dialogue,editedRangeVideo.data.fields.action,editedRangeVideo.data.fields.dialogue,
  currentRangeFrame().data.prompt.includes("木盒已经打开"),currentRangeFrame().data.prompt.includes("@图{3}"),
  rangeTail().ref===editorLink,JSON.stringify([currentRangeFrame().versions,editedRangeVideo.versions])===editorHistory]`),
  [['推近木盒','抬头看窗外'],['林森：走吧。'],'推近木盒\n抬头看窗外','节点独立台词',true,true,true,true],
  'manual edits sync to original image and video fields, retain local overrides and do not rewrite history');
 assert.match(evaluate('$("[role=status]",shotEditForm).textContent'),/同步了 2 个生成节点.*独立设置/);
 w.__memories=[...(w.__memories||[]),{id:"shot-edit-hero",name:"镜头角色",kind:"character",board:evaluate("boardId"),
  character_views:{main:"input:h3studio/shot-main.png",face:"input:h3studio/shot-face.png"}}];
 evaluate(`$("[data-shot-assets]",shotEditForm).open=true;
  const shotAssetQuery=$("[data-shot-asset-query]",shotEditForm);
  shotAssetQuery.value="镜头角";shotAssetQuery.dispatchEvent(new Event("input",{bubbles:true}));`);
 await ready('!!$("[data-add-shot-asset=shot-edit-hero]")','shot editor searches the accessible library');
 evaluate(`const shotAssetResult=$("[data-add-shot-asset=shot-edit-hero]").closest("li");
  $("select",shotAssetResult).value="face";$("button",shotAssetResult).click();shotEditSubmit.click();`);
 equal(evaluate(`[editedRangeShot.asset_refs.find(asset=>asset.id==="shot-edit-hero").view,
  currentRangeFrame().data.prompt.includes("@{shot-edit-hero#face|镜头角色}"),
  editedRangeVideo.data.fields.scene.includes("@{shot-edit-hero#face|镜头角色}")]`),
  ['face',true,true],'saving a shot reference updates both linked nodes');
 evaluate(`editedRangeVideo.data.fields.scene="节点独立场景";
  $('[data-remove-shot-asset][aria-label^="移除 镜头角色"]',shotEditForm).click();
  $("select",shotAssetResult).value="main";$("button",shotAssetResult).click();shotEditSubmit.click();`);
 equal(evaluate(`[editedRangeShot.asset_refs.find(asset=>asset.id==="shot-edit-hero").view,
  currentRangeFrame().data.prompt.includes("@{shot-edit-hero#main|镜头角色}"),
  currentRangeFrame().data.prompt.includes("@{shot-edit-hero#face|镜头角色}"),
  editedRangeVideo.data.fields.scene,JSON.stringify([currentRangeFrame().versions,editedRangeVideo.versions])===editorHistory]`),
  ['main',true,false,'节点独立场景',true],'view replacement preserves independently edited fields and history');
 assert.match(evaluate('$("[role=status]",shotEditForm).textContent'),/独立设置/);
 w.__memories=w.__memories.filter(asset=>asset.id!=="shot-edit-hero");
 const beforeEditRun=scenarioState.submittedBatches.length;
 evaluate('$("[data-run-shot-edit]",shotEditForm).click()');
 equal(evaluate('[shotEditDialog.open,$("#groupRunConfirm").open,$("#groupRunConfirm [name=mode]").value,$$("#groupRunConfirm ol li").length]'),
  [false,true,'all',2],'reviewing regeneration opens the existing two-node preview');
 assert.equal(scenarioState.submittedBatches.length,beforeEditRun,'editing and previewing do not trigger generation');
 console.log('Storyboard shot editor DOM passed: safe form save, local override protection, unchanged history and exact regeneration preview.');
 evaluate(`closeCanvasGroupRunDialog();
  const shotsBeforeStructure=rangeShotOrder(), graphBeforeStructure=JSON.stringify(B.edges), nodeCountBeforeStructure=B.nodes.length;
  const addShotButton=$("[data-add-shot]",$("#shotList")), placementShot=$("[data-shot-placement] select",shotEditForm);
  addShotButton.click();
  shotEditValue("keyframe","未保存的镜头");
  $("[data-close]",shotEditForm).click();`);
 const priorShotOrder=Array.from(evaluate('shotsBeforeStructure'));
 equal(evaluate('rangeShotOrder()'),priorShotOrder,'closing a new draft leaves the storyboard untouched');
 evaluate(`addShotButton.click();placementShot.value="0";
  shotEditValue("keyframe","远景，窗外天亮");
  shotEditValue("characters","林森，裴简");
  shotEditSubmit.click();`);
 equal(evaluate(`[rangeShotOrder().slice(1),liveRangeScript.data.shots[0].keyframe,liveRangeScript.data.shots[0].characters,
  B.nodes.length===nodeCountBeforeStructure,scriptShotLinks(liveRangeScript)[0]]`),
  [priorShotOrder,'远景，窗外天亮',['林森','裴简'],true,null],
  'adding at a chosen position stores a new independent shot without expanding or submitting it');
 evaluate(`editedRangeShot.frame={ref:"input:h3studio/existing-shot.png"};
  $('[data-edit-shot="3"]',$("#shotList")).click();
  $("[data-duplicate-shot]",shotEditForm).click();`);
 equal(evaluate('[placementShot.value,shotEditForm.elements.keyframe.value,liveRangeScript.data.shots.length]'),
  ['4','木盒已经打开',5],'copy starts an editable draft immediately after the chosen shot');
 evaluate(`shotEditSubmit.click();
  const duplicatedRangeShot=liveRangeScript.data.shots[4];`);
 equal(evaluate(`[duplicatedRangeShot.id!==editedRangeShot.id,duplicatedRangeShot.action,duplicatedRangeShot.action!==editedRangeShot.action,
  !!duplicatedRangeShot.frame,scriptShotLinks(liveRangeScript)[4]]`),
  [true,['推近木盒','抬头看窗外'],true,false,null],'copy duplicates the specification and leaves generated media attached to the original');
 equal(evaluate('[duplicatedRangeShot.asset_refs.find(asset=>asset.id==="shot-edit-hero").view,duplicatedRangeShot.asset_refs!==editedRangeShot.asset_refs]'),
  ['main',true],'copy preserves the shot reference without sharing its editable list');
 evaluate(`$('[data-edit-shot="3"]',$("#shotList")).click();
  $("[data-remove-shot]",shotEditForm).click();`);
 assert.match(evaluate('$("[role=status]",shotEditForm).textContent'),/图片、视频和历史版本会保留/);
 assert.equal(evaluate('liveRangeScript.data.shots.includes(editedRangeShot)'),true);
 evaluate('$("[data-confirm-shot-remove]",shotEditForm).click()');
 equal(evaluate(`[rangeShotOrder().includes(editedRangeShot.id),rangeShotOrder()[3]===duplicatedRangeShot.id,
  scriptShotLinks(liveRangeScript)[3],!!node(rangeFollowingVideo.id),B.nodes.length===nodeCountBeforeStructure,JSON.stringify(B.edges)===graphBeforeStructure]`),
  [false,true,null,true,true,true],'confirmed removal detaches the shot and leaves its canvas and history intact');
 evaluate('undo()');
 assert.equal(evaluate('scriptShotLinks(node(runRangeScript.id))[3].vid'),evaluate('rangeFollowingVideo.id'));
 assert.equal(scenarioState.submittedBatches.length,beforeEditRun);
 console.log('Storyboard structure DOM passed: insert, copy independent settings, detach while retaining media, and undo.');
 evaluate(`const sourceScriptForMedia=node(runRangeScript.id);
  const adoptedVideo=addNode("video",5300,200,{prompt:"独立上传素材"},{name:"已上传的片段",
    versions:[{ref:"input:h3studio/adopted-cut.mp4",w:1280,h:720,seconds:4}],cur:0});
  const adoptedStill=addNode("image",5650,200,{}, {name:"已生成的分镜图",versions:[rerunMedia("existing-still")],cur:0});
  const mediaVideoBefore=JSON.stringify(adoptedVideo);
  const originalAssociationEdges=JSON.stringify(B.edges);
  $('[data-shot-media="0"]',$("#shotList")).click();
  const mediaForm=$("#shotMediaPicker form"), [imagePicker,videoPicker]=$$("select",mediaForm);
  const mediaConfirm=$("[type=submit]",mediaForm);
  const chooseShotMedia=(picker,id)=>{picker.value=id;picker.dispatchEvent(new Event("change",{bubbles:true}));};`);
 equal(evaluate('[videoPicker.options[videoPicker.options.length-1].textContent,[...videoPicker.options].some(option=>option.value===rangeFollowingVideo.id)]'),
  ['已上传的片段 · 版本 1',false],'the picker identifies the active version and excludes videos already attached to another shot');
 evaluate('chooseShotMedia(videoPicker,adoptedVideo.id);mediaConfirm.click()');
 equal(evaluate('[scriptShotLinks(sourceScriptForMedia)[0].vid,JSON.stringify(B.edges)===originalAssociationEdges,JSON.stringify(adoptedVideo)===mediaVideoBefore]'),
  [evaluate('adoptedVideo.id'),true,true],'association reuses the node without inventing generation lineage');
 evaluate(`const previousMediaDraft=localStorage.getItem(filmDraftPrefix()+"latest");
  const filmStartForMedia=$("[data-film-from]",$("#shotList"));filmStartForMedia.selectedIndex=0;
  filmStartForMedia.dispatchEvent(new Event("change"));$("[data-film]",$("#shotList")).click();`);
 equal(evaluate('FILM.spec.clips.map(clip=>clip.ref)'),['input:h3studio/adopted-cut.mp4'],'the existing clip is available in the storyboard film path');
 evaluate(`const mediaTestDraft=FILM.key;closeFilm();localStorage.removeItem(mediaTestDraft);
  if(previousMediaDraft)localStorage.setItem(filmDraftPrefix()+"latest",previousMediaDraft);else localStorage.removeItem(filmDraftPrefix()+"latest");
  const countBeforeCompletingShot=B.nodes.length;
  openShotRangePicker(sourceScriptForMedia,null,{firstIndex:0,lastIndex:0});
  $("#shotRangePicker [type=submit]").click();
  const completedVideoPair=scriptShotLinks(sourceScriptForMedia)[0];`);
 equal(evaluate(`[B.nodes.length-countBeforeCompletingShot,completedVideoPair.vid===adoptedVideo.id,!!node(completedVideoPair.img),
  B.edges.some(edge=>edge.to===adoptedVideo.id),JSON.stringify(adoptedVideo)===mediaVideoBefore]`),
  [1,true,true,false,true],'filling a video-only shot creates just a frame node without rewriting the existing video');
 evaluate(`closeCanvasGroupRunDialog();
  $('[data-shot-media="4"]',$("#shotList")).click();
  chooseShotMedia(imagePicker,adoptedStill.id);mediaConfirm.click();
  const countBeforeMakingVideo=B.nodes.length;
  openShotRangePicker(sourceScriptForMedia,null,{firstIndex:4,lastIndex:4});
  $("#shotRangePicker [type=submit]").click();
  const completedImagePair=scriptShotLinks(sourceScriptForMedia)[4];`);
 equal(evaluate(`[B.nodes.length-countBeforeMakingVideo,completedImagePair.img===adoptedStill.id,
  B.edges.some(edge=>edge.from===adoptedStill.id&&edge.to===completedImagePair.vid&&edge.role==="first")]`),
  [1,true,true],'filling an image-only shot creates just a video node and sets its first-frame input');
 assert.equal(scenarioState.submittedBatches.length,beforeEditRun,'association and filling nodes do not submit a generation');
 console.log('Storyboard media association DOM passed: existing nodes, ordered editing and precise missing-node expansion.');
 evaluate('closeCanvasGroupRunDialog();$("#shotList [data-close]").click();AC.board=rangeAssistantBoard;restore(runRangeBase);save()');
 evaluate(`const copyFlowBase=snap();
  const copyAsset=(filename,fields={})=>({ref:"output:h3studio/"+filename,url:"/media?ref=output:h3studio/"+filename,...fields});
  const copyGuide=addNode("image",1200,700,{}, {versions:[copyAsset("guide.png",{w:512,h:512})],cur:0});
  const originalImage=addNode("image",1800,700,{prompt:"当前说明",count:4,asset:{id:"copy-fixture",kind:"character"}},
    {versions:[copyAsset("image-original.png",{prompt:"历史说明",w:768,h:1024,
      generation_record:{settings:{seed:17,ar:.75},inputs:[{node_id:copyGuide.id,ref:curV(copyGuide).ref}]}}),
      copyAsset("image-selected.png",{w:512,h:512})],cur:1});
  const useImage=addNode("video",2400,700);link(originalImage,useImage,true);
  const beforeVersionCopy=JSON.stringify(originalImage);
  $(".vtabs button",els.get(originalImage.id)).dispatchEvent(new KeyboardEvent("keydown",{key:"F10",shiftKey:true,bubbles:true,cancelable:true}));
  $("#videoTabMenu [data-version-copy]").click();
  const copiedImage=node([...sel][0]);`);
 equal(evaluate(`[JSON.stringify(originalImage)===beforeVersionCopy,copiedImage.type,curV(copiedImage).ref,copiedImage.data.prompt,
  copiedImage.data.seed,copiedImage.data.count,!!copiedImage.data.asset,
  B.edges.some(e=>e.from===copyGuide.id&&e.to===copiedImage.id),B.edges.some(e=>e.from===originalImage.id&&e.to===useImage.id),
  curV(copiedImage).copied_from.version]`),
 [true,"image","output:h3studio/image-original.png","历史说明",17,1,false,true,true,1],
 'copy from the version menu keeps the original and its downstream links, while restoring the selected result and its verified inputs');
 evaluate('undo()');
 assert(evaluate('!node(copiedImage.id) && node(originalImage.id).versions.length===2'));
 evaluate(`const versionCopyAudio=addNode("audio",3400,650,{prompt:"当前配乐",mode:"music"},{versions:[
  copyAsset("voice-old.wav",{seconds:2,audio_recipe:{mode:"tts",voice:"v1",prompt:"历史对白",speed:.9}}),
  copyAsset("music-now.wav",{seconds:4})],cur:1});
  const hitTestBefore=document.elementFromPoint;
  document.elementFromPoint=()=>vp;
  const historicalAudio=$(".vtabs button",els.get(versionCopyAudio.id));
  historicalAudio.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true,clientX:100,clientY:100}));
  window.dispatchEvent(new MouseEvent("pointermove",{clientX:500,clientY:450}));
  `);
 assert(evaluate('$(".version-drag-label.can-drop")?.textContent==="版本 1"'));
 evaluate(`window.dispatchEvent(new MouseEvent("pointerup",{clientX:500,clientY:450}));
  historicalAudio.click();
  document.elementFromPoint=hitTestBefore;
  const copiedAudio=node([...sel][0]);`);
 equal(evaluate('[versionCopyAudio.cur,copiedAudio.type,curV(copiedAudio).ref,curV(copiedAudio).seconds,copiedAudio.data.mode,copiedAudio.data.prompt,copiedAudio.data.voice,$(".version-drag-label")]'),
 [1,"audio","output:h3studio/voice-old.wav",2,"tts","历史对白","v1",null],'dragging copies the historical audio recipe and leaves the current version selected on the source');
 evaluate(`const seedVersionTarget=addNode("audio",3600,900,{mode:"seed_audio"});
  document.elementFromPoint=()=>$(".card",els.get(seedVersionTarget.id));
  const beforeVersionDrop=B.nodes.length;
  historicalAudio.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true,clientX:100,clientY:100}));
  window.dispatchEvent(new MouseEvent("pointermove",{clientX:520,clientY:470}));`);
 assert(evaluate('$(".version-drag-label.can-drop")?.textContent==="用作参考 · 版本 1"'));
 evaluate(`window.dispatchEvent(new MouseEvent("pointerup",{clientX:520,clientY:470}));
  document.elementFromPoint=hitTestBefore;`);
 equal(evaluate(`[versionCopyAudio.cur,B.nodes.length===beforeVersionDrop,
  seedVersionTarget.data.references[0].ref,B.edges.find(e=>e.to===seedVersionTarget.id).ref]`),
 [1,true,"output:h3studio/voice-old.wav","output:h3studio/voice-old.wav"],'dropping a historical tab on reference generation pins that version without copying or switching the source');
 evaluate(`const versionCopyVideo=node(useImage.id);versionCopyVideo.versions=[
  copyAsset("video-old.mp4",{w:640,h:480,seconds:5,input_edges:[{from:copyGuide.id,to:versionCopyVideo.id,role:"first"}],node_data:{...versionCopyVideo.data,prompt:"旧镜头"}}),
  copyAsset("video-new.mp4",{w:640,h:480,seconds:8})];versionCopyVideo.cur=1;render(versionCopyVideo);
  const copiedVideo=vtCopyVersion(versionCopyVideo,0);
  const versionCopyPriorAccess=B.access;B.access="reviewer";const readOnlyCopy=vtCopyVersion(versionCopyVideo,1);B.access=versionCopyPriorAccess;`);
 equal(evaluate('[versionCopyVideo.cur,copiedVideo.data.prompt,curV(copiedVideo).input_edges[0].to===copiedVideo.id,typeof readOnlyCopy]'),
 [1,"旧镜头",true,"boolean"],'copying a historical video keeps the live source separate and retargets the copied input');
 assert.equal(evaluate('readOnlyCopy'),false);
 evaluate(`const dropVersionOn=(source,index,target)=>{
  document.elementFromPoint=()=>$(".card",els.get(target.id));
  const tab=$(".vtabs button[data-i='"+index+"']",els.get(source.id));
  tab.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true,clientX:100,clientY:100}));
  window.dispatchEvent(new MouseEvent("pointermove",{clientX:520,clientY:470}));
  const accepted=!!$(".version-drag-label.can-drop");
  window.dispatchEvent(new MouseEvent("pointerup",{clientX:520,clientY:470}));
  document.elementFromPoint=hitTestBefore;
  return accepted;
 };
 const imageRefTarget=addNode("image",3650,950);
 const firstImageDrop=dropVersionOn(originalImage,0,imageRefTarget);
 const videoRefTarget=addNode("video",3650,1200);
 link(versionCopyVideo,videoRefTarget,true);
 const videoRefEdge=videoInputs(videoRefTarget)[0].edge;
 Object.assign(videoRefEdge,{start:1,end:3,prompt_slot:3});
 const historicalVideoDrop=dropVersionOn(versionCopyVideo,0,videoRefTarget);
 `);
 equal(evaluate(`[firstImageDrop,historicalVideoDrop,originalImage.cur,imageInputs(imageRefTarget)[0].version.ref,
  versionCopyVideo.cur,videoInputs(videoRefTarget).length,videoRefEdge.ref,videoRefEdge.prompt_slot,
  Object.hasOwn(videoRefEdge,"start"),Object.hasOwn(videoRefEdge,"end")]`),
 [true,true,1,"output:h3studio/image-original.png",1,1,"output:h3studio/video-old.mp4",3,false,false],
 'image and video drops pin the historical source, retain an existing reference slot, and clear an old video range');
 evaluate(`selectOnly(imageRefTarget.id);
  const versionMention=$("#prompt");
  versionMention.focus();versionMention.value="@"+originalImage.id+"#";
  versionMention.setSelectionRange(versionMention.value.length,versionMention.value.length);`);
 await evaluate('cmSuggest(versionMention)');
 equal(evaluate('CM.matches.map(item=>item.version)'),[2,1],'a trailing hash browses the source history');
 evaluate(`versionMention.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true,cancelable:true}));
  versionMention.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));`);
 equal(evaluate('[versionMention.value,imageInputs(imageRefTarget)[0].version.ref,originalImage.cur]'),
 ['@图{1} ','output:h3studio/image-original.png',1],'completion inserts a stable reference to the chosen image');
 evaluate(`selectOnly(seedVersionTarget.id);versionMention.focus();versionMention.value="@"+versionCopyAudio.id+"#2";
  versionMention.setSelectionRange(versionMention.value.length,versionMention.value.length);`);
 await evaluate('cmSuggest(versionMention)');
};
