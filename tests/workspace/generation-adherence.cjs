"use strict";

module.exports = async function generationAdherence({ assert, evaluate, ready, w }) {
 const original=w.fetch;
 const generated=[];
 w.fetch=(url,options={})=>{
  const path=new URL(String(url),w.location.href).pathname;
  if(path==="/api/preview"){
   const payload=JSON.parse(options.body);
   assert.equal(payload.image_text,"specified");
   assert.equal(payload.images[0].image_use,"camera");
   return Promise.resolve(new Response(JSON.stringify({prompt:"Only show 17.",mode:"H3-Image",
    image_preview:"test-preview",inputs:[{...payload.images[0],image_role:"image_camera"}]})));
  }
  if(path==="/api/generate"){
   generated.push(JSON.parse(options.body));
   return Promise.resolve(new Response(JSON.stringify({ids:["reviewed-image-job"],meta:{}})));
  }
  if(path==="/api/video/captions")return Promise.resolve(new Response(JSON.stringify({
   captions:[{start:.4,end:1.8,text:"你也是来看米拉的？"},{start:2,end:3,text:"声读提示词"}]
  })));
  return original(url,options);
 };
 try {
  evaluate(`const checkImage=addNode("image",250,250,{prompt:'门牌写“17”',image_text:"specified"});
   B.edges.push({from:"n1",to:checkImage.id,image_use:"camera"}); selectOnly(checkImage.id); showPanel(); $("#pvBtn").click();`);
  await ready('$("#pv").classList.contains("on") && !$("#pvBranchCommit").hidden',"prepared image preview");
  assert.equal(evaluate('$("#pvt").textContent'),"Only show 17.");
  assert.equal(evaluate('$("#pvModelCheck").hidden'),true);
  evaluate('$("#pvBranchCommit").click()');
  await ready('!!checkImage.job || checkImage.versions.length>0',"submit the reviewed image");
  assert.equal(generated[0].image_preview,"test-preview");

  evaluate(`const checkVideo=addNode("video",300,450);
   checkVideo.versions=[{ref:"output:h3studio/dialogue-review.mp4",seconds:5,generation_record:{
    effective_prompt:"summary: <d>[Chinese] 你也是来看米拉的？</d>\\n\\ndetailed_description:\\n<d>[Chinese] 你也是来看米拉的？</d>\\n\\noverall_soundscape:\\nFootsteps."
   }}]; checkVideo.cur=0; selectOnly(checkVideo.id); nodeAction(checkVideo,"dialogue-review");`);
  await ready('$("#dialogueReviewActual").textContent.includes("声读提示词")',"video audio transcript");
  assert.equal(evaluate('$("#dialogueReviewExpected").textContent'),"你也是来看米拉的？");
  assert.match(evaluate('$("#dialogueReviewStatus").textContent'),/有差异/);
  evaluate('$("#dialogueReviewClose").click(); removeNodes([checkImage.id,checkVideo.id]);');
 } finally {
  w.fetch=original;
 }
 console.log("Generation adherence passed: stable image preview and version-specific dialogue review.");
};
