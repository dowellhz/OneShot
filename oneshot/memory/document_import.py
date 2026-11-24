"""Extract editable background material from uploaded documents."""
import asyncio
import io
import json
from pathlib import Path
import re
import sys
from urllib.parse import unquote
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile

MAX_UPLOAD = 8 * 1024 * 1024
MAX_TEXT = 60_000
TEXT_EXT = {".txt", ".md", ".markdown", ".csv", ".json"}
EXTENSIONS = TEXT_EXT | {".docx", ".pdf"}
WORD = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
PDF_SLOTS = asyncio.Semaphore(2)


class UploadTooLarge(ValueError):
    pass


async def read_upload(req):
    reader = await req.multipart()
    part = await reader.next()
    if not part or part.name != "file" or not part.filename:
        raise ValueError("请选择文档文件")
    raw = bytearray()
    while chunk := await part.read_chunk(262144):
        if len(raw) + len(chunk) > MAX_UPLOAD:
            raise UploadTooLarge("文档大小不能超过 8 MB")
        raw.extend(chunk)
    return await extract(unquote(part.filename),bytes(raw))


def decode_text(raw):
    encodings = ("utf-16",) if raw.startswith((b"\xff\xfe",b"\xfe\xff")) else ("utf-8-sig","gb18030")
    for encoding in encodings:
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            pass
    raise ValueError("无法识别文本编码，请另存为 UTF-8")


def docx_text(raw):
    try:
        with ZipFile(io.BytesIO(raw)) as archive:
            entry = archive.getinfo("word/document.xml")
            if entry.file_size > MAX_UPLOAD:
                raise ValueError("Word 正文超过可导入大小")
            xml = decode_text(archive.read(entry))
    except (BadZipFile, KeyError, RuntimeError) as exc:
        raise ValueError("无法读取此 DOCX 文件") from exc
    if re.search(r"<!\s*(DOCTYPE|ENTITY)\b",xml,re.I):
        raise ValueError("DOCX 正文包含不受支持的 XML 声明")
    try:
        root = ElementTree.fromstring(xml)
    except ElementTree.ParseError as exc:
        raise ValueError("无法读取此 DOCX 文件") from exc
    return "\n".join("".join(t.text or "" for t in p.iter(WORD+"t")) for p in root.iter(WORD+"p"))


def pdf_text(raw):
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(raw))
    if reader.is_encrypted:
        raise ValueError("请先解除 PDF 的密码保护")
    pages, parts, length = reader.pages, [], 0
    for page in pages[:100]:
        part = page.extract_text() or ""
        parts.append(part[:MAX_TEXT + 1 - length])
        length += len(parts[-1]) + 1
        if length > MAX_TEXT:
            break
    return "\n\n".join(parts), len(pages) > len(parts)


async def extract_pdf(raw):
    process = await asyncio.create_subprocess_exec(sys.executable, str(Path(__file__).resolve()),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    try:
        output, _ = await asyncio.wait_for(process.communicate(raw), timeout=12)
    except (TimeoutError, asyncio.CancelledError):
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        await process.wait()
        if asyncio.current_task().cancelling():
            raise
        raise ValueError("PDF 处理超时，请拆分后再试") from None
    if process.returncode:
        raise ValueError("无法提取 PDF 正文，请确认包含可复制的文字")
    result = json.loads(output)
    if result.get("error"):
        raise ValueError(result["error"])
    return result["text"], result["truncated"]


async def extract(name, raw):
    extension = Path(name).suffix.lower()
    truncated = False
    if extension == ".pdf":
        async with PDF_SLOTS:
            text, truncated = await extract_pdf(raw)
    elif extension == ".docx":
        text = await asyncio.to_thread(docx_text,raw)
    elif extension in TEXT_EXT:
        text = decode_text(raw)
    else:
        raise ValueError("支持 TXT、Markdown、CSV、JSON、DOCX 和 PDF")
    text = text.replace("\r\n","\n").replace("\r","\n").strip()
    if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f]",text) or not text:
        raise ValueError("文档没有可用的文字内容")
    return {"name":Path(name.replace("\\","/")).name[:240],"text":text[:MAX_TEXT],"truncated":truncated or len(text)>MAX_TEXT}


def passage(document, query="", limit=1500):
    text = document.get("text","") if document else ""
    if len(text) <= limit or not query:
        return text[:limit]
    lowered = text.casefold()
    query = query.casefold()
    tokens = set(re.findall(r"[a-z0-9_]{2,}",query) + re.findall(r"(?=([\u3400-\u9fff]{2}))",query))
    step = max(1,limit-150)
    def score(start):
        sample = lowered[start:start+limit]
        return sum(token in sample for token in tokens)
    best = max(range(0,len(text),step),key=score)
    return text[best:best+limit]


if __name__ == "__main__":
    import resource
    resource.setrlimit(resource.RLIMIT_CPU,(8,8))
    if sys.platform.startswith("linux"):
        resource.setrlimit(resource.RLIMIT_AS,(256*1024*1024,256*1024*1024))
    try:
        text, truncated = pdf_text(sys.stdin.buffer.read(MAX_UPLOAD+1))
        print(json.dumps({"text":text[:MAX_TEXT],"truncated":truncated or len(text)>MAX_TEXT},ensure_ascii=True))
    except ImportError:
        print(json.dumps({"error":"服务端未安装 PDF 解析组件"}))
    except ValueError as error:
        print(json.dumps({"error":str(error)[:240]}))
