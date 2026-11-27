"use strict";

function initCanvasTopbar() {
  const navigation = $("#tl"), actions = $("#tr"), projects = $("#projectCanvases");
  navigation.insertAdjacentHTML("beforebegin", OneShotI18n.html`<div id="canvasTop">
    <header id="canvasToolbar" class="float"><details id="canvasMore">
      <summary aria-label="更多操作" title="更多操作">${ico("more")}</summary>
      <div id="canvasMorePanel">
        <span id="canvasTopAccount"></span>
        <div id="canvasMoreActions"></div>
      </div>
    </details></header>
  </div>`);
  navigation.classList.remove("float");
  actions.classList.remove("float");
  $("#canvasToolbar").prepend(navigation, actions);
  $("#canvasTop").append(projects);
  const language = $(".interface-language",actions);
  language.insertAdjacentHTML("afterbegin", OneShotI18n.html`<span>界面语言</span>`);
  $("#canvasMorePanel").append(language);

  const more = $("#canvasMore");
  document.addEventListener("pointerdown", event => {
    if (more.open && !more.contains(event.target)) more.open = false;
  });
  $("#canvasMoreActions").addEventListener("click", event => {
    if (event.target.closest("a,button")) more.open = false;
  });
  more.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !more.open) return;
    event.stopPropagation();
    more.open = false;
    $("summary",more).focus();
  });
}

function setCanvasQueueStatus(label, details = label) {
  $("#stt").textContent = label;
  $("#canvasQueueBtn").title = details;
  $("#qpContext").textContent = details;
}
