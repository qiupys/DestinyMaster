"""全功能真实引擎链路矩阵：展示的盘面事实必须逐字进入 AI prompt。

与旧 test_feature_api.py（把计算引擎也 mock 掉）互补：这里只 mock AI 输出与检索，
计算全部走真实引擎。契约来自 tests/contracts.json，新增功能自动纳入下面每一条场景，
避免「用户报一个功能才发现另一个功能同类 bug」。

矩阵不变量（每层对所有功能执行）：
  calc-deduce-fact / question-in-prompt / replay-dedupe /
  followup-keeps-fact / identity-change-new-round / invalid-lock-explicit
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path
from unittest.mock import patch

import liuyao as liuyao_engine
import main
import prompt as zw_prompt

from testkit import ApiTestCase, event_hid, event_text, parse_sse

CONTRACT = json.loads((Path(__file__).resolve().parents[1] / "contracts.json").read_text(encoding="utf-8"))
Q1 = "矩阵首轮问题：这份盘面该怎么读？"
Q2 = "矩阵追问：刚才的结论再展开一点"


class TestChainMatrix(ApiTestCase):
    """每个功能都跑同一套链路场景；子测试名即契约不变量。"""

    def _api(self, feature: str) -> dict:
        return CONTRACT["features"][feature]["api"]

    def _features(self):
        """进程内 TestClient 跑不了 py-iztro；紫微在浏览器矩阵走真实 HTTP 覆盖。"""
        for feature, spec in CONTRACT["features"].items():
            if spec["api"].get("skip_in_process"):
                with self.subTest(feature=feature, invariant="in-process-safety"):
                    self.skipTest(spec["api"]["skip_in_process"])
                continue
            yield feature

    _digest_cache: dict = {}

    def _chart(self, feature: str, pid: int, token: str, key_suffix: str = "a") -> tuple[str, str]:
        """紫微不经 /api/chart（TestClient 打 py-iztro 有线程风险），直接注入会话。"""
        spec = self._api(feature)["chart_params"]
        if feature not in self._digest_cache:
            chart = main.get_chart(spec)
            self._digest_cache[feature] = (chart, zw_prompt.chart_digest(chart))
        chart, digest = self._digest_cache[feature]
        chart_id = uuid.uuid4().hex[:12]
        main.CHARTS[chart_id] = {"chart": chart, "history": [], "profile_id": pid, "chart_id": chart_id}
        self.addCleanup(lambda: main.CHARTS.pop(chart_id, None))
        return chart_id, digest

    def _calc(self, feature: str, params: dict) -> dict:
        resp = self.client.get(f"/api/{feature}/calc", params={**params, "question": Q1})
        self.assertEqual(resp.status_code, 200, resp.text[:300])
        body = resp.json()
        self.assertTrue(body.get("ok"), body)
        return body

    @staticmethod
    def _tarot_deck(calc: dict) -> str:
        return ",".join(f"{c['slug']}|{1 if c.get('reversed') else 0}" for c in calc.get("cards", []))

    def _deduce_params(self, feature: str, params: dict, calc: dict | None, auth: dict, q: str,
                       key_suffix: str = "a") -> dict:
        api_spec = self._api(feature)
        out = {**params, **auth, "q": q}
        if api_spec.get("chart_params"):
            out = {"id": self._chart(feature, auth["profile_id"], auth["token"], key_suffix)[0],
                   **auth, "q": q, "key": f"matrix|{feature}|{key_suffix}|{q}"}
        elif calc:
            lock = api_spec.get("lock")
            if lock == "deck":
                out.update({"deck": calc["deck"], "when": params["when"]})
            elif lock == "tarot_deck":
                out["deck"] = self._tarot_deck(calc)
        return out

    def _deduce_url(self, feature: str) -> str:
        if feature == "history":
            return "/api/history/followup"
        # 全功能统一 /api/<feature>/deduce（含紫微，v129 起不再有独立 /api/deduce）。
        return f"/api/{feature}/deduce"

    def _deduce(self, feature: str, params: dict) -> tuple[list[dict], object]:
        resp = self.client.get(self._deduce_url(feature), params=params)
        self.assertEqual(resp.status_code, 200, resp.text[:300])
        self.assertIn("text/event-stream", resp.headers.get("content-type", ""), resp.text[:300])
        return parse_sse(resp.text), resp

    def _facts(self, feature: str, calc: dict) -> list[str]:
        api_spec = self._api(feature)
        if api_spec.get("chart_params"):
            if feature not in self._digest_cache:
                self._chart(feature, 0, "")
            digest = self._digest_cache[feature][1]
            return [line.strip() for line in digest.splitlines() if line.strip()][:6]
        ignore = tuple(api_spec.get("ignore_fact_lines") or ())
        return [line.strip() for line in (calc.get("fact") or "").splitlines()
                if line.strip() and not line.strip().startswith(ignore)]

    def test_calc_deduce_fact(self):
        """calc 展示的每一行盘面事实都要逐字出现在 AI 看到的 prompt 里。"""
        for feature in self._features():
            with self.subTest(feature=feature, invariant="calc-deduce-fact"):
                pid, token = self.new_user()
                auth = self.auth_params(pid, token)
                params = dict(self._api(feature).get("calc_params") or {})
                calc = {} if params == {} else self._calc(feature, params)
                facts = self._facts(feature, calc)
                self.assertTrue(facts, f"{feature} 没有可核对的盘面事实")
                events, _ = self._deduce(feature, self._deduce_params(feature, params, calc, auth, Q1))
                self.assertIsNotNone(event_hid(events), events)
                prompt = type(self).ai_mock.prompts[-1]
                for line in facts:
                    self.assertIn(line, prompt, f"{feature} 展示的事实未进入 prompt：{line}")

    def test_question_in_prompt(self):
        """q 必须回填到 prompt，且历史 payload 保存同一份盘面。"""
        for feature in self._features():
            with self.subTest(feature=feature, invariant="question-in-prompt"):
                pid, token = self.new_user()
                auth = self.auth_params(pid, token)
                params = dict(self._api(feature).get("calc_params") or {})
                calc = {} if params == {} else self._calc(feature, params)
                events, _ = self._deduce(feature, self._deduce_params(feature, params, calc, auth, Q1))
                hid = event_hid(events)
                self.assertIsNotNone(hid, events)
                prompt = type(self).ai_mock.prompts[-1]
                self.assertIn(Q1, prompt, f"{feature} 问题未进入 prompt")
                self.assertIn("mock解读", event_text(events))
                detail = self.client.get("/api/history/detail", params={**auth, "id": hid}).json()
                self.assertTrue(detail.get("ok"), detail)
                self.assertEqual(detail["item"]["feature"], feature)
                payload_text = json.dumps(detail["item"].get("payload") or {}, ensure_ascii=False)
                self.assertTrue(any(line in payload_text for line in self._facts(feature, calc)),
                                f"{feature} 历史 payload 未保存盘面事实")

    def test_replay_dedupe(self):
        """同问题 + 同盘面身份必须回放，不重复调模型。"""
        for feature in self._features():
            with self.subTest(feature=feature, invariant="replay-dedupe"):
                pid, token = self.new_user()
                auth = self.auth_params(pid, token)
                params = dict(self._api(feature).get("calc_params") or {})
                calc = {} if params == {} else self._calc(feature, params)
                dp = self._deduce_params(feature, params, calc, auth, Q1)
                first, _ = self._deduce(feature, dp)
                before = len(type(self).ai_mock.prompts)
                replay, _ = self._deduce(feature, dp)
                self.assertTrue(any(e.get("cached") for e in replay), f"{feature} 未命中缓存：{replay}")
                self.assertEqual(event_hid(replay), event_hid(first))
                self.assertEqual(len(type(self).ai_mock.prompts), before, f"{feature} 回放仍调用模型")

    def test_followup_keeps_fact(self):
        """追问必须带原问题、原盘面事实与首轮结论。"""
        for feature in self._features():
            with self.subTest(feature=feature, invariant="followup-keeps-fact"):
                pid, token = self.new_user()
                auth = self.auth_params(pid, token)
                params = dict(self._api(feature).get("calc_params") or {})
                calc = {} if params == {} else self._calc(feature, params)
                first, _ = self._deduce(feature, self._deduce_params(feature, params, calc, auth, Q1))
                hid = event_hid(first)
                follow, _ = self._deduce("history", {**auth, "id": hid, "q": Q2})
                self.assertIsNotNone(event_hid(follow), follow)
                prompt = type(self).ai_mock.prompts[-1]
                self.assertTrue("此前对话与提问" in prompt or "历史对话" in prompt,
                                f"{feature} 追问未带上下文")
                self.assertIn(Q1, prompt)
                self.assertIn("mock解读", prompt)

    def test_identity_change_new_round(self):
        """盘面身份任一变化 + 同问题，必须生成新轮而非复用旧解读。"""
        for feature in self._features():
            with self.subTest(feature=feature, invariant="identity-change-new-round"):
                pid, token = self.new_user()
                auth = self.auth_params(pid, token)
                api_spec = self._api(feature)
                params = dict(api_spec.get("calc_params") or {})
                calc = {} if params == {} else self._calc(feature, params)
                first, _ = self._deduce(feature, self._deduce_params(feature, params, calc, auth, Q1))
                before = len(type(self).ai_mock.prompts)

                if api_spec.get("chart_params"):
                    changed = self._deduce(feature, self._deduce_params(
                        feature, params, {}, auth, Q1, key_suffix="b"))
                else:
                    ident = api_spec["identity_param"]
                    params2 = {**params, ident["key"]: ident["alt"]}
                    calc2 = self._calc(feature, params2)
                    changed = self._deduce(feature, self._deduce_params(feature, params2, calc2, auth, Q1))
                self.assertNotEqual(event_hid(changed), event_hid(first),
                                    f"{feature} 盘面变化后仍复用旧轮")
                self.assertEqual(len(type(self).ai_mock.prompts), before + 1)

    def test_mutation_silent_recast_is_rejected(self):
        """变异注入：强制锁盘解析失败，历史 bug 会静默换卦继续解读；矩阵必须抓住。"""
        with self.subTest(feature="liuyao", invariant="invalid-lock-explicit", mutation="parse_yaos→None"):
            pid, token = self.new_user()
            auth = self.auth_params(pid, token)
            params = dict(self._api("liuyao")["calc_params"])
            calc = self._calc("liuyao", params)
            dp = self._deduce_params("liuyao", params, calc, auth, Q1)
            before = len(type(self).ai_mock.prompts)
            with patch.object(liuyao_engine, "parse_yaos", return_value=None):
                body = self.client.get("/api/liuyao/deduce", params=dp).json()
            self.assertFalse(body.get("ok"), "锁盘失败被静默吞掉，AI 解读了另一卦：" + str(body))
            self.assertIn("无效", body.get("error", ""))
            self.assertEqual(len(type(self).ai_mock.prompts), before, "静默回退仍调用了模型")

    def test_invalid_lock_explicit(self):
        """非法盘面/空问题必须显式报错，绝不静默换卦或调模型。"""
        for feature in self._features():
            with self.subTest(feature=feature, invariant="invalid-lock-explicit"):
                pid, token = self.new_user()
                auth = self.auth_params(pid, token)
                api_spec = self._api(feature)
                params = dict(api_spec.get("calc_params") or {})
                calc = {} if params == {} else self._calc(feature, params)
                before = len(type(self).ai_mock.prompts)

                bad = api_spec.get("invalid_lock")
                if bad:
                    dp = {**bad, **auth, "q": Q1}
                    if api_spec.get("chart_params"):
                        dp.pop("deck", None)
                        dp["id"] = self._chart(feature, pid, token)[0]
                    resp = self.client.get(self._deduce_url(feature), params=dp)
                    body = resp.json()
                    self.assertFalse(body.get("ok"), body)
                    self.assertIn("无效", body.get("error", ""))
                else:
                    dp = self._deduce_params(feature, params, calc, auth, "  ")
                    body = self.client.get(self._deduce_url(feature), params=dp).json()
                    self.assertFalse(body.get("ok"), body)
                    self.assertIn("问题不能为空", body.get("error", ""))
                self.assertEqual(len(type(self).ai_mock.prompts), before,
                                 f"{feature} 非法输入仍调用了模型")


if __name__ == "__main__":
    import unittest
    unittest.main()
