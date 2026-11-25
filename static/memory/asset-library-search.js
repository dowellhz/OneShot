"use strict";

function alClearSemantic() {
  AL.semantic = null;
  if(AL.sort==="relevance")AL.sort="recent";
}
function alCanFindByDescription() {
  return AL.open && $("#alLoading").hidden && !!AL.query.trim() && !AL.semantic?.pending;
}
async function alFindByDescription() {
  if (!alCanFindByDescription()) return;
  const bid = boardId, query = AL.query.trim();
  const search = AL.semantic = {pending:true,ids:null};
  alRender();
  try {
    const {items,method} = await boardRequest("/api/memory/search","POST",{
      board:bid,query,scope:AL.scope,...(AL.kind==="all"?{}:{kind:AL.kind}),
    });
    if (!AL.open || AL.semantic!==search || boardId!==bid) return;
    const merged = new Map(AL.items.map(asset=>[asset.id,asset]));
    for (const asset of items) merged.set(asset.id,asset);
    AL.items = [...merged.values()];
    search.ids = items.map(asset=>asset.id);
    search.method = method;
    AL.sort = "relevance";
    AL.marked.clear();
  } catch(e) {
    if(AL.semantic===search)search.error=e.message || "按描述查找失败";
  } finally {
    if(AL.semantic===search){search.pending=false;alRender();}
  }
}
function alSearchDocuments() {
  clearTimeout(AL.documentTimer);
  const bid=boardId, scope=AL.scope, query=AL.query.trim().toLocaleLowerCase();
  AL.documentQuery="";AL.documentResults=new Map();
  if (!query) return;
  AL.documentTimer=setTimeout(async()=>{
    try{
      const result=await boardRequest("/api/memory?"+new URLSearchParams({board:bid,scope,q:query}));
      if(!AL.open||bid!==boardId||scope!==AL.scope||query!==AL.query.trim().toLocaleLowerCase()||!Array.isArray(result))return;
      AL.documentQuery=query;
      AL.documentResults=new Map(result.map(a=>[a.id,a]));
      alRender();
    }catch{}
  },220);
}
