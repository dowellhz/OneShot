"use strict";

module.exports=async function wizardSuppliedAssets({assert,equal,evaluate,englishSmoke}){
 const result=await evaluate(`(async()=>{
   const before=snap(), state={W,wiz:B.wiz,api,generate,loadLibrary,flushSave,uploadInto,pickFiles};
   const calls=[], refs={hero:"input:h3studio/original-hero.png", room:"input:h3studio/original-room.png",
     prop:"input:h3studio/original-prop.png", old:"output:h3studio/old-hero.png"};
   try {
     const image=(ref,name)=>addNode("image",0,0,{},{name,versions:[{ref,w:800,h:600,source:"upload"}],cur:0});
     const hero=image(refs.hero,"Robin"), room=image(refs.room,"IMG_123");
     const supplied=(source,kind)=>({node:source.id,ref:curV(source).ref,kind,name:source.name,id:"asset-"+kind});
     const character={name:"Robin",look:"winter coat",wizard_character_ref:"ignored-reference"};
     const scene={key:"room",kind:"scene",name:"Workshop",look:"large windows"};
     const prop={key:"prop",kind:"prop",name:"Cup",look:"blue ceramic"};
     const script=addNode("script",300,0,{characters:[character],visual_assets:[scene,prop],style:"Cinema",
       shots:[{id:"intro",duration:5,characters:["Robin"],scene:"Workshop",action:[],dialogue:[],
          keyframe:"Robin enters",visual_asset_keys:["room","prop"]}]});
     script.data.wizard_media={assets:[supplied(hero,"character"),supplied(room,"scene")]};
     W=B.wiz={step:2,script:script.id,media:[hero,room].map(source=>
       ({node:source.id,ref:curV(source).ref,name:source.name,kind:"image",use:"asset"}))};
     const cast=castNode(character);
     cast.versions.push({ref:refs.old,source:"gen"});cast.cur=0;
     B.edges.find(edge=>edge.from===cast.id&&edge.to===script.id).ref=refs.old;
     loadLibrary=async()=>[];
     flushSave=async()=>{};
     generate=async n=>{calls.push(["generation",n.name]);};
     api=async(path,body)=>{
       calls.push([path,body.ref]);
       if(path==="/api/library")return {id:"original-"+body.kind};
       throw new Error(path);
     };
     let finishUpload;
     uploadInto=async target=>{
       await new Promise(resolve=>{finishUpload=resolve;});
       target.versions.push({ref:refs.prop,w:800,h:600,source:"upload"});target.cur=target.versions.length-1;
     };
     pickFiles=choose=>choose([new File(["x"],"cup.png")]);
     $("#wiz").classList.add("on");renderWiz();
     const selector=$('[data-wz-supplied-image][data-key="room"]');
     const label=selector.closest("label").firstChild.textContent.trim();
     const card=key=>$('[data-wz-visual-card="'+key+'"]');
     const missing=card("room").querySelector('[role="status"]').textContent;
     selector.value=room.id;
     selector.dispatchEvent(new Event("change"));
     const scenePreview=card("room").querySelector("img").getAttribute("src");
     const sceneReady=card("room").textContent;
     const upload=$('[data-wz-visual-upload="prop"]').onclick();
     const uploading=card("prop").querySelector('[role="status"]').textContent;
     finishUpload();
     await upload;
     const propPreview=card("prop").querySelector("img").getAttribute("src");
     const propReady=card("prop").textContent;
     const ready=await prepareWizardAssets(script), again=await prepareWizardAssets(script);
     const assetTokens=storyboardAssetTokens(script,{asset_refs:[
       {id:"mship",name:"OpenAI 战舰",kind:"prop"},
       {id:"mroom",name:"Workshop",kind:"scene"},
       {id:"mworld",name:"海战背景",kind:"world",explicit:true}
     ]},[{name:"Workshop",ref:refs.room}]);
     const fullTokens=storyboardAssetTokens(script,{asset_refs:[
       {id:"mship",name:"OpenAI 战舰",kind:"prop"}
     ]},Array.from({length:8},(_,i)=>({name:"asset-"+i,ref:"input:h3studio/ref"+i+".png"})),1);
     expandScript(script);
     const video=node(scriptShotLinks(script)[0].vid);
     script.data.shots[0].action_check={evidence:"The cup leaves Robin's hand"};
     video.versions=[{ref:"output:h3studio/v1.mp4"},{ref:"output:h3studio/v2.mp4"}];video.cur=0;
     W.step=4;renderWiz();
     const actionReview=$("[data-wz-action-review]");
     const reviewLabel=actionReview.closest("label").firstChild.textContent.trim();
     actionReview.value="needs_work";
     actionReview.dispatchEvent(new Event("change"));
     video.cur=1;renderWiz();
     const review=[video.versions[0].storyboard_action_review,$("[data-wz-action-review]").value];
     return {ready,again,label,missing,scenePreview,sceneReady,uploading,propPreview,propReady,assetTokens,fullTokens,review,reviewLabel,calls,heroHistory:cast.versions.map(v=>v.ref),
       inputs:B.edges.filter(edge=>edge.to===scriptShotLinks(script)[0].img).map(edge=>[edge.image_use,edge.ref])};
   } finally {
     ({W,api,generate,loadLibrary,flushSave,uploadInto,pickFiles}=state);
     restore(before);B.wiz=state.wiz;closeWizard();
   }
 })()`);
 assert.ok(result.ready&&result.again);
 assert.equal(result.label,englishSmoke?"Use the uploaded original":"直接使用已上传原图");
 assert.equal(result.missing,englishSmoke?"Upload an image here, or generate one when preparing assets.":"可上传图片，或在准备素材时生成。");
 assert.equal(result.uploading,englishSmoke?"Uploading image…":"正在上传图片…");
 assert.match(result.scenePreview,/original-room\.png/);
 assert.match(result.propPreview,/original-prop\.png/);
 const selected=englishSmoke?"Using the uploaded original":"已选用上传的原图";
 assert.ok(result.sceneReady.includes(selected)&&result.propReady.includes(selected));
 assert.match(result.assetTokens,/mship/);
 assert.match(result.assetTokens,/mworld/);
 assert.doesNotMatch(result.assetTokens,/mroom/);
 assert.equal(result.fullTokens,"");
 assert.equal(result.reviewLabel,englishSmoke?"Action review":"动作核对结果");
 equal(result.review,[{evidence:"The cup leaves Robin's hand",status:"needs_work"},""]);
 assert.ok(result.calls.every(([path])=>path==="/api/library"));
 equal(result.heroHistory,["output:h3studio/old-hero.png","input:h3studio/original-hero.png"]);
 equal(result.inputs,[
   ["character","input:h3studio/original-hero.png"],
   ["scene","input:h3studio/original-room.png"],
   ["prop","input:h3studio/original-prop.png"]
 ]);
 console.log("Wizard supplied assets passed: matching originals, explicit scene selection, prop upload and zero regeneration.");
};
