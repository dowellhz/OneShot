"use strict";

module.exports = async function workspaceImportAndProjects(workspace, scenarioState) {
 const { assert, equal, evaluate, ready, w } = workspace;
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
 const projectFetch=w.fetch;
 scenarioState.projectBoards = new Map([['btest',JSON.parse(JSON.stringify(evaluate('B')))]]);
 const projectMembership=new Map();
 const groups=new Map();
 scenarioState.projectAssets = [];
 scenarioState.commentThreads = [];
 scenarioState.reviewPosts = [];
 const reviewEvents=[];
 scenarioState.shareRequests = [];
 const shareState={shared:false,collaborators:[],rev:2};
 scenarioState.publicToken = 'f'.repeat(43);
 let publicShare=null;
 scenarioState.workflow = null;
 w.fetch=async(url,options={})=>{
  const u=new URL(String(url),'http://oneshot.test'),method=options.method||'GET';
  const payload=typeof options.body==='string'?JSON.parse(options.body):null;
  let result;
  if(u.pathname==='/api/boards')result=[...scenarioState.projectBoards].map(([id,b])=>({id,name:b.name,nodes:b.nodes.length,project:projectMembership.get(id)}));
  else if(u.pathname==='/api/canvas-projects'){
   if(method==='POST'){
    result={id:'project-test',name:payload.name};groups.set(result.id,result);
    if(payload.board)projectMembership.set(payload.board,result.id);
   }else result=[...groups.values()];
  } else if(u.pathname==='/api/canvas-projects/project-test' && method==='DELETE'){
   groups.clear();projectMembership.clear();scenarioState.projectAssets.forEach(a=>{a.project='';});result={ok:true};
  } else if(u.pathname==='/api/memory'){
   if(method==='POST'){
    result={...payload,id:'projectAsset',owner:1,media:[],mtime:1,ref:''};scenarioState.projectAssets.push(result);
   }else{
    const bid=u.searchParams.get('board');
    const scope=u.searchParams.get('scope');
    result=scenarioState.projectAssets.filter(a=>scope==='current' ? !!a.project&&a.project===projectMembership.get(bid) :
     scope==='personal' ? !a.project : !a.project||a.project===projectMembership.get(bid));
    if(u.searchParams.has('cursor'))result={items:result,next_cursor:null};
   }
  } else if(u.pathname==='/api/board/btest/comments'){
   if(method==='POST'){
    result={id:'comment'+(scenarioState.commentThreads.length+1),body:payload.body,created:1,author:'User',anchor:payload.anchor,can_resolve:true,resolved:false,replies:[]};
    if(payload.anchor?.passage) {
     const {start,end,quote}=payload.anchor.passage;
     result.anchor={...payload.anchor,passage:{quote}};
     result.passage_location=[start,end];
    }
    if(payload.thread_id)scenarioState.commentThreads.find(t=>t.id===payload.thread_id).replies.push(result);
    else scenarioState.commentThreads.unshift(result);
   }else result=scenarioState.commentThreads;
  } else if(u.pathname.startsWith('/api/board/btest/comments/') && method==='PATCH'){
   scenarioState.commentThreads.find(t=>t.id===u.pathname.split('/').at(-1)).resolved=payload.resolved;result={ok:true};
  } else if(u.pathname==='/api/chat/sessions'){
   result={sessions:[{id:'review-chat',title:'审阅'}]};
  } else if(u.pathname==='/api/chat/sessions/review-chat'){
   result={events:reviewEvents.filter(e=>e.id>Number(u.searchParams.get('after')||0)),runs:[],inputs:[]};
  } else if(u.pathname==='/api/chat/sessions/review-chat/messages'){
   scenarioState.reviewPosts.push(payload);
   const ids=payload.review_ids||[payload.review_id];
   const reviews=ids.map(id=>scenarioState.commentThreads.find(t=>t.id===id)).map(t=>({id:t.id,body:t.body,anchor:t.anchor,replies:t.replies.map(r=>r.body)}));
   reviewEvents.push({kind:'user',id:reviewEvents.length+1,data:{text:payload.text,reviews}});
   result={id:'review-run',state:'done'};
  } else if(u.pathname==='/api/board/btest/access'){
   if(method==='PATCH'){
    scenarioState.shareRequests.push(payload);
    shareState.collaborators=[{username:payload.username,name:'审阅同事',role:payload.role,disabled:false}];
    shareState.rev++;
    scenarioState.projectBoards.get('btest').rev=shareState.rev;
   }
   result=shareState;
  } else if(u.pathname==='/api/board/btest/snapshot'){
   if(method==='PUT')publicShare={token:scenarioState.publicToken,created:1};
   if(method==='DELETE'){publicShare=null;result={ok:true};}
   else result=publicShare;
  } else if(u.pathname==='/api/canvas-templates'){
   if(method==='POST'){
    const b=scenarioState.projectBoards.get(payload.board);
    const ids=new Set(payload.selected||b.nodes.map(n=>n.id));
    const fragment={nodes:b.nodes.filter(n=>ids.has(n.id)),edges:b.edges.filter(e=>ids.has(e.from)&&ids.has(e.to)),
     groups:b.groups.filter(g=>g.nodes.every(id=>ids.has(id)))};
    result={id:'qa-template',name:payload.name,nodes:fragment.nodes.length,updated:1};
    scenarioState.workflow={row:result,fragment,includeUpstream:payload.include_upstream};
   }else result=scenarioState.workflow?[scenarioState.workflow.row]:[];
  } else if(u.pathname==='/api/canvas-templates/qa-template/fragment'){
   result=JSON.parse(JSON.stringify(scenarioState.workflow.fragment));
   scenarioState.workflow.copyInputs=payload.inputs||[];
   for(const edit of scenarioState.workflow.copyInputs){
    const target=result.nodes.find(node=>node.id===edit.node);
    assert.equal(target.data[edit.field],edit.before);
    target.data[edit.field]=edit.value;
   }
  } else if(u.pathname==='/api/canvas-templates/qa-template/content'){
   scenarioState.workflow.replacePayload=payload;
   scenarioState.workflow.row.updated++;
   result={ok:true};
  } else if(u.pathname==='/api/canvas-templates/qa-template/history'){
   result=[{id:12,name:scenarioState.workflow.row.name,updated:1,nodes:2}];
  } else if(u.pathname==='/api/canvas-templates/qa-template/history/12'){
   result={nodes:[{name:'旧镜头',type:'video',inputs:{prompt:'前一版提示词'}}]};
  } else if(u.pathname==='/api/canvas-templates/qa-template/history/12/restore'){
   scenarioState.workflow.restorePayload=payload;scenarioState.workflow.row.updated++;
   result={ok:true};
  } else if(u.pathname==='/api/canvas-templates/catalog'){
   result=scenarioState.workflow?.row.published?[{...scenarioState.workflow.row,author:'创作者',owned:1}]:[];
  } else if(u.pathname==='/api/canvas-templates/favorites'){
   result=scenarioState.workflow?.row.favorite?[{...scenarioState.workflow.row,author:'创作者',owned:1}]:[];
  } else if(u.pathname==='/api/canvas-templates/qa-template/favorite'){
   scenarioState.workflow.row.favorite=method==='PUT';
   result={favorite:scenarioState.workflow.row.favorite};
  } else if(u.pathname==='/api/canvas-templates/qa-template/publication'){
   assert.equal(payload.confirmed,true);
   scenarioState.workflow.row.published=1;
   result={ok:true};
  } else if(u.pathname==='/api/canvas-templates/qa-template/preview'){
   result={name:scenarioState.workflow.row.name,edges:scenarioState.workflow.fragment.edges.map(edge=>({...edge,version:1,media:2})),nodes:scenarioState.workflow.fragment.nodes.map((n,i)=>(
    {id:n.id,type:n.type,name:n.name,prompt:n.data.prompt,inputs:{prompt:n.data.prompt||''},media:i}))};
  } else if(u.pathname.startsWith('/api/board/')){
   const id=u.pathname.split('/').at(-1);
   if(method==='PUT'){
    result={rev:2};scenarioState.projectBoards.set(id,{...payload,rev:2,owner:1});
    if(u.searchParams.has('project'))projectMembership.set(id,u.searchParams.get('project'));
   }else result=scenarioState.projectBoards.get(id);
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
 assert.equal(scenarioState.projectAssets[0].project,'project-test');
 assert.equal(scenarioState.projectAssets[0].board,'');
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
 assert.equal(scenarioState.projectBoards.size,2);
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
 assert.equal(scenarioState.projectBoards.get('btest').name,'等待保存的画布');
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
 assert.equal(scenarioState.projectBoards.get('btest').name,previousName);
 console.log('Canvas save retry passed: repeated HTTP failures stay visible and a successful retry persists the draft.');
};
