"use strict";

module.exports = async function wizardProduction({assert, equal, evaluate, englishSmoke}) {
  const result = await evaluate(`(async () => {
    const saved = {W,wiz:B.wiz,api,generate,exportFilm,poll}, before = snap();
    const submitted = [], openingRef = "input:h3studio/production-opening.png";
    try {
      const source = addNode("image",0,0);
      source.versions = [{ref:openingRef,url:"/media?ref="+encodeURIComponent(openingRef),w:1280,h:720}];
      source.cur = 0;
      W = B.wiz = {step:0,idea:"",style:"写实电影",dur:15,aspect:"16:9",quality:"std",takes:1,
        media:[{kind:"image",use:"first",node:source.id,ref:openingRef}]};
      $("#wiz").classList.add("on");
      renderWiz();
      const labels = [$("[data-go=script]").textContent,$("[data-go=produce]").textContent];
      const same = ["A sailor raises the flag","Wind catches it"];
      const shot = (action, keyframe) => ({action,keyframe,characters:[],dialogue:[],duration:5,scene:"Deck",camera:"Static",shot_size:"Wide"});
      let planned = 0, reload = false, savedKey, pinnedRequest, recoveredPrompt, missingImage, queuedBatch;
      const batchSubmissions = [];
      const retries = [], resend = ${englishSmoke};
      const accepted = {ids:["accepted-before-reload"],video_model:{provider:"local_h3"}};
      api = async (path, body, method, headers) => {
        if (path.startsWith("/api/generate/receipt?")) {
          const key = new URLSearchParams(path.split("?")[1]).get("key");
          if (key !== savedKey) throw new Error("Wrong submission ID");
          if (!reload) throw new Error("Connection lost after sending the request");
          return resend ? {state:"missing"} : {state:"accepted",result:accepted};
        }
        if (path === "/api/generate") {
          retries.push(headers["X-OneShot-Submission"] === savedKey && JSON.stringify(body) === pinnedRequest);
          return accepted;
        }
        if (path === "/api/wizard/video-batches") {
          batchSubmissions.push(JSON.stringify(body));
          if (!queuedBatch) {
            queuedBatch = body;
            throw new Error("Batch response lost after registration");
          }
          queuedBatch = body;
          const timeline = newSpec([]);
          timeline.story_script = body.script;
          timeline.clips = body.assembly.map(({node:id})=>({node:id,ref:"output:h3studio/production-"+id+".mp4",kind:"video"}));
          return {state:"done",entries:body.entries.map(({node})=>({node,state:"done",result:{ids:["batch-"+node]}})),
            film:{state:"done",job_id:"background-film",timeline}};
        }
        if (path !== "/api/wizard/screenplay") throw new Error(path);
        planned++;
        if (!body.story || body.refs[0]?.ref !== openingRef) throw new Error("Opening image not sent to planning");
        return {state:"done",result:{title:"A Flag",style:"Realism",characters:[],shots:[shot(same,"Flag still folded"),shot(same,"Flag above the deck")]}};
      };
      const finish = n => {
        n.versions.push({ref:"output:h3studio/production-"+n.id+(n.type==="video"?".mp4":".png"),
          w:1280,h:720,seconds:5,url:"/media?ref=production"});
        n.cur = n.versions.length - 1;
        delete n.job;
      };
      generate = async (n, {submission,snapshotOnly}) => {
        const req = {kind:n.type,board:boardId,prompt:"Frozen shot prompt"};
        const snapshot = {req,payload:req,prompt:req.prompt,textInputs:[],history:{video_recipe:{...req},node_data:{}}};
        if (snapshotOnly) return snapshot;
        submitted.push(n.id);
        if (n.type === "image" && n === shotPairs().at(-1)?.img) {
          missingImage = n;
          savedKey = submission.key;
          pinnedRequest = JSON.stringify(req);
          await submission.prepare(snapshot);
          return;
        }
        finish(n);
      };
      poll = () => {
        if (missingImage?.job?.ids[0] === accepted.ids[0]) {
          recoveredPrompt = missingImage.job.history.video_recipe.prompt;
          finish(missingImage);
        }
        for (const {node:id} of queuedBatch?.entries || []) {
          const video = node(id);
          if (video.job?.ids[0] === "batch-"+id) finish(video);
        }
        const film = wizardFilm(wizScript());
        if (film?.job?.ids[0] === "background-film") finish(film);
      };
      exportFilm = async () => {
        throw new Error("The browser must not export the server-rendered film again");
      };
      await startWizardProduction();
      const firstPause = W.production.status, submissionsBeforeReview = submitted.length;
      if (firstPause !== "paused") throw new Error(W.production.message || firstPause);
      $("[data-production-review]").click();
      const warned = $("[data-i='1'] [role=status]").textContent;
      const actions = $("[data-i='1'] [data-f=action]");
      actions.value = "The sailor lowers the flag";
      actions.dispatchEvent(new Event("input"));
      const warningCleared = !$("[data-i='1'] [role=status]");
      await continueWizardProduction();
      const unclear = W.production.status;
      const picturesAfterFirstRun = shotPairs().map(({img})=>[img.id,curV(img)?.ref]);
      const videoIds = shotPairs().map(({vid})=>vid.id);
      W = B.wiz = structuredClone(B.wiz);
      W.production.status = "running";
      reload = true;
      await resumeWizardProduction();
      const savedBatch = W.production.status === "error" && W.production.videoBatch?.id;
      W = B.wiz = structuredClone(B.wiz);
      await continueWizardProduction();
      const film = wizardFilm(wizScript());
      return {labels,firstPause,submissionsBeforeReview,warned,warningCleared,unclear,planned,final:W.production.status,submitted,recoveredPrompt,retries,
        opening:picturesAfterFirstRun[0][1],images:picturesAfterFirstRun.map(([id])=>id),videoIds,
        film:film?.data.film.clips.map(clip=>clip.node),queued:queuedBatch?.entries.map(item=>item.node),
        sameBatch:!!savedBatch && batchSubmissions.length === 2 && batchSubmissions[0] === batchSubmissions[1]};
    } finally {
      if (FILM) closeFilm();
      ({W,api,generate,exportFilm,poll} = saved);
      restore(before);
      B.wiz = saved.wiz;
      closeWizard();
    }
  })()`);
  equal(result.labels, englishSmoke ? ["Review the storyboard first","Generate a rough cut"] : ["先看分镜","直接生成初稿"]);
  equal([result.firstPause,result.submissionsBeforeReview,result.unclear,result.planned,result.final],["paused",0,"error",1,"done"]);
  assert.match(result.warned, englishSmoke ? /repeats the same actions/ : /同一组动作/);
  assert.equal(result.warningCleared,true);
  equal(result.opening,"input:h3studio/production-opening.png");
  equal(result.submitted,[result.images[1]]);
  equal(result.queued,[...result.videoIds]);
  assert.equal(result.sameBatch,true);
  equal(result.film,[...result.videoIds]);
  equal([result.recoveredPrompt,result.retries],["Frozen shot prompt",englishSmoke ? [true] : []]);
  console.log("Rough cut passed: review, pinned upload, server receipt or same-ID retry, and editable final.");
};
