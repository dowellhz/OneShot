"""Field-by-field video prompts (风格/场景/人物/镜头/动作/对话/声音/配乐) -> H3's official prompt pieces.

compose() gives the deterministic merge used for generation: one shot description in timeline order,
dialogue as `Name (S1) says: <d>[Chinese] ...</d>` per the official guide, sound/music for their own sections.
for_rewriter() gives the labeled request handed to the Qwen rewriter, which turns it into English.
"""
import re

KEYS = ("style", "scene", "people", "camera", "action", "dialogue", "sound", "music")
_CJK = re.compile(r"[㐀-鿿]")
_SEP = re.compile(r"\s*[:：]\s*")
# speech written inside an action line: 裴照低声问：“谁？” / 河神说:"..."  (prefix = the clause before the colon)
_INLINE = re.compile(r"([^，。,.;；“”\"「」]*?)[:：]\s*[“\"「]([^”\"」]+)[”\"」]")
_QUOTES = "“”\"「」"
_SPEAKER = re.compile(r"^(.{1,24}?)\s*[:：]+\s*(.+)$")          # 名字（语气）：台词 — tolerates "：：" and spaces
_VERB = re.compile(r"\s*(说|道|问|喊|答|念|叫|低语|回答|说道)$")
_NUMBER = r"[0-9]+(?:\.[0-9]+)?"
_ACTION_RANGE = re.compile(rf"^({_NUMBER})\s*[-–—~～至到]\s*({_NUMBER})\s*(?:秒|s(?:ec(?:ond)?s?)?\b)\s*[:：]?\s*",
                           re.I)
ACTION_TIME = re.compile(rf"{_NUMBER}–{_NUMBER} s:")


def _unquote(s: str) -> str:
    s = s.strip().lstrip(":：").strip()
    if len(s) >= 2 and s[0] in _QUOTES and s[-1] in _QUOTES:
        s = s[1:-1].strip()
    return s


def _lines(s) -> list[str]:
    return [x.strip(" \t-•·") for x in str(s or "").splitlines() if x.strip(" \t-•·")]


def _one(s) -> str:
    return " ".join(_lines(s))


def _end(s: str) -> str:
    s = s.rstrip()
    return s if not s or s[-1] in "。.!！?？…" else s + ("。" if _CJK.search(s[-1:]) else ".")


def _lang(s: str) -> str:
    return "Chinese" if _CJK.search(s) else "English"


class _Speakers:
    """Stable (S1), (S2)… speaker IDs; names listed in the 人物 field are recognized inside action lines."""

    def __init__(self, people: str, subj: dict | None = None, *, tag_language=True):
        self.subj = subj or {}          # name -> <Subject k> number (Ref2VA character references)
        self.tag_language = tag_language
        self.ids: dict[str, int] = {}
        self.desc: dict[str, str] = {}
        for ln in _lines(people):
            parts = _SEP.split(ln, maxsplit=1)
            if len(parts) == 2 and 0 < len(parts[0]) <= 12:
                self.desc[parts[0]] = parts[1]
        known = set(self.desc) | set(self.subj)
        short_names = {}
        for name in known:
            head, *rest = re.split(r"[·・•]", name, maxsplit=1)
            head = head.strip()
            if rest and len(head) >= 2 and head not in known:
                short_names.setdefault(head, []).append(name)
        self.aliases = {short: names[0] for short, names in short_names.items() if len(names) == 1}

    def tag(self, name: str) -> str:   # appearance comes from the 人物 sentence earlier in the description
        name = name.strip()
        name = self.aliases.get(name, name)
        if name not in self.ids:
            self.ids[name] = len(self.ids) + 1
        lab = f" <Subject {self.subj[name]}>" if name in self.subj else ""
        return f"{name}{lab} (S{self.ids[name]})"

    def inline(self, prefix: str, words: str) -> str:
        """'河神抱着碗低声说' + words -> '河神 (desc) (S1)抱着碗低声说: <d>[Chinese] words</d>' (known names only)."""
        names = set(self.desc) | set(self.subj) | set(self.aliases) | set(self.ids)
        known = sorted((n for n in names if n in prefix), key=lambda n: (prefix.index(n), -len(n)))
        if known:
            n = known[0]; i = prefix.index(n)
            head = prefix[:i] + self.tag(n) + prefix[i + len(n):]
        else:
            head = self.tag(prefix) if prefix.strip() else "a voice"
        return f"{head.rstrip()}: {self.speech(words)}"

    def speech(self, words: str) -> str:
        language = f"[{_lang(words)}] " if self.tag_language else ""
        return f"<d>{language}{words.strip()}</d>"

    def line(self, name: str, how: str, words: str) -> str:
        words = words.strip()
        how = how.strip()
        return f"{self.tag(name)}{(' ' + how) if how else ''} says: {self.speech(words)}"


def people(f: dict) -> dict[str, str]:
    """人物 field -> {name: appearance}."""
    return _Speakers(f.get("people")).desc


def _people_line(f: dict, subj: dict) -> str:
    out = []
    for ln in _lines(f.get("people")):
        parts = _SEP.split(ln, maxsplit=1)
        if len(parts) == 2 and parts[0] in subj:
            ln = f"{parts[0]}（<Subject {subj[parts[0]]}>）：{parts[1]}"
        out.append(ln)
    return "；".join(out)


def _dialogue_beats(f: dict, sp: _Speakers) -> list[str]:
    beats = []
    last = None                                   # a line without a speaker continues the previous one
    for ln in _lines(f.get("dialogue")):
        m = _SPEAKER.match(ln)
        if m and not ln.lstrip().startswith(tuple(_QUOTES)):
            who, words = m.group(1).strip(), m.group(2)
            pm = re.match(r"(.+?)\s*[（(]([^）)]+)[）)]$", who)      # 裴照（低声）：谁？
            if pm:
                name, how = pm.group(1).strip(), pm.group(2).strip()
            else:                                     # @图4 声音浑厚 说：… / 河神低声说：…
                who = _VERB.sub("", who).strip()
                name, _, how = who.partition(" ")
                if not how and name not in sp.desc and name not in sp.ids:
                    known = sorted((n for n in set(sp.desc) | set(sp.subj) | set(sp.aliases) | set(sp.ids)
                                    if name.startswith(n)), key=len, reverse=True)
                    if known:
                        name, how = known[0], name[len(known[0]):]
            last = (name or who, how.strip())
            beats.append(sp.line(last[0], last[1], _unquote(words)))
        else:
            w = _unquote(ln)
            beats.append(sp.line(last[0], "", w) if last else f"a voice says: {sp.speech(w)}")
    return beats


def _action_beats(f: dict, sp: _Speakers) -> list[str]:
    beats = []
    for line in _lines(f.get("action")):
        timing = _ACTION_RANGE.match(line)
        prefix = ""
        if timing and timing.end() < len(line):
            start, end = timing.groups()
            prefix, line = f"{start}–{end} s: ", line[timing.end():]
        beats.append(prefix + _INLINE.sub(lambda m: sp.inline(m.group(1), m.group(2)), line))
    return beats


def compose(f: dict, extra: str = "", subj: dict | None = None) -> tuple[str, str, str]:
    """-> (shot description, overall_soundscape text, non_diegetic_music text). subj: {name: subject number}."""
    subj = subj or {}
    sp = _Speakers(f.get("people"), subj)
    out = []
    for k in ("style", "scene", "people"):
        v = _people_line(f, subj) if k == "people" else _one(f.get(k))
        if v:
            out.append(_end(v))
    cam = _one(f.get("camera"))
    if cam:
        out.append(_end("镜头：" + cam if _CJK.search(cam) else "Camera: " + cam))

    actions = [line.rstrip("。.;；，,") for line in _action_beats(f, sp)]
    dialogue = _dialogue_beats(f, sp)
    timed = any(ACTION_TIME.match(line) for line in actions)
    if timed:
        out.extend(_end(line) for line in [*actions, *dialogue])
    elif beats := [*actions, *dialogue]:
        joined = beats[0] + "".join(("，然后" if _CJK.search(b[:1]) else ", then ") + b for b in beats[1:])
        out.append(_end(joined))
    if extra and extra.strip():
        out.append(_end(_one(extra)))
    return ("\n" if timed else " ").join(out), _one(f.get("sound")), _one(f.get("music"))


def has_content(f) -> bool:
    return isinstance(f, dict) and any(str(f.get(k) or "").strip() for k in KEYS if k not in ("sound", "music"))


def for_rewriter(f: dict, extra: str = "", subj: dict | None = None) -> str:
    """Labeled Chinese/English request for the LLM rewriter."""
    rows = []
    sp = _Speakers(f.get("people"), subj, tag_language=False)
    if subj:
        rows.append("Character mapping: " + "; ".join(f"{n} = <Subject {k}>" for n, k in subj.items()))
    if sp.aliases:
        rows.append("Character aliases (same people, one on-screen instance per identity): " +
                    "; ".join(f"{short} = {name}" + (f" <Subject {sp.subj[name]}>" if name in sp.subj else "")
                              for short, name in sorted(sp.aliases.items())))
    lab = {"style": "风格 Style", "scene": "场景 Scene / background", "people": "人物 Characters (name: appearance)",
           "camera": "镜头 Camera"}
    for k, t in lab.items():
        v = "; ".join(_lines(f.get(k))) if k == "people" else _one(f.get(k))
        if v:
            rows.append(f"{t}: {v}")
    acts = _action_beats(f, sp)
    if acts:
        rows.append("动作 Actions, in time order (keep this order, one continuous shot unless cuts are asked for):\n"
                    + "\n".join(f"{i + 1}. {a}" for i, a in enumerate(acts)))
    dl = _dialogue_beats(f, sp)
    if dl:
        rows.append("对话 Dialogue, in order — keep the spoken words inside each <d> block verbatim and add the correct "
                    "language tag. Preserve the (S#) speaker ID and its bound <Subject N>. Place each line at the "
                    "matching moment of the actions:\n" + "\n".join(dl))
    if extra and extra.strip():
        rows.append("补充 Additional notes: " + _one(extra))
    if not _one(f.get("music")):
        rows.append("Background music: none. Write exactly `non_diegetic_music: N/A`.")
    return "\n".join(rows)
