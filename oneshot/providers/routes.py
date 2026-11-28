"""Model and service capabilities exposed to the canvas."""

from aiohttp import web

from engine import h3_int8, image_models, sulphur
from oneshot.editing import audio_routes
from oneshot.editing import render as film
from oneshot.generation import motion_reference
from oneshot.generation import reference as video_reference
from oneshot.generation import rewriter
from oneshot.generation.audio import AUDIO_GENERATION_MODES
from oneshot.providers import catalog as providers
from oneshot.providers import remote
from oneshot.providers.selection import configured_models


def canvas_provider_choices(cap, *, enabled=None):
    if enabled is None:
        enabled = [provider for provider in providers.all_providers() if provider["enabled"]]
    rts = providers.routes(cap)
    default = rts[0]["provider"]["id"] if rts else None
    choices = []
    for pr in enabled:
        if cap in providers.caps_of(pr):
            model = providers.default_model(pr,cap)
            local = pr["kind"].startswith("local_")
            choices.append({"id":pr["id"],"name":pr["name"],"kind":pr["kind"],"local":local,
                "model":model,"default":pr["id"]==default,
                **({"default_route_model":rts[0]["model"]} if pr["id"]==default else {}),
                **({"models":[canvas_model_choice(pr,cap,choice) for choice in configured_models(pr,cap,rts)]}
                   if cap in ("video", "image") else {}),
                **({"draft":remote.supports_video_draft(pr,model)} if cap=="video" else {})})
    choices.sort(key=lambda item:(not item["default"],not item["local"]))
    return choices


async def capabilities(req):
    """What each node can pick: providers that offer a capability (default first)."""
    enabled = [provider for provider in providers.all_providers() if provider["enabled"]]
    out = {cap:canvas_provider_choices(cap,enabled=enabled) for cap in providers.CAPS}
    route = providers.primary("video")
    out["default_video_draft"] = bool(route and remote.supports_video_draft(route["provider"],route["model"]))
    out["video_quality_precheck"] = h3_int8.installed() and all(path.is_file() for path in (rewriter.LLAMA, rewriter.MODEL, rewriter.MMPROJ))
    out["previs"] = canvas_reference_choices(require_motion=True)
    out["video_extension"] = canvas_reference_choices(require_motion=True,extension=True)
    out["audio_reference"] = canvas_reference_choices()
    out["segment_edit"] = canvas_reference_choices(segment_edit=True)
    out["audio_generation"] = {cap:audio_routes.audio_service_options(cap) for cap in AUDIO_GENERATION_MODES}
    out["audio_voice_setup"] = [
        {"id":provider["id"], "name":provider["name"]} for provider in enabled
        if provider["kind"] in providers.VOICE_LIST_PROVIDERS and provider.get("secrets", {}).get("api_key")
        and not providers.configured_voices(provider["kind"], provider["config"].get("voices", ""))
    ]
    out["audio_output"] = film.AUDIO_OUTPUT_RATES
    out["audio_effects"] = True
    return web.json_response(out)


def canvas_model_choice(provider, cap, model):
    if cap != "video":
        if cap == "image":
            if provider["kind"] == "local_h3" and (spec := image_models.MODELS.get(model)):
                return {"id":model, "label":spec.label, "image_engine":True, "ref_limit":spec.references,
                        "high_resolution":spec.high_resolution}
            if model == "gemini-3.1-flash-image" and provider["kind"] == "gemini":
                return {"id":model, "label":"Nano Banana 2", "ref_limit":14}
            if model == "gpt-image-2.6-sunburst" and provider["kind"] == "openai":
                return {"id":model, "label":"GPT-Image-2.6 Sunburst"}
        return {"id":model}
    kind = provider["kind"]
    audio = motion_reference.supports_audio(provider,model)
    video = motion_reference.supports(provider,model)
    ref_images = motion_reference.image_reference_limit(provider,model)
    model_for_limits = motion_reference.video_model_for_limits(provider,model)
    count, seconds = motion_reference.av_limits(model_for_limits)
    label = {h3_int8.MODEL: h3_int8.LABEL, "h3-video": "H3 BF16", sulphur.MODEL: sulphur.LABEL}.get(model) if kind == "local_h3" else None
    return {"id":model, **({"label": label} if label else {}), "draft":remote.supports_video_draft(provider,model),
            **({"first_last_only":True,"fixed_sampling":True} if kind=="local_h3" and model==sulphur.MODEL else {}),
            "durations":[5,8,10,14] if kind == "local_h3" else remote.video_durations(kind,model,provider=provider),
            "qualities":remote.video_resolutions(kind,model,provider=provider),
            "default_quality":remote.default_video_quality(kind,model,provider=provider),
            **({"endpoint_model":model_for_limits} if model_for_limits != model else {}),
            "accepts_audio":audio,"accepts_video":video,
            **({"reference_limits":{"images":ref_images,"videos":count if video else 0,
                "audio":count if audio else 0,"seconds":seconds,**({"total":12} if kind == "minimax" else {})}} if ref_images else {})}


def canvas_reference_choices(**constraints):
    services = {}
    for route in video_reference.reference_routes(**constraints, all_models=True):
        provider, model = route["provider"], route["model"]
        option = canvas_model_choice(provider, "video", model)
        service = services.setdefault(provider["id"], {"id":provider["id"], "name":provider["name"],
                                                       "model":model, "draft":option["draft"], "models":[]})
        service["models"].append(option)
    return list(services.values())
