"""紫微去重回归（v128）：同盘 + 同运限 + 同宫位 + 同问题必须复用历史解读。

历史 bug：前端从不传 key，后端缓存条件 `if key` 永远为假，紫微每次都重新生成；
且旧记录 dedupe_key 全为 NULL，补传 key 也匹配不到。本测试同时覆盖：
- 稳定指纹排除随机 chart_id 与每日变化的「今日运限」；
- 问题/流年/宫位任一变化都起新一轮；
- 存量 NULL 记录自动回填后可被命中；
- force=1 仍可强制重新生成。
"""
from __future__ import annotations

from unittest.mock import patch

import ai
import history
import main

from testkit import ApiTestCase, event_hid, event_text


class TestZiweiDedupe(ApiTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.prepare_seq = 0
        cls.engine_patchers = [
            patch.object(main, "get_chart", return_value={"mock": "chart"}),
            patch.object(main, "horoscope_for",
                         side_effect=lambda *a, **k: {"mock": "horo", "year": a[1] if len(a) > 1 else None}),
        ]
        for p in cls.engine_patchers:
            p.start()

        def fake_prepare(chart, question, target_horo=None, target_label="", focus_terms=None):
            cls.prepare_seq += 1
            # 稳定段固定；今日运限段按调用序号变化，用来验证指纹不受其干扰。
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

    def _chart_id(self, pid: int, token: str) -> str:
        resp = self.client.get("/api/chart", params={
            "date": "1990-6-15", "timeIndex": 10, "gender": "男",
            **self.auth_params(pid, token),
        })
        self.assertTrue(resp.json().get("ok"), resp.text)
        return resp.json()["id"]

    def _ask(self, pid, token, chart_id, question, focus="", year=None, force=0):
        params = {"id": chart_id, "q": question,
                  **self.auth_params(pid, token)}
        if focus:
            params["focus"] = focus
        if year:
            params["year"] = year
        if force:
            params["force"] = force
        return self.get_sse("/api/deduce", params)[0]

    def test_same_question_reuses_history(self):
        pid, token = self.new_user()
        chart_id = self._chart_id(pid, token)
        params = dict(question="以「命宫」为主体，我的优势是什么？",
                      focus="命宫,三方四正,四化", year=2027)
        first = self._ask(pid, token, chart_id, **params)
        self.assertFalse(any(e.get("cached") for e in first))
        first_hid = event_hid(first)
        calls = len(self.ai_mock.prompts)

        second = self._ask(pid, token, chart_id, **params)
        self.assertTrue(any(e.get("cached") for e in second), second)
        self.assertEqual(len(self.ai_mock.prompts), calls, "命中历史不应再调用模型")
        self.assertEqual(event_text(second), event_text(first))
        self.assertEqual(event_hid(second), first_hid, "回放应带回原 hid，追问写回同一条历史")

    def test_new_chart_id_same_birth_still_reuses(self):
        pid, token = self.new_user()
        first_id = self._chart_id(pid, token)
        self._ask(pid, token, first_id, "财帛宫财运如何？", focus="财帛宫,三方四正,四化")
        calls = len(self.ai_mock.prompts)

        # 重新排盘会生成随机 chart_id；出生盘面相同仍应命中同一解读。
        second_id = self._chart_id(pid, token)
        self.assertNotEqual(second_id, first_id)
        events = self._ask(pid, token, second_id, "财帛宫财运如何？",
                           focus="财帛宫,三方四正,四化")
        self.assertTrue(any(e.get("cached") for e in events), events)
        self.assertEqual(len(self.ai_mock.prompts), calls)

    def test_question_year_focus_changes_start_new_round(self):
        pid, token = self.new_user()
        chart_id = self._chart_id(pid, token)
        base = dict(question="官禄宫事业如何？", focus="官禄宫,三方四正,四化", year=2027)
        self._ask(pid, token, chart_id, **base)

        variants = [
            dict(base, question="官禄宫明年要不要跳槽？"),
            dict(base, year=2028),
            dict(base, focus="财帛宫,三方四正,四化"),
        ]
        for idx, variant in enumerate(variants):
            events = self._ask(pid, token, chart_id, **variant)
            self.assertFalse(any(e.get("cached") for e in events),
                             f"问题/流年/宫位变化必须起新一轮 #{idx}")

    def test_legacy_null_key_record_is_backfilled_and_reused(self):
        pid, token = self.new_user()
        chart_id = self._chart_id(pid, token)
        question = "以「命宫」为主体，结合三方四正与四化，我的优势与需要警惕之处分别是什么？"
        focus = "命宫,三方四正,四化"
        # 模拟升级前落盘的记录：dedupe_key 为 NULL。
        legacy_payload = {
            "ziwei_data": {"digest": "STABLE_BIRTH_CHART\n【当前运限（今日）】OLD_DAY",
                           "target": "", "kb_block": "", "rag_query": "", "rag_extra": []},
            "chart_id": "old_random_id", "year": None, "month": None,
            "focus": ["命宫", "三方四正", "四化"], "rag_query": "", "rag_extra": [],
        }
        hid = history.save(pid, "ziwei", question, "【历史解读】旧答案",
                           legacy_payload, None)
        calls = len(self.ai_mock.prompts)

        # 首次请求触发该用户回填；同题必须命中旧记录而不是重新生成。
        events = self._ask(pid, token, chart_id, question, focus=focus)
        self.assertTrue(any(e.get("cached") for e in events), events)
        self.assertIn("【历史解读】旧答案", event_text(events))
        self.assertEqual(event_hid(events), hid)
        self.assertEqual(len(self.ai_mock.prompts), calls, "命中回填的历史不应调用模型")

        row = history.profile_store.db().execute(
            "SELECT dedupe_key FROM feature_history WHERE id=?", (hid,)).fetchone()
        self.assertEqual(row["dedupe_key"], history.ziwei_fingerprint(legacy_payload, question))

    def test_force_regenerates(self):
        pid, token = self.new_user()
        chart_id = self._chart_id(pid, token)
        self._ask(pid, token, chart_id, "福德宫精神状态如何？", focus="福德宫,三方四正,四化")
        calls = len(self.ai_mock.prompts)
        events = self._ask(pid, token, chart_id, "福德宫精神状态如何？",
                           focus="福德宫,三方四正,四化", force=1)
        self.assertFalse(any(e.get("cached") for e in events), events)
        self.assertEqual(len(self.ai_mock.prompts), calls + 1)
