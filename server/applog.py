"""全模块共享的最小日志设施。

为什么需要它：项目此前有多处 ``except Exception: pass`` —— 异常被静默吞掉，
既不影响用户提示、也不进任何日志，导致「盘面算错/锁盘失败/数据没写入」这类
严重问题在黑暗中发生，无从排查。容错降级可以保留，但必须留痕。

用法：
    from applog import log
    except Exception:
        log.warning("紫微运限 node 调用失败，降级为空", exc_info=True)

日志默认写 stderr（systemd journal 自动收集），不写敏感信息：调用方只传
固定的场景标签与异常类型，禁止把问题文本/出生信息/token 拼进日志。
"""
from __future__ import annotations

import logging
import sys

log = logging.getLogger("destiny")
if not log.handlers:
    _handler = logging.StreamHandler(sys.stderr)
    _handler.setFormatter(logging.Formatter(
        "%(asctime)s %(levelname)s [%(name)s] %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    ))
    log.addHandler(_handler)
    log.setLevel(logging.INFO)
    log.propagate = False
