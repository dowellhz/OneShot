"use strict";

module.exports = async function filmDubbing({ equal, evaluate, ready, w, englishSmoke }) {
  const fetch = w.fetch, requests = [];
  w.fetch = async (url, options) => {
    if (String(url) === "/api/voices") return {ok:true,json:async()=>({available:true,voices:[
      {id:"same-id",provider:"guide",name:"Guide",service:"Noiz (Guide)"},
      {id:"same-id",provider:"narrator",name:"Narrator",service:"Noiz (noiz.ai)"},
    ]})};
    if (String(url) === "/api/tts") {
      requests.push(JSON.parse(options.body));
      return {ok:true,text:async()=>JSON.stringify({ref:"output:h3studio/dub.wav",seconds:1.2})};
    }
    return fetch(url, options);
  };
  try {
    evaluate(`{
      voiceList = null;
      const source = addNode("video", 290, 200);
      source.versions = [{ref:"input:h3studio/dub-test.mp4",url:"/media?ref=input:h3studio/dub-test.mp4",w:640,h:360,seconds:4}];
      source.cur = 0;
      render(source);
      closeFilm();
      selectOnly(source.id);
      ctxMenu({target:els.get(source.id),clientX:100,clientY:100});
    }`);
    equal(evaluate('$("#ctxMenu [data-a=dubbing-voice]").textContent'), englishSmoke ? "Choose a dubbing voice" : "选择配音音色");
    evaluate('$("#ctxMenu [data-a=dubbing-voice]").click()');
    await ready('$("#ctxMenu select")?.options.length===3', "both services can be selected from the canvas menu");
    equal(evaluate('$("#ctxMenu select").options[2].text'), "Narrator · Noiz (noiz.ai)");
    evaluate(`{
      const choice = $("#ctxMenu select");
      choice.value = "1";
      choice.dispatchEvent(new Event("change"));
      $("#fmV").onloadedmetadata?.();
    }`);
    await ready('!voiceListRequest && $("#fmNarr [data-n=voice]")?.options.length===2', "editor loads with both configured voices");
    equal(evaluate('[FILM.target.ref,FILM.spec.narration[0].provider,$("#fmNarr [data-n=voice]").value]'),
      ["input:h3studio/dub-test.mp4","narrator","1"]);
    evaluate(`{
      const start = $("#fmNarr [data-n=start]");
      start.value = ".5";
      start.dispatchEvent(new Event("change"));
      const speaker = $("#fmNarr [data-n=speaker]");
      speaker.value = "Anna <host>";
      speaker.dispatchEvent(new Event("change"));
      const text = $("#fmNarr textarea");
      text.value = "Ready to go?";
      text.dispatchEvent(new Event("input"));
    }`);
    equal(evaluate('$("#fmNarr [data-a=gen]").textContent'), englishSmoke ? "Generate voiceover" : "生成配音");
    evaluate('$("#fmNarr [data-a=gen]").click()');
    await ready('!!$("[data-voice-jump]")', "generated voice appears on the timeline");
    equal(requests, [{text:"Ready to go?",voice:"same-id",provider:"narrator",speed:1}]);
    equal(evaluate('[FILM.spec.narration[0].start,$("[data-voice-jump]").textContent,$("#fmNarr [role=status]").textContent]'),
      [.5,"Anna <host>",englishSmoke ? "Ready · 1.2s" : "已生成 · 1.2s"]);
    evaluate('closeFilm();resumeFilmDraft()');
    equal(evaluate('[FILM.spec.narration[0].provider,FILM.spec.narration[0].ref]'), ["narrator","output:h3studio/dub.wav"]);
  } finally {
    evaluate('closeFilm();voiceList=null');
    w.fetch = fetch;
  }
};
