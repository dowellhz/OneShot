"use strict";

// ================================================================= persistence & history
let saveT = null, savePending = null;
const boardSaveRetry = $("#boardSaveRetry");
function showBoardSaveFailure(message = "") {
  boardSaveRetry.hidden = !message;
  boardSaveRetry.title = OneShotI18n.t(message);
}
boardSaveRetry.onclick = async () => {
  boardSaveRetry.disabled = true;
  try { await flushSave(); }
  finally { boardSaveRetry.disabled = false; }
};
// a save belongs to the board it was made on, even if the user switches boards before it is sent
function save() { if (!canvasCanEdit() || typeof acGuardSave === "function" && acGuardSave()) return; clearTimeout(saveT); savePending = { id: boardId, b: B }; saveT = setTimeout(flushSave, 500); schedulePrewarm(); }
let prewarmT = null, prewarming = false;
const prewarmed = new Set();
function schedulePrewarm(ms = 5000) { clearTimeout(prewarmT); if (canvasCanEdit()) prewarmT = setTimeout(prewarm, ms); }
async function prewarm() {
  if (prewarming) return schedulePrewarm();
  prewarming = true;
  try {
    for (const n of B.nodes.filter(x => x.type === "video" && !x.data.film && !x.job && !prepping.has(x.id))) {
      if (!usesFields(n) || !fieldsFilled(n)) continue;
      if (n.data.previs || hasMediaReferences(n)) continue;
      const p = plan(n); if (!p.imgs.every(m => curV(m))) continue;
      const req = videoReq(n, fullPrompt(n)); if (!req) continue;
      const key = JSON.stringify(req); if (prewarmed.has(key)) continue;
      try { const r = await fetch("/api/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) }); if (r.ok) prewarmed.add(key); } catch {}
    }
  } finally { prewarming = false; }
}
let saveChain = Promise.resolve(), saveSequence = 0;
// saves run one after another, each carrying the board revision it is based on (B.rev); the server refuses a stale one
function flushSave(keepalive) {
  clearTimeout(saveT); const p = savePending; savePending = null; if (!p) return saveChain;
  if (keepalive) { sendSave(p, true); return saveChain; }
  const sequence = ++saveSequence;
  return saveChain = saveChain.then(() => sendSave(p, false, sequence));
}
async function sendSave(p, keepalive, sequence) {
  if (AC.pending.has(p.id)) return;  // Queued saves yield to the conflict review.
  const isCurrent = () => p.id === boardId && p.b === B;
  const failed = (message, retryDelay) => {
    if (keepalive || !isCurrent()) return;
    showBoardSaveFailure(message);
    if (savePending || sequence !== saveSequence) return;
    savePending = p;
    if (retryDelay) saveT = setTimeout(flushSave,retryDelay);
  };
  const body = JSON.stringify(liveBoardData(p.b), (k, v) => k === "st" ? undefined : v);   // live job status is not board data
  try {
    const r = await fetch("/api/board/" + p.id, { method: "PUT", headers: { "Content-Type": "application/json" }, body, keepalive: !!keepalive && body.length < 60000 });
    if (r.ok) { const j = await r.json().catch(() => ({})); if (j.rev != null && p.b === B) B.rev = j.rev; if (typeof acRememberBoard === "function") acRememberBoard(p.id, {...JSON.parse(body),rev:j.rev}); if (isCurrent()) showBoardSaveFailure(); return; }
    if (r.status === 409 && !keepalive) {
      if (typeof acRecoverSave === "function" && await acRecoverSave(p)) {
        if (isCurrent() && (AC.pending.has(p.id) || savePending !== p)) showBoardSaveFailure();
        return;
      }
      if (p.id === boardId) { toast(OneShotI18n.t("画布已在别处更新（另一个窗口或后台修改），已载入最新版本"), 5000); setTimeout(() => openBoard(boardId), 0); }
      return;
    }
    let reason = r.status === 401 ? "登录已过期" : r.statusText;
    try { reason = (await r.json()).error || reason; } catch {}
    failed(reason || "服务器未能保存画布");
  } catch { failed("连接失败，稍后会自动重试",3000); }
}
OneShotI18n.beforeSwitch(async () => {
  const blocker = () => {
    if (document.querySelector("dialog[open]") || IMAGE_EDITOR || FILM || CM.editor?.isConnected) {
      return "请先保存或关闭正在编辑的内容，再切换语言。";
    }
    if (acHasPendingDraft()) return "请先处理创作助手中未发送的内容、引用或录音，再切换语言。";
    return "";
  };
  const reason = blocker();
  if (reason) return reason;
  await flushSave();
  return blocker() || (!savePending && !AC.pending.has(boardId));
});
addEventListener("pagehide", () => flushSave(true));
