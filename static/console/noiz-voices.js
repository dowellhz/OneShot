"use strict";

function openNoizVoices(provider) {
  const endpoint = "/api/admin/providers/" + encodeURIComponent(provider.id) + "/voices";
  const box = modal(OneShotI18n.html`<div data-noiz-voices>
    <div class="row"><h3>音色管理</h3><span class="grow"></span><button class="btn" type="button" data-voice-close>关闭</button></div>
    <h4>已启用的音色</h4><div data-voice-saved></div>
    <form data-voice-search>
      <h4>从 Noiz 选择音色</h4>
      <div class="row">
        <select class="in" name="kind" aria-label="音色来源"><option value="built-in">官方音色</option><option value="custom">我的音色</option></select>
        <input class="in" name="keyword" maxlength="80" placeholder="搜索音色" aria-label="搜索音色">
        <button type="submit" class="btn">搜索</button>
      </div>
    </form>
    <div data-voice-results></div>
    <div class="row"><button class="btn sm" type="button" data-voice-page="-1">上一页</button><button class="btn sm" type="button" data-voice-page="1">下一页</button></div>
    <form data-voice-clone>
      <h4>克隆声音</h4>
      <label class="f">音色名称<input class="in" name="name" maxlength="60" required></label>
      <label class="f">参考音频<input class="in" type="file" name="file" accept=".wav,.mp3,.m4a" required></label>
      <div class="faint">选一段你有权使用的清晰单人录音，WAV、MP3 或 M4A，最多 10 MB。</div>
      <label class="f">参考音频语言<select class="in" name="language"><option value="">自动识别</option><option value="zh">中文</option><option value="en">English</option></select></label>
      <button class="btn pri" type="submit">克隆并启用</button>
    </form>
    <p class="faint" role="status" data-voice-status></p>
  </div>`);
  const root = $("[data-noiz-voices]", box), search = $("[data-voice-search]", root);
  const results = $("[data-voice-results]", root), status = $("[data-voice-status]", root);
  const previous = $('[data-voice-page="-1"]', root), next = $('[data-voice-page="1"]', root);
  let saved = [], page = 0, available = [], more = false, busy = false, serial = 0, listedQuery = "";

  function render() {
    const adopted = new Set(saved.map(voice => voice.id));
    const row = (voice, action) => OneShotI18n.html`<div class="row">
      <span class="grow" title="${esc(voice.id)}">${esc(voice.name)}</span>
      ${action === "remove" ? OneShotI18n.html`<button type="button" class="btn sm" data-remove-voice="${esc(voice.id)}" ${busy ? "disabled" : ""}>移除</button>`
        : adopted.has(voice.id) ? OneShotI18n.html`<span class="faint">已启用</span>`
        : OneShotI18n.html`<button type="button" class="btn sm" data-add-voice="${esc(voice.id)}" ${busy ? "disabled" : ""}>启用</button>`}</div>`;
    $("[data-voice-saved]", root).innerHTML = saved.map(voice => row(voice, "remove")).join("") ||
      OneShotI18n.html`<div class="faint">尚未启用音色</div>`;
    results.innerHTML = available.map(voice => row(voice, "add")).join("");
    previous.disabled = !page || busy;
    next.disabled = !more || busy;
  }

  async function list(target) {
    if (busy) return;
    const token = ++serial;
    const query = new URLSearchParams({kind:search.elements.kind.value, page:String(target), q:search.elements.keyword.value});
    status.textContent = tr("正在加载音色…");
    try {
      const received = await api(endpoint + "?" + query);
      if (token !== serial || !root.isConnected) return;
      ({saved, voices:available, more} = received);
      page = target;
      listedQuery = query.toString();
      status.textContent = available.length ? "" : tr("没有找到音色");
      render();
    } catch (error) {
      if (token === serial) status.textContent = tr(error.message);
    }
  }

  async function mutate(operation, button, progress) {
    if (busy) return;
    busy = true;
    serial += 1;
    button.disabled = true;
    render();
    status.textContent = tr(progress);
    try {
      const result = await operation();
      saved = result.saved;
      status.textContent = tr(result.voice ? "克隆音色已启用" : "音色设置已保存");
      return result;
    } catch (error) {
      status.textContent = tr(error.message);
    } finally {
      busy = false;
      button.disabled = false;
      if (root.isConnected) render();
    }
  }

  root.onclick = event => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.hasAttribute("data-voice-close")) { closeModal(); pgServices(); return; }
    if (button.hasAttribute("data-voice-page")) list(page + Number(button.dataset.voicePage));
    const id = button.dataset.addVoice || button.dataset.removeVoice;
    if (id) {
      const add = !!button.dataset.addVoice;
      const url = endpoint + "/" + encodeURIComponent(id) + (add ? "?" + listedQuery : "");
      mutate(() => api(url, null, add ? "PUT" : "DELETE"), button, "正在保存音色…");
    }
  };
  search.onsubmit = event => { event.preventDefault(); list(0); };
  search.elements.kind.onchange = () => list(0);
  $("[data-voice-clone]", root).onsubmit = async event => {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget, body = new FormData(form);
    if (body.get("file")?.size > 10 * 1024 * 1024) {
      status.textContent = tr("参考音频不得超过 10 MB");
      return;
    }
    const result = await mutate(async () => {
      const response = await fetch(endpoint, {method:"POST", body});
      const raw = await response.text();
      if (!response.ok) {
        let message;
        try { message = JSON.parse(raw).error; } catch {}
        throw new Error(message || response.statusText);
      }
      return JSON.parse(raw);
    }, form.querySelector("button"), "正在克隆音色…");
    if (result) form.reset();
  };
  render();
  api(endpoint).then(result => { if (serial === 1 && root.isConnected && !available.length) { saved = result.saved; render(); } }).catch(() => {});
  list(0);
}
