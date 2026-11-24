"use strict";
// The editor returns a real raster mask; the assistant waits durably on the server.
Object.assign(AC_LABELS,{video_generate:"生成视频",video_regenerate:"重新生成视频",image_select:"准备编辑选区",image_layers_get:"读取图层",image_layers_edit:"调整图层",image_extract:"提取透明图层",image_history:"读取历史参数",image_reuse:"复用参数生成",image_compare:"对比编辑结果"});
AC_STATES.waiting_input="等待你在编辑器中画选区…";
function aeAction(label,fn){const button=document.createElement("button");button.type="button";button.textContent=label;button.onclick=()=>Promise.resolve().then(fn).catch(e=>toast(e.message,5000));return button;}
function aeResultExtras(host,result,name){
 const box=document.createElement("div");box.className="ac-edit-actions";
 for(const item of result.nodes||[]){const n=node(item.id),v=acResultVersion(item);if(!n||n.type!=="image")continue;
  if(v?.edit?.source||v?.agent_source)box.append(aeAction("对比",()=>aeCompare(n.id,v.edit?.source||v.agent_source,"wipe",v.ref)));
  box.append(aeAction("编辑图层",()=>aeOpenLayers(n.id,v.ref)));
  if(v?.edit?.recipe)box.append(aeAction("复用参数",()=>aeReuse(n.id,v.edit.recipe,v.ref)));
 }
 if(name==="image_layers_get")box.append(aeAction("打开图层编辑器",()=>aeOpenLayers(result.node_id)));
 if(name==="image_history"){for(const version of result.versions||[])if(version.recipe)box.append(aeAction("复用版本 "+(version.version_index+1),()=>aeReuse(result.node_id,version.recipe)));}
 if(box.childElementCount)host.append(box);
}
function aeAppendEvent(event,replay){
 const d=event.data,box=$("#acMessages");
 if(event.kind==="selection"){
  const card=document.createElement("div");card.className="ac-selection";
  const caption=document.createElement("span");caption.textContent="粉色区域将被编辑，其他区域受到遮罩保护。";
  const image=document.createElement("img");image.src=ewRefUrl(d.preview_ref);image.alt="编辑选区预览";image.loading="lazy";card.append(image,caption);
  card.append(aeAction("在编辑器查看",()=>aeShowSelection(d)));box.append(card);return true;
 }
 if(event.kind==="compare"){
  const card=document.createElement("div");card.className="ac-edit-actions";card.append(aeAction("查看前后对比",()=>aeCompare(d.node_id,d.before_ref,d.mode,d.after_ref)));box.append(card);
  if(!replay&&!$("#light").open)aeCompare(d.node_id,d.before_ref,d.mode,d.after_ref).catch(e=>toast(e.message));return true;
 }
 return event.kind==="selection_request";
}
async function aeEditor(nid,ref){
 const n=node(nid);if(!n||n.type!=="image")throw new Error("图片节点已不存在");
 if(IMAGE_EDITOR?.busy)throw new Error("请等待当前编辑操作完成");
 closeLightbox();
 await openImageEditor(n);const E=IMAGE_EDITOR;if(!E||E.n!==n)throw new Error("编辑器已切换");
 if(E.loading)await E.loadPromise;
 if(ref&&E.ref!==ref){const v=n.versions.find(v=>v.ref===ref);if(!v)throw new Error("引用版本已不存在");E.agentPinnedRef=ref;await ieLoad(v);}
 return E;
}
async function aeCompare(nid,before,mode="wipe",after){
 const E=await aeEditor(nid,after);const original=await ewAsset(E,before);if(IMAGE_EDITOR!==E)return;
 E.original=original;E.compare=false;E.compareMode=mode;$("#ieCompareMode").value=mode;$("#ieWipe").hidden=mode!=="wipe";ieDraw();ieStatus("正在对比编辑前后，可拖动滑杆或切换并排视图");
}
async function aeOpenLayers(nid,ref){
 const E=await aeEditor(nid,ref),version=E.n.versions.find(v=>v.ref===E.ref);if(!version)return;
 const saved=version.layer_stack,edit=version.edit;
 if(saved?.layers){E.layers=acClone(saved.layers);}
 else if(edit?.layer&&edit.base){const base=await ewAsset(E,edit.base);E.layers=[{id:"base",name:"编辑前原图",ref:edit.base,x:0,y:0,w:base.naturalWidth,h:base.naturalHeight,opacity:1,visible:true},{id:"generated",name:"生成区域",ref:edit.layer.ref,x:0,y:0,w:base.naturalWidth,h:base.naturalHeight,opacity:1,visible:true}];}
 await ewPreload(E,E.layers.map(l=>l.ref));if(IMAGE_EDITOR!==E)return;E.activeLayer=E.layers[E.layers.length-1]?.id;ewRenderLayers();ieMode("layers");ieDraw();ieStatus("可以调整图层位置、顺序和不透明度，合并时保存新版本");
}
async function aeReuse(nid,recipe,ref){await aeEditor(nid,ref);await ewApplyRecipe(recipe);}
async function aeShowSelection(selection){
 const E=await aeEditor(selection.node_id,selection.source_ref);await ewAsset(E,selection.mask_ref);if(IMAGE_EDITOR!==E)return;
 E.strokes=[{tool:"mask",ref:selection.mask_ref,replace:true,luminance:true}];E.redo=[];ieMode("region");ieRebuildMask();ewScheduleDraft(true);ieStatus("已加载保存的选区，可调整后生成新版本");
}
function aeRenderInputs(){
 const box=$("#acInputRequest");if(!box)return;const input=AC.inputs?.[0];box.hidden=!input;if(input&&box.dataset.call===input.call_id)return;box.dataset.call=input?.call_id||"";box.replaceChildren();
 if(!input){if(IMAGE_EDITOR?.agentSelection){delete IMAGE_EDITOR.agentSelection;IMAGE_EDITOR.agentPinnedRef=null;aeEditorControls();}return;}
 const text=document.createElement("span");text.textContent=input.instruction||"请画出需要修改的区域";box.append(text,aeAction("打开选区编辑器",()=>aeOpenInput(input)));
}
async function aeOpenInput(input){
 if(!AC.inputs?.some(x=>x.call_id===input.call_id))throw new Error("这个选区请求已经结束");
 const E=await aeEditor(input.node_id,input.source_ref);if(AC.board!==boardId)return;if(ewLayerDirty(E))throw new Error("请先合并保存当前图层草稿，再为助手绘制选区");
 E.agentSelection={...input,session_id:AC.session,board:boardId};E.agentPinnedRef=input.source_ref;ieMode("region");E.compareMode="off";$("#ieCompareMode").value="off";$("#ieWipe").hidden=true;aeEditorControls();ieSync();ieStatus(input.instruction||"画出编辑区域，然后点击「发送选区给助手」。");
}
function aeUnlockEditor(E){if(E?._agentDisabled){for(const [el,disabled]of E._agentDisabled)el.disabled=disabled;delete E._agentDisabled;}}
function aeEditorControls(){
 const E=IMAGE_EDITOR,bar=$("#ieAgentSelection");if(!bar)return;
 if(E?.agentSelection){if(!E._agentDisabled){const locked=$$("[data-mode],#ieRetry,#ieReuse,#ieResultLayer,#ieImportLayer,#ieCutout,#ieSaveLayers,#ieSelectionLayer,#ieCutSelection",$("#imageEditor"));E._agentDisabled=locked.map(el=>[el,el.disabled]);}for(const [el]of E._agentDisabled)el.disabled=true;}else aeUnlockEditor(E);bar.hidden=!E?.agentSelection;$("#ieSendSelection").disabled=!E?.image||!!E?.busy||!!E?.restoring;
 const attach=$("#ieAttachSelection");
 attach.hidden=E?.mode!=="region"||!!E?.agentSelection;
 attach.disabled=!E?.image||!!E?.busy||!!E?.loading||!!E?.restoring;
}
async function aeMaskData(E){
 const canvas=document.createElement("canvas");canvas.width=E.mask.width;canvas.height=E.mask.height;
 const ctx=canvas.getContext("2d");ctx.fillStyle="black";ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(E.mask,0,0);
 const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));if(!blob)throw new Error("无法导出选区");
 return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error("读取选区失败"));reader.readAsDataURL(blob);});
}
async function aeAttachSelection(){
 const E=IMAGE_EDITOR;
 if(!E?.image||E.busy||E.loading||E.restoring||E.mode!=="region"||E.agentSelection)return;
 if(!E.strokes.length){ieStatus("请先用画笔圈出需要修改的区域",true);return;}
 if(ewLayerDirty(E)){ieStatus("请先合并并保存图层，再把选区加入对话",true);return;}
 const board=boardId;
 E.busy=true;ieStatus("正在添加选区…");ieSync();
 let attached=false;
 try{
  const ref=E.ref,mask_data=await aeMaskData(E);
  if(board!==boardId)throw new Error("画布已切换，请重新圈选");
  await acOpen();
  const sid=AC.session;
  if(!sid||AC.board!==board||board!==boardId||node(E.n.id)!==E.n)throw new Error("请在源图所在画布打开助手对话");
  const selection=await acApi(`/api/chat/sessions/${sid}/selection`,{node_id:E.n.id,source_ref:ref,mask_data});
  if(board!==boardId||AC.session!==sid||node(E.n.id)!==E.n)throw new Error("画布或对话已切换，请重新添加选区");
  AC.selection=selection;acPinReference(E.n);attached=true;
 }catch(e){ieStatus(e.message,true);}
 finally{E.busy=false;ieSync();}
 if(attached){closeImageEditor(false);$("#acInput").focus();}
}
async function aeSendSelection(){
 const E=IMAGE_EDITOR,p=E?.agentSelection;if(!p||!E.image||E.busy)return;
 if(p.board!==boardId||E.ref!==p.source_ref)throw new Error("源图已切换，请重新打开选区请求");
 E.busy=true;aeEditorControls();ieSync();try{
  const mask_data=await aeMaskData(E);
  await acApi(`/api/chat/runs/${p.run_id}/selection`,{call_id:p.call_id,mask_data});delete E.agentSelection;E.agentPinnedRef=null;AC.inputs=(AC.inputs||[]).filter(i=>i.call_id!==p.call_id);aeRenderInputs();ieStatus("选区已发送，助手将继续执行；可以收起编辑器。");await acPoll();
 }catch(e){ieStatus(e.message,true);}finally{E.busy=false;aeEditorControls();ieSync();}
}
function aeInit(){
 const area=document.createElement("div");area.id="acInputRequest";area.className="ac-input-request";area.hidden=true;$(".ac-composer",$("#agentChat")).before(area);
 const bar=document.createElement("div");bar.id="ieAgentSelection";bar.className="ie-agent-selection";bar.hidden=true;bar.innerHTML='<span>为助手绘制编辑区域</span><button id="ieSendSelection" type="button">发送选区给助手</button>';
 $(".ie-statusbar",$("#imageEditor")).after(bar);$("#ieSendSelection").onclick=()=>aeSendSelection().catch(e=>ieStatus(e.message,true));
 const attach=aeAction("把圈选区域加入助手对话",aeAttachSelection);
 attach.id="ieAttachSelection";
 $("#ieGenerate").after(attach);
}
