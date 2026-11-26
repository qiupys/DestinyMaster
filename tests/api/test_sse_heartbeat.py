"""SSE 保活回归测试（v144）：长首包期间必须有注释帧，防止中间层 60s 读超时。

不验证具体 nginx 配置（在线上站点），只守住服务端生成器行为：
  1. 等待模型增量时按间隔发 `: ping`，该帧不是 data: 事件，前端会忽略；
  2. 正文增量顺序、免责声明、落盘、[DONE] 与保活前完全一致；
  3. 客户端取消时取消上游任务并正常关闭异步生成器，不留静默异常。
"""
import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "server"))

from features import common


class TestSSEHeartbeat(unittest.IsolatedAsyncioTestCase):
    async def test_ping_keeps_stream_alive_and_preserves_answer(self):
        async def slow_stream(_prompt):
            await asyncio.sleep(0.04)
            yield "第一段"
            await asyncio.sleep(0.04)
            yield "第二段"

        closed = False

        async def tracked_stream(prompt):
            nonlocal closed
            try:
                async for chunk in slow_stream(prompt):
                    yield chunk
            finally:
                closed = True

        saved = []
        original = common.SSE_PING_SECONDS
        common.SSE_PING_SECONDS = 0.01
        try:
            with mock.patch.object(common.ai, "stream_answer", tracked_stream):
                frames = [frame async for frame in common.answer_events(
                    "prompt", lambda text: saved.append(text) or 366)]
        finally:
            common.SSE_PING_SECONDS = original

        self.assertTrue(any(f == common._SSE_PING for f in frames), "长首包期间未发保活帧")
        self.assertTrue(all(f.startswith(":") or f.startswith("data:") for f in frames))
        data = [f for f in frames if f.startswith("data:")]
        self.assertIn('"delta": "第一段"', "".join(data))
        self.assertIn('"delta": "第二段"', "".join(data))
        import ai
        self.assertIn(ai.DISCLAIMER, "".join(data))
        self.assertIn('"hid": 366', "".join(data))
        self.assertEqual(data[-1], "data: [DONE]\n\n")
        self.assertEqual(len(saved), 1)
        self.assertTrue(closed, "SSE 结束后未关闭模型异步生成器")

    async def test_cancel_closes_upstream_without_error_event(self):
        started = asyncio.Event()

        async def never_stream(_prompt):
            started.set()
            try:
                while True:
                    await asyncio.sleep(1)
                    yield "never"
            finally:
                return

        original = common.SSE_PING_SECONDS
        common.SSE_PING_SECONDS = 0.01
        try:
            with mock.patch.object(common.ai, "stream_answer", never_stream):
                gen = common.answer_events("prompt", lambda text: 1)
                task = asyncio.ensure_future(gen.__anext__())
                await asyncio.wait_for(started.wait(), 1)
                frames = [await task]
                self.assertEqual(frames, [common._SSE_PING])
                task = asyncio.ensure_future(gen.__anext__())
                await asyncio.sleep(0)  # 让 __anext__ 进入生成器内部，再模拟客户端断连
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
                await gen.aclose()
        finally:
            common.SSE_PING_SECONDS = original


if __name__ == "__main__":
    unittest.main()
