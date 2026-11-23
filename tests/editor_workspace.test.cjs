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
w.structuredClone=structuredClone;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const ctx=()=>({save(){},restore(){},translate(){},scale(){},clearRect(){},fillRect(){},fillText(){},strokeRect(){},roundRect(){},setLineDash(){},drawImage(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},fill(){},arc(){},rect(){},clip(){},closePath(){},putImageData(){},getImageData(x,y,width,height){return{data:new Uint8ClampedArray(width*height*4).fill(255)};}});
w.HTMLCanvasElement.prototype.getContext=function(){return this._context ||= ctx();};
w.HTMLCanvasElement.prototype.toBlob=function(cb){cb(new w.Blob(['png'],{type:'image/png'}));};
w.HTMLMediaElement.prototype.load=function(){};
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
 else if(pathname==='/api/board/btest/workflow-review'){
  w.__workflowReviewQuery=[u.searchParams.get('node'),u.searchParams.get('version')];
  const version=Number(u.searchParams.get('version'))||1;
  result={name:'Test',rev:1,markdown:'# 制作复盘',steps:[{node:'n1',name:'<img src=x onerror=alert(1)>',
   kind:'图片',operation:'生成',version,versions:2,recorded:true,settings:[{label:'随机种子',value:42}],memory:[],
   ref:version===1?'input:h3studio/base.png':'input:h3studio/older.png',inputs:[],prompt:'<strong>原始提示</strong>'}]};
 }
 else if(pathname.startsWith('/api/board/'))result=method==='PUT'?{rev:++revision}:JSON.parse(JSON.stringify(board));
 else if(pathname==='/api/capabilities')result=w.__capabilities||{image:[{id:'local_h3',name:'H3',local:true,default:true}],video:[]};
 else if(pathname==='/api/me')result={id:1,role:'admin',name:'Test'};
 else if(pathname==='/api/previs/render'){
  const request=JSON.parse(options.body);
  (w.__previsRequests ||= []).push(request);
  const serial=w.__previsRequests.length, jid='preview-render-'+serial, ref='output:h3studio/previs'+serial+'.mp4';
  const duration=request.span?(request.span[1]-request.span[0])/24:4;
  jobs.set(jid,{state:'done',meta:{mode_name:'白模预演渲染'},outputs:[
   {ref,url:'/media?ref='+encodeURIComponent(ref),meta:{width:720,height:1280,duration}}]});
  result={ids:[jid]};
 }
 else if(pathname==='/api/status')result={comfy:true};
 else if(pathname==='/api/queue')result={jobs:[],total:0};
 else if(pathname==='/api/canvas-teams')result=w.__assetTeams||[];
 else if(pathname==='/api/document-import')result={name:'现场记录.md',text:'<b>吊车入镜</b>',truncated:false};
 else if(pathname==='/api/asset-folders'){
  if(method==='POST'){result={id:'qa-folder',name:JSON.parse(options.body).name};w.__folders=[result];}
  else result=w.__folders||[];
 }
 else if(pathname==='/api/asset-folders/members'){
  const p=JSON.parse(options.body);w.__memories.forEach(a=>{if(p.assets.includes(a.id))a.folder_id=p.folder;});result={ok:true};
 }
 else if(pathname==='/api/asset-folders/qa-folder' && method==='DELETE'){
  w.__folders=[];w.__memories.forEach(a=>{a.folder_id=null;});result={ok:true};
 }
 else if(pathname==='/api/upload_audio')result={ref:'input:h3studio/fx.wav',url:'/media?ref=input%3Ah3studio%2Ffx.wav',name:'风铃.wav',seconds:1};
 else if(pathname==='/api/transcription'){
  if(method==='POST'){
   w.__transcriptionFile=options.body.get('file').name;
   if(w.__holdTranscription)await new Promise(resolve=>{w.__releaseTranscription=resolve;});
   result={text:'把背景调暖'};
  }else result={available:true};
 }
 else if(pathname==='/api/chat/sessions')result={sessions:[{id:'draft-chat',title:'选区测试'}]};
 else if(pathname==='/api/chat/skills'){
  if(method==='POST'){
   w.__skillPayload=JSON.parse(options.body);
   const skill={...w.__skillPayload,id:'qa-skill'};
   w.__skills=[skill];
   result=skill;
  }else result=w.__skills||[];
 }
 else if(pathname==='/api/chat/sessions/draft-chat')result={events:[],runs:[],inputs:[]};
 else if(pathname==='/api/chat/sessions/draft-chat/selection'){
  w.__selectionPayload=JSON.parse(options.body);
  result={selection_id:'mask1',node_id:w.__selectionPayload.node_id,source_ref:w.__selectionPayload.source_ref,preview_ref:'output:h3studio/selection.png'};
 }
 else if(pathname==='/api/chat/sessions/draft-chat/messages'){
  w.__chatPayload=JSON.parse(options.body);
  result={id:'run1',state:'done'};
 }
 else if(pathname==='/api/memory'){
  if(w.__memoryReadFailure&&method==='GET')return {ok:false,status:503,json:async()=>({error:'模拟读取失败'})};
  if(method==='POST'){
   const p=JSON.parse(options.body);w.__lastMemoryPost=p;
   if(w.__memorySaveFailure)return {ok:false,status:409,json:async()=>({error:'模拟保存冲突'}),text:async()=>JSON.stringify({error:'模拟保存冲突'})};
   const old=(w.__memories||[]).find(a=>a.id===p.id),media=[...(old?.media||[])];
   if(p.ref&&!media.some(m=>m.ref===p.ref))media.push({ref:p.ref,source:p.ref.startsWith('input:')?'upload':'generated'});
   result={...old,...p,id:p.id||'mem'+(++serial),owner:old?.owner||1,media,ref:p.default_ref||old?.ref||'',mtime:Date.now()};
   if(p.character_view){
    result.character_views={...(old?.character_views||{}),[p.character_view]:p.ref};
    if(p.character_view==='main')result.ref=result.default_ref=p.ref;
   }
   w.__memories=(w.__memories||[]).filter(a=>a.id!==result.id).concat(result);
  }else{
   const scope=u.searchParams.get('scope'), bid=u.searchParams.get('board');
   result=(w.__memories||[]).filter(asset=>scope==='current' ? asset.board===bid || asset.team===w.__currentAssetTeam&&!!asset.team :
    scope==='personal' ? !asset.board&&!asset.project&&!asset.team&&(asset.owner==null||asset.owner===1) :
    scope==='shared' ? asset.shared : scope?.startsWith('team:') ? asset.team===scope.slice(5) : true);
   if(!scope && w.__limitedMemoryList)result=result.filter(asset=>asset.id!=='personal-lin');
   if(u.searchParams.has('cursor')){
    const cursor=u.searchParams.get('cursor');
    if(cursor && w.__failAssetPage)return {ok:false,status:503,json:async()=>({error:'加载暂时失败'})};
    const extra=scope==='current' && w.__oldAssetPage;
    result={items:cursor?[extra]:result,next_cursor:extra&&!cursor?'older':null};
   }
  }
 }
 else if(pathname==='/api/memory/mentions'){
  const bid=u.searchParams.get('board'), query=u.searchParams.get('q').toLowerCase(), view=u.searchParams.get('view');
  const items=(w.__memories||[]).filter(a=>!a.board||a.board===bid);
  const names=a=>[a.name,...(a.aliases||[])].map(n=>n.toLowerCase());
  const views={main:'标准主图',face:'正面头肩',side:'全身侧面',back:'全身背面',detail:'固定细节'};
  result=items.filter(a=>view===null ?
   [...names(a),...(a.tags||[])].some(value=>value.includes(query)) :
   names(a).some(value=>value.includes(query))&&Object.keys(a.character_views||{}).some(slot=>slot.includes(view)||views[slot]?.includes(view)));
  result.sort((a,b)=>2*(Number(names(b).includes(query))-Number(names(a).includes(query)))+
    Number(b.board===bid)-Number(a.board===bid));
  result=result.slice(0,20).map(a=>({...a,reference_ambiguous:items.some(other=>other.id!==a.id&&names(other).includes(a.name.toLowerCase()))}));
 }
 else if(pathname==='/api/memory/search'){
  w.__semanticSearch=JSON.parse(options.body);
  result={method:'semantic',items:['doc','char'].map(id=>w.__memories.find(item=>item.id===id))};
 }
 else if(pathname==='/api/memory/char/impact')result={canvas:[{node:'n1',name:'Image',ref:'input:h3studio/base.png',version:1}],remake:[]};
 else if(pathname==='/api/memory/import-canvas'){
  const p=JSON.parse(options.body);w.__batchImports=(w.__batchImports||[]).concat(p);
  if(w.__batchImports.length===1)return {ok:false,status:503,json:async()=>({error:'收录超时'})};
  const items=p.nodes.map((n,i)=>({id:'batch'+i,name:'收录素材 '+i,kind:n.ref?'prop':'document',board:'',folder_id:p.folder,mtime:Date.now(),media:[]}));
  w.__memories=(w.__memories||[]).concat(items);result={ids:items.map(a=>a.id)};
 }
 else if(pathname.startsWith('/api/memory/')){
  const id=decodeURIComponent(pathname.split('/').pop());
  if(method==='DELETE'){w.__memories=(w.__memories||[]).filter(a=>a.id!==id);result={ok:true};}
  else result={...(w.__memories||[]).find(a=>a.id===id),history:w.__memoryHistory||[]};
 }
 else if(pathname==='/api/library'||pathname==='/api/assets')result=[];
 else if(pathname.startsWith('/api/image-edit/drafts/')){if(method==='GET')result=drafts.get(pathname+'|'+u.searchParams.get('ref'))||null;else{const data=JSON.parse(options.body);drafts.set(pathname+'|'+data.ref,data);result={ok:true};}}
 else if(pathname==='/api/image-edit/capabilities')result={segment:true,cutout:true,native:true,decompose:true,upscale:[2,4]};
 else if(pathname==='/api/image-edit/layers'||pathname==='/api/image-edit/transform')result={ref:`output:h3studio/result${++serial}.png`,url:`/media?ref=output:h3studio/result${serial}.png`,w:512,h:384};
 else if(pathname==='/api/image-edit/generate'){
  const recipe=JSON.parse(options.body);recipes.push(recipe);
  if(w.__failNext){w.__failNext=false;return{ok:false,status:503,json:async()=>({error:'模拟暂时不可用'}),text:async()=>JSON.stringify({error:'模拟暂时不可用'})};}
  const id='e'+String(++serial).padStart(12,'0'),ref=`output:h3studio/generated${serial}.png`;
  jobs.set(id,{state:'done',meta:{seed:111,mode_name:'局部重绘'},outputs:[{ref,url:'/media?ref='+encodeURIComponent(ref),meta:{width:512,height:384},extra:{source:'edit',edit:{recipe:{...recipe,seed:111}}}}]});
  result={ids:[id],meta:{seed:111}};
 }
 else if(pathname==='/api/jobs')result=Object.fromEntries([...jobs]);
 else if(pathname==='/api/upload'){
  const filename=options.body?.get('image')?.name || '';
  const video=/\.(mkv|m4v)$/i.test(filename);
  const ext=video ? filename.split('.').at(-1).toLowerCase() : 'png';
  result={ref:`input:h3studio/upload${++serial}.${ext}`,url:`/media?ref=input:h3studio/upload${serial}.${ext}`,
   ...(video ? {type:'video',w:640,h:480,seconds:2} : {})};
 }
 return {ok:true,status:200,json:async()=>result,text:async()=>JSON.stringify(result)};
};
function evaluate(code){return vm.runInContext(code,dom.getInternalVMContext());}
function equal(actual,expected,label){assert.deepEqual(JSON.parse(JSON.stringify(actual)),expected,label);}
async function ready(predicate,label,attempts=100){for(let i=0;i<attempts;i++){if(evaluate(predicate))return;await pause(10);}throw new Error('Timed out: '+label);}
async function run(){
 let notificationRequests=0;
 w.Notification={permission:"default",async requestPermission(){notificationRequests++;return this.permission="granted";}};
 const taskNotes=[];
 w.AudioContext=class {
  state="suspended";
  currentTime=10;
  destination={};
  async resume(){this.state="running";}
  async close(){this.state="closed";}
  createOscillator(){
   return {frequency:{value:0},connect(){},disconnect(){},start(){taskNotes.push(this.frequency.value);},stop(){this.onended?.();}};
  }
  createGain(){return {gain:{setValueAtTime(){},linearRampToValueAtTime(){}},connect(){},disconnect(){}};}
 };
 const staticFile = url => path.join(root, new URL(url, w.location.href).pathname);
 for (const link of w.document.querySelectorAll('link[rel=stylesheet]')) {
  const style = w.document.createElement('style');
  style.textContent = fs.readFileSync(staticFile(link.href), 'utf8');
  link.after(style);
 }
 for (const script of w.document.querySelectorAll('script')) {
  evaluate(script.src ? fs.readFileSync(staticFile(script.src), 'utf8') : script.textContent);
 }
 await ready('B?.nodes.length===3','board boot');
 evaluate('$("#vp").dispatchEvent(new Event("pointerdown",{bubbles:true}));toggleQueue(true)');
 assert.equal(notificationRequests,0,'canvas interactions do not request browser notification permission');
 const enableNotifications=evaluate('$("#qp [data-enable-notifications]")');
 assert.equal(enableNotifications.hidden,false);
 await enableNotifications.onclick();
 assert.equal(notificationRequests,1);
 assert.equal(enableNotifications.hidden,true,'permission is requested only by the explicit queue control');
 evaluate('toggleQueue(false)');
 evaluate('const nsOriginalView={...B.view}; $("#nodeSearchBtn").click(); const nsInput=$("#nodeSearch input[type=search]");nsInput.value="Hello";nsInput.dispatchEvent(new Event("input"))');
 equal(evaluate('$$("#nodeSearch li button strong").map(x=>x.textContent)'),['Text'],'node search matches text content');
 evaluate('$$(".ns-filters button").find(x=>x.textContent.startsWith("图片")).click()');
 equal(evaluate('$$("#nodeSearch li").length'),0,'node search filters by type');
 evaluate('$$(".ns-filters button").find(x=>x.textContent.startsWith("全部")).click();nsInput.value="";nsInput.dispatchEvent(new Event("input"));for(const c of $$("#nodeSearch li input").slice(1)){c.checked=true;c.dispatchEvent(new Event("change"));}$("#nodeSearch [data-locate]").click()');
 equal(evaluate('[...sel]'),['n2','n3'],'node search locates multiple marked nodes');
 evaluate('B.view=nsOriginalView;applyView();sel.clear();updateSel()');
 evaluate(`const wrBase=curV(node("n1"));
  node("n1").versions.push({...wrBase,ref:"input:h3studio/older.png"});
  const capturedForReview=captureGenerationRecord({images:[{node_id:"n1",ref:wrBase.ref}],prompt:"旧提示"},[{node_id:"n2",text:"旧旁白"}]);
  node("n1").cur=1;
  ctxMenu({target:els.get("n1"),clientX:140,clientY:120});$("#ctxMenu [data-a=workflow-review]").click();`);
 await ready('!!$("#wrSteps li")','node context opens workflow review');
 assert.deepEqual(w.__workflowReviewQuery,['n1','2']);
 assert.equal(evaluate('$("#wrSteps strong").textContent'),'<img src=x onerror=alert(1)>');
 assert.equal(evaluate('$("#wrSteps img")'),null);
 assert.equal(evaluate('$("#wrSteps pre").textContent'),'<strong>原始提示</strong>');
 evaluate('$("#wrVersion").value="1";$("#wrVersion").dispatchEvent(new Event("change"))');
 await ready('$("#wrSteps header span")?.textContent.includes("版本 1/2")','historical version can be inspected');
 const downloadUrl=w.URL.createObjectURL, anchorClick=w.HTMLAnchorElement.prototype.click, revoke=w.URL.revokeObjectURL;
 w.URL.createObjectURL=(blob)=>{w.__reviewExport=blob;return 'blob:workflow';};
 w.URL.revokeObjectURL=()=>{};
 w.HTMLAnchorElement.prototype.click=function(){w.__reviewFilename=this.download;};
 evaluate('$("#wrDownload").click()');
 assert.equal(w.__reviewFilename,'Test · 制作复盘.md');
 assert.match(w.__reviewExport.type,/text\/markdown/);
 w.URL.createObjectURL=downloadUrl;
 w.HTMLAnchorElement.prototype.click=anchorClick;
 w.URL.revokeObjectURL=revoke || (()=>{});
 evaluate('$("[data-wr-locate]").click()');
 equal(evaluate('[node("n1").cur,[...sel],capturedForReview.inputs[1].version]'),[1,['n1'],1],'review locates the node without switching its tab');
 evaluate('node("n1").versions.pop();node("n1").cur=0;B.view=nsOriginalView;applyView();sel.clear();updateSel()');
 await evaluate('openImageEditor(node("n1"))');await ready('!!IMAGE_EDITOR?.image && !IMAGE_EDITOR.restoring','open editor');
 assert.equal(w.document.getElementById('imageEditor').getAttribute('aria-modal'),'false');
 evaluate('ewZoom(2)');equal(evaluate('Math.round(IMAGE_EDITOR.view.scale*100)'),200,'zoom in');
 evaluate('document.getElementById("ieFit").click()');equal(evaluate('IMAGE_EDITOR.zoom'),1,'fit resets zoom');
 evaluate('document.getElementById("iePrompt").value="restore my prompt"; ewPushStroke(IMAGE_EDITOR,{tool:"rect",points:[{x:10,y:10},{x:100,y:100}]});ieRebuildMask();ewScheduleDraft(true)');
 await evaluate('ewFlushDraft(IMAGE_EDITOR)');
 evaluate('ewUndoMask()');equal(evaluate('IMAGE_EDITOR.strokes.length'),0,'undo selection');evaluate('ewUndoMask(true)');equal(evaluate('IMAGE_EDITOR.strokes.length'),1,'redo selection');
 await evaluate('ewScheduleDraft(true);ewFlushDraft(IMAGE_EDITOR)');evaluate('closeImageEditor()');await evaluate('openImageEditor(node("n1"))');await ready('!!IMAGE_EDITOR?.image && !IMAGE_EDITOR.restoring','restore draft');
 equal(evaluate('IMAGE_EDITOR.strokes.length'),1,'selection recovered');assert.equal(w.document.getElementById('iePrompt').value,'restore my prompt');
 evaluate('$("#ieAttachSelection").click()');
 await ready('!IMAGE_EDITOR && !!$(".ac-ref-selection")','attach editor selection in chat').catch(error=>{
  throw new Error(error.message+': '+evaluate('$("#ieStatusText").textContent'));
 });
 assert.equal(w.__selectionPayload.source_ref,board.nodes[0].versions[0].ref);
 assert.match(w.__selectionPayload.mask_data,/^data:image\/png;base64,/);
 assert.equal(w.document.activeElement.id,'acInput');
 await ready('!$("#acVoice").hidden','configured voice input is available');
 evaluate(`$("#acInput").value="保留构图";
  Object.defineProperty($("#acVoiceFile"),"files",{configurable:true,value:[new File(["audio"],"sample.wav")]});
  $("#acVoiceFile").dispatchEvent(new Event("change"));`);
 await ready('$("#acVoiceStatus").textContent==="已添加到草稿"','voice appends to the existing draft');
 assert.equal(w.document.getElementById('acInput').value,'保留构图\n把背景调暖');
 assert.equal(w.__transcriptionFile,'sample.wav');
 assert.equal(w.__chatPayload,undefined);
 evaluate('window.__holdTranscription=true;$("#acVoiceFile").dispatchEvent(new Event("change"));$("#acVoiceCancel").click();window.__releaseTranscription();window.__holdTranscription=false');
 await pause(10);
 assert.equal(w.document.getElementById('acInput').value,'保留构图\n把背景调暖','canceled results do not modify the draft');
 evaluate(`window.__voiceStops=0;
  Object.defineProperty(navigator,"mediaDevices",{configurable:true,value:{
   getUserMedia:async()=>({getTracks:()=>[{stop(){window.__voiceStops++;}}]})
  }});
  window.MediaRecorder=class {
   static isTypeSupported(type){return type==="audio/webm;codecs=opus";}
   start(){this.state="recording";}
   stop(){this.state="inactive";queueMicrotask(()=>{
    this.ondataavailable({data:new Blob(["audio"],{type:"audio/webm"})});
    this.onstop();
   });}
  };
  $("#acVoiceRecord").click();`);
 await ready('$("#acVoiceRecord").getAttribute("aria-pressed")==="true"','first click starts recording');
 evaluate('$("#acVoiceRecord").click()');
 await ready('$("#acVoiceStatus").textContent==="已添加到草稿"','second click transcribes recording');
 assert.equal(w.__transcriptionFile,'voice.webm');
 assert.equal(w.__voiceStops,1,'microphone track is released after recording');
 assert.equal(w.__chatPayload,undefined);
 delete w.MediaRecorder;
 delete w.navigator.mediaDevices;
 await evaluate('csOpen()');
 evaluate(`const skillFile=new File(["---\\nname: 色温检查\\ndescription: 检查构图和色温\\n---\\n逐镜检查"],"SKILL.md");
  Object.defineProperty(skillFile,"webkitRelativePath",{value:"review/SKILL.md"});
  const skillRef=new File(["保持产品颜色"],"colors.md");
  Object.defineProperty(skillRef,"webkitRelativePath",{value:"review/notes/colors.md"});
  Object.defineProperty($("#csFolder"),"files",{value:[skillFile,skillRef]});
  $("#csFolder").dispatchEvent(new Event("change"));`);
 await ready('!$("#csEditor").hidden','skill folder loads into editable form');
 assert.equal(evaluate('$("#csName").value'),'色温检查');
 assert.equal(evaluate('$("#csDescription").value'),'检查构图和色温');
 assert.equal(evaluate('$("#csInstructions").value'),'逐镜检查');
 evaluate('$("#csAuto").checked=false;$("#csEditor").dispatchEvent(new Event("submit",{cancelable:true}))');
 await ready('!!$("#csRows [data-skill=qa-skill]") && !CS.busy','save imported custom skill');
 equal(w.__skillPayload.references,{'notes/colors.md':'保持产品颜色'},'skill saves directory-relative reference paths');
 assert.equal(w.__skillPayload.automatic,false);
 evaluate('$("#csRows [data-cs-action=choose]").click()');
 assert.equal(evaluate('AC.skill.name'),'色温检查');
 assert.equal(evaluate('$("#acInput").value.startsWith("保留构图")'),true);
 evaluate(`$("#acSkillClear").click();$("#acInput").value="/";
  $("#acInput").dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:"/"}))`);
 await ready('$("#creativeSkills").open&&!!$("#csRows [data-skill=qa-skill]")','the first slash opens the skill picker');
 evaluate(`$("#csSearch").value="色温";$("#csSearch").dispatchEvent(new Event("input",{bubbles:true}));
  $("#csSearch").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))`);
 equal(evaluate('[AC.skill.id,$("#acInput").value,document.activeElement.id]'),['qa-skill','','acInput']);
 evaluate('$("#acInput").value="改圈选区域";$("#acInput").dispatchEvent(new Event("input"));$("#acSend").click()');
 await ready('!!window.__chatPayload && !AC.sending','send selected source and mask together');
 equal(w.__chatPayload.selected,['n1'],'message references the source node');
 assert.equal(w.__chatPayload.selection_id,'mask1');
 assert.equal(w.__chatPayload.skill_id,'qa-skill');
 assert.equal(evaluate('AC.skill'),null);
 assert.equal(w.document.querySelector('.ac-ref-selection'),null);
 evaluate('$("#acClose").click();selectOnly("n2");$("#ntools [data-a=agent]").click()');
 await ready('AC.open && AC.refs?.[0]==="n2"','reference from the canvas toolbar');
 evaluate('$("#acClose").click();localStorage.removeItem("h3.chat.session."+boardId);AC.board=null;AC.session=null;AC.refs=null;selectOnly("n1")');
 await evaluate('openImageEditor(node("n1"))');
 await ready('!!IMAGE_EDITOR?.image && !IMAGE_EDITOR.restoring','editor reopened after sending selection');
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
 assert.equal(w.document.querySelectorAll('#selectionTools button').length,15);
 evaluate(`selectOnly("n1");
  const sizedPromptPanel=$("#pp"), oldPPRect=sizedPromptPanel.getBoundingClientRect, promptBeforeResize=$("#prompt").value;
  sizedPromptPanel.getBoundingClientRect=()=>({left:60,top:70,width:ppSize?.width||560,height:ppSize?.height||220});
  const resizePrompt=(type,x,y)=>(["pointerdown","dblclick"].includes(type)?$("#ppResize"):document.body)
    .dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,button:0,clientX:x,clientY:y}));
  resizePrompt("pointerdown",620,290);resizePrompt("pointermove",710,355);resizePrompt("pointerup",710,355);`);
 equal(evaluate('[ppSize,JSON.parse(localStorage.getItem("h3.ppSize")),sizedPromptPanel.classList.contains("resized")]'),
  [{width:650,height:285},{width:650,height:285},true]);
 evaluate(`const resizePromptKey=key=>$("#ppResize").dispatchEvent(new KeyboardEvent("keydown",{key,bubbles:true,cancelable:true}));
  resizePromptKey("ArrowDown");
  resizePrompt("pointerdown",710,355);resizePrompt("pointermove",800,405);resizePrompt("pointercancel",800,405);`);
 equal(evaluate('[ppSize,$("#prompt").value===promptBeforeResize,sel.has("n1")]'),[{width:650,height:301},true,true]);
 evaluate('resizePrompt("dblclick",710,355);sizedPromptPanel.getBoundingClientRect=oldPPRect');
 equal(evaluate('[ppSize,localStorage.getItem("h3.ppSize"),sizedPromptPanel.classList.contains("resized")]'),[null,null,false]);
 console.log('Prompt panel resize passed: two axes, saved settings, keyboard adjustment, cancel and reset.');
 evaluate(`const foldFixture=snap();
  B.edges=[{from:"n1",to:"n2"},{from:"n1",to:"n3"},{from:"n2",to:"n3"}];
  sel=new Set(["n1","n2"]);updateSel();$("#selectionTools [data-action=fold]").click();`);
 equal(evaluate('[...els.values()].map(el=>el.hidden)'),[true,true,false],'fold hides only group members');
 equal(evaluate('[B.edges.length,$$("#edges .folded-edge").length,$(".folded-edge-count").textContent]'),[3,1,"2 条连线"],'fold preserves all underlying edges');
 evaluate('restore(snap())');
 equal(evaluate('[...els.values()].map(el=>el.hidden)'),[true,true,false],'fold persists through a rebuild');
 evaluate(`const foldBase=B.nodes.slice(0,2).map(n=>n.x);
  const foldAnchor=CT_FOLD_BOXES.values().next().value.x;
  $(".canvas-group.is-folded .cg-grip").dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true}));
  window.dispatchEvent(new MouseEvent("pointermove",{clientX:80*B.view.k}));
  window.dispatchEvent(new MouseEvent("pointerup"));`);
 equal(evaluate('[...B.nodes.slice(0,2).map((n,i)=>n.x-foldBase[i]),CT_FOLD_BOXES.values().next().value.x-foldAnchor]'),[80,80,80],'folded drag moves both members and proxy');
 evaluate('$(".canvas-group.is-folded [data-group-items]").click()');
 equal(evaluate('[$("#groupGallery").open,$$("#groupGalleryItems article").length]'),[true,2],'gallery lists group members');
 equal(evaluate('[$$("#groupGalleryItems img").length,$("#groupGalleryItems .cg-preview p").textContent]'),[1,"Hello"],'gallery previews current image and text');
 evaluate('AC.refs=[];$("#groupGallery [data-group-chat]").click()');
 await ready('AC.open && AC.refs?.includes("n1")','group media is ready to reference in chat');
 equal(evaluate('[AC.refs,$("#groupGallery").open]'),[["n1"],false],'attach media without adding the text or unfolding the group');
 evaluate('$("#acClose").click();localStorage.removeItem("h3.chat.session."+boardId);AC.board=null;AC.session=null;AC.refs=null;$(".canvas-group.is-folded [data-group-items]").click()');
 evaluate('$("#groupGallery [data-member-extract]").click()');
 equal(evaluate('[$("#groupGallery").open,...[...els.values()].map(el=>el.hidden),B.edges.length]'),[false,false,false,false,3],'extracting from a pair restores both cards and their links');
 evaluate('undo();$(".canvas-group.is-folded [data-group-fold]").click()');
 equal(evaluate('[...B.nodes.slice(0,2).map((n,i)=>n.x-foldBase[i]),$$("#edges .folded-edge").length,B.edges.length]'),[80,80,0,3],'undo and expansion restore the original per-node links and moved positions');
 evaluate(`const targetGroup=B.groups.find(g=>g.nodes.length===2 && g.nodes.includes("n1"));
  ctSetFold(targetGroup,true);
  const dropAt=()=>{const box=CT_FOLD_BOXES.get(targetGroup.id);return {clientX:B.view.x+(box.x+24)*B.view.k,clientY:B.view.y+(box.y+24)*B.view.k};};
  const dispatchDrop=(type)=>window.dispatchEvent(new MouseEvent(type,dropAt()));
  const textPosition=[node("n3").x,node("n3").y];
  $(".lbl",els.get("n3")).dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true,clientX:420,clientY:420}));
  dispatchDrop("pointermove");`);
 assert(evaluate('CT_GROUPS.get(targetGroup.id).classList.contains("cg-drop-target")'));
 evaluate('dispatchDrop("pointerup")');
 equal(evaluate('[targetGroup.nodes,els.get("n3").hidden,[node("n3").x,node("n3").y],B.edges.length]'),
  [["n1","n2","n3"],true,Array.from(evaluate('textPosition')),3],'dropping on a fold hides the new member and keeps its position and links');
 evaluate(`undo();
  const extra={...structuredClone(node("n3")),id:"foldExtra",x:2000,y:900};
  B.nodes.push(extra);build(extra);sel=new Set(["n3",extra.id]);updateSel();ctGroup(true);
  const sourceGroup=B.groups.find(g=>g!==B.groups[0]);
  const sourceGrip=$(".cg-grip",CT_GROUPS.get(sourceGroup.id));
  sourceGrip.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true,clientX:500,clientY:500}));
  dispatchDrop("pointermove");dispatchDrop("pointerup");`);
 equal(evaluate('[B.groups.map(g=>g.nodes),els.get("foldExtra").hidden,B.edges.length]'),[[["n1","n2","n3","foldExtra"]],true,3],'dropping a folded group merges all members');
 evaluate('undo()');
 equal(evaluate('B.groups.map(g=>g.nodes)'),[["n1","n2"],["n3","foldExtra"]],'undo restores both folded groups');
 const memoriesBeforeBatch=w.__memories;
 const activeGroupImage=evaluate('curV(node("n1")).ref');
 w.__folders=[{id:"qa-batch-folder",name:"收录目标"}];
 evaluate('$("[data-group-items]",CT_GROUPS.get(targetGroup.id)).click();$("#groupGallery [data-group-collect]").click()');
 await ready('!!$("#groupGallery select[name=folder] option[value=qa-batch-folder]")','group import loads folder choices');
 evaluate('$("#groupGallery select[name=scope]").value="personal";$("#groupGallery select[name=folder]").value="qa-batch-folder";$(".al-group-import").dispatchEvent(new Event("submit",{cancelable:true}))');
 await ready('$(".al-group-import [role=status]").textContent==="收录超时"','group import exposes server error for retry');
 evaluate('$(".al-group-import").dispatchEvent(new Event("submit",{cancelable:true}))');
 await ready('AL.open && AL.folder==="qa-batch-folder" && $$("#alGrid .al-card").length===2 && $("#alLoading").hidden','batch import opens the selected folder');
 equal(w.__batchImports[0].nodes,[{id:'n1',ref:activeGroupImage},{id:'n2',ref:null}],'the visible versions and text node are submitted together');
 equal(w.__batchImports[0],w.__batchImports[1],'a retry reuses the same import key and selection');
 evaluate('alClose();AL.folder="all"');
 equal(evaluate(`(()=>{const sound=placeLibAsset({id:"sound",name:"现场录音",kind:"prop",media:[{type:"audio",ref:"input:h3studio/fx.wav",seconds:2}]},{x:400,y:350});return [sound.type,curV(sound).seconds,!!$("audio",els.get(sound.id))];})()`),["audio",2,true],'an audio asset returns to the canvas as playable audio');
 w.__memories=memoriesBeforeBatch;w.__folders=[];
 evaluate('restore(foldFixture);sel=new Set(["n1","n2","n3"]);updateSel()');
 evaluate(`const plainImportLength=B.nodes.length;node("n3").data.text="";
   $("#selectionTools [data-action=collect]").click();`);
 await ready('$("#alCanvasImport").open && !$("#alCanvasImport [type=submit]").disabled','ungrouped selection opens the batch import dialog');
 equal(evaluate('$$("#alCanvasImport .al-import-selection li").length'),2,'only the usable image and document are listed');
 equal(evaluate('$("#alCanvasImport form p").textContent'),'另有 1 个节点暂不可收录。','unavailable items are identified');
 evaluate('$("#alCanvasImport select[name=scope]").value="personal";$("#alCanvasImport [type=submit]").click()');
 await ready('!$("#alCanvasImport").open && AL.open && $("#alLoading").hidden','selected nodes open in their destination library');
 assert.equal(w.__batchImports[2].scope,'personal');
 equal(w.__batchImports[2].nodes.map(n=>n.id),['n1','n2'],'the canvas entry submits the whole usable selection');
 equal(evaluate('B.nodes.length'),evaluate('plainImportLength'),'collection leaves existing canvas nodes in place');
 evaluate('$("#alReset").click();alClose();restore(foldFixture);sel=new Set(["n1","n2","n3"]);updateSel();');
 w.__memories=memoriesBeforeBatch;
 const positions=evaluate('ctPositions([{id:"a",x:0,y:0},{id:"b",x:40,y:0},{id:"c",x:100,y:0}],"distributeX",()=>({w:10,h:10}))');equal(positions.map(x=>x.x),[0,190,380],'distribution expands cramped bounds to keep positive spacing');
 // Regressions: aligning a dense row/column and distributing overlapping cards must not stack them.
 const packed=[{id:"wide",x:0,y:0,w:460,h:180},{id:"tall",x:0,y:0,w:240,h:760},{id:"portrait",x:10,y:10,w:280,h:520},{id:"video",x:20,y:20,w:440,h:250}];
 for(const operation of ["left","centerX","right","top","centerY","bottom","distributeX","distributeY","grid"]){
  const result=evaluate(`(()=>{const nodes=${JSON.stringify(packed)},sizeOf=n=>({w:n.w,h:n.h});return ${JSON.stringify(operation)}==="grid"?ctGridPositions(nodes,[],sizeOf):ctPositions(nodes,${JSON.stringify(operation)},sizeOf);})()`);
  const rects=result.map(p=>({...packed.find(n=>n.id===p.id),...p}));
  for(let a=0;a<rects.length;a++)for(let b=a+1;b<rects.length;b++){const x=rects[a],y=rects[b];assert(x.x+x.w+179<=y.x || y.x+y.w+179<=x.x || x.y+x.h+139<=y.y || y.y+y.h+139<=x.y,operation+" keeps visible space between mixed-size cards");}
  const fixed=[{id:"fixedA",x:0,y:0,w:1200,h:400},{id:"fixedB",x:0,y:1400,w:1200,h:400}];
  const avoided=evaluate(`(()=>{const nodes=${JSON.stringify(packed)},fixed=${JSON.stringify(fixed)},sizeOf=n=>({w:n.w,h:n.h});return ${JSON.stringify(operation)}==="grid"?ctGridPositions(nodes,fixed,sizeOf):ctPositions(nodes,${JSON.stringify(operation)},sizeOf,fixed);})()`);
  for(const p of avoided){const n={...packed.find(n=>n.id===p.id),...p};for(const f of fixed)assert(n.x+n.w+179<=f.x || f.x+f.w+179<=n.x || n.y+n.h+139<=f.y || f.y+f.h+139<=n.y,operation+" avoids fixed nodes too");}
 }
 const roomy=evaluate('ctPositions([{id:"a",x:0,y:0,w:100,h:100},{id:"b",x:400,y:0,w:100,h:100},{id:"c",x:1000,y:0,w:100,h:100}],"distributeX",n=>({w:n.w,h:n.h}))');
 equal(roomy.map(p=>p.x),[0,500,1000],'distribution preserves roomy outer bounds');
 // Canvas right click: selected/all media scopes, collision-free grid, and undo.
 const arrangeBase=evaluate('snap()');
 evaluate('const template=node("n1");for(const [id,type,x,y] of [["arrangeImage","image",420,160],["arrangeVideo","video",550,190],["fixedImage","image",2400,120]]){const n=JSON.parse(JSON.stringify(template));Object.assign(n,{id,type,x,y,name:id});if(type==="video"){n.data={prompt:"keep movement",duration:5,aspect:"auto",quality:"std"};n.versions=[{ref:"output:h3studio/arrange.mp4",url:"/media?ref=output:h3studio/arrange.mp4",w:640,h:360,seconds:5}];n.cur=0;n.job={ids:["keepJob"],prompt:"keep movement",t0:123};}B.nodes.push(n);}B.edges.push({from:"n1",to:"arrangeVideo",role:"first"});rebuild();sel=new Set(["n1","arrangeImage","arrangeVideo"]);updateSel()');
 const fixedBefore=JSON.parse(JSON.stringify(evaluate('B.nodes.filter(n=>["n2","n3","fixedImage"].includes(n.id)).map(n=>({id:n.id,x:n.x,y:n.y}))')));
 const contentBefore=evaluate('JSON.stringify({edges:B.edges,groups:B.groups,media:B.nodes.filter(ctMedia).map(({id,data,versions,cur,job})=>({id,data,versions,cur,job}))})');
 const originalPositions=JSON.parse(JSON.stringify(evaluate('B.nodes.map(({id,x,y})=>({id,x,y}))')));
 evaluate('vp.dispatchEvent(new MouseEvent("pointerdown",{button:2,clientX:100,clientY:100,bubbles:true}));window.dispatchEvent(new MouseEvent("pointerup",{button:2,clientX:100,clientY:100,bubbles:true}))');
 assert(w.document.getElementById('addMenu').classList.contains('on'));
 const entry=w.document.querySelector('#addMenu button[data-arrange-entry]');assert.equal(entry.hidden,false);entry.click();
 assert(w.document.getElementById('arrangeMenu').classList.contains('on'));
 assert.equal(w.document.querySelector('#arrangeMenu select').value,'selected');
 w.document.querySelector('#arrangeMenu [data-layout="grid"]').click();
 equal(evaluate('B.nodes.filter(n=>["n2","n3","fixedImage"].includes(n.id)).map(n=>({id:n.id,x:n.x,y:n.y}))'),fixedBefore,'selected grid leaves other nodes fixed');
 equal(evaluate('JSON.stringify({edges:B.edges,groups:B.groups,media:B.nodes.filter(ctMedia).map(({id,data,versions,cur,job})=>({id,data,versions,cur,job}))})'),contentBefore,'layout preserves links, groups, versions, parameters and job');
 const arranged=JSON.parse(JSON.stringify(evaluate('B.nodes.map(({id,x,y})=>({id,x,y}))')));assert.notDeepEqual(arranged,originalPositions);
 equal(evaluate('(()=>{const chosen=B.nodes.filter(n=>["n1","arrangeImage","arrangeVideo"].includes(n.id));return chosen.every(a=>B.nodes.every(b=>{if(a===b)return true;const sa=size(a),sb=size(b);return a.x+sa.w<=b.x || b.x+sb.w<=a.x || a.y+sa.h<=b.y || b.y+sb.h<=a.y;}));})()'),true,'grid has no media or fixed-node overlaps');
 evaluate('undo()');equal(evaluate('B.nodes.map(({id,x,y})=>({id,x,y}))'),originalPositions,'undo layout restores positions');
 evaluate('redo()');equal(evaluate('B.nodes.map(({id,x,y})=>({id,x,y}))'),arranged,'redo layout restores grid');
 evaluate('ctxMenu({target:els.get("n1"),clientX:140,clientY:120})');w.document.querySelector('#ctxMenu [data-a="arrange"]').click();
 const scope=w.document.querySelector('#arrangeMenu select');scope.value='all';scope.dispatchEvent(new w.Event('change'));
 w.document.querySelector('#arrangeMenu [data-layout="left"]').click();
 equal(evaluate('new Set(B.nodes.filter(ctMedia).map(n=>n.x)).size'),1,'all scope aligns every image and video');
 equal(evaluate('B.nodes.filter(n=>["n2","n3"].includes(n.id)).map(n=>({id:n.id,x:n.x,y:n.y}))'),fixedBefore.slice(0,2),'all media scope leaves text positions unchanged');
 evaluate('sel=new Set(["n1","arrangeImage"]);ctOpenArrangeMenu(100,100)');assert.equal(w.document.querySelector('#arrangeMenu [data-layout="distributeX"]').disabled,true,'distribution requires three media nodes');
 evaluate('openAddMenu(100,100,{at:{x:0,y:0}})');assert.equal(entry.hidden,true,'ordinary add menu hides layout entry');assert.equal(w.getComputedStyle(entry).display,'none');
 evaluate(`restore(${JSON.stringify(arrangeBase)});closeMenus();sel=new Set();updateSel();undoStack.length=0;redoStack.length=0`);
 // Relation columns and reversible video tabs operate on existing canvas data.
 const videoTabsBase=evaluate('snap()');
 evaluate('(()=>{const image=(id,x,y)=>({id,type:"image",name:id,x,y,data:{aspect:"auto"},versions:[{ref:"input:h3studio/"+id+".png",url:"/media?ref=input:h3studio/"+id+".png",w:300,h:520}],cur:0,job:null});const video=(id,x,y,count=1)=>({id,type:"video",name:id,x,y,data:{prompt:id,duration:5,aspect:"auto",quality:"std",mode:"auto",seed:17},versions:Array.from({length:count},(_,i)=>({ref:"output:h3studio/"+id+i+".mp4",url:"/media?ref=output:h3studio/"+id+i+".mp4",w:320,h:480,seconds:5,seed:i+10,video_recipe:{prompt:id+i,duration:5,seed:i+10}})),cur:count-1,job:null});B.nodes.push(image("inputFirst",200,100),image("inputLast",0,700),video("takeA",1000,300,2),video("takeB",1600,400),image("scene2Image",100,1500),video("scene2Video",1500,1600));for(const id of ["takeA","takeB"])B.edges.push({from:"inputFirst",to:id,role:id==="takeA"?"auto":"first"},{from:"inputLast",to:id,role:id==="takeA"?"auto":"last"});B.edges.push({from:"scene2Image",to:"scene2Video",role:"first"});B.groups.push({id:"takesGroup",name:"Takes",nodes:["takeA","takeB"]});rebuild();})()');
 const flowIds=['inputFirst','inputLast','takeA','takeB','scene2Image','scene2Video'];
 const flowContents=evaluate('JSON.stringify({edges:B.edges,versions:B.nodes.map(n=>[n.id,n.data,n.versions])})');
 evaluate(`sel=new Set(${JSON.stringify(flowIds)});ctOpenArrangeMenu(100,100)`);w.document.querySelector('#arrangeMenu [data-layout="flow"]').click();
 equal(evaluate(`new Set(${JSON.stringify(flowIds)}.map(node).filter(n=>n.type==="image").map(n=>n.x)).size`),1,'relation layout puts images in one column');
 equal(evaluate(`new Set(${JSON.stringify(flowIds)}.map(node).filter(n=>n.type==="video").map(n=>n.x)).size`),1,'relation layout puts videos in one column');
 equal(evaluate('node("inputFirst").x<node("takeA").x && node("inputFirst").y<node("inputLast").y && node("scene2Image").y>node("inputLast").y+size(node("inputLast")).h && node("scene2Video").y>node("takeB").y+size(node("takeB")).h'),true,'relation blocks keep frame order and separate scenes');
 equal(evaluate('JSON.stringify({edges:B.edges,versions:B.nodes.map(n=>[n.id,n.data,n.versions])})'),flowContents,'relation layout preserves inputs and recipes');
 equal(evaluate('vtSignature(node("takeA"))===vtSignature(node("takeB"))'),true,'auto and explicit first/last inputs are equivalent');
 equal(evaluate('vtSnapshot({...node("takeA"),versions:[{ref:"output:h3studio/legacy.mp4",video_recipe:{planned:true,duration:5,ar:1.5,images:[{node_id:"inputFirst",role:"frame",time:0},{node_id:"inputLast",role:"frame",time:2},{node_id:"inputLast",role:"frame",time:5}]}}],cur:0},0).input_edges.map(e=>e.role)'),['first','keyframe','last'],'legacy recipes recover their original keyframe inputs');
 equal(evaluate(`vtSnapshot({...node("takeA"),versions:[{video_recipe:{images:[
   {node_id:"inputFirst",ref:"input:h3studio/pinned.png",pinned:true},
   {node_id:"inputLast",ref:"input:h3studio/current.png"}
 ]}}],cur:0},0).input_edges.map(e=>e.ref||null)`),['input:h3studio/pinned.png',null],
  'recovering links from a recipe keeps explicit version pins and leaves ordinary links dynamic');
 equal(evaluate(`(()=>{const nodes=${JSON.stringify(flowIds)}.map(id=>({...node(id)}));nodes.find(n=>n.id==="inputFirst").y=99999;nodes.find(n=>n.id==="inputLast").y=-9999;const p=ctFlowPositions(nodes,B.edges);return p.find(n=>n.id==="inputFirst").y<p.find(n=>n.id==="inputLast").y;})()`),true,'frame roles determine image order even after positions are reversed');
 assert(evaluate('!!vtMergeInfo(["takeA","scene2Video"]).error'),'different input graphs cannot merge');
 evaluate('B.edges.find(e=>e.to==="takeB"&&e.from==="inputLast").role="keyframe";B.edges.find(e=>e.to==="takeB"&&e.from==="inputLast").time=2');
 assert(evaluate('!!vtMergeInfo(["takeA","takeB"]).error'),'different keyframe timing cannot merge');
 evaluate('B.edges.find(e=>e.to==="takeB"&&e.from==="inputLast").role="last";delete B.edges.find(e=>e.to==="takeB"&&e.from==="inputLast").time');
 evaluate('node("takeB").job={ids:["busy"],t0:0}');assert(evaluate('!!vtMergeInfo(["takeA","takeB"]).error'),'busy videos cannot merge');evaluate('node("takeB").job=null');
 evaluate('B.nodes.push({id:"scriptPin",type:"script",name:"Script",x:9000,y:9000,data:{made:[{vid:"takeB"}]},versions:[],cur:-1});vtMerge(["takeA","takeB"],"takeA")');
 equal(evaluate('!!node("takeB")&&!node("takeA")&&node("scriptPin").data.made[0].vid==="takeB"'),true,'merge keeps the node referenced by the storyboard');
 evaluate('undo();B.nodes=B.nodes.filter(n=>n.id!=="scriptPin");rebuild()');
 const beforeVideoMerge=evaluate('snap()');
 evaluate('sel=new Set(["takeA","takeB"]);ctxMenu({target:els.get("takeA"),clientX:100,clientY:100})');
 const mergeButton=w.document.querySelector('#ctxMenu [data-a="merge-tabs"]');assert(mergeButton&&!mergeButton.disabled);mergeButton.click();
 equal(evaluate('!!node("takeB")'),false,'merge removes the duplicate canvas card');equal(evaluate('node("takeA").versions.length'),3,'merge retains all versions');
 equal(evaluate('node("takeA").cur'),1,'merge retains target active tab');
 equal(evaluate('node("takeA").versions.every(v=>v.input_edges.every(e=>e.to==="takeA"))'),true,'merged input snapshots target surviving node');
 equal(evaluate('B.edges.filter(e=>e.to==="takeA").length'),2,'merge retains one input graph');
 equal(evaluate('vtResolve("takeB","output:h3studio/takeB0.mp4").node.id'),'takeA','old node references locate merged tabs');
 equal(evaluate('acResultVersion({id:"takeB",ref:"output:h3studio/takeB0.mp4"}).ref'),'output:h3studio/takeB0.mp4','chat cards retain merged results');
 evaluate('undo()');equal(evaluate('snap()'),beforeVideoMerge,'undo merge restores complete node and edge state');evaluate('redo()');
 evaluate('switchVersion(node("takeA"),2)');equal(evaluate('node("takeA").data.prompt'),'takeB0','merged tab restores its generation settings');
 equal(evaluate('B.edges.filter(e=>e.to==="takeA").map(e=>e.role)'),['first','last'],'merged tab restores frame roles');
 evaluate('B.nodes.push({id:"filmFixture",type:"video",name:"Film",x:9000,y:9000,data:{film:{clips:[{node:"takeA"}]}},versions:[],cur:-1,job:null});rebuild();vtTabMenu(node("takeA"),2,100,100)');
 w.document.querySelector('#videoTabMenu [data-split]').click();
 const splitId=evaluate('[...sel][0]');
 equal(evaluate('node("takeA").versions.length'),2,'split moves one tab out of the source');
 equal(evaluate(`node(${JSON.stringify(splitId)}).versions[0].ref`),'output:h3studio/takeB0.mp4','split preserves the video file');
 equal(evaluate(`B.edges.filter(e=>e.to===${JSON.stringify(splitId)}).map(e=>e.role)`),['first','last'],'split restores video inputs');
 equal(evaluate(`node("filmFixture").data.film.clips[0].node`),splitId,'split current tab preserves film reference');
 evaluate('undo()');equal(evaluate('node("takeA").versions.length'),3,'undo split restores tab group');equal(evaluate('node("filmFixture").data.film.clips[0].node'),'takeA','undo restores film reference');
 evaluate('vtSplit("takeA",node("takeA").cur,true)');equal(evaluate('node("takeA").versions.length'),1,'split all retains current tab in original node');
 equal(evaluate('vtResolve("takeA","output:h3studio/takeA0.mp4").node.id!=="takeA"'),true,'history references follow tabs split into new nodes');
 // Drag a matching video onto another: highlight before drop and undo the drag+merge as one action.
 evaluate(`restore(${JSON.stringify(beforeVideoMerge)});sel=new Set(["takeB"]);B.view={x:0,y:0,k:1};applyView();updateSel();(()=>{const a=node("takeA"),b=node("takeB");window.__drop={sx:b.x+10,sy:b.y-10,tx:a.x+10,ty:a.y-10};})()`);
 const beforeDragMerge=evaluate('snap()');
 const drop=w.__drop;
 w.document.querySelector('[data-id="takeB"] .lbl').dispatchEvent(new w.MouseEvent('pointerdown',{button:0,clientX:drop.sx,clientY:drop.sy,bubbles:true}));
 w.dispatchEvent(new w.MouseEvent('pointermove',{clientX:drop.tx,clientY:drop.ty,bubbles:true}));
 assert(w.document.querySelector('[data-id="takeA"]').classList.contains('tab-merge-target'),'matching drop target is highlighted');
 w.dispatchEvent(new w.MouseEvent('pointerup',{clientX:drop.tx,clientY:drop.ty,bubbles:true}));
 equal(evaluate('!!node("takeB")'),false,'drop merges video into target tabs');
 evaluate('undo()');equal(evaluate('snap()'),beforeDragMerge,'one undo restores drag position and separate videos');
 evaluate(`restore(${JSON.stringify(videoTabsBase)});closeMenus();sel=new Set();updateSel();undoStack.length=0;redoStack.length=0`);
 assert(requests.some(r=>r.url==='/api/image-edit/layers'));
 // Agent chat: server-owned board changes, references, recoverable messages, and safe merges.
 let remote=JSON.parse(JSON.stringify(evaluate('B'))),chatEvents=[],chatRuns=[],chatSeq=0,chatPosts=[],responseLost=true;
 remote.rev=evaluate('B.rev')||revision;
 const originalFetch=w.fetch;
 w.fetch=async(url,options={})=>{
  const u=new URL(String(url),'http://oneshot.test'),body=typeof options.body==='string'?JSON.parse(options.body):null;
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
 assert(w.localStorage.getItem('h3.chat.outbox.s1'));
 await evaluate('acLoadSession("s1")');
 assert.equal(evaluate('$("#acInput").value'),'生成图片');
 assert.equal(evaluate('$("#acResend").hidden'),false);
 evaluate('$("#acInput").value="尚未发送的新草稿";$("#acResend").click()');
 await ready('!AC.sending&&$("#acResend").hidden','a resend receives a delivery receipt');
 assert.equal(chatPosts.length,2);
 assert.deepEqual(chatPosts[0],chatPosts[1],'ambiguous submission resends the exact original request');
 equal(evaluate('[$("#acInput").value,$("#acDeliveryStatus").textContent]'),['尚未发送的新草稿','已送达 · Test chat']);
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
 const beforeTabs=evaluate('B.nodes.length');
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
 equal(evaluate('B.nodes.length'),beforeTabs,'version tabs never add nodes');
 evaluate('node("pendingVideo").job={ids:[],agent_call:"busy"};switchVersion(node("pendingVideo"),0)');
 equal(evaluate('node("pendingVideo").cur'),1,'tabs cannot change an active job input graph');
 evaluate('node("pendingVideo").job=null');
 evaluate(`const assetVideo=node("pendingVideo"), assetTake=curV(assetVideo);
  assetTake.memory_used=[{id:"previous-character",name:"原角色"},{id:"previous-scene",name:"原场景"}];
  const oldVideoRecipe=assetTake.video_recipe;
  assetTake.video_recipe={...oldVideoRecipe,memory_views:[{memory_id:"previous-character",views:["face"]}]};
  selectOnly(assetVideo.id);
  const regenerateVideo=prompt=>{const req={prompt};applyVideoMemory(assetVideo,req);return req;};`);
 equal(evaluate('regenerateVideo("改变动作")'),{prompt:'改变动作',memory_ids:['previous-character','previous-scene'],
  memory_views:[{memory_id:'previous-character',views:['face']}]},'ordinary generation reuses the selected take assets');
 equal(evaluate('regenerateVideo("@{previous-character#back|原角色}")'),
  {prompt:'@{previous-character#back|原角色}',memory_ids:['previous-character','previous-scene']},'a new explicit view overrides a saved view');
 evaluate('$("[data-memory-ignore=previous-character]").click()');
 equal(evaluate('regenerateVideo("改变动作")'),{prompt:'改变动作',memory_ids:['previous-scene']},
  'the references bar can remove an inherited asset while keeping the others');
 evaluate('delete assetVideo.data.ignored_memory_ids;delete assetTake.memory_used;assetTake.video_recipe=oldVideoRecipe');
 const historyCard=evaluate('acResultCards({nodes:[{id:"pendingVideo",type:"video",ref:"output:h3studio/test.mp4",version_index:0}]})');
 assert.match(historyCard,/test\.mp4/);assert(!historyCard.includes('second.mp4'),'chat result shows the saved version');
 evaluate('duplicate(["pendingVideo"])');
 const copyId=evaluate('[...sel][0]');
 equal(evaluate(`node(${JSON.stringify(copyId)}).versions[0].input_edges.every(e=>e.to===${JSON.stringify(copyId)})`),true,'duplicated history targets copied node');
 evaluate(`switchVersion(node(${JSON.stringify(copyId)}),0)`);
 equal(evaluate(`B.edges.filter(e=>e.to===${JSON.stringify(copyId)}).map(e=>e.from)`),['n1','n2'],'copied tabs restore copied input graph');
 // A real input event opens the shared completion menu; Enter selects rather than sending chat.
 w.__memories=[{id:'person1',name:'林森',kind:'character',aliases:['小林'],tags:['主角'],desc:'圆框眼镜',ref:'input:h3studio/lin.png',board:'btest'},{id:'forest1',name:'森林',kind:'scene',aliases:[],tags:['树林'],desc:'晨雾森林',ref:'input:h3studio/forest.png',board:'btest'}];
 evaluate('cmInvalidate();document.getElementById("acInput").value="让@";document.getElementById("acInput").focus();document.getElementById("acInput").setSelectionRange(2,2);document.getElementById("acInput").dispatchEvent(new Event("input",{bubbles:true}))');
 await ready('CM.popup && !CM.popup.hidden && CM.matches.filter(item=>!item.canvasNode).length===2','mention dropdown');
 equal(evaluate('document.querySelectorAll("#memoryMention [data-memory]").length'),2,'at sign lists memory records');
 evaluate('document.getElementById("acInput").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}));document.getElementById("acInput").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))');
 equal(evaluate('document.getElementById("acInput").value'),'让@森林 ','keyboard completes without chat submission');
 evaluate('document.getElementById("prompt").value="@小";document.getElementById("prompt").focus();document.getElementById("prompt").setSelectionRange(2,2);document.getElementById("prompt").dispatchEvent(new Event("input",{bubbles:true}))');
 await ready('CM.target?.id==="prompt" && !CM.popup.hidden && CM.matches.length===1','prompt alias completion');
 evaluate('document.querySelector("#memoryMention [data-memory=person1]").click()');
 equal(evaluate('document.getElementById("prompt").value'),'@林森 ','mouse completes alias with canonical name');
 w.__memories[0].character_views={main:'input:h3studio/lin.png',face:'input:h3studio/lin-face.png',back:'input:h3studio/lin-back.png'};
 evaluate(`cmInvalidate();const anglePrompt=$("#prompt");anglePrompt._node="n1";anglePrompt.value="@小林#头肩";
  anglePrompt.setSelectionRange(anglePrompt.value.length,anglePrompt.value.length);anglePrompt.dispatchEvent(new Event("input",{bubbles:true}));`);
 await ready('CM.matches.length===1 && !!$("#memoryMention [data-character-view=face]")','approved angle can be found by alias and view name');
 evaluate('$("#memoryMention [data-character-view=face]").click()');
 equal(evaluate('[anglePrompt.value,cmReadableReferences(anglePrompt.value)]'),
   ['@{person1#face|林森} ','@林森 · 正面头肩 '],'selection preserves the asset identity and displays a readable view label');
 evaluate('document.getElementById("acInput").value="@主角";document.getElementById("acInput").focus();document.getElementById("acInput").setSelectionRange(3,3);document.getElementById("acInput").dispatchEvent(new Event("input",{bubbles:true}))');
 await ready('CM.matches.length===1 && !CM.popup.hidden','tag completion');
 evaluate('document.getElementById("acInput").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');
 equal(evaluate('CM.popup.hidden'),true,'escape closes completion');
 w.__memories=[{...w.__memories[0],id:'personal-lin',board:''}, {...w.__memories[0],id:'canvas-lin',board:'btest'}];
 w.__limitedMemoryList=true;
 evaluate(`cmInvalidate();
   const scopePrompt=$("#acInput");scopePrompt.value="@林森";scopePrompt.focus();scopePrompt.setSelectionRange(3,3);
   scopePrompt.dispatchEvent(new Event("input",{bubbles:true}));`);
 await ready('!CM.popup.hidden && CM.matches.filter(a=>a.id.endsWith("-lin")).length===2','same-name assets are offered even when outside the recent list');
 equal(evaluate('CM.matches.filter(a=>a.id.endsWith("-lin")).map(a=>a.id)'),['canvas-lin','personal-lin'],'current library sorts ahead of personal results');
 evaluate('scopePrompt.value="@尚在查找";scopePrompt.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));$("#memoryMention [data-memory=personal-lin]").click()');
 equal(evaluate('scopePrompt.value'),'@尚在查找','an old suggestion cannot replace a newer query');
 evaluate('scopePrompt.value="@林森";scopePrompt.setSelectionRange(3,3)');
 evaluate('$("#memoryMention [data-memory=personal-lin]").click()');
 equal(evaluate('scopePrompt.value'),'@{personal-lin|林森} ','the older same-name asset is inserted with its own ID');
 delete w.__limitedMemoryList;
 evaluate('cmClose()');
 await evaluate('cmEdit(null,"document")');
 equal(evaluate('document.querySelector("#memoryEditor [name=kind]").value'),'document','background memory editor');
 equal(evaluate('document.querySelector("#memoryEditor [name=board]").value'),'btest','standalone canvas defaults to its own asset library');
 evaluate('document.querySelector("#memoryEditor [data-close]").click()');
 // The dedicated library uses the same persisted API records, not an independent mock-only store.
 w.__memories=[
  {id:'char',name:'林森',kind:'character',owner:1,board:'btest',aliases:['小林'],tags:['主角'],desc:'圆框眼镜',ref:'input:h3studio/lin.png',default_ref:'input:h3studio/lin.png',media:[{ref:'input:h3studio/lin.png',source:'upload'}],mtime:5},
  {id:'scene',name:'森林',kind:'scene',owner:1,board:'',aliases:[],tags:['树林'],desc:'晨雾森林',ref:'output:h3studio/forest.png',default_ref:'output:h3studio/forest.png',media:[{ref:'output:h3studio/forest.png',source:'gen'}],mtime:4},
  {id:'doc',name:'世界观 <svg onload=alert(1)>',kind:'document',owner:1,board:'btest',aliases:[],tags:['设定'],desc:'时间是2040年',media:[],mtime:3},
  {id:'clip',name:'机器人动作',kind:'prop',owner:1,board:'btest',aliases:[],tags:[],desc:'动作资料',ref:'',media:[{ref:'input:h3studio/robot.mp4',source:'upload'}],mtime:2},
  {id:'public',name:'共享画风',kind:'style',owner:2,shared:true,board:'',aliases:[],tags:[],desc:'黑白线稿',media:[],mtime:1}
 ];
 w.__memoryHistory=[{ref:'output:h3studio/history.png',board:'btest'}];
 w.__oldAssetPage={id:'old-doc',name:'旧场记',kind:'document',board:'btest',owner:1,mtime:0};
 const nodesBeforeLibrary=evaluate('B.nodes.length');
 evaluate('ME_USER={id:1,role:"member"};document.getElementById("assetLibraryBtn").click()');
 await ready('AL.items.length===3 && document.getElementById("alLoading").hidden','asset library fetches only the current scope');
 equal(evaluate('document.getElementById("assetLibrary").hidden'),false,'dedicated workspace opens');
 evaluate(`$("#alSearch").value="这部片子讲什么，谁戴眼镜";$("#alSearch").dispatchEvent(new Event("input"));$("#alSemantic").click();`);
 await ready('$("#alSemanticStatus").textContent==="按描述匹配" && $("#alSort").value==="relevance"','description search shows the result status and sort');
 equal(w.__semanticSearch,{board:'btest',scope:'current',query:'这部片子讲什么，谁戴眼镜'});
 equal(evaluate('$$("#alGrid .al-card").map(item=>item.dataset.id)'),['doc','char'],'the semantic results keep their ranking');
 evaluate('$("#alReset").click()');
 assert.equal(evaluate('$("#alSemanticStatus").hidden'),true,'reset clears the description search');
 equal(evaluate('[$("#alScope").value,$("#alScope option:checked").textContent,$$("#alGrid .al-card").length]'),
  ['current','当前资产库 · '+evaluate('B.name'),3],'the standalone library shows only the current canvas assets');
 w.__failAssetPage=true;
 evaluate('$("#alLoadMore").click()');
 await ready('!$("#alError").hidden && !$("#alLoadMore").disabled','pagination failure allows retry');
 assert.equal(evaluate('$$("#alGrid .al-card").length'),3);
 w.__failAssetPage=false;
 evaluate('$("#alLoadMore").click()');
 await ready('!!$("#alGrid [data-id=old-doc]") && $("#alLoadMore").hidden','pagination appends older assets');
 assert.equal(evaluate('$$("#alGrid .al-card").length'),4);
 delete w.__oldAssetPage;
 await evaluate('alRefresh()');
 equal(evaluate('document.querySelector("#alGrid .al-card[data-id=doc] strong svg")'),null,'asset names are escaped');
 evaluate('$("#alNewFolder").click();$("#alFolderEditor input").value="试拍";$("#alFolderEditor button[type=submit]").click()');
 await ready('!!$("#alFolders [data-folder=qa-folder]")','creates a personal asset folder');
 evaluate('$("#alFolders [data-folder=all]").click();$("#alFileMode").click();$(".al-card[data-id=char] .al-file-check input").click();$(".al-card[data-id=doc] .al-file-check input").click();$("#alTargetFolder").value="qa-folder";$("#alTargetFolder").dispatchEvent(new Event("change"));$("#alApplyFolder").click()');
 await ready('AL.items.filter(a=>a.folder_id==="qa-folder").length===2 && !AL.folderBusy','files selected assets in one action');
 evaluate('$("#alFileMode").click();$("#alFolders [data-folder=qa-folder]").click()');
 equal(evaluate('$$("#alGrid .al-card").map(a=>a.dataset.id)'),['char','doc'],'folder filters the asset grid');
 evaluate('$("#alDeleteFolder").click();$("#alFolderEditor [data-confirm]").click()');
 await ready('!$("#alFolders [data-folder=qa-folder]") && $("#alGrid").children.length===3','deleting a folder keeps its assets');
 evaluate('document.querySelector("#alCategories [data-kind=character]").click()');
 equal(evaluate('document.querySelectorAll("#alGrid .al-card").length'),1,'category filter');
 evaluate('document.querySelector("#alCategories [data-kind=all]").click();document.getElementById("alSearch").value="小林";document.getElementById("alSearch").dispatchEvent(new Event("input"))');
 equal(evaluate('document.querySelector("#alGrid .al-card").dataset.id'),'char','alias search');
 evaluate('$("#alScope").value="personal";$("#alScope").dispatchEvent(new Event("change"));document.getElementById("alSearch").value="树林";document.getElementById("alSearch").dispatchEvent(new Event("input"))');
 await ready('$("#alGrid .al-card")?.dataset.id==="scene" && $("#alLoading").hidden','personal scope is loaded on selection');
 equal(evaluate('document.querySelector("#alGrid .al-card").dataset.id'),'scene','tag search');
 evaluate('document.getElementById("alSearch").value="";document.getElementById("alSearch").dispatchEvent(new Event("input"));document.getElementById("alSource").value="generated";document.getElementById("alSource").dispatchEvent(new Event("change"))');
 equal(evaluate('document.querySelectorAll("#alGrid .al-card").length'),1,'generated source filter');
 evaluate('document.getElementById("alReset").click();document.getElementById("alScope").value="shared";document.getElementById("alScope").dispatchEvent(new Event("change"))');
 await ready('$("#alGrid .al-card")?.dataset.id==="public" && $("#alLoading").hidden','shared scope loads after rapid scope changes');
 equal(evaluate('document.querySelectorAll("#alGrid .al-card").length'),1,'shared scope is selected separately');
 evaluate('document.getElementById("alScope").value="personal";document.getElementById("alScope").dispatchEvent(new Event("change"))');
 await ready('$("#alGrid .al-card")?.dataset.id==="scene" && $("#alLoading").hidden','personal scope restores the personal assets');
 equal(evaluate('document.querySelectorAll("#alGrid .al-card").length'),1,'personal scope excludes another owner');
 evaluate('document.getElementById("alReset").click()');
 await ready('!!$("#alGrid [data-id=char] .al-card-main") && $("#alLoading").hidden','reset reloads the current library');
 evaluate('$("#alGrid [data-id=char] .al-card-main").click()');
 await ready('document.querySelector("#alDetail [name=name]")?.value==="林森" && document.querySelector("#alDetail .cm-history img")','integrated detail and history');
 await ready('!!$("#alDetail .al-impact")','asset impact disclosure is available');
 evaluate('$("#alDetail .al-impact").open=true;$("#alDetail .al-impact").ontoggle()');
 await ready('$("#alDetail .al-impact li")?.textContent.includes("Image · 版本 1")','asset detail lists a version pinned to the old reference');
 evaluate('$("#alDetail .al-impact").open=false');
 equal(evaluate('B.nodes.length'),nodesBeforeLibrary,'viewing assets never creates canvas nodes');
 equal(evaluate('document.querySelector("#alDetail .cm-hero img").getAttribute("src")'),'/media?ref=input%3Ah3studio%2Flin.png','large asset preview');
 evaluate('document.querySelector("#alDetail [name=name]").value="林森新版";document.querySelector("#alDetail form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');
 await ready('AL.items.find(a=>a.id==="char")?.name==="林森新版" && CM.editor.dataset.busy==="false"','save existing asset');
 assert.equal(w.__lastMemoryPost.default_ref,'input:h3studio/lin.png','editing metadata preserves canonical reference');
 w.__memorySaveFailure=true;
 evaluate('document.querySelector("#alDetail [name=name]").value="未保存草稿";document.querySelector("#alDetail form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');
 await ready('document.querySelector("#alDetail .cm-error").textContent.includes("模拟保存冲突") && CM.editor.dataset.busy==="false"','save conflict visible');
 equal(evaluate('document.querySelector("#alDetail [name=name]").value'),'未保存草稿','save conflict preserves draft');
 equal(evaluate('AL.items.find(a=>a.id==="char").name'),'林森新版','failed save preserves library record');
 w.__memorySaveFailure=false;
 evaluate('document.querySelector("#alGrid [data-id=clip] .al-card-main").click()');
 await ready('document.querySelector("#alDetail .cm-hero video")?.controls===true','playable video asset');
 evaluate('$("#alScope").value="shared";$("#alScope").dispatchEvent(new Event("change"))');
 await ready('!!$("#alGrid [data-id=public] .al-card-main") && $("#alLoading").hidden','shared card is loaded');
 evaluate('$("#alGrid [data-id=public] .al-card-main").click()');
 await ready('document.querySelector("#alDetail [name=name]")?.value==="共享画风"','shared asset detail');
 equal(evaluate('document.querySelector("#alDetail [name=name]").disabled'),true,'foreign shared asset read only');
 equal(evaluate('document.querySelector("#alDetail [type=submit]").hidden'),true,'shared asset hides write action');
 evaluate('$("#alReset").click()');
 const fileInput=w.document.getElementById('alFile');
 Object.defineProperty(fileInput,'files',{configurable:true,value:[new w.File(['png'],'new-person.png',{type:'image/png'})]});
 fileInput.dispatchEvent(new w.Event('change'));
 await ready('document.querySelector("#alDetail .cm-error")?.textContent.includes("已上传")','upload directly into asset editor');
 evaluate('document.querySelector("#alDetail [name=name]").value="上传角色";document.querySelector("#alDetail form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');
 await ready('AL.items.some(a=>a.name==="上传角色") && CM.editor.dataset.busy==="false"','uploaded asset persisted');
 assert.match(w.__lastMemoryPost.ref,/^input:h3studio\/upload/);assert.equal(w.__lastMemoryPost.ref,w.__lastMemoryPost.default_ref);
 assert.equal(w.__lastMemoryPost.board,'btest','a standalone upload stays with the current canvas');
 equal(evaluate('B.nodes.length'),nodesBeforeLibrary,'asset upload does not add canvas nodes');
 evaluate('node("n1").data.asset={id:AL.items.find(a=>a.name==="上传角色").id,kind:"character"};checkpoint()');
 evaluate('document.querySelector("#alDetail [data-delete]").click();document.querySelector("#alDetail [data-delete]").click()');
 await ready('!AL.items.some(a=>a.name==="上传角色") && !document.querySelector("#alDetail .cm-editor")','delete asset updates library');
 equal(evaluate('node("n1").data.asset ?? null'),null,'asset deletion unlinks the canvas image immediately');
 evaluate('undo();ctxMenu({target:els.get("n1"),clientX:140,clientY:120})');
 equal(evaluate(`document.querySelector('#ctxMenu [data-a="asset:character"]').textContent.trim()`),'存为角色','undo does not restore deleted binding');
 evaluate('closeMenus()');
 evaluate('document.getElementById("alImportBtn").click()');
 equal(evaluate('document.getElementById("alImport").hidden'),false,'canvas import chooser');
 const importText=evaluate('B.nodes.find(n=>n.type==="text"&&n.data.text)?.name');
 const importButton=[...w.document.querySelectorAll('#alImport button')].find(b=>b.textContent.startsWith(importText+' ·'));
 assert(importButton,'text canvas item available');importButton.click();
 await ready('document.querySelector("#alDetail [name=kind]")?.value==="document"','import text becomes background asset');
 evaluate('document.querySelector("#alDetail [name=name]").value="画布资料";document.querySelector("#alDetail form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');
 await ready('AL.items.some(a=>a.name==="画布资料") && CM.editor.dataset.busy==="false"','canvas text imported');
 equal(evaluate('B.nodes.length'),nodesBeforeLibrary,'collecting canvas text preserves existing nodes');
 evaluate('document.querySelector("#alGrid [data-id=char] [data-action=canvas]").click()');
 equal(evaluate('B.nodes.length'),nodesBeforeLibrary+1,'placing asset creates exactly one node');
 equal(evaluate('document.getElementById("assetLibrary").hidden'),true,'place returns to canvas');
 await evaluate('alOpen()');
 evaluate('document.querySelector("#alGrid [data-id=char] [data-action=reference]").click()');
 await ready('!AL.open && document.getElementById("acInput").value.includes("@林森新版")','asset can be cited from library');
 w.__memoryReadFailure=true;await evaluate('alOpen()');
 equal(evaluate('document.getElementById("alError").hidden'),false,'loading failure has visible error');
 w.__memoryReadFailure=false;await evaluate('alRefresh()');
 equal(evaluate('document.getElementById("alError").hidden'),true,'refresh recovers');
 evaluate('$("#alScope").value="personal";$("#alScope").dispatchEvent(new Event("change"));$("#assetBtn").click()');
 await ready('AL.open && $("#alLoading").hidden && $("#alScope").value==="current"','the entry returns to the current library from a broader scope');
 evaluate('$("#alClose").click()');
 evaluate('$("#assetBtn").click()');
 await ready('AL.open && $("#alLoading").hidden && !$("#drawer").classList.contains("on")','the side entry opens the current library directly');
 assert.equal(evaluate('$("#alScope").value'),'current');
 const beforeVideoPlace=evaluate('B.nodes.length');
 evaluate('document.querySelector("#alGrid [data-id=clip] [data-action=canvas]").click()');
 equal(evaluate('B.nodes.length'),beforeVideoPlace+1,'video asset places one node');
 equal(evaluate('B.nodes[B.nodes.length-1].type'),'video','video-only asset stays video');
 equal(evaluate('B.nodes[B.nodes.length-1].versions[0].ref'),'input:h3studio/robot.mp4','video asset retains source');
 await evaluate('alOpen()');
 await evaluate('$("#alReset").click();alNew({file:new File(["source"],"现场记录.md"),kind:"document"})');
 await ready('$(".cm-document pre")?.textContent==="<b>吊车入镜</b>"','document import previews plain text');
 assert.equal(w.document.querySelector('.cm-document pre b'),null);
 evaluate('$("#memoryEditor button[type=submit]").click()');
 await ready('window.__lastMemoryPost?.document?.name==="现场记录.md" && $("#alGrid .al-card strong")?.textContent==="现场记录"','document saves as a reusable asset');
 evaluate('$("#alSearch").value="吊车入镜";$("#alSearch").dispatchEvent(new Event("input"))');
 equal(evaluate('$$("#alGrid .al-card strong").map(e=>e.textContent)'),['现场记录'],'asset search includes document text');
 evaluate('$("#alReset").click();alClose()');
 w.__memories=w.__memories.filter(a=>a.document?.name!=='现场记录.md');
 w.__assetTeams=[{id:'asset-team',name:'短片组',managed:true}];
 w.__currentAssetTeam='asset-team';
 w.__memories.push({id:'team-style',name:'团队画风',kind:'style',team:'asset-team',owner:2,media:[]});
 evaluate('B.team="asset-team";$("#assetLibraryBtn").click()');
 await ready('!$("#alLoading").hidden || $("#alTitle").textContent==="当前资产库 · 短片组"','team canvas opens the library');
 await ready('$("#alLoading").hidden','team library finishes loading');
 equal(evaluate('[$("#alTitle").textContent,alFolderTeam(),$$("#alGrid .al-card").some(a=>a.dataset.id==="team-style"),!!$("#alGrid [data-id=scene]")]'),
  ['当前资产库 · 短片组','asset-team',true,false],'the default scope shows assets from the current team');
 await evaluate('alNew()');
 assert.equal(evaluate('$("#memoryEditor select[name=board]").value'),'team:asset-team','new assets default to the library that is open');
 evaluate('delete B.team;alBoardChanged()');
 delete w.__assetTeams;
 delete w.__currentAssetTeam;
 w.__memories=w.__memories.filter(a=>a.id!=='team-style');
 w.__memories.push({id:"bundle-qa",name:"样品瓶",kind:"prop",owner:1,ref:"input:h3studio/bottle-front.png",
  media:[{ref:"input:h3studio/bottle-front.png",type:"image"},{ref:"input:h3studio/bottle-side.png",type:"image"},
   {ref:"input:h3studio/bottle-spin.mp4",type:"video",seconds:8},{ref:"input:h3studio/bottle-sound.wav",type:"audio",seconds:3}]});
 await evaluate('cmEdit(window.__memories.find(a=>a.id==="bundle-qa"),"prop")');
 evaluate('$(".cm-generation-images").open=true');
 assert.equal(evaluate('$$("[data-generation-media]").length'),4,'all supported media can join the same bundle');
 assert.match(evaluate('$(".cm-generation-images").textContent'),/视频 · 8.0 秒/);
 evaluate(`const bundleCheck=ref=>$$("[data-generation-media]").find(box=>box.dataset.generationMedia.endsWith(ref));
  bundleCheck("bottle-front.png").click();bundleCheck("bottle-side.png").click();
  bundleCheck("bottle-spin.mp4").click();bundleCheck("bottle-sound.wav").click();
  $$(".cm-reference-range input").forEach((field,i)=>{field.value=[1,5,.5,2.5][i];field.dispatchEvent(new Event("input"));});
  $(".cm-generation-images button[aria-label='上移参考 2']").click();
  $("#memoryEditor button[type=submit]").click();`);
 await ready('$("#memoryEditor .cm-error").textContent.startsWith("已保存")','the image reference bundle is saved');
 equal(w.__lastMemoryPost.generation_media,["input:h3studio/bottle-side.png","input:h3studio/bottle-front.png","input:h3studio/bottle-spin.mp4","input:h3studio/bottle-sound.wav"]);
 equal(w.__lastMemoryPost.generation_video_ranges,{"input:h3studio/bottle-spin.mp4":[1,5]});
 equal(w.__lastMemoryPost.generation_audio_ranges,{"input:h3studio/bottle-sound.wav":[.5,2.5]});
 assert.equal(w.__lastMemoryPost.default_ref,"input:h3studio/bottle-front.png");
 evaluate('$("#memoryEditor [data-close]").click()');
 w.__memories=w.__memories.filter(a=>a.id!=="bundle-qa");
 evaluate('cmInvalidate()');
 console.log('Mixed asset bundle passed: ordered media selection, durations and a separate default image.');
 await evaluate('cmEdit(window.__memories.find(a=>a.id==="char"),"character")');
 equal(evaluate('$$(".cm-character-view button").some(b=>b.textContent==="用现有图片定稿")'),true,'existing image has direct approval action');
 equal(evaluate('$$(".cm-character-hint").filter(el=>el.textContent==="主图定稿后可生成").length'),4,'locked angles explain the prerequisite');
 const preCharacterFetch=w.fetch;
 let characterRequest, characterDone=false, characterRequests=0;
 w.fetch=async(url,options={})=>{
  if(String(url)==='/api/generate'){
   characterRequest=JSON.parse(options.body);characterRequests++;
   return {ok:true,text:async()=>JSON.stringify({ids:['character-job']})};
  }
  if(String(url)==='/api/jobs?ids=character-job'){
   const state=characterDone?{state:'done',outputs:[{ref:'output:h3studio/approved-main.png'}]}:{state:'queued'};
   return {ok:true,json:async()=>({'character-job':state})};
  }
  return preCharacterFetch(url,options);
 };
 const beforeCharacter=evaluate('B.nodes.length');
 evaluate('document.querySelector(".cm-character-primary").click();document.querySelector(".cm-character-primary").click()');
 await ready('document.querySelector(".cm-character-status")?.textContent==="排队中…"','character generation progress stays in details');
 assert.equal(characterRequests,1);
 assert.equal(characterRequest.images[0].ref,'input:h3studio/lin.png');
 assert.equal(characterRequest.character_draft.asset,'char');
 assert.match(characterRequest.prompt,/正面略转约30度/);
 equal(evaluate('B.nodes.length'),beforeCharacter,'generation leaves canvas untouched');
 evaluate('CM.editor.querySelector("[data-close]").click();characterDrafts.clear()');
 characterDone=true;
 await evaluate('alOpen()');
 equal(evaluate(`document.querySelector('#alGrid [data-id="char"] .al-reference').textContent`),'新图待定稿','opening library recovers old job and highlights candidate');
 equal(evaluate(`document.querySelector('#alGrid [data-id="char"] img').getAttribute("src")`),'/media?ref=output%3Ah3studio%2Fapproved-main.png','asset cover previews draft');
 evaluate('alClose();characterDrafts.clear();localStorage.removeItem(characterDraftKey(window.__memories.find(a=>a.id==="char"),"main",boardId))');
 w.__memories.find(a=>a.id==='char').character_drafts={main:{source:'input:h3studio/lin.png',ref:'output:h3studio/approved-main.png'}};
 await evaluate('alOpen()');
 equal(evaluate(`document.querySelector('#alGrid [data-id="char"] .al-reference').textContent`),'新图待定稿','server draft visible with no browser job state');
 evaluate('alClose()');
 await evaluate('cmEdit(window.__memories.find(a=>a.id==="char"),"character")');
 await ready('!!document.querySelector(".cm-character-candidate img")','reopened editor recovers candidate from job');
 const previewSize = evaluate('getComputedStyle($(".cm-character-preview img")).width+"x"+getComputedStyle($(".cm-character-preview img")).height');

 evaluate('$$(".cm-character-view button").find(b=>b.textContent==="定稿").click()');
 await ready('$$(".cm-character-view button").filter(b=>b.textContent==="生成").length===4','main approval unlocks all four views');
 assert.equal(w.__lastMemoryPost.character_view,'main');
 assert.equal(w.__lastMemoryPost.ref,'output:h3studio/approved-main.png');
 equal(evaluate('getComputedStyle($(".cm-character-preview img")).width+"x"+getComputedStyle($(".cm-character-preview img")).height'),previewSize,'approval retains thumbnail dimensions');
 equal(evaluate('$(".cm-character-preview").target'),'_blank','approved thumbnail opens full image');

 equal(evaluate('B.nodes.length'),beforeCharacter,'approval leaves canvas untouched');
 evaluate('CM.editor.querySelector("[data-close]").click()');
 w.fetch=preCharacterFetch;

 const appendChatEvent = (kind,text) => {
  const event={id:++chatSeq,kind,data:{text},run_id:'choice-run'};
  chatEvents.push(event);
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
   const event={id:++chatSeq,kind:'user',data:{text:picked.text},run_id:'choice-result'};
   chatEvents.push(event);
   chatRuns=[{id:'choice-result',state:'thinking'}];
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
 chatRuns=[{id:'choice-result',state:'done'}];
 await evaluate('acLoadSession("s1")');
 equal(evaluate('document.querySelectorAll(".ac-choices button:not(:disabled)").length'),0,'old choices stay inactive after replay');
 const previousFetch=w.fetch;
 w.__memories.find(a=>a.id==='char').character_views.face='input:h3studio/headshot.png';
 let remakeSession=null, remakeSelection, remakeOptions, remakeMotion, beforeSplit, remakeBatches=0;
 const reviewedMotion='第一秒回头\n固定机位\n镜头内 1.00 秒，抬起右手';
 w.fetch=async(url,options={})=>{
  if(String(url).startsWith('/api/jobs?') && String(url).includes('playback-job')){
   Object.assign(remakeSession.playback,{state:'done',ref:'output:h3studio/browser-playback.mp4'});
   return {ok:true,json:async()=>({'playback-job':{state:'done'}})};
  }
  if(String(url).startsWith('/api/jobs?') && String(url).includes('tracked-shot')){
   return {ok:true,json:async()=>({'tracked-shot':{state:'running',phase:'sampling',value:2,max:4}})};
  }
  if(String(url)==='/api/cancel'){
   assert.deepEqual(JSON.parse(options.body).ids,['tracked-shot']);
   const task=remakeSession.shots[0].videos.find(v=>v.job==='tracked-shot');
   Object.assign(task,{state:'error',error:'已取消'});
   return {ok:true,text:async()=>'{"ok":true}'};
  }
  if(!String(url).startsWith('/api/video-remake/'))return previousFetch(url,options);
  const operation=options.body&&JSON.parse(options.body);
  if(operation?.action==='prepare_playback'){
   remakeSession={shots:[],playback:{job:'playback-job',state:'queued'}};
  }
  if(operation?.action==='analyze'){
   const frame={ref:'input:h3studio/remake-frame.png',w:640,h:480,previews:[]};
   remakeSession={...remakeSession,session_node:'pendingVideo',depth_available:true,
    motion_providers:[{id:'depth-provider',name:'测试视频服务',model:'Seedance'}],warning:'镜头已切分，视觉分析暂不可用。',
    shots:[{start:.5,end:3.5,analysis_missing:true,summary:{},frames:{first:frame,middle:structuredClone(frame)}}]};
  }
  if(operation?.action==='retry_analysis'){
   assert.equal(operation.cut_revision,0);
   remakeSession.warning='';
   Object.assign(remakeSession.shots[0],{analysis_missing:false,summary:{action:['缓慢转身'],characters:['人物 A'],shot_size:'面部特写'}});
  }
  const frame=remakeSession?.shots[0]?.frames.first;
  if(operation?.action==='map_person'){
   remakeSession.mapping={source:operation.person,asset:operation.asset,asset_name:'林森新版',shots:operation.shots};
  }
  if(operation?.action==='apply_plan'){
   assert.deepEqual(operation.shots,[0]);
   assert.equal(operation.reference,'input:h3studio/headshot.png');
   remakeSession.apply_plan={submitted:[],failed:[],skipped:[],needs_selection:[0],jobs:[]};
  }
  if(operation?.action==='batch_locate_people'){
   assert.deepEqual({person:operation.person,asset:operation.asset,look:operation.look,shots:operation.shots},
    {person:'人物 A',asset:'char',look:'',shots:[0]});
   frame.person_hint={source:operation.person,look:'',point:[.35,.45]};
   remakeSession.batch_locate_people={located:[0],skipped:[],failed:[]};
  }
  if(operation?.action==='apply_person_hint'){
   assert.equal(operation.person,'人物 A');
   remakeSession.shots[0].frames[operation.frame].selection={
    mask:'input:h3studio/remake-mask.png',overlay:'input:h3studio/remake-overlay.png',
   };
  }
  if(operation?.action==='select'){
   remakeSelection=operation.rect;
   remakeSession.shots[0].frames[operation.frame][operation.layer]={
    mask:'input:h3studio/remake-mask.png',overlay:'input:h3studio/remake-overlay.png',
   };
  }
  if(operation?.action==='capture_correction'){
   const key='correction-24';
   remakeSession.shots[0].frames[key]={ref:frame.ref,w:frame.w,h:frame.h,correction_tick:24,at:1,previews:[]};
   return {ok:true,json:async()=>({...structuredClone(remakeSession),captured_frame:key}),text:async()=>JSON.stringify({...remakeSession,captured_frame:key})};
  }
  if(operation?.action==='suggest_entry'){
   assert.equal(operation.person,'人物 A');
   remakeSession.shots[0].frames.entry={ref:frame.ref,w:640,h:480,at:.75,correction_tick:18,previews:[],
    person_hint:{source:'人物 A',look:'',point:[.35,.45]}};
   return {ok:true,text:async()=>JSON.stringify({...remakeSession,captured_frame:'entry'})};
  }
  if(operation?.action==='clear_protection'){
   remakeSession.shots[0].frames[operation.frame].protection={mask:null};
  }
  if(operation?.action==='set_absence'){
   const target=remakeSession.shots[0].frames[operation.frame];
   if(operation.absent)target.person_absent={source:remakeSession.mapping.source};
   else delete target.person_absent;
  }
  if(operation?.action==='preview'){
   remakeOptions=operation;
   const selected=remakeSession.shots[0].frames[operation.frame];
   selected.previews.push({
    job:'remake-'+operation.frame,state:'done',ref:'output:h3studio/remake.png',asset:{id:'char',name:'林森'},source_person:'人物 A',
    mask:selected.selection.mask,protection:selected.protection?.mask,
   });
  }
  if(operation?.action==='batch_previews'){
   assert.equal(operation.person,'人物 A');
   const target=frame.person_absent ? 'entry' : 'first';
   const view=target==='first' ? 'face' : 'main', note=target==='first' ? '保留茶杯' : '尚未提交的修改要求';
   const asset=w.__memories.find(a=>a.id==='char');
   const reference=asset.character_views[view] || asset.ref;
   assert.deepEqual(operation.shots,[{shot:0,frame:target,view,reference,note}]);
   remakeOptions={asset:operation.asset,view};
   const selected=remakeSession.shots[0].frames[target];
   selected.previews.push({job:'remake-'+target,state:'done',ref:'output:h3studio/remake.png',asset:{id:'char',name:'林森',view,ref:reference},
    source_person:'人物 A',mask:selected.selection.mask,protection:selected.protection?.mask,note});
   remakeSession.batch_previews={submitted:[0],skipped:[],failed:[]};
  }
  if(operation?.action==='approve')remakeSession.shots[0].frames[operation.frame].approved=operation.job;
  if(operation?.action==='clear_guide')delete remakeSession.shots[0].frames[operation.frame].approved;
  if(operation?.action==='analyze_motion'){
   remakeSession.shots[0].motion_analysis={source_person:'人物 A',camera:'固定机位',beats:[{tick:24,action:'抬起右手'}]};
  }
  if(operation?.action==='prepare_depth'){
   const shot=remakeSession.shots[operation.shot];
   shot.depth={job:'depth-job',state:'done',ref:'output:h3studio/shot-depth.mp4',start:shot.start,end:shot.end,w:640,h:480};
  }
  if(operation?.action==='generate_depth_video'){
   assert.equal(operation.provider,'depth-provider');
   assert.equal(operation.first_job,'remake-first');
   assert.equal(operation.motion,reviewedMotion);
   const shot=remakeSession.shots[operation.shot];
   (shot.videos ||= []).push({job:'depth-version',state:'done',mode:'depth',depth_ref:shot.depth.ref,
    ref:'output:h3studio/depth-version.mp4',motion:operation.motion,first_frame:shot.frames.first.previews[0].ref,
    asset:{id:'char'},source_person:'人物 A'});
  }
  if(operation?.action==='batch_videos'){
   assert.deepEqual(operation.shots,[{shot:0,first_job:'remake-first',motion:reviewedMotion}]);
   remakeMotion=operation.shots[0].motion;
   const versions=remakeSession.shots[0].videos ||= [];
   const task=++remakeBatches===1 ? {job:'tracked-shot',state:'running'}
    : {job:'shot-video',state:'done',ref:'output:h3studio/shot-remake.mp4'};
   versions.push({...task,first_frame:frame.previews[0].ref,motion:remakeMotion,asset:{id:'char'},source_person:'人物 A'});
   remakeSession.batch_videos={submitted:[0],skipped:[],failed:[]};
  }
  if(operation?.action==='localize'){
   assert.equal(operation.job,'shot-video');
   remakeSession.shots[0].videos.push({job:'shot-local',mode:'local',state:'done',ref:'output:h3studio/shot-local.mp4',
    asset:{id:'char'},source_person:'人物 A',first_frame:frame.previews[0].ref,
    guides:[{ref:'output:h3studio/shot-guide.png',tick:12}],w:640,h:480,duration:3});
  }
  if(['approve_video','keep'].includes(operation?.action)){
   if(operation.cut_revision!==(remakeSession.cut_revision||0)){
    const error={error:'剪辑点已更新，请重新打开视频重制界面'};
    return {ok:false,status:409,text:async()=>JSON.stringify(error),json:async()=>error};
   }
   const shot=remakeSession.shots[operation.shot];
   shot.keep_original=operation.action==='keep';
   if(!shot.keep_original)shot.adopted_video=operation.job;
  }
  if(operation?.action==='export')remakeSession.export={job:'export-job',state:'done',ref:'output:h3studio/assembled.mp4',
   w:640,h:480,duration:3,clips:[{ref:'output:h3studio/shot-local.mp4',in:0,out:3,frames:72}]};
  if(operation?.action==='split_shot'){
   assert.equal(operation.cut_revision,0);
   assert.equal(operation.at,1.25);
   beforeSplit=structuredClone(remakeSession);
   const shot=remakeSession.shots[0];
   const splitFrame={ref:frame.ref,w:frame.w,h:frame.h,previews:[]};
   remakeSession.shots=[{...shot,end:operation.at,videos:[]},
    {start:operation.at,end:shot.end,summary:{},frames:{first:splitFrame,middle:splitFrame}}];
   remakeSession.mapping.shots=[0,1];
   Object.assign(remakeSession,{cut_revision:1,can_undo_cut:true,selected_shot:1});
   remakeSession.export.stale=true;
  }
  if(operation?.action==='undo_cut'){
   assert.equal(operation.cut_revision,1);
   remakeSession={...beforeSplit,cut_revision:2,can_undo_cut:false,selected_shot:0};
  }
  if(operation?.action==='split_long_shot'){
   const shot=remakeSession.shots[0], span=(shot.end-shot.start)/3;
   remakeSession.shots=Array.from({length:3},(_,i)=>({
    ...shot,start:shot.start+i*span,end:shot.start+(i+1)*span,
    videos:[],frames:{first:{ref:frame.ref,w:frame.w,h:frame.h,previews:[]}},
   }));
   remakeSession.mapping.shots=[0,1,2];
   Object.assign(remakeSession,{cut_revision:remakeSession.cut_revision+1,can_undo_cut:true,selected_shot:0});
  }
  if(remakeSession){
   const review={adopted:0,remaining:[]};
   for (const shot of remakeSession.mapping?.shots || []){
    const item=remakeSession.shots[shot];
    if(item.videos?.some(video=>video.job===item.adopted_video))review.adopted++;
    else review.remaining.push({shot,error:'待审核，请采用视频或选择保留原镜头'});
   }
   remakeSession.export_review=review;
  }
  return {ok:true,json:async()=>structuredClone(remakeSession),text:async()=>JSON.stringify(remakeSession)};
 };
 evaluate('ctxMenu({target:els.get("pendingVideo"),clientX:140,clientY:120})');
 evaluate(`document.querySelector('#ctxMenu [data-a="remake"]').click()`);
 await ready('$("#videoRemake [data-analyze]")?.disabled===false','remake workspace opens from video menu');
 evaluate('$(".rm-source video").dispatchEvent(new Event("error"))');
 equal(evaluate('!$("[data-playback]").hidden && !$("[data-prepare-playback]").disabled'),true,
  'a browser decode error exposes the compatible playback action before analysis');
 evaluate('$("[data-prepare-playback]").click()');
 await ready('$("[data-task-summary]").textContent.includes("原片播放预览")','playback preview uses the task queue');
 await ready('$(".rm-source video").src.includes("browser-playback.mp4")','finished playback preview replaces the player source',350);
 evaluate('$(".rm-source video").dispatchEvent(new Event("loadedmetadata"))');
 equal(evaluate('$("[data-playback]").hidden'),true,'loading the compatible video clears the playback error');
 evaluate('$("#videoRemake [data-analyze]").click()');
 await ready('!!$("#videoRemake .rm-shots button")','analyzed shot visible');
 equal(evaluate('$("[data-analyze]").textContent==="重试视觉分析" && !$("[data-analyze]").hidden'),true,
  'missing visual analysis can be retried in the same workspace');
 evaluate('$("[data-analyze]").click()');
 await ready('$("[data-analyze]").hidden && $(".rm-summary").textContent.includes("缓慢转身")',
  'retry fills the existing shot summary and removes the retry button');
 evaluate(`const sourcePersonCheck=$("#videoRemake [data-person]");sourcePersonCheck.value="人物 A";sourcePersonCheck.dispatchEvent(new Event("change"));
   $("#videoRemake [data-map-asset]").value="char";$("#videoRemake [data-map-shots] input").checked=true;
   $("#videoRemake [data-save-mapping]").click()`);
 await ready('$("#videoRemake [data-role]").disabled && $(".rm-mapping-status").textContent.includes("人物 A → 林森")','confirmed cross-shot mapping binds role');
 equal(evaluate('$("[data-review-next]").textContent==="1 个镜头待审核" && $("[data-export]").disabled'),true,
  'an unresolved mapped shot is listed before submitting export');
 evaluate('$("[data-absence]").click()');
 await ready('$(".rm-motion-hint").textContent.includes("首次入画的位置") && !$("[data-absence]").disabled','absent first frame prompts for an entry keyframe');
 equal(evaluate('$("[data-batch-locate]").disabled'),true,'batch localization skips an absent first frame');
 evaluate('$("[data-absence]").click()');
 await ready('!$("[data-batch-locate]").disabled','cancelling absence makes the frame eligible for batching');
 evaluate('$("[data-batch-locate]").click()');
 await ready('!$(".rm-person-point").hidden && $("[data-locate-person]").textContent==="按此位置选中"','model hint is visible before selection');
 equal(evaluate('$(".rm-shots button").textContent.includes("人物位置待确认") && $("[data-batch-locate]").disabled'),true,
  'a located shot is marked for review and excluded from repeat batches');
 assert.equal(evaluate('$(".rm-mask").hidden'),true);
 evaluate('$("[data-locate-person]").click()');
 await ready('$(".rm-person-point").hidden && !$(".rm-mask").hidden','confirmed location becomes a selection');

 evaluate(`$("#videoRemake [data-mode=box]").click();
  let rmSurface=$(".rm-surface");
  rmSurface.dispatchEvent(new MouseEvent("pointerdown",{button:0,clientX:60,clientY:15}));
  rmSurface.dispatchEvent(new MouseEvent("pointerup",{button:0,clientX:180,clientY:37}));`);
 await ready('!$("[data-frame]").disabled && $(".rm-mask").hidden===false','manual selection can adjust the suggested mask');
 assert.equal(remakeSelection.length,4);
 evaluate(`let remakeLayer=$("#videoRemake [data-layer]");remakeLayer.value="protection";remakeLayer.dispatchEvent(new Event("change"));
  rmSurface.dispatchEvent(new MouseEvent("pointerdown",{button:0,clientX:80,clientY:18}));
  rmSurface.dispatchEvent(new MouseEvent("pointerup",{button:0,clientX:120,clientY:28}));`);
 await ready('!$(".rm-protection").hidden && !$(".rm-mask").hidden','foreground and replacement selections are shown separately');
 evaluate('const rmNote=$("#videoRemake .rm-note input");rmNote.value="保留茶杯";rmNote.dispatchEvent(new Event("input"));$("[data-batch-previews]").click()');
 await ready('!!$("#videoRemake .rm-output img")','role preview displays in workspace');
 equal(evaluate('$("[data-batch-previews]").disabled'),true,'a finished matching first-frame preview removes the shot from the batch');
 assert.equal(remakeOptions.asset,'char');
 assert.equal(remakeOptions.view,'face','close-up suggests an approved headshot');
 evaluate('$$(".rm-review button").find(b=>b.textContent==="采用此预览").click()');
 await ready('$$(".rm-review button").some(b=>b.textContent==="用作视频首帧")','approve exposes first-frame action');
 evaluate(`const motionField=$("#videoRemake [data-motion]");motionField.value="第一秒回头";motionField.dispatchEvent(new Event("input"));$("[data-analyze-motion]").click()`);
 await ready('!!$("[data-motion-beats] button") && !$("[data-use-motion]").disabled','motion analysis exposes an actionable sampled timeline');
 equal(evaluate('motionField.value'),'第一秒回头','analysis does not change the edited draft');
 evaluate('$("[data-motion-beats] button").click()');
 equal(evaluate('$("#videoRemake .rm-source video").currentTime'),1.5,'motion time seeks relative to the current shot');
 evaluate('$("[data-use-motion]").click();$("[data-use-motion]").click()');
 equal(evaluate('motionField.value'),reviewedMotion,'applying motion notes preserves existing text and skips duplicate lines');
 evaluate('$("[data-prepare-depth]").click()');
 await ready('!$("[data-depth-player]").hidden && !$("[data-download-depth]").hidden','depth output can be played and downloaded');
 equal(evaluate('$("[data-depth-player]").getAttribute("src")'),'/media?ref=output%3Ah3studio%2Fshot-depth.mp4','preview pins the selected shot’s depth guide');
 evaluate('$("[data-insert-depth]").click()');
 equal(evaluate('B.nodes.at(-1).versions[0].remake.kind'),'depth','inserting depth creates a guide instead of an approved video');
 equal(evaluate('B.edges.find(e=>e.to===B.nodes.at(-1).id).from'),'pendingVideo','depth remains connected to the source');
 await evaluate('openVideoRemake(node("pendingVideo"))');
 await ready('!$("[data-depth-player]").hidden','depth result survives reopening the workspace');
 evaluate('$("[data-insert-depth]").click()');
 equal(evaluate('B.nodes.filter(n=>n.versions.some(v=>v.remake?.kind==="depth")).length'),1,'reinserting the same depth guide selects the existing node');
 await evaluate('openVideoRemake(node("pendingVideo"))');
 await ready('!$("[data-batch-videos]").disabled','first-frame review remains available after generating depth');
 evaluate('rmSurface=$(".rm-surface");remakeLayer=$("#videoRemake [data-layer]")');
 equal(evaluate('$("[data-depth-provider]").value'),'depth-provider','depth offers only available generation services');
 evaluate('$("[data-generate-depth-video]").click()');
 await ready('$("#videoRemake [data-result]").getAttribute("src")?.includes("depth-version.mp4")','depth-guided video joins the usual review list');
 assert.match(evaluate('$(".rm-video-review select").selectedOptions[0].textContent'),/深度参考重制/);
 assert.equal(evaluate('$("[data-batch-videos]").disabled'),false,'regular generation remains available after a depth-guided result');
 evaluate('$("[data-batch-videos]").click()');
 await ready('$("[data-task-summary]").textContent.includes("50%") && $("[data-task-list] progress")?.value===50',
  'remake header reflects the engine’s actual progress',350);
 evaluate('$("[data-task-list] button").click()');
 await ready('$(".rm-tasks").hidden && $(".rm-video-status").textContent==="已取消" && !$("[data-batch-videos]").disabled',
  'cancelling an active shot updates its version and enables retry');
 evaluate('$("[data-batch-videos]").click()');
 await ready('!!$("#videoRemake [data-result]").getAttribute("src")','remade video can be reviewed in workspace');
 assert.equal(remakeMotion,reviewedMotion);
 equal(evaluate('$("[data-batch-videos]").disabled'),true,'completed recipe is skipped by the video batch');
 evaluate(`const comparedSource=$("#videoRemake .rm-source video"), comparedResult=$("#videoRemake [data-result]");
  for(const media of [comparedSource, comparedResult]) {
   let paused=true;
   Object.defineProperty(media,"paused",{get:()=>paused});
   media.play=()=>{paused=false;return Promise.resolve()};
   media.pause=()=>{paused=true};
  }
  $("#videoRemake [data-compare]").click();`);
 equal(evaluate('[comparedSource.currentTime, comparedSource.muted, comparedResult.muted]'),[.5,false,true],'compare begins at shot start and uses only the original soundtrack');
 evaluate('comparedResult.currentTime=1.25;comparedResult.dispatchEvent(new Event("seeking"));comparedResult.dispatchEvent(new Event("seeked"))');
 equal(evaluate('[comparedSource.currentTime, comparedSource.paused]'),[1.75,false],'seeking the remake seeks the corresponding original timestamp');
 evaluate('comparedResult.currentTime=3;comparedResult.dispatchEvent(new Event("timeupdate"))');
 equal(evaluate('[comparedSource.paused,comparedResult.paused]'),[true,true],'comparison stops at the original cut');
 evaluate('$("#videoRemake video").currentTime=1;$("#videoRemake [data-capture-correction]").click()');
 await ready('$("#videoRemake [data-frame]").value==="correction-24" && !$("#videoRemake .rm-role").hidden','correction frame offers role preview generation');
 evaluate('remakeLayer.value="selection";remakeLayer.dispatchEvent(new Event("change"));$("[data-absence]").click()');
 await ready('$(".rm-selection-status").textContent.includes("从此帧保留原片") && !$("[data-absence]").disabled','absence starts preserving original frames');
 evaluate('$("[data-absence]").click()');
 await ready('$("[data-absence]").textContent==="标记人物从此帧出画" && !$("[data-absence]").disabled','absence can be undone without deleting the correction frame');
 evaluate('remakeLayer.value="protection";remakeLayer.dispatchEvent(new Event("change"))');
 evaluate('$("#videoRemake [data-clear-protection]").click()');
 await ready('$(".rm-selection-status").textContent.includes("从此帧停止保护")','stop marker can terminate foreground tracking on correction frame');
 evaluate('remakeLayer.value="selection";remakeLayer.dispatchEvent(new Event("change"))');
 evaluate(`rmSurface.dispatchEvent(new MouseEvent("pointerdown",{button:0,clientX:80,clientY:15}));
  rmSurface.dispatchEvent(new MouseEvent("pointerup",{button:0,clientX:200,clientY:37}));`);
 await ready('!$(".rm-mask").hidden && $$(".rm-video-review button").some(b=>!b.disabled && b.textContent.includes("1 张校正帧"))','correction counted by local render control');
 evaluate('$("#videoRemake [data-generate]").click()');
 await ready('$$(".rm-review button").some(b=>!b.disabled && b.textContent==="用作动作关键帧")','correction preview can be reviewed as a timed guide');
 evaluate('$$(".rm-review button").find(b=>b.textContent==="用作动作关键帧").click()');
 await ready('$(".rm-motion-hint").textContent.includes("1 张动作关键帧") && !$("#videoRemake [data-generate-video]").disabled','guide and first frame remain adopted together');
 evaluate('$$(".rm-review button").find(b=>b.textContent==="取消动作关键帧").click()');
 await ready('!$(".rm-motion-hint").textContent.includes("1 张动作关键帧") && !$("#videoRemake [data-generate-video]").disabled','guide removal preserves the adopted first frame');
 evaluate('$$(".rm-video-review button").find(b=>b.textContent.startsWith("跟踪人物并局部合成")).click()');
 await ready('$("#videoRemake [data-result]").getAttribute("src")?.includes("shot-local.mp4")','local result is selectable alongside original generation');
 evaluate('$$(".rm-video-review button").find(b=>b.textContent==="采用此视频").click()');
 await ready('!$("[data-export]").disabled && $("[data-review-next]").hidden','review unlocks export');
 evaluate('$("#videoRemake [data-export]").click()');
 await ready('$("#videoRemake [data-download]").hidden===false','finished export can be downloaded');
 equal(evaluate('$("#videoRemake [data-download]").download'),'assembled.mp4','export download uses assembled file');
 evaluate('$("[data-close]").click()');
 Object.assign(remakeSession.export,{state:'error',ref:null,error:'成片文件暂不可用，请重新合成'});
 await evaluate('openVideoRemake(node("pendingVideo"))');
 equal(evaluate('$("[data-download]").hidden && $("[data-watch]").hidden && $("[data-insert-export]").hidden'),true,
  'an unavailable export cannot be downloaded, watched, or placed on the canvas');
 equal(evaluate('$("[data-export]").textContent==="重新合成" && !$("[data-export]").disabled'),true,
  'the reviewed shots can be exported again');
 evaluate('$("[data-export]").click()');
 await ready('!$("[data-download]").hidden','a replacement export restores the download');
 evaluate(`$(".rm-cuts").open=true;const reopenedSource=$("#videoRemake .rm-source video");
  reopenedSource.currentTime=1.25;reopenedSource.dispatchEvent(new Event("timeupdate"));
  $("[data-cut=split_shot]").click();`);
 await ready('$$(".rm-shots button").length===2 && $(".rm-shot").textContent==="镜头 2" && $("[data-download]").hidden','split updates the active shot and hides the stale export');
 equal(evaluate('$("[data-review-next]").textContent==="2 个镜头待审核" && $("[data-export]").disabled'),true,
  'editing the cut exposes both unresolved shots and disables export');
 evaluate('$("[data-review-next]").click()');
 equal(evaluate('$(".rm-shot").textContent'),'镜头 1','the review shortcut takes the user to the next unresolved shot');
 evaluate('$("[data-cut=undo_cut]").click()');
 await ready('$$(".rm-shots button").length===1 && $(".rm-shot").textContent==="镜头 1"','undo restores the earlier shot');
 evaluate('$("#videoRemake [data-send-film]").click()');
 equal(evaluate('FILM.spec.clips.map(c=>[c.name,c.ref,c.in,c.out,c.audio_start])'),
  [['镜头 1','output:h3studio/shot-local.mp4',0,3,.5]],'editable handoff pins the approved clip and its original audio location');
 evaluate('FILM.spec.clips[0].subs=["剪辑草稿字幕"];FILM.pendingOffset=1.25;$("#fmV").pause=$("#fmOriginal").pause=()=>{};closeFilm();resumeFilmDraft()');
 equal(evaluate('[FILM.spec.clips[0].subs,FILM.pendingOffset]'),[['剪辑草稿字幕'],1.25],'closing and resuming restores edits and playhead');
 evaluate('$("#fmV").pause=$("#fmOriginal").pause=()=>{}; closeFilm(); selectOnly("pendingVideo"); $("#shotListBtn").click()');
 await ready('$("#shotList li")?.textContent.includes("已采用")','shot list shows the reviewed version');
 equal(evaluate(`filmTotal({clips:[
  {in:0,out:.125,remake_shot:{},trans:"fade"},
  {in:0,out:.125,remake_shot:{},trans:"cut"}
 ]})`),5/24,'short clips cap the fade to half the shorter clip in frames');
 evaluate(`const mixedRef=curV(node("n1")).ref;
   sel=new Set(["n1","pendingVideo"]);updateSel();
   ctxMenu({target:els.get("n1"),clientX:80,clientY:100});
   $("#ctxMenu [data-a=concat]").click();`);
 equal(evaluate('FILM.spec.clips.map(c=>c.kind)'),['image','video'],'images and videos share a timeline');
 equal(evaluate('[$("#fmStill").hidden, $("#fmV").hidden, $("#fmTl .fc img").src.includes(encodeURIComponent(mixedRef))]'),[false,true,true],'still shows in the viewer and timeline');
 evaluate('const stillDuration=$("#fmClip .still-duration input");stillDuration.value=".8";stillDuration.dispatchEvent(new Event("change"))');
 equal(evaluate('FILM.spec.clips[0].duration'),.8,'still duration is editable');
 evaluate('$("#fmStillSeek").value=".5";$("#fmStillSeek").dispatchEvent(new Event("input"));closeFilm();resumeFilmDraft()');
 equal(evaluate('[FILM.spec.clips[0].ref,FILM.spec.clips[0].duration,FILM.still.offset]'),[evaluate('mixedRef'),.8,.5],'draft restores still version and playhead');
 evaluate('$("#fmAll").click();FILM.still.started=performance.now()-1000;previewTick()');
 equal(evaluate('[FILM.sel,$("#fmStill").hidden,$("#fmV").hidden]'),[1,true,false],'continuous preview advances from still to video');
 evaluate('$("#fmTl .fadd").click();$("#fmAdd [data-id=n1]").click()');
 equal(evaluate('FILM.spec.clips.map(c=>c.kind)'),['image','video','image'],'add-media menu can append an image');
 evaluate(`$("#fmTime").value=".25";$("#fmTime").dispatchEvent(new Event("input"));const originalPickAudio=pickAudio;
  pickAudio=callback=>callback(new File(["audio"],"fx.wav",{type:"audio/wav"}));
  $("#fmSet [data-b=audio]").click();`);
 await ready('FILM.spec.audio_clips?.length===1 && !$("#fmAudioLanes").hidden','upload timed audio and display a lane');
 equal(evaluate('FILM.spec.audio_clips[0].start'),.25,'upload uses the actual playhead');
 evaluate(`pickAudio=originalPickAudio;
  const setAudio=(key,value)=>{const input=$("#fmAudioSettings [data-audio-key="+key+"]");input.value=value;input.dispatchEvent(new Event("change"));};
  setAudio("start",.4);setAudio("in",.2);setAudio("out",.6);setAudio("volume",.5);
  closeFilm();resumeFilmDraft();`);
 equal(evaluate('(()=>{const {start,in:i,out,volume}=FILM.spec.audio_clips[0];return [start,i,out,volume];})()'),
  [.4,.2,.6,.5],'source trims, gain and timeline position persist');
 evaluate(`const originalAudio=window.Audio;
  window.Audio=function(url){Object.assign(this,{url,paused:true,currentTime:0,play(){this.paused=false;return Promise.resolve();},pause(){this.paused=true;}});};
  $("#fmAudioLanes button").click();$("#fmStillPlay").click();FILM.still.offset=.55;previewTick();`);
 equal(evaluate('(()=>{const a=[...FILM.audioPlayers.values()][0].media;return [Math.round(a.currentTime*100),a.volume,a.paused];})()'),
  [35,.5,false],'preview seeks to the trimmed source time and applies its gain');
 evaluate('FILM.still.offset=.85;previewTick();window.Audio=originalAudio');
 equal(evaluate('FILM.audioPlayers.size'),0,'preview pauses when the audio fragment ends');
 evaluate('closeFilm()');
 evaluate('$("#shotList li button").click()');
 await ready('$("#videoRemake .rm-shot")?.textContent==="镜头 1"','shot list locates the original remake shot');
 evaluate('$("#shotList [data-close]").click()');
 evaluate(`const planHost=document.createElement("div");$("#acMessages").append(planHost);
  planHost.innerHTML=acResultCards({remake:{node_id:"pendingVideo",source_ref:curV(node("pendingVideo")).ref},
   remake_plan:{board:boardId,cut_revision:2,asset:"char",asset_name:"林森",person:"人物 A",
   reference:"input:h3studio/headshot.png",look:"",shots:[{shot:1,selection_ready:false},{shot:2,selection_ready:true}]}});
  const planChecks=$$("input",planHost);planChecks[1].checked=false;
  $("[data-apply-plan]",planHost).click()`);
 await ready('$("output",planHost).textContent.includes("请确认镜头 1")','plan submits only the checked shot and flags manual selection');
 evaluate('planHost.remove()');
 evaluate(`const rmFrameSelect=$("#videoRemake [data-frame]");rmFrameSelect.value="first";rmFrameSelect.dispatchEvent(new Event("change"))`);
 const beforeRemake=evaluate('B.nodes.length');
 evaluate('$$(".rm-review button").find(b=>b.textContent==="用作视频首帧").click()');
 equal(evaluate('B.nodes.length'),beforeRemake+2,'handoff creates one preview image and one linked video');
 equal(evaluate('B.nodes.at(-1).data.prompt'),'缓慢转身','new video receives analyzed motion description');
 equal(evaluate('B.edges.at(-1).from'),evaluate('B.nodes.at(-2).id'),'approved frame linked to new video');
 equal(evaluate('!!$("#videoRemake")'),false,'handoff returns to canvas');
 await evaluate('openVideoRemake(node("pendingVideo"))');
 evaluate('$$(".rm-video-review button").find(b=>b.textContent==="镜头放入画布").click()');
 equal(evaluate('B.nodes.length'),beforeRemake+4,'shot handoff adds a video and guide while reusing the first frame');
 const shotNode=evaluate('B.nodes.at(-1).id');
 equal(evaluate(`const shotHandoff=node(${JSON.stringify(shotNode)});
  B.edges.filter(e=>e.to===shotHandoff.id).map(e=>[e.relation||e.role,e.source_ref||curV(node(e.from)).ref,e.time??null])`),
  [['remake',evaluate('curV(node("pendingVideo")).ref'),null],['first','output:h3studio/remake.png',0],
   ['keyframe','output:h3studio/shot-guide.png',.5]],'shot keeps original video provenance and exact timed frame connections');
 remakeSession.shots[0].videos.push({...remakeSession.shots[0].videos.at(-1),job:'shot-local-2',ref:'output:h3studio/shot-local-2.mp4',guides:[]});
 remakeSession.shots[0].adopted_video='shot-local-2';
 await evaluate('openVideoRemake(node("pendingVideo"))');
 evaluate('$$(".rm-video-review button").find(b=>b.textContent==="镜头放入画布").click()');
 equal(evaluate('[shotHandoff.versions.length,curV(shotHandoff).ref]'),[2,'output:h3studio/shot-local-2.mp4'],'another reviewed result becomes a tab');
 evaluate('switchVersion(shotHandoff,0)');
 equal(evaluate('B.edges.filter(e=>e.to===shotHandoff.id).map(e=>e.relation||e.role)'),['remake','first','keyframe'],'switching tabs restores each result’s connections');
 await evaluate('openVideoRemake(node("pendingVideo"))');
 evaluate('$("[data-insert-export]").click()');
 equal(evaluate('const exportHandoff=B.nodes.at(-1);[curV(exportHandoff).ref,curV(exportHandoff).remake.clips[0].frames]'),
  ['output:h3studio/assembled.mp4',72],'finished export retains the render snapshot on the canvas');
 await evaluate('openVideoRemake(node("pendingVideo"))');
 evaluate('$("[data-insert-export]").click()');
 equal(evaluate('B.nodes.filter(n=>n.versions.some(v=>v.ref==="output:h3studio/assembled.mp4")).length'),1,'repeated handoff selects the existing export');
 await evaluate('openVideoRemake(node("pendingVideo"))');
 evaluate(`const unsentMotion=$("#videoRemake [data-motion]"),unsentNote=$("#videoRemake .rm-note input"),unsentView=$("#videoRemake [data-view]");
  unsentMotion.value="尚未提交的动作";unsentMotion.dispatchEvent(new Event("input"));
  unsentNote.value="尚未提交的修改要求";unsentNote.dispatchEvent(new Event("input"));
  unsentView.value="main";unsentView.dispatchEvent(new Event("change"));
  $("#videoRemake [data-close]").click();`);
 await evaluate('openVideoRemake(node("pendingVideo"))');
 equal(evaluate('[$("#videoRemake [data-motion]").value,$("#videoRemake .rm-note input").value,$("#videoRemake [data-view]").value]'),
  ['尚未提交的动作','尚未提交的修改要求','main'],'reopening restores the unsent shot draft and chosen view');
 evaluate('$("#videoRemake [data-close]").click();const originalVersion=node("pendingVideo").cur;switchVersion(node("pendingVideo"),originalVersion===0?1:0)');
 await evaluate('openVideoRemake(node("pendingVideo"))');
 equal(evaluate('[$("#videoRemake .rm-note input").value,$("#videoRemake [data-view]").value]'),['','face'],'another source version has its own draft scope');
 evaluate('$("#videoRemake [data-close]").click();switchVersion(node("pendingVideo"),originalVersion)');
 evaluate('const originalTab=node("pendingVideo"),originalRef=curV(originalTab).ref;vtSplit(originalTab.id,originalTab.cur)');
 equal(evaluate('const splitOriginal=vtResolve("pendingVideo",originalRef).node;B.edges.filter(e=>e.relation==="remake").every(e=>e.from===splitOriginal.id)'),true,'origin links follow the pinned video version when split');
 evaluate('switchVersion(shotHandoff,1)');
 equal(evaluate('B.edges.find(e=>e.to===shotHandoff.id&&e.relation==="remake").from'),evaluate('splitOriginal.id'),'the other result tab points to the moved origin too');
 await evaluate('openVideoRemake(splitOriginal)');
 equal(evaluate('[$("#videoRemake [data-motion]").value,$("#videoRemake .rm-note input").value,$("#videoRemake [data-view]").value]'),
  ['尚未提交的动作','尚未提交的修改要求','main'],'the moved source tab uses the draft scope of its existing remake session');
 evaluate('$("#videoRemake [data-close]").click()');
 equal(evaluate(`const mergePeer=addNode("video",3000,200,splitOriginal.data,{versions:[{...curV(splitOriginal),
   ref:"output:h3studio/merge-peer.mp4",tab_nodes:[]}],cur:0});
   B.edges.push(...B.edges.filter(e=>e.to===splitOriginal.id).map(e=>({...e,to:mergePeer.id})));
   vtMerge([splitOriginal.id,mergePeer.id],mergePeer.id)`),true,'clips with remake provenance can merge using compatible generation inputs');
 equal(evaluate('vtResolve("pendingVideo",originalRef).node.id'),evaluate('mergePeer.id'),'original source moves back into a merged tab');
 equal(evaluate('B.edges.filter(e=>e.relation==="remake").every(e=>e.from===mergePeer.id)'),true,'all remake links now point to the merged source node');
 const entryShot=remakeSession.shots[0];
 evaluate('switchVersion(mergePeer,vtResolve("pendingVideo",originalRef).index)');
 delete entryShot.frames.first.protection;
 await evaluate('openVideoRemake(mergePeer)');
 equal(evaluate('$("[data-generate-video]").disabled && $(".rm-motion-hint").textContent.includes("首帧选区已更新")'),true,
  'changed foreground protection requires a new approved first-frame preview');
 evaluate('$("#videoRemake [data-close]").click()');
 entryShot.frames.first.person_absent={source:'人物 A'};
 await evaluate('openVideoRemake(mergePeer)');
 evaluate('$("[data-suggest-entry]").click()');
 await ready('$("[data-frame]").value==="entry" && !$(".rm-person-point").hidden && $(".rm-mask").hidden',
  'entry suggestion jumps to a candidate frame without selecting the person');
 equal(evaluate('$(".rm-source video").currentTime'),.75,'the original player follows the suggested entry');
 evaluate('$("[data-locate-person]").click()');
 await ready('!$("[data-batch-previews]").disabled','confirming the suggested entry enables batch preview');
 evaluate('$("[data-batch-previews]").click()');
 await ready('$("#videoRemake [data-frame]").value==="entry" && $$(".rm-review button").some(b=>b.textContent==="用作动作关键帧")',
  'batching an off-screen shot opens its first visible frame for review');
 equal(evaluate('$("[data-batch-previews]").disabled'),true,'an unchanged reference is excluded from the batch');
 evaluate('$("#videoRemake [data-close]").click()');
 w.__memories.find(a=>a.id==='char').character_views.main='input:h3studio/new-main.png';
 await evaluate('openVideoRemake(mergePeer)');
 evaluate('const entrySelect=$("[data-frame]");entrySelect.value="entry";entrySelect.dispatchEvent(new Event("change"))');
 equal(evaluate('$("[aria-label=预览版本]").selectedOptions[0].textContent.includes("旧参考图") && !$("[data-batch-previews]").disabled'),true,
  'an updated asset reference re-enables batch generation and marks the older preview');
 evaluate('$("#videoRemake [data-close]").click()');
 remakeSession.shots[0].end=12;
 remakeSession.video_limits=[10];
 await evaluate('openVideoRemake(mergePeer)');
 equal(evaluate('[$("[data-cut=split_long_shot]").hidden,$("[data-cut=split_long_shot]").textContent,$("[data-generate-video]").disabled]'),
  [false,'拆成 2 个镜头',true],'the current route can require splitting below the general remake limit');
 evaluate('$("#videoRemake [data-close]").click()');
 delete remakeSession.video_limits;
 remakeSession.shots[0].end=29.5;
 await evaluate('openVideoRemake(mergePeer)');
 equal(evaluate('$("[data-cut=split_long_shot]").textContent'), '拆成 3 个镜头','an oversized shot shows its balanced split action');
 equal(evaluate('$("[data-generate-video]").disabled'),true,'oversized shots cannot be sent to generation');
 evaluate('$("[data-cut=split_long_shot]").click()');
 await ready('$$(".rm-shots button").length===3 && $("[data-cut=split_long_shot]").hidden && !$("[data-cut=undo_cut]").hidden',
  'automatic splitting updates the shot list and exposes undo');
 evaluate('$("#videoRemake [data-close]").click()');
 const locatedShot=remakeSession.shots[1];
 locatedShot.frames.first.person_hint={source:'人物 A',look:'',point:[.35,.45]};
 evaluate(`const pinnedIndex=vtResolve("pendingVideo",originalRef).index;
 switchVersion(mergePeer,mergePeer.cur===0?1:0);
 $("#acMessages").insertAdjacentHTML("beforeend",acResultCards({remake:{node_id:"pendingVideo",source_ref:originalRef,
  shot_number:2,shot_start:${locatedShot.start}}}));
 $("#acMessages [data-remake-node]").click();`);
 await ready('$("#videoRemake .rm-shot")?.textContent==="镜头 2" && !$(".rm-person-point").hidden && mergePeer.cur===pinnedIndex',
  'the assistant opens the located shot on the pinned source version even after its tab moved');
 evaluate('$("#videoRemake [data-close]").click()');
 const previewTime=Math.round((locatedShot.start+.5)*24);
 locatedShot.frames['correction-'+previewTime]={ref:locatedShot.frames.first.ref,w:640,h:480,at:previewTime/24,correction_tick:previewTime,
  previews:[{job:'chat-preview',state:'done',ref:'output:h3studio/chat-preview.png',asset:{id:'char'},source_person:'人物 A'},
   {job:'later-preview',state:'done',ref:'output:h3studio/later-preview.png',asset:{id:'char'},source_person:'人物 A'}]};
 evaluate(`$("#acMessages [data-remake-node]").remove();
 $("#acMessages").insertAdjacentHTML("beforeend",acResultCards({preview:{completed:[2]},remake:{node_id:"pendingVideo",
  source_ref:originalRef,shot_number:2,shot_start:${locatedShot.start},frame:"correction-${previewTime}",preview_job:"chat-preview"}}));
 $("#acMessages [data-remake-node]").click();`);
 await ready('$(".rm-output img")?.src.includes("chat-preview.png") && $(".rm-shot").textContent==="镜头 2"',
  'a preview submitted from chat opens the corresponding correction frame for review');
 evaluate('$("#videoRemake [data-close]").click()');
 locatedShot.videos=[
  {job:'chat-remake-video',state:'done',ref:'output:h3studio/chat-remake-video.mp4'},
  {job:'newer-remake-video',state:'done',ref:'output:h3studio/newer-remake-video.mp4'},
 ];
 evaluate(`$("#acMessages [data-remake-node]").remove();
 $("#acMessages").insertAdjacentHTML("beforeend",acResultCards({review_board:boardId,cut_revision:${remakeSession.cut_revision},review_versions:[
  {number:1,job:"chat-remake-video",adopted:true},{number:2,job:"newer-remake-video"}],remake:{node_id:"pendingVideo",
  source_ref:originalRef,shot_number:2,shot_start:${locatedShot.start}}}));
 $("#acMessages [data-remake-video-job=chat-remake-video]").click();`);
 await ready('$("#videoRemake video[data-result]")?.src.includes("chat-remake-video.mp4") && $(".rm-shot").textContent==="镜头 2"',
  'the assistant review menu opens the exact earlier remake version');
 evaluate('$("#videoRemake [data-close]").click()');
 remakeSession.cut_revision++;
 evaluate('$("[data-review-job=newer-remake-video]").click()');
 await ready('$("[data-review-status]").textContent.includes("剪辑点已更新") && !$("[data-review-job=newer-remake-video]").disabled',
  'a stale review card shows the conflict and leaves the decision available for a retry');
 assert.notEqual(locatedShot.adopted_video,'newer-remake-video');
 remakeSession.cut_revision--;
 evaluate('$("[data-review-job=newer-remake-video]").click()');
 await ready('$("[data-review-status]").textContent.includes("已采用") && $("[data-review-job=newer-remake-video]").getAttribute("aria-pressed")==="true"',
  'adopting a version gives direct confirmation in the chat card');
 assert.equal(locatedShot.adopted_video,'newer-remake-video');
 evaluate('$("[data-remake-decision=keep]").click()');
 await ready('$("[data-review-status]").textContent.includes("保留原片") && $("[data-remake-decision=keep]").getAttribute("aria-pressed")==="true"',
  'the keep button updates the review decision for the same shot');
 assert.equal(locatedShot.keep_original,true);
 w.fetch=previousFetch;
 evaluate(`$("#upBtn").click();
 const uploadEntry=$("#file");
 Object.defineProperty(uploadEntry,"files",{value:[new File(["video"],"source.MKV",{type:""})]});
 uploadEntry.dispatchEvent(new Event("change"));`);
 await ready('B.nodes.some(n=>n.name==="source" && n.type==="video" && curV(n)?.ref.endsWith(".mkv"))',
  'the file picker uploads an MKV without a MIME type onto a video node');
 evaluate(`const uploadDrop=new MouseEvent("drop",{clientX:550,clientY:400,bubbles:true,cancelable:true});
 Object.defineProperty(uploadDrop,"dataTransfer",{value:{getData:()=>"",files:[new File(["video"],"dropped.m4v",{type:"application/octet-stream"})]}});
 vp.dispatchEvent(uploadDrop);`);
 await ready('B.nodes.some(n=>n.name==="dropped" && n.type==="video" && curV(n)?.ref.endsWith(".m4v"))',
  'dropping a generic binary M4V uploads it as a video');
 evaluate(`const targetDropSnapshot=snap(), targetDropNode=addNode("video",1600,540,{}), targetDropId=targetDropNode.id;
 const targetDropName=targetDropNode.name, targetDropCount=B.nodes.length;
 const dropIntoVideo=fileName=>{
  const e=new MouseEvent("drop",{bubbles:true,cancelable:true});
  Object.defineProperty(e,"dataTransfer",{value:{getData:()=>"",files:[new File(["video"],fileName)]}});
  $(".card",els.get(targetDropId)).dispatchEvent(e);
 };
 dropIntoVideo("第一版.MKV");dropIntoVideo("并发重复.MKV");`);
 await ready('node(targetDropId).versions.length===1&&curV(node(targetDropId)).ref.endsWith(".mkv")','video is imported into the exact target');
 equal(evaluate('[B.nodes.length===targetDropCount,node(targetDropId).name,node(targetDropId).versions.length]'),[true,'第一版',1]);
 evaluate('dropIntoVideo("第二版.m4v")');
 await ready('node(targetDropId).versions.length===2','an existing media node receives another version');
 evaluate('undo();undo()');
 equal(evaluate('[node(targetDropId).name===targetDropName,node(targetDropId).versions.length]'),[true,0]);
 evaluate('restore(targetDropSnapshot)');
 console.log('Targeted video import passed: exact node, duplicate in-flight protection, version append and undo.');
 const countBeforePaste=evaluate('B.nodes.length');
 evaluate(`const makePaste=()=>{const event=new Event("paste",{bubbles:true,cancelable:true});
  Object.defineProperty(event,"clipboardData",{value:{files:[
    new File(["outline"],"现场记录.md",{type:"text/markdown"}),new File(["sound"],"对白",{type:"audio/wav"}),
    new File(["video"],"剪辑.MKV"),new File(["ignored"],"unsupported.zip")]}});
  return event;};
 $("#prompt").dispatchEvent(makePaste());`);
 equal(evaluate('B.nodes.length'),countBeforePaste,'paste in an editor preserves native behavior');
 evaluate('vp.dispatchEvent(makePaste())');
 await ready('B.nodes.some(n=>n.name==="剪辑" && n.type==="video" && curV(n)?.ref.endsWith(".mkv"))','mixed paste finishes');
 equal(evaluate('B.nodes.slice(-3).map(n=>[n.type,n.name,n.data.text_format||null])'),
  [['text','现场记录','markdown'],['audio','对白',null],['video','剪辑',null]],'supported files import in order');
 equal(evaluate('B.nodes.at(-3).data.text'),'<b>吊车入镜</b>','document imports editable text');
 equal(evaluate('$("#toast").textContent.includes("unsupported.zip")'),true,'mixed import identifies the unsupported file');
 evaluate('undo()');
 equal(evaluate('B.nodes.length'),countBeforePaste,'the entire import can be undone once');
 evaluate('redo()');
 equal(evaluate('B.nodes.length'),countBeforePaste+3,'redo restores all imported content');
 evaluate('undo()');
 evaluate('ctxMenu({target:els.get(B.nodes.find(n=>n.name==="dropped").id),clientX:140,clientY:120})');
 equal(evaluate('!!$("#ctxMenu [data-a=remake]")'),true,'uploaded video exposes the remake entry point');
 const projectFetch=w.fetch, projectBoards=new Map([['btest',JSON.parse(JSON.stringify(evaluate('B')))]]), projectMembership=new Map();
 const groups=new Map(), projectAssets=[], commentThreads=[], reviewPosts=[], reviewEvents=[];
 const shareRequests=[], shareState={shared:false,collaborators:[],rev:2};
 const publicToken='f'.repeat(43);
 let publicShare=null;
 let workflow=null;
 w.fetch=async(url,options={})=>{
  const u=new URL(String(url),'http://oneshot.test'),method=options.method||'GET';
  const payload=typeof options.body==='string'?JSON.parse(options.body):null;
  let result;
  if(u.pathname==='/api/boards')result=[...projectBoards].map(([id,b])=>({id,name:b.name,nodes:b.nodes.length,project:projectMembership.get(id)}));
  else if(u.pathname==='/api/canvas-projects'){
   if(method==='POST'){
    result={id:'project-test',name:payload.name};groups.set(result.id,result);
    if(payload.board)projectMembership.set(payload.board,result.id);
   }else result=[...groups.values()];
  } else if(u.pathname==='/api/canvas-projects/project-test' && method==='DELETE'){
   groups.clear();projectMembership.clear();projectAssets.forEach(a=>{a.project='';});result={ok:true};
  } else if(u.pathname==='/api/memory'){
   if(method==='POST'){
    result={...payload,id:'projectAsset',owner:1,media:[],mtime:1,ref:''};projectAssets.push(result);
   }else{
    const bid=u.searchParams.get('board');
    const scope=u.searchParams.get('scope');
    result=projectAssets.filter(a=>scope==='current' ? !!a.project&&a.project===projectMembership.get(bid) :
     scope==='personal' ? !a.project : !a.project||a.project===projectMembership.get(bid));
    if(u.searchParams.has('cursor'))result={items:result,next_cursor:null};
   }
  } else if(u.pathname==='/api/board/btest/comments'){
   if(method==='POST'){
    result={id:'comment'+(commentThreads.length+1),body:payload.body,created:1,author:'User',anchor:payload.anchor,can_resolve:true,resolved:false,replies:[]};
    if(payload.anchor?.passage) {
     const {start,end,quote}=payload.anchor.passage;
     result.anchor={...payload.anchor,passage:{quote}};
     result.passage_location=[start,end];
    }
    if(payload.thread_id)commentThreads.find(t=>t.id===payload.thread_id).replies.push(result);
    else commentThreads.unshift(result);
   }else result=commentThreads;
  } else if(u.pathname.startsWith('/api/board/btest/comments/') && method==='PATCH'){
   commentThreads.find(t=>t.id===u.pathname.split('/').at(-1)).resolved=payload.resolved;result={ok:true};
  } else if(u.pathname==='/api/chat/sessions'){
   result={sessions:[{id:'review-chat',title:'审阅'}]};
  } else if(u.pathname==='/api/chat/sessions/review-chat'){
   result={events:reviewEvents.filter(e=>e.id>Number(u.searchParams.get('after')||0)),runs:[],inputs:[]};
  } else if(u.pathname==='/api/chat/sessions/review-chat/messages'){
   reviewPosts.push(payload);
   const ids=payload.review_ids||[payload.review_id];
   const reviews=ids.map(id=>commentThreads.find(t=>t.id===id)).map(t=>({id:t.id,body:t.body,anchor:t.anchor,replies:t.replies.map(r=>r.body)}));
   reviewEvents.push({kind:'user',id:reviewEvents.length+1,data:{text:payload.text,reviews}});
   result={id:'review-run',state:'done'};
  } else if(u.pathname==='/api/board/btest/access'){
   if(method==='PATCH'){
    shareRequests.push(payload);
    shareState.collaborators=[{username:payload.username,name:'审阅同事',role:payload.role,disabled:false}];
    shareState.rev++;
    projectBoards.get('btest').rev=shareState.rev;
   }
   result=shareState;
  } else if(u.pathname==='/api/board/btest/snapshot'){
   if(method==='PUT')publicShare={token:publicToken,created:1};
   if(method==='DELETE'){publicShare=null;result={ok:true};}
   else result=publicShare;
  } else if(u.pathname==='/api/canvas-templates'){
   if(method==='POST'){
    const b=projectBoards.get(payload.board);
    const ids=new Set(payload.selected||b.nodes.map(n=>n.id));
    const fragment={nodes:b.nodes.filter(n=>ids.has(n.id)),edges:b.edges.filter(e=>ids.has(e.from)&&ids.has(e.to)),
     groups:b.groups.filter(g=>g.nodes.every(id=>ids.has(id)))};
    result={id:'qa-template',name:payload.name,nodes:fragment.nodes.length,updated:1};
    workflow={row:result,fragment,includeUpstream:payload.include_upstream};
   }else result=workflow?[workflow.row]:[];
  } else if(u.pathname==='/api/canvas-templates/qa-template/fragment'){
   result=JSON.parse(JSON.stringify(workflow.fragment));
   workflow.copyInputs=payload.inputs||[];
   for(const edit of workflow.copyInputs){
    const target=result.nodes.find(node=>node.id===edit.node);
    assert.equal(target.data[edit.field],edit.before);
    target.data[edit.field]=edit.value;
   }
  } else if(u.pathname==='/api/canvas-templates/qa-template/content'){
   workflow.replacePayload=payload;
   workflow.row.updated++;
   result={ok:true};
  } else if(u.pathname==='/api/canvas-templates/qa-template/history'){
   result=[{id:12,name:workflow.row.name,updated:1,nodes:2}];
  } else if(u.pathname==='/api/canvas-templates/qa-template/history/12'){
   result={nodes:[{name:'旧镜头',type:'video',inputs:{prompt:'前一版提示词'}}]};
  } else if(u.pathname==='/api/canvas-templates/qa-template/history/12/restore'){
   workflow.restorePayload=payload;workflow.row.updated++;
   result={ok:true};
  } else if(u.pathname==='/api/canvas-templates/catalog'){
   result=workflow?.row.published?[{...workflow.row,author:'创作者',owned:1}]:[];
  } else if(u.pathname==='/api/canvas-templates/favorites'){
   result=workflow?.row.favorite?[{...workflow.row,author:'创作者',owned:1}]:[];
  } else if(u.pathname==='/api/canvas-templates/qa-template/favorite'){
   workflow.row.favorite=method==='PUT';
   result={favorite:workflow.row.favorite};
  } else if(u.pathname==='/api/canvas-templates/qa-template/publication'){
   assert.equal(payload.confirmed,true);
   workflow.row.published=1;
   result={ok:true};
  } else if(u.pathname==='/api/canvas-templates/qa-template/preview'){
   result={name:workflow.row.name,edges:workflow.fragment.edges.map(edge=>({...edge,version:1,media:2})),nodes:workflow.fragment.nodes.map((n,i)=>(
    {id:n.id,type:n.type,name:n.name,prompt:n.data.prompt,inputs:{prompt:n.data.prompt||''},media:i}))};
  } else if(u.pathname.startsWith('/api/board/')){
   const id=u.pathname.split('/').at(-1);
   if(method==='PUT'){
    result={rev:2};projectBoards.set(id,{...payload,rev:2,owner:1});
    if(u.searchParams.has('project'))projectMembership.set(id,u.searchParams.get('project'));
   }else result=projectBoards.get(id);
  }else return projectFetch(url,options);
  return {ok:true,status:200,json:async()=>structuredClone(result),text:async()=>JSON.stringify(result)};
 };
 evaluate('closeMenus();$("#bmenuBtn").click()');
 await ready('!!$("#boards [data-new-project]")','project menu opens');
 evaluate('$("#boards [data-new-project]").click();$("#bpForm input[name=name]").value="短片";$("#bpForm input[name=attach]").checked=true;$("#bpForm button[type=submit]").click()');
 await ready('$("#projectCanvases strong")?.textContent==="短片"','current canvas moves into the new project');
 await evaluate('closeMenus();cmEdit(null,"document")');
 equal(evaluate('$("#memoryEditor select[name=board]").value'),'project:project-test','assets default to the current project');
 evaluate('$("#memoryEditor input[name=name]").value="城市设定";$("#memoryEditor button[type=submit]").click()');
 await ready('$(".cm-error").textContent.includes("已保存")','save a project-scope asset').catch(error=>{
  throw new Error(error.message+': '+evaluate('$(".cm-error").textContent'));
 });
 assert.equal(projectAssets[0].project,'project-test');
 assert.equal(projectAssets[0].board,'');
 evaluate('$("#projectCanvases [data-project-add]").click()');
 await ready('boardId!=="btest" && $$("#projectCanvases [data-project-board]").length===2','project quick toolbar creates a sibling canvas');
 assert.equal(evaluate('B.nodes.length'),0);
 await evaluate('alOpen()');
 equal(evaluate('[$("#alScope").value,$("#alScope option:checked").textContent]'),['current','当前资产库 · 短片']);
 equal(evaluate('$("#alGrid .al-card strong")?.textContent'),'城市设定','project asset is listed from the sibling canvas');
 evaluate('alClose()');
 const siblingAssets=await evaluate('cmList(true)');
 assert.equal(siblingAssets[0].id,'projectAsset','@ lookup uses the same cross-canvas assets');
 evaluate('$("#projectCanvases [data-project-board=btest]").click()');
 await ready('boardId==="btest" && !!node("n1")','project switch restores the original canvas nodes');
 assert.equal(w.location.search,'?board=btest');
 evaluate('closeMenus();$("#bmenuBtn").click()');
 await ready('!!$("#boards [data-dissolve-project]")','project operations are shown');
 evaluate('$("#boards [data-dissolve-project]").click();$("#bpForm [data-confirm]").click()');
 await ready('$("#projectCanvases").hidden && !!$("#boards [data-id=btest]")','dissolving retains the original board');
 assert.equal(projectBoards.size,2);
 evaluate('closeMenus();$("#assetLibraryBtn").click()');
 await ready('AL.open && $("#alLoading").hidden','the independent canvas opens its current library');
 equal(evaluate('[$("#alTitle").textContent,$("#alGrid .al-card strong")?.textContent ?? null]'),
  ['当前资产库 · '+evaluate('B.name'),null],'the canvas library excludes assets moved to the personal library after the project was dissolved');
 evaluate('$("#alScope").value="personal";$("#alScope").dispatchEvent(new Event("change"))');
 await ready('$("#alGrid .al-card strong")?.textContent==="城市设定" && $("#alLoading").hidden','migrated asset loads only from the personal library');
 assert.equal(evaluate('$("#alGrid .al-card strong")?.textContent'),'城市设定');
 evaluate('alClose()');
 const saveFetch=w.fetch, previousName=evaluate('B.name');
 w.fetch=(url,options={})=>url==='/api/board/btest'&&options.method==='PUT'
  ? Promise.resolve({ok:false,status:503,json:async()=>({error:'暂时无法保存'})})
  : saveFetch(url,options);
 await evaluate('B.name="等待保存的画布";save();flushSave()');
 equal(evaluate('[$("#boardSaveRetry").hidden,$("#boardSaveRetry").title,savePending.id]'),[false,'暂时无法保存','btest']);
 await evaluate('$("#boardSaveRetry").onclick()');
 assert.equal(evaluate('$("#boardSaveRetry").hidden'),false);
 w.fetch=saveFetch;
 await evaluate('$("#boardSaveRetry").onclick()');
 assert.equal(evaluate('$("#boardSaveRetry").hidden'),true);
 assert.equal(projectBoards.get('btest').name,'等待保存的画布');
 let rejectOlderSave;
 w.fetch=(url,options={})=>url==='/api/board/btest'&&options.method==='PUT'
  ? new Promise(resolve=>{ rejectOlderSave=()=>resolve({ok:false,status:503,json:async()=>({})}); })
  : saveFetch(url,options);
 const olderSave=evaluate('B.name="先保存这个名称";save();flushSave()');
 await Promise.resolve();
 assert.equal(typeof rejectOlderSave,'function');
 const latestSave=evaluate(`B.name=${JSON.stringify(previousName)};save();flushSave()`);
 w.fetch=saveFetch;
 rejectOlderSave();
 await Promise.all([olderSave,latestSave]);
 equal(evaluate('[$("#boardSaveRetry").hidden,savePending]'),[true,null]);
 assert.equal(projectBoards.get('btest').name,previousName);
 console.log('Canvas save retry passed: repeated HTTP failures stay visible and a successful retry persists the draft.');
 evaluate('closeMenus();ctxMenu({target:els.get("n1"),clientX:140,clientY:120});$("#ctxMenu [data-a=comment]").click()');
 equal(evaluate('CC.anchor.ref'),evaluate('curV(node("n1")).ref'),'node review targets the shown version');
 evaluate('$("#ccBody").value="<b>检查背景</b>";$("#ccSend").click()');
 await ready('!!$("#ccList [data-thread=comment1]")','node review appears in the comment panel');
 equal(evaluate('$("#ccList .cc-message p").textContent'),'<b>检查背景</b>','comments render as text');
 assert.equal(w.document.querySelector('#ccList .cc-message p b'),null);
 evaluate('$("#ccList [data-cc-reply]").click();$("#ccBody").value="已核对";$("#ccSend").click()');
 await ready('$("#ccList .cc-reply p")?.textContent==="已核对"','reply appears in the original thread');
 evaluate('const qaPoint=toW(150,160);ctxMenu({target:vp,clientX:150,clientY:160});$("#addMenu [data-comment-entry]").click();$("#ccBody").value="核对空白位置";$("#ccSend").click()');
 await ready('!!$("#commentPins [data-cc-pin=comment2]")','point comment has a marker');
 equal(commentThreads[0].anchor,JSON.parse(evaluate('JSON.stringify(qaPoint)')),'marker references a world position');
 evaluate('$("#ccClose").click();$("#commentPins [data-cc-pin=comment2]").click();$("#ccList [data-cc-toggle=comment2]").click()');
 await ready('!$("#commentPins [data-cc-pin=comment2]")','resolved marker is removed from the canvas');
 evaluate('$("#ccFilter").value="resolved";$("#ccFilter").dispatchEvent(new Event("change"));$("#ccList [data-cc-toggle=comment2]").click()');
 await ready('!!$("#commentPins [data-cc-pin=comment2]")','reopening restores the marker at the same position');
 evaluate('AC.session=null;AC.board=null');
 await evaluate('acOpen()');
 evaluate('$("#acInput").value="比较原素材";$("#ccFilter").value="all";$("#ccFilter").dispatchEvent(new Event("change"));$("#ccList [data-cc-agent=comment1]").click()');
 await ready('!!$(".ac-review-ref") && $("#canvasComments").hidden','comment is attached in the assistant composer');
 assert.equal(reviewPosts.length,0);
 equal(evaluate('$("#acInput").value'),'比较原素材','attach preserves an existing draft');
 equal(evaluate('acRefs().map(n=>n.id)'),['n1'],'assistant includes the commented node');
 evaluate('$("#acInput").dispatchEvent(new Event("input"));$("#acSend").click()');
 await ready('!!$("#acMessages .ac-sent-review")','sent review is visible in conversation history');
 assert.equal(reviewPosts[0].review_id,'comment1');
 assert.equal(reviewPosts[0].text,'比较原素材');
 assert.deepEqual([...w.document.querySelectorAll('.ac-sent-review p')].map(p=>p.textContent),['<b>检查背景</b>','已核对']);
 assert.equal(w.document.querySelector('.ac-sent-review p b'),null);
 await ready('!AC.sending','first comment message is settled');
 evaluate(`const timestampPreview=addNode("video",900,14800,{}, {name:"配音审阅",versions:[
    {ref:"output:h3studio/review-old.mp4",url:"/media?ref=output:h3studio/review-old.mp4",seconds:8},
    {ref:"output:h3studio/review-new.mp4",url:"/media?ref=output:h3studio/review-new.mp4",seconds:8}],cur:1});
   lightbox(timestampPreview.versions[0],timestampPreview);
   $("#light video").currentTime=1.25;
   $("[data-light-comment]").click();`);
 equal(evaluate('[timestampPreview.cur,CC.anchor.ref,CC.anchor.at,$("#ccTarget").textContent]'),[1,'output:h3studio/review-old.mp4',1.25,'配音审阅 · 1.25 秒']);
 evaluate('$("#ccBody").value="这里压低音乐";$("#ccSend").click()');
 await ready('!!$("#ccList [data-thread=comment3]")','timed comment is saved');
 evaluate('$("[data-cc-version=comment3]").click();$("#light video").dispatchEvent(new Event("loadedmetadata"))');
 equal(evaluate('[$("#light video").currentTime,$("#light video").autoplay,timestampPreview.cur]'),[1.25,false,1]);
 evaluate('$("[data-light-range]").click();$("#light video").currentTime=.75;$("[data-light-range]").click()');
 assert.match(evaluate('$(".light-status").textContent'),/终点必须晚于起点/);
 evaluate(`$("[data-light-cancel-range]").click();$("#light video").currentTime=2;
   $("[data-light-range]").click();$("#light video").currentTime=6;$("[data-light-range]").click()`);
 equal(evaluate('[CC.anchor.at,CC.anchor.end,CC.anchor.ref,$("#ccTarget").textContent]'),[2,6,'output:h3studio/review-old.mp4','配音审阅 · 2.00–6.00 秒']);
 evaluate('$("#ccBody").value="这个片段保留旁白";$("#ccSend").click()');
 await ready('!!$("#ccList [data-thread=comment4]")','a range comment is saved');
 assert.equal(evaluate('$("[data-cc-version=comment4]").textContent'),'查看批注片段');
 evaluate(`$("[data-cc-version=comment4]").click();const reviewRangePlayer=$("#light video");
   let rangePaused=0;reviewRangePlayer.play=async()=>{};reviewRangePlayer.pause=()=>{rangePaused++;};
   reviewRangePlayer.dispatchEvent(new Event("loadedmetadata"));
   $("[data-light-play-review]").click()`);
 assert.equal(evaluate('reviewRangePlayer.currentTime'),2);
 evaluate('reviewRangePlayer.currentTime=6.1;reviewRangePlayer.dispatchEvent(new Event("timeupdate"))');
 equal(evaluate('[reviewRangePlayer.currentTime,rangePaused,timestampPreview.cur]'),[6,1,1]);
 evaluate('closeLightbox();$("#commentBtn").click();$("[data-cc-select=comment1]").click();$("[data-cc-select=comment4]").click();$("[data-cc-batch-send]").click()');
 await ready('AC.reviews.length===2 && $("#canvasComments").hidden','two selected notes are attached together');
 equal(evaluate('[AC.reviews.map(r=>r.id),$("#acSend").disabled,$("#acInput").value]'),[['comment1','comment4'],false,'']);
 evaluate('$("[data-remove-review=comment1]").click()');
 equal(evaluate('AC.reviews.map(r=>r.id)'),['comment4']);
 evaluate('$("#commentBtn").click();$("[data-cc-agent=comment1]").click()');
 await ready('AC.reviews.length===2 && $("#canvasComments").hidden','an added comment leaves the existing one attached');
 evaluate('$("#acSend").click()');
 await ready('$$("#acMessages .ac-sent-review").length===3','both comments replay in message history');
 equal(reviewPosts[1].review_ids,['comment4','comment1']);
 equal(reviewPosts[1].selected,[evaluate('timestampPreview.id'),'n1']);
 assert.match(reviewPosts[1].text,/汇总.*修改建议/);
 assert.match(evaluate('$$("#acMessages .ac-sent-review")[1].textContent'),/2\.00–6\.00 秒.*保留旁白/);
 await ready('!AC.sending','the range review send is complete');
 evaluate(`const regionPreview=addNode("image",950,15100,{}, {name:"海报批注",versions:[
    {ref:"output:h3studio/review-image-old.png",url:"/media?ref=output:h3studio/review-image-old.png"},
    {ref:"output:h3studio/review-image-new.png",url:"/media?ref=output:h3studio/review-image-new.png"}],cur:1});
   lightbox(regionPreview.versions[0],regionPreview);
   const reviewImageRect=()=>({left:100,top:150,width:400,height:400});
   $("#light img").getBoundingClientRect=reviewImageRect;
   const markImagePointer=(type,x,y)=>$("#light img").dispatchEvent(new MouseEvent(type,{button:0,clientX:x,clientY:y,bubbles:true,cancelable:true}));
   $("[data-light-mark-region]").click();markImagePointer("pointerdown",200,275);
   markImagePointer("pointermove",400,425);markImagePointer("pointerup",400,425);`);
 equal(evaluate('[$(".light-review-region").style.left,$(".light-review-region").style.top,$("[data-light-save-region]").disabled]'),
  ['200px','275px',false]);
 evaluate('$("[data-light-save-region]").click()');
 equal(evaluate('[CC.anchor.box,CC.anchor.ref,regionPreview.cur]'),[[.25,.25,.75,.75],'output:h3studio/review-image-old.png',1]);
 evaluate('$("#ccBody").value="仅改这一块背景";$("#ccSend").click()');
 await ready('!!$("[data-cc-version=comment5]")','regional comment is saved');
 assert.equal(evaluate('$("[data-cc-version=comment5]").textContent'),'查看标记区域');
 evaluate('$("[data-cc-version=comment5]").click();$("#light img").getBoundingClientRect=reviewImageRect;$("#light img").dispatchEvent(new Event("load"))');
 equal(evaluate('[$(".light-review-region").hidden,$(".light-review-region").style.width,regionPreview.cur]'),[false,'200px',1]);
 evaluate(`closeLightbox();
   const passageDoc=addNode("text",1000,15500,{text:"🎬 标题\\n这是要改的原文\\n保留后文",text_format:"markdown"},{name:"分镜说明"});
   openTextDocument(passageDoc);
   const noteTextArea=$("#textDocument textarea"), quotedPassage="这是要改的原文";
   const passageStart=noteTextArea.value.indexOf(quotedPassage);
   noteTextArea.setSelectionRange(passageStart,passageStart+quotedPassage.length);
   noteTextArea.dispatchEvent(new Event("select"));
   $("[data-document-annotate]").click();`);
 equal(evaluate('[CC.anchor.passage,$("#ccQuote").textContent,$("#textDocument").open]'),
  [{start:5,end:12,quote:'这是要改的原文'},'这是要改的原文',false]);
 evaluate('$("#ccBody").value="改成口语";$("#ccSend").click()');
 await ready('!!$("[data-cc-passage=comment6]")','text range comment is saved');
 evaluate('$("[data-cc-passage=comment6]").click()');
 await ready('$("#textDocument").open','a text comment opens the original passage');
 equal(evaluate('[noteTextArea.value.slice(noteTextArea.selectionStart,noteTextArea.selectionEnd),document.activeElement===noteTextArea]'),
  ['这是要改的原文',true]);
 evaluate('closeTextDocument();$("#ccClose").click()');
 evaluate('$("#acClose").click();$("#shareBtn").click()');
 await ready('!$("#canvasShare").hidden && !$("#shareManage").disabled','owner can manage board sharing');
 equal(evaluate('$("#shareURL").value'),'http://oneshot.test/?board=btest','sharing copies a direct board link');
 evaluate('$("#shareUser").value="reviewer";$("#shareDirectInvite button").click()');
 await ready('$("#sharePeople").textContent.includes("审阅同事")','sharing displays an invited account');
 assert.deepEqual(shareRequests[0],{username:'reviewer',role:'reviewer'});
 evaluate('$("#publicPublish").click()');
 await ready('!$("#publicLink").hidden && $("#publicPublish").hidden','publishing shows the public link');
 assert.equal(evaluate('$("#publicURL").value'),'http://oneshot.test/share/'+publicToken);
 evaluate('$("#publicRevoke").click()');
 await ready('$("#publicLink").hidden && !$("#publicPublish").hidden','revoking removes the public link');
 const ownBoard=projectBoards.get('btest');
 projectBoards.set('review-board',{...ownBoard,owner:42,access:'reviewer'});
 await evaluate('openBoard("review-board")');
 assert(w.document.body.classList.contains('review-only'));
 assert.equal(w.document.querySelector('#boardAccessBadge').hidden,false);
 evaluate('selectOnly("n1");document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"Delete",bubbles:true}));save()');
 equal(evaluate('!!node("n1") && !savePending'),true,'reviewer editing commands never queue a save');
 evaluate('$("#shareBtn").click()');
 assert.equal(w.document.querySelector('#shareManage').hidden,true);
 assert.equal(w.document.querySelector('#sharePublic').hidden,true);
 console.log('Share DOM passed: direct link, account invitation, permissions panel and reviewer read-only mode.');
 const publishedDOM=new JSDOM(fs.readFileSync(path.join(root,'static/public-canvas.html'),'utf8'),{
  url:'http://oneshot.test/share/'+publicToken,runScripts:'outside-only',
 });
 try {
  const published=publishedDOM.window;
  published.HTMLCanvasElement.prototype.getContext=()=>null;
  published.fetch=async url=>({ok:!url.endsWith('/copy'),status:url.endsWith('/copy')?404:200,json:async()=>({
   name:'公开画布',created:1,edges:[],nodes:[{id:'t',type:'text',name:'资料',x:4,y:6,text:'<script>可见文本</script>'},
    {id:'a',type:'image',name:'预览',x:330,y:6,w:20,h:10,media:0},
    {id:'d',type:'text',name:'剧本',x:4,y:240,text_format:'markdown',text_background:'lilac',text:'# 公开剧本\n\n- 镜头一\n\n![不加载](https://example.invalid/image.png)\n\n<a href="javascript:alert(1)">链接</a>'}],
  })});
  for(const script of published.document.querySelectorAll('script'))
   vm.runInContext(fs.readFileSync(staticFile(script.src),'utf8'),publishedDOM.getInternalVMContext());
  for(let i=0;i<30&&published.document.getElementById('copyBoard').disabled;i++)await pause(10);
  assert.equal(published.document.querySelector('.node-content').textContent,'<script>可见文本</script>');
  assert.equal(published.document.querySelector('.snapshot-node script'),null);
  assert.equal(published.document.querySelector('.snapshot-node img').getAttribute('src'),'/api/share/'+publicToken+'/media/0');
  const sharedDocument=published.document.querySelector('.node-content.ac-markdown');
  assert.equal(sharedDocument.closest('.snapshot-node').dataset.documentBackground,'lilac');
  assert.equal(sharedDocument.querySelector('h1').textContent,'公开剧本');
  assert.equal(sharedDocument.querySelector('li').textContent,'镜头一');
  assert.equal(sharedDocument.querySelector('img'),null);
  assert.equal(sharedDocument.querySelector('a').hasAttribute('href'),false);
  published.document.getElementById('copyBoard').click();
  await pause(25);
  assert.equal(published.document.getElementById('shareFeedback').textContent,'此分享已撤销');
 } finally { publishedDOM.window.close(); }
 console.log('Public snapshot DOM passed: publish and revoke, anonymous rendering, scoped media URL and copy feedback.');
 await evaluate('openBoard("btest")');
 evaluate(`const publicPromptVideo={id:"showcase-prompt-clip",type:"video",name:"公开示例",cur:0,
  data:{prompt:"未发布的最新稿"},versions:[
    {ref:"output:h3studio/publish-take1.mp4",prompt:"最初提示",generation_record:{prompt:"选中版本提示",effective_prompt:"私有扩充提示"}},
    {ref:"output:h3studio/publish-take2.mp4",prompt:"第二版提示"}]};
  B.nodes.push(publicPromptVideo);
  const showcasePanel=$("#shareShowcase"), previousShowcaseDisabled=showcasePanel.disabled;
  showcasePanel.disabled=false;setupShowcaseForm();
  const showcaseSelect=$("#shareShowcaseVideo"),showcasePromptOpt=$("#shareShowcaseAttachPrompt"),
    showcaseText=$("#shareShowcasePrompt");
  const promptVideoOptions=showcaseChoices("video").filter(option=>option.node===publicPromptVideo.id);
  const selectPromptVersion=ref=>{
    showcaseSelect.value=String(showcaseChoices("video").findIndex(option=>option.ref===ref));
    showcaseSelect.dispatchEvent(new Event("change"));
  };
  selectPromptVersion(promptVideoOptions[0].ref);
  const savedShowcaseChange=changeShowcase, promptSubmission=[];
  changeShowcase=(...args)=>promptSubmission.push(args);
  const submitShowcase=()=>$("#shareShowcaseForm").dispatchEvent(new Event("submit",{cancelable:true}));
  submitShowcase();showcasePromptOpt.click();`);
 equal(evaluate('[promptSubmission[0][2].public_prompt,showcaseText.value,showcaseText.required]'),
   [null,'选中版本提示',true],'publishing prompt text requires an explicit opt-in and uses the chosen version');
 evaluate(`showcaseText.value="核对后的提示";submitShowcase();selectPromptVersion(promptVideoOptions[1].ref);`);
 equal(evaluate('[promptSubmission[1][2].public_prompt,showcasePromptOpt.checked,showcaseText.value,showcaseText.required]'),
   ['核对后的提示',false,'',false],'changing video versions clears the previous publication confirmation');
 evaluate('changeShowcase=savedShowcaseChange;B.nodes.pop();showcasePanel.disabled=previousShowcaseDisabled;$("#shareShowcaseForm").hidden=true');
 const watchDOM=new JSDOM(fs.readFileSync(path.join(root,'static/showcase.html'),'utf8'),{
   url:'http://oneshot.test/showcase/'+publicToken,runScripts:'outside-only',
 });
 try {
  const watch=watchDOM.window, publicPrompt='<img src=x onerror=alert(1)>\n照常保留第二行';
  const reuseCalls=[], clipboard=[];
  Object.defineProperty(watch.navigator,'clipboard',{value:{writeText:async value=>clipboard.push(value)}});
  watch.fetch=async(url,options)=>{
   if (url.endsWith('/use-prompt')) {
    reuseCalls.push(JSON.parse(options.body));
    return {ok:false,status:401,json:async()=>({error:"请先登录"})};
   }
   return {ok:true,json:async()=>url.endsWith('/auth/state')?{user:null}:
     {token:publicToken,title:"公开动图",author:"创作者",creator:"visitor",prompt:publicPrompt,media_kind:"gif"}};
  };
  vm.runInContext(fs.readFileSync(path.join(root,'static/showcase.js'),'utf8'),watchDOM.getInternalVMContext());
  for(let i=0;i<30&&!watch.document.querySelector('.showcase-prompt');i++) await pause(10);
  const card=watch.document.querySelector('.showcase-prompt');
  assert.equal(watch.document.querySelector('.showcase-watch > img').getAttribute('src'),'/api/showcase/'+publicToken+'/gif');
  assert.equal(watch.document.querySelector('.showcase-watch a[download]').download,'公开动图.gif');
  assert.equal(watch.document.querySelector('.showcase-watch video'),null);
  assert.equal(card.querySelector('textarea').value,publicPrompt);
  assert.equal(card.querySelector('img'),null);
  const [copy,reuse]=card.querySelectorAll('button');
  await copy.onclick();
  equal(clipboard,[publicPrompt]);
  await reuse.onclick();await reuse.onclick();
  assert.equal(reuseCalls.length,2);
  assert.equal(reuseCalls[0].request_key,reuseCalls[1].request_key);
  assert.match(card.querySelector('[role=status] a').href,/login\?next=/);
 } finally { watchDOM.window.close(); }
 console.log('Showcase prompt DOM passed: opt-in, exact version, edited text, public copy and login-required reuse.');
 evaluate(`const qaFrom=addNode("image",100,200),qaTo=addNode("video",500,200,{prompt:"沿河移动"});
  qaFrom.versions=[{...curV(node("n1"))}];qaFrom.cur=0;
  qaTo.versions=[{ref:"output:h3studio/trace.mp4",w:640,h:360,generation_record:{inputs:[{node_id:qaFrom.id,ref:curV(qaFrom).ref,version:1}]}}];qaTo.cur=0;
  B.edges.push({from:qaFrom.id,to:qaTo.id,role:"first"});
  sel=new Set([qaFrom.id,qaTo.id]);updateSel();ctGroup();
  ctxMenu({target:els.get(qaFrom.id),clientX:150,clientY:150});$("#ctxMenu [data-a=template]").click();`);
 await ready('!$("#workflowTemplates").hidden && $("#templateScope").value==="selection" && !$("#templateStatus").textContent','right-click opens a selection template');
 evaluate('$("#templateScope").value="upstream";$("#templateName").value="可复用镜头";$("#templateSave").click()');
 await ready('$("#templateRows strong")?.textContent==="可复用镜头"','selection is saved as a private template');
 assert.equal(workflow.row.nodes,2);
 assert.equal(workflow.includeUpstream,true);
 evaluate('$("#templateRows [data-template-action=preview]").click()');
 await ready('!!$("#templatePreview [data-template-action=confirm]")','private preview opens before sharing');
 assert.equal(evaluate('$("#templatePreview .template-preview-nodes p").textContent'),'沿河移动');
 assert.equal(evaluate('$("#templatePreview video").getAttribute("src")'),'/api/canvas-templates/qa-template/preview/media/1');
 assert.match(evaluate('$("#templatePreview .template-preview-edges summary").textContent'),/首帧 · 版本 1/);
 assert.equal(evaluate('$("#templatePreview .template-preview-edges img").getAttribute("src")'),'/api/canvas-templates/qa-template/preview/media/2');
 evaluate('$("#templatePreview [data-template-action=confirm]").click()');
 assert.equal(evaluate('$("#templatePublishConfirm").hidden'),false);
 assert.equal(workflow.row.published,undefined);
 evaluate('$("#templatePublishConfirm [data-template-action=publish]").click()');
 await ready('$("#templateStatus").textContent==="已加入共享模板库"','explicit sharing adds a saved template to the catalog');
 evaluate('$("#templateRows [data-template-action=replace]").click()');
 equal(evaluate('[$("#templateReplaceShared").hidden,$("#templateForm").checkValidity()]'),[false,false],
  'replacing a shared template requires acknowledging that existing links use the update');
 evaluate('$("#templateReplaceShared input").checked=true;$("#templateSave").click()');
 await ready('$("#templateStatus").textContent==="原模板内容已更新"','the template is updated in place');
 equal(workflow.replacePayload.selected,[evaluate('qaFrom.id'),evaluate('qaTo.id')],'the update uses the selected source nodes');
 assert.equal(workflow.replacePayload.template_updated,1);
 assert.equal(workflow.replacePayload.confirmed_shared,true);
 evaluate('$("#templateRows [data-template-action=history]").click()');
 await ready('!!$(".template-history details")','the author can open template history');
 await evaluate('const oldTemplateDetails=$(".template-history details");oldTemplateDetails.open=true;oldTemplateDetails.ontoggle()');
 assert.match(evaluate('$("[data-version-preview]",oldTemplateDetails).textContent'),/前一版提示词/);
 assert.equal(evaluate('$("form",oldTemplateDetails).checkValidity()'),false);
 evaluate('$("[name=confirm]",oldTemplateDetails).checked=true;$("form button",oldTemplateDetails).click()');
 await ready('$("#templateStatus").textContent==="已还原模板版本"','restoring a shared template uses its current revision and explicit confirmation');
 equal(workflow.restorePayload,{template_updated:2,confirmed_shared:true});
 evaluate('$("#templateScopes [data-scope=catalog]").click()');
 await ready('$("#templateRows article span")?.textContent.includes("创作者")','catalog lists the creator');
 evaluate('$("#templateSearch").value="无匹配";$("#templateSearch").dispatchEvent(new Event("input"))');
 assert.equal(evaluate('$("#templateRows").textContent.includes("没有匹配的模板")'),true);
 evaluate('$("#templateSearch").value="创作者";$("#templateSearch").dispatchEvent(new Event("input"));$("#templateRows [data-template-action=preview]").click()');
 await ready('!!$("#templatePreview [data-template-action=insert]")','matching shared template can be inserted after preview');
 evaluate('$("#templatePreview [data-template-action=favorite]").click()');
 await ready('$("#templatePreview [data-template-action=favorite]")?.getAttribute("aria-pressed")==="true"','template can be favorited from preview');
 evaluate('$("#templateScopes [data-scope=favorites]").click()');
 await ready('$("#templateRows strong")?.textContent==="可复用镜头"','favorites list includes the saved shared template');
 evaluate('$("#templateRows [data-template-action=favorite]").click()');
 await ready('$("#templateRows").textContent.includes("还没有收藏模板")','unfavoriting removes the item from the favorites list');
 evaluate('$("#templateScopes [data-scope=catalog]").click()');
 await ready('!!$("#templateRows [data-template-action=favorite]")','return to the shared template listing');
 evaluate('$("#templateRows [data-template-action=favorite]").click()');
 await ready('$("#templateStatus").textContent==="已收藏模板"','template can also be favorited directly');
 evaluate(`closeWorkflowTemplates();
  const beforeSearchBoard=AC.board;AC.board=boardId;
  acAppendEvent({kind:"tool_start",data:{name:"workflow_template_search",call_id:"template-lookup"}});
  acAppendEvent({kind:"tool_end",data:{name:"workflow_template_search",call_id:"template-lookup",result:{
    workflow_templates:[{id:"qa-template",name:"可复用镜头",scope:"favorites",nodes:2,description:"<雨夜说明>"}]}}});
  const lookup=$('[data-call="template-lookup"] [data-open-workflow-template]');`);
 assert.equal(evaluate('lookup.closest("article").querySelector("p").textContent'),'<雨夜说明>');
 await evaluate('$("#acMessages").onclick({target:lookup})');
 assert.equal(evaluate('$("#templatePreview strong").textContent'),'可复用镜头');
 evaluate(`const fillDraft={id:"qa-template",name:"可复用镜头",scope:"favorites",board:boardId,
   inputs:[{node:qaTo.id,field:"prompt",before:"沿河移动",value:"雨夜沿河推近"}]};
  const appendFill=(id,plan)=>{
   acAppendEvent({kind:"tool_start",data:{name:"workflow_template_plan",call_id:id}});
   acAppendEvent({kind:"tool_end",data:{name:"workflow_template_plan",call_id:id,result:{template_fill_plan:plan}}});
   return $("[data-template-fill-plan]",AC.calls.get(id));
  };
  const outdatedFill=appendFill("stale-template-draft",{...fillDraft,inputs:[{...fillDraft.inputs[0],before:"旧内容"}]});
  const proposedFill=appendFill("template-draft",fillDraft);`);
 await evaluate('$("#acMessages").onclick({target:outdatedFill})');
 assert.match(evaluate('$("#templateStatus").textContent'),/原草稿未填入/);
 await evaluate('$("#acMessages").onclick({target:proposedFill})');
 equal(evaluate(`[ $("#templatePreview .template-inputs").open,
   $$("#templatePreview [data-template-input]").find(input=>input.dataset.templateInput===qaTo.id).value]`),
   [true,'雨夜沿河推近'],'a matching assistant draft opens with editable values prefilled');
 evaluate('AC.board=beforeSearchBoard');
 await ready('!!$("#templateRows [data-template-action=insert]")','favorites can be reused without opening a preview');
 const beforeInsert=evaluate('B.nodes.length');
 evaluate(`const templateEditedPrompt=$$('#templatePreview [data-template-input]').find(input=>input.dataset.templateInput===qaTo.id);
  templateEditedPrompt.value='夜晚沿河移动';
  $('#templatePreview [data-template-action=insert-run]').click();`);
 await ready(`$("#workflowTemplates").hidden && B.nodes.length===${beforeInsert+2}`,'inserting a template creates new nodes');
 equal(evaluate('B.edges.filter(e=>sel.has(e.from)&&sel.has(e.to)).map(e=>e.role)'),['first'],'template edges remap to the inserted nodes');
 equal(evaluate('[...sel].map(node).find(n=>n.type==="video").data.prompt'),'夜晚沿河移动','configured prompt reaches the copied node');
 assert.equal(workflow.copyInputs.length,1);
 assert.equal(workflow.fragment.nodes.find(n=>n.type==='video').data.prompt,'沿河移动','the original saved template keeps its prompt');
 equal(evaluate('sel.has([...sel].map(node).find(n=>n.type==="video").versions[0].generation_record.inputs[0].node_id)'),true,'template remaps the receipts to the copied inputs');
 equal(evaluate('B.groups.some(g=>g.nodes.length===2&&g.nodes.every(id=>sel.has(id)))'),true,'template group remaps to the inserted nodes');
 equal(evaluate(`[$("#groupRunConfirm").open,$("#groupRunConfirm [name=mode]").value,
   $$("#groupRunConfirm li strong").map(item=>item.textContent),B.nodes.some(n=>sel.has(n.id)&&n.job)]`),
   [true,"affected",[evaluate('node([...sel].find(id=>node(id).type==="video")).name')],false],
   'template plan defaults to changed copied nodes and waits for generation approval');
 evaluate('const templateRunMode=$("#groupRunConfirm [name=mode]");templateRunMode.value="all";templateRunMode.dispatchEvent(new Event("change"))');
 equal(evaluate('$$("#groupRunConfirm li strong").map(item=>item.textContent).sort()'),
   [...evaluate('[...sel].map(id=>node(id).name).sort()')],'the all-mode plan cannot pull in original canvas nodes');
 evaluate('closeCanvasGroupRunDialog()');
 evaluate('undo()');
 assert.equal(evaluate('B.nodes.length'),beforeInsert);
 evaluate('openAddMenu(160,120,{at:{x:120,y:100}});$("#addMenu [data-add=previs]").click()');
 assert.equal(evaluate('$("#previsEditor").open'),true);
 const previsMotionFetch=w.fetch, motionRequests=[], routeRequests=[];
 w.fetch=async(url,opts)=>{
  if(String(url)==='/api/previs/object-motion'){
   const request=JSON.parse(opts.body);routeRequests.push(request);
   const [first,last]=request.scene.objects[0].keys;
   return {ok:true,text:async()=>JSON.stringify({keys:[
    first,{...first,t:16,...request.plan.points[0]},
    {...first,t:48,...request.plan.points[1]},last]})};
  }
  if(String(url)!=='/api/previs/camera-motion')return previsMotionFetch(url,opts);
  const request=JSON.parse(opts.body);motionRequests.push(request);
  const start=request.scene.camera[0];
  return {ok:true,text:async()=>JSON.stringify({camera:[start,{...start,t:request.plan.end,x:4,z:6,ease:"smooth"}]})};
 };
 evaluate(`$("[data-pv-motion]").open=true;
  const motionEnd=$("[data-pv-motion-end]");motionEnd.value="2";motionEnd.dispatchEvent(new Event("input"));
  $("[data-pv-motion-apply]").click();`);
 await ready('PV.editor.scene.camera.length===2','the camera motion preset adds editable keyframes');
 equal(motionRequests.map(request=>request.plan),[{mode:'push',start:0,end:48,amount:1,target:'actor'}],
  'camera motion uses the playhead, end time and selected amount');
 assert.match(evaluate('$("[data-pv-status]").textContent'),/已应用推进/);
 equal(evaluate('PV.editor.scene.camera.map(k=>k.t)'),[0,48]);
 evaluate('$("[data-pv-motion-undo]").click()');
 equal(evaluate('PV.editor.scene.camera.map(k=>k.t)'),[0]);
 evaluate(`const routeTrack=$("[data-pv-track]"), routeView=$("[data-pv-view]");
  routeTrack.value="actor";routeTrack.dispatchEvent(new Event("change"));
  $("[data-pv-route-start]").click();
  const routeEnd=$("[data-pv-route-end]");routeEnd.value="2";routeEnd.dispatchEvent(new Event("input"));
  const routeCanvas=$("#previsEditor canvas");
  const routeClick=(x,z)=>{
    const E=PV.editor, box=routeCanvas.getBoundingClientRect();
    const [px,py]=pvPlan(E.scene,E.tick,routeCanvas.width,routeCanvas.height,E.active).point(x,z);
    routeCanvas.onpointerdown({button:0,pointerId:10,clientX:box.left+px*box.width/routeCanvas.width,
      clientY:box.top+py*box.height/routeCanvas.height});
  };
  routeClick(0,1);routeClick(1,1);$("[data-pv-route-pop]").click();routeClick(3,1);
  $("[data-pv-route-apply]").click();`);
 await ready('PV.editor.scene.objects[0].keys.length===4','clicking a route writes editable object keyframes');
 equal(routeRequests.map(request=>request.plan),[{target:'actor',start:0,end:48,points:[{x:0,z:1},{x:3,z:1}]}]);
 equal(evaluate('PV.editor.scene.objects[0].keys.map(k=>[k.t,k.x,k.z])'),
   [[0,-1.7,0],[16,0,1],[48,3,1],[96,1.5,0]]);
 evaluate(`$("[data-pv-route-undo]").click();routeTrack.value="camera";routeTrack.dispatchEvent(new Event("change"));
  routeView.value="camera";routeView.dispatchEvent(new Event("change"));`);
 equal(evaluate('PV.editor.scene.objects[0].keys.map(k=>k.t)'),[0,96]);
 w.fetch=previsMotionFetch;
 evaluate(`const cameraBeforeCut=structuredClone(PV.editor.scene.camera), cutScrub=$("[data-pv-scrub]");
  cutScrub.value=24;cutScrub.dispatchEvent(new Event("input"));
  const cutX=$("[data-owner=camera][data-pv-param=x]");cutX.value=2;cutX.dispatchEvent(new Event("change"));
  cutScrub.value=48;cutScrub.dispatchEvent(new Event("input"));
  $("[data-pv-cut-source]").value="0";$("[data-pv-add-cut]").click();
  const cutFov=$("[data-owner=camera][data-pv-param=fov]");cutFov.value=24;cutFov.dispatchEvent(new Event("change"));`);
 equal(evaluate(`[pvSample(PV.editor.scene.camera,47).x,pvSample(PV.editor.scene.camera,48).x,
  pvSample(PV.editor.scene.camera,47).fov,pvSample(PV.editor.scene.camera,48).fov,
  $("[data-pv-at='48']").textContent]`),[2,5,42,24,"2.00 秒 · 硬切"],"the camera holds the old framing up to the cut");
 w.TextEncoder=TextEncoder;
 const cutBlob=evaluate('pvGlb(PV.editor.scene,48,"切镜验证")');
 const cutBinary=Buffer.from(await new Promise((resolve,reject)=>{
  const reader=new w.FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);
  reader.readAsArrayBuffer(cutBlob);
 }));
 const cutJsonLength=cutBinary.readUInt32LE(12);
 const cutGlb=JSON.parse(cutBinary.toString("utf8",20,20+cutJsonLength));
 const cameraAnimation=cutGlb.animations[0];
 const cameraTrack=cameraAnimation.channels.find(channel=>channel.target.node===0&&channel.target.path==="translation");
 const cameraSampler=cameraAnimation.samplers[cameraTrack.sampler];
 const cameraAccessor=cutGlb.accessors[cameraSampler.output], cameraBuffer=cutGlb.bufferViews[cameraAccessor.bufferView];
 const offsets=28+cutJsonLength+(cameraBuffer.byteOffset||0)+(cameraAccessor.byteOffset||0);
 equal([cameraSampler.interpolation,cutBinary.readFloatLE(offsets+47*12),cutBinary.readFloatLE(offsets+48*12)],
  ['STEP',2,5],'GLB camera animation uses the same cutoff at 24 FPS');
 const objectTrack=cameraAnimation.channels.find(channel=>channel.target.node===1&&channel.target.path==="translation");
 const fovTrack=cameraAnimation.channels.find(channel=>channel.target.path==="pointer");
 equal([cameraAnimation.samplers[objectTrack.sampler].interpolation,cameraAnimation.samplers[fovTrack.sampler].interpolation],
  ['LINEAR','STEP'],'glTF export keeps object motion smooth and applies the cut to focal length too');
 evaluate('PV.editor.scene.camera=cameraBeforeCut;PV.editor.tick=0;pvRefreshTrack(PV.editor)');
 evaluate(`const previsNode=PV.editor.n;const pvScrub=$("[data-pv-scrub]");pvScrub.value=48;pvScrub.dispatchEvent(new Event("input"));
  const pvHeight=$("[data-owner=camera][data-pv-param=y]");pvHeight.value="5";pvHeight.dispatchEvent(new Event("change"));
  const pvAspect=$("[data-pv-aspect]");pvAspect.value="9:16";pvAspect.dispatchEvent(new Event("change"));
  $("[data-pv-render]").click();`);
 await ready('previsNode.versions.length===1','previs job appends a version to the scene node',300);
 assert.equal(w.__previsRequests[0].node,evaluate('previsNode.id'));
 equal(evaluate('previsNode.versions[0].previs_recipe.camera.map(x=>[x.t,x.y])'),[[0,3.2],[48,5]],'scene snapshot stores the camera keyframes');
 equal(evaluate('[$("#previsEditor canvas").width,$("#previsEditor canvas").height]'),[405,720],'portrait preview preserves framing');
 evaluate(`const pvPlanSelect=$("[data-pv-view]");pvPlanSelect.value="plan";pvPlanSelect.dispatchEvent(new Event("change"));
   const pvEncode=HTMLCanvasElement.prototype.toBlob;
   let pvFrameDimensions;
   HTMLCanvasElement.prototype.toBlob=function(callback,mime){pvFrameDimensions=[this.width,this.height,this!==$("#previsEditor canvas"),mime];pvEncode.call(this,callback,mime);};
   $("[data-pv-frame-canvas]").click();`);
 await ready('!PV.editor.sending && [...sel].some(id=>curV(node(id))?.source==="previs-frame")','previs frame creates a selected image node');
 equal(evaluate('[pvFrameDimensions,curV(node([...sel][0])).w,curV(node([...sel][0])).h,PV.editor.tick,previsNode.versions.length]'),
  [[405,720,true,'image/png'],405,720,48,1],'export uses the shot framing and keeps the original timeline and video');
 evaluate('HTMLCanvasElement.prototype.toBlob=pvEncode');
 evaluate(`const pvFreeBefore=structuredClone(PV.editor.scene.camera), pvFreeCanvas=$("#previsEditor canvas");
  const setPvView=value=>{pvPlanSelect.value=value;pvPlanSelect.dispatchEvent(new Event("change"));};
  setPvView("free");
  const freeStart=structuredClone(PV.editor.freeView);
  const freeKey=key=>pvFreeCanvas.dispatchEvent(new KeyboardEvent("keydown",{key,bubbles:true,cancelable:true}));
  const freeDrag=(handler,x,y)=>pvFreeCanvas[handler]({button:0,pointerId:17,clientX:x,clientY:y});
  freeKey("w");freeKey("e");
  freeDrag("onpointerdown",80,90);freeDrag("onpointermove",120,105);freeDrag("onpointerup",120,105);
  const freeShot=structuredClone(PV.editor.freeView);
  const paintBeforeFree=pvPaint;
  let freeCapturePose;
  pvPaint=(canvas,scene,tick,...rest)=>{
    if(canvas!==pvFreeCanvas)freeCapturePose=pvSample(scene.camera,tick);
    paintBeforeFree(canvas,scene,tick,...rest);
  };
  $("[data-pv-free-capture]").click();`);
 assert.equal(evaluate('freeShot.y===freeStart.y+.25 && freeShot.x!==freeStart.x && freeShot.tx!==freeStart.tx && !PV.editor.look'),true);
 await ready('!PV.editor.sending && curV(node([...sel][0]))?.mode==="白模自由视图"','free view saves a separate camera still');
 equal(evaluate(`[JSON.stringify(freeCapturePose)===JSON.stringify(freeShot),
   JSON.stringify(PV.editor.scene.camera)===JSON.stringify(pvFreeBefore),
   JSON.stringify(previsNode.data.previs.camera)===JSON.stringify(pvFreeBefore),PV.editor.tick]`),
  [true,true,true,48],'free view capture does not change authored camera keys or move the playhead');
 evaluate(`pvPaint=paintBeforeFree;
  $("[data-pv-free-reset]").click();
  const freeWasReset=JSON.stringify(PV.editor.freeView)===JSON.stringify(freeStart);
  freeKey("d");freeKey("ArrowLeft");
  const adoptedX=PV.editor.freeView.x,adoptedTarget=PV.editor.freeView.tz;
  $("[data-pv-free-adopt]").click();`);
 equal(evaluate(`[freeWasReset,PV.editor.view,$("[data-pv-free-controls]").hidden,
  PV.editor.scene.camera.find(k=>k.t===48).x===adoptedX,PV.editor.scene.camera.find(k=>k.t===48).tz===adoptedTarget,
  PV.editor.scene.camera[0].x===pvFreeBefore[0].x]`),
  [true,"camera",true,true,true,true],'only explicit adoption writes the free pose into the current camera key');
 evaluate('PV.editor.scene.camera=pvFreeBefore;pvRefreshTrack(PV.editor)');
 evaluate(`const lightPreset=$("[data-pv-light-preset]");
  const chooseLight=value=>{lightPreset.value=value;lightPreset.dispatchEvent(new Event("change"));};
  chooseLight("back");
  const updatePvLight=(field,value)=>{
    const input=$('[data-pv-light-value="'+field+'"]');
    input.value=String(value);input.dispatchEvent(new Event("change"));
  };
  updatePvLight("azimuth",0);updatePvLight("elevation",0);updatePvLight("key",.6);updatePvLight("ambient",.2);
  const expectedPrevisLight={azimuth:0,elevation:0,key:.6,ambient:.2,tone:"warm"};
  const lightProof={duration:2,aspect:"1:1",lighting:expectedPrevisLight,
    camera:[{t:0,x:0,y:1,z:5,tx:0,ty:1,tz:0,fov:42,ease:"linear"}],
    objects:[{id:"box",label:"方块",shape:"box",width:2,height:2,depth:1,
      keys:[{t:0,x:0,y:0,z:0,yaw:0,ease:"linear"}]}]};
  const lightColors=[], polygonBeforeLight=pvPolygon;
  pvPolygon=(_ctx,_points,color)=>lightColors.push(color);
  pvPaint(pvFreeCanvas,lightProof,0);pvPolygon=polygonBeforeLight;`);
 equal(evaluate('[lightPreset.value,$("[data-pv-light-fields]").hidden,PV.editor.scene.lighting,lightColors.includes("rgb(182 152 125)")]'),
  ["custom",false,{azimuth:0,elevation:0,key:.6,ambient:.2,tone:"warm"},true],
  'lighting controls update the actual browser renderer');
 const litGlb=evaluate('pvGlb(lightProof,0,"灯光验证")');
 const lightingBytes=Buffer.from(await new Promise((resolve,reject)=>{
  const reader=new w.FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);
  reader.readAsArrayBuffer(litGlb);
 }));
 const lightingJsonLength=lightingBytes.readUInt32LE(12);
 const lightingJson=JSON.parse(lightingBytes.toString("utf8",20,20+lightingJsonLength));
 const lightingAccessor=lightingJson.accessors[lightingJson.meshes[0].primitives[0].attributes.COLOR_0];
 const lightingView=lightingJson.bufferViews[lightingAccessor.bufferView];
 const faceStart=28+lightingJsonLength+(lightingView.byteOffset||0)+6*3*4;
 for(const [i,channel] of [182,152,125].entries()){
  const linear=((channel/255+.055)/1.055)**2.4;
  assert.ok(Math.abs(lightingBytes.readFloatLE(faceStart+i*4)-linear)<1e-6,'GLB preserves the lit face at the exported frame');
 }
 evaluate('chooseLight("off")');
 equal(evaluate('[PV.editor.scene.lighting,$("[data-pv-light-fields]").hidden]'),[null,true]);
 evaluate('chooseLight("back");updatePvLight("azimuth",0);updatePvLight("elevation",0);updatePvLight("key",.6);updatePvLight("ambient",.2)');
 evaluate('pvHeight.value="7";pvHeight.dispatchEvent(new Event("change"));$("[data-pv-render]").click()');
 await ready('previsNode.versions.length===2','re-render remains on the same node',300);
 equal(evaluate('previsNode.versions[1].previs_recipe.lighting'),{azimuth:0,elevation:0,key:.6,ambient:.2,tone:"warm"});
 evaluate('$("[data-pv-close]").click();switchVersion(previsNode,0);openPrevis(previsNode)');
 assert.equal(evaluate('PV.editor.scene.lighting'),undefined,'the old render tab uses its original default lighting');
 equal(evaluate('PV.editor.scene.camera.find(x=>x.t===48).y'),5,'opening a prior tab restores the scene used for that render');
 evaluate(`CAPS_LIST.previs=[{id:"test-ark",name:"方舟测试",model:"ep-test"}];$("[data-pv-use]").click();
   const formal=[...sel].map(node)[0]; formal.data.prompt="跟拍人物走进花园";link(node("n1"),formal);`);
 equal(evaluate('videoReq(formal,formal.data.prompt).previs_guide.ref'), 'output:h3studio/previs1.mp4','formal video uses the displayed render');
 equal(evaluate('[formal.data.aspect,formal.data.provider,videoReq(formal,formal.data.prompt).images[0].role]'),['9:16','test-ark','subject'],'inherits framing and uses pictures as visual references');
 evaluate('switchVersion(previsNode,1)');
 equal(evaluate('videoReq(formal,formal.data.prompt).previs_guide.ref'), 'output:h3studio/previs1.mp4','upstream tab switch keeps the pinned version');
 evaluate('$("[data-previs-update]").click()');
 equal(evaluate('videoReq(formal,formal.data.prompt).previs_guide.ref'), 'output:h3studio/previs2.mp4','explicit update selects the current upstream version');
 const beforeFormalFetch=w.fetch;
 let formalRequest;
 w.fetch=async(url,opts)=>{
  if(String(url)!=='/api/generate')return beforeFormalFetch(url,opts);
  formalRequest=JSON.parse(opts.body);
  jobs.set('formal-test',{state:'done',meta:{model:'ep-test'},outputs:[{ref:'output:h3studio/formal.mp4',url:'/media?ref=output:h3studio/formal.mp4'}]});
  return {ok:true,text:async()=>JSON.stringify({ids:['formal-test']})};
 };
 evaluate('$("#send").click()');
 await ready('formal.versions.length===1','formal video is appended to the downstream node',300);
 w.fetch=beforeFormalFetch;
 equal([formalRequest.provider,formalRequest.previs_guide.version],['test-ark',2],'generation submits the pinned reference and selected model service');
 equal(evaluate('formal.versions[0].generation_record.inputs.at(-1).role'),'previs','generation receipt identifies the whitebox guide');
 equal(evaluate('formal.versions[0].input_edges.find(e=>e.relation==="previs").ref'), 'output:h3studio/previs2.mp4','version retains the guide connection');
 evaluate(`const reuse=addNode("video",1800,100,{prompt:"复用原来的设置",duration:8});openAddMenu(80,90,{to:reuse});$("#addMenu [data-previs-menu] button").click();`);
 equal(evaluate('[reuse.data.prompt,reuse.data.duration,previsInput(reuse).edge.ref]'),['复用原来的设置',8,'output:h3studio/previs2.mp4'],'an existing video can receive a guide with its settings intact');
 assert.equal(evaluate('vtSplit(previsNode.id,1)'),true);
 equal(evaluate('[previsInput(formal).version.ref,previsInput(formal).source.id===previsNode.id,formal.versions[0].video_recipe.previs_guide.node_id===previsInput(formal).source.id]'),
   ['output:h3studio/previs2.mp4',false,true],'splitting the source tab retargets the guide and preserves its exact media');
 evaluate(`const sceneOwner=previsInput(formal).source;AC.board=boardId;
   $("#acMessages").insertAdjacentHTML("beforeend",acResultCards({previs_node:sceneOwner.id,nodes:[{id:sceneOwner.id,type:"video",ref:curV(sceneOwner).ref}]}));
   $("#acMessages [data-previs-open]").click();`);
 equal(evaluate('PV.editor.n.id===sceneOwner.id && PV.editor.scene.camera.find(k=>k.t===48).y===7'),true,'assistant result opens the rendered scene version');
 evaluate(`const remoteBoard=acClone(B);remoteBoard.nodes.find(n=>n.id===sceneOwner.id).data.previs.camera[0].y=4;acApplyBoard(remoteBoard);`);
 equal(evaluate('PV.editor.scene.camera[0].y'),4,'untouched scene follows a remote edit');
 evaluate(`PV.editor.scene.camera[0].y=5;const advancedBoard=acClone(B);
   advancedBoard.nodes.find(n=>n.id===sceneOwner.id).data.previs.camera[0].y=6;acApplyBoard(advancedBoard);
   $("[data-pv-close]").click();`);
 equal(evaluate('[$("#previsEditor").open,$("[data-pv-discard]").hidden,sceneOwner.data.previs.camera[0].y]'),[true,false,6],'conflicting manual edits cannot overwrite the assistant result');
 evaluate('$("[data-pv-discard]").click()');
 const previsStoryFetch=w.fetch, previsStoryUploads=[];
 let failPrevisStoryUpload=true;
 w.fetch=(url,options)=>{
  const name=String(url)==='/api/upload' && options?.body?.get('image')?.name;
  if(name?.startsWith?.('白模镜头-')){
   previsStoryUploads.push(name);
   if(failPrevisStoryUpload && name.endsWith('-02.png')){
    return Promise.resolve({ok:false,json:async()=>({error:'上传暂时失败'})});
   }
  }
  return previsStoryFetch(url,options);
 };
 equal(evaluate('pvStoryboardBoundaries(pvInitialScene())'),[0,96],'a continuous preview still produces one shot');
 evaluate(`openPrevis(sceneOwner);
   const pvStoryScene=PV.editor.scene,pvStoryEnd=pvStoryScene.duration*PV_FPS;
   pvStoryScene.camera[0].ease="cut";
   pvStoryScene.camera.splice(1,0,{...pvStoryScene.camera[0],t:31,x:3});
   pvStoryScene.camera.push({...pvStoryScene.camera.at(-1),t:pvStoryEnd,ease:"cut"});
   pvCommit(PV.editor);
   closePrevis();
   const pvChatCard={board:boardId,node:sceneOwner.id,name:sceneOwner.name,aspect:pvStoryScene.aspect,fps:PV_FPS,boundaries:[0,31,pvStoryEnd]};
   $("#acMessages").insertAdjacentHTML("beforeend",acResultCards({previs_storyboard_plan:pvChatCard}));
   const pvChatButton=$("[data-open-previs-storyboard]",$("#acMessages"));
   pvChatButton.dataset.openPrevisStoryboard=JSON.stringify({...pvChatCard,boundaries:[0,35,pvStoryEnd]});
   pvChatButton.click();`);
 equal(evaluate('!!PV.editor'),false,'an old assistant plan does not open after the cuts change');
 assert.match(evaluate('pvChatButton.closest("section").textContent'),/0–1\.29 秒 · 1\.29 秒/);
 evaluate('pvChatButton.dataset.openPrevisStoryboard=JSON.stringify(pvChatCard);pvChatButton.click()');
 equal(evaluate('PV.editor.n.id'),evaluate('sceneOwner.id'),'the current assistant plan opens the source editor');
 assert.equal(previsStoryUploads.length,0,'opening the plan submits no work');
 evaluate(`
   const pvStoryBefore=[B.nodes.length,B.edges.length,undoStack.length];
   const pvStoryPainter=pvPaint,pvCapturedPoses=[];
   pvPaint=(canvas,scene,tick,...rest)=>{
    if(canvas!==$("#previsEditor canvas"))pvCapturedPoses.push([tick,pvSample(scene.camera,tick).x]);
    pvStoryPainter(canvas,scene,tick,...rest);
   };
   const pvStoryView=$("[data-pv-view]");pvStoryView.value="plan";pvStoryView.dispatchEvent(new Event("change"));
   $("[data-pv-storyboard]").click();`);
 await ready('!PV.editor.sending && $("[data-pv-status]").textContent==="上传暂时失败"','failed upload leaves the storyboard retryable');
 const beforePrevisStory=Array.from(evaluate('pvStoryBefore'));
 equal(evaluate('[B.nodes.length,B.edges.length,undoStack.length]'),beforePrevisStory,'failed upload creates no partial canvas nodes');
 failPrevisStoryUpload=false;
 evaluate('$("[data-pv-storyboard]").click()');
 await ready('!PV.editor.sending && B.nodes.some(n=>n.data.previs_source===sceneOwner.id)','cut export creates an editable storyboard');
 equal(previsStoryUploads,['白模镜头-01.png','白模镜头-02.png','白模镜头-02.png'],'retry reuses successfully uploaded stills');
 equal(evaluate('pvCapturedPoses'),[[0,5],[31,3],[31,3]],'stills use each new camera pose even from overhead layout');
 evaluate('pvPaint=pvStoryPainter');
 w.fetch=previsStoryFetch;
 equal(evaluate(`const pvStoryboard=B.nodes.find(n=>n.data.previs_source===sceneOwner.id);
   [pvStoryboard.data.shots.map(s=>s.previs_range),$$(".du",els.get(pvStoryboard.id)).map(e=>e.textContent),
   pvStoryboard.data.made.map(({img,vid},i)=>{const first=videoReq(node(vid),"").images[0];return [
     curV(node(img)).source,first.ref===pvStoryboard.data.shots[i].frame.ref,first.time,
     B.edges.find(e=>e.from===img&&e.to===vid).role,node(vid).data.duration];}),
   undoStack.length-pvStoryBefore[2]]`),
   [[[0,31],[31,96]],['1.29s','2.71s'],[['previs-frame',true,0,'first',5],['previs-frame',true,0,'first',5]],1],
   'each shot retains its original preview timing, generation duration, and first-frame connection');
 evaluate(`$("[data-pv-close]").click();openScriptShotRangeRun(pvStoryboard,0,1,"missing_video");`);
 assert.match(evaluate('$("#groupRunConfirm ol").textContent'),/白模 1\.29 秒 · 视频设定 5 秒/);
 assert.match(evaluate('$("#groupRunConfirm ol").textContent'),/首帧仍为白模/);
 assert.match(evaluate('$("#groupRunConfirm ol").textContent'),/首帧 · 版本 1（当前） · 白模草稿/);
 evaluate(`closeCanvasGroupRunDialog();
  const pvLayoutImage=node(pvStoryboard.data.made[0].img),pvLayoutVideo=node(pvStoryboard.data.made[0].vid);
  const pvWhitebox=curV(pvLayoutImage).ref;
  pvLayoutImage.data.prompt="以 @图{3} 的角色为主角，写实夜景";
  pvLayoutVideo.data.fields.action="角色走进画面";
  B.edges.push({from:"n1",to:pvLayoutImage.id,prompt_slot:3});
  selectOnly(pvLayoutImage.id);`);
 assert.equal(evaluate('$("[data-previs-composition]").getAttribute("aria-pressed")'),'true');
 equal(evaluate(`const occupiedRefs=Array.from({length:9},(_,i)=>"ref-"+i), pvGuide=previsComposition(pvLayoutImage);
  [previsCompositionHasRoom(pvLayoutImage,pvGuide,occupiedRefs),
   previsCompositionHasRoom(pvLayoutImage,pvGuide,[...occupiedRefs.slice(0,8),pvGuide.ref])]`),
  [false,true],'a local recipe must leave space for the composition unless it is already one of the inputs');
 evaluate('$("[data-previs-composition]").click()');
 assert.equal(evaluate('storyboardFrameReady(pvLayoutImage)'),true,'the whitebox can be adopted directly by disabling replacement');
 evaluate(`undo();
  const pvLayoutImageId=pvLayoutImage.id,pvLayoutVideoId=pvLayoutVideo.id;
  openScriptShotRun(node(pvStoryboard.id),0);`);
 assert.match(evaluate('$("#groupRunConfirm ol").textContent'),/白模构图固定参考/);
 assert.match(evaluate('$("#groupRunConfirm ol").textContent'),/首帧 · 本轮生成/);
 const previsGenerationFetch=w.fetch, previsGenerated=[];
 w.fetch=(url,options)=>{
  if(String(url)!=='/api/generate')return previsGenerationFetch(url,options);
  const request=JSON.parse(options.body), id='previs-composition-'+request.kind;
  const ref='output:h3studio/'+id+(request.kind==='image'?'.png':'.mp4');
  previsGenerated.push(request);
  jobs.set(id,{state:'done',meta:{seed:42},outputs:[{ref,url:'/media?ref='+encodeURIComponent(ref),meta:{width:405,height:720}}]});
  return Promise.resolve({ok:true,text:async()=>JSON.stringify({ids:[id]})});
 };
 evaluate('$("#groupRunConfirm [type=submit]").click()');
 await ready('groupRun?.steps.length===2 && !groupRun.active','the storyboard converts the whitebox then submits the video',1000);
 w.fetch=previsGenerationFetch;
 assert.equal(previsGenerated.length,2);
 assert.deepEqual(previsGenerated[0].images.map(item=>item.ref),Array.from(evaluate('[curV(node("n1")).ref,pvWhitebox]')));
 assert.match(previsGenerated[0].prompt,/以 @图1 的角色/);
 assert.match(previsGenerated[0].prompt,/按 @图2 的机位/);
 assert.equal(previsGenerated[1].images[0].ref,'output:h3studio/previs-composition-image.png');
 equal(evaluate(`const pvFinalImage=node(pvLayoutImageId);
  [pvFinalImage.versions.map(version=>version.source),previsComposition(pvFinalImage).ref,
   curV(pvFinalImage).generation_record.inputs.at(-1).version,storyboardFrameReady(pvFinalImage)]`),
  [['previs-frame','gen'],evaluate('pvWhitebox'),1,true],'the finished picture preserves the original whitebox tab and generation receipt');
 evaluate(`$("#groupRunProgress [data-dismiss]").click();
  const pvEditScript=node(pvStoryboard.id), pvEditVideo=node(pvEditScript.data.made[1].vid);
  curV(node(pvLayoutVideoId)).seconds=5.2;
  pvEditVideo.versions=[{ref:"output:h3studio/short-whitebox-take.mp4",seconds:2.25,w:405,h:720}];pvEditVideo.cur=0;
  openStoryFilm(pvEditScript,0,1,"fade");$("#fmV").onloadedmetadata?.();`);
 equal(evaluate(`[FILM.spec.clips.map(c=>[c.out*FILM_FPS,c.story_frames,c.trans,c.tight]),$("#fmTotal").textContent]`),
  [[[31,31,"cut",true],[54,65,"cut",true]],"2 段 · 3.54 秒"],'the new cut preserves planned frames and clamps a short original');
 evaluate('$("[data-a=reset]",$("#fmClip")).click()');
 assert.equal(evaluate('FILM.spec.clips[0].out'),null,'full-length playback is still available');
 evaluate('$("[data-a=story-length]",$("#fmClip")).click();selectClip(1);$("#fmV").onloadedmetadata?.()');
 assert.equal(evaluate('FILM.spec.clips[0].out*FILM_FPS'),31);
 assert.match(evaluate('$("#fmClip").textContent'),/素材时长不足/);
 evaluate(`const slowPreview=$("#fmSlowdownDialog"), slowClip=FILM.spec.clips[1];
  const slowOriginal=JSON.stringify(slowClip), openSlow=()=>$("[data-story-slowdown]",$("#fmClip")).click();
  const applySlow=()=>$("form",slowPreview).dispatchEvent(new Event("submit",{cancelable:true}));
  openSlow();$("video",slowPreview).onloadedmetadata();`);
 assert.match(evaluate('$("[data-slowdown-result]",slowPreview).textContent'),/2\.25 秒素材，以 0\.831 倍速播放 2\.71 秒/);
 assert.equal(evaluate('$("video",slowPreview).playbackRate'),2.25/(65/24));
 evaluate('$("[data-close]",slowPreview).click()');
 assert.equal(evaluate('JSON.stringify(slowClip)===slowOriginal'),true,'preview and cancel leave timeline settings intact');
 evaluate('openSlow();slowClip.out=2;applySlow()');
 equal(evaluate('[slowPreview.open,slowClip.out,filmSpeed(slowClip)]'),[false,2,1],'a stale preview does not overwrite the timeline');
 evaluate('slowClip.out=2.25;openSlow();applySlow();$("#fmV").onloadedmetadata?.()');
 equal(evaluate('[clipLen(slowClip)*24,$("#fmTotal").textContent,!!$("[data-story-slowdown]",$("#fmClip"))]'),
  [65,"2 段 · 4.00 秒",false],'confirmed slowdown reaches the exact planned timeline length');
 equal(evaluate(`[storySlowdownPlan({kind:"video",story_frames:120},2.49),
  storySlowdownPlan({kind:"video",story_frames:120},2.5).rate]`),
  [null,.5],'the minimum supported speed bounds the available fix');
 evaluate(`FILM.spec.clips[0].out=20/FILM_FPS;
  closeFilm();openStoryFilm(pvEditScript);$("#fmV").onloadedmetadata?.();`);
 assert.equal(evaluate('FILM.spec.clips[0].out*FILM_FPS'),20,'reopening preserves manually edited timing');
 assert.equal(evaluate('clipLen(FILM.spec.clips[1])*24'),65,'reopening preserves the accepted slowdown');
 evaluate(`const pvAltSource=node(pvEditVideo.id), pvLong={ref:"output:h3studio/long-whitebox-take.mp4",seconds:4.75};
  pvAltSource.versions.push({ref:"output:h3studio/shorter-whitebox-take.mp4",seconds:1.75},pvLong,
    {ref:"output:h3studio/probe-whitebox-take.mp4"});
  selectClip(1);$("#fmV").onloadedmetadata?.();$("[data-update-version]",$("#fmClip")).click();
  const pvAltForm=$(".fm-version-picker"), pvAltPicker=$("select",pvAltForm), pvFit=$("[data-fit-story]",pvAltForm),
    pvAltPreview=$("video",pvAltForm), pvAltStatus=$("[role=status]",pvAltForm);
  const chooseAlt=index=>{pvAltPicker.value=String(index);pvAltPicker.dispatchEvent(new Event("change"));};
  const applyAlt=()=>$('[type=submit]',pvAltForm).click();`);
 equal(evaluate('[...pvAltPicker.options].map(o=>o.textContent.split(" · ").at(-1))'),
  ['缺 0.96 秒','够计划镜长','待核实时长']);
 assert.equal(evaluate('pvFit.disabled'),true);
 evaluate('chooseAlt(2)');
 assert.equal(evaluate('pvFit.disabled'),true,'unknown source duration cannot be applied as an exact planned cut');
 evaluate(`chooseAlt(1);pvFit.click();$("[data-preview-version]",pvAltForm).click();
  pvAltPreview.onloadedmetadata();`);
 assert.match(evaluate('pvAltStatus.textContent'),/以原速取用 2\.71 秒/);
 assert.match(evaluate('pvAltPreview.src'),/long-whitebox-take\.mp4/);
 equal(evaluate('[pvAltPreview.hidden,pvAltPreview.playbackRate,pvAltPreview.currentTime,FILM.spec.clips[1].ref]'),
  [false,1,0,'output:h3studio/short-whitebox-take.mp4'],'preview uses the candidate and the plan without replacing the draft');
 evaluate('pvLong.seconds=4.5;applyAlt()');
 assert.match(evaluate('pvAltStatus.textContent'),/素材已更新，请再次确认/);
 assert.equal(evaluate('FILM.spec.clips[1].ref'),'output:h3studio/short-whitebox-take.mp4');
 evaluate('applyAlt();$("#fmV").onloadedmetadata?.()');
 equal(evaluate(`[FILM.spec.clips[1].ref,clipLen(FILM.spec.clips[1])*24,filmSpeed(FILM.spec.clips[1]),
  pvAltSource.cur,pvAltPreview.getAttribute("src")]`),
  ['output:h3studio/long-whitebox-take.mp4',65,1,0,null],'applying at original speed retains the plan and the canvas version selection');
 evaluate(`const oneFrameClip={story_frames:1,in:0,media_seconds:5};
  alignStoryClipLength(oneFrameClip,5);closeFilm();`);
 assert.equal(evaluate('clipLen(oneFrameClip)'),1/24);
 evaluate(`const shotMotionSource=node(sceneOwner.id);
  const shotMotionTarget=node(node(pvStoryboard.id).data.made[1].vid);
  openPrevis(shotMotionSource);
  const chooseMotionSpan=span=>{
    const select=$("[data-pv-shot-range]");select.value=JSON.stringify(span);select.dispatchEvent(new Event("change"));
    $("[data-pv-render-shot]").click();
  };
  chooseMotionSpan([0,31]);`);
 await ready('!PV.editor.sending && curV(shotMotionSource)?.previs_span?.[1]===31','renders the first cut independently',450);
 equal(evaluate('[curV(shotMotionSource).seconds,$("[data-pv-use]").disabled,$("[data-pv-shot-guide]").hidden]'),
  [31/24,true,true],'short previews remain available for editing without becoming invalid motion references');
 evaluate('chooseMotionSpan([31,96])');
 await ready('!PV.editor.sending && curV(shotMotionSource)?.previs_span?.[0]===31','renders the eligible second interval',450);
 assert.deepEqual(w.__previsRequests.slice(-2).map(request=>request.span),[[0,31],[31,96]]);
 assert.notEqual(w.__previsRequests.at(-1).request_key,w.__previsRequests.at(-2).request_key);
 equal(evaluate('[PV.editor.tick,$("[data-pv-shot-guide]").hidden,$("[data-pv-guide-target]").value===shotMotionTarget.id]'),
  [31,false,true],'exports the selected interval and offers only the corresponding storyboard video');
 evaluate('$("[data-pv-apply-shot-guide]").click()');
 equal(evaluate(`[!PV.editor,previsInput(shotMotionTarget).edge.ref===curV(shotMotionSource).ref,
  previsInput(shotMotionTarget).version.previs_span,videoReq(shotMotionTarget,"").previs_guide.version]`),
  [true,true,[31,96],evaluate('shotMotionSource.cur+1')],'explicit attachment pins exactly the rendered motion version');
 evaluate(`const [motionCopy,scriptCopy,videoCopy]=paste([shotMotionSource,node(pvStoryboard.id),shotMotionTarget].map(o=>structuredClone(o)));
  const copiedMotion=node(motionCopy);`);
 equal(evaluate('[node(scriptCopy).data.previs_source,pvShotGuideTargets({n:copiedMotion},curV(copiedMotion)).has(videoCopy)]'),
  [evaluate('motionCopy'),true],'copied shots bind to the copied whitebox and video');
 evaluate('undo()');
 evaluate('undo()');
 assert.equal(evaluate('previsInput(node(shotMotionTarget.id))'),null);
 evaluate('undo()');
 equal(evaluate('[B.nodes.length,B.edges.length,undoStack.length]'),beforePrevisStory,'one undo removes every imported shot and connection');
 evaluate(`const beforeMotionBatch=snap(), motionBase=pvInitialScene();
  motionBase.duration=10;
  const guideSpans=[[0,24],[24,80],[80,136],[136,184],[184,240]];
  motionBase.camera=guideSpans.map(([t],i)=>({...motionBase.camera[0],t,ease:i?"cut":"linear"}));
  const batchMotion=addNode("video",0,0,{previs:motionBase},{name:"批量白模"});
  const batchGuide=(span,ref)=>({ref,source:"previs",seconds:(span[1]-span[0])/24,
    url:"/media?ref="+encodeURIComponent(ref),previs_span:span,previs_recipe:structuredClone(motionBase)});
  const reusableGuide=batchGuide(guideSpans[1],"output:h3studio/reusable-motion.mp4");
  const retainedGuide=batchGuide(guideSpans[4],"output:h3studio/existing-motion.mp4");
  batchMotion.versions.push(reusableGuide,retainedGuide);batchMotion.cur=1;
  const guideShots=guideSpans.map((span,i)=>({id:"batch-shot-"+i,previs_range:span,duration:(span[1]-span[0])/24,
    shot_size:"",camera:"",action:[],dialogue:[]}));
  const batchGuideVideos=guideShots.map((_,i)=>addNode("video",1000+i*400,0));
  const guideBoardScript=addNode("script",0,0,{previs_source:batchMotion.id,shots:guideShots,
    made:batchGuideVideos.map((video,i)=>({shot_id:guideShots[i].id,vid:video.id}))});
  const retainedEdge={from:batchMotion.id,to:batchGuideVideos[4].id,relation:"previs",ref:retainedGuide.ref};
  B.edges.push(retainedEdge);
  openPrevis(batchMotion);$("[data-pv-batch-open]").click();
  const guideBatchConfirm=$("[data-pv-batch-confirm]"), guideBatchRows=$("[data-pv-batch-rows]");`);
 assert.match(evaluate('guideBatchRows.textContent'),/少于 2 秒.*复用当前场景.*渲染并绑定.*已有动作参考/);
 const batchMotionRequests=w.__previsRequests.length;
 evaluate('B.edges.push({...retainedEdge,to:batchGuideVideos[3].id});guideBatchConfirm.click()');
 assert.equal(w.__previsRequests.length,batchMotionRequests);
 assert.match(evaluate('$("[data-pv-status]").textContent'),/请核对后再次确认/);
 evaluate('B.edges.pop();$("[data-pv-batch-open]").click()');
 const guideBatchFetch=w.fetch;
 let heldMotionJob;
 w.fetch=async(url,options)=>{
  const response=await guideBatchFetch(url,options);
  if(String(url)==='/api/previs/render'&&JSON.parse(options.body).span?.[0]===80){
   const {ids:[id]}=await response.json(), completed=jobs.get(id);
   heldMotionJob={id,completed};jobs.set(id,{...completed,state:"running"});
  }
  return response;
 };
 evaluate('guideBatchConfirm.click()');
 await ready('batchMotion.job && PV.editor.guideBatch','the confirmed batch submits the first pending render',500);
 assert.equal(w.__previsRequests.length,batchMotionRequests+1,'the next render waits for the current job');
 jobs.set(heldMotionJob.id,heldMotionJob.completed);
 await ready('!PV.editor.guideBatch','the motion batch finishes and binds its results',650);
 w.fetch=guideBatchFetch;
 assert.deepEqual(w.__previsRequests.slice(batchMotionRequests).map(request=>request.span),[[80,136],[136,184]]);
 equal(evaluate('batchGuideVideos.map(v=>previsInput(v)?.version?.previs_span)'),
  [null,[24,80],[80,136],[136,184],[184,240]],'the batch reuses matching takes, renders pending shots and preserves existing inputs');
 assert.match(evaluate('$("[data-pv-status]").textContent'),/已绑定 3 镜/);
 evaluate(`const batchGuideIds=batchGuideVideos.map(v=>v.id), batchMotionId=batchMotion.id;
  closePrevis();undo();`);
 equal(evaluate('[batchGuideIds.map(id=>!!previsInput(node(id))),node(batchMotionId).versions.length]'),
  [[false,false,false,false,true],4],'one undo clears the new edges and retains rendered takes');
 evaluate('restore(beforeMotionBatch)');
 console.log('Previs storyboard DOM passed: cut poses, timing, upload retry, composition input, dependent video generation, frame-accurate editing, version choice and single undo.');
 await evaluate(`const soundNode=addNode("audio",140,140);
   uploadInto(soundNode,new File(["fixture"],"旁白.wav",{type:"audio/wav"}));`);
 equal(evaluate('[$("audio",els.get(soundNode.id)).getAttribute("src"),soundNode.name,curV(soundNode).seconds]'),
   ['/media?ref=input%3Ah3studio%2Ffx.wav','旁白',1],'upload creates a playable named audio node');
 evaluate(`CAPS_LIST.audio_reference=[{id:"fixture-ark",name:"声音参考服务",model:"doubao-seedance-2-5-fixture"}];
   const audioVideo=addNode("video",520,120,{prompt:"跟随声音节奏"});
   openAddMenu(80,90,{to:audioVideo});$("#addMenu [data-audio-menu] button").click();selectOnly(audioVideo.id);`);
 equal(evaluate('[videoReq(audioVideo,audioVideo.data.prompt).audio_refs[0].ref,audioVideo.data.provider,$("#refs [data-tok=\\\"@音1\\\"]").textContent.includes("版本 1")]'),
   ['input:h3studio/fx.wav','fixture-ark',true],'pinned audio appears as the numbered sound reference');
 evaluate(`addVersion(soundNode,{ref:"input:h3studio/other.wav",url:"/media?ref=input%3Ah3studio%2Fother.wav",seconds:3,source:"upload",prompt:""});`);
 equal(evaluate('videoReq(audioVideo,"").audio_refs[0].version'),1,'editing the source audio keeps the existing reference');
 evaluate('$("[data-audio-update]").click()');
 equal(evaluate('videoReq(audioVideo,"").audio_refs[0].version'),2,'the reference switches only on explicit adoption');
 evaluate(`selectOnly(audioVideo.id);
   for(const [point,value] of [["start",.5],["end",2.5]]){
    const input=$('[data-audio-point="'+point+'"]');input.value=value;input.dispatchEvent(new Event("change"));
   }`);
 equal(evaluate('videoReq(audioVideo,"").audio_refs.map(({start,end})=>[start,end])'),[[.5,2.5]]);
 evaluate(`openFilm([node("n1")]);const picked=$("#fmCanvasAudio");picked.value=soundNode.id;picked.dispatchEvent(new Event("change"));`);
 equal(evaluate('FILM.spec.audio_clips.map(({name,ref,node,start,out})=>[name,ref,node===soundNode.id,start,out])'),
   [['旁白','input:h3studio/other.wav',true,0,3]],'the actual audio can be placed on the editing timeline');
 evaluate('$("#fmV").pause=$("#fmOriginal").pause=()=>{};closeFilm()');
 console.log('Audio DOM passed: upload, playback, reference, version pin and adoption, plus timeline reuse.');
 evaluate(`CAPS_LIST.previs=[{id:"fixture-ark",name:"视频参考服务",model:"doubao-seedance-2-5-fixture"}];
   const clipSource=addNode("video",240,150);
   addVersion(clipSource,{ref:"input:h3studio/reference1.mp4",url:"/media?ref=input%3Ah3studio%2Freference1.mp4",seconds:12,w:720,h:1280});
   selectOnly(audioVideo.id);openAddMenu(80,90,{to:audioVideo});
   $$("#addMenu [data-video-menu] button").find(b=>b.textContent.startsWith(clipSource.name+" ")).click();
   const setClipPoint=(point,value)=>{const f=$('[data-clip-point="'+point+'"]');f.value=value;f.dispatchEvent(new Event("change"));};
   setClipPoint("start",2);setClipPoint("end",6);`);
 equal(evaluate('videoReq(audioVideo,"").video_refs.map(({ref,start,end,version})=>[ref,start,end,version])'),
   [['input:h3studio/reference1.mp4',2,6,1]],'reference stores the selected video version and trim');
 equal(evaluate('videoReq(audioVideo,"").ar'),9/16,'source display framing is inherited in auto mode');
 evaluate(`addVersion(clipSource,{ref:"input:h3studio/reference2.mp4",url:"/media?ref=input%3Ah3studio%2Freference2.mp4",seconds:8,w:720,h:1280});`);
 equal(evaluate('videoReq(audioVideo,"").video_refs[0].version'),1,'source tab changes do not alter the selected reference');
 evaluate('$("[data-video-update]").click()');
 equal(evaluate('videoReq(audioVideo,"").video_refs.map(({ref,start,end,version})=>[ref,start,end,version])'),
   [['input:h3studio/reference2.mp4',0,8,2]],'adopting a new version resets the trim');
 const ordinaryReferenceFetch=w.fetch;
 let automaticReference;
 w.fetch=async(url,options)=>{
  if(String(url)!=="/api/generate")return ordinaryReferenceFetch(url,options);
  automaticReference=JSON.parse(options.body);
  return {ok:false,text:async()=>JSON.stringify({error:"测试拦截"})};
 };
 evaluate(`CAPS_LIST.previs[0].models=[{id:"long-reference",durations:[5,15,20,30],qualities:{std:"720p",hd:"1080p","4k":"4k"}}];
   const autoService=$("#ctl [data-k=provider]");
   autoService.value="";autoService.dispatchEvent(new Event("change"));
   const autoDuration=$("#ctl [data-k=duration]");autoDuration.value="20";autoDuration.dispatchEvent(new Event("change"));`);
 await evaluate('generate(audioVideo)');
 assert(!Object.hasOwn(automaticReference,"provider"),'the canvas leaves automatic routes unpinned before the server checks every input');
 assert.equal(automaticReference.duration,20);
 assert.equal(automaticReference.audio_refs[0].start,.5);
 w.fetch=ordinaryReferenceFetch;
 evaluate(`audioVideo.data.provider="fixture-ark";audioVideo.data.duration=5;delete CAPS_LIST.previs[0].models;showPanel();`);
 console.log('Video reference DOM passed: attach to existing video, trim, frame ratio, version pin and explicit adoption.');
 evaluate(`openVideoExtension(clipSource);const extForm=$("#videoExtension form");
   extForm.elements.direction.value="before";extForm.elements.direction.dispatchEvent(new Event("change"));
   extForm.elements.prompt.value="站台还空着";extForm.elements.duration.value=6;
   extForm.dispatchEvent(new Event("submit",{cancelable:true}));const extensionNode=node([...sel][0]);
   const sourceAtCreation=curV(clipSource).ref;`);
 equal(evaluate(`[extensionNode.x<clipSource.x,videoReq(extensionNode,extensionNode.data.prompt).extension,
   videoReq(extensionNode,"").video_refs[0].start,videoReq(extensionNode,"").video_refs[0].end,$("[data-clip-point=start]").disabled]`),
   [true,'before',0,4,true],'a prologue uses the original opening and is placed before the original');
 evaluate(`addVersion(extensionNode,{ref:"output:h3studio/prologue.mp4",url:"/media?ref=output%3Ah3studio%2Fprologue.mp4",seconds:6,w:720,h:1280,
   video_recipe:videoReq(extensionNode,extensionNode.data.prompt)});switchVersion(clipSource,0);
   nodeAction(extensionNode,"extension-film");`);
 equal(evaluate('FILM.spec.clips.map(c=>c.ref)'),['output:h3studio/prologue.mp4',evaluate('sourceAtCreation')],
   'the timeline opens the prologue before the exact original version');
 evaluate('$("#fmV").pause=$("#fmOriginal").pause=()=>{};closeFilm();openVideoExtension(clipSource);$("#videoExtension form").dispatchEvent(new Event("submit",{cancelable:true}));const nextScene=node([...sel][0]);');
 equal(evaluate('[nextScene.x>clipSource.x,videoReq(nextScene,"").extension,videoReq(nextScene,"").video_refs[0].start,videoReq(nextScene,"").video_refs[0].end]'),
   [true,'after',8,12],'the sequel uses the tail boundary and is placed after the original');
 evaluate(`const tailAnchor=addNode("image",600,500,{}, {name:"本地续拍接点",versions:[
   {ref:"output:h3studio/local-tail.png",capture:{source_node:clipSource.id,source_ref:sourceAtCreation,position:"last"}},
   {ref:"output:h3studio/local-older-anchor.png",capture:{source_node:clipSource.id,source_ref:curV(clipSource).ref,position:"last"}}],cur:1});
   const localTail=addNode("video",1000,500,{}, {name:"本地续拍结果",versions:[
   {ref:"output:h3studio/local-sequel.mp4",url:"/media?ref=output%3Ah3studio%2Flocal-sequel.mp4",seconds:5.17,
    video_recipe:{images:[{node_id:tailAnchor.id,ref:tailAnchor.versions[0].ref,time:0,role:"frame"}]}},
   {ref:"output:h3studio/local-other.mp4",seconds:6}],cur:0});
   ctxMenu({target:els.get(localTail.id),clientX:140,clientY:120});
   $("#ctxMenu [data-a=extension-film]").click();`);
 equal(evaluate('FILM.spec.clips.map(c=>c.ref)'),
   [evaluate('sourceAtCreation'),'output:h3studio/local-sequel.mp4'],'local continuation uses the capture referenced by the recipe, not the current frame');
 evaluate(`closeFilm();AC.board=boardId;
   $("#acMessages").insertAdjacentHTML("beforeend",acResultCards({nodes:[{id:localTail.id,type:"video",ref:curV(localTail).ref}]}));
   switchVersion(localTail,1);
   const continuationButton=$("#acMessages [data-extension-clip]");continuationButton.click();`);
 equal(evaluate('[localTail.cur,FILM.spec.clips[1].ref]'),[1,'output:h3studio/local-sequel.mp4'],
   'the assistant result opens that result version without changing the selected canvas Tab');
 evaluate(`selectClip(1);$("#fmV").onloadedmetadata?.();
   const editAt=(key,time)=>{$("#fmV").currentTime=time;
    $("#fmTime").dispatchEvent(new KeyboardEvent("keydown",{key,bubbles:true,cancelable:true}));};
   editAt("q",1);editAt("e",4);editAt("c",2);`);
 equal(evaluate('FILM.spec.clips.slice(1).map(c=>[c.in,c.out])'),[[1,2],[2,4]],
   'trim and split shortcuts work in a continuation timeline from the focused playhead control');
 evaluate(`closeFilm();continuationButton.closest(".ac-results").remove();
   const prologueInput={source_node:clipSource.id,source_ref:sourceAtCreation,position:"first"};
   tailAnchor.versions[0].capture=prologueInput;
   const localPrologue={video_recipe:{planned:true,duration:124/24,images:[
      {node_id:tailAnchor.id,ref:tailAnchor.versions[0].ref,time:5,role:"frame"}]}};
 `);
 equal(evaluate('extensionInput(localPrologue)?.direction'),'before','a locally generated tail anchor is recognized as a prologue');
 equal(evaluate('extensionInput({video_recipe:{images:[{...localPrologue.video_recipe.images[0],role:"subject"}]}})'),
   null,'a captured image used as an appearance reference does not create a continuation');
 evaluate('B.nodes=B.nodes.filter(n=>n!==localTail&&n!==tailAnchor);rebuild();updateSel();');
 const frameExtensionFetch=w.fetch, frameExtensionReads=[];
 w.fetch=async(url,options)=>{
  if(String(url)!=="/api/lastframe")return frameExtensionFetch(url,options);
  frameExtensionReads.push(JSON.parse(options.body));
  return {ok:true,text:async()=>JSON.stringify({ref:"output:h3studio/local-pin.png",url:"/media?ref=output%3Ah3studio%2Flocal-pin.png",w:720,h:1280,at:0})};
 };
 evaluate(`const previousExtensionServices=CAPS_LIST.video;
   CAPS_LIST.video=[{id:"cloud-default",kind:"ark",name:"云端服务",default:true},
                   {id:"local_h3",kind:"local_h3",name:"本地 H3",local:true}];
   openVideoExtension(clipSource);extForm.elements.method.value="frame";
   extForm.elements.method.dispatchEvent(new Event("change"));
   extForm.elements.direction.value="before";extForm.elements.prompt.value="补上空站台";
   extForm.dispatchEvent(new Event("submit",{cancelable:true}));`);
 await ready('node([...sel][0])?.name.endsWith("补拍片头")','the frame capture creates and selects the continuation');
 equal(frameExtensionReads,[{ref:evaluate('curV(clipSource).ref'),position:"first"}]);
 evaluate(`const frameExtensionDraft=node([...sel][0]);
   const frameExtensionAnchor=imageInputs(frameExtensionDraft)[0].source;
   addVersion(frameExtensionAnchor,{ref:"output:h3studio/unrelated-version.png",w:1280,h:720});`);
 equal(evaluate(`[frameExtensionDraft.data.provider,extForm.elements.duration.min,videoReq(frameExtensionDraft,"").ar,
   imageInputs(frameExtensionDraft)[0].edge.role,videoReq(frameExtensionDraft,"").images[0].ref]`),
   ["local_h3","5",9/16,"last","output:h3studio/local-pin.png"],'local continuation keeps the pinned anchor, actual aspect and local service after switching versions');
 evaluate('CAPS_LIST.video=previousExtensionServices;removeNodes([frameExtensionAnchor.id,frameExtensionDraft.id]);');
 w.fetch=frameExtensionFetch;
 console.log('Extension DOM passed: head/tail mode, pinned boundary, directional placement and ordered timeline.');
 evaluate(`CAPS_LIST.segment_edit=[{id:"fixture-edit",name:"片段编辑服务",model:"doubao-seedance-2-5-fixture"}];
   openSegmentEditor(clipSource);const segForm=$("#videoSegment form");
   $("video",segForm).pause=()=>{};segForm.elements.start.value=.25;segForm.elements.end.value=4.25;segForm.elements.prompt.value="改成夜景";
   segForm.elements.end.dispatchEvent(new Event("input"));segForm.dispatchEvent(new Event("submit",{cancelable:true}));
   const segmentNode=node([...sel][0]), segmentRecipe=videoReq(segmentNode,segmentNode.data.prompt);`);
 equal(evaluate('[segmentRecipe.segment_edit,segmentRecipe.video_refs[0].start,segmentRecipe.video_refs[0].end,segmentNode.data.provider]'),
   [true,.25,4.25,'fixture-edit'],'the dialog binds the edited range to its original source and service');
 evaluate(`addVersion(segmentNode,{ref:"output:h3studio/revised-segment.mp4",url:"/media?ref=output%3Ah3studio%2Frevised-segment.mp4",seconds:4,w:720,h:1280,video_recipe:segmentRecipe});
   nodeAction(segmentNode,"segment-film");`);
 equal(evaluate('FILM.spec.clips.map(c=>[c.ref,c.in,c.out,c.tight])'),
   [['input:h3studio/reference1.mp4',0,.25,true],['output:h3studio/revised-segment.mp4',0,4,true],['input:h3studio/reference1.mp4',4.25,12,true]],
   'the original prefix and suffix surround the replacement without rounding the short prefix away');
 evaluate('$("#fmV").pause=$("#fmOriginal").pause=()=>{};closeFilm()');
 console.log('Segment edit DOM passed: dedicated picker, editable range, pinned result and assembled timeline.');
 evaluate(`nodeAction(clipSource,"camera-retake");
   const retakeForm=$("#videoSegment form");
   $("video",retakeForm).pause=()=>{};
   const setRetakeMode=value=>{
     retakeForm.elements.cameraMode.value=value;
     retakeForm.elements.cameraMode.dispatchEvent(new Event("change"));
   };
   setRetakeMode("move");
   $("[data-vs-view=end] select",retakeForm).value="rear";
   retakeForm.dispatchEvent(new Event("submit",{cancelable:true}));
   const retakeDraft=node([...sel][0]);
   const savedCameraRequest=videoReq(retakeDraft,"");`);
 equal(evaluate('[savedCameraRequest.prompt,savedCameraRequest.mode,savedCameraRequest.camera_plan,savedCameraRequest.video_refs[0].ref]'),
   ['', 'camera_retake',{mode:'move',start:{angle:'front',scale:'medium'},end:{angle:'rear',scale:'medium'}},'input:h3studio/reference1.mp4'],
   'a retake may use its structured plan without extra text and keeps the exact source video');
 evaluate(`addVersion(retakeDraft,{ref:"output:h3studio/camera-retake.mp4",seconds:5,video_recipe:savedCameraRequest});
   selectOnly(retakeDraft.id);$("#retakeSettings").click();setRetakeMode("fixed");
   $("[data-vs-view=start] select",retakeForm).value="overhead";
   retakeForm.dispatchEvent(new Event("submit",{cancelable:true}));`);
 equal(evaluate('[node([...sel][0]).id===retakeDraft.id,retakeDraft.data.camera_plan,curV(retakeDraft).node_data.camera_plan]'),
   [true,{mode:'fixed',start:{angle:'overhead',scale:'medium'}},{mode:'move',start:{angle:'front',scale:'medium'},end:{angle:'rear',scale:'medium'}}],
   'adjusting a take uses its existing node and preserves the historical plan');
 evaluate('removeNodes([retakeDraft.id])');
 console.log('Camera retake DOM passed: structured source settings, optional text, and preserved node version.');
 const batchFetch=w.fetch, batchRequests=[];
 w.fetch=async(url,options)=>{
  if(String(url)!=="/api/generate") return batchFetch(url,options);
  const request=JSON.parse(options.body);batchRequests.push(request);
  const id="retake-batch-"+batchRequests.length;
  jobs.set(id,{state:"running",meta:{}});
  return {ok:true,text:async()=>JSON.stringify({ids:[id]})};
 };
 evaluate(`nodeAction(clipSource,"camera-retake");
   const retakePlayer=$("video",retakeForm);
   Object.defineProperty(retakePlayer,"readyState",{value:1,configurable:true});
   const setRetakeRange=(start,end)=>{retakeForm.elements.start.value=start;retakeForm.elements.end.value=end;
     retakeForm.elements.end.dispatchEvent(new Event("input"));};
   setRetakeRange(0,12);retakePlayer.currentTime=4;
   retakePlayer.dispatchEvent(new Event("timeupdate"));$("[data-retake-split]").click();
   $("[data-retake-remove]").click();$("[data-retake-add]").click();
   setRetakeRange(6,11);setRetakeMode("move");
   $("[data-vs-view=end] select",retakeForm).value="rear";
   retakeForm.elements.prompt.value="人物回头";
   const batchButtons=()=>$$("[data-retake-tabs] button");
   batchButtons()[0].click();
   $("[data-vs-view=start] select",retakeForm).value="overhead";
   setRetakeRange(0,7);`);
 equal(evaluate('[$("[data-vs-status]").textContent,$("[data-retake-generate]").disabled]'),
   ['重拍区间重叠，请调整入出点。',true],'overlap blocks the entire batch');
 evaluate('setRetakeRange(0,4);batchButtons()[1].click()');
 equal(evaluate('[retakeForm.elements.cameraMode.value,retakeForm.elements.prompt.value,$("[data-vs-view=end] select").value]'),
   ['move','人物回头','rear'],'switching intervals keeps the independent camera and notes');
 evaluate('$("[data-retake-generate]").click()');
 await ready('!$("#videoSegment").open && !queueing','retake batch submitted');
 equal(batchRequests.map(request=>[request.video_refs[0].ref,request.video_refs[0].start,request.video_refs[0].end,
   request.camera_plan.mode,request.camera_plan.start.angle,request.prompt]),[
   ['input:h3studio/reference1.mp4',0,4,'fixed','overhead',''],
   ['input:h3studio/reference1.mp4',6,11,'move','front','人物回头'],
 ],'batch creates and queues the selected source intervals in chronological order without filling gaps');
 evaluate('const batchIds=[...sel];removeNodes(batchIds);');
 delete w.document.querySelector('#videoSegment video').readyState;
 w.fetch=batchFetch;
 console.log('Multi-range retake DOM passed: split, add, remove, reject overlap, and submit each preserved plan.');
 evaluate(`nodeAction(clipSource,"object-replace");
   const objectPlayer=$("#videoSegment video"), overlay=$("[data-object-overlay]");
   Object.defineProperty(objectPlayer,"readyState",{value:1,configurable:true});
   objectPlayer.getBoundingClientRect=()=>({left:0,top:0,width:200,height:200});
   objectPlayer.currentTime=1;
   $("[data-object-mark]").click();
   overlay.onpointerdown({button:0,clientX:80,clientY:50,preventDefault:()=>{}});
   overlay.onpointermove({clientX:120,clientY:150});overlay.onpointerup({clientX:120,clientY:150});
   const objectForm=$("#videoSegment form");
   const replaceOption=[...$("[data-object-ref]").options].find(option=>option.value);
   $("[data-object-ref]").value=replaceOption.value;$("[data-object-ref]").dispatchEvent(new Event("change"));
   objectForm.dispatchEvent(new Event("submit",{cancelable:true}));
   const objectDraft=node([...sel][0]), objectRequest=videoReq(objectDraft,"");`);
 equal(evaluate('[objectRequest.mode,objectRequest.object_edit.action,objectRequest.object_edit.at,objectRequest.object_edit.replacement_ref===replaceOption.value]'),
   ['object_edit','replace',1,true],'the new node pins both the marked frame and the selected replacement reference');
 const objectBox=evaluate('objectRequest.object_edit.box');
 equal(objectBox.map(value=>+value.toFixed(3)),[.322,.25,.678,.75],'box coordinates are relative to the displayed video, not letterbox bars');
 const objectFetch=w.fetch, uploads=[];
 w.fetch=async(url,options)=>{
  if(String(url).startsWith('/api/library?board='))return {ok:true,text:async()=>JSON.stringify([
    {ref:'input:h3studio/library-prop.png',name:'蓝色花瓶'},{ref:'input:h3studio/library-video.mp4',name:'原片'}
  ])};
  if(String(url)!=='/api/upload')return objectFetch(url,options);
  return new Promise(resolve=>uploads.push({file:options.body.get('image'),resolve}));
 };
 evaluate('$("#objectSettings").click();');
 equal(evaluate('$("[data-object-ref]").value===replaceOption.value'),true,'reopening keeps the pinned replacement version');
 await ready('[...$("[data-object-ref]").options].some(option=>option.value==="input:h3studio/library-prop.png" && option.text==="蓝色花瓶")',
   'visible asset appears in the replacement picker');
 evaluate(`const chooseReplacement=ref=>{const el=$("[data-object-ref]");el.value=ref;el.dispatchEvent(new Event("change"));};
   const uploadReplacement=name=>{const field=$("[data-object-file]");
     Object.defineProperty(field,"files",{value:[new File(["fixture"],name,{type:"image/png"})],configurable:true});
     field.dispatchEvent(new Event("change"));};
   chooseReplacement("input:h3studio/library-prop.png");objectPlayer.currentTime=3;
   $("[data-object-locate]").click();uploadReplacement("candidate.png");`);
 equal(evaluate('[objectPlayer.currentTime,$("#videoSegment [type=submit]").disabled,$("[data-object-preview]").hidden]'),
   [1,true,false],'jumping back seeks to the marked frame, and an in-flight upload blocks submission');
 equal(uploads[0].file.name,'candidate.png','a replacement file is sent directly as a multipart image');
 uploads[0].resolve({ok:false,json:async()=>({error:'读不了这张图片'})});
 await ready('!$("[data-object-upload]").disabled','failed upload restored its picker');
 equal(evaluate('$("[data-object-ref]").value'),'input:h3studio/library-prop.png','failed upload preserves the selected asset');
 evaluate('uploadReplacement("orange-vase.webp");');
 uploads[1].resolve({ok:true,json:async()=>({ref:'input:h3studio/uploaded-vase.webp'})});
 await ready('$("[data-object-ref]").value==="input:h3studio/uploaded-vase.webp"','uploaded image is selected');
 evaluate('objectForm.dispatchEvent(new Event("submit",{cancelable:true}));$("#objectSettings").click();');
 equal(evaluate('[objectDraft.data.object_edit.replacement_ref,$("[data-object-ref]").selectedOptions[0].text,$("[data-object-preview]").hidden]'),
   ['input:h3studio/uploaded-vase.webp','orange-vase.webp',false],'upload saves the pinned reference and preview without adding a separate node');
 evaluate('uploadReplacement("late.png");closeSegmentEditor();$("#objectSettings").click();');
 uploads[2].resolve({ok:true,json:async()=>({ref:'input:h3studio/late.png'})});
 await new Promise(resolve=>setImmediate(resolve));
 equal(evaluate('$("[data-object-ref]").value'),'input:h3studio/uploaded-vase.webp','an upload from a closed editor cannot change a reopened draft');
 w.fetch=objectFetch;
 evaluate('closeSegmentEditor();removeNodes([objectDraft.id]);');
 delete w.document.querySelector('#videoSegment video').readyState;
 evaluate(`const addReviewCandidate=(target,name,start,end)=>{
   const ref="output:h3studio/"+name+".mp4";
   const recipe={...segmentRecipe,video_refs:[{...segmentRecipe.video_refs[0],start,end}]};
   addVersion(target,{ref,url:"/media?ref="+encodeURIComponent(ref),seconds:end-start,w:720,h:1280,video_recipe:recipe});
 };
 addReviewCandidate(segmentNode,"review-alternate",.25,4.25);
 addReviewCandidate(addNode("video",800,120),"review-overlap",3,7);
 addReviewCandidate(addNode("video",880,120),"review-later",6,10);
 $("#segmentReview video").pause=()=>{};
 nodeAction(clipSource,"segment-review");
 const reviewRows=()=>$$("#segmentReview [data-sr-list] select");
 const chooseReview=(row,index)=>{
   const select=reviewRows()[row];select.selectedIndex=index;select.dispatchEvent(new Event("change"));
 };
 chooseReview(0,2);chooseReview(2,1);chooseReview(1,1);`);
 equal(evaluate('[$("[data-sr-send]").disabled,$("[data-sr-status]").textContent.includes("重叠")]'),
   [true,true],'overlapping decisions cannot be saved or sent');
 evaluate('chooseReview(1,0);$("[data-sr-save]").click();nodeAction(segmentNode,"segment-review-parent");');
 equal(evaluate('reviewRows().map(select=>select.selectedIndex)'),[2,0,1],
   'the original version reopens with the saved decisions');
 evaluate('$("[data-sr-send]").click();');
 equal(evaluate('FILM.spec.clips.map(c=>[c.ref,c.in,c.out,c.tight])'),[
   ['input:h3studio/reference1.mp4',0,.25,true],
   ['output:h3studio/review-alternate.mp4',0,4,true],
   ['input:h3studio/reference1.mp4',4.25,6,true],
   ['output:h3studio/review-later.mp4',0,4,true],
   ['input:h3studio/reference1.mp4',10,12,true],
 ],'review builds a continuous timeline from exact source and selected versions');
 evaluate('$("#fmV").pause=$("#fmOriginal").pause=()=>{};closeFilm()');
 console.log('Segment review DOM passed: alternatives, overlap validation, saved decisions and continuous timeline.');
 evaluate(`nodeAction(clipSource,"segment-review");$("[data-sr-original-audio]").checked=true;
   $("[data-sr-save]").click();nodeAction(segmentNode,"segment-review-parent");`);
 equal(evaluate('$("[data-sr-original-audio]").checked'),true,'original audio choice stays with the pinned source version');
 evaluate('$("[data-sr-send]").click();');
 equal(evaluate('FILM.spec.clips.map(c=>[c.audio_ref,c.audio_start])'),[
   ['input:h3studio/reference1.mp4',0],
   ['input:h3studio/reference1.mp4',.25],
   ['input:h3studio/reference1.mp4',0],
   ['input:h3studio/reference1.mp4',6],
   ['input:h3studio/reference1.mp4',0],
 ],'the separate draft keeps the exact original audio offsets even when another audio choice already has a draft');
 evaluate('selectClip(1);$("#fmV").onloadedmetadata?.();');
 equal(evaluate('[$("#fmV").muted,$("#fmOriginal").currentTime]'),[true,.25],
   'preview mutes the replacement soundtrack and seeks the original audio to the edited interval');
 evaluate(`const setFilmRate=rate=>{const field=$("[data-clip-speed]");field.value=rate;field.dispatchEvent(new Event("change"));};
   setFilmRate(2);seekTimeline(1.25);$("#fmV").onloadedmetadata?.();`);
 equal(evaluate('[FILM.spec.clips[1].speed,filmTotal(FILM.spec),$("#fmV").playbackRate,$("#fmV").currentTime,$("#fmOriginal").playbackRate,$("#fmOriginal").currentTime]'),
   [2,10,2,2,2,2.25],'retimed film playhead and preserved source audio follow the same source position');
 evaluate('setFilmRate(3)');
 equal(evaluate('[$("[data-clip-speed]").value,FILM.spec.clips[1].speed]'),['2',2],'out-of-range retiming leaves the valid rate intact');
 evaluate(`FILM.spec.clips[1].subs=["前半段","后半段"];FILM.spec.clips[1].trans="fade";
   const durationBeforeSplit=filmTotal(FILM.spec);
   $("#fmV").currentTime=3.75;$("[data-split-clip]").click();
   if(FILM.spec.clips.length!==5)throw new Error("Split shortened an existing dissolve");
   $("#fmV").currentTime=2;$("[data-split-clip]").click();$("#fmV").onloadedmetadata?.();`);
 equal(evaluate(`[FILM.sel,filmTotal(FILM.spec)===durationBeforeSplit,
   FILM.spec.clips.slice(1,3).map(c=>[c.in,c.out,c.speed,c.audio_start,c.trans,c.subs]),
   $("#fmOriginal").currentTime]`),[2,true,[[0,2,2,.25,'cut',['前半段']],[2,4,2,.25,'fade',['后半段']]],2.25],
   'splitting on the sped-up playhead preserves the output duration, audio alignment and outgoing transition');
 evaluate('selectClip(0);$("#fmV").onloadedmetadata?.();');
 equal(evaluate('[$("#fmV").muted,$("#fmV").playbackRate]'),[false,1],'untouched clips use their own audio and normal speed');
 evaluate('closeFilm()');
 const captureFetch=w.fetch, frameRequests=[];
 w.fetch=async(url,options)=>{
  if(String(url)!=='/api/lastframe')return captureFetch(url,options);
  const request=JSON.parse(options.body);frameRequests.push(request);
  const ref='input:h3studio/frame-'+frameRequests.length+'.png';
  return {ok:true,text:async()=>JSON.stringify({ref,url:'/media?ref='+encodeURIComponent(ref),w:64,h:64,
    at:request.position==='first'?0:1.5,position:request.position})};
 };
 evaluate(`nodeAction(clipSource,"capture");$("#frameCapture video").pause=()=>{};
   $("[data-capture-position=first]").click();`);
 await ready('!$("#frameCapture").open','first frame capture closes picker');
 equal(evaluate('curV(node([...sel][0])).capture'),{
   source_node:evaluate('clipSource.id'),source_ref:'input:h3studio/reference1.mp4',position:'first',at:0
 },'camera modal preserves the exact capture source and timestamp');
 evaluate(`const standaloneCapture=newSpec([clipSource]);
   Object.assign(standaloneCapture.clips[0],{in:1,out:4,speed:.5});
   showFilm(standaloneCapture,null,filmDraftPrefix()+"capture-test");
   const filmCapturePlayer=$("#fmV");filmCapturePlayer.onloadedmetadata?.();
   Object.defineProperty(filmCapturePlayer,"readyState",{value:1,configurable:true});
   seekTimeline(1);$("[data-film-capture]").click();`);
 await ready('!FILM','playhead capture returns to the canvas');
 equal(frameRequests,[{ref:'input:h3studio/reference1.mp4',position:'first'},
   {ref:'input:h3studio/reference1.mp4',position:'time',at:1.5}],
   'the film capture submits the source clock of the retimed clip');
 equal(evaluate(`const captured=B.edges.find(e=>e.to===[...sel][0]);
   [captured.relation,captured.source_ref,captured.at]`),['capture','input:h3studio/reference1.mp4',1.5],
   'the inserted frame is connected to its source');
 delete w.document.querySelector('#fmV').readyState;
 w.fetch=captureFetch;
 console.log('Video capture DOM passed: choose the first frame or capture the retimed timeline playhead.');
 const trimFetch=w.fetch, trimCalls=[];
 w.fetch=async(url,options)=>{
  if (String(url)!=='/api/video/trim')return trimFetch(url,options);
  const request=JSON.parse(options.body);trimCalls.push(request);
  const result=request.action==='detect'?{cuts:[48,96]}:{clips:[
    {ref:'output:h3studio/trim1.mp4',url:'/media?ref=output%3Ah3studio%2Ftrim1.mp4',start:1,end:2,seconds:1,w:720,h:1280},
    {ref:'output:h3studio/trim2.mp4',url:'/media?ref=output%3Ah3studio%2Ftrim2.mp4',start:2,end:6,seconds:4,w:720,h:1280}
  ]};
  return {ok:true,text:async()=>JSON.stringify(result)};
 };
 evaluate(`nodeAction(clipSource,"trim-video");
   const trimForm=$("#videoTrim form"),trimPlayer=$("#videoTrim video");
   trimPlayer.pause=()=>{};
   trimForm.elements.start.value=1;trimForm.elements.end.value=6;
   trimForm.elements.end.dispatchEvent(new Event("input"));
   $("[data-trim-detect]").click();`);
 await ready('$$("[data-trim-cuts] button").length===2','detected cut points');
 evaluate(`$$("[data-trim-cuts] button")[1].click();
   Object.defineProperty(trimPlayer,"readyState",{value:1,configurable:true});
   trimPlayer.currentTime=3;$("[data-trim-split]").click();
   if($$("[data-trim-cuts] button")[1].textContent!=="3.00 秒 ×")throw new Error("Missing manual cut");
   $$("[data-trim-cuts] button")[1].click();
   trimForm.dispatchEvent(new Event("submit",{cancelable:true}));`);
 await ready('!$("#videoTrim").open','trim results placed on the canvas');
 equal(trimCalls.map(call=>[call.action,call.points]),[['detect',[24,144]],['render',[24,48,144]]],
   'trimming submits only the adopted cut points');
 equal(evaluate(`[...sel].map(id=>{const out=node(id), edge=B.edges.find(e=>e.to===id);
   return [curV(out).ref,edge.from===clipSource.id,edge.relation,edge.source_ref,edge.start,edge.end];})`),[
   ['output:h3studio/trim1.mp4',true,'trim','input:h3studio/reference1.mp4',1,2],
   ['output:h3studio/trim2.mp4',true,'trim','input:h3studio/reference1.mp4',2,6],
 ],'both outputs are related to the original media version');
 console.log('Video trim DOM passed: detected and manual cuts, selective export and pinned source links.');
 w.fetch=trimFetch;
 const gifFetch=w.fetch,gifCalls=[],gridGifCalls=[];
 const gifResult={ref:'output:h3studio/gif_test.gif',width:256,height:144,seconds:1.75,size_bytes:4800};
 w.fetch=async(url,opts)=>{
   if(String(url)==='/api/video/gif')gifCalls.push(JSON.parse(opts.body));
   else if(String(url)==='/api/image/gif')gridGifCalls.push(JSON.parse(opts.body));
   else return gifFetch(url,opts);
   return {ok:true,text:async()=>JSON.stringify(gifResult)};
 };
 evaluate(`const gifBefore=JSON.stringify(B.nodes);
   ctxMenu({target:els.get(clipSource.id),clientX:140,clientY:120});$("#ctxMenu [data-a=gif-export]").click();
   const gifForm=$("#videoGif form"),gifVideo=$("video",gifForm);
   gifVideo.pause=()=>{};
   gifForm.elements.start.value=1;
   gifForm.elements.end.value=2;
   gifForm.elements.size.value=256;gifForm.elements.fps.value=8;gifForm.elements.pingPong.checked=true;
   gifForm.dispatchEvent(new Event("input",{bubbles:true}));
   gifForm.dispatchEvent(new Event("submit",{cancelable:true}));`);
 await ready('!$("#videoGif .gif-preview").hidden','GIF preview and download appear');
 equal(gifCalls,[{ref:'input:h3studio/reference1.mp4',start:1,end:2,fps:8,size:256,ping_pong:true}],
   'the canvas GIF export uses the pinned source, range and loop settings');
 equal(evaluate(`[$("#videoGif a").download,$("#videoGif .gif-preview img").getAttribute("src"),JSON.stringify(B.nodes)===gifBefore]`),
   ['gif_test.gif','/media?ref=output%3Ah3studio%2Fgif_test.gif',true]);
 assert.match(evaluate(`acResultCards(${JSON.stringify({gif:gifResult})})`),/下载 GIF/);
 evaluate(`const gifPublish=$("[data-gif-publish]",gifForm);
   if(gifPublish.hidden)throw new Error("The owner cannot publish a generated GIF");
   gifForm.elements.end.value=1.1;gifForm.dispatchEvent(new Event("input",{bubbles:true}));
   if(!$("button[type=submit]",gifForm).disabled||!$("#videoGif .gif-preview").hidden)throw new Error("Invalid interval still exportable");
   gifForm.elements.end.value=2;gifForm.dispatchEvent(new Event("input",{bubbles:true}));
   gifForm.dispatchEvent(new Event("submit",{cancelable:true}));`);
 await ready('!$("#videoGif .gif-preview").hidden','GIF preview shows publication action');
 evaluate(`const savedGifShareOpen=shareOpen, savedGifShowcaseChange=changeShowcase, capturedGifPublication=[];
   const oldGifShare=[$("#canvasShare").hidden,$("#shareShowcase").disabled];
   shareOpen=async()=>{$("#canvasShare").hidden=false;$("#shareShowcase").disabled=false;};
   changeShowcase=(...args)=>capturedGifPublication.push(args);
   gifPublish.click();`);
 await ready('$("#shareShowcaseVideo").value==="gif-export"','the publication form opens on the rendered GIF');
 equal(evaluate('[$("#videoGif").open,$("#shareShowcaseVideoFile").required,$("#shareShowcaseAttachPrompt").checked]'),
   [false,false,false],'the export handoff preserves GIF selection and leaves prompt opt-in disabled');
 evaluate(`$("#shareShowcaseForm").dispatchEvent(new Event("submit",{cancelable:true}));`);
 equal(evaluate('[capturedGifPublication[0][2].gif_ref,capturedGifPublication[0][2].video,capturedGifPublication[0][2].public_prompt]'),
   ['output:h3studio/gif_test.gif',null,null]);
 evaluate(`shareOpen=savedGifShareOpen;changeShowcase=savedGifShowcaseChange;
   $("#canvasShare").hidden=oldGifShare[0];$("#shareShowcase").disabled=oldGifShare[1];$("#shareShowcaseForm").hidden=true;`);
 evaluate(`const gifGridSource=node("n1"), gifGridRef=curV(gifGridSource).ref, beforeGridGif=JSON.stringify(B.nodes);
   ctxMenu({target:els.get(gifGridSource.id),clientX:140,clientY:120});
   $("#ctxMenu [data-a=gif-export]").click();`);
 equal(evaluate('[$("#videoGifTitle").textContent,gifVideo.hidden,$$("[data-gif-cells] span").length,gifForm.elements.fps.value]'),
  ['宫格生成 GIF',true,16,'8']);
 evaluate(`for(const [name,value] of [["rows",2],["cols",3],["first",2],["last",5]]){
   const field=gifForm.elements[name];field.value=value;field.dispatchEvent(new Event("input",{bubbles:true}));
  }`);
 equal(evaluate('$$("[data-gif-cells] [data-selected]").map(cell=>cell.textContent)'),['2','3','4','5']);
 evaluate(`gifForm.dispatchEvent(new Event("submit",{cancelable:true}));`);
 await ready('!$("#videoGif .gif-preview").hidden','the image grid GIF result is available');
 equal(gridGifCalls,[{ref:evaluate('gifGridRef'),rows:2,cols:3,first:2,last:5,fps:8,size:360,ping_pong:false}],
  'image GIF uses the agreed row-major range and exact canvas version');
 assert.equal(evaluate('JSON.stringify(B.nodes)===beforeGridGif'),true);
 evaluate('closeVideoGif()');
 w.fetch=gifFetch;
 console.log('GIF export DOM passed: video interval, image grid, preview, download, publication and assistant result card.');
 evaluate(`const beforeModelOptions=snap(), previousVideoServices=CAPS_LIST.video;
  CAPS_LIST.video=[{id:"h3-fixture",kind:"minimax",name:"云端 H3",default:true,
                    model:"MiniMax-H3",default_route_model:"MiniMax-H3-Max",
                    models:[{id:"MiniMax-H3",durations:[4,5,15],qualities:{std:"768P",hd:"2K"}},
                            {id:"MiniMax-H3-Max",durations:[5,15],qualities:{std:"480P",hd:"768P"}}]},
                   {id:"flash-fixture",kind:"kling",name:"可灵 Flash",model:"kling-4.0-flash",
                    models:[{id:"kling-4.0-flash",durations:[3,20],qualities:{std:"720p"}}]},
                   {id:"ark-endpoint",kind:"ark",name:"方舟接入点",model:"ep-example",
                    models:[{id:"ep-example",endpoint_model:"doubao-seedance-2-5",durations:[5,15,30],
                             qualities:{std:"720p",hd:"1080p","4k":"4k"}}]}];
  const optionsVideo=addNode("video",420,90,{prompt:"测试可用选项",duration:4,quality:"hd"});
  selectOnly(optionsVideo.id);`);
 equal(evaluate(`[$("#ctl select[data-k=duration]").value, $("#ctl select[data-k=quality]").selectedOptions[0].textContent,
  videoReq(optionsVideo,"测试").duration]`),['5','768P',5]);
 evaluate(`optionsVideo.data.provider="flash-fixture";optionsVideo.data.duration=23;showPanel();`);
 equal(evaluate(`[$("#ctl select[data-k=duration]").value,!!$("#ctl select[data-k=quality]"),
  videoReq(optionsVideo,"测试").duration,videoReq(optionsVideo,"测试").quality]`),['20',false,20,'std']);
 evaluate(`Object.assign(optionsVideo.data,{provider:"ark-endpoint",selected_model:"ep-example",duration:30,quality:"4k"});showPanel();`);
 equal(evaluate(`[$("#ctl select[data-k=selected_model]").selectedOptions[0].textContent,
  $("#ctl select[data-k=quality]").value,videoReq(optionsVideo,"测试").duration]`),
  ['ep-example · doubao-seedance-2-5','4k',30]);
 evaluate('CAPS_LIST.video=previousVideoServices;restore(beforeModelOptions)');
 console.log('Video model settings passed: configured default model, provider-specific durations and single-resolution submission.');
 const checkedPreviewFetch=w.fetch, checkedSubmissions=[], modelChecks=[];
 let rejectPreview=false;
 w.fetch=async(url,options)=>{
  const path=String(url);
  if(path==="/api/preview" && rejectPreview)return {ok:false,text:async()=>JSON.stringify({error:"参考视频超过 15 秒"})};
  if(path==="/api/preview")return {ok:true,text:async()=>JSON.stringify({
    reference_preview:"a".repeat(64),prompt:"采用资产里的图片和音频",mode:"全模态参考",inputs:[]})};
  if(path==="/api/video/reference-models"){
   modelChecks.push(JSON.parse(options.body));
   return {ok:true,text:async()=>JSON.stringify({counts:{images:1,videos:1,audio:1},models:[
    {provider:"方舟",provider_id:"ark-model",model:"seedance-short",duration:10,quality:"hd",resolution:"1080p",
     limits:{images:9,videos:3,audio:3,seconds:15},error:"参考视频超过 15 秒"},
    {provider:"方舟",provider_id:"ark-model",model:"seedance-long",duration:10,quality:"hd",resolution:"1080p",
     limits:{images:30,videos:10,audio:10,seconds:30},video_seconds:16,audio_seconds:3,draft:false},
   ]})};
  }
  if(path!=="/api/generate")return checkedPreviewFetch(url,options);
  const req=JSON.parse(options.body), jobId="checked-reference-"+checkedSubmissions.length;
  checkedSubmissions.push(req);
  jobs.set(jobId,{state:"error",error:"模拟停止"});
  return {ok:true,text:async()=>JSON.stringify({ids:[jobId]})};
 };
 evaluate(`const beforeCheckedPreview=snap(), checkedVideo=addNode("video",450,90,{prompt:"按 @样品素材 动作"});
  selectOnly(checkedVideo.id);`);
 await evaluate("previewPrompt(checkedVideo)");
 evaluate("closePromptPreview()");
 await evaluate("generate(checkedVideo)");
 await ready("!checkedVideo.job","preview-bound generation finished",350);
 assert.equal(checkedSubmissions[0].reference_preview,"a".repeat(64));
 evaluate('checkedVideo.data.duration=10');
 await evaluate("generate(checkedVideo)");
 await ready("!checkedVideo.job","edited request finished",350);
 assert.equal(Object.hasOwn(checkedSubmissions[1],"reference_preview"),false);
 rejectPreview=true;
 await evaluate("previewPrompt(checkedVideo)");
 assert.match(evaluate('$("#pvm").textContent'),/预览失败.*超过 15 秒/);
 evaluate('$("#pvModelCheck").click()');
 await ready('$("#pvModelStatus").textContent==="1 / 2 个模型可用"','failed previews still offer model compatibility checks');
 assert.equal(modelChecks[0].prompt,"按 @样品素材 动作");
 equal(evaluate('[$$("#pvModelList button").length,$$("#pvModelList li")[0].textContent.includes("超过 15 秒"),$("#pvModelList").textContent.includes("16/30 秒")]'),
  [1,true,true],'model reports show limits and only valid choices can be applied');
 rejectPreview=false;
 evaluate('$("#pvModelList button").click()');
 await ready('$("#pvm").textContent==="全模态参考"','selected model is set and previewed again');
 equal(evaluate('[checkedVideo.data.provider,checkedVideo.data.selected_model,checkedVideo.data.duration,checkedVideo.data.quality]'),
  ['ark-model','seedance-long',10,'hd']);
 assert.equal(checkedSubmissions.length,2,'checking or applying a model does not submit');
 evaluate('closePromptPreview()');
 evaluate("restore(beforeCheckedPreview)");
 w.fetch=checkedPreviewFetch;
 console.log('Mixed reference preview passed: submitting reviewed assets is pinned until the node inputs change.');
 const nativeDraftFetch=w.fetch, nativeDraftReq=[];
 let branchTransportFailure=true, branchProviderFailure=true;
 w.fetch=async(url,opts)=>{
   const path=String(url);
   if(!['/api/generate','/api/video/draft/finalize'].includes(path))return nativeDraftFetch(url,opts);
   const payload=JSON.parse(opts.body);nativeDraftReq.push(payload);
   const branch=path==='/api/video/draft/finalize'&&payload.resolution==="1080p";
   if(branch&&branchTransportFailure){branchTransportFailure=false;throw new Error("连接中断");}
   const id=path==='/api/generate'?'native-draft':branch?'native-branch':'native-final';
   if(branch&&branchProviderFailure){
     branchProviderFailure=false;
     jobs.set(id,{state:'error',error:'定稿任务失败'});
     return {ok:true,text:async()=>JSON.stringify({ids:[id]})};
   }
   const ref='output:h3studio/'+id+'.mp4';
   jobs.set(id,{state:'done',meta:{mode_name:id,provider:'fixture'},outputs:[{ref,url:'/media?ref='+encodeURIComponent(ref),
     meta:{width:720,height:1280,duration:5},...(id==='native-draft'?{extra:{draft_expires:Date.now()/1000+600}}:{})}]});
   return {ok:true,text:async()=>JSON.stringify({ids:[id]})};
 };
 evaluate(`CAPS_LIST.default_video_draft=true;
   const nativeDraftNode=addNode("video",420,90,{prompt:"原始样片提示"});
   selectOnly(nativeDraftNode.id);
   const draftCtl=$("#ctl select[data-k=draft]");draftCtl.value="true";draftCtl.dispatchEvent(new Event("change"));
   $("#send").click();`);
 await ready('nativeDraftNode.versions.length===1','native sample available',250);
 equal(evaluate('[$(".badge",els.get(nativeDraftNode.id)).textContent,curV(nativeDraftNode).video_recipe.draft]'),
   ['480p 样片',true],'the native sample is labeled and preserves its generation recipe');
 evaluate(`nativeDraftNode.data.prompt="新的未提交提示";
   nodeAction(nativeDraftNode,"draft-final");
   const draftFinalForm=$("#videoDraftFinal form");
   draftFinalForm.elements.resolution.value="4k";
   draftFinalForm.dispatchEvent(new Event("submit",{cancelable:true}));`);
 await ready('nativeDraftNode.versions.length===2','final video is appended to the sample node',250);
 equal([nativeDraftReq[0].draft,nativeDraftReq[1].ref,nativeDraftReq[1].resolution,Object.hasOwn(nativeDraftReq[1],'prompt')],
   [true,'output:h3studio/native-draft.mp4','4k',false],'final requests pin only the chosen sample and resolution');
 equal(evaluate(`[nativeDraftNode.cur,$(".badge",els.get(nativeDraftNode.id)).textContent,curV(nativeDraftNode).prompt,
   !!nativeDraftNode.data.draft]`),[1,'4K 定稿','原始样片提示',false],
   'the final version uses the older saved prompt and can be compared in place');
 evaluate(`const comparisonBefore=snap(), compareVideos=$$("#videoCompare video");
   compareVideos.forEach((video,i)=>{
     Object.defineProperty(video,"duration",{value:i?6:5});
     video.play=async()=>{video.dataset.playing="yes";};
     video.pause=()=>{video.dataset.playing="no";};
   });
   $("#ntools [data-a=compare-video]").click();
   compareVideos[0].dispatchEvent(new Event("loadedmetadata"));`);
 equal(evaluate('[videoCompare.open,...compareVersions.map(s=>s.value),compareTime.max,...compareVideos.map(v=>v.muted)]'),
   [true,'0','1','5',true,false],'previous and current versions share the shorter timeline, with sound on the current side');
 evaluate('compareTime.value="2.5";compareTime.dispatchEvent(new Event("input"));comparePlay.click()');
 equal(evaluate('compareVideos.map(v=>[v.currentTime,v.dataset.playing])'),[[2.5,'yes'],[2.5,'yes']],
   'shared seek and play affect both sides');
 evaluate('compareVideos[0].currentTime=5;compareVideos[0].dispatchEvent(new Event("timeupdate"));');
 equal(evaluate('compareVideos.map(v=>[v.currentTime,v.dataset.playing])'),[[5,'no'],[5,'no']],
   'both players stop when the shorter version ends');
 evaluate(`compareVersions[0].value="1";compareVersions[0].dispatchEvent(new Event("change"));
   compareAudio.value="left";compareAudio.dispatchEvent(new Event("change"));`);
 equal(evaluate('[...compareVersions.map(s=>s.value),...compareVideos.map(v=>v.muted),snap()===comparisonBefore]'),
   ['1','0',false,true,true],'swapping previews and their sound leaves canvas history and settings intact');
 evaluate(`$("[data-compare-close]").click();nodeAction(nativeDraftNode,"full");$("[data-light-compare]").click()`);
 equal(evaluate('[videoCompare.open, !!$("#light.on")]'),[true,false],'fullscreen offers the same comparison');
 evaluate('$("[data-compare-close]").click()');
 evaluate('lightbox(nativeDraftNode.versions[0],nativeDraftNode);$("[data-light-draft-final]").click()');
 equal(evaluate('[$("#videoDraftFinal").open,$("[data-draft-name]").textContent.endsWith("版本 1"),nativeDraftNode.cur]'),
  [true,true,1],'finalizing from a historical preview pins that sample without changing the active tab');
 evaluate('closeVideoDraftFinal()');
 evaluate('switchVersion(nativeDraftNode,0);');
 equal(evaluate('[nativeDraftNode.data.draft,!!$("#ntools [data-a=draft-final]")]'),[true,true],
   'switching back restores the original sample controls');
 evaluate(`const sourceBeforeBranch=JSON.stringify(nativeDraftNode);
   openVideoDraftFinal(nativeDraftNode);draftFinalForm.elements.placement.value="branch";
   draftFinalForm.dispatchEvent(new Event("submit",{cancelable:true}));`);
 await ready('$("[data-draft-status]").textContent==="连接中断"','a failed transport leaves the same finalization available to retry');
 evaluate('closeVideoDraftFinal();openVideoDraftFinal(nativeDraftNode)');
 assert.equal(evaluate('draftFinalForm.elements.placement.value'),"branch");
 evaluate('draftFinalForm.dispatchEvent(new Event("submit",{cancelable:true}))');
 await ready('B.nodes.some(n=>draftFinalEdge(n)?.from===nativeDraftNode.id&&!n.job)','a confirmed provider failure keeps its branch',250);
 evaluate(`const failedDraftBranch=B.nodes.find(n=>draftFinalEdge(n)?.from===nativeDraftNode.id);
   switchVersion(nativeDraftNode,1,{recordUndo:false});selectOnly(failedDraftBranch.id);
   ctxMenu({target:els.get(failedDraftBranch.id),clientX:140,clientY:120});
   $("#ctxMenu [data-a=draft-final]").click();`);
 equal(evaluate('[draftFinalForm.elements.placement.disabled,$("[data-draft-name]").textContent.endsWith("版本 1")]'),[true,true],
   'retry from the branch locks its placement and finds the pinned sample even after switching tabs');
 evaluate('draftFinalForm.dispatchEvent(new Event("submit",{cancelable:true}))');
 await ready('B.nodes.some(n=>curV(n)?.ref==="output:h3studio/native-branch.mp4")','final branch appears next to the sample',250);
 equal(nativeDraftReq[2],nativeDraftReq[3],'retry preserves the same provider job key and pinned sample');
 assert.notEqual(nativeDraftReq[3].request_key,nativeDraftReq[4].request_key,'a confirmed provider failure needs a new request key');
 equal([nativeDraftReq[4].node,nativeDraftReq[4].ref],[nativeDraftReq[3].node,nativeDraftReq[3].ref]);
 assert.equal(evaluate('curV(failedDraftBranch)?.ref'),'output:h3studio/native-branch.mp4','provider retry completes in the original branch');
 evaluate('switchVersion(nativeDraftNode,0,{recordUndo:false})');
 equal(evaluate(`(()=>{const branch=B.nodes.find(n=>curV(n)?.ref==="output:h3studio/native-branch.mp4");
   const edge=B.edges.find(e=>e.to===branch.id&&e.from===nativeDraftNode.id);
   return [JSON.stringify(nativeDraftNode)===sourceBeforeBranch,branch.x>nativeDraftNode.x+size(nativeDraftNode).w,
     sel.has(branch.id),edge.relation,edge.ref,videoInputs(branch).length,curV(branch).draft_final.source_node===nativeDraftNode.id];})()`),
   [true,true,true,"draft_final","output:h3studio/native-draft.mp4",0,true]);
 evaluate(`switchVersion(nativeDraftNode,1,{recordUndo:false});
   selectOnly(failedDraftBranch.id);$("#ntools [data-a=compare-draft]").click()`);
 equal(evaluate(`[videoCompare.open,$("#videoCompareTitle").textContent,...compareVersions.map(s=>s.disabled),
   ...compareVideos.map(v=>decodeURIComponent(v.src).split("ref=").at(-1)),nativeDraftNode.cur]`),
  [true,"对比样片与定稿",true,false,"output:h3studio/native-draft.mp4","output:h3studio/native-branch.mp4",1],
  'the branch opens a synchronized view with its exact sample and the explicitly selected final');
 evaluate('$("[data-compare-close]").click();lightbox(nativeDraftNode.versions[0],nativeDraftNode);$("[data-light-compare-draft]").click()');
 equal(evaluate('compareVersions[1].options.length'),2,'a historical sample preview can choose among both final results');
 evaluate(`$("[data-compare-close]").click();vtSplit(nativeDraftNode.id,0);
   const movedSample=B.nodes.find(n=>n.id!==nativeDraftNode.id&&curV(n)?.draft_expires);
   const sourceAfterSplit=()=>draftVideoComparison(node(failedDraftBranch.id),curV(node(failedDraftBranch.id))).source.node.id;`);
 equal(evaluate(`[sourceAfterSplit(),B.edges.find(e=>e.to===failedDraftBranch.id&&e.relation==="draft_final").from,
    curV(node(failedDraftBranch.id)).draft_final.source_node]`),
   [evaluate('movedSample.id'),evaluate('movedSample.id'),evaluate('movedSample.id')],
   'moving the sample tab updates comparison, the canvas link and the saved final provenance');
 evaluate('undo()');
 evaluate(`const draftBranchNode=B.nodes.find(n=>curV(n)?.ref==="output:h3studio/native-branch.mp4");
   duplicate([nativeDraftNode.id,draftBranchNode.id]);`);
 equal(evaluate(`(()=>{const [sample,final]=[...sel].map(node);return [
   curV(final).draft_final.source_node===sample.id,B.edges.some(e=>e.from===sample.id&&e.to===final.id&&e.relation==="draft_final")];})()`),
   [true,true],'duplicating the pair preserves the copied sample as the finalization source');
 evaluate('undo()');
 evaluate('undo();CAPS_LIST.default_video_draft=false');
 assert.equal(evaluate('B.nodes.some(n=>curV(n)?.ref==="output:h3studio/native-branch.mp4")'),false);
 evaluate('removeNodes([nativeDraftNode.id])');
 w.fetch=nativeDraftFetch;
 console.log('Video draft and comparison DOM passed: tab and branch finalization, retry, provenance, undo and synchronized comparison.');
 const editTimelineFetch=w.fetch, timelineRequests=[], captionRequests=[];
 let editTimelineFails=true;
 w.fetch=async(url,options)=>{
   const route=String(url);
   if(!['/api/render/check','/api/render','/api/video/captions'].includes(route))return editTimelineFetch(url,options);
   const payload=JSON.parse(options.body);
   if(route==='/api/video/captions'){
     captionRequests.push(payload);
     return {ok:true,text:async()=>JSON.stringify({captions:[{start:1.5,end:2.5,text:'识别到的台词'}]})};
   }
   if(route.endsWith('/check')) return {ok:true,text:async()=>JSON.stringify({ok:true,dimensions:[720,1280]})};
   timelineRequests.push(payload);
   const id='timeline-edit-'+timelineRequests.length, ref='output:h3studio/timeline-edit.mp4';
   jobs.set(id,editTimelineFails ? {state:'error',error:'模拟渲染失败'} : {state:'done',meta:{mode_name:'成片'},
     outputs:[{ref,url:'/media?ref='+encodeURIComponent(ref),meta:{width:720,height:1280,duration:2}}]});
   return {ok:true,text:async()=>JSON.stringify({ids:[id]})};
 };
 evaluate(`const editTimelineNode=addNode("video",420,90,{prompt:"原视频的提示词"});
   editTimelineNode.versions=[{ref:"input:h3studio/timeline-input.mp4",url:"/media?ref=input:h3studio/timeline-input.mp4",w:720,h:1280,seconds:8}];
   editTimelineNode.cur=0;
   const editTimelineEdge={from:"n1",to:editTimelineNode.id,role:"first"};
   B.edges.push(editTimelineEdge);render(editTimelineNode);selectOnly(editTimelineNode.id);
   const beforeTimelineCount=B.nodes.length;
   $("#ntools [data-a=film]").click();
   Object.assign(FILM.spec.clips[0],{in:1,out:5,speed:2,subs:["测试字幕"]});
   closeFilm();resumeFilmDraft();`);
 equal(evaluate(`[$("#fmGo").textContent,FILM.target.ref,FILM.spec.clips[0].speed]`),
   ['导出为新版本','input:h3studio/timeline-input.mp4',2],'resuming a timeline preserves its original version and in-place export');
 evaluate('$("#fmV").onloadedmetadata?.();$("[data-film-transcribe]").click()');
 await ready('!!$("[data-cue-text]")','timed subtitle editing is available');
 equal(captionRequests,[{board:'btest',ref:'input:h3studio/timeline-input.mp4',in:1,out:5}],'caption generation uses the pinned source and only its selected range');
 evaluate(`const cueText=$("[data-cue-text]"), cueEnd=$("[data-cue-time=end]");
   cueText.value="修正后的台词";cueText.dispatchEvent(new Event("change"));
   cueEnd.value="2.25";cueEnd.dispatchEvent(new Event("change"));
   $("[data-cue-seek]").click();previewTick();`);
 equal(evaluate('[$("#fmV").currentTime,$("#fmSub").textContent]'),[1.5,'修正后的台词'],
   'seeking to the caption displays the edited text at the matching source time');
 evaluate(`$("[data-b=title]").click();
   const titleText=$("[data-title-key=text]"), titleEnd=$("[data-title-key=end]"), titleStyle=$("[data-title-key=style]");
   titleText.value="第一幕 · <站台>";titleText.dispatchEvent(new Event("input"));
   titleEnd.value=".75";titleEnd.dispatchEvent(new Event("change"));
   titleStyle.value="label";titleStyle.dispatchEvent(new Event("change"));
   $("[data-title-jump]").click();$("#fmV").onloadedmetadata?.();previewTick();`);
 equal(evaluate(`[FILM.spec.titles[0].start,$("#fmV").currentTime,$("#fmTitleLayer span").textContent,
   $("#fmTitleLayer span").dataset.style,!!$("#fmTitleLayer img")]`),[.25,1.5,'第一幕 · <站台>','label',false],
   'the title track seeks by output time on a retimed clip and escapes the preview text');
 evaluate(`const savedInsertRef=curV(node("n1")).ref;
   const cutawayPicker=$("#fmCutawaySource");cutawayPicker.value="n1";cutawayPicker.dispatchEvent(new Event("change"));
   const cutawayEnd=$("[data-cutaway-key=duration]");cutawayEnd.value=".5";cutawayEnd.dispatchEvent(new Event("change"));
   $("[data-cutaway-jump]").click();$("#fmV").onloadedmetadata?.();previewTick();
   const cutawayFixture=$("#fmCutawayLayer img");Object.defineProperty(cutawayFixture,"complete",{value:true});
   cutawayFixture.onload();`);
 equal(evaluate(`[FILM.spec.cutaways[0].start,$("#fmV").currentTime,$("#fmCutawayLayer").hidden,
   $("#fmCutawayLayer img").src.endsWith(encodeURIComponent(savedInsertRef)),$("#fmTitleLayer span").textContent]`),
   [.25,1.5,false,true,'第一幕 · <站台>'],'a pinned picture covers the main video at the output time without replacing its title or playhead');
 evaluate('seekTimeline(1);$("#fmV").onloadedmetadata?.();previewTick()');
 equal(evaluate('$("#fmTitleLayer").childElementCount'),0,'the title disappears after its configured end');
 equal(evaluate('[$("#fmCutawayLayer").hidden,$("#fmCutawayLayer").childElementCount]'),[true,0],
   'the preview returns to the main picture after the cutaway');
 evaluate('$("#fmGo").click()');
 await ready('!FILM && !editTimelineNode.job','the failed edit job settles for retry',250);
 equal(evaluate('[editTimelineNode.cur,editTimelineNode.versions.length,B.nodes.length===beforeTimelineCount,!!editTimelineNode.data.film]'),
   [0,1,true,false],'a failed export leaves the current version and node type intact');
 editTimelineFails=false;
 evaluate('resumeFilmDraft();$("#fmGo").click()');
 await ready('editTimelineNode.versions.length===2','the video edit appears as a new version',300);
 equal(evaluate(`[editTimelineNode.cur,curV(editTimelineNode).source,curV(editTimelineNode).mode,
   B.nodes.length===beforeTimelineCount,editTimelineNode.data.prompt,!!editTimelineNode.data.film,
   B.edges.filter(e=>e.to===editTimelineNode.id).map(e=>e.from)]`),
   [1,'film','剪辑',true,'原视频的提示词',false,['n1']],'a completed edit appends to the original node and preserves its inputs');
 equal(timelineRequests.map(r=>[r.spec.clips[0].ref,r.spec.clips[0].in,r.spec.clips[0].out,r.spec.clips[0].speed]),
   Array.from({length:2},()=>['input:h3studio/timeline-input.mp4',1,5,2]),'the render and retry use the pinned input and its edited range');
 assert.notEqual(timelineRequests[0].request_key,timelineRequests[1].request_key,'a confirmed failure can submit a fresh render');
 equal(timelineRequests[1].spec.clips[0].captions,[{start:1.5,end:2.25,text:'修正后的台词'}],
   'the edited caption is sent through to the renderer');
 equal(timelineRequests[1].spec.titles,[{start:.25,end:.75,text:'第一幕 · <站台>',position:'center',style:'label'}],
   'the title is pinned to the film timeline through failure recovery and export');
 equal(timelineRequests[1].spec.cutaways,[{node:'n1',ref:evaluate('savedInsertRef'),kind:'image',start:.25,duration:.5,in:0,
   name:evaluate('node("n1").name'),version:evaluate('node("n1").cur+1')}],
   'render requests preserve the cutaway range and exact source version');
 evaluate(`nodeAction(editTimelineNode,"full");
   $$("#light .light-actions button").find(button=>button.textContent==="剪辑视频").click();
   $("#fmV").onloadedmetadata?.();`);
 equal(evaluate('[FILM.spec.clips[0].ref,FILM.spec.clips[0].subs,!!$("[data-update-version]")]'),
   ['input:h3studio/timeline-input.mp4',['测试字幕'],false],'the new version reopens its source timeline and subtitles');
 equal(evaluate('[$("[data-cue-text]").value,$("[data-cue-time=end]").value]'),['修正后的台词','2.25'],
   'the exported version preserves the editable caption track');
 equal(evaluate('$("[data-title-key=text]").value'),'第一幕 · <站台>','the exported version preserves its editable title');
 equal(evaluate('[FILM.spec.cutaways[0].ref,$("[data-cutaway-key=duration]").value]'),[evaluate('savedInsertRef'),'0.5'],
   'the exported version retains its editable cutaway track');
 evaluate('closeFilm();switchVersion(editTimelineNode,0);removeNodes([editTimelineNode.id]);');
 evaluate(`openAddMenu(60,80,{at:{x:100,y:100}});$("#addMenu [data-add=playlist]").click();
   const emptyPlaylist=node([...sel][0]);$("[data-open-playlist]",els.get(emptyPlaylist.id)).click();`);
 equal(evaluate('[emptyPlaylist.data.film.clips.length,FILM.n.id===emptyPlaylist.id,$("#fmGo").disabled]'),
   [0,true,true],'an empty playlist opens directly with export disabled');
 evaluate(`const playlistInputs=[0,1].map(i=>{
     const video=addNode("video",950+i*500,100);
     const ref="input:h3studio/playlist-source-"+i+".mp4";
     video.versions.push({ref,url:"/media?ref="+encodeURIComponent(ref),w:640,h:360,seconds:4});
     video.cur=0;render(video);return video;
   });
   $("#fmTl .fadd").click();$("#fmAdd [data-id='"+playlistInputs[0].id+"']").click();
   $("#fmSaveList").click();closeFilm();`);
 equal(evaluate('emptyPlaylist.data.film.clips.map(c=>c.ref)'),['input:h3studio/playlist-source-0.mp4'],
   'adding and saving an empty playlist writes the pinned source into the canvas');
 evaluate(`const draggedPlaylistSource=playlistInputs[1], sourcePosition=[draggedPlaylistSource.x,draggedPlaylistSource.y];
   const playlistFrom=[B.view.x+draggedPlaylistSource.x*B.view.k,B.view.y+draggedPlaylistSource.y*B.view.k];
   const playlistTo=[B.view.x+emptyPlaylist.x*B.view.k,B.view.y+emptyPlaylist.y*B.view.k];
   $(".lbl",els.get(draggedPlaylistSource.id)).dispatchEvent(new MouseEvent("pointerdown",{button:0,clientX:playlistFrom[0],clientY:playlistFrom[1],bubbles:true}));
   dispatchEvent(new MouseEvent("pointermove",{clientX:playlistTo[0],clientY:playlistTo[1]}));
   if(!els.get(emptyPlaylist.id).classList.contains("playlist-drop-target"))throw new Error("Missing playlist drop indication");
   dispatchEvent(new MouseEvent("pointerup",{clientX:playlistTo[0],clientY:playlistTo[1]}));`);
 equal(evaluate(`[draggedPlaylistSource.x===sourcePosition[0],draggedPlaylistSource.y===sourcePosition[1],emptyPlaylist.data.film.clips.map(c=>c.ref)]`),
   [true,true,['input:h3studio/playlist-source-0.mp4','input:h3studio/playlist-source-1.mp4']],
   'dropping onto the playlist adds a pinned clip while leaving its source in place');
 evaluate(`sel=new Set(playlistInputs.map(n=>n.id));updateSel();$("#selectionTools [data-action=playlist]").click();
   const savedPlaylist=node([...sel][0]);nodeAction(savedPlaylist,"playlist-open");
   const transfer={getData:()=>"1"}, move=new Event("drop",{cancelable:true});Object.defineProperty(move,"dataTransfer",{value:transfer});
   $("#fmTl .fc[data-i='0']").dispatchEvent(move);
   $("#fmV").onloadedmetadata?.();$("#fmV").currentTime=2;
   document.dispatchEvent(new KeyboardEvent("keydown",{key:"c",bubbles:true}));
   $("#fmSaveList").click();closeFilm();localStorage.removeItem(filmDraftKey(savedPlaylist.data.film,savedPlaylist));
   nodeAction(savedPlaylist,"playlist-open");`);
 equal(evaluate(`FILM.spec.clips.map(c=>[c.ref,c.in,c.out])`),[
   ['input:h3studio/playlist-source-1.mp4',0,2],['input:h3studio/playlist-source-1.mp4',2,4],['input:h3studio/playlist-source-0.mp4',0,null]],
   'dragging, splitting and saving preserve exact clip order and source ranges without a browser draft');
 evaluate(`const playlistPlayer=$("#fmV"), originalPlaylistPlay=playlistPlayer.play;
   playlistPlayer.play=async()=>{};Object.defineProperty(playlistPlayer,"paused",{value:false,configurable:true});
   selectClip(0);playlistPlayer.onloadedmetadata?.();playlistPlayer.currentTime=2;playAll=true;previewTick();
   playlistPlayer.onloadedmetadata?.();delete playlistPlayer.paused;playlistPlayer.play=originalPlaylistPlay;`);
 equal(evaluate('[FILM.sel,$("#fmV").currentTime]'),[1,2],'continuous review advances to the next pinned range');
 const playlistFetch=w.fetch, archiveRequests=[], archiveNames=[];
 const archiveUrl=w.URL.createObjectURL,archiveRevoke=w.URL.revokeObjectURL,archiveClick=w.HTMLAnchorElement.prototype.click;
 w.URL.createObjectURL=()=> 'blob:playlist';w.URL.revokeObjectURL=()=>{};
 w.HTMLAnchorElement.prototype.click=function(){ archiveNames.push(this.download); };
 w.fetch=async(url,opts)=>{
   if(String(url)!=='/api/assets/export')return playlistFetch(url,opts);
   archiveRequests.push(JSON.parse(opts.body));return {ok:true,blob:async()=>new w.Blob(['archive'])};
 };
 evaluate('$("#fmPlaylistSources").click()');
 for(let i=0;i<30&&!archiveNames.length;i++)await pause(10);
 equal(archiveRequests,[{refs:['input:h3studio/playlist-source-1.mp4','input:h3studio/playlist-source-0.mp4']}],
   'playlist downloads deduplicate originals in timeline order');
 assert.match(archiveNames[0],/原片\.zip$/);
 w.fetch=playlistFetch;w.URL.createObjectURL=archiveUrl;w.URL.revokeObjectURL=archiveRevoke;w.HTMLAnchorElement.prototype.click=archiveClick;
 const directDownloads=[], savedPlaylistBefore=evaluate('JSON.stringify(savedPlaylist)');
 const rendersBeforeDownload=timelineRequests.length;
 w.HTMLAnchorElement.prototype.click=function(){directDownloads.push([this.download,this.getAttribute("href")]);};
 evaluate('$("#fmDownloadMerged").click()');
 await ready('$("#fmDownloadStatus").textContent.includes("浏览器下载")','playlist download starts');
 evaluate('closeFilm();nodeAction(savedPlaylist,"playlist-open");$("#fmDownloadMerged").click()');
 await ready('$("#fmDownloadStatus").textContent.includes("浏览器下载")','playlist download can be repeated from its saved task');
 equal(timelineRequests.length,rendersBeforeDownload+1,'identical download requests reuse the finished render');
 equal(timelineRequests.at(-1).spec.clips.map(({in:from,out})=>[from,out]),[[0,2],[2,4],[0,null]],
   'the downloaded render uses the edited timeline ranges');
 equal(directDownloads.length,2,'both download requests hand off an MP4');
 assert.match(directDownloads[0][0],/\.mp4$/);
 assert.match(directDownloads[0][1],/timeline-edit\.mp4$/);
 equal(evaluate('JSON.stringify(savedPlaylist)'),savedPlaylistBefore,'direct download leaves the playlist node and versions untouched');
 w.HTMLAnchorElement.prototype.click=archiveClick;
 evaluate(`closeFilm();B.access="reviewer";nodeAction(savedPlaylist,"playlist-open");`);
 equal(evaluate('[$("#film").classList.contains("playlist-review"),$("#fmSaveList").hidden,$("#fmGo").disabled]'),
   [true,true,true],'reviewers can preview saved playlists without modification controls');
 evaluate(`closeFilm();delete B.access;nodeAction(savedPlaylist,"playlist-open");$("#fmGo").click();`);
 await ready('savedPlaylist.versions.length===1','merged video lands in the saved playlist',300);
 equal(evaluate('[savedPlaylist.data.film.clips.length,playlistInputs.map(n=>n.versions.length)]'),[3,[1,1]],
   'merging retains the editable playlist and avoids changing source versions');
 evaluate(`const playlistChatBoard=AC.board;AC.board=boardId;
   acAppendEvent({kind:"tool_start",data:{call_id:"playlist-create-card",name:"video_playlist_create"}});
   acAppendEvent({kind:"tool_end",data:{call_id:"playlist-create-card",name:"video_playlist_create",result:{playlist_node:savedPlaylist.id}}});
   $("[data-call=playlist-create-card] [data-playlist-open]").click();`);
 await ready('FILM?.n?.id===savedPlaylist.id','the assistant result opens the same saved playlist');
 evaluate(`const startPlaylistPick=()=>{$("#fmTl .fadd").click();$("#fmAdd [data-playlist-pick]").click();};
   const pickTimelineSource=i=>$(".lbl",els.get(playlistInputs[i].id)).dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}));
   const originalPlaylistLength=FILM.spec.clips.length;
   startPlaylistPick();pickTimelineSource(1);pickTimelineSource(0);`);
 equal(evaluate('playlistInputs.map(n=>els.get(n.id).dataset.playlistPickOrder)'),['2','1'],
   'canvas selection badges follow the order in which videos are clicked');
 evaluate('$("#filmPlaylistPick").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));');
 equal(evaluate('[filmPlaylistPicker,$("#film").classList.contains("on"),FILM.spec.clips.length]'),
   [null,true,evaluate('originalPlaylistLength')],'cancelling selection reopens the unchanged timeline');
 evaluate(`startPlaylistPick();pickTimelineSource(1);pickTimelineSource(0);
   $("#filmPlaylistPick").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));`);
 equal(evaluate('FILM.spec.clips.slice(-2).map(c=>c.ref)'),['input:h3studio/playlist-source-1.mp4','input:h3studio/playlist-source-0.mp4'],
   'confirming canvas selection appends the exact clips in click order');
 equal(evaluate('savedPlaylist.data.film.clips.length'),evaluate('originalPlaylistLength'),
   'canvas picking updates the timeline draft before the list is explicitly saved');
 evaluate(`const tray=()=>$("#fmTl .fc:last-of-type");
   const pinnedClip=FILM.spec.clips.at(-1);
   const otherVersion={ref:"output:h3studio/playlist-newer.mp4",url:"/media?ref=output%3Ah3studio%2Fplaylist-newer.mp4",seconds:4};
   addVersion(playlistInputs[0],otherVersion);
   tray().dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:100,clientY:80}));
   $("#playlistClipMenu [data-source-preview]").click();`);
 equal(evaluate('[$("#light").open,$("#light video").getAttribute("src"),curV(playlistInputs[0]).ref]'),
   [true,'/media?ref=input%3Ah3studio%2Fplaylist-source-0.mp4','output:h3studio/playlist-newer.mp4'],
   'timeline preview opens the pinned version without changing the source node');
 evaluate('document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));');
 equal(evaluate('[$("#light").open,$("#film").classList.contains("on")]'),[false,true],
   'escaping from the source preview preserves the open timeline');
 evaluate('tray().querySelector(".fm-clip-menu").click();$("#playlistClipMenu [data-playlist-clip-remove]").click();');
 equal(evaluate('[FILM.spec.clips.includes(pinnedClip),FILM.spec.clips.length,!!node(playlistInputs[0].id)]'),
   [false,evaluate('originalPlaylistLength+1'),true],'removing a timeline entry keeps its source video');
 evaluate('closeFilm();AC.board=playlistChatBoard;');
 evaluate('removeNodes([emptyPlaylist.id,savedPlaylist.id,...playlistInputs.map(n=>n.id)]);');
 console.log('Playlist DOM passed: empty and multi-selection entries, board save, ordering, splitting, original download and merged export.');
 w.fetch=editTimelineFetch;
 console.log('Video timeline DOM passed: draft resume, editable captions and cutaways, and same-node export.');
 const audioFetch=w.fetch;
 const submittedAudio=[];
 w.fetch=async(url,opts)=>{
  if(String(url)!=='/api/audio/generate')return audioFetch(url,opts);
  const p=JSON.parse(opts.body),id='audio-job-'+submittedAudio.length;
  submittedAudio.push(p);
  const ref='output:h3studio/'+id+'.wav', recipe={mode:p.mode,prompt:p.prompt,provider:p.provider,voice:p.voice,speed:p.speed,lyrics:p.lyrics,
   ...(p.mode==='sfx'?{duration_seconds:p.duration_seconds,prompt_influence:p.prompt_influence,loop:p.loop}:{})};
  jobs.set(id,{state:'done',meta:{mode_name:p.mode==='tts'?'配音':'音乐生成'},outputs:[{ref,url:'/media?ref='+encodeURIComponent(ref),meta:{duration:3}}]});
  return {ok:true,text:async()=>JSON.stringify({ids:[id],recipe})};
 };
 evaluate(`CAPS_LIST.audio_generation={tts:[{id:"tts-test",name:"配音服务",voices:[{id:"zf_001",name:"自然女声"},{id:"zm_010",name:"自然男声"}]}],music:[{id:"music-test",name:"音乐服务",voices:[]}],sfx:[{id:"sfx-test",name:"音效服务",voices:[]}]};
   openAddMenu(80,90,{at:{x:170,y:430}});$("#addMenu [data-add=audio]").click();const generatedAudio=node([...sel][0]);
   const writePrompt=value=>{$("#prompt").value=value;$("#prompt").dispatchEvent(new Event("input"));};writePrompt("欢迎登车");
   const voice=$("#ctl [data-audio-field=voice]");voice.value="zm_010";voice.dispatchEvent(new Event("change"));
   $("#send").click();`);
 await ready('generatedAudio.versions.length===1','queued speech version arrives',300);
 equal([submittedAudio[0].prompt,submittedAudio[0].voice,submittedAudio[0].provider],['欢迎登车','zm_010','tts-test'],'speech includes the chosen voice');
 evaluate(`$("[data-audio-mode=music]").click();writePrompt("蓝调爵士");$("#audioLyrics").value="列车来了";$("#audioLyrics").dispatchEvent(new Event("input"));$("#send").click();`);
 await ready('generatedAudio.versions.length===2','music appends to the same audio node',300);
 evaluate(`$("[data-audio-mode=sfx]").click();writePrompt("雨落玻璃");
   $("[data-audio-field=duration_seconds]").value=8;$("[data-audio-field=duration_seconds]").dispatchEvent(new Event("change"));
   $("[data-audio-field=loop]").click();$("#send").click();`);
 await ready('generatedAudio.versions.length===3','sound effects append to the same node',300);
 equal([submittedAudio[2].mode,submittedAudio[2].duration_seconds,submittedAudio[2].prompt_influence,submittedAudio[2].loop],['sfx',8,.3,true]);
 w.fetch=audioFetch;
 equal([submittedAudio[1].node,submittedAudio[1].lyrics,submittedAudio[1].provider],[submittedAudio[0].node,'列车来了','music-test'],'music tracks the same node');
 evaluate('switchVersion(generatedAudio,0)');
 equal(evaluate('[$("#prompt").value,$("[data-audio-field=voice]").value,curV(generatedAudio).source]'),['欢迎登车','zm_010','audio_gen'],'the audio tab restores its original controls');
 evaluate('switchVersion(generatedAudio,2)');
 equal(evaluate('[$("#prompt").value,$("[data-audio-field=duration_seconds]").value,$("[data-audio-field=loop]").checked]'),['雨落玻璃','8',true]);
 assert.match(evaluate('acResultCards({nodes:[{id:generatedAudio.id,type:"audio",ref:curV(generatedAudio).ref}]})'),/<audio controls/);
 console.log('Audio generation DOM passed: node creation, configuration, speech/music, job output, chat player and version restore.');
 console.log('Previs DOM passed: scene editing, render tabs, pinned motion reference, guide replacement, existing video and split source handling.');
 console.log('Template DOM passed: save selection, preview, confirm sharing, search catalog, insert linked group and undo.');
 console.log('Comment DOM passed: node version anchor, plain text, reply, point marker, resolve and reopen.');
 console.log('Project DOM passed: create and group, add a sibling, switch, retain link, and dissolve without deleting canvases.');
 console.log('Video remake DOM passed: analyze, select, preview, review remade shots, correct tracking, localize, export, and first-frame handoff.');
 console.log('Chat choices passed: numbered options, submission, draft preservation and conversation replay.');
 console.log('Asset library DOM passed: entry, categories/search/source/scope, safe labels, preview/history, save/upload/delete, readonly shared assets, canvas import/place, @ citation, and fetch recovery.');
 console.log('Memory DOM passed: @ dropdown, alias/tag filtering, keyboard and mouse completion, no accidental send, duplicate identities and editor scope.');
 console.log('DOM integration passed: boot, zoom, fit, draft restore, undo/redo, comparisons, layer opacity/merge, docking, alignment, grouping/undo and spacing.');
 console.log('Agent DOM integration passed: panel, references, interrupted submission retry, result sync/cards/focus, conversation restore, floating layout and conflict-safe merge.');
 console.log('Stage-two DOM passed: Markdown tables/code/links/XSS cleanup, video cards, layer metadata, before/after comparison and manual selection handoff.');
 console.log('Pending video DOM passed: immediate input edge, independent sync with chat closed and no duplicate completion.');
 console.log('Version tabs DOM passed: image tabs, video input/settings restoration, busy protection, immutable chat result cards and copied history.');
 console.log('Right-click layout DOM passed: menu entry, selected/all media, collision-free grid, fixed text, preserved content/jobs, undo and redo.');
 console.log('Relation/video tabs DOM passed: relationship columns, frame order, graph validation, drag merge, tab split, recipes, film/chat references and undo.');
 const generationFetch=w.fetch;
 const submittedBatches=[], quotedGeneration=[];
 let persistedLayout;
 w.fetch=async(url,options)=>{
  if(String(url)==="/api/generation-cost"){
   const {requests}=JSON.parse(options.body);
   quotedGeneration.push(requests);
   return {ok:true,text:async()=>JSON.stringify({amounts:requests.map(r=>
    r.kind==="image" ? .125*r.count : r.board==="btest"&&r.prompt?.includes("@报价素材") ? 1.25*r.count : null)})};
  }
  if(String(url)!=="/api/generate"){
   if(String(url)==="/api/board/btest"&&options?.method==="PUT")persistedLayout=JSON.parse(options.body).batch_layout;
   return generationFetch(url,options);
  }
  const req=JSON.parse(options.body),jobId="layout-job-"+submittedBatches.length;
  submittedBatches.push({jobId,req});
  jobs.set(jobId,{state:"running"});
  return {ok:true,text:async()=>JSON.stringify({ids:[jobId]})};
 };
 const finishBatch=(index,total=2)=>{
  const {jobId,req}=submittedBatches[index],ext=req.kind==="video"?".mp4":".png";
  jobs.set(jobId,{state:"done",meta:{model:"layout-fixture"},outputs:Array.from({length:total},(_,i)=>{
   const ref="output:h3studio/"+jobId+"-"+i+ext;
   return {ref,url:"/media?ref="+encodeURIComponent(ref),meta:{width:720,height:1280,duration:5}};
  })});
 };
 evaluate(`const beforeBatchLayout=snap();
  const layoutSource=addNode("text",2200,100,{text:"保持构图"});
  const batchImage=addNode("image",2600,100,{prompt:"不同光线",count:2});
  link(layoutSource,batchImage,true);
  const setBatchLayout=value=>{renderBoardMenu();const select=$("[data-batch-layout]");select.value=value;select.dispatchEvent(new Event("change"));};`);
 equal(evaluate('canvasBatchLayout()'),'tabs','old canvases default to version tabs');
 await evaluate('generate(batchImage)');
 finishBatch(0);
 await ready('batchImage.versions.length===2','default keeps two generated images on the same node',350);
 evaluate('setBatchLayout("fold")');
 await evaluate('generate(batchImage)');
 await evaluate('flushSave()');
 assert.equal(persistedLayout,'fold');
 evaluate('setBatchLayout("spread")');
 finishBatch(1);
 await ready('B.groups.some(g=>g.name.endsWith("批量结果"))','submitted fold mode stays fixed after a setting change',350);
 equal(evaluate(`(()=>{const g=B.groups.find(g=>g.name.endsWith("批量结果"));return [
  g.collapsed,g.nodes.map(id=>node(id).versions.length),g.nodes.map(id=>B.edges.find(e=>e.to===id).from===layoutSource.id),
  batchImage.versions.length,curV(batchImage).ref];})()`),[true,[1,1],[true,true],2,'output:h3studio/layout-job-0-1.png'],
 'fold creates a group of independent results and leaves earlier image versions intact');
 evaluate('undo()');
 assert.equal(evaluate('B.groups.some(g=>g.name.endsWith("批量结果"))'),false);
 evaluate(`const batchVideo=addNode("video",2700,950,{prompt:"向前",count:2});link(layoutSource,batchVideo,true);`);
 await evaluate('generate(batchVideo)');
 finishBatch(2);
 await ready('B.nodes.some(n=>curV(n)?.ref==="output:h3studio/layout-job-2-1.mp4")','second video appears on the canvas',350);
 equal(evaluate(`(()=>{const v=B.nodes.find(n=>curV(n)?.ref==="output:h3studio/layout-job-2-1.mp4");return [
  curV(batchVideo).ref,v.x>batchVideo.x+size(batchVideo).w,!ctFolded(v.id),v.data.count,curV(v).node_data.count,
  curV(v).input_edges[0].to===v.id,curV(v).input_edges[0].from===layoutSource.id,
  curV(v).generation_record.settings.count];})()`),
 ['output:h3studio/layout-job-2-0.mp4',true,true,1,1,true,true,2],
 'spread reuses an empty video node then adds a sibling with working pinned video inputs');
 evaluate('const batchNodeTotal=B.nodes.length;setBatchLayout("fold");');
 await evaluate('generate(batchVideo)');
 finishBatch(3,1);
 await ready('curV(batchVideo)?.ref==="output:h3studio/layout-job-3-0.mp4"','a single successful result remains a version',350);
 assert(evaluate('B.nodes.length===batchNodeTotal && batchVideo.versions.length===2'));
 evaluate('restore(beforeBatchLayout);delete B.batch_layout;save()');
 console.log('Batch layout DOM passed: setting persistence, submission snapshot, legacy tabs, folded results and undo, spread video and one-result fallback.');
 evaluate(`const quoteBase=snap();
  const quoteVideo=addNode("video",1500,100,{prompt:"空镜头",count:2},{name:"报价视频"});
  const quoteImage=addNode("image",2100,700,{prompt:"海报",count:1},{name:"报价图片"});
  const quoteGroup=ctNewGroup("参考报价",[quoteVideo.id,quoteImage.id]);drawEdges();
  selectOnly(quoteVideo.id);
  $("#prompt").value="使用 @报价素材";$("#prompt").dispatchEvent(new Event("input"));`);
 await ready('$("[data-generation-cost]")?.textContent.includes("¥2.50")','editing an asset mention refreshes the node quote');
 evaluate('$("[data-group-run]",CT_GROUPS.get(quoteGroup.id)).click()');
 await ready('$("#groupRunConfirm [data-group-cost]").textContent.includes("¥2.625")','group quote includes the asset video and image');
 assert(quotedGeneration.some(batch=>batch.length===2&&batch.some(request=>request.prompt==="使用 @报价素材"&&request.count===2)));
 evaluate('$("#groupRunConfirm footer [data-close]").click();restore(quoteBase)');
 evaluate(`const groupRunBase=snap();setBatchLayout("fold");
  const workflowImage=addNode("image",1500,100,{prompt:"起始构图",count:2},{name:"分镜首帧"});
  const workflowVideo=addNode("video",2100,100,{prompt:"镜头慢慢推进",count:1},{name:"分镜视频"});
  const independentImage=addNode("image",1500,850,{prompt:"另一处场景",count:1},{name:"场景参考"});
  link(workflowImage,workflowVideo,true);
  const workflowGroup=ctNewGroup("场景制作",[workflowVideo.id,workflowImage.id,independentImage.id]);drawEdges();
  const workflowButton=$("[data-group-run]",CT_GROUPS.get(workflowGroup.id));
  const approveWorkflow=()=>$("#groupRunConfirm form").dispatchEvent(new Event("submit",{cancelable:true}));
  selectOnly(workflowImage.id);
  workflowButton.click();`);
 await ready('$("#groupRunConfirm [data-group-cost]").textContent.includes("¥0.375")','batch quotes retain known subtotal');
 assert.match(evaluate('$("#groupRunConfirm [data-group-cost]").textContent'),/1 个节点无法估算/);
 await ready('$("[data-generation-cost]")?.textContent.includes("¥0.25")','node generation quotes include the selected result count');
 equal(evaluate('$$("#groupRunConfirm li strong").map(el=>el.textContent)'),['分镜首帧','分镜视频','场景参考'],'confirmation shows dependency order before submission');
 assert.match(evaluate('$("#groupRunConfirm [data-summary]").textContent'),/3 个节点.*4 项/);
 equal(evaluate(`workflowVideo.data.count=4;
   workflowVideo.data.prompt+=" @图{123}";
   const batchCountQuote=canvasCostRequest(workflowVideo);
   workflowVideo.data.count=1;workflowVideo.data.prompt="镜头慢慢推进";
   [batchCountQuote.count,batchCountQuote.has_asset]`),
   [3,false],'legacy video counts honor the cap, and connected canvas references do not look like external assets');
 assert.match(evaluate('$("#groupRunConfirm .group-run-refs").textContent'),/分镜首帧\s*首帧 · 本轮生成/);
 assert.equal(evaluate('$("#groupRunConfirm .group-run-refs img")'),null,'a live dependency preview does not show a stale thumbnail');
 evaluate('$("#groupRunConfirm footer [data-close]").click()');
 assert.equal(submittedBatches.length,4,'cancelling confirmation submits nothing');
 evaluate('workflowButton.click();approveWorkflow()');
 await ready('workflowImage.job && groupRun.active','group submits the first upstream node');
 assert.equal(submittedBatches.length,5,'downstream waits for the upstream result');
 finishBatch(4);
 await ready('workflowVideo.job','group submits video only after image success',350);
 assert.equal(submittedBatches[5].req.images[0].ref,'output:h3studio/layout-job-4-1.png');
 assert.equal(evaluate('workflowImage.versions.length'),2,'group execution keeps generated images on the linked node under fold preference');
 finishBatch(5,1);
 await ready('independentImage.job','group moves on to the final independent branch',350);
 finishBatch(6,1);
 await ready('!groupRun.active','workflow reaches a terminal state',350);
 equal(evaluate('groupRun.steps.map(step=>step.status)'),['done','done','done'],'completed generation stays visible in the progress panel');
 evaluate('workflowButton.click();const mode=$("#groupRunConfirm select");mode.value="all";mode.dispatchEvent(new Event("change"));approveWorkflow()');
 await ready('workflowImage.job','rerun includes nodes that have results',350);
 const failedUpstream=submittedBatches[7].jobId;
 jobs.set(failedUpstream,{state:"error",error:"上游服务失败"});
 await ready('independentImage.job','an independent branch still runs after upstream failure',350);
 assert.equal(submittedBatches.length,9,'dependent video was not resubmitted with its stale frame');
 finishBatch(8,1);
 await ready('!groupRun.active','failure workflow finishes with independent outputs',350);
 equal(evaluate('groupRun.steps.map(step=>step.status)'),['error','skipped','done'],'progress distinguishes errors from skipped dependents');
 evaluate('workflowButton.click();mode.value="all";mode.dispatchEvent(new Event("change"));approveWorkflow()');
 await ready('workflowImage.job','stop test starts its first generation',350);
 evaluate('$("#groupRunProgress [data-stop]").click()');
 finishBatch(9);
 await ready('!groupRun.active','stop waits for the submitted node without launching more',350);
 assert.equal(submittedBatches.length,10);
 equal(evaluate('groupRun.steps.map(step=>step.status)'),['done','skipped','skipped'],'stop preserves the first result');
 evaluate(`const stoppedOutput=curV(workflowImage).ref;
  switchVersion(workflowImage,0);
  const retryGroup=$("#groupRunProgress [data-retry]");
  retryGroup.click();`);
 assert.match(evaluate('$("#groupRunConfirm ol").textContent'),/已切换版本/);
 assert.match(evaluate('$("#groupRunConfirm [data-summary]").textContent'),/将重试 1 个节点.*保留 1 个完成节点/);
 evaluate(`$("#groupRunConfirm footer [data-close]").click();
  switchVersion(workflowImage,workflowImage.versions.findIndex(v=>v.ref===stoppedOutput));
  retryGroup.click();`);
 assert.match(evaluate('$("#groupRunConfirm [data-summary]").textContent'),/将重试 2 个节点/);
 assert.equal(submittedBatches.length,10,'opening retry submits no work');
 evaluate('approveWorkflow()');
 await ready('workflowVideo.job','retry starts from the unfinished video',350);
 assert.equal(submittedBatches[10].req.images[0].ref,evaluate('stoppedOutput'),'retry reuses the completed upstream output');
 jobs.set(submittedBatches[10].jobId,{state:"error",error:"模拟视频失败"});
 await ready('independentImage.job','failed retry leaves the other branch runnable',350);
 finishBatch(11,1);
 await ready('!groupRun.active','retry completes with one remaining failure',350);
 evaluate('retryGroup.click()');
 equal(evaluate('$$("#groupRunConfirm li strong").map(el=>el.textContent)'),['分镜视频'],
  'the second retry keeps both successful nodes and only offers the remaining failure');
 evaluate('approveWorkflow()');
 await ready('workflowVideo.job','second retry launches only the failed video',350);
 assert.equal(submittedBatches[12].req.images[0].ref,evaluate('stoppedOutput'));
 finishBatch(12,1);
 await ready('!groupRun.active','second retry completes',350);
 equal(evaluate('groupRun.steps.map(step=>step.status)'),['done','done','done'],'all earlier successes remain visible after the retry');
 assert(evaluate('$("#groupRunProgress [data-retry]").hidden'));
 const targetedStart=submittedBatches.length;
 evaluate(`const rerunMedia=name=>({ref:"output:h3studio/"+name+".png",url:"/media?ref=output:h3studio/"+name+".png",w:512,h:512});
  const rerunSource=addNode("image",900,100,{}, {name:"原始素材",versions:[rerunMedia("previous")],cur:0});
  const rerunReplacement=addNode("image",900,480,{}, {name:"更新素材",versions:[rerunMedia("replacement")],cur:0});
  const pinnedScene=addNode("image",2150,850,{prompt:"引用旧版本",count:1},{name:"固定旧分镜"});
  workflowImage.data.count=1;
  link(rerunSource,workflowImage,true);
  link(workflowImage,pinnedScene,true,{ref:curV(workflowImage).ref});
  workflowGroup.nodes.push(pinnedScene.id);
  drawEdges();
  $("[data-group-replace]",CT_GROUPS.get(workflowGroup.id)).click();
  const currentOriginal=$("#versionRefUpdate [name=original]");
  currentOriginal.value=rerunSource.id;currentOriginal.dispatchEvent(new Event("change"));
  const currentReplacement=$("#versionRefUpdate [name=replacement]");
  currentReplacement.value=rerunReplacement.id;currentReplacement.dispatchEvent(new Event("change"));
  $("#versionRefUpdate [data-review-run]").click();`);
 equal(evaluate('[$("#groupRunConfirm select").value,$$("#groupRunConfirm li strong").map(el=>el.textContent)]'),
   ["affected",["分镜首帧","分镜视频"]],'targeted run follows live downstream images and skips independent or pinned branches');
 assert.equal(submittedBatches.length,targetedStart,'showing the targeted plan does not submit generation');
 evaluate('approveWorkflow()');
 await ready('workflowImage.job','targeted rerun starts with the changed image reference',350);
 assert.equal(submittedBatches[targetedStart].req.images[0].ref,'output:h3studio/replacement.png');
 finishBatch(targetedStart,1);
 await ready('workflowVideo.job','dependent video uses the new upstream image',350);
 assert.equal(submittedBatches[targetedStart+1].req.images[0].ref,`output:h3studio/layout-job-${targetedStart}-0.png`);
 finishBatch(targetedStart+1,1);
 await ready('!groupRun.active','targeted rerun finished',350);
 assert.equal(submittedBatches.length,targetedStart+2,'no independent or pinned shots were resubmitted');
 evaluate(`const recoveryId=groupRun.id;
  const runReceipt=JSON.parse(sessionStorage.getItem(groupRunStorageKey(boardId)));
  runReceipt.steps[0].status="running";runReceipt.steps[1].status="waiting";
  sessionStorage.setItem(groupRunStorageKey(boardId),JSON.stringify(runReceipt));
  restoreCanvasGroupRun();`);
 equal(evaluate(`[groupRun.id===recoveryId,groupRun.active,groupRun.steps.map(step=>step.status),
  curV(workflowImage).group_run_id===recoveryId,groupRun.steps[0].outputRef===curV(workflowImage).ref]`),
  [true,false,["done","skipped"],true,true],'restoring progress recognizes the exact saved output and leaves unsubmitted steps for confirmation');
 assert.equal(submittedBatches.length,targetedStart+2,'restoring the receipt submits no additional generation');
 evaluate(`$("#groupRunProgress [data-dismiss]").click();
  const groupPlanBoard=AC.board;AC.board=boardId;
  acAppendEvent({kind:"tool_start",data:{name:"canvas_group_run_plan",call_id:"scoped-group-run"}});
  acAppendEvent({kind:"tool_end",data:{name:"canvas_group_run_plan",call_id:"scoped-group-run",result:{group_run_plan:{
   board:boardId,group:workflowGroup.id,name:workflowGroup.name,targets:[workflowVideo.id],mode:"all"}}}});
  const extraMember=addNode("video",2200,1300,{prompt:"新加入的镜头"});
  workflowGroup.nodes.push(extraMember.id);
  $("[data-call=scoped-group-run] [data-group-run-plan]").click();AC.board=groupPlanBoard;`);
 equal(evaluate('$$("#groupRunConfirm li strong").map(el=>el.textContent)'),['分镜视频'],
  'the assistant card retains its original scope when a new node joins the group');
 assert.match(evaluate('$("#groupRunConfirm .group-run-refs small").textContent'),/首帧 · 版本 \d+（当前）/);
 assert.equal(evaluate('new URL($("#groupRunConfirm .group-run-refs img").src,location.href).searchParams.get("ref")'),evaluate('curV(workflowImage).ref'));
 assert.equal(submittedBatches.length,targetedStart+2,'opening the assistant preview does not submit');
 evaluate('approveWorkflow()');
 await ready('workflowVideo.job','assistant group confirmation starts the specified video',350);
 assert.equal(submittedBatches[targetedStart+2].req.images[0].ref,evaluate('curV(workflowImage).ref'));
 finishBatch(targetedStart+2,1);
 await ready('!groupRun.active','assistant planned run completes',350);
 assert.equal(submittedBatches.length,targetedStart+3);
 evaluate(`const storyLast={duration:5,shot_size:"中景",camera:"缓推",scene:"窗边暖光",characters:["林森"],
   action:["右手握木盒"],dialogue:[],sound:"风声",keyframe:"木盒在窗台",
   asset_refs:[{id:"prior-room",name:"旧房",kind:"scene"}]};
  const storyNext={...storyLast,shot_size:"近景",keyframe:"林森右手握木盒",action:["左手打开盒盖"],
   asset_refs:[{id:"next-hero",name:"林森",kind:"character",view:"face"}]};
  const storyCast=[{name:"林森",look:"深蓝外套"}];
  const storyNode=addNode("script",4000,100,{style:"写实暖光",characters:storyCast,shots:[storyLast],made:[]});
  const legacyStoryImage=addNode("image",4450,100,{}, {name:"以前的首帧"});
  const legacyStoryVideo=addNode("video",4450,600,{}, {name:"以前的镜头"});
  storyNode.data.made=[{img:legacyStoryImage.id,vid:legacyStoryVideo.id}];
  const storyReference=addNode("image",3570,100,{}, {name:"林森",versions:[rerunMedia("cast-previous"),rerunMedia("cast-current")],cur:1});
  B.edges.push({from:storyReference.id,to:storyNode.id,ref:storyReference.versions[0].ref});
  const storyBefore=B.nodes.length;
  AC.board=boardId;
  acAppendEvent({kind:"tool_start",data:{name:"storyboard_next_shot_plan",call_id:"next-shot"}});
  acAppendEvent({kind:"tool_end",data:{name:"storyboard_next_shot_plan",call_id:"next-shot",result:{storyboard_plan:{
   board:boardId,node:storyNode.id,name:storyNode.name,anchor:{count:1,last:storyLast,style:"写实暖光",characters:storyCast},shot:storyNext}}}});
  const adoptShot=$("[data-call=next-shot] [data-adopt-storyboard]");
  storyNode.data.style="冷光";adoptShot.click();`);
 assert.match(evaluate('$("[data-call=next-shot] [role=status]").textContent'),/重新准备/);
 assert.equal(evaluate('storyNode.data.shots.length'),1);
 assert.match(evaluate('$("[data-call=next-shot]").textContent'),/林森（正面头肩）/);
 evaluate('storyNode.data.style="写实暖光";const priorShotAssets=storyLast.asset_refs;storyLast.asset_refs=[];adoptShot.click()');
 assert.match(evaluate('$("[data-call=next-shot] [role=status]").textContent'),/重新准备/);
 assert.equal(evaluate('storyNode.data.shots.length'),1,'changing prior assets invalidates the continuation preview');
 evaluate('storyLast.asset_refs=priorShotAssets;adoptShot.click()');
 equal(evaluate('[storyNode.data.shots.length,storyNode.data.shots.at(-1).keyframe,storyNode.data.made.length,B.nodes.length===storyBefore,adoptShot.disabled]'),
  [2,"林森右手握木盒",1,true,true],'confirmed continuation appends one script shot without generating or expanding the canvas');
 evaluate(`const openNewShot=$("[data-call=next-shot] [data-open-approved-shot]");
  openNewShot.click();
  const newStoryPair=scriptShotLinks(storyNode)[1], newestStoryVideo=node(newStoryPair.vid);
  openNewShot.click();`);
 equal(evaluate(`[B.nodes.length===storyBefore+2,scriptShotLinks(storyNode)[0].vid===legacyStoryVideo.id,
  newestStoryVideo.name,plan(newestStoryVideo).inputs.map(({edge,version})=>[edge.role,version?.ref??null])]`),
  [true,true,"镜2",[["first",null],["subject","output:h3studio/cast-previous.png"]]],
  'the new shot can be expanded once and located without duplicating the prior pair or switching the pinned cast');
 equal(evaluate('[newestStoryVideo.data.fields.scene.includes("@{next-hero#face|林森}"),newestStoryVideo.data.fields.scene.includes("prior-room")]'),
  [true,false],'continuation only attaches the approved references for the new shot');
 evaluate('$("[data-call=next-shot] [data-run-approved-shot]").click()');
 equal(evaluate('$$("#groupRunConfirm li strong").map(el=>el.textContent)'),["镜2 · 分镜图","镜2"],
  'the single-shot plan only includes its two nodes in dependency order');
 assert.match(evaluate('$$("#groupRunConfirm .group-run-refs").at(-1).textContent'),/首帧 · 本轮生成/);
 evaluate(`const storyRunMode=$("#groupRunConfirm select");
  storyRunMode.value="video";storyRunMode.dispatchEvent(new Event("change"));`);
 assert.match(evaluate('$("#groupRunConfirm ol").textContent'),/参考素材不可用/);
 assert(evaluate('$("#groupRunConfirm [type=submit]").disabled'));
 evaluate('$("#groupRunConfirm footer [data-close]").click()');
 const storyCaptureFetch=w.fetch, storyTailRequests=[];
 let releaseOlderTail;
 w.fetch=async(url,options)=>{
  if(String(url)!=='/api/lastframe')return storyCaptureFetch(url,options);
  storyTailRequests.push(JSON.parse(options.body));
  if(storyTailRequests.length===2)await new Promise(resolve=>{releaseOlderTail=resolve;});
  const ref='input:h3studio/story-tail-'+storyTailRequests.length+'.png';
  return {ok:true,text:async()=>JSON.stringify({ref,url:'/media?ref='+encodeURIComponent(ref),w:64,h:64,at:4.9})};
 };
 await evaluate(`legacyStoryVideo.versions=["older","newer"].map(label=>({ref:"input:h3studio/"+label+".mp4",
  url:"/media?ref=input:h3studio/"+label+".mp4",w:640,h:480,seconds:5}));legacyStoryVideo.cur=0;
  const picture=node(newStoryPair.img), tailButton=$("[data-call=next-shot] [data-link-previous-shot]");
  $("#acMessages").onclick({target:tailButton});`);
 const tailEdge=evaluate('B.edges.find(edge=>edge.to===picture.id&&edge.story_continuity)');
 assert.match(evaluate('picture.data.prompt'),/@图\{1\}/);
 equal(evaluate('curV(node(B.edges.find(edge=>edge.to===picture.id&&edge.story_continuity).from)).capture.source_ref'),
  'input:h3studio/older.mp4','the tail capture records the precise prior video version');
 const tailBadge=`$('[data-script-tail-status="1"]',els.get(storyNode.id))`;
 assert.match(evaluate(tailBadge+'.textContent'),/已对齐 · 上一镜版本 1/);
 await evaluate('linkPreviousShotFrame(storyNode,1)');
 assert.equal(storyTailRequests.length,1,'repeat clicks reuse the exact existing tail frame');
 const staleTail=evaluate('legacyStoryVideo.cur=1;drawEdges();linkPreviousShotFrame(storyNode,1)');
 assert.match(evaluate(tailBadge+'.textContent'),/不一致/);
 evaluate('legacyStoryVideo.cur=0');
 releaseOlderTail();
 await staleTail;
 assert.equal(evaluate('B.nodes.length'),evaluate('storyBefore+3'),'switching versions during capture leaves the graph intact');
 await evaluate('legacyStoryVideo.cur=1;linkPreviousShotFrame(storyNode,1)');
 const updatedTail=evaluate('B.edges.find(edge=>edge.to===picture.id&&edge.story_continuity)');
 assert.equal(updatedTail.prompt_slot,1,'renewing the tail retains its prompt index');
 assert.notEqual(updatedTail.ref,'input:h3studio/story-tail-1.png');
 assert.equal(tailEdge.prompt_slot,1);
 evaluate(`picture.versions=[{...rerunMedia("story-result"),generation_record:{inputs:[{ref:"input:h3studio/story-tail-1.png"}]}}];picture.cur=0;drawEdges();`);
 assert.match(evaluate(tailBadge+'.textContent'),/当前分镜图尚未使用/);
 evaluate(`curV(picture).generation_record.inputs[0].ref=B.edges.find(edge=>edge.to===picture.id&&edge.story_continuity).ref;drawEdges();`);
 assert.match(evaluate(tailBadge+'.textContent'),/已对齐 · 上一镜版本 2/);
 evaluate(`newestStoryVideo.versions=[{ref:"output:h3studio/shot-two.mp4",url:"/media?ref=output:h3studio/shot-two.mp4",seconds:5,w:640,h:480}];
  newestStoryVideo.cur=0;
  const comparisonBoardSnapshot=JSON.stringify([B.nodes,B.edges]);
  $("[data-script-review='1']",els.get(storyNode.id)).click();
  const compare=$('#shotContinuityReview');
  const compareSources=()=>$$("img",compare).map(img=>new URL(img.getAttribute("src"),location.href));
  const leftCompare=$("[data-left-frame] select",compare),rightCompare=$("[data-right-frame] select",compare);`);
 equal(evaluate('[compare.open,...compareSources().map(url=>url.searchParams.get("position"))]'),
  [true,"last","first"],'shot review compares the actual final and first frames by default');
 evaluate(`leftCompare.value="0";leftCompare.dispatchEvent(new Event("change"));
  rightCompare.value="1";rightCompare.dispatchEvent(new Event("change"));`);
 equal(evaluate(`[...compareSources().map(url=>[url.pathname,url.searchParams.get("ref")]),
  JSON.stringify([B.nodes,B.edges])===comparisonBoardSnapshot]`),[
  ["/api/video/frame-preview","input:h3studio/older.mp4"],["/media","output:h3studio/story-result.png"],true],
  'selecting alternate review versions only changes the dialog');
 evaluate('closeShotContinuityReview()');
 evaluate(`acAppendEvent({kind:"tool_start",data:{name:"storyboard_visual_review",call_id:"visual-shot-review"}});
  acAppendEvent({kind:"tool_end",data:{name:"storyboard_visual_review",call_id:"visual-shot-review",result:{text:"核对木盒位置",shot_review:{
    board:boardId,script:storyNode.id,shot:2,
    left:{node:legacyStoryVideo.id,version:1,ref:legacyStoryVideo.versions[0].ref,kind:"video"},
    right:{node:picture.id,version:1,ref:curV(picture).ref,kind:"image"}}}}});
  $("[data-call=visual-shot-review] [data-shot-review]").click();`);
 equal(evaluate(`[compare.open,leftCompare.value,rightCompare.value,legacyStoryVideo.cur,newestStoryVideo.cur]`),
  [true,"0","1",1,0],'assistant review reopens the precise old tail and still without switching canvas versions');
 evaluate('closeShotContinuityReview()');
 evaluate(`openShotContinuityReview(storyNode,1,{
   left:{node:legacyStoryVideo.id,version:1,ref:legacyStoryVideo.versions[0].ref},
   right:{node:newestStoryVideo.id,version:1,ref:curV(newestStoryVideo).ref},
   samples:{left:[{position:"time",at:2.4,seconds:2.38},{position:"last",seconds:2.8}],
     right:[{position:"first",seconds:0},{position:"time",at:.4,seconds:.4}]}});
  const motionButtons=$$("[data-left-frame] [data-samples] button",compare);
  motionButtons[0].click();`);
 equal(evaluate(`[motionButtons[0].textContent,motionButtons[0].getAttribute("aria-pressed"),
   compareSources()[0].searchParams.get("position"),compareSources()[0].searchParams.get("at"),
   compareSources()[0].searchParams.get("ref"),legacyStoryVideo.cur]`),
   ["2.38s","true","time","2.4","input:h3studio/older.mp4",1],
   'motion review selects the analyzed timestamp on its pinned historical video');
 evaluate('leftCompare.value="1";leftCompare.dispatchEvent(new Event("change"))');
 assert.equal(evaluate('$("[data-left-frame] [data-samples]",compare).hidden'),true);
 const shotReviewTestFetch=w.fetch, shotReviewRequests=[];
 w.fetch=(url,options)=>{
  if(String(url)==='/api/chat/sessions/shot-review-ui/messages'){
   shotReviewRequests.push(JSON.parse(options.body));
   const failed=shotReviewRequests.length===1;
   return Promise.resolve({ok:!failed,json:async()=>failed?{error:'请重试'}:{id:'review-queued',state:'queued'}});
  }
  return shotReviewTestFetch(url,options);
 };
 evaluate(`const savedReviewAssistant={open:acOpen,poll:acPoll,session:AC.session,draft:$("#acInput").value};
  acOpen=async()=>{};acPoll=async()=>{};AC.session="shot-review-ui";$("#acInput").value="未发送的草稿";
  leftCompare.value="0";leftCompare.dispatchEvent(new Event("change"));
  const requestMotion=$("[data-request-review]",compare);`);
 await evaluate('requestMotion.onclick()');
 assert.match(evaluate('$("footer [role=status]",compare).textContent'),/请重试/);
 await evaluate('requestMotion.onclick()');
 assert.equal(shotReviewRequests.length,2);
 assert.equal(shotReviewRequests[0].request_key,shotReviewRequests[1].request_key);
 equal(shotReviewRequests[1].shot_review,{node_id:evaluate('storyNode.id'),shot:2,current_type:"video",
  left:{node:evaluate('legacyStoryVideo.id'),ref:"input:h3studio/older.mp4",version:1},
  right:{node:evaluate('newestStoryVideo.id'),ref:"output:h3studio/shot-two.mp4",version:1}},'direct review sends the chosen historical version and current video');
 equal(evaluate('[compare.open,$("#acInput").value,legacyStoryVideo.cur]'),[false,"未发送的草稿",1]);
 evaluate('const reviewRevisionRequest=$("[data-call=visual-shot-review] [data-plan-review-revision]")');
 await evaluate('$("#acMessages").onclick({target:reviewRevisionRequest})');
 assert.equal(shotReviewRequests[2].review_revision_call,'visual-shot-review');
 equal(evaluate('[reviewRevisionRequest.disabled,$("#acInput").value,JSON.stringify([B.nodes,B.edges])===comparisonBoardSnapshot]'),
  [true,"未发送的草稿",true],'requesting a revision uses the review card and preserves the existing draft and board');
 evaluate(`acOpen=savedReviewAssistant.open;acPoll=savedReviewAssistant.poll;AC.session=savedReviewAssistant.session;
   $("#acInput").value=savedReviewAssistant.draft;`);
 w.fetch=shotReviewTestFetch;
 evaluate(`const savedRangeShots=storyNode.data.shots.slice(), savedRangeLinks=storyNode.data.made.slice();
  const savedLatestFilm=localStorage.getItem(filmDraftPrefix()+"latest"), savedRangeSelection=new Set(sel);
  storyNode.data.shots.push({...storyLast,id:"range-missing"},{...storyLast,id:"range-fourth"});
  storyNode.data.made.push({shot_id:"range-fourth",vid:legacyStoryVideo.id});
  selectOnly(storyNode.id);$("#shotListBtn").click();
  const shotTimeline=$("#shotList"), rangeFrom=$("[data-film-from]",shotTimeline), rangeTo=$("[data-film-to]",shotTimeline);
  const sendRange=$("[data-film]",shotTimeline);`);
 equal(evaluate(`[[...rangeFrom.options].map(option=>option.disabled),[...rangeTo.options].map(option=>option.textContent),
   $$("[data-clip-range]",shotTimeline).length,sendRange.disabled]`),[[false,false,true,false],["镜头 1","镜头 2"],2,false],
  'completed consecutive shots can be cut before a later shot has generated');
 evaluate(`const savedWizard=W;
  W={step:5,script:storyNode.id};
  const unrelatedFilm={id:"unrelated-film",type:"video",data:{film:{clips:[{node:"other-video"}]}},versions:[],cur:-1};
  B.nodes.push(unrelatedFilm);`);
 assert.match(evaluate('stepFilm()'),/镜头 3 还缺少视频/);
 assert.equal(evaluate(`stepFilm().includes('data-go="quick"')`),false);
 await evaluate('wizGo("quick")');
 assert.equal(evaluate('FILM'),null,'the wizard cannot submit a partial storyboard from a stale button');
 evaluate(`sendRange.click();const firstRangeDraft=FILM.key;
  FILM.spec.clips[0].volume=.3;closeFilm();`);
 equal(evaluate('JSON.parse(localStorage.getItem(firstRangeDraft)).spec.clips.map(clip=>[clip.node,clip.ref])'),[
  [evaluate('legacyStoryVideo.id'),evaluate('legacyStoryVideo.versions[1].ref')],
  [evaluate('newestStoryVideo.id'),'output:h3studio/shot-two.mp4']],'the selected range enters the timeline in storyboard order with pinned references');
 evaluate('legacyStoryVideo.cur=0;sendRange.click();const secondRangeDraft=FILM.key');
 equal(evaluate('[firstRangeDraft!==secondRangeDraft,FILM.spec.clips[0].ref,FILM.spec.clips[0].volume]'),
  [true,"input:h3studio/older.mp4",1],'a new version opens its own timeline draft instead of reusing the old cut');
 evaluate(`closeFilm();legacyStoryVideo.cur=1;sendRange.click();`);
 equal(evaluate('[FILM.key===firstRangeDraft,FILM.spec.clips[0].volume]'),[true,.3],'returning to the same versions restores the edited range draft');
 evaluate(`const clipForSwap=FILM.spec.clips[0], canvasTakeBeforeSwap=legacyStoryVideo.cur;
  Object.assign(clipForSwap,{in:1,out:4,speed:2,trans:"fade",subs:["手写字幕"],captions:[{start:1.2,end:2.2,text:"原字幕"}]});
  legacyStoryVideo.versions[0].seconds=8;
  legacyStoryVideo.versions.push({ref:"input:h3studio/too-short.mp4",seconds:.8});
  $("#fmV").onloadedmetadata?.();$('[data-update-version]',$('#fmClip')).click();
  const swapForm=$('.fm-version-picker'), swapPicker=$("select",swapForm), swapApply=$("button",swapForm);
  swapPicker.value="1";swapPicker.dispatchEvent(new Event("change"));`);
 equal(evaluate('[swapApply.disabled,clipForSwap.ref]'),[true,'input:h3studio/newer.mp4'],'a version that ends before the cut cannot replace the source');
 evaluate('legacyStoryVideo.versions[2].seconds=3;swapPicker.dispatchEvent(new Event("change"))');
 assert.match(evaluate('$(`[role=status]`,swapForm).textContent'),/缩短 0.50 秒/);
 evaluate(`swapPicker.value="0";swapPicker.dispatchEvent(new Event("change"));
  $("[data-keep-captions]",swapForm).checked=true;
  swapForm.dispatchEvent(new Event("submit",{cancelable:true}));`);
 equal(evaluate(`[clipForSwap.ref,clipForSwap.in,clipForSwap.out,clipForSwap.speed,clipForSwap.trans,clipForSwap.volume,
  clipForSwap.subs,clipForSwap.captions[0].text,legacyStoryVideo.cur===canvasTakeBeforeSwap]`),
  ['input:h3studio/older.mp4',1,4,2,'fade',.3,['手写字幕'],'原字幕',true],
  'applying a historical version keeps the edited range and the selected subtitles without switching the canvas version');
 evaluate('legacyStoryVideo.versions.pop();legacyStoryVideo.versions[0].seconds=5');
 evaluate(`closeFilm();rangeFrom.value="range-fourth";rangeFrom.dispatchEvent(new Event("change"));`);
 equal(evaluate('[...rangeTo.options].map(option=>option.textContent)'),['镜头 4'],'choosing a later shot starts its own contiguous interval');
 evaluate(`$("#shotList [data-close]").click();storyNode.data.shots=savedRangeShots;storyNode.data.made=savedRangeLinks;
  for(const key of [firstRangeDraft,secondRangeDraft])localStorage.removeItem(key);
  openStoryFilm(storyNode);const fullStoryDraft=FILM.key;
  Object.assign(FILM.spec.clips[0],{in:1,out:4,trans:"black",volume:.4,speed:1.5,subs:["保留的字幕"],
    captions:[{start:1.1,end:1.8,text:"校正的字幕"}]});
  Object.assign(FILM.spec.clips[1],{in:2,out:4});
  FILM.spec.clips.push({...newFilmClip(legacyStoryVideo),name:"手动补画面"});
  FILM.spec.aspect="9:16";FILM.spec.titles=[{text:"片头",start:0,end:1,position:"center",style:"plain"}];
  closeFilm();`);
 await evaluate('wizGo("edit")');
 equal(evaluate('[FILM.key===fullStoryDraft,FILM.spec.story_script,FILM.spec.clips[0].trans,FILM.spec.aspect,FILM.n]'),
  [true,evaluate('storyNode.id'),'black','9:16',null],'the wizard opens the same storyboard draft and keeps its adjustments');
 evaluate(`closeFilm();unrelatedFilm.data.film.story_script=storyNode.id;
  legacyStoryVideo.cur=0;
  newestStoryVideo.versions.push({ref:"output:h3studio/short-take.mp4",seconds:1.5});
  newestStoryVideo.cur=1;`);
 await evaluate('wizGo("current-cut")');
 equal(evaluate('[wizardFilm(storyNode)===unrelatedFilm,FILM.key!==fullStoryDraft,FILM.spec.clips[0].ref,FILM.n]'),
  [true,true,'input:h3studio/older.mp4',null],'a finished film can be kept while opening a cut from newly selected shot versions');
 assert.equal(evaluate('$("#fmStoryReuse").hidden'),false);
 evaluate(`const newFullStoryDraft=FILM.key, oldStoryState=localStorage.getItem(fullStoryDraft);
  $("#fmStoryReuse").click();const storyReuseDialog=$("#fmStoryDialog");
  const storyReuseSubmit=()=>$("form",storyReuseDialog).dispatchEvent(new Event("submit",{cancelable:true}));`);
 equal(evaluate('$$("li",storyReuseDialog).map(li=>li.textContent)'),[
  '镜头 1 · 1 段改用版本 1','镜头 2 · 1 段因新版本过短保留原素材'],
  'the preview identifies changed and too-short shots before applying');
 evaluate('$("[data-close]",storyReuseDialog).click()');
 equal(evaluate('[FILM.spec.aspect,FILM.spec.clips.length,storyReuseDialog.open]'),['source',2,false]);
 evaluate('$("#fmStoryReuse").click();newestStoryVideo.cur=0;storyReuseSubmit()');
 equal(evaluate('[FILM.spec.aspect,FILM.spec.clips.length]'),['source',2],'a canvas version change invalidates the preview');
 evaluate('newestStoryVideo.cur=1;$("#fmStoryReuse").click();storyReuseSubmit()');
 equal(evaluate(`[FILM.spec.aspect,FILM.spec.titles[0].text,FILM.n,$("#fmStoryReuse").hidden,
  FILM.spec.clips.map(clip=>[clip.ref,clip.in,clip.out,clip.trans,clip.speed??1,clip.volume]),
  FILM.spec.clips[0].captions[0].text, localStorage.getItem(fullStoryDraft)===oldStoryState]`),
  ['9:16','片头',null,true,[
    ['input:h3studio/older.mp4',1,4,'black',1.5,.4],
    ['output:h3studio/shot-two.mp4',2,4,'cut',1,1],
    ['input:h3studio/newer.mp4',0,null,'cut',1,1]],'校正的字幕',true],
  'the new draft preserves editing, manual duplicates, and the original draft without claiming a finished film');
 evaluate(`closeFilm();openStoryFilm(storyNode);`);
 equal(evaluate('[FILM.key===newFullStoryDraft,FILM.spec.clips.length,FILM.spec.aspect,$("#fmStoryReuse").hidden]'),
  [true,3,'9:16',true],'reopening the new versions restores the saved imported draft');
 evaluate(`closeFilm();
  newestStoryVideo.versions.push({ref:"output:h3studio/long-take.mp4",seconds:6});newestStoryVideo.cur=2;
  openStoryFilm(storyNode);const longStoryDraft=FILM.key;
  $("#fmStoryReuse").click();const priorStoryDraft=$("select",storyReuseDialog);
  priorStoryDraft.selectedIndex=[...priorStoryDraft.options].findIndex(option=>option.textContent.endsWith("V1 / V2"));
  priorStoryDraft.dispatchEvent(new Event("change"));storyReuseSubmit();`);
 equal(evaluate('FILM.spec.clips.map(clip=>clip.ref)'),[
  'input:h3studio/older.mp4','output:h3studio/long-take.mp4','input:h3studio/newer.mp4'],
  'a later version can replace a linked shot that was previously too short');
 evaluate(`closeFilm();legacyStoryVideo.cur=1;newestStoryVideo.versions.splice(1);newestStoryVideo.cur=0;
  W=savedWizard;B.nodes.splice(B.nodes.indexOf(unrelatedFilm),1);
  sel=savedRangeSelection;updateSel();
  for(const key of [fullStoryDraft,newFullStoryDraft,longStoryDraft])localStorage.removeItem(key);
  if(savedLatestFilm)localStorage.setItem(filmDraftPrefix()+"latest",savedLatestFilm);else localStorage.removeItem(filmDraftPrefix()+"latest");`);
 evaluate(`const revisionShot=storyNode.data.shots[1], revisionEdges=JSON.stringify(B.edges);
  const oldAction=newestStoryVideo.data.fields.action;
  const oldDialogue=newestStoryVideo.data.fields.dialogue;
  newestStoryVideo.data.fields.dialogue="人工调整的对白";
  const revisionPlan={board:boardId,node:storyNode.id,shot:2,shot_id:revisionShot.id,
    before:{keyframe:revisionShot.keyframe,action:revisionShot.action,dialogue:revisionShot.dialogue??null,asset_refs:revisionShot.asset_refs},
    changes:{keyframe:"木盒在左手",action:["抬起木盒"],dialogue:["方案对白"],asset_refs:[]}};
  const continuitySuffix=picture.data.prompt.slice(scriptShotSettings(storyNode,revisionShot).image.prompt.length);
  acAppendEvent({kind:"tool_start",data:{name:"storyboard_revision_plan",call_id:"revise-shot"}});
  acAppendEvent({kind:"tool_end",data:{name:"storyboard_revision_plan",call_id:"revise-shot",result:{shot_revision:revisionPlan}}});
  const revisionCard=$("[data-call=revise-shot]"), revisionApply=$("[data-apply-shot-revision]",revisionCard);
  revisionShot.keyframe="先手动改了首帧";revisionApply.click();`);
 assert.match(evaluate(`$('[role=status]',revisionCard).textContent`),/重新准备/);
 assert.match(evaluate('revisionCard.textContent'),/参考资产.*林森（正面头肩）.*清空/s);
 evaluate('revisionShot.keyframe=revisionPlan.before.keyframe;revisionApply.click()');
 equal(evaluate(`[revisionShot.keyframe,picture.data.prompt.includes("木盒在左手"),picture.data.prompt.endsWith(continuitySuffix),
   newestStoryVideo.data.fields.action,newestStoryVideo.data.fields.dialogue,curV(newestStoryVideo).node_data.fields.action===oldAction,
   JSON.stringify(B.edges)===revisionEdges,$("[data-run-shot-revision]",revisionCard).dataset.mode]`),
   ["木盒在左手",true,true,"抬起木盒","人工调整的对白",true,true,"all"],
   'confirmed shot revision updates the linked prompts while retaining manual changes, history and continuity links');
 equal(evaluate('[revisionShot.asset_refs,picture.data.prompt.includes("next-hero"),newestStoryVideo.data.fields.scene.includes("next-hero")]'),
  [[],false,false],'clearing references in the revision removes them from both linked generation nodes');
 evaluate('newestStoryVideo.data.fields.dialogue=oldDialogue;undo()');
 w.fetch=storyCaptureFetch;
 evaluate('AC.board=groupPlanBoard;undo();undo()');
 evaluate('const liveStory=node(storyNode.id);checkpoint();liveStory.data.shots.reverse();refresh(liveStory)');
 equal(evaluate('scriptShotLinks(liveStory).map(pair=>pair.vid)'),[evaluate('newStoryPair.vid'),evaluate('legacyStoryVideo.id')],
  'editing shot order keeps each generated pair attached to its own shot');
 evaluate('undo();undo()');
 assert.equal(evaluate('B.nodes.length'),evaluate('storyBefore'));
 evaluate('undo()');
 assert.equal(evaluate('node(storyNode.id).data.shots.length'),1);
 evaluate('$("#groupRunProgress [data-dismiss]").click();restore(groupRunBase);delete B.batch_layout;save()');
 assert.equal(evaluate('sessionStorage.getItem(groupRunStorageKey(boardId))'),null,'dismissing progress removes the saved receipt');
 const groupBatchFetch=w.fetch;
 const selectionBatchStart=submittedBatches.length;
 let selectionAudio;
 w.fetch=async(url,options)=>{
  if(String(url)!=="/api/audio/generate")return groupBatchFetch(url,options);
  selectionAudio=JSON.parse(options.body);
  jobs.set("selection-audio-job",{state:"running"});
  return {ok:true,text:async()=>JSON.stringify({ids:["selection-audio-job"],recipe:selectionAudio})};
 };
 evaluate(`const selectionBatchBase=snap(), oldBatchAudio=CAPS_LIST.audio_generation;
  CAPS_LIST.audio_generation={tts:[{id:"selection-voice",name:"旁白服务",voices:[{id:"v1",name:"旁白"}]}]};
  const selectedImage=addNode("image",1100,450,{prompt:"批量首帧",count:1},{name:"选区首帧"});
  const selectedVideo=addNode("video",1600,450,{prompt:"批量镜头",count:1},{name:"选区视频"});
  const selectedAudio=addNode("audio",2100,450,{mode:"tts",prompt:"选区旁白"},{name:"选区旁白"});
  link(selectedImage,selectedVideo,true);
  sel=new Set([selectedImage.id,selectedVideo.id,selectedAudio.id]);updateSel();
  $("#selectionTools [data-action=generate]").click();`);
 equal(evaluate('[$("#groupRunConfirm select").value,$$("#groupRunConfirm li strong").map(el=>el.textContent)]'),
  ['all',['选区首帧','选区视频','选区旁白']]);
 assert.equal(submittedBatches.length,selectionBatchStart);
 assert.equal(selectionAudio,undefined);
 evaluate('approveWorkflow()');
 await ready('selectedImage.job&&selectedAudio.job&&!selectedVideo.job','independent image and audio submit before the dependent video',350);
 assert.equal(selectionAudio.prompt,"选区旁白");
 finishBatch(selectionBatchStart,1);
 await ready('selectedVideo.job&&selectedAudio.job','the dependent video starts once its image finishes without waiting for the independent audio',350);
 assert.equal(submittedBatches[selectionBatchStart+1].req.images[0].ref,`output:h3studio/layout-job-${selectionBatchStart}-0.png`);
 finishBatch(selectionBatchStart+1,1);
 jobs.set("selection-audio-job",{state:"done",outputs:[{ref:"output:h3studio/selection-voice.wav",url:"/media?ref=output:h3studio/selection-voice.wav",meta:{duration:2}}]});
 await ready('!groupRun.active','selected nodes reach a terminal state',350);
 equal(evaluate('[groupRun.name,groupRun.steps.map(step=>step.status),B.groups.length]'),
  ['选中节点',['done','done','done'],evaluate('JSON.parse(selectionBatchBase).groups.length')]);
 evaluate('$("#groupRunProgress [data-dismiss]").click();restore(selectionBatchBase);CAPS_LIST.audio_generation=oldBatchAudio;');
 console.log('Selection batch generation passed: no persistent group, parallel image and audio, pinned dependent video and completion.');
 w.fetch=generationFetch;
 console.log('Group run DOM passed: confirmation, dependency order, pinned result reuse, failure isolation and stopping later submissions.');
 evaluate(`const runRangeBase=snap();
  const runRangeScript=addNode("script",4500,100,{style:"写实",characters:[],shots:[0,1,2,3].map(i=>({...storyLast,id:"range-"+i,characters:[]})),made:[]});
  const runRangeCount=B.nodes.length;selectOnly(runRangeScript.id);$("#shotListBtn").click();
  $("#shotList [data-run-range]").click();
  const runRangePicker=$("#shotRangePicker"), generationFirst=$("[name=first]",runRangePicker), generationLast=$("[name=last]",runRangePicker);
  generationFirst.value="1";generationFirst.dispatchEvent(new Event("change"));
  generationLast.value="2";generationLast.dispatchEvent(new Event("change"));`);
 assert.match(evaluate('$("#shotRangePicker [role=status]").textContent'),/已选 2 镜，其中 2 镜待展开/);
 assert.equal(evaluate('B.nodes.length===runRangeCount'),true);
 evaluate('$("#shotRangePicker [type=submit]").click()');
 equal(evaluate(`[runRangePicker.open,$("#groupRunConfirm").open,scriptShotLinks(runRangeScript).map(pair=>!!pair),
   $$("#groupRunConfirm li strong").map(item=>item.textContent),B.nodes.length-runRangeCount,B.nodes.some(n=>n.job)]`),
  [false,true,[false,true,true,false],["镜2 · 分镜图","镜2","镜3 · 分镜图","镜3"],4,false],
  'shot range expands only the requested shots in order and previews their work before any generation');
 evaluate('const scopedRunMode=$("#groupRunConfirm [name=mode]");scopedRunMode.value="frame";scopedRunMode.dispatchEvent(new Event("change"))');
 equal(evaluate('$$("#groupRunConfirm li strong").map(item=>item.textContent)'),['镜2 · 分镜图','镜3 · 分镜图']);
 evaluate(`closeCanvasGroupRunDialog();const previouslyGeneratedFrame=node(scriptShotLinks(runRangeScript)[1].img);
  previouslyGeneratedFrame.versions=[rerunMedia("range-already-generated")];previouslyGeneratedFrame.cur=0;
  const rangeAssistantBoard=AC.board;AC.board=boardId;
  acAppendEvent({kind:"tool_start",data:{name:"storyboard_range_run_plan",call_id:"scoped-shot-chat"}});
  acAppendEvent({kind:"tool_end",data:{name:"storyboard_range_run_plan",call_id:"scoped-shot-chat",result:{shot_range_plan:{
    board:boardId,script:runRangeScript.id,name:runRangeScript.name,first:2,last:3,
    anchors:[{id:"range-1"},{id:"range-2"}],mode:"missing_frame"}}}});
  $("[data-call=scoped-shot-chat] [data-open-shot-range]").click();`);
 equal(evaluate('[generationFirst.value,generationLast.value]'),['1','2'],'the assistant card opens with the planned range');
 evaluate('$("#shotRangePicker [type=submit]").click()');
 equal(evaluate('[scopedRunMode.value,$$("#groupRunConfirm li strong").map(item=>item.textContent)]'),
  ['missing_frame',['镜3 · 分镜图']],'a plan to fill missing frames keeps existing results and skips video generation');
 evaluate(`closeCanvasGroupRunDialog();
  const rangePriorVideo=node(scriptShotLinks(runRangeScript)[1].vid),rangeFollowingFrame=node(scriptShotLinks(runRangeScript)[2].img);
  const rangeFollowingVideo=node(scriptShotLinks(runRangeScript)[2].vid);
  const rangeGuide=addNode("image",4100,200,{}, {versions:[rerunMedia("range-guide")],cur:0});
  B.edges.push({from:rangeGuide.id,to:rangeFollowingFrame.id,ref:curV(rangeGuide).ref,prompt_slot:2});
  rangeFollowingFrame.data.image_ref_seq=2;rangeFollowingFrame.data.prompt+="\\n角色参考 @图{2}";
  const rangeFramePrompt=rangeFollowingFrame.data.prompt;
  const originalRangeTail=()=>B.edges.find(edge=>edge.to===rangeFollowingFrame.id&&edge.story_continuity);`);
 const batchTailRequests=[];
 w.fetch=(url,options)=>{
  if(String(url)!=="/api/lastframe")return groupBatchFetch(url,options);
  batchTailRequests.push(JSON.parse(options.body));
  const ref="input:h3studio/range-tail-"+batchTailRequests.length+".png";
  return Promise.resolve({ok:true,text:async()=>JSON.stringify({ref,url:'/media?ref='+encodeURIComponent(ref),w:64,h:64,at:4.9})});
 };
 const newChainStart=submittedBatches.length;
 evaluate(`acAppendEvent({kind:"tool_start",data:{name:"storyboard_range_run_plan",call_id:"continuous-shot-chat"}});
  acAppendEvent({kind:"tool_end",data:{name:"storyboard_range_run_plan",call_id:"continuous-shot-chat",result:{shot_range_plan:{
    board:boardId,script:runRangeScript.id,name:runRangeScript.name,first:2,last:3,
    anchors:[{id:"range-1"},{id:"range-2"}],mode:"missing",tail_mode:"connect"}}}});
  const continuityCard=$("[data-call=continuous-shot-chat]");
  $("[data-open-shot-range]",continuityCard).click();
  $("#shotRangePicker [type=submit]").click();
  const connectTailOption=$("#groupRunConfirm [name=connect-tails]");
  const tailRefreshOption=$("#groupRunConfirm [name=refresh-tails]"), rangeRunSubmit=$("#groupRunConfirm [type=submit]");`);
 assert.match(evaluate('continuityCard.textContent'),/连接缺失的上一镜尾帧/);
 equal(evaluate('[connectTailOption.closest("label").hidden,connectTailOption.checked,tailRefreshOption.closest("label").hidden]'),
  [false,true,true],'the assistant preselects new tail connections in the existing run dialog');
 assert.match(evaluate('$("#groupRunConfirm ol").textContent'),/连接上一镜尾帧 · 取本轮生成视频/);
 assert.match(evaluate('$("#groupRunConfirm [data-summary]").textContent'),/为 1 张分镜图连接上一镜尾帧/);
 evaluate('connectTailOption.click()');
 assert.doesNotMatch(evaluate('$("#groupRunConfirm ol").textContent'),/连接上一镜尾帧/);
 evaluate('connectTailOption.click()');
 assert.equal(evaluate('!!originalRangeTail() || rangeFollowingFrame.data.prompt!==rangeFramePrompt'),false);
 assert.equal(batchTailRequests.length,0,'preview does not capture a frame or alter the prompt');
 assert.equal(submittedBatches.length,newChainStart,'the assistant plan and opening its preview submit no work');
 evaluate('rangeRunSubmit.click()');
 await ready('rangePriorVideo.job','the prior missing video is submitted first',1000);
 assert.equal(submittedBatches.length,newChainStart+1);
 finishBatch(newChainStart,1);
 await ready('rangeFollowingFrame.job','a new tail is connected before submitting the following frame',1000);
 assert.equal(batchTailRequests[0].ref,`output:h3studio/layout-job-${newChainStart}-0.mp4`);
 equal(evaluate('[originalRangeTail().ref,originalRangeTail().prompt_slot,rangeFollowingFrame.data.prompt.startsWith(rangeFramePrompt)]'),
  ['input:h3studio/range-tail-1.png',3,true]);
 assert.match(evaluate('rangeFollowingFrame.data.prompt'),/参考上一镜尾帧 @图\{3\}/);
 assert.deepEqual(submittedBatches[newChainStart+1].req.images.map(input=>input.prompt_slot),[2,3]);
 finishBatch(newChainStart+1,1);
 await ready('rangeFollowingVideo.job','the new video waits for its new frame',1000);
 finishBatch(newChainStart+2,1);
 await ready('!groupRun.active','the new chain completes',1000);
 equal(evaluate('groupRun.steps.map(step=>step.status)'),['done','done','done']);
 const rangeBatchStart=submittedBatches.length;
 evaluate(`openScriptShotRangeRun(runRangeScript,1,2,"all");
  const oldRangeTailRef=originalRangeTail().ref, oldRangeTailSlot=originalRangeTail().prompt_slot;`);
 assert.match(evaluate('$("#groupRunConfirm [data-summary]").textContent'),/第 3 镜会沿用已固定的尾帧/);
 assert.equal(evaluate('tailRefreshOption.checked'),false);
 evaluate('tailRefreshOption.checked=true;tailRefreshOption.dispatchEvent(new Event("change"))');
 assert.match(evaluate('$("#groupRunConfirm ol").textContent'),/上一镜尾帧 · 取本轮生成视频/);
 assert.equal(batchTailRequests.length,1,'checking the option makes no media request');
 assert.equal(submittedBatches.length,rangeBatchStart);
 evaluate('rangeRunSubmit.click()');
 await ready('groupRun.steps[0]?.status==="running" && node(groupRun.steps[0].id).job','first frame is running',1000);
 finishBatch(rangeBatchStart,1);
 await ready('rangePriorVideo.job','the prior video runs after its own frame',1000);
 assert.equal(batchTailRequests.length,1,'capture waits for the prior video result');
 finishBatch(rangeBatchStart+1,1);
 await ready('rangeFollowingFrame.job','next frame is submitted after capture',1000);
 assert.equal(batchTailRequests[1].ref,`output:h3studio/layout-job-${rangeBatchStart+1}-0.mp4`);
 assert.equal(batchTailRequests[1].position,'last');
 assert.equal(submittedBatches[rangeBatchStart+2].req.images.find(input=>input.prompt_slot===evaluate('oldRangeTailSlot')).ref,
  'input:h3studio/range-tail-2.png','the next frame sends the new tail at the existing prompt slot');
 equal(evaluate('[originalRangeTail().ref,originalRangeTail().prompt_slot]'),['input:h3studio/range-tail-2.png',evaluate('oldRangeTailSlot')]);
 assert.equal(evaluate('B.nodes.some(n=>n.type==="image"&&n.versions.some(v=>v.ref===oldRangeTailRef))'),true);
 finishBatch(rangeBatchStart+2,1);
 await ready('node(scriptShotLinks(runRangeScript)[2].vid).job','next shot video follows its new frame',1000);
 finishBatch(rangeBatchStart+3,1);
 await ready('!groupRun.active','tail refresh batch completes',1000);
 equal(evaluate('groupRun.steps.map(step=>step.status)'),['done','done','done','done']);
 evaluate(`openScriptShotRangeRun(runRangeScript,1,2,"all");
  tailRefreshOption.checked=true;tailRefreshOption.dispatchEvent(new Event("change"));rangeRunSubmit.click();`);
 await ready('groupRun.steps[0]?.status==="running" && node(groupRun.steps[0].id).job','first frame is retried',1000);
 finishBatch(rangeBatchStart+4,1);
 await ready('rangePriorVideo.job','the prior video is retried',1000);
 jobs.set(submittedBatches[rangeBatchStart+5].jobId,{state:"error",error:"模拟上一镜失败"});
 await ready('!groupRun.active','dependent shots are skipped when the prior video fails',1000);
 equal(evaluate('groupRun.steps.map(step=>step.status)'),['done','error','skipped','skipped']);
 assert.equal(batchTailRequests.length,2);
 assert.equal(submittedBatches.length,rangeBatchStart+6,'failure does not fall back to the old tail or submit its dependent video');
 evaluate('$("#groupRunProgress [data-dismiss]").click()');
 w.fetch=generationFetch;
 console.log('Storyboard batch continuity DOM passed: explicit preview, new and refreshed tail references, stable prompt slots and upstream failure isolation.');
 evaluate(`const sortShotsButton=$("#shotList [data-sort-shots]");
  const sortBeforeEdges=JSON.stringify(B.edges), sortBeforeMedia=JSON.stringify([rangePriorVideo,rangeFollowingVideo]);
  const rangeShotOrder=()=>node(runRangeScript.id).data.shots.map(shot=>shot.id);
  sortShotsButton.click();
  $('[data-shot-order="2"] [data-step="-1"]').click();`);
 equal(evaluate('rangeShotOrder()'),['range-0','range-2','range-1','range-3'],'the arrow moves the chosen shot one position');
 evaluate(`const sortRows=$$("#shotList ol li");
  const shotDrag=(type,input)=>Object.assign(new Event(type,{cancelable:true}),input);
  const shotDragData={setData(){},dropEffect:"",effectAllowed:""};
  $(".sl-sort-grip",sortRows[1]).ondragstart(shotDrag("dragstart",{dataTransfer:shotDragData}));
  sortRows[0].ondragover(shotDrag("dragover",{clientY:-1,dataTransfer:shotDragData}));`);
 assert.equal(evaluate('sortRows[0].dataset.shotDrop'),'before');
 evaluate('sortRows[0].ondrop(shotDrag("drop",{clientY:-1,dataTransfer:shotDragData}))');
 equal(evaluate('rangeShotOrder()'),['range-2','range-0','range-1','range-3'],'dragging a shot before the first row moves it across the list');
 equal(evaluate(`[JSON.stringify(B.edges)===sortBeforeEdges,JSON.stringify([rangePriorVideo,rangeFollowingVideo])===sortBeforeMedia,
  scriptShotLinks(runRangeScript)[0].vid===rangeFollowingVideo.id,madeShots(runRangeScript)[0].vid===rangeFollowingVideo.id]`),
  [true,true,true,true],'versions and pinned edges remain unchanged while subsequent tools use the new order');
 assert.match(evaluate('$("[data-script-tail-status=\'0\']",$("#shotList")).textContent'),/首镜仍引用旧的上一镜尾帧/);
 evaluate(`sortShotsButton.dispatchEvent(new KeyboardEvent("keydown",{key:"z",ctrlKey:true,bubbles:true,cancelable:true}));`);
 equal(evaluate('rangeShotOrder()'),['range-0','range-2','range-1','range-3'],'undo works with focus inside the shot list');
 equal(evaluate('$$("#shotList [data-shot-order]").length'),4,'undo refreshes the open list');
 evaluate(`sortShotsButton.dispatchEvent(new KeyboardEvent("keydown",{key:"z",ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}));`);
 equal(evaluate('rangeShotOrder()'),['range-2','range-0','range-1','range-3'],'redo restores the new ordering');
 console.log('Storyboard ordering DOM passed: arrows, drag, stable references, continuity warnings and undo/redo.');
 evaluate(`sortShotsButton.click();
  const currentRangeFrame=()=>node(rangeFollowingFrame.id);
  const rangeTail=()=>scriptTailEdges().get(rangeFollowingFrame.id);
  const tailRemoveBefore={prompt:currentRangeFrame().data.prompt,versions:JSON.stringify(currentRangeFrame().versions),ref:rangeTail().ref,source:rangeTail().from};
  const firstTailControls=$('[data-shot-tail-actions="0"]',$("#shotList"));
  $("[data-tail-remove]",firstTailControls).click();`);
 equal(evaluate(`[!!rangeTail(),currentRangeFrame().data.prompt===rangeFramePrompt,
  JSON.stringify(currentRangeFrame().versions)===tailRemoveBefore.versions,curV(node(tailRemoveBefore.source)).ref===tailRemoveBefore.ref]`),
  [false,true,true,true],'removing the first-shot tail clears just its generated instruction and retains the capture and history');
 evaluate(`sortShotsButton.dispatchEvent(new KeyboardEvent("keydown",{key:"z",ctrlKey:true,bubbles:true,cancelable:true}));`);
 equal(evaluate('[currentRangeFrame().data.prompt===tailRemoveBefore.prompt,rangeTail().ref===tailRemoveBefore.ref]'),
  [true,true],'undo restores the exact tail binding and prompt');
 evaluate(`sortShotsButton.click();
  $('[data-shot-order="0"] [data-step="1"]').click();
  $('[data-shot-order="1"] [data-step="1"]').click();
  node(rangePriorVideo.id).cur=0;drawEdges();`);
 const repairFetch=w.fetch, repairRequests=[];
 w.fetch=(url,options)=>{
  if(String(url)!=="/api/lastframe")return repairFetch(url,options);
  repairRequests.push(JSON.parse(options.body));
  return Promise.resolve({ok:true,text:async()=>JSON.stringify({ref:"input:h3studio/repaired-tail.png",w:64,h:64,at:4.9})});
 };
 const relinkButton=`$('[data-shot-tail-actions="2"] [data-tail-link]',$("#shotList"))`;
 assert.equal(evaluate(relinkButton+'.hidden'),false,'switching the prior version reveals a repair action');
 const beforeRepairSelection=evaluate('JSON.stringify([...sel])');
 evaluate(relinkButton+'.click()');
 await ready('rangeTail()?.ref==="input:h3studio/repaired-tail.png"','repair uses the new selected prior version');
 assert.equal(repairRequests[0].ref,evaluate('curV(node(rangePriorVideo.id)).ref'));
 equal(evaluate('[rangeTail().prompt_slot,currentRangeFrame().data.prompt===tailRemoveBefore.prompt,JSON.stringify([...sel])]'),
  [3,true,beforeRepairSelection],'repair keeps the slot, prompt and canvas selection stable');
 assert.match(evaluate('$("[data-script-tail-status=\'2\']",$("#shotList")).textContent'),/当前分镜图尚未使用/);
 w.fetch=repairFetch;
 console.log('Storyboard tail repair DOM passed: in-list refresh, targeted removal, original media retention and undo.');
 evaluate(`sortShotsButton.click();
  const liveRangeScript=node(runRangeScript.id), editedRangeShot=liveRangeScript.data.shots[2];
  const editedRangeVideo=node(rangeFollowingVideo.id);
  editedRangeVideo.data.fields.dialogue="节点独立台词";
  const editorHistory=JSON.stringify([currentRangeFrame().versions,editedRangeVideo.versions]);
  const editorLink=rangeTail().ref, editorAction=editedRangeShot.action;
  $('[data-edit-shot="2"]',$("#shotList")).click();
  const shotEditDialog=$("#shotEditor"), shotEditForm=$("form",shotEditDialog), shotEditSubmit=$("[type=submit]",shotEditForm);
  const shotEditValue=(name,value)=>{
    const field=shotEditForm.elements.namedItem(name);field.value=value;field.dispatchEvent(new Event("input",{bubbles:true}));
  };
  shotEditValue("keyframe","木盒已经打开");
  shotEditValue("action","推近木盒\\n抬头看窗外");
  shotEditValue("dialogue","林森：走吧。");
  editedRangeShot.action=["他人刚修改了动作"];
  shotEditSubmit.click();`);
 assert.match(evaluate('$("[role=status]",shotEditForm).textContent'),/镜头内容已变化/);
 equal(evaluate('[shotEditForm.elements.action.value,currentRangeFrame().data.prompt.includes("木盒已经打开")]'),
  ['推近木盒\n抬头看窗外',false],'conflicting edits preserve the form draft without overwriting the graph');
 evaluate('editedRangeShot.action=editorAction;shotEditSubmit.click()');
 equal(evaluate(`[editedRangeShot.action,editedRangeShot.dialogue,editedRangeVideo.data.fields.action,editedRangeVideo.data.fields.dialogue,
  currentRangeFrame().data.prompt.includes("木盒已经打开"),currentRangeFrame().data.prompt.includes("@图{3}"),
  rangeTail().ref===editorLink,JSON.stringify([currentRangeFrame().versions,editedRangeVideo.versions])===editorHistory]`),
  [['推近木盒','抬头看窗外'],['林森：走吧。'],'推近木盒\n抬头看窗外','节点独立台词',true,true,true,true],
  'manual edits sync to original image and video fields, retain local overrides and do not rewrite history');
 assert.match(evaluate('$("[role=status]",shotEditForm).textContent'),/同步了 2 个生成节点.*独立设置/);
 w.__memories=[...(w.__memories||[]),{id:"shot-edit-hero",name:"镜头角色",kind:"character",board:evaluate("boardId"),
  character_views:{main:"input:h3studio/shot-main.png",face:"input:h3studio/shot-face.png"}}];
 evaluate(`$("[data-shot-assets]",shotEditForm).open=true;
  const shotAssetQuery=$("[data-shot-asset-query]",shotEditForm);
  shotAssetQuery.value="镜头角";shotAssetQuery.dispatchEvent(new Event("input",{bubbles:true}));`);
 await ready('!!$("[data-add-shot-asset=shot-edit-hero]")','shot editor searches the accessible library');
 evaluate(`const shotAssetResult=$("[data-add-shot-asset=shot-edit-hero]").closest("li");
  $("select",shotAssetResult).value="face";$("button",shotAssetResult).click();shotEditSubmit.click();`);
 equal(evaluate(`[editedRangeShot.asset_refs.find(asset=>asset.id==="shot-edit-hero").view,
  currentRangeFrame().data.prompt.includes("@{shot-edit-hero#face|镜头角色}"),
  editedRangeVideo.data.fields.scene.includes("@{shot-edit-hero#face|镜头角色}")]`),
  ['face',true,true],'saving a shot reference updates both linked nodes');
 evaluate(`editedRangeVideo.data.fields.scene="节点独立场景";
  $('[data-remove-shot-asset][aria-label^="移除 镜头角色"]',shotEditForm).click();
  $("select",shotAssetResult).value="main";$("button",shotAssetResult).click();shotEditSubmit.click();`);
 equal(evaluate(`[editedRangeShot.asset_refs.find(asset=>asset.id==="shot-edit-hero").view,
  currentRangeFrame().data.prompt.includes("@{shot-edit-hero#main|镜头角色}"),
  currentRangeFrame().data.prompt.includes("@{shot-edit-hero#face|镜头角色}"),
  editedRangeVideo.data.fields.scene,JSON.stringify([currentRangeFrame().versions,editedRangeVideo.versions])===editorHistory]`),
  ['main',true,false,'节点独立场景',true],'view replacement preserves independently edited fields and history');
 assert.match(evaluate('$("[role=status]",shotEditForm).textContent'),/独立设置/);
 w.__memories=w.__memories.filter(asset=>asset.id!=="shot-edit-hero");
 const beforeEditRun=submittedBatches.length;
 evaluate('$("[data-run-shot-edit]",shotEditForm).click()');
 equal(evaluate('[shotEditDialog.open,$("#groupRunConfirm").open,$("#groupRunConfirm [name=mode]").value,$$("#groupRunConfirm ol li").length]'),
  [false,true,'all',2],'reviewing regeneration opens the existing two-node preview');
 assert.equal(submittedBatches.length,beforeEditRun,'editing and previewing do not trigger generation');
 console.log('Storyboard shot editor DOM passed: safe form save, local override protection, unchanged history and exact regeneration preview.');
 evaluate(`closeCanvasGroupRunDialog();
  const shotsBeforeStructure=rangeShotOrder(), graphBeforeStructure=JSON.stringify(B.edges), nodeCountBeforeStructure=B.nodes.length;
  const addShotButton=$("[data-add-shot]",$("#shotList")), placementShot=$("[data-shot-placement] select",shotEditForm);
  addShotButton.click();
  shotEditValue("keyframe","未保存的镜头");
  $("[data-close]",shotEditForm).click();`);
 const priorShotOrder=Array.from(evaluate('shotsBeforeStructure'));
 equal(evaluate('rangeShotOrder()'),priorShotOrder,'closing a new draft leaves the storyboard untouched');
 evaluate(`addShotButton.click();placementShot.value="0";
  shotEditValue("keyframe","远景，窗外天亮");
  shotEditValue("characters","林森，裴简");
  shotEditSubmit.click();`);
 equal(evaluate(`[rangeShotOrder().slice(1),liveRangeScript.data.shots[0].keyframe,liveRangeScript.data.shots[0].characters,
  B.nodes.length===nodeCountBeforeStructure,scriptShotLinks(liveRangeScript)[0]]`),
  [priorShotOrder,'远景，窗外天亮',['林森','裴简'],true,null],
  'adding at a chosen position stores a new independent shot without expanding or submitting it');
 evaluate(`editedRangeShot.frame={ref:"input:h3studio/existing-shot.png"};
  $('[data-edit-shot="3"]',$("#shotList")).click();
  $("[data-duplicate-shot]",shotEditForm).click();`);
 equal(evaluate('[placementShot.value,shotEditForm.elements.keyframe.value,liveRangeScript.data.shots.length]'),
  ['4','木盒已经打开',5],'copy starts an editable draft immediately after the chosen shot');
 evaluate(`shotEditSubmit.click();
  const duplicatedRangeShot=liveRangeScript.data.shots[4];`);
 equal(evaluate(`[duplicatedRangeShot.id!==editedRangeShot.id,duplicatedRangeShot.action,duplicatedRangeShot.action!==editedRangeShot.action,
  !!duplicatedRangeShot.frame,scriptShotLinks(liveRangeScript)[4]]`),
  [true,['推近木盒','抬头看窗外'],true,false,null],'copy duplicates the specification and leaves generated media attached to the original');
 equal(evaluate('[duplicatedRangeShot.asset_refs.find(asset=>asset.id==="shot-edit-hero").view,duplicatedRangeShot.asset_refs!==editedRangeShot.asset_refs]'),
  ['main',true],'copy preserves the shot reference without sharing its editable list');
 evaluate(`$('[data-edit-shot="3"]',$("#shotList")).click();
  $("[data-remove-shot]",shotEditForm).click();`);
 assert.match(evaluate('$("[role=status]",shotEditForm).textContent'),/图片、视频和历史版本会保留/);
 assert.equal(evaluate('liveRangeScript.data.shots.includes(editedRangeShot)'),true);
 evaluate('$("[data-confirm-shot-remove]",shotEditForm).click()');
 equal(evaluate(`[rangeShotOrder().includes(editedRangeShot.id),rangeShotOrder()[3]===duplicatedRangeShot.id,
  scriptShotLinks(liveRangeScript)[3],!!node(rangeFollowingVideo.id),B.nodes.length===nodeCountBeforeStructure,JSON.stringify(B.edges)===graphBeforeStructure]`),
  [false,true,null,true,true,true],'confirmed removal detaches the shot and leaves its canvas and history intact');
 evaluate('undo()');
 assert.equal(evaluate('scriptShotLinks(node(runRangeScript.id))[3].vid'),evaluate('rangeFollowingVideo.id'));
 assert.equal(submittedBatches.length,beforeEditRun);
 console.log('Storyboard structure DOM passed: insert, copy independent settings, detach while retaining media, and undo.');
 evaluate(`const sourceScriptForMedia=node(runRangeScript.id);
  const adoptedVideo=addNode("video",5300,200,{prompt:"独立上传素材"},{name:"已上传的片段",
    versions:[{ref:"input:h3studio/adopted-cut.mp4",w:1280,h:720,seconds:4}],cur:0});
  const adoptedStill=addNode("image",5650,200,{}, {name:"已生成的分镜图",versions:[rerunMedia("existing-still")],cur:0});
  const mediaVideoBefore=JSON.stringify(adoptedVideo);
  const originalAssociationEdges=JSON.stringify(B.edges);
  $('[data-shot-media="0"]',$("#shotList")).click();
  const mediaForm=$("#shotMediaPicker form"), [imagePicker,videoPicker]=$$("select",mediaForm);
  const mediaConfirm=$("[type=submit]",mediaForm);
  const chooseShotMedia=(picker,id)=>{picker.value=id;picker.dispatchEvent(new Event("change",{bubbles:true}));};`);
 equal(evaluate('[videoPicker.options[videoPicker.options.length-1].textContent,[...videoPicker.options].some(option=>option.value===rangeFollowingVideo.id)]'),
  ['已上传的片段 · 版本 1',false],'the picker identifies the active version and excludes videos already attached to another shot');
 evaluate('chooseShotMedia(videoPicker,adoptedVideo.id);mediaConfirm.click()');
 equal(evaluate('[scriptShotLinks(sourceScriptForMedia)[0].vid,JSON.stringify(B.edges)===originalAssociationEdges,JSON.stringify(adoptedVideo)===mediaVideoBefore]'),
  [evaluate('adoptedVideo.id'),true,true],'association reuses the node without inventing generation lineage');
 evaluate(`const previousMediaDraft=localStorage.getItem(filmDraftPrefix()+"latest");
  const filmStartForMedia=$("[data-film-from]",$("#shotList"));filmStartForMedia.selectedIndex=0;
  filmStartForMedia.dispatchEvent(new Event("change"));$("[data-film]",$("#shotList")).click();`);
 equal(evaluate('FILM.spec.clips.map(clip=>clip.ref)'),['input:h3studio/adopted-cut.mp4'],'the existing clip is available in the storyboard film path');
 evaluate(`const mediaTestDraft=FILM.key;closeFilm();localStorage.removeItem(mediaTestDraft);
  if(previousMediaDraft)localStorage.setItem(filmDraftPrefix()+"latest",previousMediaDraft);else localStorage.removeItem(filmDraftPrefix()+"latest");
  const countBeforeCompletingShot=B.nodes.length;
  openShotRangePicker(sourceScriptForMedia,null,{firstIndex:0,lastIndex:0});
  $("#shotRangePicker [type=submit]").click();
  const completedVideoPair=scriptShotLinks(sourceScriptForMedia)[0];`);
 equal(evaluate(`[B.nodes.length-countBeforeCompletingShot,completedVideoPair.vid===adoptedVideo.id,!!node(completedVideoPair.img),
  B.edges.some(edge=>edge.to===adoptedVideo.id),JSON.stringify(adoptedVideo)===mediaVideoBefore]`),
  [1,true,true,false,true],'filling a video-only shot creates just a frame node without rewriting the existing video');
 evaluate(`closeCanvasGroupRunDialog();
  $('[data-shot-media="4"]',$("#shotList")).click();
  chooseShotMedia(imagePicker,adoptedStill.id);mediaConfirm.click();
  const countBeforeMakingVideo=B.nodes.length;
  openShotRangePicker(sourceScriptForMedia,null,{firstIndex:4,lastIndex:4});
  $("#shotRangePicker [type=submit]").click();
  const completedImagePair=scriptShotLinks(sourceScriptForMedia)[4];`);
 equal(evaluate(`[B.nodes.length-countBeforeMakingVideo,completedImagePair.img===adoptedStill.id,
  B.edges.some(edge=>edge.from===adoptedStill.id&&edge.to===completedImagePair.vid&&edge.role==="first")]`),
  [1,true,true],'filling an image-only shot creates just a video node and sets its first-frame input');
 assert.equal(submittedBatches.length,beforeEditRun,'association and filling nodes do not submit a generation');
 console.log('Storyboard media association DOM passed: existing nodes, ordered editing and precise missing-node expansion.');
 evaluate('closeCanvasGroupRunDialog();$("#shotList [data-close]").click();AC.board=rangeAssistantBoard;restore(runRangeBase);save()');
 evaluate(`const copyFlowBase=snap();
  const copyAsset=(filename,fields={})=>({ref:"output:h3studio/"+filename,url:"/media?ref=output:h3studio/"+filename,...fields});
  const copyGuide=addNode("image",1200,700,{}, {versions:[copyAsset("guide.png",{w:512,h:512})],cur:0});
  const originalImage=addNode("image",1800,700,{prompt:"当前说明",count:4,asset:{id:"copy-fixture",kind:"character"}},
    {versions:[copyAsset("image-original.png",{prompt:"历史说明",w:768,h:1024,
      generation_record:{settings:{seed:17,ar:.75},inputs:[{node_id:copyGuide.id,ref:curV(copyGuide).ref}]}}),
      copyAsset("image-selected.png",{w:512,h:512})],cur:1});
  const useImage=addNode("video",2400,700);link(originalImage,useImage,true);
  const beforeVersionCopy=JSON.stringify(originalImage);
  $(".vtabs button",els.get(originalImage.id)).dispatchEvent(new KeyboardEvent("keydown",{key:"F10",shiftKey:true,bubbles:true,cancelable:true}));
  $("#videoTabMenu [data-version-copy]").click();
  const copiedImage=node([...sel][0]);`);
 equal(evaluate(`[JSON.stringify(originalImage)===beforeVersionCopy,copiedImage.type,curV(copiedImage).ref,copiedImage.data.prompt,
  copiedImage.data.seed,copiedImage.data.count,!!copiedImage.data.asset,
  B.edges.some(e=>e.from===copyGuide.id&&e.to===copiedImage.id),B.edges.some(e=>e.from===originalImage.id&&e.to===useImage.id),
  curV(copiedImage).copied_from.version]`),
 [true,"image","output:h3studio/image-original.png","历史说明",17,1,false,true,true,1],
 'copy from the version menu keeps the original and its downstream links, while restoring the selected result and its verified inputs');
 evaluate('undo()');
 assert(evaluate('!node(copiedImage.id) && node(originalImage.id).versions.length===2'));
 evaluate(`const versionCopyAudio=addNode("audio",3400,650,{prompt:"当前配乐",mode:"music"},{versions:[
  copyAsset("voice-old.wav",{seconds:2,audio_recipe:{mode:"tts",voice:"v1",prompt:"历史对白",speed:.9}}),
  copyAsset("music-now.wav",{seconds:4})],cur:1});
  const hitTestBefore=document.elementFromPoint;
  document.elementFromPoint=()=>vp;
  const historicalAudio=$(".vtabs button",els.get(versionCopyAudio.id));
  historicalAudio.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true,clientX:100,clientY:100}));
  window.dispatchEvent(new MouseEvent("pointermove",{clientX:500,clientY:450}));
  `);
 assert(evaluate('$(".version-drag-label.can-drop")?.textContent==="版本 1"'));
 evaluate(`window.dispatchEvent(new MouseEvent("pointerup",{clientX:500,clientY:450}));
  historicalAudio.click();
  document.elementFromPoint=hitTestBefore;
  const copiedAudio=node([...sel][0]);`);
 equal(evaluate('[versionCopyAudio.cur,copiedAudio.type,curV(copiedAudio).ref,curV(copiedAudio).seconds,copiedAudio.data.mode,copiedAudio.data.prompt,copiedAudio.data.voice,$(".version-drag-label")]'),
 [1,"audio","output:h3studio/voice-old.wav",2,"tts","历史对白","v1",null],'dragging copies the historical audio recipe and leaves the current version selected on the source');
 evaluate(`const seedVersionTarget=addNode("audio",3600,900,{mode:"seed_audio"});
  document.elementFromPoint=()=>$(".card",els.get(seedVersionTarget.id));
  const beforeVersionDrop=B.nodes.length;
  historicalAudio.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true,clientX:100,clientY:100}));
  window.dispatchEvent(new MouseEvent("pointermove",{clientX:520,clientY:470}));`);
 assert(evaluate('$(".version-drag-label.can-drop")?.textContent==="用作参考 · 版本 1"'));
 evaluate(`window.dispatchEvent(new MouseEvent("pointerup",{clientX:520,clientY:470}));
  document.elementFromPoint=hitTestBefore;`);
 equal(evaluate(`[versionCopyAudio.cur,B.nodes.length===beforeVersionDrop,
  seedVersionTarget.data.references[0].ref,B.edges.find(e=>e.to===seedVersionTarget.id).ref]`),
 [1,true,"output:h3studio/voice-old.wav","output:h3studio/voice-old.wav"],'dropping a historical tab on reference generation pins that version without copying or switching the source');
 evaluate(`const versionCopyVideo=node(useImage.id);versionCopyVideo.versions=[
  copyAsset("video-old.mp4",{w:640,h:480,seconds:5,input_edges:[{from:copyGuide.id,to:versionCopyVideo.id,role:"first"}],node_data:{...versionCopyVideo.data,prompt:"旧镜头"}}),
  copyAsset("video-new.mp4",{w:640,h:480,seconds:8})];versionCopyVideo.cur=1;render(versionCopyVideo);
  const copiedVideo=vtCopyVersion(versionCopyVideo,0);
  const versionCopyPriorAccess=B.access;B.access="reviewer";const readOnlyCopy=vtCopyVersion(versionCopyVideo,1);B.access=versionCopyPriorAccess;`);
 equal(evaluate('[versionCopyVideo.cur,copiedVideo.data.prompt,curV(copiedVideo).input_edges[0].to===copiedVideo.id,typeof readOnlyCopy]'),
 [1,"旧镜头",true,"boolean"],'copying a historical video keeps the live source separate and retargets the copied input');
 assert.equal(evaluate('readOnlyCopy'),false);
 evaluate(`const dropVersionOn=(source,index,target)=>{
  document.elementFromPoint=()=>$(".card",els.get(target.id));
  const tab=$(".vtabs button[data-i='"+index+"']",els.get(source.id));
  tab.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true,clientX:100,clientY:100}));
  window.dispatchEvent(new MouseEvent("pointermove",{clientX:520,clientY:470}));
  const accepted=!!$(".version-drag-label.can-drop");
  window.dispatchEvent(new MouseEvent("pointerup",{clientX:520,clientY:470}));
  document.elementFromPoint=hitTestBefore;
  return accepted;
 };
 const imageRefTarget=addNode("image",3650,950);
 const firstImageDrop=dropVersionOn(originalImage,0,imageRefTarget);
 const videoRefTarget=addNode("video",3650,1200);
 link(versionCopyVideo,videoRefTarget,true);
 const videoRefEdge=videoInputs(videoRefTarget)[0].edge;
 Object.assign(videoRefEdge,{start:1,end:3,prompt_slot:3});
 const historicalVideoDrop=dropVersionOn(versionCopyVideo,0,videoRefTarget);
 `);
 equal(evaluate(`[firstImageDrop,historicalVideoDrop,originalImage.cur,imageInputs(imageRefTarget)[0].version.ref,
  versionCopyVideo.cur,videoInputs(videoRefTarget).length,videoRefEdge.ref,videoRefEdge.prompt_slot,
  Object.hasOwn(videoRefEdge,"start"),Object.hasOwn(videoRefEdge,"end")]`),
 [true,true,1,"output:h3studio/image-original.png",1,1,"output:h3studio/video-old.mp4",3,false,false],
 'image and video drops pin the historical source, retain an existing reference slot, and clear an old video range');
 evaluate(`selectOnly(imageRefTarget.id);
  const versionMention=$("#prompt");
  versionMention.focus();versionMention.value="@"+originalImage.id+"#";
  versionMention.setSelectionRange(versionMention.value.length,versionMention.value.length);`);
 await evaluate('cmSuggest(versionMention)');
 equal(evaluate('CM.matches.map(item=>item.version)'),[2,1],'a trailing hash browses the source history');
 evaluate(`versionMention.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true,cancelable:true}));
  versionMention.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));`);
 equal(evaluate('[versionMention.value,imageInputs(imageRefTarget)[0].version.ref,originalImage.cur]'),
 ['@图{1} ','output:h3studio/image-original.png',1],'completion inserts a stable reference to the chosen image');
 evaluate(`selectOnly(seedVersionTarget.id);versionMention.focus();versionMention.value="@"+versionCopyAudio.id+"#2";
  versionMention.setSelectionRange(versionMention.value.length,versionMention.value.length);`);
 await evaluate('cmSuggest(versionMention)');
 equal(evaluate('CM.matches.map(item=>item.version)'),[2],'a numbered search returns the requested audio version');
 evaluate('versionMention.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",bubbles:true,cancelable:true}))');
 equal(evaluate('[versionMention.value,seedVersionTarget.data.references.map(item=>item.ref)]'),
 ['@音频2 ',['output:h3studio/voice-old.wav','output:h3studio/music-now.wav']],'Seed Audio completion inserts the correct numbered reference');
 evaluate(`const pinnedVoice={node_id:versionCopyAudio.id,ref:versionCopyAudio.versions[0].ref,kind:"audio"};
  const seedBulkTarget=addNode("audio",3660,1050,{mode:"seed_audio",references:[pinnedVoice]},
    {versions:[copyAsset("recorded-dialogue.wav",{audio_recipe:{mode:"seed_audio",references:[pinnedVoice]}})],cur:0});
  drawEdges();
  vtTabMenu(versionCopyAudio,1,120,120);
  $("#videoTabMenu [data-version-update]").click();`);
 assert.match(evaluate('$("#versionRefUpdate [data-summary]").textContent'),/版本 2 · 更新 1 个节点/);
 evaluate('$("#versionRefUpdate form").dispatchEvent(new Event("submit",{cancelable:true}))');
 equal(evaluate(`[seedBulkTarget.data.references[0].ref,curV(seedBulkTarget).audio_recipe.references[0].ref,
  seedVersionTarget.data.references.map(ref=>ref.ref)]`),
 ['output:h3studio/music-now.wav','output:h3studio/voice-old.wav',['output:h3studio/voice-old.wav','output:h3studio/music-now.wav']],
 'bulk reference update preserves the generation recipe and skips a target using multiple versions of the source');
 evaluate('vtOpenReferenceUpdate(versionCopyVideo,1)');
 assert.match(evaluate('$("#versionRefUpdate [data-summary]").textContent'),/更新 1 个节点/);
 evaluate('$("#versionRefUpdate form").dispatchEvent(new Event("submit",{cancelable:true}))');
 equal(evaluate('[videoRefEdge.ref,videoRefEdge.prompt_slot,versionCopyVideo.cur]'),
 ['output:h3studio/video-new.mp4',3,1],'bulk update keeps the stable slot while pinning the chosen video');
 evaluate(`const replacementVideo=addNode("video",3920,1200,{},
   {name:"替换素材",versions:[copyAsset("replacement-old.mp4",{seconds:6}),copyAsset("replacement-new.mp4",{seconds:8})],cur:1});
  const upstreamVideo=addNode("video",3880,1000,{},
   {versions:[copyAsset("upstream.mp4",{seconds:6})],cur:0});
  const duplicateTarget=addNode("video",4200,1200);
  link(versionCopyVideo,upstreamVideo,true);
  link(upstreamVideo,replacementVideo,true);
  link(versionCopyVideo,duplicateTarget,true);
  link(replacementVideo,duplicateTarget,true);
  videoRefTarget.versions=[copyAsset("already-generated.mp4",{seconds:5})];videoRefTarget.cur=0;
  Object.assign(videoRefEdge,{start:1,end:3});
  const originalCard=$(".card",els.get(versionCopyVideo.id));
  ctxMenu({target:originalCard,clientX:120,clientY:120});
  $("#ctxMenu [data-a=replace-reference]").click();
  const replacementSelect=$("#versionRefUpdate [name=replacement]");
  replacementSelect.value=replacementVideo.id;
  replacementSelect.dispatchEvent(new Event("change"));
  const replacementVersion=$("#versionRefUpdate [name=replacementVersion]");
  replacementVersion.value="0";
  replacementVersion.dispatchEvent(new Event("change"));`);
 assert.match(evaluate('$("#versionRefUpdate [data-summary]").textContent'),/→ 替换素材 · 版本 1 · 更新 1 个节点/);
 assert.match(evaluate('$("#versionRefUpdate ol").textContent'),/参考区间将重置/);
 evaluate('$("#versionRefUpdate form").dispatchEvent(new Event("submit",{cancelable:true}))');
 equal(evaluate(`[videoRefEdge.from===replacementVideo.id,videoRefEdge.ref,videoRefEdge.prompt_slot,videoRefEdge.start??null,
  curV(videoRefTarget).input_edges[0].from===versionCopyVideo.id,curV(videoRefTarget).input_edges[0].ref,
  videoInputs(upstreamVideo)[0].source===versionCopyVideo,videoInputs(duplicateTarget).length,replacementVideo.cur]`),
 [true,"output:h3studio/replacement-old.mp4",3,null,true,"output:h3studio/video-new.mp4",true,2,1],
 'cross-node replacement pins the selected source, preserves history and skips cycles and duplicate links');
 evaluate(`const replacementAudio=addNode("audio",3900,1050,{},
   {versions:[copyAsset("replacement.wav")],cur:0});
  vtOpenReferenceUpdate(versionCopyAudio);
  const audioReplacement=$("#versionRefUpdate [name=replacement]");
  audioReplacement.value=replacementAudio.id;audioReplacement.dispatchEvent(new Event("change"));
  $("#versionRefUpdate form").dispatchEvent(new Event("submit",{cancelable:true}));`);
 equal(evaluate(`[seedBulkTarget.data.references[0].node_id===replacementAudio.id,
  B.edges.find(e=>e.to===seedBulkTarget.id).from===replacementAudio.id,
  curV(seedBulkTarget).audio_recipe.references[0].node_id===versionCopyAudio.id]`),
 [true,true,true],'reference audio keeps the current slots and leaves the historical recipe intact');
 evaluate(`const groupShot=addNode("video",4150,1200);
  link(versionCopyVideo,groupShot,true,{prompt_slot:6});
  const groupReplacement=addNode("video",3980,1420,{},
    {name:"新镜头素材",versions:[copyAsset("group-alternative.mp4",{seconds:5})],cur:0});
  const referenceGroup=ctNewGroup("复用模板",[videoRefTarget.id,groupShot.id]);
  ctSetFold(referenceGroup,true);
  $("[data-group-replace]",CT_GROUPS.get(referenceGroup.id)).click();
  const groupOriginal=$("#versionRefUpdate [name=original]");
  groupOriginal.value=versionCopyVideo.id;groupOriginal.dispatchEvent(new Event("change"));
  const groupNew=$("#versionRefUpdate [name=replacement]");
  groupNew.value=groupReplacement.id;groupNew.dispatchEvent(new Event("change"));`);
 equal(evaluate('Array.from(groupOriginal.options,option=>option.value).sort()'),
   [evaluate('versionCopyVideo.id'),evaluate('replacementVideo.id')].sort(),'the group lists its existing references, including external source nodes');
 assert.match(evaluate('$("#versionRefUpdate ol").textContent'),/版本 1/);
 evaluate('$("#versionRefUpdate form").dispatchEvent(new Event("submit",{cancelable:true}))');
 equal(evaluate(`[referenceGroup.collapsed,videoInputs(groupShot)[0].source===groupReplacement,
  videoInputs(groupShot)[0].edge.prompt_slot,videoInputs(upstreamVideo)[0].source===versionCopyVideo,
  videoInputs(videoRefTarget)[0].source===replacementVideo]`),
  [true,true,6,true,true],'a folded group replacement only changes matching links that enter the group');
 evaluate('Object.assign(videoRefEdge,{start:0.5,end:2})');
 assert.match(evaluate('groupGenerationNodes(referenceGroup,true).find(step=>step.id===videoRefTarget.id).references[0].label'),
  /视频参考 · 版本 1（固定） · 0\.5–2 秒/);
 evaluate(`const referenceCardBoard=AC.board;AC.board=boardId;
  acAppendEvent({kind:"tool_start",data:{name:"canvas_reference_plan",call_id:"reference-plan-card"}});
  acAppendEvent({kind:"tool_end",data:{name:"canvas_reference_plan",call_id:"reference-plan-card",result:{reference_plan:{
    board:boardId,source:groupReplacement.id,source_name:groupReplacement.name,replacement:replacementVideo.id,
    replacement_name:replacementVideo.name,ref:replacementVideo.versions[0].ref,version:1,group:referenceGroup.id,group_name:referenceGroup.name}}}});
  $("[data-call=reference-plan-card] [data-reference-plan]").click();`);
 equal(evaluate(`[$("#versionRefUpdate [name=original]").value===groupReplacement.id,
  $("#versionRefUpdate [name=replacement]").value===replacementVideo.id,$("#versionRefUpdate [name=replacementVersion]").value,
  replacementVideo.cur,videoInputs(groupShot)[0].source===groupReplacement]`),
  [true,true,"0",1,true],'the assistant card preselects the exact historical version without applying the plan or switching the source');
 assert.match(evaluate('$("#versionRefUpdate ol").textContent'),/版本 1/);
 evaluate('$("#versionRefUpdate [data-cancel]").click();AC.board=referenceCardBoard');
 evaluate(`const focusedVersion=$(".vtabs button.on",els.get(versionCopyVideo.id));focusedVersion.focus();
  focusedVersion.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowUp",bubbles:true,cancelable:true}));`);
 equal(evaluate('[versionCopyVideo.cur,document.activeElement.dataset.i,document.activeElement.tabIndex]'),[0,"0",0],'arrow navigation keeps keyboard focus on the activated tab');
 equal(evaluate(`{
  const strip=$(".vtabs",els.get(versionCopyVideo.id));
  Object.defineProperties(strip,{clientHeight:{value:24},scrollHeight:{value:52}});
  const wheel=new WheelEvent("wheel",{deltaY:80,bubbles:true,cancelable:true});
  document.activeElement.dispatchEvent(wheel);
  strip.scrollTop=28;
  render(versionCopyVideo);
  [wheel.defaultPrevented,strip.scrollTop,document.activeElement.dataset.i];
 }`),[false,28,"0"],'an overflowing version list handles wheel input without moving the canvas and keeps its scroll and focus on refresh');
 const referenceLibraryFetch=w.fetch;
 const replacementAssets=[
  {id:'lin-memory',kind:'character',name:'林森',aliases:['远林'],tags:['近代'],ref:'input:h3studio/old-lin.png',
   character_views:{main:'input:h3studio/lin-main.png',side:'input:h3studio/lin-side.png'},
   media:[{ref:'input:h3studio/lin-main.png'},{ref:'input:h3studio/lin-side.png',w:512,h:768}]},
  {id:'sound-memory',kind:'prop',name:'声音',media:[{ref:'input:h3studio/voice.wav',type:'audio'}]},
 ];
 w.fetch=(url,options)=>{
  const path=new URL(url,'http://oneshot.test').pathname;
  if(path==='/api/memory'&&options?.method==='GET')return Promise.resolve({ok:true,json:async()=>replacementAssets});
  if(path==='/api/memory/lin-memory'&&options?.method==='GET')return Promise.resolve({ok:true,json:async()=>replacementAssets[0]});
  return referenceLibraryFetch(url,options);
 };
 await evaluate(`vtOpenReferenceUpdate(node(originalImage.id));$("#versionRefUpdate [data-library-source]").onclick()`);
 assert.equal(evaluate('$("#versionRefUpdate [data-library-picker] [role=status]").textContent'),"");
 equal(evaluate('Array.from($("#versionRefUpdate [data-library-picker] select").options,option=>option.textContent)'),
   ['选择素材…','林森 · 标准主图 · 个人素材库','林森 · 全身侧面 · 个人素材库'],
   'only compatible assets are offered, with approved character views labelled separately');
 evaluate(`const librarySearch=$("#versionRefUpdate [data-library-picker] input");
  librarySearch.value="不匹配";librarySearch.dispatchEvent(new Event("input"));`);
 assert.match(evaluate('$("#versionRefUpdate [data-library-picker] [role=status]").textContent'),/没有匹配/);
 evaluate(`librarySearch.value="远林";librarySearch.dispatchEvent(new Event("input"));
  const librarySelect=$("#versionRefUpdate [data-library-picker] select");
  librarySelect.value="1";librarySelect.dispatchEvent(new Event("change"));`);
 assert.match(evaluate('$("#versionRefUpdate [data-reference-media] img").src'),/lin-side\.png/);
 evaluate('$("#versionRefUpdate form").dispatchEvent(new Event("submit",{cancelable:true}))');
 equal(evaluate(`[imageInputs(imageRefTarget)[0].source.name,imageInputs(imageRefTarget)[0].source.data.asset.id,
  imageInputs(imageRefTarget)[0].version.ref,imageInputs(imageRefTarget)[0].edge.prompt_slot]`),
  ['林森 · 全身侧面','lin-memory','input:h3studio/lin-side.png',1],
  'a library view becomes an asset-linked source and retains the prompt slot');
 await evaluate(`const scopedAssetShot=addNode("video",4220,1550,{},{name:"只替换此镜头"});
  link(node(originalImage.id),scopedAssetShot,true,{role:"subject",prompt_slot:7});
  const otherAssetShot=addNode("video",4500,1550);
  link(node(originalImage.id),otherAssetShot,true);
  AC.board=boardId;
  const scopedAssetCall="reference-library-plan";
  acAppendEvent({kind:"tool_start",data:{name:"canvas_reference_plan",call_id:scopedAssetCall}});
  acAppendEvent({kind:"tool_end",data:{name:"canvas_reference_plan",call_id:scopedAssetCall,result:{reference_plan:{
    board:boardId,source:originalImage.id,source_name:originalImage.name,memory:"lin-memory",
    replacement_name:"林森 · 全身侧面",ref:"input:h3studio/lin-side.png",character_view:"side",targets:[scopedAssetShot.id]}}}});
  $("#acMessages").onclick({target:$("[data-call=reference-library-plan] [data-reference-plan]")});`);
 assert.match(evaluate('$("#versionRefUpdate [data-reference-media] img").src'),/lin-side\.png/);
 equal(evaluate('$$("#versionRefUpdate ol li").map(li=>li.firstChild.textContent)'),['只替换此镜头'],
  'the assistant preview narrows the asset replacement to the requested shot');
 evaluate('$("#versionRefUpdate form").dispatchEvent(new Event("submit",{cancelable:true}));AC.board=referenceCardBoard;');
 equal(evaluate(`[imageInputs(scopedAssetShot)[0].source.data.asset.id,imageInputs(scopedAssetShot)[0].edge.prompt_slot,
  imageInputs(otherAssetShot)[0].source.id===originalImage.id]`),['lin-memory',7,true],
  'choosing one shot preserves the other shot even when both originally shared the reference');
 w.fetch=referenceLibraryFetch;
 evaluate(`const countBeforeReferenceUpload=B.nodes.length;
  const referenceUpload=filename=>{
    const field=$("#versionRefUpdate [name=replacementFile]");
    Object.defineProperty(field,"files",{configurable:true,value:[new File(["fixture"],filename)]});
    return field.onchange();
  };
  vtOpenReferenceUpdate(groupReplacement);`);
 await evaluate('referenceUpload("wrong-type.png")');
 assert.match(evaluate('$("#versionRefUpdate [data-upload-status]").textContent'),/请选择视频文件/);
 await evaluate('referenceUpload("模板取景.mkv")');
 assert.match(evaluate('$("#versionRefUpdate [name=replacement] option:checked").textContent'),/模板取景（新上传）/);
 equal(evaluate('[B.nodes.length===countBeforeReferenceUpload,videoInputs(groupShot)[0].source===groupReplacement]'),
  [true,true],'uploading is staged until the replacement is confirmed');
 evaluate('$("#versionRefUpdate [data-cancel]").click();vtOpenReferenceUpdate(groupReplacement)');
 assert.doesNotMatch(evaluate('$("#versionRefUpdate [name=replacement]").textContent'),/新上传/);
 await evaluate('referenceUpload("模板取景.mkv")');
 evaluate('$("#versionRefUpdate form").dispatchEvent(new Event("submit",{cancelable:true}))');
 equal(evaluate(`[B.nodes.length===countBeforeReferenceUpload+1,videoInputs(groupShot)[0].source.name,
  videoInputs(groupShot)[0].edge.prompt_slot,videoInputs(groupShot)[0].version.source]`),
  [true,"模板取景",6,"upload"],'confirming creates the new source node and moves the reference to it');
 evaluate('undo()');
 equal(evaluate(`[B.nodes.length===countBeforeReferenceUpload,videoInputs(node(groupShot.id))[0].source.id===groupReplacement.id]`),
  [true,true],'undo restores the original reference and removes the node created in the same operation');
 const audioLibraryFetch=w.fetch, resolvedAudioAssets=[];
 const libraryAudio=[{id:"cast-voice",name:"演员声线",kind:"character",aliases:["渡船"],media:[
  {ref:"output:h3studio/voice-old.wav",type:"audio",seconds:2},
  {ref:"input:h3studio/alternate-voice.wav",type:"audio",seconds:7},
  {ref:"input:h3studio/full-interview.wav",type:"audio",seconds:80},
 ]},{id:"station-motion",name:"站台运镜",kind:"scene",tags:["环绕"],media:[
  {ref:"input:h3studio/station-motion.mp4",type:"video",w:864,h:480,seconds:9},
 ]}];
 w.fetch=async(url,options={})=>{
  const path=new URL(url,"http://oneshot.test").pathname;
  if(path==="/api/memory")return {ok:true,json:async()=>libraryAudio};
  if(path==="/api/memory/resolve"){
   const payload=JSON.parse(options.body);
   resolvedAudioAssets.push(payload);
   return {ok:true,json:async()=>libraryAudio.filter(asset=>payload.ids.includes(asset.id))};
  }
  return audioLibraryFetch(url,options);
 };
 evaluate(`const libraryAudioTarget=addNode("audio",4300,1650,{mode:"seed_audio"});
  selectOnly(libraryAudioTarget.id);
  const audioLibraryNodeCount=B.nodes.length;
  $("#refs [data-seed-library]").click();`);
 await ready('$("#referenceLibrary select").options.length===3','audio picker lists reusable clips under the duration limit');
 evaluate(`const audioLibraryQuery=$("#referenceLibrary input");
  audioLibraryQuery.value="渡船";audioLibraryQuery.dispatchEvent(new Event("input"));
  const audioLibraryPick=index=>{
    const choice=$("#referenceLibrary select");choice.selectedIndex=index;
    choice.dispatchEvent(new Event("change"));
  };
  audioLibraryPick(1);`);
 assert.match(evaluate('$("#referenceLibrary audio").src'),/voice-old\.wav/);
 await evaluate('$("#referenceLibrary form").onsubmit(new Event("submit"))');
 equal(evaluate('[B.nodes.length===audioLibraryNodeCount,libraryAudioTarget.data.references[0].node_id===versionCopyAudio.id,libraryAudioTarget.data.references[0].ref,node(versionCopyAudio.id).cur]'),
  [true,true,"output:h3studio/voice-old.wav",1],'reuse the historical canvas version without adding a duplicate or changing the current version');
 await evaluate('openReferenceLibrary(libraryAudioTarget,"audio")');
 equal(evaluate('$("#referenceLibrary select").options.length'),2,'an already linked audio version is omitted');
 await evaluate('audioLibraryPick(1);$("#referenceLibrary form").onsubmit(new Event("submit"))');
 equal(evaluate(`(()=>{
   const ref=libraryAudioTarget.data.references[1], source=node(ref.node_id);
   return [B.nodes.length,source.data.asset.id,curV(source).ref,B.edges.some(e=>e.from===source.id&&e.to===libraryAudioTarget.id&&e.slot===2)];
 })()`),[evaluate('audioLibraryNodeCount+1'),"cast-voice","input:h3studio/alternate-voice.wav",true]);
 assert.deepEqual(resolvedAudioAssets.map(body=>body.ids),[["cast-voice"],["cast-voice"]]);
 evaluate('undo()');
 equal(evaluate('[B.nodes.length===audioLibraryNodeCount,node(libraryAudioTarget.id).data.references.length]'),[true,1]);
 evaluate(`const libraryVideoTarget=addNode("video",4650,1650);
   const libraryVideoNodeCount=B.nodes.length;
   const openLibraryInput=kind=>{
     openAddMenu(110,150,{to:libraryVideoTarget});
     $("#addMenu [data-library-reference='"+kind+"']").click();
   };
   openLibraryInput("video");`);
 await ready('$("#referenceLibrary select").options.length===2','video picker lists saved footage');
 evaluate(`audioLibraryQuery.value="环绕";audioLibraryQuery.dispatchEvent(new Event("input"));audioLibraryPick(1);`);
 assert.match(evaluate('$("#referenceLibrary video").src'),/station-motion\.mp4/);
 assert.equal(evaluate('$("#referenceLibrary audio").hidden'),true);
 await evaluate('$("#referenceLibrary form").onsubmit(new Event("submit"))');
 equal(evaluate('[B.nodes.length===libraryVideoNodeCount+1,videoInputs(libraryVideoTarget)[0].edge.prompt_slot]'),[true,1]);
 evaluate('openLibraryInput("audio")');
 await ready('$("#referenceLibrary select").options.length===4','video node can pick an audio reference');
 evaluate('audioLibraryPick(1)');
 await evaluate('$("#referenceLibrary form").onsubmit(new Event("submit"))');
 equal(evaluate(`(()=>{
   const request=videoReq(libraryVideoTarget,"沿用 @视频{1} 的运镜和 @音{1} 的旁白");
   const [clip]=request.video_refs,[sound]=request.audio_refs;
   return [clip.ref,clip.start,clip.end,clip.prompt_slot,sound.node_id===versionCopyAudio.id,sound.version,sound.prompt_slot,
     B.nodes.length===libraryVideoNodeCount+1,request.prompt];
 })()`),["input:h3studio/station-motion.mp4",0,9,1,true,1,1,true,"沿用 @视频1 的运镜和 @音1 的旁白"]);
 evaluate('undo();undo()');
 equal(evaluate('[B.nodes.length===libraryVideoNodeCount,videoInputs(node(libraryVideoTarget.id)).length,audioInputs(node(libraryVideoTarget.id)).length]'),[true,0,0]);
 w.fetch=audioLibraryFetch;
 console.log('Library media references DOM passed: audio and video pickers, preview, pinned versions, request bindings and undo.');
 evaluate('restore(copyFlowBase)');
 console.log('Version copies and references DOM passed: keyboard menu, drag, pinned audio reference, read-only guard, provenance, video inputs and undo.');
 const queueFetch=w.fetch, queueSends=[], queueDeletes=[];
 const uiQueue=[];
 w.fetch=async(url,options={})=>{
  const path=new URL(url,'http://oneshot.test').pathname;
  let result;
  if(path==='/api/chat/sessions/queue-ui'){
   result={events:[],runs:[{id:'ongoing-run',state:'running'}],queue:uiQueue,board_rev:evaluate('B.rev||0')};
  }else if(path==='/api/chat/sessions/queue-ui/messages'){
   const body=JSON.parse(options.body);
   queueSends.push(body);
   result={id:'queued-'+queueSends.length,state:'queued'};
   uiQueue.push({id:result.id,text:body.text});
  }else if(path==='/api/chat/runs/queued-1/queue' && options.method==='DELETE'){
   queueDeletes.push(path);uiQueue.splice(0,1);result={ok:true};
  }else return queueFetch(url,options);
  return {ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(result))};
 };
 evaluate('AC.open=true;AC.board=boardId');
 await evaluate('acLoadSession("queue-ui")');
 evaluate('$("#acInput").value="完成后再做下一幕";$("#acInput").dispatchEvent(new Event("input"))');
 equal(evaluate('[$("#acSend").textContent,$("#acSend").disabled,$("#acStop").hidden]'),
 ["加入队列",false,false],"a running turn keeps the composer usable and offers an explicit queue action");
 evaluate('$("#acSend").click()');
 await ready('!!$("#acQueue [data-remove-queued=queued-1]") && !AC.sending','accepted follow-up appears as waiting');
 equal([queueSends.length,queueSends[0].enqueue,evaluate('$("#acInput").value'),evaluate('acActive().id')],
 [1,true,"","ongoing-run"],"queue admission clears the submitted draft and leaves the active turn alone");
 await evaluate('acLoadSession("queue-ui")');
 assert.match(evaluate('$("#acQueue ol").textContent'),/完成后再做下一幕/);
 evaluate('$("#acQueue [data-remove-queued]").click()');
 await ready('$("#acQueue").hidden','a waiting message can be removed after reopening');
 assert.equal(queueDeletes.length,1);
 w.fetch=queueFetch;
 console.log('Assistant queue DOM passed: active composer, durable pending list, active-turn controls and removal.');
 const attachmentFetch=w.fetch, attachmentUploads=[], attachmentDeletes=[];
 let attachmentMessage;
 w.fetch=async(url,options={})=>{
  const path=new URL(url,'http://oneshot.test').pathname;
  let result;
  if(path==='/api/chat/sessions/attachment-ui/documents'&&options.method==='POST'){
   const file=options.body.get('file');attachmentUploads.push(file.name);
   result={id:'document-'+attachmentUploads.length,name:file.name,length:123,truncated:false};
  }else if(path==='/api/chat/sessions/attachment-ui/documents/document-2'&&options.method==='DELETE'){
   attachmentDeletes.push(path);result={ok:true};
  }else if(path==='/api/chat/sessions/attachment-ui/messages'){
   attachmentMessage=JSON.parse(options.body);result={id:'attachment-run',state:'done'};
  }else if(path==='/api/chat/sessions/attachment-ui'){
   result={events:attachmentMessage?[{id:1,run_id:'attachment-run',kind:'user',data:{text:attachmentMessage.text,documents:[{name:attachmentUploads[0]}]}}]:[],
    runs:[],queue:[],board_rev:evaluate('B.rev||0')};
  }else return attachmentFetch(url,options);
  return {ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(result))};
 };
 await evaluate('acLoadSession("attachment-ui")');
 evaluate(`const docPicker=$("#acDocumentFile");
   Object.defineProperty(docPicker,"files",{value:[new File(["# 灯光"],"<剧本>.md")],configurable:true});
   docPicker.dispatchEvent(new Event("change"));`);
 await ready('AC.documents.length===1 && !AC.documentUpload','file picker attaches a parsed document');
 assert.equal(evaluate('$("#acSend").disabled'),false,'an attachment by itself can be sent');
 evaluate(`const dropDocument=new Event("drop",{cancelable:true,bubbles:true});
  Object.defineProperty(dropDocument,"dataTransfer",{value:{files:[new File(["参考"],"参考资料.txt")]}});
  $(".ac-composer").dispatchEvent(dropDocument);`);
 await ready('AC.documents.length===2 && !AC.documentUpload','drop adds an attachment to the composer');
 evaluate('$("[data-remove-document=document-2]").click();$("#acSend").click()');
 await ready('!!$("#acMessages .ac-sent-skill") && !AC.sending','sent user message shows its attachment');
 equal(attachmentMessage.document_ids,['document-1'],'only the attachment left in the composer is sent');
 assert.equal(attachmentDeletes.length,1);
 assert.equal(evaluate('$("#acDocumentFile").hidden'),true);
 assert.equal(evaluate('$("#acDocuments").hidden'),true);
 assert.match(evaluate('$("#acMessages .ac-sent-skill").textContent'),/<剧本>\.md/);
 w.fetch=attachmentFetch;
 console.log('Assistant documents DOM passed: picker, drop, remove, attachment-only send, safe filename and message history.');
 const mentionFetch=w.fetch;
 let pinnedReferenceMessage;
 w.fetch=async(url,options={})=>{
  const path=new URL(url,'http://oneshot.test').pathname;
  let result;
  if(path==='/api/chat/sessions/reference-ui/messages'){
   pinnedReferenceMessage=JSON.parse(options.body);result={id:'ref-run',state:'done'};
  }else if(path==='/api/chat/sessions/reference-ui'){
   result={events:[],runs:[],queue:[],board_rev:evaluate('B.rev||0')};
  }else return mentionFetch(url,options);
  return {ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(result))};
 };
 await evaluate('acLoadSession("reference-ui")');
 await evaluate('acOpen()');
 evaluate(`const mentionFixture=snap();sel.clear();updateSel();
  const exactMentionNode=addNode("image",1700,720,{}, {name:"对齐引用首帧",versions:[
   copyAsset("mention-v1.png",{w:512,h:512}),copyAsset("mention-v2.png",{w:512,h:512})],cur:0});
  const duplicateMentionNode=addNode("image",2130,720,{}, {name:"对齐引用首帧"});
  const mentionInput=$("#acInput");mentionInput.value="分析@对齐引用";mentionInput.focus();mentionInput.setSelectionRange(mentionInput.value.length,mentionInput.value.length);
  mentionInput.dispatchEvent(new Event("input",{bubbles:true}));`);
 await ready('CM.matches.filter(item=>item.canvasNode).length===2 && !CM.popup.hidden','typing @ finds both same-name canvas nodes');
 evaluate('mentionInput.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));switchVersion(exactMentionNode,1);acRenderRefs()');
 assert.equal(pinnedReferenceMessage,undefined,'Enter chooses the suggestion before submitting');
 const mentionNodeId=evaluate('exactMentionNode.id');
 assert.ok(evaluate('mentionInput.value').includes(`「对齐引用首帧」（${mentionNodeId}）`));
 assert.match(evaluate('$("#acRefs").textContent'),/版本 1 · 已指定/);
 assert.match(evaluate('$("#acRefs img").src'),/mention-v1\.png$/);
 evaluate(`const setReferenceVersion=value=>{
  const picker=$("#acRefs [data-reference-version]");picker.focus();picker.value=value;
  picker.dispatchEvent(new Event("change",{bubbles:true}));
 };setReferenceVersion("");`);
 equal(evaluate('[AC.referencePins.has(exactMentionNode.id),$("#acRefs [data-reference-version]").value]'),
  [false,''],'version selector can return to the current canvas version');
 assert.match(evaluate('$("#acRefs img").src'),/mention-v2\.png$/);
 evaluate('switchVersion(exactMentionNode,0)');
 assert.match(evaluate('$("#acRefs img").src'),/mention-v1\.png$/,'following the canvas refreshes the thumbnail immediately');
 evaluate('switchVersion(exactMentionNode,1)');
 evaluate('setReferenceVersion("0")');
 equal(evaluate('[exactMentionNode.cur,document.activeElement.dataset.referenceVersion]'),
  [1,mentionNodeId],'explicit reference changes preserve the canvas version and picker focus');
 evaluate('$("#acSend").click()');
 await ready('!AC.sending && !AC.referencePins.size','the sent draft clears its pinned version');
 equal(pinnedReferenceMessage.selected,[mentionNodeId],'same-name nodes remain unambiguous');
 equal(pinnedReferenceMessage.selected_versions,[{node_id:mentionNodeId,ref:'output:h3studio/mention-v1.png'}],'switching canvas versions does not change the payload');
 evaluate('restore(mentionFixture)');
 w.fetch=mentionFetch;
 console.log('Canvas mention DOM passed: mixed completion, duplicate labels, keyboard selection, version pin and payload.');
 const promptFetch=w.fetch, wiredPrompts=[];
 w.fetch=async(url,options={})=>{
  if(String(url)!=="/api/generate")return promptFetch(url,options);
  wiredPrompts.push(JSON.parse(options.body));
  const id="prompt-wired-job-"+wiredPrompts.length,ref="output:h3studio/prompt-wired-"+wiredPrompts.length+".png";
  jobs.set(id,{state:"done",outputs:[{ref,url:"/media?ref="+encodeURIComponent(ref),meta:{width:640,height:360}}]});
  return {ok:true,text:async()=>JSON.stringify({ids:[id]})};
 };
 evaluate(`const wirePromptBase=snap();
  const promptReference=addNode("image",100,550,{}, {name:"画布专用参考图",versions:[
   copyAsset("prompt-old.png",{w:512,h:384}),copyAsset("prompt-new.png",{w:512,h:512})],cur:0});
  const legacyReference=addNode("image",400,550,{},{versions:[copyAsset("legacy-ref.png",{w:512,h:512})],cur:0});
  const wiredImage=addNode("image",720,550);
  link(legacyReference,wiredImage,true);selectOnly(wiredImage.id);
  const enterMention=(field,value)=>{field.value=value;field.focus();field.setSelectionRange(value.length,value.length);
   field.dispatchEvent(new Event("input",{bubbles:true}));};
  enterMention($("#prompt"),"对照@画布专用");`);
 await ready('!CM.popup.hidden && CM.matches.some(m=>m.id===promptReference.id)','the image composer offers compatible canvas images');
 evaluate('$("[data-canvas-node]",CM.popup).click();');
 equal(evaluate('[node(wiredImage.id).data.prompt,imageInputs(wiredImage)[1].edge.ref]'),["对照@图{1} ","output:h3studio/prompt-old.png"],'choosing the image creates a pinned input edge and stable token');
 evaluate('undo()');
 equal(evaluate('[node(wiredImage.id).data.prompt,$("#prompt").value,imageInputs(node(wiredImage.id)).length]'),["对照@画布专用","对照@画布专用",1],'undo restores both the prompt and graph');
 evaluate('redo();switchVersion(node(promptReference.id),1);selectOnly(wiredImage.id)');
 await evaluate('generate(node(wiredImage.id))');
 await ready('node(wiredImage.id).versions.length===1','the pinned image request creates a version',350);
 equal([wiredPrompts[0].prompt,wiredPrompts[0].images[1].ref],["对照@图2","output:h3studio/prompt-old.png"],'submission uses the selected older image and correct position');
 evaluate(`const beforeRegeneration=curV(node(wiredImage.id)).ref;
   const legacyImageNode=node(legacyReference.id);
   legacyImageNode.versions.push(copyAsset("legacy-new.png",{w:512,h:512}));
   switchVersion(legacyImageNode,1);
   selectOnly(legacyImageNode.id);
   $("[data-node-prompt]",els.get(wiredImage.id)).click();
   enterMention($("#prompt"),"未提交的草稿");
   lightbox(curV(node(wiredImage.id)),node(wiredImage.id));
   $("[data-light-generation-draft]").click();`);
 equal(evaluate('[$("#light").open,$("#prompt").value,document.activeElement.id,imageInputs(node(wiredImage.id)).map(input=>input.edge.ref)]'),
 [false,"对照@图{1} ","prompt",["output:h3studio/legacy-ref.png","output:h3studio/prompt-old.png"]],
 'continuing a result restores editable tokens and both historical source versions');
 evaluate('undo()');
 assert.equal(evaluate('node(wiredImage.id).data.prompt'),"未提交的草稿",'undo restores the unsent draft');
 evaluate('vtTabMenu(node(wiredImage.id),0,100,100);$("[data-version-draft]").click();');
 assert.equal(evaluate('$("#send").getAttribute("aria-label")'),"重新生成");
 await evaluate('generate(node(wiredImage.id))');
 await ready('node(wiredImage.id).versions.length===2','regeneration appends a version to the original node',350);
 equal(evaluate('[node(wiredImage.id).versions[0].ref,curV(node(wiredImage.id)).ref]'),
 [evaluate('beforeRegeneration'),"output:h3studio/prompt-wired-2.png"],'the generated result and the source version stay on the node');
 equal(wiredPrompts[1].images.map(input=>input.ref),["output:h3studio/legacy-ref.png","output:h3studio/prompt-old.png"]);
 evaluate(`const removedHistoryImage=node(legacyReference.id).versions.shift();
   node(legacyReference.id).cur=0;
   const beforeMissingHistory=snap();
   lightbox(node(wiredImage.id).versions[0],node(wiredImage.id));
   $("[data-light-generation-draft]").click();`);
 assert.match(evaluate('$(".light-status").textContent'),/历史素材版本已移除/);
 assert.equal(evaluate('snap()===beforeMissingHistory'),true,'a missing input leaves the active draft and graph untouched');
 evaluate('closeLightbox();node(legacyReference.id).versions.unshift(removedHistoryImage);node(legacyReference.id).cur=1;');
 evaluate(`node(wiredImage.id).versions[0].memory_used=[{id:"historical-asset",name:"旧版设定"}];
   vtTabMenu(node(wiredImage.id),0,100,100);$("[data-version-replay-assets]").click();`);
 equal(evaluate('[node(wiredImage.id).data.replay_memory_ref,!!$("[data-replay-assets-clear]")]'),
  [evaluate("beforeRegeneration"),true],"the reviewed version pins the original asset snapshot");
 evaluate('$("[data-replay-assets-clear]").click()');
 assert.equal(evaluate("node(wiredImage.id).data.replay_memory_ref"),undefined);
 evaluate("undo();selectOnly(wiredImage.id)");
 await evaluate("generate(node(wiredImage.id))");
 await ready('node(wiredImage.id).versions.length===3','asset snapshot replay completes',350);
 assert.equal(wiredPrompts[2].replay_memory_ref,evaluate("beforeRegeneration"));
 evaluate(`const recipeDraftAudio=addNode("audio",650,930,{prompt:"当前文案"},{versions:[
   copyAsset("historical-voice.wav",{seconds:5,audio_recipe:{mode:"tts",prompt:"此前的文案",speed:.9}}),
   copyAsset("latest-voice.wav",{seconds:4})],cur:1});
   render(recipeDraftAudio);render(recipeDraftAudio);lightbox(recipeDraftAudio.versions[0],recipeDraftAudio);
   $("[data-light-generation-draft]").click();
   const inheritedVideo=addNode("video",850,930,{prompt:"更新后"},{versions:[
     copyAsset("historical-video.mp4",{seconds:5,video_recipe:{
       kind:"video",duration:5,ar:4/3,planned:true,prompt:"参考 @音1",provider:"legacy-route",
       images:[{node_id:promptReference.id,ref:node(promptReference.id).versions[0].ref,role:"subject"}],
       audio_refs:[{node_id:recipeDraftAudio.id,ref:recipeDraftAudio.versions[0].ref}]}}),
     copyAsset("latest-video.mp4",{seconds:5})],cur:1});
   lightbox(inheritedVideo.versions[0],inheritedVideo);
   $("[data-light-generation-draft]").click();`);
 equal(evaluate(`[recipeDraftAudio.cur,recipeDraftAudio.data.prompt,recipeDraftAudio.data.speed,
   $$("[data-node-prompt]",els.get(recipeDraftAudio.id)).length,
   inheritedVideo.cur,inheritedVideo.data.prompt,inheritedVideo.data.aspect,
   imageInputs(inheritedVideo)[0].edge.ref,audioInputs(inheritedVideo)[0].edge.ref]`),
 [0,"此前的文案",.9,1,0,"参考 @音1","4:3","output:h3studio/prompt-old.png","output:h3studio/historical-voice.wav"],
 'old audio and video recipe shapes restore their own selected version and saved inputs');
 console.log('Historical generation drafts passed: prompt shortcut, pinned image references, undo, same-node regeneration and missing inputs.');
 evaluate(`const wiredVideo=addNode("video",1100,550,{pmode:"fields",fields:{action:""}});selectOnly(wiredVideo.id);
   enterMention($("#pfields [data-k=action]"),"沿用＠画布专用");`);
 await ready('!CM.popup.hidden && CM.matches.some(m=>m.id===promptReference.id)','structured video field supports name completion');
 evaluate('$("[data-canvas-node]",CM.popup).click();switchVersion(node(promptReference.id),0);selectOnly(wiredVideo.id)');
 equal(evaluate(`[wiredVideo.data.fields.action,videoReq(wiredVideo,"").fields.action,videoReq(wiredVideo,"").images[0].ref]`),
 ["沿用@图{1} ","沿用@图1 ","output:h3studio/prompt-new.png"],'video field resolves the pinned reference without following the source tab');
 evaluate('$("[data-image-update]").click();');
 equal(evaluate('videoReq(wiredVideo,"").images[0].ref'),"output:h3studio/prompt-old.png",'an explicit action adopts the current source version');
 const beforePreviewFetch=w.fetch;
 let recordedPreview;
 w.fetch=async (path,options)=>{
  if(path!=="/api/preview")return beforePreviewFetch(path,options);
  recordedPreview=JSON.parse(options.body);
  return {ok:true,text:async()=>JSON.stringify({prompt:"Follow <Picture 1>.",mode:"人物设定",
   inputs:[{...recordedPreview.images[0],name:"乔纳 <参考图>",role:"subject"}]})};
 };
 evaluate('$("#pvBtn").click()');
 await ready('$("#pv").classList.contains("on")','the preview opens for the selected video');
 assert.equal(recordedPreview.fields.action,"沿用@图1 ");
 assert.equal(recordedPreview.images[0].ref,"output:h3studio/prompt-old.png");
 equal(evaluate('[$("#pvt").textContent,$("#pvInputs strong").textContent,$("#pvInputs small").textContent]'),
 ["Follow <Picture 1>.","乔纳 <参考图>","人物设定 · 版本 1"],'the preview shows the resolved prompt and the pinned source');
 evaluate('$("#pvClose").click()');
 w.fetch=beforePreviewFetch;
 evaluate(`const promptReferenceLine=()=>$$('#edges .hit').find(hit=>hit.getAttribute("aria-label")?.includes(
   promptReference.name+" · 固定版本 1 → "+wiredVideo.name));
  const edgeKey=key=>promptReferenceLine().dispatchEvent(new KeyboardEvent("keydown",{key,bubbles:true,cancelable:true}));
  const edgeAccess=B.access;B.access="reviewer";edgeKey("Enter");`);
 equal(evaluate('[!!$(".edge-inspector"),!!$("[data-edge-cut]")]'),[true,false]);
 evaluate('B.access=edgeAccess;drawEdges();edgeKey("Enter")');
 assert.match(evaluate('$("title",promptReferenceLine()).textContent'),/固定版本 1/);
 assert.equal(evaluate('document.activeElement.hasAttribute("data-edge-cut")'),true);
 evaluate(`const edgeGesture=(type,x,y)=>$("[data-edge-cut]").dispatchEvent(new MouseEvent(type,
  {button:0,bubbles:true,cancelable:true,clientX:x,clientY:y,detail:1}));
  edgeGesture("pointerdown",100,100);edgeGesture("pointermove",100,68);edgeGesture("pointerup",100,68);
  edgeGesture("click",100,68);`);
 assert.equal(evaluate('imageInputs(wiredVideo).length'),1,'dragging upwards cannot cut a connection');
 evaluate('edgeGesture("pointerdown",100,100);edgeGesture("pointermove",100,131);edgeGesture("pointercancel",100,131)');
 assert.equal(evaluate('imageInputs(wiredVideo).length'),1,'cancelling the gesture leaves the connection intact');
 evaluate('edgeGesture("pointerdown",100,100);edgeGesture("pointermove",100,131);edgeGesture("pointerup",100,131)');
 equal(evaluate('videoReq(wiredVideo,"")'),null,'an orphaned prompt token stops submission');
 assert.match(evaluate('$(".errbox",els.get(wiredVideo.id)).textContent'),/图片引用已断开/);
 evaluate('undo()');
 assert.equal(evaluate('imageInputs(node(wiredVideo.id))[0].edge.ref'),"output:h3studio/prompt-old.png");
 console.log('Connection inspection passed: exact source version, reviewer access, directed scissors gesture and undo.');
 evaluate('restore(wirePromptBase)');
 w.fetch=promptFetch;
 console.log('Generation mention DOM passed: image and structured video, pinned edges, undo, version adoption and missing reference validation.');
 evaluate(`const modelPickerBase=snap(),previousImageServices=CAPS_LIST.image;
  CAPS_LIST.image=[{id:"model-qa",name:"图像服务",model:"model-standard",default:true,default_route_model:"model-fast",
    models:[{id:"model-standard"},{id:"model-fast"}]}];
  const modelImage=addNode("image",900,600,{prompt:"走廊"});
  selectOnly(modelImage.id);`);
 const beforeModelFetch=w.fetch;
 let selectedModelRequest;
 w.fetch=async (path,options)=>{
  if(path!=="/api/generate")return beforeModelFetch(path,options);
  selectedModelRequest=JSON.parse(options.body);
  const ref="output:h3studio/chosen-model.png";
  jobs.set("chosen-model",{state:"done",outputs:[{ref,url:"/media?ref="+encodeURIComponent(ref)}]});
  return {ok:true,text:async()=>JSON.stringify({ids:["chosen-model"]})};
 };
 assert.match(evaluate('$("[data-k=selected_model]").parentElement.textContent'),/model-fast/);
 evaluate(`const selectCanvasModel=id=>{
   const option=$("[data-k=selected_model]");option.value=id;option.dispatchEvent(new Event("change"));
  };
  selectCanvasModel("model-standard");`);
 await evaluate('generate(modelImage)');
 equal([selectedModelRequest.provider,selectedModelRequest.selected_model],["model-qa","model-standard"]);
 await ready('modelImage.versions.length===1','chosen image model returns a new version');
 assert.equal(evaluate('curV(modelImage).generation_record.settings.provider_model'),"model-standard");
 evaluate('$("[data-k=provider]").value="";$("[data-k=provider]").dispatchEvent(new Event("change"))');
 assert.equal(evaluate('modelImage.data.selected_model'),undefined,'switching back to the default service clears the model override');
 w.fetch=beforeModelFetch;
 evaluate('CAPS_LIST.image=previousImageServices;restore(modelPickerBase)');
 console.log('Canvas model picker passed: a single service exposes alternate models and records the selected model.');

 evaluate(`const avPromptBase=snap(),capsBeforeAV={audio:CAPS_LIST.audio_reference,video:CAPS_LIST.previs};
  CAPS_LIST.audio_reference=[{id:"audio-qa",name:"仅声音参考",model:"seedance-2"}];
  CAPS_LIST.previs=[{id:"multimodal-qa",name:"视频参考服务",model:"seedance-2-5",
    models:[{id:"seedance-2-5",draft:true},{id:"seedance-2",draft:false}]}];
  window.__capabilities={...CAPS_LIST};
  const avTarget=addNode("video",1200,650,{prompt:""}, {name:"成片"});
  const avVideo=addNode("video",600,650,{}, {name:"画布运镜实拍",versions:[
   copyAsset("move-old.mp4",{seconds:12,w:640,h:480}),copyAsset("move-now.mp4",{seconds:12,w:640,h:480})],cur:0});
  const avAudio=addNode("audio",100,650,{}, {name:"画布现场铃声",versions:[
   copyAsset("bell-old.wav",{seconds:4}),copyAsset("bell-now.wav",{seconds:4})],cur:0});
  selectOnly(avTarget.id);enterMention($("#prompt"),"按@画布现场");`);
 await ready('CM.matches.some(m=>m.id===avAudio.id) && !CM.popup.hidden','video composer offers audio nodes');
 evaluate('$("[data-canvas-node]",CM.popup).click();');
 equal(evaluate('[avTarget.data.prompt,avTarget.data.provider,videoReq(avTarget,fullPrompt(avTarget)).audio_refs[0].ref]'),
 ["按@音{1} ","audio-qa","output:h3studio/bell-old.wav"],'audio reference uses the audio-capable route');
 evaluate('enterMention($("#prompt"),avTarget.data.prompt+"与@画布运镜")');
 await ready('CM.matches.some(m=>m.id===avVideo.id) && !CM.popup.hidden','video composer offers video references');
 evaluate(`$("[data-canvas-node]",CM.popup).click();
  const inPoint=$("[data-clip-point=start]");
  inPoint.value="2";inPoint.dispatchEvent(new Event("change"));
  const currentOut=$("[data-clip-point=end]");currentOut.value="7";currentOut.dispatchEvent(new Event("change"));
  switchVersion(avVideo,1);switchVersion(avAudio,1);selectOnly(avTarget.id);
  const avRequest=videoReq(avTarget,fullPrompt(avTarget));`);
 equal(evaluate('[avRequest.prompt,avTarget.data.provider,avRequest.video_refs[0].ref,avRequest.video_refs[0].start,avRequest.video_refs[0].end,avRequest.audio_refs[0].ref]'),
 ["按@音1 与@视频1","multimodal-qa","output:h3studio/move-old.mp4",2,7,"output:h3studio/bell-old.wav"],
 'combined references keep the chosen versions, clip range and compatible service');
 evaluate('selectCanvasModel("seedance-2")');
 equal(evaluate('[referenceDuration(avTarget),videoDraftAvailable(avTarget)]'),[15,false],
  'reference model drives duration and draft availability');
 evaluate(`const avGuide=addNode("video",100,850,{}, {name:"白模动作",versions:[copyAsset("guide.mp4",{source:"previs",seconds:4,w:640,h:480})],cur:0});
  B.edges.push({from:avGuide.id,to:avTarget.id,relation:"previs",ref:curV(avGuide).ref});drawEdges();`);
 equal(evaluate('videoReq(avTarget,fullPrompt(avTarget)).prompt'),"按@音1 与@视频2",'video reference numbering accounts for a whitebox guide');
 evaluate('cutEdge(audioInputs(avTarget)[0].edge)');
 equal(evaluate('videoReq(avTarget,fullPrompt(avTarget))'),null,'a removed audio edge cannot silently change the reference');
 evaluate('delete window.__capabilities;CAPS_LIST.audio_reference=capsBeforeAV.audio;CAPS_LIST.previs=capsBeforeAV.video;restore(avPromptBase)');
 console.log('Multimodal mention DOM passed: clip and sound selection, pinned media, trimming, routing, guide numbering and detached tokens.');
 const collaborationFetch=w.fetch, heartbeats=[], liveDeletes=[], savedLiveViews=[];
 const collaborationPeer={id:"8:other-tab",name:"审片同事",view:{cx:800,cy:460,k:.5},presenting:true,cursor:{x:160,y:130}};
 let peerPresent=true, remoteViewRev=0, commentsVersion="review-joined", commentReads=0;
 w.fetch=async(url,options={})=>{
  const endpoint=new URL(url,'http://oneshot.test');
  if(endpoint.pathname==='/api/board/btest/live'){
   if(options.method==='DELETE'){
    liveDeletes.push(endpoint.searchParams.get("tab"));
    return {ok:true,json:async()=>({ok:true})};
   }
   const data=JSON.parse(options.body);
   heartbeats.push(data);
   const self={id:"1:"+data.tab,name:"我",view:data.view,presenting:data.presenting};
   return {ok:true,json:async()=>({self:self.id,participants:peerPresent?[self,collaborationPeer]:[self],rev:remoteViewRev,comments_version:commentsVersion})};
  }
  if(endpoint.pathname==='/api/board/btest/comments'&&(!options.method||options.method==='GET'))commentReads++;
  if(endpoint.pathname==='/api/board/btest'&&options?.method==='PUT')savedLiveViews.push(JSON.parse(options.body).view);
  return collaborationFetch(url,options);
 };
 evaluate(`const liveDefaultView={x:42,y:24,k:.8};B.view={...liveDefaultView};applyView();
  const liveSyncOriginal=acSyncBoard, checkedLiveRevs=[];
  acSyncBoard=async(rev,independent)=>checkedLiveRevs.push([rev,independent]);`);
 await evaluate('shareOpen()');
 assert.equal(heartbeats.length,0,'opening sharing leaves live collaboration opt-in');
 evaluate('$("#liveJoin").click()');
 await ready('liveCanvas?.people.length===2 && !liveCanvas.busy','join marks both members present');
 await ready('liveCanvas.commentsVersion==="review-joined"','join refreshes existing comments');
 evaluate('$("#ccClose").click();$("#ccBody").value="保留我的草稿"');
 const newReview={id:"remote-review",body:"标注这个位置",author:"审片同事",created:5,anchor:{x:100,y:140},resolved:false,can_resolve:false,replies:[]};
 commentThreads.unshift(newReview);
 commentsVersion="review-posted";
 await evaluate('livePulse()');
 await ready('$("#canvasComments").hidden && !!$("#commentPins [data-cc-pin=remote-review]")','a remote comment shows its pin with the panel closed');
 await ready('liveCanvas.commentsVersion==="review-posted"','the new comment list settles');
 const afterPostReads=commentReads;
 await evaluate('livePulse()');
 assert.equal(commentReads,afterPostReads,'unchanged heartbeats do not reload comments');
 newReview.resolved=true;
 commentsVersion="review-resolved";
 await evaluate('livePulse()');
 await ready('!$("#commentPins [data-cc-pin=remote-review]")','resolving remotely removes the pin');
 assert.equal(evaluate('$("#ccBody").value'),'保留我的草稿');
 assert.equal(evaluate('$("#liveBadge").textContent'),'跟随 审片同事');
 equal(evaluate('[$("#liveCursors .live-cursor").textContent,$("#liveCursors .live-cursor").style.transform]').map(value=>value.replace(/,\s+/g,',')),
 ["审片同事","translate(170px,128px)"],'a collaborator pointer uses canvas coordinates on the local screen');
 evaluate('vp.dispatchEvent(new MouseEvent("pointermove",{bubbles:true,clientX:122,clientY:104}))');
 await evaluate('livePulse()');
 equal(heartbeats.at(-1).cursor,{x:100,y:100},'only world coordinates for canvas pointers are shared');
 evaluate('$("#liveSharePointer").click()');
 await ready('!liveCanvas.shareCursor && !liveCanvas.busy','disabling cursor sends an update');
 assert.equal(heartbeats.at(-1).cursor,null);
 assert.equal(evaluate('$$("#liveCursors .live-cursor").length'),1,'hiding your own cursor still shows peers');
 evaluate('shareClose();$("#liveBadge").click()');
 await ready('!!liveCanvas.following && !liveCanvas.busy','the top-bar invitation starts following only on click');
 equal(evaluate('[toW(innerWidth/2,innerHeight/2),B.view.k]'),[{x:800,y:460},.5],'follow uses the world-space center on the follower screen');
 equal(heartbeats.at(-1).view,heartbeats[0].view,'a follower keeps broadcasting their independent view');
 evaluate('save()');
 await evaluate('flushSave()');
 equal(savedLiveViews.at(-1),{x:42,y:24,k:.8},'saving edits cannot persist the followed viewport');
 collaborationPeer.view={cx:218,cy:229,k:1};
 remoteViewRev=evaluate('(B.rev||0)+1');
 await evaluate('livePulse()');
 equal(evaluate('[toW(innerWidth/2,innerHeight/2),B.view.k,checkedLiveRevs.at(-1)]'),[{x:218,y:229},1,[remoteViewRev,true]],'a heartbeat updates the viewport and signals a newer board revision');
 evaluate('$("#liveBadge").click()');
 equal(evaluate('B.view'),{x:42,y:24,k:.8},'explicit stop restores the previous personal position');
 evaluate('liveFollow("8:other-tab");zoomAt(120,90,1.1)');
 assert.equal(evaluate('liveCanvas.following'),null,'manual navigation stops following');
 await ready('!liveCanvas.busy','manual follow pulse settles');
 await evaluate('liveFollow("8:other-tab")');
 await ready('!liveCanvas.busy','peer departure test starts with a completed heartbeat');
 peerPresent=false;
 await evaluate('livePulse()');
 assert.equal(evaluate('liveCanvas.following'),null,'expired or departing participants stop follow mode');
 assert.equal(evaluate('$("#liveCursors").childElementCount'),0,'a departed collaborator is removed from the cursor overlay');
 evaluate('liveLeave();acSyncBoard=liveSyncOriginal');
 assert.equal(liveDeletes.length,1);
 assert.equal(evaluate('$("#liveBadge").hidden'),true);
 w.fetch=collaborationFetch;
 console.log('Live canvas DOM passed: opt-in presence, presentation invitation, world-space following, safe saves and stopping.');
 evaluate(`undoStack.length=redoStack.length=0;
  const editTarget=node("n1");
  const historyOriginal={name:editTarget.name,x:editTarget.x};
  checkpoint();editTarget.name="我的节点名";
  const staleGesture=snap(), peerBoard=acClone(B);
  peerBoard.nodes.find(n=>n.id===editTarget.id).x+=100;
  peerBoard.nodes.push({...acClone(editTarget),id:"peerHistoryNode",name:"同事新建"});
  peerBoard.rev=(B.rev||0)+1;acApplyBoard(peerBoard,true);
  undoStack.push(staleGesture);undo();`);
 equal(evaluate('[node("n1").name,node("n1").x,node("peerHistoryNode").name]'),
  [evaluate('historyOriginal.name'),evaluate('historyOriginal.x+100'),"同事新建"], 'undo restores only the local rename and skips stale gesture history');
 evaluate('redo()');
 equal(evaluate('[node("n1").name,node("n1").x,!!node("peerHistoryNode")]'),
  ["我的节点名",evaluate('historyOriginal.x+100'),true], 'redo preserves the collaborator move and new node');
 evaluate(`const conflictingBoard=acClone(B);
  conflictingBoard.nodes.find(n=>n.id==="n1").name="同事改名";
  conflictingBoard.rev++;acApplyBoard(conflictingBoard,true);undo();`);
 assert.equal(evaluate('node("n1").name'),"同事改名",'history stops before undoing a field edited by a collaborator');
 evaluate(`checkpoint();const ownNewNode=addNode("text",500,100);
  const linkedBoard=acClone(B);linkedBoard.edges.push({from:ownNewNode.id,to:"peerHistoryNode"});
  linkedBoard.rev++;acApplyBoard(linkedBoard,true);undo();`);
 assert.equal(evaluate('!!node(ownNewNode.id) && B.edges.some(e=>e.from===ownNewNode.id&&e.to==="peerHistoryNode")'),true,
  'undo cannot remove a node that a collaborator has connected');
 console.log('Collaborative history passed: safe undo and redo, stale gestures, conflicting fields and collaborator links.');
 await evaluate('flushSave()');
 evaluate('acRememberBoard(boardId,B)');
 const raceBoard=JSON.parse(evaluate('JSON.stringify(B)'));
 raceBoard.rev=(raceBoard.rev||0)+1;
 const movedPeer=raceBoard.nodes.find(n=>n.id==='peerHistoryNode');
 movedPeer.y+=240;
 const newPeerId=evaluate('newCanvasNodeId()');
 raceBoard.nodes.push({...movedPeer,id:newPeerId,name:'同事添加的素材'});
 raceBoard.edges.push({from:'n1',to:newPeerId});
 let openRead, finishRead, openWrite, finishWrite, saveAttempts=0, mergedSave;
 const reading=new Promise(resolve=>{openRead=resolve;});
 const writing=new Promise(resolve=>{openWrite=resolve;});
 const raceResponse=(body,status=200)=>({ok:status===200,status,json:async()=>structuredClone(body)});
 w.fetch=async(url,options={})=>{
  if(new URL(url,'http://oneshot.test').pathname!=='/api/board/btest')return collaborationFetch(url,options);
  if(options.method==='PUT'){
   if(++saveAttempts===1)return new Promise(resolve=>{finishWrite=resolve;openWrite();});
   mergedSave=JSON.parse(options.body);
   return raceResponse({rev:raceBoard.rev+1});
  }
  if(!finishRead)return new Promise(resolve=>{finishRead=resolve;openRead();});
  return raceResponse(raceBoard);
 };
 const refresh=evaluate(`acSyncBoard(${raceBoard.rev},true)`);
 await reading;
 const newLocalId=evaluate(`node("n1").name="本地并发编辑";
  const linkedNewImage=addNode("image",500,100,{}, {name:"我添加的素材"});
  link(node("n1"),linkedNewImage);linkedNewImage.id;`);
 const saveDuringRead=evaluate('flushSave()');
 await writing;
 finishRead(raceResponse(raceBoard));
 await refresh;
 assert.equal(evaluate('node("n1").name'),'本地并发编辑','background read cannot replace edits in an active save');
 finishWrite(raceResponse({rev:raceBoard.rev},409));
 await saveDuringRead;
 assert.equal(saveAttempts,2);
 equal(mergedSave.nodes.filter(n=>n.id==='n1'||n.id==='peerHistoryNode').map(n=>[n.id,n.name,n.y]),
  [['n1','本地并发编辑',raceBoard.nodes.find(n=>n.id==='n1').y],['peerHistoryNode','同事新建',movedPeer.y]],
  'the revision retry saves both the local rename and peer movement');
 assert.match(newLocalId,/^n[0-9a-f]{24}$/);
 assert.notEqual(newLocalId,newPeerId,'concurrent creation does not reuse a sequential ID');
 equal(mergedSave.edges.filter(e=>e.to===newPeerId||e.to===newLocalId),
  [{from:'n1',to:newPeerId},{from:'n1',to:newLocalId}], 'concurrent creation saves both new nodes with their own edges');
 assert.equal(mergedSave.nodes.find(n=>n.id===newLocalId).name,'我添加的素材');
 assert.equal(mergedSave.nodes.find(n=>n.id===newPeerId).name,'同事添加的素材');
 w.fetch=collaborationFetch;
 console.log('Collaborative save passed: delayed refresh, in-flight edit and automatic revision merge.');
 const conflictServer=JSON.parse(evaluate('JSON.stringify(B)'));
 conflictServer.rev++;
 const sharedNode=conflictServer.nodes.find(n=>n.id==='n1');
 sharedNode.name='同事命名';sharedNode.x+=80;
 sharedNode.data.prompt='同事的提示词';
 let resolvedBoard, conflictWrites=0;
 w.fetch=async(url,options={})=>{
  if(new URL(url,'http://oneshot.test').pathname!=='/api/board/btest')return collaborationFetch(url,options);
  if(options.method!=='PUT')return raceResponse(conflictServer);
  conflictWrites++;
  const sent=JSON.parse(options.body);
  if(sent.rev!==conflictServer.rev)return raceResponse({rev:conflictServer.rev},409);
  resolvedBoard=sent;
  return raceResponse({rev:conflictServer.rev+1});
 };
 const localY=evaluate('node("n1").y+70');
 const localConflictPrompt='我的完整提示词'.repeat(110)+'，保留结尾';
 evaluate(`node("n1").name="<b>我的命名</b>";node("n1").data.prompt=${JSON.stringify(localConflictPrompt)};node("n1").y=${localY};save()`);
 await evaluate('flushSave()');
 await ready('!$("#acConflict").hidden && AC.pending.has(boardId)','a conflicting edit exposes the review entry');
 assert.equal(conflictWrites,1);
 const storedConflict=JSON.parse(w.localStorage.getItem('h3.chat.conflict.btest'));
 assert.ok(storedConflict.base.nodes.some(n=>n.id==='n1'));
 equal(storedConflict.draft.nodes.find(n=>n.id==='n1').name,'<b>我的命名</b>');
 evaluate(`AC.pending.delete(boardId);acApplyBoard(${JSON.stringify(conflictServer)},true);restoreCanvasConflict();`);
 assert.equal(evaluate('node("n1").name'),'<b>我的命名</b>','the local comparison and draft survive reopening');
 evaluate('$("#acConflict button").click()');
 await ready('$("#canvasConflictReview").open && $$("#canvasConflictReview fieldset").length===2','both conflicting fields can be reviewed');
 const conflictRow=field=>[...w.document.querySelectorAll('#canvasConflictReview fieldset')].find(row=>row.querySelector('legend').textContent.endsWith(field));
 const compared=field=>[...conflictRow(field).querySelectorAll('pre')].map(el=>el.textContent);
 const choose=(field,side)=>conflictRow(field).querySelector(`input[value=${side}]`).click();
 const confirmConflict=w.document.querySelector('[data-conflict-save]');
 equal(compared('名称'),['<b>我的命名</b>','同事命名']);
 equal(compared('提示词'),[localConflictPrompt,'同事的提示词'],'the full prompt is available for comparison');
 assert.equal(evaluate('$("#canvasConflictReview pre b")'),null);
 assert.equal(confirmConflict.disabled,true);
 choose('名称','remote');
 assert.equal(confirmConflict.disabled,true,'all conflict fields require an explicit choice');
 choose('提示词','local');
 assert.equal(confirmConflict.disabled,false);
 conflictServer.rev++;
 sharedNode.name='同事最新命名';
 confirmConflict.click();
 await ready('$("#canvasConflictReview [role=status]").textContent.includes("重新核对")','a stale choice waits for a fresh confirmation');
 assert.equal(resolvedBoard,undefined);
 equal(compared('名称'),['<b>我的命名</b>','同事最新命名']);
 assert.equal(confirmConflict.disabled,true,'a new revision clears the previous decisions');
 evaluate('$("[data-select-side=remote]").click()');
 equal(evaluate('$$("#canvasConflictReview input:checked").map(x=>x.value)'),['remote','remote']);
 choose('提示词','local');
 confirmConflict.click();
 await ready('$("#acConflict").hidden && !$("#canvasConflictReview").open','the confirmed result resumes editing the original canvas');
 const resolvedNode=resolvedBoard.nodes.find(n=>n.id==='n1');
 equal([resolvedNode.name,resolvedNode.data.prompt,resolvedNode.x,resolvedNode.y],['同事最新命名',localConflictPrompt,sharedNode.x,localY], 'mixed conflict choices preserve compatible changes from both sides');
 assert.equal(w.localStorage.getItem('h3.chat.conflict.btest'),null);
 console.log('Conflict review passed: persistent local draft, plain-text preview, stale-choice refresh and in-place resolution.');
 const legacyDraft=JSON.parse(evaluate('JSON.stringify(B)'));
 legacyDraft.shared=true;
 legacyDraft.name='共享原稿';
 w.localStorage.setItem('h3.chat.conflict.btest',JSON.stringify(legacyDraft));
 let conflictCopyId, conflictCopyData;
 w.fetch=async(url,options={})=>{
  const path=new URL(url,'http://oneshot.test').pathname;
  if(path==='/api/board/btest'&&options.method!=='PUT')return raceResponse({error:'共享画布已无法读取'},404);
  if(/^\/api\/board\/b[0-9a-f]{24}$/.test(path)&&options.method==='PUT'){
   conflictCopyId=path.split('/').at(-1);
   conflictCopyData=JSON.parse(options.body);
   return raceResponse({rev:1});
  }
  if(conflictCopyId&&path===`/api/board/${conflictCopyId}`)return raceResponse({...conflictCopyData,rev:1});
  return collaborationFetch(url,options);
 };
 evaluate('restoreCanvasConflict();$("#acConflict button").click()');
 await ready('!$("[data-conflict-copy]").disabled','an unreadable shared canvas still makes its local draft available');
 assert.equal(confirmConflict.disabled,true);
 evaluate('$("[data-conflict-copy]").click()');
 await ready('boardId!=="btest" && !$("#canvasConflictReview").open','the saved copy opens without recreating the original');
 equal([conflictCopyData.name,conflictCopyData.shared],['共享原稿 · 本地副本',false]);
 assert.equal(Object.hasOwn(conflictCopyData,'rev'),false);
 assert.equal(w.localStorage.getItem('h3.chat.conflict.btest'),null);
 w.fetch=collaborationFetch;
 console.log('Conflict copy passed: legacy draft, inaccessible source and private recovery.');
 evaluate('selectOnly("n2");$("#ntools [data-a=text-document]").click()');
 const docSource=w.document.querySelector('#textDocument textarea');
 const docPreview=w.document.querySelector('#textDocumentPreview');
 const docSave=w.document.querySelector('[data-document-save]');
 assert.equal(evaluate('$("#textDocument").open'),true);
 const originalDocument=docSource.value;
 docSource.value='开场\n码头';
 docSource.setSelectionRange(0,2);
 w.document.querySelector('[data-document-format=heading]').click();
 assert.equal(docSource.value,'# 开场\n码头');
 assert.equal(docPreview.querySelector('h1').textContent,'开场');
 w.document.querySelector('[data-document-format=subsection]').click();
 assert.equal(docPreview.querySelector('h3').textContent,'开场');
 w.document.querySelector('[data-document-format=body]').click();
 assert.equal(docSource.value,'开场\n码头');
 w.document.querySelector('[data-document-format=heading]').click();
 const docBackground=w.document.querySelector('#textDocumentBackground');
 docBackground.value='lilac';
 docBackground.dispatchEvent(new w.Event('change',{bubbles:true}));
 assert.equal(docPreview.dataset.documentBackground,'lilac');
 docSource.setSelectionRange(docSource.value.length-2,docSource.value.length);
 w.document.querySelector('[data-document-format=table]').click();
 assert.match(docSource.value,/码头\n\n\| 镜头/,'inserting a table preserves the selected text');
 assert.ok(docPreview.querySelector('table'));
 const savedDocument=docSource.value+'\n![参考图](https://example.invalid/image.png)\n<a href="javascript:alert(1)">链接</a>';
 docSource.value=savedDocument;
 docSource.dispatchEvent(new w.Event('input',{bubbles:true}));
 assert.equal(docPreview.querySelector('img'),null);
 assert.equal(docPreview.querySelector('a').hasAttribute('href'),false);
 docSave.click();
 equal(evaluate('[node("n2").data.text,node("n2").data.text_format,$(".node-document h1",els.get("n2")).textContent]'),[savedDocument,'markdown','开场']);
 equal(evaluate('[node("n2").data.text_background,$(".card",els.get("n2")).dataset.documentBackground]'),['lilac','lilac']);
 evaluate('undo()');
 assert.equal(evaluate('$("textarea",els.get("n2")).value'),originalDocument);
 assert.equal(evaluate('$(".card",els.get("n2")).dataset.documentBackground'),'');
 evaluate('redo();$(".node-document h1",els.get("n2")).dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');
 docSource.value='未保存的本地修改';
 docSource.dispatchEvent(new w.Event('input',{bubbles:true}));
 evaluate('$("[data-document-close]").click();openTextDocument(node("n2"))');
 assert.equal(docSource.value,'未保存的本地修改','closing the editor retains the draft in the current tab');
 evaluate(`const remoteDocument=acClone(B);
  remoteDocument.nodes.find(n=>n.id==="n2").data.text="# 同事的修改";
  acApplyBoard(remoteDocument,true);`);
 assert.equal(docSave.disabled,true,'a stale draft cannot replace someone else’s edit');
 assert.equal(docSource.value,'未保存的本地修改');
 evaluate('$("[data-document-reload]").click()');
 assert.equal(docSource.value,'# 同事的修改');
 evaluate('acApplyBoard({...acClone(B),access:"reviewer"},true);closeTextDocument();openTextDocument(node("n2"))');
 assert.equal(docSource.readOnly,true);
 assert.equal(docSave.hidden,true);
 assert.equal(docPreview.querySelector('h1').textContent,'同事的修改');
 evaluate('closeTextDocument()');
 console.log('Canvas documents passed: formatting, safe previews, same-node save, undo, drafts, concurrent changes and reviewer access.');
 evaluate('acApplyBoard({...acClone(B),access:"owner"},true);openTextDocument(node("n2"))');
 const assetBody='    保留开头的空格\n\n# 文档资产\n\n'+'场记内容\n'.repeat(1300)+'\n最后一行  \n';
 docSource.value=assetBody;
 docSource.dispatchEvent(new w.Event('input',{bubbles:true}));
 evaluate('$("[data-document-asset]").click()');
 assert.equal(evaluate('$("#textDocument").open'),false);
 equal(evaluate('[CM.editor.querySelector("[name=kind]").value,CM.editor.querySelector(".cm-document pre").textContent]'),['document',assetBody]);
 evaluate('$("#memoryEditor button[type=submit]").click()');
 await ready('$("#memoryEditor .cm-error").textContent.includes("已保存")','complete document is collected into the library');
 const collectedDoc=projectAssets.at(-1);
 assert.equal(collectedDoc.document.text,assetBody);
 assert.equal(collectedDoc.document.format,'markdown');
 let documentDetailReads=0;
 w.fetch=async(url,options={})=>{
  const target=new URL(url,'http://oneshot.test');
  if(target.pathname===`/api/memory/${collectedDoc.id}`){
   assert.equal(target.searchParams.get('board'),conflictCopyId);
   documentDetailReads++;
   return raceResponse(collectedDoc);
  }
  return collaborationFetch(url,options);
 };
 const listedDoc={...collectedDoc,document:{name:collectedDoc.document.name,excerpt:'摘要而不是正文'}};
 await evaluate(`alPlace(${JSON.stringify(listedDoc)})`);
 assert.equal(documentDetailReads,1);
 const restoredDoc=evaluate('B.nodes[B.nodes.length-1]');
 equal([restoredDoc.data.text,restoredDoc.data.text_format],[assetBody,'markdown'],'placement loads the full library document and restores formatting');
 assert.equal(evaluate('$(".node-document h1",els.get(B.nodes.at(-1).id)).textContent'),'文档资产');
 assert.equal(evaluate('node("n2").data.text'),'# 同事的修改','collecting a draft leaves the source node alone');
 equal(evaluate(`(()=>{const count=B.nodes.length;let notice="";
  placeLibraryAsset({name:"长文档",kind:"document",document:{text:"字".repeat(20001)}},{x:0,y:0},null,error=>notice=error);
  return [B.nodes.length===count,notice.includes("20,000")];})()`),[true,true],'oversize library documents are never placed as truncated nodes');
 w.fetch=collaborationFetch;
 console.log('Document assets passed: full draft collection, summary hydration and Markdown round trip.');
 let audioTranscriptRequest, downloadedTranscript;
 const previousAudioTranscriptFetch=w.fetch;
 w.fetch=async(url,options={})=>{
  if(new URL(url,'http://oneshot.test').pathname!=='/api/audio/transcript')return previousAudioTranscriptFetch(url,options);
  audioTranscriptRequest=JSON.parse(options.body);
  return raceResponse({text:'原始台词',start:1,end:3,captions:[{start:1.25,end:2.5,text:'原始台词'}]});
 };
 evaluate(`const recordedSpeech=addNode("audio",700,400,{}, {name:"现场录音",versions:[
  {ref:"input:h3studio/interview.wav",url:"/media?ref=input:h3studio/interview.wav",seconds:4}],cur:0});
  selectOnly(recordedSpeech.id);$("#ntools [data-a=transcript]").click();
  const transcriptRange=$("#audioTranscript form");transcriptRange.elements.namedItem("in").value="1";
  transcriptRange.elements.namedItem("out").value="3";$("[data-transcript-run]").click();`);
 await ready('!!$("#audioTranscript textarea") && !$("[data-transcript-add]").disabled','a completed audio version can be transcribed and reviewed');
 equal(audioTranscriptRequest,{board:conflictCopyId,node:evaluate('recordedSpeech.id'),ref:'input:h3studio/interview.wav',in:1,out:3});
 assert.equal(evaluate('$("#audioTranscript [data-transcript-result] button").textContent'),'00:00:01.250');
 evaluate('const transcriptCue=$("#audioTranscript textarea");transcriptCue.value="校对台词";transcriptCue.dispatchEvent(new Event("input"))');
 const createSubtitleURL=w.URL.createObjectURL, revokeSubtitleURL=w.URL.revokeObjectURL, subtitleLink=w.HTMLAnchorElement.prototype.click;
 const readSubtitle = new Promise(resolve=>{
  w.URL.createObjectURL=blob=>{const reader=new w.FileReader();reader.onload=()=>resolve(reader.result);reader.readAsText(blob);return 'blob:subtitles';};
 });
 w.URL.revokeObjectURL=()=>{};
 w.HTMLAnchorElement.prototype.click=function(){downloadedTranscript=this.download;};
 evaluate('$("[data-transcript-download]").click()');
 assert.equal(await readSubtitle,'1\n00:00:01,250 --> 00:00:02,500\n校对台词\n');
 assert.equal(downloadedTranscript,'现场录音.srt');
 w.URL.createObjectURL=createSubtitleURL;w.URL.revokeObjectURL=revokeSubtitleURL;w.HTMLAnchorElement.prototype.click=subtitleLink;
 evaluate('$("[data-transcript-add]").click()');
 const canvasTranscript=evaluate('B.nodes.at(-1)');
 equal([canvasTranscript.type,canvasTranscript.data.text,canvasTranscript.data.transcript.cues[0].start],['text','校对台词',1.25]);
 equal(evaluate('B.edges.at(-1)'),{from:evaluate('recordedSpeech.id'),to:canvasTranscript.id,relation:'transcript',source_ref:'input:h3studio/interview.wav'});
 assert.equal(evaluate('$("#audioTranscript").open'),false);
 w.fetch=previousAudioTranscriptFetch;
 console.log('Audio transcript passed: node entry, pinned source range, cue editing, SRT and linked document.');
 evaluate(`const originalCaptionImage=node("n1");openFilm([originalCaptionImage]);
  FILM.spec.clips[0].subs=["镜头原字幕"];
  addFilmAudio(FILM,{...curV(recordedSpeech),name:recordedSpeech.name,node:recordedSpeech.id},.75);
  const captionTrack=FILM.spec.audio_clips[0];captionTrack.in=1;captionTrack.out=2;
  const captionTextNode=node(B.nodes.at(-1).id);
  const otherCaptionVersion=addNode("text",100,300,{text:"错版本",transcript:{...captionTextNode.data.transcript,source_ref:"input:h3studio/other.wav"}});
  renderFilmAudio();`);
 equal(evaluate('$$("[data-audio-transcript] option").map(o=>o.value)'),['',canvasTranscript.id],'only transcriptions of the selected source version appear');
 evaluate(`const captionSelector=$("[data-audio-transcript]");captionSelector.value=captionTextNode.id;
  captionSelector.dispatchEvent(new Event("change"));seekTimeline(1.25);previewTick();`);
 assert.equal(evaluate('$("#fmSub").textContent'),'校对台词');
 equal(evaluate('[filmAudioCaption(FILM.spec,.99),filmAudioCaption(FILM.spec,1),filmAudioCaption(FILM.spec,1.75)]'),['','校对台词','']);
 evaluate(`const trackStart=$("[data-audio-key=start]");trackStart.value="1.25";trackStart.dispatchEvent(new Event("change"));
  seekTimeline(1.25);previewTick();`);
 assert.equal(evaluate('$("#fmSub").textContent'),'镜头原字幕','moving the audio moves its subtitles too');
 evaluate('seekTimeline(1.5);previewTick()');
 assert.equal(evaluate('$("#fmSub").textContent'),'校对台词');
 evaluate('closeFilm();resumeFilmDraft()');
 equal(evaluate('[FILM.spec.audio_clips[0].captions[0].text,filmAudioCaption(FILM.spec,1.5)]'),['校对台词','校对台词']);
 evaluate('closeFilm()');
 console.log('Timeline transcript captions passed: version binding, trimming, movement, preview priority and saved draft.');
 let audioCutRequest;
 w.fetch=async(url,options={})=>{
  if(new URL(url,'http://oneshot.test').pathname!=='/api/audio/cut')return previousAudioTranscriptFetch(url,options);
  audioCutRequest=JSON.parse(options.body);
  return raceResponse({ref:'output:h3studio/edited-speech.wav',url:'/media?ref=output:h3studio/edited-speech.wav',seconds:1.25,
   ranges:[{start:.25,end:1,at:0},{start:2.5,end:3,at:.75}]});
 };
 evaluate(`Object.assign(captionTextNode.data.transcript,{start:0,end:4,cues:[
  {start:.25,end:1,text:"开头"},{start:1.25,end:2,text:"这句剪掉"},{start:2.5,end:3,text:"结尾"}]});
  recordedSpeech.versions.push({ref:"input:h3studio/later-recording.wav",url:"/media?ref=input:h3studio/later-recording.wav",seconds:5});
  recordedSpeech.cur=1;selectOnly(captionTextNode.id);$("#ntools [data-a=saved-transcript]").click();
  $$("#audioTranscript input[type=checkbox]")[1].click();`);
 assert.equal(evaluate('$("[data-transcript-source]").textContent'),'现场录音 · 版本 1');
 equal(evaluate('transcriptCuts(captionTextNode.data.transcript.cues,new Set([0,1])).map(({start,end})=>[start,end])'),[[.25,2]],
  'consecutive selected lines keep the gap between them');
 evaluate('const nodesBeforeAudioCut=B.nodes.length;$("[data-transcript-cut]").click()');
 await ready('!$("#audioTranscript").open && B.nodes.length===nodesBeforeAudioCut+2','line-based cut adds its audio and mapped transcript together');
 equal(audioCutRequest,{board:conflictCopyId,node:evaluate('recordedSpeech.id'),ref:'input:h3studio/interview.wav',ranges:[{start:.25,end:1},{start:2.5,end:3}]});
 const lastAudio=evaluate('node([...sel][0])');
 assert.equal(lastAudio.versions[0].ref,'output:h3studio/edited-speech.wav');
 equal(evaluate('B.nodes.at(-1).data.transcript.cues'),[{start:0,end:.75,text:'开头'},{start:.75,end:1.25,text:'结尾'}]);
 equal(evaluate('B.edges.slice(-2).map(e=>[e.relation,e.source_ref])'),[['audio_cut','input:h3studio/interview.wav'],['transcript','output:h3studio/edited-speech.wav']]);
 evaluate('undo()');
 equal(evaluate('[B.nodes.length===nodesBeforeAudioCut,node(recordedSpeech.id).cur]'),[true,1]);
 w.fetch=previousAudioTranscriptFetch;
 console.log('Text-based audio cuts passed: saved transcript, pinned version, retained pauses, splice remapping and undo.');
 equal(evaluate(`(()=>{
  const lightSample={width:3,height:1,data:new Uint8ClampedArray([100,100,100,255,100,100,100,140,100,100,100,255])};
  const neutral={x:-100,y:0,key:0,exposure:0,temperature:0,rim:0};
  const unchanged=structuredClone(lightSample);
  relightApply(unchanged,relightMap(lightSample,neutral),0);
  const left=structuredClone(lightSample), right=structuredClone(lightSample);
  relightApply(left,relightMap(lightSample,{...neutral,key:80}),60);
  relightApply(right,relightMap(lightSample,{...neutral,key:80,x:100}),-60);
  const front=relightMap(lightSample,{...neutral,key:80,depth:100});
  const back=relightMap(lightSample,{...neutral,key:80,depth:-100});
  return [unchanged.data.every((v,i)=>v===lightSample.data[i]),left.data[0]>left.data[8],right.data[0]<right.data[8],
   left.data[0]>left.data[2],right.data[0]<right.data[2],left.data[7],right.data[7],front.field[1]>back.field[1]];
 })()`),[true,true,true,true,true,140,140,true],'relighting changes position, depth and temperature while retaining alpha');
 await evaluate(`const sourcePortrait=addNode("image",200,300,{}, {name:"布光原图",versions:[copyAsset("portrait.png",{w:512,h:384})],cur:0});
  nodeAction(sourcePortrait,"relight")`);
 assert.equal(evaluate('IMAGE_EDITOR.mode'),'relight');
 evaluate(`(()=>{const c=$(".ie-canvas"),{tx,ty,scale}=IMAGE_EDITOR.view,r=c.getBoundingClientRect();
  const pointer=(type,x,y)=>c.dispatchEvent(new MouseEvent(type,{button:0,clientX:r.left+tx+x*scale,clientY:r.top+ty+y*scale}));
  pointer("pointerdown",256,192);pointer("pointermove",384,96);pointer("pointerup",384,96);
 })()`);
 equal(evaluate('[$("#ieLightX").value,$("#ieLightY").value]'),['50','-50'],'dragging the light uses image coordinates');
 evaluate(`$("#ieLightX").value="65";$("#ieLightX").dispatchEvent(new Event("input",{bubbles:true}));
   $("#ieLightTemperature").value="-50";$("#ieLightTemperature").dispatchEvent(new Event("input",{bubbles:true}));
   $("#ieLightDepth").value="-75";$("#ieLightDepth").dispatchEvent(new Event("input",{bubbles:true}));`);
 assert.equal(evaluate('$("#ieLightXValue").textContent'),'65');
 equal(evaluate('[$("#ieLightTemperatureValue").textContent,$("#ieLightDepthValue").textContent]'),['7550 K','后方 75%']);
 evaluate('$("#ieSaveLight").click()');
 await ready('sourcePortrait.versions.length===2 && !IMAGE_EDITOR.loading && !IMAGE_EDITOR.busy','the adjusted image is saved on the source node');
 equal(evaluate('[sourcePortrait.cur,curV(sourcePortrait).w,curV(sourcePortrait).h,curV(sourcePortrait).edit.source,curV(sourcePortrait).edit.light.x]'),
  [1,512,384,'output:h3studio/portrait.png',65]);
 await evaluate('$("#ieReuse").onclick()');
 equal(evaluate('[IMAGE_EDITOR.mode,sourcePortrait.cur,$("#ieLightX").value,$("#ieLightTemperature").value,$("#ieLightDepth").value]'),
  ['relight',0,'65','-50','-75']);
 evaluate('$("#ieRelightAI").click()');
 equal(evaluate('[IMAGE_EDITOR.mode,$("#ieAI").hidden,$("#ieSaveLight").hidden,$("#ieExportLight").hidden]'),['relight_ai',false,true,true]);
 assert.equal(evaluate('sourcePortrait.versions.length'),2,'preparing AI guidance does not submit a generation');
 const relightFetch=w.fetch;
 let modelLightRequest;
 w.fetch=async(url,options={})=>{
  if(String(url)!=='/api/image-edit/generate')return relightFetch(url,options);
  modelLightRequest=JSON.parse(options.body);
  const id='model-relight-qa', output=copyOutputForRelight(modelLightRequest);
  jobs.set(id,{state:'done',meta:{mode_name:'图片重新布光'},outputs:[output]});
  return {ok:true,text:async()=>JSON.stringify({ids:[id]})};
 };
 const copyOutputForRelight=recipe=>({ref:'output:h3studio/model-relight.png',url:'/media?ref=output:h3studio/model-relight.png',
  meta:{width:512,height:384},extra:{source:'edit',edit:{mode:'whole',source:recipe.ref,recipe}}});
 evaluate('$("#iePrompt").value=""');
 await evaluate('ieGenerate()');
 await ready('sourcePortrait.versions.length===3 && !IMAGE_EDITOR.loading && !sourcePortrait.job','structured model lighting saves a version');
 assert.deepEqual([modelLightRequest.mode,modelLightRequest.backend,modelLightRequest.relight.depth,modelLightRequest.relight.temperature],
  ['whole','h3',-75,-50]);
 await evaluate('$("#ieReuse").onclick()');
 equal(evaluate('[IMAGE_EDITOR.mode,relightSettings().depth,relightSettings().temperature]'),['relight_ai',-75,-50]);
 evaluate(`$("#ieRelightAI").click();
   const portraitBeforeExport=JSON.stringify(sourcePortrait), nodeCountBeforeRelight=B.nodes.length;
   $("#ieExportLight").click();`);
 await ready('B.nodes.length===nodeCountBeforeRelight+1 && !IMAGE_EDITOR.busy && !$("#ieLocateLight").hidden',
  'manual relighting exports a new canvas node from the editor');
 equal(evaluate(`(()=>{
   const exported=node(IMAGE_EDITOR.lightExportId), version=curV(exported);
   return [JSON.stringify(sourcePortrait)===portraitBeforeExport,IMAGE_EDITOR.mode,exported.type,
     version.w,version.h,version.edit.source,version.edit.light.depth,version.edit.light.temperature];
 })()`),[true,'relight','image',512,384,'output:h3studio/portrait.png',-75,-50]);
 evaluate(`const lightExportId=IMAGE_EDITOR.lightExportId;$("#ieLocateLight").click();`);
 equal(evaluate('[IMAGE_EDITOR===null,[...sel]]'),[true,[evaluate('lightExportId')]]);
 evaluate('undo()');
 equal(evaluate('[!node(lightExportId),B.nodes.length===nodeCountBeforeRelight]'),[true,true]);
 w.fetch=relightFetch;
 console.log('Image relighting passed: alpha, in-place save, separate export, canvas location, undo and AI handoff.');
 const originalCameraFetch=w.fetch;
 let cameraRequest;
 w.fetch=async(url,options={})=>{
  if(String(url)!=='/api/image-edit/generate')return originalCameraFetch(url,options);
  cameraRequest=JSON.parse(options.body);
  const id='camera-view-qa', results=Array.from({length:cameraRequest.count},(_,i)=>({
   ref:`output:h3studio/angle-${i}.png`,url:`/media?ref=output:h3studio/angle-${i}.png`,meta:{width:512,height:384},
   extra:{source:'edit',edit:{mode:'whole',source:cameraRequest.ref,recipe:cameraRequest}},
  }));
  jobs.set(id,{state:'done',meta:{mode_name:'图片换机位',seed:24},outputs:results});
  return {ok:true,text:async()=>JSON.stringify({ids:[id]})};
 };
 await evaluate(`const cameraPortrait=addNode("image",200,600,{}, {name:"机位原图",versions:[copyAsset("original-angle.png",{w:512,h:384})],cur:0});
  nodeAction(cameraPortrait,"image-camera")`);
 equal(evaluate('[IMAGE_EDITOR.mode,$("#ieBlend").hidden,$("#ieBackend").hidden]'),['camera',true,true]);
 evaluate(`const orbit=$(".ie-camera-orbit");
  const orbitPointer=(type,x,y)=>orbit.dispatchEvent(new MouseEvent(type,{clientX:x,clientY:y,button:0,bubbles:true}));
  orbitPointer("pointerdown",120,120);orbitPointer("pointermove",140,100);orbitPointer("pointerup",140,100);`);
 equal(evaluate('[imageCameraSettings().yaw,imageCameraSettings().pitch,$(".ie-camera-height").hidden]'),[75,20,false]);
 evaluate('orbitPointer("pointerdown",140,100);orbitPointer("pointermove",100,140);orbitPointer("pointercancel",100,140)');
 equal(evaluate('[imageCameraSettings().yaw,imageCameraSettings().pitch]'),[75,20],'cancelled orbit drag restores the starting pose');
 evaluate(`$("[data-camera-preset='2']").click();orbitPointer("pointerdown",120,120);orbitPointer("pointermove",120,100);orbitPointer("pointerup",120,100);`);
 equal(evaluate('[imageCameraSettings().yaw,imageCameraSettings().pitch]'),[180,20],'vertical drag preserves the rear heading');
 evaluate(`$("#ieCamSensor").value="s35";$("#ieCamOptics").value="anamorphic";$("#ieCamAperture").value="2.8";
  $("[data-camera-preset='0']").click();$("#ieCamPitch").value="25";$("#ieCamPitch").dispatchEvent(new Event("input"));
  $("#ieCamDistance").value="-40";$("#ieCamLens").value="18";$("#ieCamCount").value="3";`);
 assert.match(evaluate('$(".ie-camera-orbit").getAttribute("aria-label")'),/左环绕 90°.*俯拍 25°/);
 await evaluate('ieGenerate()');
 await ready('cameraPortrait.versions.length===4 && !IMAGE_EDITOR.loading && !cameraPortrait.job','three generated views appear on the same image node',300);
 equal([cameraRequest.mode,cameraRequest.backend,cameraRequest.count,cameraRequest.prompt,cameraRequest.camera_view],
  ['whole','h3',3,'',{yaw:-90,pitch:25,distance:-40,framing:'中景',lens:18,sensor:'s35',optics:'anamorphic',aperture:'2.8'}]);
 assert.equal(evaluate('cameraPortrait.versions[0].ref'),cameraRequest.ref);
 await evaluate('$("#ieReuse").onclick()');
 equal(evaluate('[IMAGE_EDITOR.mode,curV(cameraPortrait).ref,imageCameraSettings(),$("#ieCamCount").value]'),
  ['camera',cameraRequest.ref,cameraRequest.camera_view,'3']);
 evaluate('closeImageEditor();selectOnly(cameraPortrait.id);openAngle(cameraPortrait);$("#agLens").value="135";$("#agLens").dispatchEvent(new Event("input"));$("#agOk").click()');
 assert.match(evaluate('cameraPortrait.data.prompt'),/135 mm/);
 w.fetch=originalCameraFetch;
 console.log('Image camera tools passed: presets, camera preview controls, candidate versions, saved recipes and legacy prompts.');
 const opticFetch=w.fetch;
 let opticRequest;
 w.fetch=(url,options)=>{
  if(String(url)!=="/api/generate")return opticFetch(url,options);
  opticRequest=JSON.parse(options.body);
  const ref="output:h3studio/new-lens.mp4";
  jobs.set("video-optics-job",{state:"done",outputs:[{ref,url:"/media?ref="+encodeURIComponent(ref),meta:{width:640,height:480,duration:5}}]});
  return Promise.resolve({ok:true,text:async()=>JSON.stringify({ids:["video-optics-job"]})});
 };
 evaluate(`const opticalNode=addNode("video",2600,100,{prompt:"列车靠站"},{versions:[
    copyAsset("old-lens.mp4",{seconds:5}),copyAsset("older-no-snapshot.mp4",{seconds:5})],cur:0});
  selectOnly(opticalNode.id);$("#videoOpticsBtn").click();
  $('[data-video-optics-preset="1"]').click();$("#videoOptics [name=optics]").value="anamorphic";
  $("#videoOptics [type=submit]").click();`);
 equal(evaluate('[opticalNode.data.video_optics,opticalNode.data.prompt,$("#videoOptics").open]'),
  [{lens:85,sensor:'full-frame',optics:'anamorphic',aperture:'2'},'列车靠站',false]);
 await evaluate('generate(opticalNode)');
 await ready('opticalNode.versions.length===3 && !opticalNode.job','video optics request produces a new canvas version',350);
 assert.deepEqual(opticRequest.video_optics,{lens:85,sensor:'full-frame',optics:'anamorphic',aperture:'2'});
 equal(evaluate('[curV(opticalNode).video_recipe.video_optics,curV(opticalNode).generation_record.video_optics]'),
  [opticRequest.video_optics,opticRequest.video_optics]);
 evaluate('switchVersion(opticalNode,0)');
 assert.equal(evaluate('!!opticalNode.data.video_optics'),false,'selecting a legacy version restores its original settings');
 evaluate('switchVersion(opticalNode,2);switchVersion(opticalNode,1)');
 assert.equal(evaluate('!!opticalNode.data.video_optics'),false,'an older version without a snapshot does not inherit optics from another take');
 evaluate('switchVersion(opticalNode,2);$("#videoOpticsBtn").click()');
 equal(evaluate('$$("select",$("#videoOptics")).map(select=>select.value)'),['85','full-frame','anamorphic','2']);
 evaluate('$("#videoOptics [data-reset]").click();$("#videoOptics [type=submit]").click()');
 assert.equal(evaluate('!!videoReq(opticalNode,fullPrompt(opticalNode)).video_optics'),false,'clearing does not carry optics into the next submission');
 w.fetch=opticFetch;
 console.log('Video optics DOM passed: presets, request capture, legacy version switching and reset.');
 const oldSizeFetch=w.fetch;
 let pixelExport;
 w.fetch=async(url,options={})=>{
  if(String(url)!=='/api/image-edit/transform')return oldSizeFetch(url,options);
  pixelExport=JSON.parse(options.body);
  const {width:w,height:h}=pixelExport.resize;
  return {ok:true,text:async()=>JSON.stringify({ref:'output:h3studio/resized.png',url:'/media?ref=output:h3studio/resized.png',w,h,resize:pixelExport.resize})};
 };
 await evaluate(`const pixelInput=addNode("image",200,700,{}, {name:"尺寸原图",versions:[copyAsset("pixel-original.png",{w:512,h:384})],cur:0});
  nodeAction(pixelInput,"image-pixels")`);
 equal(evaluate('[IMAGE_EDITOR.mode,$("#iePixelSize").open,pixelSizeSettings()]'),['local',true,{width:512,height:384,fit:'contain'}]);
 evaluate('$("#iePixelWidth").value="100";$("#iePixelWidth").dispatchEvent(new Event("input",{bubbles:true}))');
 assert.equal(evaluate('$("#iePixelHeight").value'),'75');
 evaluate('IMAGE_EDITOR.crop={x:8,y:12,w:256,h:128};ieDraw()');
 assert.equal(evaluate('$("#iePixelHeight").value'),'50','the aspect lock uses the active crop');
 evaluate('$("#iePixelLock").click();$("#iePixelHeight").value="144";$("#iePixelFit").value="cover";$("#iePixelFit").dispatchEvent(new Event("change",{bubbles:true}))');
 equal(evaluate('[pixelSizeSettings(),$("#iePixelPreview").width,$("#iePixelPreview").height]'),[{width:100,height:144,fit:'cover'},100,144]);
 await evaluate('closeImageEditor();openImageEditor(pixelInput)');
 equal(evaluate('[$("#iePixelSize").open,$("#iePixelLock").checked,pixelSizeSettings()]'),[true,false,{width:100,height:144,fit:'cover'}]);
 await evaluate('$("#iePixelSave").onclick()');
 await ready('pixelInput.versions.length===2 && !IMAGE_EDITOR.loading','exact dimensions save into the original node');
 equal([pixelExport.ref,pixelExport.crop,pixelExport.resize],['output:h3studio/pixel-original.png',{x:8,y:12,w:256,h:128},{width:100,height:144,fit:'cover'}]);
 equal(evaluate('[curV(pixelInput).w,curV(pixelInput).h,curV(pixelInput).edit.resize]'),[100,144,{width:100,height:144,fit:'cover'}]);
 evaluate('closeImageEditor()');
 w.fetch=oldSizeFetch;
 console.log('Exact image sizing passed: crop-aware aspect lock, fit preview, draft restore and same-node save.');
 const oldUpscaleFetch=w.fetch;
 let upscaleRequest;
 w.fetch=async(url,options={})=>{
  if(String(url)!=='/api/image-edit/upscale')return oldUpscaleFetch(url,options);
  upscaleRequest=JSON.parse(options.body);
  const ref="output:h3studio/super-resolution.png";
  return {ok:true,text:async()=>JSON.stringify({ref,url:"/media?ref="+encodeURIComponent(ref),w:1024,h:768})};
 };
 await evaluate('switchVersion(pixelInput,0);nodeAction(pixelInput,"image-upscale")');
 await ready(`!$('[data-upscale="2"]').disabled`,'upscale becomes available on the selected historical image');
 equal(evaluate('[IMAGE_EDITOR.mode,$("#ieAI").hidden,$$("[data-upscale]").map(b=>b.textContent)]'),
  ['upscale',true,['2× · 1024 × 768','4× · 2048 × 1536']]);
 await evaluate(`$('[data-upscale="2"]').onclick()`);
 await ready('pixelInput.versions.length===3 && !IMAGE_EDITOR.loading','model upscale is saved as a new image version');
 equal(upscaleRequest,{ref:"output:h3studio/pixel-original.png",scale:2});
 equal(evaluate('[curV(pixelInput).w,curV(pixelInput).h,curV(pixelInput).edit,pixelInput.versions[0].ref]'),
  [1024,768,{source:"output:h3studio/pixel-original.png",mode:"upscale",scale:2,model:"FSRCNN"},"output:h3studio/pixel-original.png"]);
 evaluate('closeImageEditor()');
 w.fetch=oldUpscaleFetch;
 console.log('Model upscale DOM passed: historical source, dimensions, request and non-destructive version save.');
 const decomposeFetch=w.fetch;
 let decomposeRequest;
 w.fetch=async(url,options={})=>{
  if(String(url)!=="/api/image-edit/decompose")return decomposeFetch(url,options);
  decomposeRequest=JSON.parse(options.body);
  const layer=(id,name,x,y,w,h)=>({id,name,x,y,w,h,ref:"output:h3studio/"+id+".png",visible:true,opacity:1});
  const ref="output:h3studio/decomposed.png";
  return {ok:true,text:async()=>JSON.stringify({ref,url:"/media?ref="+encodeURIComponent(ref),w:512,h:384,
    layer_stack:{base_ref:decomposeRequest.ref,layers:[layer("background","背景",0,0,512,384),
      layer("object-1","物体 1",12,14,100,144),layer("object-2","物体 2",170,100,200,150)]}})};
 };
 await evaluate(`const decomposeSource=addNode("image",300,700,{}, {versions:[copyAsset("objects.png",{w:512,h:384})],cur:0});
   nodeAction(decomposeSource,"image-decompose")`);
 await ready('!$("#ieDecompose").disabled','automatic decomposition is available');
 await evaluate('$("#ieDecompose").onclick()');
 equal(decomposeRequest,{ref:"output:h3studio/objects.png"});
 equal(evaluate('[IMAGE_EDITOR.mode,decomposeSource.versions.length,IMAGE_EDITOR.layers.map(layer=>[layer.name,layer.x,layer.y])]'),
   ["layers",2,[["背景",0,0],["物体 1",12,14],["物体 2",170,100]]]);
 evaluate(`$("#ieLayerX").value="188";$("#ieLayerX").dispatchEvent(new Event("change"));closeImageEditor();`);
 await evaluate('openImageEditor(decomposeSource)');
 equal(evaluate('[IMAGE_EDITOR.layers.at(-1).x,curV(decomposeSource).layer_stack.layers.at(-1).x,decomposeSource.versions[0].ref]'),
   [188,170,"output:h3studio/objects.png"]);
 evaluate('closeImageEditor()');
 w.fetch=decomposeFetch;
 console.log('Image decomposition DOM passed: separate layers, source retention and movement draft restore.');
 evaluate(`const previewImage=addNode("image",0,100000,{}, {name:"预览图片",versions:[
   copyAsset("preview-first.png",{generation_record:{prompt:"历史版本 <img src=x>",effective_prompt:"生成时实际使用"},
    memory_used:[{name:"林森 <img src=x>",references:[{view:"face",ref:"input:h3studio/past-face.png"}]}]}),
   copyAsset("preview-current.png",{prompt:"当前版本提示词"})],cur:1});
   const previewAudio=addNode("audio",500,100000,{}, {name:"预览音频",versions:[
   copyAsset("preview-track.wav",{seconds:8}),copyAsset("preview-track-later.wav")],cur:1});
   addNode("text",1000,100000,{text:"历史音轨转写",transcript:{source_node:previewAudio.id,source_ref:previewAudio.versions[0].ref}},{name:"原始旁白"});
   addNode("text",1500,100000,{text:"其他版本转写",transcript:{source_node:previewAudio.id,source_ref:previewAudio.versions[1].ref}},{name:"后续旁白"});
   nodeAction(previewImage,"full");const previewBefore=snap();
   $("[data-light-version]").value="0";$("[data-light-version]").dispatchEvent(new Event("change"));`);
 equal(evaluate('[$("#lightTitle").textContent,$("#light [download]").download,$("#light img").src.includes("preview-first"),snap()===previewBefore]'),
  ['预览图片','preview-first.png',true,true]);
 evaluate('$("[data-light-overview]").click()');
 equal(evaluate('[$$("[data-light-tile]").length,document.activeElement.dataset.lightTile,$("[data-light-tile] img").src.endsWith("preview-first.png")]'),[2,"0",true]);
 evaluate('$$("[data-light-tile]")[1].click();$("[data-light-peek]").dispatchEvent(new KeyboardEvent("keydown",{code:"Backslash",bubbles:true,cancelable:true}))');
 equal(evaluate('[$("#light img.light-peek").src.endsWith("preview-first.png"),$("#light img.light-peek").hidden,previewImage.cur]'),[true,false,1]);
 evaluate('$("[data-light-peek]").dispatchEvent(new KeyboardEvent("keyup",{code:"Backslash",bubbles:true}))');
 assert.equal(evaluate('$("#light img.light-peek").hidden'),true);
 evaluate('$("[data-light-overview]").click();$$("[data-light-tile]")[0].click()');
 evaluate('$("[data-light-compare]").click()');
 equal(evaluate('[$$("#light figure").map(el=>el.textContent.trim()),previewImage.cur]'),[['画布当前版本','预览版本 1'],1]);
 evaluate('$("[data-light-details]").click()');
 equal(evaluate('[$("#lightDetails").hidden,$("#lightDetails pre").textContent,$$("#lightDetails img").length]'),
  [false,'历史版本 <img src=x>',0]);
 equal(evaluate('[$("#lightDetails li").textContent,$("#lightDetails li a").getAttribute("href")]'),
  ['林森 <img src=x> · 正面头肩','/media?ref=input%3Ah3studio%2Fpast-face.png'],
  'generation details link to the exact character angle used by the selected version');
 let copiedPreviewPrompt;
 Object.defineProperty(w.navigator,'clipboard',{configurable:true,value:{writeText:async value=>{copiedPreviewPrompt=value;}}});
 await evaluate('$("[data-light-copy-prompt]").onclick()');
 assert.equal(copiedPreviewPrompt,'历史版本 <img src=x>');
 delete w.navigator.clipboard;
 evaluate('$("[data-light-copy]").click()');
 equal(evaluate('[curV(node([...sel][0])).copied_from.version,previewImage.cur,$(".light-status").textContent]'),[1,1,'已放入画布']);
 assert.equal(evaluate('$("[data-light-locate]").hidden'),false);
 evaluate('const placedPreview=node([...sel][0]);$("[data-light-locate]").click()');
 equal(evaluate('[$("#light").open,sel.has(placedPreview.id),curV(placedPreview).ref]'),[false,true,'output:h3studio/preview-first.png']);
 evaluate('lightbox(previewImage.versions[0],previewImage)');
 evaluate('$("[data-light-close]").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true,cancelable:true}))');
 assert.equal(evaluate('lightState.nodeId'),evaluate('placedPreview.id'));
 evaluate('$("[data-light-close]").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true,cancelable:true}))');
 equal(evaluate('[$("#lightTitle").textContent,!!$("#light audio"),!!$("#light.on")]'),['预览音频',true,true]);
 evaluate('$("[data-light-close]").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');
 assert.equal(evaluate('$("#light").open'),false);
 evaluate('const lightPreviousAccess=B.access;B.access="reviewer";lightbox(previewImage.versions[0],previewImage)');
 equal(evaluate('[!!$("[data-light-copy]"),!!$("#light [download]"),!!$("[data-light-compare]"),!!$("[data-light-edit]")]'),[false,true,true,false]);
 evaluate('lightbox(previewAudio.versions[0],previewAudio);$("[data-light-details]").click()');
 equal(evaluate('[$("#lightDetails").hidden,$$("#lightDetails pre").map(el=>el.textContent),!!$("[data-light-edit]")]'),[false,['历史音轨转写'],false]);
 evaluate('closeLightbox();B.access=lightPreviousAccess;lightbox(previewAudio.versions[0],previewAudio);$("[data-light-edit]").click()');
 equal(evaluate('[$("#audioTranscript").open,$("#audioTranscript audio").src.endsWith("preview-track.wav"),previewAudio.cur]'),[true,true,1]);
 evaluate(`closeAudioTranscript();const previewVideo=addNode("video",1000,100500,{fields:{dialogue:"角色：新版台词"}},{name:"预览视频",versions:[
   copyAsset("preview-video-first.mp4",{seconds:8,w:720,h:1280,prompt:"旧版视频提示词",node_data:{fields:{dialogue:"角色：旧版台词"}},
    memory_used:[{name:"动作设定",references:[{ref:"input:h3studio/source-motion.mp4",type:"video",start:1,end:5},
     {ref:"input:h3studio/source-sound.wav",type:"audio"}]}]}),
   copyAsset("preview-video-current.mp4",{seconds:5,w:720,h:1280})],cur:1});
   lightbox(previewVideo.versions[0],previewVideo);$("[data-light-details]").click()`);
 equal(evaluate('$$("aside#lightDetails li a").map(a=>[a.textContent,a.getAttribute("href")])'),[
  ['参考视频 1–5 秒','/media?ref=input%3Ah3studio%2Fsource-motion.mp4#t=1,5'],
  ['参考音频','/media?ref=input%3Ah3studio%2Fsource-sound.wav'],
 ]);
 evaluate('$("[data-light-edit]").click()');
 equal(evaluate('[FILM.target.ref,FILM.spec.clips[0].ref,FILM.spec.clips[0].media_seconds,FILM.spec.clips[0].subs,previewVideo.cur]'),
  ['output:h3studio/preview-video-first.mp4','output:h3studio/preview-video-first.mp4',8,['旧版台词'],1]);
 const previewRenderFetch=w.fetch;
 let previewRender;
 w.fetch=async (url,options) => {
  const route=String(url);
  if(route==='/api/render/check')return {ok:true,text:async()=>JSON.stringify({ok:true,dimensions:[720,1280]})};
  if(route!=='/api/render')return previewRenderFetch(url,options);
  previewRender=JSON.parse(options.body);
  const id='preview-timeline-result',ref='output:h3studio/preview-timeline.mp4';
  jobs.set(id,{state:'done',outputs:[{ref,url:'/media?ref='+encodeURIComponent(ref),meta:{width:720,height:1280,duration:8}}]});
  return {ok:true,text:async()=>JSON.stringify({ids:[id]})};
 };
 evaluate('$("#fmGo").click()');
 await ready('previewVideo.versions.length===3','export from the historical preview adds a version to the same node',300);
 assert.equal(previewRender.target.ref,'output:h3studio/preview-video-first.mp4');
 assert.equal(previewRender.spec.clips[0].ref,previewRender.target.ref);
 equal(evaluate('[curV(previewVideo).prompt,previewVideo.versions[1].ref]'),
  ['旧版视频提示词','output:h3studio/preview-video-current.mp4']);
 w.fetch=previewRenderFetch;
 evaluate(`closeFilm();lightbox(previewImage.versions[0],previewImage);
   $("[data-light-close]").dispatchEvent(new KeyboardEvent("keydown",{key:"e",bubbles:true}))`);
 await ready('IMAGE_EDITOR?.ref===previewImage.versions[0].ref','image editor loads the explicitly selected version');
 equal(evaluate('[$("#light").open,previewImage.cur]'),[false,0]);
 evaluate('closeImageEditor()');
 console.log('Fullscreen media passed: historical download, still comparison, independent copy, keyboard navigation and reviewer permissions.');
 console.log('Media version details passed: prompt display and copy, source-specific transcript, historical video timeline and image edit handoff.');
 evaluate(`const fixedId=addNode("image",100,110000,{}, {name:"定稿图"}).id;
   const movableIds=[addNode("video",750,110200,{}, {versions:[copyAsset("movable-one.mp4")],cur:0}).id,
     addNode("video",800,111000,{}, {versions:[copyAsset("movable-two.mp4")],cur:0}).id];
   selectOnly(fixedId);
   const openNodeActions=id=>ctxMenu({target:els.get(id),clientX:150,clientY:110});
   $("#ntools [data-a=pin]").click();$("#nodePinMenu [data-a='pin:lilac']").click();
   openNodeActions(fixedId);$("#ctxMenu [data-a='lock-selection']").click();`);
 equal(evaluate('[node(fixedId).pin,node(fixedId).locked,$(".node-lock",els.get(fixedId)).hidden,!!$("#ntools [data-a=del]")]'),
  ['lilac',true,false,false]);
 evaluate('$("#nodeSearchBtn").click();$(".ns-status").value="lilac";$(".ns-status").dispatchEvent(new Event("change"))');
 equal(evaluate('$$("#nodeSearch li strong").map(el=>el.textContent.trim())'),['定稿图']);
 evaluate('$("#nodeSearch [data-close]").click()');
 evaluate(`sel=new Set([fixedId,movableIds[0]]);updateSel();
   $("#selectionTools [data-action=pin]").click();$("#nodePinMenu [data-a='pin:amber']").click();
   $("#nodePinBar [data-pin-color=amber]").click();`);
 equal(evaluate('[nodePins(node(fixedId)),$$(".node-pins .node-pin",els.get(fixedId)).length,$$(".ns-status option:checked").map(x=>x.value),$$("#nodeSearch li").length]'),
  [['lilac','amber'],2,['amber'],2],'adding a second color preserves the existing marker and opens the corresponding color group');
 evaluate('$("#nodeSearch [data-close]").click();$("#selectionTools [data-action=pin]").click()');
 assert.equal(evaluate('$("#nodePinMenu [data-a=\'pin:amber\']").getAttribute("aria-pressed")'),'true');
 evaluate('$("#nodePinMenu [data-a=\'pin:amber\']").click()');
 equal(evaluate('[nodePins(node(fixedId)),!!$("#nodePinBar [data-pin-color=amber]")]'),[['lilac'],false],
   'toggling a shared color removes only that color');
 evaluate('undo()');
 assert.equal(evaluate('!!$("#nodePinBar [data-pin-color=amber]")'),true,'undo restores the bar and the markers');
 evaluate('markCanvasNodes([fixedId,movableIds[0]],"amber")');
 evaluate(`$(".lbl",els.get(fixedId)).dispatchEvent(new MouseEvent("pointerdown",{button:0,clientX:150,clientY:100,bubbles:true}));
   window.dispatchEvent(new MouseEvent("pointermove",{clientX:240,clientY:170}));
   window.dispatchEvent(new MouseEvent("pointerup",{clientX:240,clientY:170}));`);
 assert.equal(evaluate('node(fixedId).x'),100);
 evaluate(`sel=new Set([fixedId,...movableIds]);updateSel();
   const movablePrior=node(movableIds[0]).x;
   document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true,cancelable:true}));
   const movableShift=node(movableIds[0]).x-movablePrior;
   ctArrange("grid",[fixedId,...movableIds]);ctGroup();
   const groupPositions=()=>[fixedId,...movableIds].map(id=>[node(id).x,node(id).y]);
   const beforeGroupDrag=JSON.stringify(groupPositions());
   const lockedGroup=(B.groups||[]).find(g=>g.nodes.includes(fixedId));
   const groupHeader=$(".cg-head",CT_GROUPS.get(lockedGroup.id));
   ctDragGroup({target:groupHeader,button:0,clientX:100,clientY:100,preventDefault(){},stopPropagation(){}},lockedGroup);
   window.dispatchEvent(new MouseEvent("pointermove",{clientX:200,clientY:200}));
   window.dispatchEvent(new MouseEvent("pointerup",{clientX:200,clientY:200}));`);
 equal(evaluate('[movableShift,[node(fixedId).x,node(fixedId).y],JSON.stringify(groupPositions())===beforeGroupDrag]'),[10,[100,110000],true]);
 evaluate('markCanvasNodes([movableIds[0]],true,{lock:true})');
 assert.match(evaluate('vtMergeInfo(movableIds).error'),/先解锁/);
 evaluate('markCanvasNodes([movableIds[0]],false,{lock:true});sel=new Set([fixedId,...movableIds]);updateSel();openNodeActions(fixedId);$("#ctxMenu [data-a=del]").click()');
 equal(evaluate('[!!node(fixedId),movableIds.map(id=>!!node(id)),[...sel]]'),[true,[false,false],[evaluate('fixedId')]]);
 evaluate('undo();selectOnly(fixedId);$("#ntools [data-a=unlock-node]").click();undo()');
 assert.equal(evaluate('node(fixedId).locked'),true,'undo restores the lock');
 evaluate('const originalAccess=B.access;B.access="reviewer";openNodeActions(fixedId);markCanvasNodes([fixedId],"rose");removeNodes([fixedId])');
 equal(evaluate('[!!$("#ctxMenu .node-pin-menu"),node(fixedId).pin,node(fixedId).locked]'),[false,'lilac',true]);
 evaluate('closeMenus();B.access=originalAccess;const lockBase={nodes:[{id:"locktest",x:10,y:20}]};');
 equal(evaluate('acMerge(lockBase,{nodes:[{id:"locktest",x:300,y:400}]},{nodes:[{id:"locktest",x:10,y:20,locked:true}]}).nodes[0]'),
  {id:'locktest',x:10,y:20,locked:true});
 const lockSaveFetch=w.fetch;
 let lockSaved;
 w.fetch=async(url,options={})=>{
  if(options.method==='PUT' && String(url).startsWith('/api/board/'))lockSaved=JSON.parse(options.body);
  return lockSaveFetch(url,options);
 };
 await evaluate('save();flushSave()');
 const savedLock=lockSaved.nodes.find(n=>n.id===evaluate('fixedId'));
 equal([savedLock.pin,savedLock.locked],['lilac',true]);
 w.fetch=lockSaveFetch;
 evaluate('selectOnly(fixedId);$("#ntools [data-a=unlock-node]").click();removeNodes([fixedId])');
 assert.equal(evaluate('!!node(fixedId)'),false,'an explicitly unlocked node can be deleted');
 console.log('Node organization passed: color marks and search, protected movement and deletion, merge, undo, collaboration and serialized state.');
 evaluate(`const guideId=addNode("text",40,120000,{text:"跟随参考线"}).id;
   const guideNeighborId=addNode("text",300,120250,{text:"对齐目标"}).id;
   B.view={x:0,y:-59910,k:.5};applyView();
   const layoutPrefs=key=>$("[data-canvas-layout="+key+"]");
   const activeGuideCount=()=>$$("#canvasDragGuides line").filter(line=>line.style.display!=="none").length;
   const layoutDragStart=(id,x,y)=>$(".lbl",els.get(id)).dispatchEvent(new MouseEvent("pointerdown",{button:0,clientX:x,clientY:y,bubbles:true}));
   const layoutPointer=(type,x,y,altKey=false)=>window.dispatchEvent(new MouseEvent(type,{clientX:x,clientY:y,altKey}));
   $("#canvasLayoutBtn").click();layoutPrefs("guides").click();`);
 equal(evaluate('[layoutPrefs("guides").checked,layoutPrefs("grid").checked,localStorage.getItem("h3.canvasGuides"),$("#canvasLayoutBtn").getAttribute("aria-expanded")]'),
  [true,false,'1','true']);
 evaluate('layoutPrefs("guides").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');
 equal(evaluate('[!!$("#canvasLayoutMenu.on"),document.activeElement.id]'),[false,'canvasLayoutBtn']);
 evaluate('layoutDragStart(guideId,100,140);layoutPointer("pointermove",227,143)');
 equal(evaluate('[node(guideId).x,activeGuideCount(),Number($("#canvasDragGuides line").getAttribute("x1"))]'),[300,1,150]);
 evaluate('layoutPointer("pointermove",227,143,true)');
 equal(evaluate('[node(guideId).x,activeGuideCount()]'),[294,0]);
 evaluate('layoutPointer("pointerup",227,143)');
 equal(evaluate('[node(guideId).x,activeGuideCount()]'),[300,0]);
 evaluate('undo();const dragHistorySize=undoStack.length;layoutDragStart(guideId,100,140);layoutPointer("pointermove",227,143);layoutPointer("pointercancel",227,143)');
 equal(evaluate('[node(guideId).x,activeGuideCount(),undoStack.length]'),[40,0,evaluate('dragHistorySize')]);
 evaluate(`$("#canvasLayoutBtn").click();layoutPrefs("guides").click();layoutPrefs("grid").click();closeMenus();
   const otherPlacedId=addNode("text",95,120070,{text:"同组选区"}).id;
   B.view={x:0,y:-119900,k:1};applyView();sel=new Set([guideId,otherPlacedId]);updateSel();
   layoutDragStart(guideId,120,160);layoutPointer("pointermove",144,179);layoutPointer("pointerup",144,179);`);
 equal(evaluate('[node(guideId).x,node(guideId).y,node(otherPlacedId).x-node(guideId).x,node(otherPlacedId).y-node(guideId).y,activeGuideCount(),localStorage.getItem("h3.canvasGrid")]'),
  [55,120021,55,70,0,'1']);
 evaluate(`ctGroup(true);const snapGroup=B.groups.find(g=>g.nodes.includes(guideId));
   ctDragGroup({target:$(".cg-head",CT_GROUPS.get(snapGroup.id)),button:0,clientX:120,clientY:160,preventDefault(){},stopPropagation(){}},snapGroup);
   layoutPointer("pointermove",149,183);layoutPointer("pointerup",149,183);`);
 equal(evaluate('[(snapGroup.fold.x-11)%22,(snapGroup.fold.y-11)%22,node(otherPlacedId).x-node(guideId).x,node(guideNeighborId).x]'),
  [0,0,55,300]);
 console.log('Canvas drag alignment passed: settings, zoom-scaled guides, modifier bypass, undo, pointer cancellation, grid and folded group offsets.');
 const voicePointFetch=w.fetch;
 let failPlacementSend=false, voiceCommand=null, deferNodeTranscript=false, finishNodeTranscript, voiceSignal;
 const voiceRequests=[];
 const voiceStops=[];
 w.fetch=async(url,options={})=>{
  if(options.method==="POST" && String(url).split("?")[0]==="/api/transcription" && voiceCommand!==null) {
   voiceSignal=options.signal;
   voiceRequests.push({url:String(url),size:options.body.get("file").size});
   return {ok:true,json:()=>deferNodeTranscript
    ? new Promise(resolve=>{w.__nodeTranscriptPending=true;finishNodeTranscript=()=>resolve({text:voiceCommand});})
    : Promise.resolve({text:voiceCommand})};
  }
  if(options.method==="POST" && /^\/api\/chat\/runs\/voice-scope-[^/]+\/stop$/.test(String(url))){
   voiceStops.push(String(url));
   return {ok:true,json:async()=>({ok:true})};
  }
  if(options.method==='POST' && /^\/api\/chat\/sessions\/[^/]+\/messages$/.test(String(url))){
   w.__chatPayload=JSON.parse(options.body);
   if(failPlacementSend){failPlacementSend=false;return {ok:false,json:async()=>({error:'模拟发送失败'})};}
   return {ok:true,json:async()=>({id:'voice-point-run',state:'done'})};
  }
  return voicePointFetch(url,options);
 };
 await evaluate('acOpen({focus:false})');
 await ready('acVoiceAvailable && AC.session','voice shortcut capabilities and session are available');
 evaluate(`AC.refs=null;AC.selection=null;AC.reviews=[];AC.referencePins.clear();
   $("#acInput").value="";sel.clear();updateSel();
   const voicedImage=addNode("image",250,130000,{}, {name:"语音参考图",versions:[
    copyAsset("voice-original.png"),copyAsset("voice-later.png")],cur:0});
   const voicedAudio=addNode("audio",450,130000,{}, {name:"语音参考配乐",versions:[copyAsset("voice-music.wav")],cur:0});
   $(".card",els.get(voicedAudio.id)).getBoundingClientRect=()=>({left:780,top:400,width:80,height:60});
   window.__chatPayload=null;window.__heldStops=0;
   Object.defineProperty(navigator,"mediaDevices",{configurable:true,value:{
    getUserMedia:async()=>({getTracks:()=>[{stop(){window.__heldStops++;}}]})
   }});
   window.MediaRecorder=class {
    static isTypeSupported(){return true;}
    start(timeslice){this.state="recording";this.timeslice=timeslice;}
    stop(){this.state="inactive";queueMicrotask(()=>{
     this.ondataavailable({data:new Blob([this.timeslice?"full recording":"segment"],{type:"audio/webm"})});this.onstop();
    });}
   };
   const voiceKey=(type,key="r",code="KeyR",target=document.body)=>target.dispatchEvent(new KeyboardEvent(type,{key,code,bubbles:true,cancelable:true}));
   $("#acClose").click();voiceKey("keydown");`);
 await ready('acVoiceActive?.phase==="recording" && AC.open','holding the key opens the assistant and starts recording');
 evaluate(`$(".card",els.get(voicedImage.id)).dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true,cancelable:true}));
   vp.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true,cancelable:true,clientX:770,clientY:390}));
   window.dispatchEvent(new MouseEvent("pointermove",{clientX:875,clientY:470}));
   window.dispatchEvent(new MouseEvent("pointerup",{clientX:875,clientY:470}));
   const spokenTarget=toW(620,440);
   vp.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true,cancelable:true,clientX:620,clientY:440}));
   window.dispatchEvent(new MouseEvent("pointerup",{clientX:620,clientY:440}));
   switchVersion(voicedImage,1);`);
 equal(evaluate('[...acVoiceActive.refs.keys()]'),[evaluate('voicedImage.id'),evaluate('voicedAudio.id')]);
 assert.equal(evaluate('els.get(voicedImage.id).classList.contains("ac-voice-reference")'),true);
 equal(evaluate('[$("#acPlacementMarker").hidden,$("#acPlacementMarker").style.left]'),[false,'620px']);
 evaluate('voiceKey("keyup")');
 await ready('window.__chatPayload?.selected_versions?.length===2 && !AC.sending','release sends the transcript and exact reference versions').catch(error=>{
  throw new Error(error.message+': '+JSON.stringify(evaluate('[acVoiceActive?.phase, $("#acVoiceStatus").textContent, $("#acInput").value, $("#toast").textContent, AC.session, AC.board, boardId, window.__chatPayload]')));
 });
 equal(w.__chatPayload.selected_versions,[
  {node_id:evaluate('voicedImage.id'),ref:'output:h3studio/voice-original.png'},
  {node_id:evaluate('voicedAudio.id'),ref:'output:h3studio/voice-music.wav'},
 ]);
 equal(w.__chatPayload.placement,JSON.parse(evaluate('JSON.stringify({x:Math.round(spokenTarget.x),y:Math.round(spokenTarget.y)})')));
 assert.equal(evaluate('$("#acPlacementMarker").hidden'),true,'the sent marker clears from the canvas');
 equal(evaluate('[activeGuideCount(),!!$(".node.ac-voice-reference"),window.__heldStops]'),[0,false,1]);
 evaluate('window.__chatPayload=null;$("#acInput").value="现有草稿";voiceKey("keydown")');
 await ready('acVoiceActive?.phase==="recording"','the shortcut starts another recording');
 evaluate('voiceKey("keyup")');
 await ready('$("#acVoiceStatus").textContent==="已添加到草稿"','a pre-existing draft remains available for review');
 equal(evaluate('[$("#acInput").value,window.__chatPayload]'),['现有草稿\n把背景调暖',null]);
 evaluate('$("#acVoiceKey").value="Space";$("#acVoiceKey").dispatchEvent(new Event("change"));voiceKey("keydown"," ","Space")');
 await ready('acVoiceActive?.phase==="recording"','the configured space shortcut starts recording');
 evaluate('voiceKey("keydown","Escape","Escape",$("#acInput"));voiceKey("keyup"," ","Space")');
 equal(evaluate('[acVoiceActive,spaceDown,window.__chatPayload,localStorage.getItem("h3.chat.voiceKey")]'),[null,false,null,'Space']);
 evaluate('voiceKey("keydown"," ","Space",$("#acInput"))');
 assert.equal(evaluate('acVoiceActive'),null,'typing a space cannot activate recording');
 voiceCommand="停止当前任务。";
 evaluate(`const voiceSelector=$("#acVoiceKey");
   voiceSelector.value="custom";voiceSelector.dispatchEvent(new Event("change"));
   voiceKey("keydown","q","KeyQ",voiceSelector);
   AC.runs=[{id:"voice-scope-original",state:"running"}];window.__chatPayload=null;
   voiceKey("keydown","q","KeyQ");`);
 await ready('acVoiceActive?.phase==="recording"','custom shortcut starts a scoped voice command');
 equal(evaluate('[voiceSelector.value,localStorage.getItem("h3.chat.voiceKey")]'),['KeyQ','KeyQ']);
 evaluate('voiceKey("keyup","q","KeyQ")');
 await ready('$("#acVoiceStatus").textContent==="已请求停止当前任务"','voice sends the stop request and acknowledges it');
 assert.deepEqual(voiceStops,["/api/chat/runs/voice-scope-original/stop"]);
 equal(evaluate('[$("#acInput").value,window.__chatPayload]'),['现有草稿\n把背景调暖',null]);
 evaluate(`AC.runs=[{id:"voice-scope-ending",state:"running"}];voiceKey("keydown","q","KeyQ");`);
 await ready('acVoiceActive?.phase==="recording"','recording captures the active task before the queue advances');
 evaluate(`AC.runs=[{id:"voice-scope-next",state:"running"}];voiceKey("keyup","q","KeyQ");`);
 await ready('$("#acVoiceStatus").textContent==="录音开始时的任务已无法停止"','the newly activated task is spared');
 assert.equal(voiceStops.length,1);
 assert.equal(evaluate('window.__chatPayload'),null);
 evaluate('AC.runs=[];voiceSelector.value="Space";voiceSelector.dispatchEvent(new Event("change"))');
 voiceCommand=null;
 console.log('Voice command DOM passed: custom shortcut, draft preservation, scoped stop and queue transition.');
 evaluate(`$("#acPickPlacement").click();
   vp.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true,cancelable:true,clientX:430,clientY:320}));
   B.view.x+=20;applyView();`);
 equal(evaluate('[$("#acPlacementMarker").style.left,!!$("[data-locate-placement]"),acPickingPlacement]'),['450px',true,false]);
 evaluate('$("[data-remove-placement]").click()');
 equal(evaluate('[AC.placement,$("#acPlacementMarker").hidden]'),[null,true]);
 evaluate(`$("#acPickPlacement").click();
   vp.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true,cancelable:true,clientX:430,clientY:320}));
   const typedTarget={...AC.placement};
   $("#acInput").value="把标题放在这个位置";`);
 failPlacementSend=true;
 await evaluate('acSend()');
 const placementRequestKey=w.__chatPayload.request_key;
 await evaluate('acLoadSession(AC.session)');
 const restoredTarget=JSON.parse(evaluate('JSON.stringify(typedTarget)'));
 equal(evaluate('[AC.placement,$("#acPlacementMarker").hidden,$("#acInput").value]'),[restoredTarget,false,'把标题放在这个位置']);
 await evaluate('acSend()');
 equal([w.__chatPayload.placement,w.__chatPayload.request_key],[restoredTarget,placementRequestKey]);
 assert.equal(evaluate('$("#acPlacementMarker").hidden'),true);
 const beforeNodeVoice=evaluate('snap()');
 voiceCommand="人物从门内走出";
 evaluate(`const dictatedVideo=addNode("video",700,130000,{pmode:"fields",fields:{action:"保留站位"}});
   selectOnly(dictatedVideo.id);
   $("#ppVoiceRecord").focus();
   window.__chatPayload=null;
   voiceKey("keydown"," ","Space",$("#ppVoiceRecord"));`);
 await ready('acVoiceActive?.phase==="recording" && acVoiceActive.target.dataset.k==="action"','focused node voice uses the video action field');
 equal(evaluate('[spaceDown,acVoicePointing(),$("#acVoiceRecord").disabled]'),[false,null,true]);
 evaluate('voiceKey("keyup"," ","Space",$("#ppVoiceRecord"))');
 await ready('$("#ppVoiceStatus").textContent==="已填入提示词"','letting go transcribes the node recording');
 equal(evaluate('[dictatedVideo.data.fields.action,window.__chatPayload,!!dictatedVideo.job]'),
 ["保留站位\n人物从门内走出",null,false],'dictation stays in the node draft and does not start generation');
 evaluate('undo();');
 assert.equal(evaluate('node(dictatedVideo.id).data.fields.action'),"保留站位",'dictation can be undone with the canvas history');

 voiceCommand="停止";
 evaluate('selectOnly(voicedAudio.id);$("#ppVoiceRecord").click()');
 await ready('acVoiceActive?.phase==="recording"','clicking the audio node voice action starts recording');
 evaluate('$("#ppVoiceRecord").click()');
 await ready('node(voicedAudio.id).data.prompt==="停止"','node dictation keeps a spoken word as draft text');
 assert.equal(voiceStops.length,1);

 voiceCommand="已取消的文字";deferNodeTranscript=true;
 evaluate('selectOnly(voicedImage.id);$("#ppVoiceRecord").click()');
 await ready('acVoiceActive?.phase==="recording"','image node exposes the same recorder');
 evaluate('$("#ppVoiceRecord").click()');
 await ready('acVoiceActive?.phase==="transcribing" && window.__nodeTranscriptPending','recording begins transcription');
 evaluate('selectOnly(voicedAudio.id)');
 assert.equal(evaluate('acVoiceActive'),null,'switching nodes cancels the pending dictation');
 finishNodeTranscript();delete w.__nodeTranscriptPending;deferNodeTranscript=false;voiceCommand=null;
 equal(evaluate('[node(voicedImage.id).data.prompt,node(voicedAudio.id).data.prompt]'),["","停止"]);

 voiceCommand="预览第一句";
 evaluate(`const voicePreviewChunk=()=>acVoiceActive.previewRecorder.stop();
  selectOnly(voicedImage.id);
  $("#ppVoiceLive").click();
  $("#ppVoiceRecord").click();`);
 await ready('acVoiceActive?.phase==="recording"','live preview recording starts');
 evaluate('voicePreviewChunk()');
 await ready('$("#ppVoicePreview").textContent==="预览第一句"','node partial transcript appears before stop');
 equal(evaluate('[$("#ppVoicePreview").hidden,$("#prompt").value,$("#acVoiceLive").checked]'),[false,"",true]);
 voiceCommand="预览第二句";
 evaluate('voicePreviewChunk()');
 await ready('$("#ppVoicePreview").textContent==="预览第一句\\n预览第二句"','a new segment follows the earlier transcript');
 voiceCommand="完整转写";
 evaluate('$("#ppVoiceRecord").click()');
 await ready('node(voicedImage.id).data.prompt==="完整转写"','only the final transcript enters the prompt');
 assert.deepEqual(voiceRequests.slice(-3),[
  {url:"/api/transcription?preview=1",size:"segment".length},
  {url:"/api/transcription?preview=1",size:"segment".length},
  {url:"/api/transcription",size:"full recording".length},
 ],'each preview sends a separate audio file and the final draft uses the continuous recording');
 assert.equal(evaluate('$("#ppVoicePreview").hidden'),true);

 voiceCommand="取消后的迟到预览";deferNodeTranscript=true;
 evaluate('$("#acInput").value="现有草稿";$("#acVoiceRecord").click()');
 await ready('acVoiceActive?.phase==="recording"','assistant live preview shares the setting');
 evaluate('voicePreviewChunk()');
 await ready('window.__nodeTranscriptPending','assistant preview request is in flight');
 evaluate('$("#acVoiceCancel").click()');
 assert.equal(voiceSignal.aborted,true);
 finishNodeTranscript();delete w.__nodeTranscriptPending;deferNodeTranscript=false;
 await Promise.resolve();
 equal(evaluate('[$("#acVoicePreview").hidden,$("#acInput").value,acVoiceActive]'),[true,"现有草稿",null]);
 evaluate('$("#acVoiceLive").click();$("#acVoiceRecord").click()');
 await ready('acVoiceActive?.phase==="recording"','recording restarts after cancel');
 evaluate('acVoiceActive.recorder.state="inactive";acVoiceActive.recorder.onstop()');
 equal(evaluate('[$("#acVoiceStatus").textContent,$("#acInput").value]'),["录音中断，请重试","现有草稿"]);
 evaluate(`navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException("denied","NotAllowedError");};
  $("#acVoiceRecord").click();`);
 await ready('$("#acVoiceStatus").textContent.startsWith("麦克风权限未开启")','microphone denial is reported without uploading');
 voiceCommand="从文件转写";
 evaluate(`selectOnly(voicedImage.id);
   const nodeVoiceFile=$("#ppVoiceFile");
   Object.defineProperty(nodeVoiceFile,"files",{configurable:true,value:[new File(["voice"],"recording.wav")]});
   $("#ppVoiceUpload").click();
   nodeVoiceFile.dispatchEvent(new Event("change"));`);
 await ready('node(voicedImage.id).data.prompt==="完整转写\\n从文件转写"','audio file transcribes into the selected node without microphone access');
 evaluate(`$("#ppVoiceUpload").click();
   selectOnly(voicedAudio.id);
   nodeVoiceFile.dispatchEvent(new Event("change"));`);
 equal(evaluate('[acVoiceActive,node(voicedAudio.id).data.prompt]'),[null,"停止"],'a file selection cannot move to a different node');
 voiceCommand=null;
 console.log('Live dictation passed: incremental drafts, final result, shared preference, cancelled response, interrupted recording and denied permission.');
 evaluate(`restore(${JSON.stringify(beforeNodeVoice)})`);
 console.log('Node dictation passed: video fields, keyboard recording, audio draft, undo and stale-response isolation.');
 delete w.MediaRecorder;
 delete w.navigator.mediaDevices;
 w.fetch=voicePointFetch;
 console.log('Voice pointing passed: hold gesture, pinned references, position markers, typed placement, cancellation and recoverable submission.');
 const approvalFetch=w.fetch, approvalDecisions=[];
 let approvalRequest, approvalPending=false, approvalRunState='done', finishApproval;
 let approvalMockId='approval-card', approvalPlan={kind:'image',count:2,unit_cost:.125,label:'海报草稿',prompt:'<img src=x> 保留产品配色',references:1,editable:{prompt:3000,count:4}};
 const approvalSid=evaluate('AC.session');
 w.fetch=async(url,options={})=>{
  const path=String(url).split('?')[0];
  if(path===`/api/chat/sessions/${approvalSid}/messages`){
   approvalRequest=JSON.parse(options.body);
   approvalPending=true;approvalRunState='waiting_approval';
   return {ok:true,json:async()=>({id:'approval-run',state:approvalRunState})};
  }
  if(path===`/api/chat/sessions/${approvalSid}`){
   const approvals=approvalPending?[{id:approvalMockId,run_id:'approval-run',name:'image_generate',plan:approvalPlan}]:[];
   return {ok:true,json:async()=>({runs:[{id:'approval-run',state:approvalRunState}],events:[],approvals})};
  }
  if(path===`/api/chat/runs/approval-run/approvals/${approvalMockId}`){
   const payload=JSON.parse(options.body);
   approvalDecisions.push(payload);
   if(payload.decision==='adjust'){
    approvalMockId='approval-revised';approvalPlan={...approvalPlan,...payload.parameters};
    return {ok:true,json:async()=>({ok:true,approval_id:approvalMockId})};
   }
   await new Promise(resolve=>{finishApproval=resolve;});
   approvalPending=false;approvalRunState='done';
   return {ok:true,json:async()=>({ok:true})};
  }
  return approvalFetch(url,options);
 };
 evaluate('$("#acGenerationMode").value="manual";$("#acGenerationMode").dispatchEvent(new Event("change"));$("#acInput").value="生成两张海报"');
 await evaluate('acSend()');
 await ready('!$("#acApprovals").hidden','the assistant displays a pending generation card');
 equal([approvalRequest.generation_mode,evaluate('localStorage.getItem("h3.chat.generationMode")')],['manual','manual']);
 assert.match(evaluate('$("#acApprovals").textContent'),/海报草稿.*2 张图片/s);
 assert.match(evaluate('$("#acApprovals").textContent'),/预计费用 ¥0\.25/);
 equal(evaluate('[$$("#acApprovals img").length,$("#acApprovals p").textContent,$("#acStatus").textContent]'),
  [0,'<img src=x> 保留产品配色','等待确认生成方案…']);
 evaluate(`const generationEditForm=$("[data-approval-edit]");
   generationEditForm.elements.prompt.value="两种暖色排版";
   generationEditForm.elements.count.value="3";
   generationEditForm.elements.count.dispatchEvent(new Event("input",{bubbles:true}));`);
 assert.equal(evaluate('$("[data-decision=approve]").disabled'),true);
 evaluate('generationEditForm.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');
 await ready('!!$("[data-approval-id=approval-revised]")','saved changes get a fresh confirmation card');
 assert.match(evaluate('$("#acApprovals").textContent'),/3 张图片.*两种暖色排版/s);
 assert.match(evaluate('$("#acApprovals").textContent'),/预计费用 ¥0\.375/);
 evaluate('$("[data-approval-id][data-decision=approve]").click();$("[data-approval-id][data-decision=skip]").click()');
 equal(approvalDecisions,[{decision:'adjust',parameters:{prompt:'两种暖色排版',count:3}},{decision:'approve'}]);
 assert.equal(evaluate('$("[data-approval-id][data-decision=approve]").disabled'),true);
 finishApproval();
 await ready('$("#acApprovals").hidden','a successful decision removes the pending card');
 w.fetch=approvalFetch;
 console.log('Assistant generation approval passed: preference snapshot, safe plan display, exclusive decision and confirmation handoff.');
 evaluate(`const previousApprovals=AC.approvals;
  const mixedApproval={id:"mixed-review",name:"video_generate",plan:{kind:"video",count:1,prompt:"拍摄",
    editable:{prompt:3000},reference_review:{duration:8,quality:"1080p",provider:"方舟",model:"Seedance 2.5",
      assets:["站台参考"],counts:[["图",1,30],["音频",1,10]],
      inputs:[{name:"<img src=x>",role:"subject"},{name:"站台环境声",role:"audio_ref",start:0,end:2}]}}};
  AC.approvals=[mixedApproval];acRenderApprovals();`);
 assert.match(evaluate('$("#acApprovals").textContent'),/8 秒.*1080p.*Seedance 2\.5/s);
 assert.match(evaluate('$("#acApprovals").textContent'),/站台环境声 · 音频 · 0–2 秒/);
 assert.equal(evaluate('$("#acApprovals img")'),null);
 evaluate(`mixedApproval.plan.reference_review=null;
  mixedApproval.plan.reference_pending=true;acRenderApprovals();
  const blockedForm=$("[data-approval-edit]");
  blockedForm.dispatchEvent(new Event("reset",{bubbles:true}));`);
 assert.equal(evaluate('$("[data-decision=approve]").disabled'),true);
 evaluate('AC.approvals=previousApprovals;acRenderApprovals()');
 console.log('Assistant mixed-media approval passed: exact model and inputs, safe labels and pending confirmation lock.');
 evaluate(`AC.approvals=[{id:"set-review",name:"image_generate_set",plan:{kind:"image",count:2,items:[
   {name:"远景",prompt:"站台",aspect:"auto",assets:["林森（标准主图）","车站 <img src=x>"]},
   {name:"特写",prompt:"头肩",aspect:"auto",assets:["林森（正面头肩）"]}]}}];acRenderApprovals();`);
 equal(evaluate('$$("#acApprovals .ac-approval-items li small").map(row=>row.textContent)'),
  ['参考资产 · 林森（标准主图）、车站 <img src=x>','参考资产 · 林森（正面头肩）']);
 assert.equal(evaluate('$("#acApprovals img")'),null);
 evaluate('AC.approvals=previousApprovals;acRenderApprovals()');
 evaluate(`AC.approvals=[{id:"image-review",name:"image_generate",plan:{kind:"image",count:1,reference_review:{
    assets:["林森（正面头肩）"],counts:[["图",2,9]],inputs:[{name:"画布参考",version:2},{name:"林森 · 正面头肩",role:"subject"}]}}}];
  acRenderApprovals();`);
 assert.match(evaluate('$("#acApprovals").textContent'),/画布参考 · 图片 · 版本 2.*林森 · 正面头肩.*林森（正面头肩）/s);
 evaluate('AC.approvals=previousApprovals;acRenderApprovals()');

 const fullscreenFetch=w.fetch;
 let fullscreenRequest;
 w.fetch=async(url,options={})=>{
  if(String(url)===`/api/chat/sessions/${approvalSid}/messages`){
   fullscreenRequest=JSON.parse(options.body);
   return {ok:true,json:async()=>({id:'fullscreen-run',state:'done'})};
  }
  return fullscreenFetch(url,options);
 };
 evaluate(`const previewChatPane=$("#agentChat"), previewWindowLayout=localStorage.getItem("h3.chat.window");
   AC.refs=[];AC.referencePins.clear();$("#acInput").value="比较这个版本的构图";
   switchVersion(previewImage,1);
   lightbox(previewImage.versions[0],previewImage);
   $("[data-light-agent]").click();`);
 await ready('document.activeElement===$("#acInput")','assistant opens and focuses within the preview');
 equal(evaluate(`[$("#light > #agentChat")===previewChatPane,$$("#agentChat").length,AC.session,
   $("#acInput").value,AC.referencePins.get(previewImage.id).ref,previewImage.cur]`),
  [true,1,approvalSid,'比较这个版本的构图','output:h3studio/preview-first.png',1]);
 evaluate('acStoreWindow();$("[data-light-version]").value="1";$("[data-light-version]").dispatchEvent(new Event("change"))');
 equal(evaluate(`[$("#light > #agentChat")===previewChatPane,document.activeElement===$("#acInput"),
   localStorage.getItem("h3.chat.window")===previewWindowLayout,AC.referencePins.get(previewImage.id).ref]`),
  [true,true,true,'output:h3studio/preview-first.png']);
 evaluate('$("#acInput").value="@预览音频";$("#acInput").setSelectionRange(5,5)');
 await evaluate('cmSuggest($("#acInput"))');
 assert.equal(evaluate('$("#light > #memoryMention [data-canvas-node]").dataset.canvasNode===previewAudio.id'),true);
 evaluate('$("#acInput").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');
 equal(evaluate('[$("#light").open,!!$("#light > #agentChat"),$("#memoryMention").hidden]'),[true,true,true]);
 evaluate('$("#acInput").value="比较这个版本的构图";$("#acInput").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');
 equal(evaluate('[$("#light").open,$("#agentChat").hidden,document.activeElement===$("[data-light-agent]")]'),[true,true,true]);
 evaluate('$("[data-light-agent]").click()');
 await ready('AC.referencePins.get(previewImage.id)?.ref===previewImage.versions[1].ref','explicitly reattaching updates the pinned version');
 evaluate(`const historicalMention=$("#acInput");
  historicalMention.value="@"+previewImage.id+"#1";
  historicalMention.setSelectionRange(historicalMention.value.length,historicalMention.value.length);`);
 await evaluate('cmSuggest(historicalMention)');
 equal(evaluate('CM.matches.map(item=>item.version)'),[1]);
 evaluate('historicalMention.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))');
 assert.match(evaluate('historicalMention.value'),/版本 1/);
 await ready('AC.referencePins.get(previewImage.id)?.ref===previewImage.versions[0].ref','historical completion pins the version for the assistant');
 await evaluate('acSend()');
 equal(fullscreenRequest.selected_versions,[{node_id:evaluate('previewImage.id'),ref:'output:h3studio/preview-first.png'}]);
 evaluate('$("#acInput").value="继续分析";closeLightbox()');
 equal(evaluate('[$("#light").open,previewChatPane.parentElement===document.body,!previewChatPane.hidden,$("#acInput").value]'),
  [false,true,true,'继续分析']);
 evaluate('const fullscreenAccess=B.access;B.access="reviewer";lightbox(previewImage.versions[0],previewImage)');
 assert.equal(evaluate('!!$("[data-light-agent]")'),false);
 evaluate('closeLightbox();B.access=fullscreenAccess;$("#acInput").value=""');
 evaluate('lightbox(previewImage.versions[0],previewImage);$("[data-light-agent]").click()');
 await ready('document.activeElement===$("#acInput")','assistant reopens inside the preview');
 await evaluate('acFocus([previewImage.id],true)');
 equal(evaluate('[$("#light").open,IMAGE_EDITOR?.n.id===previewImage.id,!$("#agentChat").hidden]'),[false,true,true]);
 evaluate('closeImageEditor()');
 w.fetch=fullscreenFetch;
 console.log('Fullscreen assistant passed: shared session and draft, explicit version pins, mention picker, keyboard and review permissions.');

 evaluate(`const assistantKey=(target,key,options={})=>target.dispatchEvent(new KeyboardEvent("keydown",
   {key,bubbles:true,cancelable:true,...options}));
   $("#acInput").value="保留键盘草稿";$("#acInput").focus()`);
 assert.equal(evaluate('assistantKey($("#acInput"),"/")'),true,'the slash works as text in the composer');
 equal(evaluate('[assistantKey($("#acInput"),"j",{metaKey:true}),$("#agentChat").hidden,document.activeElement.id]'),
  [false,true,'chatLaunch']);
 assert.equal(evaluate('assistantKey($("#chatLaunch"),"j",{ctrlKey:true,repeat:true})'),false);
 assert.equal(evaluate('$("#agentChat").hidden'),true,'holding the shortcut does not reopen the pane');
 evaluate('$("#acTaskCenterBtn").click()');
 assert.equal(evaluate('assistantKey($("[data-task-close]"),"/")'),true,'an open modal owns keyboard focus');
 assert.equal(evaluate('$("#agentChat").hidden'),true);
 evaluate('acCloseTaskCenter()');
 assert.equal(evaluate('assistantKey($("#prompt"),"/")'),true,'the node prompt retains its slash tools');
 assert.equal(evaluate('assistantKey($("#chatLaunch"),"/",{isComposing:true})'),true,'composition keeps its keystrokes');
 assert.equal(evaluate('assistantKey($("#chatLaunch"),"/")'),false);
 await ready('document.activeElement.id==="acInput"','canvas shortcut focuses the composer');
 equal(evaluate('[$("#acInput").value,AC.session]'),['保留键盘草稿',approvalSid]);
 evaluate('lightbox(previewImage.versions[0],previewImage);assistantKey($("[data-light-close]"),"j",{ctrlKey:true})');
 await ready('document.activeElement.id==="acInput"&&$("#agentChat").parentElement.id==="light"','toggle opens the assistant inside the preview');
 equal(evaluate('[$("#acInput").value,AC.referencePins.get(previewImage.id).ref]'),
  ['保留键盘草稿','output:h3studio/preview-first.png']);
 evaluate('assistantKey($("#acInput"),"j",{metaKey:true})');
 equal(evaluate('[$("#light").open,$("#agentChat").hidden,document.activeElement.hasAttribute("data-light-agent")]'),
  [true,true,true]);
 evaluate('assistantKey($("[data-light-agent]"),"a")');
 assert.equal(evaluate('$(".light-region-drawing")!==null&&$("#light").open'),true);
 evaluate('closeLightbox();assistantKey($("#chatLaunch"),"a")');
 equal(evaluate('[$("#canvasComments").hidden,document.activeElement.id]'),[false,'ccBody']);
 evaluate('$("#ccClose").click();AC.open=true;$("#agentChat").hidden=false;$("#chatLaunch").hidden=true');
 console.log('Assistant keyboard shortcuts passed: composition and modal isolation, preserved drafts, media version pins and annotation.');

 const retryFetch=w.fetch, retryRequests=[];
 let replyRetry=false;
 w.fetch=async(url,options={})=>{
  const path=String(url).split('?')[0];
  if(path===`/api/chat/sessions/${approvalSid}/calls/retry-demo/retry`){
   retryRequests.push(options.method);
   if(!replyRetry)return {ok:false,json:async()=>({error:'参考素材已丢失'})};
   return {ok:true,json:async()=>({id:'retry-new-run',state:'running'})};
  }
  return retryFetch(url,options);
 };
 evaluate(`AC.runs=[];AC.queue=[];$("#acInput").value="保留这条草稿";
   const failedBatch=[{kind:"tool_start",data:{call_id:"retry-demo",name:"image_generate"}},
     {kind:"tool_end",data:{call_id:"retry-demo",name:"image_generate",retry_count:2,
       result:{nodes:[],errors:["<b>模型错误</b>"]}}}];
   failedBatch.forEach(event=>acAppendEvent(event));acRenderState();`);
 equal(evaluate(`[$("[data-call=retry-demo]").open,$("[data-call=retry-demo] summary").textContent,
   $("[data-retry-call=retry-demo]").textContent,$$("[data-call=retry-demo] b").length]`),
  [true,'生成图片 · 部分失败','按原参数重试 2 个失败结果',0]);
 await evaluate('$("[data-retry-call=retry-demo]").onclick()');
 equal(evaluate('[$(".ac-retry [role=status]").textContent,$("[data-retry-call=retry-demo]").disabled]'),['参考素材已丢失',false]);
 replyRetry=true;
 await evaluate(`Promise.all([$("[data-retry-call=retry-demo]").onclick(),$("[data-retry-call=retry-demo]").onclick()])`);
 equal(retryRequests,['POST','POST']);
 equal(evaluate('[$("[data-retry-call=retry-demo]").disabled,$("[data-retry-call=retry-demo]").textContent,$("#acInput").value]'),
  [true,'已提交重试','保留这条草稿']);
 evaluate(`$("[data-call=retry-demo]").remove();failedBatch.forEach(event=>acAppendEvent(event,true));
   acAppendEvent({kind:"retry_queued",data:{call_id:"retry-demo"}},true);
   acAppendEvent({kind:"tool_start",data:{call_id:"retry-new",name:"image_generate",retry:true}},true);acRenderState();`);
 equal(evaluate('[$("[data-retry-call=retry-demo]").disabled,$("[data-call=retry-new] summary").textContent]'),
  [true,'重试 · 生成图片 · 执行中']);
 w.fetch=retryFetch;
 console.log('Assistant job retry passed: partial failure, recovery, duplicate clicks, replay and draft preservation.');

 const profileFetch=w.fetch, profileWrites=[], profileDecisions=[];
 let profileSettingsMock={personal:{text:'字幕用简体',revision:2},project:{id:'profile-project',name:'海报项目',text:'使用暖色',revision:1}};
 w.fetch=async(url,options={})=>{
  const path=String(url).split('?')[0];
  if(path==='/api/chat/profile'){
   if(options.method==='PUT'){
    const request=JSON.parse(options.body);
    profileWrites.push(request);
    for(const [scope,update] of Object.entries(request.changes)){
     profileSettingsMock[scope]={...profileSettingsMock[scope],text:update.text,revision:update.revision+1};
    }
   }
   return {ok:true,json:async()=>structuredClone(profileSettingsMock)};
  }
  if(path===`/api/chat/sessions/${approvalSid}/profile/profile-demo`){
   const payload=JSON.parse(options.body);
   profileDecisions.push(payload.decision);
   return {ok:true,json:async()=>payload};
  }
  return profileFetch(url,options);
 };
 const profileBoard=evaluate('boardId');
 await evaluate('$("#acProfile").onclick()');
 equal(evaluate('[$("#creativeProfile").open,$("#cpPersonal").value,$("#cpProject").value,$("#cpProjectName").textContent]'),
  [true,'字幕用简体','使用暖色','项目规则 · 海报项目']);
 evaluate('$("#cpPersonal").value="";$("#cpProject").value="保留已定稿人物参考"');
 await evaluate('$("#creativeProfile form").onsubmit({preventDefault(){},currentTarget:$("#creativeProfile form")})');
 equal(profileWrites,[{board:profileBoard,changes:{personal:{text:'',revision:2},project:{id:'profile-project',text:'保留已定稿人物参考',revision:1}}}]);
 assert.match(evaluate('$("#cpStatus").textContent'),/已保存/);
 evaluate('$("#cpClose").click()');
 profileSettingsMock.project=null;
 await evaluate('$("#acProfile").onclick()');
 assert.equal(evaluate('$("#cpProjectScope").hidden'),true);
 evaluate('$("#cpClose").click()');
 evaluate(`const memoryEvents=[{kind:"tool_start",data:{call_id:"profile-demo",name:"creative_profile_suggest"}},
   {kind:"tool_end",data:{call_id:"profile-demo",name:"creative_profile_suggest",
     result:{text:"等待确认",profile_suggestion:{id:"profile-demo",scope:"personal",text:"保留 <img src=x> 字样"}}}}];
   memoryEvents.forEach(event=>acAppendEvent(event));`);
 equal(evaluate('[$("[data-call=profile-demo] summary").textContent,$(".ac-profile-suggestion p").textContent,$$(".ac-profile-suggestion img").length]'),
  ['建议保存创作记忆 · 等待确认','保留 <img src=x> 字样',0]);
 await evaluate(`Promise.all([$("[data-profile-decision=save]").onclick(),$("[data-profile-decision=dismiss]").onclick()])`);
 equal(profileDecisions,['save']);
 equal(evaluate('[$("[data-profile-decision=save]").hidden,$(".ac-profile-suggestion [role=status]").textContent,$("#acInput").value]'),
  [true,'已保存到记忆','保留这条草稿']);
 evaluate(`$("[data-call=profile-demo]").remove();memoryEvents.forEach(event=>acAppendEvent(event,true));
   acAppendEvent({kind:"profile_decision",data:{id:"profile-demo",decision:"save"}},true);`);
 assert.equal(evaluate('$("[data-call=profile-demo] summary").textContent'),'建议保存创作记忆 · 已保存');
 await evaluate('$("#acProfile").onclick()');
 evaluate('$("#acClose").click()');
 equal(evaluate('[$("#creativeProfile").open,$("#agentChat").hidden]'),[false,true]);
 w.fetch=profileFetch;
 console.log('Assistant memory passed: scoped settings, clearing, safe suggestion display, explicit confirmation and replay.');

 const stemFetch=w.fetch;
 const stemRequests=[];
 const stems=['vocals','no_vocals'].map(stem=>({
  ref:'output:h3studio/stem-'+stem+'.wav',url:'/media?test='+stem,meta:{duration:2},extra:{stem}
 }));
 let stemStarted=false, finishedStems=false;
 w.fetch=async(url,options={})=>{
  const link=new URL(String(url),'http://oneshot.test');
  if(link.pathname==='/api/audio/separate'){
   if(options.method==='POST'){
    stemRequests.push(JSON.parse(options.body));
    stemStarted=true;
    return {ok:true,json:async()=>({id:'stems-qa',range:{start:1,end:3}})};
   }
   return {ok:true,json:async()=>({available:true,latest:stemStarted?{id:'stems-qa',range:{start:1,end:3}}:null})};
  }
  if(link.pathname==='/api/jobs' && link.searchParams.get('ids')==='stems-qa'){
   const state=finishedStems?{state:'done',outputs:stems}:{state:'running',phase:'sampling'};
   return {ok:true,json:async()=>({'stems-qa':state})};
  }
  return stemFetch(url,options);
 };
 evaluate(`const stemTestVideo=addNode("video",76000,76000,{}, {name:"分离原片",versions:[
   copyAsset("stem-video-old.mp4",{seconds:6}),copyAsset("stem-video-new.mp4",{seconds:7})],cur:1});
   lightbox(stemTestVideo.versions[0],stemTestVideo);$("[data-light-separate]").click();`);
 await ready('$("#audioSeparation").open&&!$("[data-stem-start]").disabled','stem dialog for historical video');
 assert.equal(evaluate('$("[data-stem-source]").textContent'),'分离原片 · 版本 1');
 evaluate('const stemForm=$("#audioSeparation form");stemForm.elements.start.value="1";stemForm.elements.end.value="3";stemForm.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));');
 await ready('$("#audioSeparation [role=status]").textContent==="正在分离人声"','background phase display');
 equal(stemRequests.map(({ref,start,end})=>[ref,start,end]),[['output:h3studio/stem-video-old.mp4',1,3]]);
 evaluate('closeAudioSeparation()');
 finishedStems=true;
 await evaluate('openAudioSeparation(stemTestVideo,stemTestVideo.versions[0])');
 equal(evaluate('[$$("[data-stem-results] audio").length,$$("[data-stem-results] a").map(x=>x.download),stemTestVideo.cur]'),
  [2,['人声.wav','伴奏与环境声.wav'],1]);
 evaluate('$("[data-stem-add]").click();$("[data-stem-add]").click()');
 equal(evaluate(`B.nodes.filter(n=>curV(n)?.audio_separation?.job==="stems-qa").map(n=>[n.type,curV(n).audio_separation.stem])`),
  [['audio','vocals'],['audio','no_vocals']]);
 equal(evaluate(`B.edges.filter(e=>e.from===stemTestVideo.id&&e.relation==="audio_separation").map(e=>e.source_ref)`),
  ['output:h3studio/stem-video-old.mp4','output:h3studio/stem-video-old.mp4']);
 evaluate('$("[data-stem-edit]").click()');
 equal(evaluate(`[FILM.target.ref,FILM.spec.clips.map(c=>[c.in,c.out,c.volume,c.tight]),
   FILM.spec.audio_clips.map(c=>[c.ref,c.start,c.out]),$("#audioSeparation").open]`),
  ['output:h3studio/stem-video-old.mp4',[[1,3,0,true]],stems.map(s=>[s.ref,0,2]),false]);
 evaluate('closeFilm()');
 w.fetch=stemFetch;
 console.log('Audio separation passed: historical version, background receipt recovery, duplicate-safe placement and aligned film tracks.');

 const parallelFetch=w.fetch, parallelCalls=[], scopedMessages=[], dashboardRemovals=[];
 const parallelSessions=[
  {id:'parallel-ui-a',title:'写分镜',run_state:'waiting_approval',active_task_id:'parallel-run-a',active_task_text:'画三个夜景镜头',
   queued_count:2,queued_tasks:[{id:'parallel-queue-a',text:'继续',position:4},{id:'parallel-queue-remove',text:'生成封面',position:5}],
   node_activity:{nodes:['n1'],calls:[]}},
  {id:'parallel-ui-b',title:'剪旁白',run_state:'thinking',active_task_id:'parallel-run-b',queued_count:0,node_activity:{nodes:[evaluate('stemTestVideo.id')],calls:['badge-pending']}},
  {id:'parallel-ui-ready',title:'导出海报',run_state:null,queued_count:0,recent_task:{id:'ready-run',state:'done',updated:7}},
 ];
 let releaseParallelPoll, holdParallel=false, parallelCreates=0, taskClock=10;
 w.fetch=async(url,options={})=>{
  const request=new URL(String(url),'http://oneshot.test');
  if(request.pathname==='/api/chat/task-history'){
   const older=request.searchParams.get('before')==='8';
   return {ok:true,json:async()=>older?{tasks:[
    {id:'history-older',session_id:'parallel-ui-old',title:'旧对话',state:'stopped',text:'整理第一版'}
   ],before:null}:{tasks:[
    {id:'ready-run',session_id:'parallel-ui-ready',title:'导出海报',state:'done',text:'保存海报'}
   ],before:8}};
  }
  if(request.pathname==='/api/chat/sessions'){
   if(options.method==='POST'){
    const session={id:'parallel-ui-'+['c','d','e','f'][parallelCreates++],title:'新对话',run_state:null,queued_count:0};
    parallelSessions.unshift(session);
    return {ok:true,json:async()=>({id:session.id})};
   }
   return {ok:true,json:async()=>({sessions:structuredClone(parallelSessions),task_snapshot_at:taskClock})};
  }
  if(request.pathname==='/api/chat/sessions/parallel-ui-e/messages'){
   scopedMessages.push(JSON.parse(options.body));
   return {ok:true,json:async()=>({id:'scope-run',state:'done'})};
  }
  if(request.pathname==='/api/chat/sessions/parallel-ui-old'){
   return {ok:true,json:async()=>({session:{id:'parallel-ui-old',title:'旧对话'},sessions:structuredClone(parallelSessions),runs:[],
    events:request.searchParams.get('after')==='0'?[{id:490,kind:'user',run_id:'history-older',data:{text:'整理第一版'}}]:[]})};
  }
  const match=request.pathname.match(/^\/api\/chat\/sessions\/(parallel-ui-(?:[abcdef]|ready))$/);
  if(match){
   const session=parallelSessions.find(s=>s.id===match[1]);
   const id=session.id.slice(-1);
   if(holdParallel&&id==='a'){
    holdParallel=false;
    await new Promise(resolve=>{releaseParallelPoll=resolve;});
   }
   return {ok:true,json:async()=>({
    session,sessions:structuredClone(parallelSessions),runs:session.run_state?[{id:'parallel-run-'+id,state:session.run_state}]:[],
    queue:structuredClone(session.queued_tasks||[]),
    approvals:session.run_state==="waiting_approval"?[{id:"task-center-approval",name:"image_generate",plan:{kind:"image",count:1}}]:[],
    events:request.searchParams.get('after')==='0'?[{id:820,kind:'assistant',run_id:session.recent_task?.id,
      data:{text:id==='y'?'海报已完成':'助手 '+id+' 的回复'}}]:[]
   })};
  }
  if(request.pathname==='/api/chat/runs/parallel-queue-remove/queue'&&options.method==='DELETE'){
   dashboardRemovals.push(request.pathname);
   parallelSessions[0].queued_tasks.pop();
   parallelSessions[0].queued_count--;
   return {ok:true,text:async()=>'{"ok":true}',json:async()=>({ok:true})};
  }
  if(request.pathname.startsWith('/api/chat/runs/parallel-run-')&&request.pathname.endsWith('/stop')){
   parallelCalls.push(request.pathname);
   parallelSessions.find(s=>s.id.endsWith(request.pathname.split('/')[4].slice(-1))).run_state=null;
   return {ok:true,json:async()=>({ok:true})};
  }
  return parallelFetch(url,options);
 };
 evaluate('AC.open=false;AC.board=null;$("#agentChat").hidden=true');
 await evaluate('acRefreshNodeDirectory()');
 assert.equal(evaluate('$("[data-node-agent-session=parallel-ui-a] span",els.get("n1")).textContent'),'待确认');
 equal(evaluate('[$("#agentChat").hidden,$("#acTaskCenterBtn").hidden,$("#acTaskCenterBtn [data-task-attention]").textContent]'),
   [true,false,"1 待处理"]);
 evaluate('$("#acTaskCenterBtn").click();$("#acTaskSound").click();$("#acTaskBadge").value="dot";$("#acTaskBadge").onchange()');
 await ready('AC.taskSoundSnapshot?.observedAt===10','sound starts from the current directory state');
 assert.deepEqual(taskNotes,[]);
 assert.equal(evaluate('$("[data-node-agent-session=parallel-ui-a] .ac-task-dot.needs-input").closest("button").getAttribute("aria-label")'),
  '查看任务 写分镜 · 待确认');
 evaluate('acCloseTaskCenter();$("#acTaskCenterBtn").click()');
 equal(evaluate('[$("#acTaskSound").checked,$("#acTaskBadge").value]'),[true,'dot']);
 await ready('!AC.nodeDirectoryRequest','reopened task center has refreshed its baseline');
 evaluate('acCloseTaskCenter()');
 Object.assign(parallelSessions[1],{run_state:'waiting_input',active_task_updated:11});
 taskClock=12;
 await evaluate('acRefreshNodeDirectory()');
 await ready('AC.taskSoundSnapshot.observedAt===12','the waiting state reaches the task directory');
 assert.deepEqual(taskNotes,[587,440]);
 await evaluate('acRefreshNodeDirectory()');
 assert.deepEqual(taskNotes,[587,440],'repeated observations do not replay the alert');
 Object.assign(parallelSessions[1],{run_state:'thinking',recent_task:{id:'sound-preview',state:'done',updated:13}});
 taskClock=14;
 await evaluate('acRefreshNodeDirectory()');
 assert.deepEqual(taskNotes,[587,440,523,659]);
 taskClock=12;
 await evaluate('acRefreshNodeDirectory()');
 assert.equal(evaluate('AC.taskSoundSnapshot.observedAt'),14,'an older response cannot replay alerts');
 evaluate('$("#acTaskCenterBtn").click();$("#acTaskSound").click();$("#acTaskBadge").value="label";$("#acTaskBadge").onchange();acCloseTaskCenter()');
 await ready('!AC.nodeDirectoryRequest','task center refresh has settled after disabling audio');
 parallelSessions[1].recent_task.updated=15;
 taskClock=16;
 await evaluate('acRefreshNodeDirectory()');
 assert.deepEqual(taskNotes,[587,440,523,659],'disabling audio silences subsequent changes');
 delete parallelSessions[1].recent_task;
 delete parallelSessions[1].active_task_updated;
 await evaluate('acRefreshNodeDirectory()');
 console.log('Assistant task preferences passed: opt-in alerts for new transitions, silence after disabling, and accessible compact markers.');
 evaluate('$("#acTaskCenterBtn").click()');
 equal(evaluate(`$$("#acTaskCenterRows section").map(section=>[$("h3",section).textContent,
   $$("[data-task-session]",section).map(button=>button.dataset.taskSession)])`),
   [["待处理",["parallel-ui-a"]],["执行中",["parallel-ui-b"]],["排队指令",["parallel-ui-a","parallel-ui-a"]],
    ["近期结果",["parallel-ui-ready"]]]);
 assert.equal(evaluate('$("[data-task-running]").textContent'),'1 执行中');
 assert.match(evaluate('$("[data-task-session=parallel-ui-a]").textContent'),/画三个夜景镜头/);
 evaluate('$("[data-task-queued=parallel-queue-remove]").click()');
 await ready('AC.session==="parallel-ui-a"&&document.activeElement.dataset.queuedTask==="parallel-queue-remove"',
  'an individual queued request opens its conversation and focuses the exact queue entry');
 await evaluate('acLoadSession("parallel-ui-b")');
 evaluate('$("#acTaskCenterBtn").click();$("[data-task-remove=parallel-queue-remove]").click()');
 await ready('!$("[data-task-queued=parallel-queue-remove]")&&!!$("[data-task-queued=parallel-queue-a]")',
  'removing a queued request leaves the other instruction in place');
 assert.deepEqual(dashboardRemovals,["/api/chat/runs/parallel-queue-remove/queue"]);
 equal(evaluate('[AC.session,$("[data-task-stop=parallel-run-a]").disabled]'),['parallel-ui-b',false]);
 console.log('Assistant task queue passed: running count, active prompt, exact queue focus and scoped queue removal.');
 evaluate('$("[data-task-session=parallel-ui-a]").click()');
 await ready('!$("#acTaskCenter").open&&AC.session==="parallel-ui-a"&&document.activeElement.id==="acApprovals"',
   'task center opens the correct waiting approval');
 evaluate('$("#acTaskCenterBtn").click();$("[data-task-locate=parallel-ui-b]").click()');
 await ready('AC.session==="parallel-ui-b"&&sel.has(stemTestVideo.id)','task center can locate an offscreen source node');
 assert.equal(evaluate('$("#acTaskCenter").open'),false);
 assert.equal(evaluate('$("[data-task-results]").textContent'),"1 新结果");
 evaluate('$("#acTaskCenterBtn").click();$("[data-task-result=ready-run]").click()');
 await ready('AC.session==="parallel-ui-ready"&&document.activeElement.dataset.taskRun==="ready-run"',
   'opening the finished task navigates to the exact result');
 equal(evaluate('[$("[data-task-results]").hidden,acTaskSeen().has("ready-run")]'),[true,true]);
 evaluate(`const reopenCompleted=()=>{$("#acTaskCenterBtn").click();$("[data-task-continue-run=ready-run]").click();};
  $("#acInput").value="继续原来的设计";reopenCompleted()`);
 await ready('!$("#acContinuation").hidden&&AC.session==="parallel-ui-ready"','continue in the completed task conversation');
 evaluate(`const continuationClick=(target,x,y)=>target.dispatchEvent(new MouseEvent("pointerdown",
  {bubbles:true,cancelable:true,button:0,clientX:x,clientY:y}));
  continuationClick($(".card",els.get("n1")),200,150)`);
 equal(evaluate('[$("#acContinuation").hidden,document.activeElement.id,$("#acInput").value,AC.referencePins.get("n1").ref===curV(node("n1")).ref]'),
  [true,'acInput','继续原来的设计',true]);
 evaluate('reopenCompleted()');
 await ready('!$("#acContinuation").hidden','completed task can be targeted again');
 evaluate(`const nextDropCoords=toW(300,200), transferredContinuation=new Map();
  const continuationData={setData:(type,value)=>transferredContinuation.set(type,value),
   getData:type=>transferredContinuation.get(type),get types(){return [...transferredContinuation.keys()];}};
  const continuationDrag=(target,type)=>{
   const event=new MouseEvent(type,{bubbles:true,cancelable:true,clientX:300,clientY:200});
   Object.defineProperty(event,"dataTransfer",{value:continuationData});return target.dispatchEvent(event);
  };
  continuationDrag($("#acContinuationDrag"),"dragstart");
  continuationDrag(vp,"dragover");
  continuationDrag(vp,"drop");`);
 equal(evaluate('[AC.session,$("#acContinuation").hidden,AC.placement,$("#acInput").value]'),
  ['parallel-ui-ready',true,JSON.parse(evaluate('JSON.stringify(acPlacementPoint(nextDropCoords))')),'继续原来的设计']);
 evaluate('reopenCompleted()');
 await ready('!$("#acContinuation").hidden','targeting mode can be cancelled');
 evaluate('$("#acContinuationCancel").click()');
 equal(evaluate('[$("#acContinuation").hidden,document.activeElement.id,$("#acInput").value]'),[true,'acInput','继续原来的设计']);
 console.log('Assistant continuation passed: same conversation and draft, exact version pin, drag placement and cancel.');
 parallelSessions.push({id:"parallel-ui-x",title:"测试配音",run_state:"running",active_task_id:"parallel-run-x",queued_count:1,
  active_task_text:"保留背景，只替换旁白",node_activity:{nodes:["n1"],calls:[]}});
 await evaluate('acRefreshNodeDirectory()');
 await evaluate('acStopTaskRow("parallel-ui-x","previous-run")');
 assert.equal(parallelCalls.length,0);
 evaluate('$("#acTaskCenterBtn").click();$("[data-task-stop=parallel-run-x]").click()');
 await ready('!$("[data-task-stop=parallel-run-x]")&&$("#acTaskCenter").open','scoped stop refreshes directly in the task center');
 assert.deepEqual(parallelCalls.splice(0),["/api/chat/runs/parallel-run-x/stop"]);
 equal(evaluate('[AC.session,acTaskDirectory().find(row=>row.id==="parallel-ui-x").queued_count]'),["parallel-ui-ready",1]);
 evaluate('acCloseTaskCenter()');
 Object.assign(parallelSessions.at(-1),{run_state:"running",active_task_id:"parallel-run-next-x"});
 await evaluate('acRefreshNodeDirectory()');
 evaluate('$("[data-node-agent-session=parallel-ui-x]",els.get("n1")).click()');
 equal(evaluate('[$("#acNodeTask").open,$("#acNodeTaskPrompt").textContent,$("#acNodeTaskStatus").textContent,AC.session]'),
  [true,"保留背景，只替换旁白","正在执行…","parallel-ui-ready"]);
 Object.assign(parallelSessions.at(-1),{active_task_id:"parallel-run-later-x",
  recent_task:{id:"parallel-run-next-x",state:"done",updated:23}});
 await evaluate('acRefreshNodeDirectory()');
 equal(evaluate('[$("#acNodeTaskStop").disabled,$("#acNodeTaskStatus").textContent]'),[true,"本轮已结束"]);
 evaluate('$("#acNodeTaskStop").click()');
 assert.deepEqual(parallelCalls,[],'the open node task card cannot stop its replacement run');
 evaluate('$("[data-node-task-close]").click();$("[data-node-agent-session=parallel-ui-x]",els.get("n1")).click();$("#acNodeTaskStop").click()');
 await ready('$("#acNodeTask").open&&$("#acNodeTaskStop").hidden','node task stop refreshes the selected run in place');
 assert.deepEqual(parallelCalls.splice(0),["/api/chat/runs/parallel-run-later-x/stop"]);
 equal(evaluate('AC.session'),"parallel-ui-ready");
 evaluate('acCloseNodeTask()');
 parallelSessions.pop();
 await evaluate('acRefreshNodeDirectory()');
 console.log('Assistant node task card passed: live instruction, exact-run stop and replacement-race protection.');
 console.log('Assistant task actions DOM passed: completion badge, exact result focus, read receipt and scoped stop.');
 console.log('Assistant task center DOM passed: closed-panel updates, grouping, approval focus and node location.');
 evaluate('$("#acTaskCenterBtn").click()');
 await evaluate('$("#acTaskHistoryMore").onclick()');
 equal(evaluate('[$("#acTaskHistoryRows strong").textContent,$("#acTaskHistoryMore").textContent]'),
  ['保存海报','加载更早的任务']);
 await evaluate('$("#acTaskHistoryMore").onclick()');
 equal(evaluate('[$$("#acTaskHistoryRows strong").map(node=>node.textContent),$("#acTaskHistoryMore").hidden]'),
  [['保存海报','整理第一版'],true]);
 evaluate('$("#acTaskHistoryRows [data-task-result=history-older]").click()');
 await ready('AC.session==="parallel-ui-old"&&document.activeElement.dataset.taskRequest==="history-older"',
  'task history opens an older session and focuses the originating request if the run produced no output');
 console.log('Assistant task history passed: pagination and navigation outside the session directory.');
 evaluate('AC.open=true;AC.board=boardId;$("#agentChat").hidden=false');
 await evaluate('acLoadSession("parallel-ui-a")');
 equal(evaluate(`[$("#acNew").disabled,$("#acParallel").hidden,$$("[data-parallel-session]").map(b=>[...b.children].map(e=>e.textContent))]`),
  [false,false,[['写分镜','等待确认生成方案 · 排队 1'],['剪旁白','正在理解与规划']]]);
 equal(evaluate(`[$("[data-node-agent-session=parallel-ui-a] span",els.get("n1")).textContent,
   $("[data-node-agent-session=parallel-ui-b] span",els.get(stemTestVideo.id)).textContent]`),['待确认','规划中']);
 evaluate('const oldNodeJob=node("n1").job;node("n1").job={agent_call:"badge-pending"};acRenderNodeActivity()');
 assert.ok(evaluate('$("[data-node-agent-session=parallel-ui-b]",els.get("n1"))'));
 evaluate('node("n1").job=oldNodeJob;acRenderNodeActivity()');
 evaluate('$("#acInput").value="甲的草稿";AC.refs=[];AC.referencePins.clear();acAttachNodeReference(stemTestVideo,stemTestVideo.versions[0].ref)');
 holdParallel=true;
 const oldParallelPoll=evaluate('acPoll()');
 await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(typeof releaseParallelPoll,'function');
 evaluate('$("[data-node-agent-session=parallel-ui-b]",els.get(stemTestVideo.id)).click();$("#acNodeTaskOpen").click()');
 await ready('AC.session==="parallel-ui-b"&&$("#acMessages").textContent.includes("助手 b")','second session loads before an older poll returns');
 releaseParallelPoll();
 await oldParallelPoll;
 equal(evaluate('[$("#acInput").value,AC.referencePins.size,$("#acMessages").textContent.includes("助手 a")]'),['',0,false]);
 evaluate('$("#acInput").value="乙的草稿"');
 await evaluate('$("#acStop").onclick()');
 equal(parallelCalls,['/api/chat/runs/parallel-run-b/stop']);
 assert.equal(evaluate('!!$("[data-node-agent-session=parallel-ui-b]")'),false);
 await evaluate('acLoadSession("parallel-ui-a")');
 equal(evaluate('[$("#acInput").value,AC.referencePins.get(stemTestVideo.id).ref,acActive().state]'),
  ['甲的草稿','output:h3studio/stem-video-old.mp4','waiting_approval']);
 await evaluate('$("#acNew").onclick()');
 equal(evaluate('[AC.session,$("#acInput").value,$("#acParallel").hidden]'),['parallel-ui-c','',false]);
 await evaluate('acLoadSession("parallel-ui-b")');
 assert.equal(evaluate('$("#acInput").value'),'乙的草稿');
 evaluate('acAttachNodeReference(stemTestVideo,stemTestVideo.versions[0].ref);$("#creativeAppsBtn").click()');
 assert.equal(evaluate('$("#creativeApps").open'),true);
 evaluate('$("#creativeApps [data-app-category]").value="视频";$("#creativeApps [data-app-category]").dispatchEvent(new Event("change"))');
 equal(evaluate(' $$("#creativeApps [data-app-list] button").map(button=>button.dataset.appId)'),['previs','broll','loop-gif','remake']);
 evaluate('$("#creativeApps [data-app-id=broll]").click()');
 assert.equal(evaluate('$("#creativeApps video").getAttribute("src")'),'/static/creative-examples/broll.mp4');
 await evaluate('$("#creativeApps [data-app-example]").onclick()');
 equal(evaluate('[AC.session,AC.referencePins.get(stemTestVideo.id).ref,$("#creativeApps").open]'),['parallel-ui-b','output:h3studio/stem-video-old.mp4',false]);
 assert.match(evaluate('$("#acInput").value'),/^乙的草稿\n\n创作任务 · 动态字幕与图表/);
 assert.match(evaluate('$("#acInput").value'),/三月 10，四月 20，五月 30/);
 evaluate(`$("#creativeAppsBtn").click();
  $('[data-app-id="broll"]',$("#creativeApps")).click();
  $('[name="app-0"]',$("#creativeApps")).value="结尾显示订单增长";
  $('[name="app-1"]',$("#creativeApps")).value="保留原声";
  $("[data-app-source]",$("#creativeApps")).value=stemTestVideo.id;
  $("[data-app-source]",$("#creativeApps")).dispatchEvent(new Event("change"));`);
 await evaluate('$("[data-app-workspace]",$("#creativeApps")).onclick()');
 equal(evaluate(`[$("#brollDialog").open,brollSession.ref,stemTestVideo.cur,$("#brollDialog [name=brief]").value]`),
  [true,'output:h3studio/stem-video-old.mp4',1,'画面内容和图表数据 · 结尾显示订单增长\n显示时段和样式 · 保留原声'],
  'opening the native workspace carries the form brief and uses the pinned historical media without switching tabs');
 evaluate('closeBroll()');
 evaluate('$("#creativeAppsBtn").click();$("#creativeApps [data-app-id=loop-gif]").click()');
 await evaluate('$("#creativeApps [data-app-example]").onclick()');
 const gifAppDraft=evaluate('$("#acInput").value');
 assert.ok(gifAppDraft.includes("创作任务 · 循环动图") && gifAppDraft.includes("再导出 GIF"));
 assert.equal(evaluate('AC.referencePins.get(stemTestVideo.id).ref'),'output:h3studio/stem-video-old.mp4');
 const appPreviewFetch=w.fetch;
 w.fetch=(url,options)=>{
  const path=new URL(String(url),'http://oneshot.test').pathname;
  const row={id:'starter-storyboard',name:'三镜头分镜模板',category:'分镜',builtin:true,nodes:2};
  const result=path==='/api/canvas-templates/presets'?[row]:path==='/api/canvas-templates/starter-storyboard/preview'?
   {name:row.name,nodes:[{id:'n1',name:'故事简报',type:'text',inputs:{text:'旧故事'}},
    {id:'n2',name:'分镜',type:'script',inputs:{prompt:'',nshots:'3',shotlen:'5',aspect:'16:9'}}],edges:[]}:null;
  return result?Promise.resolve({ok:true,json:async()=>result}):appPreviewFetch(url,options);
 };
 const appBoardNodes=evaluate('B.nodes.length');
 evaluate(`$("#creativeAppsBtn").click();
  $('[name="app-0"]',$("#creativeApps")).value="深夜末班列车";
  $('[name="app-1"]',$("#creativeApps")).value="20 秒，5 镜";
  $('[name="app-2"]',$("#creativeApps")).value="9:16，纪实风";`);
 await evaluate('$("[data-app-template]",$("#creativeApps")).onclick()');
 assert.match(evaluate('$("[data-field=text]",$("#templatePreview")).value'),/深夜末班列车[\s\S]*20 秒，5 镜/);
 equal(evaluate(`[$("[data-field=nshots]",$("#templatePreview")).value,$("[data-field=shotlen]",$("#templatePreview")).value,
  $("[data-field=aspect]",$("#templatePreview")).value,B.nodes.length,$("#templatePreview .template-inputs").open]`),
  ['auto','auto','9:16',appBoardNodes,true],'template launch pre-fills only the editable copy preview, including script controls');
 equal(evaluate('templateCopyPayload($("[data-template-action=insert]",$("#templatePreview"))).inputs.map(input=>[input.node,input.field,input.before]).slice(-3)'),
  [['n2','nshots','3'],['n2','shotlen','5'],['n2','aspect','16:9']]);
 evaluate('closeWorkflowTemplates()');
 w.fetch=appPreviewFetch;
 console.log('Creative apps passed: category, example and insertion preserve the running session, draft and pinned version.');
 console.log('Creative app launch DOM passed: prefilled templates and historical-version workspace handoff.');
 evaluate(`const previousAgentDraft=$("#acInput").value, liveStemVersion=stemTestVideo.cur;
   vtTabMenu(stemTestVideo,0,70,100);`);
 await evaluate('$("[data-version-new-session]").onclick()');
 equal(evaluate(`[AC.session,$("#acInput").value,AC.refs,AC.referencePins.get(stemTestVideo.id).ref,stemTestVideo.cur===liveStemVersion]`),
  ['parallel-ui-d','',[evaluate('stemTestVideo.id')],'output:h3studio/stem-video-old.mp4',true],
  'opening a new conversation from a historical version preserves the visible version and pins the selected source');
 await evaluate('acLoadSession("parallel-ui-b")');
 assert.equal(evaluate('$("#acInput").value===previousAgentDraft'),true);
 evaluate(`sel=new Set(["n1",stemTestVideo.id]);updateSel();
   ctxMenu({target:els.get(stemTestVideo.id),clientX:80,clientY:110});$("#ctxMenu [data-a=agent-new]").click();`);
 await ready('AC.session==="parallel-ui-e"&&AC.refs?.length===2','context menu opens a separate conversation with the full selection');
 equal(evaluate('[AC.refs,AC.referencePins.get(stemTestVideo.id).ref,$("#acInput").value]'),
  [['n1',evaluate('stemTestVideo.id')],evaluate('curV(stemTestVideo).ref'),'']);
 assert.equal(parallelCreates,3);
 evaluate(`$("#acExecutionScope").value="plan";$("#acExecutionScope").dispatchEvent(new Event("change"));
   $("#acInput").value="给我一个方案";`);
 assert.equal(evaluate('$("#acGenerationMode").disabled'),true);
 await evaluate('acSend()');
 assert.equal(scopedMessages[0].execution_scope,'plan');
 assert.equal(scopedMessages[0].generation_mode,undefined);
 await evaluate('acLoadSession("parallel-ui-b")');
 assert.equal(evaluate('$("#acExecutionScope").value'),'full');
 await evaluate('acLoadSession("parallel-ui-e")');
 assert.equal(evaluate('$("#acExecutionScope").value'),'plan');
 evaluate(`$("#acExecutionScope").value="brainstorm";$("#acExecutionScope").dispatchEvent(new Event("change"));
  const directionIds=["雨夜悬疑","站台重逢","误车喜剧"];
  acAppendEvent({kind:"tool_start",data:{name:"creative_directions",call_id:"idea-comparison"}});
  acAppendEvent({kind:"tool_end",data:{name:"creative_directions",call_id:"idea-comparison",result:{creative_directions:directionIds.map(title=>(
   {title,premise:"<img onerror=alert(1)> 空站台",approach:"试写场景",tradeoff:"需要夜景素材",first_step:"五秒开场"}))}}});
  const ideaCard=$("[data-call=idea-comparison]");`);
 equal(evaluate('[ideaCard.open,$$(".ac-direction",ideaCard).length,!!$("img",ideaCard),$("#acGenerationMode").disabled]'),
  [true,3,false,true],'brainstorm displays comparison cards as text and disables generation settings');
 evaluate(`$("#acInput").value="以及保留现有主角";
  $$("[data-explore-direction]",ideaCard)[1].click();`);
 assert.match(evaluate('$("#acInput").value'),/^以及保留现有主角\n\n继续讨论「站台重逢」/);
 assert.equal(scopedMessages.length,1,'choosing a direction populates the draft without sending it');
 await evaluate('acSend()');
 assert.equal(scopedMessages[1].execution_scope,'brainstorm');
 assert.equal(scopedMessages[1].generation_mode,undefined);
 evaluate(`acAttachNodeReference(stemTestVideo,stemTestVideo.versions[0].ref);
  $("#acInput").value="先控制在十五秒";
  $$("[data-plan-direction]",ideaCard)[0].click();`);
 assert.equal(evaluate('$("#acExecutionScope").value'),'plan');
 assert.match(evaluate('$("#acInput").value'),/^先控制在十五秒\n\n把「雨夜悬疑」拟成制作方案[\s\S]*需要夜景素材[\s\S]*五秒开场/);
 assert.equal(scopedMessages.length,2,'planning loads the selected direction without submitting it');
 await evaluate('acSend()');
 assert.equal(scopedMessages[2].execution_scope,'plan');
 assert.equal(scopedMessages[2].generation_mode,undefined);
 assert(scopedMessages[2].selected_versions.some(item=>item.ref==='output:h3studio/stem-video-old.mp4'));
 console.log('Brainstorm assistant passed: comparison cards, scoped discussion and planning, pinned references and draft preservation.');
 evaluate(`const blankStarts=["image","video","audio"].map(type=>addNode(type,2400,1000,{prompt:"夜景草稿"}));
  const startButton=(n,action)=>$('[data-node-start="'+action+'"]',els.get(n.id));
  startButton(blankStarts[0],"prompt").click()`);
 equal(evaluate('[blankStarts.map(n=>!!startButton(n,"agent")),document.activeElement.id,sel.has(blankStarts[0].id)]'),
  [[true,true,true],'prompt',true]);
 evaluate('startButton(blankStarts[0],"agent").click()');
 await ready('AC.session==="parallel-ui-f"&&AC.refs?.[0]===blankStarts[0].id','empty node assistant opens with the selected target');
 equal(evaluate('[$("#acInput").value,document.activeElement.id,AC.referencePins.size]'),['夜景草稿','acInput',0]);
 equal(evaluate('[acComposeMessage().payload.empty_media_node,$("#acRefs").textContent.includes("接收生成结果")]'),
  [evaluate('blankStarts[0].id'),true]);
 assert.equal(scopedMessages.length,3,'opening the assistant does not submit the draft');
 evaluate('removeNodes(blankStarts.map(n=>n.id))');
 console.log('Empty media node starts passed: prompt focus, separate assistant conversation and preserved node draft.');
 w.fetch=parallelFetch;
 console.log('Parallel assistant passed: live switcher, late-poll isolation, session drafts, new chat during approval and scoped stop.');

 const gridFetch=w.fetch, gridCalls=[];
 w.fetch=async(url,options={})=>{
  if(String(url)==='/api/generate'){
   gridCalls.push(JSON.parse(options.body));
   const ref='output:h3studio/grid-shortcut.png';
   jobs.set('shortcut-grid-job',{state:'done',outputs:[{ref,url:'/media?ref='+encodeURIComponent(ref),meta:{width:900,height:600}}]});
   return {ok:true,text:async()=>JSON.stringify({ids:['shortcut-grid-job']})};
  }
  if(String(url)==='/api/split'){
   gridCalls.push(JSON.parse(options.body));
   const tiles=Array.from({length:9},(_,i)=>({...evaluate('copyAsset("shortcut-tile.png")'),row:Math.floor(i/3),col:i%3,w:300,h:200}));
   return {ok:true,text:async()=>JSON.stringify({tiles})};
  }
  return gridFetch(url,options);
 };
 evaluate('const gridFixture=snap();const gridBase=addNode("image",0,800,{},{versions:[copyAsset("shortcut-ref.png")],cur:0});const gridTarget=addNode("image",440,800,{aspect:"3:4",seed:912});selectOnly(gridTarget.id)');
 evaluate('const shortcutInput=$("#prompt");shortcutInput.focus();shortcutInput.value="/";shortcutInput.setSelectionRange(1,1);shortcutInput.dispatchEvent(new InputEvent("input",{inputType:"insertText",data:"/",bubbles:true}))');
 assert.equal(evaluate('$("#slash-grid9").disabled'),true);
 evaluate('shortcutInput.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));link(gridBase,gridTarget,true);const gridOther=addNode("image",0,1150,{},{versions:[copyAsset("shortcut-ref-extra.png")],cur:0});link(gridOther,gridTarget,true);');
 evaluate('shortcutInput.value="原创草稿\\n/";shortcutInput.setSelectionRange(shortcutInput.value.length,shortcutInput.value.length);shortcutInput.dispatchEvent(new InputEvent("input",{inputType:"insertText",data:"/",bubbles:true}));');
 evaluate('shortcutInput.setRangeText("grid9",shortcutInput.selectionStart,shortcutInput.selectionEnd,"end");shortcutInput.dispatchEvent(new InputEvent("input",{inputType:"insertText",data:"grid9",bubbles:true}))');
 equal(evaluate('[$$("#slashMenu button").length,shortcutInput.getAttribute("aria-activedescendant")]'),[1,"slash-grid9"]);
 evaluate('shortcutInput.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",bubbles:true,cancelable:true}))');
 await ready('gridTarget.versions.length===1 && !gridTarget.job','grid shortcut generation completes',300);
 assert.match(gridCalls[0].prompt,/左前中景/);
 equal([gridCalls[0].ar,gridCalls[0].seed,gridCalls[0].images.map(image=>image.ref)],[.75,912,["output:h3studio/shortcut-ref.png"]]);
 equal(evaluate('[gridTarget.data.prompt,curV(gridTarget).image_grid,curV(gridTarget).input_edges.length]'),['原创草稿\n',true,1]);
 evaluate('$("[data-a=split3x3]",$("#ntools")).click()');
 await ready('B.nodes.some(n=>n.name.endsWith("主体细节特写"))','grid tiles appear',150);
 equal(gridCalls[1],{ref:"output:h3studio/grid-shortcut.png",rows:3,cols:3});
 equal(evaluate('Array.from(sel,id=>node(id).name.split(" · ").at(-1))'),Array.from(evaluate('GRID9_ANGLES')));
 evaluate('restore(gridFixture)');
 w.fetch=gridFetch;
 console.log('Image shortcuts passed: required reference, filtering, Tab activation, preserved draft and ordered grid splits.');
 const historyFetch=w.fetch;
 const recoveryItems=[
  {id:'qa-history-image',type:'image',label:'找回海报',width:480,height:800,seed:24,ref:'output:h3studio/recovery-image.png',source:'edit',
   image_edit:{source:'input:h3studio/recovery-source.png',recipe:{ref:'input:h3studio/recovery-source.png',mode:'whole',relight:{depth:-75}},
    layer:{ref:'output:h3studio/recovery-layer.png',w:480,h:800}}},
  {id:'qa-history-video',type:'video',label:'找回镜头',width:640,height:360,seconds:3,ref:'output:h3studio/recovery-video.mp4'},
  {id:'qa-history-audio',type:'audio',label:'找回旁白',seconds:4,ref:'output:h3studio/recovery-audio.wav'},
 ].map(item=>({...item,available:true,url:'/media?ref='+encodeURIComponent(item.ref)}));
 w.fetch=async(url,options)=>{
  const path=new URL(String(url),'http://oneshot.test');
  if(path.pathname!=='/api/generation-history')return historyFetch(url,options);
  const items=recoveryItems.filter(item=>['all',item.type].includes(path.searchParams.get('kind')));
  return {ok:true,json:async()=>({items, next:null})};
 };
 evaluate('ghOpen();const historyCanvasSize=B.nodes.length;');
 await ready('ghCards().length===3','history restores usable results');
 evaluate(`const historyKind=kind=>{const picker=gh("[data-gh-kind]");picker.value=kind;picker.dispatchEvent(new Event("change"));};
  historyKind("image");`);
 await ready('ghCards().length===1 && ghCards()[0]._historyItem.type==="image"','history image filter loads');
 assert.match(evaluate('ghCards()[0].textContent'),/可复用编辑参数和图层/);
 evaluate('gh("[data-gh-select-visible]").click();historyKind("video");');
 await ready('ghCards().length===1 && ghCards()[0]._historyItem.type==="video"','history video filter loads');
 equal(evaluate('gh("[data-gh-count]").textContent'),'已选 1 · 筛选外 1','selection survives media filters');
 evaluate('gh("[data-gh-select-visible]").click();historyKind("audio");');
 await ready('ghCards().length===1 && ghCards()[0]._historyItem.type==="audio"','history audio filter loads');
 evaluate('gh("[data-gh-select-visible]").click();gh("[data-gh-apply]").click();');
 equal(evaluate('B.nodes.slice(-3).map(n=>[n.type,n.versions[0].seed??null,n.versions[0].seconds??null])'),
  [['image',24,null],['video',null,3],['audio',null,4]],'mixed history restore keeps generation settings and media metadata');
 equal(evaluate('curV(B.nodes.at(-3)).edit'),recoveryItems[0].image_edit,'restored image keeps both its lighting recipe and editable layer');
 evaluate('undo()');
 equal(evaluate('B.nodes.length'),evaluate('historyCanvasSize'),'mixed history restore uses one undo step');
 const recoveredSound=recoveryItems[2];
 recoveredSound.audio_recipe={mode:'seed_audio',prompt:'跟随 @音频2',references:[
  {node_id:'prior-voice',ref:'output:h3studio/recovery-ref-a.wav',kind:'audio'},
  {node_id:'removed-voice',ref:'output:h3studio/recovery-ref-b.wav',kind:'audio'},
 ]};
 evaluate(`const reusableHistoryVoice=addNode("audio",700,850,{}, {versions:[
  {ref:"output:h3studio/recovery-ref-a.wav",url:"/media?ref=output:h3studio/recovery-ref-a.wav"},
  {ref:"output:h3studio/new-voice.wav",url:"/media?ref=output:h3studio/new-voice.wav"}],cur:1});
  const seedHistorySize=B.nodes.length;ghOpen();historyKind("audio");`);
 await ready('ghCards().length===1 && ghCards()[0]._historyItem.audio_recipe?.mode==="seed_audio"','history lists a reference generation');
 evaluate('$(".gh-card-actions [data-gh-card-apply]",ghCards()[0]).click()');
 equal(evaluate(`[B.nodes.length-seedHistorySize,reusableHistoryVoice.cur,sel.size,
  B.edges.filter(e=>e.relation==="seed_audio_ref"&&sel.has(e.to)).map(e=>[e.ref,e.from===reusableHistoryVoice.id]),
  curV(node([...sel][0])).audio_recipe.references.map(r=>r.ref)]`),
 [2,1,1,[['output:h3studio/recovery-ref-a.wav',true],['output:h3studio/recovery-ref-b.wav',false]],
  ['output:h3studio/recovery-ref-a.wav','output:h3studio/recovery-ref-b.wav']],
 'history restores both reference pins, reusing an existing version and creating just one missing source');
 evaluate('undo()');
 equal(evaluate('B.nodes.length'),evaluate('seedHistorySize'),'restoring history with inputs uses one undo step');
 w.fetch=historyFetch;
 evaluate(`const historySearchNode=addNode("image",420,80,{}, {name:"重复名称",versions:[
  {ref:"output:h3studio/search-old.png",url:"/media?ref=output%3Ah3studio%2Fsearch-old.png",prompt:"旧版港口灯光"},
  {ref:"output:h3studio/search-new.png",url:"/media?ref=output%3Ah3studio%2Fsearch-new.png",prompt:"当前空白站台"}],cur:1});
  const nsGroup=ctNewGroup("验收镜头组",[historySearchNode.id,"n1"]);ctSetFold(nsGroup,true);
  document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"f",ctrlKey:true,bubbles:true,cancelable:true}));
  const historySearchInput=$("#nodeSearch input[type=search]");
  const searchFor=value=>{historySearchInput.value=value;historySearchInput.dispatchEvent(new Event("input",{bubbles:true}));};
  searchFor("旧版港口灯光");`);
 assert.equal(evaluate('$("#nodeSearch").open'),true,'Ctrl+F opens application search');
 assert.match(evaluate('$("#nodeSearch ol").textContent'),/匹配版本 1/);
 evaluate('$("#nodeSearch .ns-preview").click()');
 equal(evaluate('[$("#light img").getAttribute("src"),historySearchNode.cur]'),
   ['/media?ref=output%3Ah3studio%2Fsearch-old.png',1],'history search previews the exact matching version');
 evaluate(`closeLightbox();$("#nodeSearchBtn").click();searchFor("验收镜头组");
  $$(".ns-filters button").find(x=>x.textContent.startsWith("分组")).click();
  historySearchInput.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true,cancelable:true}));`);
 assert.match(evaluate('document.activeElement.textContent'),/验收镜头组/);
 evaluate('document.activeElement.click()');
 equal(evaluate('[nsGroup.collapsed,CT_GROUPS.get(nsGroup.id).classList.contains("ns-located")]'),[true,true],
   'group search locates the folded group without expanding it');
 evaluate(`const exportLayerNode=addNode("image",320,120,{}, {name:"分层测试",versions:[
  {...copyAsset("layer-composite.png"),layer_stack:{base_ref:"output:h3studio/layer-composite.png",layers:[
   {id:"base",name:"主体",ref:"output:h3studio/layer-smoke.png",x:8,y:12,w:200,h:160,opacity:.5,visible:true}]}},
  copyAsset("layer-other-version.png")],cur:0});`);
 await evaluate('openImageEditor(exportLayerNode)');
 await ready('!!IMAGE_EDITOR?.image && !IMAGE_EDITOR.loading && !IMAGE_EDITOR.restoring','layered source is open');
 evaluate(`ieMode("layers");
  $('#ieLayerList [data-layer="base"] button').click();
  const exportLayerAccess=B.access, exportLayerStack=JSON.stringify(IMAGE_EDITOR.layers),
   exportLayerSource=curV(node(exportLayerNode.id)).ref, exportLayerRef="output:h3studio/layer-smoke.png";
  B.access="reviewer";ieSync();`);
 assert(w.document.getElementById('ieExportLayer').disabled,'reviewers cannot create a layer node');
 evaluate('B.access=exportLayerAccess;ieSync();$("#ieExportLayer").click()');
 await ready('!!IMAGE_EDITOR?.layerExportIds?.length && !IMAGE_EDITOR.busy','selected layer is available on the canvas');
 equal(evaluate(`[curV(node(IMAGE_EDITOR.layerExportIds[0])).ref,curV(node(exportLayerNode.id)).ref,
  JSON.stringify(IMAGE_EDITOR.layers)===exportLayerStack]`),
 [evaluate('exportLayerRef'),evaluate('exportLayerSource'),true],'layer export reuses its own media and preserves the source stack');
 evaluate('const exportedLayerId=IMAGE_EDITOR.layerExportIds[0];$("#ieLocateLayer").click()');
 assert(evaluate('!IMAGE_EDITOR && sel.has(exportedLayerId)'),'locating the export selects its canvas node');
 evaluate('undo()');
 assert(evaluate('!node(exportedLayerId) && curV(node(exportLayerNode.id)).ref===exportLayerSource'),'one undo removes only the layer node');
 console.log('Layer reuse passed: permissions, independent media reference, source stack, locate and undo.');

 evaluate(`const batchLayerNode=addNode("image",480,160,{}, {name:"物件拆分",versions:[{
  ...copyAsset("batch-layer-composite.png", {w:512,h:384}),layer_stack:{layers:[
   {id:"object-0",name:"背景",ref:"output:h3studio/batch-layer-background.png",x:0,y:0,w:512,h:384,opacity:1,visible:true},
   {id:"object-1",name:"灯",ref:"output:h3studio/batch-layer-light.png",x:24,y:40,w:200,h:300,opacity:1,visible:true},
   {id:"object-2",name:"花瓶",ref:"output:h3studio/batch-layer-vase.png",x:210,y:220,w:60,h:120,opacity:.6,visible:false},
   {id:"object-3",name:"桌子",ref:"output:h3studio/batch-layer-table.png",x:0,y:160,w:430,h:160,opacity:1,visible:true}
  ]}}],cur:0});`);
 await evaluate('openImageEditor(batchLayerNode)');
 evaluate('ieMode("layers")');
 const layerDownloadFetch=w.fetch, layerDownloadURL=w.URL.createObjectURL, layerRevokeURL=w.URL.revokeObjectURL;
 const layerAnchorClick=w.HTMLAnchorElement.prototype.click;
 let layerDownloadRequest, layerDownloadName;
 w.URL.createObjectURL=()=> 'blob:layer-download';
 w.URL.revokeObjectURL=()=>{};
 w.HTMLAnchorElement.prototype.click=function(){layerDownloadName=this.download;};
 w.fetch=async(url,options)=>{
  if(String(url)!=='/api/image-edit/openraster')return layerDownloadFetch(url,options);
  layerDownloadRequest=JSON.parse(options.body);
  return {ok:true,headers:new Headers({"Content-Disposition":"attachment; filename*=UTF-8''"+encodeURIComponent("物件拆分.ora")}),
   blob:async()=>new w.Blob(['openraster'],{type:'image/openraster'})};
 };
 await evaluate('$("#ieDownloadLayers").onclick()');
 assert.equal(layerDownloadName,'物件拆分.ora');
 assert.equal(layerDownloadRequest.layers.length,4,'the editable file includes hidden layers and the background');
 assert.equal(layerDownloadRequest.layers[2].visible,false);
 assert.equal(layerDownloadRequest.layers[2].opacity,.6);
 w.fetch=layerDownloadFetch;
 w.URL.createObjectURL=layerDownloadURL;
 w.URL.revokeObjectURL=layerRevokeURL || (()=>{});
 w.HTMLAnchorElement.prototype.click=layerAnchorClick;
 evaluate('$("#ieOpenLayerBatch").click()');
 equal(evaluate('$$("#ieLayerBatchList input:checked").map(input=>input.value)'),['object-3','object-1'],
  'background and hidden layers require an explicit choice');
 evaluate(`const batchLayerPick=id=>$$("#ieLayerBatchList input").find(input=>input.value===id);
  batchLayerPick("object-3").click();batchLayerPick("object-2").click();
  const batchSourceStack=ewLayerState(IMAGE_EDITOR);
  $("#ieConfirmLayerBatch").click();`);
 await ready('!IMAGE_EDITOR?.busy && IMAGE_EDITOR?.layerExportIds?.length===2','selected layers are exported as a batch');
 equal(evaluate(`IMAGE_EDITOR.layerExportIds.map(id=>[node(id).name,curV(node(id)).ref])`),[
  ['物件拆分 · 花瓶','output:h3studio/batch-layer-vase.png'],['物件拆分 · 灯','output:h3studio/batch-layer-light.png']]);
 assert(evaluate('ewLayerState(IMAGE_EDITOR)===batchSourceStack'),'batch export preserves the editable stack');
 assert(evaluate(`const batchExportIds=[...IMAGE_EDITOR.layerExportIds];
  const [firstLayerExport,secondLayerExport]=batchExportIds.map(node);
  firstLayerExport.x+size(firstLayerExport).w<secondLayerExport.x`),'batch cards have room between them');
 evaluate('$("#ieLocateLayer").click()');
 assert(evaluate('!IMAGE_EDITOR && batchExportIds.every(id=>sel.has(id))'),'locate selects all exported nodes');
 evaluate('undo()');
 assert(evaluate('batchExportIds.every(id=>!node(id)) && !!node(batchLayerNode.id)'),'one undo removes the whole batch');

 const backgroundFetch=w.fetch;
 let backgroundRequest;
 w.fetch=async(url,options)=>{
  if(String(url)!=='/api/image-edit/fill-background')return backgroundFetch(url,options);
  backgroundRequest=JSON.parse(options.body);
  return {ok:true,text:async()=>JSON.stringify({...evaluate('copyAsset("filled-background.png")'),w:512,h:384})};
 };
 evaluate(`const layeredBackground=addNode("image",360,160,{}, {versions:[{
  ...copyAsset("split-result.png"),edit:{mode:"layers"},
  layer_stack:{base_ref:"output:h3studio/layered-source.png",layers:[
   {id:"object-0",name:"背景",ref:"output:h3studio/split-background.png",x:36,y:32,w:496,h:368,opacity:1,visible:true,
    decomposition_bounds:{x:8,y:12,w:496,h:368}},
   {id:"object-1",name:"物体 1",ref:"output:h3studio/layer-smoke.png",x:40,y:50,w:100,h:90,opacity:1,visible:true}
  ]}}],cur:0});`);
 await evaluate('openImageEditor(layeredBackground)');
 evaluate(`ieMode("layers");IMAGE_EDITOR.layers[1].x=110;$("#ieFillBackground").click();`);
 await ready('!IMAGE_EDITOR?.busy && IMAGE_EDITOR?.layers[0]?.name==="补全背景"','background is replaced in the current draft');
 equal(backgroundRequest,{ref:'output:h3studio/layered-source.png',background:'output:h3studio/split-background.png',x:8,y:12});
 equal(evaluate('[...IMAGE_EDITOR.layers.map(({ref,x,y})=>[ref,x,y]),layeredBackground.versions.length]'),[
  ['output:h3studio/filled-background.png',28,20],['output:h3studio/layer-smoke.png',110,50],1]);
 assert(w.document.getElementById('ieFillBackground').hidden,'the completed background cannot be filled again');
 evaluate(`const layerKey=(key,shiftKey=false)=>$("#ieLayerOpacity").dispatchEvent(new KeyboardEvent("keydown",
  {key,ctrlKey:true,shiftKey,bubbles:true,cancelable:true}));
  layerKey("z");`);
 assert(evaluate('!$("#ieFillBackground").hidden && IMAGE_EDITOR.layers[1].x===110'),
  'undo restores the original background without moving the subject');
 evaluate('layerKey("z",true)');
 assert(evaluate('$("#ieFillBackground").hidden && IMAGE_EDITOR.layers[0].name==="补全背景"'),'redo restores the filled layer');
 evaluate(`const layerCanvas=$(".ie-canvas"), layerPointer=(type,dx)=>{
  const view=IMAGE_EDITOR.view, rect=layerCanvas.getBoundingClientRect();
  layerCanvas.dispatchEvent(new MouseEvent(type,{button:0,bubbles:true,cancelable:true,
   clientX:rect.left+view.tx+(120+dx)*view.scale,clientY:rect.top+view.ty+100*view.scale}));
 };
 layerPointer("pointerdown",0);layerPointer("pointermove",15);layerPointer("pointercancel",15);
 const layerHistoryBeforeMove=IMAGE_EDITOR.layerUndo.length;`);
 equal(evaluate('IMAGE_EDITOR.layers[1].x'),110,'cancelled movement restores the original position');
 evaluate('layerPointer("pointerdown",0);layerPointer("pointermove",8);layerPointer("pointerup",16)');
 equal(evaluate('[IMAGE_EDITOR.layers[1].x,IMAGE_EDITOR.layerUndo.length-layerHistoryBeforeMove]'),[126,1],
  'a complete drag records one step');
 evaluate('$("#ieUndoLayer").click()');
 equal(evaluate('IMAGE_EDITOR.layers[1].x'),110,'one undo reverts the complete drag');
 evaluate(`const layerOpacity=$('#ieLayerOpacity');
  for(const value of [85,65,40]){layerOpacity.value=value;layerOpacity.dispatchEvent(new Event("input",{bubbles:true}));}
  layerOpacity.dispatchEvent(new Event("change",{bubbles:true}));`);
 equal(evaluate('[IMAGE_EDITOR.layers[1].opacity,$("#ieRedoLayer").disabled]'),[.4,true],
  'committing opacity creates a new history branch');
 evaluate('layerKey("z");$("#ieLayerDelete").click()');
 equal(evaluate('IMAGE_EDITOR.layers.length'),1,'the selected layer is deleted');
 evaluate('$("#ieUndoLayer").click()');
 equal(evaluate('[IMAGE_EDITOR.layers[1].opacity,IMAGE_EDITOR.activeLayer]'),[1,'object-1'],
  'one undo restores deletion and another restores the entire opacity adjustment');
 await evaluate('ewCommitLayers()');
 await ready('!IMAGE_EDITOR?.loading && !IMAGE_EDITOR?.restoring','filled layers are committed');
 equal(evaluate('curV(layeredBackground).layer_stack.layers[0].ref'),'output:h3studio/filled-background.png');
 assert(w.document.getElementById('ieUndoLayer').disabled,'the new version begins a separate edit history');
 w.fetch=backgroundFetch;
 console.log('Layer background fill passed: original geometry, retained movement, draft and version save.');

 evaluate('closeImageEditor()');
 const oraUploadFetch=w.fetch;
 let oraUploadedFile;
 w.fetch=async(url,options)=>{
  if(String(url)!=='/api/upload')return oraUploadFetch(url,options);
  oraUploadedFile=options.body.get('image').name;
  return {ok:true,json:async()=>({ref:'input:h3studio/ora-preview.png',url:'/media?ref=input:h3studio/ora-preview.png',
   w:600,h:450,layer_stack:{layers:[{id:'ora-1',name:'导入前景',ref:'input:h3studio/ora-layer.png',
    x:-3,y:16,w:100,h:120,opacity:.55,visible:false}]}})};
 };
 const oraFile=new w.File(['openraster'],'编辑稿.ora',{type:'application/octet-stream'});
 await evaluate('importCanvasFiles')([oraFile],{x:850,y:350});
 assert.equal(oraUploadedFile,'编辑稿.ora','the normal canvas import accepts .ora files');
 evaluate('const oraNode=B.nodes.at(-1)');
 equal(evaluate('[oraNode.type,oraNode.name,curV(oraNode).w,curV(oraNode).h]'),['image','编辑稿',600,450]);
 await evaluate('openImageEditor(oraNode)');
 evaluate('ieMode("layers")');
 equal(evaluate('IMAGE_EDITOR.layers.map(({name,x,y,opacity,visible})=>[name,x,y,opacity,visible])'),
  [['导入前景',-3,16,.55,false]],'the image editor restores independent imported layers');
 w.fetch=oraUploadFetch;
 console.log('OpenRaster import passed: normal canvas entry, document size and editable layer restoration.');

 evaluate(`const pickLayerNode=addNode("image",460,360,{}, {versions:[{
  ...copyAsset("pick-composite.png"),layer_stack:{layers:[
   {id:"lower",name:"底图",ref:"output:h3studio/pick-lower.png",x:0,y:0,w:240,h:220,opacity:1,visible:true},
   {id:"upper",name:"主体",ref:"output:h3studio/pick-upper.png",x:40,y:50,w:100,h:100,opacity:.7,visible:true},
   {id:"hidden",name:"隐藏图层",ref:"output:h3studio/pick-hidden.png",x:40,y:50,w:100,h:100,opacity:1,visible:false}
  ]}}],cur:0});`);
 await evaluate('openImageEditor(pickLayerNode)');
 evaluate(`ieMode("layers");
  const pickSamples=[], hitProbe=document.createElement("canvas");
  const hitContext=hitProbe.getContext("2d");
  hitContext.drawImage=(image,x,y)=>pickSamples.push([decodeURIComponent(image.src),x,y]);
  hitContext.getImageData=()=>{
   const [src,x]=pickSamples.at(-1);
   return {data:[0,0,0,src.includes("pick-upper") && x<100 ? 0 : 255]};
  };
  IMAGE_EDITOR.layerHitCanvas=hitProbe;
  const directPick=(type,x,y,altKey=false,shiftKey=false)=>{
   const view=IMAGE_EDITOR.view, rect=layerCanvas.getBoundingClientRect();
   layerCanvas.dispatchEvent(new MouseEvent(type,{button:0,altKey,shiftKey,bubbles:true,cancelable:true,
    clientX:rect.left+view.tx+x*view.scale,clientY:rect.top+view.ty+y*view.scale}));
  };
  directPick("pointerdown",50,65);directPick("pointerup",50,65);`);
 equal(evaluate('[IMAGE_EDITOR.activeLayer,IMAGE_EDITOR.layerUndo.length]'),['lower',0],
  'clicking through a transparent pixel selects the layer below without an undo entry');
 assert(evaluate('pickSamples[0][1]>=50 && pickSamples[0][1]<=51 && pickSamples.every(([src])=>!src.includes("pick-hidden"))'),
  'picking uses the scaled source pixel and skips hidden layers');
 evaluate('directPick("pointerdown",70,65);directPick("pointerup",70,65)');
 equal(evaluate('IMAGE_EDITOR.activeLayer'),'upper','opaque overlapping pixels select the highest visible layer');
 evaluate(`$('#ieLayerList [data-layer="lower"] button').click();
  directPick("pointerdown",70,65,true);directPick("pointerup",90,65,true);
  directPick("pointerdown",450,350);directPick("pointerup",470,350);`);
 equal(evaluate('[IMAGE_EDITOR.activeLayer,IMAGE_EDITOR.layers.map(l=>l.x),IMAGE_EDITOR.layerUndo.length]'),
  ['lower',[20,40,40],1],'Alt drag moves the explicit layer and empty space moves nothing');
 console.log('Layer picking passed: topmost visible pixel, transparent click-through, transforms and explicit drag.');

 evaluate(`$('#ieLayerList [data-layer="upper"] button').click();
  directPick("pointermove",40,50);
  const resizeDepth=IMAGE_EDITOR.layerUndo.length;
  const layerBox=()=>{const {x,y,w,h}=IMAGE_EDITOR.layers.find(layer=>layer.id==="upper");return [x,y,w,h];};`);
 equal(evaluate('layerCanvas.dataset.layerResize'),'nwse','hovering the corner shows a resize cursor');
 evaluate('directPick("pointerdown",40,50);directPick("pointermove",30,35);directPick("pointerup",20,20)');
 equal(evaluate('[layerBox(),$("#ieLayerWidth").value,$("#ieLayerHeight").value,IMAGE_EDITOR.layerUndo.length-resizeDepth]'),
  [[20,20,120,130],'120','130',1],'free resize keeps the opposite corner fixed and updates the panel in one step');
 evaluate('$("#ieUndoLayer").click()');
 equal(evaluate('layerBox()'),[40,50,100,100],'undo restores coordinates and dimensions');
 evaluate('directPick("pointerdown",140,150,false,true);directPick("pointerup",170,160,false,true)');
 equal(evaluate('layerBox()'),[40,50,120,120],'Shift keeps the original layer aspect ratio');
 evaluate(`directPick("pointerdown",160,170);directPick("pointermove",180,200);
  layerCanvas.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));`);
 equal(evaluate('[layerBox(),!IMAGE_EDITOR.layerDrag]'),[[40,50,120,120],true],
  'Escape cancels resizing in place');
 console.log('Layer resize passed: corner hit testing, fixed anchor, Shift ratio, panel sync, undo and cancel.');

 evaluate(`closeImageEditor();
  const timingVideos=[6,2.25,null].map((seconds,index)=>addNode("video",1000+index*520,830,{duration:5},{
   versions:[{ref:"output:h3studio/timing-shot-"+index+".mp4",w:640,h:360,...(seconds?{seconds}:{})}],cur:0
  }));
  const timingScript=addNode("script",450,800,{shots:[3.5,4.5,3].map((duration,index)=>({
   id:"timing-shot-"+index,duration,action:["移动"],dialogue:[],shot_size:"中景",camera:"固定"
  })),made:timingVideos.map((video,index)=>({shot_id:"timing-shot-"+index,vid:video.id}))});
  openStoryFilm(timingScript,0,2,"fade");`);
 equal(evaluate('FILM.spec.clips.map(c=>[c.story_frames,c.out,c.trans,!!c.story_pending_length])'),
  [[84,3.5,'fade',false],[108,2.25,'fade',false],[72,null,'fade',true]],
  'regular storyboards use actual generated footage against planned length while keeping the chosen transitions');
 evaluate('selectClip(1);$("#fmV").onloadedmetadata?.()');
 assert.match(evaluate('$("#fmClip").textContent'),/素材时长不足，缺 2\.25 秒/);
 evaluate(`selectClip(2);
  const timingPlayer=$("#fmV");
  Object.defineProperty(timingPlayer,"duration",{value:5.2,configurable:true});
  timingPlayer.onloadedmetadata?.();
  delete timingPlayer.duration;`);
 equal(evaluate('[FILM.spec.clips[2].out,!!FILM.spec.clips[2].story_pending_length]'),[3,false],
  'previously unknown duration is measured from this clip before trimming');
 evaluate(`delete FILM.spec.clips[0].story_frames;
  Object.assign(FILM.spec.clips[0],{in:.75,out:2.5,speed:1.25});
  closeFilm();openStoryFilm(timingScript);`);
 equal(evaluate('[FILM.spec.clips[0].story_frames,FILM.spec.clips[0].in,FILM.spec.clips[0].out,FILM.spec.clips[0].speed]'),
  [84,.75,2.5,1.25],'old drafts recover the planned length without replacing manual edits');
 console.log('Story film timing passed: normal shot durations, measured sources, real shortage and saved manual cuts.');

 evaluate(`delete FILM.spec.clips[2].src_len;
  const timingReview=$("#fmTimingDialog");
  const openTiming=()=>$("#fmTiming").click();
  const applyTiming=()=>$("#fmTimingDialog form").dispatchEvent(new Event("submit",{cancelable:true}));
  openTiming();`);
 assert.match(evaluate('$("[data-timing-summary]",timingReview).textContent'),/3 段有镜长计划 · 1 段素材不足 · 1 段待核实/);
 assert.match(evaluate('$("[data-timing-list]",timingReview).textContent'),/素材缺 2\.25 秒/);
 equal(evaluate('$$("[data-timing-check]",timingReview).map(input=>input.dataset.timingCheck)'),['0'],
  'only clips with enough verified footage and mismatched timing can be selected');
 evaluate('$$("[data-timing-locate]",timingReview).find(button=>button.dataset.timingLocate==="1").click();$("#fmV").onloadedmetadata?.()');
 equal(evaluate('[timingReview.open,FILM.sel]'),[false,1],'the short shot can be located directly');
 evaluate(`openTiming();$("[data-timing-check]",timingReview).click();
  const reviewedClip=FILM.spec.clips[0];
  reviewedClip.out=2.75;applyTiming();`);
 equal(evaluate('[timingReview.open,reviewedClip.out,$("[data-timing-check]",timingReview).checked]'),[true,2.75,false],
  'a timeline change invalidates the selected proposal');
 evaluate('$("[data-timing-check]",timingReview).click();applyTiming()');
 equal(evaluate('[timingReview.open,reviewedClip.in,reviewedClip.out,reviewedClip.speed,FILM.spec.clips[1].out]'),
  [false,.75,5.125,1.25,2.25],'applying uses the selected starting point and playback rate while leaving a short clip alone');
 evaluate('FILM.spec.remake_audio=true;reviewedClip.out=2;openTiming()');
 assert.equal(evaluate('$$("[data-timing-check]",timingReview).length'),0,'synchronized originals cannot be batch-retimed');
 evaluate('closeFilmStoryTiming();delete FILM.spec.remake_audio');
 console.log('Story timing review passed: short and unknown coverage, locate, stale proposal and selective adjustment.');

 evaluate(`const shortTimelineClip=FILM.spec.clips[1], timingCandidates=timingVideos[1];
  shortTimelineClip.in=.25;
  timingCandidates.versions.push({ref:"output:h3studio/timing-alt-almost.mp4",seconds:4.5},
   {ref:"output:h3studio/timing-alt-usable.mp4",seconds:6.2},
   {ref:"output:h3studio/timing-alt-latest.mp4",seconds:7.2});
  timingCandidates.cur=1;
  openTiming();`);
 assert.match(evaluate('$("[data-timing-list]",timingReview).textContent'),/2 个备选版本原速够长/);
 evaluate('timingCandidates.versions[3].seconds=3;$("[data-timing-preview]",timingReview).click()');
 assert(evaluate('timingReview.open'),'an outdated recommendation keeps the review open');
 assert.match(evaluate('$("[data-timing-list]",timingReview).textContent'),/1 个备选版本原速够长/);
 evaluate(`$("[data-timing-preview]",timingReview).click();$("#fmV").onloadedmetadata?.();
  const recommendedPicker=$(".fm-version-picker"), recommendedPreview=$("video",recommendedPicker);
  recommendedPreview.onloadedmetadata?.();`);
 equal(evaluate('[shortTimelineClip.ref,shortTimelineClip.out,timingCandidates.cur,$("[data-fit-story]",recommendedPicker).checked,recommendedPreview.currentTime]'),
  ['output:h3studio/timing-shot-1.mp4',2.25,1,true,.25],'preview pins an eligible candidate without changing the draft or canvas');
 assert.match(evaluate('recommendedPreview.src'),/timing-alt-usable\.mp4/);
 evaluate('recommendedPicker.dispatchEvent(new Event("submit",{cancelable:true}))');
 equal(evaluate('[shortTimelineClip.ref,shortTimelineClip.in,shortTimelineClip.out,shortTimelineClip.speed,timingCandidates.cur]'),
  ['output:h3studio/timing-alt-usable.mp4',.25,4.75,1,1],'confirmed candidate fills the requested length at original speed');
 console.log('Story timing alternatives passed: available versions, stale recommendation, preview and explicit application.');

 evaluate(`const timingRetakeDraftKey=FILM.key;
  Object.assign(shortTimelineClip,{ref:timingCandidates.versions[0].ref,out:2.25,speed:1,
   story_shot:"timing-shot-1",media_seconds:2.25});
  timingCandidates.versions[2].seconds=4;
  timingCandidates.data.duration=3;timingCandidates.data.prompt="补拍动作";
  openTiming();$("[data-timing-retake]",timingReview).click();`);
 equal(evaluate('[!FILM,$("#groupRunConfirm").open,$("#groupRunConfirm [name=mode]").value,sel.has(timingCandidates.id)]'),
  [true,true,'video',true],'shortage links to the existing same-shot video plan without launching jobs');
 assert.match(evaluate('$("#groupRunConfirm [data-summary]").textContent'),/至少需要 4\.75 秒素材.*当前生成时长设为 3 秒/);
 equal(evaluate('JSON.parse(localStorage.getItem(timingRetakeDraftKey)).spec.clips[1].out'),2.25,'opening the plan preserves the existing edit');
 console.log('Story timing retake passed: matched source, required length, video-only confirmation and draft preservation.');
 assert.equal(evaluate('$("#groupRunConfirm [data-set-retake-length]").textContent'),'将视频节点设为 5 秒');
 evaluate('$("#groupRunConfirm [data-set-retake-length]").click()');
 equal(evaluate('[timingCandidates.data.duration,$("#groupRunConfirm").open,$("#groupRunConfirm [data-set-retake-length]").hidden,!!timingCandidates.job]'),
  [5,true,true,false],'the smallest eligible preset is applied without submitting the generation');
 evaluate(`const originalTimingExecution=executeCanvasGroup;
  const timingTakeRef="output:h3studio/timing-fresh-take.mp4";
  executeCanvasGroup=async run=>{
    timingCandidates.versions.push({ref:timingTakeRef,seconds:6.5,w:640,h:360});
    groupRun={...run,active:false};
    groupRunSetResult(groupRun.steps[0],{refs:[timingTakeRef],errors:[]});
    preserveCanvasGroupRun(groupRun);
  };
  $("#groupRunConfirm form").dispatchEvent(new Event("submit",{cancelable:true}));
  executeCanvasGroup=originalTimingExecution;
  restoreCanvasGroupRun();
  localStorage.setItem(filmDraftPrefix()+"latest","unrelated-draft");`);
 assert.equal(evaluate('$("#groupRunProgress [data-film-return]").hidden'),false,'the return action survives restoring the finished run');
 evaluate('$("#groupRunProgress [data-film-return]").click();$("#fmV").onloadedmetadata?.()');
 equal(evaluate('[FILM.key,FILM.sel,FILM.spec.clips[1].ref,FILM.spec.clips[1].out]'),
  [evaluate('timingRetakeDraftKey'),1,'output:h3studio/timing-shot-1.mp4',2.25],
  'returning locates the original edited clip without adopting the new take');
 assert.match(evaluate('$(".fm-version-picker video").src'),/timing-fresh-take\.mp4/);
 console.log('Story take return passed: persistent run receipt, exact draft, new-version preview and retained edit.');
 evaluate('closeFilm();openScriptShotRun(timingScript,1,{mode:"video",requiredSeconds:17})');
 assert.match(evaluate('$("#groupRunConfirm [data-summary]").textContent'),/最长 14 秒/);
 assert.equal(evaluate('$("#groupRunConfirm [data-set-retake-length]").hidden'),true,'the plan does not suggest inaccessible duration presets');
 evaluate('closeCanvasGroupRunDialog()');
 evaluate(`const newStoryboardReference=addNode("image",600,280,{},{
  name:"角色参考",versions:[copyAsset("story-first.png"),copyAsset("story-second.png")],cur:1
 });
 AC.board=boardId;
 acAppendEvent({kind:"tool_start",data:{call_id:"new-storyboard-candidate",name:"storyboard_create_plan"}});
 acAppendEvent({kind:"tool_end",data:{call_id:"new-storyboard-candidate",name:"storyboard_create_plan",
  result:{storyboard_create:{id:"n-new-storyboard-candidate",board:boardId,title:"雨夜",aspect:"9:16",style:"写实",
   story:"走出门",planned_seconds:20,characters:[],refs:[{node:newStoryboardReference.id,
    ref:newStoryboardReference.versions[0].ref,name:newStoryboardReference.name}],
   shots:[{duration:10,scene:"走廊",shot_size:"中景",action:["靠近门"],dialogue:[],keyframe:"门边",
    asset_refs:[{id:"hero-asset",name:"林森",kind:"character",view:"face"}]},
    {duration:10,scene:"街道",shot_size:"远景",action:["走出门"],dialogue:[],keyframe:"街灯"}]}}}});
 const confirmNewStoryboard=$("[data-call=new-storyboard-candidate] [data-create-storyboard]");
 const adoptNewStoryboard=()=>$("#acMessages").onclick({target:confirmNewStoryboard});`);
 assert.equal(evaluate('!!node("n-new-storyboard-candidate")'),false,'planning leaves the canvas intact');
 assert.match(evaluate('$("[data-storyboard-create]").textContent'),/林森（正面头肩）/);
 await evaluate('adoptNewStoryboard()');
 equal(evaluate(`const createdStory=node("n-new-storyboard-candidate");
  [createdStory.type,createdStory.data.aspect,createdStory.data.shots.map(s=>s.duration),scriptRefs(createdStory)[0].ref]`),
  ['script','9:16',[10,10],'output:h3studio/story-first.png'],'confirmation creates an editable script with its exact reference version');
 await evaluate('adoptNewStoryboard()');
 equal(evaluate('B.nodes.filter(n=>n.id==="n-new-storyboard-candidate").length'),1,'repeated confirmation locates the same script');
 evaluate('expandScript(createdStory)');
 equal(evaluate(`const ownedShots=scriptShotLinks(createdStory), exactAsset="@{hero-asset#face|林森}";
  [node(ownedShots[0].img).data.prompt.includes(exactAsset), node(ownedShots[0].vid).data.fields.scene.includes(exactAsset),
   node(ownedShots[1].img).data.prompt.includes(exactAsset), node(ownedShots[1].vid).data.fields.scene.includes(exactAsset)]`),
  [true,true,false,false],'only the shot using the asset sends its exact identity and view to both generation nodes');
 evaluate('undo()');
 evaluate('undo()');
 assert.equal(evaluate('!!node("n-new-storyboard-candidate")'),false,'one undo removes the script and its reference connection');
 console.log('Assistant storyboard creation passed: review, pinned assets, duplicate protection and undo.');
}
run().catch(err=>{console.error(err);process.exitCode=1;}).finally(()=>w.close());
