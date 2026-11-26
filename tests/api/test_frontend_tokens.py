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

    def test_followup_result_reads_as_paragraph(self):
        """v127：追问结果内联为「问+答」段落，不套独立卡片/展开按钮（与个人中心历史详情同构）。"""
        head = _block(".ai-follow-slot > .pf-hist-fu .pf-fu-q")
        self.assertIn("var(--fs-base)", head, "追问标题应回到正文基准字号")
        self.assertNotIn("var(--fs-sm)", head, "追问标题不得降级为说明小字")
        self.assertIn("font-weight:600", head)
        self.assertIn("var(--ink-2)", head)
        para = _block(".ai-follow-slot > .pf-hist-fu")
        self.assertIn("border-top:var(--line-w) solid var(--line-strong)", para,
                      "追问段落分隔应为实线，不用浅虚线")
        self.assertIn("margin-top:var(--gap-md)", para)
        # 存量快照兼容：旧追问卡的卡头必须隐藏，不再显示「收起/展开」
        legacy = _block(".ai-follow-slot > .p-ai > .p-ai-head")
        self.assertIn("display:none", legacy, "旧结构追问卡头须隐藏，杜绝展开按钮")
        self.assertIn("var(--fs-sm)", _block(".pf-follow-note"), "追问说明文字应为 sm 而非辅助 xs")

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

    def test_birthplace_shared_control_unified_and_required(self):
        """v137：八字/占星/注册统一复用 placeFieldsHTML 三级联动，出生地必填，不做真太阳时校正。"""
        # 八字页不再保留旧的「出生地（可选）」自由文本框（id 仍叫 bz-place，但由 placeFieldsHTML 生成）
        self.assertNotIn("出生地（可选）", JS, "八字页仍有旧的「出生地（可选）」文本框")
        self.assertIn('placeFieldsHTML("bz"', JS, "八字页未接入统一出生地控件")
        self.assertIn('placeFieldsBind("bz")', JS, "八字页未绑定统一出生地控件")
        self.assertIn('placeFieldsHTML("au"', JS, "注册弹窗未接入统一出生地控件")
        self.assertIn("请选择出生地点", JS, "注册/八字缺少出生地必填校验")
        # 真太阳时开关不得回到产品模板（预览里那版被否掉了：仅收集不用）
        self.assertNotIn("使用真太阳时", JS, "产品模板出现真太阳时开关，与「仅收集不用」口径冲突")

    def test_marriage_compact_uses_token_and_scoped(self):
        """v137：合婚表单 compact 高度走 token，且只作用于填写控件不碰结果盘面。"""
        block = _block(".portal-body")
        self.assertIn("--control-h-compact: 36px", block, "缺少紧凑控件高度 token")
        self.assertIn("height: var(--control-h-compact)", CSS, "compact 规则未使用高度 token")
        # compact 规则必须限定 .mrg-person 作用域，不得全局改 .ti
        self.assertIn(".mrg-person .ti", CSS, "compact 未限定在合婚填写表单作用域")

    def test_analysis_cards_share_content_width(self):
        """v138：十神/神煞卡挂在结果根外（非 .p-result 内），必须自己并入 --content-w，
        否则吃不到 `.p-result .p-card` 的 760 约束，撑到 804px 比表单卡宽 22px。"""
        block = _block(".bz-analysis")
        self.assertIn("var(--content-w)", block, ".bz-analysis 未并入单一宽度源")
        self.assertIn("auto", block, ".bz-analysis 缺少水平居中，宽度设了也不会对齐")

    def test_bazi_options_card_between_analysis_and_ask(self):
        """v141：大运/流年/流月选项独立成卡，位于十神/神煞分析之后、提问卡之前，并并入单一宽度源。"""
        self.assertIn('class="p-card bz-options"', JS, "八字选项未独立成卡")
        self.assertLess(JS.index("bzAnalysisHTML(d)"), JS.index('class="p-card bz-options"'),
                        "选项卡必须在神煞分析之后")
        self.assertLess(JS.index('class="p-card bz-options"'), JS.index('class="bz-ask"'),
                        "选项卡必须在提问卡之前")
        block = _block(".bz-options")
        self.assertIn("var(--content-w)", block, "选项卡未并入单一宽度源")
        self.assertIn("auto", block, "选项卡未水平居中")

    def test_pair_birth_form_rows_share_line(self):
        """v142：阳历/农历与出生日期同行且外框等高；早晚子时与时/分选择同排。"""
        self.assertIn('class="bf-field bf-date-field"', JS, "出生日期标签行未结构化为 bf-date-field")
        self.assertIn('class="bf-time-row"', JS, "早晚子时未并入时/分同排")
        self.assertIn("extraTime: earlyZi", JS, "早晚子时未从共用出生模板插入时分行")
        self.assertIn(".mrg-person .bf-date-field", CSS, "双栏日期标签行缺少专属布局")
        self.assertIn("height: var(--control-h-compact); padding: 0;", CSS, "阳历/农历外框未与日期按钮等高")
        self.assertIn(".mrg-person .bf-time-row", CSS, "双栏时分行缺少专属布局")

    def test_analysis_note_beats_generic_card_paragraph(self):
        """v139：十神说明段在 .p-card 内，必须多一个元素选择器压过 `.p-card p`，
        否则 margin/font/color/line-height 被通用规则吃掉，只剩分割线贴住柱卡边框。"""
        block = _block(".bz-analysis p.bz-analysis-note")
        self.assertTrue(block, "说明段选择器特异性不足，被 .p-card p 覆盖")
        for token in ("margin: var(--gap-sm)", "padding-top: var(--gap-sm)",
                      "border-top: var(--line-w)", "font-size: var(--fs-xs)",
                      "color: var(--ink-3)"):
            self.assertIn(token, block, f"说明段缺少 {token}")

    def test_register_modal_widened_only_on_reg_tab(self):
        """v137：仅注册 tab 加宽弹窗缓解拥挤，登录保持 420px。"""
        self.assertIn(".p-modal-box.is-reg", CSS, "缺少注册弹窗加宽规则")
        self.assertIn("width:min(600px,92vw)", CSS, "注册弹窗未加宽到 600px")
        self.assertIn('classList.toggle("is-reg"', JS, "login/reg 切换未同步弹窗宽度状态")

    def test_asset_version_bumped_with_css_change(self):
        # 只锁版本下限（v114 为该护栏引入基线），避免每次正经 bump 都要改测试。
        # 版本回退到基线以下（缓存破坏失效）仍会被这里拦住。
        for asset, baseline in (("portal.css", 114), ("portal.js", 114)):
            m = re.search(re.escape(asset) + r"\?v=(\d+)", HTML)
            self.assertIsNotNone(m, f"{asset} 缺少版本号")
            self.assertGreaterEqual(int(m.group(1)), baseline,
                                    f"{asset} 版本号低于基线 {baseline}，缓存破坏可能失效")


if __name__ == "__main__":
    unittest.main(verbosity=2)
