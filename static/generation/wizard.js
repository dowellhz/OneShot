"use strict";
// 一句话成片: a step-by-step guide over the canvas (想法 → 剧本 → 角色 → 分镜图 → 视频 → 成片).
// Every step creates ordinary canvas nodes through the existing tools, so the user can switch to the canvas any time.
// Progress lives in the board (B.wiz), so closing the page and coming back resumes where it was.

const WSTEPS = ["想法", "剧本", "制作素材", "分镜图", "视频", "成片"];
const STYLES = ["写实电影", "日系动画", "3D 动画", "水彩绘本", "国风水墨", "赛博朋克", "复古胶片"];
const VOICES_HINT = ["清亮少女音", "温柔女声", "干练女声", "少年音", "低沉男声", "沙哑大叔音", "苍老男声", "奶声童音"];
const TEMPLATES = [
  { t: "宠物搞笑", idea: "一只胖橘猫趁主人不在，偷偷爬上餐桌想偷吃盘子里的鱼。门突然开了，主人回家，猫立刻趴下假装睡觉，嘴边还挂着鱼刺，主人哭笑不得。", style: "3D 动画", aspect: "9:16", dur: 15 },
  { t: "咖啡广告", idea: "清晨的阳光照进小公寓，咖啡豆落入研磨机，热水缓缓注入手冲壶，女孩在窗边捧起杯子喝下第一口，露出满足的微笑。最后画面定格在冒着热气的杯子上。", style: "写实电影", aspect: "16:9", dur: 15 },
  { t: "雨夜重逢", idea: "雨夜，林夏一个人在公交站等车。前男友周屿撑着伞走过来，停在她面前。林夏抬头，愣住了，说：“你怎么来了？”周屿把伞举到她头顶，说：“我一直都在。”", style: "写实电影", aspect: "9:16", dur: 30 },
  { t: "绘本童话", idea: "小兔子在森林里捡到一颗会发光的种子，把它种在山坡上。种子一夜之间长成一棵会唱歌的大树，森林里的动物们都跑来围着大树跳舞。", style: "水彩绘本", aspect: "16:9", dur: 30 },
  { t: "大理 vlog", idea: "在云南大理，女孩骑着电动车沿洱海边兜风，路过白族村落的白墙青瓦，最后坐在海边咖啡馆的露台上，看着太阳落进苍山。", style: "写实电影", aspect: "9:16", dur: 15 },
  { t: "赛博快递", idea: "2077 年的霓虹城市，下着雨。快递员阿杰骑着悬浮摩托在高楼之间穿梭，把一个发光的包裹送到天台上一位神秘老人手里。老人打开包裹，里面是一朵真正的花。", style: "赛博朋克", aspect: "16:9", dur: 30 },
  { t: "竹林对决", idea: "竹林深处，白衣少年剑客与黑衣刺客对峙。风起，竹叶纷飞，两人同时出剑，剑光交错。片刻后，刺客倒下，少年收剑转身，消失在竹林里。", style: "国风水墨", aspect: "16:9", dur: 15 },
  { t: "水的旅行", idea: "用动画讲解水的循环：阳光照在大海上，水蒸气升上天空变成白云，云越积越厚下起雨，雨水落在山上汇成小溪，小溪流进大河，最后回到大海。", style: "3D 动画", aspect: "16:9", dur: 30 },
];
let W = null;             // B.wiz
let SAMPLES = [];         // finished example films (one per template), from /api/samples
let wizSig = "";

const wizScript = () => W && node(W.script);
function wizSave() { B.wiz = W; save(); }
const wizardQualityEnabled = () => W?.quality_precheck ?? CAPS_LIST.video_quality_precheck === true;
function setWizardVideoQuality(video, count) {
  Object.assign(video.data,{count:count||1,quality:W.quality||video.data.quality||"hd",quality_precheck:wizardQualityEnabled()});
  if (video.data.quality_precheck) Object.assign(video.data,{provider:"local_h3",selected_model:"h3-video",draft:false});
}

// ---- open / close
async function openWizard() {
  fetch("/api/samples").then(r => r.json()).then(x => { SAMPLES = x || []; if (W && W.step === 0) { wizSig = ""; renderWiz(); } }).catch(() => {});
  if (B.wiz && (!B.wiz.script || node(B.wiz.script))) W = B.wiz;
  else {
    if (B.nodes.length) {   // a guided project gets its own board
      const id = "b" + Date.now().toString(36);
      await flushSave();
      await fetch("/api/board/" + id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({...emptyBoard(OneShotI18n.t("新项目")),auto_name:"project"}) });
      await openBoard(id);
    }
    W = B.wiz = { step: 0, idea: "", style: STYLES[0], aspect: "16:9", dur: 15, quality: "hd", takes: 1, script: null };
  }
  $("#wiz").classList.add("on"); wizSig = ""; renderWiz();
}
function closeWizard() { $("#wiz").classList.remove("on"); updateWizBtn(); }
function updateWizBtn() {
  const b = $("#wizBtn"); if (!b || !B) return;
  const step = WSTEPS[B.wiz?.step];
  const resume = step && (B.wiz.idea || node(B.wiz.script));
  const { t } = OneShotI18n;
  const label = resume ? t("继续向导 · {step}", {step:t(step)}) : t("一句话成片");
  $("span", b).textContent = label;
}
function goStep(k) { W.step = k; wizSave(); wizSig = ""; renderWiz(); }

// ---- shared bits
function shotPairs() {
  const s=wizScript();
  return s?scriptShotLinks(s).map((pair,index)=>({record:pair,img:node(pair?.img),vid:node(pair?.vid),index})).filter(pair=>pair.img&&pair.vid):[];
}
function wizardShotFrames(pair) {
  const timing=plan(pair.vid);
  const captured=pair.record.shared_first&&timing.inputs.find(input=>input.edge.role==="first"&&input.version?.capture?.position==="last");
  const middle=timing.inputs.findIndex(input=>input.source.id===pair.record.motion_frames?.middle);
  const seconds=value=>Number(Number(value).toFixed(2));
  return [
    {node:captured?.source||pair.img,phase:"first",label:OneShotI18n.t(captured?"首帧 · 上一镜成片尾帧":pair.record.shared_first?"首帧 · 沿用上一镜分镜尾帧":"首帧 · 0 秒")},
    {node:node(pair.record.motion_frames?.middle),phase:"middle",label:OneShotI18n.t("中帧 · {seconds} 秒",{seconds:seconds(timing.times[middle]??0)})},
    {node:node(pair.record.motion_frames?.end),phase:"end",label:OneShotI18n.t("尾帧 · {seconds} 秒",{seconds:seconds(timing.end)})},
  ].filter(frame=>frame.node);
}
function wizardMiddleTiming(pair) {
  const {vid,record}=pair;
  if(isRemote(vid)||hasMediaReferences(vid))return null;
  const timing=plan(vid);
  const index=timing.inputs.findIndex(({source,edge})=>source.id===record.motion_frames?.middle&&edge.role==="keyframe");
  if(index<0)return null;
  return {edge:timing.es[index],time:timing.times[index],maxFrame:Math.round(timing.end*24)-1,
    editable:canvasCanEdit()&&!nodeLocked(vid)&&!vid.job&&!prepping.has(vid.id)};
}
// ---- rendering
function renderWiz() {
  if (!W) return;
  const st = $("#wzSteps");
  st.innerHTML = WSTEPS.map((t, i) => `<button class="${i === W.step ? "on" : ""} ${i < W.step ? "done" : ""}" data-s="${i}" ${i > maxStep() ? "disabled" : ""}><b>${i < W.step ? "✓" : i + 1}</b>${OneShotI18n.t(t)}</button>`).join("<i></i>");
  $$("button", st).forEach(b => b.onclick = () => goStep(+b.dataset.s));
  const body = $("#wzBody");
  body.innerHTML = [stepIdea, stepScript, stepCast, stepBoards, stepVideos, stepFilm][W.step]();
  wireStep(body);
  $$("textarea", body).forEach(t => { const g = () => { t.style.height = "auto"; t.style.height = Math.min(220, t.scrollHeight + 2) + "px"; }; g(); t.addEventListener("input", g); });
  wizSig = sigOf();
}
function maxStep() {
  const s = wizScript(); if (!s) return 0;
  if (!(s.data.shots || []).length) return 0;
  if (!wizardMissingVideos(s).length) return 5;
  const pairs = shotPairs();
  if (!pairs.length) return 2;
  if (pairs.length!==s.data.shots.length||!pairs.every(p => !missingMotionFrames(s.data.shots[p.index],p.record) &&
      wizardShotFrames(p).every(frame=>storyboardFrameReady(frame.node)))) return 3;
  return 4;
}
function sigOf() {
  const s = wizScript(); if (!s) return "";
  const ns = [s, ...shotPairs().flatMap(p => [...wizardShotFrames(p).map(frame=>frame.node),p.vid]), ...imgInputs(s), ...B.nodes.filter(n => n.data.film)];
  return JSON.stringify(ns.map(n => [n.id, n.versions.length, n.cur, n.job ? jobText(n) : 0, toolBusy.has(n.id), canvasGenerationError(n)])) + W.step + (s.data.shots || []).length;
}
setInterval(() => {
  if (!W || !$("#wiz").classList.contains("on")) return;
  if (document.activeElement && document.activeElement.closest("#wiz") && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  const sg = sigOf(); if (sg !== wizSig) renderWiz();
}, 1000);

const castNodes = () => { const s = wizScript(); return s ? imgInputs(s).filter(n=>!n.data.story_asset_key) : []; };
const castOf = name => castNodes().find(m => m.name === name);
function wizardMissingVideos(script) {
  return scriptShotLinks(script).flatMap((pair,index)=>storyboardVersionReady(node(pair?.vid))?[]:[index+1]);
}
function wizardFilm(script) {
  if (!script) return null;
  const sources = new Set(scriptShotLinks(script).map(pair => pair?.vid).filter(Boolean));
  const films = B.nodes.filter(n => {
    const spec = n.data.film;
    if (!spec || n.data.playlist) return false;
    if (spec.story_script) return spec.story_script === script.id;
    const clips = new Set((spec.clips || []).map(clip => clip.node));
    return sources.size > 0 && sources.size === script.data.shots.length && clips.size === sources.size &&
      [...clips].every(id => sources.has(id));
  });
  return films.at(-1);
}
// ---- actions
function wireStep(body) {
  $$("[data-goto]", body).forEach(b => b.onclick = () => goStep(+b.dataset.goto));
  $$("[data-go]", body).forEach(b => b.onclick = () => wizGo(b.dataset.go, b));
  $$("[data-set]", body).forEach(b => b.onclick = () => { const k = b.dataset.set; W[k] = k==="quality_precheck" ? b.dataset.val==="true" : ["dur", "takes"].includes(k) ? +b.dataset.val : b.dataset.val; wizSave(); renderWiz(); });
  $$("[data-tpl]", body).forEach(b => b.onclick = () => { const i=+b.dataset.tpl, t = TEMPLATES[i]; Object.assign(W, { idea: wizardTemplateIdea(i), style: t.style, aspect: t.aspect, dur: t.dur }); wizSave(); renderWiz(); });
  $$("[data-sample]", body).forEach(b => b.onclick = () => showSample(SAMPLES[+b.dataset.sample]));
  const idea = $("#wzIdea", body); if (idea) { idea.oninput = () => { W.idea = idea.value; wizSave(); }; if (!W.idea) idea.focus(); }
  $$("[data-v]", body).forEach(b => b.onclick = () => { const n = node(b.dataset.n); nodeAction(n, b.dataset.v); wizSig = ""; renderWiz(); });
  // script editing writes straight into the script node
  const s = wizScript(), d = s?.data;
  if (W.step === 1 && d?.shots?.length) {
    $("#wzTitle", body).oninput = e => { d.title = e.target.value; save(); };
    $("#wzStyle", body).oninput = e => { d.style = e.target.value; save(); };
    $$(".sh", body).forEach(el => {
      const index=+el.dataset.i, x=d.shots[index];
      const edited=new WeakSet();
      $$("input,select,textarea",el).forEach(field=>field.addEventListener("focus",()=>edited.delete(field)));
      const commit=(field,changes,oldValue)=>{
        try {
          const before=Object.fromEntries(Object.keys(changes).map(key=>[key,x[key]]));
          const first=!edited.has(field);
          const result=applyScriptShotRevision(s,{shot:index+1,shot_id:x.id,before,changes},{wizard:true,recordUndo:first});
          if(first&&result.retained.length)toast(OneShotI18n.t("保留了独立修改或共用的节点：{names}",{names:wizardShotNumbers(result.retained)}),4500);
          if(!result.already)edited.add(field);
        }catch(error){
          field.value=oldValue;
          toast(error.message,4500);
        }
      };
      $$("[data-f]", el).forEach(f => f.oninput = f.onchange = () => {
        const k = f.dataset.f, v = f.value;
        if (k === "duration") commit(f,{duration:+v},x.duration);
        else if (k === "cam") commit(f,{shot_size:v,camera:""},[x.shot_size,x.camera].filter(Boolean).join("，"));
        else if (k === "action" || k === "dialogue") commit(f,{[k]:v.split("\n").map(t=>t.trim()).filter(Boolean)},x[k].join("\n"));
        else commit(f,{[k]:v,...(k==="keyframe"&&x[k]!==v?{continues_previous:false}:{})},x[k]);
      });
      $$("[data-motion-frame]",el).forEach(field=>field.oninput=field.onchange=()=>{
        const phase=field.dataset.motionFrame;
        commit(field,{motion_frames:{...x.motion_frames,[phase]:field.value}},x.motion_frames[phase]);
      });
    });
    $$("[data-m]", body).forEach(b => b.onclick = () => {
      const el = b.closest(".sh"), i = el ? +el.dataset.i : -1, m = b.dataset.m;
      checkpoint();ensureScriptShotIds(s);
      if (m === "add") d.shots.push({ id:newCanvasNodeId(), duration: 5, shot_size: "中景", camera: "", scene: d.shots.at(-1)?.scene || "", characters: d.shots.at(-1)?.characters || [], action: [], dialogue: [], sound: "", keyframe: "",motion_frames:{middle:"",end:""} });
      else if (m === "del") d.shots.splice(i, 1);
      else if (m === "up" && i > 0) d.shots.splice(i - 1, 0, d.shots.splice(i, 1)[0]);
      else if (m === "down" && i + 1 < d.shots.length) d.shots.splice(i + 1, 0, d.shots.splice(i, 1)[0]);
      save(); render(s); renderWiz();
    });
  }
  if (W.step === 2) wireCast(body);
  $$("[data-middle-time]",body).forEach(input=>input.onchange=()=>{
    const pair=shotPairs().find(item=>item.index===Number(input.dataset.middleTime));
    const timing=pair&&wizardMiddleTiming(pair);
    if(!timing)return;
    const seconds=input.valueAsNumber;
    const time=timing.editable&&Number.isFinite(seconds)?
      Math.min(timing.maxFrame,Math.max(1,Math.round(seconds*24)))/24:timing.time;
    input.value=String(Number(time.toFixed(2)));
    if(time===timing.time)return;
    checkpoint();
    rememberVideoVersion(pair.vid);
    timing.edge.time=time;
    refresh(pair.vid);
    save();
  });
  $$("[data-redo]", body).forEach(b => b.onclick = () => {
    const n = node(b.dataset.redo), fix = $(`[data-fix="${n.id}"]`, body).value.trim();
    if (n.data.base_prompt == null) n.data.base_prompt = n.data.prompt;
    n.data.prompt = n.data.base_prompt + (fix ? `。调整：${fix}` : "");
    save(); generate(n); setTimeout(renderWiz, 300);
  });
  $$("[data-vredo]", body).forEach(b => b.onclick = () => {
    const pair=shotPairs().find(item=>item.vid.id===b.dataset.vredo);
    if(!pair)return;
    if(missingMotionFrames(wizScript().data.shots[pair.index],pair.record)||
       wizardShotFrames(pair).some(frame=>!storyboardFrameReady(frame.node)))
      return toast("请先到分镜图步骤补齐更新后的画面");
    setWizardVideoQuality(pair.vid,1);
    void generate(pair.vid).then(()=>{if(W&&$("#wiz").classList.contains("on"))renderWiz();});
  });
  $$("[data-motion-tail]",body).forEach(b=>b.onclick=async()=>{
    b.disabled=true;
    await useRenderedMotionTail(wizScript(),Number(b.dataset.motionTail));
    if(W&&$("#wiz").classList.contains("on"))renderWiz();
  });
  const eta = $("#wzEta", body);
  if (eta) fetch("/api/queue").then(r => r.json()).then(q => { if (q.total) eta.textContent = OneShotI18n.t("全部完成约 {time}（{clock}）。",{time:fmtT(q.total),clock:clock(q.total)}); }).catch(() => {});
}
function wireCast(body) {
  const s = wizScript(), d = s.data;
  $$(".cc", body).forEach(el => {
    const c = d.characters[+el.dataset.i];
    $$("[data-c]", el).forEach(f => f.oninput = () => {
      const k = f.dataset.c, old = c.name;
      c[k] = f.value;
      if (k === "name" && old !== c.name) {   // rename everywhere the script uses it
        d.shots.forEach(x => { x.characters = x.characters.map(n => n === old ? c.name : n); x.dialogue = x.dialogue.map(l => l.startsWith(old) ? c.name + l.slice(old.length) : l); });
        const m = castOf(old); if (m) { m.name = c.name; render(m); }
      }
      save();
    });
    $$("[data-voice]", el).forEach(b => b.onclick = () => { c.voice = b.dataset.voice; save(); $("[data-c=voice]", el).value = c.voice; });
    $$("[data-pick]", el).forEach(im => im.onclick = () => { const m = node(im.dataset.n); m.cur = +im.dataset.pick; save(); render(m); refreshDownstream(m); wizSig = ""; renderWiz(); });
    $$("[data-cast]", el).forEach(b => b.onclick = () => castAction(c, b.dataset.cast));
  });
}
function castNode(c) {
  let m = castOf(c.name);
  if (!m) {
    const s = wizScript(), at = freeSpot(s.x - 420, s.y + castNodes().length * 420, "image");
    m = addNode("image", at.x, at.y, { aspect: "3:4", quality: "4mp", count: 2 }, { name: c.name });
    link(m, s, true);
  }
  return m;
}
async function castAction(c, a) {
  if (a === "gen") {
    const m = castNode(c);
    setWizardCharacterPrompt(m,wizScript(),c);
    m.data.count = 2; save();
    await generate(m); wizSig = ""; renderWiz();
  } else if (a === "up") {
    pickFiles(async files => { const m = castNode(c); await uploadInto(m, files[0]); m.data.caption = c.look || ""; save(); wizSig = ""; renderWiz(); });
  } else if (a === "lib") {
    const list = (await loadLibrary()).filter(x => x.kind === "character");
    const box = $("#wzLib");
    box.innerHTML = list.length ? `<div class="lib"><b>${esc(OneShotI18n.t("选一个资产库里的角色给「{name}」",{name:c.name}))}</b><div class="li">${list.map(x => `<div data-id="${x.id}"><img src="${x.url}"><span>${esc(x.name)}</span></div>`).join("")}</div></div>` : OneShotI18n.html`<div class="lib">资产库里还没有角色</div>`;
    $$("[data-id]", box).forEach(el => el.onclick = () => {
      const x = list.find(y => y.id === el.dataset.id), m = castNode(c);
      checkpoint(); m.versions.push({ ref: x.ref, url: x.url, w: x.w, h: x.h, asset_id:x.id, source: "asset", prompt: "" }); m.cur = m.versions.length - 1;
      m.data.asset = { id: x.id, kind: "character" }; if (x.desc && !c.look) c.look = x.desc; if (x.voice && !c.voice) c.voice = x.voice;
      save(); render(m); box.innerHTML = ""; wizSig = ""; renderWiz();
    });
  }
}
async function wizGo(what, btn) {
  const s = wizScript();
  if (what === "script") {
    const idea = (W.idea || "").trim(); if (!idea) { toast("先写一句你的想法"); return; }
    let n = s;
    if (!n) { n = addNode("script", 0, 0, {}, { name: "剧本" }); W.script = n.id; }
    if (n.data.made?.length) toast("新分镜生成后会展开为一组新镜头");
    Object.assign(n.data, { prompt: `${idea}\n风格：${W.style}`, nshots:"auto", shotlen:"auto", aspect:W.aspect, quality:W.quality });
    W.step = 1; wizSave();
    const job = planStoryboard(n,{targetSeconds:W.dur,resetLinks:true,motionFrames:true});
    renderWiz();
    await job;
    fit(B.nodes); wizSig = ""; renderWiz();
  } else if (what === "boards") {
    if (!await prepareWizardAssets(s)) return;
    expandMissingScriptShots(s);
    W.step = 3; wizSave(); renderWiz();
    await batchImages(s); wizSig = ""; renderWiz();
  } else if (what === "fill-frames") {
    expandMissingScriptShots(s);
    wizSig="";renderWiz();
    await batchImages(s);
  } else if (what === "videos") {
    if(maxStep()<4)return toast("请先补齐分镜关键帧");
    W.step = 4; wizSave(); renderWiz();
    wizGo("genvids");
  } else if (what === "repair-shots") {
    expandMissingScriptShots(s);
    wizSig = ""; renderWiz();
  } else if (what === "genvids") {
    const pairs = shotPairs().filter(p => !storyboardVersionReady(p.vid) && !p.vid.job);
    pairs.forEach(p => setWizardVideoQuality(p.vid,W.takes));
    save();
    await batchVideos(s); wizSig = ""; renderWiz();
  } else if (what === "edit" || what === "quick" || what === "current-cut") {
    if (what === "edit") {
      const f = wizardFilm(s);
      if (f) { openFilm(f); return; }
    }
    if (!s || !openStoryFilm(s, 0, s.data.shots.length - 1, "fade")) return;
    if (what === "quick") { await exportFilm(); wizSig = ""; renderWiz(); return; }
  } else if (what === "canvas") closeWizard();
}

// ---- example films: watch, start from the same idea, or open the whole project
function wizardTemplateIdea(index) {
  const key=`wizard.example.idea.${index}`, localized=OneShotI18n.t(key);
  return localized===key ? TEMPLATES[index]?.idea : localized;
}
const builtInSampleTitles=["贪吃橘猫现形记","清晨手冲","雨夜重逢","会唱歌的魔法树","洱海落日骑行","2077 霓虹雨夜","竹林对决","水的循环"];
const isBuiltInSample = sample => sample.id===`sample${sample.tpl}` && sample.title===builtInSampleTitles[sample.tpl];
const sampleTitle = sample => isBuiltInSample(sample) ? OneShotI18n.t(sample.title) : sample.title;
const sampleIdea = sample => isBuiltInSample(sample) && OneShotI18n.locale==="en" ? wizardTemplateIdea(sample.tpl) : sample.idea;
const sampleStyle = sample => isBuiltInSample(sample) ? OneShotI18n.t(sample.style) : sample.style;
function showSample(x) {
  const m = $("#wzSample");
  m.innerHTML = OneShotI18n.html`<div class="box"><div class="hd"><b>${esc(sampleTitle(x))}</b><span class="dim">${esc(sampleStyle(x) || "")} · ${OneShotI18n.t("{seconds} 秒",{seconds:x.seconds?.toFixed(1)})} · ${OneShotI18n.t("每镜 1 个版本，没有挑选和精修")}</span>
      <span style="flex:1"></span><button class="ghost sm" data-x>关闭</button></div>
    <video src="${x.url}" controls autoplay playsinline></video>
    <div class="idea">${OneShotI18n.t("想法：{idea}",{idea:esc(sampleIdea(x) || "")})}</div>
    <div class="row"><button class="go" data-use>用这个想法开始</button><button class="ghost" data-open title="复制一份完整项目：剧本、角色、分镜图、每个镜头的视频都能看、能改">打开完整项目，看每一步</button></div></div>`;
  m.classList.add("on");
  const close = () => { $("video", m).pause(); m.classList.remove("on"); m.innerHTML = ""; };
  $("[data-x]", m).onclick = close;
  m.onpointerdown = e => { if (e.target === m) close(); };
  $("[data-use]", m).onclick = async () => {
    close();
    if (!($("#wiz").classList.contains("on") && W && !W.script)) await newWizardProject();   // never overwrite a project in progress
    const t = TEMPLATES[x.tpl]; if (t) Object.assign(W, { idea: sampleIdea(x) || wizardTemplateIdea(x.tpl), style: t.style, aspect: t.aspect, dur: t.dur });
    W.step = 0; wizSave(); wizSig = ""; renderWiz();
  };
  $("[data-open]", m).onclick = async () => {
    try { const r = await api(`/api/samples/${x.id}/open`, {}); close(); await openBoard(r.id); W = B.wiz; if (W) { W.step = 5; wizSig = ""; $("#wiz").classList.add("on"); renderWiz(); } toast("已打开示例项目的副本，点上方的步骤可以查看每一步，随便改不影响示例", 4500); }
    catch (e) { toast(e.message); }
  };
}

async function newWizardProject() {
  if (B.nodes.length || B.wiz) {
    const id = "b" + Date.now().toString(36);
    await fetch("/api/board/" + id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({...emptyBoard(OneShotI18n.t("新项目")),auto_name:"project"}) });
    await openBoard(id);
  }
  W = B.wiz = { step: 0, idea: "", style: STYLES[0], aspect: "16:9", dur: 15, quality: "hd", takes: 1, script: null };
  $("#wiz").classList.add("on"); wizSig = "";
}
async function loadSamples() { try { SAMPLES = await (await fetch("/api/samples")).json() || []; } catch {} return SAMPLES; }
const sampleCards = () => SAMPLES.map((x, k) => `<button class="gc" data-sample="${k}" title="${esc(sampleIdea(x) || "")}">
  <img src="${x.cover_url || ""}" loading="lazy"><span class="pl">▶</span><b>${esc(sampleTitle(x))}</b><small>${x.seconds ? OneShotI18n.t("{seconds} 秒",{seconds:x.seconds.toFixed(0)}) + " · " : ""}${esc(sampleStyle(x) || "")}</small></button>`).join("");
async function showGallery() {
  await loadSamples();
  const m = $("#wzSample");
  m.innerHTML = OneShotI18n.html`<div class="box"><div class="hd"><b>🎬 示例成片</b><span class="dim">全部用「一句话成片」自动做出来：一句想法 → 剧本 → 角色 → 分镜图 → 视频 → 成片，每部约 6 分钟</span>
    <span style="flex:1"></span><button class="ghost sm" data-x>关闭</button></div>
    <div class="gal grid">${sampleCards() || OneShotI18n.html`<div class="dim">还没有示例</div>`}</div></div>`;
  m.classList.add("on");
  $("[data-x]", m).onclick = () => { m.classList.remove("on"); m.innerHTML = ""; };
  m.onpointerdown = e => { if (e.target === m) { m.classList.remove("on"); m.innerHTML = ""; } };
  $$("[data-sample]", m).forEach(b => b.onclick = () => showSample(SAMPLES[+b.dataset.sample]));
}
async function fillEmptyGallery() {
  const box = $("#emptyGal"); if (!box) return;
  await loadSamples();
  box.innerHTML = SAMPLES.length ? OneShotI18n.html`<p style="margin:18px 0 8px">看看示例成片：</p><div class="gl">${sampleCards()}</div>` : "";
  $$("[data-sample]", box).forEach(b => b.onclick = () => showSample(SAMPLES[+b.dataset.sample]));
}

// ---- wiring
function initWizard() {
  const css = document.createElement("style");
  css.textContent = `
#wiz { position: fixed; inset: 0; z-index: 57; background: var(--bg); display: none; flex-direction: column; }
#wiz.on { display: flex; }
#wiz .top { display: flex; align-items: center; gap: 14px; padding: 12px 18px; border-bottom: 1px solid var(--line); }
#wiz .top .x { margin-left: auto; }
#wzSteps { display: flex; align-items: center; gap: 4px; margin: 0 auto; }
#wzSteps i { width: 18px; height: 1px; background: var(--line2); }
#wzSteps button { display: flex; align-items: center; gap: 6px; border: none; background: none; color: var(--dim); padding: 6px 8px; border-radius: 9px; font-size: var(--fs-body); }
#wzSteps button b { width: 20px; height: 20px; border-radius: 50%; border: 1px solid var(--line2); display: inline-flex; align-items: center; justify-content: center; font-size: var(--fs-caption); }
#wzSteps button.on { color: #fff; } #wzSteps button.on b { background: #fff; color: #000; border-color: #fff; }
#wzSteps button.done b { background: #2b2b30; border-color: #d6d6dc; color: #d6d6dc; }
#wzSteps button:disabled { opacity: .4; cursor: default; }
#wzBody { flex: 1; overflow-y: auto; padding: 26px 18px 40px; }
#wzBody > div { max-width: 1060px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
#wiz h2 { margin: 10px 0 4px; font-size: var(--fs-display); font-weight: 600; text-align: center; }
#wiz textarea, #wiz input:not([type]) { background: #141417; border: 1px solid var(--line2); border-radius: 10px; padding: 8px 10px; color: var(--text); width: 100%; resize: vertical; }
#wzIdea { font-size: var(--fs-heading); padding: 14px 16px !important; border-radius: 14px !important; }
#wiz .lab { color: var(--dim); font-size: var(--fs-small); margin-right: 8px; display: inline-block; min-width: 56px; }
#wiz .chip { border: 1px solid var(--line2); background: #18181b; color: #d6d6dc; border-radius: 16px; padding: 4px 12px; margin: 3px 4px 3px 0; font-size: var(--fs-small); }
#wiz .chip.on { background: #fff; color: #000; border-color: #fff; } #wiz .chip.sm { padding: 1px 8px; font-size: var(--fs-caption); }
#wiz .opts { display: flex; flex-direction: column; gap: 6px; }
#wiz .est, #wiz .tip, #wiz .dim { color: var(--dim); font-size: var(--fs-small); }
#wiz .nav { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-top: 10px; position: sticky; bottom: 0; padding: 12px 0; background: linear-gradient(transparent, #0b0b0c 40%); }
#wiz .go { background: #fff; color: #000; border: none; border-radius: 11px; padding: 9px 18px; font-weight: 600; text-decoration: none; font-size: var(--fs-body); }
#wiz .go:disabled { opacity: .35; cursor: default; }
#wiz .ghost { background: #1d1d21; color: #ddd; border: 1px solid var(--line2); border-radius: 11px; padding: 8px 14px; text-decoration: none; font-size: var(--fs-body); }
#wiz .sm { padding: 5px 10px; font-size: var(--fs-small); border-radius: 9px; }
#wiz .wait { display: flex; align-items: center; justify-content: center; gap: 12px; min-height: 240px; color: var(--dim); font-size: var(--fs-heading); }
#wiz .spin { width: 18px; height: 18px; border-radius: 50%; border: 2px solid #555; border-top-color: #fff; animation: wzs 0.9s linear infinite; flex: none; }
@keyframes wzs { to { transform: rotate(360deg); } }
#wiz .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; } #wiz .grow { flex: 1; }
.wz2 .title { font-size: var(--fs-title); font-weight: 600; max-width: 360px; }
.wz2 .sty { display: flex; align-items: center; gap: 10px; color: var(--dim); font-size: var(--fs-small); white-space: nowrap; }
.wz2 .shots { display: flex; flex-direction: column; gap: 10px; }
.wz2 .sh { background: #141417; border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.wz2 .sh .h { display: flex; align-items: center; gap: 8px; } .wz2 .sh .h input { max-width: 300px; padding: 4px 8px !important; }
.wz2 .sh select { background: #1d1d21; border: 1px solid var(--line2); border-radius: 8px; padding: 3px 6px; }
.wz2 .sh label { display: grid; grid-template-columns: 40px 1fr; gap: 8px; align-items: start; color: var(--dim); font-size: var(--fs-small); }
.wz2 .sh textarea { padding: 5px 8px !important; font-size: var(--fs-small); }
.wz2 .ic { border: none; background: none; color: var(--dim); width: 24px; height: 24px; border-radius: 6px; } .wz2 .ic:hover { background: #222; color: #fff; }
.wz2 .add { border: 1px dashed var(--line2); background: none; color: var(--dim); border-radius: 12px; padding: 10px; }
.wz3 .cast { display: grid; grid-template-columns: repeat(auto-fill, minmax(480px, 1fr)); gap: 14px; }
.wz3 .cc { display: flex; gap: 12px; background: #141417; border: 1px solid var(--line); border-radius: 14px; padding: 12px; }
.wz3 .pics { width: 190px; flex: none; display: flex; flex-wrap: wrap; gap: 6px; align-content: flex-start; position: relative; min-height: 200px; }
.wz3 .pics img { width: 92px; height: 123px; object-fit: cover; border-radius: 8px; border: 2px solid transparent; cursor: pointer; opacity: .6; }
.wz3 .pics img.on { border-color: #fff; opacity: 1; }
.wz3 .pend, .wz4 .pend, .wz5 .pend { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--dim); font-size: var(--fs-small); text-align: center; background: #0e0e10cc; border-radius: 10px; }
.wz3 .info { flex: 1; display: flex; flex-direction: column; gap: 6px; }
.wz3 .info label { display: flex; flex-direction: column; gap: 3px; color: var(--dim); font-size: var(--fs-small); }
.wz3 .nm { font-weight: 600; font-size: var(--fs-heading); max-width: 200px; }
.wz3 .btns { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
.wz3 .lib { background: #141417; border: 1px solid var(--line); border-radius: 12px; padding: 10px; }
.wz3 .li { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; } .wz3 .li div { width: 90px; cursor: pointer; font-size: var(--fs-caption); text-align: center; }
.wz3 .li img { width: 90px; height: 120px; object-fit: cover; border-radius: 8px; display: block; }
.wz4 .grid, .wz5 .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
.wz4 .grid.tall, .wz5 .grid.tall { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
.bc { background: #141417; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; }
.bc .pic { position: relative; aspect-ratio: 16 / 9; background: #000; } .tall .bc .pic { aspect-ratio: 9 / 16; }
.bc .pic img, .bc .pic video { width: 100%; height: 100%; object-fit: contain; display: block; } .bc .pic .dimg { opacity: .35; }
.bc .pend { border-radius: 0 !important; }
.bc .cap { display: flex; align-items: center; gap: 8px; padding: 8px 10px 2px; font-size: var(--fs-small); }
.bc .txt { padding: 0 10px; color: var(--dim); font-size: var(--fs-caption); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 34px; }
.bc .wz-frame-time { display: flex; align-items: center; gap: 6px; padding: 3px 10px; font-size: var(--fs-caption); color: var(--dim); }
.bc .wz-frame-time input { width: 72px; padding: 4px 8px !important; font-size: var(--fs-small); }
.bc .wz-shot-error { margin: 0; padding: 4px 10px 8px; color: #f3a6a6; font-size: var(--fs-small); }
.bc .fix { display: flex; gap: 6px; padding: 8px 10px 10px; } .bc .fix input { padding: 4px 8px !important; font-size: var(--fs-small); min-width: 0; } .bc button { white-space: nowrap; flex: none; }
.vn { display: inline-flex; align-items: center; gap: 2px; color: var(--dim); font-size: var(--fs-caption); }
.vn button { border: none; background: #222; color: #ddd; width: 20px; height: 20px; border-radius: 6px; }
.wz6 .final { width: 100%; max-height: 62vh; background: #000; border-radius: 14px; }
.gal .gl { display: flex; gap: 10px; overflow-x: auto; padding: 6px 0 4px; }
.gal .gc { position: relative; flex: none; width: 150px; border: 1px solid var(--line); background: #141417; border-radius: 12px; padding: 0 0 8px; text-align: left; overflow: hidden; color: var(--text); }
.gal .gc img { width: 100%; height: 100px; object-fit: cover; display: block; background: #000; }
.gal .gc .pl { position: absolute; left: 8px; top: 70px; width: 22px; height: 22px; border-radius: 50%; background: #000a; display: flex; align-items: center; justify-content: center; font-size: var(--fs-micro); }
.gal .gc b { display: block; padding: 6px 9px 0; font-size: var(--fs-small); } .gal .gc small { display: block; padding: 0 9px; color: var(--dim); font-size: var(--fs-caption); }
.gal .gc:hover { border-color: #777; }
#galBtn { display: inline-flex; align-items: center; gap: 6px; background: #222226; color: #e6e6ea; border: 1px solid var(--line2); border-radius: 7px; padding: 4px 8px; font: inherit; min-height: 28px; margin-left: 6px; white-space: nowrap; }
#emptyGal .gl { justify-content: center; max-width: 90vw; flex-wrap: wrap; }
.gal.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; overflow-y: auto; }
.gal.grid .gc { width: auto; } .gal.grid .gc img { height: 130px; } .gal.grid .gc .pl { top: 100px; }
#wzSample { position: fixed; inset: 0; z-index: 61; background: rgba(0,0,0,.7); display: none; align-items: center; justify-content: center; }
#wzSample.on { display: flex; }
#wzSample .box { width: min(980px, 94vw); max-height: 94vh; display: flex; flex-direction: column; gap: 10px; background: var(--panel); border: 1px solid var(--line2); border-radius: 16px; padding: 14px 16px; }
#wzSample .hd { display: flex; align-items: center; gap: 10px; }
#wzSample video { width: 100%; max-height: 66vh; background: #000; border-radius: 10px; }
#wzSample .idea { color: var(--dim); font-size: var(--fs-small); line-height: 1.6; }
#wizBtn { display: inline-flex; align-items: center; gap: 6px; background: var(--card-hi); color: var(--text); border: 1px solid var(--line2); border-radius: 7px; padding: 4px 8px; font: inherit; min-height: 28px; margin-left: 6px; white-space: nowrap; }
#empty .wcta { display: inline-block; margin: 6px 0 22px; padding: 14px 26px; border-radius: 14px; border: 1px solid var(--line2); color: var(--text); font-size: var(--fs-heading); font-weight: 600; background: var(--card-hi); box-shadow: 0 8px 30px rgba(0,0,0,.3); }
#wizBtn:hover, #empty .wcta:hover { background: #27272d; border-color: #686870; }
#wiz .top > b { display: flex; align-items: center; gap: 6px; }
#empty .wcta small { display: block; font-weight: 400; font-size: var(--fs-small); opacity: .85; margin-top: 2px; }`;
  document.head.appendChild(css);
  document.body.insertAdjacentHTML("beforeend", OneShotI18n.html`<div id="wiz"><div class="top"><b>${ico("script")} 一句话成片</b><div id="wzSteps"></div>
    <button class="ghost x" id="wzClose" title="向导的进度会保存，随时可以回来">去画布查看</button></div><div id="wzBody"></div></div><div id="wzSample"></div>`);
  $("#wzClose").onclick = closeWizard;
  $("#tl").insertAdjacentHTML("beforeend", OneShotI18n.html`<button id="wizBtn" title="AI 帮你从一句话做到成片">${ico("script")}<span>一句话成片</span></button>`);
  $("#wizBtn").onclick = openWizard;
  $("#wizBtn").insertAdjacentHTML("afterend", OneShotI18n.html`<button id="galBtn" title="看看用一句话做出来的示例成片">${ico("video")}<span>示例</span></button>`);
  $("#galBtn").onclick = showGallery;
  $("#empty .tiles").insertAdjacentHTML("afterend", `<div class="gal" id="emptyGal"></div>`);
  fillEmptyGallery();
  $("#empty h1").insertAdjacentHTML("afterend", OneShotI18n.html`<button class="wcta" id="wizCta">一句话成片<small>写下想法，AI 帮你写剧本、定角色、出分镜、生成视频、剪成片</small></button><p style="margin:0 0 8px">或者自己搭：</p>`);
  $("#wizCta").onclick = openWizard;
  setInterval(updateWizBtn, 2000);
}
