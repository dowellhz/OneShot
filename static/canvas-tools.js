"use strict";
const CT_GROUPS=new Map();
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
function ctPositions(nodes,operation,sizeOf=size) {
  if(nodes.length<2)return [];
  const items=nodes.map(n=>({id:n.id,x:n.x,y:n.y,...sizeOf(n)}));
  const x0=Math.min(...items.map(n=>n.x)),y0=Math.min(...items.map(n=>n.y)),x1=Math.max(...items.map(n=>n.x+n.w)),y1=Math.max(...items.map(n=>n.y+n.h));
  if(operation==="distributeX" || operation==="distributeY") {
    if(items.length<3)return [];
    const axis=operation==="distributeX" ? "x" : "y",dim=axis==="x" ? "w" : "h";items.sort((a,b)=>a[axis]-b[axis]);
    const min=items[0][axis],max=items[items.length-1][axis]+items[items.length-1][dim],gap=(max-min-items.reduce((s,n)=>s+n[dim],0))/(items.length-1);
    let cursor=min;for(const n of items){n[axis]=Math.round(cursor);cursor+=n[dim]+gap;}
  } else for(const n of items) {
    if(operation==="left")n.x=x0;else if(operation==="right")n.x=x1-n.w;else if(operation==="centerX")n.x=Math.round((x0+x1-n.w)/2);
    else if(operation==="top")n.y=y0;else if(operation==="bottom")n.y=y1-n.h;else if(operation==="centerY")n.y=Math.round((y0+y1-n.h)/2);
  }
  return items.map(({id,x,y})=>({id,x,y}));
}
function ctSelected(){return [...sel].map(node).filter(Boolean);}
const ctMedia=n=>n && (n.type==="image" || n.type==="video");
function ctGridPositions(nodes,obstacles=[],sizeOf=size){
  if(nodes.length<2)return [];
  const items=nodes.map(n=>({id:n.id,x:n.x,y:n.y,...sizeOf(n)})).sort((a,b)=>a.y-b.y || a.x-b.x || a.id.localeCompare(b.id));
  const columns=Math.ceil(Math.sqrt(items.length)),gapX=120,gapY=100;
  const x0=Math.min(...items.map(n=>n.x)),y0=Math.min(...items.map(n=>n.y));
  const widths=Array.from({length:columns},(_,col)=>Math.max(...items.filter((_,i)=>i%columns===col).map(n=>n.w)));
  const lefts=widths.map((_,i)=>x0+widths.slice(0,i).reduce((sum,w)=>sum+w+gapX,0));
  let y=y0;
  for(let i=0;i<items.length;i+=columns){const row=items.slice(i,i+columns);row.forEach((n,col)=>{n.x=lefts[col];n.y=y;});y+=Math.max(...row.map(n=>n.h))+gapY;}
  // Keep fixed nodes where they are; move the whole grid below any collision.
  const fixed=obstacles.map(n=>({...n,...sizeOf(n)}));let offset=0;
  for(let pass=0;pass<fixed.length;pass++){
    const hits=fixed.filter(o=>items.some(n=>n.x<o.x+o.w+60 && n.x+n.w+60>o.x && n.y+offset<o.y+o.h+60 && n.y+n.h+offset+60>o.y));
    if(!hits.length)break;
    offset=Math.max(offset,...hits.map(o=>o.y+o.h+gapY-y0));
  }
  return items.map(({id,x,y})=>({id,x:Math.round(x),y:Math.round(y+offset)}));
}
function ctArrange(action,ids){
  const nodes=ids.map(node).filter(ctMedia);
  if(nodes.length<2)return toast("至少需要两个图片或视频节点");
  const targets=new Set(nodes.map(n=>n.id));
  const positions=action==="grid" ? ctGridPositions(nodes,B.nodes.filter(n=>!targets.has(n.id))) : ctPositions(nodes,action);
  if(!positions.length)return toast("等距排列至少需要三个图片或视频节点");
  if(!positions.some(p=>{const n=node(p.id);return n.x!==p.x || n.y!==p.y;}))return toast("这些节点已经对齐");
  checkpoint();for(const p of positions){const n=node(p.id);n.x=p.x;n.y=p.y;render(n);}
  drawEdges();drawMini();placeOverlays();save();toast("已整理 "+nodes.length+" 个节点，可按 ⌘/Ctrl Z 撤销");
}
function ctOpenArrangeMenu(x,y){
  closeMenus();const bid=boardId,selected=ctSelected().filter(ctMedia).map(n=>n.id),all=B.nodes.filter(ctMedia).map(n=>n.id);
  let m=$("#arrangeMenu");if(!m){m=document.createElement("div");m.id="arrangeMenu";m.className="menu";document.body.append(m);}
  m.innerHTML=`<div class="mt">整理对齐</div><label class="ct-arrange-scope">范围<select aria-label="整理范围"><option value="selected">选中的图片与视频（${selected.length}）</option><option value="all">全部图片与视频（${all.length}）</option></select></label><button data-layout="grid">${ico("assets")}网格整理</button><div class="sep"></div>`+
    CT_ACTIONS.slice(0,8).map(([action,label,path])=>`<button data-layout="${action}"><svg class="i" aria-hidden="true"><path d="${path}"/></svg>${label}</button>`).join("")+`<div class="ct-arrange-note">只调整位置，支持撤销</div>`;
  const select=$("select",m);select.value=selected.length>=2 ? "selected" : "all";
  const chosen=()=>select.value==="selected" ? selected : all;
  const update=()=>{$$("[data-layout]",m).forEach(b=>{const min=b.dataset.layout.startsWith("distribute")?3:2;b.disabled=chosen().length<min;b.title=b.disabled?`至少需要 ${min} 个图片或视频节点`:"";});$(".ct-arrange-note",m).textContent=chosen().length<2?"至少需要两个图片或视频节点":"只调整位置，支持撤销";};
  select.onchange=update;update();
  $$("[data-layout]",m).forEach(b=>b.onclick=()=>{const ids=chosen();closeMenus();if(boardId===bid)ctArrange(b.dataset.layout,ids);});
  m.classList.add("on");m.style.left=Math.max(8,Math.min(x,innerWidth-m.offsetWidth-8))+"px";m.style.top=Math.max(8,Math.min(y,innerHeight-m.offsetHeight-8))+"px";
}
function ctGroupBounds(nodes){const rects=nodes.map(n=>({...n,...size(n)}));return {x:Math.min(...rects.map(n=>n.x))-20,y:Math.min(...rects.map(n=>n.y))-64,right:Math.max(...rects.map(n=>n.x+n.w))+20,bottom:Math.max(...rects.map(n=>n.y+n.h))+20};}
function ctGroup(){const nodes=ctSelected();if(nodes.length<2)return toast("至少选择两个节点");checkpoint();const ids=nodes.map(n=>n.id),chosen=new Set(ids);B.groups=(B.groups||[]).map(g=>({...g,nodes:g.nodes.filter(id=>!chosen.has(id))})).filter(g=>g.nodes.length);B.groups.push({id:"g"+Date.now().toString(36)+Math.random().toString(36).slice(2,6),name:"分组 "+((B.groups||[]).length+1),nodes:ids});drawEdges();save();toast("已编组，拖动分组标题可整体移动");}
function ctUngroup(ids=sel){const chosen=new Set(ids),groups=(B.groups||[]).filter(g=>g.nodes.some(id=>chosen.has(id)));if(!groups.length)return toast("选中的节点没有编组");checkpoint();const remove=new Set(groups.map(g=>g.id));B.groups=B.groups.filter(g=>!remove.has(g.id));ctRenderGroups();save();toast("已取消编组");}
async function ctDownload(){const refs=[...new Set(ctSelected().map(curV).filter(Boolean).map(v=>v.ref))];if(!refs.length)return toast("选中节点还没有可下载的素材");if(CT_GROUPS.downloading)return;CT_GROUPS.downloading=true;try{await flushSave();toast("正在打包 "+refs.length+" 个素材…",60000);const r=await fetch("/api/assets/export",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({refs})});if(!r.ok){const p=await r.json();throw new Error(p.error || "打包失败");}const blob=await r.blob(),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=(B.name || "OneShot")+"-素材.zip";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast("已打包 "+refs.length+" 个素材");}catch(err){toast(err.message,5000);}finally{CT_GROUPS.downloading=false;}}
function ctAction(action){if(action==="group")return ctGroup();if(action==="ungroup")return ctUngroup();if(action==="download")return ctDownload();const positions=ctPositions(ctSelected(),action);if(!positions.length)return toast("等距排列至少需要三个节点");checkpoint();for(const p of positions){const n=node(p.id);Object.assign(n,{x:p.x,y:p.y});render(n);}drawEdges();drawMini();placeOverlays();save();}
function ctRenderSelectionTools(){const box=$("#selectionTools");if(!box || !B)return;const nodes=ctSelected();box.classList.toggle("on",nodes.length>1);if(nodes.length<2)return;
  const key=nodes.map(n=>n.id).sort().join(",");if(box.dataset.key!==key){box.dataset.key=key;box.innerHTML=CT_ACTIONS.map(([action,label,path])=>`<button data-action="${action}" aria-label="${label}" data-tip="${label}"><svg class="i" aria-hidden="true"><path d="${path}"/></svg></button>`).join("");$$("button",box).forEach(button=>{button.onclick=()=>{hideNodeToolTip();ctAction(button.dataset.action);};button.onmouseenter=button.onfocus=()=>showNodeToolTip(button);button.onmouseleave=button.onblur=hideNodeToolTip;});}ctPlaceSelectionTools();}
function ctPlaceSelectionTools(){const box=$("#selectionTools");if(!box?.classList.contains("on"))return;const rects=ctSelected().map(n=>$(".card",els.get(n.id))?.getBoundingClientRect()).filter(Boolean);if(!rects.length)return;const center=(Math.min(...rects.map(r=>r.left))+Math.max(...rects.map(r=>r.right)))/2;box.style.left=Math.max(8,Math.min(innerWidth-box.offsetWidth-8,center-box.offsetWidth/2))+"px";box.style.top=Math.max(64,Math.min(innerHeight-50,Math.min(...rects.map(r=>r.top))-58))+"px";}
function ctRenderGroups(){if(!B || !world)return;const groups=B.groups || [],keep=new Set();for(const group of groups){const nodes=group.nodes.map(node).filter(Boolean);if(!nodes.length)continue;keep.add(group.id);let el=CT_GROUPS.get(group.id);if(el && (!el.isConnected || el._group!==group)){el.remove();CT_GROUPS.delete(group.id);el=null;}if(!el){el=document.createElement("div");el.className="canvas-group";el._group=group;el.innerHTML=`<div class="cg-head"><input aria-label="分组名称"><button aria-label="选择分组" title="选中整组">${ico("select")}</button><button aria-label="取消编组" title="取消编组">${ico("minus")}</button></div>`;world.insertBefore(el,world.firstChild);CT_GROUPS.set(group.id,el);
      const input=$("input",el);input.onpointerdown=e=>e.stopPropagation();input.onfocus=()=>{input._before=input.value;};input.onblur=()=>{if(input.value.trim() && input.value!==group.name){checkpoint();group.name=input.value.trim().slice(0,60);save();}input.value=group.name;};input.onkeydown=e=>{e.stopPropagation();if(e.key==="Enter")input.blur();};
      const buttons=$$("button",el);buttons[0].onclick=e=>{e.stopPropagation();sel=new Set(group.nodes.filter(id=>node(id)));updateSel();};buttons[1].onclick=e=>{e.stopPropagation();ctUngroup(group.nodes);};
      $(".cg-head",el).onpointerdown=e=>{if(e.button!==0 || e.target.closest("button,input"))return;e.preventDefault();e.stopPropagation();sel=new Set(group.nodes.filter(id=>node(id)));updateSel();const start={x:e.clientX,y:e.clientY},orig=group.nodes.map(node).filter(Boolean).map(n=>({n,x:n.x,y:n.y}));let moved=false;const before=snap();const move=ev=>{const dx=(ev.clientX-start.x)/B.view.k,dy=(ev.clientY-start.y)/B.view.k;if(!moved && Math.abs(dx)+Math.abs(dy)<3)return;moved=true;for(const o of orig){o.n.x=Math.round(o.x+dx);o.n.y=Math.round(o.y+dy);render(o.n);}drawEdges();drawMini();placeOverlays();};const end=()=>{removeEventListener("pointermove",move);removeEventListener("pointerup",end);removeEventListener("pointercancel",end);if(moved){undoStack.push(before);redoStack.length=0;save();}};addEventListener("pointermove",move);addEventListener("pointerup",end);addEventListener("pointercancel",end);};
    }
    const input=$("input",el);if(document.activeElement!==input)input.value=group.name;const r=ctGroupBounds(nodes);Object.assign(el.style,{left:r.x+"px",top:r.y+"px",width:(r.right-r.x)+"px",height:(r.bottom-r.y)+"px"});}
  for(const [id,el]of CT_GROUPS)if(!keep.has(id)){el.remove();CT_GROUPS.delete(id);}}
function initCanvasTools(){const style=document.createElement("style");style.textContent=`#selectionTools{position:fixed;z-index:20;display:none;gap:2px;padding:4px;max-width:calc(100vw - 16px);overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:0 8px 30px #0006}#selectionTools.on{display:flex}#selectionTools button{display:flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;background:none;border:0;border-radius:8px;color:var(--dim)}#selectionTools button:hover,#selectionTools button:focus-visible{background:#ffffff12;color:var(--text)}.canvas-group{position:absolute;pointer-events:none;border:1px dashed var(--line2);border-radius:18px;background:#ffffff02}.canvas-group .cg-head{position:absolute;left:0;right:0;top:0;height:30px;display:flex;align-items:center;gap:6px;padding:0 10px;pointer-events:auto;cursor:grab}.cg-head input{min-width:0;flex:1;max-width:180px;border:0;background:transparent;color:var(--dim);font:var(--fs-small) var(--font);cursor:text}.cg-head button{display:flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;background:var(--card-hi);border-radius:6px;color:var(--dim);cursor:pointer}.cg-head button:first-of-type{margin-left:auto}.cg-head svg.i{width:14px;height:14px}`;document.head.append(style);const box=document.createElement("div");box.id="selectionTools";box.setAttribute("role","toolbar");box.setAttribute("aria-label","多选节点操作");document.body.append(box);}
