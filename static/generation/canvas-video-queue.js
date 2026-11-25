"use strict";

// put several videos in the generation queue, in name order (视频 2 before 视频 10); each one is sent like a click on 生成
let queueing = false;
async function queueVideos(list) {
  if (queueing) return toast("正在排队，请稍等上一批提交完");
  list = list.filter(x => x && !x.job && !x.data.previs).sort((a, b) => a.name.localeCompare(b.name, "zh", { numeric: true }) || a.y - b.y || a.x - b.x);
  if (!list.length) return toast("没有需要排队的视频（正在生成的会跳过）");
  const board=boardId, epoch=boardOpenEpoch;
  queueing = true;
  let ok = 0;
  try {
    for (const [i, v] of list.entries()) {
      if (boardId!==board || boardOpenEpoch!==epoch) break;
      if (node(v.id)!==v) continue;
      toast(`正在提交 ${i + 1}/${list.length}：${v.name}`, 60000);
      await generate(v);
      if (v.job) ok++;
    }
  } finally { queueing = false; }
  const bad = list.length - ok;
  if (boardId!==board || boardOpenEpoch!==epoch) return;
  toast(`已提交 ${ok} 段视频${bad ? `，${bad} 段未提交成功，可查看节点提示` : ""}`, 6000);
}
