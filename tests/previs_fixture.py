"""Reusable previsualization scene with a moving actor."""




def motion_scene():
    return {"duration":4,"aspect":"16:9","camera":[
        {"t":t,"x":0,"y":2,"z":6,"tx":0,"ty":1,"tz":0,"fov":42} for t in (0,48,96)],
        "objects":[{"id":"walker","label":"人物","shape":"figure","width":.8,"height":2,"depth":.6,
                    "keys":[{"t":0,"x":0,"y":0,"z":0,"yaw":0},
                            {"t":48,"x":2,"y":0,"z":1,"yaw":0,"ease":"smooth"},
                            {"t":96,"x":4,"y":0,"z":2,"yaw":0}]}]}
