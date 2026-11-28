"use strict";

module.exports = async function versionGenerationSettings({equal,evaluate,englishSmoke}) {
  const result = await evaluate(`(() => {
    const before = snap(), oldCaps = CAPS_LIST;
    const seedance = "doubao-seedance-2-5-260628";
    CAPS_LIST = {video:[
      {id:"ark-test",name:"Volcengine Ark",default:true,models:[{id:seedance,label:"Seedance 2.5"}]},
      {id:"local_h3",name:"本地 H3",local:true,models:[{id:"h3-video",label:"H3 BF16"}]},
    ]};
    try {
      const n = addNode("video",0,0,{provider:"ark-test",selected_model:seedance,quality:"480p",prompt:"Working draft"});
      n.versions = [
        {ref:"output:h3studio/h3.mp4",url:"/h3.mp4",w:864,h:480,seconds:5,prompt:"The flag moves",
         video_recipe:{provider:"local_h3",selected_model:"h3-video",quality:"std",prompt:"The flag moves",turbo:false,images:[]}},
        {ref:"output:h3studio/seedance.mp4",url:"/seedance.mp4",w:864,h:480,seconds:8,
         node_data:{provider:"ark-test",selected_model:seedance,quality:"720p",prompt:"The boat turns"},
         generation_record:{service:"Volcengine Ark",settings:{provider:"ark-test",provider_model:seedance,quality:"480p"}}},
      ];
      n.cur=1;
      n.data={...n.data,provider:"local_h3",selected_model:"h3-video"};
      restoreOpenedGenerationModel(n);
      const reopened = [n.data.provider,n.data.selected_model,n.data.quality];
      selectOnly(n.id);
      switchVersion(n,0);
      const h3 = [n.data.provider,n.data.selected_model,n.data.quality,n.data.turbo,$("#prompt").value,
        $(".badge",els.get(n.id)).textContent];
      lightbox(curV(n),n);
      $("[data-light-details]").click();
      const detail = $("[data-light-generation-model]").textContent;
      closeLightbox();
      switchVersion(n,1);
      const switched = [n.data.provider,n.data.selected_model,n.data.quality,$("#prompt").value,
        $(".badge",els.get(n.id)).textContent];
      n.data.provider="local_h3";
      n.data.model_selection_ref=curV(n).ref;
      restoreOpenedGenerationModel(n);
      const draftPreserved=n.data.provider;
      const unknown = versionGenerationModel({source:"upload",ref:"input:h3studio/unknown.mp4"},"video");
      return {reopened,h3,detail,switched,draftPreserved,unknown};
    } finally {
      closeLightbox(); CAPS_LIST=oldCaps; restore(before);
    }
  })()`);
  const local = englishSmoke ? "Local H3 · H3 BF16" : "本地 H3 · H3 BF16";
  const ark = "Volcengine Ark · Seedance 2.5";
  const seedance = "doubao-seedance-2-5-260628";
  equal(result.reopened,["ark-test",seedance,"480p"]);
  equal(result.h3,["local_h3","h3-video","std",false,"The flag moves",local]);
  equal(result.detail,local);
  equal(result.switched,["ark-test",seedance,"480p","The boat turns",ark]);
  equal(result.draftPreserved,"local_h3");
  equal(result.unknown,null);
  console.log("Generation model history passed: reload, H3 and Seedance tabs, original prompts, preview and draft.");
};
