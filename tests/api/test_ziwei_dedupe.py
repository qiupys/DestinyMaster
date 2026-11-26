"""紫微去重回归（v129）：接入统一工厂后，dedupe_key 与其他 10 功能完全同构。

- 同出生 + 同问题（含时点/宫位措辞）→ 复用历史解读；
- 问题/时点/出生任一变化都起新一轮；
- 存量旧格式记录迁移到统一 key 后可被命中；
- force=1 仍可强制重新生成。
"""
from __future__ import annotations

import json
from unittest.mock import patch

import ai
import chart as ziwei_chart
import history
import rag
from features import common as feature_common

from testkit import ApiTestCase, event_hid, event_text

BIRTH_PARAMS = {"year": 1990, "month": 6, "day": 15, "hour": 10,
                "gender": "男", "calendar": "solar"}


class TestZiweiDedupe(ApiTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.engine_patchers = [
            patch.object(ziwei_chart, "get_chart", return_value={"mock": "chart"}),
            patch.object(ziwei_chart, "horoscope_for",
                         side_effect=lambda *a, **k: {"mock": "horo", "year": a[1] if len(a) > 1 else None}),
            patch.object(rag, "retrieve", return_value=[]),
        ]
        for p in cls.engine_patchers:
            p.start()

        def fake_prepare(chart, question, target_horo=None, target_label="", focus_terms=None):
            # 稳定段固定；今日运限段按序号变化，验证统一 payload 不受其干扰。
            cls.prepare_seq = getattr(cls, "prepare_seq", 0) + 1
            digest = f"STABLE_BIRTH_CHART\n【当前运限（今日）】TODAY_{cls.prepare_seq}"
            target = f"【{target_label}】\nMOCK_HORO" if target_label else ""
            return {
                "digest": digest, "target": target,
                "kb_block": "【mock文献】", "rag_query": "ziwei mock", "rag_extra": [],
            }
        cls.prepare_patcher = patch.object(ai, "prepare_ziwei", new=fake_prepare)
        cls.prepare_patcher.start()

    @classmethod
    def tearDownClass(cls):
        cls.prepare_patcher.stop()
        for p in reversed(cls.engine_patchers):
            p.stop()
        super().tearDownClass()

    def _ask(self, pid, token, question, birth=None, force=0):
        params = {**(birth or BIRTH_PARAMS), "q": question, **self.auth_params(pid, token)}
        if force:
            params["force"] = force
        return self.get_sse("/api/ziwei/deduce", params)[0]

    def test_same_question_reuses_history(self):
        pid, token = self.new_user()
        question = "以「命宫」为主体，我的优势是什么？"
        first = self._ask(pid, token, question)
        self.assertFalse(any(e.get("cached") for e in first))
        first_hid = event_hid(first)
        calls = len(self.ai_mock.prompts)

        second = self._ask(pid, token, question)
        self.assertTrue(any(e.get("cached") for e in second), second)
        self.assertEqual(len(self.ai_mock.prompts), calls, "命中历史不应再调用模型")
        self.assertEqual(event_text(second), event_text(first))
        self.assertEqual(event_hid(second), first_hid, "回放应带回原 hid，追问写回同一条历史")

    def test_question_and_time_and_birth_changes_start_new_round(self):
        pid, token = self.new_user()
        base = "以「官禄宫」为主体，事业如何？"
        self._ask(pid, token, base)
        variants = [
            ("以「官禄宫」为主体，明年要不要跳槽？", None),
            ("只看2033年以「官禄宫」为主体，事业如何？", None),
            (base, {**BIRTH_PARAMS, "hour": 14}),   # 换时辰 = 换盘
        ]
        for idx, (question, birth) in enumerate(variants):
            events = self._ask(pid, token, question, birth=birth)
            self.assertFalse(any(e.get("cached") for e in events),
                             f"问题/时点/出生变化必须起新一轮 #{idx}")

    def test_legacy_record_migrates_to_unified_key(self):
        pid, token = self.new_user()
        question = "以「命宫」为主体，我的优势与需要警惕之处分别是什么？"
        legacy_payload = {
            "ziwei_data": {"digest": "STABLE_BIRTH_CHART\n【当前运限（今日）】OLD_DAY",
                           "target": "", "kb_block": "", "rag_query": "ziwei mock", "rag_extra": []},
            "chart_id": "old_random_id", "year": None, "month": None,
            "focus": ["命宫", "三方四正", "四化"], "rag_query": "ziwei mock", "rag_extra": [],
        }
        hid = history.save(pid, "ziwei", question, "【历史解读】旧答案", legacy_payload, None)
        calls = len(self.ai_mock.prompts)

        events = self._ask(pid, token, question)
        self.assertTrue(any(e.get("cached") for e in events), events)
        self.assertIn("【历史解读】旧答案", event_text(events))
        self.assertEqual(event_hid(events), hid)
        self.assertEqual(len(self.ai_mock.prompts), calls, "命中迁移的历史不应调用模型")

        row = history.profile_store.db().execute(
            "SELECT payload, dedupe_key FROM feature_history WHERE id=?", (hid,)).fetchone()
        new_payload = json.loads(row["payload"])
        self.assertNotIn("chart_id", new_payload)
        self.assertNotIn("【当前运限（今日）】", new_payload["ziwei_data"]["digest"])
        expected = feature_common.dedupe_key(pid, "ziwei", new_payload, question)
        self.assertEqual(row["dedupe_key"], expected, "存量记录必须用统一 dedupe_key")

    def test_force_regenerates(self):
        pid, token = self.new_user()
        question = "以「福德宫」为主体，精神状态如何？"
        self._ask(pid, token, question)
        calls = len(self.ai_mock.prompts)
        events = self._ask(pid, token, question, force=1)
        self.assertFalse(any(e.get("cached") for e in events), events)
        self.assertEqual(len(self.ai_mock.prompts), calls + 1)
