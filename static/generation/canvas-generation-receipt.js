"use strict";

function sendCanvasGenerationSubmission(nodeId, key, payload) {
  return api("/api/generate",payload,"POST",{
    "X-OneShot-Submission":key,"X-OneShot-Node":nodeId,
  });
}

async function canvasGenerationSubmissionStatus(board, {id,key}) {
  const query = new URLSearchParams({board,node:id,key});
  return api("/api/generate/receipt?"+query,null,"GET");
}

function applyCanvasGenerationReceipt(n, result, snapshot) {
  const {req,prompt,textInputs,groupRunId} = snapshot;
  const history = structuredClone(snapshot.history), batch = structuredClone(snapshot.batch);
  if (result.image_story_context === "unavailable") toast("世界观细节暂时无法提取，本次按镜头描述生图",4500);
  if (history.video_recipe) Object.assign(history.video_recipe,result.memory_context,result.video_model,result.reference_context);
  if (history.video_recipe && result.video_model) Object.assign(history.node_data,result.video_model);
  if (result.image_model) {
    if (history.node_data) Object.assign(history.node_data,result.image_model);
    if (batch) Object.assign(batch.data,result.image_model);
  }
  if (history.video_recipe && result.reference_context) {
    history.input_edges = vtEdgesWithReferenceRanges(history.input_edges,result.reference_context);
  }
  const extra = {...result.memory_context,...result.reference_context,...result.video_model,...result.image_model};
  const generation_record = Object.keys(extra).length || !snapshot.generationRecord
    ? captureGenerationRecord({...req,...extra},textInputs) : snapshot.generationRecord;
  n.job = {ids:result.ids,prompt,t0:Date.now(),st:{},memory_used:result.memory_used||[],generation_record,history,
    ...(groupRunId ? {group_run_id:groupRunId} : {}),...(batch ? {batch} : {})};
  save();
  render(n);
  showPanel();
  poll();
}
