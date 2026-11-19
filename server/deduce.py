"""调用 codebuddy CLI（服务器端非交互模式）进行紫微推演，流式产出文本增量。"""
from __future__ import annotations

import asyncio
import json
import os
import socket

# 推演模型：默认 glm-5.3-flash（响应快、流式体验好），可用环境变量 ZIWEI_MODEL 覆盖，
# 可选值参考 `codebuddy --help` 中 --model 列表（如 glm-5.3 更深度、kimi-k3-1 等）。
MODEL = os.environ.get("ZIWEI_MODEL", "glm-5.3-flash")
# 推理力度：minimal/low/medium/high/xhigh/max。low 起盘快（首包显著提前），
# 推演质量由强规则 prompt + RAG 摘录兜底；需要更深度可设 ZIWEI_EFFORT=medium/high。
EFFORT = os.environ.get("ZIWEI_EFFORT", "low")


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


async def stream_deduce(prompt: str, timeout: float = 300.0):
    """spawn codebuddy -p，解析 stream-json，yield 文本增量。"""
    port = _free_port()
    env = dict(os.environ)
    proc = await asyncio.create_subprocess_exec(
        "codebuddy",
        "-p", prompt,
        "--model", MODEL,
        "--effort", EFFORT,
        "--tools", "",
        "--port", str(port),
        "--output-format", "stream-json",
        "--include-partial-messages",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        env=env,
    )
    try:
        while True:
            try:
                raw = await asyncio.wait_for(proc.stdout.readline(), timeout=timeout)
            except asyncio.TimeoutError:
                yield "\n\n[推演超时，已中断]"
                break
            if not raw:
                break
            line = raw.decode("utf-8", "ignore").strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            t = obj.get("type")
            if t == "stream_event":
                ev = obj.get("event") or {}
                if ev.get("type") == "content_block_delta":
                    delta = ev.get("delta") or {}
                    if delta.get("type") == "text_delta" and delta.get("text"):
                        yield delta["text"]
            elif t == "result":
                if obj.get("subtype") != "success":
                    errs = "；".join(obj.get("errors") or []) or "未知错误"
                    yield f"\n\n> ⚠️ 推演失败：{errs}"
                break
    finally:
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        await proc.wait()
