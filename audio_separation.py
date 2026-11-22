"""Separate a pinned source interval on the host using the Demucs CLI."""
import asyncio
import logging
import math
import os
import shutil
import tempfile
import wave
from pathlib import Path

import render

MODEL = "htdemucs"
MAX_SECONDS = 600
MAX_RUNTIME = 30 * 60
STEMS = {"vocals":"人声","no_vocals":"伴奏与环境声"}
log = logging.getLogger(__name__)


def executable():
    return shutil.which(os.environ.get("ONESHOT_DEMUCS_BIN") or "demucs")


def media_range(path, kind, start, end):
    import av

    with av.open(str(path)) as source:
        if not source.streams.audio:
            raise ValueError("这个版本没有音轨")
        if kind == "video" and not source.streams.video:
            raise ValueError("该素材没有视频流")
        stream = source.streams.video[0] if kind == "video" else source.streams.audio[0]
        duration = float(stream.duration * stream.time_base) if stream.duration else float(source.duration or 0) / av.time_base
    if duration <= 0:
        raise ValueError("无法读取原素材时长")
    if end is None or duration < end <= duration + .04:
        end = duration
    start, end = round(start * render.SR), round(end * render.SR)
    length = end - start
    if start < 0 or end > round(duration * render.SR) or length < round(.1 * render.SR):
        raise ValueError("请选择素材时长内至少 0.1 秒的区间")
    if length > MAX_SECONDS * render.SR:
        raise ValueError("每次最多分离 10 分钟，请选择区间")
    return start, end


def range_values(payload):
    start, end = payload.get("start",0), payload.get("end")
    for value in (start, end) if end is not None else (start,):
        if type(value) not in (int,float) or not 0 <= value <= 604800 or not math.isfinite(value):
            raise ValueError("请输入有效的分离起止时间")
    return start, end


def extract_mix(source, kind, mix, start, end):
    import numpy as np

    pcm = render.original_pcm(source,end-start,offset=start,audio_only=kind=="audio")
    if np.max(np.abs(pcm)) < .00001:
        raise ValueError("所选区间内没有可分离的声音")
    with wave.open(str(mix),"wb") as output:
        output.setparams((2,2,render.SR,0,"NONE",""))
        output.writeframes(np.round(np.clip(pcm.T,-1,1)*32767).astype("<i2").tobytes())


async def demix(binary, mix, folder, cancelled):
    device = os.environ.get("ONESHOT_DEMUCS_DEVICE","cpu")
    env = {**os.environ}
    env.setdefault("OMP_NUM_THREADS","2")
    env.setdefault("MKL_NUM_THREADS","2")
    with tempfile.TemporaryFile() as transcript:
        process = await asyncio.create_subprocess_exec(
            binary,"-n",MODEL,"-d",device,"--two-stems","vocals","--shifts","0",
            "--clip-mode","clamp","-o",str(folder),str(mix),
            stdout=transcript,stderr=asyncio.subprocess.STDOUT,env=env)
        waiting = asyncio.create_task(process.wait())
        deadline = asyncio.get_running_loop().time() + MAX_RUNTIME
        try:
            while not waiting.done():
                if cancelled():
                    raise render.Cancelled()
                if asyncio.get_running_loop().time() >= deadline:
                    raise ValueError("人声分离超时，请缩短分离区间后重试")
                await asyncio.wait({waiting},timeout=.25)
        finally:
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
                await waiting
        if process.returncode:
            transcript.seek(max(0,transcript.tell()-1600))
            log.warning("Demucs exited %s: %s",process.returncode,transcript.read().decode(errors="replace").strip())
            raise ValueError("人声分离模型运行失败，请检查部署主机的模型和运行环境")


def save_stems(root, source_dir, mix_name, length, cancelled):
    import av

    paths = {stem:source_dir / MODEL / mix_name / (stem + ".wav") for stem in STEMS}
    for path in paths.values():
        if not path.is_file():
            raise ValueError("分离模型没有返回完整的两条音轨")
        with av.open(str(path)) as saved:
            stream = saved.streams.audio[0] if saved.streams.audio else None
            if not stream or stream.rate != render.SR or stream.channels != 2 or stream.duration is None:
                raise ValueError("分离模型返回了无效音轨")
            if abs(float(stream.duration*stream.time_base)*render.SR-length) > 2:
                raise ValueError("分离音轨与原区间时长不一致")
    moved, refs = [], {}
    try:
        for stem, path in paths.items():
            if cancelled():
                raise render.Cancelled()
            target, ref = render._new(root,"output","stem_"+stem,".wav")
            moved.append(target)
            shutil.move(path,target)
            refs[stem] = ref
        if cancelled():
            raise render.Cancelled()
        return refs
    except BaseException:
        for path in moved:
            path.unlink(missing_ok=True)
        raise


async def separate(root, binary, source, kind, start, end, phase, cancelled):
    with tempfile.TemporaryDirectory(prefix="oneshot-stems-") as temporary:
        folder = Path(temporary)
        mix = folder / "mix.wav"
        phase("encoding")
        await asyncio.to_thread(extract_mix,source,kind,mix,start,end)
        if cancelled():
            raise render.Cancelled()
        phase("sampling")
        await demix(binary,mix,folder,cancelled)
        phase("compositing")
        return await asyncio.to_thread(save_stems,root,folder,mix.stem,end-start,cancelled)


async def assistant_request(service, run, user, call_id, args):
    board_id, node_id = run["board_id"], args["node_id"]
    board = service.board(user,board_id)
    source = next((n for n in board["nodes"] if n["id"] == node_id and n["type"] in ("audio","video")),None)
    if not source:
        raise ValueError("请选择视频或音频节点")
    bound = run["data"]["bindings"].get(node_id)
    version = next((v for v in source["versions"] if v.get("ref") == bound),None) if bound else service.current(source)
    if not version or not version.get("ref"):
        raise ValueError("原素材版本已移除，请重新选择")
    if run["data"].get("audio_separation_call",call_id) != call_id:
        raise ValueError("每轮可分离一个素材版本，请在下一轮处理其他素材")
    run["data"]["audio_separation_call"] = call_id
    service.update(run)
    payload = {"board":board_id,"node":node_id,"ref":version["ref"],"request_key":call_id,
               "start":args.get("start",0),"end":args.get("end")}
    receipt = await service.response(service.host.request_stems,user,payload)
    selection = {"node":node_id,"ref":version["ref"],"job":receipt["id"],"range":receipt["range"]}
    return await service.wait_submitted_jobs(run,user,call_id,{
        "ids":[receipt["id"]],"stem_separation":selection,"cancel_on_stop":False})


def assistant_finish(service, run, user, call_id, selection, status):
    if status["state"] != "done":
        raise ValueError(status.get("error") or "人声分离未完成")
    outputs = {out.get("extra",{}).get("stem"):out for out in status.get("outputs") or []}
    if any(stem not in outputs for stem in STEMS):
        raise ValueError("分离结果不完整，请重新提交")

    def place(board):
        source = next((n for n in board["nodes"] if n["id"] == selection["node"]),None)
        if not source or not any(v.get("ref") == selection["ref"] for v in source["versions"]):
            raise ValueError("原素材版本已移除，可在任务中心查看输出")
        right = max((n.get("x") or 0) + service.dimensions(n)[0] for n in board["nodes"]) + 100
        nodes = []
        for index,(stem,label) in enumerate(STEMS.items()):
            output = outputs[stem]
            ref = output["ref"]
            ident = "stem" + selection["job"] + str(index)
            node = next((n for n in board["nodes"] if n["id"] == ident),None)
            if node is None:
                details = {"job":selection["job"],"stem":stem,"source_node":source["id"],
                           "source_ref":selection["ref"],**selection["range"]}
                version = {"ref":ref,"url":output["url"],"seconds":output["meta"]["duration"],
                           "source":"audio_separation","audio_separation":details}
                name = (source.get("name") or "原素材")[:30] + " · " + label
                node = {"id":ident,"type":"audio","name":name,"x":right,"y":(source.get("y") or 0)+index*180,
                        "data":{},"versions":[version],"cur":0,"job":None}
                board["nodes"].append(node)
                board["edges"].append({"from":source["id"],"to":ident,"relation":"audio_separation","source_ref":selection["ref"]})
            version_index = next((i for i,v in enumerate(node["versions"]) if v.get("ref") == ref),None)
            if version_index is None:
                raise ValueError("已放入画布的分离音轨有所变更，请在原节点查看")
            nodes.append({"id":ident,"type":"audio","name":node["name"],"ref":ref,"url":output["url"],"version_index":version_index})
        return {"text":"已将人声和伴奏与环境声放入两个独立音频节点。","media_type":"audio","nodes":nodes}

    result = service.commit(run,user,call_id,place)
    run["data"]["bindings"].update({item["id"]:item["ref"] for item in result["nodes"]})
    service.update(run)
    return result
