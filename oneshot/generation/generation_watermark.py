"""Add an opt-in, visible label to generated media without altering model output files."""

import hashlib
import tempfile
import threading
from pathlib import Path
from urllib.parse import quote

from PIL import Image, ImageDraw, ImageFont, ImageOps

from oneshot.editing import render
from oneshot.generation import tools


VIDEO_ENCODERS = threading.BoundedSemaphore(1)
LABEL = "AI-generated"


def badge(width, height):
    size = min(42, max(6, round(min(width,height)*.047)))
    try:
        font = ImageFont.load_default(size=size)
    except TypeError:
        font = ImageFont.load_default()
    left, top, right, bottom = font.getbbox(LABEL)
    pad = max(2,size//3)
    panel = Image.new("RGBA",(right-left+2*pad,bottom-top+2*pad))
    draw = ImageDraw.Draw(panel)
    draw.rounded_rectangle((0,0,panel.width-1,panel.height-1),radius=pad,fill=(18,19,24,215))
    draw.text((pad-left,pad-top),LABEL,font=font,fill="white")
    panel.thumbnail((max(1,width-pad),max(1,height-pad)),Image.Resampling.LANCZOS)
    return panel,(max(0,width-panel.width-pad),max(0,height-panel.height-pad))


def mark_image(source, destination):
    with Image.open(source) as original:
        image = ImageOps.exif_transpose(original).convert("RGBA")
        layer, position = badge(*image.size)
        image.alpha_composite(layer,position)
        image.save(destination,icc_profile=original.info.get("icc_profile"))


def mark_video(source, destination, cancelled):
    import av

    with VIDEO_ENCODERS:
        width,height,_,_ = render.probe(source)
        encode_video(av,source,destination,width,height,cancelled)


def encode_video(av, source, destination, width, height, cancelled):
    layer,position = badge(width,height)
    with av.open(str(source)) as media, av.open(str(destination),"w",options={"movflags":"+faststart"}) as target:
        source_video = media.streams.video[0]
        video = target.add_stream("libx264",rate=source_video.average_rate or source_video.base_rate or 24)
        video.width,video.height = width,height
        video.pix_fmt = "yuv444p" if width%2 or height%2 else "yuv420p"
        video.codec_context.time_base = source_video.time_base
        video.codec_context.thread_count = 2
        video.options = {"preset":"veryfast","crf":"17"}
        audio = {stream.index:target.add_stream_from_template(stream) for stream in media.streams.audio}
        streams = (source_video,*media.streams.audio)
        frames = 0
        for packet in media.demux(*streams):
            if cancelled():
                raise InterruptedError()
            if packet.stream.index in audio:
                if packet.dts is not None:
                    packet.stream = audio[packet.stream.index]
                    target.mux(packet)
                continue
            for frame in packet.decode():
                image = render.frame_image(frame).convert("RGBA")
                image.alpha_composite(layer,position)
                labelled = av.VideoFrame.from_image(image.convert("RGB"))
                labelled.pts,labelled.time_base = frame.pts,frame.time_base
                for encoded in video.encode(labelled):
                    target.mux(encoded)
                frames += 1
        if not frames:
            raise ValueError("视频没有可标记的画面")
        for encoded in video.encode():
            target.mux(encoded)


def label_outputs(root, job_id, kind, outputs, cancelled):
    labelled = []
    for output in outputs:
        if cancelled():
            raise InterruptedError()
        source = tools.ref_path(root,output["ref"])
        key = hashlib.sha256(f"{job_id}:{output['ref']}".encode()).hexdigest()[:32]
        suffix = ".png" if kind=="image" else ".mp4"
        ref = "output:h3studio/ai_"+key+suffix
        destination = tools.ref_path(root,ref)
        destination.parent.mkdir(parents=True,exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=destination.parent,prefix=".ai-",suffix=suffix,delete=False) as file:
            temp = Path(file.name)
        try:
            if kind == "image":
                mark_image(source,temp)
            else:
                mark_video(source,temp,cancelled)
            if cancelled():
                raise InterruptedError()
            temp.replace(destination)
        finally:
            temp.unlink(missing_ok=True)
        extra = {**output.get("extra",{}),"ai_watermark":True}
        labelled.append({**output,"ref":ref,"url":"/media?ref="+quote(ref,safe=""),"extra":extra})
    return labelled
