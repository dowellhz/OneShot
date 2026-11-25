"use strict";

module.exports = async function assistantChoicesAndArchive(workspace, scenarioState) {
 const { assert, equal, evaluate, ready, w } = workspace;
 const appendChatEvent = (kind,text) => {
  const event={id:++scenarioState.chatSeq,kind,data:{text},run_id:'choice-run'};
  scenarioState.chatEvents.push(event);
  evaluate(`AC.cursor=${event.id};AC.events.push(${JSON.stringify(event)});acAppendEvent(AC.events.at(-1));acRenderState()`);
 };
 appendChatEvent('assistant','操作顺序：\n\n1. 上传图片\n2. 选择尺寸\n3. 导出图片');
 equal(evaluate('document.querySelectorAll("#acMessages .ac-choices").length'),0,'instructions stay as a list');
 appendChatEvent('assistant','你想选择哪个方案？\n\n1. **暖色风格**\n2. 冷色风格');
 equal(evaluate('document.querySelectorAll(".ac-choices button:not(:disabled)").length'),2,'assistant offers two active choices');
 appendChatEvent('assistant','准备工作：\n\n1. 载入素材\n2. 定好画幅\n\n请选择一个风格：\n\n1、**暖色风格**\n2、冷色风格');
 equal(evaluate('$$(".ac-choices button:not(:disabled)").map(b=>b.textContent)'),['1暖色风格','2冷色风格'],
  'only the list attached to the latest choice question becomes clickable');
 assert(evaluate('$$("#acMessages ol").some(list=>list.textContent.includes("定好画幅"))'),'the preceding procedure stays an ordered list');
 const priorChatFetch=w.fetch;
 let picked, attempts=0;
 w.fetch=async(url,options={})=>{
  if(String(url)==='/api/chat/sessions/s1/messages'){
   attempts++;picked=JSON.parse(options.body);
   const event={id:++scenarioState.chatSeq,kind:'user',data:{text:picked.text},run_id:'choice-result'};
   scenarioState.chatEvents.push(event);
   scenarioState.chatRuns=[{id:'choice-result',state:'thinking'}];
   return {ok:true,json:async()=>({id:'choice-result',state:'thinking'})};
  }
  return priorChatFetch(url,options);
 };
 evaluate('$("#acInput").value="正在写的草稿"; const choices=$$(".ac-choices button:not(:disabled)");choices[1].click();choices[0].click()');
 await ready('!AC.sending && AC.events.at(-1).data.text==="我选择 2：冷色风格"','selected option reaches the conversation');
 assert.equal(picked.text,'我选择 2：冷色风格');
 assert.equal(attempts,1,'clicks cannot submit twice');
 equal(evaluate('$("#acInput").value'),'正在写的草稿','option preserves draft');
 equal(evaluate('document.querySelectorAll(".ac-choices button:not(:disabled)").length'),0,'answered choices cannot be submitted again');
 scenarioState.chatRuns=[{id:'choice-result',state:'done'}];
 await evaluate('acLoadSession("s1")');
 equal(evaluate('document.querySelectorAll(".ac-choices button:not(:disabled)").length'),0,'old choices stay inactive after replay');
 const chatMemoryFetch=w.fetch;
 let archiveCalls=0, releaseChatMemory;
 w.fetch=async(url,options)=>{
  if(String(url)!=="/api/chat/sessions/s1/memory")return chatMemoryFetch(url,options);
  archiveCalls++;
  await new Promise(resolve=>{releaseChatMemory=resolve;});
  return {ok:true,json:async()=>({id:"saved-conversation",messages:3,truncated:false})};
 };
 evaluate('$("#acSaveMemory").click();$("#acSaveMemory").click()');
 assert.equal(archiveCalls,1,'conversation memory has one request in flight');
 assert.equal(evaluate('$("#acSaveMemory").disabled'),true);
 releaseChatMemory();
 await ready('!$("#acSaveMemory").disabled&&$("#toast").textContent.includes("已收录 3 条")','conversation is archived from the assistant panel');
 w.fetch=chatMemoryFetch;
};
