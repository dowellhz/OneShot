"use strict";
// AI 设置: a remote OpenAI-compatible model (DeepSeek API by default) for text-only work — writing scripts, splitting shots,
// rewriting prompts. Anything that has to look at a picture stays on the local Qwen3.5 (the DeepSeek API has no vision).

let SET = null;
function openCanvasPreferences() {
  const consoleUrl = ME_USER?.role === "admin" ? "/console#services" : "/console";
  $("#setBox").innerHTML = OneShotI18n.html`<div class="hd">设置<span style="flex:1"></span><button class="pill" id="setClose">关闭</button></div>
    <label class="ck"><input type="checkbox" id="setVideoPrecheck" aria-describedby="setVideoPrecheckHelp" ${defaultVideoQualityPrecheck() ? "checked" : ""}>先用量化模型预览视频</label>
    <div class="h" id="setVideoPrecheckHelp">在此浏览器默认对兼容的 H3 视频先生成并评估 INT8 样片，最多五次，再用 BF16 定稿。项目和节点可单独覆盖。</div>
    <div class="bt"><a class="pill" href="${consoleUrl}">控制台</a></div>`;
  $("#setClose").onclick = () => $("#settings").classList.remove("on");
  $("#setVideoPrecheck").onchange = event => {
    localStorage.setItem(VIDEO_QUALITY_PREFERENCE, event.target.checked ? "on" : "off");
    if (B && sel.size === 1) showPanel();
    if ($("#wiz").classList.contains("on")) renderWiz();
  };
  $("#settings").classList.add("on");
}
async function openSettings() {
  let LC;
  try { LC = await (await fetch("/api/llm")).json(); } catch { return toast("连不上画布服务"); }
  const box = $("#setBox");
  box.innerHTML = OneShotI18n.html`<div class="hd">文本模型<span style="flex:1"></span><button class="pill" id="setClose">关闭</button></div>
    <div class="h">用于<b>把提示词翻译成英文</b>、写剧本、拆分镜、改写、反推看图。选中的排第一，出错时自动换下一个。</div>
    <div class="ml">${LC.choices.map(c => `<button data-pid="${c.id}" class="${c.id === LC.current ? "on" : ""}"><b>${esc(c.name)}</b>
      <span>${esc(c.model || "")}${c.local ? " · 本机，不花钱；显卡在生成视频时用 CPU，较慢" : " · 云端，快，不占显卡，按用量计费"}${c.vision ? "" : " · 不能看图（看图仍用其他模型）"}</span></button>`).join("")}</div>
    <div class="bt"><span id="sMsg" class="h"></span><span style="flex:1"></span><a class="pill" href="/console#services">添加 / 管理服务…</a></div>`;
  $("#setClose").onclick = () => $("#settings").classList.remove("on");
  $$("[data-pid]", box).forEach(b => b.onclick = async () => {
    try {
      await api("/api/admin/llm", { provider: b.dataset.pid }, "PUT");
      $$("[data-pid]", box).forEach(x => x.classList.toggle("on", x === b));
      toast("文本模型已切换为 " + b.querySelector("b").textContent, 3000); status(); loadCaps?.();
    } catch (e) { $("#sMsg").textContent = e.message; $("#sMsg").style.color = "var(--red)"; }
  });
  $("#settings").classList.add("on");
  return;
  try { SET = await (await fetch("/api/settings")).json(); } catch { return toast("连不上画布服务"); }
  const L = SET.llm || {};
  if (!L.provider) Object.assign(L, { provider: "deepseek", ...SET.presets.deepseek, enabled: false });
  renderSettings(L);
  $("#settings").classList.add("on");
}
function renderSettings(L) {
  const box = $("#setBox"), custom = L.provider === "custom";
  box.innerHTML = OneShotI18n.html`<div class="hd">AI 设置<span style="flex:1"></span><button class="pill" id="setClose">关闭</button></div>
    <label class="ck big"><input type="checkbox" id="sEn" ${L.enabled ? "checked" : ""}>文本任务使用云端大模型</label>
    <div class="h">开启后，<b>写剧本、拆分镜、改写提示词、扩写</b>这些纯文字的工作交给下面的模型：更快、写得更好，而且不占用显卡，生成视频时也不用等。<br>
      需要看图的工作（反推、看图填写、拉片、带参考图的改写）仍然用本机的 Qwen3.5，因为 DeepSeek 接口不能看图。</div>
    <div class="f"><span>服务</span><div class="seg">${[["deepseek", "DeepSeek 官方"], ["local", "本机 DeepSeek"], ["custom", "自定义（OpenAI 兼容）"]]
      .map(([k, t]) => `<button data-p="${k}" class="${L.provider === k ? "on" : ""}">${t}</button>`).join("")}</div></div>
    ${L.provider === "local" ? `<div class="h warn">本机 DeepSeek 和视频生成共用这块 4090，通常不能同时开着；它没启动时这些任务会报错。</div>` : ""}
    ${custom ? OneShotI18n.html`<div class="f"><span>名称</span><input id="sName" value="${esc(L.name || "")}" placeholder="显示在提示里，如 Kimi"></div>` : ""}
    <div class="f"><span>接口地址</span><input id="sUrl" value="${esc(L.base_url || "")}" placeholder="https://api.deepseek.com" ${custom ? "" : "readonly"}></div>
    <div class="f"><span>API Key</span><input id="sKey" type="password" autocomplete="off" placeholder="${L.api_key_masked ? "已保存（" + esc(L.api_key_masked) + "），留空不修改" : L.provider === "local" ? "本机服务不需要" : "sk-…，在 platform.deepseek.com 创建"}"></div>
    <div class="f"><span>模型</span><input id="sModel" list="sModels" value="${esc(L.model || "")}" placeholder="deepseek-flash"><datalist id="sModels"></datalist></div>
    ${L.provider === "deepseek" ? `<div class="h">deepseek-flash 快又便宜；deepseek-v4-pro 更强。（旧的 deepseek-chat 已于 2026-07 停用）点「测试连接」可以列出账号能用的模型。</div>` : ""}
    <div class="bt"><span id="sMsg" class="h"></span><span style="flex:1"></span><button class="pill" id="sTest">测试连接</button><button class="pill" id="sSave" style="background:#fff;color:#000">保存</button></div>
    <div class="h">Key 只保存在 4090 的画布服务里（data/settings.json），页面上不会再显示完整的 Key。</div>`;
  const read = () => ({ ...L, enabled: $("#sEn").checked, name: $("#sName")?.value.trim() || L.name, base_url: $("#sUrl").value.trim(), model: $("#sModel").value.trim(),
    api_key: $("#sKey").value.trim() || undefined });
  $("#setClose").onclick = () => $("#settings").classList.remove("on");
  $$("[data-p]", box).forEach(b => b.onclick = () => {
    const k = b.dataset.p, keep = read();
    Object.assign(L, k === "custom" ? { provider: k, name: "", base_url: "", model: "" } : { provider: k, ...SET.presets[k] }, { enabled: keep.enabled });
    if (k !== (SET.llm?.provider)) L.api_key_masked = "";
    renderSettings(L);
  });
  $("#sTest").onclick = async () => {
    const msg = $("#sMsg"); msg.textContent = OneShotI18n.t("测试中…"); msg.style.color = "";
    try {
      const r = await api("/api/settings/test", { llm: read() });
      msg.textContent = `连接成功，${r.seconds}s 回复「${r.reply}」`; msg.style.color = "var(--green)";
      if (r.models.length) $("#sModels").innerHTML = r.models.map(m => `<option value="${esc(m)}">`).join("");
    } catch (e) { msg.textContent = e.message; msg.style.color = "var(--red)"; }
  };
  $("#sSave").onclick = async () => {
    const v = read();
    if (v.enabled && v.provider === "deepseek" && !v.api_key && !L.api_key_masked) { $("#sMsg").textContent = "请先填写 API Key"; $("#sMsg").style.color = "var(--red)"; return; }
    try { await api("/api/settings", { llm: v }, "PUT"); $("#settings").classList.remove("on"); toast(v.enabled ? `已开启：文本任务使用 ${v.name || "DeepSeek"}（${v.model}）` : "已关闭云端模型，全部用本机 Qwen", 3500); status(); }
    catch (e) { $("#sMsg").textContent = e.message; $("#sMsg").style.color = "var(--red)"; }
  };
}
function initSettings() {
  const css = document.createElement("style");
  css.textContent = `
#settings { position: fixed; inset: 0; z-index: 56; background: rgba(0,0,0,.6); display: none; align-items: center; justify-content: center; }
#settings.on { display: flex; }
#setBox { width: min(600px, 94vw); display: flex; flex-direction: column; gap: 12px; background: var(--panel); border: 1px solid var(--line2); border-radius: 16px; padding: 16px 20px; box-shadow: 0 20px 60px rgba(0,0,0,.6); }
#setBox .hd { display: flex; align-items: center; font-weight: 600; font-size: var(--fs-heading); }
#setBox .h { color: var(--dim); font-size: var(--fs-small); line-height: 1.6; } #setBox .h.warn { color: #ffcf5a; }
#setBox .ck { display: flex; align-items: center; gap: 8px; font-weight: 600; }
#setBox .f { display: grid; grid-template-columns: 72px 1fr; align-items: center; gap: 10px; font-size: var(--fs-small); color: var(--dim); }
#setBox .f input { background: #111113; border: 1px solid var(--line2); border-radius: 9px; padding: 7px 10px; color: var(--text); }
#setBox .f input[readonly] { color: var(--dim); }
#setBox .seg { display: flex; gap: 4px; flex-wrap: wrap; }
#setBox .seg button { border: 1px solid var(--line2); background: #18181b; color: #d6d6dc; border-radius: 9px; padding: 5px 10px; font-size: var(--fs-small); }
#setBox .seg button.on { background: #fff; color: #000; border-color: #fff; }
#setBox .bt { display: flex; align-items: center; gap: 8px; }
#setBox .bt a { text-decoration: none; color: var(--text); }
#setBox .ml { display: flex; flex-direction: column; gap: 8px; }
#setBox .ml button { text-align: left; display: flex; flex-direction: column; gap: 3px; border: 1px solid var(--line2); background: #18181b; color: var(--text); border-radius: 11px; padding: 10px 12px; }
#setBox .ml button span { color: var(--dim); font-size: var(--fs-small); }
#setBox .ml button.on { border-color: #fff; box-shadow: 0 0 0 1px #fff inset; }
#setBox .ml button.on b::after { content: "  ✓ 当前使用"; color: var(--green); font-weight: 500; font-size: var(--fs-small); }`;
  document.head.appendChild(css);
  document.body.insertAdjacentHTML("beforeend", `<div id="settings"><div id="setBox"></div></div>`);
  $("#helpBtn").insertAdjacentHTML("beforebegin", OneShotI18n.html`<button class="ib" id="setBtn" title="设置" aria-label="设置" style="font-size:var(--fs-heading)">⚙</button>`);
  $("#setBtn").onclick = openCanvasPreferences;
  $("#settings").addEventListener("pointerdown", e => { if (e.target.id === "settings") $("#settings").classList.remove("on"); });
}
