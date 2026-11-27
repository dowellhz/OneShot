"use strict";

module.exports=async function wizardMedia({assert,equal,evaluate,englishSmoke}){
 const result=await evaluate(`(async()=>{
   const before=snap(), state={W,wiz:B.wiz,api,readCanvasFile,openVideoRemake,captureOnCanvas,flushSave,showFilm,previs:CAPS_LIST.previs};
   const calls=[],refs={opening:"input:h3studio/intro.png", asset:"input:h3studio/mug.png",
     motion:"input:h3studio/motion.mp4", clip:"input:h3studio/broll.mp4"};
   try {
     W=B.wiz={step:0,idea:"A close-up of a mug",style:"写实电影",aspect:"16:9",dur:15,quality:"hd",takes:1};
     CAPS_LIST.previs=[{id:"test-remote",models:[{id:"reference-video",accepts_video:true,reference_limits:{videos:1,seconds:10}}]}];
     $("#wiz").classList.add("on"); renderWiz();
     readCanvasFile=async (file,kind)=>({
       name:file.name.split(".")[0],data:{},
       version:{ref:refs[file.name.split(".")[0]],w:1280,h:720,seconds:kind==="video"?9:undefined,source:"upload"}
     });
     const label=$("[data-wz-upload]").textContent;
     let resolveOpening;
     api=async(path,body)=>{
       if(path!=="/api/describe") throw new Error(path);
       if(body.images[0].ref===refs.opening) return new Promise(resolve=>{resolveOpening=resolve;});
       throw new Error("Vision service unavailable");
     };
     const uploading=uploadWizardMedia(["opening.png","asset.png","motion.mp4","clip.mp4"].map(name=>new File(["x"],name)));
     for (let attempts=0; attempts<20 && !resolveOpening; attempts++) await sleep(10);
     const analysisStatus=$('[data-wz-media="0"] [role="status"]').textContent;
     const previewDuringAnalysis=$('[data-wz-media="0"] img').getAttribute("src");
     const cardsBeforeAnalysis=$$("[data-wz-media]").length;
     const scriptBlocked=$('[data-go="script"]').disabled;
     resolveOpening({subjects:[],summary:"A mug on a windowsill"});
     await uploading;
     const summary=$('[data-wz-media="0"]').textContent;
     const failedAnalysis=$('[data-wz-media="1"] [role="status"]').textContent;
     const scriptReady=!$('[data-go="script"]').disabled;
     const defaults=W.media.map(item=>item.use);
     const defaultVideoRanges=W.media.filter(item=>item.kind==="video").map(item=>[item.start,item.end]);
     const choose=(index,use)=>{
       const field=$('[data-wz-media="'+index+'"] [data-wz-field=use]');
       field.value=use;field.dispatchEvent(new Event("change"));
     };
     choose(0,"first");
     choose(2,"motion");
     const [opening,asset,motion,clip]=W.media;
     asset.category="prop";
     motion.start=1;motion.end=4;
     clip.start=2;clip.end=6;
     flushSave=async()=>{};
     api=async(path,body)=>{
       calls.push([path,body]);
       if (path==="/api/library") return {id:"mug-asset"};
       if (path==="/api/storyboard") return {title:"Ad",style:"写实电影",characters:[],visual_assets:[],
         shots:[0,1].map(i=>({duration:5,scene:"Room",shot_size:"中景",action:["The mug turns"],dialogue:[],characters:[],keyframe:"Mug",motion_frames:{end:"Mug at rest"}}))};
       throw new Error(path);
     };
     await wizGo("script");
     const script=wizScript();
     expandScript(script);
     const pairs=scriptShotLinks(script), first=node(pairs[0].vid);
     const edge=videoInputs(first)[0].edge;
     const firstFrame=imageInputs(first).find(item=>item.edge.role==="first");
     const fixed=curV(node(pairs[0].img))?.ref;
     const notOnSecond=videoInputs(node(pairs[1].vid)).length===0;
     for (const pair of pairs) {
       const video=node(pair.vid);
       video.versions=[{ref:"output:h3studio/"+video.id+".mp4",seconds:6}];
       video.cur=0;
     }
     let appended;
     showFilm=spec=>{appended=spec.clips.at(-1);};
     openStoryFilm(script);
     const originalRef=node(clip.node).versions[0].ref;
     node(clip.node).versions.push({ref:"output:h3studio/new-version.mp4",seconds:10});
     node(clip.node).cur=1;
     openStoryFilm(script);
     captureOnCanvas=async (sourceId,version,{position,at})=>{
       calls.push(["capture",{sourceId,ref:version.ref,position,at}]);
       const ref="output:h3studio/captured.png";
       return addNode("image",0,0,{},{versions:[{ref,w:1280,h:720}],cur:0});
     };
     wizardSetMediaUse(clip,"frame");clip.at=3;
     const captured=await prepareWizardUploads();
     openVideoRemake=async (source,options)=>{calls.push(["remake",source.id,options]);};
     await launchWizardRemake(clip);
     return {label,defaults,defaultVideoRanges,analysisStatus,previewDuringAnalysis,cardsBeforeAnalysis,summary,failedAnalysis,scriptBlocked,scriptReady,
       first:fixed,pin:firstFrame.edge.ref,range:[edge.start,edge.end],
       remote:first.data.provider,action:first.data.fields.action, notOnSecond,
       library:calls.find(([path])=>path==="/api/library")[1],scriptRefs:calls.find(([path])=>path==="/api/storyboard")[1].refs,
       inserted:[appended.ref,appended.in,appended.out],originalRef,
       firstAfterCapture:opening.use,captured:captured.opening.ref,
       capture:calls.find(([path])=>path==="capture")[1],
       remake:calls.find(([path])=>path==="remake")[2],
       remaking:!$("#wiz").classList.contains("on")};
   } finally {
     ({W,api,readCanvasFile,openVideoRemake,captureOnCanvas,flushSave,showFilm}=state);
     CAPS_LIST.previs=state.previs; restore(before); B.wiz=state.wiz; closeWizard();
   }
 })()`);
 assert.equal(result.label,englishSmoke?"Upload images or videos":"上传图片或视频");
 assert.equal(result.analysisStatus,englishSmoke?"Analyzing image…":"正在分析图片…");
 assert.match(result.previewDuringAnalysis,/intro\.png/);
 assert.equal(result.cardsBeforeAnalysis,4);
 assert.ok(result.scriptBlocked&&result.scriptReady);
 assert.match(result.summary,/A mug on a windowsill/);
 assert.equal(result.failedAnalysis,englishSmoke?"Image analysis failed. You can retry.":"图片分析失败，可重试。");
 equal(result.defaults,["asset","asset","clip","clip"]);
 equal(result.defaultVideoRanges,[[0,9],[0,9]]);
 equal([result.first,result.pin],["input:h3studio/intro.png","input:h3studio/intro.png"]);
 equal(result.range,[1,4]);
 assert.equal(result.remote,"test-remote");
 assert.match(result.action,/@视频\{1\}/);
 assert.ok(result.notOnSecond);
 equal([result.library.kind,result.library.ref],["prop","input:h3studio/mug.png"]);
 equal(result.scriptRefs.map(ref=>ref.ref),["input:h3studio/intro.png","input:h3studio/mug.png"]);
 equal(result.inserted,[result.originalRef,2,6]);
 assert.equal(result.firstAfterCapture,"keep");
 assert.equal(result.captured,"output:h3studio/captured.png");
 equal([result.capture.ref,result.capture.position,result.capture.at],[result.originalRef,"time",3]);
 assert.equal(result.remake.sourceRef,result.originalRef);
 assert.ok(result.remaking);
 console.log("Wizard media passed: classified inputs, library saves, pinned first frame, motion, trimmed insertion, capture, and remake.");
};
