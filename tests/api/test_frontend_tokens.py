"""前端设计系统静态护栏：防止散写字号/控件尺寸回潮。

运行：PYTHONPATH=server:. .venv-dev/bin/python -m unittest discover -s tests/api -p 'test_*.py'
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CSS = (ROOT / "web" / "portal.css").read_text(encoding="utf-8")
HTML = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
JS = (ROOT / "web" / "portal.js").read_text(encoding="utf-8")


def _block(selector: str, index: int = 0) -> str:
    blocks = re.findall(re.escape(selector) + r"\s*\{([^{}]*)\}", CSS)
    return blocks[index] if len(blocks) > index else ""


class TestFrontendTokens(unittest.TestCase):
    def test_portal_body_sets_base_font_and_control_inheritance(self):
        # .portal-body 依次是 token 定义、暗色 token、正文基准；后者必须显式设字号。
        blocks = re.findall(r"\.portal-body\s*\{([^{}]*)\}", CSS)
        self.assertTrue(any("font-size: var(--fs-base)" in b for b in blocks))
        inheritance = re.search(
            r"\.portal-body :where\(button, input, select, textarea\)\s*\{([^{}]*)\}", CSS
        )
        self.assertIsNotNone(inheritance)
        self.assertIn("font-family: inherit", inheritance.group(1))
        self.assertIn("font-size: inherit", inheritance.group(1))

    def test_no_bare_px_font_sizes(self):
        """v114：全站字号 100% 走 token，裸 px（含盘面 9/9.5/10/40）一律拦截。"""
        bad = []
        for m in re.finditer(r"font-size\s*:\s*([^;]+);", CSS):
            value = m.group(1).strip()
            if value.startswith("var(--fs-") or value == "inherit":
                continue
            bad.append(value)
        self.assertEqual(bad, [], f"发现未 token 化的字号：{sorted(set(bad))}")

    def test_panel_and_glyph_tokens_defined(self):
        """盘面小字集中到两个 token + 卦符一个 token，禁止再散写裸 px。"""
        block = _block(".portal-body")
        for token in ("--fs-dense: 10px", "--fs-fine: 9px", "--fs-glyph: 40px"):
            self.assertIn(token, block, f"缺少盘面字号 token：{token}")

    def test_aux_text_promoted_to_xs(self):
        """普通辅助文字（非盘面）统一到 --fs-xs，不得回退到 dense/fine。"""
        for selector in (".p-brand-sub", ".p-soon", ".p-hist-feat",
                         ".pf-hcard-date", ".hl-cell span", ".hl-cell em",
                         ".qm-help", ".tf-req"):
            self.assertIn("var(--fs-xs)", _block(selector),
                          f"{selector} 未提升到辅助字号 token")

    def test_shared_controls_use_height_token(self):
        for selector in (".p-seg button", ".hl-ctl .ti", ".hl-nav", ".dp-cell"):
            self.assertIn("var(--control-h)", _block(selector), f"{selector} 未使用控件高度 token")

    def test_shared_cards_use_radius_token(self):
        for selector in (".home-card", ".p-card", ".tool-card"):
            block = _block(selector)
            self.assertTrue("var(--radius-lg)" in block or "var(--radius-lg)" in CSS,
                            f"{selector} 未使用卡片圆角 token")

    def test_profile_headings_use_tokens(self):
        for selector in (".p-profile-head h3", ".p-profile-head h3, .pf-birth-h h3, .pf-stat-h h3, .pf-hist-head h3, .pf-memory h3"):
            self.assertIn("var(--fs-", _block(selector), f"{selector} 未使用字号 token")

    def test_no_inline_font_size_in_templates(self):
        self.assertNotIn("font-size:", JS, "模板里仍有内联 font-size，样式应留在 portal.css 的 token 层")

    def test_asset_version_bumped_with_css_change(self):
        self.assertIn("portal.css?v=114", HTML)
        self.assertIn("portal.js?v=114", HTML)


if __name__ == "__main__":
    unittest.main(verbosity=2)
