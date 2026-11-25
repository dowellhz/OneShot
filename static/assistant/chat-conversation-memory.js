"use strict";

const acMemorySaves=new Set();
async function acSaveConversationMemory(){
 const sid=AC.session, board=boardId;
 if(!sid||acMemorySaves.has(sid))return;
 acMemorySaves.add(sid);
 acRenderState();
 try{
  const result=await acApi(`/api/chat/sessions/${encodeURIComponent(sid)}/memory`,{});
  cmInvalidate();
  if(AC.session===sid&&boardId===board)
   toast(`已收录 ${result.messages} 条消息到个人资产库${result.truncated?"（较早消息已省略）":""}`);
 }catch(error){
  if(AC.session===sid&&boardId===board)toast(error.message,4500);
 }finally{
  acMemorySaves.delete(sid);
  if(AC.session===sid&&boardId===board)acRenderState();
 }
}

function acInitMemorySave(){
 $("#acNew").before(Object.assign(document.createElement("button"),{
  id:"acSaveMemory",type:"button",textContent:"收录到记忆",disabled:true,
  title:"把当前对话的文字消息保存到个人资产库，再次收录会更新正文",
  onclick:acSaveConversationMemory,
 }));
}
