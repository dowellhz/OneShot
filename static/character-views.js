"use strict";

const CHARACTER_VIEWS = {
  main: ["标准主图", "01-character-main.png", "全身单人，正面略转约30度，自然站姿，双手垂放。脸、发型、服装、身材比例和鞋清晰可见。"],
  face: ["正面头肩", "02-face-front.png", "正面头肩近照，中性表情，清晰展示脸型、五官和发际线。"],
  side: ["全身侧面", "03-full-side.png", "全身侧面，自然站立，完整展示鞋子和衣摆。"],
  back: ["全身背面", "04-full-back.png", "全身纯背面，自然站立，完整展示后脑发型、衣摆和鞋子。"],
  detail: ["固定细节", "05-detail.png", "单张近景，突出角色卡里最有辨识度的伤疤、发簪或固定随身道具，保持原来的身体侧别与佩戴位置。"]
};

const CHARACTER_FIELDS = {
  code:"角色编号", appearance:"外貌锚点", hair:"发型", costume:"默认服装",
  details:"固定细节", performance:"表演特征", variation:"允许变化", style:"正片风格"
};

function characterPrompt(asset, slot, card) {
  const identity = Object.entries(CHARACTER_FIELDS)
    .filter(([key]) => key !== "code" && card[key])
    .map(([key, label]) => label + "：" + card[key]);
  return [
    "以 @图1 为身份依据，制作同一角色的单张标准参考图。",
    CHARACTER_VIEWS[slot][2],
    "每张只画一个角色和一个角度。保留适当留白，浅灰纯色背景，均匀柔光，沿用正片或参考图的画面风格。",
    "严格保留脸型、发际线、衣领、服装配色、身体比例、配饰的位置和角色本人左右侧。禁止镜像、拼版、文字、水印和多视图。",
    asset.desc, asset.constraints, ...identity
  ].filter(Boolean).join("\n");
}

function placeCharacterReference(asset, ref) {
  const at = toW(innerWidth / 2 - 150, innerHeight / 2 - 180);
  const media = asset.media.find(item => item.ref === ref);
  return placeLibAsset({...asset, ...media, ref}, at);
}

function characterSource(asset, slot) {
  return asset.character_views?.main || (slot === "main" ? asset.ref : "");
}

function characterDraftKey(asset, slot, board) {
  return ["h3.character.draft", ME_USER?.id, board, asset.id, slot].join(":");
}

const characterDrafts = new Map();

function readCharacterDraft(key) {
  if (characterDrafts.has(key)) return characterDrafts.get(key);
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    characterDrafts.set(key, saved);
    return saved;
  } catch { return null; }
}

function writeCharacterDraft(key, draft) {
  characterDrafts.set(key, draft);
  try {
    if (draft?.submitting) return;
    if (draft) localStorage.setItem(key, JSON.stringify(draft));
    else localStorage.removeItem(key);
  } catch {}
}

async function generateCharacterView(asset, slot, card, board, refresh) {
  const source = characterSource(asset, slot);
  if (!source) return;
  const key = characterDraftKey(asset, slot, board);
  const existing = readCharacterDraft(key);
  if (existing?.submitting || existing?.ids?.length) return;
  writeCharacterDraft(key, {source, submitting: true});
  refresh();
  try {
    const result = await api("/api/generate", {
      kind: "image", model: "h3img", prompt: characterPrompt(asset, slot, card),
      images: [{ref:source}], ar: 3 / 4, quality: "4mp", count: 1,
      seed: -1, turbo: true, board, label: asset.name + " · " + CHARACTER_VIEWS[slot][0]
    });
    if (!result.ids?.length) throw new Error("服务未返回任务编号");
    writeCharacterDraft(key, {source, ids: result.ids});
  } catch (error) {
    writeCharacterDraft(key, {source, error: error.message});
  }
  refresh();
}

async function pollCharacterDraft(key, panel, refresh) {
  while (panel.isConnected) {
    const draft = readCharacterDraft(key);
    if (!draft?.ids?.length) return;
    try {
      const response = await fetch("/api/jobs?ids=" + encodeURIComponent(draft.ids.join(",")));
      if (!response.ok) throw new Error("无法读取任务状态");
      const jobs = await response.json();
      if (readCharacterDraft(key) !== draft) return;
      const states = draft.ids.map(id => jobs[id]).filter(Boolean);
      const failed = states.find(state => state.state === "error");
      const result = states.find(state => state.state === "done");
      if (failed || result || !states.length) {
        const ref = result?.outputs?.find(output => output.ref)?.ref;
        writeCharacterDraft(key, ref
          ? {source: draft.source, ref}
          : {source: draft.source, error: failed?.error || "任务未返回图片，可重新生成"});
        refresh();
        return;
      }
      const state = states[0];
      const progress = state.state === "queued" ? "排队中…" :
        state.max > 1 && Number.isFinite(state.value)
          ? "正在生成 · " + Math.min(99, Math.round(100 * state.value / state.max)) + "%" : "正在生成…";
      if (draft.progress !== progress) { draft.progress = progress; refresh(); }
    } catch {
      if (draft.progress !== "暂时无法读取进度，正在重连…") {
        draft.progress = "暂时无法读取进度，正在重连…";
        refresh();
      }
    }
    await sleep(1400);
  }
}
