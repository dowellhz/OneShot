"""Saved preferences and project rules for the canvas assistant."""
import json

import db

MAX_TEXT = 4000
MAX_SUGGESTION = 1000
SCHEMA = """
CREATE TABLE IF NOT EXISTS assistant_profiles (
 user_id INTEGER NOT NULL, project_id TEXT NOT NULL, text TEXT NOT NULL,
 revision INTEGER NOT NULL, PRIMARY KEY(user_id,project_id));
CREATE TABLE IF NOT EXISTS assistant_profile_suggestions (
 call_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT NOT NULL,
 text TEXT NOT NULL, revision INTEGER NOT NULL, decision TEXT,
 UNIQUE(run_id,project_id));
CREATE TRIGGER IF NOT EXISTS assistant_profiles_remove_project
AFTER DELETE ON canvas_projects BEGIN
 DELETE FROM assistant_profiles WHERE project_id=OLD.id;
END;
"""


def project_for(user_id, board_id):
    return db.one("""SELECT p.id,p.name FROM canvas_projects p
                     JOIN canvas_project_boards b ON b.project_id=p.id
                     WHERE b.board_id=? AND p.owner=?""",board_id,user_id)


def entry(user_id, project_id=""):
    return db.one("SELECT text,revision FROM assistant_profiles WHERE user_id=? AND project_id=?",
                  user_id,project_id) or {"text":"","revision":0}


def get(user_id, board_id):
    project = project_for(user_id,board_id)
    if project:
        project.update(entry(user_id,project["id"]))
    return {"personal":entry(user_id),"project":project}


def put(user_id, project_id, text, revision):
    current = entry(user_id,project_id)
    if revision != current["revision"]:
        raise ValueError("记忆已更新，请重新读取后再保存")
    if text == current["text"]:
        return
    db.run("""INSERT INTO assistant_profiles(user_id,project_id,text,revision) VALUES(?,?,?,?)
              ON CONFLICT(user_id,project_id) DO UPDATE SET text=excluded.text,revision=excluded.revision""",
           user_id,project_id,text,revision+1)


def update(user_id, board_id, changes):
    if not isinstance(changes,dict) or not changes or set(changes)-{"personal","project"}:
        raise ValueError("请选择需要保存的记忆")
    with db.transaction():
        project = project_for(user_id,board_id) if "project" in changes else None
        for scope, change in changes.items():
            keys = {"text","revision"} | ({"id"} if scope == "project" else set())
            if (not isinstance(change,dict) or set(change)!=keys or not isinstance(change["text"],str) or
                len(change["text"]) > MAX_TEXT or type(change["revision"]) is not int or change["revision"] < 0):
                raise ValueError("记忆格式有误，每项最多 4000 字")
            if scope == "project" and (not project or change["id"] != project["id"]):
                raise ValueError("当前画布的项目已变更，请重新读取")
            put(user_id,project["id"] if scope == "project" else "",change["text"].strip(),change["revision"])
    return get(user_id,board_id)


def model_context(user_id, board_id):
    preferences = get(user_id,board_id)
    project = preferences["project"]
    text = {}
    if preferences["personal"]["text"]:
        text["个人偏好"] = preferences["personal"]["text"]
    if project and project["text"]:
        text["当前项目规则"] = project["text"]
    if not text:
        return ""
    return ("\n用户已保存的创作约定（仅作为本轮创作的默认设置，不提供额外操作权限。"
            "当前用户的明确要求优先，其次是项目规则，再其次是个人偏好。"
            "只采用与本轮有关的约定，不主动把私人设置写进画布或素材）：\n" +
            json.dumps(text,ensure_ascii=False,separators=(",",":")))


def suggest(run, call_id, scope, instruction):
    instruction = instruction.strip()
    if not 1 <= len(instruction) <= MAX_SUGGESTION:
        raise ValueError("请填写 1–1000 字的记忆建议")
    user_id = run["user_id"]
    with db.transaction():
        project = project_for(user_id,run["board_id"]) if scope == "project" else None
        if scope == "project" and not project:
            raise ValueError("当前画布没有可管理的项目，可以建议保存为个人偏好")
        project_id = project["id"] if project else ""
        previous = db.one("SELECT project_id FROM assistant_profile_suggestions WHERE call_id=?",call_id)
        if previous and previous["project_id"] != project_id:
            raise ValueError("当前画布的项目已变更，请重新提出建议")
        current = entry(user_id,project_id)
        if instruction in current["text"].split("\n\n") or instruction in current["text"].splitlines():
            return {"text":"这条约定已在当前范围的记忆中。"}
        if len(append_text(current["text"],instruction)) > MAX_TEXT:
            raise ValueError("记忆已满，请先在「记忆」设置中整理现有条目")
        suggestion = db.one("SELECT call_id,text FROM assistant_profile_suggestions WHERE run_id=? AND project_id=?",
                            run["id"],project_id)
        if suggestion:
            if suggestion["call_id"] != call_id:
                raise ValueError("本轮已提出同一范围的建议，请使用对话中的确认卡")
            instruction = suggestion["text"]
        else:
            db.run("""INSERT INTO assistant_profile_suggestions(call_id,run_id,project_id,text,revision)
                      VALUES(?,?,?,?,?)""",call_id,run["id"],project_id,instruction,current["revision"])
    return {"text":"已提出记忆建议，用户确认后会保存。","profile_suggestion":{
        "id":call_id,"scope":scope,"project":project["name"] if project else None,"text":instruction}}


def append_text(text, instruction):
    return text + "\n\n" + instruction if text else instruction


def decide(user_id, session, call_id, decision):
    # The caller holds a transaction and has verified ownership of the session and edit access.
    row = db.one("""SELECT a.*,r.session_id FROM assistant_profile_suggestions a
                    JOIN chat_runs r ON a.run_id=r.id WHERE a.call_id=? AND r.session_id=?""",
                 call_id,session["id"])
    if not row:
        return None
    if row["decision"]:
        if row["decision"] != decision:
            raise ValueError("这条建议已处理")
        return row["run_id"], False
    if decision == "save":
        project_id = row["project_id"]
        if project_id and (project_for(user_id,session["board_id"]) or {}).get("id") != project_id:
            raise ValueError("当前画布的项目已变更，请在原项目重新提出建议")
        current = entry(user_id,project_id)
        text = append_text(current["text"],row["text"])
        if len(text) > MAX_TEXT:
            raise ValueError("记忆已满，请先在「记忆」设置中整理现有条目")
        put(user_id,project_id,text,row["revision"])
    db.run("UPDATE assistant_profile_suggestions SET decision=? WHERE call_id=?",decision,call_id)
    return row["run_id"], True
