"use strict";

function scriptedDialogue(version) {
  const record=version.generation_record;
  const prompt=record?.effective_prompt || version.video_recipe?.prompt || version.prompt || "";
  const detailed=prompt.match(/(?:^|\n)(?:detailed_description|integrated_multimodal_description):\s*([\s\S]*?)(?=\n\n(?:overall_soundscape|non_diegetic_music):|$)/);
  const lines=[...(detailed?.[1] || prompt).matchAll(/<d>\s*(?:\[[^\]\r\n]+\]\s*)?([\s\S]*?)<\/d>/g)]
    .map(match=>match[1].trim()).filter(Boolean);
  if (lines.length) return lines;
  const fields=record?.fields?.dialogue || version.video_recipe?.fields?.dialogue;
  if (typeof fields==="string" && fields.trim()) {
    return fields.trim().split(/\r?\n/).map(line=>line.replace(/^[^：:\n]{1,60}[：:]\s*/, "").trim()).filter(Boolean);
  }
  return prompt.includes("No human speech, narration or voices of any kind.") ? [] : null;
}

function normalizedSpeech(text) {
  return text.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{Z}\s]+/gu,"");
}

async function openDialogueReview(n, version) {
  if (!canvasCanEdit() || n.type!=="video" || !version?.ref) return;
  const dialog=$("#dialogueReview");
  const expected=scriptedDialogue(version);
  const speak=$("#dialogueReviewExpected"), actual=$("#dialogueReviewActual"), status=$("#dialogueReviewStatus");
  const current=()=>dialog.open && dialog.review===review && B===board;
  const board=B, review=Symbol();
  dialog.review=review;
  $("#dialogueReviewAudio").src="/media?ref="+encodeURIComponent(version.ref);
  $("#dialogueReviewVersion").textContent=OneShotI18n.t("{name} · 版本 {version}",{name:n.name,version:n.cur+1});
  speak.textContent=expected?.join("\n") || OneShotI18n.t(expected ? "无预期对白" : "此版本没有记录预期对白");
  actual.textContent="";
  status.textContent=OneShotI18n.t("正在识别视频原声…");
  if (!dialog.open) {
    if (dialog.showModal) dialog.showModal();
    else dialog.setAttribute("open","");
  }
  try {
    await flushSave();
    if (!current()) return;
    const result=await api("/api/video/captions",{board:boardId,ref:version.ref});
    if (!current()) return;
    const cues=result.captions||[];
    actual.textContent=cues.map(cue=>`${Number(cue.start).toFixed(2)}s  ${cue.text}`).join("\n")
      || OneShotI18n.t("未识别到对白");
    if (expected) {
      const match=normalizedSpeech(expected.join(" "))===normalizedSpeech(cues.map(cue=>cue.text).join(" "));
      status.textContent=OneShotI18n.t(match ? "转写与预期对白一致" : "转写与预期对白有差异，请听原声核对");
    } else status.textContent=OneShotI18n.t("转写完成");
  } catch (error) {
    if (current()) status.textContent=error.message;
  }
}

const dialogueReviewDialog=$("#dialogueReview");
dialogueReviewDialog.addEventListener("close",()=>$("#dialogueReviewAudio").removeAttribute("src"));
$("#dialogueReviewClose").onclick=()=>{
  if (dialogueReviewDialog.close) dialogueReviewDialog.close();
  else {
    dialogueReviewDialog.removeAttribute("open");
    $("#dialogueReviewAudio").removeAttribute("src");
  }
};
