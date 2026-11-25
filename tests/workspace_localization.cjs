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
  assert.equal(w.document.querySelector('#videoCompareTitle').textContent,'Compare video versions');
  assert.equal(w.document.querySelector('[data-compare-audio]').value,'left');
  assert.equal(w.document.querySelector('#imagePanorama canvas').getAttribute('aria-label'),'Panorama view');
  w.__samples=[{title:'保留原名',idea:'保留原文',seconds:6}];
  await evaluate('showGallery()');
  assert.match(evaluate('$("#wzSample .hd b").textContent'),/Example films/);
  assert.equal(evaluate('$("#wzSample [data-sample] b").textContent'),'保留原名');
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
  assert.match(evaluate('$("#wzBody .tip").textContent'),/reference image for each character/);
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

  evaluate(`node("n1").data.prompt="保存"; sel=new Set(["n1"]); updateSel();`);
  assert.equal(evaluate('$("#prompt").value'),'保存');
  assert.equal(evaluate('$("#send").getAttribute("aria-label")'),'Regenerate');
  assert.equal(evaluate('$("#ctl select[data-k=expand] option[value=false]").textContent'),'Prompt expansion off');
  await evaluate('acOpen()');
  assert.equal(evaluate('$("#agentChat .ac-head strong").textContent'),'Creative assistant');
  assert.equal(evaluate('$("#acSend").textContent'),'Send');
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
