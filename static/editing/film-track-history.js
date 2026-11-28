"use strict";

function rememberFilmTrackEdit(F, edit) {
  const state = filmTrackState(F);
  state.undo.push(edit);
  if (state.undo.length>40) state.undo.shift();
  state.redo.length = 0;
  updateFilmTrackControls(F);
}

function finishFilmTrackEdit(F, position) {
  renderFilm();
  if (F.spec.clips.length) seekTimeline(Math.min(position,filmTotal(F.spec)));
  else selectClip(0);
  renderFilmTrackEditor();
  revealFilmTrackPlayhead();
  saveFilmDraft(F);
}

function recordFilmTrackFields(F, item, after, position) {
  const {clip,type} = item, spec = F.spec;
  const field = FILM_TRACK_FIELDS[type];
  const keys = Object.keys(after), before = Object.fromEntries(keys.map(key=>[key,clip[key]]));
  if (keys.every(key=>before[key]===after[key])) return;
  const edit = {
    apply(undo) {
      const expected = undo ? after : before, next = undo ? before : after;
      if (F.spec!==spec || !spec[field]?.includes(clip) || keys.some(key=>!Object.is(clip[key],expected[key]))) return false;
      Object.assign(clip,next);
      return true;
    },
  };
  if (!edit.apply(false)) return;
  rememberFilmTrackEdit(F,edit);
  finishFilmTrackEdit(F,position);
}

function filmTrackListEdit(F, field, before, after) {
  const spec = F.spec;
  return {
    apply(undo) {
      const expected = undo ? after : before, next = undo ? before : after;
      const current = spec[field];
      if (F.spec!==spec || current.length!==expected.length || expected.some((clip,index)=>current[index]!==clip)) return false;
      spec[field] = next.slice();
      return true;
    },
  };
}

function recordFilmTrackList(F, field, clips, position) {
  const edit = filmTrackListEdit(F,field,F.spec[field].slice(),clips);
  if (!edit.apply(false)) return;
  rememberFilmTrackEdit(F,edit);
  finishFilmTrackEdit(F,typeof position==="function" ? position() : position);
}

function stepFilmTrackHistory(F, undo) {
  if (!filmTracksEditable(F)) return;
  const state = filmTrackState(F), from = undo ? state.undo : state.redo, to = undo ? state.redo : state.undo;
  const edit = from.at(-1), position = timelinePos();
  if (!edit) return;
  if (!edit.apply(undo)) {
    state.undo.length = state.redo.length = 0;
    updateFilmTrackControls(F);
    return toast(OneShotI18n.t("剪辑已在其他控件中修改，无法应用这一步"));
  }
  to.push(from.pop());
  finishFilmTrackEdit(F,position);
}

function filmTrackClipOperation(F, action) {
  const before = F.spec.clips.slice();
  action();
  const after = F.spec.clips.slice();
  if (before.length!==after.length || before.some((clip,index)=>clip!==after[index])) {
    rememberFilmTrackEdit(F,filmTrackListEdit(F,"clips",before,after));
  }
}

function filmTrackSplit(F, clip) {
  if (!filmTracksEditable(F)) return;
  const offset = filmClipOffset(F);
  filmTrackClipOperation(F,()=>splitFilmClip(F,clip,(clip.in || 0)+offset*filmSpeed(clip)));
}

function filmTrackSelected(F) {
  const active = F.tracks.active;
  const clip = F.spec.clips[F.sel];
  if (active?.type==="music" && F.spec.bgm===active.clip) return active;
  if (active && F.spec[FILM_TRACK_FIELDS[active.type]]?.includes(active.clip)) return active;
  return clip ? {type:"picture",clip} : null;
}

function filmTrackSplitSelection(F) {
  if (!filmTracksEditable(F)) return;
  const selected = filmTrackSelected(F);
  if (selected?.type==="picture" && selected.clip.kind==="video") return filmTrackSplit(F,selected.clip);
  if (selected?.type!=="audio") return;
  const {clip} = selected, position = timelinePos(), start = clip.start ?? 0, sourceIn = clip.in ?? 0;
  const offset = Math.round((position-start)*FILM_FPS)/FILM_FPS;
  const at = sourceIn+offset, out = clip.out ?? clip.seconds;
  if (offset < 1/FILM_FPS-1e-6 || out-at < 1/FILM_FPS-1e-6) {
    return toast(OneShotI18n.t("请把播放头移到片段内部再分割"));
  }
  const clips = F.spec.audio_clips.slice();
  const left = {...clip,out:at}, right = {...clip,start:start+offset,in:at};
  clips.splice(clips.indexOf(clip),1,left,right);
  F.tracks.active = {type:"audio",clip:right};
  recordFilmTrackList(F,"audio_clips",clips,start+offset);
}

function filmTrackRemoveSelection(F) {
  if (!filmTracksEditable(F)) return;
  const selected = filmTrackSelected(F);
  if (!selected) return;
  if (selected.type==="picture") return filmTrackClipOperation(F,()=>removeFilmClip(F,selected.clip));
  const position = timelinePos();
  F.tracks.active = null;
  if (selected.type==="music") {
    const spec = F.spec, original = spec.bgm;
    const edit = {apply(undo) {
      if (F.spec!==spec || spec.bgm!==(undo?null:original)) return false;
      spec.bgm = undo ? original : null;
      return true;
    }};
    if (edit.apply(false)) {
      rememberFilmTrackEdit(F,edit);
      finishFilmTrackEdit(F,position);
    }
    return;
  }
  const field = FILM_TRACK_FIELDS[selected.type];
  recordFilmTrackList(F,field,F.spec[field].filter(item=>item!==selected.clip),position);
}
