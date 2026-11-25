"use strict";

async function pvImportModel(E,picked) {
  if (!picked.length || !pvValidNode(E)) return;
  if (E.scene.objects.length>=24) return pvStatus("一个场景最多包含 24 个物体");
  const main=picked.filter(file=>/\.(glb|gltf)$/i.test(file.name));
  if (main.length>1) return pvStatus("每次请选择一个 GLB 或 glTF 模型");
  const file=main[0] || E.modelImport?.file;
  if (!file || file.size>PV_MODEL_SIZE) return pvStatus("请选择 12 MiB 以内的 GLB 或 glTF 模型");
  const files=new Map(main.length?[]:E.modelImport.files);
  const selected=picked.filter(part=>part!==file);
  if (new Set(selected.map(part=>part.name)).size!==selected.length) return pvStatus("所选的配套文件有重名，请检查文件名");
  selected.forEach(part=>files.set(part.name,part));
  const button=pvElement("[data-pv-import-model]");
  E.modelImport=null;
  button.textContent="导入 3D 模型";
  pvPause(E);
  E.sending=true;
  pvUpdateRenderState(E.n);
  try {
    const used=E.scene.objects.reduce((total,item)=>total+(item.shape==="mesh"?item.triangles.length:0),0);
    const available=PV_TRIANGLE_LIMIT-used;
    const {triangles,dimensions:[width,height,depth]}=/\.gltf$/i.test(file.name) ?
      await pvReadGltf(file,files,available) : pvReadGlb(await file.arrayBuffer(),available);
    if (!pvValidNode(E)) return;
    if (!pvFaces({shape:"mesh",triangles}).length) throw new Error("模型没有可显示的三角面");
    const id=newCanvasNodeId(), label=file.name.replace(/\.(gltf|glb)$/i,"").trim().slice(0,40)||"导入模型";
    E.scene.objects.push({id,label,shape:"mesh",triangles,width,height,depth,
      keys:[{t:0,x:0,y:0,z:0,yaw:0,ease:"linear"}]});
    E.active=id;
    pvRefreshTrack(E);
    pvStatus(`已导入 ${label} · ${triangles.length} 个三角面`);
  } catch(error) {
    if (error.missingBuffers) {
      E.modelImport={file,files};
      button.textContent="补选模型文件";
    }
    pvStatus(error.message);
  } finally {
    E.sending=false;
    pvUpdateRenderState(E.n);
  }
}
