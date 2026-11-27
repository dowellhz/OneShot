"use strict";

module.exports = async function filmMusic({equal, evaluate, ready, w, englishSmoke}) {
  const originalFetch = w.fetch, sent = [];
  w.fetch = async (url, options) => {
    if (String(url) === "/api/audio/generate") {
      sent.push(JSON.parse(options.body));
      return {ok:true,text:async()=>JSON.stringify({ids:["test-music"]})};
    }
    if (String(url) === "/api/jobs?ids=test-music") {
      const data = {"test-music":{state:"done",outputs:[{ref:"output:h3studio/score.mp3"}]}};
      return {ok:true,json:async()=>data,text:async()=>JSON.stringify(data)};
    }
    return originalFetch(url, options);
  };
  try {
    evaluate(`{
      globalThis.savedAudioCaps = CAPS_LIST.audio_generation;
      CAPS_LIST.audio_generation = {...CAPS_LIST.audio_generation,
        music:[{id:"fixture-music",name:"ElevenLabs",model:"music_v1",music_duration:true}]};
      const source = addNode("video", 300, 200);
      source.versions = [{ref:"input:h3studio/music-test.mp4",url:"/media?ref=input:h3studio/music-test.mp4",w:640,h:360,seconds:5}];
      source.cur = 0;
      render(source);
      editVideoTimeline(source);
      $("#fmMusicMaker details").open = true;
      const prompt = $("#fmMusicMaker textarea");
      prompt.value = "Gentle piano";
      prompt.dispatchEvent(new Event("input",{bubbles:true}));
      $("#fmMusicMaker form").dispatchEvent(new Event("submit",{cancelable:true}));
    }`);
    await ready('!!$("[data-music-apply]")', "instrumental candidate is ready to use");
    equal(sent.map(({mode,prompt,provider,duration_seconds}) => [mode,prompt,provider,duration_seconds]),
      [["music","Gentle piano","fixture-music",5]]);
    equal(evaluate('$("[data-music-apply]").textContent'), englishSmoke ? "Use as background music" : "用作背景音乐");
    evaluate('$("[data-music-apply]").click()');
    equal(evaluate('[FILM.spec.bgm.ref,FILM.spec.bgm.volume,FILM.spec.bgm.duck]'), ["output:h3studio/score.mp3",.35,true]);
  } finally {
    evaluate('closeFilm();CAPS_LIST.audio_generation=savedAudioCaps;delete globalThis.savedAudioCaps');
    w.fetch = originalFetch;
  }
};
