"""紫微「主体宫位」解读护栏（v116）。

用户点名某宫 = 以它为主体、据三方四正与四化展开，不是「只看」单宫。
本文件锁定三处：prompt 方法论、RAG 检索补词、前端提问措辞与三方四正偏移。
纯函数 + 静态检查，不调用 py-iztro（避免线程不安全），也不需要 mock AI。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))
sys.path.insert(0, str(ROOT))

import prompt as zw_prompt  # noqa: E402

JS = (ROOT / "web" / "portal.js").read_text(encoding="utf-8")


class TestZiweiSubjectPalace(unittest.TestCase):
    def test_prompt_declares_subject_palace_method(self):
        rules = zw_prompt.SYSTEM_RULES
        self.assertIn("主体宫位法则", rules)
        self.assertIn("点名某宫≠只看该宫", rules)
        self.assertIn("三方四正", rules)
        self.assertIn("对宫", rules)
        self.assertIn("三合二宫", rules)
        self.assertIn("四化", rules)
        # 法则要明确禁止孤立单宫解读
        self.assertIn("禁止只罗列该宫本宫", rules)
        self.assertIn("禁止出现「只看X宫」", rules)

    def test_assembled_prompt_carries_subject_rule(self):
        data = {"digest": "MOCK", "target": "", "kb_block": ""}
        text = zw_prompt.assemble_ziwei(data, "（以「财帛宫」为主体，结合三方四正与四化）股票还持有吗？")
        self.assertIn("主体宫位法则", text)
        self.assertIn("以「财帛宫」为主体", text)

    def test_subject_question_enriches_rag_terms(self):
        """点名主体的提问必须补入方法论检索词，避免只命中单宫词条。"""
        chart = {"solarDate": "1990-06-15", "palaces": [], "horoscope": {}}
        with patch.object(zw_prompt.rag, "retrieve", return_value=[]):
            data = zw_prompt.prepare_ziwei(chart, "以财帛宫为主体，我的财运如何？")
        for term in ("三方四正", "四化", "对宫", "飞化"):
            self.assertIn(term, data["rag_query"], f"RAG 缺方法论检索词：{term}")
            self.assertIn(term, data["rag_extra"], f"rag_extra 缺方法论词：{term}")

    def test_plain_question_does_not_force_method_terms(self):
        """未点名主体的普通提问不应被强制塞入方法论词（保留 RAG  precision）。"""
        chart = {"solarDate": "1990-06-15", "palaces": [], "horoscope": {}}
        with patch.object(zw_prompt.rag, "retrieve", return_value=[]):
            data = zw_prompt.prepare_ziwei(chart, "今天心情怎么样")
        self.assertNotIn("飞化", data["rag_extra"])


class TestZiweiPalaceAskFrontend(unittest.TestCase):
    def test_no_only_this_palace_wording(self):
        self.assertNotIn("（只看「", JS, "前端不得再把「只看XX宫」写进问题文本")
        self.assertNotIn('"（只看"', JS)

    def test_subject_wording_present(self):
        self.assertIn("为主体，结合三方四正与四化", JS)
        self.assertIn("为主体", JS)

    def test_chips_use_subject_wording(self):
        self.assertIn("以「\" + pn + \"」为主体，结合三方四正与四化", JS)

    def test_focus_palace_passed_to_backend(self):
        self.assertIn("focusPalace", JS)
        self.assertIn('"&focus=" + encodeURIComponent(focus)', JS)

    def test_trine_offsets_are_correct(self):
        """三方四正快捷跳转偏移须为 +4/+8/+6，与命格解析口径一致。"""
        self.assertIn("var trine = [4, 8, 6]", JS)
        self.assertNotIn("[1, 5, 7]", JS)


if __name__ == "__main__":
    unittest.main()
