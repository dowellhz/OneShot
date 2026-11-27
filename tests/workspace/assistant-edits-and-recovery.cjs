"use strict";

module.exports = async function assistantEditsAndRecovery(workspace, scenarioState) {
 const { assert, equal, evaluate, jobs, pause, ready, w } = workspace;
 let remote=JSON.parse(JSON.stringify(evaluate('B')));
 scenarioState.chatEvents = [];
 scenarioState.chatRuns = [];
 scenarioState.chatSeq = 0;
 let chatPosts=[];
 let responseLost=true;
 remote.rev=evaluate('B.rev')||workspace.revision;
 const originalFetch=w.fetch;
 w.fetch=async(url,options={})=>{
  const u=new URL(String(url),'http://oneshot.test'),body=typeof options.body==='string'?JSON.parse(options.body):null;
  let result;
  if(u.pathname==='/api/chat/sessions')result=options.method==='POST'?{id:'s1'}:{sessions:[{id:'s1',title:'Test chat'}]};
  else if(u.pathname==='/api/chat/sessions/s1/messages'){
   chatPosts.push(body);
   if(!scenarioState.chatRuns.length){
    const n=JSON.parse(JSON.stringify(remote.nodes[0]));n.id='agentResult';n.name='助手结果';n.x=1600;remote.nodes.push(n);remote.rev++;
    scenarioState.chatRuns=[{id:'run1',state:'done',model:{provider:'Configured',model:'tools-model'}}];
    for(const [kind,data]of [['user',{text:body.text,selected:body.selected}],['tool_start',{call_id:'call1',name:'image_generate'}],['tool_end',{call_id:'call1',name:'image_generate',result:{nodes:[{id:n.id,ref:n.versions[0].ref,name:n.name}]}}],['assistant',{text:'生成并保存完成'}]])scenarioState.chatEvents.push({id:++scenarioState.chatSeq,kind,data,run_id:'run1'});
   }
   if(responseLost){responseLost=false;throw new Error('connection lost after submission');}
   result={id:'run1',state:'done'};
  }else if(u.pathname==='/api/chat/sessions/s1')result={session:{id:'s1'},events:scenarioState.chatEvents.filter(e=>e.id>Number(u.searchParams.get('after')||0)),runs:scenarioState.chatRuns,board_rev:remote.rev};
  else if(u.pathname.startsWith('/api/board/')){if(options.method==='PUT'){remote=JSON.parse(options.body);remote.rev=Math.max(workspace.revision,remote.rev||0)+1;result={rev:remote.rev};}else result=remote;}
  else return originalFetch(url,options);
  return {ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(result))};
 };
 evaluate('sel=new Set(["n1"]);updateSel()');await evaluate('acOpen()');
 assert.equal(w.document.getElementById('agentChat').hidden,false);
 assert.match(w.document.getElementById('acRefs').textContent,/Image/);
 evaluate('document.getElementById("acInput").value="生成图片"');
 await evaluate('acSend()');assert.equal(chatPosts.length,1);assert.equal(w.document.getElementById('acInput').value,'生成图片');
 assert(w.localStorage.getItem('h3.chat.outbox.s1'));
 await evaluate('acLoadSession("s1")');
 assert.equal(evaluate('$("#acInput").value'),'生成图片');
 assert.equal(evaluate('$("#acResend").hidden'),false);
 evaluate('$("#acInput").value="尚未发送的新草稿";$("#acResend").click()');
 await ready('!AC.sending&&$("#acDelivery").hidden','a successful resend clears the composer status');
 assert.equal(chatPosts.length,2);
 assert.deepEqual(chatPosts[0],chatPosts[1],'ambiguous submission resends the exact original request');
 equal(evaluate('[$("#acInput").value,$("#acDeliveryStatus").textContent]'),['尚未发送的新草稿','']);
 equal(evaluate('$$(".ac-msg",$("#acMessages")).map(el=>el.textContent.trim())'),['生成图片','生成并保存完成'],
   'the delivered message stays in the transcript in event order');
 assert.equal(w.localStorage.getItem('h3.chat.outbox.s1'),null);
 evaluate('$("#acInput").value=""');
 console.log('Assistant composer shortcuts and receipts passed: skill search, exact resend, receipt and modified draft preservation.');
 equal(chatPosts[0].selected,['n1'],'selection bound at submit');
 await ready('!!node("agentResult")','server result reaches canvas');
 assert.equal(w.document.querySelectorAll('.ac-result').length,1);
 w.document.querySelector('.ac-result').click();equal(evaluate('[...sel]'),['agentResult'],'chat result locates node');
 assert.match(w.document.getElementById('acModel').textContent,/Configured/);
 evaluate('document.getElementById("acClose").click()');assert.equal(w.document.getElementById('agentChat').hidden,true);
 await evaluate('acOpen()');assert.match(w.document.getElementById('acMessages').textContent,/生成并保存完成/);
 evaluate('document.getElementById("acDock").click()');assert(w.document.getElementById('agentChat').classList.contains('floating'));
 const merged=evaluate('acMerge({rev:1,nodes:[{id:"x",name:"old",x:0}],edges:[]},{rev:1,nodes:[{id:"x",name:"new",x:0}],edges:[]},{rev:2,nodes:[{id:"x",name:"old",x:100},{id:"y",name:"result"}],edges:[]})');
 equal(merged.nodes,[{id:'x',name:'new',x:100},{id:'y',name:'result'}],'disjoint manual and agent edits merge');
 assert.throws(()=>evaluate('acMerge({nodes:[{id:"x",name:"old"}]},{nodes:[{id:"x",name:"mine"}]},{nodes:[{id:"x",name:"theirs"}]})'),/同一内容/);
 const linkBase={nodes:[{id:'source1'},{id:'source2'},{id:'target1'},{id:'target2'}],edges:[],seq:4,view:{x:0,y:0,k:1}};
 const localLinks={...linkBase,edges:[{from:'source2',to:'target1',role:'first'},{from:'source1',to:'target1',role:'last'}],seq:5,view:{x:100,y:0,k:1}};
 const peerLinks={...linkBase,edges:[{from:'source1',to:'target2'}],seq:7,view:{x:230,y:0,k:1}};
 const mergeLinks=(left,right)=>evaluate(`acMerge(${JSON.stringify(linkBase)},${JSON.stringify(left)},${JSON.stringify(right)})`);
 const mergedLinks=mergeLinks(localLinks,peerLinks);
 equal(mergedLinks.edges,[...peerLinks.edges,...localLinks.edges],'disjoint target edits merge and ordered input roles stay intact');
 equal([mergedLinks.seq,mergedLinks.view],[7,localLinks.view],'legacy sequence stays monotonic and independent panning does not cause conflicts');
 assert.throws(()=>mergeLinks(localLinks,{...peerLinks,edges:[{from:'source1',to:'target1',role:'first'}]}),/同一内容/);
 assert.throws(()=>mergeLinks(localLinks,{...linkBase,nodes:linkBase.nodes.slice(1)}),/连线的节点已被删除/);
 assert.throws(()=>mergeLinks(localLinks,{...linkBase,edges:[{from:'target1',to:'source1'}]}),/冲突的连线/);
 const markdown=w.document.createElement('div');w.document.body.append(markdown);
 w.__markdown=markdown;
 evaluate('acMarkdown(window.__markdown,"# 标题\\n\\n**重点**\\n\\n- 项目一\\n- 项目二\\n\\n| 名称 | 数量 |\\n| --- | --- |\\n| 图片 | 3 |\\n\\n> 引用\\n\\n```js\\nconst value = 1;\\n```\\n\\n[官网](https://example.com)")');
 assert(markdown.querySelector('h1'));assert.equal(markdown.querySelectorAll('li').length,2);assert(markdown.querySelector('table'));assert(markdown.querySelector('blockquote'));assert.equal(markdown.querySelector('pre code').textContent.trim(),'const value = 1;');assert(markdown.querySelector('.ac-code-copy'));assert.equal(markdown.querySelector('a').rel,'noopener noreferrer');
 evaluate('acMarkdown(window.__markdown,\'<script>alert(1)</script><img src="x" onerror="alert(1)"><svg onload="alert(1)"></svg><a href="javascript:alert(1)">unsafe</a><p class="ac-conflict" style="position:fixed">text</p>\')');
 assert.equal(markdown.querySelectorAll('script,svg,[onerror],[onload],[style],.ac-conflict').length,0);assert(!markdown.querySelector('a').hasAttribute('href'));
 evaluate(`const streamedChat=$("#acMessages");
  acRenderReplyPreview(streamedChat,[{run_id:"preview",text:"**开头** <img src=x>"}]);`);
 equal(evaluate('[$("#acMessages [data-ac-reply-preview]").textContent,$$("#acMessages [data-ac-reply-preview] img").length]'),
  ['**开头** <img src=x>',0],'an unfinished reply is safe visible text');
 evaluate(`acRenderReplyPreview(streamedChat,[{run_id:"preview",text:"**更长的回复**"}]);`);
 equal(evaluate('$$("#acMessages [data-ac-reply-preview]").map(el=>el.textContent)'),['**更长的回复**'],
  'successive updates reuse one bubble');
 evaluate('acRenderReplyPreview(streamedChat,[])');
 assert.equal(evaluate('$$("#acMessages [data-ac-reply-preview]").length'),0);
 const videoHTML=evaluate('acResultCards({nodes:[{id:"videoTest",type:"video",ref:"output:h3studio/test.mp4",name:"视频"}]})');
 assert.match(videoHTML,/<video controls/);assert(!videoHTML.includes('<img'));
 const exportCard=w.document.createElement('div');
 exportCard.innerHTML=evaluate('acResultCards({remake:{node_id:"videoTest",source_ref:"input:h3studio/原片.mp4"},export_ref:"output:h3studio/新成片.mp4"})');
 assert.equal(exportCard.querySelector('a').getAttribute('href'),'/media?ref='+encodeURIComponent('output:h3studio/新成片.mp4'));
 assert.equal(exportCard.querySelector('a').download,'新成片.mp4');
 evaluate(`acAppendEvent({kind:"tool_start",data:{call_id:"remake-export-call",name:"video_remake_export"}});
 acAppendEvent({kind:"progress",data:{call_id:"remake-export-call",jobs:[{state:"running",value:1,max:4}]}});
 `);
 equal(evaluate('$("[data-call=remake-export-call] summary").textContent.includes("25%")'),true,
  'export progress remains visible in a collapsed tool result');
 evaluate(`acAppendEvent({kind:"tool_end",data:{call_id:"remake-export-call",name:"video_remake_export",
  result:{remake:{node_id:"videoTest",source_ref:"input:h3studio/source.mp4"},export_ref:"output:h3studio/film.mp4"}}});`);
 equal(evaluate('$("[data-call=remake-export-call] a[download]").download'),'film.mp4','the completed export offers a download in the same turn');
 equal(evaluate('$("[data-call=remake-export-call]").open'),true,'the completed export shows its download without expanding the card');
 evaluate(`acAppendEvent({kind:"tool_start",data:{call_id:"remake-split",name:"video_remake_split_long"}});
 acAppendEvent({kind:"tool_end",data:{call_id:"remake-split",name:"video_remake_split_long",
  result:{remake:{node_id:"videoTest",source_ref:"input:h3studio/source.mp4",shot_number:1,shot_start:0},
   split_shots:[{number:1,start:0,end:6},{number:2,start:6,end:12}]}}});`);
 equal(evaluate('$("[data-call=remake-split]").open'),true,'split results show the new ranges without expanding the card');
 equal(evaluate('$$("[data-call=remake-split] [data-remake-start]").map(b=>[b.textContent,b.dataset.remakeStart,b.dataset.remakeRef])'),[
  ['镜头 1 · 0–6 秒','0','input:h3studio/source.mp4'],
  ['镜头 2 · 6–12 秒','6','input:h3studio/source.mp4'],
 ]);
 evaluate('$("[data-call=remake-split]").remove()');
 evaluate('node("agentResult").versions[node("agentResult").cur].layer_stack={base_ref:curV(node("n1")).ref,layers:[{id:"base",name:"底图",ref:curV(node("n1")).ref,x:0,y:0,w:512,h:384,opacity:1,visible:true},{id:"generated",name:"生成区域",ref:curV(node("agentResult")).ref,x:0,y:0,w:512,h:384,opacity:.5,visible:true}]}');
 await evaluate('aeOpenLayers("agentResult")');equal(evaluate('IMAGE_EDITOR.layers.map(l=>l.id)'),['base','generated'],'chat layers open with stable IDs');
 await evaluate('aeCompare("agentResult",curV(node("n1")).ref)');equal(evaluate('IMAGE_EDITOR.compareMode'),'wipe','chat before/after compare');
 // Manual selection pins the requested image version and sends a raster mask before resuming.
 evaluate('closeImageEditor();AC.inputs=[{call_id:"manualCall",run_id:"manualRun",node_id:"n1",source_ref:curV(node("n1")).ref,instruction:"画出要改的位置"}];aeRenderInputs()');
 assert.equal(w.document.getElementById('acInputRequest').hidden,false);
 const chatFetch=w.fetch;let selectionSent;
 w.fetch=async(url,options={})=>{if(String(url)==='/api/chat/runs/manualRun/selection'){selectionSent=JSON.parse(options.body);return{ok:true,json:async()=>({selection_id:'mask1'})};}return chatFetch(url,options);};
 await evaluate('aeOpenInput(AC.inputs[0])');equal(evaluate('IMAGE_EDITOR.agentSelection.call_id'),'manualCall','manual request opens editor');
 assert.equal(w.document.getElementById('ieGenerate').disabled,true);
 await evaluate('aeSendSelection()');assert.equal(selectionSent.call_id,'manualCall');assert(selectionSent.mask_data.startsWith('data:image/png;base64,'));equal(evaluate('!!IMAGE_EDITOR.agentSelection'),false,'selection completes editor handoff');
 // A queued agent video is visible with its edge; the browser must not append outputs itself.
 evaluate('closeImageEditor();AC.open=false;AC.board="different-board"');
 const pending={id:'pendingVideo',type:'video',name:'排队视频',x:2400,y:100,data:{prompt:'move',duration:5,aspect:'auto',quality:'std'},versions:[],cur:-1,agent_call:'pendingCall',job:{ids:['pagent0000001'],prompt:'move',t0:Date.now(),agent_call:'pendingCall'}};
 remote.nodes.push(pending);remote.edges.push({from:'n1',to:'pendingVideo',role:'first'});remote.rev++;
 jobs.set('pagent0000001',{state:'done',meta:{seed:5},outputs:[{ref:'output:h3studio/test.mp4',url:'/media?ref=output:h3studio/test.mp4',meta:{width:640,height:480,duration:5}}]});
 await evaluate(`acSyncBoard(${remote.rev},true)`);await pause(70);
 equal(evaluate('node("pendingVideo").versions.length'),0,'agent completion is owned by server');
 equal(evaluate('B.edges.filter(e=>e.to==="pendingVideo").length'),1,'pending video has visible source connection');
 remote.nodes.find(n=>n.id==='pendingVideo').versions=[{ref:'output:h3studio/test.mp4',url:'/media?ref=output:h3studio/test.mp4',w:640,h:480,seconds:5}];remote.nodes.find(n=>n.id==='pendingVideo').cur=0;remote.nodes.find(n=>n.id==='pendingVideo').job=null;remote.rev++;
 await evaluate('acSyncAgentJobs()');equal(evaluate('node("pendingVideo").versions.length'),1,'same pending node gets one completed video');equal(evaluate('node("pendingVideo").job'),null,'completed video clears progress');
 // Both media types use tabs; video tabs restore version-specific settings and graph inputs.
 evaluate('AC.board=boardId;sel=new Set(["n1"]);updateSel()');
 equal(evaluate('els.get("n1").querySelectorAll(".vtabs [role=tab]").length'),3,'image versions have tabs');
 evaluate('els.get("n1").querySelectorAll(".vtabs button")[0].click()');
 equal(evaluate('node("n1").cur'),0,'image tab switches original node');
 evaluate('nodeAction(node("n1"),"next")');equal(evaluate('node("n1").cur'),1,'toolbar shares version switching');
 evaluate('const video=node("pendingVideo");video.versions[0].input_edges=[{from:"n1",to:video.id,role:"first"},{from:"n2",to:video.id}];video.versions[0].node_data={...video.data,prompt:"old",duration:5};video.versions.push({...video.versions[0],ref:"output:h3studio/second.mp4",url:"/media?ref=output:h3studio/second.mp4",input_edges:[{from:"agentResult",to:video.id,role:"keyframe",time:2}],node_data:{...video.data,prompt:"new",duration:8}});video.cur=1;video.data={...video.versions[1].node_data};B.edges=B.edges.filter(e=>e.to!==video.id).concat(video.versions[1].input_edges);render(video)');
 scenarioState.beforeTabs = evaluate('B.nodes.length');
 evaluate('els.get("pendingVideo").querySelectorAll(".vtabs button")[0].click()');
 equal(evaluate('node("pendingVideo").cur'),0,'video old tab selected');
 equal(evaluate('node("pendingVideo").data.prompt'),'old','old prompt restored');
 equal(evaluate('B.edges.filter(e=>e.to==="pendingVideo").map(e=>e.from)'),['n1','n2'],'old inputs restored');
 evaluate('switchVersion(node("pendingVideo"),1)');
 equal(evaluate('node("pendingVideo").data.duration'),8,'new duration restored');
 equal(evaluate('B.edges.filter(e=>e.to==="pendingVideo")'),[{from:'agentResult',to:'pendingVideo',role:'keyframe',time:2}],'new input role and time restored');
 evaluate(`const versionPoint=target=>target.dispatchEvent(new MouseEvent("pointerover",{bubbles:true}));
  const versionKey=(key,options={})=>document.body.dispatchEvent(new KeyboardEvent("keydown",{key,bubbles:true,cancelable:true,...options}));
  const initialVersionPosition=[node("n1").x,node("pendingVideo").x];
  versionPoint($(".card",els.get("pendingVideo")));
  versionKey("ArrowLeft");`);
 equal(evaluate('[node("pendingVideo").cur,node("pendingVideo").data.prompt,[...sel],node("n1").x,node("pendingVideo").x]'),
  [0,'old',['n1'],...evaluate('initialVersionPosition')],'the key targets the hovered node without moving the selection');
 evaluate('versionKey("ArrowRight")');
 equal(evaluate('[node("pendingVideo").cur,node("pendingVideo").data.duration,B.edges.find(e=>e.to==="pendingVideo").from]'),
  [1,8,'agentResult'],'hover navigation restores the version inputs and settings');
 evaluate('versionKey("ArrowLeft",{repeat:true});');
 assert.equal(evaluate('node("pendingVideo").cur'),1);
 evaluate('versionPoint(world);versionKey("ArrowRight")');
 assert.equal(evaluate('node("n1").x'),evaluate('initialVersionPosition[0]+10'),'leaving the hover target restores arrow-key movement');
 evaluate('versionKey("ArrowLeft")');
 equal(evaluate('$$( ".vtabs img",els.get("n1")).map(img=>img.getAttribute("src"))'),
  JSON.parse(evaluate('JSON.stringify(node("n1").versions.map(v=>v.url))')),'the image thumbnails use each exact version');
 console.log('Hovered version navigation passed: thumbnails, pinned video inputs, stable selection and canvas nudge fallback.');
};
