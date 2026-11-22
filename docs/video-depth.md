# 镜头深度参考

在视频节点上打开「视频重制」，分析原片后选择镜头。展开「镜头深度参考」，点击生成。任务在同一工作区显示进度，可取消。完成后可播放、下载 MP4，或把参考作为单独节点放入画布并保留与原片版本的连线。深度参考独立于镜头审核和成片。

每段最长 14 秒。生成时按当前剪辑点和显示方向截取镜头，用相对深度模型提取前后层次，输出与镜头帧数相同的 24 FPS 无声灰度视频。推理采用 12 FPS 采样。

## 用深度参考重制镜头

生成深度参考并采用替换后的首帧后，选择一个 Seedance 服务，点击「用深度参考生成」。首帧图提供角色外观、色彩和开场构图。深度视频提供走位、遮挡和运镜。完成后可对照原片、局部合成和采用，成片仍可保留原声。

该入口支持 2 到 14 秒、宽高比在 0.4 到 2.5 之间的镜头。已采用入画帧或校正关键帧的镜头继续从「生成镜头视频」进入按关键帧生成。

在「控制台 → 模型与服务」编辑火山方舟，填写「参考视频公网地址」。这个地址是方舟能访问的 OneShot HTTPS 站点根地址，反向代理需转发 `GET` 和 `HEAD` 的 `/api/motion-guide/` 路径。选择支持全模态参考的 Seedance 2.5、2.0 或相应接入点 ID。OneShot 仅在提交这一模式时开放单个重新编码后的深度视频，使用临时随机链接，任务结束、取消或链接到期后收回。原片和原声音轨不会通过该链接提供。方舟请求由所选账户计费。[方舟视频 API](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)

## 在 OneShot 部署主机安装

1. 准备 [Video Depth Anything 官方代码](https://github.com/DepthAnything/Video-Depth-Anything/tree/4f5ae23172ba60fd7bc11ef671cca678842c7072) 和可运行其 `run.py` 的独立 Python 环境。按模型项目说明安装依赖。OneShot 以 CPU 和 FP32 调用上游入口。
2. 从 [Small 模型仓库](https://huggingface.co/depth-anything/Video-Depth-Anything-Small/tree/main) 下载 `video_depth_anything_vits.pth`，放进上游目录的 `checkpoints/`。Small 权重采用 Apache-2.0。
3. 将上游目录放到 OneShot 的 `models/Video-Depth-Anything/`，或在 OneShot 进程中设置 `ONESHOT_DEPTH_HOME` 指向上游目录。若模型依赖在独立环境中，设置 `ONESHOT_DEPTH_PYTHON` 为该环境 Python 的绝对路径。保存进程配置后，按部署方式重载 OneShot。

模型代码和权重留在部署主机。深度任务串行运行，使用独立于剪辑渲染的队列。
