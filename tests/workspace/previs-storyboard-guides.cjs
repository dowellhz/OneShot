"use strict";

module.exports = async function previsStoryboardGuides(workspace, scenarioState) {
 const { assert, equal, evaluate, jobs, ready, w } = workspace;
 assert.equal(evaluate('$("video",slowPreview).playbackRate'),2.25/(65/24));
 evaluate('$("[data-close]",slowPreview).click()');
 assert.equal(evaluate('JSON.stringify(slowClip)===slowOriginal'),true,'preview and cancel leave timeline settings intact');
 evaluate('openSlow();slowClip.out=2;applySlow()');
 equal(evaluate('[slowPreview.open,slowClip.out,filmSpeed(slowClip)]'),[false,2,1],'a stale preview does not overwrite the timeline');
 evaluate('slowClip.out=2.25;openSlow();applySlow();$("#fmV").onloadedmetadata?.()');
 equal(evaluate('[clipLen(slowClip)*24,$("#fmTotal").textContent,!!$("[data-story-slowdown]",$("#fmClip"))]'),
  [65,"2 段 · 4.00 秒",false],'confirmed slowdown reaches the exact planned timeline length');
 equal(evaluate(`[storySlowdownPlan({kind:"video",story_frames:120},2.49),
  storySlowdownPlan({kind:"video",story_frames:120},2.5).rate]`),
  [null,.5],'the minimum supported speed bounds the available fix');
 evaluate(`FILM.spec.clips[0].out=20/FILM_FPS;
  closeFilm();openStoryFilm(pvEditScript);$("#fmV").onloadedmetadata?.();`);
 assert.equal(evaluate('FILM.spec.clips[0].out*FILM_FPS'),20,'reopening preserves manually edited timing');
 assert.equal(evaluate('clipLen(FILM.spec.clips[1])*24'),65,'reopening preserves the accepted slowdown');
 evaluate(`const pvAltSource=node(pvEditVideo.id), pvLong={ref:"output:h3studio/long-whitebox-take.mp4",seconds:4.75};
  pvAltSource.versions.push({ref:"output:h3studio/shorter-whitebox-take.mp4",seconds:1.75},pvLong,
    {ref:"output:h3studio/probe-whitebox-take.mp4"});
  selectClip(1);$("#fmV").onloadedmetadata?.();$("[data-update-version]",$("#fmClip")).click();
  const pvAltForm=$(".fm-version-picker"), pvAltPicker=$("select",pvAltForm), pvFit=$("[data-fit-story]",pvAltForm),
    pvAltPreview=$("video",pvAltForm), pvAltStatus=$("[role=status]",pvAltForm);
  const chooseAlt=index=>{pvAltPicker.value=String(index);pvAltPicker.dispatchEvent(new Event("change"));};
  const applyAlt=()=>$('[type=submit]',pvAltForm).click();`);
 equal(evaluate('[...pvAltPicker.options].map(o=>o.textContent.split(" · ").at(-1))'),
  ['缺 0.96 秒','够计划镜长','待核实时长']);
 assert.equal(evaluate('pvFit.disabled'),true);
 evaluate('chooseAlt(2)');
 assert.equal(evaluate('pvFit.disabled'),true,'unknown source duration cannot be applied as an exact planned cut');
 evaluate(`chooseAlt(1);pvFit.click();$("[data-preview-version]",pvAltForm).click();
  pvAltPreview.onloadedmetadata();`);
 assert.match(evaluate('pvAltStatus.textContent'),/以原速取用 2\.71 秒/);
 assert.match(evaluate('pvAltPreview.src'),/long-whitebox-take\.mp4/);
 equal(evaluate('[pvAltPreview.hidden,pvAltPreview.playbackRate,pvAltPreview.currentTime,FILM.spec.clips[1].ref]'),
  [false,1,0,'output:h3studio/short-whitebox-take.mp4'],'preview uses the candidate and the plan without replacing the draft');
 evaluate('pvLong.seconds=4.5;applyAlt()');
 assert.match(evaluate('pvAltStatus.textContent'),/素材已更新，请再次确认/);
 assert.equal(evaluate('FILM.spec.clips[1].ref'),'output:h3studio/short-whitebox-take.mp4');
 evaluate('applyAlt();$("#fmV").onloadedmetadata?.()');
 equal(evaluate(`[FILM.spec.clips[1].ref,clipLen(FILM.spec.clips[1])*24,filmSpeed(FILM.spec.clips[1]),
  pvAltSource.cur,pvAltPreview.getAttribute("src")]`),
  ['output:h3studio/long-whitebox-take.mp4',65,1,0,null],'applying at original speed retains the plan and the canvas version selection');
 evaluate(`const oneFrameClip={story_frames:1,in:0,media_seconds:5};
  alignStoryClipLength(oneFrameClip,5);closeFilm();`);
 assert.equal(evaluate('clipLen(oneFrameClip)'),1/24);
 evaluate(`const shotMotionSource=node(sceneOwner.id);
  const shotMotionTarget=node(node(pvStoryboard.id).data.made[1].vid);
  openPrevis(shotMotionSource);
  const chooseMotionSpan=span=>{
    const select=$("[data-pv-shot-range]");select.value=JSON.stringify(span);select.dispatchEvent(new Event("change"));
    $("[data-pv-render-shot]").click();
  };
  chooseMotionSpan([0,31]);`);
 await ready('!PV.editor.sending && curV(shotMotionSource)?.previs_span?.[1]===31','renders the first cut independently',450);
 equal(evaluate('[curV(shotMotionSource).seconds,$("[data-pv-use]").disabled,$("[data-pv-shot-guide]").hidden]'),
  [31/24,true,true],'short previews remain available for editing without becoming invalid motion references');
 evaluate('chooseMotionSpan([31,96])');
 await ready('!PV.editor.sending && curV(shotMotionSource)?.previs_span?.[0]===31','renders the eligible second interval',450);
 assert.deepEqual(w.__previsRequests.slice(-2).map(request=>request.span),[[0,31],[31,96]]);
 assert.notEqual(w.__previsRequests.at(-1).request_key,w.__previsRequests.at(-2).request_key);
 equal(evaluate('[PV.editor.tick,$("[data-pv-shot-guide]").hidden,$("[data-pv-guide-target]").value===shotMotionTarget.id]'),
  [31,false,true],'exports the selected interval and offers only the corresponding storyboard video');
 evaluate('$("[data-pv-apply-shot-guide]").click()');
 equal(evaluate(`[!PV.editor,previsInput(shotMotionTarget).edge.ref===curV(shotMotionSource).ref,
  previsInput(shotMotionTarget).version.previs_span,videoReq(shotMotionTarget,"").previs_guide.version]`),
  [true,true,[31,96],evaluate('shotMotionSource.cur+1')],'explicit attachment pins exactly the rendered motion version');
 evaluate(`const [motionCopy,scriptCopy,videoCopy]=paste([shotMotionSource,node(pvStoryboard.id),shotMotionTarget].map(o=>structuredClone(o)));
  const copiedMotion=node(motionCopy);`);
 equal(evaluate('[node(scriptCopy).data.previs_source,pvShotGuideTargets({n:copiedMotion},curV(copiedMotion)).has(videoCopy)]'),
  [evaluate('motionCopy'),true],'copied shots bind to the copied whitebox and video');
 evaluate('undo()');
 evaluate('undo()');
 assert.equal(evaluate('previsInput(node(shotMotionTarget.id))'),null);
 evaluate('undo()');
 equal(evaluate('[B.nodes.length,B.edges.length,undoStack.length]'),scenarioState.beforePrevisStory,'one undo removes every imported shot and connection');
 evaluate(`const beforeMotionBatch=snap(), motionBase=pvInitialScene();
  motionBase.duration=10;
  const guideSpans=[[0,24],[24,80],[80,136],[136,184],[184,240]];
  motionBase.camera=guideSpans.map(([t],i)=>({...motionBase.camera[0],t,ease:i?"cut":"linear"}));
  const batchMotion=addNode("video",0,0,{previs:motionBase},{name:"批量白模"});
  const batchGuide=(span,ref)=>({ref,source:"previs",seconds:(span[1]-span[0])/24,
    url:"/media?ref="+encodeURIComponent(ref),previs_span:span,previs_recipe:structuredClone(motionBase)});
  const reusableGuide=batchGuide(guideSpans[1],"output:h3studio/reusable-motion.mp4");
  const retainedGuide=batchGuide(guideSpans[4],"output:h3studio/existing-motion.mp4");
  batchMotion.versions.push(reusableGuide,retainedGuide);batchMotion.cur=1;
  const guideShots=guideSpans.map((span,i)=>({id:"batch-shot-"+i,previs_range:span,duration:(span[1]-span[0])/24,
    shot_size:"",camera:"",action:[],dialogue:[]}));
  const batchGuideVideos=guideShots.map((_,i)=>addNode("video",1000+i*400,0));
  const guideBoardScript=addNode("script",0,0,{previs_source:batchMotion.id,shots:guideShots,
    made:batchGuideVideos.map((video,i)=>({shot_id:guideShots[i].id,vid:video.id}))});
  const retainedEdge={from:batchMotion.id,to:batchGuideVideos[4].id,relation:"previs",ref:retainedGuide.ref};
  B.edges.push(retainedEdge);
  openPrevis(batchMotion);$("[data-pv-batch-open]").click();
  const guideBatchConfirm=$("[data-pv-batch-confirm]"), guideBatchRows=$("[data-pv-batch-rows]");`);
 assert.match(evaluate('guideBatchRows.textContent'),/少于 2 秒.*复用当前场景.*渲染并绑定.*已有动作参考/);
 const batchMotionRequests=w.__previsRequests.length;
 evaluate('B.edges.push({...retainedEdge,to:batchGuideVideos[3].id});guideBatchConfirm.click()');
 assert.equal(w.__previsRequests.length,batchMotionRequests);
 assert.match(evaluate('$("[data-pv-status]").textContent'),/请核对后再次确认/);
 evaluate('B.edges.pop();$("[data-pv-batch-open]").click()');
 const guideBatchFetch=w.fetch;
 let heldMotionJob;
 w.fetch=async(url,options)=>{
  const response=await guideBatchFetch(url,options);
  if(String(url)==='/api/previs/render'&&JSON.parse(options.body).span?.[0]===80){
   const {ids:[id]}=await response.json(), completed=jobs.get(id);
   heldMotionJob={id,completed};jobs.set(id,{...completed,state:"running"});
  }
  return response;
 };
 evaluate('guideBatchConfirm.click()');
 await ready('batchMotion.job && PV.editor.guideBatch','the confirmed batch submits the first pending render',500);
 assert.equal(w.__previsRequests.length,batchMotionRequests+1,'the next render waits for the current job');
 jobs.set(heldMotionJob.id,heldMotionJob.completed);
 await ready('!PV.editor.guideBatch','the motion batch finishes and binds its results',650);
 w.fetch=guideBatchFetch;
 assert.deepEqual(w.__previsRequests.slice(batchMotionRequests).map(request=>request.span),[[80,136],[136,184]]);
 equal(evaluate('batchGuideVideos.map(v=>previsInput(v)?.version?.previs_span)'),
  [null,[24,80],[80,136],[136,184],[184,240]],'the batch reuses matching takes, renders pending shots and preserves existing inputs');
 assert.match(evaluate('$("[data-pv-status]").textContent'),/已绑定 3 镜/);
 evaluate(`const batchGuideIds=batchGuideVideos.map(v=>v.id), batchMotionId=batchMotion.id;
  closePrevis();undo();`);
 equal(evaluate('[batchGuideIds.map(id=>!!previsInput(node(id))),node(batchMotionId).versions.length]'),
  [[false,false,false,false,true],4],'one undo clears the new edges and retains rendered takes');
 evaluate('restore(beforeMotionBatch)');
 console.log('Previs storyboard DOM passed: cut poses, timing, upload retry, composition input, dependent video generation, frame-accurate editing, version choice and single undo.');
};
