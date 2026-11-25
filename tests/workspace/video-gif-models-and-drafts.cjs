"use strict";

module.exports = async function videoGifModelsAndDrafts(workspace, scenarioState) {
 const { assert, equal, evaluate, jobs, ready, w } = workspace;
 w.fetch=scenarioState.trimFetch;
 const gifFetch=w.fetch,gifCalls=[],gridGifCalls=[];
 const gifResult={ref:'output:h3studio/gif_test.gif',width:256,height:144,seconds:1.75,size_bytes:4800};
 w.fetch=async(url,opts)=>{
   if(String(url)==='/api/video/gif')gifCalls.push(JSON.parse(opts.body));
   else if(String(url)==='/api/image/gif')gridGifCalls.push(JSON.parse(opts.body));
   else return gifFetch(url,opts);
   return {ok:true,text:async()=>JSON.stringify(gifResult)};
 };
 evaluate(`const gifBefore=JSON.stringify(B.nodes);
   ctxMenu({target:els.get(clipSource.id),clientX:140,clientY:120});$("#ctxMenu [data-a=gif-export]").click();
   const gifForm=$("#videoGif form"),gifVideo=$("video",gifForm);
   gifVideo.pause=()=>{};
   gifForm.elements.start.value=1;
   gifForm.elements.end.value=2;
   gifForm.elements.size.value=256;gifForm.elements.fps.value=8;gifForm.elements.pingPong.checked=true;
   gifForm.dispatchEvent(new Event("input",{bubbles:true}));
   gifForm.dispatchEvent(new Event("submit",{cancelable:true}));`);
 await ready('!$("#videoGif .gif-preview").hidden','GIF preview and download appear');
 equal(gifCalls,[{ref:'input:h3studio/reference1.mp4',start:1,end:2,fps:8,size:256,ping_pong:true}],
   'the canvas GIF export uses the pinned source, range and loop settings');
 equal(evaluate(`[$("#videoGif a").download,$("#videoGif .gif-preview img").getAttribute("src"),JSON.stringify(B.nodes)===gifBefore]`),
   ['gif_test.gif','/media?ref=output%3Ah3studio%2Fgif_test.gif',true]);
 assert.match(evaluate(`acResultCards(${JSON.stringify({gif:gifResult})})`),/下载 GIF/);
 evaluate(`const gifPublish=$("[data-gif-publish]",gifForm);
   if(gifPublish.hidden)throw new Error("The owner cannot publish a generated GIF");
   gifForm.elements.end.value=1.1;gifForm.dispatchEvent(new Event("input",{bubbles:true}));
   if(!$("button[type=submit]",gifForm).disabled||!$("#videoGif .gif-preview").hidden)throw new Error("Invalid interval still exportable");
   gifForm.elements.end.value=2;gifForm.dispatchEvent(new Event("input",{bubbles:true}));
   gifForm.dispatchEvent(new Event("submit",{cancelable:true}));`);
 await ready('!$("#videoGif .gif-preview").hidden','GIF preview shows publication action');
 evaluate(`const savedGifShareOpen=shareOpen, savedGifShowcaseChange=changeShowcase, capturedGifPublication=[];
   const oldGifShare=[$("#canvasShare").hidden,$("#shareShowcase").disabled];
   shareOpen=async()=>{$("#canvasShare").hidden=false;$("#shareShowcase").disabled=false;};
   changeShowcase=(...args)=>capturedGifPublication.push(args);
   gifPublish.click();`);
 await ready('$("#shareShowcaseVideo").value==="gif-export"','the publication form opens on the rendered GIF');
 equal(evaluate('[$("#videoGif").open,$("#shareShowcaseVideoFile").required,$("#shareShowcaseAttachPrompt").checked]'),
   [false,false,false],'the export handoff preserves GIF selection and leaves prompt opt-in disabled');
 evaluate(`$("#shareShowcaseForm").dispatchEvent(new Event("submit",{cancelable:true}));`);
 equal(evaluate('[capturedGifPublication[0][2].gif_ref,capturedGifPublication[0][2].video,capturedGifPublication[0][2].public_prompt]'),
   ['output:h3studio/gif_test.gif',null,null]);
 evaluate(`shareOpen=savedGifShareOpen;changeShowcase=savedGifShowcaseChange;
   $("#canvasShare").hidden=oldGifShare[0];$("#shareShowcase").disabled=oldGifShare[1];$("#shareShowcaseForm").hidden=true;`);
 evaluate(`const gifGridSource=node("n1"), gifGridRef=curV(gifGridSource).ref, beforeGridGif=JSON.stringify(B.nodes);
   ctxMenu({target:els.get(gifGridSource.id),clientX:140,clientY:120});
   $("#ctxMenu [data-a=gif-export]").click();`);
 equal(evaluate('[$("#videoGifTitle").textContent,gifVideo.hidden,$$("[data-gif-cells] span").length,gifForm.elements.fps.value]'),
  ['宫格生成 GIF',true,16,'8']);
 evaluate(`for(const [name,value] of [["rows",2],["cols",3],["first",2],["last",5]]){
   const field=gifForm.elements[name];field.value=value;field.dispatchEvent(new Event("input",{bubbles:true}));
  }`);
 equal(evaluate('$$("[data-gif-cells] [data-selected]").map(cell=>cell.textContent)'),['2','3','4','5']);
 evaluate(`gifForm.dispatchEvent(new Event("submit",{cancelable:true}));`);
 await ready('!$("#videoGif .gif-preview").hidden','the image grid GIF result is available');
 equal(gridGifCalls,[{ref:evaluate('gifGridRef'),rows:2,cols:3,first:2,last:5,fps:8,size:360,ping_pong:false}],
  'image GIF uses the agreed row-major range and exact canvas version');
 assert.equal(evaluate('JSON.stringify(B.nodes)===beforeGridGif'),true);
 evaluate('closeVideoGif()');
 w.fetch=gifFetch;
 console.log('GIF export DOM passed: video interval, image grid, preview, download, publication and assistant result card.');
 evaluate(`const beforeModelOptions=snap(), previousVideoServices=CAPS_LIST.video;
  CAPS_LIST.video=[{id:"h3-fixture",kind:"minimax",name:"云端 H3",default:true,
                    model:"MiniMax-H3",default_route_model:"MiniMax-H3-Max",
                    models:[{id:"MiniMax-H3",durations:[4,5,15],qualities:{std:"768P",hd:"2K"}},
                            {id:"MiniMax-H3-Max",durations:[5,15],qualities:{std:"480P",hd:"768P"}}]},
                   {id:"flash-fixture",kind:"kling",name:"可灵 Flash",model:"kling-4.0-flash",
                    models:[{id:"kling-4.0-flash",durations:[3,20],qualities:{std:"720p"}}]},
                   {id:"ark-endpoint",kind:"ark",name:"方舟接入点",model:"ep-example",
                    models:[{id:"ep-example",endpoint_model:"doubao-seedance-2-5",durations:[5,15,30],
                             qualities:{std:"720p",hd:"1080p","4k":"4k"}}]}];
  const optionsVideo=addNode("video",420,90,{prompt:"测试可用选项",duration:4,quality:"hd"});
  selectOnly(optionsVideo.id);`);
 equal(evaluate(`[$("#ctl select[data-k=duration]").value, $("#ctl select[data-k=quality]").selectedOptions[0].textContent,
  videoReq(optionsVideo,"测试").duration]`),['5','768P',5]);
 evaluate(`optionsVideo.data.provider="flash-fixture";optionsVideo.data.duration=23;showPanel();`);
 equal(evaluate(`[$("#ctl select[data-k=duration]").value,!!$("#ctl select[data-k=quality]"),
  videoReq(optionsVideo,"测试").duration,videoReq(optionsVideo,"测试").quality]`),['20',false,20,'std']);
 evaluate(`Object.assign(optionsVideo.data,{provider:"ark-endpoint",selected_model:"ep-example",duration:30,quality:"4k"});showPanel();`);
 equal(evaluate(`[$("#ctl select[data-k=selected_model]").selectedOptions[0].textContent,
  $("#ctl select[data-k=quality]").value,videoReq(optionsVideo,"测试").duration]`),
  ['ep-example · doubao-seedance-2-5','4k',30]);
 evaluate(`CAPS_LIST.video.unshift({id:"local_h3",kind:"local_h3",local:true,name:"本地 H3",model:"h3-video",
  models:[{id:"h3-video",label:"H3 BF16"},{id:"h3-video-ref2va-int8-convrot",label:"H3 Ref2VA INT8 ConvRot"}]});
  showPanel();
  $("#ctl select[data-k=provider]").value="local_h3";
  $("#ctl select[data-k=provider]").dispatchEvent(new Event("change"));
  $("#ctl select[data-k=selected_model]").value="h3-video-ref2va-int8-convrot";
  $("#ctl select[data-k=selected_model]").dispatchEvent(new Event("change"));`);
 equal(evaluate(`[videoPreviewRequest(optionsVideo).provider,videoPreviewRequest(optionsVideo).selected_model,
   $("#ctl select[data-k=selected_model]").selectedOptions[0].textContent]`),
  ['local_h3','h3-video-ref2va-int8-convrot','H3 Ref2VA INT8 ConvRot']);
 equal(evaluate(`(()=>{const data={};vtRestoreVideoModel(data,{video_recipe:videoPreviewRequest(optionsVideo)});return data;})()`),
  {provider:'local_h3',selected_model:'h3-video-ref2va-int8-convrot'});
 evaluate(`$("#ctl select[data-k=selected_model]").value="";
  $("#ctl select[data-k=selected_model]").dispatchEvent(new Event("change"));`);
 equal(evaluate(`[!!videoPreviewRequest(optionsVideo).selected_model,
  $("#ctl select[data-k=selected_model]").selectedOptions[0].textContent]`),[false,'默认 · H3 BF16']);
 evaluate('CAPS_LIST.video=previousVideoServices;restore(beforeModelOptions)');
 console.log('Video model settings passed: configured default model, provider-specific durations and single-resolution submission.');
 const checkedPreviewFetch=w.fetch, checkedSubmissions=[], modelChecks=[];
 let rejectPreview=false;
 w.fetch=async(url,options)=>{
  const path=String(url);
  if(path==="/api/preview" && rejectPreview)return {ok:false,text:async()=>JSON.stringify({error:"参考视频超过 15 秒"})};
  if(path==="/api/preview")return {ok:true,text:async()=>JSON.stringify({
    reference_preview:"a".repeat(64),prompt:"采用资产里的图片和音频",mode:"全模态参考",inputs:[]})};
  if(path==="/api/video/reference-models"){
   modelChecks.push(JSON.parse(options.body));
   return {ok:true,text:async()=>JSON.stringify({counts:{images:1,videos:1,audio:1},models:[
    {provider:"方舟",provider_id:"ark-model",model:"seedance-short",duration:10,quality:"hd",resolution:"1080p",
     limits:{images:9,videos:3,audio:3,seconds:15},error:"参考视频超过 15 秒"},
    {provider:"方舟",provider_id:"ark-model",model:"seedance-long",duration:10,quality:"hd",resolution:"1080p",
     limits:{images:30,videos:10,audio:10,seconds:30},video_seconds:16,audio_seconds:3,draft:false},
   ]})};
  }
  if(path!=="/api/generate")return checkedPreviewFetch(url,options);
  const req=JSON.parse(options.body), jobId="checked-reference-"+checkedSubmissions.length;
  checkedSubmissions.push(req);
  jobs.set(jobId,{state:"error",error:"模拟停止"});
  return {ok:true,text:async()=>JSON.stringify({ids:[jobId]})};
 };
 evaluate(`const beforeCheckedPreview=snap(), checkedVideo=addNode("video",450,90,{prompt:"按 @样品素材 动作"});
  selectOnly(checkedVideo.id);`);
 await evaluate("previewPrompt(checkedVideo)");
 evaluate("closePromptPreview()");
 await evaluate("generate(checkedVideo)");
 await ready("!checkedVideo.job","preview-bound generation finished",350);
 assert.equal(checkedSubmissions[0].reference_preview,"a".repeat(64));
 evaluate('checkedVideo.data.duration=10');
 await evaluate("generate(checkedVideo)");
 await ready("!checkedVideo.job","edited request finished",350);
 assert.equal(Object.hasOwn(checkedSubmissions[1],"reference_preview"),false);
 rejectPreview=true;
 await evaluate("previewPrompt(checkedVideo)");
 assert.match(evaluate('$("#pvm").textContent'),/预览失败.*超过 15 秒/);
 evaluate('$("#pvModelCheck").click()');
 await ready('$("#pvModelStatus").textContent==="1 / 2 个模型可用"','failed previews still offer model compatibility checks');
 assert.equal(modelChecks[0].prompt,"按 @样品素材 动作");
 equal(evaluate('[$$("#pvModelList button").length,$$("#pvModelList li")[0].textContent.includes("超过 15 秒"),$("#pvModelList").textContent.includes("16/30 秒")]'),
  [1,true,true],'model reports show limits and only valid choices can be applied');
 rejectPreview=false;
 evaluate('$("#pvModelList button").click()');
 await ready('$("#pvm").textContent==="全模态参考"','selected model is set and previewed again');
 equal(evaluate('[checkedVideo.data.provider,checkedVideo.data.selected_model,checkedVideo.data.duration,checkedVideo.data.quality]'),
  ['ark-model','seedance-long',10,'hd']);
 assert.equal(checkedSubmissions.length,2,'checking or applying a model does not submit');
 evaluate('closePromptPreview()');
 evaluate("restore(beforeCheckedPreview)");
 w.fetch=checkedPreviewFetch;
 console.log('Mixed reference preview passed: submitting reviewed assets is pinned until the node inputs change.');
 const nativeDraftFetch=w.fetch, nativeDraftReq=[];
 let branchSaveFailure=true, branchTransportFailure=true, branchProviderFailure=true;
 w.fetch=async(url,opts)=>{
   const path=String(url);
   if(path==="/api/board/btest"&&opts?.method==="PUT"&&branchSaveFailure&&
      JSON.parse(opts.body).nodes.some(n=>n.draft_finalize_attempt?.placement==="branch")){
     branchSaveFailure=false;
     return {ok:false,status:503,json:async()=>({error:"画布写入失败"})};
   }
   if(!['/api/generate','/api/video/draft/finalize'].includes(path))return nativeDraftFetch(url,opts);
   const payload=JSON.parse(opts.body);nativeDraftReq.push(payload);
   const branch=path==='/api/video/draft/finalize'&&payload.resolution==="1080p";
   if(branch&&branchTransportFailure){branchTransportFailure=false;throw new Error("连接中断");}
   const id=path==='/api/generate'?'native-draft':branch?'native-branch':'native-final';
   if(branch&&branchProviderFailure){
     branchProviderFailure=false;
     jobs.set(id,{state:'error',error:'定稿任务失败'});
     return {ok:true,text:async()=>JSON.stringify({ids:[id]})};
   }
   const ref='output:h3studio/'+id+'.mp4';
   jobs.set(id,{state:'done',meta:{mode_name:id,provider:'fixture'},outputs:[{ref,url:'/media?ref='+encodeURIComponent(ref),
     meta:{width:720,height:1280,duration:5},...(id==='native-draft'?{extra:{draft_expires:Date.now()/1000+600}}:{})}]});
   return {ok:true,text:async()=>JSON.stringify({ids:[id]})};
 };
 evaluate(`CAPS_LIST.default_video_draft=true;
   const nativeDraftNode=addNode("video",420,90,{prompt:"原始样片提示"});
   selectOnly(nativeDraftNode.id);
   const draftCtl=$("#ctl select[data-k=draft]");draftCtl.value="true";draftCtl.dispatchEvent(new Event("change"));
   $("#send").click();`);
 await ready('nativeDraftNode.versions.length===1','native sample available',250);
 equal(evaluate('[$(".badge",els.get(nativeDraftNode.id)).textContent,curV(nativeDraftNode).video_recipe.draft]'),
   ['480p 样片',true],'the native sample is labeled and preserves its generation recipe');
 evaluate(`nativeDraftNode.data.prompt="新的未提交提示";
   nodeAction(nativeDraftNode,"draft-final");
   const draftFinalForm=$("#videoDraftFinal form");
   draftFinalForm.elements.resolution.value="4k";
   draftFinalForm.dispatchEvent(new Event("submit",{cancelable:true}));`);
 await ready('nativeDraftNode.versions.length===2','final video is appended to the sample node',250);
 equal([nativeDraftReq[0].draft,nativeDraftReq[1].ref,nativeDraftReq[1].resolution,Object.hasOwn(nativeDraftReq[1],'prompt')],
   [true,'output:h3studio/native-draft.mp4','4k',false],'final requests pin only the chosen sample and resolution');
 equal(evaluate(`[nativeDraftNode.cur,$(".badge",els.get(nativeDraftNode.id)).textContent,curV(nativeDraftNode).prompt,
   !!nativeDraftNode.data.draft]`),[1,'4K 定稿','原始样片提示',false],
   'the final version uses the older saved prompt and can be compared in place');
 evaluate(`const comparisonBefore=snap(), compareVideos=$$("#videoCompare video");
   compareVideos.forEach((video,i)=>{
     Object.defineProperty(video,"duration",{value:i?6:5});
     video.play=async()=>{video.dataset.playing="yes";};
     video.pause=()=>{video.dataset.playing="no";};
   });
   $("#ntools [data-a=compare-video]").click();
   compareVideos[0].dispatchEvent(new Event("loadedmetadata"));`);
 equal(evaluate('[videoCompare.open,...compareVersions.map(s=>s.value),compareTime.max,...compareVideos.map(v=>v.muted)]'),
   [true,'0','1','5',true,false],'previous and current versions share the shorter timeline, with sound on the current side');
 evaluate('compareTime.value="2.5";compareTime.dispatchEvent(new Event("input"));comparePlay.click()');
 equal(evaluate('compareVideos.map(v=>[v.currentTime,v.dataset.playing])'),[[2.5,'yes'],[2.5,'yes']],
   'shared seek and play affect both sides');
 evaluate('compareVideos[0].currentTime=5;compareVideos[0].dispatchEvent(new Event("timeupdate"));');
 equal(evaluate('compareVideos.map(v=>[v.currentTime,v.dataset.playing])'),[[5,'no'],[5,'no']],
   'both players stop when the shorter version ends');
 evaluate(`compareVersions[0].value="1";compareVersions[0].dispatchEvent(new Event("change"));
   compareAudio.value="left";compareAudio.dispatchEvent(new Event("change"));`);
 equal(evaluate('[...compareVersions.map(s=>s.value),...compareVideos.map(v=>v.muted),snap()===comparisonBefore]'),
   ['1','0',false,true,true],'swapping previews and their sound leaves canvas history and settings intact');
 evaluate(`$("[data-compare-close]").click();nodeAction(nativeDraftNode,"full");$("[data-light-compare]").click()`);
 equal(evaluate('[videoCompare.open, !!$("#light.on")]'),[true,false],'fullscreen offers the same comparison');
 evaluate('$("[data-compare-close]").click()');
 evaluate('lightbox(nativeDraftNode.versions[0],nativeDraftNode);$("[data-light-draft-final]").click()');
 equal(evaluate('[$("#videoDraftFinal").open,$("[data-draft-name]").textContent.endsWith("版本 1"),nativeDraftNode.cur]'),
  [true,true,1],'finalizing from a historical preview pins that sample without changing the active tab');
 evaluate('closeVideoDraftFinal()');
 evaluate('switchVersion(nativeDraftNode,0);');
 equal(evaluate('[nativeDraftNode.data.draft,!!$("#ntools [data-a=draft-final]")]'),[true,true],
   'switching back restores the original sample controls');
 evaluate(`const sourceBeforeBranch=JSON.stringify(nativeDraftNode);
   openVideoDraftFinal(nativeDraftNode);draftFinalForm.elements.placement.value="branch";
   draftFinalForm.dispatchEvent(new Event("submit",{cancelable:true}));`);
 await ready('$("[data-draft-status]").textContent==="定稿请求尚未保存，请重试"','failed save prevents finalization before its recovery key is durable');
 assert.equal(nativeDraftReq.length,2);
 const unsavedDraftKey=evaluate('nativeDraftNode.draft_finalize_attempt.key');
 evaluate('draftFinalForm.dispatchEvent(new Event("submit",{cancelable:true}))');
 await ready('$("[data-draft-status]").textContent==="连接中断"','a failed transport leaves the same finalization available to retry');
 assert.equal(nativeDraftReq[2].request_key,unsavedDraftKey);
 evaluate('const sampleExpiry=curV(nativeDraftNode).draft_expires;curV(nativeDraftNode).draft_expires=Date.now()/1000-1');
 evaluate('closeVideoDraftFinal();openVideoDraftFinal(nativeDraftNode)');
 equal(evaluate('[draftFinalForm.elements.placement.value,$("button[type=submit]",draftFinalForm).disabled,$("button[type=submit]",draftFinalForm).textContent]'),
   ["branch",false,"恢复定稿"],'a persisted request can be recovered after the sample expires');
 evaluate('draftFinalForm.dispatchEvent(new Event("submit",{cancelable:true}))');
 await ready('B.nodes.some(n=>draftFinalEdge(n)?.from===nativeDraftNode.id&&!n.job)','a confirmed provider failure keeps its branch',250);
 evaluate('curV(nativeDraftNode).draft_expires=sampleExpiry');
 evaluate(`const failedDraftBranch=B.nodes.find(n=>draftFinalEdge(n)?.from===nativeDraftNode.id);
   switchVersion(nativeDraftNode,1,{recordUndo:false});selectOnly(failedDraftBranch.id);
   ctxMenu({target:els.get(failedDraftBranch.id),clientX:140,clientY:120});
   $("#ctxMenu [data-a=draft-final]").click();`);
 equal(evaluate('[draftFinalForm.elements.placement.disabled,$("[data-draft-name]").textContent.endsWith("版本 1")]'),[true,true],
   'retry from the branch locks its placement and finds the pinned sample even after switching tabs');
 evaluate('draftFinalForm.dispatchEvent(new Event("submit",{cancelable:true}))');
 await ready('B.nodes.some(n=>curV(n)?.ref==="output:h3studio/native-branch.mp4")','final branch appears next to the sample',250);
 equal(nativeDraftReq[2],nativeDraftReq[3],'retry preserves the same provider job key and pinned sample');
 assert.notEqual(nativeDraftReq[3].request_key,nativeDraftReq[4].request_key,'a confirmed provider failure needs a new request key');
 equal([nativeDraftReq[4].node,nativeDraftReq[4].ref],[nativeDraftReq[3].node,nativeDraftReq[3].ref]);
 assert.equal(evaluate('curV(failedDraftBranch)?.ref'),'output:h3studio/native-branch.mp4','provider retry completes in the original branch');
 evaluate('switchVersion(nativeDraftNode,0,{recordUndo:false})');
 equal(evaluate(`(()=>{const branch=B.nodes.find(n=>curV(n)?.ref==="output:h3studio/native-branch.mp4");
   const edge=B.edges.find(e=>e.to===branch.id&&e.from===nativeDraftNode.id);
   return [JSON.stringify(nativeDraftNode)===sourceBeforeBranch,branch.x>nativeDraftNode.x+size(nativeDraftNode).w,
     sel.has(branch.id),edge.relation,edge.ref,videoInputs(branch).length,curV(branch).draft_final.source_node===nativeDraftNode.id];})()`),
   [true,true,true,"draft_final","output:h3studio/native-draft.mp4",0,true]);
 evaluate(`switchVersion(nativeDraftNode,1,{recordUndo:false});
   selectOnly(failedDraftBranch.id);$("#ntools [data-a=compare-draft]").click()`);
 equal(evaluate(`[videoCompare.open,$("#videoCompareTitle").textContent,...compareVersions.map(s=>s.disabled),
   ...compareVideos.map(v=>decodeURIComponent(v.src).split("ref=").at(-1)),nativeDraftNode.cur]`),
  [true,"对比样片与定稿",true,false,"output:h3studio/native-draft.mp4","output:h3studio/native-branch.mp4",1],
  'the branch opens a synchronized view with its exact sample and the explicitly selected final');
 evaluate('$("[data-compare-close]").click();lightbox(nativeDraftNode.versions[0],nativeDraftNode);$("[data-light-compare-draft]").click()');
 equal(evaluate('compareVersions[1].options.length'),2,'a historical sample preview can choose among both final results');
 evaluate(`$("[data-compare-close]").click();vtSplit(nativeDraftNode.id,0);
   const movedSample=B.nodes.find(n=>n.id!==nativeDraftNode.id&&curV(n)?.draft_expires);
   const sourceAfterSplit=()=>draftVideoComparison(node(failedDraftBranch.id),curV(node(failedDraftBranch.id))).source.node.id;`);
 equal(evaluate(`[sourceAfterSplit(),B.edges.find(e=>e.to===failedDraftBranch.id&&e.relation==="draft_final").from,
    curV(node(failedDraftBranch.id)).draft_final.source_node]`),
   [evaluate('movedSample.id'),evaluate('movedSample.id'),evaluate('movedSample.id')],
   'moving the sample tab updates comparison, the canvas link and the saved final provenance');
 evaluate('undo()');
 evaluate(`const draftBranchNode=B.nodes.find(n=>curV(n)?.ref==="output:h3studio/native-branch.mp4");
   duplicate([nativeDraftNode.id,draftBranchNode.id]);`);
 equal(evaluate(`(()=>{const [sample,final]=[...sel].map(node);return [
   curV(final).draft_final.source_node===sample.id,B.edges.some(e=>e.from===sample.id&&e.to===final.id&&e.relation==="draft_final")];})()`),
   [true,true],'duplicating the pair preserves the copied sample as the finalization source');
 evaluate('undo()');
 evaluate('undo();CAPS_LIST.default_video_draft=false');
 assert.equal(evaluate('B.nodes.some(n=>curV(n)?.ref==="output:h3studio/native-branch.mp4")'),false);
 evaluate('removeNodes([nativeDraftNode.id])');
 w.fetch=nativeDraftFetch;
 console.log('Video draft and comparison DOM passed: tab and branch finalization, retry, provenance, undo and synchronized comparison.');
};
