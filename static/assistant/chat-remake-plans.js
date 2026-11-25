"use strict";

async function acApplyRemakePlan(button) {
 const card = button.closest("[data-plan]");
 const plan = JSON.parse(card.dataset.plan);
 const shots = $$("input:checked:not(:disabled)", card).map(control => Number(control.value) - 1);
 const status = $("output", card);
 if (!shots.length) { status.textContent = "请至少勾选一个镜头"; return; }
 card.disabled = true;
 try {
  await flushSave();
  if (boardId !== plan.board) throw new Error("请回到对应画布");
  const target = vtResolve(plan.node_id, plan.source_ref);
  if (!target || target.node.versions[target.index]?.ref !== plan.source_ref) throw new Error("原片版本已不存在");
  const url = `/api/video-remake/${encodeURIComponent(plan.board)}/${encodeURIComponent(target.node.id)}?source=${encodeURIComponent(plan.source_ref)}`;
  const state = await remakeRequest(url, {"action":"apply_plan", shots, plan_id:plan.id, cut_revision:plan.cut_revision,
    person:plan.person, asset:plan.asset, reference:plan.reference, look:plan.look});
  acShowRemakeReceipt(card, url, plan, state, state.apply_plan, target.node.id);
 } catch (e) {
  status.textContent = e.message;
  card.disabled = false;
 }
}

function acShowRemakeReceipt(card, url, plan, state, outcome, nodeId) {
  if (!outcome || card.dataset.receipt) return;
  card.dataset.receipt = "1";
  card.disabled = true;
  const status = $("output", card);
  const summary = [`已提交 ${outcome.submitted.length} 个预览`, ...outcome.failed.map(s => `镜头 ${s.shot + 1} ${s.error}`)];
  if (outcome.uncertain) summary.push("提交曾中断，请先核对已有任务");
  if (outcome.needs_selection.length) summary.push(`请确认镜头 ${outcome.needs_selection.map(i => i + 1).join("、")} 的人物选区`);
  status.textContent = summary.join(" · ");
  const first = (outcome.needs_selection.length ? outcome.needs_selection : outcome.submitted)[0];
  if (first != null && state.shots[first]) {
   const link = document.createElement("button"); link.type = "button"; link.textContent = `打开镜头 ${first + 1}`;
   Object.assign(link.dataset, {remakeNode:nodeId, remakeRef:plan.source_ref, remakeStart:state.shots[first].start});
   card.after(link);
  }
  if (outcome.submitted.length) {
   const results = document.createElement("div"); results.className = "ac-remake-plan";
   card.after(results);
   watchRemakePlan(results, url, plan, outcome.jobs || []);
  }
}

async function acRestoreRemakePlan(card) {
 const plan = JSON.parse(card.dataset.plan);
 if (!plan.id || plan.board !== boardId) return;
 const controls = $$("input:not(:disabled)", card);
 const key = `oneshot.plan:${ME_USER?.id ?? "local"}:${plan.board}:${plan.id}`;
 const apply = selected => controls.forEach(c => { c.checked = selected.includes(Number(c.value) - 1); });
 try {
  const draft = JSON.parse(localStorage.getItem(key));
  if (Array.isArray(draft)) apply(draft);
 } catch {}
 card.addEventListener("change", () => {
  try { localStorage.setItem(key, JSON.stringify(controls.filter(c => c.checked).map(c => Number(c.value) - 1))); } catch {}
 });
 try {
  const target = vtResolve(plan.node_id, plan.source_ref);
  if (!target || target.node.versions[target.index]?.ref !== plan.source_ref) return;
  const url = `/api/video-remake/${encodeURIComponent(plan.board)}/${encodeURIComponent(target.node.id)}?source=${encodeURIComponent(plan.source_ref)}`;
  const state = await remakeRequest(url);
  const receipt = state?.remake_plans?.[plan.id];
  if (!receipt || !card.isConnected || boardId !== plan.board) return;
  apply(receipt.shots);
  acShowRemakeReceipt(card, url, plan, state, receipt.result, target.node.id);
 } catch {}
}

async function watchRemakePlan(results, url, plan, targets) {
 if (!targets.length) return;
 let allDone = false;
 const deadline = Date.now() + 30 * 60 * 1000;
 while (!allDone && results.isConnected && boardId === plan.board && Date.now() < deadline) {
  try {
   const jobs = await acApi("/api/jobs?ids=" + encodeURIComponent(targets.map(t => t.job).join(",")));
   const latest = await remakeRequest(url);
   if (!results.isConnected || boardId !== plan.board) return;
   allDone = targets.every(t => ["done","error"].includes(jobs[t.job]?.state));
   results.replaceChildren();
   for (const {index, frame, job} of targets) {
    const shot = latest.shots[index], preview = shot?.frames[frame]?.previews.find(p => p.job === job);
    const line = document.createElement("div");
    const ref = preview?.ref || jobs[job]?.outputs?.[0]?.ref;
    line.textContent = `镜头 ${index + 1} · ${ref ? "预览完成" : preview?.error || jobs[job]?.error || "生成中"}`;
    if (ref) {
     const view = document.createElement("img");
     view.src = remakeMedia(ref); view.alt = `镜头 ${index + 1} 换角预览`;
     line.append(view);
    }
    if (preview?.ref && latest.cut_revision === plan.cut_revision) {
     const accept = document.createElement("button"); accept.type = "button"; accept.textContent = OneShotI18n.t("采用预览");
     accept.disabled = shot.frames[frame].approved === job;
     if (accept.disabled) accept.textContent = OneShotI18n.t("已采用");
     accept.onclick = async () => {
      accept.disabled = true;
      try {
       await remakeRequest(url, {action:"approve", shot:index, frame, job, cut_revision:plan.cut_revision});
       accept.textContent = OneShotI18n.t("已采用");
      } catch (e) { accept.disabled = false; toast(e.message); }
     };
     line.append(accept);
    }
    results.append(line);
   }
  } catch (e) {
   results.textContent = "进度暂不可用 · " + e.message;
  }
  if (!allDone) await new Promise(resolve => setTimeout(resolve, 1700));
 }
 if (!allDone && results.isConnected && boardId === plan.board) results.textContent = "等待超时，可在重制工作区继续查看任务";
}

async function acReviewRemake(button) {
 const card = button.closest("[data-review-board]");
 if (!card || button.disabled || card.getAttribute("aria-busy") === "true") return;
 const {reviewBoard, reviewNode, reviewRef, reviewShot, reviewRevision} = card.dataset;
 const info = $("[data-review-status]", card);
 const decisions = $$("[data-remake-decision]:not(:disabled)", card);
 const adopting = button.dataset.remakeDecision === "adopt";
 const shot = Number(reviewShot) - 1;
 const job = button.dataset.reviewJob;
 card.setAttribute("aria-busy", "true");
 decisions.forEach(control => { control.disabled = true; });
 info.textContent = OneShotI18n.t("正在保存审核决定…");
 try {
  if (reviewBoard !== boardId) throw new Error("画布已切换，请重新打开对应对话");
  await flushSave();
  if (reviewBoard !== boardId) throw new Error("画布已切换，请重新打开对应对话");
  const target = vtResolve(reviewNode, reviewRef);
  if (!target || target.node.type !== "video" || target.node.versions[target.index]?.ref !== reviewRef) {
   throw new Error("原片版本已不存在");
  }
  const url = "/api/video-remake/" + encodeURIComponent(reviewBoard) + "/" + encodeURIComponent(target.node.id) +
   "?source=" + encodeURIComponent(reviewRef);
  const session = await remakeRequest(url, {
   action:adopting ? "approve_video" : "keep", shot, cut_revision:Number(reviewRevision), ...(adopting ? {job} : {}),
  });
  const selected = session.shots[shot];
  for (const control of decisions) {
   const pressed = selected.keep_original ? control.dataset.remakeDecision === "keep" : !!selected.adopted_video &&
    selected.adopted_video === control.dataset.reviewJob;
   control.setAttribute("aria-pressed", String(pressed));
  }
  info.textContent = adopting ? `镜头 ${reviewShot} 已采用所选版本。` : `镜头 ${reviewShot} 已设为保留原片。`;
 } catch (error) {
  info.textContent = error.message;
 } finally {
  decisions.forEach(control => { control.disabled = false; });
  card.removeAttribute("aria-busy");
 }
}
