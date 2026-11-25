"use strict";

const removedAssetIds = new Set();

function clearDeletedAssetBindings(nodes) {
  const affected = [];
  for (const n of nodes) {
    let changed = false;
    if (removedAssetIds.has(n.data?.asset?.id)) {
      delete n.data.asset;
      changed = true;
    }
    if (removedAssetIds.has(n.data?.character_draft?.asset)) {
      delete n.data.character_draft;
      changed = true;
    }
    if (changed) affected.push(n);
  }
  return affected;
}

function unlinkDeletedAsset(id) {
  removedAssetIds.add(id);
  if (!B) return;
  const affected = clearDeletedAssetBindings(B.nodes);
  if (!affected.length) return;
  for (const n of affected) { render(n); refreshDownstream(n); }
  closeMenus();
  showPanel();
  save();
}

async function saveAsset(n, kind) {
  const v = curV(n); if (!v) return toast("还没有图片");
  const bid = boardId;
  const name = n.name.replace(/^图片 (\d+)$/, `${KIND_CN[kind]}$1`);
  try {
    await flushSave();
    if (bid !== boardId || node(n.id) !== n) return;
    const scope = n.data.asset?.id ? {} : cmNewScope();
    const a = await api("/api/library", { id: n.data.asset?.id, kind, name, desc: n.data.caption || (v.prompt || "").slice(0, 200), ref: v.ref, w: v.w, h: v.h, source_board: bid, node_id:n.id, ...scope, recreate_deleted:true });
    if (bid !== boardId || node(n.id) !== n) return;
    checkpoint(); n.name = a.name; n.data.asset = { id: a.id, kind }; save(); render(n); refreshDownstream(n); drawEdges();
    toast(`已存入资产库 · ${KIND_CN[kind]}「${a.name}」${kind === "character" ? "。之后新连到视频时默认作为人物设定" : ""}`, 3000);
    cmInvalidate(); loadAssets();
    if (kind === "character") cmEdit(a, kind);
  } catch (e) { toast("保存失败：" + e.message); }
}
