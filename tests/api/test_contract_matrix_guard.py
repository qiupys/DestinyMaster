"""契约矩阵护栏：测试覆盖跟着功能注册表走，新增功能不能悄悄逃出测试矩阵。

contracts.json 是「功能 × 场景 × 不变量」的单一事实源；它必须与 reading-core.js
的 FEATURES 注册表严格对齐，且每条不变量都要在对应矩阵里有执行点。
"""
from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONTRACT = json.loads((ROOT / "tests" / "contracts.json").read_text(encoding="utf-8"))
CORE = (ROOT / "web" / "reading-core.js").read_text(encoding="utf-8")
CHAIN = (ROOT / "tests" / "api" / "test_chain_matrix.py").read_text(encoding="utf-8")
MODULE = (ROOT / "tests" / "js" / "test_contract_matrix.js").read_text(encoding="utf-8")
BROWSER = (ROOT / "tests" / "js" / "test_browser_matrix.js").read_text(encoding="utf-8")


def registry_features() -> set[str]:
    block = re.search(r"var FEATURES = \{(.*?)\n  \};", CORE, re.S)
    assert block, "reading-core.js 找不到 FEATURES 注册表"
    return set(re.findall(r"^    ([a-z_]+):\s*\{", block.group(1), re.M))


class TestContractMatrixGuard(unittest.TestCase):
    def test_contract_covers_every_registered_feature(self):
        self.assertEqual(set(CONTRACT["features"]), registry_features(),
                         "契约功能集与 FEATURES 注册表不一致（新增功能必须登记 contracts.json）")

    def test_every_feature_has_module_chain_browser_recipe(self):
        for feature, spec in CONTRACT["features"].items():
            with self.subTest(feature=feature):
                self.assertTrue(spec.get("api") and (spec["api"].get("calc_params") or spec["api"].get("chart_params")),
                                f"{feature} 缺少 API 链路参数")
                self.assertTrue(spec.get("ui", {}).get("route") and spec["ui"].get("ask"),
                                f"{feature} 缺少浏览器驱动配方")
                if spec["api"].get("calc_params"):
                    self.assertTrue(spec["api"].get("identity_param"), f"{feature} 缺少盘面身份变化参数")

    def test_in_process_skips_are_covered_by_browser_chain(self):
        """紫微等不能在进程内 TestClient 跑的功能，必须在真实 HTTP 浏览器矩阵里覆盖。"""
        for feature, spec in CONTRACT["features"].items():
            if spec["api"].get("skip_in_process"):
                with self.subTest(feature=feature):
                    # 浏览器矩阵由 CONTRACT 生成，不会在源码里写死功能名
                    self.assertIn("Object.keys(CONTRACT.features)", BROWSER,
                                  "浏览器矩阵未从契约生成，跳过的进程内功能可能漏测")
                    self.assertTrue(spec.get("ui", {}).get("ask"))

    def test_every_declared_invariant_has_execution_point(self):
        sources = {"module": MODULE, "chain": CHAIN, "browser": BROWSER}
        for layer, names in CONTRACT["invariants"].items():
            for name in names:
                with self.subTest(layer=layer, invariant=name):
                    self.assertIn(name, sources[layer],
                                  f"不变量 {layer}/{name} 已声明但没有矩阵执行点")

    def test_no_feature_specific_matrix_test_files(self):
        """矩阵必须靠数据驱动；不允许给某个功能单独再写一套测试文件。"""
        names = [p.name for p in (ROOT / "tests" / "api").glob("test_*_matrix.py")]
        self.assertEqual(names, ["test_chain_matrix.py"], names)


if __name__ == "__main__":
    unittest.main()
