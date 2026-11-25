"""十一功能 API 回归：计算 → 解读 → 追问 → 去重 → 身份变化 → 鉴权。

AI 与计算引擎全部 mock，只验证链路契约，不受模型耗时/随机性影响。
"""
from __future__ import annotations

import json
from unittest.mock import patch

import astrology as astrology_engine
import bazi as bazi_engine
import feature_api  # noqa: F401  确保路由已注册
import huangli as huangli_engine
import liuyao as liuyao_engine
import marriage as marriage_engine
import meihua as meihua_engine
import profile as profile_store
import qimen as qimen_engine
import tarot as tarot_engine

from testkit import ApiTestCase, event_hid, event_text

FEATURE_PARAMS = {
    "bazi": {"year": 1990, "month": 6, "day": 15, "hour": 10, "minute": 30, "gender": "男"},
    "meihua": {"method": "number", "num1": 3, "num2": 5, "when": "2027-03-04T10:00:00"},
    "tarot": {"spread": "three"},
    "huangli": {"year": 2027, "month": 3, "day": 8},
    "astrology": {"year": 1990, "month": 6, "day": 15, "hour": 10, "minute": 30,
                  "lat": 31.23, "lon": 121.47, "tz": 8, "place": "上海"},
    "bazi_marriage": {"year": 1990, "month": 6, "day": 15, "hour": 10, "gender": "男",
                      "p2_year": 1992, "p2_month": 8, "p2_day": 20, "p2_hour": 14,
                      "p2_gender": "女"},
    "ziwei_marriage": {"year": 1990, "month": 6, "day": 15, "hour": 10, "gender": "男",
                       "p2_year": 1992, "p2_month": 8, "p2_day": 20, "p2_hour": 14,
                       "p2_gender": "女"},
    "astrology_marriage": {"year": 1990, "month": 6, "day": 15, "hour": 10,
                           "lat": 31.23, "lon": 121.47, "tz": 8, "place": "上海",
                           "p2_year": 1992, "p2_month": 8, "p2_day": 20, "p2_hour": 14,
                           "p2_lat": 39.90, "p2_lon": 116.40, "p2_tz": 8, "p2_place": "北京"},
    "liuyao": {"method": "coin", "coins": "7,8,9,6,7,8", "when": "2027-03-04T10:00:00"},
    "qimen": {"method": "chaibu", "when": "2027-03-04T10:00:00"},
    "huangli_pair": {"year": 2027, "month": 3, "day": 8, "name": "甲方",
                     "p2_year": 1992, "p2_month": 8, "p2_day": 20, "p2_name": "乙方"},
}


def _fact(feature: str, **extra) -> dict:
    return {
        "fact": f"FAKE_FACT::{feature}::{json.dumps(extra, ensure_ascii=False, sort_keys=True)}",
        "rag_query": f"{feature} mock", "rag_extra": [], **extra,
    }


def _bazi_chart(*args, **kwargs):
    out = _fact("bazi")
    out.update({"pillars": {"year": "庚午", "month": "癸未", "day": "甲子", "hour": "辛巳"},
                "day_master": "甲"})
    return out


def _cards_from_deck(deck: str, spread: str = "three") -> dict:
    slugs = [x.strip() for x in (deck or "").split("|") if x.strip()]
    if not slugs:
        return {}
    return {
        "fact": f"FAKE_FACT::tarot::{','.join(slugs)}",
        "cards": [{"slug": s, "name": s, "reversed": False} for s in slugs],
        "spread": spread, "rag_query": "tarot mock", "rag_extra": [],
    }


class TestAllFeatures(ApiTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.engine_patchers = [
            patch.object(bazi_engine, "chart", new=_bazi_chart),
            patch.object(meihua_engine, "derive",
                         side_effect=lambda *a, **k: _fact("meihua", when=str(k.get("when")))),
            patch.object(huangli_engine, "query",
                         side_effect=lambda *a, **k: _fact("huangli", date=a[:3])),
            patch.object(tarot_engine, "draw",
                         side_effect=lambda *a, **k: _fact("tarot", spread=a[0] if a else k.get("spread"))),
            patch.object(tarot_engine, "cards_from_deck", new=_cards_from_deck),
            patch.object(astrology_engine, "derive",
                         side_effect=lambda *a, **k: _fact("astrology", birth=a[:5])),
            patch.object(marriage_engine, "bazi_marriage",
                         side_effect=lambda *a, **k: _fact("bazi_marriage", pair=a)),
            patch.object(marriage_engine, "ziwei_marriage",
                         side_effect=lambda *a, **k: _fact("ziwei_marriage", pair=a)),
            patch.object(marriage_engine, "astrology_marriage",
                         side_effect=lambda *a, **k: _fact("astrology_marriage", pair=a)),
            patch.object(liuyao_engine, "derive",
                         side_effect=lambda *a, **k: _fact("liuyao", yaos=k.get("yaos"))),
            patch.object(qimen_engine, "derive",
                         side_effect=lambda *a, **k: _fact("qimen", when=str(k.get("when")))),
        ]
        for p in cls.engine_patchers:
            p.start()

    @classmethod
    def tearDownClass(cls):
        for p in reversed(cls.engine_patchers):
            p.stop()
        super().tearDownClass()

    def test_calc_and_deduce_and_followup_for_all_features(self):
        pid, token = self.new_user()
        auth = self.auth_params(pid, token)
        for feature, params in FEATURE_PARAMS.items():
            with self.subTest(feature=feature):
                # huangli_pair 与 huangli 共用同一计算函数，mock 事实标记也共用
                marker = "FAKE_FACT::huangli" if feature == "huangli_pair" else f"FAKE_FACT::{feature}"
                # calc 不调模型，返回可核对的确定性盘面
                calc = self.client.get(f"/api/{feature}/calc", params=params)
                self.assertEqual(calc.status_code, 200, calc.text)
                calc_body = calc.json()
                self.assertTrue(calc_body.get("ok"), calc_body)
                self.assertIn(marker, calc_body.get("fact", ""))

                first_q = f"{feature} 首轮问题？"
                before = len(self.ai_mock.prompts)
                events, _ = self.get_sse(f"/api/{feature}/deduce",
                                         {**params, **auth, "q": first_q})
                hid = event_hid(events)
                self.assertIsNotNone(hid, events)
                self.assertTrue(event_text(events).startswith("【mock解读"))
                self.assertEqual(len(self.ai_mock.prompts), before + 1)
                first_prompt = self.ai_mock.prompts[-1]
                self.assertIn(first_q, first_prompt)
                self.assertIn(marker, first_prompt)

                # 追问复用首轮盘面事实 + 首轮问答上下文，且仍挂在同一条顶层记录
                follow_q = f"{feature} 追问：为什么？"
                self.get_sse("/api/history/followup",
                             {**auth, "id": hid, "q": follow_q})
                self.assertEqual(len(self.ai_mock.prompts), before + 2)
                follow_prompt = self.ai_mock.prompts[-1]
                self.assertIn("此前对话与提问", follow_prompt)
                self.assertIn(first_q, follow_prompt)
                self.assertIn("【mock解读", follow_prompt)
                self.assertIn(marker, follow_prompt)

                detail = self.client.get("/api/history/detail", params={**auth, "id": hid}).json()
                self.assertTrue(detail.get("ok"), detail)
                item = detail["item"]
                self.assertEqual(item["feature"], feature)
                self.assertIn("FAKE_FACT", json.dumps(item.get("payload") or {}, ensure_ascii=False))
                self.assertEqual(len(item.get("followups") or []), 1)
                self.assertEqual(item["followups"][0]["question"], follow_q)

    def test_dedupe_replay_and_force_new_round(self):
        pid, token = self.new_user()
        auth = self.auth_params(pid, token)
        params = {**FEATURE_PARAMS["qimen"], **auth, "q": "局不变只问同一问题？"}
        before = len(self.ai_mock.prompts)
        events, _ = self.get_sse("/api/qimen/deduce", params)
        first_hid = event_hid(events)
        self.assertIsNotNone(first_hid)
        self.assertEqual(len(self.ai_mock.prompts), before + 1)

        replay, _ = self.get_sse("/api/qimen/deduce", params)
        self.assertTrue(any(e.get("cached") for e in replay), replay)
        self.assertEqual(event_hid(replay), first_hid)
        self.assertEqual(len(self.ai_mock.prompts), before + 1)

        forced, _ = self.get_sse("/api/qimen/deduce", {**params, "force": 1})
        second_hid = event_hid(forced)
        self.assertNotEqual(second_hid, first_hid)
        self.assertEqual(len(self.ai_mock.prompts), before + 2)
        rows = self.client.get("/api/history/list", params={**auth, "feature": "qimen"}).json()["items"]
        self.assertEqual(len(rows), 2)

    def test_payload_identity_changes_create_new_rounds(self):
        pid, token = self.new_user()
        auth = self.auth_params(pid, token)
        q = "同一问题换盘面身份？"
        base = {**auth, "q": q}

        e1, _ = self.get_sse("/api/qimen/deduce",
                             {**base, **FEATURE_PARAMS["qimen"], "when": "2027-03-04T10:00:00"})
        e2, _ = self.get_sse("/api/qimen/deduce",
                             {**base, **FEATURE_PARAMS["qimen"], "when": "2027-03-05T10:00:00"})
        self.assertNotEqual(event_hid(e1), event_hid(e2))

        d1 = {**base, "spread": "three", "deck": "fool|magician|high-priestess"}
        d2 = {**base, "spread": "three", "deck": "lovers|hermit|wheel"}
        t1, _ = self.get_sse("/api/tarot/deduce", d1)
        t2, _ = self.get_sse("/api/tarot/deduce", d2)
        self.assertNotEqual(event_hid(t1), event_hid(t2))

        before = len(self.ai_mock.prompts)
        b1, _ = self.get_sse("/api/qimen/deduce",
                             {**base, **FEATURE_PARAMS["qimen"], "use_bazi": 1})
        self.assertEqual(len(self.ai_mock.prompts), before + 1)
        self.assertIn("命主本人八字", self.ai_mock.prompts[-1])

        rows = self.client.get("/api/history/list", params={**auth, "feature": "tarot"}).json()["items"]
        self.assertEqual(len(rows), 2)

    def test_injected_constraint_survives_followup(self):
        pid, token = self.new_user()
        auth = self.auth_params(pid, token)
        first_q = "引入八字后追问是否仍带约束？"
        events, _ = self.get_sse("/api/meihua/deduce",
                                 {**FEATURE_PARAMS["meihua"], **auth, "q": first_q})
        hid = event_hid(events)
        self.assertIn("命主本人八字", self.ai_mock.prompts[-1])

        self.get_sse("/api/history/followup", {**auth, "id": hid, "q": "刚才的体用关系再说细一点"})
        self.assertIn("命主本人八字", self.ai_mock.prompts[-1])
        detail = self.client.get("/api/history/detail", params={**auth, "id": hid}).json()["item"]
        self.assertIn("命主本人八字", detail["payload"].get("_injected", ""))

    def test_liuyao_deck_lock_uses_exact_chart_shown_to_user(self):
        """页面展示的卦必须就是 AI 解读的卦：deck 连串与逗号串都要能锁定。"""
        pid, token = self.new_user()
        auth = self.auth_params(pid, token)
        deck = "879877"  # calc 返回的 6 位连串；mock derive 会把 yaos 原样写进 fact
        when = "2027-03-04T10:00:00"
        q = "宁德时代能够长持吗？"

        events, _ = self.get_sse("/api/liuyao/deduce", {
            **auth, "q": q, "deck": deck, "when": when,
        })
        self.assertIsNotNone(event_hid(events), events)
        prompt = self.ai_mock.prompts[-1]
        # mock 引擎把锁定的 yaos 放进 fact；解析失败时会变成 yaos=None 并重新起卦
        self.assertIn(str([8, 7, 9, 8, 7, 7]), prompt, prompt)
        detail = self.client.get("/api/history/detail",
                                 params={**auth, "id": event_hid(events)}).json()["item"]
        self.assertIn(str([8, 7, 9, 8, 7, 7]), detail["payload"].get("fact", ""))

        # 手动起卦回传的逗号串必须等价（force=1 避免命中同 key 缓存跳过锁盘）
        self.get_sse("/api/liuyao/deduce", {
            **auth, "q": q, "deck": "8,7,9,8,7,7", "when": when, "force": 1,
        })
        self.assertIn(str([8, 7, 9, 8, 7, 7]), self.ai_mock.prompts[-1])

    def test_liuyao_invalid_deck_never_silently_recasts(self):
        """deck 无效必须明示错误，绝不静默换一卦给 AI 解读。"""
        pid, token = self.new_user()
        auth = self.auth_params(pid, token)
        before = len(self.ai_mock.prompts)
        bad = self.client.get("/api/liuyao/deduce", params={
            **auth, "q": "坏 deck", "deck": "9999999", "when": "2027-03-04T10:00:00",
        })
        self.assertEqual(bad.status_code, 200, bad.text)
        self.assertFalse(bad.json().get("ok"), bad.json())
        self.assertIn("卦象标识无效", bad.json().get("error", ""))
        self.assertEqual(len(self.ai_mock.prompts), before)

    def test_auth_boundaries(self):
        pid, token = self.new_user()
        events, _ = self.get_sse("/api/qimen/deduce", {**FEATURE_PARAMS["qimen"], **self.auth_params(pid, token), "q": "鉴权边界"})
        hid = event_hid(events)

        no_auth = self.client.get("/api/qimen/deduce", params={"q": "未登录"})
        self.assertFalse(no_auth.json().get("ok"))
        self.assertIn("请先登录", no_auth.json().get("error", ""))

        other_pid, other_token = self.new_user()
        detail = self.client.get("/api/history/detail", params={
            "profile_id": other_pid, "token": other_token, "id": hid})
        self.assertFalse(detail.json().get("ok"))

        with patch.object(bazi_engine, "chart", side_effect=ValueError("测试非法输入")):
            bad = self.client.get("/api/bazi/calc", params=FEATURE_PARAMS["bazi"])
        self.assertFalse(bad.json().get("ok"))
        self.assertEqual(bad.json().get("error"), "测试非法输入")


class TestRealEngineLock(ApiTestCase):
    """不 mock 引擎：验证「页面看到的盘 == AI prompt 里的盘」真实链路。

    TestAllFeatures 把引擎也 mock 掉，正好掩盖了六爻 deck 连串解析失败、
    deduce 静默重新起卦的严重 bug。这里用真实引擎守住这条铁律。
    """

    def test_liuyao_calc_deck_equals_deduce_fact(self):
        pid, token = self.new_user()
        auth = self.auth_params(pid, token)
        q = "卦面与解读必须同一卦？"
        when = "2027-03-04T10:00:00"
        calc = self.client.get("/api/liuyao/calc", params={
            "method": "coin", "coins": "8,7,9,8,7,7", "when": when, "question": q,
        }).json()
        self.assertTrue(calc.get("ok"), calc)
        self.assertEqual(calc["deck"], "879877")
        self.assertIn("巽为风", calc["fact"])

        events, _ = self.get_sse("/api/liuyao/deduce", {
            **auth, "q": q, "deck": calc["deck"], "when": calc["when"],
        })
        self.assertIsNotNone(event_hid(events), events)
        prompt = self.ai_mock.prompts[-1]
        # calc 展示的每一层关键事实都必须逐字出现在 AI 看到的 prompt 中
        for line in calc["fact"].splitlines():
            if line.startswith(("本卦：", "纳甲：", "动爻：")):
                self.assertIn(line, prompt, f"展示的盘面事实未进入 prompt：{line}")
        self.assertIn(q, prompt)  # q 回填到 question，fact 的「所问」才不丢

    def test_tarot_calc_deck_equals_deduce_fact(self):
        pid, token = self.new_user()
        auth = self.auth_params(pid, token)
        q = "牌面与解读必须同一副牌？"
        calc = self.client.get("/api/tarot/calc", params={
            "spread": "three", "question": q,
        }).json()
        self.assertTrue(calc.get("ok"), calc)
        deck = ",".join(f"{c['slug']}|{1 if c['reversed'] else 0}" for c in calc["cards"])
        events, _ = self.get_sse("/api/tarot/deduce", {
            **auth, "q": q, "spread": "three", "deck": deck,
        })
        self.assertIsNotNone(event_hid(events), events)
        prompt = self.ai_mock.prompts[-1]
        for line in calc["fact"].splitlines()[1:]:  # 跳过牌阵标题行
            self.assertIn(line, prompt, f"展示的牌面未进入 prompt：{line}")
