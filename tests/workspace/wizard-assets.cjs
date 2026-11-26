"use strict";

module.exports = async function wizardAssets({assert,equal,evaluate}) {
 const result=await evaluate(`(async()=>{
   const old={generate,api,loadLibrary,flushSave,renderWiz, W, wiz:B.wiz};
   const previous=snap(), calls=[], checked=[];
   try {
     const script=addNode("script",100,100,{title:"咖啡",style:"写实电影",aspect:"16:9",
       characters:[{name:"林夏",look:"蓝外套"}],visual_assets:[
         {key:"kitchen",kind:"scene",name:"厨房",look:"橡木桌"},
         {key:"mug",kind:"prop",name:"蓝杯",look:"白色杯柄"}
       ],shots:[
         {id:"first",duration:5,scene:"厨房",characters:["林夏"],action:[],dialogue:[],visual_asset_keys:["kitchen","mug"],
          keyframe:"拿杯",motion_frames:{middle:"举杯",end:"放下"}},
         {id:"second",duration:5,scene:"厨房",characters:[],action:[],dialogue:[],visual_asset_keys:["kitchen"],
          keyframe:"空厨房",continues_previous:true,motion_frames:{middle:"窗帘摆动",end:"窗帘落下"}}
       ]});
     W=B.wiz={script:script.id,step:2};
     renderWiz=()=>{};
     flushSave=async()=>{};
     loadLibrary=async()=>[{id:"stored-room",kind:"scene",name:"厨房",desc:"橡木桌\\n写实电影",
       ref:"input:h3studio/wiz-room.png",url:"/media?ref=input:h3studio/wiz-room.png",w:1920,h:1080}];
     generate=async n=>{
       calls.push(["generate",n.name]);
       const ref="output:h3studio/wiz-"+n.id+"-"+n.versions.length+".png";
       n.versions.push({ref,url:"/media?ref="+ref,w:1024,h:1024,source:"gen"});
       n.cur=n.versions.length-1;
     };
     api=async(path,body)=>{
       if(path==="/api/character-sheet/review"){
         checked.push(body.ref);
         const passed=checked.length>1;
         return {checked:true,count:passed?1:2,passed};
       }
       calls.push([path,body.kind]);
       return {id:"saved-"+body.kind};
     };
     const ready=await prepareWizardAssets(script);
     const again=await prepareWizardAssets(script);
     expandScript(script);
     const pair=scriptShotLinks(script);
     const refs=id=>B.edges.filter(edge=>edge.to===id);
     return {ready,again,calls,checked,cast:refs(pair[0].img).find(e=>e.image_use==="character").ref,
       first:refs(pair[0].img).map(e=>[e.image_use,Boolean(e.ref)]),
       timed:refs(pair[0].motion_frames.middle).map(e=>e.image_use),
       second:refs(pair[1].img).map(e=>[e.image_use,e.ref]),
       video:refs(pair[0].vid).map(e=>e.role),
       solo:wizardCharacterLook({data:{characters:[{name:"猫妈"},{name:"小猫"}]}},
         {name:"猫妈",look:"白色长毛，黑蝴蝶结抱着小猫，米白蕾丝上衣"})};
   } finally {
     ({generate,api,loadLibrary,flushSave,renderWiz,W}=old);
     restore(previous); B.wiz=old.wiz;
   }
 })()`);
 assert.equal(result.ready,true);
 assert.equal(result.again,true);
 equal(result.calls,[["generate","林夏"],["generate","蓝杯"],["generate","林夏"],["/api/library","character"],["/api/library","prop"]]);
 assert.equal(result.checked.length,2);
 assert.notEqual(result.checked[0],result.cast);
 assert.equal(result.checked[1],result.cast);
 equal(result.first,[["character",true],["scene",true],["prop",true]]);
 equal(result.timed,["camera","character","scene","prop"]);
 equal(result.second,[["scene","input:h3studio/wiz-room.png"]]);
 equal(result.video,["first","subject","keyframe","last"]);
 assert.equal(result.solo,"白色长毛，黑蝴蝶结，米白蕾丝上衣");
 console.log("Wizard assets passed: library reuse, generated assets, pinned shot references and repeat protection.");
};
