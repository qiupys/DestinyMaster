"""紫微专属回归：显式流年必须进入 prompt 与追问上下文；命盘身份不可借用。"""
from __future__ import annotations

import json
from unittest.mock import patch

import ai
import main
import rag

from testkit import ApiTestCase, event_hid, event_text


class TestZiweiYear(ApiTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.captured_labels: list[str] = []
        cls.engine_patchers = [
            patch.object(main, "get_chart", return_value={"mock": "chart"}),
            patch.object(main, "horoscope_for",
                         side_effect=lambda *a, **k: {"mock": "horoscope", "year": a[1] if len(a) > 1 else None}),
            patch.object(feature_api_prepare_target(), "retrieve", return_value=[]),
        ]
        for p in cls.engine_patchers[:-1]:
            p.start()
        cls.engine_patchers[-1].start()  # rag.retrieve（供紫微追问使用）

        def fake_prepare(chart, question, target_horo=None, target_label="", focus_terms=None):
            cls.captured_labels.append(target_label or "")
            target = f"【{target_label}】\nMOCK_HOROSCOPE" if target_label else ""
            return {
                "digest": "MOCK_ZIWEI_CHART", "target": target,
                "kb_block": "【mock文献】星曜释义", "rag_query": "ziwei mock", "rag_extra": [],
            }
        cls.prepare_patcher = patch.object(ai, "prepare_ziwei", new=fake_prepare)
        cls.prepare_patcher.start()

    @classmethod
    def tearDownClass(cls):
        cls.prepare_patcher.stop()
        for p in reversed(cls.engine_patchers):
            p.stop()
        super().tearDownClass()

    def _chart_id(self, pid: int, token: str) -> str:
        resp = self.client.get("/api/chart", params={
            "date": "1990-6-15", "timeIndex": 10, "gender": "男",
            **self.auth_params(pid, token),
        })
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertTrue(body.get("ok"), body)
        return body["id"]

    def test_explicit_year_drives_prompt_and_followup(self):
        pid, token = self.new_user()
        chart_id = self._chart_id(pid, token)
        events, _ = self.get_sse("/api/deduce", {
            "id": chart_id, "q": "只看这个流年事业如何？", "year": 2033,
            **self.auth_params(pid, token),
        })
        hid = event_hid(events)
        self.assertIsNotNone(hid)
        self.assertTrue(event_text(events).startswith("【mock解读"))
        self.assertIn("2033", self.captured_labels[-1])
        first_prompt = self.ai_mock.prompts[-1]
        self.assertIn("2033", first_prompt)
        self.assertIn("推演目标优先级（最高）", first_prompt)
        self.assertIn("MOCK_HOROSCOPE", first_prompt)

        # 追问沿用落盘的 ziwei_data，即使清掉内存命盘也不丢失目标年份
        main.CHARTS.pop(chart_id, None)
        self.get_sse("/api/history/followup", {
            **self.auth_params(pid, token), "id": hid, "q": "刚才说的是哪一年？"})
        follow_prompt = self.ai_mock.prompts[-1]
        self.assertIn("2033", follow_prompt)
        self.assertIn("推演目标优先级（最高）", follow_prompt)
        self.assertIn("MOCK_HOROSCOPE", follow_prompt)

        detail = self.client.get("/api/history/detail", params={
            **self.auth_params(pid, token), "id": hid}).json()["item"]
        self.assertEqual(detail["payload"]["year"], 2033)
        self.assertIn("2033", json.dumps(detail["payload"]["ziwei_data"], ensure_ascii=False))

    def test_year_parsed_from_question(self):
        pid, token = self.new_user()
        chart_id = self._chart_id(pid, token)
        self.get_sse("/api/deduce", {
            "id": chart_id, "q": "只看2027年3月财运如何？",
            **self.auth_params(pid, token),
        })
        self.assertIn("2027", self.captured_labels[-1])

    def test_chart_identity_cannot_be_borrowed(self):
        owner_pid, owner_token = self.new_user()
        chart_id = self._chart_id(owner_pid, owner_token)
        other_pid, other_token = self.new_user()
        resp = self.client.get("/api/deduce", params={
            "id": chart_id, "q": "借用别人的盘", **self.auth_params(other_pid, other_token),
        })
        self.assertFalse(resp.json().get("ok"))
        self.assertIn("其他账号", resp.json().get("error", ""))


def feature_api_prepare_target():
    """延迟解析 rag 模块，避免在 import 阶段绑死被测对象。"""
    return rag
