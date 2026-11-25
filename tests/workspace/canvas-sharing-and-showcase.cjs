"use strict";

module.exports = async function canvasSharingAndShowcase(workspace, scenarioState) {
 const { JSDOM, assert, equal, evaluate, fs, path, pause, ready, root, vm, w } = workspace;
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
 equal(scenarioState.commentThreads[0].anchor,JSON.parse(evaluate('JSON.stringify(qaPoint)')),'marker references a world position');
 evaluate('$("#ccClose").click();$("#commentPins [data-cc-pin=comment2]").click();$("#ccList [data-cc-toggle=comment2]").click()');
 await ready('!$("#commentPins [data-cc-pin=comment2]")','resolved marker is removed from the canvas');
 evaluate('$("#ccFilter").value="resolved";$("#ccFilter").dispatchEvent(new Event("change"));$("#ccList [data-cc-toggle=comment2]").click()');
 await ready('!!$("#commentPins [data-cc-pin=comment2]")','reopening restores the marker at the same position');
 evaluate('AC.session=null;AC.board=null');
 await evaluate('acOpen()');
 evaluate('$("#acInput").value="比较原素材";$("#ccFilter").value="all";$("#ccFilter").dispatchEvent(new Event("change"));$("#ccList [data-cc-agent=comment1]").click()');
 await ready('!!$(".ac-review-ref") && $("#canvasComments").hidden','comment is attached in the assistant composer');
 assert.equal(scenarioState.reviewPosts.length,0);
 equal(evaluate('$("#acInput").value'),'比较原素材','attach preserves an existing draft');
 equal(evaluate('acRefs().map(n=>n.id)'),['n1'],'assistant includes the commented node');
 evaluate('$("#acInput").dispatchEvent(new Event("input"));$("#acSend").click()');
 await ready('!!$("#acMessages .ac-sent-review")','sent review is visible in conversation history');
 assert.equal(scenarioState.reviewPosts[0].review_id,'comment1');
 assert.equal(scenarioState.reviewPosts[0].text,'比较原素材');
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
 equal(scenarioState.reviewPosts[1].review_ids,['comment4','comment1']);
 equal(scenarioState.reviewPosts[1].selected,[evaluate('timestampPreview.id'),'n1']);
 assert.match(scenarioState.reviewPosts[1].text,/汇总.*修改建议/);
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
 assert.deepEqual(scenarioState.shareRequests[0],{username:'reviewer',role:'reviewer'});
 evaluate('$("#publicPublish").click()');
 await ready('!$("#publicLink").hidden && $("#publicPublish").hidden','publishing shows the public link');
 assert.equal(evaluate('$("#publicURL").value'),'http://oneshot.test/share/'+scenarioState.publicToken);
 evaluate('$("#publicRevoke").click()');
 await ready('$("#publicLink").hidden && !$("#publicPublish").hidden','revoking removes the public link');
 const ownBoard=scenarioState.projectBoards.get('btest');
 scenarioState.projectBoards.set('review-board',{...ownBoard,owner:42,access:'reviewer'});
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
  url:'http://oneshot.test/share/'+scenarioState.publicToken,runScripts:'outside-only',
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
   vm.runInContext(fs.readFileSync(workspace.staticFile(script.src),'utf8'),publishedDOM.getInternalVMContext());
  for(let i=0;i<30&&published.document.getElementById('copyBoard').disabled;i++)await pause(10);
  assert.equal(published.document.querySelector('.node-content').textContent,'<script>可见文本</script>');
  assert.equal(published.document.querySelector('.snapshot-node script'),null);
  assert.equal(published.document.querySelector('.snapshot-node img').getAttribute('src'),'/api/share/'+scenarioState.publicToken+'/media/0');
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
   url:'http://oneshot.test/showcase/'+scenarioState.publicToken,runScripts:'outside-only',
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
     {token:scenarioState.publicToken,title:"公开动图",author:"创作者",creator:"visitor",prompt:publicPrompt,media_kind:"gif"}};
  };
  const showcaseScripts=[...watch.document.querySelectorAll('script[src]')];
  for(const script of showcaseScripts.filter(script=>!script.defer).concat(showcaseScripts.filter(script=>script.defer)))
   vm.runInContext(fs.readFileSync(workspace.staticFile(script.src),'utf8'),watchDOM.getInternalVMContext());
  for(let i=0;i<30&&!watch.document.querySelector('.showcase-prompt');i++) await pause(10);
  const card=watch.document.querySelector('.showcase-prompt');
  assert.equal(watch.document.querySelector('.showcase-watch > img').getAttribute('src'),'/api/showcase/'+scenarioState.publicToken+'/gif');
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
};
