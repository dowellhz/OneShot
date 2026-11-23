"use strict";

const PV_FPS = 24;
const PV_SIZE = {"16:9":[720,405],"9:16":[405,720],"1:1":[540,540]};
const PV_SHAPES = {box:"方块", column:"圆柱", figure:"人物"};
const PV_TRIANGLE_LIMIT = 2000;
const PV_NEAR = .12;

function pvSample(track, tick) {
  const right = track.findIndex(pose => pose.t >= tick);
  if (right <= 0) return {...track[right < 0 ? track.length - 1 : 0]};
  const a = track[right-1], b = track[right];
  let x = (tick-a.t) / (b.t-a.t);
  if (b.ease === "smooth") x = x*x*(3-2*x);
  const pose = {...b};
  for (const key of Object.keys(b)) if (key !== "t" && key !== "ease") pose[key] = a[key] + (b[key]-a[key])*x;
  return pose;
}

function pvBox(cx=0,bottom=0,cz=0,width=1,height=1,depth=1,shade=1) {
  const x0=cx-width/2,x1=cx+width/2,y1=bottom+height,z0=cz-depth/2,z1=cz+depth/2;
  const vertices=[[x0,bottom,z0],[x1,bottom,z0],[x1,y1,z0],[x0,y1,z0],
    [x0,bottom,z1],[x1,bottom,z1],[x1,y1,z1],[x0,y1,z1]];
  return [[[0,1,2,3],.74],[[4,5,6,7],.86],[[0,4,7,3],.68],[[1,5,6,2],.78],
    [[3,2,6,7],1],[[0,1,5,4],.62]].map(([order,light])=>[order.map(i=>vertices[i]),light*shade]);
}

function pvColumn() {
  const base=Array.from({length:16},(_,i)=>[Math.cos(i*Math.PI/8)/2,0,Math.sin(i*Math.PI/8)/2]);
  const top=base.map(([x,_,z])=>[x,1,z]);
  return [[base,.62],[top,1],...base.map((point,i)=>{
    const j=(i+1)%16;
    return [[point,base[j],top[j],top[i]],.76+.14*Math.cos((i+2)*Math.PI/8)];
  })];
}

const PV_MESH = {
  box:pvBox(), column:pvColumn(),
  figure:[...pvBox(0,.82,0,.43,.18,.70),...pvBox(0,.40,0,.63,.41,.75),
    ...pvBox(-.17,0,0,.24,.42,.50,.91),...pvBox(.17,0,0,.24,.42,.50,.91),
    ...pvBox(-.40,.36,0,.16,.39,.45,.96),...pvBox(.40,.36,0,.16,.39,.45,.96)],
};

const pvMeshFaces=new WeakMap();
function pvFaces(item) {
  if (item.shape!=="mesh") return PV_MESH[item.shape];
  let faces=pvMeshFaces.get(item.triangles);
  if (faces) return faces;
  const {triangles}=item;
  faces=[];
  for (const triangle of triangles) {
    const a=triangle.slice(0,3),b=triangle.slice(3,6),c=triangle.slice(6,9);
    const u=b.map((value,axis)=>value-a[axis]),v=c.map((value,axis)=>value-a[axis]);
    const normal=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    const length=Math.hypot(...normal);
    if (length>0) faces.push([[a,b,c],.63+.34*Math.abs((normal[0]*.36+normal[1]*.8+normal[2]*.48)/length)]);
  }
  pvMeshFaces.set(triangles,faces);
  return faces;
}

function pvCameraBasis(camera) {
  const unit=(a,fallback)=>{const m=Math.hypot(...a);return m>1e-6?a.map(x=>x/m):fallback;};
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const forward=unit([camera.tx-camera.x,camera.ty-camera.y,camera.tz-camera.z],[0,0,-1]);
  const right=unit(cross(forward,[0,1,0]),[1,0,0]),up=cross(right,forward);
  return [right,up,forward];
}

function pvCamera(camera) {
  const basis=pvCameraBasis(camera);
  return ([x,y,z])=>basis.map(a=>a[0]*(x-camera.x)+a[1]*(y-camera.y)+a[2]*(z-camera.z));
}

function pvNearHit(a,b) {
  const f=(PV_NEAR-a[2])/(b[2]-a[2]);
  return [a[0]+(b[0]-a[0])*f,a[1]+(b[1]-a[1])*f,PV_NEAR];
}

function pvClip(points) {
  const result=[];
  let previous=points.at(-1);
  for (const point of points) {
    if ((point[2]>=PV_NEAR) !== (previous[2]>=PV_NEAR)) result.push(pvNearHit(previous,point));
    if (point[2]>=PV_NEAR) result.push(point);
    previous=point;
  }
  return result;
}

function pvLine(ctx, a, b, color) {
  ctx.beginPath();
  ctx.moveTo(...a);
  ctx.lineTo(...b);
  ctx.strokeStyle=color;
  ctx.stroke();
}

function pvPolygon(ctx, points, color, edge) {
  ctx.beginPath();
  ctx.moveTo(...points[0]);
  for (const p of points.slice(1)) ctx.lineTo(...p);
  ctx.closePath();
  ctx.fillStyle=color;
  ctx.fill();
  ctx.strokeStyle=edge;
  ctx.stroke();
}

function pvPaint(cameraCanvas,scene,tick,active) {
  const {width,height}=cameraCanvas,ctx=cameraCanvas.getContext("2d");
  ctx.fillStyle="#24262b";
  ctx.fillRect(0,0,width,height);
  const camera=pvSample(scene.camera,tick),toCamera=pvCamera(camera);
  const focal=height/(2*Math.tan(camera.fov*Math.PI/360));
  const project=([x,y,z])=>[width/2+focal*x/z,height/2-focal*y/z];
  for (let o=-16;o<=16;o++) for (const [from,to] of [[[o,0,-16],[o,0,16]],[[-16,0,o],[16,0,o]]]) {
    let a=toCamera(from),b=toCamera(to);
    if (a[2]<PV_NEAR && b[2]<PV_NEAR) continue;
    if (a[2]<PV_NEAR) a=pvNearHit(a,b);
    if (b[2]<PV_NEAR) b=pvNearHit(b,a);
    pvLine(ctx,project(a),project(b),o?"#3c3e44":"#64666c");
  }
  const faces=[];
  for (const item of scene.objects) {
    const pose=pvSample(item.keys,tick),a=pose.yaw*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
    for (const [verts,light] of pvFaces(item)) {
      const points=pvClip(verts.map(([x,y,z])=>toCamera([pose.x+x*item.width*c-z*item.depth*s,
        pose.y+y*item.height,pose.z+x*item.width*s+z*item.depth*c])));
      if (points.length>=3) {
        const depth=points.reduce((sum,p)=>sum+p[2],0)/points.length;
        faces.push({depth,points:points.map(project),light,selected:item.id===active});
      }
    }
  }
  faces.sort((a,b)=>b.depth-a.depth);
  for (const face of faces) {
    const v=Math.round(228*face.light);
    pvPolygon(ctx,face.points,`rgb(${v} ${v} ${v})`,face.selected?"#a5b8db":"#555861");
  }
}

function pvPlan(scene,tick,width,height) {
  const camera=pvSample(scene.camera,tick);
  const objects=scene.objects.map(item=>({...item,...pvSample(item.keys,tick)}));
  const extent=Math.max(6,...objects.map(o=>Math.max(Math.abs(o.x)+o.width,Math.abs(o.z)+o.depth)),
    Math.abs(camera.x)+1,Math.abs(camera.z)+1);
  const scale=Math.min(width,height)/(2*extent+1);
  return {camera,objects,extent,scale,point:(x,z)=>[width/2+x*scale,height/2+z*scale],
    world:(x,y)=>[(x-width/2)/scale,(y-height/2)/scale]};
}

function pvPaintPlan(canvas,scene,tick,active,layout=pvPlan(scene,tick,canvas.width,canvas.height)) {
  const {width,height}=canvas,ctx=canvas.getContext("2d");
  ctx.fillStyle="#24262b";
  ctx.fillRect(0,0,width,height);
  const {camera,point,extent,scale}=layout;
  const bounds=Math.ceil(extent);
  for (let i=-bounds;i<=bounds;i++) {
    const color=i?"#3c3e44":"#64666c";
    pvLine(ctx,point(i,-bounds),point(i,bounds),color);
    pvLine(ctx,point(-bounds,i),point(bounds,i),color);
  }
  pvLine(ctx,point(camera.x,camera.z),point(camera.tx,camera.tz),"#8b9bbb");
  for (const item of scene.objects) {
    const o={...item,...pvSample(item.keys,tick)},a=o.yaw*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
    const vertices=o.shape==="column" ? Array.from({length:16},(_,i)=>[Math.cos(i*Math.PI/8),Math.sin(i*Math.PI/8)]) :
      [[-1,-1],[1,-1],[1,1],[-1,1]];
    const points=vertices.map(([dx,dz])=>point(o.x+(dx*o.width*c-dz*o.depth*s)/2,o.z+(dx*o.width*s+dz*o.depth*c)/2));
    pvPolygon(ctx,points,o.id===active?"#9eb7df":"#a7a8ae","#575a65");
    ctx.fillStyle="#ebedf2";
    ctx.font="13px system-ui";
    ctx.fillText(o.label,...point(o.x,o.z-o.depth/2-8/scale));
  }
  const [x,y]=point(camera.x,camera.z);
  pvPolygon(ctx,[[x,y-6],[x+6,y+4],[x-6,y+4]],"#a8bedf","#bac7e0");
  ctx.fillStyle="#ebedf2";
  ctx.font="13px system-ui";
  ctx.fillText("机位",x+8,y+5);
}
