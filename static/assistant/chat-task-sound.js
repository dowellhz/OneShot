"use strict";

const acTaskAudio = window.AudioContext || window.webkitAudioContext;
let acTaskSoundContext;
function acTaskPreferenceKey(name){
 return "h3.chat."+name+"."+ME_USER?.id;
}
function acTaskPreference(name){
 try{return localStorage.getItem(acTaskPreferenceKey(name));}catch{return null;}
}
function acSetTaskPreference(name,value){
 try{localStorage.setItem(acTaskPreferenceKey(name),value);}catch{}
}

function acUnlockTaskSound(){
 if(!acTaskAudio||acTaskPreference("taskSound")!=="on")return;
 try{
  acTaskSoundContext??=new acTaskAudio();
  if(acTaskSoundContext.state==="suspended")void acTaskSoundContext.resume().catch(()=>{});
 }catch{}
}

function acPlayTaskSound(attention){
 const audio=acTaskSoundContext;
 if(audio?.state!=="running")return;
 const notes=attention?[587,440]:[523,659];
 const when=audio.currentTime;
 notes.forEach((frequency,i)=>{
  const start=when+i*0.13;
  const tone=audio.createOscillator(), volume=audio.createGain();
  tone.frequency.value=frequency;
  volume.gain.setValueAtTime(0,start);
  volume.gain.linearRampToValueAtTime(0.055,start+0.014);
  volume.gain.linearRampToValueAtTime(0,start+0.15);
  tone.connect(volume);
  volume.connect(audio.destination);
  tone.onended=()=>{tone.disconnect();volume.disconnect();};
  tone.start(start);
  tone.stop(start+0.15);
 });
}

const acTaskNeedsInput=session=>["waiting_input","waiting_approval"].includes(session.run_state);
function acObserveTaskSounds(sessions,observedAt){
 if(!B||!canvasCanEdit()||!Number.isFinite(observedAt)||acTaskPreference("taskSound")!=="on")return;
 const prior=AC.taskSoundSnapshot;
 const user=ME_USER?.id;
 const sameScope=prior?.board===boardId&&prior.user===user;
 if(sameScope&&observedAt<=prior.observedAt)return;
 AC.taskSoundSnapshot={board:boardId,user,observedAt};
 if(!sameScope)return;
 const changed=time=>time>prior.observedAt&&time<=observedAt;
 const attention=sessions.some(row=>(acTaskNeedsInput(row)&&changed(row.active_task_updated))||
  (row.recent_task?.state==="error"&&changed(row.recent_task.updated)));
 const done=sessions.some(row=>row.recent_task?.state==="done"&&changed(row.recent_task.updated));
 if(attention||done){try{acPlayTaskSound(attention);}catch{}}
}
