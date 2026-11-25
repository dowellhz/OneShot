"use strict";

function acComposerDraft(){
 return {text:$("#acInput").value,refs:AC.refs?.slice()??null,pins:[...AC.referencePins],
  emptyMediaNode:AC.emptyMediaNode,
  selection:AC.selection,reviews:AC.reviews.slice(),placement:AC.placement,skill:AC.skill,documents:AC.documents.slice(),
  modelChoice:AC.modelSelection.choice,thinkingLevel:AC.modelSelection.level,executionScope:AC.executionScope};
}

function acRememberDraft(){
 if(AC.session)AC.drafts.set(AC.session,acComposerDraft());
}

function acHasPendingDraft(){
 const hasContent=draft=>!!(draft.text?.trim() || draft.refs?.length || draft.pins?.length ||
   draft.emptyMediaNode || draft.selection || draft.reviews?.length || draft.placement ||
   draft.skill || draft.documents?.length);
 const answering=AC.questionnaires.some(card=>{
  const draft=acQuestionDrafts.get(card.id);
  return draft && !draft.sent && draft.answers.some(answer=>answer.value.trim() || Number.isInteger(answer.pick) && answer.pick>=0);
 });
 return !!(AC.sending || AC.documentUpload || acVoiceActive || answering ||
   AC.session && hasContent(acComposerDraft()) ||
   [...AC.drafts].some(([id,draft])=>id!==AC.session && hasContent(draft)));
}

function acRestoreDraft(draft){
 $("#acInput").value=draft.text;
 AC.refs=draft.refs;
 AC.emptyMediaNode=draft.emptyMediaNode||null;
 AC.referencePins=new Map(draft.pins);
 AC.selection=draft.selection;
 AC.reviews=draft.reviews;
 AC.placement=draft.placement;
 AC.documents=draft.documents;
 AC.modelSelection.choice=draft.modelChoice;
 AC.modelSelection.level=draft.thinkingLevel;
 AC.executionScope=draft.executionScope||"full";
 csChoose(draft.skill);
}
