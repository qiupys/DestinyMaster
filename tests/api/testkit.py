"""本地 API 测试底座：隔离数据库 + mock 计算引擎 + mock AI + SSE 解析。

所有测试都不调用真实模型、不依赖线上服务、不污染 server/ziwei.db。
运行：PYTHONPATH=server:. .venv-dev/bin/python -m unittest discover -s tests/api -p 'test_*.py'
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))
sys.path.insert(0, str(ROOT))

import ai  # noqa: E402
import feature_api  # noqa: E402
import main  # noqa: E402
import profile as profile_store  # noqa: E402
from features import common as feature_common  # noqa: E402
import tarot as tarot_engine  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

BIRTH = {
    "year": 1990, "month": 6, "day": 15, "hour": 10, "minute": 30,
    "gender": "男", "know_time": True, "calendar": "solar",
}


class RecordingAI:
    """把每次 model 调用替换成确定性短文本，并记录完整 prompt。"""

    def __init__(self):
        self.prompts: list[str] = []

    async def stream(self, prompt: str, timeout: float = 300.0):
        idx = len(self.prompts) + 1
        self.prompts.append(prompt)
        yield f"【mock解读{idx}】盘面结论稳定，建议复核关键假设。"


def parse_sse(text: str) -> list[dict]:
    """把 SSE 文本解析成事件字典，[DONE] 记作 {'done': True}。"""
    events = []
    for line in text.splitlines():
        if not line.startswith("data: "):
            continue
        raw = line[6:].strip()
        if raw == "[DONE]":
            events.append({"done": True})
        else:
            events.append(json.loads(raw))
    return events


def event_text(events: list[dict]) -> str:
    return "".join(e.get("delta", "") for e in events if isinstance(e, dict))


def event_hid(events: list[dict]) -> int | None:
    for e in events:
        if isinstance(e, dict) and e.get("hid"):
            return int(e["hid"])
    return None


class ApiTestCase(unittest.TestCase):
    """每个测试类共享一套隔离环境；用例之间用不同用户名隔离历史。"""

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls._old_db_path = profile_store.DB_PATH
        cls._old_conn = profile_store._conn
        if profile_store._conn:
            profile_store._conn.close()
        profile_store.DB_PATH = Path(cls._tmp.name) / "test.db"
        profile_store._conn = None

        cls.ai_mock = RecordingAI()
        cls.patchers = [
            patch.object(ai, "stream_answer", new=cls.ai_mock.stream),
            patch.object(feature_common, "_retrieve", return_value=["【mock文献】传统条目摘要"]),
            patch.object(tarot_engine, "retrieve_excerpts", return_value=["【mock牌义】牌名与正逆位"]),
        ]
        for p in cls.patchers:
            p.start()
        cls.client = TestClient(main.app)
        cls._user_seq = 0

    @classmethod
    def tearDownClass(cls):
        cls.client.close()
        for p in reversed(cls.patchers):
            p.stop()
        if profile_store._conn:
            profile_store._conn.close()
        profile_store.DB_PATH, profile_store._conn = cls._old_db_path, cls._old_conn
        cls._tmp.cleanup()

    def new_user(self) -> tuple[int, str]:
        type(self)._user_seq += 1  # 类级计数器：每个用例一个独立账号，避免跨方法重名
        prefix = "".join(c for c in self.__class__.__name__.lower() if c.isalnum())[:8]
        name = f"api_{prefix}_{self._user_seq}"
        res = profile_store.register(name, "Test12345", dict(BIRTH))
        self.assertTrue(res.get("ok"), res)
        return res["profile_id"], res["token"]

    def auth_params(self, pid: int, token: str) -> dict:
        return {"profile_id": pid, "token": token}

    def get_sse(self, url: str, params: dict) -> tuple[list[dict], object]:
        resp = self.client.get(url, params=params)
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertIn("text/event-stream", resp.headers.get("content-type", ""))
        return parse_sse(resp.text), resp
