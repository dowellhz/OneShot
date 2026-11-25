"use strict";

module.exports = async function timelinePlaylistsAndAudio(workspace) {
 const { assert, equal, evaluate, jobs, ready, w } = workspace;
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
 const playlistFetch=w.fetch, archiveRequests=[], archiveLinks=[], archiveClick=w.HTMLAnchorElement.prototype.click;
 let playlistTransfer;
 w.HTMLAnchorElement.prototype.click=function(){
   archiveLinks.push([this.download,this.getAttribute("href")]);
   playlistTransfer={...playlistTransfer,state:"sent",bytes:120};
 };
 w.fetch=async(url,opts)=>{
   const path=String(url);
   if(path==="/api/assets/transfers" && opts.method==="POST"){
     const payload=JSON.parse(opts.body);archiveRequests.push(payload);
     playlistTransfer={id:"playlist-transfer",state:"packing",name:payload.name,bytes:0,total:120};
     if(payload.refs.length===1)playlistTransfer={...playlistTransfer,state:"ready",name:payload.refs[0].split("/").pop()};
   } else if(path==="/api/assets/transfers/playlist-transfer"){
     if(playlistTransfer.state==="packing")playlistTransfer={...playlistTransfer,state:"ready"};
   } else return playlistFetch(url,opts);
   return {ok:true,json:async()=>playlistTransfer};
 };
 evaluate('$("#fmPlaylistSources").click();$("#fmPlaylistSources").click()');
 await ready('$("#assetTransferPanel").parentElement===$("#film") && $("[data-transfer-state]").textContent==="正在打包"',
   'playlist shows packing progress and ignores repeated clicks');
 evaluate('closeFilm();');
 await ready('$("#assetTransferPanel").parentElement===document.body && $("[data-transfer-state]").textContent==="文件已发送"',
   'closing the playlist keeps transfer progress visible',150);
 assert.equal(archiveRequests.length,1);
 equal(archiveRequests[0].refs,['input:h3studio/playlist-source-1.mp4','input:h3studio/playlist-source-0.mp4'],
   'playlist downloads deduplicate originals in timeline order');
 assert.match(archiveLinks[0][0],/原片\.zip$/);
 evaluate('nodeAction(savedPlaylist,"playlist-open");const originalDownloadClips=FILM.spec.clips;FILM.spec.clips=originalDownloadClips.slice(0,2);$("#fmPlaylistSources").click()');
 await ready('!ctDownloading && $("[data-transfer-state]").textContent==="文件已发送"','a single deduplicated original downloads',150);
 equal(archiveRequests[1].refs,['input:h3studio/playlist-source-1.mp4']);
 equal(archiveLinks[1],["playlist-source-1.mp4","/api/assets/transfers/playlist-transfer/file"]);
 evaluate('FILM.spec.clips=originalDownloadClips');
 w.fetch=playlistFetch;w.HTMLAnchorElement.prototype.click=archiveClick;
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
 const playlistCanvasFetch=w.fetch, canvasRenderAttempts=[];
 let acceptedCanvasRender;
 w.fetch=async(url,opts)=>{
  if(String(url)!=="/api/render")return playlistCanvasFetch(url,opts);
  canvasRenderAttempts.push(JSON.parse(opts.body));
  if(acceptedCanvasRender)return acceptedCanvasRender;
  acceptedCanvasRender=await playlistCanvasFetch(url,opts);
  throw new Error("模拟提交答复丢失");
 };
 evaluate('FILM.spec.clips[0].out=1.5;$("#fmExportCanvas").click()');
 await ready('!FILM.busy && $("#toast").textContent.includes("模拟提交答复丢失")','a lost reply leaves an export retry');
 assert.equal(evaluate('B.nodes.some(n=>n.id===FILM.canvasAttempt.nodeId)'),false);
 evaluate('closeFilm();nodeAction(savedPlaylist,"playlist-open");$("#fmExportCanvas").click()');
 await ready('!FILM && node([...sel][0])?.name.endsWith(" · 成片")','a retry attaches the exported movie to a new node');
 const standaloneFilmId=evaluate('[...sel][0]');
 await ready(`node(${JSON.stringify(standaloneFilmId)}).versions.length===1`,'new node receives the merged video',350);
 assert.equal(canvasRenderAttempts.length,2);
 assert.equal(canvasRenderAttempts[0].request_key,canvasRenderAttempts[1].request_key);
 equal(canvasRenderAttempts[1].spec.clips.map(({in:from,out})=>[from,out]),[[0,1.5],[2,4],[0,null]]);
 equal(evaluate('JSON.stringify(savedPlaylist)'),savedPlaylistBefore,'exporting a new node leaves the saved playlist untouched');
 equal(evaluate('node([...sel][0]).data.film.clips.map(c=>c.ref)'),[
  'input:h3studio/playlist-source-1.mp4','input:h3studio/playlist-source-1.mp4','input:h3studio/playlist-source-0.mp4']);
 w.fetch=playlistCanvasFetch;
 evaluate(`removeNodes([${JSON.stringify(standaloneFilmId)}]);localStorage.removeItem(filmDraftKey(savedPlaylist.data.film,savedPlaylist));`);
 evaluate(`closeFilm();B.access="reviewer";nodeAction(savedPlaylist,"playlist-open");`);
 equal(evaluate('[$("#film").classList.contains("playlist-review"),$("#fmSaveList").hidden,$("#fmExportCanvas").hidden,$("#fmGo").disabled]'),
   [true,true,true,true],'reviewers can preview saved playlists without modification controls');
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
};
