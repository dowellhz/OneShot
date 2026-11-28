"use strict";

const activeWizardProductions = new WeakSet();

async function prepareWizardScreenplaySource() {
  const board = B, wizard = W;
  const t = OneShotI18n.t;
  const idea = (wizard.idea || "").trim() ||
    (wizard.media?.length ? t("使用上传的素材制作一个连贯的短片，尊重已指定的素材用途。") : "");
  if (!idea) { toast("先写一句你的想法"); return null; }
  const media = await prepareWizardUploads();
  if (!media || B !== board || W !== wizard) return null;
  let script = wizScript();
  if (!script) { script = addNode("script", 0, 0, {}, {name:"剧本"}); wizard.script = script.id; }
  if (script.data.made?.length) toast("新分镜生成后会展开为一组新镜头");
  Object.assign(script.data,{prompt:`${idea}\n风格：${wizard.style}`,nshots:"auto",shotlen:"auto",aspect:wizard.aspect,quality:wizard.quality});
  wizard.step = 1;
  wizSave();
  return {script,media};
}

async function wizardPlanScript() {
  const board = B, wizard = W;
  const prepared = await prepareWizardScreenplaySource();
  if (!prepared) return false;
  const {script,media} = prepared;
  const t = OneShotI18n.t;
  delete wizard.screenplay;
  const run = wizard.production?.status === "running" ? wizard.production : null;
  const active = () => B === board && W === wizard && wizard.production === run && run.status === "running";
  const requestDraft = !run ? undefined : async payload => {
    run.draft ||= {...payload,script:script.id,key:filmExportKey()};
    wizSave();
    await flushSave();
    if (active() && (savePending?.id === payload.board || AC.pending.has(payload.board) || !boardSaveRetry.hidden))
      throw new Error(t("制作进度未保存，请检查连接后继续。"));
    while (active()) {
      const receipt = await api("/api/wizard/screenplay",run.draft);
      if (!active()) return;
      if (receipt.state === "done") return receipt.result;
      if (receipt.state === "error") {
        delete run.draft;
        wizSave();
        throw new Error(receipt.error);
      }
      await sleep(1500);
    }
  };
  const result = planStoryboard(script,{targetSeconds:wizard.dur,resetLinks:true,motionFrames:true,wizardMedia:media,requestDraft});
  renderWiz();
  const planned = await result;
  if (B !== board || W !== wizard || wizScript() !== script) return false;
  if (planned && run) delete run.draft;
  if (!wizard.production) fit(B.nodes);
  renderWiz();
  return !!planned;
}

function wizardProductionSignature(script) {
  if (!script) return null;
  const {style,aspect,shots,characters,visual_assets,wizard_media} = script.data;
  return JSON.stringify([style,aspect,shots,characters,visual_assets,wizard_media]);
}

function wizardProductionStatus(run, status, message = "") {
  Object.assign(run,{status,message});
  wizSave();
  if ($("#wiz").classList.contains("on")) renderWiz();
}

function wizardProductionVisible() {
  return !!W.production && W.production.status !== "done" && !W.production.showEditor;
}

function renderWizardProduction(body) {
  const run = W.production;
  if (!wizardProductionVisible()) return false;
  const running = run.status === "running", t = OneShotI18n.t;
  const script = wizScript();
  const links = script ? scriptShotLinks(script) : [];
  const done = links.filter(pair => storyboardVersionReady(node(pair?.vid))).length;
  const message = run.message || t("当前阶段：{stage}", {stage:t(WSTEPS[W.step])});
  body.innerHTML = OneShotI18n.html`<div class="wz6">
    <h2>生成可编辑初稿</h2>
    <p class="tip" role="status">${esc(message)}</p>
    ${links.length ? `<p>${esc(t("已完成 {ready}/{total} 个视频镜头",{ready:done,total:links.length}))}</p>` : ""}
    ${run.pending ? `<p>${esc(node(run.pending.id)?.name || "")} ${esc(jobText(node(run.pending.id)))}</p>` : ""}
    <p class="est">${t(run.videoBatch?.assembly && run.videoBatch.started ? "服务器会继续生成镜头并合成初稿。重新打开向导可接回成片。" : run.videoBatch?.started ? "服务器会继续处理这一批镜头。重新打开向导可接回结果并合成。" : "已提交的生成任务会继续运行。关闭页面后，重新打开向导可继续制作。")}</p>
    <div class="row">
      ${running ? OneShotI18n.html`<button class="ghost" type="button" data-production-pause>暂停提交后续任务</button>` :
        OneShotI18n.html`<button class="go" type="button" data-production-resume ${activeWizardProductions.has(run) ? "disabled" : ""}>${t(run.status === "uncertain" ? "确认后重试该步骤" : "继续制作")}</button>`}
      ${!running && script?.data.shots?.length ? OneShotI18n.html`<button class="ghost" type="button" data-production-review>${t(run.stage === 2 ? "查看制作素材" : run.frameReview ? "查看关键帧" : "查看和编辑分镜")}</button>` : ""}
    </div></div>`;
  $("[data-production-pause]",body)?.addEventListener("click", () => void pauseWizardProduction(run));
  $("[data-production-resume]",body)?.addEventListener("click", () => void continueWizardProduction());
  $("[data-production-review]",body)?.addEventListener("click", () => {run.showEditor = true; goStep(run.stage === 2 ? 2 : run.frameReview ? 3 : 1);});
  return true;
}

async function startWizardProduction() {
  if (!canvasCanEdit() || W.production && W.production.status !== "done") return;
  if (!(W.idea || "").trim() && !W.media?.length) return toast("先写一句你的想法");
  W.production = {stage:1,status:"running",previousScriptShot:wizScript()?.data.shots?.[0]?.id || null};
  await resumeWizardProduction();
}

async function continueWizardProduction() {
  const run = W.production;
  if (!run || !canvasCanEdit() || activeWizardProductions.has(run)) return;
  if (run.status === "uncertain") { run.pending = null; run.videoBatch = null; }
  run.showEditor = false;
  W.step = run.stage;
  const signature = wizScript()?.data.shots?.length ? wizardProductionSignature(wizScript()) : null;
  if ((run.pending || run.videoBatch) && run.reviewed !== signature) {
    wizardProductionStatus(run,"paused",OneShotI18n.t("分镜已修改，待恢复的提交仍用原分镜。请先撤销这次分镜修改。"));
    return;
  }
  if (run.videoBatch && run.status === "paused") run.videoBatch.resumeRequested = true;
  if (run.frameReview) {run.acceptedFrameReview = run.frameReview; delete run.frameReview;}
  run.reviewed = signature;
  wizardProductionStatus(run,"running");
  await resumeWizardProduction();
}

async function resumeWizardProduction() {
  const board = B, bid = boardId, wizard = W, run = wizard?.production;
  if (run?.status !== "running" || !canvasCanEdit() || activeWizardProductions.has(run)) return;
  const current = () => B === board && boardId === bid && W === wizard && W.production === run && canvasCanEdit();
  const active = () => current() && run.status === "running";
  const t = OneShotI18n.t;
  const persist = async () => {
    wizSave();
    await flushSave();
    if (active() && (savePending?.id === bid || AC.pending.has(bid) || !boardSaveRetry.hidden))
      throw new Error(t("制作进度未保存，请检查连接后继续。"));
  };
  const unchanged = () => active() && (!run.reviewed || wizardProductionSignature(wizScript()) === run.reviewed);
  const advance = async stage => {
    if (!unchanged()) return false;
    run.stage = stage;
    wizard.step = stage;
    wizardProductionStatus(run,"running");
    await persist();
    return active();
  };
  const wait = async media => {
    while (unchanged() && node(media.id) === media && (media.job || prepping.has(media.id))) await sleep(300);
    return unchanged() && node(media.id) === media;
  };
  const receive = async (media, pending, resend) => {
    const sameNode = () => unchanged() && node(media.id) === media;
    const apply = result => {
      if (!sameNode()) return false;
      if (!media.job && curV(media)?.ref === pending.previous) applyCanvasGenerationReceipt(media,result,pending.snapshot);
      return true;
    };
    while (sameNode()) {
      const receipt = await canvasGenerationSubmissionStatus(bid,pending);
      if (!sameNode()) return false;
      if (receipt.state === "accepted") return apply(receipt.result);
      if (receipt.state === "rejected") {
        run.pending = null;
        await persist();
        throw new Error(canvasGenerationError(media) || t("服务器拒绝了该生成请求，请检查镜头后重试。"));
      }
      if (receipt.state === "missing" && resend) {
        resend = false;
        try { return apply(await sendCanvasGenerationSubmission(media.id,pending.key,pending.snapshot.payload)); }
        catch { continue; }
      }
      if (receipt.state === "missing") throw new Error(t("未收到提交回执。继续制作时将用原编号重试。"));
      if (receipt.state !== "submitting") {
        wizardProductionStatus(run,"uncertain",t("提交状态未记录。先检查任务中心，再确认重试。"));
        return false;
      }
      await sleep(1000);
    }
    return false;
  };
  const submit = async (media, options) => {
    if (!unchanged() || node(media.id) !== media) return false;
    if (!media.job && !prepping.has(media.id)) {
      if (nodeLocked(media)) throw new Error(t("节点「{name}」已锁定。",{name:media.name}));
      const pending = {id:media.id,key:filmExportKey(),previous:curV(media)?.ref};
      await generate(media,{...options,batchLayout:"tabs",submission:{key:pending.key,prepare:async snapshot => {
        if (!unchanged()) return false;
        run.pending = Object.assign(pending,{snapshot});
        await persist();
        if (unchanged()) return true;
        if (current()) {run.pending = null; await persist();}
        return false;
      }}});
      if (!current()) return false;
      if (!media.job && curV(media)?.ref === pending.previous) {
        if (!active()) return false;
        if (!pending.snapshot) throw new Error(canvasGenerationError(media) || t("未生成「{name}」。",{name:media.name}));
        if (!await receive(media,pending,false)) return false;
      }
      if (run.pending === pending) { pending.acknowledged = true; await persist(); }
    }
    if (!await wait(media)) return false;
    if (run.pending?.id === media.id) {run.pending = null; await persist();}
    return active();
  };

  activeWizardProductions.add(run);
  try {
    wizard.step = run.stage;
    if ($("#wiz").classList.contains("on")) renderWiz();
    await persist();
    if (!active()) return;
    if (run.pending) {
      const pending = run.pending, {id,previous,acknowledged} = pending, media = node(id);
      if (media && pending.key && pending.snapshot && !media.job && curV(media)?.ref === previous) {
        if (!await receive(media,pending,true)) return;
      }
      if (!media || !media.job && !acknowledged && (curV(media)?.ref || null) === (previous || null)) {
        wizardProductionStatus(run,"uncertain",t("提交状态未记录。先检查任务中心，再确认重试。"));
        return;
      }
      if (!await wait(media)) return;
      run.pending = null;
      await persist();
      if (curV(media)?.ref === previous) throw new Error(canvasGenerationError(media) || t("未生成「{name}」。",{name:media.name}));
    }
    if (run.stage === 1) {
      const firstShot = wizScript()?.data.shots?.[0];
      if ((!firstShot || firstShot.id === run.previousScriptShot) && !await wizardPlanScript())
        throw new Error(t("剧本尚未生成。"));
      if (!active()) return;
      const script = wizScript(), signature = wizardProductionSignature(script);
      if (run.reviewed !== signature && wizardStoryboardWarnings(script).size) {
        wizardProductionStatus(run,"paused",t("分镜有需要核对的地方。可查看和编辑分镜后继续。"));
        return;
      }
      run.reviewed = signature;
      if (!await advance(2)) return;
    }
    const script = wizScript();
    if (run.stage === 2) {
      await startWizardOpeningAnalysis({production:true});
      if (!unchanged()) return;
      if (!await prepareWizardAssets(script,{submit,keepRunning:unchanged})) {
        if (unchanged()) throw new Error(t("制作素材尚未就绪。"));
        return;
      }
      if (!await advance(3)) return;
    }
    if (run.stage === 3) {
      expandMissingScriptShots(script);
      await persist();
      if (!unchanged()) return;
      const frames = [...new Set(scriptShotLinks(script).flatMap(pair => pair ? shotFrameIds(pair) : []))].map(node);
      for (const frame of frames) {
        if (storyboardFrameReady(frame)) continue;
        if (!await submit(frame)) return;
        if (!storyboardFrameReady(frame)) throw new Error(canvasGenerationError(frame) || t("未生成「{name}」。",{name:frame.name}));
      }
      if (maxStep() < 4) throw new Error(t("请先补齐分镜关键帧"));
      const framesToReview = wizardFrameReviewInputs();
      const frameSignature = JSON.stringify(framesToReview);
      if (framesToReview.length && frameSignature !== run.acceptedFrameReview) {
        const warnings = await reviewWizardFrameImages();
        if (!unchanged()) return;
        if (warnings.some(warning=>!warning.advisory)) {
          run.frameReview = frameSignature;
          wizardProductionStatus(run,"paused",t("关键帧有需要核对的地方。请检查角色和道具动作后继续。"));
          return;
        }
      }
      if (!await advance(4)) return;
    }
    if (run.stage === 4) {
      if (!await runWizardVideoBatch(run,script,{active:unchanged,persist,wait})) return;
      if (wizardMissingVideos(script).length) throw new Error(t("仍有镜头缺少视频。"));
      if (!await advance(5)) return;
    }
    let film = wizardFilm(script);
    if (!film?.job && !curV(film)) {
      if (FILM) throw new Error(t("请先关闭正在使用的剪辑台，再继续制作。"));
      if (!openStoryFilm(script,0,script.data.shots.length-1,"cut")) throw new Error(t("无法打开成片剪辑。"));
      const editor = FILM;
      if (film) editor.n = film;
      await exportFilm();
      if (!current()) return;
      film = wizardFilm(script);
      if (!film?.job && !curV(film)) {
        if (FILM === editor) closeFilm();
        throw new Error(t("成片未提交，请检查剪辑内容后重试。"));
      }
    }
    if (!await wait(film)) return;
    if (!curV(film)) throw new Error(canvasGenerationError(film) || t("成片尚未生成。"));
    wizardProductionStatus(run,"done");
    await persist();
  } catch (error) {
    if (active()) wizardProductionStatus(run,"error",error.message);
  } finally {
    if (active() && !unchanged()) wizardProductionStatus(run,"paused",t("分镜已修改，请核对后继续。"));
    activeWizardProductions.delete(run);
    if (current() && $("#wiz").classList.contains("on")) renderWiz();
  }
}
