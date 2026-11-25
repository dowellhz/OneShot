"use strict";

document.getElementById("audioToolDialogs").insertAdjacentHTML("beforebegin", OneShotI18n.html`
<dialog id="audioSeparation" aria-labelledby="audioSeparationTitle">
  <header><strong id="audioSeparationTitle">人声分离</strong><button type="button" data-stem-close aria-label="关闭">×</button></header>
  <p data-stem-source></p>
  <div class="stem-source-player"></div>
  <form>
    <label>开始（秒） <input name="start" type="number" min="0" step="any" required></label>
    <label>结束（秒） <input name="end" type="number" min="0" step="any"></label>
    <button type="submit" data-stem-start>开始分离</button>
    <button type="button" data-stem-cancel hidden>取消任务</button>
  </form>
  <p role="status"></p>
  <div data-stem-results></div>
  <footer class="stem-result-actions" hidden>
    <button type="button" data-stem-add>两条音轨放入画布</button>
    <button type="button" data-stem-edit>在剪辑台使用</button>
  </footer>
</dialog>
`);

const STEM_LABELS={vocals:"人声",no_vocals:"伴奏与环境声"};
let stemDialogState=null;

function closeAudioSeparation() {
 const dialog=$("#audioSeparation");
 if(!dialog.open)return;
 clearTimeout(stemDialogState?.timer);
 stemDialogState=null;
 pausePreviewMedia(dialog);
 $(".stem-source-player",dialog).replaceChildren();
 $("[data-stem-results]",dialog).replaceChildren();
 dialog.close?.();
 dialog.removeAttribute("open");
}

function activeStemDialog(state) {
 return stemDialogState===state && B===state.board;
}

function boundStemSource(state) {
 const source=node(state.source);
 const version=source?.versions.find(v=>v.ref===state.ref);
 return version&&source.type===state.type?{source,version}:null;
}

async function openAudioSeparation(source,version=curV(source)) {
 const dialog=$("#audioSeparation");
 if(!canvasCanEdit()||!version?.ref||!source.versions.includes(version)||
    !["audio","video"].includes(source.type)||dialog.open)return;
 const form=$("form",dialog), status=$("[role=status]",dialog);
 const binding={board:boardId,node:source.id,ref:version.ref};
 const state={source:source.id,ref:version.ref,type:source.type,board:B,binding,job:null,range:null,outputs:[],available:false};
 stemDialogState=state;
 $("[data-stem-source]",dialog).textContent=source.name+" · 版本 "+(source.versions.indexOf(version)+1);
 const player=document.createElement(source.type);
 player.controls=true;
 player.preload="metadata";
 player.setAttribute("aria-label","原素材预览");
 player.src=version.url;
 if(source.type==="video")player.playsInline=true;
 $(".stem-source-player",dialog).replaceChildren(player);
 form.elements.start.value="0";
 form.elements.end.value="";
 form.elements.end.placeholder=version.seconds>0?Number(version.seconds).toFixed(2)+" 秒":"素材结尾";
 $("[data-stem-results]",dialog).replaceChildren();
 $(".stem-result-actions",dialog).hidden=true;
 $("[data-stem-start]",dialog).disabled=true;
 $("[data-stem-cancel]",dialog).hidden=true;
 status.textContent="正在读取分离任务…";
 form.onsubmit=event=>{event.preventDefault();void submitStems(state,form);};
 $("[data-stem-cancel]",dialog).onclick=()=>cancelStems(state);
 if(dialog.showModal)dialog.showModal();
 else dialog.setAttribute("open","");
 try{
  await flushSave();
  if(!activeStemDialog(state))return;
  const saved=await boardRequest("/api/audio/separate?"+new URLSearchParams(binding));
  if(!activeStemDialog(state))return;
  state.available=saved.available;
  if(saved.latest){
   loadStemJob(state,saved.latest);
   await pollStems(state);
  }else{
   status.textContent=state.available?"":"部署主机尚未配置人声分离模型";
   stemJobControls(state,false);
  }
 }catch(error){if(activeStemDialog(state))status.textContent=error.message;}
}

function loadStemJob(state, receipt) {
 const dialog=$("#audioSeparation"), form=$("form",dialog);
 state.job=receipt.id;
 state.range=receipt.range;
 form.elements.start.value=String(+state.range.start.toFixed(3));
 form.elements.end.value=String(+state.range.end.toFixed(3));
}

function stemJobControls(state,busy) {
 const dialog=$("#audioSeparation");
 $("[data-stem-start]",dialog).disabled=busy||!state.available;
 $("[data-stem-cancel]",dialog).hidden=!busy||!state.job||state.submitting;
 for(const field of $$("input",dialog))field.disabled=busy;
}

async function submitStems(state,form) {
 if(!activeStemDialog(state)||!boundStemSource(state)||$("[data-stem-start]").disabled)return;
 const start=form.elements.start.valueAsNumber;
 const end=form.elements.end.value?form.elements.end.valueAsNumber:null;
 const status=$("#audioSeparation [role=status]");
 if(!Number.isFinite(start)||start<0||end!==null&&(!Number.isFinite(end)||end-start<.1||end-start>600)){
  status.textContent="请选择至少 0.1 秒且不超过 10 分钟的区间";
  return;
 }
 state.submitting=true;
 stemJobControls(state,true);
 status.textContent=OneShotI18n.t("正在提交…");
 const key="h3.stems."+JSON.stringify(state.binding), fingerprint=JSON.stringify([start,end]);
 let attempt;
 try{
  const existing=JSON.parse(sessionStorage.getItem(key)||"null");
  if(existing?.fingerprint===fingerprint)attempt=existing.id;
 }catch{}
 attempt ||= crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,"0")).join("");
 try{sessionStorage.setItem(key,JSON.stringify({fingerprint,id:attempt}));}catch{}
 try{
  await flushSave();
  if(!activeStemDialog(state))return;
  const receipt=await boardRequest("/api/audio/separate","POST",{...state.binding,start,end,request_key:attempt});
  try{if(JSON.parse(sessionStorage.getItem(key)||"null")?.id===attempt)sessionStorage.removeItem(key);}catch{}
  if(!activeStemDialog(state))return;
  state.submitting=false;
  loadStemJob(state,receipt);
  const results=$("[data-stem-results]");
  pausePreviewMedia(results);
  results.replaceChildren();
  $(".stem-result-actions").hidden=true;
  state.outputs=[];
  await pollStems(state);
 }catch(error){
  if(activeStemDialog(state)){state.submitting=false;status.textContent=error.message;stemJobControls(state,false);}
 }
}

async function pollStems(state) {
 if(state.reading||!activeStemDialog(state))return;
 clearTimeout(state.timer);
 const job=state.job, status=$("#audioSeparation [role=status]");
 state.reading=true;
 try{
  const response=await boardRequest("/api/jobs?"+new URLSearchParams({ids:job}));
  if(!activeStemDialog(state)||job!==state.job)return;
  const result=response[job];
  if(!result)throw new Error("暂时无法读取任务");
  if(result.state==="done"){
   const outputs=Object.keys(STEM_LABELS).map(stem=>result.outputs?.find(o=>o.extra?.stem===stem));
   if(outputs.every(output=>output?.ref&&output.url&&output.meta?.duration>0)){
    state.outputs=outputs;
    renderStems(state);
    status.textContent="分离完成";
   }else status.textContent="分离结果不完整，可重新提交";
  }else if(result.state==="error")status.textContent=result.error||"分离未完成，可以重试";
  else{
   const phases={encoding:"正在提取原声音轨",sampling:"正在分离人声",compositing:"正在保存音轨"};
   status.textContent=phases[result.phase]||"正在排队";
   stemJobControls(state,true);
   state.timer=setTimeout(()=>pollStems(state),1000);
   return;
  }
  stemJobControls(state,false);
 }catch(error){
  if(activeStemDialog(state)&&job===state.job){
   status.textContent=error.message+"，正在重连…";
   stemJobControls(state,true);
   state.timer=setTimeout(()=>pollStems(state),2000);
  }
 }finally{state.reading=false;}
}

async function cancelStems(state) {
 if(!activeStemDialog(state)||!state.job)return;
 const control=$("[data-stem-cancel]");
 control.disabled=true;
 try{
  await boardRequest("/api/cancel","POST",{ids:[state.job]});
  if(activeStemDialog(state))await pollStems(state);
 }catch(error){if(activeStemDialog(state))$("#audioSeparation [role=status]").textContent=error.message;}
 finally{control.disabled=false;}
}

function renderStems(state) {
 const host=$("[data-stem-results]");
 host.replaceChildren();
 for(const output of state.outputs){
  const stem=output.extra.stem, label=STEM_LABELS[stem];
  const row=document.createElement("section");
  const title=document.createElement("strong"), player=document.createElement("audio");
  const download=document.createElement("a"), button=document.createElement("button");
  title.textContent=label;
  player.controls=true;
  player.preload="metadata";
  player.src=output.url;
  player.setAttribute("aria-label",label);
  download.href=output.url;
  download.download=label+".wav";
  download.textContent=OneShotI18n.t("下载");
  button.type="button";
  button.textContent=OneShotI18n.t("放入画布");
  button.onclick=()=>placeStems(state,[output]);
  row.append(title,player,download,button);
  host.append(row);
 }
 $(".stem-result-actions").hidden=false;
 $("[data-stem-add]").onclick=()=>placeStems(state,state.outputs);
 const edit=$("[data-stem-edit]");
 edit.hidden=state.type!=="video";
 edit.onclick=()=>{
  const source=boundStemSource(state);
  if(!source)return;
  const tracks=placeStems(state,state.outputs);
  if(!tracks.length)return;
  const spec=newSpec([]);
  spec.clips=[{...filmClipForVersion(source.source,source.version),in:state.range.start,out:state.range.end,volume:0,tight:true,
    media_seconds:Math.max(source.version.seconds||0,state.range.end)}];
  spec.audio_clips=tracks.map((track,index)=>{
   const version=track.versions.find(v=>v.ref===state.outputs[index].ref);
   return {node:track.id,ref:version.ref,name:track.name,seconds:version.seconds,start:0,in:0,out:version.seconds,volume:1};
  });
  closeAudioSeparation();
  showFilm(spec,null,filmDraftPrefix()+"stems:"+state.job,{id:source.source.id,ref:state.ref});
 };
}

function placeStems(state,outputs) {
 const bound=activeStemDialog(state)&&canvasCanEdit()&&boundStemSource(state);
 if(!bound){$("#audioSeparation [role=status]").textContent="原素材版本已移除，无法放入画布";return [];}
 const {source}=bound;
 const existing=B.nodes.filter(n=>n.type==="audio");
 const wanted=outputs.map(output=>({output,node:existing.find(n=>n.versions.some(
  version=>version.ref===output.ref&&version.audio_separation?.job===state.job))}));
 if(wanted.some(item=>!item.node)){
  checkpoint();
  for(const item of wanted){
   if(item.node)continue;
   const {output}=item, stem=output.extra.stem;
   const at=freeSpot(source.x+size(source).w+110,source.y,"audio");
   const provenance={job:state.job,stem,source_node:source.id,source_ref:state.ref,...state.range};
   const version={ref:output.ref,url:output.url,seconds:output.meta.duration,source:"audio_separation",audio_separation:provenance};
   const id="stem"+state.job+Object.keys(STEM_LABELS).indexOf(stem);
   item.node=addNode("audio",at.x,at.y,{}, {...(!node(id)?{id}:{}),name:source.name.slice(0,30)+" · "+STEM_LABELS[stem],versions:[version],cur:0});
   B.edges.push({from:source.id,to:item.node.id,relation:"audio_separation",source_ref:state.ref});
  }
  save();
 }
 const placed=wanted.map(item=>item.node);
 sel=new Set(placed.map(n=>n.id));updateSel();
 $("#audioSeparation [role=status]").textContent="音轨已放入画布";
 return placed;
}

const audioSeparationDialog=$("#audioSeparation");
$("[data-stem-close]",audioSeparationDialog).onclick=closeAudioSeparation;
audioSeparationDialog.oncancel=event=>{event.preventDefault();closeAudioSeparation();};
audioSeparationDialog.onkeydown=event=>event.stopPropagation();
