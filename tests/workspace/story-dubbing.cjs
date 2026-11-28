"use strict";

module.exports = async function storyDubbing({equal, evaluate, englishSmoke}) {
  const result = await evaluate(`(async () => {
    await voiceListRequest;
    const before = snap(), saved = {api, flushSave, voiceList, wizardShotFrames};
    const calls = [], spec = newSpec([]);
    try {
      flushSave = async () => {};
      const voices = [{id:"narrator",provider:"noiz"},{id:"second",provider:"noiz"}];
      voiceList = {voices};
      const originalFetch = window.fetch;
      window.fetch = async (...args) => args[0] === "/api/voices"
        ? {ok:true,json:async () => ({voices})}
        : originalFetch(...args);
      try {
        for (const [index, line] of ["Original", "Missing", "Too long", "Unavailable", "Matching"].entries()) {
          const video = addNode("video", index * 500, 100);
          video.versions = [{ref:"input:h3studio/story-dub-" + index + ".mp4",seconds:3}];
          video.cur = 0;
          spec.clips.push({...newFilmClip(video),story_shot:"shot-" + index,subs:[line],out:3,trans:index===0?"fade":"cut"});
        }
        spec.clips[1].story_dialogue = ["甲（轻声）：Missing","乙：Found"];
        api = async (path, body) => {
          calls.push({path, body});
          if (path === "/api/video/captions") {
            if (body.ref.endsWith("-3.mp4")) throw new Error("ASR unavailable");
            return {captions:body.ref.endsWith("-0.mp4") ? [{text:"Different original line"}] :
              body.ref.endsWith("-4.mp4") ? [{text:"Matching",start:.42,end:1.31}] : []};
          }
          if (path === "/api/tts") return {ref:"output:h3studio/story-dub.wav",seconds:body.text==="Too long"?4:1.25};
          throw new Error(path);
        };
        const film = showFilm(spec);
        const label = $("[data-story-dubbing] button").textContent;
        const second = $$("[data-story-voices] select")[1];
        second.value = "1";
        second.dispatchEvent(new Event("change"));
        $("[data-story-dubbing] button").click();
        while (film.storyDubbing?.running) await sleep(10);
        const status = $("[data-story-dubbing] [role=status]").textContent;
        const notes = [...$("[data-story-dubbing] ul").children].map(item => item.textContent);
        const beforeRetry = calls.filter(call => call.path==="/api/tts" && call.body.text==="Missing").length;
        await fillMissingStoryDubbing(film);
        const afterRetry = calls.filter(call => call.path==="/api/tts" && call.body.text==="Missing").length;
        const track = film.spec.narration[0], placement = [track.start,track.seconds,track.provider];
        const roles = film.spec.narration.map(({speaker,voice,start})=>[speaker,voice,start]);
        const captions = automaticStoryCaptions(film.spec,film.spec.clips[1]);
        const matchingClip = film.spec.clips[4], matched = automaticStoryCaptions(film.spec,matchingClip);
        matchingClip.in = .25;
        const expired = automaticStoryCaptions(film.spec,matchingClip);
        film.spec.clips.splice(0, 1);
        alignStoryDubbing(film.spec);
        const moved = track.start;
        film.spec.clips[0].out = .75;
        const tooLong = !!alignStoryDubbing(film.spec);
        const refs = [{versions:[{ref:"input:h3studio/middle.png"}],cur:0},{versions:[{ref:"input:h3studio/end.png"}],cur:0}];
        wizardShotFrames = () => [{node:refs[0],phase:"first",label:"first"},{node:refs[0],phase:"middle",label:"middle"},
          {node:refs[1],phase:"end",label:"end"}];
        const repeated = [...wizardRepeatedKeyframes({}, {keyframe:"Ball left", motion_frames:{middle:"Ball mid",end:"Ball mid."}})];
        return {label,status,notes,beforeRetry,afterRetry,placement,roles,captions,matched,expired,moved,tooLong,repeated,calls};
      } finally { window.fetch = originalFetch; }
    } finally {
      closeFilm();
      ({api, flushSave, voiceList, wizardShotFrames} = saved);
      restore(before);
    }
  })()`);
  equal(result.label, englishSmoke ? "Check and fill missing dialogue" : "检查并补对白");
  equal(result.status, englishSmoke ? "Dialogue check complete. Voiceovers added: 1." : "对白检查完成，已补配音 1 段。");
  equal(result.notes.length,5);
  equal(result.notes[0], englishSmoke ? "Clip 1 · The speech transcript differs from the script. Listen to the clip to check it." :
    "片段 1 · 原声转写与剧本有差异，请试听核对。");
  equal(result.notes[3], englishSmoke ? "Clip 4 · ASR unavailable" : "片段 4 · ASR unavailable");
  equal([result.beforeRetry,result.afterRetry], [1,1]);
  equal(result.placement, [3,1.25,"noiz"]);
  equal(result.roles,[["甲","narrator",3],["乙","second",4.25]]);
  equal(result.captions,[{start:.5,end:1.75,text:"Missing"},{start:1.75,end:3,text:"Found"}]);
  equal(result.matched,[{text:"Matching",start:.42,end:1.31}]);
  equal(result.expired === undefined,true);
  equal([result.moved,result.tooLong], [0,true]);
  equal(result.repeated, [["middle","first"],["end","middle"]]);
  equal(result.calls.filter(call => call.path === "/api/video/captions").every(call => call.body.allow_silence), true);
  equal(result.calls.filter(call => call.path === "/api/tts").map(call => call.body.text), ["Missing","Found","Too long"]);
  console.log("Storyboard checks passed: duplicate keyframes, original speech, missing and overlong voiceovers, retry and clip alignment.");
};
