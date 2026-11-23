"use strict";

const audioPeaks = new Map();
let audioWaveObserver = null;
const audioModes={tts:"配音",music:"音乐",sfx:"音效",seed_audio:"参考生成"};
const audioMode=data=>Object.hasOwn(audioModes,data.mode)?data.mode:"tts";
const audioSpeedRange=route=>route?.speed_range || [.5,2];
function audioSpeed(route,value) {
  const [min,max]=audioSpeedRange(route);
  return Number.isFinite(value) && value>=min && value<=max ? value : 1;
}
function audioDelivery(data) {
  const formats=CAPS_LIST.audio_output || {};
  const format=Object.hasOwn(formats,data.audio_format)?data.audio_format:"source";
  const rates=formats[format] || [];
  const rate=rates.includes(data.sample_rate)?data.sample_rate:rates.includes(44100)?44100:rates[0];
  return {formats,format,rates,rate};
}

const seedAudioRefs=n=>Array.isArray(n?.data?.references)?n.data.references.filter(ref=>ref &&
  typeof ref.node_id==="string"&&typeof ref.ref==="string"&&["audio","image"].includes(ref.kind)):[];
const isSeedAudio=n=>n?.type==="audio"&&n.data?.mode==="seed_audio";
const seedReferenceKey=(from,to,ref)=>JSON.stringify([from,to,ref]);

function syncSeedAudioEdges() {
  const sources=new Map(B.nodes.map(n=>[n.id,n]));
  const existing=new Map(B.edges.filter(e=>e.relation==="seed_audio_ref").map(e=>[seedReferenceKey(e.from,e.to,e.ref),e]));
  const kept=B.edges.filter(e=>e.relation!=="seed_audio_ref");
  for (const target of B.nodes.filter(isSeedAudio)) {
    const seen=new Set();
    seedAudioRefs(target).slice(0,3).forEach((ref,index)=>{
      const source=sources.get(ref.node_id);
      if (!source || source===target || source.type!==ref.kind || !ref.ref || seen.has(ref.ref) ||
          !Array.isArray(source.versions) || !source.versions.some(v=>v?.ref===ref.ref)) return;
      seen.add(ref.ref);
      const edge=existing.get(seedReferenceKey(source.id,target.id,ref.ref)) ||
        {from:source.id,to:target.id,relation:"seed_audio_ref",ref:ref.ref};
      edge.slot=index+1;
      kept.push(edge);
    });
  }
  if (kept.length!==B.edges.length || kept.some((edge,i)=>edge!==B.edges[i])) B.edges=kept;
  if (selEdge?.relation==="seed_audio_ref" && !B.edges.includes(selEdge)) selEdge=null;
}

function canSeedAudioReference(target,source,version) {
  if (!isSeedAudio(target) || !source || source===target || !version?.ref || !["audio","image"].includes(source.type)) return false;
  const refs=seedAudioRefs(target);
  return refs.length<(source.type==="image"?1:3) && refs.every(item=>item?.kind===source.type && item.ref!==version.ref);
}

function addSeedAudioReference(target,source,version,recordUndo=true) {
  if (!canvasCanEdit() || !canSeedAudioReference(target,source,version)) return false;
  if (recordUndo) checkpoint();
  target.data.references=[...seedAudioRefs(target),{node_id:source.id,ref:version.ref,kind:source.type}];
  refresh(target);
  save();
  return true;
}

function removeSeedAudioReference(n,index) {
  const refs=seedAudioRefs(n);
  if (!canvasCanEdit() || !refs[index]) return;
  checkpoint();
  n.data.references=refs.filter((_,i)=>i!==index);
  if (refs[index].kind==="audio") n.data.prompt=(n.data.prompt||"").replace(/@音频(\d+)/g,(tag,value)=>{
    const number=Number(value);
    return number===index+1?"":number>index+1?`@音频${number-1}`:tag;
  });
  refresh(n);
  save();
}

function renderSeedAudioRefs(n,prompt) {
  const host=$("#refs"),refs=seedAudioRefs(n);
  const choices=B.nodes.filter(source=>source!==n&&["audio","image"].includes(source.type)).flatMap(source=>
    source.versions.map((version,index)=>({source,version,index})).filter(({version})=>canSeedAudioReference(n,source,version)));
  host.innerHTML=refs.map((ref,index)=>{
    const source=node(ref.node_id),version=source?.versions.findIndex(v=>v.ref===ref.ref)??-1;
    const title=source?source.name+(version>=0?` · 版本 ${version+1}`:" · 版本已移除"):"来源已移除";
    return `<span class="ref" title="${esc(title)}">${ico(ref.kind==="image"?"image":"audio")}
      ${ref.kind==="audio"?`<button type="button" data-seed-token="${index+1}" title="插入参考编号">@音频${index+1}</button>`:"参考图"}
      <span>${esc(title)}</span><button type="button" data-seed-remove="${index}" aria-label="移除${esc(title)}">×</button></span>`;
  }).join("")+`<span class="pill">添加参考<select data-seed-pick aria-label="添加参考音频或图片" ${choices.length?"":"disabled"}>
    <option value="">选择画布版本</option>${choices.map(({source,index},i)=>
      `<option value="${i}">${esc(source.name)} · ${source.type==="audio"?"音频":"图片"} · 版本 ${index+1}</option>`).join("")}</select></span>`;
  host.style.display="";
  $("[data-seed-pick]",host).onchange=event=>{
    if (event.target.value==="" || !canvasCanEdit()) return;
    const choice=choices[Number(event.target.value)];
    if (!choice) return;
    addSeedAudioReference(n,choice.source,choice.version);
  };
  $$("[data-seed-remove]",host).forEach(button=>button.onclick=()=>removeSeedAudioReference(n,Number(button.dataset.seedRemove)));
  $$("[data-seed-token]",host).forEach(button=>button.onclick=()=>{
    const token="@音频"+button.dataset.seedToken;
    if (!canvasCanEdit() || prompt.value.length+token.length>prompt.maxLength) return;
    prompt.setRangeText(token,prompt.selectionStart,prompt.selectionEnd,"end");
    prompt.focus();
    prompt.dispatchEvent(new Event("input",{bubbles:true}));
  });
}

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
  const data=n.data, panel=$("#pp"), prompt=$("#prompt"), mode=audioMode(data);
  const adjust=$("#more");
  const keepAdjust=adjust._audioNode===n.id && adjust.classList.contains("on");
  const services=CAPS_LIST.audio_generation?.[mode] || [];
  const route=services.find(s=>s.id===data.provider) || (!data.provider?services[0]:null);
  const voice=route?.voices?.some(v=>v.id===data.voice)?data.voice:route?.voices?.[0]?.id;
  const options=(values,current)=>values.map(({id,name})=>
    `<option value="${esc(id)}" ${id===current?"selected":""}>${esc(name)}</option>`).join("");
  $("#refs").replaceChildren();
  $("#refs").style.display="none";
  adjust._audioNode=n.id;
  adjust.classList.toggle("on",!!CAPS_LIST.audio_effects && keepAdjust);
  adjust.innerHTML=CAPS_LIST.audio_effects?[`<label>音高（半音） <input type="number" min="-12" max="12" step="1" value="${Number.isInteger(data.pitch_semitones)?data.pitch_semitones:0}" data-audio-field="pitch_semitones" aria-label="音高（半音）"></label>`,
    `<label>音量（倍） <input type="number" min=".5" max="2" step="any" value="${Number.isFinite(data.gain)?data.gain:1}" data-audio-field="gain" aria-label="音量（倍）"></label>`].join(""):"";
  panel.classList.remove("wide");
  $("#pmode").innerHTML = Object.entries(audioModes).map(([key,label])=>
    `<button type="button" data-audio-mode="${key}" aria-pressed="${key===mode}" class="${key===mode?"on":""}">${label}</button>`).join("");
  prompt.style.display="";
  prompt.placeholder={tts:"输入要朗读的对白或旁白",music:"描述音乐的风格、情绪、节奏和乐器",seed_audio:"描述要生成的声音、对白和氛围",
    sfx:"描述声音来源、距离、节奏和环境，例如雨落在车窗上"}[mode];
  prompt.value=data.prompt || "";
  prompt._node=n.id;
  prompt.maxLength=3000;
  if (mode==="seed_audio") renderSeedAudioRefs(n,prompt);
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
  const [minSpeed,maxSpeed]=audioSpeedRange(route);
  const {formats,format,rates,rate}=audioDelivery(data);
  const formatNames={source:"原格式",wav:"WAV",mp3:"MP3",ogg:"OGG Opus"};
  $("#ctl").innerHTML=`
    <span class="pill model">${esc(serviceLabel)}<select data-audio-field="provider" aria-label="音频服务">
      <option value="">默认服务</option>${options(services,data.provider)}</select></span>
    ${mode==="tts"&&available?`<span class="pill">${esc(route.voices.find(v=>v.id===voice)?.name || "音色")}<select aria-label="配音音色" data-audio-field="voice">${options(route.voices,voice)}</select></span>
    <label class="pill audio-rate" ${minSpeed===maxSpeed?'title="此模型使用固定语速"':""}>语速 <input type="number" value="${audioSpeed(route,data.speed)}" min="${minSpeed}" max="${maxSpeed}" step="any" ${minSpeed===maxSpeed?"disabled":""} data-audio-field="speed" aria-label="配音语速"></label>
    ${route.subtitles? `<label class="pill"><input type="checkbox" data-audio-field="subtitles" ${data.subtitles===true?"checked":""}>生成同步字幕</label>` : ""}`:""}
    ${mode==="sfx"?`
      <label class="pill audio-rate">时长（秒） <input type="number" min=".5" max="30" step="any" placeholder="自动" value="${Number.isFinite(data.duration_seconds)?data.duration_seconds:""}" data-audio-field="duration_seconds" aria-label="音效时长（秒）"></label>
      <label class="pill audio-rate">提示词影响 <input type="number" min="0" max="1" step="any" value="${Number.isFinite(data.prompt_influence)?data.prompt_influence:.3}" data-audio-field="prompt_influence" aria-label="提示词影响"></label>
      <label class="pill"><input type="checkbox" ${data.loop===true?"checked":""} data-audio-field="loop">循环</label>`:""}
    ${mode==="seed_audio"&&available?`<label class="pill"><input type="checkbox" data-audio-field="subtitles" ${data.subtitles===true?"checked":""}>生成同步字幕</label>`:""}
    ${Object.keys(formats).length?`<span class="pill">输出 · ${esc(formatNames[format] || format)}<select data-audio-field="audio_format" aria-label="音频输出格式">
      ${options(["source",...Object.keys(formats)].map(id=>({id,name:formatNames[id] || id})),format)}</select></span>`:""}
    ${rates.length?`<span class="pill">${rate/1000} kHz<select data-audio-field="sample_rate" aria-label="音频采样率">
      ${options(rates.map(id=>({id,name:id/1000+" kHz"})),rate)}</select></span>`:""}
    ${CAPS_LIST.audio_effects?`<button type="button" class="pill" id="moreBtn" aria-controls="more">音高和音量</button>`:""}
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
    if (field.type==="number") {
      const fallback={speed:1,duration_seconds:null,prompt_influence:.3,pitch_semitones:0,gain:1};
      data[key]=field.checkValidity() && field.value!=="" ? field.valueAsNumber : fallback[key];
    } else data[key]=field.type==="checkbox"?field.checked:key==="sample_rate"?Number(field.value):field.value;
    if (key==="provider") data.voice="";
    save();showPanel();
  });
  const adjustButton=$("#moreBtn",panel);
  if (adjustButton) adjustButton.onclick=()=>adjust.classList.toggle("on");
  $("#send").onclick=()=>n.job?cancel(n):generateAudio(n);
}

async function generateAudio(n,{groupRunId}={}) {
  if (!canvasCanEdit() || n.job || prepping.has(n.id)) return;
  const data=n.data, mode=audioMode(data), prompt=data.prompt?.trim();
  if (!prompt) return toast("请先填写"+audioModes[mode]+"提示词");
  const route=(CAPS_LIST.audio_generation?.[mode] || []).find((s,i)=>data.provider?s.id===data.provider:i===0);
  if (!route) return toast("请在控制台配置可用的音频生成服务");
  const recipe={mode,prompt,provider:route.id};
  if (mode==="tts") {
    recipe.speed=audioSpeed(route,data.speed);
    recipe.voice=route.voices.some(v=>v.id===data.voice)?data.voice:route.voices[0]?.id;
    if (route.subtitles && data.subtitles) recipe.subtitles=true;
  } else if (mode==="music") recipe.lyrics=data.lyrics || "";
  else if (mode==="sfx") Object.assign(recipe,{duration_seconds:data.duration_seconds??null,prompt_influence:data.prompt_influence??.3,loop:data.loop===true});
  else Object.assign(recipe,{references:data.references||[],subtitles:data.subtitles===true});
  const {format,rate}=audioDelivery(data);
  if (format!=="source") Object.assign(recipe,{audio_format:format,sample_rate:rate});
  if (CAPS_LIST.audio_effects) {
    if (data.pitch_semitones) recipe.pitch_semitones=data.pitch_semitones;
    if (Number.isFinite(data.gain) && data.gain!==1) recipe.gain=data.gain;
  }
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
      generation_record:{mode,prompt,settings:Object.fromEntries(Object.entries(used).filter(([key])=>!["mode","prompt","references"].includes(key))),
        inputs:(used.references||[]).map(({node_id,ref})=>({node_id,ref,role:"reference"}))}};
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
