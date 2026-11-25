"use strict";

module.exports = async function remakeCorrectionsAndHandoff(workspace, scenarioState) {
 const { assert, equal, evaluate, ready, w } = workspace;
 const beforeRemake=evaluate('B.nodes.length');
 evaluate('$$(".rm-review button").find(b=>b.textContent==="用作视频首帧").click()');
 equal(evaluate('B.nodes.length'),beforeRemake+2,'handoff creates one preview image and one linked video');
 equal(evaluate('B.nodes.at(-1).data.prompt'),'缓慢转身','new video receives analyzed motion description');
 equal(evaluate('B.edges.at(-1).from'),evaluate('B.nodes.at(-2).id'),'approved frame linked to new video');
 equal(evaluate('!!$("#videoRemake")'),false,'handoff returns to canvas');
 await evaluate('openVideoRemake(node("pendingVideo"))');
 evaluate('$$(".rm-video-review button").find(b=>b.textContent==="镜头放入画布").click()');
 equal(evaluate('B.nodes.length'),beforeRemake+4,'shot handoff adds a video and guide while reusing the first frame');
 const shotNode=evaluate('B.nodes.at(-1).id');
 equal(evaluate(`const shotHandoff=node(${JSON.stringify(shotNode)});
  B.edges.filter(e=>e.to===shotHandoff.id).map(e=>[e.relation||e.role,e.source_ref||curV(node(e.from)).ref,e.time??null])`),
  [['remake',evaluate('curV(node("pendingVideo")).ref'),null],['first','output:h3studio/remake.png',0],
   ['keyframe','output:h3studio/shot-guide.png',.5]],'shot keeps original video provenance and exact timed frame connections');
 scenarioState.remakeSession.shots[0].videos.push({...scenarioState.remakeSession.shots[0].videos.at(-1),job:'shot-local-2',ref:'output:h3studio/shot-local-2.mp4',guides:[]});
 scenarioState.remakeSession.shots[0].adopted_video='shot-local-2';
 await evaluate('openVideoRemake(node("pendingVideo"))');
 evaluate('$$(".rm-video-review button").find(b=>b.textContent==="镜头放入画布").click()');
 equal(evaluate('[shotHandoff.versions.length,curV(shotHandoff).ref]'),[2,'output:h3studio/shot-local-2.mp4'],'another reviewed result becomes a tab');
 evaluate('switchVersion(shotHandoff,0)');
 equal(evaluate('B.edges.filter(e=>e.to===shotHandoff.id).map(e=>e.relation||e.role)'),['remake','first','keyframe'],'switching tabs restores each result’s connections');
 await evaluate('openVideoRemake(node("pendingVideo"))');
 evaluate('$("[data-insert-export]").click()');
 equal(evaluate('const exportHandoff=B.nodes.at(-1);[curV(exportHandoff).ref,curV(exportHandoff).remake.clips[0].frames]'),
  ['output:h3studio/assembled.mp4',72],'finished export retains the render snapshot on the canvas');
 await evaluate('openVideoRemake(node("pendingVideo"))');
 evaluate('$("[data-insert-export]").click()');
 equal(evaluate('B.nodes.filter(n=>n.versions.some(v=>v.ref==="output:h3studio/assembled.mp4")).length'),1,'repeated handoff selects the existing export');
 await evaluate('openVideoRemake(node("pendingVideo"))');
 evaluate(`const unsentMotion=$("#videoRemake [data-motion]"),unsentNote=$("#videoRemake .rm-note input"),unsentView=$("#videoRemake [data-view]");
  unsentMotion.value="尚未提交的动作";unsentMotion.dispatchEvent(new Event("input"));
  unsentNote.value="尚未提交的修改要求";unsentNote.dispatchEvent(new Event("input"));
  unsentView.value="main";unsentView.dispatchEvent(new Event("change"));
  $("#videoRemake [data-close]").click();`);
 await evaluate('openVideoRemake(node("pendingVideo"))');
 equal(evaluate('[$("#videoRemake [data-motion]").value,$("#videoRemake .rm-note input").value,$("#videoRemake [data-view]").value]'),
  ['尚未提交的动作','尚未提交的修改要求','main'],'reopening restores the unsent shot draft and chosen view');
 evaluate('$("#videoRemake [data-close]").click();const originalVersion=node("pendingVideo").cur;switchVersion(node("pendingVideo"),originalVersion===0?1:0)');
 await evaluate('openVideoRemake(node("pendingVideo"))');
 equal(evaluate('[$("#videoRemake .rm-note input").value,$("#videoRemake [data-view]").value]'),['','face'],'another source version has its own draft scope');
 evaluate('$("#videoRemake [data-close]").click();switchVersion(node("pendingVideo"),originalVersion)');
 evaluate('const originalTab=node("pendingVideo"),originalRef=curV(originalTab).ref;vtSplit(originalTab.id,originalTab.cur)');
 equal(evaluate('const splitOriginal=vtResolve("pendingVideo",originalRef).node;B.edges.filter(e=>e.relation==="remake").every(e=>e.from===splitOriginal.id)'),true,'origin links follow the pinned video version when split');
 evaluate('switchVersion(shotHandoff,1)');
 equal(evaluate('B.edges.find(e=>e.to===shotHandoff.id&&e.relation==="remake").from'),evaluate('splitOriginal.id'),'the other result tab points to the moved origin too');
 await evaluate('openVideoRemake(splitOriginal)');
 equal(evaluate('[$("#videoRemake [data-motion]").value,$("#videoRemake .rm-note input").value,$("#videoRemake [data-view]").value]'),
  ['尚未提交的动作','尚未提交的修改要求','main'],'the moved source tab uses the draft scope of its existing remake session');
 evaluate('$("#videoRemake [data-close]").click()');
 equal(evaluate(`const mergePeer=addNode("video",3000,200,splitOriginal.data,{versions:[{...curV(splitOriginal),
   ref:"output:h3studio/merge-peer.mp4",tab_nodes:[]}],cur:0});
   B.edges.push(...B.edges.filter(e=>e.to===splitOriginal.id).map(e=>({...e,to:mergePeer.id})));
   vtMerge([splitOriginal.id,mergePeer.id],mergePeer.id)`),true,'clips with remake provenance can merge using compatible generation inputs');
 equal(evaluate('vtResolve("pendingVideo",originalRef).node.id'),evaluate('mergePeer.id'),'original source moves back into a merged tab');
 equal(evaluate('B.edges.filter(e=>e.relation==="remake").every(e=>e.from===mergePeer.id)'),true,'all remake links now point to the merged source node');
 const entryShot=scenarioState.remakeSession.shots[0];
 evaluate('switchVersion(mergePeer,vtResolve("pendingVideo",originalRef).index)');
 delete entryShot.frames.first.protection;
 await evaluate('openVideoRemake(mergePeer)');
 equal(evaluate('$("[data-generate-video]").disabled && $(".rm-motion-hint").textContent.includes("首帧选区已更新")'),true,
  'changed foreground protection requires a new approved first-frame preview');
 evaluate('$("#videoRemake [data-close]").click()');
 entryShot.frames.first.person_absent={source:'人物 A'};
 await evaluate('openVideoRemake(mergePeer)');
 evaluate('$("[data-suggest-entry]").click()');
 await ready('$("[data-frame]").value==="entry" && !$(".rm-person-point").hidden && $(".rm-mask").hidden',
  'entry suggestion jumps to a candidate frame without selecting the person');
 equal(evaluate('$(".rm-source video").currentTime'),.75,'the original player follows the suggested entry');
 evaluate('$("[data-locate-person]").click()');
 await ready('!$("[data-batch-previews]").disabled','confirming the suggested entry enables batch preview');
 evaluate('$("[data-batch-previews]").click()');
 await ready('$("#videoRemake [data-frame]").value==="entry" && $$(".rm-review button").some(b=>b.textContent==="用作动作关键帧")',
  'batching an off-screen shot opens its first visible frame for review');
 equal(evaluate('$("[data-batch-previews]").disabled'),true,'an unchanged reference is excluded from the batch');
 evaluate('$("#videoRemake [data-close]").click()');
 w.__memories.find(a=>a.id==='char').character_views.main='input:h3studio/new-main.png';
 await evaluate('openVideoRemake(mergePeer)');
 evaluate('const entrySelect=$("[data-frame]");entrySelect.value="entry";entrySelect.dispatchEvent(new Event("change"))');
 equal(evaluate('$("[aria-label=预览版本]").selectedOptions[0].textContent.includes("旧参考图") && !$("[data-batch-previews]").disabled'),true,
  'an updated asset reference re-enables batch generation and marks the older preview');
 evaluate('$("#videoRemake [data-close]").click()');
 scenarioState.remakeSession.shots[0].end=12;
 scenarioState.remakeSession.video_limits=[10];
 await evaluate('openVideoRemake(mergePeer)');
 equal(evaluate('[$("[data-cut=split_long_shot]").hidden,$("[data-cut=split_long_shot]").textContent,$("[data-generate-video]").disabled]'),
  [false,'拆成 2 个镜头',true],'the current route can require splitting below the general remake limit');
 evaluate('$("#videoRemake [data-close]").click()');
 delete scenarioState.remakeSession.video_limits;
 scenarioState.remakeSession.shots[0].end=29.5;
 await evaluate('openVideoRemake(mergePeer)');
 equal(evaluate('$("[data-cut=split_long_shot]").textContent'), '拆成 3 个镜头','an oversized shot shows its balanced split action');
 equal(evaluate('$("[data-generate-video]").disabled'),true,'oversized shots cannot be sent to generation');
 evaluate('$("[data-cut=split_long_shot]").click()');
 await ready('$$(".rm-shots button").length===3 && $("[data-cut=split_long_shot]").hidden && !$("[data-cut=undo_cut]").hidden',
  'automatic splitting updates the shot list and exposes undo');
 evaluate('$("#videoRemake [data-close]").click()');
 const locatedShot=scenarioState.remakeSession.shots[1];
 locatedShot.frames.first.person_hint={source:'人物 A',look:'',point:[.35,.45]};
 evaluate(`const pinnedIndex=vtResolve("pendingVideo",originalRef).index;
 switchVersion(mergePeer,mergePeer.cur===0?1:0);
 $("#acMessages").insertAdjacentHTML("beforeend",acResultCards({remake:{node_id:"pendingVideo",source_ref:originalRef,
  shot_number:2,shot_start:${locatedShot.start}}}));
 $("#acMessages [data-remake-node]").click();`);
 await ready('$("#videoRemake .rm-shot")?.textContent==="镜头 2" && !$(".rm-person-point").hidden && mergePeer.cur===pinnedIndex',
  'the assistant opens the located shot on the pinned source version even after its tab moved');
 evaluate('$("#videoRemake [data-close]").click()');
 const previewTime=Math.round((locatedShot.start+.5)*24);
 locatedShot.frames['correction-'+previewTime]={ref:locatedShot.frames.first.ref,w:640,h:480,at:previewTime/24,correction_tick:previewTime,
  previews:[{job:'chat-preview',state:'done',ref:'output:h3studio/chat-preview.png',asset:{id:'char'},source_person:'人物 A'},
   {job:'later-preview',state:'done',ref:'output:h3studio/later-preview.png',asset:{id:'char'},source_person:'人物 A'}]};
 evaluate(`$("#acMessages [data-remake-node]").remove();
 $("#acMessages").insertAdjacentHTML("beforeend",acResultCards({preview:{completed:[2]},remake:{node_id:"pendingVideo",
  source_ref:originalRef,shot_number:2,shot_start:${locatedShot.start},frame:"correction-${previewTime}",preview_job:"chat-preview"}}));
 $("#acMessages [data-remake-node]").click();`);
 await ready('$(".rm-output img")?.src.includes("chat-preview.png") && $(".rm-shot").textContent==="镜头 2"',
  'a preview submitted from chat opens the corresponding correction frame for review');
 evaluate('$("#videoRemake [data-close]").click()');
 locatedShot.videos=[
  {job:'chat-remake-video',state:'done',ref:'output:h3studio/chat-remake-video.mp4'},
  {job:'newer-remake-video',state:'done',ref:'output:h3studio/newer-remake-video.mp4'},
 ];
 evaluate(`$("#acMessages [data-remake-node]").remove();
 $("#acMessages").insertAdjacentHTML("beforeend",acResultCards({review_board:boardId,cut_revision:${scenarioState.remakeSession.cut_revision},review_versions:[
  {number:1,job:"chat-remake-video",adopted:true},{number:2,job:"newer-remake-video"}],remake:{node_id:"pendingVideo",
  source_ref:originalRef,shot_number:2,shot_start:${locatedShot.start}}}));
 $("#acMessages [data-remake-video-job=chat-remake-video]").click();`);
 await ready('$("#videoRemake video[data-result]")?.src.includes("chat-remake-video.mp4") && $(".rm-shot").textContent==="镜头 2"',
  'the assistant review menu opens the exact earlier remake version');
 evaluate('$("#videoRemake [data-close]").click()');
 scenarioState.remakeSession.cut_revision++;
 evaluate('$("[data-review-job=newer-remake-video]").click()');
 await ready('$("[data-review-status]").textContent.includes("剪辑点已更新") && !$("[data-review-job=newer-remake-video]").disabled',
  'a stale review card shows the conflict and leaves the decision available for a retry');
 assert.notEqual(locatedShot.adopted_video,'newer-remake-video');
 scenarioState.remakeSession.cut_revision--;
 evaluate('$("[data-review-job=newer-remake-video]").click()');
 await ready('$("[data-review-status]").textContent.includes("已采用") && $("[data-review-job=newer-remake-video]").getAttribute("aria-pressed")==="true"',
  'adopting a version gives direct confirmation in the chat card');
 assert.equal(locatedShot.adopted_video,'newer-remake-video');
 evaluate('$("[data-remake-decision=keep]").click()');
 await ready('$("[data-review-status]").textContent.includes("保留原片") && $("[data-remake-decision=keep]").getAttribute("aria-pressed")==="true"',
  'the keep button updates the review decision for the same shot');
 assert.equal(locatedShot.keep_original,true);
 w.fetch=scenarioState.previousFetch;
 evaluate(`$("#upBtn").click();
 const uploadEntry=$("#file");
 Object.defineProperty(uploadEntry,"files",{value:[new File(["video"],"source.MKV",{type:""})]});
 uploadEntry.dispatchEvent(new Event("change"));`);
 await ready('B.nodes.some(n=>n.name==="source" && n.type==="video" && curV(n)?.ref.endsWith(".mkv"))',
  'the file picker uploads an MKV without a MIME type onto a video node');
 evaluate(`const uploadDrop=new MouseEvent("drop",{clientX:550,clientY:400,bubbles:true,cancelable:true});
 Object.defineProperty(uploadDrop,"dataTransfer",{value:{getData:()=>"",files:[new File(["video"],"dropped.m4v",{type:"application/octet-stream"})]}});
 vp.dispatchEvent(uploadDrop);`);
 await ready('B.nodes.some(n=>n.name==="dropped" && n.type==="video" && curV(n)?.ref.endsWith(".m4v"))',
  'dropping a generic binary M4V uploads it as a video');
 evaluate(`const targetDropSnapshot=snap(), targetDropNode=addNode("video",1600,540,{}), targetDropId=targetDropNode.id;
 const targetDropName=targetDropNode.name, targetDropCount=B.nodes.length;
 const dropIntoVideo=fileName=>{
  const e=new MouseEvent("drop",{bubbles:true,cancelable:true});
  Object.defineProperty(e,"dataTransfer",{value:{getData:()=>"",files:[new File(["video"],fileName)]}});
  $(".card",els.get(targetDropId)).dispatchEvent(e);
 };
 dropIntoVideo("第一版.MKV");dropIntoVideo("并发重复.MKV");`);
 await ready('node(targetDropId).versions.length===1&&curV(node(targetDropId)).ref.endsWith(".mkv")','video is imported into the exact target');
 equal(evaluate('[B.nodes.length===targetDropCount,node(targetDropId).name,node(targetDropId).versions.length]'),[true,'第一版',1]);
 evaluate('dropIntoVideo("第二版.m4v")');
 await ready('node(targetDropId).versions.length===2','an existing media node receives another version');
 evaluate('undo();undo()');
 equal(evaluate('[node(targetDropId).name===targetDropName,node(targetDropId).versions.length]'),[true,0]);
 evaluate('restore(targetDropSnapshot)');
 console.log('Targeted video import passed: exact node, duplicate in-flight protection, version append and undo.');
};
