"use strict";

// ================================================================= queue panel + ETAs + "all done"
let qOpen = false, qTimer = null;
const clock = sec => { const d = new Date(Date.now() + sec * 1000); return d.toTimeString().slice(0, 5); };
async function renderQueue() {
  const box = $("#qpJobs");
  let q; try { q = await (await fetch("/api/queue")).json(); } catch { box.innerHTML = `<div class="h">连不上画布服务</div>`; return; }
  const byJob = new Map(); B.nodes.forEach(n => n.job?.ids.forEach(i => byJob.set(i, n)));
  box.innerHTML = `<div class="mt">任务队列${q.jobs.length ? ` · 全部完成约 ${fmtT(q.total)}（${clock(q.total)}）` : ""}</div>` +
    (q.jobs.map(j => {
      const n = byJob.get(j.id), pct = j.max ? Math.round((j.value || 0) / j.max * 100) : 0;
      return OneShotI18n.html`<div class="qj ${j.state}"><span class="ty">${{ image: "图片", video: "视频", render: "成片" }[j.kind] || ""}</span>
        <span class="nm" ${n ? `data-n="${n.id}" title="在画布上定位"` : ""}>${esc(n?.name || j.label)}</span>
        <span class="st">${j.state === "running" ? (pct ? `${pct}%` : "进行中") : "排队"} · ${j.state === "running" ? "还要" : ""}约 ${fmtT(j.eta)}</span>
        <button class="x" data-id="${j.id}" title="取消">×</button></div>`;
    }).join("") || `<div class="h">没有进行中的任务</div>`) +
    (q.foreign ? `<div class="h">另有 ${q.foreign} 个其他来源的任务在 ComfyUI 排队</div>` : "") +
    `<div class="h">可以关掉网页，任务会在 4090 上继续跑；回来后结果会自动出现在画布上</div>`;
  $$(".qj .x", box).forEach(b => b.onclick = async e => { e.stopPropagation(); await api("/api/cancel", { ids: [b.dataset.id] }).catch(() => {}); renderQueue(); });
  $$(".qj .nm[data-n]", box).forEach(s => s.onclick = () => { const n = node(s.dataset.n); if (n) { selectOnly(n.id); fit([n]); } });
}
function toggleQueue(on = !qOpen) {
  qOpen = on; $("#qp").classList.toggle("on", on); clearInterval(qTimer);
  $("#canvasQueueBtn").setAttribute("aria-expanded", String(on));
  if (on) $("#qp").style.top = $("#canvasToolbar").getBoundingClientRect().bottom + 8 + "px";
  if (on) { renderQueue(); qTimer = setInterval(renderQueue, 2000); }
}
let wasBusy = false, doneCount = 0;
function watchDone() {
  const busy = !!B && B.nodes.some(n => n.job);
  if (wasBusy && !busy) notifyDone();
  wasBusy = busy;
}
function notifyDone() {
  toast("✓ 全部任务已完成", 5000);
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)(), o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = 880; o.connect(g); g.connect(ac.destination); g.gain.setValueAtTime(0.12, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.6); o.start(); o.stop(ac.currentTime + 0.6);
  } catch {}
  if (document.hidden) {
    doneCount++; document.title = "✓ 生成完成 · OneShot";
    if (window.Notification && Notification.permission === "granted") try { new Notification("OneShot", { body: "全部任务已完成" }); } catch {}
  }
}
