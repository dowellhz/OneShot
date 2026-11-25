"use strict";

// ================================================================= image tools: 反推, 宫格拆分, 高清重绘, 资产
async function describeImage(n) {
  const v = curV(n); if (!v) return toast("还没有图片");
  await withBusy(n, "Qwen 看图反推中", async () => {
    const r = await api("/api/describe", { images: [{ ref: v.ref, name: n.name }], mode: "prompt" });
    checkpoint();
    if (!n.data.caption) n.data.caption = r.text.slice(0, 300);
    const at = placeRight(n, "text"), t = addNode("text", at.x, at.y, { text: r.text }, { name: n.name + " · 反推" });
    selectOnly(t.id); toast(`已反推出提示词（${r.seconds}s）${llmNote(r)}，连到图片或视频节点即可使用`, 3500);
  });
}
async function splitGrid(n, rows, cols) {
  const v = curV(n); if (!v) return toast("还没有图片");
  const board=B, angles=v.image_grid&&rows===3&&cols===3 ? GRID9_ANGLES : null;
  await withBusy(n, "拆分中", async () => {
    const r = await api("/api/split", { ref: v.ref, rows, cols });
    if(board!==B || node(n.id)!==n || !canvasCanEdit())return;
    checkpoint();
    const s = size(n), x0 = n.x + s.w + 110, made = [];
    let tw = 0, th = 0;
    for (const t of r.tiles) {
      const title=angles?.[t.row*cols+t.col] || `${t.row+1}-${t.col+1}`;
      const m = addNode("image", 0, 0, { caption: n.data.caption || (v.prompt || "").slice(0, 200), aspect: "auto" }, { name: `${n.name} · ${title}` });
      m.versions.push({ ref: t.ref, url: t.url, w: t.w, h: t.h, source: "tile", prompt: "" }); m.cur = 0;
      const z = size(m); tw = z.w; th = z.h; made.push([m, t]);
    }
    // park the whole grid to the right of the image, past anything already there
    const gw = cols * (tw + 30), gh = rows * (th + 56), mine = new Set(made.map(([m]) => m.id));
    let gx = x0;
    for (let k = 0; k < 50; k++) {
      const hit = B.nodes.find(o => !mine.has(o.id) && o.id !== n.id && (() => { const z = size(o); return gx < o.x + z.w + 40 && gx + gw > o.x && n.y < o.y + z.h + 40 && n.y + gh > o.y - 40; })());
      if (!hit) break; gx = hit.x + size(hit).w + 80;
    }
    for (const [m, t] of made) { m.x = Math.round(gx + t.col * (tw + 30)); m.y = Math.round(n.y + t.row * (th + 56)); render(m); }
    drawEdges(); save(); sel = new Set(made.map(([m]) => m.id)); updateSel();
    toast(`已拆成 ${rows}×${cols} 张，可以选中某一张点「高清」放大，或连到视频当首帧`, 3500);
  });
}
async function hdRedraw(n) {
  if (!curV(n)) return toast("还没有图片");
  checkpoint();
  const at = placeRight(n, "image");
  const m = addNode("image", at.x, at.y, { prompt: "高清重绘：保持 @图1 的构图、人物长相、表情、服装、场景和色彩完全一致，提升清晰度和细节，去除模糊、噪点和压缩痕迹", aspect: "auto", quality: "4mp" }, { name: n.name + " · 高清" });
  link(n, m, true); selectOnly(m.id); generate(m);
}
