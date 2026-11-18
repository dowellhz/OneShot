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

function generateCharacterView(asset, slot, card) {
  const ref = asset.character_views?.main || (slot === "main" ? asset.ref : "");
  if (!ref) return toast(slot === "main" ? "请先保存一张原始角色图片" : "请先定稿标准主图");
  const source = B.nodes.find(n => n.type === "image" && curV(n)?.ref === ref)
    || placeCharacterReference(asset, ref);
  checkpoint();
  const at = placeRight(source, "image");
  const draft = addNode("image", at.x, at.y, {
    prompt: characterPrompt(asset, slot, card), aspect: "3:4", count: 1,
    character_draft: {asset: asset.id, slot, source: ref}
  }, {name: asset.name + " · " + CHARACTER_VIEWS[slot][0]});
  link(source, draft, true);
  selectOnly(draft.id);
  alClose();
  CM.editor?.querySelector("[data-close]").click();
  generate(draft);
  toast("生成后请在资产详情核对草稿并定稿");
}
