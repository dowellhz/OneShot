"use strict";

const audioPeaks = new Map();
let audioWaveObserver = null;

function audioPreviewMarkup(version, fullscreen=false) {
  return `<div class="audio-preview ${fullscreen?"audio-full":""}">
    <div class="audio-wave" hidden>
      <div class="audio-peaks" aria-hidden="true"></div>
      <input type="range" min="0" max="1" step=".01" value="0" disabled aria-label="波形播放位置">
    </div>
    <div class="audio-preview-controls">
      <button type="button" data-audio-skip="-10" aria-label="后退 10 秒" title="后退 10 秒" disabled>−10</button>
      <audio src="${esc(version.url||"")}" controls preload="metadata"></audio>
      <button type="button" data-audio-skip="10" aria-label="前进 10 秒" title="前进 10 秒" disabled>＋10</button>
    </div>
  </div>`;
}

function audioPreviewPeaks(ref) {
  if(!audioPeaks.has(ref)){
    const pending=boardRequest("/api/audio/waveform?ref="+encodeURIComponent(ref)).then(result=>{
      if(!Array.isArray(result.peaks)||!result.peaks.length||result.peaks.length>256||
         result.peaks.some(p=>!Number.isFinite(p)||p<0||p>1))throw new Error("无可用波形");
      return result.peaks;
    });
    audioPeaks.set(ref,pending);
    pending.catch(()=>{if(audioPeaks.get(ref)===pending)audioPeaks.delete(ref);});
    if(audioPeaks.size>96)audioPeaks.delete(audioPeaks.keys().next().value);
  }
  return audioPeaks.get(ref);
}

function bindAudioPreview(container, version) {
  const root=$(".audio-preview",container);
  if(!root)return;
  const audio=$("audio",root), wave=$(".audio-wave",root), slider=$("input",wave), visual=$(".audio-peaks",wave);
  const skip=$$("[data-audio-skip]",root);
  function seek(at){if(Number.isFinite(audio.duration)&&audio.duration>0)audio.currentTime=Math.max(0,Math.min(at,audio.duration));}
  const format=time=>Math.floor(time/60)+":"+String(Math.floor(time%60)).padStart(2,"0");
  function sync(){
    const duration=audio.duration, canSeek=Number.isFinite(duration)&&duration>0;
    slider.disabled=!canSeek;
    for(const button of skip)button.disabled=!canSeek;
    if(!canSeek)return;
    const current=audio.currentTime;
    slider.max=duration;
    slider.value=current;
    slider.setAttribute("aria-valuetext",format(current)+" / "+format(duration));
    visual.style.setProperty("--played",(100*current/duration)+"%");
  }
  slider.oninput=()=>seek(slider.valueAsNumber);
  for(const button of skip)button.onclick=()=>seek(audio.currentTime+Number(button.dataset.audioSkip));
  for(const event of ["loadedmetadata","durationchange","timeupdate","seeked"])audio.addEventListener(event,sync);
  root.addEventListener("pointerdown",e=>{if(e.target.closest(".audio-wave,button"))e.stopPropagation();});
  root.addEventListener("dblclick",e=>{if(e.target.closest("audio, input, button"))e.stopPropagation();});
  sync();
  if(!version.ref)return;
  const load=async()=>{
    try{
      const peaks=await audioPreviewPeaks(version.ref);
      if(!root.isConnected)return;
      visual.replaceChildren(...peaks.map(peak=>{
        const bar=document.createElement("span");
        bar.style.height=Math.max(6,peak*100)+"%";
        return bar;
      }));
      wave.hidden=false;
    }catch{}
  };
  if(root.classList.contains("audio-full")||typeof IntersectionObserver!=="function")void load();
  else{
    audioWaveObserver??=new IntersectionObserver(entries=>{
      for(const {isIntersecting,target} of entries){
        if(!isIntersecting&&target.isConnected)continue;
        audioWaveObserver.unobserve(target);
        if(target.isConnected)void target._loadWave();
      }
    });
    root._loadWave=load;
    audioWaveObserver.observe(root);
  }
}

function renderAudioPanel(n) {
  const data=n.data, panel=$("#pp"), prompt=$("#prompt"), mode=data.mode==="music"?"music":"tts";
  const services=CAPS_LIST.audio_generation?.[mode] || [];
  const route=services.find(s=>s.id===data.provider) || (!data.provider?services[0]:null);
  const voice=route?.voices?.some(v=>v.id===data.voice)?data.voice:route?.voices?.[0]?.id;
  const options=(values,current)=>values.map(({id,name})=>
    `<option value="${esc(id)}" ${id===current?"selected":""}>${esc(name)}</option>`).join("");
  $("#refs").replaceChildren();
  $("#refs").style.display="none";
  $("#more").classList.remove("on");
  panel.classList.remove("wide");
  $("#pmode").innerHTML = [["tts","配音"],["music","音乐"]].map(([key,label])=>
    `<button type="button" data-audio-mode="${key}" aria-pressed="${key===mode}" class="${key===mode?"on":""}">${label}</button>`).join("");
  prompt.style.display="";
  prompt.placeholder=mode==="tts"?"输入要朗读的对白或旁白":"描述音乐的风格、情绪、节奏和乐器";
  prompt.value=data.prompt || "";
  prompt._node=n.id;
  prompt.maxLength=3000;
  autoGrow(prompt);
  const fields=$("#pfields");
  fields._node=null;
  fields.classList.toggle("on",mode==="music");
  fields.innerHTML=mode==="music"?'<textarea id="audioLyrics" maxlength="3000" rows="2" placeholder="歌词（留空生成纯音乐）" aria-label="歌词"></textarea>':"";
  const lyrics=$("#audioLyrics");
  if (lyrics) {
    lyrics.value=data.lyrics || "";
    lyrics.oninput=()=>{data.lyrics=lyrics.value;save();};
  }
  const serviceLabel=route?.name || (services.length?"选择服务":"需配置音频服务");
  const available=!!route;
  $("#ctl").innerHTML=`
    <span class="pill model">${esc(serviceLabel)}<select data-audio-field="provider" aria-label="音频服务">
      <option value="">默认服务</option>${options(services,data.provider)}</select></span>
    ${mode==="tts"&&available?`<span class="pill">${esc(route.voices.find(v=>v.id===voice)?.name || "音色")}<select aria-label="配音音色" data-audio-field="voice">${options(route.voices,voice)}</select></span>
    <label class="pill audio-rate">语速 <input type="number" value="${Number.isFinite(data.speed)?data.speed:1}" min=".5" max="2" step=".05" data-audio-field="speed" aria-label="配音语速"></label>`:""}
    <span class="grow"></span><button id="send" class="${n.job?"stop":""}" title="${n.job?"取消音频任务":"生成音频"}" aria-label="${n.job?"取消音频任务":"生成音频"}" ${!available&&!n.job?"disabled":""}>${ico(n.job?"stop":"send")}</button>`;
  $$("[data-audio-mode]",panel).forEach(button=>button.onclick=()=>{
    if (button.dataset.audioMode===mode) return;
    checkpoint();
    Object.assign(data,{mode:button.dataset.audioMode,provider:"",voice:""});
    save();showPanel();
  });
  $$("[data-audio-field]",panel).forEach(field=>field.onchange=()=>{
    const key=field.dataset.audioField;
    checkpoint();
    data[key]=key==="speed"?(field.checkValidity()&&field.value?field.valueAsNumber:1):field.value;
    if (key==="provider") data.voice="";
    save();showPanel();
  });
  $("#send").onclick=()=>n.job?cancel(n):generateAudio(n);
}

async function generateAudio(n,{groupRunId}={}) {
  if (!canvasCanEdit() || n.job || prepping.has(n.id)) return;
  const data=n.data, mode=data.mode==="music"?"music":"tts", prompt=data.prompt?.trim();
  if (!prompt) return toast(mode==="tts"?"请先填写旁白或对白":"请先描述音乐");
  const route=(CAPS_LIST.audio_generation?.[mode] || []).find((s,i)=>data.provider?s.id===data.provider:i===0);
  if (!route) return toast("请在控制台配置可用的音频生成服务");
  const recipe={mode,prompt,provider:route.id};
  if (mode==="tts") {
    recipe.speed=data.speed || 1;
    recipe.voice=route.voices.some(v=>v.id===data.voice)?data.voice:route.voices[0]?.id;
  } else recipe.lyrics=data.lyrics || "";
  const board=boardId, receiptKey=`h3.audio.attempt.${board}.${n.id}`, fingerprint=JSON.stringify(recipe);
  let attempt;
  try {
    const prior=JSON.parse(sessionStorage.getItem(receiptKey) || "null");
    if (prior?.fingerprint===fingerprint) attempt=prior.token;
  } catch {}
  attempt ||= crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), b=>b.toString(16).padStart(2,"0")).join("");
  try { sessionStorage.setItem(receiptKey,JSON.stringify({token:attempt,fingerprint})); } catch {}
  prepping.add(n.id);
  showErr(n,"");showPrep(n,true);
  try {
    await flushSave();
    if (board!==boardId || node(n.id)!==n) return;
    const result=await api("/api/audio/generate",{...recipe,board,node:n.id,label:n.name,request_key:attempt});
    if (board!==boardId || node(n.id)!==n) return;
    const used=result.recipe;
    n.job={ids:result.ids,prompt,t0:Date.now(),st:{},source:"audio_gen",history:{audio_recipe:used},
      ...(groupRunId?{group_run_id:groupRunId}:{}),
      generation_record:{mode,prompt,settings:{provider:used.provider,voice:used.voice,speed:used.speed,lyrics:used.lyrics},inputs:[]}};
    save();render(n);if(sel.has(n.id))showPanel();poll();
    await flushSave();
    try {sessionStorage.removeItem(receiptKey);} catch {}
  } catch (error) {
    if (board===boardId && node(n.id)===n) showErr(n,error.message);
  } finally {
    prepping.delete(n.id);
    if (board===boardId && node(n.id)===n) showPrep(n,false);
  }
}
