"""Bounded public research providers for the creative assistant."""

import asyncio
import io
import json
import re
import uuid
from html.parser import HTMLParser
from ipaddress import ip_address
from urllib.parse import parse_qs, urlsplit

import aiohttp
from PIL import Image, ImageOps

import image_editor
import providers
import db


class ResearchError(ValueError):
    pass


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, text):
        self.parts.append(text)


def plain(value, limit):
    parser = PlainText()
    parser.feed(value if isinstance(value,str) else "")
    return " ".join("".join(parser.parts).split())[:limit]


def public_link(value):
    if not isinstance(value,str) or len(value)>1800 or re.search(r"[\s<>\\\x00-\x1f]",value):
        return ""
    try:
        target = urlsplit(value)
        host = target.hostname
        if (target.scheme not in ("https","http") or not host or target.username is not None or
                target.password is not None or target.port not in (None,80,443)):
            return ""
        try:
            if not ip_address(host).is_global:
                return ""
        except ValueError:
            if "." not in host or host.endswith((".local",".localhost",".internal",".test")):
                return ""
    except ValueError:
        return ""
    return value


def commons_media(value):
    value = public_link(value)
    if value:
        url = urlsplit(value)
        if url.scheme=="https" and url.hostname in ("upload.wikimedia.org","thumb.wikimedia.org") and url.port in (None,443) and url.path.startswith("/wikipedia/commons/"):
            return value
    return ""


class DuckResults(HTMLParser):
    def __init__(self):
        super().__init__()
        self.items, self.parts, self.target = [], [], None
        self.url = ""
        self.challenge = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if attrs.get("id") == "challenge-form":
            self.challenge = True
        if tag != "a":
            return
        classes = attrs.get("class","").split()
        if "result__a" in classes:
            href = attrs.get("href","")
            try:
                target = urlsplit(href)
                if target.hostname in ("duckduckgo.com","html.duckduckgo.com") and target.path=="/l/":
                    href = parse_qs(target.query).get("uddg",[""])[0]
            except ValueError:
                href = ""
            self.target = "title"
            self.url = public_link(href)
            self.parts = []
        elif "result__snippet" in classes:
            self.target = "snippet"
            self.parts = []

    def handle_data(self, text):
        if self.target:
            self.parts.append(text)

    def handle_endtag(self, tag):
        if tag != "a" or not self.target:
            return
        text = " ".join("".join(self.parts).split())
        if self.target=="title" and self.url and text:
            self.items.append({"title":text[:180],"url":self.url,"snippet":""})
        if self.target=="snippet" and self.items and self.url==self.items[-1]["url"]:
            self.items[-1]["snippet"] = text[:320]
        self.target = None


async def fetch(http, url, *, params=None, headers=None, maximum=1_500_000):
    headers = {"User-Agent":"OneShotResearch/1.0", **(headers or {})}
    try:
        async with http.get(url,params=params,headers=headers,allow_redirects=False,timeout=aiohttp.ClientTimeout(total=10)) as response:
            if response.status != 200 or response.content_length is not None and response.content_length>maximum:
                raise ResearchError("公开搜索服务暂时不可用")
            data = bytearray()
            async for chunk in response.content.iter_chunked(32_768):
                data.extend(chunk)
                if len(data)>maximum:
                    raise ResearchError("服务响应超过允许大小")
            return bytes(data)
    except (aiohttp.ClientError,asyncio.TimeoutError) as error:
        raise ResearchError("公开搜索服务连接失败") from error


async def json_results(http, url, params, headers=None):
    try:
        result = json.loads(await fetch(http,url,params=params,headers=headers))
    except (ValueError,UnicodeError) as error:
        raise ResearchError("公开搜索服务未返回有效结果") from error
    if not isinstance(result,dict) or result.get("error"):
        raise ResearchError("公开搜索服务未返回有效结果")
    return result


def field(data, *keys, default=None):
    for key in keys:
        if not isinstance(data,dict):
            return default
        data = data.get(key)
    return default if data is None else data


async def brave(http, route, query, count, days):
    key = route["provider"]["secrets"].get("api_key")
    if not key:
        raise ResearchError("Brave Search 尚未配置密钥")
    params = {"q":query,"count":count,"safesearch":"moderate","text_decorations":"false"}
    if days:
        params["freshness"] = {1:"pd",7:"pw",30:"pm",365:"py"}[days]
    payload = await json_results(http,"https://api.search.brave.com/res/v1/web/search",params,{"X-Subscription-Token":key})
    return [{"title":plain(item.get("title"),180),"url":public_link(item.get("url")),
             "snippet":plain(item.get("description"),320),"date":plain(item.get("page_age"),40)}
            for item in field(payload,"web","results",default=[]) if isinstance(item,dict)]


async def wikipedia(http, query, count, language):
    host = f"https://{language}.wikipedia.org"
    data = await json_results(http,host+"/w/api.php",{"action":"query","list":"search","srsearch":query,
        "srlimit":count,"format":"json","formatversion":2})
    return [{"title":plain(item.get("title"),180),"url":host+"/?curid="+str(item["pageid"]),
             "snippet":plain(item.get("snippet"),320)} for item in field(data,"query","search",default=[])
            if isinstance(item,dict) and type(item.get("pageid")) is int]


async def open_images(http, query, count):
    host = "https://commons.wikimedia.org"
    data = await json_results(http,host+"/w/api.php",{"action":"query","generator":"search","gsrnamespace":6,
        "gsrsearch":query,"gsrlimit":min(20,count*2),"prop":"imageinfo","iiprop":"url|thumbmime|mime|size|extmetadata|user",
        "iiextmetadatafilter":"Artist|LicenseShortName|LicenseUrl","iiurlwidth":640,"format":"json","formatversion":2})
    pages = field(data,"query","pages",default=[])
    items = []
    for page in sorted(pages,key=lambda x:x.get("index",0)):
        info = (page.get("imageinfo") or [{}])[0]
        mime = info.get("thumbmime") or info.get("mime")
        photo = commons_media(info.get("thumburl") or info.get("url"))
        if mime not in ("image/png","image/jpeg","image/webp") or not photo or type(page.get("pageid")) is not int:
            continue
        license_name = plain(field(info,"extmetadata","LicenseShortName","value"),90)
        if not license_name:
            continue
        items.append({"title":plain(page.get("title",""),180).removeprefix("File:"),"url":host+"/?curid="+str(page["pageid"]),
            "image":photo,"license":license_name,"license_url":public_link(field(info,"extmetadata","LicenseUrl","value")),
            "credit":plain(field(info,"extmetadata","Artist","value",default=info.get("user")),160)})
    return items[:count]


async def search(http, query, kind="web", count=5, days=None, site=None):
    query = " ".join(query.split())
    if not query or len(query)>240 or query.startswith(("!","\\")):
        raise ResearchError("请输入 1–240 个字符的公开搜索词")
    if site and not re.fullmatch(r"(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,24}",site):
        raise ResearchError("站点筛选需要域名，例如 example.org")
    if kind=="images":
        if days or site:
            raise ResearchError("开放图片搜索使用 Wikimedia Commons，不支持站点或时效筛选")
        return "Wikimedia Commons",await open_images(http,query,count)
    full_query = query+f" site:{site.lower()}" if site else query
    attempts = providers.routes("search")
    for route in attempts:
        try:
            items = await brave(http,route,full_query,count,days)
            break
        except ResearchError:
            continue
    else:
        items = None
    if items is not None:
        source = "Brave Search"
    elif days:
        raise ResearchError("指定时效的公开搜索需要在控制台配置 Brave Search")
    else:
        source = "DuckDuckGo"
        try:
            parser = DuckResults()
            parser.feed((await fetch(http,"https://html.duckduckgo.com/html/",params={"q":full_query})).decode("utf-8","replace"))
            if parser.challenge:
                raise ResearchError("搜索服务暂时不接受自动请求")
            items = parser.items
        except ResearchError:
            if site:
                raise ResearchError("本次站点搜索不可用，请重试或配置 Brave Search") from None
            source = "Wikipedia（百科范围）"
            items = await wikipedia(http,query,count,"zh" if re.search(r"[\u3400-\u9fff]",query) else "en")
    found = {}
    for item in items:
        url = item["url"]
        if site and url:
            host = urlsplit(url).hostname.lower()
            if host!=site.lower() and not host.endswith("."+site.lower()):
                continue
        if item["title"] and url:
            found.setdefault(url,item)
    return source,list(found.values())[:count]


async def download_image(http, directory, item):
    url = commons_media(item.get("image"))
    if not url:
        raise ResearchError("此结果没有可导入的开放图片")
    payload = await fetch(http,url,maximum=8_000_000)

    def save():
        try:
            with Image.open(io.BytesIO(payload),formats=["JPEG","PNG","WEBP"]) as photo:
                if photo.width*photo.height>20_000_000:
                    raise ResearchError("参考图片尺寸超出限制")
                photo = ImageOps.exif_transpose(photo).convert("RGBA")
                photo.thumbnail((1600,1600))
                return image_editor.save(directory,photo,"web_reference",kind="input")
        except (OSError,Image.DecompressionBombError) as error:
            raise ResearchError("无法读取开放图片") from error
    return await asyncio.to_thread(save)


def lookup(session, ids):
    rows = db.q("""SELECT c.result FROM chat_calls c JOIN chat_runs r ON r.id=c.run_id
                   WHERE r.session_id=? AND c.name='web_search' AND c.state='done' ORDER BY c.rowid DESC LIMIT 12""",session)
    sources = {}
    for row in rows:
        for item in json.loads(row["result"] or "{}").get("sources",[]):
            sources[item["id"]] = item
    if any(identifier not in sources for identifier in ids):
        raise ResearchError("部分来源已失效，请先在当前对话重新搜索")
    return [sources[identifier] for identifier in dict.fromkeys(ids)]


def markdown_text(text):
    return re.sub(r"([\\`*_\[\]<>])",r"\\\1",text)


async def save_references(service, run, user, cid, args):
    bid = run["board_id"]
    board = service.board(user,bid)
    prior = next((op["result"] for op in board.get("agent_ops",[]) if op["id"]==cid),None)
    if prior is not None:
        return prior
    sources = lookup(run["session_id"],args["source_ids"])
    mode = args.get("kind","notes")
    name = (args.get("name") or "公开资料来源").strip()[:40] or "公开资料来源"
    if mode=="notes":
        sections = [f"# {markdown_text(name)}"]
        for source in sources:
            sections.append(f"- [{markdown_text(source['title'])}](<{source['url']}>)")
            for key in ("date","credit","license","snippet"):
                if source.get(key):
                    sections.append("  "+markdown_text(source[key]))
        text = "\n".join(sections)
        def change(board):
            nid = "a"+uuid.uuid5(uuid.NAMESPACE_URL,cid).hex[:20]
            x = max((n.get("x",0)+service.dimensions(n)[0] for n in board["nodes"]),default=0)+100
            board["nodes"].append({"id":nid,"type":"text","name":name,"x":x,"y":100,
                                  "data":{"text":text,"text_format":"markdown"},"versions":[],"cur":-1,"job":None})
            return {"nodes":[{"id":nid,"type":"text","name":name}],"text":"已保存资料和原始链接"}
        return service.commit(run,user,cid,change)

    if any(not commons_media(source.get("image")) for source in sources):
        raise ResearchError("请选择开放图片搜索结果，或改为保存来源文字")
    results, problems, variants = [], [], []
    for source in sources:
        if service.stopped(run):
            raise ResearchError("用户已停止本轮任务")
        try:
            media = await download_image(service.app["http"],service.host.COMFY_DIR,source)
        except ResearchError:
            problems.append(source["title"])
            continue
        service.host.grant_media(user,media["ref"])
        results.append({**media,"source":"web_reference","prompt":source["title"],
            "web_source":{"link":source["url"],**{key:source[key] for key in ("title","credit","license","license_url") if source.get(key)}}})
        variants.append({"name":source["title"][:40],"aspect":"auto"})
    if not results:
        raise ResearchError("未能导入所选图片，可以打开原始链接查看")
    if service.stopped(run):
        raise ResearchError("用户已停止本轮任务")
    result = service.add_results(run,user,cid,results,name,variants=variants)
    if problems:
        result["text"] = "以下图片未能导入 · " + "、".join(problems)
    return result
