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
const englishSmoke=process.argv.includes('--english');
if(englishSmoke)w.localStorage.setItem('oneshot.language','en');
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
 else if(pathname==='/api/samples')result=w.__samples||[];
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
 else if(pathname==='/api/memory/review-generation'){
  const {entries}=JSON.parse(options.body);
  result=entries.map(entry=>({id:entry.id,...(w.__groupAssetReview?.(entry)||{assets:[],key:'a'.repeat(64)})}));
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

async function boot() {
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
 return {
 JSDOM,
 assert,
 board,
 englishSmoke,
 equal,
 evaluate,
 fs,
 jobs,
 path,
 pause,
 ready,
 recipes,
 requests,
 get revision() { return revision; },
 set revision(value) { revision = value; },
 root,
 vm,
 w,
  get notificationRequests() { return notificationRequests; },
  set notificationRequests(value) { notificationRequests = value; },
  taskNotes,
  staticFile,
 };
}

module.exports = { boot, close: () => w.close() };
