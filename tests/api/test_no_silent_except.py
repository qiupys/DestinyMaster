"""静默吞异常护栏：禁止 except:pass / 空 catch 回潮。

背景（v115）：六爻 deduce 的 deck 锁盘失败被 `except: pass` 吞掉后静默
重新起卦，页面显示巽为风、AI 却解读另一卦。这类「吞掉错误 + 用错数据继续」
是最危险的一类 bug——用户无从察觉、日志也无痕。本护栏把「静默吞异常」
在编码阶段就拦下：容错降级允许，但必须留痕（console.warn / log.warning）。

运行：PYTHONPATH=server:. .venv-dev/bin/python -m unittest discover -s tests/api -p 'test_*.py'
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class TestNoSilentExcept(unittest.TestCase):
    def test_no_bare_except_pass_in_server(self):
        """后端禁止 `except ...: pass`（单行或换行）——留痕是底线。"""
        offenders = []
        for f in sorted((ROOT / "server").rglob("*.py")):
            lines = f.read_text(encoding="utf-8").splitlines()
            for i, line in enumerate(lines):
                if re.match(r"\s*except\b", line):
                    # 允许紧邻注释后 pass 吗？不允许——注释不是留痕。
                    window = [x.strip() for x in lines[i + 1:i + 4] if x.strip()]
                    if window and window[0] == "pass":
                        offenders.append(f"{f.relative_to(ROOT)}:{i + 1}")
        self.assertEqual(offenders, [], f"发现静默吞异常 except:pass：{offenders}")

    def test_no_empty_catch_in_frontend(self):
        """前端禁止空的 `.catch(function(){})` 与 `catch(e){}`。"""
        js = (ROOT / "web" / "portal.js").read_text(encoding="utf-8")
        offenders = []
        # .catch(function () {}) —— 去掉注释行避免误报
        for i, line in enumerate(js.splitlines(), 1):
            code = line.split("//")[0]  # 粗粒度去注释；足够拦住空 catch 字面量
            if re.search(r"\.catch\s*\(\s*function\s*\(\s*\)\s*\{\s*\}\s*\)", code):
                offenders.append(f"portal.js:{i} 空 .catch")
            if re.search(r"catch\s*\(\s*\w+\s*\)\s*\{\s*\}", code):
                offenders.append(f"portal.js:{i} 空 catch(e)")
        self.assertEqual(offenders, [], f"发现静默吞异常空 catch：{offenders}")

    def test_warn_helper_and_applog_exist(self):
        """降级留痕的基础设施必须在位。"""
        js = (ROOT / "web" / "portal.js").read_text(encoding="utf-8")
        self.assertIn("function warn(", js, "前端缺少 warn 留痕工具")
        self.assertTrue((ROOT / "server" / "applog.py").exists(), "后端缺少 applog 日志模块")
