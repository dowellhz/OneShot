"use strict";

const pixelSizeFields = ["iePixelWidth","iePixelHeight","iePixelFit"];

function pixelSizeHTML() {
  return `<details id="iePixelSize"><summary>像素尺寸</summary>
    <div class="ie-padding"><label>宽度（px）<input id="iePixelWidth" type="number" min="1" max="8192" step="1"></label>
    <label>高度（px）<input id="iePixelHeight" type="number" min="1" max="8192" step="1"></label></div>
    <label class="ie-pixel-lock"><input id="iePixelLock" type="checkbox" checked>锁定比例</label>
    <label class="ie-label" for="iePixelFit">适配方式</label><select id="iePixelFit">
      <option value="contain">透明补边</option><option value="cover">居中裁切</option><option value="stretch">拉伸</option></select>
    <div class="ie-pixel-preview"><canvas id="iePixelPreview" aria-label="输出尺寸预览"></canvas></div>
    <p class="ie-note" id="iePixelStatus" role="status"></p>
    <div class="ie-row"><button type="button" id="iePixelReset">恢复输入尺寸</button><button type="button" id="iePixelSave" class="ie-primary">保存指定尺寸</button></div>
  </details>`;
}

function pixelSource(E) {
  return E.crop || {x:0,y:0,w:E.image.naturalWidth,h:E.image.naturalHeight};
}

function pixelSizeSettings() {
  const width=$("#iePixelWidth").valueAsNumber, height=$("#iePixelHeight").valueAsNumber;
  if (![width,height].every(n=>Number.isInteger(n) && n>=1 && n<=8192) || width*height>32*1024*1024) return null;
  return {width,height,fit:$("#iePixelLock").checked?"contain":($("#iePixelFit").value || "contain")};
}

function resetPixelSize(E) {
  const {w,h}=pixelSource(E);
  $("#iePixelWidth").value=w;$("#iePixelHeight").value=h;
  $("#iePixelLock").checked=true;$("#iePixelFit").value="contain";
  E.pixelAnchor="width";E.pixelBasis=`${w}:${h}`;E.pixelPreviewKey=null;
}

function updatePixelPreview(E) {
  if (E.mode!=="local" || !$("#iePixelSize").open) return;
  const {x,y,w,h}=pixelSource(E), width=$("#iePixelWidth"), height=$("#iePixelHeight"), locked=$("#iePixelLock").checked;
  const basis=`${w}:${h}`;
  if (locked && E.pixelBasis!==basis) {
    const anchor=E.pixelAnchor==="height"?height:width, other=anchor===height?width:height;
    if (anchor.valueAsNumber>0) other.value=Math.max(1,Math.round(anchor.valueAsNumber*(anchor===height?w/h:h/w)));
  }
  E.pixelBasis=basis;
  $("#iePixelFit").disabled=$("#iePixelFit").hidden=$('label[for="iePixelFit"]').hidden=locked;
  const size=pixelSizeSettings(), status=$("#iePixelStatus"), preview=$("#iePixelPreview");
  $("#iePixelSave").disabled=!size || E.busy || E.restoring || !!E.n.job || !canvasCanEdit();
  status.textContent=size ? `${w} × ${h} → ${size.width} × ${size.height} px` : "请输入 1–8192 的整数像素，总像素不能超过 3200 万";
  preview.hidden=!size;
  if(!size)return;
  const filters=["Brightness","Contrast","Saturation"].map(key=>$("#ie"+key).value);
  const key=JSON.stringify([E.ref,E.layers,x,y,w,h,size,filters]);
  if(key===E.pixelPreviewKey)return;
  E.pixelPreviewKey=key;
  const scale=Math.min(1,180/Math.max(size.width,size.height));
  preview.width=Math.max(1,Math.round(size.width*scale));preview.height=Math.max(1,Math.round(size.height*scale));
  const fitScale=size.fit==="cover"?Math.max(preview.width/w,preview.height/h):Math.min(preview.width/w,preview.height/h);
  const pw=size.fit==="stretch"?preview.width:w*fitScale, ph=size.fit==="stretch"?preview.height:h*fitScale;
  const ctx=preview.getContext("2d");
  ctx.save();ctx.translate((preview.width-pw)/2,(preview.height-ph)/2);ctx.scale(pw/w,ph/h);ctx.translate(-x,-y);
  ctx.beginPath();ctx.rect(x,y,w,h);ctx.clip();
  ctx.filter=`brightness(${filters[0]}%) contrast(${filters[1]}%) saturate(${filters[2]}%)`;
  ewDrawLayers(E,ctx);ctx.restore();
}

function initPixelSize() {
  const sync = anchor => {
    const E=IMAGE_EDITOR;if(!E?.image)return;
    if(anchor)E.pixelAnchor=anchor;
    E.pixelBasis=null;updatePixelPreview(E);ewScheduleDraft();
  };
  $("#iePixelWidth").oninput=()=>sync("width");$("#iePixelHeight").oninput=()=>sync("height");
  $("#iePixelLock").onchange=()=>sync();$("#iePixelFit").onchange=()=>sync();
  $("#iePixelSize").ontoggle=()=>{const E=IMAGE_EDITOR;if(E?.image)updatePixelPreview(E);};
  $("#iePixelReset").onclick=()=>{const E=IMAGE_EDITOR;if(E?.image){resetPixelSize(E);sync();}};
  $("#iePixelSave").onclick=()=>{const resize=pixelSizeSettings();if(resize)return ieLocal({resize});};
}
