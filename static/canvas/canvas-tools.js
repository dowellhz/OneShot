"use strict";
const CT_ACTIONS=[
  ["left","左对齐","M5 3v18M9 7h10v4H9zM9 15h7v4H9z"],
  ["centerX","水平居中对齐","M12 3v18M5 6h14v4H5zM8 14h8v4H8z"],
  ["right","右对齐","M19 3v18M5 7h10v4H5zM8 15h7v4H8z"],
  ["top","顶部对齐","M3 5h18M6 9h4v10H6zM14 9h4v7h-4z"],
  ["centerY","垂直居中对齐","M3 12h18M6 5h4v14H6zM14 8h4v8h-4z"],
  ["bottom","底部对齐","M3 19h18M6 5h4v10H6zM14 8h4v7h-4z"],
  ["distributeX","水平等距排列","M3 4v16M21 4v16M7 8h3v8H7zM14 8h3v8h-3z"],
  ["distributeY","垂直等距排列","M4 3h16M4 21h16M8 7h8v3H8zM8 14h8v3H8z"],
  ["group","编组","M3 8V4h4M17 4h4v4M21 16v4h-4M7 20H3v-4M7 8h4v5H7zM14 11h4v5h-4z"],
  ["ungroup","取消编组","M3 8V4h4M17 4h4v4M21 16v4h-4M7 20H3v-4M8 8l8 8M16 8l-8 8"],
  ["download","批量下载","M12 3v12M7 10l5 5 5-5M4 17v4h16v-4"]
];
// Card-to-card spacing also leaves room for titles, version tabs and connectors.
const CT_LAYOUT_GAP={x:180,y:140};
function ctAvoidObstacles(positions,nodes,obstacles,sizeOf=size){
  if(!positions.length || !obstacles.length)return positions;
  const byId=new Map(nodes.map(n=>[n.id,n]));
  const items=positions.map(p=>({...p,...sizeOf(byId.get(p.id))})),fixed=obstacles.map(n=>({...n,...sizeOf(n)}));
  const y0=Math.min(...items.map(n=>n.y));let offset=0;
  for(let pass=0;pass<fixed.length;pass++){
    const hits=fixed.filter(o=>items.some(n=>n.x<o.x+o.w+CT_LAYOUT_GAP.x && n.x+n.w+CT_LAYOUT_GAP.x>o.x && n.y+offset<o.y+o.h+CT_LAYOUT_GAP.y && n.y+n.h+offset+CT_LAYOUT_GAP.y>o.y));
    if(!hits.length)break;
    offset=Math.max(offset,...hits.map(o=>o.y+o.h+CT_LAYOUT_GAP.y-y0));
  }
  return positions.map(p=>({...p,y:Math.round(p.y+offset)}));
}
function ctPositions(nodes,operation,sizeOf=size,obstacles=[]) {
  if(nodes.length<2)return [];
  const items=nodes.map(n=>({id:n.id,x:n.x,y:n.y,...sizeOf(n)}));
  const x0=Math.min(...items.map(n=>n.x)),y0=Math.min(...items.map(n=>n.y)),x1=Math.max(...items.map(n=>n.x+n.w)),y1=Math.max(...items.map(n=>n.y+n.h));
  if(operation==="distributeX" || operation==="distributeY") {
    if(items.length<3)return [];
    const axis=operation==="distributeX" ? "x" : "y",dim=axis==="x" ? "w" : "h";items.sort((a,b)=>a[axis]-b[axis] || a.id.localeCompare(b.id));
    const min=items[0][axis],max=Math.max(...items.map(n=>n[axis]+n[dim])),gap=Math.max(CT_LAYOUT_GAP[axis],(max-min-items.reduce((s,n)=>s+n[dim],0))/(items.length-1));
    let cursor=min;for(const n of items){n[axis]=Math.round(cursor);cursor+=n[dim]+gap;}
  } else {
    const vertical=["left","right","centerX"].includes(operation),axis=vertical?"y":"x",dim=vertical?"h":"w";
    items.sort((a,b)=>a[axis]-b[axis] || a[vertical?"x":"y"]-b[vertical?"x":"y"] || a.id.localeCompare(b.id));
    let cursor=items[0][axis];
    for(const n of items){
      if(operation==="left")n.x=x0;else if(operation==="right")n.x=x1-n.w;else if(operation==="centerX")n.x=Math.round((x0+x1-n.w)/2);
      else if(operation==="top")n.y=y0;else if(operation==="bottom")n.y=y1-n.h;else if(operation==="centerY")n.y=Math.round((y0+y1-n.h)/2);
      n[axis]=Math.max(n[axis],cursor);cursor=n[axis]+n[dim]+CT_LAYOUT_GAP[axis];
    }
  }
  return ctAvoidObstacles(items.map(({id,x,y})=>({id,x,y})),nodes,obstacles,sizeOf);
}
function ctSelected(){return [...sel].map(node).filter(Boolean);}
const ctMedia=n=>n && (n.type==="image" || n.type==="video");
function ctGridPositions(nodes,obstacles=[],sizeOf=size){
  if(nodes.length<2)return [];
  const items=nodes.map(n=>({id:n.id,x:n.x,y:n.y,...sizeOf(n)})).sort((a,b)=>a.y-b.y || a.x-b.x || a.id.localeCompare(b.id));
  const columns=Math.ceil(Math.sqrt(items.length)),gapX=CT_LAYOUT_GAP.x,gapY=CT_LAYOUT_GAP.y;
  const x0=Math.min(...items.map(n=>n.x)),y0=Math.min(...items.map(n=>n.y));
  const widths=Array.from({length:columns},(_,col)=>Math.max(...items.filter((_,i)=>i%columns===col).map(n=>n.w)));
  const lefts=widths.map((_,i)=>x0+widths.slice(0,i).reduce((sum,w)=>sum+w+gapX,0));
  let y=y0;
  for(let i=0;i<items.length;i+=columns){const row=items.slice(i,i+columns);row.forEach((n,col)=>{n.x=lefts[col];n.y=y;});y+=Math.max(...row.map(n=>n.h))+gapY;}
  return ctAvoidObstacles(items.map(({id,x,y})=>({id,x:Math.round(x),y:Math.round(y)})),nodes,obstacles,sizeOf);
}
function ctFlowPositions(nodes,edges,obstacles=[],sizeOf=size){
  if(nodes.length<2)return [];
  const media=nodes.filter(ctMedia),byId=new Map(media.map(n=>[n.id,n])),links=edges.filter(e=>byId.has(e.from)&&byId.has(e.to));
  const adjacent=new Map(media.map(n=>[n.id,[]]));for(const e of links){adjacent.get(e.from).push(e.to);adjacent.get(e.to).push(e.from);}
  const order=(a,b)=>a.y-b.y || a.x-b.x || (a.name||a.id).localeCompare(b.name||b.id,"zh",{numeric:true});
  const seen=new Set(),components=[];
  for(const start of [...media].sort(order)){
    if(seen.has(start.id))continue;const ids=[start.id],component=[];seen.add(start.id);
    for(let i=0;i<ids.length;i++){const n=byId.get(ids[i]);component.push(n);for(const id of adjacent.get(n.id))if(!seen.has(id)){seen.add(id);ids.push(id);}}
    components.push(component);
  }
  const x0=Math.min(...media.map(n=>n.x)),y0=Math.min(...media.map(n=>n.y));
  const images=media.filter(n=>n.type==="image"),videoX=images.length?x0+Math.max(...images.map(n=>sizeOf(n).w))+320:x0;
  const positions=[];let cursor=y0;
  for(const component of components){
    const vids=component.filter(n=>n.type==="video").sort(order),rank=new Map(vids.map((n,i)=>[n.id,i]));
    const imageRank=n=>{const outgoing=links.filter(e=>e.from===n.id&&rank.has(e.to));if(!outgoing.length)return [Infinity,0];
      const e=outgoing.sort((a,b)=>rank.get(a.to)-rank.get(b.to))[0],role=e.role||"auto",video=byId.get(e.to);
      const frames=links.filter(f=>f.to===e.to&&byId.get(f.from)?.type==="image"&&(f.role||"auto")!=="subject");
      const ordered=[...frames.filter(f=>f.role==="first"),...frames.filter(f=>!["first","last"].includes(f.role)),...frames.filter(f=>f.role==="last")];
      const frameRank=role==="subject"||(role==="auto"&&video.data.mode==="reference")?-1:role==="first"?0:role==="last"?1000:e.time!=null?Number(e.time):ordered.indexOf(e)*1000/Math.max(1,ordered.length-1);
      return [rank.get(e.to),frameRank];};
    const imageOrder=(a,b)=>{const ar=imageRank(a),br=imageRank(b);return ar[0]-br[0]||ar[1]-br[1]||order(a,b);};
    const remaining=component.filter(n=>n.type==="image").sort(imageOrder),imgs=[];
    while(remaining.length){const ready=remaining.filter(n=>!links.some(e=>e.to===n.id&&remaining.some(m=>m.id===e.from))).sort(imageOrder);const n=ready[0]||remaining[0];imgs.push(n);remaining.splice(remaining.indexOf(n),1);}
    const left=[];let leftY=cursor;
    for(const n of imgs){const s=sizeOf(n);left.push({id:n.id,x:x0,y:leftY,h:s.h});leftY+=s.h+CT_LAYOUT_GAP.y;}
    const leftById=new Map(left.map(p=>[p.id,p])),right=[];let rightY=cursor;
    const desired=n=>{const inputs=links.filter(e=>e.to===n.id).map(e=>leftById.get(e.from)).filter(Boolean);return inputs.length?inputs.reduce((sum,p)=>sum+p.y+p.h/2,0)/inputs.length:cursor;};
    for(const n of vids.sort((a,b)=>desired(a)-desired(b)||order(a,b))){const s=sizeOf(n),y=Math.max(rightY,desired(n)-s.h/2);right.push({id:n.id,x:videoX,y,h:s.h});rightY=y+s.h+CT_LAYOUT_GAP.y;}
    const leftH=left.length?leftY-CT_LAYOUT_GAP.y-left[0].y:0,rightH=right.length?rightY-CT_LAYOUT_GAP.y-right[0].y:0,blockH=Math.max(leftH,rightH);
    if(left.length){const shift=cursor+(blockH-leftH)/2-left[0].y;for(const p of left)p.y+=shift;}
    if(right.length){const shift=cursor+(blockH-rightH)/2-right[0].y;for(const p of right)p.y+=shift;}
    positions.push(...left,...right);cursor+=blockH+CT_LAYOUT_GAP.y*2;
  }
  return ctAvoidObstacles(positions.map(({id,x,y})=>({id,x:Math.round(x),y:Math.round(y)})),nodes,obstacles,sizeOf);
}
function ctArrange(action,ids){
  if(!canvasCanEdit()) return;
  const nodes=ids.map(node).filter(n=>ctMedia(n)&&!ctFolded(n.id)&&!nodeLocked(n));
  if(nodes.length<2)return toast("至少需要两个未锁定的图片或视频节点");
  const targets=new Set(nodes.map(n=>n.id));
  const fixed=[...B.nodes.filter(n=>!targets.has(n.id)&&!ctFolded(n.id)),...CT_FOLD_BOXES.values()];
  const positions=action==="flow" ? ctFlowPositions(nodes,B.edges,fixed) : action==="grid" ? ctGridPositions(nodes,fixed) : ctPositions(nodes,action,size,fixed);
  if(!positions.length)return toast("等距排列至少需要三个图片或视频节点");
  if(!positions.some(p=>{const n=node(p.id);return n.x!==p.x || n.y!==p.y;}))return toast("这些节点已经对齐");
  checkpoint();for(const p of positions){const n=node(p.id);n.x=p.x;n.y=p.y;render(n);}
  drawEdges();drawMini();placeOverlays();save();toast("已整理 "+nodes.length+" 个节点，可按 ⌘/Ctrl Z 撤销");
}
function ctOpenArrangeMenu(x,y){
  closeMenus();const bid=boardId,eligible=n=>ctMedia(n)&&!ctFolded(n.id)&&!nodeLocked(n);
  const selected=ctSelected().filter(eligible).map(n=>n.id),all=B.nodes.filter(eligible).map(n=>n.id);
  let m=$("#arrangeMenu");if(!m){m=document.createElement("div");m.id="arrangeMenu";m.className="menu";document.body.append(m);}
  m.innerHTML=`<div class="mt">整理对齐</div><label class="ct-arrange-scope">范围<select aria-label="整理范围"><option value="selected">选中的图片与视频（${selected.length}）</option><option value="all">全部图片与视频（${all.length}）</option></select></label><button data-layout="flow">${ico("next")}按关系整理（图片左 · 视频右）</button><button data-layout="grid">${ico("assets")}网格整理（自动留出间距）</button><div class="sep"></div>`+
    CT_ACTIONS.slice(0,8).map(([action,label,path])=>`<button data-layout="${action}"><svg class="i" aria-hidden="true"><path d="${path}"/></svg>${label}</button>`).join("")+`<div class="ct-arrange-note">只调整位置，支持撤销</div>`;
  const select=$("select",m);select.value=selected.length>=2 ? "selected" : "all";
  const chosen=()=>select.value==="selected" ? selected : all;
  const update=()=>{$$("[data-layout]",m).forEach(b=>{const min=b.dataset.layout.startsWith("distribute")?3:2;b.disabled=chosen().length<min;b.title=b.disabled?`至少需要 ${min} 个未锁定的图片或视频节点`:"";});$(".ct-arrange-note",m).textContent="锁定节点保留原位置，整理支持撤销";};
  select.onchange=update;update();
  $$("[data-layout]",m).forEach(b=>b.onclick=()=>{const ids=chosen();closeMenus();if(boardId===bid)ctArrange(b.dataset.layout,ids);});
  m.classList.add("on");m.style.left=Math.max(8,Math.min(x,innerWidth-m.offsetWidth-8))+"px";m.style.top=Math.max(8,Math.min(y,innerHeight-m.offsetHeight-8))+"px";
}
let ctDownloading=false;
const CT_TRANSFER_TEXT={packing:"正在打包",ready:"正在交给浏览器",sending:"正在传输",sent:"文件已发送",error:"下载未完成"};
document.querySelector("[data-transfer-close]").onclick=e=>{e.currentTarget.closest("section").hidden=true;};

function ctDownloadable(nodes) {
  return [...new Set(nodes.filter(n=>["image","video","audio","film"].includes(n.type)&&!n.job)
    .map(n=>curV(n)?.ref).filter(Boolean))];
}

function ctTransferPanel(host) {
  const panel=$("#assetTransferPanel");
  const activeDialog=document.querySelector("dialog[open]:focus-within");
  const parent=host||activeDialog||document.body;
  if(panel.parentNode!==parent)parent.appendChild(panel);
  if(activeDialog&&!activeDialog._assetTransferClose){
    activeDialog._assetTransferClose=true;
    activeDialog.addEventListener("close",()=>{
      if(panel.parentNode===activeDialog)document.body.appendChild(panel);
    });
  }
  panel.hidden=false;
  return panel;
}

async function downloadAssetRefs(refs, filename, {prepare,host}={}) {
  if(ctDownloading)throw new Error("已有一项素材正在打包或下载");
  ctDownloading=true;ctRenderSelectionTools();
  const panel=ctTransferPanel(host), state=$("[data-transfer-state]",panel), name=$("[data-transfer-name]",panel);
  const progress=$("progress",panel), close=$("[data-transfer-close]",panel);
  close.hidden=true;
  state.textContent="正在准备素材";
  progress.hidden=false;progress.removeAttribute("value");
  name.textContent=filename;
  try{
    await prepare?.();
    let item=await boardRequest("/api/assets/transfers","POST",{refs:[...new Set(refs)],name:filename});
    const path="/api/assets/transfers/"+encodeURIComponent(item.id);
    let requested=null;
    while(true){
      state.textContent=CT_TRANSFER_TEXT[item.state]||"正在准备素材";
      name.textContent=item.name;
      if(item.total>0){progress.max=item.total;progress.value=Math.min(item.total,item.bytes);}
      if(item.state==="sent")return;
      if(item.state==="error")throw new Error(item.error||"下载失败");
      if(item.state==="ready"){
        if(requested===null){
          const link=document.createElement("a");
          link.href=path+"/file";link.download=item.name;link.target="assetTransferDownload";
          document.body.append(link);link.click();link.remove();
          requested=Date.now();
        }else if(Date.now()-requested>15000){
          throw new Error("浏览器未继续下载，请重新发起");
        }
      }
      await sleep(450);
      item=await boardRequest(path);
    }
  }catch(error){
    progress.hidden=true;
    state.textContent=error.message||"下载失败";
    throw error;
  }finally{
    close.hidden=false;ctDownloading=false;ctRenderSelectionTools();
  }
}

async function ctDownload(nodes=ctSelected()) {
  const refs = ctDownloadable(nodes);
  if (!refs.length) return toast("选中节点还没有可下载的素材");
  if (ctDownloading) return;
  try {
    await downloadAssetRefs(refs,(B.name || "OneShot")+"-素材.zip",{prepare:flushSave});
  } catch (err) { toast(err.message,5000); }
}
function ctAction(action) {
  if (action === "download") return ctDownload();
  if (!canvasCanEdit()) return;
  if (action === "generate") return openCanvasSelectionRun(byPosition([...sel]));
  if (action === "collect") return alOpenCanvasImport(byPosition([...sel]));
  if (action === "fold") return ctGroup(true);
  if (action === "group") return ctGroup();
  if (action === "ungroup") return ctUngroup();
  const chosen = ctSelected().filter(n => !nodeLocked(n));
  const minimum = action.startsWith("distribute") ? 3 : 2;
  if (chosen.length < minimum) return toast(`至少需要 ${minimum} 个未锁定的节点`);
  const targets = new Set(chosen.map(n => n.id));
  const fixed = [...B.nodes.filter(n => !targets.has(n.id) && !ctFolded(n.id)), ...CT_FOLD_BOXES.values()];
  const positions = ctPositions(chosen,action,size,fixed);
  checkpoint();
  for (const {id,x,y} of positions) { const n = node(id); Object.assign(n,{x,y}); render(n); }
  drawEdges(); drawMini(); placeOverlays(); save();
}
function ctRenderSelectionTools(){const box=$("#selectionTools");if(!box || !B)return;const nodes=ctSelected();box.classList.toggle("on",nodes.length>1);if(nodes.length<2)return;
  const edit=canvasCanEdit(), playlist=edit&&nodes.filter(playlistVideo).length>=2;
  const collect=edit&&nodes.some(alCanvasCollectable), generate=edit&&nodes.some(groupGeneratable);
  const key=nodes.map(n=>n.id).sort().join(",")+":"+playlist+":"+edit+":"+collect+":"+generate;if(box.dataset.key!==key){box.dataset.key=key;box.innerHTML=CT_ACTIONS.map(([action,label,path])=>`<button data-action="${action}" aria-label="${label}" data-tip="${label}"><svg class="i" aria-hidden="true"><path d="${path}"/></svg></button>`).join("");
    if(generate)box.insertAdjacentHTML("afterbegin",`<button data-action="generate" aria-label="批量生成选中节点" data-tip="批量生成选中节点">${ico("motion")}</button>`);
    if(edit)box.insertAdjacentHTML("beforeend",`<button data-action="fold" aria-label="收起为一组" data-tip="收起为一组">${ico("stack")}</button>`);
    if(edit)box.insertAdjacentHTML("beforeend",`<button data-action="pin" aria-label="颜色标记" data-tip="颜色标记">${ico("tag")}</button>`);
    if(collect)box.insertAdjacentHTML("beforeend",OneShotI18n.html`<button data-action="collect" aria-label="收录到资产库" data-tip="收录到资产库">${ico("assets")}</button>`);
    if(playlist)box.insertAdjacentHTML("beforeend",`<button data-action="playlist" aria-label="创建播放列表" data-tip="创建播放列表">${ico("stack")}</button>`);
    $$("button",box).forEach(button=>{
      button.onclick=()=>{
        hideNodeToolTip();
        if(button.dataset.action==="playlist")return createFilmPlaylist(byPosition([...sel]));
        if(button.dataset.action==="pin")return openNodePinMenu(button);
        ctAction(button.dataset.action);
      };
      button.onmouseenter=button.onfocus=()=>showNodeToolTip(button);
      button.onmouseleave=button.onblur=hideNodeToolTip;
    });}
  $("[data-action=download]",box).disabled=ctDownloading||!ctDownloadable(nodes).length;
  ctPlaceSelectionTools();}
function ctPlaceSelectionTools(){const box=$("#selectionTools");if(!box?.classList.contains("on"))return;const selected=ctSelected();if(selected.length<2){box.classList.remove("on");return;}const rects=selected.map(n=>$(".card",els.get(n.id))?.getBoundingClientRect()).filter(Boolean);if(!rects.length)return;const center=(Math.min(...rects.map(r=>r.left))+Math.max(...rects.map(r=>r.right)))/2;box.style.left=Math.max(8,Math.min(innerWidth-box.offsetWidth-8,center-box.offsetWidth/2))+"px";box.style.top=Math.max(64,Math.min(innerHeight-50,Math.min(...rects.map(r=>r.top))-58))+"px";}
function initCanvasTools(){const style=document.createElement("style");style.textContent=`#selectionTools{position:fixed;z-index:20;display:none;gap:2px;padding:4px;max-width:calc(100vw - 16px);overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:0 8px 30px #0006}#selectionTools.on{display:flex}#selectionTools button{display:flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;background:none;border:0;border-radius:8px;color:var(--dim)}#selectionTools button:hover,#selectionTools button:focus-visible{background:#ffffff12;color:var(--text)}`;document.head.append(style);const box=document.createElement("div");box.id="selectionTools";box.setAttribute("role","toolbar");box.setAttribute("aria-label","多选节点操作");document.body.append(box);initCanvasGroups();}
