"use strict";

document.getElementById("mediaToolDialogs").insertAdjacentHTML("beforebegin", OneShotI18n.html`
<dialog id="videoQualityReport" aria-labelledby="videoQualityReportTitle">
  <header><strong id="videoQualityReportTitle">查看质量预检</strong><button type="button" class="pill" id="videoQualityReportClose">关闭</button></header>
  <p id="videoQualityReportDecision"></p>
  <ol id="videoQualityReportAttempts"></ol>
  <section id="videoQualityReportFinal" hidden></section>
</dialog>
`);

const qualityReportDialog=$("#videoQualityReport");
const qualityCheckTitles={subjects:"主体与人数",action:"动作",order:"顺序与站位",camera:"运镜与构图",visual:"场景与画面"};
const qualityCheckStates={pass:"通过",fail:"未通过",unclear:"证据不足"};

function videoQualityProgress(review,status) {
  const {phase,engine_queue:queue,value,max}=status;
  const final=Boolean(review.selected);
  const label=phase==="quality_prepare" ? "正在准备视频提示词" :
    Number.isInteger(queue) ? (final ? "BF16 定稿排队中" : "INT8 样片排队中") :
    phase==="quality_final_review" ? "正在复评 BF16 定稿" :
    final ? "正在生成 BF16 定稿" : phase==="quality_review" ? "正在评估样片" : "正在生成 INT8 样片";
  const attempt=final?review.final_attempt:review.attempt, limit=final?review.final_limit:review.limit;
  return OneShotI18n.t(label)+(queue>0 ? OneShotI18n.t("（前面 {count} 个）",{count:queue}) : "")+
    (attempt && limit ? ` · ${attempt}/${limit}` : "")+
    (Number.isFinite(value) && max>1 ? " · "+OneShotI18n.t("第 {step}/{total} 步",{step:value,total:max}) : "");
}

function showVideoQualityReport(review) {
  if (!review) return;
  const tr=OneShotI18n.t;
  const content=$("#videoQualityReportAttempts");
  content.replaceChildren();
  $("#videoQualityReportDecision").textContent=tr(review.passed
    ? "以第 {attempt} 次通过的提示词开始 BF16 定稿"
    : "五次均未通过，以评分最高的第 {attempt} 次提示词开始 BF16 定稿",{attempt:review.selected});
  function appendAssessment(parent, heading, result) {
    const title=document.createElement("strong");
    title.textContent=heading;
    const summary=document.createElement("p");
    summary.textContent=Object.entries(result.checks||{}).map(([key,status])=>`${tr(qualityCheckTitles[key])} ${tr(qualityCheckStates[status])}`).join(" · ");
    parent.append(title,summary);
    if(result.evidence) {
      const note=document.createElement("p");
      note.textContent=result.evidence;
      parent.append(note);
    }
  }
  for (const result of review.attempts||[]) {
    const row=document.createElement("li");
    appendAssessment(row,tr("第 {attempt} 次 · {score}/10 分",{attempt:result.attempt,score:result.score}),result);
    content.append(row);
  }
  const final=$("#videoQualityReportFinal"), assessment=review.final_assessment;
  const attempts=review.final_attempts || [];
  const independent=review.benchmark_assessment;
  final.replaceChildren();
  final.hidden=!(attempts.length || Number.isFinite(assessment?.score) ||
    review.final_review_failed || review.final_retry_failed);
  if (attempts.length > 1) {
    for (const result of attempts) {
      appendAssessment(final,tr("BF16 第 {attempt} 次复评 · {score}/10 分",{attempt:result.attempt,score:result.score}),result);
    }
    const selected=document.createElement("p");
    selected.textContent=tr("保留第 {attempt} 次 BF16 定稿",{attempt:review.final_selected});
    final.append(selected);
  } else if (Number.isFinite(assessment?.score)) {
    appendAssessment(final,tr("BF16 定稿复评 · {score}/10 分",{score:assessment.score}),assessment);
  }
  if (Number.isFinite(independent?.score)) {
    appendAssessment(final,tr("对照测试评分 · {score}/10 分",{score:independent.score}),independent);
  }
  if (review.final_review_failed || review.final_retry_failed) {
    const notice=document.createElement("p");
    notice.textContent=tr(review.final_retry_failed?"BF16 补跑未完成，已保留原定稿":"BF16 复评未完成，已保留可用定稿");
    final.append(notice);
  }
  if (qualityReportDialog.showModal) qualityReportDialog.showModal();
  else qualityReportDialog.setAttribute("open","");
}

$("#videoQualityReportClose").onclick=()=>{
  if (qualityReportDialog.close) qualityReportDialog.close();
  else qualityReportDialog.removeAttribute("open");
};
