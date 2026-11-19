"""py-iztro 排盘 + iztro(node) 运限，统一归一化为 camelCase JSON。"""
from __future__ import annotations

import inspect
import json
import re
import subprocess
from datetime import date
from pathlib import Path

from py_iztro import Astro

BASE = Path(__file__).resolve().parent.parent
# node 可执行文件：环境变量 ZIWEI_NODE 优先，其次 PATH，最后本机 WorkBuddy 托管版本
import os
import shutil as _shutil
NODE = os.environ.get("ZIWEI_NODE") or _shutil.which("node") \
    or "/Users/pengyu/.workbuddy/binaries/node/versions/22.12.0/bin/node"

_astro = Astro()

# py-iztro 底层抛出的农历错误，如 "only 30 days in lunar year 2026 month 10"
_LUNAR_DAYS = re.compile(r"only (\d+) days in lunar year (\d+) month (\d+)", re.I)


def _friendly_chart_error(e: Exception) -> str:
    m = _LUNAR_DAYS.search(str(e))
    if m:
        days, y, mo = m.group(1), m.group(2), m.group(3)
        return f"农历 {y} 年 {mo} 月只有 {days} 天，所选日期不存在，请核对后重试"
    return "排盘失败：日期可能超出支持范围（约 1900–2100 年），请核对后重试"


def _snake_to_camel(s: str) -> str:
    parts = s.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


def _normalize(obj):
    """递归把 py-iztro 的 snake_case 键转为 iztro 原生 camelCase 风格。"""
    if isinstance(obj, dict):
        return {_snake_to_camel(k): _normalize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_normalize(x) for x in obj]
    return obj


def _get_horoscope(solar_date: str, time_index: int, gender: str, fix_leap: bool,
                   date_iso: str | None = None):
    """调用 node + iztro 获取点查询运限（大限/流年/流月/流日）；date_iso 缺省为今天。"""
    script = BASE / "server" / "horoscope.js"
    cmd = [NODE, str(script), solar_date, str(time_index), gender,
           "true" if fix_leap else "false"]
    if date_iso:
        cmd.append(date_iso)
    try:
        out = subprocess.run(cmd, cwd=str(BASE), capture_output=True, text=True, timeout=20)
        if out.returncode == 0 and out.stdout.strip():
            return _normalize(json.loads(out.stdout))
    except Exception:
        pass
    return None


def _get_horoscope_mode(b: dict, mode: str, arg: str) -> dict | None:
    """调用 node + iztro 获取整年/整月运限。

    历法口径（horoscope.js 内实现）：
    - 流年以立春为界，附带公历起讫 solarRange；
    - 流月以节气为界，--ym 返回覆盖整个公历月的 1~2 张流月盘（monthlies）；
    - --year 额外返回年初尾盘 yearlyTail（1月1日~立春前，属上一流年）；
    - 大限 range 为虚岁，附带换算后的约公历区间。
    """
    script = BASE / "server" / "horoscope.js"
    cmd = [NODE, str(script), b["date"], str(b["timeIndex"]), b["gender"],
           "true" if b["fixLeap"] else "false", mode, arg]
    try:
        out = subprocess.run(cmd, cwd=str(BASE), capture_output=True, text=True, timeout=30)
        if out.returncode == 0 and out.stdout.strip():
            return _normalize(json.loads(out.stdout))
    except Exception:
        pass
    return None


def horoscope_for(chart: dict, year: int, month: int | None = None) -> dict | None:
    """基于已排命盘的出生信息，计算指定年份/月份的运限（立春界流年、节气月流月）。

    month=None：--year 模式，返回 {decadal, yearly, yearlyTail, lichun}；
    month 给定：--ym 模式，另含覆盖该公历月的流月盘列表 monthlies。
    返回结构已抹平为与点查询一致的键（monthly 取第一张盘，monthlyAlt 为第二张）。
    """
    b = chart.get("birth") or {}
    if not b:
        return None
    raw = _get_horoscope_mode(b, "--ym" if month else "--year",
                              f"{year}-{month}" if month else str(year))
    if not raw:
        return None
    horo = {
        "date": raw.get("date"),
        "lichun": raw.get("lichun"),
        "decadal": raw.get("decadal"),
        "yearly": raw.get("yearly"),
        "yearlyTail": raw.get("yearlyTail"),
    }
    monthlies = raw.get("monthlies") or []
    if monthlies:
        horo["monthly"] = monthlies[0]
        if len(monthlies) > 1:
            horo["monthlyAlt"] = monthlies[1]
    return horo


def get_chart(payload) -> dict:
    if hasattr(payload, "model_dump"):
        d = payload.model_dump()
    elif hasattr(payload, "_asdict"):
        d = payload._asdict()
    else:
        d = dict(payload.__dict__) if hasattr(payload, "__dict__") else dict(payload)
    date_str: str = d["date"]
    time_index: int = int(d["timeIndex"])
    gender: str = d["gender"]
    fix_leap: bool = bool(d.get("fixLeap", True))
    calendar: str = d.get("calendar", "solar")

    # 校验日期
    try:
        y, m, dd = (int(x) for x in date_str.split("-"))
        date(y, m, dd)
    except Exception:
        raise ValueError("日期格式应为 YYYY-M-D，例如 2000-8-16")
    if not 0 <= time_index <= 12:
        raise ValueError("时辰序号需在 0~12 之间")
    if gender not in ("男", "女"):
        raise ValueError("性别需为 男 或 女")

    try:
        if calendar == "lunar":
            sig = inspect.signature(_astro.by_lunar)
            params = list(sig.parameters)
            # py-iztro 不同版本参数顺序可能不同，这里按参数名取值
            kwargs = {}
            for p in params:
                if p == "lunar_date_str" or p == "lunar_date":
                    kwargs[p] = date_str
                elif p in ("time_index", "timeIndex"):
                    kwargs[p] = time_index
                elif p == "gender":
                    kwargs[p] = gender
                elif p == "fix_leap" or p == "fixLeap":
                    kwargs[p] = fix_leap
            r = _astro.by_lunar(**kwargs)
        else:
            r = _astro.by_solar(date_str, time_index, gender, fix_leap, "zh-CN")
    except ValueError:
        raise
    except Exception as e:
        raise ValueError(_friendly_chart_error(e)) from e

    chart = _normalize(r.model_dump())
    chart["calendar"] = calendar
    chart["inputTimeIndex"] = time_index
    # 缓存出生参数，供后续按年份计算运限
    chart["birth"] = {"date": date_str, "timeIndex": time_index,
                      "gender": gender, "fixLeap": fix_leap}

    horo = _get_horoscope(date_str, time_index, gender, fix_leap)
    if horo:
        chart["horoscope"] = horo
    return chart
