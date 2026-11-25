"use strict";

function paste(items, dx = 40, dy = 40, fragment = null) {
  checkpoint(); const map = Object.create(null); const made = [];
  for (const o of items) { const n = addNode(o.type, o.x + dx, o.y + dy, o.data); n.versions = JSON.parse(JSON.stringify(o.versions)); n.cur = o.cur; n.name = o.name + " 副本"; map[o.id] = n.id; render(n); made.push(n.id); }
  const remapData = data=>{
    for(const shot of data?.made || []){
      for(const key of ["img","vid"]) if(shot[key]) shot[key]=map[shot[key]]||"";
      for(const phase of ["middle","end"])if(shot.motion_frames?.[phase])
        shot.motion_frames[phase]=map[shot.motion_frames[phase]]||"";
    }
    if(data?.previs_source) data.previs_source=map[data.previs_source]||"";
    if(data?.film?.story_script) data.film.story_script=map[data.film.story_script]||"";
    for(const clip of data?.film?.clips || []) if(clip.node) clip.node=map[clip.node]||"";
    for(const clip of data?.film?.cutaways || []) if(clip.node) clip.node=map[clip.node]||"";
  };
  const remapSeedRefs=data=>{
    if (data?.mode==="seed_audio") data.references=seedAudioRefs({data}).map(ref=>({...ref,node_id:map[ref.node_id]||ref.node_id}));
  };
  for (const id of made) {
    remapSeedRefs(node(id).data);
    if(fragment || map[node(id).data?.previs_source])remapData(node(id).data);
    else for (const clip of node(id).data?.film?.cutaways || []) if(map[clip.node]) clip.node=map[clip.node];
    for(const v of node(id).versions) {
      remapSeedRefs(v.audio_recipe);
      if(v.input_edges) v.input_edges = v.input_edges.filter(e=>!fragment||map[e.from]).map(e=>({...e,from:map[e.from]||e.from,to:id}));
      if(v.copied_from?.node) {
        const origin=map[v.copied_from.node];
        if(origin)v.copied_from.node=origin;
        else if(fragment)delete v.copied_from.node;
      }
      if (Array.isArray(v.segment_review)) v.segment_review=v.segment_review.filter(c=>c&&(!fragment||map[c.node_id]))
        .map(c=>({...c,node_id:map[c.node_id]||c.node_id}));
      for (const guide of [v.video_recipe?.previs_guide, ...(v.video_recipe?.audio_refs || []), ...(v.video_recipe?.video_refs || [])].filter(Boolean)) {
        if (map[guide.node_id]) guide.node_id = map[guide.node_id];
        else if (fragment) delete guide.node_id;
      }
      for (const [entries, key] of [[v.video_recipe?.images,"node_id"], [v.generation_record?.inputs,"node_id"],
        [v.film_recipe?.clips,"node"], [v.film_recipe?.audio,"node"], [v.film_recipe?.timeline?.clips,"node"],
        [v.film_recipe?.timeline?.audio_clips,"node"], [v.film_recipe?.cutaways,"node"], [v.film_recipe?.timeline?.cutaways,"node"]]) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          if (!entry || typeof entry[key] !== "string") continue;
          if (map[entry[key]]) entry[key] = map[entry[key]];
          else if (fragment) delete entry[key];
        }
      }
      for (const origin of [v.capture,v.draft_final]) {
        if (origin?.source_node && (fragment || map[origin.source_node])) origin.source_node = map[origin.source_node] || "";
      }
      if(fragment){
        remapData(v.node_data);
        if(v.remake?.source_node)v.remake.source_node=map[v.remake.source_node]||"";
      }
      if(v.tab_nodes)v.tab_nodes=[id];delete v.tab_origin;
    }
  }
  for (const e of fragment?.edges || B.edges.slice()) if (map[e.from] && map[e.to]) B.edges.push({ ...e, from: map[e.from], to: map[e.to] });
  for (const group of fragment?.groups || [...(B.groups || [])]) if(group.nodes.every(id => map[id])) B.groups.push({...group,id:"g"+Date.now().toString(36)+Math.random().toString(36).slice(2,6),name:group.name+" 副本",nodes:group.nodes.map(id=>map[id]),
    ...(Number.isFinite(group.fold?.x)&&Number.isFinite(group.fold?.y)?{fold:{x:group.fold.x+dx,y:group.fold.y+dy}}:{})});
  if(fragment)made.forEach(id=>render(node(id)));
  drawEdges(); sel = new Set(made); updateSel(); save();
  return made;
}
function duplicate(ids) { paste(ids.map(id => JSON.parse(JSON.stringify(node(id)))), 60, 60); }
