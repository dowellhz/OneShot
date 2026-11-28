"use strict";

function handleFilmTrackKey(F, event) {
  if (!F.tracks?.open || event.defaultPrevented || event.isComposing || !event.target.closest?.("#fmTracks,#fmTrackSwitch") ||
      event.target.closest("input,textarea,select,[contenteditable]:not([contenteditable=false])") || $("dialog[open]")) return false;
  const key = event.key.toLowerCase(), modifier = event.metaKey || event.ctrlKey;
  const seek = time => { seekTimeline(time); revealFilmTrackPlayhead(); };
  const actions = {
    arrowleft:()=>seek(Math.max(0,timelinePos()-(event.shiftKey?1:1/FILM_FPS))),
    arrowright:()=>seek(Math.min(filmTotal(F.spec),timelinePos()+(event.shiftKey?1:1/FILM_FPS))),
    home:()=>seek(0),
    end:()=>seek(filmTotal(F.spec)),
    c:()=>filmTrackSplitSelection(F),
    delete:()=>filmTrackRemoveSelection(F),
    backspace:()=>filmTrackRemoveSelection(F),
  };
  if (!event.target.closest("button")) actions[" "] = ()=>$("#fmMainPlay").click();
  const intent = modifier ? key==="z" ? ()=>stepFilmTrackHistory(F,!event.shiftKey) :
    key==="y" ? ()=>stepFilmTrackHistory(F,false) : null : actions[key];
  if (!intent || event.altKey) return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  intent();
  return true;
}
