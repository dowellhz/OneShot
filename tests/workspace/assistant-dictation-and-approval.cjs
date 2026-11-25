"use strict";

module.exports = async function assistantDictationAndApproval(workspace, scenarioState) {
 const { assert, equal, evaluate, ready, w } = workspace;
 evaluate(`$("#acPickPlacement").click();
   vp.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true,cancelable:true,clientX:430,clientY:320}));
   B.view.x+=20;applyView();`);
 equal(evaluate('[$("#acPlacementMarker").style.left,!!$("[data-locate-placement]"),acPickingPlacement]'),['450px',true,false]);
 evaluate('$("[data-remove-placement]").click()');
 equal(evaluate('[AC.placement,$("#acPlacementMarker").hidden]'),[null,true]);
 evaluate(`$("#acPickPlacement").click();
   vp.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true,cancelable:true,clientX:430,clientY:320}));
   const typedTarget={...AC.placement};
   $("#acInput").value="把标题放在这个位置";`);
 scenarioState.failPlacementSend=true;
 await evaluate('acSend()');
 const placementRequestKey=w.__chatPayload.request_key;
 await evaluate('acLoadSession(AC.session)');
 const restoredTarget=JSON.parse(evaluate('JSON.stringify(typedTarget)'));
 equal(evaluate('[AC.placement,$("#acPlacementMarker").hidden,$("#acInput").value]'),[restoredTarget,false,'把标题放在这个位置']);
 await evaluate('acSend()');
 equal([w.__chatPayload.placement,w.__chatPayload.request_key],[restoredTarget,placementRequestKey]);
 assert.equal(evaluate('$("#acPlacementMarker").hidden'),true);
 const beforeNodeVoice=evaluate('snap()');
 scenarioState.voiceCommand="人物从门内走出";
 evaluate(`const dictatedVideo=addNode("video",700,130000,{pmode:"fields",fields:{action:"保留站位"}});
   selectOnly(dictatedVideo.id);
   $("#ppVoiceRecord").focus();
   window.__chatPayload=null;
   voiceKey("keydown"," ","Space",$("#ppVoiceRecord"));`);
 await ready('acVoiceActive?.phase==="recording" && acVoiceActive.target.dataset.k==="action"','focused node voice uses the video action field');
 equal(evaluate('[spaceDown,acVoicePointing(),$("#acVoiceRecord").disabled]'),[false,null,true]);
 evaluate('voiceKey("keyup"," ","Space",$("#ppVoiceRecord"))');
 await ready('$("#ppVoiceStatus").textContent==="已填入提示词"','letting go transcribes the node recording');
 equal(evaluate('[dictatedVideo.data.fields.action,window.__chatPayload,!!dictatedVideo.job]'),
 ["保留站位\n人物从门内走出",null,false],'dictation stays in the node draft and does not start generation');
 evaluate('undo();');
 assert.equal(evaluate('node(dictatedVideo.id).data.fields.action'),"保留站位",'dictation can be undone with the canvas history');

 scenarioState.voiceCommand="停止";
 evaluate('selectOnly(voicedAudio.id);$("#ppVoiceRecord").click()');
 await ready('acVoiceActive?.phase==="recording"','clicking the audio node voice action starts recording');
 evaluate('$("#ppVoiceRecord").click()');
 await ready('node(voicedAudio.id).data.prompt==="停止"','node dictation keeps a spoken word as draft text');
 assert.equal(scenarioState.voiceStops.length,1);

 scenarioState.voiceCommand="已取消的文字";scenarioState.deferNodeTranscript=true;
 evaluate('selectOnly(voicedImage.id);$("#ppVoiceRecord").click()');
 await ready('acVoiceActive?.phase==="recording"','image node exposes the same recorder');
 evaluate('$("#ppVoiceRecord").click()');
 await ready('acVoiceActive?.phase==="transcribing" && window.__nodeTranscriptPending','recording begins transcription');
 evaluate('selectOnly(voicedAudio.id)');
 assert.equal(evaluate('acVoiceActive'),null,'switching nodes cancels the pending dictation');
 scenarioState.finishNodeTranscript();delete w.__nodeTranscriptPending;scenarioState.deferNodeTranscript=false;scenarioState.voiceCommand=null;
 equal(evaluate('[node(voicedImage.id).data.prompt,node(voicedAudio.id).data.prompt]'),["","停止"]);

 scenarioState.voiceCommand="预览第一句";
 evaluate(`const voicePreviewChunk=()=>acVoiceActive.previewRecorder.stop();
  selectOnly(voicedImage.id);
  $("#ppVoiceLive").click();
  $("#ppVoiceRecord").click();`);
 await ready('acVoiceActive?.phase==="recording"','live preview recording starts');
 evaluate('voicePreviewChunk()');
 await ready('$("#ppVoicePreview").textContent==="预览第一句"','node partial transcript appears before stop');
 equal(evaluate('[$("#ppVoicePreview").hidden,$("#prompt").value,$("#acVoiceLive").checked]'),[false,"",true]);
 scenarioState.voiceCommand="预览第二句";
 evaluate('voicePreviewChunk()');
 await ready('$("#ppVoicePreview").textContent==="预览第一句\\n预览第二句"','a new segment follows the earlier transcript');
 scenarioState.voiceCommand="完整转写";
 evaluate('$("#ppVoiceRecord").click()');
 await ready('node(voicedImage.id).data.prompt==="完整转写"','only the final transcript enters the prompt');
 assert.deepEqual(scenarioState.voiceRequests.slice(-3),[
  {url:"/api/transcription?preview=1",size:"segment".length},
  {url:"/api/transcription?preview=1",size:"segment".length},
  {url:"/api/transcription",size:"full recording".length},
 ],'each preview sends a separate audio file and the final draft uses the continuous recording');
 assert.equal(evaluate('$("#ppVoicePreview").hidden'),true);

 scenarioState.voiceCommand="取消后的迟到预览";scenarioState.deferNodeTranscript=true;
 evaluate('$("#acInput").value="现有草稿";$("#acVoiceRecord").click()');
 await ready('acVoiceActive?.phase==="recording"','assistant live preview shares the setting');
 evaluate('voicePreviewChunk()');
 await ready('window.__nodeTranscriptPending','assistant preview request is in flight');
 evaluate('$("#acVoiceCancel").click()');
 assert.equal(scenarioState.voiceSignal.aborted,true);
 scenarioState.finishNodeTranscript();delete w.__nodeTranscriptPending;scenarioState.deferNodeTranscript=false;
 await Promise.resolve();
 equal(evaluate('[$("#acVoicePreview").hidden,$("#acInput").value,acVoiceActive]'),[true,"现有草稿",null]);
 evaluate('$("#acVoiceLive").click();$("#acVoiceRecord").click()');
 await ready('acVoiceActive?.phase==="recording"','recording restarts after cancel');
 evaluate('acVoiceActive.recorder.state="inactive";acVoiceActive.recorder.onstop()');
 equal(evaluate('[$("#acVoiceStatus").textContent,$("#acInput").value]'),["录音中断，请重试","现有草稿"]);
 evaluate(`navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException("denied","NotAllowedError");};
  $("#acVoiceRecord").click();`);
 await ready('$("#acVoiceStatus").textContent.startsWith("麦克风权限未开启")','microphone denial is reported without uploading');
 scenarioState.voiceCommand="从文件转写";
 evaluate(`selectOnly(voicedImage.id);
   const nodeVoiceFile=$("#ppVoiceFile");
   Object.defineProperty(nodeVoiceFile,"files",{configurable:true,value:[new File(["voice"],"recording.wav")]});
   $("#ppVoiceUpload").click();
   nodeVoiceFile.dispatchEvent(new Event("change"));`);
 await ready('node(voicedImage.id).data.prompt==="完整转写\\n从文件转写"','audio file transcribes into the selected node without microphone access');
 evaluate(`$("#ppVoiceUpload").click();
   selectOnly(voicedAudio.id);
   nodeVoiceFile.dispatchEvent(new Event("change"));`);
 equal(evaluate('[acVoiceActive,node(voicedAudio.id).data.prompt]'),[null,"停止"],'a file selection cannot move to a different node');
 scenarioState.voiceCommand=null;
 console.log('Live dictation passed: incremental drafts, final result, shared preference, cancelled response, interrupted recording and denied permission.');
 evaluate(`restore(${JSON.stringify(beforeNodeVoice)})`);
 console.log('Node dictation passed: video fields, keyboard recording, audio draft, undo and stale-response isolation.');
 delete w.MediaRecorder;
 delete w.navigator.mediaDevices;
 w.fetch=scenarioState.voicePointFetch;
 console.log('Voice pointing passed: hold gesture, pinned references, position markers, typed placement, cancellation and recoverable submission.');
 const approvalFetch=w.fetch, approvalDecisions=[];
 let approvalRequest, approvalPending=false, approvalRunState='done', finishApproval;
 let approvalMockId='approval-card', approvalPlan={kind:'image',count:2,unit_cost:.125,label:'海报草稿',prompt:'<img src=x> 保留产品配色',references:1,editable:{prompt:3000,count:4}};
 scenarioState.approvalSid = evaluate('AC.session');
 w.fetch=async(url,options={})=>{
  const path=String(url).split('?')[0];
  if(path===`/api/chat/sessions/${scenarioState.approvalSid}/messages`){
   approvalRequest=JSON.parse(options.body);
   approvalPending=true;approvalRunState='waiting_approval';
   return {ok:true,json:async()=>({id:'approval-run',state:approvalRunState})};
  }
  if(path===`/api/chat/sessions/${scenarioState.approvalSid}`){
   const approvals=approvalPending?[{id:approvalMockId,run_id:'approval-run',name:'image_generate',plan:approvalPlan}]:[];
   return {ok:true,json:async()=>({runs:[{id:'approval-run',state:approvalRunState}],events:[],approvals})};
  }
  if(path===`/api/chat/runs/approval-run/approvals/${approvalMockId}`){
   const payload=JSON.parse(options.body);
   approvalDecisions.push(payload);
   if(payload.decision==='adjust'){
    approvalMockId='approval-revised';approvalPlan={...approvalPlan,...payload.parameters};
    return {ok:true,json:async()=>({ok:true,approval_id:approvalMockId})};
   }
   await new Promise(resolve=>{finishApproval=resolve;});
   approvalPending=false;approvalRunState='done';
   return {ok:true,json:async()=>({ok:true})};
  }
  return approvalFetch(url,options);
 };
 evaluate('$("#acGenerationMode").value="manual";$("#acGenerationMode").dispatchEvent(new Event("change"));$("#acInput").value="生成两张海报"');
 await evaluate('acSend()');
 await ready('!$("#acApprovals").hidden','the assistant displays a pending generation card');
 equal([approvalRequest.generation_mode,evaluate('localStorage.getItem("h3.chat.generationMode")')],['manual','manual']);
 assert.match(evaluate('$("#acApprovals").textContent'),/海报草稿.*2 张图片/s);
 assert.match(evaluate('$("#acApprovals").textContent'),/预计费用 ¥0\.25/);
 equal(evaluate('[$$("#acApprovals img").length,$("#acApprovals p").textContent,$("#acStatus").textContent]'),
  [0,'<img src=x> 保留产品配色','等待确认生成方案…']);
 evaluate(`const generationEditForm=$("[data-approval-edit]");
   generationEditForm.elements.prompt.value="两种暖色排版";
   generationEditForm.elements.count.value="3";
   generationEditForm.elements.count.dispatchEvent(new Event("input",{bubbles:true}));`);
 assert.equal(evaluate('$("[data-decision=approve]").disabled'),true);
 evaluate('generationEditForm.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');
 await ready('!!$("[data-approval-id=approval-revised]")','saved changes get a fresh confirmation card');
 assert.match(evaluate('$("#acApprovals").textContent'),/3 张图片.*两种暖色排版/s);
 assert.match(evaluate('$("#acApprovals").textContent'),/预计费用 ¥0\.375/);
 evaluate('$("[data-approval-id][data-decision=approve]").click();$("[data-approval-id][data-decision=skip]").click()');
 equal(approvalDecisions,[{decision:'adjust',parameters:{prompt:'两种暖色排版',count:3}},{decision:'approve'}]);
 assert.equal(evaluate('$("[data-approval-id][data-decision=approve]").disabled'),true);
 finishApproval();
 await ready('$("#acApprovals").hidden','a successful decision removes the pending card');
 w.fetch=approvalFetch;
 console.log('Assistant generation approval passed: preference snapshot, safe plan display, exclusive decision and confirmation handoff.');
 evaluate(`const previousApprovals=AC.approvals;
  const mixedApproval={id:"mixed-review",name:"video_generate",plan:{kind:"video",count:1,prompt:"拍摄",
    editable:{prompt:3000},reference_review:{duration:8,quality:"1080p",provider:"方舟",model:"Seedance 2.5",
      assets:["站台参考"],counts:[["图",2,30],["音频",1,10]],
      inputs:[{name:"<img src=x>",role:"subject"},{name:"站台",role:"image_ref",image_role:"frame",time:3.2,version:2},
              {name:"站台环境声",role:"audio_ref",prompt_reference:"@音频1",start:0,end:2}]}}};
  AC.approvals=[mixedApproval];acRenderApprovals();`);
 assert.match(evaluate('$("#acApprovals").textContent'),/8 秒.*1080p.*Seedance 2\.5/s);
 assert.match(evaluate('$("#acApprovals").textContent'),/站台环境声 · @音频1 · 音频 · 0–2 秒/);
 assert.match(evaluate('$("#acApprovals").textContent'),/站台 · 构图参考 · 版本 2 · 3.2 秒/);
 assert.equal(evaluate('$("#acApprovals img")'),null);
 evaluate(`mixedApproval.plan.reference_review=null;
  mixedApproval.plan.reference_pending=true;acRenderApprovals();
  const blockedForm=$("[data-approval-edit]");
  blockedForm.dispatchEvent(new Event("reset",{bubbles:true}));`);
 assert.equal(evaluate('$("[data-decision=approve]").disabled'),true);
 evaluate('AC.approvals=previousApprovals;acRenderApprovals()');
 console.log('Assistant mixed-media approval passed: exact model and inputs, safe labels and pending confirmation lock.');
};
