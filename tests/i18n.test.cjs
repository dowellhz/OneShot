const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { setImmediate: wait } = require("node:timers/promises");
const { JSDOM, VirtualConsole } = require("jsdom");

const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

function page(file, locale, url = "", fetch) {
  const dom = new JSDOM(read("static/" + file), {
    url: "https://oneshot.test/" + url, runScripts: "outside-only", virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;
  if (locale) window.localStorage.setItem("oneshot.language", locale);
  if (fetch) window.fetch = fetch;
  for (const script of window.document.querySelectorAll("script")) {
    const asset = script.getAttribute("src");
    if (asset?.startsWith("/static/shared/") || fetch && !script.defer && script.type !== "module") {
      vm.runInContext(asset ? read(new URL(script.src).pathname.slice(1)) : script.textContent, dom.getInternalVMContext());
    }
  }
  return dom;
}

function json(value) {
  return { ok: true, json: async () => value, text: async () => JSON.stringify(value) };
}

async function run() {
  const chinese = page("index.html");
  const english = page("index.html", "en");
  const zh = chinese.window.document;
  const en = english.window.document;
  assert.equal(zh.documentElement.lang, "zh-CN");
  assert.equal(zh.querySelector("#shareBtn").textContent, "分享");
  assert.equal(en.documentElement.lang, "en");
  assert.equal(en.querySelector("#shareBtn").textContent, "Share");
  assert.match(en.querySelector("#toolPan").dataset.tip, /Pan/);
  const category = en.querySelector("[data-app-category]");
  assert.equal(category.options[2].textContent, "Image");
  assert.equal(category.options[2].value, "图片");
  assert.equal(en.querySelector("[data-interface-language]").value, "en");

  const { html, t, beforeSwitch } = english.window.OneShotI18n;
  const host = en.createElement("div");
  const userTitle = "保存";
  host.innerHTML = html`<button title="保存" data-token="保存">保存</button><strong>${userTitle}</strong>`;
  assert.equal(host.querySelector("button").textContent, "Save");
  assert.equal(host.querySelector("button").title, "Save");
  assert.equal(host.querySelector("button").dataset.token, "保存");
  assert.equal(host.querySelector("strong").textContent, userTitle);
  host.innerHTML = html`<button data-title="保存" data-label="保存"
    title = '保存' data-note='title="保存"'>${html`<span>保存</span>`}</button>
    <select name="mode"><option> 保存 </option><option value="保留">保存</option>
    <option>保存 ${userTitle}</option><option><span>保存</span></option></select>`;
  const button = host.querySelector("button");
  assert.equal(button.textContent, "Save");
  assert.equal(button.title, "Save");
  assert.equal(button.dataset.title, "保存");
  assert.equal(button.dataset.label, "保存");
  assert.equal(button.dataset.note, 'title="保存"');
  const dynamicOptions = host.querySelector("select").options;
  assert.equal(dynamicOptions[0].text.trim(), "Save");
  assert.equal(dynamicOptions[0].value, "保存");
  assert.equal(dynamicOptions[1].text, "Save");
  assert.equal(dynamicOptions[1].value, "保留");
  assert.equal(dynamicOptions[2].value, "保存 保存");
  assert.equal(dynamicOptions[3].value, "保存");
  const form = en.createElement("form");
  form.append(host.querySelector("select"));
  assert.equal(new english.window.FormData(form).get("mode"), "保存");
  assert.equal(t("{count} 次", { count: 3 }), "3 runs");
  let guarded = false;
  beforeSwitch(async () => { guarded = true; return false; });
  const selector = en.querySelector("[data-interface-language]");
  selector.value = "zh-CN";
  selector.dispatchEvent(new english.window.Event("change"));
  await wait();
  assert.equal(guarded, true);
  assert.equal(english.window.localStorage.getItem("oneshot.language"), "en");
  assert.equal(selector.value, "en");
  assert.match(en.querySelector("[data-language-status]").textContent, /Save or close/);
  const defaultPicker = zh.querySelector("[data-interface-language]");
  defaultPicker.value = "en";
  defaultPicker.dispatchEvent(new chinese.window.Event("change"));
  await wait();
  assert.equal(chinese.window.localStorage.getItem("oneshot.language"), "en");
  chinese.window.close();
  english.window.close();

  const login = page("login.html", "en", "login", async () => json({needs_setup: true}));
  await wait();
  assert.equal(login.window.document.title, "Sign in · OneShot");
  assert.equal(login.window.document.querySelector("#go").textContent, "Create administrator account");
  assert.equal(login.window.document.querySelector("#extra input").placeholder, "e.g. Alex");
  login.window.close();

  const displayName = "保存";
  const api = {
    "/api/me": {name: displayName, role: "admin"},
    "/api/admin/local": {gpu: {}, mem: {total: 100, available: 50}, disks: [], models: [], busy: {},
      services: {engine: {running: true, ready: true}, deepseek: {}, qwen: {}, kokoro: {}}},
  };
  const console = page("console.html", "en", "console#local", async url => {
    assert.ok(Object.hasOwn(api, url), url);
    return json(api[url]);
  });
  await wait();
  const admin = console.window.document;
  assert.equal(admin.querySelector("#main h1").textContent, "Local deployment");
  assert.equal(admin.querySelector(".svc b").textContent, "H3 engine");
  assert.equal(admin.querySelector(".svc .tag").textContent, "Running");
  assert.equal(admin.querySelector("#me b").textContent, displayName);
  console.window.close();

  for (const file of ["public-canvas.html", "shared-item.html", "showcase.html", "connect-agents.html", "events.html"]) {
    const publicPage = page(file, "en");
    const doc = publicPage.window.document;
    assert.equal(doc.documentElement.lang, "en", file);
    assert.equal(doc.querySelector("[data-interface-language]").getAttribute("aria-label"), "Interface language", file);
    assert.equal(doc.querySelectorAll("script:not([src])").length, 0, file);
    publicPage.window.close();
  }
}

run().then(() => console.log("Bilingual interface tests passed.")).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
