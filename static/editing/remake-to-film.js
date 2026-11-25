"use strict";

function remakeTimelineSpec(video, source, session) {
  const spec = newSpec([]);
  spec.fit = "pad";
  spec.subtitles = false;
  spec.remake_audio = source.ref;
  spec.clips = session.shots.map((shot, index) => {
    const inScope = !session.mapping || session.mapping.shots.includes(index);
    const job = session.reviewed_jobs ? session.reviewed_jobs[index] : inScope && !shot.keep_original ? shot.adopted_video : null;
    const adopted = shot.videos?.find(v => v.job === job && v.state === "done" && v.ref);
    const elapsed = (Math.round(shot.end * RM_FPS) - Math.round(shot.start * RM_FPS)) / RM_FPS;
    const take = adopted ? {ref:adopted.ref, in:0, out:elapsed, audio_start:shot.start, media_seconds:adopted.duration || elapsed}
      : {ref:source.ref, in:shot.start, out:shot.end, audio_start:0, media_seconds:session.duration};
    return {node:video.id, ...take, name:`镜头 ${index + 1}`, trans:"cut", subs:[], volume:1,
      remake_shot:{source:source.ref, start:shot.start, end:shot.end}};
  });
  return spec;
}

function sendRemakeToFilm(video, source, session) {
  if (!session?.shots.length || session.export_review?.remaining?.length) return toast("请先完成镜头审核");
  showFilm(remakeTimelineSpec(video, source, session));
}
