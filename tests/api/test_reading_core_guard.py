"""统一解读对象模型的架构护栏。

v116 起「一次 AI 解读」是 Reading 对象，功能元信息在 reading-core.js 的 FEATURES
注册表单点维护。本护栏防止回潮：禁止在 portal.js 里重新散写 followNote 的 MAP、
重新手写全功能选择器表，确保新增功能只需加一行注册表配置。

运行：PYTHONPATH=server:. .venv-dev/bin/python -m unittest discover -s tests/api -p 'test_*.py'
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
JS = (ROOT / "web" / "portal.js").read_text(encoding="utf-8")
CORE = (ROOT / "web" / "reading-core.js").read_text(encoding="utf-8")
HTML = (ROOT / "web" / "index.html").read_text(encoding="utf-8")


class TestReadingCoreGuard(unittest.TestCase):
    def test_core_loaded_before_portal(self):
        self.assertIn('src="/reading-core.js', HTML, "index.html 未引入对象模型核心")
        self.assertLess(HTML.index('src="/reading-core.js'), HTML.index('src="/portal.js'),
                        "reading-core.js 必须在 portal.js 之前加载")

    def test_registry_covers_all_features_with_person_meta(self):
        """注册表每项都必须声明 arity/needsBirth/note——用户信息导入靠它声明式驱动。"""
        for key in ("bazi", "ziwei", "meihua", "liuyao", "qimen", "tarot", "astrology",
                    "huangli", "huangli_pair", "bazi_marriage", "ziwei_marriage", "astrology_marriage"):
            # 在注册表块里该 key 的定义行附近能找到 arity 与 needsBirth
            # 支持注册表项内嵌对象（ziwei 的 slots 声明），匹配到该项结束的 4 空格大括号
            m = re.search(r"\b" + key + r"\s*:\s*\{(.*?)\n    \}", CORE, re.S)
            self.assertIsNotNone(m, f"注册表缺少 {key}")
            body = m.group(1)
            self.assertIn("arity:", body, f"{key} 缺少 arity")
            self.assertIn("needsBirth:", body, f"{key} 缺少 needsBirth")
            self.assertIn("note:", body, f"{key} 缺少 note")

    def test_no_scattered_follownote_map(self):
        """追问提示文案不得在 portal.js 里重新散写成 MAP（必须走 Core.followNote）。"""
        self.assertIn("Core.followNote(feature)", JS, "portal.js 未转发 followNote 到注册表")
        # 旧的散表特征：同时出现多条「追问会沿用...不会重新」字面量即视为回潮
        occurrences = len(re.findall(r"追问会沿用这一次", JS))
        self.assertLessEqual(occurrences, 1,
                             f"portal.js 出现 {occurrences} 处追问文案字面量，应收敛到注册表")

    def test_no_scattered_root_selector_table(self):
        """选择器表不得重新手写全量字面量（应从注册表生成）。"""
        self.assertIn("Core.FEATURES", JS, "portal.js 未从注册表生成选择器")
        self.assertIn("function sessOf(", JS, "缺少容器→会话桥接")

    def test_repaint_protection_is_single_source(self):
        """v121：重绘保护与 slot 映射必须从注册表派生，禁止再给单个功能写一套。"""
        self.assertIn("Core.outsOf(", JS, "输出容器清单未从注册表派生")
        self.assertIn("Core.slotMap()", JS, "slot 映射未从注册表派生")
        self.assertIn("preserveOutputs(", JS, "缺少全功能共用的重绘保护")
        self.assertIn("archiveBeforeRepaint(", JS, "缺少换盘统一归档入口")
        self.assertNotIn("zwKeepOutputs", JS, "紫微专用重绘保护未收编")
        self.assertIn("findReadingById", JS, "历史详情追问未按 hid 全局定位 Reading")

    def test_decisions_read_from_core_not_dom_text(self):
        """去重判断必须走对象的 find()，不再用 DOM 文本 indexOf(q) 判定。"""
        self.assertIn("sess.find(q, rk)", JS, "findAnswered 未走对象模型")
        self.assertIn("sess.begin(", JS, "解读开始未创建对象")
        self.assertIn("sess.finish(", JS, "解读结束未写回对象")

    def test_person_snapshot_built_centrally(self):
        """用户信息导入统一在 currentPersons 构造，双人功能写 setPartner。"""
        self.assertIn("function currentPersons(", JS)
        self.assertIn("new Core.Person(", JS)
        self.assertIn("setPartner(", JS, "双人功能未写入对方 Person 快照")


if __name__ == "__main__":
    unittest.main()
