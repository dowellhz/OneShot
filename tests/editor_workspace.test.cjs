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
  }else result=w.__memories||[];
 }
 else if(pathname.startsWith('/api/memory/')){
  const id=decodeURIComponent(pathname.split('/').pop());
  if(method==='DELETE'){w.__memories=(w.__memories||[]).filter(a=>a.id!==id);result={ok:true};}
  else result={...(w.__memories||[]).find(a=>a.id===id),history:w.__memoryHistory||[]};
 }
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
 // A real input event opens the shared completion menu; Enter selects rather than sending chat.
 w.__memories=[{id:'person1',name:'林森',kind:'character',aliases:['小林'],tags:['主角'],desc:'圆框眼镜',ref:'input:h3studio/lin.png',board:'btest'},{id:'forest1',name:'森林',kind:'scene',aliases:[],tags:['树林'],desc:'晨雾森林',ref:'input:h3studio/forest.png',board:'btest'}];
 evaluate('cmInvalidate();document.getElementById("acInput").value="让@";document.getElementById("acInput").focus();document.getElementById("acInput").setSelectionRange(2,2);document.getElementById("acInput").dispatchEvent(new Event("input",{bubbles:true}))');
 await ready('CM.popup && !CM.popup.hidden && CM.matches.length===2','mention dropdown');
 equal(evaluate('document.querySelectorAll("#memoryMention [role=option]").length'),2,'at sign lists memory records');
 evaluate('document.getElementById("acInput").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}));document.getElementById("acInput").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))');
 equal(evaluate('document.getElementById("acInput").value'),'让@森林 ','keyboard completes without chat submission');
 evaluate('document.getElementById("prompt").value="@小";document.getElementById("prompt").focus();document.getElementById("prompt").setSelectionRange(2,2);document.getElementById("prompt").dispatchEvent(new Event("input",{bubbles:true}))');
 await ready('CM.target?.id==="prompt" && !CM.popup.hidden && CM.matches.length===1','prompt alias completion');
 evaluate('document.querySelector("#memoryMention [data-memory=person1]").click()');
 equal(evaluate('document.getElementById("prompt").value'),'@林森 ','mouse completes alias with canonical name');
 evaluate('document.getElementById("acInput").value="@主角";document.getElementById("acInput").focus();document.getElementById("acInput").setSelectionRange(3,3);document.getElementById("acInput").dispatchEvent(new Event("input",{bubbles:true}))');
 await ready('CM.matches.length===1 && !CM.popup.hidden','tag completion');
 evaluate('document.getElementById("acInput").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');
 equal(evaluate('CM.popup.hidden'),true,'escape closes completion');
 evaluate('CM.items.push({...CM.items[0],id:"person2"});document.getElementById("acInput").value="";document.getElementById("acInput").setSelectionRange(0,0);cmInsert(document.getElementById("acInput"),CM.items[0])');
 equal(evaluate('document.getElementById("acInput").value'),'@{person1} ','duplicate names insert unambiguous IDs');
 await evaluate('cmEdit(null,"document")');
 equal(evaluate('document.querySelector("#memoryEditor [name=kind]").value'),'document','background memory editor');
 equal(evaluate('document.querySelector("#memoryEditor [name=board]").value'),'btest','new memory defaults to current project');
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
 const nodesBeforeLibrary=evaluate('B.nodes.length');
 evaluate('ME_USER={id:1,role:"member"};document.getElementById("assetLibraryBtn").click()');
 await ready('AL.items.length===5 && document.getElementById("alLoading").hidden','asset library entry');
 equal(evaluate('document.getElementById("assetLibrary").hidden'),false,'dedicated workspace opens');
 equal(evaluate('document.querySelectorAll("#alGrid .al-card").length'),5,'all kinds share asset grid');
 equal(evaluate('document.querySelector("#alGrid .al-card[data-id=doc] strong svg")'),null,'asset names are escaped');
 evaluate('document.querySelector("#alCategories [data-kind=character]").click()');
 equal(evaluate('document.querySelectorAll("#alGrid .al-card").length'),1,'category filter');
 evaluate('document.querySelector("#alCategories [data-kind=all]").click();document.getElementById("alSearch").value="小林";document.getElementById("alSearch").dispatchEvent(new Event("input"))');
 equal(evaluate('document.querySelector("#alGrid .al-card").dataset.id'),'char','alias search');
 evaluate('document.getElementById("alSearch").value="树林";document.getElementById("alSearch").dispatchEvent(new Event("input"))');
 equal(evaluate('document.querySelector("#alGrid .al-card").dataset.id'),'scene','tag search');
 evaluate('document.getElementById("alReset").click();document.getElementById("alSource").value="generated";document.getElementById("alSource").dispatchEvent(new Event("change"))');
 equal(evaluate('document.querySelectorAll("#alGrid .al-card").length'),1,'generated source filter');
 evaluate('document.getElementById("alReset").click();document.getElementById("alScope").value="project";document.getElementById("alScope").dispatchEvent(new Event("change"))');
 equal(evaluate('document.querySelectorAll("#alGrid .al-card").length'),3,'project scope filter');
 evaluate('document.getElementById("alScope").value="personal";document.getElementById("alScope").dispatchEvent(new Event("change"))');
 equal(evaluate('document.querySelectorAll("#alGrid .al-card").length'),1,'personal scope excludes another owner');
 evaluate('document.getElementById("alReset").click();document.querySelector("#alGrid [data-id=char] .al-card-main").click()');
 await ready('document.querySelector("#alDetail [name=name]")?.value==="林森" && document.querySelector("#alDetail .cm-history img")','integrated detail and history');
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
 evaluate('document.querySelector("#alGrid [data-id=public] .al-card-main").click()');
 await ready('document.querySelector("#alDetail [name=name]")?.value==="共享画风"','shared asset detail');
 equal(evaluate('document.querySelector("#alDetail [name=name]").disabled'),true,'foreign shared asset read only');
 equal(evaluate('document.querySelector("#alDetail [type=submit]").hidden'),true,'shared asset hides write action');
 const fileInput=w.document.getElementById('alFile');
 Object.defineProperty(fileInput,'files',{configurable:true,value:[new w.File(['png'],'new-person.png',{type:'image/png'})]});
 fileInput.dispatchEvent(new w.Event('change'));
 await ready('document.querySelector("#alDetail .cm-error")?.textContent.includes("已上传")','upload directly into asset editor');
 evaluate('document.querySelector("#alDetail [name=name]").value="上传角色";document.querySelector("#alDetail form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');
 await ready('AL.items.some(a=>a.name==="上传角色") && CM.editor.dataset.busy==="false"','uploaded asset persisted');
 assert.match(w.__lastMemoryPost.ref,/^input:h3studio\/upload/);assert.equal(w.__lastMemoryPost.ref,w.__lastMemoryPost.default_ref);
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
 evaluate('document.getElementById("assetBtn").click()');equal(evaluate('AL.open'),false,'side toolbar toggles same library');
 await evaluate('alOpen()');
 const beforeVideoPlace=evaluate('B.nodes.length');
 evaluate('document.querySelector("#alGrid [data-id=clip] [data-action=canvas]").click()');
 equal(evaluate('B.nodes.length'),beforeVideoPlace+1,'video asset places one node');
 equal(evaluate('B.nodes[B.nodes.length-1].type'),'video','video-only asset stays video');
 equal(evaluate('B.nodes[B.nodes.length-1].versions[0].ref'),'input:h3studio/robot.mp4','video asset retains source');
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
 evaluate('$("#acInput").value="正在写的草稿"; const choices=$$(".ac-choices button");choices[1].click();choices[0].click()');
 await ready('!AC.sending && AC.events.at(-1).data.text==="我选择 2：冷色风格"','selected option reaches the conversation');
 assert.equal(picked.text,'我选择 2：冷色风格');
 assert.equal(attempts,1,'clicks cannot submit twice');
 equal(evaluate('$("#acInput").value'),'正在写的草稿','option preserves draft');
 equal(evaluate('document.querySelectorAll(".ac-choices button:not(:disabled)").length'),0,'answered choices cannot be submitted again');
 chatRuns=[{id:'choice-result',state:'done'}];
 await evaluate('acLoadSession("s1")');
 equal(evaluate('document.querySelectorAll(".ac-choices button:not(:disabled)").length'),0,'old choices stay inactive after replay');
 const previousFetch=w.fetch;
 let remakeSession=null, remakeSelection, remakeOptions, remakeMotion;
 w.fetch=async(url,options={})=>{
  if(!String(url).startsWith('/api/video-remake/'))return previousFetch(url,options);
  const operation=options.body&&JSON.parse(options.body);
  if(operation?.action==='analyze'){
   const frame={ref:'input:h3studio/remake-frame.png',w:640,h:480,previews:[]};
   remakeSession={shots:[{start:0,end:3,summary:{action:['缓慢转身']},frames:{first:frame,middle:structuredClone(frame)}}]};
  }
  const frame=remakeSession?.shots[0].frames.first;
  if(operation?.action==='select'){
   remakeSelection=operation.rect;
   frame.selection={overlay:'input:h3studio/remake-overlay.png'};
  }
  if(operation?.action==='capture_correction'){
   const key='correction-24';
   remakeSession.shots[0].frames[key]={...structuredClone(frame),correction_tick:24,at:1,selection:null,previews:[]};
   return {ok:true,json:async()=>({...structuredClone(remakeSession),captured_frame:key}),text:async()=>JSON.stringify({...remakeSession,captured_frame:key})};
  }
  if(operation?.action==='select' && operation.frame==='correction-24'){
   remakeSession.shots[0].frames[operation.frame].selection={overlay:'input:h3studio/correction-overlay.png'};
  }
  if(operation?.action==='preview'){
   remakeOptions=operation;
   frame.previews.push({job:'remake-job',state:'done',ref:'output:h3studio/remake.png',asset:{name:'林森'}});
  }
  if(operation?.action==='approve')frame.approved=operation.job;
  if(operation?.action==='generate_video'){
   remakeMotion=operation.motion;
   remakeSession.shots[0].videos=[{job:'shot-video',state:'done',ref:'output:h3studio/shot-remake.mp4'}];
  }
  if(operation?.action==='localize'){
   assert.equal(operation.job,'shot-video');
   remakeSession.shots[0].videos.push({job:'shot-local',mode:'local',state:'done',ref:'output:h3studio/shot-local.mp4'});
  }
  if(operation?.action==='approve_video')remakeSession.shots[0].adopted_video=operation.job;
  if(operation?.action==='export')remakeSession.export={job:'export-job',state:'done',ref:'output:h3studio/assembled.mp4'};
  return {ok:true,json:async()=>structuredClone(remakeSession),text:async()=>JSON.stringify(remakeSession)};
 };
 evaluate('ctxMenu({target:els.get("pendingVideo"),clientX:140,clientY:120})');
 evaluate(`document.querySelector('#ctxMenu [data-a="remake"]').click()`);
 await ready('$("#videoRemake [data-analyze]")?.disabled===false','remake workspace opens from video menu');
 evaluate('$("#videoRemake [data-analyze]").click()');
 await ready('!!$("#videoRemake .rm-shots button")','analyzed shot visible');
 evaluate(`$("#videoRemake [data-mode=box]").click();
  const rmSurface=$(".rm-surface");
  rmSurface.dispatchEvent(new MouseEvent("pointerdown",{button:0,clientX:60,clientY:15}));
  rmSurface.dispatchEvent(new MouseEvent("pointerup",{button:0,clientX:180,clientY:37}));`);
 await ready('$(".rm-mask").hidden===false','selected mask appears over source');
 assert.equal(remakeSelection.length,4);
 evaluate(`const rmRole=$("[data-role]",$("#videoRemake"));rmRole.value="char";rmRole.dispatchEvent(new Event("change"));$("#videoRemake [data-generate]").click()`);
 await ready('!!$("#videoRemake .rm-output img")','role preview displays in workspace');
 assert.equal(remakeOptions.asset,'char');
 evaluate('$$(".rm-review button").find(b=>b.textContent==="采用此预览").click()');
 await ready('$$(".rm-review button").some(b=>b.textContent==="用作视频首帧")','approve exposes first-frame action');
 evaluate(`const motionField=$("#videoRemake [data-motion]");motionField.value="第一秒回头";motionField.dispatchEvent(new Event("input"));$("#videoRemake [data-generate-video]").click()`);
 await ready('!!$("#videoRemake [data-result]").getAttribute("src")','remade video can be reviewed in workspace');
 assert.equal(remakeMotion,'第一秒回头');
 evaluate('$("#videoRemake video").currentTime=1;$("#videoRemake [data-capture-correction]").click()');
 await ready('$("#videoRemake [data-frame]").value==="correction-24" && $("#videoRemake .rm-role").hidden','capture opens frame only for tracking correction');
 evaluate(`rmSurface.dispatchEvent(new MouseEvent("pointerdown",{button:0,clientX:80,clientY:15}));
  rmSurface.dispatchEvent(new MouseEvent("pointerup",{button:0,clientX:200,clientY:37}));`);
 await ready('$$(".rm-video-review button").some(b=>b.textContent.includes("1 张校正帧"))','correction counted by local render control');
 evaluate('$$(".rm-video-review button").find(b=>b.textContent.startsWith("跟踪人物并局部合成")).click()');
 await ready('$("#videoRemake [data-result]").getAttribute("src")?.includes("shot-local.mp4")','local result is selectable alongside original generation');
 evaluate('$$(".rm-video-review button").find(b=>b.textContent==="采用此视频").click()');
 await ready('$("#videoRemake [data-export]").hidden===false','review unlocks export');
 evaluate('$("#videoRemake [data-export]").click()');
 await ready('$("#videoRemake [data-download]").hidden===false','finished export can be downloaded');
 equal(evaluate('$("#videoRemake [data-download]").download'),'assembled.mp4','export download uses assembled file');
 evaluate(`const rmFrameSelect=$("#videoRemake [data-frame]");rmFrameSelect.value="first";rmFrameSelect.dispatchEvent(new Event("change"))`);
 const beforeRemake=evaluate('B.nodes.length');
 evaluate('$$(".rm-review button").find(b=>b.textContent==="用作视频首帧").click()');
 equal(evaluate('B.nodes.length'),beforeRemake+2,'handoff creates one preview image and one linked video');
 equal(evaluate('B.nodes.at(-1).data.prompt'),'缓慢转身','new video receives analyzed motion description');
 equal(evaluate('B.edges.at(-1).from'),evaluate('B.nodes.at(-2).id'),'approved frame linked to new video');
 equal(evaluate('!!$("#videoRemake")'),false,'handoff returns to canvas');
 w.fetch=previousFetch;
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
}
run().catch(err=>{console.error(err);process.exitCode=1;}).finally(()=>w.close());
