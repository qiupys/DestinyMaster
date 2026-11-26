"""八字流月选择回归测试（v130）。

覆盖：
  1. 后端按节气月柱给出十二流月，干支与八字排盘同源；
  2. calc_bazi 复用共用 parse_target_period 把被问流年/流月写进 payload 与 fact
     （进 dedupe key → 不同流月是不同轮）；
  3. 前端有流月行、点选拼进 scope，且不造专属 API 参数。
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "server"))

import bazi
from features import calculations

JS = (Path(__file__).resolve().parents[2] / "web" / "portal.js").read_text(encoding="utf-8")


class TestBaziLiuyue(unittest.TestCase):
    def test_liuyue_uses_solar_term_month_pillar(self):
        months = bazi.liuyue_of_year(2026)
        self.assertEqual(len(months), 12)
        self.assertEqual([m["month"] for m in months], list(range(1, 13)))
        # 2026 丙午年：2 月庚寅（寅月）、5 月癸巳（巳月）——真实节气月柱，非公历序位错配
        by_month = {m["month"]: m["ganzhi"] for m in months}
        self.assertEqual(by_month[2], "庚寅")
        self.assertEqual(by_month[5], "癸巳")

    def test_chart_attaches_liuyue_to_each_liunian(self):
        payload = bazi.chart(1990, 6, 15, 10, 30, "男")
        self.assertTrue(payload.get("liunian"), "八字盘应有流年")
        for year_item in payload["liunian"]:
            self.assertEqual(len(year_item.get("liuyue", [])), 12)

    def test_liunian_covers_all_displayed_dayun(self):
        """v143：点任一大运都要有对应流年可切，流月再跟着选中流年走。"""
        payload = bazi.chart(1990, 6, 15, 10, 30, "男")
        self.assertTrue(payload["dayun"], "八字盘应有大运")
        self.assertGreater(len(payload["liunian"]), 10, "流年只给今年起十年，点后段大运无数据可切")
        for dy in payload["dayun"]:
            matched = [x for x in payload["liunian"]
                       if dy["start_year"] <= x["year"] <= dy["end_year"]]
            self.assertTrue(matched, f"大运 {dy['ganzhi']} 没有对应流年")
            self.assertTrue(all(x["dayun"] == dy["ganzhi"] for x in matched),
                            f"流年的 dayun 归属与大运不一致：{dy['ganzhi']}")
            self.assertTrue(all(len(x["liuyue"]) == 12 for x in matched),
                            "大运内流年缺少节气流月")

    def test_liuyue_question_written_to_payload_and_fact(self):
        base = {"year": 1990, "month": 6, "day": 15, "hour": 10, "gender": "男", "calendar": "solar"}
        plain = calculations.calc_bazi(dict(base, question="我的事业格局如何？"))
        self.assertNotIn("target_year", plain)
        liuyue = calculations.calc_bazi(
            dict(base, question="（只看 2026 年 5 月 癸巳 流月）这个月事业如何？"))
        self.assertEqual(liuyue.get("target_year"), 2026)
        self.assertEqual(liuyue.get("target_month"), 5)
        self.assertIn("2026 年 5 月流月", liuyue["fact"])
        # 时点进 payload → 进 dedupe key：换流月 fact 必须不同
        other = calculations.calc_bazi(
            dict(base, question="（只看 2026 年 6 月 甲午 流月）这个月事业如何？"))
        self.assertNotEqual(liuyue["fact"], other["fact"])

    def test_frontend_uses_shared_scope_pattern(self):
        self.assertIn("data-kind=\"ly\"", JS)
        self.assertIn("bz-liuyue", JS)
        self.assertIn("bz-liunian", JS)
        self.assertIn("liunianForDayun", JS)
        self.assertIn("applyDayunScope", JS)
        self.assertIn("pick.kind === \"ly\"", JS)
        # 流月 scope 走通用 q 参数 + 统一 factory，不新增专属参数
        self.assertIn("encodeURIComponent(scope + q)", JS)

    def test_ten_god_detail_and_shensha_by_pillar(self):
        payload = bazi.chart(1990, 6, 15, 10, 30, "男")
        detail = payload["ten_god_detail"]
        self.assertEqual(sorted(detail.keys()), ["day", "hour", "month", "year"])
        self.assertTrue(detail["year"]["main"])
        self.assertTrue(detail["year"]["main_desc"], "十神须带释义")
        self.assertTrue(all(h.get("desc") is not None for h in detail["year"]["hidden"]))
        by_pillar = payload["shensha_by_pillar"]
        self.assertEqual(sorted(by_pillar.keys()), ["day", "hour", "month", "year"])
        for items in by_pillar.values():
            for item in items:
                self.assertIn(item["tone"], ("吉", "凶", "中"))
                self.assertTrue(item["name"])

    def test_frontend_analysis_projection_from_board(self):
        self.assertIn("function bzAnalysisHTML(boardData)", JS)
        self.assertIn("十神分析", JS)
        self.assertIn("神煞分析", JS)
        # 分析卡插在八字盘面投影里（bzAnalysisHTML(d)），不是硬编码 HTML 复制
        self.assertIn("bzAnalysisHTML(d)", JS)


if __name__ == "__main__":
    unittest.main(verbosity=2)
