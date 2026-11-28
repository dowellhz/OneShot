"use strict";

function wizardStoryboardWarnings(script) {
  const warnings = new Map(), seen = new Set(), t = OneShotI18n.t;
  const shots = script?.data.shots || [];
  shots.forEach((shot, index) => {
    const issues = [];
    const actions = (shot.action || []).map(normalizedSpeech).filter(Boolean);
    const key = actions.join("\n");
    if (actions.length > 1 && seen.has(key))
      issues.push(t("另一镜已有同一组动作。请只保留这一镜要拍的动作。"));
    if (key) seen.add(key);
    const frameDescriptions = [shot.keyframe, shot.motion_frames?.middle, shot.motion_frames?.end]
      .filter(Boolean).map(normalizedSpeech).filter(Boolean);
    if (new Set(frameDescriptions).size < frameDescriptions.length)
      issues.push(t("关键帧描述重复，请补出动作前后不同的姿态或道具位置。"));
    if (shot.continues_previous && shots[index-1] && shot.scene !== shots[index-1].scene)
      issues.push(t("这一镜标记为连续动作，但与上一镜的场景不同。请核对转场。"));
    const dialogue = subsOf({data:{fields:{dialogue:(shot.dialogue || []).join("\n")}}}).join(" ");
    const characters = dialogue.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length || 0;
    const words = dialogue.match(/[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Arabic}\d]+/gu)?.length || 0;
    const estimate = Math.ceil(characters / 5 + words / 3);
    if (shot.duration > 0 && estimate > shot.duration)
      issues.push(t("台词粗估需要 {seconds} 秒。请缩短台词或增加镜头时长。",{seconds:estimate}));
    if (issues.length) warnings.set(index,issues);
  });
  return warnings;
}

function wizardStoryboardWarningMarkup(issues = []) {
  return issues.map(issue=>`<p class="wz-shot-error" role="status">${esc(issue)}</p>`).join("");
}

function refreshWizardStoryboardWarnings(script, body) {
  const review = wizardStoryboardWarnings(script);
  $$("[data-wz-story-review]",body).forEach(slot => {
    slot.innerHTML = wizardStoryboardWarningMarkup(review.get(Number(slot.dataset.wzStoryReview)));
  });
}

function wizardFrameReviewInputs() {
  return shotPairs().flatMap(pair => {
    const shot = wizScript().data.shots[pair.index];
    if (!shot?.action_check?.evidence && !shot?.motion_frames?.middle) return [];
    const frames = wizardShotFrames(pair).map(frame=>({ref:curV(frame.node)?.ref,label:frame.label}));
    const expected = shot.action_check?.evidence ? Object.entries({
      "Main action check":shot.action_check.evidence,"First frame":shot.keyframe,
      "Middle frame":shot.motion_frames?.middle,"Last frame":shot.motion_frames?.end,
    }).filter(([,value])=>value).map(([label,value])=>label+": "+value).join("\n").slice(0,1200) : "";
    return frames.length>1 && frames.every(frame=>frame.ref) ? [{shot:pair.index,frames,expected}] : [];
  });
}

async function reviewWizardFrameImages() {
  const current = W, board = B, inputs = wizardFrameReviewInputs();
  if (!inputs.length) return [];
  const result = await api("/api/wizard/frame-review",{
    shots:inputs.map(item=>item.frames.map(frame=>frame.ref)),
    expectations:inputs.map(item=>item.expected),english:OneShotI18n.locale==="en",
  });
  if (current !== W || board !== B || JSON.stringify(inputs)!==JSON.stringify(wizardFrameReviewInputs())) return [];
  W.frameReviews = result.warnings.map(({shot,left,right})=>({
    index:inputs[shot].shot, first:inputs[shot].frames[left], second:inputs[shot].frames[right],
  }));
  W.frameReviews.push(...(result.semantic || []).map(({shot,reason})=>({
    index:inputs[shot].shot, refs:inputs[shot].frames.map(frame=>frame.ref), reason, advisory:true,
  })));
  W.frameReviewCoverage = {checked:result.checked || 0, requested:result.requested || 0};
  wizSave();
  if ($("#wiz").classList.contains("on")) renderWiz();
  return W.frameReviews;
}

function wizardFrameReviewMarkup(pair) {
  const current = new Set(wizardShotFrames(pair).map(frame=>curV(frame.node)?.ref));
  return (W.frameReviews || []).filter(item=>item.index===pair.index&&
      (item.refs || [item.first.ref,item.second.ref]).every(ref=>current.has(ref)))
    .map(item=>`<p class="${item.advisory?"est":"wz-shot-error"}" role="status">${esc(item.reason ? OneShotI18n.t("关键帧动作核对：{reason}",{reason:item.reason}) : OneShotI18n.t(
      "「{first}」和「{second}」画面几乎相同。请检查人物或道具是否推进了动作。",
      {first:item.first.label,second:item.second.label}))}</p>`).join("");
}

async function showWizardFrameReview() {
  try {
    if ((await reviewWizardFrameImages()).length) return;
    const {checked,requested} = W.frameReviewCoverage || {};
    toast(checked < requested ? "未发现近似重复的关键帧，部分动作还需人工核对。" : "未发现关键帧问题。");
  } catch (error) { toast(error.message); }
}
