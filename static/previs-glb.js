"use strict";

const PV_MODEL_SIZE=12*1024*1024;
const pvInvalidModel=()=>new Error("模型结构或网格数据无效");

function pvModelJson(bytes) {
  try { return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)); }
  catch { throw pvInvalidModel(); }
}

function pvGlbTransform(node) {
  const [x,y,z,w]=node.rotation??[0,0,0,1], [sx,sy,sz]=node.scale??[1,1,1];
  const [tx,ty,tz]=node.translation??[0,0,0];
  const matrix=node.matrix??[
    sx*(1-2*(y*y+z*z)),sx*2*(x*y+z*w),sx*2*(x*z-y*w),0,
    sy*2*(x*y-z*w),sy*(1-2*(x*x+z*z)),sy*2*(y*z+x*w),0,
    sz*2*(x*z+y*w),sz*2*(y*z-x*w),sz*(1-2*(x*x+y*y)),0,tx,ty,tz,1,
  ];
  if (!Array.isArray(matrix) || matrix.length!==16 || !matrix.every(Number.isFinite) ||
      matrix[3]!==0 || matrix[7]!==0 || matrix[11]!==0 || matrix[15]!==1) throw new Error("模型节点变换无效");
  return point=>[0,1,2].map(i=>matrix[12+i]+point[0]*matrix[i]+point[1]*matrix[4+i]+point[2]*matrix[8+i]);
}

function pvReadGlb(data, triangleLimit) {
  if (data.byteLength>PV_MODEL_SIZE) throw new Error("GLB 文件最大为 12 MiB");
  const invalid=pvInvalidModel;
  const bytes=new DataView(data);
  if (bytes.byteLength<28 || bytes.getUint32(0,true)!==0x46546c67 ||
      bytes.getUint32(4,true)!==2 || bytes.getUint32(8,true)!==bytes.byteLength) throw invalid();
  let model,bin;
  for (let at=12;at<bytes.byteLength;) {
    if (at+8>bytes.byteLength) throw invalid();
    const length=bytes.getUint32(at,true), kind=bytes.getUint32(at+4,true), start=at+8, end=start+length;
    if (length%4 || end>bytes.byteLength || (at===12 && kind!==0x4e4f534a)) throw invalid();
    if (kind===0x4e4f534a) {
      if (at!==12) throw invalid();
      model=pvModelJson(new Uint8Array(data,start,length));
    } else if (kind===0x004e4942) {
      if (bin) throw invalid();
      bin=new DataView(data,start,length);
    }
    at=end;
  }
  const buffer=model?.buffers?.[0];
  if (!bin || !buffer || buffer.uri!==undefined) throw invalid();
  return pvModelGeometry(model,[bin],triangleLimit);
}

async function pvReadGltf(file, files, triangleLimit) {
  const model=pvModelJson(await file.arrayBuffer());
  if (model?.asset?.version!=="2.0" || !Array.isArray(model.buffers) || model.buffers.length>1024) throw pvInvalidModel();
  const buffers=[],cache=new Map(),missing=new Set(),paths=new Map();
  let size=file.size;
  for (const buffer of model.buffers) {
    const uri=buffer?.uri;
    if (typeof uri!=="string") throw pvInvalidModel();
    if (uri.startsWith("data:")) {
      const hit=/^data:(?:application\/octet-stream|application\/gltf-buffer);base64,([A-Za-z0-9+/=]+)$/.exec(uri);
      if (!hit) throw new Error("glTF 内嵌缓冲区格式无效");
      let decoded;
      try { decoded=atob(hit[1]); } catch { throw pvInvalidModel(); }
      buffers.push(new DataView(Uint8Array.from(decoded,c=>c.charCodeAt(0)).buffer));
      continue;
    }
    if (/^(?:[a-z][a-z\d+.-]*:|[/\\])/i.test(uri) || /[?#]/.test(uri)) {
      throw new Error("请选择引用本地缓冲区文件的 glTF");
    }
    let path;
    try { path=decodeURIComponent(uri); } catch { throw pvInvalidModel(); }
    const name=path.split("/").at(-1);
    if (!name || /[\\\x00-\x1f]/.test(name)) throw pvInvalidModel();
    if (paths.has(name) && paths.get(name)!==path) throw new Error(`模型引用了多个名为 ${name} 的文件，请给缓冲区使用不同文件名`);
    paths.set(name,path);
    const bufferFile=files.get(name);
    if (!bufferFile) {
      missing.add(name);
      buffers.push(null);
      continue;
    }
    if (!cache.has(name)) {
      size+=bufferFile.size;
      if (size>PV_MODEL_SIZE) throw new Error("模型与缓冲区文件合计最大为 12 MiB");
      cache.set(name,new DataView(await bufferFile.arrayBuffer()));
    }
    buffers.push(cache.get(name));
  }
  if (missing.size) {
    const names=[...missing];
    const error=new Error(`缺少 ${names.slice(0,3).join("、")}${names.length>3?` 等 ${names.length} 个文件`:""}，点击「补选模型文件」添加`);
    error.missingBuffers=true;
    throw error;
  }
  return pvModelGeometry(model,buffers,triangleLimit);
}

function pvModelGeometry(model,buffers,triangleLimit) {
  const invalid=pvInvalidModel, root=model?.scenes?.[model.scene??0];
  const unsigned=[5121,5123,5125], int=value=>Number.isSafeInteger(value)&&value>=0;
  if (model?.asset?.version!=="2.0" || !Array.isArray(root?.nodes)) throw invalid();
  function read(index, position) {
    const field=model.accessors?.[index], view=model.bufferViews?.[field?.bufferView];
    if (!field || !view || !int(view.buffer) || field.sparse || field.normalized ||
        (position ? field.type!=="VEC3" || field.componentType!==5126 :
          field.type!=="SCALAR" || !unsigned.includes(field.componentType))) {
      throw new Error("请使用未压缩、浮点顶点的 glTF 或 GLB");
    }
    const bin=buffers[view.buffer], buffer=model.buffers?.[view.buffer];
    if (!bin || !int(buffer?.byteLength) || buffer.byteLength>bin.byteLength) throw invalid();
    const component=field.componentType===5121?1:field.componentType===5123?2:4;
    const width=component*(position?3:1);
    const start=view.byteOffset??0, shift=field.byteOffset??0, stride=view.byteStride??width;
    if (![start,shift,stride,view.byteLength,field.count].every(int) || stride<width ||
        start+view.byteLength>buffer.byteLength || !field.count ||
        shift+stride*(field.count-1)+width>view.byteLength) throw invalid();
    return {count:field.count, at(i) {
      if (!int(i) || i>=field.count) throw invalid();
      const offset=start+shift+i*stride;
      if (position) return [0,4,8].map(delta=>bin.getFloat32(offset+delta,true));
      if (component===1) return bin.getUint8(offset);
      return component===2 ? bin.getUint16(offset,true) : bin.getUint32(offset,true);
    }};
  }
  const mesh=[],visited=new Set(), min=[Infinity,Infinity,Infinity], max=[-Infinity,-Infinity,-Infinity];
  function visit(index,parent,depth) {
    const node=model.nodes?.[index], entry=model.meshes?.[node?.mesh];
    if (!int(index) || !node || depth>64 || visited.has(index) || visited.size>=1024) throw invalid();
    visited.add(index);
    const local=pvGlbTransform(node), transform=point=>parent(local(point));
    if (node.mesh!==undefined) {
      if (!Array.isArray(entry?.primitives)) throw invalid();
      for (const primitive of entry.primitives) {
        const mode=primitive.mode??4;
        if (![4,5,6].includes(mode)) continue;
        const vertices=read(primitive.attributes?.POSITION,true);
        const indices=primitive.indices===undefined ? {count:vertices.count,at:i=>i} : read(primitive.indices,false);
        const count=mode===4?indices.count/3:indices.count-2;
        if (!int(count) || count<1) throw invalid();
        if (count+mesh.length/9>triangleLimit) throw new Error("模型超出场景剩余三角面数量，请简化后导入");
        for (let i=0;i<count;i++) {
          const triangle=mode===4?[3*i,3*i+1,3*i+2]:mode===6?[0,i+1,i+2]:i%2?[i+1,i,i+2]:[i,i+1,i+2];
          for (const vertex of triangle) {
            const point=transform(vertices.at(indices.at(vertex)));
            if (!point.every(Number.isFinite)) throw invalid();
            for (let axis=0;axis<3;axis++) {
              min[axis]=Math.min(min[axis],point[axis]);
              max[axis]=Math.max(max[axis],point[axis]);
              mesh.push(point[axis]);
            }
          }
        }
      }
    }
    for (const child of node.children??[]) visit(child,transform,depth+1);
  }
  for (const node of root.nodes) visit(node,point=>point,0);
  const span=max.map((value,i)=>value-min[i]), largest=Math.max(...span);
  if (!mesh.length || !Number.isFinite(largest) || largest<=0) throw new Error("场景中没有可用的三角网格");
  const dimensions=span.map(value=>Math.max(.1,value/largest*2));
  const origin=[min[0]+span[0]/2,min[1],min[2]+span[2]/2];
  const normalized=mesh.map((value,i)=> {
    const axis=i%3;
    return Math.round((value-origin[axis])/largest*2/dimensions[axis]*100000)/100000;
  });
  const triangles=[];
  for (let i=0;i<normalized.length;i+=9) triangles.push(normalized.slice(i,i+9));
  return {triangles, dimensions};
}

function pvCameraRotation(pose) {
  const [right,up,forward]=pvCameraBasis(pose);
  const [[m00,m10,m20],[m01,m11,m21],[m02,m12,m22]]=[right,up,forward.map(value=>-value)];
  const trace=m00+m11+m22;
  let q;
  if (trace>0) {
    const s=2*Math.sqrt(1+trace);
    q=[(m21-m12)/s,(m02-m20)/s,(m10-m01)/s,s/4];
  } else if (m00>=m11 && m00>=m22) {
    const s=2*Math.sqrt(1+m00-m11-m22);
    q=[s/4,(m01+m10)/s,(m02+m20)/s,(m21-m12)/s];
  } else if (m11>=m22) {
    const s=2*Math.sqrt(1+m11-m00-m22);
    q=[(m01+m10)/s,s/4,(m12+m21)/s,(m02-m20)/s];
  } else {
    const s=2*Math.sqrt(1+m22-m00-m11);
    q=[(m02+m20)/s,(m12+m21)/s,s/4,(m10-m01)/s];
  }
  const length=Math.hypot(...q);
  return q.map(value=>value/length);
}

function pvGlb(scene,tick,name) {
  const gltf={
    asset:{version:"2.0",generator:"OneShot"},
    scene:0,scenes:[{name,nodes:[]}],nodes:[],cameras:[],meshes:[],
    accessors:[],bufferViews:[],buffers:[],
  };
  const parts=[];
  let byteLength=0;
  function accessor(values,type,{target,bounds=false}={}) {
    const components={SCALAR:1,VEC3:3,VEC4:4}[type],data=new Float32Array(values);
    const view={buffer:0,byteOffset:byteLength,byteLength:data.byteLength};
    if (target) view.target=target;
    const entry={bufferView:gltf.bufferViews.length,componentType:5126,count:data.length/components,type};
    if (bounds) {
      entry.min=Array(components).fill(Infinity);
      entry.max=Array(components).fill(-Infinity);
      for (let i=0;i<data.length;i++) {
        const axis=i%components;
        entry.min[axis]=Math.min(entry.min[axis],data[i]);
        entry.max[axis]=Math.max(entry.max[axis],data[i]);
      }
    }
    gltf.bufferViews.push(view);
    parts.push(data);
    byteLength+=data.byteLength;
    return gltf.accessors.push(entry)-1;
  }
  const translation=({x,y,z})=>[x,y,z];
  const verticalFov=({fov})=>fov*Math.PI/180;
  const objectRotation=({yaw})=>[0,Math.sin(-yaw*Math.PI/360),0,Math.cos(yaw*Math.PI/360)];
  const camera=pvSample(scene.camera,tick),[width,height]=PV_SIZE[scene.aspect];
  gltf.cameras.push({name:"预演机位",type:"perspective",perspective:{
    yfov:verticalFov(camera),znear:PV_NEAR,aspectRatio:width/height,
  }});
  gltf.nodes.push({name:"预演机位",camera:0,translation:translation(camera),rotation:pvCameraRotation(camera)});
  const shapes=new Map();
  for (const item of scene.objects) {
    const meshKey=item.shape==="mesh"?item.triangles:item.shape;
    if (!shapes.has(meshKey)) {
      const positions=[],colors=[];
      for (const [points,light] of pvFaces(item)) {
        const tone=Math.round(228*light)/255;
        const linear=((tone+.055)/1.055)**2.4;
        for (let i=1;i<points.length-1;i++) {
          positions.push(...points[0],...points[i],...points[i+1]);
          colors.push(linear,linear,linear,linear,linear,linear,linear,linear,linear);
        }
      }
      if (positions.length) {
        const attributes={
          POSITION:accessor(positions,"VEC3",{target:34962,bounds:true}),
          COLOR_0:accessor(colors,"VEC3",{target:34962}),
        };
        shapes.set(meshKey,gltf.meshes.push({name:PV_SHAPES[item.shape]||item.label,primitives:[{attributes,material:0}]})-1);
      }
    }
    const pose=pvSample(item.keys,tick);
    gltf.nodes.push({name:item.label,mesh:shapes.get(meshKey),scale:[item.width,item.height,item.depth],
      translation:translation(pose),rotation:objectRotation(pose)});
  }
  gltf.scenes[0].nodes=gltf.nodes.map((_,index)=>index);
  const extensions=[];
  if (gltf.meshes.length) {
    extensions.push("KHR_materials_unlit");
    gltf.materials=[{name:"白模",doubleSided:true,pbrMetallicRoughness:{metallicFactor:0},
      extensions:{KHR_materials_unlit:{}}}];
  } else delete gltf.meshes;
  const animation={name:"白模预演",samplers:[],channels:[]};
  const ticks=Array.from({length:scene.duration*PV_FPS+1},(_,index)=>index);
  const time=accessor(ticks.map(frame=>frame/PV_FPS),"SCALAR",{bounds:true});
  function channel(target,type,values) {
    const output=accessor(values.flat(),type);
    const sampler=animation.samplers.push({input:time,output,interpolation:"LINEAR"})-1;
    animation.channels.push({sampler,target});
  }
  function motion(track,index,rotation) {
    const poses=ticks.map(frame=>pvSample(track,frame));
    const rotations=poses.map(rotation);
    for (let i=1;i<rotations.length;i++) {
      if (rotations[i].reduce((dot,value,axis)=>dot+value*rotations[i-1][axis],0)<0) {
        rotations[i]=rotations[i].map(value=>-value);
      }
    }
    channel({node:index,path:"translation"},"VEC3",poses.map(translation));
    channel({node:index,path:"rotation"},"VEC4",rotations);
    return poses;
  }
  const cameraPoses=motion(scene.camera,0,pvCameraRotation);
  scene.objects.forEach((item,index)=>motion(item.keys,index+1,objectRotation));
  if (cameraPoses.some(pose=>pose.fov!==cameraPoses[0].fov)) {
    extensions.push("KHR_animation_pointer");
    channel({path:"pointer",extensions:{KHR_animation_pointer:{pointer:"/cameras/0/perspective/yfov"}}},
      "SCALAR",cameraPoses.map(verticalFov));
  }
  gltf.animations=[animation];
  if (extensions.length) gltf.extensionsUsed=extensions;
  gltf.buffers.push({byteLength});

  const json=new TextEncoder().encode(JSON.stringify(gltf));
  const padded=new Uint8Array((json.length+3)&~3).fill(0x20);
  padded.set(json);
  const header=new DataView(new ArrayBuffer(20));
  [0x46546c67,2,28+padded.length+byteLength,padded.length,0x4e4f534a]
    .forEach((value,i)=>header.setUint32(i*4,value,true));
  const bin=new DataView(new ArrayBuffer(8));
  bin.setUint32(0,byteLength,true);
  bin.setUint32(4,0x004e4942,true);
  return new Blob([header,padded,bin,...parts],{type:"model/gltf-binary"});
}
