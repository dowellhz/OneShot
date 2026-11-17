// DOM integration checks without starting an HTTP service or a browser.
const {JSDOM}=require('jsdom');
const vm=require('node:vm');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const board={name:'Test',owner:1,seq:4,nodes:[{id:'n1',type:'image',name:'Image',x:120,y:120,data:{prompt:'',model:'h3img',aspect:'auto',count:1,quality:'4mp',seed:-1},versions:[{ref:'input:h3studio/base.png',url:'/media?ref=input%3Ah3studio%2Fbase.png',w:512,h:384,source:'upload',prompt:''}],cur:0},{id:'n2',type:'text',name:'Text',x:700,y:200,data:{text:'Hello'},versions:[],cur:-1},{id:'n3',type:'text',name:'Text2',x:1150,y:300,data:{text:'World'},versions:[],cur:-1}],edges:[],groups:[],view:{x:0,y:0,k:1}};
const drafts=new Map(),requests=[],jobs=new Map(),recipes=[];let serial=0,revision=0;
const html=fs.readFileSync(path.join(root,'static/index.html'),'utf8');
const dom=new JSDOM(html,{url:'http://oneshot.test/?board=btest',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const ctx=()=>({save(){},restore(){},translate(){},scale(){},clearRect(){},fillRect(){},strokeRect(){},roundRect(){},setLineDash(){},drawImage(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},fill(){},arc(){},rect(){},clip(){},putImageData(){},getImageData(x,y,width,height){return{data:new Uint8ClampedArray(width*height*4).fill(255)};}});
w.HTMLCanvasElement.prototype.getContext=function(){return this._context ||= ctx();};
w.HTMLCanvasElement.prototype.toBlob=function(cb){cb(new w.Blob(['png'],{type:'image/png'}));};
w.HTMLElement.prototype.setPointerCapture=function(){};
Object.defineProperties(w.HTMLElement.prototype,{clientWidth:{get(){return this.classList.contains('ie-stage')?640:this.tagName==='CANVAS'?this.width:parseFloat(this.style.width)||900;}},clientHeight:{get(){return this.classList.contains('ie-stage')?480:this.tagName==='CANVAS'?this.height:parseFloat(this.style.height)||56;}},offsetWidth:{get(){return this.clientWidth;}},offsetHeight:{get(){return this.clientHeight;}}});
w.HTMLElement.prototype.getBoundingClientRect=function(){const left=parseFloat(this.style.left)||0,top=parseFloat(this.style.top)||0,width=this.clientWidth,height=this.clientHeight;return{x:left,y:top,left,top,width,height,right:left+width,bottom:top+height};};
w.HTMLElement.prototype.getClientRects=function(){return this.hidden?[]:[this.getBoundingClientRect()];};
Object.defineProperties(w.HTMLImageElement.prototype,{naturalWidth:{get(){return 512;}},naturalHeight:{get(){return 384;}},src:{get(){return this.getAttribute('src')||'';},set(value){this.setAttribute('src',value);queueMicrotask(()=>this.onload?.());}}});
w.Image=function(){return w.document.createElement('img');};
w.ResizeObserver=class{observe(){}disconnect(){}};
w.navigator.sendBeacon=()=>true;
w.fetch=async(url,options={})=>{
 const u=new URL(String(url),'http://oneshot.test'),pathname=u.pathname,method=options.method||'GET';requests.push({url:u.pathname,method});
 let result={};
 if(pathname==='/api/boards')result=[{id:'btest',name:'Test'}];
 else if(pathname.startsWith('/api/board/'))result=method==='PUT'?{rev:++revision}:JSON.parse(JSON.stringify(board));
 else if(pathname==='/api/capabilities')result={image:[{id:'local_h3',name:'H3',local:true,default:true}],video:[]};
 else if(pathname==='/api/me')result={id:1,role:'admin',name:'Test'};
 else if(pathname==='/api/status')result={comfy:true};
 else if(pathname==='/api/queue')result={jobs:[],total:0};
 else if(pathname==='/api/library'||pathname==='/api/assets')result=[];
 else if(pathname.startsWith('/api/image-edit/drafts/')){if(method==='GET')result=drafts.get(pathname+'|'+u.searchParams.get('ref'))||null;else{const data=JSON.parse(options.body);drafts.set(pathname+'|'+data.ref,data);result={ok:true};}}
 else if(pathname==='/api/image-edit/capabilities')result={segment:true,cutout:true,native:true};
 else if(pathname==='/api/image-edit/layers'||pathname==='/api/image-edit/transform')result={ref:`output:h3studio/result${++serial}.png`,url:`/media?ref=output:h3studio/result${serial}.png`,w:512,h:384};
 else if(pathname==='/api/image-edit/generate'){
  const recipe=JSON.parse(options.body);recipes.push(recipe);
  if(w.__failNext){w.__failNext=false;return{ok:false,status:503,json:async()=>({error:'模拟暂时不可用'}),text:async()=>JSON.stringify({error:'模拟暂时不可用'})};}
  const id='e'+String(++serial).padStart(12,'0'),ref=`output:h3studio/generated${serial}.png`;
  jobs.set(id,{state:'done',meta:{seed:111,mode_name:'局部重绘'},outputs:[{ref,url:'/media?ref='+encodeURIComponent(ref),meta:{width:512,height:384},extra:{source:'edit',edit:{recipe:{...recipe,seed:111}}}}]});
  result={ids:[id],meta:{seed:111}};
 }
 else if(pathname==='/api/jobs')result=Object.fromEntries([...jobs]);
 else if(pathname==='/api/upload')result={ref:`input:h3studio/upload${++serial}.png`,url:`/media?ref=input:h3studio/upload${serial}.png`};
 return {ok:true,status:200,json:async()=>result,text:async()=>JSON.stringify(result)};
};
function evaluate(code){return vm.runInContext(code,dom.getInternalVMContext());}
function equal(actual,expected,label){assert.deepEqual(JSON.parse(JSON.stringify(actual)),expected,label);}
async function ready(predicate,label){for(let i=0;i<100;i++){if(evaluate(predicate))return;await pause(10);}throw new Error('Timed out: '+label);}
async function run(){
 for(const file of ['image-editor.js','editor-workspace.js','canvas-tools.js','vendor/marked.js','vendor/purify.min.js','agent-markdown.js','agent-chat.js','agent-editing.js','tools.js','film.js','wizard.js','settings.js','account.js'])evaluate(fs.readFileSync(path.join(root,'static',file),'utf8'));
 const inline=[...w.document.querySelectorAll('script:not([src])')].map(x=>x.textContent).join('\n');evaluate(inline);
 await ready('B?.nodes.length===3','board boot');
 await evaluate('openImageEditor(node("n1"))');await ready('!!IMAGE_EDITOR?.image && !IMAGE_EDITOR.restoring','open editor');
 assert.equal(w.document.getElementById('imageEditor').getAttribute('aria-modal'),'false');
 evaluate('ewZoom(2)');equal(evaluate('Math.round(IMAGE_EDITOR.view.scale*100)'),200,'zoom in');
 evaluate('document.getElementById("ieFit").click()');equal(evaluate('IMAGE_EDITOR.zoom'),1,'fit resets zoom');
 evaluate('document.getElementById("iePrompt").value="restore my prompt"; ewPushStroke(IMAGE_EDITOR,{tool:"rect",points:[{x:10,y:10},{x:100,y:100}]});ieRebuildMask();ewScheduleDraft(true)');
 await evaluate('ewFlushDraft(IMAGE_EDITOR)');
 evaluate('ewUndoMask()');equal(evaluate('IMAGE_EDITOR.strokes.length'),0,'undo selection');evaluate('ewUndoMask(true)');equal(evaluate('IMAGE_EDITOR.strokes.length'),1,'redo selection');
 await evaluate('ewScheduleDraft(true);ewFlushDraft(IMAGE_EDITOR)');evaluate('closeImageEditor()');await evaluate('openImageEditor(node("n1"))');await ready('!!IMAGE_EDITOR?.image && !IMAGE_EDITOR.restoring','restore draft');
 equal(evaluate('IMAGE_EDITOR.strokes.length'),1,'selection recovered');assert.equal(w.document.getElementById('iePrompt').value,'restore my prompt');
 evaluate('document.getElementById("ieCompareMode").value="wipe";document.getElementById("ieCompareMode").dispatchEvent(new Event("change"))');assert.equal(w.document.getElementById('ieWipe').hidden,false);
 evaluate('document.getElementById("ieCompareMode").value="split";document.getElementById("ieCompareMode").dispatchEvent(new Event("change"))');equal(evaluate('IMAGE_EDITOR.compareMode'),'split','split comparison');
 evaluate('document.getElementById("ieCompareMode").value="off";document.getElementById("ieCompareMode").dispatchEvent(new Event("change"))');
 await evaluate('ewAddLayer(IMAGE_EDITOR,{ref:"input:h3studio/second.png",w:200,h:200},"Second")');equal(evaluate('IMAGE_EDITOR.layers.length'),2,'new layer');equal(evaluate('IMAGE_EDITOR.mode'),'layers','layers pane');
 evaluate('document.getElementById("ieLayerOpacity").value=50;document.getElementById("ieLayerOpacity").dispatchEvent(new Event("input"))');equal(evaluate('IMAGE_EDITOR.layers[1].opacity'),.5,'layer opacity');
 await evaluate('ewCommitLayers()');await ready('!IMAGE_EDITOR.busy && !IMAGE_EDITOR.restoring && !IMAGE_EDITOR.loading','merge layers');equal(evaluate('node("n1").versions.length'),2,'merged version');
 evaluate('ieMode("region");ewPushStroke(IMAGE_EDITOR,{tool:"rect",points:[{x:20,y:20},{x:120,y:120}]});ieRebuildMask();document.getElementById("iePrompt").value="retry instruction";window.__failNext=true');
 await evaluate('ieGenerate()');assert(w.document.querySelector('.ie-statusbar').classList.contains('error'));assert.equal(w.document.getElementById('ieRetry').hidden,false);
 evaluate('document.getElementById("ieRetry").click()');await ready('node("n1").versions.length===3 && !node("n1").job','retry completion');await ready('!!IMAGE_EDITOR.image && !IMAGE_EDITOR.loading && !IMAGE_EDITOR.restoring','retry image load');
 assert.equal(recipes.length,2);assert.equal(recipes[0].prompt,recipes[1].prompt);assert.equal(recipes[0].ref,recipes[1].ref);
 evaluate('document.getElementById("ieBackend").value="native";document.getElementById("ieBackend").dispatchEvent(new Event("change"))');assert.equal(w.document.getElementById('ieNativeSettings').hidden,false);

 evaluate('IE_WINDOW.dock="left";ieApplyWindow()');assert(w.document.getElementById('imageEditor').classList.contains('docked'));
 evaluate('document.getElementById("ieCollapse").click()');assert(w.document.getElementById('imageEditor').classList.contains('collapsed'));evaluate('document.getElementById("ieCollapse").click()');
 evaluate('closeImageEditor();sel=new Set(["n1","n2","n3"]);updateSel();ctAction("left")');equal(evaluate('B.nodes.map(n=>n.x)'),[120,120,120],'align nodes');
 evaluate('ctGroup()');equal(evaluate('B.groups.length'),1,'group nodes');evaluate('ctUngroup()');equal(evaluate('B.groups.length'),0,'ungroup nodes');evaluate('undo()');equal(evaluate('B.groups.length'),1,'undo restores group');
 assert.equal(w.document.querySelectorAll('#selectionTools button').length,11);
 const positions=evaluate('ctPositions([{id:"a",x:0,y:0},{id:"b",x:40,y:0},{id:"c",x:100,y:0}],"distributeX",()=>({w:10,h:10}))');equal(positions.map(x=>x.x),[0,50,100],'equal spacing');
 assert(requests.some(r=>r.url==='/api/image-edit/layers'));
 // Agent chat: server-owned board changes, references, recoverable messages, and safe merges.
 let remote=JSON.parse(JSON.stringify(evaluate('B'))),chatEvents=[],chatRuns=[],chatSeq=0,chatPosts=[],responseLost=true;
 remote.rev=evaluate('B.rev')||revision;
 const originalFetch=w.fetch;
 w.fetch=async(url,options={})=>{
  const u=new URL(String(url),'http://oneshot.test'),body=options.body&&JSON.parse(options.body);
  let result;
  if(u.pathname==='/api/chat/sessions')result=options.method==='POST'?{id:'s1'}:{sessions:[{id:'s1',title:'Test chat'}]};
  else if(u.pathname==='/api/chat/sessions/s1/messages'){
   chatPosts.push(body);
   if(!chatRuns.length){
    const n=JSON.parse(JSON.stringify(remote.nodes[0]));n.id='agentResult';n.name='助手结果';n.x=1600;remote.nodes.push(n);remote.rev++;
    chatRuns=[{id:'run1',state:'done',model:{provider:'Configured',model:'tools-model'}}];
    for(const [kind,data]of [['user',{text:body.text,selected:body.selected}],['tool_start',{call_id:'call1',name:'image_generate'}],['tool_end',{call_id:'call1',name:'image_generate',result:{nodes:[{id:n.id,ref:n.versions[0].ref,name:n.name}]}}],['assistant',{text:'生成并保存完成'}]])chatEvents.push({id:++chatSeq,kind,data,run_id:'run1'});
   }
   if(responseLost){responseLost=false;throw new Error('connection lost after submission');}
   result={id:'run1',state:'done'};
  }else if(u.pathname==='/api/chat/sessions/s1')result={session:{id:'s1'},events:chatEvents.filter(e=>e.id>Number(u.searchParams.get('after')||0)),runs:chatRuns,board_rev:remote.rev};
  else if(u.pathname.startsWith('/api/board/')){if(options.method==='PUT'){remote=JSON.parse(options.body);remote.rev=Math.max(revision,remote.rev||0)+1;result={rev:remote.rev};}else result=remote;}
  else return originalFetch(url,options);
  return {ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(result))};
 };
 evaluate('sel=new Set(["n1"]);updateSel()');await evaluate('acOpen()');
 assert.equal(w.document.getElementById('agentChat').hidden,false);
 assert.match(w.document.getElementById('acRefs').textContent,/Image/);
 evaluate('document.getElementById("acInput").value="生成图片"');
 await evaluate('acSend()');assert.equal(chatPosts.length,1);assert.equal(w.document.getElementById('acInput').value,'生成图片');
 assert(w.localStorage.getItem('h3.chat.outbox.s1'));await evaluate('acLoadSession("s1")');assert.equal(w.document.getElementById('acInput').value,'生成图片');await evaluate('acSend()');assert.equal(chatPosts.length,2);assert.equal(chatPosts[0].request_key,chatPosts[1].request_key,'ambiguous submission reuses idempotency key');
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
 const markdown=w.document.createElement('div');w.document.body.append(markdown);
 w.__markdown=markdown;
 evaluate('acMarkdown(window.__markdown,"# 标题\\n\\n**重点**\\n\\n- 项目一\\n- 项目二\\n\\n| 名称 | 数量 |\\n| --- | --- |\\n| 图片 | 3 |\\n\\n> 引用\\n\\n```js\\nconst value = 1;\\n```\\n\\n[官网](https://example.com)")');
 assert(markdown.querySelector('h1'));assert.equal(markdown.querySelectorAll('li').length,2);assert(markdown.querySelector('table'));assert(markdown.querySelector('blockquote'));assert.equal(markdown.querySelector('pre code').textContent.trim(),'const value = 1;');assert(markdown.querySelector('.ac-code-copy'));assert.equal(markdown.querySelector('a').rel,'noopener noreferrer');
 evaluate('acMarkdown(window.__markdown,\'<script>alert(1)</script><img src="x" onerror="alert(1)"><svg onload="alert(1)"></svg><a href="javascript:alert(1)">unsafe</a><p class="ac-conflict" style="position:fixed">text</p>\')');
 assert.equal(markdown.querySelectorAll('script,svg,[onerror],[onload],[style],.ac-conflict').length,0);assert(!markdown.querySelector('a').hasAttribute('href'));
 const videoHTML=evaluate('acResultCards({nodes:[{id:"videoTest",type:"video",ref:"output:h3studio/test.mp4",name:"视频"}]})');
 assert.match(videoHTML,/<video controls/);assert(!videoHTML.includes('<img'));
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
 const beforeTabs=evaluate('B.nodes.length');
 evaluate('els.get("pendingVideo").querySelectorAll(".vtabs button")[0].click()');
 equal(evaluate('node("pendingVideo").cur'),0,'video old tab selected');
 equal(evaluate('node("pendingVideo").data.prompt'),'old','old prompt restored');
 equal(evaluate('B.edges.filter(e=>e.to==="pendingVideo").map(e=>e.from)'),['n1','n2'],'old inputs restored');
 evaluate('switchVersion(node("pendingVideo"),1)');
 equal(evaluate('node("pendingVideo").data.duration'),8,'new duration restored');
 equal(evaluate('B.edges.filter(e=>e.to==="pendingVideo")'),[{from:'agentResult',to:'pendingVideo',role:'keyframe',time:2}],'new input role and time restored');
 equal(evaluate('B.nodes.length'),beforeTabs,'version tabs never add nodes');
 evaluate('node("pendingVideo").job={ids:[],agent_call:"busy"};switchVersion(node("pendingVideo"),0)');
 equal(evaluate('node("pendingVideo").cur'),1,'tabs cannot change an active job input graph');
 evaluate('node("pendingVideo").job=null');
 const historyCard=evaluate('acResultCards({nodes:[{id:"pendingVideo",type:"video",ref:"output:h3studio/test.mp4",version_index:0}]})');
 assert.match(historyCard,/test\.mp4/);assert(!historyCard.includes('second.mp4'),'chat result shows the saved version');
 evaluate('duplicate(["pendingVideo"])');
 const copyId=evaluate('[...sel][0]');
 equal(evaluate(`node(${JSON.stringify(copyId)}).versions[0].input_edges.every(e=>e.to===${JSON.stringify(copyId)})`),true,'duplicated history targets copied node');
 evaluate(`switchVersion(node(${JSON.stringify(copyId)}),0)`);
 equal(evaluate(`B.edges.filter(e=>e.to===${JSON.stringify(copyId)}).map(e=>e.from)`),['n1','n2'],'copied tabs restore copied input graph');
 console.log('DOM integration passed: boot, zoom, fit, draft restore, undo/redo, comparisons, layer opacity/merge, docking, alignment, grouping/undo and spacing.');
 console.log('Agent DOM integration passed: panel, references, interrupted submission retry, result sync/cards/focus, conversation restore, floating layout and conflict-safe merge.');
 console.log('Stage-two DOM passed: Markdown tables/code/links/XSS cleanup, video cards, layer metadata, before/after comparison and manual selection handoff.');
 console.log('Pending video DOM passed: immediate input edge, independent sync with chat closed and no duplicate completion.');
 console.log('Version tabs DOM passed: image tabs, video input/settings restoration, busy protection, immutable chat result cards and copied history.');
}
run().catch(err=>{console.error(err);process.exitCode=1;}).finally(()=>w.close());
