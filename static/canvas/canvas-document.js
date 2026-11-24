"use strict";

const canvasDocumentDrafts = new Map();
let canvasDocument = null;
const documentBackgrounds = new Set(["blue","lilac","sand","rose"]);
const documentBackground = value => documentBackgrounds.has(value) ? value : "";

function documentText(n) {
  return {text:String(n.data.text ?? ""),format:n.data.text_format === "markdown" ? "markdown" : "plain",
    background:documentBackground(n.data.text_background)};
}

function equalDocument(a,b) { return a.text === b.text && a.format === b.format && a.background === b.background; }

function documentAssetPreset(name, value) {
  return {name:name.replace(/@/g,"＠"), document:{name,text:value.text,format:value.format}};
}

function renderDocumentPreview(host,value) {
  host.classList.toggle("document-plain", value.format === "plain");
  if (value.format === "markdown") acMarkdown(host,value.text,{images:false});
  else host.textContent = value.text;
}

function closeTextDocument() {
  const dialog = $("#textDocument");
  if (dialog.open) dialog.close?.();
  dialog.removeAttribute("open");
  canvasDocument = null;
}

const documentBlockText = text => text.replace(/^ {0,3}(?:#{1,6}|[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/, "");
const documentFormats = {
  heading:{line:text=>"# " + (documentBlockText(text) || "标题")},
  subheading:{line:text=>"## " + (documentBlockText(text) || "小标题")},
  subsection:{line:text=>"### " + (documentBlockText(text) || "三级标题")},
  body:{line:documentBlockText},
  bullets:{line:text=>"- " + (documentBlockText(text) || "列表项")},
  ordered:{line:(text,index)=>`${index + 1}. ${documentBlockText(text) || "列表项"}`},
  bold:{wrap:"**"},
  italic:{wrap:"*"},
  divider:{insert:"---"},
  table:{insert:"| 镜头 | 说明 |\n| --- | --- |\n| 1 |  |"},
};

function formatTextDocument(source, action) {
  const rule = documentFormats[action];
  let start = source.selectionStart, end = source.selectionEnd;
  const text = source.value;
  if (rule.line) {
    start = start === 0 ? 0 : text.lastIndexOf("\n",start - 1) + 1;
    const last = text.indexOf("\n",end > start && text[end - 1] === "\n" ? end - 1 : end);
    end = last === -1 ? text.length : last;
  }
  if (rule.insert) start = end;
  const selected = text.slice(start,end);
  let replacement;
  if (rule.line) replacement = selected.split("\n").map(rule.line).join("\n");
  else if (rule.wrap) replacement = rule.wrap + (selected || "文字") + rule.wrap;
  else replacement = (start > 0 ? "\n\n" : "") + rule.insert + (end < text.length ? "\n\n" : "\n");
  if (text.length - selected.length + replacement.length > source.maxLength) return false;
  source.setRangeText(replacement,start,end,"select");
  source.focus();
  return true;
}

function openTextDocument(n, passage) {
  if (n?.type !== "text" || node(n.id) !== n) return;
  const dialog = $("#textDocument"), source = $("textarea",dialog), format = $("#textDocumentFormat");
  const background = $("#textDocumentBackground");
  const preview = $("#textDocumentPreview"), controls = $("#documentFormatting"), status = $("[role=status]",dialog);
  const apply = $("[data-document-save]",dialog), reload = $("[data-document-reload]",dialog);
  const collect = $("[data-document-asset]",dialog), annotate = $("[data-document-annotate]",dialog);
  const key = boardId + ":" + n.id, editable = canvasCanEdit();
  const current = documentText(n), draft = editable ? canvasDocumentDrafts.get(key) : null;
  let highlight=null;
  if (passage) {
    const [start,end]=passage.location;
    const points=Array.from(current.text);
    if ((draft && draft.value.text !== current.text) || points.slice(start,end).join("") !== passage.quote) {
      toast("当前正文或草稿与批注不一致，可在评论中查看批注原文");
      return;
    }
    highlight=[points.slice(0,start).join("").length,points.slice(0,end).join("").length];
  }
  const session = {board:boardId,id:n.id,base:draft?.base || current,update};
  canvasDocument = session;
  source.value = (draft?.value || current).text;
  format.value = (draft?.value || current).format;
  background.value = (draft?.value || current).background;
  source.readOnly = apply.hidden = controls.hidden = format.disabled = !editable;
  $("#textDocumentTitle").textContent = n.name;
  const value = () => ({text:source.value,format:format.value,background:documentBackground(background.value)});
  function updateAnnotation() {
    const selected=source.value.slice(source.selectionStart,source.selectionEnd);
    annotate.disabled=!selected.trim();
  }
  function update() {
    const changes = value();
    const changed = !equalDocument(changes,session.base);
    const liveNode = boardId === session.board ? node(session.id) : null;
    const stale = !liveNode || !equalDocument(documentText(liveNode),session.base);
    const writable = editable && canvasCanEdit();
    preview.dataset.documentBackground = changes.background;
    renderDocumentPreview(preview,changes);
    if (editable) {
      if (changed) canvasDocumentDrafts.set(key,{base:session.base,value:changes});
      else canvasDocumentDrafts.delete(key);
    }
    source.readOnly = controls.hidden = format.disabled = !writable;
    background.closest("label").hidden = !writable;
    background.disabled = !writable;
    collect.hidden = !writable;
    collect.disabled = !changes.text.trim();
    apply.disabled = !writable || !changed || stale;
    reload.hidden = !writable || !stale || !liveNode;
    status.textContent = stale ? "画布上的文档已更新，草稿仍可复制。" : changed ? "有未保存的改动" : "";
    updateAnnotation();
  }
  source.oninput = format.onchange = background.onchange = update;
  source.onselect = updateAnnotation;
  annotate.onclick = () => {
    const target=boardId===session.board?node(session.id):null;
    if(!target || documentText(target).text!==source.value){status.textContent="请保存正文后再批注选中的文字";return;}
    const quote=source.value.slice(source.selectionStart,source.selectionEnd);
    const count=Array.from(quote).length;
    if(!quote.trim() || count>4000){status.textContent="每条批注可选 1–4,000 个字符";return;}
    const start=Array.from(source.value.slice(0,source.selectionStart)).length;
    closeTextDocument();
    ccTextPassage(target,{start,end:start+count,quote});
  };
  controls.onclick = event => {
    const action = event.target.closest("[data-document-format]")?.dataset.documentFormat;
    if (!action || !editable || !canvasCanEdit()) return;
    if (!formatTextDocument(source,action)) { status.textContent = "文档最多可输入 20,000 字符"; return; }
    format.value = "markdown";
    update();
  };
  apply.onclick = () => {
    const target = node(session.id);
    if (canvasDocument !== session || boardId !== session.board || !canvasCanEdit() || !target ||
        !equalDocument(documentText(target),session.base) || source.value.length > source.maxLength) { update(); return; }
    checkpoint();
    const changes = value();
    target.data.text = changes.text;
    if (changes.format === "markdown") target.data.text_format = "markdown";
    else delete target.data.text_format;
    if (changes.background) target.data.text_background = changes.background;
    else delete target.data.text_background;
    canvasDocumentDrafts.delete(key);
    render(target);
    refreshDownstream(target);
    save();
    closeTextDocument();
  };
  reload.onclick = () => {
    const target = boardId === session.board ? node(session.id) : null;
    if (!target) return;
    canvasDocumentDrafts.delete(key);
    openTextDocument(target);
  };
  collect.onclick = () => {
    if (!editable || !canvasCanEdit() || boardId !== session.board || !source.value.trim()) return;
    const preset = documentAssetPreset(n.name,value());
    closeTextDocument();
    cmEdit(null,"document",{preset}).catch(error=>toast(error.message));
  };
  $("[data-document-close]",dialog).onclick = closeTextDocument;
  $("[data-document-copy]",dialog).onclick = async () => {
    try { await acCopyText(source.value); if (canvasDocument === session) status.textContent = "已复制正文"; }
    catch { if (canvasDocument === session) status.textContent = "无法复制，可选中正文后手动复制"; }
  };
  dialog.oncancel = event => { event.preventDefault(); closeTextDocument(); };
  dialog.onkeydown = event => {
    event.stopPropagation();
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !apply.disabled) { event.preventDefault(); apply.click(); }
  };
  update();
  if (!dialog.open) {
    if (dialog.showModal) dialog.showModal();
    else dialog.setAttribute("open", "");
  }
  if (editable || highlight) source.focus();
  if (highlight) { source.setSelectionRange(...highlight); updateAnnotation(); }
}
