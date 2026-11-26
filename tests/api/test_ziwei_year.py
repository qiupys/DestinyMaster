"""紫微回归：接入统一工厂后，目标流年仍进入 prompt 与追问上下文。"""
from __future__ import annotations

import json
from unittest.mock import patch

import ai
import chart as ziwei_chart
import rag

from testkit import ApiTestCase, event_hid, event_text

BIRTH_PARAMS = {"year": 1990, "month": 6, "day": 15, "hour": 10,
                "gender": "男", "calendar": "solar"}


class TestZiweiYear(ApiTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.captured_labels: list[str] = []
        cls.engine_patchers = [
            patch.object(ziwei_chart, "get_chart", return_value={"mock": "chart"}),
            patch.object(ziwei_chart, "horoscope_for",
                         side_effect=lambda *a, **k: {"mock": "horoscope", "year": a[1] if len(a) > 1 else None}),
            patch.object(rag, "retrieve", return_value=[]),
        ]
        for p in cls.engine_patchers:
            p.start()

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

    def _ask(self, pid, token, question):
        return self.get_sse("/api/ziwei/deduce", {
            **BIRTH_PARAMS, "q": question, **self.auth_params(pid, token),
        })[0]

    def test_year_in_question_drives_prompt_and_followup(self):
        pid, token = self.new_user()
        # 与其他功能一样：目标流年写在问题文本里，不传专属参数。
        events = self._ask(pid, token, "只看2033年流年事业如何？")
        hid = event_hid(events)
        self.assertIsNotNone(hid)
        self.assertTrue(event_text(events).startswith("【mock解读"))
        self.assertIn("2033", self.captured_labels[-1])
        first_prompt = self.ai_mock.prompts[-1]
        self.assertIn("2033", first_prompt)
        self.assertIn("推演目标优先级（最高）", first_prompt)
        self.assertIn("MOCK_HOROSCOPE", first_prompt)

        # 追问沿用落盘的 ziwei_data，即使清掉内存命盘也不丢失目标年份
        self.get_sse("/api/history/followup", {
            **self.auth_params(pid, token), "id": hid, "q": "刚才说的是哪一年？"})
        follow_prompt = self.ai_mock.prompts[-1]
        self.assertIn("2033", follow_prompt)
        self.assertIn("推演目标优先级（最高）", follow_prompt)
        self.assertIn("MOCK_HOROSCOPE", follow_prompt)

        detail = self.client.get("/api/history/detail", params={
            **self.auth_params(pid, token), "id": hid}).json()["item"]
        self.assertEqual(detail["payload"]["target_year"], 2033)
        self.assertIn("2033", json.dumps(detail["payload"]["ziwei_data"], ensure_ascii=False))

    def test_explicit_target_year_in_question(self):
        pid, token = self.new_user()
        self._ask(pid, token, "只看2027年3月财运如何？")
        self.assertIn("2027", self.captured_labels[-1])
