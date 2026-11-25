"""Shared MiniMax endpoint, authorization, and response errors."""

from oneshot.providers.catalog import ProviderError


def mm_base(p: dict) -> str:
    c = p["config"]
    if c.get("base_url"):
        return c["base_url"].rstrip("/")
    return "https://api.minimax.io" if c.get("region") == "intl" else "https://api.minimax.cn"


def mm_headers(p: dict) -> dict:
    return {"Authorization": "Bearer " + p["secrets"].get("api_key", ""), "Content-Type": "application/json"}


def mm_check(j: dict, who="MiniMax"):
    br = j.get("base_resp") or {}
    code = br.get("status_code", 0)
    if code:
        msg = {1002: "请求太频繁", 1004: "API Key 不对", 1008: "账户余额不足", 1026: "内容触发了审核", 1039: "超出每分钟用量",
               2013: "参数不对", 2038: "账号没有这个权限", 2049: "API Key 无效"}.get(code, "")
        raise ProviderError(f"{who} 错误 {code}：{msg or br.get('status_msg')}")
