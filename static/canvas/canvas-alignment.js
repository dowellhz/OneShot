"use strict";

const CANVAS_GRID_STEP = 22;
const canvasLayout = {
  guides: localStorage.getItem("h3.canvasGuides") === "1",
  grid: localStorage.getItem("h3.canvasGrid") === "1",
};

function canvasDragBounds(nodes) {
  const rects = nodes.map(n => ({x:n.x,y:n.y,...size(n)}));
  const x = Math.min(...rects.map(r => r.x)), y = Math.min(...rects.map(r => r.y));
  return {x,y,w:Math.max(...rects.map(r => r.x + r.w)) - x,h:Math.max(...rects.map(r => r.y + r.h)) - y};
}

function canvasAlignment(rect, targets, axis, tolerance, reach) {
  const horizontal = axis === "x";
  const cross = horizontal ? "y" : "x", span = horizontal ? "w" : "h", depth = horizontal ? "h" : "w";
  const start = rect[axis], length = rect[span];
  const points = [start, start + length / 2, start + length];
  let closest = null, distance = tolerance, weakest = Infinity;
  for (const target of targets) {
    const crossGap = Math.max(0, target[cross] - rect[cross] - rect[depth], rect[cross] - target[cross] - target[depth]);
    if (crossGap > reach || target[axis] > start + length + distance || target[axis] + target[span] < start - distance) continue;
    const anchors = [target[axis], target[axis] + target[span] / 2, target[axis] + target[span]];
    for (let i = 0; i < points.length; i++) {
      for (let j = 0; j < anchors.length; j++) {
        if ((i === 1) !== (j === 1)) continue;
        const delta = anchors[j] - points[i], gap = Math.abs(delta);
        if (gap > distance || gap === distance && crossGap >= weakest) continue;
        distance = gap;
        weakest = crossGap;
        closest = {delta, at:anchors[j], target};
      }
    }
  }
  return closest;
}

function canvasGridPosition(value) {
  const offset = CANVAS_GRID_STEP / 2; // The dots sit at the centers of the background tiles.
  return Math.round((value - offset) / CANVAS_GRID_STEP) * CANVAS_GRID_STEP + offset;
}

function drawCanvasGuides(rect, vertical, horizontal) {
  const layer = $("#canvasDragGuides");
  const view = B.view;
  const guides = [vertical,horizontal];
  [...layer.children].forEach((line,i) => {
    const match = guides[i];
    line.style.display = match ? "" : "none";
    if (!match) return;
    const {at,target} = match, cross = i ? "x" : "y", span = i ? "w" : "h";
    const start = Math.min(rect[cross],target[cross]) * view.k + view[cross] - 8;
    const end = Math.max(rect[cross] + rect[span],target[cross] + target[span]) * view.k + view[cross] + 8;
    const fixed = at * view.k + (i ? view.y : view.x);
    const coords = i ? [start,fixed,end,fixed] : [fixed,start,fixed,end];
    ["x1","y1","x2","y2"].forEach((attr,j) => line.setAttribute(attr,coords[j]));
  });
}

function clearCanvasGuides() {
  for (const line of $("#canvasDragGuides").children) line.style.display = "none";
}

function canvasDragPlacement(moving, frame, groupId) {
  if (!canvasLayout.guides && !canvasLayout.grid) return (x,y) => ({x,y});
  const bounds = frame || canvasDragBounds(moving);
  const excluded = new Set(moving.map(n => n.id));
  excluded.add(groupId);
  const targets = canvasLayout.guides ? ctCanvasRects().filter(r => !excluded.has(r.id)) : [];
  return (x,y,bypass) => {
    if (bypass) { clearCanvasGuides(); return {x,y}; }
    const rect = {...bounds,x:bounds.x + x,y:bounds.y + y};
    const tolerance = 6 / B.view.k, reach = 280 / B.view.k;
    const vertical = canvasAlignment(rect,targets,"x",tolerance,reach);
    const horizontal = canvasAlignment(rect,targets,"y",tolerance,reach);
    const place = (axis,match) => match ? rect[axis] + match.delta : canvasLayout.grid ? canvasGridPosition(rect[axis]) : rect[axis];
    rect.x = place("x",vertical);
    rect.y = place("y",horizontal);
    drawCanvasGuides(rect,vertical,horizontal);
    return {x:rect.x - bounds.x,y:rect.y - bounds.y};
  };
}

function initCanvasAlignmentSettings() {
  const trigger = $("#canvasLayoutBtn"), panel = $("#canvasLayoutMenu");
  function toggle() {
    const open = !panel.classList.contains("on");
    closeMenus();
    if (!open) return;
    panel.classList.add("on");
    trigger.setAttribute("aria-expanded","true");
    const rect = trigger.getBoundingClientRect();
    panel.style.left = Math.max(8,Math.min(rect.left,innerWidth - panel.offsetWidth - 8)) + "px";
    panel.style.bottom = Math.max(8,innerHeight - rect.top + 8) + "px";
    $("input",panel).focus();
  }
  trigger.onclick = toggle;
  for (const input of $$("[data-canvas-layout]",panel)) {
    const key = input.dataset.canvasLayout;
    input.checked = canvasLayout[key];
    input.onchange = () => {
      canvasLayout[key] = input.checked;
      localStorage.setItem(key === "grid" ? "h3.canvasGrid" : "h3.canvasGuides",input.checked ? "1" : "0");
    };
  }
}
