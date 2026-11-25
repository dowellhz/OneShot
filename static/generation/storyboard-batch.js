"use strict";

async function batchImages(n) {
  const board=B;
  const shots=madeShots(n);
  const todo = [...new Set(shots.flatMap(shotFrameIds))].map(node)
    .filter(m => m && !storyboardFrameReady(m) && !m.job && !prepping.has(m.id));
  if (!todo.length) return toast("分镜图都已经生成了；想重画某一张就选中它单独生成");
  if(shots.some(pair=>pair.motion_frames))return openCanvasSelectionRun(todo);
  let queued=0;
  for (const m of todo){
    if(B!==board || node(n.id)!==n)return;
    if(node(m.id)!==m || !fullPrompt(m))continue;
    await generate(m);
    if(m.job)queued++;
  }
  if(B!==board || node(n.id)!==n)return;
  const skipped=todo.length-queued;
  toast(`已提交 ${queued} 张分镜图${skipped?`，${skipped} 张未提交，请检查提示词或参考图`:""}`,3000);
}
async function batchVideos(n) {
  const board=B, all = madeShots(n), ready = [], wait = [];
  for (const x of all) { const v = node(x.vid); if (!v || v.job || storyboardVersionReady(v)) continue;
    const shot=n.data.shots.find(item=>item.id===x.shot_id);
    (node(x.img)&&!missingMotionFrames(shot,x)&&shotFrameIds(x).every(id=>node(id)&&storyboardFrameReady(node(id))) ? ready : wait).push(v); }
  if (!ready.length) return toast(wait.length ? "分镜图还没生成好，先点「批量出分镜图」" : "视频都已经生成了；想重做某一镜就选中它单独生成");
  let queued=0;
  for (const v of ready) {
    if(B!==board||node(n.id)!==n)return;
    if(node(v.id)!==v)continue;
    await generate(v);
    if(v.job)queued++;
  }
  if(B!==board||node(n.id)!==n)return;
  const failed=ready.length-queued;
  const status=[queued?`已排队 ${queued} 段视频`:"",failed?`${failed} 段未提交，可查看失败原因后重试`:"",wait.length?`${wait.length} 镜等待分镜图`:""];
  toast(status.filter(Boolean).join("，"),4000);
}
