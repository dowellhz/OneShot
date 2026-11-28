"use strict";

module.exports = async function screenplayWorkbench({equal,evaluate,englishSmoke}) {
  const result = await evaluate(`(async()=>{
    const before=snap(), saved={W,wiz:B.wiz,api};
    const calls=[];
    const draft={intent:"<should stay text>",fixed:["The label is handwritten."],beats:[
      {setup:"Gallery closes",action:"Jonah waits",result:"Door opens",evidence:"Door ajar",dialogue:["Jonah: Yes."]},
      {setup:"Door ajar",action:"A woman turns a painting",result:"The name appears",evidence:"Name on paper",dialogue:[]},
    ]};
    let writeRequest, offline=true, builds=0;
    try {
      W=B.wiz={step:0,idea:"Jonah waits.",style:"写实电影",dur:15,aspect:"16:9",quality:"std",takes:1};
      $("#wiz").classList.add("on");
      renderWiz();
      const label=$("[data-screenplay-start]").textContent;
      api=async (path,body)=>{
        if (path!=="/api/wizard/screenplay") return saved.api(path,body);
        calls.push(body.operation);
        if (body.operation==="outline")
          return {state:"done",result:{outline:{goal:"Find the painting",events:["Turn it"],ending:"Reveal the name",fixed:[],seconds:15}}};
        if (body.operation==="write") {
          if (body.outline?.seconds!==30 || body.target_seconds!==30) throw new Error("The approved duration is missing");
          if (offline) { writeRequest=JSON.stringify(body); throw new Error("Response disconnected"); }
          if (JSON.stringify(body)!==writeRequest) throw new Error("Write request changed after reloading");
          return {state:"done",result:{manuscript:draft}};
        }
        if (body.operation==="review") return {state:"done",result:{notes:[
          {scene:2,kind:"filmability",evidence:"The name appears",problem:"Where?",suggestion:"Show the back of the paper."},
        ]}};
        if (body.operation==="revise") {
          if (body.scene!==2 || body.notes!=="Show the back of the paper.") throw new Error("Incorrect revision request");
          return {state:"done",result:{scene:2,scene_data:{...draft.beats[1],action:"She turns it to show the back of the paper."}}};
        }
        if (body.manuscript.beats[0].dialogue[0]!=="Jonah: Yes." || body.manuscript.fixed[0]!==draft.fixed[0])
          throw new Error("Approved content changed outside the scene");
        if (++builds===1) return {state:"done",result:{screenplay_audit:{ok:false,events:[
          {scene:2,text:"Reveal the name",shots:[1],issues:["premature"]},
        ]}}};
        return {state:"done",result:{screenplay_audit:{ok:true,events:[]},title:"The Gallery",style:"Realism",shots:[
          {duration:5,action:["Jonah waits"],dialogue:["Jonah: Yes."],keyframe:"A closed door",scene:"Gallery"},
        ]}};
      };
      await wizardStartScreenplay();
      const outline=$("[data-screenplay-outline]");
      const outlineLabel=outline.querySelector("button[type=submit]").textContent;
      outline.elements.seconds.value="30";
      outline.dispatchEvent(new Event("submit",{cancelable:true}));
      while (activeScreenplays.has(wizardScreenplay())) await sleep(10);
      W=B.wiz=structuredClone(W);
      renderWiz();
      const canResume=!!$("[data-screenplay=resume]");
      offline=false;
      await wizardScreenplayRequest(wizardScreenplay(),wizardScreenplay().pending.operation);
      const reviewVisible=$(".wz-screenplay-notes q").textContent;
      const safeHtml=$(".wz-screenplay").textContent.includes("<should stay text>");
      const gated=maxStep()===1 && !wizScript().data.shots?.length && !$("#wzSteps [data-s='2']:not([disabled])");
      $("[data-screenplay-scene='2'] [data-screenplay=revise]").click();
      while (activeScreenplays.has(wizardScreenplay())) await sleep(10);
      const oldStillVisible=$("[data-screenplay-scene='2']").textContent.includes("A woman turns a painting");
      $("[data-screenplay=adopt]").click();
      const reviewInvalidated=$("[data-screenplay=compile]").disabled;
      $("[data-screenplay-scene='2'] [data-screenplay=edit]").click();
      const editor=$("[data-screenplay-edit]");
      editor.elements.action.value="Manual edit.";
      editor.dispatchEvent(new Event("submit",{cancelable:true}));
      const savedManual=wizardScreenplay().manuscript.beats[1].action==="Manual edit.";
      const locks=$("[data-screenplay-locks]");
      locks.elements.fixed.value="User-locked prop.";
      locks.dispatchEvent(new Event("submit",{cancelable:true}));
      const savedLocks=wizardScreenplay().manuscript.fixed[0]==="User-locked prop.";
      const select=$("[data-screenplay-compare]");
      select.value="2";
      select.dispatchEvent(new Event("change"));
      const compared=$(".wz-screenplay-diff").textContent.includes("Manual edit.");
      $("[data-screenplay=restore]").click();
      await wizardScreenplayRequest(wizardScreenplay(),"review");
      const approveLabel=$("[data-screenplay=compile]").textContent;
      await wizardScreenplayRequest(wizardScreenplay(),"compile");
      const blocked=!!wizardScreenplay() && !wizScript().data.shots?.length && $("[data-screenplay-audit][open]").textContent.includes("Reveal the name");
      await wizardScreenplayRequest(wizardScreenplay(),"compile");
      const approved=wizScript().data.approved_screenplay;
      const savedShots=wizScript().data.shots.length, approvedVisible=!!$(".wz-screenplay-approved");
      $("[data-screenplay-reopen]").click();
      const reopened=!!wizardScreenplay()?.versions.length;
      return {label,outlineLabel,canResume,reviewVisible,safeHtml,gated,oldStillVisible,reviewInvalidated,approveLabel,
        savedManual,savedLocks,compared,blocked,reopened,
        firstUntouched:JSON.stringify(approved.beats[0])===JSON.stringify(draft.beats[0]),
        fixedUntouched:JSON.stringify(approved.fixed)===JSON.stringify(draft.fixed),
        savedShots,changed:approved.beats[1].action,approvedVisible,calls:calls.join(",")};
    } finally {
      api=saved.api; $("#wiz").classList.remove("on");
      restore(before); W=saved.W; B.wiz=saved.wiz;
    }
  })()`);
  equal(result.label,englishSmoke?"Write screenplay first":"先写剧本");
  equal(result.outlineLabel,englishSmoke?"Approve outline and write →":"确认大纲并写剧本 →");
  equal(result.approveLabel,englishSmoke?"Approve and storyboard →":"确认定稿并拆分镜 →");
  equal(result.canResume,true);
  equal(result.reviewVisible,"The name appears");
  for (const key of ["safeHtml","gated","oldStillVisible","reviewInvalidated","firstUntouched","fixedUntouched","approvedVisible","savedManual","savedLocks","compared","blocked","reopened"])
    equal(result[key],true,key);
  equal(result.changed,"She turns it to show the back of the paper.");
  equal(result.savedShots,1);
  equal(result.calls,"outline,write,write,review,revise,review,compile,compile");
};
