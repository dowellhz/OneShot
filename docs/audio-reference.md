# 画布音频

## 分离人声和伴奏

选中画布上的视频或音频，在右键菜单或浮动工具栏点击「人声分离」。全屏预览时也能用这个入口处理当前查看的版本。每次最多分离 10 分钟，结束时间留空会处理到素材结尾。关闭窗口后任务会继续，再打开可查看同一版本最近一次结果。

结果是两条独立的立体声 WAV，分别包含人声和其余声音。两条音轨可以试听、下载或放到画布，素材节点会记录原版本和分离区间。对视频点击「在剪辑台使用」会打开对应视频区间和两条对齐的音轨，原视频音量设为零。可单独调整音量、删除音轨并导出为原视频节点的新版本。对白和背景音乐混得很重时，音轨可能留有串音。

在创作助手引用一段视频或音频，也可以说「把这段素材的第 1 到第 5 秒分离为人声和伴奏」，结果会作为两个关联音频节点放入画布。

部署主机使用 [Demucs v4.0.1](https://github.com/facebookresearch/demucs/tree/v4.0.1) 的 `htdemucs` 模型。建议在已有 OneShot 环境之外建立独立的 Python 3.11 环境，CPU 模式与现有视频生成分开使用资源。

```sh
python3.11 -m venv "$HOME/.venvs/oneshot-demucs"
"$HOME/.venvs/oneshot-demucs/bin/pip" install torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cpu
"$HOME/.venvs/oneshot-demucs/bin/pip" install demucs==4.0.1 soundfile
export ONESHOT_DEMUCS_BIN="$HOME/.venvs/oneshot-demucs/bin/demucs"
```

以上安装命令适用于 Linux CPU 环境。确认部署机有 FFmpeg，把 `ONESHOT_DEMUCS_BIN` 放入 OneShot 服务环境。可先用服务账号对任意一段自有音频运行 `"$ONESHOT_DEMUCS_BIN" -n htdemucs -d cpu --two-stems vocals 音频.wav`，预载模型权重。需要使用 CUDA 时，安装匹配的 PyTorch 和 TorchAudio，再为服务配置 `ONESHOT_DEMUCS_DEVICE=cuda`。

通过画布「＋ → 上传图片、视频或音频」选择 WAV、MP3、M4A、AAC、FLAC 或 OGG，也可以把文件拖到画布空白处。音频节点可以试听、下载和上传新版本，素材库的「音频」筛选会列出可复用的音频。

## 生成配音或音乐

打开「＋ → 音频生成」。选「配音」后输入对白或旁白，选可用服务、音色和语速。选「音乐」时描述风格、情绪、节奏和乐器。可以填写歌词，留空时生成纯音乐。可用服务来自「控制台 → 模型与服务」，例如已安装的本地 Kokoro 或已配置的云端语音和音乐服务。

每次完成后会在同一个音频节点增加一个版本，可播放或下载。切换到旧版本可以恢复当时的文案、服务和声线设置。在创作助手里也可以说「用自然女声朗读这段旁白」或「用原音频节点再生成一版爵士配乐」，完成后可直接在对话中试听。

## 用音频生成视频

把音频节点的右侧连线拖到普通视频节点，或在视频节点左侧「＋」选用画布音频。点击提示词上方的音频标签插入 `@音1` 等编号，说明希望参考语调、节奏还是环境声。可同时连入图片与白模。切换音频节点的版本会保留原引用，点击「改用当前版本」可以更新。创作助手也可以采用明确指定的音频节点和版本。

使用支持全模态参考的 Seedance 2.x。Seedance 2.0 和使用接入点编号配置的服务需要同时连入图片或视频参考，参考音频总长至多 15 秒。已知的 Seedance 2.5 系列可单独采用音频参考，总长至多 30 秒。每段音频至少 2 秒。音频参考会由模型生成新声音。 [方舟视频 API](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)

## 在剪辑台保留原音

在剪辑台把播放头移到需要加入声音的位置，再从「选用画布音频」选择素材。它会作为单独的音频片段进入时间线，可调整入点、出点和音量，并随成片一起导出。
