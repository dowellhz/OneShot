"use strict";

// ================================================================= video tools: 拉片, 看图填写, 拼接
async function analyzeVideo(n) {
  const v = curV(n); if (!v) return toast(OneShotI18n.t("还没有视频"));
  await withBusy(n, "拉片中：切镜头 + Qwen 分析", async () => {
    const r = await api("/api/analyze", { ref: v.ref });
    checkpoint();
    const at = placeRight(n, "script");
    const s = addNode("script", at.x, at.y, { prompt: `拉片：${r.title || n.name}`, title: r.title, style: r.style, characters: r.characters, shots: r.shots, aspect: v.w && v.h ? nearestAspect(v.w / v.h) : "16:9" }, { name: `拉片 · ${n.name}` });
    selectOnly(s.id);
    toast(`拆出 ${r.shots.length} 个镜头（${r.seconds}s）${llmNote(r)}。点「展开到画布」逐镜复刻；人物叫 人物1、人物2，可把自己的角色图改成这个名字连进来替换`, 6000);
  });
}
function nearestAspect(r) { return Object.entries(AR).reduce((a, b) => Math.abs(Math.log(b[1] / r)) < Math.abs(Math.log(a[1] / r)) ? b : a)[0]; }
async function fillFieldsFromImages(n) {
  const imgs = plan(n).imgs.map(m => ({ m, v: curV(m) })).filter(x => x.v).map(x => ({ ref: x.v.ref, name: x.m.name }));
  if (!imgs.length) return toast("先把首帧或人物图连到这个视频节点");
  await withBusy(n, "Qwen 看图填写中", async () => {
    const r = await api("/api/describe", { images: imgs, mode: "fields" });
    checkpoint(); const f = n.data.fields || (n.data.fields = {}); let c = 0;
    for (const [k, val] of Object.entries(r.fields)) if (val && !(f[k] || "").trim()) { f[k] = val; c++; }
    save(); $("#pfields")._node = null;
    toast(c ? `已按图片填好 ${c} 栏（只填空着的栏）${llmNote(r)}，动作和对话还需要你来写` : "这些栏都已经有内容了，没有覆盖", 3500);
  });
}
async function concatVideos(list) {
  const vids = list.filter(m => m && m.type === "video" && curV(m));
  if (!vids.length) return toast("还没有已生成的视频");
  openFilm(vids);
}
async function concatVideosNow(list, anchor) {
  const vids = list.filter(m => m && m.type === "video" && curV(m));
  if (vids.length < 2) return toast("至少需要两段已生成的视频");
  const host = anchor || vids[vids.length - 1];
  await withBusy(host, `拼接 ${vids.length} 段视频中`, async () => {
    const r = await api("/api/concat", { refs: vids.map(m => curV(m).ref) });
    checkpoint();
    const right = vids.reduce((a, b) => (b.x + size(b).w > a.x + size(a).w ? b : a));
    const at = freeSpot(right.x + size(right).w + 110, right.y, "video");
    const out = addNode("video", at.x, at.y, {}, { name: `成片（${vids.length} 段）` });
    out.versions.push(mediaVersion(r, { source: "concat", mode: "拼接" })); out.cur = 0; render(out); save(); selectOnly(out.id);
    toast(`已拼成 ${r.seconds.toFixed(1)} 秒成片，顺序：${vids.map(m => m.name).join(" → ")}`, 4000);
  });
}
const byPosition = ids => ids.map(node).filter(Boolean).sort((a, b) => (Math.abs(a.y - b.y) > 300 ? a.y - b.y : a.x - b.x));
