"use strict";

const undoStack = [], redoStack = [];
let historyEpoch = 0;
function canvasHistoryState(board) {
  return { nodes: board.nodes.map(n => ({ ...n, job: null })), edges: board.edges || [], groups: board.groups || [] };
}
function snap() {
  return JSON.stringify({ ...canvasHistoryState(B), seq: B.seq, epoch: historyEpoch });
}
function rebaseCanvasHistory(incoming) {
  const base = JSON.parse(JSON.stringify(canvasHistoryState(B)));
  const remote = canvasHistoryState({ ...B, ...incoming });
  if (JSON.stringify(base) === JSON.stringify(remote)) return;
  const previousEpoch = historyEpoch++;
  const dangling = state => {
    const ids = new Set(state.nodes.map(n => n.id));
    const references = state.edges.flatMap(e => [e?.from, e?.to]);
    references.push(...state.groups.flatMap(g => Array.isArray(g?.nodes) ? g.nodes : []));
    return new Set(references.filter(id => id && !ids.has(id)));
  };
  const existingDangling = dangling(remote);
  for (const stack of [undoStack, redoStack]) {
    for (let i = stack.length - 1; i >= 0; i--) {
      const { seq, epoch, ...snapshot } = JSON.parse(stack[i]);
      if (epoch !== previousEpoch) { stack.splice(i, 1); continue; }
      try {
        const merged = acMerge(base, snapshot, remote);
        if ([...dangling(merged)].some(id => !existingDangling.has(id))) throw new Error("节点有新的引用");
        stack[i] = JSON.stringify({ ...merged, seq, epoch: historyEpoch });
      } catch {
        stack.splice(0, i + 1);
        break;
      }
    }
  }
}
function checkpoint(before) {
  if (before && JSON.parse(before).epoch !== historyEpoch) return;
  undoStack.push(before || snap());
  if (undoStack.length > 80) undoStack.shift();
  redoStack.length = 0;
}
function restore(s) {
  const o = typeof s === "string" ? JSON.parse(s) : s;
  const jobs = new Map(B.nodes.filter(n => n.job).map(n => [n.id, n.job]));
  if(document.activeElement?.matches("#prompt,#pfields textarea"))document.activeElement._before=null;
  clearDeletedAssetBindings(o.nodes);
  B.nodes = o.nodes; B.edges = o.edges; B.groups = o.groups || []; B.seq = Math.max(B.seq, o.seq);
  B.nodes.forEach(n => { if (jobs.has(n.id)) n.job = jobs.get(n.id); });
  $("#prompt")._node=null; $("#pfields")._node=null;
  rebuild(); showPanel(); save();
  $("#shotList")?.dispatchEvent(new Event("canvas-restored"));
  if(document.activeElement?.matches("#prompt,#pfields textarea"))document.activeElement._before=snap();
}
function stepCanvasHistory(source, destination) {
  while (source.length) {
    const saved = JSON.parse(source.pop());
    if (saved.epoch !== historyEpoch) continue;
    destination.push(snap());
    restore(saved);
    return;
  }
}
function undo() { stepCanvasHistory(undoStack, redoStack); }
function redo() { stepCanvasHistory(redoStack, undoStack); }
