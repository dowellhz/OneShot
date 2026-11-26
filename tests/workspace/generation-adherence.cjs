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
  evaluate(`const savedGenerationCaps=CAPS_LIST;
   CAPS_LIST={...CAPS_LIST,image:[{id:"local_h3",name:"本地 H3",local:true,default:true,model:"h3-image",models:[
     {id:"h3-image"},{id:"qwen-image-2.1",label:"Qwen-Image-2.1",image_engine:true,high_resolution:true,ref_limit:6},
     {id:"flux-2-klein-4b",label:"FLUX.2 [klein] 4B",image_engine:true,ref_limit:4}]},
     {id:"google",name:"Google Gemini",model:"gemini-3.1-flash-image",models:[{id:"gemini-3.1-flash-image",label:"Nano Banana 2"}]},
     {id:"openai",name:"OpenAI",model:"gpt-image-2.5-flare",models:[{id:"gpt-image-2.5-flare"},{id:"gpt-image-2.6-sunburst"}]}]};
   const altImage=addNode("image",180,250,{prompt:"move the ball",model:"h3video"});
   selectOnly(altImage.id);
   const changeModel=(key,value)=>{
     const field=$('#ctl select[data-k="'+key+'"]');
     field.value=value;field.dispatchEvent(new Event("change"));
   };
   changeModel("selected_model","qwen-image-2.1");`);
  assert.equal(evaluate('imageCanvasRequest(altImage,altImage.data.prompt).request.selected_model'),"qwen-image-2.1");
  assert.equal(evaluate('imageCanvasRequest(altImage,altImage.data.prompt).request.model'),"h3img");
  assert.equal(evaluate('$("#ctl select[data-k=model]")'),null);
  evaluate('changeModel("selected_model","flux-2-klein-4b")');
  assert.equal(evaluate('$("#ctl select[data-k=quality]")'),null);
  evaluate('changeModel("provider","google")');
  assert.match(evaluate('$("#ctl").textContent'),/Nano Banana 2/);
  evaluate('changeModel("provider","openai");changeModel("selected_model","gpt-image-2.6-sunburst")');
  assert.equal(evaluate('imageCanvasRequest(altImage,altImage.data.prompt).request.selected_model'),"gpt-image-2.6-sunburst");
  evaluate('removeNodes([altImage.id]);CAPS_LIST=savedGenerationCaps');
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
