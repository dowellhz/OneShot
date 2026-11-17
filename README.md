# OneShot

一句话做成片的 AI 视频工作台：写下想法，AI 帮你写剧本、定角色、出分镜图、生成带声音的视频、剪成片。
本地运行完整的 MiniMax-H3（视频）和 H3-Image（图片），也可以接入第三方 API。多人账号，统一的 Web 控制台。

![OneShot 画布：参考图、分镜图和视频节点，下方是分栏填写的视频提示词面板](docs/screenshot.png)

## 功能

- **一句话成片向导**：想法 / 模板 → 剧本（可逐镜修改）→ 角色定妆照与声音描述 → 分镜图 → 视频（可每镜抽卡）→ 成片
- **画布**：文本 / 图片 / 视频 / 分镜脚本节点，连线即引用；视频提示词可「分栏填写」（风格、场景、人物、镜头、动作、对话、声音、配乐），自动合成 H3 官方结构
- **创作助手（第二阶段）**：右下角打开对话，使用控制台配置的文本模型进行多轮工具调用；选中节点或通过 `@ 引用` 指定素材，完成看图、生图、改图、抠图、裁剪调色、文本创建和画布排列。操作卡片展示真实任务进度，结果可以定位，支持停止、历史恢复与撤销本轮画布改动。支持 Markdown、主体保护重绘、手动选区等待、图层调整、对比与参数复用，以及视频生成 / 重生成和关键帧替换。普通修改在原节点追加历史版本，通过 Tab 切换；视频版本同步恢复输入连线与参数。每轮最多生成 4 张图和 1 段视频、调用 16 次工具、执行 30 分钟；配音和成片工具留待后续阶段。[使用与实现说明](docs/agent-chat.md)
- **工具**：三视图、九宫格、换角度等图片模板，宫格拆分，高清重绘，反推提示词，看图填写，拉片（切镜头 + 分析，逐镜复刻）
- **图像编辑**：选中图片 →「编辑图片」，支持画笔 / 矩形选区、擦除 / 反选、局部重绘、整图文字编辑、四边扩图，以及裁剪、旋转、翻转、亮度 / 对比度 / 饱和度调整；原图对比与历史版本切换。AI 任务沿用现有图像服务，选区外像素由遮罩合成保护。[使用与实现说明](docs/image-editing.md)
- **完整编辑工作区**：图片缩放平移、草稿恢复、选区撤销重做、滑杆 / 并排对比、参数复用与重试、透明图层、SAM2 智能选物、自动抠图、SD 原生遮罩重绘、浮窗停靠；画布多选对齐、等距排列、编组与 ZIP 批量下载。新增模型可在 4090 上运行 `python scripts/fetch_editor_models.py` 准备。
- **剪辑台**：排序、裁剪、叠化 / 黑场转场、台词自动成字幕、背景音乐（人声时自动压低）、旁白配音、封面、横竖屏
- **资产库**：角色 / 场景 / 道具，跨项目复用，可团队共享
- **控制台**（`/console`）：项目、任务中心（耗时、失败原因、费用）、模型与服务、本地部署、成员
- **模型与服务**：每项能力（文本、看图、生图、生视频、配音、配乐）选默认服务和备用服务，画布节点也可单独选
  - 本地：H3 视频 + H3-Image（自研引擎）、Qwen3.5-9B（llama.cpp）、Kokoro 中文配音（CPU）
  - 第三方：可灵、MiniMax（云端 H3 / 语音 / 音乐）、火山方舟（Seedance / Seedream）、阿里云百炼（千问 / 万相）、DeepSeek、OpenAI、任意 OpenAI 兼容接口

> 第三方适配器按各家 2026-11 的官方文档实现，尚未全部用真实 Key 验证。

## 架构

```
浏览器 ──▶ server.py（aiohttp，:8190）── 账号、项目、任务、路由、剪辑渲染（PyAV）
              │
              ├─▶ engine/service.py（:8189，本机）── H3 引擎：diffusers 运行完整 MiniMax-H3 / H3-Image
              ├─▶ llama-server（:8191，按需）── Qwen3.5-9B 写剧本、改写、看图
              ├─▶ tts_worker.py（CPU）── Kokoro 配音
              └─▶ 第三方 API（remote.py）
```

| 文件 | 内容 |
|---|---|
| `server.py` | Web 服务、画布 API、生成路由、剪辑渲染、控制台 API |
| `auth.py` / `db.py` | 多人账号（scrypt）、会话、SQLite（服务、路由、任务），API Key 用 Fernet 加密存储 |
| `providers.py` / `remote.py` | 服务目录与能力路由；第三方生图 / 视频 / 配音 / 音乐适配器 |
| `engine/h3engine.py` | 完整 H3（31B BF16）在 24 GB 显卡上运行：权重放在锁页内存里按 Transformer 块流式上卡，文本编码器 FP8 存储，turbo LoRA 加载时合并 |
| `engine/service.py` | 引擎服务：单 GPU 队列、进度、取消、视频 / 图片模型按需切换 |
| `rewriter.py` / `fields.py` / `tools.py` | 提示词改写与分栏合成、分镜、反推、拉片、宫格、拼接 |
| `image_editor.py` / `static/image-editor.js` | 图像编辑、选区上下文、扩图与遮罩合成、历史版本界面 |
| `agent_chat.py` / `agent_editing.py` / `agent_video.py` / `static/agent-chat.js` | 持久化聊天与工具执行、图片版本绑定、防重复提交、进度、停止、撤销与画布同步 |
| `render.py` | 成片渲染（转场、字幕、配乐压低、旁白） |
| `local_admin.py` / `engine.sh` | 本地部署页：GPU / 内存 / 磁盘、服务启停、模型文件 |
| `static/` | 画布（`index.html` + `tools.js` `film.js` `wizard.js` `account.js`）、控制台、登录页 |

## 部署（Linux + NVIDIA 24 GB 显卡）

实测环境：RTX 4090 24 GB、125 GB 内存、Ubuntu、CUDA 12.8。引擎常驻约 90 GB 内存（一个大模型 + FP8 文本编码器）。

```bash
# 1. Python 环境（引擎和 Web 服务共用）
python3 -m venv ~/h3engine-venv
~/h3engine-venv/bin/pip install -r requirements.txt

# 2. 模型权重（见下表；scripts/fetch_models.sh 从 ModelScope 下载官方组件和提示词指南）
bash scripts/fetch_models.sh

# 3. 启动引擎和 Web 服务
bash engine.sh engine-start
~/h3engine-venv/bin/python server.py      # http://<主机>:8190 ，第一次打开时创建管理员
```

| 权重 | 位置（环境变量） | 来源 |
|---|---|---|
| H3 视频 Transformer（fl2va / ref2va，BF16 单文件） | `H3_WEIGHTS/diffusion_models/` | Comfy-Org/MiniMax-H3 |
| Qwen3-VL 文本编码器（单文件） | `H3_WEIGHTS/text_encoders/` | Comfy-Org/MiniMax-H3 |
| turbo LoRA（4 步 768p / 8 步 / Ref 4 步） | `H3_WEIGHTS/loras/` | Comfy-Org/MiniMax-H3 |
| VAE、音频 VAE、调度器、分词器 | `H3_BASE`（默认 `~/h3engine/MiniMax-H3`） | MiniMax/MiniMax-H3 |
| H3-Image（diffusers 版，与视频共用文本编码器） | `H3_IMAGE_BASE` | MiniMax/MiniMax-H3-Image |

其他可选组件：

- **提示词改写 / 写剧本（本地）**：[llama.cpp](https://github.com/ggml-org/llama.cpp) 的 `llama-server` + Qwen3.5-9B GGUF 与 mmproj（`H3_LLAMA_SERVER`、`H3_LLM_MODEL`、`H3_LLM_MMPROJ`）。也可以只用第三方文本模型。
- **配音**：`python3 -m venv tts-venv && tts-venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu && tts-venv/bin/pip install "kokoro>=0.9.4" "misaki[zh]>=0.9.4" soundfile`，装好后 `touch tts-venv/.ready`。
- **字幕字体**：把 Noto Sans SC 放到 `fonts/NotoSansSC.ttf`。
- **H3-Image 智能扩写**：需要 H3-Image 官方工作流里的扩写提示词（`templates/h3image_t2i.json`、`h3image_edit.json`），没有时自动跳过。
- **媒体目录**：`COMFY_DIR`（历史名称，默认 `~/ComfyUI`）下的 `output/h3studio/` 和 `input/h3studio/` 存放生成的图片、视频和上传文件。

## 许可

MiniMax-H3 与 H3-Image 的权重遵循 MiniMax H3 Community License。
