"use strict";

module.exports = async function nodeOrganizingAndVoiceCommands(workspace, scenarioState) {
 const { assert, equal, evaluate, ready, w } = workspace;
 evaluate(`const fixedId=addNode("image",100,110000,{}, {name:"定稿图"}).id;
   const movableIds=[addNode("video",750,110200,{}, {versions:[copyAsset("movable-one.mp4")],cur:0}).id,
     addNode("video",800,111000,{}, {versions:[copyAsset("movable-two.mp4")],cur:0}).id];
   selectOnly(fixedId);
   const openNodeActions=id=>ctxMenu({target:els.get(id),clientX:150,clientY:110});
   $("#ntools [data-a=pin]").click();$("#nodePinMenu [data-a='pin:lilac']").click();
   openNodeActions(fixedId);$("#ctxMenu [data-a='lock-selection']").click();`);
 equal(evaluate('[node(fixedId).pin,node(fixedId).locked,$(".node-lock",els.get(fixedId)).hidden,!!$("#ntools [data-a=del]")]'),
  ['lilac',true,false,false]);
 evaluate('$("#nodeSearchBtn").click();$(".ns-status").value="lilac";$(".ns-status").dispatchEvent(new Event("change"))');
 equal(evaluate('$$("#nodeSearch li strong").map(el=>el.textContent.trim())'),['定稿图']);
 evaluate('$("#nodeSearch [data-close]").click()');
 evaluate(`sel=new Set([fixedId,movableIds[0]]);updateSel();
   $("#selectionTools [data-action=pin]").click();$("#nodePinMenu [data-a='pin:amber']").click();
   $("#nodePinBar [data-pin-color=amber]").click();`);
 equal(evaluate('[nodePins(node(fixedId)),$$(".node-pins .node-pin",els.get(fixedId)).length,$$(".ns-status option:checked").map(x=>x.value),$$("#nodeSearch li").length]'),
  [['lilac','amber'],2,['amber'],2],'adding a second color preserves the existing marker and opens the corresponding color group');
 evaluate('$("#nodeSearch [data-close]").click();$("#selectionTools [data-action=pin]").click()');
 assert.equal(evaluate('$("#nodePinMenu [data-a=\'pin:amber\']").getAttribute("aria-pressed")'),'true');
 evaluate('$("#nodePinMenu [data-a=\'pin:amber\']").click()');
 equal(evaluate('[nodePins(node(fixedId)),!!$("#nodePinBar [data-pin-color=amber]")]'),[['lilac'],false],
   'toggling a shared color removes only that color');
 evaluate('undo()');
 assert.equal(evaluate('!!$("#nodePinBar [data-pin-color=amber]")'),true,'undo restores the bar and the markers');
 evaluate('markCanvasNodes([fixedId,movableIds[0]],"amber")');
 evaluate(`$(".lbl",els.get(fixedId)).dispatchEvent(new MouseEvent("pointerdown",{button:0,clientX:150,clientY:100,bubbles:true}));
   window.dispatchEvent(new MouseEvent("pointermove",{clientX:240,clientY:170}));
   window.dispatchEvent(new MouseEvent("pointerup",{clientX:240,clientY:170}));`);
 assert.equal(evaluate('node(fixedId).x'),100);
 evaluate(`sel=new Set([fixedId,...movableIds]);updateSel();
   const movablePrior=node(movableIds[0]).x;
   document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true,cancelable:true}));
   const movableShift=node(movableIds[0]).x-movablePrior;
   ctArrange("grid",[fixedId,...movableIds]);ctGroup();
   const groupPositions=()=>[fixedId,...movableIds].map(id=>[node(id).x,node(id).y]);
   const beforeGroupDrag=JSON.stringify(groupPositions());
   const lockedGroup=(B.groups||[]).find(g=>g.nodes.includes(fixedId));
   const groupHeader=$(".cg-head",CT_GROUPS.get(lockedGroup.id));
   ctDragGroup({target:groupHeader,button:0,clientX:100,clientY:100,preventDefault(){},stopPropagation(){}},lockedGroup);
   window.dispatchEvent(new MouseEvent("pointermove",{clientX:200,clientY:200}));
   window.dispatchEvent(new MouseEvent("pointerup",{clientX:200,clientY:200}));`);
 equal(evaluate('[movableShift,[node(fixedId).x,node(fixedId).y],JSON.stringify(groupPositions())===beforeGroupDrag]'),[10,[100,110000],true]);
 evaluate('markCanvasNodes([movableIds[0]],true,{lock:true})');
 assert.match(evaluate('vtMergeInfo(movableIds).error'),/先解锁/);
 evaluate('markCanvasNodes([movableIds[0]],false,{lock:true});sel=new Set([fixedId,...movableIds]);updateSel();openNodeActions(fixedId);$("#ctxMenu [data-a=del]").click()');
 equal(evaluate('[!!node(fixedId),movableIds.map(id=>!!node(id)),[...sel]]'),[true,[false,false],[evaluate('fixedId')]]);
 evaluate('undo();selectOnly(fixedId);$("#ntools [data-a=unlock-node]").click();undo()');
 assert.equal(evaluate('node(fixedId).locked'),true,'undo restores the lock');
 evaluate('const originalAccess=B.access;B.access="reviewer";openNodeActions(fixedId);markCanvasNodes([fixedId],"rose");removeNodes([fixedId])');
 equal(evaluate('[!!$("#ctxMenu .node-pin-menu"),node(fixedId).pin,node(fixedId).locked]'),[false,'lilac',true]);
 evaluate('closeMenus();B.access=originalAccess;const lockBase={nodes:[{id:"locktest",x:10,y:20}]};');
 equal(evaluate('acMerge(lockBase,{nodes:[{id:"locktest",x:300,y:400}]},{nodes:[{id:"locktest",x:10,y:20,locked:true}]}).nodes[0]'),
  {id:'locktest',x:10,y:20,locked:true});
 const lockSaveFetch=w.fetch;
 let lockSaved;
 w.fetch=async(url,options={})=>{
  if(options.method==='PUT' && String(url).startsWith('/api/board/'))lockSaved=JSON.parse(options.body);
  return lockSaveFetch(url,options);
 };
 await evaluate('save();flushSave()');
 const savedLock=lockSaved.nodes.find(n=>n.id===evaluate('fixedId'));
 equal([savedLock.pin,savedLock.locked],['lilac',true]);
 w.fetch=lockSaveFetch;
 evaluate('selectOnly(fixedId);$("#ntools [data-a=unlock-node]").click();removeNodes([fixedId])');
 assert.equal(evaluate('!!node(fixedId)'),false,'an explicitly unlocked node can be deleted');
 console.log('Node organization passed: color marks and search, protected movement and deletion, merge, undo, collaboration and serialized state.');
 evaluate(`const guideId=addNode("text",40,120000,{text:"跟随参考线"}).id;
   const guideNeighborId=addNode("text",300,120250,{text:"对齐目标"}).id;
   B.view={x:0,y:-59910,k:.5};applyView();
   const layoutPrefs=key=>$("[data-canvas-layout="+key+"]");
   const activeGuideCount=()=>$$("#canvasDragGuides line").filter(line=>line.style.display!=="none").length;
   const layoutDragStart=(id,x,y)=>$(".lbl",els.get(id)).dispatchEvent(new MouseEvent("pointerdown",{button:0,clientX:x,clientY:y,bubbles:true}));
   const layoutPointer=(type,x,y,altKey=false)=>window.dispatchEvent(new MouseEvent(type,{clientX:x,clientY:y,altKey}));
   $("#canvasLayoutBtn").click();layoutPrefs("guides").click();`);
 equal(evaluate('[layoutPrefs("guides").checked,layoutPrefs("grid").checked,localStorage.getItem("h3.canvasGuides"),$("#canvasLayoutBtn").getAttribute("aria-expanded")]'),
  [true,false,'1','true']);
 evaluate('layoutPrefs("guides").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');
 equal(evaluate('[!!$("#canvasLayoutMenu.on"),document.activeElement.id]'),[false,'canvasLayoutBtn']);
 evaluate('layoutDragStart(guideId,100,140);layoutPointer("pointermove",227,143)');
 equal(evaluate('[node(guideId).x,activeGuideCount(),Number($("#canvasDragGuides line").getAttribute("x1"))]'),[300,1,150]);
 evaluate('layoutPointer("pointermove",227,143,true)');
 equal(evaluate('[node(guideId).x,activeGuideCount()]'),[294,0]);
 evaluate('layoutPointer("pointerup",227,143)');
 equal(evaluate('[node(guideId).x,activeGuideCount()]'),[300,0]);
 evaluate('undo();const dragHistorySize=undoStack.length;layoutDragStart(guideId,100,140);layoutPointer("pointermove",227,143);layoutPointer("pointercancel",227,143)');
 equal(evaluate('[node(guideId).x,activeGuideCount(),undoStack.length]'),[40,0,evaluate('dragHistorySize')]);
 evaluate(`$("#canvasLayoutBtn").click();layoutPrefs("guides").click();layoutPrefs("grid").click();closeMenus();
   const otherPlacedId=addNode("text",95,120070,{text:"同组选区"}).id;
   B.view={x:0,y:-119900,k:1};applyView();sel=new Set([guideId,otherPlacedId]);updateSel();
   layoutDragStart(guideId,120,160);layoutPointer("pointermove",144,179);layoutPointer("pointerup",144,179);`);
 equal(evaluate('[node(guideId).x,node(guideId).y,node(otherPlacedId).x-node(guideId).x,node(otherPlacedId).y-node(guideId).y,activeGuideCount(),localStorage.getItem("h3.canvasGrid")]'),
  [55,120021,55,70,0,'1']);
 evaluate(`ctGroup(true);const snapGroup=B.groups.find(g=>g.nodes.includes(guideId));
   ctDragGroup({target:$(".cg-head",CT_GROUPS.get(snapGroup.id)),button:0,clientX:120,clientY:160,preventDefault(){},stopPropagation(){}},snapGroup);
   layoutPointer("pointermove",149,183);layoutPointer("pointerup",149,183);`);
 equal(evaluate('[(snapGroup.fold.x-11)%22,(snapGroup.fold.y-11)%22,node(otherPlacedId).x-node(guideId).x,node(guideNeighborId).x]'),
  [0,0,55,300]);
 console.log('Canvas drag alignment passed: settings, zoom-scaled guides, modifier bypass, undo, pointer cancellation, grid and folded group offsets.');
 scenarioState.voicePointFetch = w.fetch;
 scenarioState.failPlacementSend = false;
 scenarioState.voiceCommand = null;
 scenarioState.deferNodeTranscript = false;
 scenarioState.finishNodeTranscript = undefined;
 scenarioState.voiceSignal = undefined;
 scenarioState.voiceRequests = [];
 scenarioState.voiceStops = [];
 w.fetch=async(url,options={})=>{
  if(options.method==="POST" && String(url).split("?")[0]==="/api/transcription" && scenarioState.voiceCommand!==null) {
   scenarioState.voiceSignal=options.signal;
   scenarioState.voiceRequests.push({url:String(url),size:options.body.get("file").size});
   return {ok:true,json:()=>scenarioState.deferNodeTranscript
    ? new Promise(resolve=>{w.__nodeTranscriptPending=true;scenarioState.finishNodeTranscript=()=>resolve({text:scenarioState.voiceCommand});})
    : Promise.resolve({text:scenarioState.voiceCommand})};
  }
  if(options.method==="POST" && /^\/api\/chat\/runs\/voice-scope-[^/]+\/stop$/.test(String(url))){
   scenarioState.voiceStops.push(String(url));
   return {ok:true,json:async()=>({ok:true})};
  }
  if(options.method==='POST' && /^\/api\/chat\/sessions\/[^/]+\/messages$/.test(String(url))){
   w.__chatPayload=JSON.parse(options.body);
   if(scenarioState.failPlacementSend){scenarioState.failPlacementSend=false;return {ok:false,json:async()=>({error:'模拟发送失败'})};}
   return {ok:true,json:async()=>({id:'voice-point-run',state:'done'})};
  }
  return scenarioState.voicePointFetch(url,options);
 };
 await evaluate('acOpen({focus:false})');
 await ready('acVoiceAvailable && AC.session','voice shortcut capabilities and session are available');
 evaluate(`AC.refs=null;AC.selection=null;AC.reviews=[];AC.referencePins.clear();
   $("#acInput").value="";sel.clear();updateSel();
   const voicedImage=addNode("image",250,130000,{}, {name:"语音参考图",versions:[
    copyAsset("voice-original.png"),copyAsset("voice-later.png")],cur:0});
   const voicedAudio=addNode("audio",450,130000,{}, {name:"语音参考配乐",versions:[copyAsset("voice-music.wav")],cur:0});
   $(".card",els.get(voicedAudio.id)).getBoundingClientRect=()=>({left:780,top:400,width:80,height:60});
   window.__chatPayload=null;window.__heldStops=0;
   Object.defineProperty(navigator,"mediaDevices",{configurable:true,value:{
    getUserMedia:async()=>({getTracks:()=>[{stop(){window.__heldStops++;}}]})
   }});
   window.MediaRecorder=class {
    static isTypeSupported(){return true;}
    start(timeslice){this.state="recording";this.timeslice=timeslice;}
    stop(){this.state="inactive";queueMicrotask(()=>{
     this.ondataavailable({data:new Blob([this.timeslice?"full recording":"segment"],{type:"audio/webm"})});this.onstop();
    });}
   };
   const voiceKey=(type,key="r",code="KeyR",target=document.body)=>target.dispatchEvent(new KeyboardEvent(type,{key,code,bubbles:true,cancelable:true}));
   $("#acClose").click();voiceKey("keydown");`);
 await ready('acVoiceActive?.phase==="recording" && AC.open','holding the key opens the assistant and starts recording');
 evaluate(`$(".card",els.get(voicedImage.id)).dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true,cancelable:true}));
   vp.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true,cancelable:true,clientX:770,clientY:390}));
   window.dispatchEvent(new MouseEvent("pointermove",{clientX:875,clientY:470}));
   window.dispatchEvent(new MouseEvent("pointerup",{clientX:875,clientY:470}));
   const spokenTarget=toW(620,440);
   vp.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true,cancelable:true,clientX:620,clientY:440}));
   window.dispatchEvent(new MouseEvent("pointerup",{clientX:620,clientY:440}));
   switchVersion(voicedImage,1);`);
 equal(evaluate('[...acVoiceActive.refs.keys()]'),[evaluate('voicedImage.id'),evaluate('voicedAudio.id')]);
 assert.equal(evaluate('els.get(voicedImage.id).classList.contains("ac-voice-reference")'),true);
 equal(evaluate('[$("#acPlacementMarker").hidden,$("#acPlacementMarker").style.left]'),[false,'620px']);
 evaluate('voiceKey("keyup")');
 await ready('window.__chatPayload?.selected_versions?.length===2 && !AC.sending','release sends the transcript and exact reference versions').catch(error=>{
  throw new Error(error.message+': '+JSON.stringify(evaluate('[acVoiceActive?.phase, $("#acVoiceStatus").textContent, $("#acInput").value, $("#toast").textContent, AC.session, AC.board, boardId, window.__chatPayload]')));
 });
 equal(w.__chatPayload.selected_versions,[
  {node_id:evaluate('voicedImage.id'),ref:'output:h3studio/voice-original.png'},
  {node_id:evaluate('voicedAudio.id'),ref:'output:h3studio/voice-music.wav'},
 ]);
 equal(w.__chatPayload.placement,JSON.parse(evaluate('JSON.stringify({x:Math.round(spokenTarget.x),y:Math.round(spokenTarget.y)})')));
 assert.equal(evaluate('$("#acPlacementMarker").hidden'),true,'the sent marker clears from the canvas');
 equal(evaluate('[activeGuideCount(),!!$(".node.ac-voice-reference"),window.__heldStops]'),[0,false,1]);
 evaluate('window.__chatPayload=null;$("#acInput").value="现有草稿";voiceKey("keydown")');
 await ready('acVoiceActive?.phase==="recording"','the shortcut starts another recording');
 evaluate('voiceKey("keyup")');
 await ready('$("#acVoiceStatus").textContent==="已添加到草稿"','a pre-existing draft remains available for review');
 equal(evaluate('[$("#acInput").value,window.__chatPayload]'),['现有草稿\n把背景调暖',null]);
 evaluate('$("#acVoiceKey").value="Space";$("#acVoiceKey").dispatchEvent(new Event("change"));voiceKey("keydown"," ","Space")');
 await ready('acVoiceActive?.phase==="recording"','the configured space shortcut starts recording');
 evaluate('voiceKey("keydown","Escape","Escape",$("#acInput"));voiceKey("keyup"," ","Space")');
 equal(evaluate('[acVoiceActive,spaceDown,window.__chatPayload,localStorage.getItem("h3.chat.voiceKey")]'),[null,false,null,'Space']);
 evaluate('voiceKey("keydown"," ","Space",$("#acInput"))');
 assert.equal(evaluate('acVoiceActive'),null,'typing a space cannot activate recording');
 scenarioState.voiceCommand="停止当前任务。";
 evaluate(`const voiceSelector=$("#acVoiceKey");
   voiceSelector.value="custom";voiceSelector.dispatchEvent(new Event("change"));
   voiceKey("keydown","q","KeyQ",voiceSelector);
   AC.runs=[{id:"voice-scope-original",state:"running"}];window.__chatPayload=null;
   voiceKey("keydown","q","KeyQ");`);
 await ready('acVoiceActive?.phase==="recording"','custom shortcut starts a scoped voice command');
 equal(evaluate('[voiceSelector.value,localStorage.getItem("h3.chat.voiceKey")]'),['KeyQ','KeyQ']);
 evaluate('voiceKey("keyup","q","KeyQ")');
 await ready('$("#acVoiceStatus").textContent==="已请求停止当前任务"','voice sends the stop request and acknowledges it');
 assert.deepEqual(scenarioState.voiceStops,["/api/chat/runs/voice-scope-original/stop"]);
 equal(evaluate('[$("#acInput").value,window.__chatPayload]'),['现有草稿\n把背景调暖',null]);
 evaluate(`AC.runs=[{id:"voice-scope-ending",state:"running"}];voiceKey("keydown","q","KeyQ");`);
 await ready('acVoiceActive?.phase==="recording"','recording captures the active task before the queue advances');
 evaluate(`AC.runs=[{id:"voice-scope-next",state:"running"}];voiceKey("keyup","q","KeyQ");`);
 await ready('$("#acVoiceStatus").textContent==="录音开始时的任务已无法停止"','the newly activated task is spared');
 assert.equal(scenarioState.voiceStops.length,1);
 assert.equal(evaluate('window.__chatPayload'),null);
 evaluate('AC.runs=[];voiceSelector.value="Space";voiceSelector.dispatchEvent(new Event("change"))');
 scenarioState.voiceCommand=null;
 console.log('Voice command DOM passed: custom shortcut, draft preservation, scoped stop and queue transition.');
};
