"use strict";

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
    if (!shapes.has(item.shape)) {
      const positions=[],colors=[];
      for (const [points,light] of PV_MESH[item.shape]) {
        const tone=Math.round(228*light)/255;
        const linear=((tone+.055)/1.055)**2.4;
        for (let i=1;i<points.length-1;i++) {
          positions.push(...points[0],...points[i],...points[i+1]);
          colors.push(linear,linear,linear,linear,linear,linear,linear,linear,linear);
        }
      }
      const attributes={
        POSITION:accessor(positions,"VEC3",{target:34962,bounds:true}),
        COLOR_0:accessor(colors,"VEC3",{target:34962}),
      };
      shapes.set(item.shape,gltf.meshes.push({name:PV_SHAPES[item.shape],primitives:[{attributes,material:0}]})-1);
    }
    const pose=pvSample(item.keys,tick);
    gltf.nodes.push({name:item.label,mesh:shapes.get(item.shape),scale:[item.width,item.height,item.depth],
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
