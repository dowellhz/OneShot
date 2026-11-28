"""Resolve configured generation models and validate explicit selections."""

from engine import h3_int8, image_models, sulphur
from oneshot.providers import catalog as providers
from oneshot.web import http as http_errors


def configured_models(provider, cap, routes):
    kind = provider["kind"]
    models = [providers.default_model(provider, cap)]
    models.extend(route["model"] for route in routes if route["provider"]["id"] == provider["id"])
    if cap == "video" and kind == "ark":
        models.extend(provider.get("config", {}).get("video_endpoint_models", {}))
    if cap == "video" and kind == "local_h3":
        models = [model for model in models if model != sulphur.MODEL]
        if h3_int8.installed():
            models.append(h3_int8.MODEL)
        if h3_int8.installed(sulphur.WEIGHTS, sulphur.SIZE):
            models.append(sulphur.MODEL)
    if cap == "image" and kind == "local_h3":
        available = [model for model in image_models.MODELS if image_models.installed(model)]
        models = [model for model in models if model not in image_models.MODELS]
        models.extend(available)
    if cap == "image" and kind == "openai":
        models.append("gpt-image-2.6-sunburst")
    return list(dict.fromkeys(model for model in models if model))


def requested_generation_route(raw, cap):
    provider_id = raw.get("provider")
    choice = providers.get(provider_id) if isinstance(provider_id, str) and provider_id else None
    selected = raw.get("selected_model")
    available = choice and choice["enabled"] and cap in providers.caps_of(choice)
    if selected is not None:
        if (not isinstance(selected, str) or not available or
                (choice["kind"].startswith("local_") and (choice["kind"] != "local_h3" or cap not in ("image", "video"))) or
                selected not in configured_models(choice, cap, providers.routes(cap))):
            raise http_errors.bad("所选模型已不可用，请重新选择模型")
        return {"provider":choice, "model":selected}
    if available:
        model = raw.get("provider_model") or providers.default_model(choice, cap)
        if model is not None and not isinstance(model, str):
            raise http_errors.bad("所选模型已不可用，请重新选择模型")
        return {"provider":choice, "model":model}
    if cap == "video" and provider_id == "local_h3":
        raise http_errors.bad("本地 H3 服务已不可用，请重新选择模型")
    if provider_id:
        raise http_errors.bad("所选生成服务不可用，请重新选择服务")
    return providers.primary(cap)
