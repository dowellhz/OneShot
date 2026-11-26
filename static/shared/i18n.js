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

  const tagPattern = /<!--[^]*?-->|<\/?[a-z][\w:-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
  const attributePattern = /(\s+)([^\s=<>/"']+)(?:(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s<>]+)))?/g;

  function translateTag(tag, marker) {
    return tag.replace(attributePattern, (raw, gap, name, eq, double, single, bare) => {
      const value = double ?? single ?? bare;
      if (!attributes.includes(name.toLowerCase()) || value == null || value.includes(marker)) return raw;
      const translated = t(value);
      return translated === value ? raw : gap + name + eq + '"' + escape(translated) + '"';
    });
  }

  // Keep substitutions opaque while inspecting the authored tags.
  function html(parts, ...values) {
    if (locale !== "en") return parts.map((part, i) =>
      part + (i < values.length ? String(values[i]) : "")).join("");
    let marker = "\uE000";
    while (parts.some(part => part.includes(marker))) marker += "\uE000";
    const slots = new RegExp("(" + marker + "\\d+\uE001)", "g");
    const source = parts.map((part, i) => part + (i < values.length ? marker + i + "\uE001" : "")).join("");
    const translateText = text => text.split(slots).map((piece, i) => {
      if (i % 2) return piece;
      const translated = t(piece);
      return translated === piece ? piece : escape(translated);
    }).join("");
    const tags = [...source.matchAll(tagPattern)];
    let output = "", end = 0, rawText = "", implicitOption = false;
    for (const [index, match] of tags.entries()) {
      const tag = match[0], offset = match.index;
      const [, closing, name] = /^<(\/?)([\w:-]+)/.exec(tag) || [];
      const element = name?.toLowerCase();
      const text = source.slice(end, offset);
      output += rawText || implicitOption ? text : translateText(text);
      end = offset + tag.length;
      if (rawText) {
        output += tag;
        if (closing && element === rawText) rawText = "";
        continue;
      }
      if (element === "option" || (closing && ["select", "optgroup", "datalist"].includes(element))) implicitOption = false;
      let translatedTag = element && !closing ? translateTag(tag, marker) : tag;
      if (element === "option" && !closing && ![...tag.matchAll(attributePattern)].some(attr => attr[2].toLowerCase() === "value")) {
        const next = tags[index + 1];
        const label = source.slice(end, next?.index);
        const plainLabel = !next || /^<(?:\/option|option|\/(?:select|optgroup|datalist))(?=[\s>])/i.test(next[0]);
        if (plainLabel && !label.includes(marker) && t(label) !== label) {
          const original = document.createElement("option");
          original.innerHTML = label;
          translatedTag = translatedTag.slice(0, -1) + ' value="' + escape(original.value) + '">';
        } else {
          // An implicit value computed from dynamic or nested content must stay intact.
          implicitOption = true;
        }
      }
      output += translatedTag;
      if (!closing && ["script", "style", "textarea"].includes(element)) rawText = element;
    }
    const tail = source.slice(end);
    output += rawText || implicitOption ? tail : translateText(tail);
    return output.replace(slots, slot => String(values[Number(slot.slice(marker.length, -1))]));
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
          const result = await guard();
          if (!result || typeof result === "string") {
            status.textContent = t(result || "请先保存或关闭正在编辑的内容，再切换语言。");
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
  function canvasName(board) {
    const empty = Array.isArray(board.nodes) ? !board.nodes.length : board.nodes === 0;
    const legacy = board.auto_name == null && empty && !board.wiz?.idea && ["新项目","New project"].includes(board.name);
    return board.auto_name === "project" || legacy ? t("新项目") : board.name;
  }

  return { locale, t, html, canvasName, markup: source => html([source]), beforeSwitch: guard => guards.push(guard) };
})();
