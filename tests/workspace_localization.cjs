const assert = require('node:assert/strict');

async function verifyDraftProtection(w,evaluate,ready) {
  const picker=w.document.querySelector('[data-interface-language]');
  const attempt=()=>{
    picker.value='zh-CN';
    picker.dispatchEvent(new w.Event('change'));
  };
  const blocked=async ()=>{
    await ready('!$("[data-interface-language]").disabled','language switch completed');
    assert.equal(w.localStorage.getItem('oneshot.language'),'en');
    assert.match(w.document.querySelector('[data-language-status]').textContent,/unsent assistant drafts/);
  };

  evaluate('sel.clear(); acAttachNodeReference(node("n1"));');
  assert.equal(evaluate('$("#acInput").value'),'');
  attempt();
  await blocked();
  assert.equal(evaluate('AC.referencePins.get("n1").ref'),'input:h3studio/base.png');

  evaluate('acRememberDraft(); AC.drafts.set("other",AC.drafts.get(AC.session)); AC.refs=null; AC.referencePins.clear()');
  attempt();
  await blocked();
  assert.equal(evaluate('AC.drafts.get("other").pins[0][0]'),'n1');
  evaluate('AC.drafts.clear()');

  const fetch=w.fetch;
  let completeSave;
  const responseReady = new Promise(resolve=>{completeSave=resolve;});
  w.fetch=async(url,options)=>{
    if(String(url)==='/api/board/btest' && options?.method==='PUT')await responseReady;
    return fetch(url,options);
  };
  try {
    evaluate('save()');
    attempt();
    await ready('!!$("[data-interface-language]").disabled','awaiting canvas save');
    evaluate('acAttachNodeReference(node("n1"))');
    completeSave();
    await blocked();
    assert.equal(evaluate('AC.refs.includes("n1")'),true);
  } finally {
    completeSave();
    w.fetch=fetch;
    evaluate('AC.refs=null; AC.referencePins.clear()');
  }
}

module.exports = async function testEnglishWorkspace({w,evaluate,ready,requests}) {
  assert.equal(w.document.documentElement.lang,'en');
  assert.equal(evaluate('$("#shareBtn").textContent'),'Share');
  assert.equal(evaluate('$("#wizBtn span").textContent'),'Idea to Film');
  assert.equal(evaluate('$("#galBtn span").textContent'),'Examples');
  assert.equal(evaluate('$("#wmBtn").textContent'),'Wheel: Auto');
  evaluate('$("#wmBtn").click()');
  assert.equal(evaluate('$("#wmBtn").textContent'),'Wheel: Zoom');
  evaluate('$("#wmBtn").click()');
  assert.equal(evaluate('$("#wmBtn").textContent'),'Wheel: Pan');
  evaluate('$("#wmBtn").click()');
  assert.equal(w.document.querySelector('#videoCompareTitle').textContent,'Compare video versions');
  assert.equal(w.document.querySelector('[data-compare-audio]').value,'left');
  assert.equal(w.document.querySelector('#imagePanorama canvas').getAttribute('aria-label'),'Panorama view');
  w.__samples=[{title:'保留原名',idea:'保留原文',seconds:6},
    {id:'sample0',tpl:0,title:'贪吃橘猫现形记',style:'3D 动画',seconds:15}];
  await evaluate('showGallery()');
  assert.match(evaluate('$("#wzSample .hd b").textContent'),/Example films/);
  assert.equal(evaluate('$("#wzSample [data-sample] b").textContent'),'保留原名');
  assert.equal(w.document.querySelector('#wzSample [data-sample="1"] b').textContent,'The Ginger Cat Gets Caught');
  assert.match(w.document.querySelector('#wzSample [data-sample="1"] small').textContent,/3D animation/);
  evaluate('$("#wzSample [data-x]").click()');
  evaluate(`B.wiz={idea:"保留这个想法",step:4,style:STYLES[0],aspect:"16:9",dur:15,script:null};
    updateWizBtn(); W={...B.wiz,step:0}; renderWiz();`);
  assert.equal(evaluate('$("#wizBtn span").textContent'),'Resume · Video');
  assert.equal(evaluate(`$('#wzSteps [data-s="4"]').textContent`),'5Video');
  assert.equal(evaluate('B.wiz.idea'),'保留这个想法');
  assert.equal(evaluate('$("#wzBody h2").textContent'),'What kind of video do you want to make?');
  assert.match(evaluate('$("#wzIdea").placeholder'),/^Describe your idea/);
  assert.equal(evaluate('$("#wzIdea").value'),'保留这个想法');
  const style = w.document.querySelector('[data-set=style][data-val="写实电影"]');
  assert.equal(style.textContent,'Cinematic realism');
  style.click();
  assert.equal(evaluate('W.style'),'写实电影');
  evaluate('CAPS_LIST.video_quality_precheck=true; wizSig=""; renderWiz()');
  assert.equal(evaluate('$("#wzBody [data-set=quality_precheck].on").textContent'),'Check with INT8 first');
  evaluate('$("#wzBody [data-set=quality_precheck][data-val=false]").click()');
  assert.equal(evaluate('W.quality_precheck'),false);
  assert.equal(evaluate('$("#wzBody [data-set=takes]").textContent'),'1 take');
  evaluate(`const wizardLocaleScript=addNode("script",0,0,{
    title:"保留片名",style:"写实电影",aspect:"16:9",
    characters:[{name:"林森",look:"布衣",voice:"低沉男声"}],
    shots:[{duration:5,shot_size:"中景",camera:"固定机位",characters:["林森"],
      action:["走出门"],dialogue:[],keyframe:"门里",motion_frames:{middle:"跨门槛",end:"门外"}}]
  });
  W.script=wizardLocaleScript.id;
  expandScript(wizardLocaleScript);
  goStep(1);`);
  assert.equal(evaluate('$("#wzTitle").value'),'保留片名');
  assert.equal(evaluate('$("#wzTitle").placeholder'),'Film title');
  assert.equal(evaluate('$("#wzBody select[data-f=duration]").value'),'5');
  assert.match(evaluate('$("#wzBody select[data-f=duration] option:checked").textContent'),/^5 s/);
  evaluate('goStep(2)');
  assert.match(evaluate('$("#wzBody .tip").textContent'),/Prepare characters, sets, and props first/);
  assert.equal(evaluate('$("#wzBody [data-go=boards]").textContent').trim(),'Prepare assets and generate storyboard →');
  assert.equal(evaluate('$("#wzBody [data-c=name]").value'),'林森');
  evaluate('goStep(3)');
  assert.match(evaluate('$("#wzBody .tip").textContent'),/^Review each shot/);
  assert.equal(evaluate('$("#wzBody [data-middle-time]").getAttribute("aria-label")'),'Shot 1 middle frame time in seconds');
  evaluate('goStep(4)');
  assert.match(evaluate('$("#wzBody .tip").textContent'),/^Shots missing video: 1/);
  evaluate('goStep(5)');
  assert.match(evaluate('$("#wzBody .tip").textContent'),/Finish them before exporting/);

  evaluate(`B.name="新画布"; $("#bname").textContent=B.name;
    boardDirectory=[{id:boardId,name:B.name,project:"project-example"}];
    canvasProjects=[{id:"project-example",name:"弥赛亚的底稿"}];
    renderProjectCanvases();`);
  assert.equal(evaluate('$("#projectCanvases strong").textContent'),'弥赛亚的底稿');
  assert.equal(evaluate('$("#projectCanvases [aria-current=page]").textContent'),'新画布');
  assert.equal(evaluate('$("#projectCanvases [data-project-add]").getAttribute("aria-label")'),'New canvas in this project');
  evaluate(`boardDirectory.push({id:"auto-project",name:"新项目",nodes:0},{id:"custom-project",name:"新项目",nodes:0,auto_name:false});
    renderBoardMenu();`);
  assert.equal(w.document.querySelector('[data-id="auto-project"] .bp-name').textContent,'New project');
  assert.equal(w.document.querySelector('[data-id="custom-project"] .bp-name').textContent,'新项目');
  assert.equal(w.document.querySelector('[data-id="auto-project"] .k').textContent,'0 nodes');
  assert.match(w.document.querySelector('[data-qnew]').textContent,/Queue videos without a result/);
  assert.match(w.document.querySelector('#boards [data-new]').textContent,/New canvas in personal workspace/);
  assert.equal(w.document.querySelector('[data-batch-layout] option[value=tabs]').textContent,'Versions on the same node');

  evaluate(`node("n1").data.prompt="保存"; sel=new Set(["n1"]); updateSel();`);
  assert.equal(evaluate('$("#prompt").value'),'保存');
  assert.equal(evaluate('$("#send").getAttribute("aria-label")'),'Regenerate');
  assert.equal(evaluate('$("#ctl select[data-k=expand] option[value=false]").textContent'),'Prompt expansion off');
  assert.equal(w.document.querySelector('#ntools [data-a="full"]').getAttribute('aria-label'),'Open full screen');
  evaluate('ctxMenu({target:els.get("n1"),clientX:20,clientY:20})');
  assert.match(w.document.querySelector('#ctxMenu [data-a="image-upscale"]').textContent,/Upscale/);
  assert.match(w.document.querySelector('#ctxMenu [data-a="agent-new"]').textContent,/Start a new chat/);
  evaluate('closeMenus()');
  await evaluate('acOpen()');
  assert.equal(evaluate('$("#agentChat .ac-head strong").textContent'),'Creative assistant');
  assert.equal(evaluate('$("#acSend").textContent'),'Send');
  const fetchLocale = w.fetch;
  w.fetch = async (url, options) => {
    const fixtures = {
      "/api/status": {comfy:true,running:1,pending:0,remote:"DeepSeek (deepseek-flash)"},
      "/api/queue": {jobs:[{}],total:540},
      "/api/chat/profile?board=btest": {personal:{text:"保留原文",revision:1}},
    };
    if (String(url).startsWith("/api/generation-history?")) return {ok:true,json:async()=>({items:[]})};
    return Object.hasOwn(fixtures,url) ? {ok:true,json:async()=>fixtures[url]} : fetchLocale(url,options);
  };
  try {
    await evaluate("status()");
    assert.equal(w.document.querySelector("#stt").textContent,"Generating · 1 task · about 9 min · Text: DeepSeek (deepseek-flash) ▾");
    const openingProfile = evaluate("cpOpen()");
    assert.equal(w.document.querySelector("#cpStatus").textContent,"Loading memory…");
    await openingProfile;
    assert.equal(w.document.querySelector("#cpPersonal").value,"保留原文");
    w.document.querySelector("#creativeProfile form").dispatchEvent(new w.Event("submit",{cancelable:true}));
    assert.equal(w.document.querySelector("#cpStatus").textContent,"No changes to save");
    evaluate("cpClose()");
    evaluate("ghOpen()");
    assert.equal(w.document.querySelector("[data-gh-status]").textContent,"Loading generation history…");
    await ready('gh("[data-gh-status]").textContent === "No matching generation records"',"history has loaded");
    const result = evaluate('ghCard({id:"localized",label:"保留原名",type:"video",available:false})');
    assert.equal(result.querySelector("strong").textContent,"保留原名");
    assert.equal(result.querySelector(".gh-preview").textContent,"Original file unavailable");
    evaluate("ghClose()");

    const clipboard = Object.getOwnPropertyDescriptor(w.navigator,"clipboard");
    Object.defineProperty(w.navigator,"clipboard",{configurable:true,value:{writeText:async()=>{}}});
    try {
      const sharedURL = w.document.createElement("input");
      sharedURL.value = "https://oneshot.test/?board=btest";
      w.qaSharedURL = sharedURL;
      await evaluate("copyShareURL(qaSharedURL)");
      assert.equal(w.document.querySelector("#shareStatus").textContent,"Link copied");
    } finally {
      delete w.qaSharedURL;
      if (clipboard) Object.defineProperty(w.navigator,"clipboard",clipboard);
      else delete w.navigator.clipboard;
    }
  } finally {
    w.fetch = fetchLocale;
  }
  await verifyDraftProtection(w,evaluate,ready);
  await evaluate('alOpen()');
  assert.equal(evaluate('$("#alNew").textContent'),'New asset');
  assert.equal(evaluate('$("#alCategories [data-kind=world] span").textContent'),'Worldbuilding');
  const requestsBeforeCreate = requests.length, savedFetch=w.fetch;
  let createdName;
  w.fetch=(url,options)=> {
    if(String(url).endsWith('?project=project-example')&&options?.method==='PUT')createdName=JSON.parse(options.body).name;
    return savedFetch(url,options);
  };
  await evaluate('createCanvas("project-example")');
  assert.equal(createdName,'New canvas');
  assert.ok(requests.length>requestsBeforeCreate);
  console.log('English workspace passed: all six wizard steps, examples, canvas names, generation controls, assistant drafts, and asset library.');
};
