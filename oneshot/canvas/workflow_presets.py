"""Original, editable starter workflows for the template catalog."""


def node(id, kind, name, x, y, **data):
    return {"id":id, "type":kind, "name":name, "x":x, "y":y,
            "data":data, "versions":[], "cur":-1, "job":None}


def preset(id, name, category, description, nodes, connections):
    edges = [{"from":source,"to":target,**({"role":role[0]} if role else {})}
             for source,target,*role in connections]
    return {"id":id, "name":name, "category":category, "description":description, "author":"OneShot",
            "builtin":True, "nodes":len(nodes), "data":{
                "nodes":nodes, "edges":edges, "groups":[{"id":"g1","name":name,"nodes":[n["id"] for n in nodes]}],
                "seq":len(nodes)+1, "view":{"x":100,"y":110,"k":.65},
            }}


PRESETS = {entry["id"]:entry for entry in (
    preset("starter-storyboard", "三镜头故事分镜", "分镜", "替换故事简报后，在分镜节点拆分镜头，再展开为首帧和视频节点。", [
        node("n1","text","故事简报",0,0,text="傍晚的修表铺即将打烊。雨刚停，一位顾客带着一只停走的怀表回来。用三个镜头表现相遇、发现和释然。"),
        node("n2","script","三镜头分镜",430,0,aspect="16:9",nshots="3",shotlen="5"),
    ], [("n1","n2")]),
    preset("starter-product", "商品图三种画幅", "商品", "修改商品描述，生成方形主图，再以主图为参考生成横幅广告和竖版海报。", [
        node("n1","text","商品描述",0,310,text="一盏深蓝色钴釉陶瓷台灯，乳白灯罩，暖色灯光，浅灰自然影棚。保持商品造型和颜色一致。"),
        node("n2","image","商品方形主图",450,0,aspect="1:1",prompt="产品居中，三分之二视角，保留完整轮廓，无文字。"),
        node("n3","image","横版广告",450,430,aspect="16:9",prompt="产品靠右，左侧留出文案空间，柔和侧光，无文字。"),
        node("n4","image","竖版海报",450,765,aspect="9:16",prompt="台灯放在浅木边桌，画面上方留白，完整展示灯罩与灯座，无文字。"),
    ], [("n1","n2"),("n1","n3"),("n1","n4"),("n2","n3"),("n2","n4")]),
    preset("starter-keyframes", "首尾帧短片", "视频", "先生成两张关键画面，再用已接好的首尾帧连线生成短片。", [
        node("n1","image","起始画面",0,0,aspect="16:9",
             prompt="俯拍深色木桌，左侧是一张折好的白色纸船，右侧是一只盛水的浅青陶盘。固定机位，柔和晨光。"),
        node("n2","image","结束画面",0,330,aspect="16:9",
             prompt="保留参考图的机位、光线和构图。白色纸船现在漂浮在右侧的浅青陶盘中央，桌面左侧空了。"),
        node("n3","video","首尾帧过渡",650,120,aspect="16:9",duration=5,
             prompt="A hand gently lifts the white paper boat from the table and sets it afloat in the shallow bowl. Locked overhead camera."),
    ], [("n1","n2"),("n1","n3","first"),("n2","n3","last")]),
    preset("starter-character", "角色造型与转面", "角色", "先生成标准主图，再以主图为参考生成头肩、侧面和背面。", [
        node("n1","image","标准角色主图",0,450,aspect="3:4",
             prompt="写实电影造型参考。短黑发的年轻女钟表匠，窄脸，浅灰围裙，深棕工装，黑鞋。自然站立，身体略转约三十度，完整全身，浅灰背景，均匀光。"),
        node("n2","image","正面头肩",480,0,aspect="1:1",prompt="参考主图。单人正面头肩近照，中性表情，保留脸型和发际线，浅灰背景。"),
        node("n3","image","全身侧面",480,395,aspect="3:4",prompt="参考主图。同一角色全身侧面，鞋和衣摆完整，保持服装比例和配饰位置，浅灰背景。"),
        node("n4","image","全身背面",480,850,aspect="3:4",prompt="参考主图。同一角色全身背面，鞋和衣摆完整，保持发型、身材和服装，浅灰背景。"),
    ], [("n1","n2"),("n1","n3"),("n1","n4")]),
)}
