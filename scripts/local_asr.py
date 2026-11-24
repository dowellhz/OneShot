"""Serve a local Faster Whisper model through OneShot's ASR interface."""

import argparse
import asyncio
import hmac
import io
from itertools import chain
import os
from pathlib import Path

import av
import numpy as np
from aiohttp import BodyPartReader, web


UPLOAD_LIMIT = 8 * 1024 * 1024
SAMPLE_RATE = 16000
MAX_SAMPLES = 600 * SAMPLE_RATE


def decode_audio(audio):
    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    chunks = []
    samples = 0
    with av.open(io.BytesIO(audio), options={"protocol_whitelist": "pipe"}) as container:
        if not container.streams.audio:
            raise ValueError("文件没有音轨")
        for frame in chain(container.decode(audio=0), (None,)):
            for converted in resampler.resample(frame):
                samples += converted.samples
                if samples > MAX_SAMPLES:
                    raise ValueError("本地转写每次最多识别 10 分钟")
                chunks.append(converted.to_ndarray().ravel())
    if not chunks:
        raise ValueError("无法读取音频")
    return np.concatenate(chunks).astype(np.float32) / 32768


def recognize(model, audio):
    samples = decode_audio(audio)
    segments, _ = model.transcribe(samples, beam_size=3, condition_on_previous_text=False, vad_filter=True)
    return [{"start": item.start, "end": item.end, "text": item.text} for item in segments]


def create_app(model, token):
    lock = asyncio.Lock()

    async def transcription(request):
        if not hmac.compare_digest(request.headers.get("Authorization", "").encode(), b"Bearer " + token):
            return web.json_response({"error": "转写服务鉴权失败"}, status=401)
        try:
            if request.content_type != "multipart/form-data":
                raise ValueError("请选择音频文件")
            fields = {}
            async for part in await request.multipart():
                if (not isinstance(part, BodyPartReader) or part.name in fields or
                        part.name not in {"file", "model", "response_format", "timestamp_granularities[]"}):
                    raise ValueError("无效的转写请求")
                limit = UPLOAD_LIMIT if part.name == "file" else 128
                data = bytearray()
                while chunk := await part.read_chunk():
                    data.extend(chunk)
                    if len(data) > limit:
                        return web.json_response({"error": "转写请求过大"}, status=413)
                fields[part.name] = data
            if fields.get("model") != b"whisper-1" or not fields.get("file"):
                raise ValueError("请选择 whisper-1 和音频文件")
            response_format = fields.get("response_format", b"json")
            if response_format not in (b"json", b"verbose_json"):
                raise ValueError("不支持的转写格式")
            async with lock:
                segments = await asyncio.to_thread(recognize, model, fields["file"])
        except (ValueError, av.FFmpegError) as error:
            message = str(error) if isinstance(error, ValueError) else "无法读取音频"
            return web.json_response({"error": message}, status=400)
        result = {"text": "".join(segment["text"] for segment in segments).strip()}
        if response_format == b"verbose_json":
            result["segments"] = segments
        return web.json_response(result)

    app = web.Application(client_max_size=UPLOAD_LIMIT + 65536)
    app.router.add_post("/v1/audio/transcriptions", transcription)
    return app


def main():
    from faster_whisper import WhisperModel

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", required=True, type=Path)
    parser.add_argument("--port", type=int, default=8191)
    args = parser.parse_args()
    token = os.environ.pop("ONESHOT_ASR_TOKEN", "").encode()
    if not token:
        parser.error("set ONESHOT_ASR_TOKEN before starting")
    if not (args.model_dir / "model.bin").is_file():
        parser.error("select a local Faster Whisper model directory")
    model = WhisperModel(str(args.model_dir.resolve()), device="cpu", compute_type="int8", cpu_threads=2)
    web.run_app(create_app(model, token), host="127.0.0.1", port=args.port, access_log=None)


if __name__ == "__main__":
    main()
