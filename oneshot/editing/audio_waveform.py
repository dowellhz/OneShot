"""Calculate compact audio peak envelopes without buffering the decoded track."""

from functools import lru_cache
from threading import BoundedSemaphore

import av
import numpy as np


BINS = 128
DECODERS = BoundedSemaphore(2)


def waveform(path):
    stat = path.stat()
    return decode(path,stat.st_mtime_ns,stat.st_size)


@lru_cache(maxsize=192)
def decode(path, modified, size):
    peaks = np.zeros(BINS,dtype=np.float32)
    with DECODERS, av.open(str(path)) as media:
        if not media.streams.audio:
            raise ValueError("文件没有音轨")
        stream = media.streams.audio[0]
        duration = float(stream.duration*stream.time_base) if stream.duration else float(media.duration or 0)/1e6
        if not np.isfinite(duration) or duration<=0:
            raise ValueError("音频时长不可用")
        origin = float(stream.start_time*stream.time_base) if stream.start_time is not None else None
        offset = 0
        for frame in media.decode(audio=0):
            if not frame.samples:
                continue
            pixels = frame.to_ndarray()
            channels = len(frame.layout.channels)
            if not frame.format.is_planar:
                pixels = pixels.reshape(-1,channels).T
            samples = pixels.astype(np.float32)
            if pixels.dtype.kind == "u":
                midpoint = (np.iinfo(pixels.dtype).max+1)/2
                samples = (samples-midpoint)/midpoint
            elif pixels.dtype.kind == "i":
                samples /= -float(np.iinfo(pixels.dtype).min)
            if frame.time is not None:
                if origin is None:
                    origin = frame.time
                offset = max(0,frame.time-origin)
            bins = np.minimum(BINS-1,((offset+np.arange(frame.samples)/frame.sample_rate)*BINS/duration).astype(int))
            boundaries = np.r_[0,np.flatnonzero(np.diff(bins))+1]
            levels = np.maximum.reduceat(np.abs(samples).max(axis=0),boundaries)
            np.maximum.at(peaks,bins[boundaries],np.nan_to_num(levels))
            offset += frame.samples/frame.sample_rate
    return {"seconds":round(duration,4),"peaks":np.round(np.clip(peaks,0,1),3).tolist()}
