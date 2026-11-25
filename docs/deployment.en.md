# Linux deployment

## H3 BF16 and H3-Image

Tested with an RTX 4090 (24 GB), 125 GB of system RAM, Ubuntu, and CUDA 12.8. The engine uses about 90 GB of system RAM while holding one large model and the FP8 text encoder.

```bash
# 1. Create the Python environment shared by the Web service and the engine.
python3 -m venv ~/h3engine-venv
~/h3engine-venv/bin/pip install -r requirements.txt

# 2. Download the official pipeline components, H3-Image, and prompt guides from ModelScope.
export H3_WEIGHTS="$HOME/h3engine/weights"
export H3_IMAGE_BASE="$HOME/h3engine/MiniMax-H3-Image"
bash scripts/fetch_models.sh
```

Download the BF16 video transformers, text encoder, and turbo LoRA separately as listed below. From the repository root, start the engine in the terminal where you set the environment variables above.

```bash
~/h3engine-venv/bin/python engine/service.py
```

Start the web service from the repository root in a separate terminal and create an administrator on your first visit to port 8190.

```bash
~/h3engine-venv/bin/python server.py
```

| Model files | Location or environment variable | Source |
| --- | --- | --- |
| H3 video Transformer (fl2va / ref2va, BF16 single file) | `H3_WEIGHTS/diffusion_models/` | Comfy-Org/MiniMax-H3 |
| Qwen3-VL text encoder (single file) | `H3_WEIGHTS/text_encoders/` | Comfy-Org/MiniMax-H3 |
| Turbo LoRA (4-step 768p / 8-step / 4-step Ref) | `H3_WEIGHTS/loras/` | Comfy-Org/MiniMax-H3 |
| VAE, audio VAE, scheduler, and tokenizer | `H3_BASE` (default `~/h3engine/MiniMax-H3`) | MiniMax/MiniMax-H3 |
| H3-Image for Diffusers, sharing the video text encoder | `H3_IMAGE_BASE` | MiniMax/MiniMax-H3-Image |

## H3 Ref2VA INT8 ConvRot

OneShot uses the balanced DmitryDB Ref2VA checkpoint with a stock CUDA-enabled ComfyUI runtime that supports the MiniMax H3 nodes. Install ComfyUI and its dependencies first. The quantized transformer is 20.94 GiB. The author's 4090 loader result covers the checkpoint and a quantized projection. Measure end-to-end peak VRAM, duration, and runtime on your machine with an actual generation. [ComfyUI setup](https://github.com/Comfy-Org/ComfyUI) · [DmitryDB checkpoints and measurements](https://huggingface.co/DmitryDB/MiniMax-H3-ComfyUI-Quants/blob/f33fe03608b9e1fffdf6702fd618993d822bfce0/README.md)

Set these paths for both the Web and H3 engine processes. The commands assume ComfyUI has its Python environment at `~/ComfyUI/.venv`.

```bash
export H3_INT8_COMFY_DIR="$HOME/ComfyUI"
export H3_INT8_PYTHON="$H3_INT8_COMFY_DIR/.venv/bin/python"
export H3_INT8_MODELS="$PWD/models/h3-int8"
```

Download these files and place them in the indicated locations.

| File | Location |
|---|---|
| `MiniMax-H3_Ref2VA-INT8-ConvRot.safetensors` | `$H3_INT8_MODELS/diffusion_models/` |
| `minimax_h3_video_vae_fp16.safetensors` and `minimax_h3_audio_vae_fp32.safetensors` | `$H3_INT8_MODELS/vae/` |
| `qwen3vl_32b_minimax_h3_bf16.safetensors` | `$H3_INT8_COMFY_DIR/models/text_encoders/` |
| `minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors` for Turbo | `$H3_INT8_COMFY_DIR/models/loras/` |

Use the Ref2VA and VAE files from the quantization repository and the text encoder and LoRA from the original Comfy-Org weights. [DmitryDB files](https://huggingface.co/DmitryDB/MiniMax-H3-ComfyUI-Quants/tree/c92b1936494a722cdf3cb84d9e3a3d54bb6cbbdd) · [Comfy-Org weights](https://huggingface.co/Comfy-Org/MiniMax-H3)

Start the engine and Web service with the same paths. The engine starts an isolated ComfyUI instance for each INT8 job. Check `int8_ready` in the engine's local `/status` response, then select **H3 Ref2VA INT8 ConvRot** from a video node's model menu. A five-second 480p shot is the first acceptance case. [GPU acceptance procedure](verification.en.md#4090-release-acceptance)

## Optional components

- **Local prompt rewriting and scriptwriting** use `llama-server` with Qwen3.5-9B GGUF and mmproj. Set `H3_LLAMA_SERVER`, `H3_LLM_MODEL`, and `H3_LLM_MMPROJ`. A third-party text provider can handle these tasks as well. [llama.cpp](https://github.com/ggml-org/llama.cpp)
- **Voiceover** uses a CPU environment. Run `python3 -m venv tts-venv && tts-venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu && tts-venv/bin/pip install "kokoro>=0.9.4" "misaki[zh]>=0.9.4" soundfile`, then run `touch tts-venv/.ready`.
- **Subtitle font** uses Noto Sans SC at `fonts/NotoSansSC.ttf`.
- **H3-Image prompt expansion** uses the official workflow prompts from `templates/h3image_t2i.json` and `h3image_edit.json`. Expansion is skipped if the templates are unavailable.
- **Media storage** uses `output/h3studio/` and `input/h3studio/` under `COMFY_DIR`, which defaults to `~/ComfyUI`.
