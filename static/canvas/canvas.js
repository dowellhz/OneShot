"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ico = (n, cls = "i") => `<svg class="${cls}"><use href="#i-${n}"/></svg>`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const AR = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:3": 4 / 3, "3:4": 3 / 4, "21:9": 21 / 9 };
const TYPE_CN = { text: "文本", image: "图片", video: "视频", audio: "音频", script: "分镜" };
const NODE_PINS = new Map([["blue","雾蓝"],["lilac","淡紫"],["amber","琥珀"],["rose","玫瑰"]]);
function nodePins(n) { return [...new Set((Array.isArray(n.pins)?n.pins:[n.pin]).filter(color=>NODE_PINS.has(color)))]; }
function renderNodePinBar() {
  const bar=$("#nodePinBar");
  if(!bar || !B)return;
  const counts=new Map();
  for(const n of B.nodes)for(const color of nodePins(n))counts.set(color,(counts.get(color)||0)+1);
  const markup=[...NODE_PINS].filter(([color])=>counts.has(color)).map(([color,label])=>
    `<button type="button" data-pin-color="${color}" aria-controls="nodeSearch" aria-label="${label}标记 · ${counts.get(color)} 个节点" title="${label}标记 · ${counts.get(color)} 个节点"><span class="node-pin" data-color="${color}" aria-hidden="true"></span><span aria-hidden="true">${counts.get(color)}</span></button>`).join("");
  if(bar._markup!==markup){bar._markup=markup;bar.innerHTML=markup;}
  bar.hidden=!markup;
}
const nodeLocked = n => n?.locked === true;

const vp = $("#vp"), world = $("#world"), svg = $("#edges");
let boardId = localStorage.getItem("h3.board") || "default";
let B = null;                         // board
const els = new Map();
let sel = new Set();
let selEdge = null;
const canvasCanEdit = () => B?.access !== "reviewer";
function canvasApplyAccess() {
  const readOnly = !canvasCanEdit();
  document.body.classList.toggle("review-only",readOnly);
  $("#bname").contentEditable = String(!readOnly);
  $("#boardAccessBadge").hidden = !readOnly;
  if (readOnly && AC.open) $("#acClose").click();
}

function emptyBoard(name = "我的画布") { return { name, nodes: [], edges: [], groups: [], view: { x: 0, y: 0, k: 1 }, seq: 1 }; }
function toast(m, ms = 2400) { const t = $("#toast"); t.textContent = OneShotI18n.t(m); t.classList.add("on"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("on"), ms); }
