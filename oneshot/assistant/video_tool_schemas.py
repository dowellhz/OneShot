"""Video tools and argument schemas exposed to the assistant."""
from __future__ import annotations

from oneshot.editing import broll
from oneshot.editing import camera_plan
from oneshot.editing import image_camera
from oneshot.editing import object_edit
from oneshot.editing import previs
from oneshot.editing import video_remake
from oneshot.editing.render import CUTAWAY_LIMIT
from oneshot.editing.render import FPS
from oneshot.editing.render import GIF_FPS
from oneshot.editing.render import GIF_SIZES
from oneshot.editing.render import TITLE_LIMIT
from oneshot.editing.render import TITLE_POSITIONS
from oneshot.editing.render import TITLE_STYLES
from oneshot.memory import creative_memory


NAMES = {"video_models", "video_generate", "video_regenerate", "video_extend", "video_edit_segment", "video_object_settings", "video_capture_frame", "video_remake_status", "video_remake_analyze", "video_remake_plan",
         "video_draft_status", "video_draft_finalize", "video_titles_get", "video_titles_edit",
         "video_cutaways_get", "video_cutaways_edit", "video_broll_generate", "video_export_gif",
         "video_remake_split_long", "video_remake_map", "video_remake_locate", "video_remake_preview", "video_remake_generate",
         "video_remake_review", "video_remake_export", "video_previs_get", "video_previs_save", "video_previs_render",
         "video_previs_camera_motion", "video_previs_object_motion", "video_previs_storyboard_plan"}


def register(tool, prop, node, prompt):
    frame = prop("object", properties={"node_id": node, "role": prop("string", enum=["first", "last", "keyframe", "subject"]),
                                      "time": prop("number", minimum=0, maximum=15)}, required=["node_id"], additionalProperties=False)
    optics = prop("object",properties={
        "lens":prop("integer",enum=list(image_camera.LENSES)), "sensor":prop("string",enum=list(image_camera.SENSORS)),
        "optics":prop("string",enum=list(image_camera.OPTICS)), "aperture":prop("string",enum=list(image_camera.APERTURES)),
    },additionalProperties=False)
    options = {"prompt": prompt, "duration": prop("number", minimum=2, maximum=30),
               "quality": prop("string", enum=["hd","std","480p","4k"],description="选择当前模型支持的分辨率。480p 与 4k 为显式档位。"),
               "selected_model": prop("string", minLength=1,maxLength=200,description="用 video_models 查到的具体模型 ID。新生成时须同时传该模型的 provider。"),
               "draft": prop("boolean"),
               "video_optics":optics,
               "memory_views":creative_memory.view_selection_schema(prop),
               "seed": prop("integer", minimum=-1, maximum=2**48), "provider": prop("string", maxLength=100), "name": node}
    guide = prop("object", properties={"node_id":node, "version":prop("integer", minimum=1, maximum=5000)},
                 required=["node_id"], additionalProperties=False)
    clips = prop("array", items=prop("object", properties={**guide["properties"],
                 "start":prop("number", minimum=0), "end":prop("number", minimum=0)},
                 required=["node_id"], additionalProperties=False), maxItems=10)
    sounds = clips
    camera_view=prop("object",properties={"angle":prop("string",enum=list(camera_plan.ANGLES)),
                     "scale":prop("string",enum=list(camera_plan.SCALES))},required=["angle","scale"],additionalProperties=False)
    camera=prop("object",properties={"mode":prop("string",enum=list(camera_plan.MODES)),
                "start":camera_view,"end":camera_view},required=["mode","start"],additionalProperties=False)
    replacement=prop("object",properties={**guide["properties"],"memory_id":node},additionalProperties=False)
    object_plan=prop("object",properties={"action":prop("string",enum=list(object_edit.ACTIONS)), "at":prop("number",minimum=0),
                     "box":prop("array",items=prop("number",minimum=0,maximum=1),minItems=4,maxItems=4),
                     "replacement":replacement},additionalProperties=False)
    tool("video_models", "读取当前可选视频模型、服务 ID、支持的时长、分辨率和参考能力。选模式可筛选音视频参考、续拍或片段编辑。", {
        "mode":prop("string",enum=["generation","audio_reference","video_reference","extension","segment_edit"]),
    }, [])
    tool("video_generate", "生成真正的视频（MP4）。frames 支持首尾帧、关键帧和人物设定；提供已渲染的 previs 时，图片作为外观参考，白模控制运镜和走位。", {
        **options, "frames": prop("array", items=frame, maxItems=30), "previs":guide, "audio_refs":sounds, "video_refs":clips}, ["prompt"])
    tool("video_extend", "生成接在现有视频之前或之后的新镜头。method 默认 auto，有支持的连续参考服务时使用原片连续画面，否则在本地 H3 以接点帧接拍。method=frame 指定本地接拍，method=motion 指定连续画面参考。node_id 指原视频，version 省略时使用本轮所选版本；before 补拍片头，after 续拍片尾。", {
        **options, **guide["properties"], "direction":prop("string", enum=["before","after"]),
        "method":prop("string", enum=["auto","frame","motion"]),
        "frames":prop("array", items=frame, maxItems=30), "audio_refs":sounds, "video_refs":clips}, ["node_id","direction","prompt"])
    tool("video_edit_segment", "编辑原片的指定范围（4 到 30 秒），结果放在相连的新节点。普通修改提供 prompt；重拍提供 camera_plan；框选物体用 object_edit，须有明确的原片秒数 at 和归一化框 [左,上,右,下]。替换参考用 replacement 的图片节点或资产ID。", {
        "node_id":node,"version":guide["properties"]["version"],"prompt":prompt,"provider":options["provider"],"name":node,"draft":options["draft"],"video_optics":optics,
        "memory_views":options["memory_views"],
        "start":prop("number",minimum=0),"end":prop("number",minimum=0),
        "frames":prop("array",items=frame,maxItems=30),"audio_refs":sounds,"video_refs":clips,"camera_plan":camera,"object_edit":object_plan},
        ["node_id","start","end"])
    tool("video_object_settings", "读取物体编辑节点已保存的原片区间、框选位置及替换参考图。可读取还未生成的草稿或指定历史版本。", guide["properties"], ["node_id"])
    tool("video_draft_status", "列出视频节点中实际生成过的 480p 样片及其定稿有效期；普通视频不会列为样片。", {"node_id":node}, ["node_id"])
    tool("video_draft_finalize", "把已生成的原生 480p 样片交给原生成服务定稿。placement=branch 把定稿放到相连的新节点，默认 tab 在原节点追加定稿版本。version 选定样片版本，默认当前引用；resolution 默认 1080p。", {
        **guide["properties"],"resolution":prop("string",enum=["1080p","4k"]),
        "placement":prop("string",enum=["tab","branch"])}, ["node_id"])
    tool("video_titles_get", "读取所选视频版本的时长和可编辑画面标题。标题编号从 1 开始，时间是该版本的成片秒数。", guide["properties"], ["node_id"])
    title = prop("object", properties={"text":prop("string",minLength=1,maxLength=120),
        "start":prop("number",minimum=0),"end":prop("number",minimum=0),
        "position":prop("string",enum=list(TITLE_POSITIONS)),"style":prop("string",enum=sorted(TITLE_STYLES))},
        additionalProperties=False)
    change = prop("object", properties={"action":prop("string",enum=["add","update","remove"]),
        "number":prop("integer",minimum=1,maximum=TITLE_LIMIT),"title":title}, required=["action"], additionalProperties=False)
    tool("video_titles_edit", "给已有视频添加、修改或移除片头、地名条等画面文字。add 提供 title.text，其他字段可选；update 必须提供原编号和要改的 title 字段；remove 只提供原编号。同次改动中编号以原列表为准。输出追加到原节点新版本。", {
        **guide["properties"],"changes":prop("array",items=change,minItems=1,maxItems=TITLE_LIMIT)}, ["node_id","changes"])
    source = prop("object",properties={**guide["properties"],"memory_id":node},additionalProperties=False)
    cutaway = prop("object",properties={"source":source,"start":prop("number",minimum=0),
        "duration":prop("number",minimum=1/24),"in":prop("number",minimum=0)},additionalProperties=False)
    cutaway_change = prop("object",properties={"action":prop("string",enum=["add","update","remove"]),
        "number":prop("integer",minimum=1,maximum=CUTAWAY_LIMIT),"cutaway":cutaway},required=["action"],additionalProperties=False)
    tool("video_cutaways_get", "读取所选视频版本的时长、补画面编号和标题，不会提交渲染。", guide["properties"], ["node_id"])
    tool("video_cutaways_edit", "在现有视频指定时段插入补画面，保留主片时长、声音和字幕。同一次可改标题。add 提供 cutaway.source（画布图片/视频节点及可选版本，或资产 memory_id）、start 和 duration，视频可用 in 指定源素材入点。update 传原编号与改动；remove 只传原编号。编号以改动前为准。结果保存到原节点的新版本。", {
        **guide["properties"],"changes":prop("array",items=cutaway_change,minItems=1,maxItems=CUTAWAY_LIMIT),
        "title_changes":prop("array",items=change,minItems=1,maxItems=TITLE_LIMIT)}, ["node_id","changes"])
    graphics_bar = prop("object",properties={"label":prop("string",minLength=1,maxLength=18),
        "value":prop("number",minimum=0,maximum=1e9)},required=["label","value"],additionalProperties=False)
    tool("video_broll_generate", "在用户确认后，把指定图片或视频版本制作成相连的独立 B-roll 视频。title 为动态标题，captions 为依次显示的字幕卡，chart 为条形图，motion 为图片推拉。只做草稿时直接用文字回复。图表只用用户给出的数值，不补造。start/end 是源视频或图片片段的秒数，视频保留原声和总长，图片片段默认 4 秒。", {
        **guide["properties"],"mode":prop("string",enum=list(broll.MODES)),"style":prop("string",enum=sorted(broll.STYLES)),
        "start":prop("number",minimum=0),"end":prop("number",minimum=0),"duration":prop("number",minimum=.5,maximum=12),
        "title":prop("string",minLength=1,maxLength=100),"lines":prop("array",items=prop("string",minLength=1,maxLength=70),minItems=1,maxItems=6),
        "bars":prop("array",items=graphics_bar,minItems=2,maxItems=6),"direction":prop("string",enum=["in","out"])}, ["node_id","mode"])
    tool("video_capture_frame", "把视频的首帧、末帧或指定时间的画面保存成相连的图片节点。position 为 first、last 或 time；仅 time 需要 at（原视频秒数）。返回真实图片节点，可以在后续生成用作首帧或参考图。", {
        **guide["properties"], "position":prop("string", enum=["first","last","time"]),
        "at":prop("number", minimum=0), "name":node}, ["node_id","position"])
    tool("video_export_gif", "把已完成的视频版本导出为可下载的无声循环 GIF。start/end 是原片秒数，区间须在 0.25–8 秒内；默认导出开头最多 3 秒。ping_pong=true 时往返循环，适合动作首尾不相接。", {
        **guide["properties"],"start":prop("number",minimum=0),"end":prop("number",exclusiveMinimum=0),
        "fps":prop("integer",enum=list(GIF_FPS)),"size":prop("integer",enum=list(GIF_SIZES)),
        "ping_pong":prop("boolean")},["node_id"])
    tool("video_regenerate", "在同一节点重新生成并追加版本。可选 version 指定旧版。省略 frames 时沿用所选版本的图片；只换个别输入用 replacements，重新指定整组图片用 frames，两者不可同传。物体框选等其他设置仍沿用所选版本。", {
        **options, **guide["properties"], "previs":guide, "audio_refs":sounds, "video_refs":clips, "camera_plan":camera, "object_edit":object_plan,
        "reuse_asset_references":prop("boolean",description="用户要求按旧资产复现时为 true，沿用原生成记录里的参考素材和文字设定"),
        "memory_ids":prop("array",items=node,maxItems=8,description="替换从旧版本沿用的资产，空数组可清除继承；省略则沿用。用户本轮或本次提示词的明确引用仍会应用"),
        "frames":prop("array",items=frame,maxItems=30),
        "replacements": prop("array", maxItems=12, items=prop("object", properties={
            "from_node_id": node, "to_node_id": node}, required=["from_node_id", "to_node_id"], additionalProperties=False))}, ["node_id"])
    def track(fields, transitions=("linear","smooth")):
        pose = {field:prop("number", minimum=18 if field == "fov" else -360 if field == "yaw" else -50,
                           maximum=95 if field == "fov" else 360 if field == "yaw" else 50) for field in fields}
        key = prop("object", properties={**pose, "t":prop("integer", minimum=0, maximum=24 * previs.MAX_SECONDS),
                   "ease":prop("string", enum=list(transitions))}, required=["t", *fields], additionalProperties=False)
        return prop("array", items=key, minItems=1, maxItems=32)
    dimensions = {key:prop("number", minimum=.1, maximum=20) for key in ("width","height","depth")}
    item = prop("object", properties={"id":node, "label":node, "shape":prop("string", enum=sorted(previs.SHAPES)), **dimensions,
                                    "keys":track(previs.POSE_FIELDS)},
                required=["id","label","shape",*dimensions,"keys"], additionalProperties=False)
    lighting = prop("object",properties={
        **{key:prop("number",minimum=low,maximum=high) for key,(low,high) in previs.LIGHT_LIMITS.items()},
        "tone":prop("string",enum=list(previs.LIGHT_TONES)),"enabled":prop("boolean")},additionalProperties=False)
    scene = prop("object", properties={"duration":prop("integer", minimum=2, maximum=previs.MAX_SECONDS),
                 "aspect":prop("string", enum=list(previs.ASPECTS)), "camera":track(previs.CAMERA_FIELDS,previs.CAMERA_TRANSITIONS),
                 "objects":prop("array", items=item, maxItems=24),"lighting":lighting},
                 required=["duration","aspect","camera","objects"], additionalProperties=False)
    tool("video_previs_get", "读取白模当前可编辑场景、场景版本校验码和已渲染的 Tab。", {"node_id":node}, ["node_id"])
    tool("video_previs_storyboard_plan", "按现有白模的机位硬切准备分镜导入卡，列出实际切点和时长。用户打开白模核对后，点击按切点创建分镜，生成首帧并连到视频节点。", {"node_id":node}, ["node_id"])
    tool("video_previs_save", "保存可编辑的白模场景。创建时省略 node_id。修改时先读取原场景，保留无关物体和关键帧，并传 node_id 与 scene_revision。灯光 lighting 省略时保留，开启时填写 azimuth（0° 为 +Z、90° 为 +X）、elevation、key、ambient、tone，传 enabled=false 恢复默认。已导入的 mesh 通过原物体 ID 保留。t 为 24 FPS 帧号。", {
        "node_id":node, "scene_revision":prop("string", maxLength=64), "name":node, "scene":scene}, ["scene"])
    tool("video_previs_camera_motion", "为现有白模在指定区间写入可编辑运镜关键帧。先用 video_previs_get 获取校验码和物体编号。start/end 为秒。推进、拉远和横移的 amount 为米，环绕的 amount 为度，跟拍则提供 target 物体编号。", {
        "node_id":node,"scene_revision":prop("string",minLength=64,maxLength=64),
        "mode":prop("string",enum=list(previs.CAMERA_MOVES)),
        "start":prop("number",minimum=0,maximum=previs.MAX_SECONDS),
        "end":prop("number",minimum=0,maximum=previs.MAX_SECONDS),
        "amount":prop("number",minimum=.1,maximum=180),"target":node},
        ["node_id","scene_revision","mode","start","end"])
    route_point = prop("object",properties={"x":prop("number",minimum=-50,maximum=50),
        "z":prop("number",minimum=-50,maximum=50)},required=["x","z"],additionalProperties=False)
    tool("video_previs_object_motion", "给现有白模的一个物体设置按距离分配时间的走位路线。先读取场景，提供版本校验码和目标物体编号。start/end 为秒，起点自动取该物体在 start 的位置。points 按经过顺序填写 X/Z 坐标，最后一个为终点。", {
        "node_id":node,"scene_revision":prop("string",minLength=64,maxLength=64),"target":node,
        "start":prop("number",minimum=0,maximum=previs.MAX_SECONDS),
        "end":prop("number",minimum=0,maximum=previs.MAX_SECONDS),
        "points":prop("array",items=route_point,minItems=1,maxItems=31)},
        ["node_id","scene_revision","target","start","end","points"])
    tool("video_previs_render", "把已保存的白模渲染为无声 MP4，追加在同一节点的版本 Tab。span 可指定 24 FPS 的起止帧，起帧包含、止帧不包含，省略时渲染整段。渲染结果至少 2 秒才可用作视频动作参考。", {
        "node_id":node,"span":prop("array",items=prop("integer",minimum=0,maximum=FPS*previs.MAX_SECONDS),minItems=2,maxItems=2)}, ["node_id"])
    shot_number = prop("integer", minimum=1, maximum=video_remake.MAX_SHOTS)
    tool("video_remake_status", "读取原片视频版本的角色替换进度。指定shot可查看该镜头的已完成视频版本和任务编号。", {
        "node_id": node, "shot": shot_number,
    }, ["node_id"])
    tool("video_remake_analyze", "分析重制原片的镜头和人物。已有分析时读取结果；用户要求重试时设retry=true，补充缺失分析并保留剪辑点和审核决定。", {
        "node_id": node, "retry": prop("boolean"),
    }, ["node_id"])
    tool("video_remake_split_long", "按当前视频服务的时长上限均匀拆分指定长镜头。先用video_remake_status获取镜头编号和最新cut_revision。拆分会更新后续镜头编号。", {
        "node_id": node, "shot": shot_number, "cut_revision": prop("integer", minimum=0),
    }, ["node_id", "shot", "cut_revision"])
    tool("video_remake_plan", "列出换角执行计划的镜头、角色参考和待确认选区，等待用户勾选提交。", {
        "node_id": node, "asset_id": node, "person": prop("string", minLength=1, maxLength=60),
        "look": prop("string", maxLength=240), "shots": prop("array", items=shot_number, minItems=1, maxItems=4),
    }, ["node_id", "asset_id", "person", "shots"])
    tool("video_remake_map", "保存角色映射，用资产库角色替换指定原片人物。镜头编号从1开始，使用最近一次重制状态的cut_revision。", {
        "node_id": node, "person": prop("string", minLength=1, maxLength=60), "asset_id": node,
        "shots": prop("array", items=prop("integer", minimum=1, maximum=video_remake.MAX_SHOTS),
                      minItems=1, maxItems=video_remake.MAX_SHOTS),
        "cut_revision": prop("integer", minimum=0), "look": prop("string", maxLength=240),
    }, ["node_id", "person", "asset_id", "shots", "cut_revision"])
    tool("video_remake_locate", "为已映射镜头的首帧批量标记候选人物位置，留给用户确认。镜头从1编号，省略shots则使用当前映射的全部镜头。", {
        "node_id": node, "person": prop("string", minLength=1, maxLength=60), "asset_id": node,
        "shots": prop("array", items=prop("integer", minimum=1, maximum=video_remake.MAX_SHOTS),
                      minItems=1, maxItems=video_remake.MAX_SHOTS),
        "cut_revision": prop("integer", minimum=0),
    }, ["node_id", "person", "asset_id", "cut_revision"])
    tool("video_remake_preview", "为有选区的镜头提交起始帧换角预览，最多4个。镜头从1编号；预览保存在重制工作区。", {
        "node_id": node, "person": prop("string", minLength=1, maxLength=60), "asset_id": node,
        "cut_revision": prop("integer", minimum=0),
        "shots": prop("array", minItems=1, maxItems=4, items=prop("object", properties={
            "number": prop("integer", minimum=1, maximum=video_remake.MAX_SHOTS),
            "view": prop("string", enum=sorted(video_remake.VIEWS)), "note": prop("string", maxLength=800),
        }, required=["number"], additionalProperties=False)),
    }, ["node_id", "person", "asset_id", "cut_revision", "shots"])
    tool("video_remake_generate", "用已采用的起始帧和动作关键帧提交一个重制镜头视频。first_job取自重制状态的approved_start_job。仅在用户明确要求用深度参考时，传入可用的motion_provider。", {
        "node_id": node, "person": prop("string", minLength=1, maxLength=60), "asset_id": node,
        "cut_revision": prop("integer", minimum=0),
        "shot": prop("integer", minimum=1, maximum=video_remake.MAX_SHOTS), "first_job": node,
        "motion": prop("string", maxLength=1600), "motion_provider": node,
    }, ["node_id", "person", "asset_id", "cut_revision", "shot", "first_job"])
    tool("video_remake_export", "把已审核的重制镜头与保留原片的镜头合成，保留原声。须使用最新cut_revision；只有用户明确要求重新导出时才设rebuild。", {
        "node_id": node, "cut_revision": prop("integer", minimum=0), "rebuild": prop("boolean"),
    }, ["node_id", "cut_revision"])
    tool("video_remake_review", "保存用户明确指定的审核决定。adopt时使用该镜头已完成版本的video_job，keep时保留原镜头。镜头从1编号。", {
        "node_id": node, "shot": shot_number, "cut_revision": prop("integer", minimum=0),
        "decision": prop("string", enum=["adopt", "keep"]), "video_job": node,
    }, ["node_id", "shot", "cut_revision", "decision"])
