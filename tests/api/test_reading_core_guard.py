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

    def test_board_is_first_class_object(self):
        """v126：盘面是一等对象 Board——Reading 持有它，仓库按 roundKey 索引。"""
        self.assertIn("function Board(", CORE, "缺少 Board 对象")
        self.assertIn("this.roundKey", CORE, "Board 字段应为 roundKey（不用缩写）")
        self.assertIn("this.board = Board.fromJSON", CORE, "Reading 未持有 Board")
        self.assertIn("this.boards = Object.create(null)", CORE, "会话缺少盘面仓库")
        self.assertIn("bindBoardToRound", CORE, "缺少盘面→轮次绑定")
        self.assertIn("Board: Board", CORE, "Board 未导出")

    def test_every_feature_puts_board(self):
        """12 功能每个 calc 落地都要 putBoard——盘面数据必须进对象，不能只留在 DOM。"""
        # 单功能走字面量 feature；黄历 personal/pair 与三个合婚共用舞台，feat 运行时决定
        for feature in ("bazi", "ziwei", "meihua", "liuyao", "qimen", "tarot", "astrology"):
            self.assertIn('putBoard("' + feature + '"', JS, f"{feature} 未把盘面数据存进 Board")
        self.assertGreaterEqual(JS.count("putBoard(feat,"), 2, "黄历 personal/pair 与合婚未走 Board")

    def test_archive_fact_from_board_not_dom(self):
        """归档盘面摘要必须从 Board 对象投影，禁止再复制 .p-result 的 innerHTML。"""
        self.assertIn("var projected = boardView(", JS, "归档摘要未从 Board 投影")
        self.assertIn("BOARD_VIEWS", JS, "缺少盘面投影注册表")
        # 归档函数体内不得直接复制结果卡 innerHTML 作为摘要源
        m = re.search(r"function archiveRound\(.*?\n  \}", JS, re.S)
        self.assertIsNotNone(m, "找不到 archiveRound")
        self.assertNotIn("resultCard.innerHTML", m.group(0), "归档仍在复制盘面 DOM HTML")

    def test_every_feature_has_dedicated_board_projection(self):
        """v131：12 功能全部注册 Board 专属投影，通用摘要只做兜底。
        命盘/合婚/黄历的核心对象数组（十神、神煞、宫位、行星、跨盘关系）
        不能再被 generalBoardView 跳过；投影必须只读，不得带交互元素。"""
        features = ("bazi", "ziwei", "meihua", "liuyao", "qimen", "tarot", "astrology",
                    "huangli", "huangli_pair", "bazi_marriage", "ziwei_marriage",
                    "astrology_marriage")
        for feature in features:
            self.assertIn("BOARD_VIEWS." + feature + " =", JS,
                          f"{feature} 未注册专属 Board 投影")
        start = JS.index("function generalBoardView(")
        end = JS.index("function boardView(featureName, board)")
        projections = JS[start:end]
        for field in ("ten_god_detail", "shensha_by_pillar", "palaces", "planets",
                      "aspects", "cross", "yi", "ji"):
            self.assertIn(field, projections, f"Board 投影未读取核心字段 {field}")
        for forbidden in ("<button", "<input", "onclick=", "data-q=", "addEventListener"):
            self.assertNotIn(forbidden, projections, f"Board 投影含交互元素 {forbidden}")

    def test_session_boundary_is_page_epoch(self):
        """v127：会话边界=本次打开页面。快照必须带内存 epoch + token，恢复时校验，
        刷新（新 epoch）即丢弃旧对话——绝不能把上次打开的对话串进当前功能页。"""
        self.assertIn("pageEpoch", JS, "缺少页面 epoch（本次打开页面的会话身份）")
        self.assertIn("snap.pageEpoch !== S.pageEpoch", JS, "恢复时未校验 epoch，刷新会串旧对话")
        self.assertIn("snap.profileToken !== tokenNow", JS, "恢复时未校验登录态，换号会串对话")
        # restoreStageSnap 内必须真的删除过期快照，而不是静默 return
        m = re.search(r"function restoreStageSnap\(.*?\n  \}", JS, re.S)
        self.assertIsNotNone(m, "找不到 restoreStageSnap")
        self.assertIn("removeItem(snapKey(feat))", m.group(0), "过期快照未被清除")

    def test_followups_are_inline_paragraphs(self):
        """v127：追问结果内联成问+答段落，不渲染带卡头/展开按钮的独立 .p-ai 卡。"""
        # 追问分支生成 .pf-hist-fu 段落而非 .p-ai 卡
        self.assertIn('isFollow\n      ? \'<div class="pf-hist-fu"', JS, "追问未内联为段落")
        self.assertIn("class=\"pf-fu-q\"", JS, "追问段落缺少「问」标题")
        self.assertIn("class=\"pf-fu-body\"", JS, "追问段落缺少答案容器")
        # 新提问才渲染 .p-ai 卡头；追问走三元分支的 .pf-hist-fu，不再攒独立卡
        m = re.search(r"function streamToUrl\(.*?\n  \}", JS, re.S)
        self.assertIsNotNone(m, "找不到 streamToUrl")
        self.assertIn("isFollow\n      ?", m.group(0), "追问未走独立的内联渲染分支")
        # 存量快照的旧追问卡折叠态要清掉，让「问+答」常开
        self.assertIn("p-ai-folded\", scope).forEach", JS, "存量追问卡折叠态未清理")
        # 归档追问链时优先取内联段落 HTML，而不是旧 .p-ai-body 提取
        am = re.search(r"function archiveRound\(.*?\n  \}", JS, re.S)
        self.assertIsNotNone(am)
        self.assertIn('classList.contains("pf-hist-fu")', am.group(0), "归档未识别内联追问段落")


if __name__ == "__main__":
    unittest.main()
