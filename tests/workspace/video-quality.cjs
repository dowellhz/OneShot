"use strict";

module.exports=async function videoQuality({assert,evaluate}) {
 evaluate(`const originalQualityCaps=CAPS_LIST, oldQualityWizard=W;
  W={quality:"std",takes:2};
  CAPS_LIST={...CAPS_LIST,video_quality_precheck:true,video:[{id:"local_h3",local:true,default:true,model:"h3-video",
    models:[{id:"h3-video",durations:[5,8,10,14]},{id:"h3-video-ref2va-int8-convrot"}]}]};
  const qualityTest=addNode("video",400,510,{provider:"local_h3",prompt:"Fixed camera.",count:3});
  selectOnly(qualityTest.id); showPanel();`);
 assert.equal(evaluate('videoReq(qualityTest,"Fixed camera.").quality_precheck'),true);
 evaluate(`$("#setBtn").click(); $("#setVideoPrecheck").click();`);
 assert.equal(evaluate('localStorage.getItem(VIDEO_QUALITY_PREFERENCE)'),"off");
 assert.equal(evaluate('videoReq(qualityTest,"Fixed camera.").quality_precheck'),undefined);
 assert.equal(evaluate('videoReq(qualityTest,"Fixed camera.").count'),3);
 assert.equal(evaluate('wizardQualityEnabled()'),false);
 evaluate(`$("#setClose").click(); $("#setBtn").click();`);
 assert.equal(evaluate('$("#setVideoPrecheck").checked'),false);
 evaluate(`$("#setClose").click(); const qualitySetting=$('[data-k="quality_precheck"]');
  qualitySetting.value="true"; qualitySetting.onchange();`);
 assert.equal(evaluate('videoReq(qualityTest,"Fixed camera.").quality_precheck'),true);
 assert.equal(evaluate('videoReq(qualityTest,"Fixed camera.").count'),1);
 assert.equal(evaluate('qualityTest.data.count'),3);
 evaluate(`$("#setBtn").click(); $("#setVideoPrecheck").click(); $("#setClose").click();
  setWizardVideoQuality(qualityTest,W.takes)`);
 assert.equal(evaluate('qualityTest.data.selected_model'),"h3-video");
 assert.equal(evaluate('videoReq(qualityTest,"Fixed camera.").quality_precheck'),true);
 assert.equal(evaluate('videoReq(qualityTest,"Fixed camera.").quality'),"std");
 evaluate('W=oldQualityWizard');
 assert.match(evaluate('videoQualityProgress({attempt:1,limit:5},{phase:"quality_draft",engine_queue:4})'),
  /INT8 样片排队中.*前面 4 个/);
 assert.match(evaluate('videoQualityProgress({attempt:1,limit:5},{phase:"quality_draft",value:2,max:4})'),
  /正在生成 INT8 样片.*第 2\/4 步/);
 evaluate(`qualityTest.versions=[{ref:"output:h3studio/quality.mp4",generation_record:{quality_review:{
  limit:5,selected:2,passed:false,final_assessment:{score:9,checks:{action:"unclear"},evidence:"Final shot evidence"},attempts:[{attempt:2,score:8,checks:{action:"fail"},evidence:"Repeated exit"}]
 }}}]; qualityTest.cur=0; nodeAction(qualityTest,"video-quality-report");`);
 assert.match(evaluate('$("#videoQualityReportDecision").textContent'),/第 2 次/);
 assert.match(evaluate('$("#videoQualityReportAttempts").textContent'),/Repeated exit/);
 assert.match(evaluate('$("#videoQualityReportFinal").textContent'),/9\/10.*Final shot evidence/);
 evaluate('$("#videoQualityReportClose").click(); removeNodes([qualityTest.id]); CAPS_LIST=originalQualityCaps; localStorage.removeItem(VIDEO_QUALITY_PREFERENCE);');
 console.log("Video quality precheck passed: settings persistence, node override, one final and recorded decisions.");
};
