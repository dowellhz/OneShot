"use strict";

function versionGenerationModel(version, kind) {
  if (!version || !["image","video"].includes(kind)) return null;
  const record = version.generation_record, settings = record?.settings || {};
  const recipe = version.video_recipe || {}, saved = version.node_data || {};
  const model = settings.provider_model || recipe.selected_model || saved.selected_model;
  const services = CAPS_LIST[kind] || [];
  const candidates = model ? services.filter(service=>service.models?.some(item=>item.id===model)) : [];
  const provider = settings.provider || recipe.provider || saved.provider ||
    (/^h3-(?:video|image)(?:$|-)|^sulphur-3$/.test(model || "") ? "local_h3" : candidates.length===1 ? candidates[0].id : "");
  if (!provider && !model && !record?.service) return null;
  const service = services.find(item=>item.id===provider);
  const providerLabel = provider==="local_h3" ? OneShotI18n.t("本地 H3") : record?.service || service?.name || provider;
  const entry = service?.models?.find(item=>item.id===model);
  const catalogLabel = entry?.label || entry?.endpoint_model;
  const localLabel = { "h3-video":"H3 BF16", "h3-image":"H3-Image", "h3-video-ref2va-int8-convrot":"H3 INT8 ConvRot" }[model];
  const modelLabel = kind==="image" && provider==="local_h3" && (!model || model==="h3-image") &&
    (settings.model || saved.model)==="h3video" ? OneShotI18n.t("H3 快速") : catalogLabel || localLabel || model;
  return {provider,model,label:[...new Set([providerLabel,modelLabel].filter(Boolean))].join(" · ")};
}

function restoreVersionGenerationModel(data, version, kind) {
  const route = versionGenerationModel(version,kind);
  if (!route?.provider || (!route.model && route.provider!=="local_h3")) return;
  data.provider = route.provider;
  if (route.model) data.selected_model = route.model;
  else delete data.selected_model;
  const quality = version.generation_record?.settings?.quality;
  if (typeof quality==="string") data.quality = quality;
}

function restoreOpenedGenerationModel(n) {
  const version = curV(n);
  if (!version || n.job || n.data.model_selection_ref===version.ref) return;
  restoreVersionGenerationModel(n.data,version,n.type);
}
