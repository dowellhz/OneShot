"use strict";

module.exports = async function filmMultitrack({equal,evaluate,ready,w,englishSmoke}) {
  const before = evaluate("snap()");
  const latest = evaluate('localStorage.getItem(filmDraftPrefix()+"latest")');
  const fetch = w.fetch, getContext = w.HTMLCanvasElement.prototype.getContext;
  const waveformRequests = [];
  w.fetch = (url,options) => {
    if (!String(url).startsWith("/api/audio/waveform?")) return fetch(url,options);
    waveformRequests.push(new URL(String(url),"http://oneshot.test").searchParams.get("ref"));
    return Promise.resolve({ok:true,json:async()=>({seconds:4,peaks:[.1,.5,.8,.3]})});
  };
  w.HTMLCanvasElement.prototype.getContext = function () {
    const ctx = getContext.call(this);
    if (this.hasAttribute("data-track-waveform")) ctx.fillRect = (_,y)=>{ this.dataset.waveDrawn = String(y); };
    return ctx;
  };
  try {
    evaluate(`{
      const makeVideo = (name,ref) => {
        const n = addNode("video",200,200,{}, {name});
        n.versions = [{ref,seconds:4}]; n.cur = 0;
        return n;
      };
      const first = makeVideo("First","input:h3studio/first.mp4");
      const second = makeVideo("Second","input:h3studio/second.mp4");
      openFilm([first,second]);
      const spec = FILM.spec;
      spec.clips[0].captions = [{start:.5,end:1.5,text:"对白"}];
      spec.audio_clips = [{ref:"input:h3studio/voice.wav",name:"Voice",start:1,in:.5,out:2.5,seconds:4,volume:1,
        captions:[{start:1,end:2,text:"Voice caption"}]}];
      spec.bgm = {ref:"input:h3studio/music.wav",name:"Music",volume:.4};
      spec.titles = [{start:2,end:3,text:"Title"}];
      renderFilm(); $("#fmTrackSwitch").click();
    }`);
    equal(evaluate('[$("#fmTracks").hidden,$("#fmTrackSwitch").getAttribute("aria-pressed"),$$("#fmTrackContent .fm-track-picture").length]'),
      [false,"true",2]);
    equal(evaluate('$("#fmTrackSwitch").textContent'),englishSmoke?"Multitrack timeline":"多轨时间线");
    await ready('$$("#fmTracks [data-wave-drawn]").length===2',"waveforms appear for audio and music");
    equal([...new Set(waveformRequests)].sort(),["input:h3studio/music.wav","input:h3studio/voice.wav"]);
    equal(evaluate(`filmTrackRows(FILM.spec).find(row=>row.type==="caption").items.map(c=>[c.start,c.end,c.label])`),
      [[.5,1.5,"对白"],[1.5,2.5,"Voice caption"]]);
    evaluate(`window.multitrackDrag=(selector,start,end,edge,cancel=false) => {
      const ruler = $(".fm-track-ruler");
      ruler.getBoundingClientRect = () => ({left:0,width:800});
      const item = $(selector);
      const target = edge ? $("[data-track-edge="+edge+"]",item) : $("[data-track-body]",item);
      const event = (type,clientX) => Object.assign(new Event(type,{bubbles:true}),{button:0,pointerId:1,clientX});
      target.dispatchEvent(event("pointerdown",start));
      item.dispatchEvent(event("pointermove",end));
      item.dispatchEvent(event(cancel?"pointercancel":"pointerup",end));
    };`);
    const audio = '.fm-track-lanes[data-track-type=audio] [data-track-item]';
    evaluate(`multitrackDrag(${JSON.stringify(audio)},100,203)`);
    equal(evaluate("FILM.spec.audio_clips[0].start"),2.0416666666666665);
    const cue = evaluate(`filmTrackRows(FILM.spec).find(row=>row.type==="caption").items.at(-1)`);
    equal(cue.start,2.5416666666666665);
    evaluate('$(\'[data-track-action="undo"]\').click()');
    equal(evaluate("FILM.spec.audio_clips[0].start"),1);
    evaluate('$(\'[data-track-action="redo"]\').click()');
    equal(evaluate("FILM.spec.audio_clips[0].start"),2.0416666666666665);
    evaluate(`multitrackDrag(${JSON.stringify(audio)},400,350,"out",true)`);
    equal(evaluate("FILM.spec.audio_clips[0].out"),2.5,"cancel does not commit");
    evaluate(`multitrackDrag(${JSON.stringify(audio)},400,350,"out")`);
    equal(evaluate("FILM.spec.audio_clips[0].out"),2,"dragging an edge trims the source range");
    evaluate('$(\'[data-track-action="undo"]\').click()');
    equal(evaluate("FILM.spec.audio_clips[0].out"),2.5,"trimming is reversible");
    evaluate(`{
      $(${JSON.stringify(audio)}+" button").click();
      seekTimeline(FILM.spec.audio_clips[0].start + 1);
      $("#fmTrackViewport").dispatchEvent(new KeyboardEvent("keydown",{key:"c",bubbles:true,cancelable:true}));
    }`);
    equal(evaluate("FILM.spec.audio_clips.map(c=>[c.ref,c.in,c.out])"),
      [["input:h3studio/voice.wav",.5,1.5],["input:h3studio/voice.wav",1.5,2.5]]);
    evaluate(`$("#fmTrackViewport").dispatchEvent(new KeyboardEvent("keydown",{key:"Delete",bubbles:true,cancelable:true}));`);
    equal(evaluate("FILM.spec.audio_clips.map(c=>c.out)"),[1.5],"Delete removes the selected audio segment");
    evaluate(`for(let i=0;i<2;i++)$("#fmTrackViewport").dispatchEvent(new KeyboardEvent("keydown",{key:"z",metaKey:true,bubbles:true,cancelable:true}));`);
    equal(evaluate("FILM.spec.audio_clips.map(c=>[c.in,c.out])"),[[.5,2.5]],"keyboard undo restores the intact audio");
    evaluate('multitrackDrag("[data-picture-index]",100,700)');
    equal(evaluate("FILM.spec.clips.map(clip=>clip.ref)"),["input:h3studio/second.mp4","input:h3studio/first.mp4"]);
    equal(evaluate("FILM.spec.clips[FILM.sel].ref"),"input:h3studio/first.mp4","reordering follows the moved video");
    evaluate('$(\'[data-track-action="undo"]\').click(); $(\'[data-track-action="in"]\').click()');
    equal(evaluate('[$("#fmTrackContent").style.width,$("#fmTrackZoom").textContent,FILM.spec.clips[0].ref]'),
      ["200%","200%","input:h3studio/first.mp4"]);
    evaluate("closeFilm();resumeFilmDraft();");
    await ready('!!FILM?.spec.audio_clips.length',"multitrack draft restored");
    equal(evaluate("[FILM.spec.audio_clips[0].start,FILM.spec.clips[0].ref]"),
      [2.0416666666666665,"input:h3studio/first.mp4"]);
    let submitted;
    w.fetch = (url,options) => {
      if (String(url)!=="/api/render/check") return fetch(url,options);
      submitted = JSON.parse(options.body).spec;
      return Promise.resolve({ok:true,text:async()=>JSON.stringify({ok:false,issues:[{error:"test preflight"}]})});
    };
    equal(await evaluate('submitFilm(FILM,"version").catch(error=>error.message)'),"test preflight");
    equal(submitted.clips.map(clip=>clip.ref),["input:h3studio/first.mp4","input:h3studio/second.mp4"]);
    equal(submitted.audio_clips.map(clip=>[clip.ref,clip.start,clip.in,clip.captions[0].start]),
      [["input:h3studio/voice.wav",2.0416666666666665,.5,1]]);
  } finally {
    w.fetch = fetch;
    w.HTMLCanvasElement.prototype.getContext = getContext;
    evaluate("closeFilm(); delete window.multitrackDrag;");
    evaluate(`restore(${JSON.stringify(before)})`);
    if (latest===null) evaluate('localStorage.removeItem(filmDraftPrefix()+"latest")');
    else evaluate(`localStorage.setItem(filmDraftPrefix()+"latest",${JSON.stringify(latest)})`);
  }
  console.log("Multitrack timeline passed: waveforms, pointer and keyboard edits, undo, zoom, draft restore, and export inputs.");
};
