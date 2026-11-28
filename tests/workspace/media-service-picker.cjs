"use strict";

module.exports = async function mediaServicePicker({equal,evaluate,englishSmoke}) {
  const result = await evaluate(`(() => {
    const before=snap(), oldCaps=CAPS_LIST;
    const seedream="doubao-seedream-5-5-261028", seedance="doubao-seedance-2-5-260628";
    const local={id:"local_h3",name:"本地 H3",local:true,default:true};
    const service=(id,name,model)=>({id,name,model,models:[{id:model}]});
    try {
      CAPS_LIST={image:[local],video:[local],audio_voice_setup:[{id:"pending",name:"Pending voice service"}],
        audio_generation:{tts:[{id:"kokoro",name:"Kokoro",voices:[{id:"v1",name:"Local voice"}]},
          {id:"noiz",name:"Noiz",voices:[{id:"v2",name:"Noiz voice"}]}],
          music:[{id:"remote-music",name:"Music service",voices:[]}]}};
      const img=addNode("image",0,0,{prompt:"One apple"}), motion=addNode("video",0,0,{prompt:"An apple rolls"});
      function choice(field,value) {
        const select=$("#ctl select"+field);
        select.value=value;
        select.dispatchEvent(new Event("change"));
      }
      selectOnly(img.id);
      const onlyService=[...$("#ctl select[data-k=provider]").options].map(o=>o.value);
      CAPS_LIST.image.push(service("ark","Ark",seedream));
      CAPS_LIST.video.push(service("ark","Ark",seedance));
      showPanel();
      const aria=$("#ctl select[data-k=provider]").getAttribute("aria-label");
      choice("[data-k=provider]","ark");
      const image=[img.data.provider,imageCanvasRequest(img,"One apple").request.provider,
        canvasNodeModel(img,nodeProvider(img)).id];
      selectOnly(motion.id);
      choice("[data-k=provider]","ark");
      const video=[motion.data.provider,videoPreviewRequest(motion).provider,
        canvasNodeModel(motion,nodeProvider(motion)).id];
      CAPS_LIST.video.pop();
      showPanel();
      const retired=[nodeProvider(motion),videoPreviewRequest(motion).provider,
        $("#ctl select[data-k=provider]").value];
      const sound=addNode("audio",0,0,{prompt:"Hello"});
      selectOnly(sound.id);
      const pending=$("#ctl select[data-audio-field=provider] option[value=pending]");
      const pendingVoice=pending.disabled && pending.textContent.includes("Pending voice service");
      choice("[data-audio-field=provider]","noiz");
      const voice=[sound.data.provider,$("#ctl select[data-audio-field=voice]").value,!$("#send").disabled];
      $("#pmode button[data-audio-mode=music]").click();
      choice("[data-audio-field=provider]","remote-music");
      const music=[sound.data.provider,!$("#send").disabled,!!$("#ctl select[data-audio-field=voice]")];
      return {onlyService,aria,image,video,retired,pendingVoice,voice,music};
    } finally {CAPS_LIST=oldCaps;restore(before);}
  })()`);
  equal(result.onlyService,["","local_h3"]);
  equal(result.aria,englishSmoke?"Generation service":"生成服务");
  equal(result.image,["ark","ark","doubao-seedream-5-5-261028"]);
  equal(result.video,["ark","ark","doubao-seedance-2-5-260628"]);
  equal(result.retired,[null,"ark","ark"]);
  equal(result.pendingVoice,true);
  equal(result.voice,["noiz","v2",true]);
  equal(result.music,["remote-music",true,false]);
  console.log("Media service pickers passed: Seedream, Seedance, Noiz, music and unavailable providers.");
};
