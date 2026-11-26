"""横向能力：鉴权、去重键、RAG 检索、免责声明、SSE 回复。

这一层不关心具体功能，也不注册路由；新增功能时只复用这些函数即可。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re

from fastapi.responses import StreamingResponse

import ai
import profile as profile_store
import rag_kb

FEATURES = ("bazi", "meihua", "tarot", "huangli", "astrology",
            "bazi_marriage", "ziwei_marriage", "astrology_marriage",
            "liuyao", "qimen", "huangli_pair")
# 组合功能共用单人领域的确定性语料：八字合婚→bazi，紫微合婚→ziwei，占星合盘→astrology，双人择日→huangli。
_MARRIAGE_KB = {"bazi_marriage": "bazi", "ziwei_marriage": "ziwei",
                "astrology_marriage": "astrology", "huangli_pair": "huangli"}


def auth(pid: int | None, token: str | None) -> int | None:
    if pid and token and profile_store.auth(pid, token):
        return pid
    return None


def retrieve(feature: str, query: str, extra, payload: dict | None = None) -> list[str]:
    """通用功能 RAG 检索。梅花语料含爻辞+各家解卦，需更大额度并让本卦优先。"""
    feature = _MARRIAGE_KB.get(feature, feature)
    if feature == "meihua":
        return rag_kb.retrieve(feature, query, extra, top_k=10, max_chars=3600,
                               primary=(payload or {}).get("rag_primary_idx"))
    if feature == "astrology":
        return rag_kb.retrieve(feature, query, extra, top_k=8, max_chars=2800)
    if feature in ("liuyao", "qimen", "bazi", "ziwei"):
        return rag_kb.retrieve(feature, query, extra, top_k=8, max_chars=2600)
    return rag_kb.retrieve(feature, query, extra, top_k=5, max_chars=1400)


# 兼容旧调用名（facade 与历史脚本都可能直接引用）
_auth = auth
_retrieve = retrieve


def dedupe_key(pid: int | None, feature: str, payload: dict, question: str) -> str:
    raw = json.dumps({"f": feature, "p": payload, "q": question},
                     ensure_ascii=False, sort_keys=True)
    return hashlib.md5(raw.encode()).hexdigest()[:16] + (f":{pid}" if pid else "")


_dedupe_key = dedupe_key


def with_disclaimer(answer: str) -> str:
    """正文后统一附加免责声明（系统负责，模型不再自行撰写）。

    模型偶发会在正文结尾自行写一句免责套话（如「解读仅供参考，重在启发与自省」），
    这里先剥离这类结尾套话，再统一附加官方声明，确保一次解读只出现一条声明。
    """
    text = (answer or "").rstrip()
    # 只匹配独立的短句/短段，避免误伤正文结论。
    self_written = (
        r"(?:\n+\s*---\s*\n+)?[^。\n]{0,40}(?:解读仅供参考|以上内容仅供参考|本解读仅供参考|仅供参考，重在启发)[^。\n]{0,40}[。]?\s*",
    )
    for pat in self_written:
        text = re.sub(pat, "", text)
    text = re.sub(r"\n{3,}", "\n\n", text).rstrip()
    if ai.DISCLAIMER in text:
        return text
    return text + "\n\n---\n\n" + ai.DISCLAIMER if text else ai.DISCLAIMER


_with_disclaimer = with_disclaimer


def sse_event(data: dict) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


def sse_replay(answer: str, hid: int | None = None) -> StreamingResponse:
    answer = with_disclaimer(answer)

    async def replay():
        yield sse_event({"cached": True})
        yield sse_event({"delta": answer})
        if hid:
            yield sse_event({"hid": hid})
        yield "data: [DONE]\n\n"

    return StreamingResponse(replay(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache"})


_sse_replay = sse_replay

# SSE 保活间隔：模型冷启动/上游拥塞时首包可能等数十秒。nginx 对普通 /api/ 的
# proxy_read_timeout 默认 60s，流中只要有一段时间没有字节就会掐断连接，前端
# 只看到 "network error"。每 15s 发一个 SSE 注释帧即可让中间层保持连接，
# 注释帧不是 data: 事件，前端解析器会忽略，不影响正文/落盘/免责链路。
SSE_PING_SECONDS = 15.0
_SSE_PING = ": ping\n\n"


def answer_events(prompt: str, persist, *, save_on_cancel: bool = True):
    """统一 AI 流式回复 + 免责 + 落盘链路。

    persist(text) -> int | None：由调用方决定落顶层问题还是追问子记录；
    返回的历史 id 会以 SSE 事件回传给前端，用于挂追问条。
    """
    async def gen():
        full = ""
        disc_sent = False
        stream = ai.stream_answer(prompt)
        pending = asyncio.ensure_future(stream.__anext__())
        try:
            while True:
                done, _ = await asyncio.wait({pending}, timeout=SSE_PING_SECONDS)
                if not done:
                    yield _SSE_PING
                    continue
                try:
                    delta = pending.result()
                except StopAsyncIteration:
                    break
                pending = asyncio.ensure_future(stream.__anext__())
                if not delta:
                    continue
                full += delta
                yield sse_event({"delta": delta})
            if full.strip():
                tail = with_disclaimer(full)
                if tail != full.rstrip():
                    disc = tail[len(full.rstrip()):]
                    full = tail
                    yield sse_event({"delta": disc})
                disc_sent = True
            hid = persist(full.strip()) if full.strip() else None
            if hid:
                yield sse_event({"hid": hid})
            yield "data: [DONE]\n\n"
        except asyncio.CancelledError:
            if not pending.done():
                pending.cancel()
                try:
                    await pending
                except (StopAsyncIteration, asyncio.CancelledError):
                    from applog import log
                    log.info("SSE 取消：上游模型流已停止")
                except Exception as exc:
                    # 取消时上游异常也要留痕，不再静默吞掉
                    from applog import log
                    log.warning("SSE 取消时模型上游异常：%s", type(exc).__name__)
            if save_on_cancel and full.strip():
                if not disc_sent:
                    full = with_disclaimer(full)
                hid = persist(full.strip())
                if hid:
                    yield sse_event({"hid": hid})
            raise
        finally:
            aclose = getattr(stream, "aclose", None)
            if aclose:
                try:
                    await aclose()
                except Exception as exc:
                    from applog import log
                    log.warning("SSE 流关闭异常：%s", type(exc).__name__)

    return gen()
