"use strict";

window.OneShotI18n = (() => {
  const key = "oneshot.language";
  let saved;
  try { saved = localStorage.getItem(key); } catch {}
  const locale = saved === "en" ? "en" : "zh-CN";
  document.documentElement.lang = locale;

  const english = window.OneShotEnglish || Object.create(null);
  const attributes = ["title", "placeholder", "aria-label", "aria-description", "alt", "data-tip", "label"];
  const guards = [];
  const escape = value => String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);

  function t(source, values) {
    let message = source;
    if (locale === "en" && typeof source === "string") {
      const label = source.trim();
      if (label && Object.hasOwn(english, label)) message = source.replace(label, () => english[label]);
    }
    return values ? message.replace(/\{(\w+)\}/g, (match, name) =>
      Object.hasOwn(values, name) ? String(values[name]) : match) : message;
  }

  // Only authored markup is translated. Substitutions keep their existing escaping.
  function html(parts, ...values) {
    return parts.map((part, index) => {
      if (locale === "en") {
        part = part.replace(/\b(title|placeholder|aria-label|aria-description|alt|data-tip|label)=(["'])([^"'<>]*?)\2/g,
          (match, attr, quote, label) => {
            const translated = t(label);
            return translated === label ? match : attr + "=" + quote + escape(translated) + quote;
          });
        part = part.replace(/(^|>)([^<>]+)(?=<|$)/g, (match, prefix, label) => {
          const translated = t(label);
          return translated === label ? match : prefix + escape(translated);
        });
      }
      return part + (index < values.length ? String(values[index]) : "");
    }).join("");
  }

  function localizeMarkup(root) {
    if (locale !== "en") return;
    const skip = "script,style,svg,textarea,[contenteditable],[data-i18n-skip]";
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement.closest(skip)) continue;
      const localized = t(node.data);
      if (localized === node.data) continue;
      const option = node.parentElement.closest("option");
      if (option && !option.hasAttribute("value")) option.value = option.value;
      node.data = localized;
    }
    for (const el of root.querySelectorAll(attributes.map(attr => "[" + attr + "]").join(","))) {
      if (el.closest("[data-i18n-skip]")) continue;
      for (const attr of attributes) {
        if (el.hasAttribute(attr)) el.setAttribute(attr, t(el.getAttribute(attr)));
      }
    }
  }

  function mount() {
    document.title = t(document.title);
    localizeMarkup(document.body);
    const select = document.querySelector("[data-interface-language]");
    if (!select) return;
    select.value = locale;
    const status = document.querySelector("[data-language-status]");
    select.addEventListener("change", async () => {
      const requested = select.value;
      if (requested === locale || !["zh-CN", "en"].includes(requested)) return;
      select.disabled = true;
      status.textContent = "";
      try {
        for (const guard of guards) {
          if (!(await guard())) {
            status.textContent = t("请先保存或关闭正在编辑的内容，再切换语言。");
            return;
          }
        }
        localStorage.setItem(key, requested);
        location.reload();
      } catch {
        status.textContent = t("无法保存界面语言设置。");
      } finally {
        select.value = locale;
        select.disabled = false;
      }
    });
  }

  mount();
  return { locale, t, html, markup: source => html([source]), beforeSwitch: guard => guards.push(guard) };
})();
