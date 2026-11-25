"use strict";

let pickCb = null;
function pickFiles(cb) { pickCb = cb; $("#file").click(); }
$("#file").onchange = e => { const f = [...e.target.files]; e.target.value = ""; if (f.length && pickCb) pickCb(f); pickCb = null; };
const CANVAS_CLIPBOARD_EXT = {
  "image/png":"png","image/jpeg":"jpg","image/webp":"webp",
  "video/mp4":"mp4","video/quicktime":"mov","video/webm":"webm",
  "audio/mpeg":"mp3","audio/wav":"wav","audio/x-wav":"wav","audio/mp4":"m4a",
  "audio/aac":"aac","audio/flac":"flac","audio/ogg":"ogg",
};
function canvasUploadKind(file) {
  if (CM_DOCUMENT_EXT.test(file.name)) return "text";
  if (/\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(file.name)) return "audio";
  if (/\.(mp4|mov|webm|m4v|mkv)$/i.test(file.name)) return "video";
  if (/\.(png|jpe?g|webp|ora)$/i.test(file.name)) return "image";
  if (file.type.startsWith("audio/") && CANVAS_CLIPBOARD_EXT[file.type]) return "audio";
  if (file.type.startsWith("video/")) return "video";
  return file.type.startsWith("image/") ? "image" : "";
}
const imgSize = url => new Promise(r => { const i = new Image(); i.onload = () => r([i.naturalWidth, i.naturalHeight]); i.onerror = () => r([0, 0]); i.src = url; });
const canvasMediaUploadTarget=n=>["image","video","audio"].includes(n.type)&&!n.data.film&&!n.data.previs;
const canvasCanUploadInto=n=>canvasCanEdit()&&canvasMediaUploadTarget(n)&&!n.job&&!prepping.has(n.id);
async function uploadInto(n, file) {
  if(!canvasCanUploadInto(n))return toast("当前节点暂时无法接收文件");
  showErr(n, "");
  const board=B,epoch=boardOpenEpoch;
  const current=()=>B===board&&boardOpenEpoch===epoch&&node(n.id)===n;
  prepping.add(n.id);
  try {
    const {name,data,version}=await readCanvasFile(file,n.type);
    if (!current()||!canvasCanEdit()||n.job) return;
    const before=snap();
    if (name && n.name.startsWith(TYPE_CN[n.type]+" ")) n.name=name;
    if (!n.data.caption && data.caption) n.data.caption=data.caption;
    addVersion(n,version,before);loadAssets();
  } catch (e) { if(current())showErr(n, "上传失败：" + e.message); }
  finally{prepping.delete(n.id);}
}
async function readCanvasFile(file, kind) {
  const body=new FormData(), stem=file.name.replace(/\.[^.]+$/,"");
  if(kind==="text"){
    body.append("file",file);
    const doc=await (await fetchOk("/api/document-import",{method:"POST",body})).json();
    if(doc.truncated || doc.text.length>20_000)throw new Error("正文超过单个画布文档的 20,000 字符上限");
    return {name:stem.slice(0,80),data:{text:doc.text,...(/\.(md|markdown)$/i.test(file.name)?{text_format:"markdown"}:{})}};
  }
  const extension=CANVAS_CLIPBOARD_EXT[file.type];
  const filename=/\.[^.]+$/.test(file.name) || !extension?file.name:`${stem||"paste"}.${extension}`;
  body.append(kind==="audio"?"file":"image",file,filename||"paste.png");
  const result=await (await fetchOk(kind==="audio"?"/api/upload_audio":"/api/upload",{method:"POST",body})).json();
  const [w,h]=kind==="image"&&!result.layer_stack?await imgSize(result.url):[result.w,result.h];
  const caption=stem.replace(/[-_ ]?\d+$/,"").replace(/^(image|paste|IMG|DSC|Screenshot).*$/i,"");
  return {name:stem.slice(0,kind==="audio"?40:24),data:kind==="image"?{caption}:{},
    version:{ref:result.ref,url:result.url,w,h,seconds:result.seconds,source:"upload",prompt:"",
      ...(result.layer_stack?{layer_stack:result.layer_stack,mode:"导入可编辑图层"}:{})}};
}
async function importCanvasFiles(files, at, target=null) {
  if (!canvasCanEdit() || !files.length) return;
  const board=B, epoch=boardOpenEpoch, imports=[], errors=[];
  const current=()=>B===board && boardOpenEpoch===epoch && canvasCanEdit();
  toast(`正在导入 ${files.length} 个文件…`);
  for(const file of files){
    if(!current())return;
    const kind=canvasUploadKind(file);
    if(!kind){errors.push(`${file.name}：不支持此格式`);continue;}
    try{imports.push({kind,...await readCanvasFile(file,kind)});}
    catch(error){errors.push(`${file.name}：${error.message}`);}
  }
  if(!current())return;
  if(imports.length){
    checkpoint();
    let x=at.x;
    for(const {kind,name,data,version} of imports){
      const extra=version?{versions:[version],cur:0}:{};
      const dims=size({type:kind,data:{...defaults(kind),...data},versions:extra.versions||[],cur:extra.cur??-1});
      const spot=freeSpot(x,at.y,kind,dims);
      const n=addNode(kind,spot.x,spot.y,data,{...extra,...(name?{name}:{})});
      if(target && node(target.id)===target && canLink(n,target))link(n,target,true);
      x=spot.x+dims.w+100;
    }
    if(imports.some(item=>item.version))loadAssets();
  }
  const completed=imports.length?`已导入 ${imports.length} 个文件`:"导入失败";
  toast(errors.length?`${completed} · ${errors.length} 个未导入 · ${errors[0]}`:completed,errors.length?5500:2200);
}
vp.addEventListener("dragover", e => e.preventDefault());
vp.addEventListener("drop", e => {
  e.preventDefault(); if (!canvasCanEdit()) return;
  const at = toW(e.clientX, e.clientY);
  const a = e.dataTransfer.getData("application/x-h3-asset");
  if (a) { placeAsset(JSON.parse(a), at); return; }
  void importCanvasFiles(Array.from(e.dataTransfer.files),at);
});
addEventListener("paste", e => {
  if (e.defaultPrevented || !canvasCanEdit() || e.target.closest?.("input, textarea, [contenteditable]:not([contenteditable=false]), [role=dialog]")) return;
  const files=Array.from(e.clipboardData?.files||[]);
  if(!files.some(canvasUploadKind))return;
  e.preventDefault();
  const kind=files.length===1&&canvasUploadKind(files[0]);
  const selected=sel.size===1?node([...sel][0]):null;
  if(selected?.type===kind && !curV(selected) && canvasCanUploadInto(selected)){
    void uploadInto(selected,files[0]);return;
  }
  void importCanvasFiles(files,toW(innerWidth/2-150,innerHeight/2-180));
});
