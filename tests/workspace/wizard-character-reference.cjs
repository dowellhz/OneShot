"use strict";

module.exports=async function wizardCharacterReference({assert,equal,evaluate,englishSmoke}){
 const result=await evaluate(`(async()=>{
   const before=snap(), state={W,wiz:B.wiz,api,generate,loadLibrary,flushSave};
   const calls=[], imageRef="input:h3studio/group-portrait.png", oldRef="output:h3studio/old-cast.png",
     newRef="output:h3studio/referenced-cast.png";
   try {
     const source=addNode("image",0,0,{},{name:"Uploaded photo",versions:[{ref:imageRef,w:512,h:512}],cur:0});
     const shot={id:"intro",duration:5,characters:["Robin"],action:[],dialogue:[],scene:"Garden",
       keyframe:"Robin in a garden",frame:{source:"wizard-opening",ref:imageRef,w:512,h:512},motion_frames:{end:"Robin waves"}};
     const character={name:"Robin",look:"short hair"};
     const script=addNode("script",300,0,{characters:[character],shots:[shot],style:"Cinema"});
     const upload={node:source.id,ref:imageRef,kind:"image",use:"first",name:"Uploaded photo"};
     W=B.wiz={step:2,script:script.id,style:"Cinema",media:[upload]};
     const cast=castNode(character);
     cast.versions.push({ref:oldRef,source:"gen"});cast.cur=0;
     B.edges.find(edge=>edge.from===cast.id&&edge.to===script.id).ref=oldRef;
     expandScript(script);
     const pair=scriptShotLinks(script)[0], middle=node(pair.motion_frames.end);
     middle.versions.push({ref:"output:h3studio/old-last.png",source:"gen"});middle.cur=0;
     api=async(path,body)=>{
       calls.push([path,body]);
       if(path==="/api/describe")return {subjects:[
         {position:"left",appearance:"Blue coat and brown hat"},
         {position:"right",appearance:"Red parka and silver glasses"}
       ]};
       if(path==="/api/character-sheet/review")return {checked:true,passed:true};
       if(path==="/api/library")return {id:"saved-generated-character"};
       throw new Error(path);
     };
     loadLibrary=async()=>[];
     flushSave=async()=>{};
     generate=async n=>{
       const {request}=imageCanvasRequest(n,n.data.prompt);
       calls.push(["generation",request]);
       n.versions.push({ref:newRef,source:"gen",generation_record:captureGenerationRecord(request,[])});
       n.cur=n.versions.length-1;
     };
     $("#wiz").classList.add("on");renderWiz();
     const selector=$("[data-wz-cast-ref]"), label=selector.closest("label").firstChild.textContent.trim();
     const defaultSource=selector.value===source.id;
     for (let attempts=0; attempts<20 && !$("[data-wz-cast-subject]"); attempts++) await sleep(10);
     const unselected=!selectedWizardCharacterRef(script,character).appearance;
     const subject=$("[data-wz-cast-subject]");
     subject.value="1";
     subject.dispatchEvent(new Event("change"));
     const unrelated=addNode("image",0,0,{},{versions:[{ref:"input:h3studio/unrelated.png"}],cur:0});
     B.edges.push({from:unrelated.id,to:cast.id,ref:curV(unrelated).ref,image_use:"character"});
     const ready=await prepareWizardAssets(script);
     const savedAnalysis=upload.analysis;
     const optional={name:"Another character",wizard_character_ref:""};
     const optOut=selectedWizardCharacterRef(script,optional)===undefined;
     upload.analysis={ref:imageRef,subjects:[{appearance:"Blue coat and brown hat"}]};
     const single=selectedWizardCharacterRef(script,{name:"Robin"})?.appearance;
     script.data.characters.push({name:"Another character"});
     const needsAssignment=!selectedWizardCharacterRef(script,{name:"Robin"})?.appearance;
     upload.analysis={ref:imageRef,subjects:[]};
     const scenery=selectedWizardCharacterRef(script,{name:"Robin"})===undefined;
     upload.analysis=savedAnalysis;
     return {ready,label,unselected,defaultSource,optOut,single,needsAssignment,scenery,calls,
       history:cast.versions.map(v=>v.ref),opening:curV(node(pair.img)).ref,
       openingStale:node(pair.img).data.storyboard_stale_refs,
       frameRef:B.edges.find(edge=>edge.from===cast.id&&edge.to===middle.id).ref,
       stale:middle.data.storyboard_stale_refs};
   } finally {
     ({W,api,generate,loadLibrary,flushSave}=state);
     restore(before);B.wiz=state.wiz;closeWizard();
   }
 })()`);
 assert.equal(result.label,englishSmoke?"Character image reference":"人物生成参考");
 assert.ok(result.ready&&result.defaultSource&&result.unselected);
 assert.ok(result.optOut&&result.needsAssignment&&result.scenery);
 assert.equal(result.single,"Blue coat and brown hat");
 equal(result.calls.map(([path])=>path),["/api/describe","generation","/api/character-sheet/review","/api/library"]);
 equal(result.calls[0][1].mode,englishSmoke?"character_ref_en":"character_ref");
 const request=result.calls[1][1];
 assert.equal(request.character_sheet_reference,"input:h3studio/group-portrait.png");
 assert.equal(request.images.length,1);
 assert.match(request.prompt,/right.*Red parka and silver glasses/);
 assert.doesNotMatch(request.prompt,/Blue coat/);
 equal(result.history,["output:h3studio/old-cast.png","output:h3studio/referenced-cast.png"]);
 equal(result.opening,"input:h3studio/group-portrait.png");
 assert.equal(result.openingStale,undefined);
 equal(result.frameRef,"output:h3studio/referenced-cast.png");
 equal(result.stale,["output:h3studio/old-last.png"]);
 console.log("Wizard character reference passed: vision first, explicit subject, pinned request, preserved opening and updated shots.");
};
