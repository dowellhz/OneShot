# Linux 部署

## H3 BF16 与 H3-Image

实测环境：RTX 4090 24 GB、125 GB 内存、Ubuntu、CUDA 12.8。引擎常驻约 90 GB 内存（一个大模型 + FP8 文本编码器）。

```bash
# 1. Python 环境（引擎和 Web 服务共用）
python3 -m venv ~/h3engine-venv
~/h3engine-venv/bin/pip install -r requirements.txt

# 2. 从 ModelScope 下载官方管线组件、H3-Image 和提示词指南
export H3_WEIGHTS="$HOME/h3engine/weights"
export H3_IMAGE_BASE="$HOME/h3engine/MiniMax-H3-Image"
bash scripts/fetch_models.sh
```

按下表另行下载 BF16 视频 Transformer、文本编码器和 turbo LoRA。然后在设置过上述环境变量的终端中，从仓库根目录启动引擎。

```bash
~/h3engine-venv/bin/python engine/service.py
```

在另一个终端从仓库根目录启动 Web 服务，首次访问 8190 端口时创建管理员。

```bash
~/h3engine-venv/bin/python server.py
```

| 权重 | 位置（环境变量） | 来源 |
|---|---|---|
| H3 视频 Transformer（fl2va / ref2va，BF16 单文件） | `H3_WEIGHTS/diffusion_models/` | Comfy-Org/MiniMax-H3 |
| Qwen3-VL 文本编码器（单文件） | `H3_WEIGHTS/text_encoders/` | Comfy-Org/MiniMax-H3 |
| turbo LoRA（4 步 768p / 8 步 / Ref 4 步） | `H3_WEIGHTS/loras/` | Comfy-Org/MiniMax-H3 |
| VAE、音频 VAE、调度器、分词器 | `H3_BASE`（默认 `~/h3engine/MiniMax-H3`） | MiniMax/MiniMax-H3 |
| H3-Image（diffusers 版，与视频共用文本编码器） | `H3_IMAGE_BASE` | MiniMax/MiniMax-H3-Image |

## H3 Ref2VA INT8 ConvRot

OneShot 使用 DmitryDB 的 Ref2VA 均衡版检查点，需要先安装支持 MiniMax H3 节点的原生 ComfyUI 和 CUDA 环境。量化 Transformer 约 20.94 GiB。作者的 4090 数据覆盖权重加载和量化投影，整段出片的峰值显存、时长和耗时要通过实际生成测量。 [ComfyUI 安装说明](https://github.com/Comfy-Org/ComfyUI) · [DmitryDB 权重及实测数据](https://huggingface.co/DmitryDB/MiniMax-H3-ComfyUI-Quants/blob/f33fe03608b9e1fffdf6702fd618993d822bfce0/README.md)

在启动 Web 和 H3 引擎的环境中都设置以下路径。示例使用 ComfyUI 自己的 Python 虚拟环境。

```bash
export H3_INT8_COMFY_DIR="$HOME/ComfyUI"
export H3_INT8_PYTHON="$H3_INT8_COMFY_DIR/.venv/bin/python"
export H3_INT8_MODELS="$PWD/models/h3-int8"
```

将以下文件放到对应目录。

| 文件 | 目录 |
|---|---|
| `MiniMax-H3_Ref2VA-INT8-ConvRot.safetensors` | `$H3_INT8_MODELS/diffusion_models/` |
| `minimax_h3_video_vae_fp16.safetensors` 和 `minimax_h3_audio_vae_fp32.safetensors` | `$H3_INT8_MODELS/vae/` |
| `qwen3vl_32b_minimax_h3_bf16.safetensors` | `$H3_INT8_COMFY_DIR/models/text_encoders/` |
| Turbo 所需的 `minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors` | `$H3_INT8_COMFY_DIR/models/loras/` |

Ref2VA 和 VAE 从量化仓库取，文本编码器和 LoRA 从原 Comfy-Org 权重仓库取。 [DmitryDB 文件](https://huggingface.co/DmitryDB/MiniMax-H3-ComfyUI-Quants/tree/c92b1936494a722cdf3cb84d9e3a3d54bb6cbbdd) · [Comfy-Org 权重](https://huggingface.co/Comfy-Org/MiniMax-H3)

用相同的路径配置启动引擎和 Web 服务。每个 INT8 任务由引擎启动隔离的 ComfyUI 进程。确认引擎本机 `/status` 的 `int8_ready` 为真，再从视频节点的模型菜单选择 **H3 Ref2VA INT8 ConvRot**。首次验收可用五秒、480p 的镜头。 [GPU 验收步骤](verification.md#4090-版本验收)

## Sulphur-3 W4A8

将官方量化文件 `quantized/s3_w4a8.safetensors` 放进 `$H3_INT8_MODELS/diffusion_models/`。它复用上面的 ComfyUI、文本编码器和音视频 VAE。确认引擎 `/status` 的 `sulphur_ready` 为真，再在视频节点的本地 H3 模型菜单选择 **Sulphur-3 W4A8**。支持文生视频、首帧和首尾帧。 [模型文件与校验值](https://huggingface.co/SulphurAI/Sulphur-3/blob/988224b9913740d60ee54b5a53c7a892467edc76/quantized/s3_w4a8.safetensors)

## 可选本地图像模型

在与 GPU 引擎相同的 Python 环境下执行。模型与 H3 共用单 GPU 队列。

```bash
python scripts/fetch_image_models.py qwen-image-2.1 flux-2-klein-4b
```

引擎环境需要提供 Diffusers 的 `QwenImage21Pipeline`、`Flux2KleinPipeline` 以及 Accelerate。权重默认位于 `models/image`，可用 `ONESHOT_IMAGE_MODELS` 修改，Web 与引擎应使用相同路径。Qwen-Image-2.1 和 FLUX.2 [klein] 4B 分别遵循其发布仓库的许可证。

## 可选组件

- **提示词改写 / 写剧本（本地）**：[llama.cpp](https://github.com/ggml-org/llama.cpp) 的 `llama-server` + Qwen3.5-9B GGUF 与 mmproj（`H3_LLAMA_SERVER`、`H3_LLM_MODEL`、`H3_LLM_MMPROJ`）。也可以只用第三方文本模型。
- **配音**：`python3 -m venv tts-venv && tts-venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu && tts-venv/bin/pip install "kokoro>=0.9.4" "misaki[zh]>=0.9.4" soundfile`，装好后 `touch tts-venv/.ready`。
- **字幕字体**：把 Noto Sans SC 放到 `fonts/NotoSansSC.ttf`。
- **H3-Image 智能扩写**：需要 H3-Image 官方工作流里的扩写提示词（`templates/h3image_t2i.json`、`h3image_edit.json`），没有时自动跳过。
- **媒体目录**：`COMFY_DIR`（历史名称，默认 `~/ComfyUI`）下的 `output/h3studio/` 和 `input/h3studio/` 存放生成的图片、视频和上传文件。
