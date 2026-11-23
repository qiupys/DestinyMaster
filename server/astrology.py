"""占星本命盘引擎：用 Swiss Ephemeris(pyswisseph) 做确定性计算，AI 解读由 ai.py 负责。

输入：出生年月日 + 精确时分 + 出生地经纬度 + 时区（默认东八区）。
输出：太阳/月亮/十大行星落座（含度数、逆行）、上升/中天、Placidus 十二宫宫头、
      主要相位（合/冲/刑/拱/六合），以及可逐步复核的 fact 文本与检索词。

约定：
- 黄道使用回归黄道(tropical)，十二星座每 30°，白羊座起点为春分点(黄经 0)。
- 本地出生时刻 → UT：jd_ut = julday(本地年月日, 小时+分/60 - tz)。
- 宫位制默认 Placidus('P')；高纬度失效时自动回落至整宫制('W')。
- 相位容许度按行星类别给固定值（个人星紧、外行星宽），够用且稳定。
"""
from __future__ import annotations

import math

import swisseph as swe

# ---- 十二星座 ----
SIGNS = [
    {"name": "白羊座", "en": "Aries",      "symbol": "♈", "element": "火", "modality": "基本", "ruler": "火星",   "keywords": "开创、直率、行动力、急躁"},
    {"name": "金牛座", "en": "Taurus",     "symbol": "♉", "element": "土", "modality": "固定", "ruler": "金星",   "keywords": "稳定、感官、固执、务实"},
    {"name": "双子座", "en": "Gemini",     "symbol": "♊", "element": "风", "modality": "变动", "ruler": "水星",   "keywords": "沟通、好奇、多变、机敏"},
    {"name": "巨蟹座", "en": "Cancer",     "symbol": "♋", "element": "水", "modality": "基本", "ruler": "月亮",   "keywords": "滋养、保护、敏感、恋家"},
    {"name": "狮子座", "en": "Leo",        "symbol": "♌", "element": "火", "modality": "固定", "ruler": "太阳",   "keywords": "表现、创造力、自尊、慷慨"},
    {"name": "处女座", "en": "Virgo",      "symbol": "♍", "element": "土", "modality": "变动", "ruler": "水星",   "keywords": "分析、秩序、服务、挑剔"},
    {"name": "天秤座", "en": "Libra",      "symbol": "♎", "element": "风", "modality": "基本", "ruler": "金星",   "keywords": "平衡、关系、审美、犹豫"},
    {"name": "天蝎座", "en": "Scorpio",    "symbol": "♏", "element": "水", "modality": "固定", "ruler": "冥王星", "keywords": "洞察、深度、执念、转化"},
    {"name": "射手座", "en": "Sagittarius","symbol": "♐", "element": "火", "modality": "变动", "ruler": "木星",   "keywords": "探索、理想、坦率、不安"},
    {"name": "摩羯座", "en": "Capricorn",  "symbol": "♑", "element": "土", "modality": "基本", "ruler": "土星",   "keywords": "责任、结构、野心、保守"},
    {"name": "水瓶座", "en": "Aquarius",   "symbol": "♒", "element": "风", "modality": "固定", "ruler": "天王星", "keywords": "独立、前瞻、疏离、革新"},
    {"name": "双鱼座", "en": "Pisces",     "symbol": "♓", "element": "水", "modality": "变动", "ruler": "海王星", "keywords": "同理、想象、迷糊、消融"},
]

# ---- 天体：key -> (中文名, swe 常量, 容许度) ----
PLANETS = [
    ("sun",     "太阳",   swe.SUN,      8),
    ("moon",    "月亮",   swe.MOON,     7),
    ("mercury", "水星",   swe.MERCURY,  5),
    ("venus",   "金星",   swe.VENUS,    5),
    ("mars",    "火星",   swe.MARS,     5),
    ("jupiter", "木星",   swe.JUPITER,  6),
    ("saturn",  "土星",   swe.SATURN,   6),
    ("uranus",  "天王星", swe.URANUS,   5),
    ("neptune", "海王星", swe.NEPTUNE,  5),
    ("pluto",   "冥王星", swe.PLUTO,    5),
    ("north_node", "北交点", swe.MEAN_NODE, 4),
]

# ---- 主要相位：角度 -> (名称, 基调) ----
ASPECTS = [
    (0,   "合相",   "能量融合、彼此强化（吉凶取决于星性）"),
    (180, "对冲",   "对立拉扯、需整合两端"),
    (90,  "刑相",   "紧张摩擦、带来考验与动力"),
    (120, "拱相",   "和谐顺畅、自然助力"),
    (60,  "六合",   "轻微协调、需主动把握的机会"),
]

HOUSE_CUSPS = 12


def _sign_of(lon: float) -> int:
    """黄经 → 星座下标(0=白羊)。"""
    return int(lon // 30) % 12


def _deg_of(lon: float) -> float:
    """黄经 → 星座内度数 0~30。"""
    return lon % 30


def _fmt_deg(v: float) -> str:
    d = int(v)
    m = int(round((v - d) * 60))
    if m == 60:
        d, m = d + 1, 0
    return f"{d}°{m:02d}′"


def _pos_text(lon: float, include_sign: bool = True) -> str:
    """把黄经格式化为「星座 X°Y′」。"""
    s = SIGNS[_sign_of(lon)]
    txt = f"{s['name']} {_fmt_deg(_deg_of(lon))}"
    return txt if include_sign else _fmt_deg(_deg_of(lon))


def _house_of(lon: float, cusps: list[float]) -> int | None:
    """某黄经落在第几宫（1-12）。cusps[0..11] 依次是第 1..12 宫宫头。
    Placidus 宫头可能不连续，用「落在相邻两宫头之间」判断。"""
    if not cusps or len(cusps) < HOUSE_CUSPS:
        return None
    for i in range(HOUSE_CUSPS):
        a, b = cusps[i], cusps[(i + 1) % HOUSE_CUSPS]
        if a <= b:
            if a <= lon < b:
                return i + 1
        else:  # 跨 0° 的宫
            if lon >= a or lon < b:
                return i + 1
    return None


def _aspect_between(lon1: float, lon2: float, orb: int) -> tuple[int, float] | None:
    """返回 (相位角度, 容许差)，无主要相位则 None。"""
    diff = abs(lon1 - lon2) % 360
    if diff > 180:
        diff = 360 - diff
    for angle, _name, _tone in ASPECTS:
        delta = abs(diff - angle)
        if delta <= orb:
            return angle, round(delta, 1)
    return None


def _angle_diff(a: float, b: float) -> float:
    d = abs(a - b) % 360
    return d if d <= 180 else 360 - d


# 常见城市经纬度（东八区中国城市为主），供前端下拉；也允许用户手动输入经纬度
CITIES = [
    {"name": "北京", "lat": 39.9042, "lon": 116.4074, "tz": 8},
    {"name": "上海", "lat": 31.2304, "lon": 121.4737, "tz": 8},
    {"name": "广州", "lat": 23.1291, "lon": 113.2644, "tz": 8},
    {"name": "深圳", "lat": 22.5431, "lon": 114.0579, "tz": 8},
    {"name": "杭州", "lat": 30.2741, "lon": 120.1551, "tz": 8},
    {"name": "成都", "lat": 30.5728, "lon": 104.0668, "tz": 8},
    {"name": "武汉", "lat": 30.5928, "lon": 114.3055, "tz": 8},
    {"name": "西安", "lat": 34.3416, "lon": 108.9398, "tz": 8},
    {"name": "南京", "lat": 32.0603, "lon": 118.7969, "tz": 8},
    {"name": "重庆", "lat": 29.5630, "lon": 106.5516, "tz": 8},
    {"name": "天津", "lat": 39.3434, "lon": 117.3616, "tz": 8},
    {"name": "苏州", "lat": 31.2989, "lon": 120.5853, "tz": 8},
    {"name": "长沙", "lat": 28.2282, "lon": 112.9388, "tz": 8},
    {"name": "郑州", "lat": 34.7466, "lon": 113.6254, "tz": 8},
    {"name": "青岛", "lat": 36.0671, "lon": 120.3826, "tz": 8},
    {"name": "厦门", "lat": 24.4798, "lon": 118.0894, "tz": 8},
    {"name": "昆明", "lat": 25.0389, "lon": 102.7183, "tz": 8},
    {"name": "香港", "lat": 22.3193, "lon": 114.1694, "tz": 8},
    {"name": "台北", "lat": 25.0330, "lon": 121.5654, "tz": 8},
    {"name": "新加坡", "lat": 1.3521, "lon": 103.8198, "tz": 8},
]


def city_lookup(name: str) -> dict | None:
    if not name:
        return None
    name = name.strip()
    for c in CITIES:
        if c["name"] == name or name in c["name"] or c["name"] in name:
            return c
    return None


def sun_sign(month: int, day: int) -> dict:
    """仅凭公历月日算太阳星座（供塔罗从档案生日取星座用，不依赖星历库）。

    每项 = (该星座起始日含当天, SIGNS 下标)。摩羯跨年，1/1–1/19 归摩羯。
    """
    starts = [
        ((1, 20), 10),   # 水瓶 1/20–2/18
        ((2, 19), 11),   # 双鱼 2/19–3/20
        ((3, 21), 0),    # 白羊 3/21–4/19
        ((4, 20), 1),    # 金牛 4/20–5/20
        ((5, 21), 2),    # 双子 5/21–6/21
        ((6, 22), 3),    # 巨蟹 6/22–7/22
        ((7, 23), 4),    # 狮子 7/23–8/22
        ((8, 23), 5),    # 处女 8/23–9/22
        ((9, 23), 6),    # 天秤 9/23–10/23
        ((10, 24), 7),   # 天蝎 10/24–11/22
        ((11, 23), 8),   # 射手 11/23–12/21
        ((12, 22), 9),   # 摩羯 12/22–12/31
    ]
    idx = 9  # 默认摩羯（1/1–1/19）
    for (m, d), sign_idx in starts:
        if (month, day) >= (m, d):
            idx = sign_idx
        else:
            break
    return SIGNS[idx]


def derive(year: int, month: int, day: int, hour: int, minute: int = 0,
           lat: float = 39.9042, lon: float = 116.4074, tz: float = 8.0,
           place: str = "") -> dict:
    """计算完整本命盘，返回结构化 payload（含 fact / rag_query / rag_extra）。"""
    if not (1800 <= year <= 2100):
        raise ValueError("年份须在 1800–2100 之间")
    if not (1 <= month <= 12 and 1 <= day <= 31):
        raise ValueError("出生日期无效")
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError("出生时间无效")
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("经纬度无效")
    if not (-12 <= tz <= 14):
        raise ValueError("时区无效（应为 UTC-12 ~ UTC+14）")

    # 本地时刻 → UT 小时（可跨日，julday 会自动处理）
    local_hour = hour + minute / 60.0
    ut_hour = local_hour - tz
    jd_ut = swe.julday(year, month, day, ut_hour, swe.GREG_CAL)

    # 行星位置（含逆行速度）
    planets: list[dict] = []
    for key, name, idx, orb in PLANETS:
        pos, _ret = swe.calc_ut(jd_ut, idx, swe.FLG_SPEED)
        longitude = pos[0] % 360
        speed = pos[3]
        planets.append({
            "key": key, "name": name,
            "lon": round(longitude, 4),
            "sign": SIGNS[_sign_of(longitude)]["name"],
            "sign_en": SIGNS[_sign_of(longitude)]["en"],
            "symbol": SIGNS[_sign_of(longitude)]["symbol"],
            "degree": _fmt_deg(_deg_of(longitude)),
            "retro": bool(speed < 0),
            "orb": orb,
        })

    # 宫位：Placidus 高纬度失效时回落整宫制
    hsys_used = "P"
    cusps, ascmc = swe.houses_ex(jd_ut, lat, lon, hsys_used.encode())
    if not cusps or len(cusps) < HOUSE_CUSPS or any((c or 0) <= 0 for c in cusps[:HOUSE_CUSPS]):
        hsys_used = "W"
        cusps, ascmc = swe.houses_ex(jd_ut, lat, lon, hsys_used.encode())
    cusps = [float(c) % 360 for c in cusps]

    asc_lon = float(ascmc[0]) % 360
    mc_lon = float(ascmc[1]) % 360

    # 给每个行星标宫位
    for p in planets:
        p["house"] = _house_of(p["lon"], cusps)

    houses = []
    for i in range(HOUSE_CUSPS):
        c = cusps[i]
        houses.append({
            "num": i + 1, "lon": round(c, 4),
            "sign": SIGNS[_sign_of(c)]["name"],
            "symbol": SIGNS[_sign_of(c)]["symbol"],
            "degree": _fmt_deg(_deg_of(c)),
        })

    # 主要相位（排除北交点参与，避免噪声；行星两两）
    aspects: list[dict] = []
    body_for_aspect = [p for p in planets if p["key"] != "north_node"]
    for i in range(len(body_for_aspect)):
        for j in range(i + 1, len(body_for_aspect)):
            a, b = body_for_aspect[i], body_for_aspect[j]
            hit = _aspect_between(a["lon"], b["lon"], min(a["orb"], b["orb"]))
            if hit:
                angle, delta = hit
                tone = next(ac[2] for ac in ASPECTS if ac[0] == angle)
                aspects.append({
                    "a": a["name"], "b": b["name"],
                    "angle": angle,
                    "name": next(ac[1] for ac in ASPECTS if ac[0] == angle),
                    "orb": delta, "tone": tone,
                })
    aspects.sort(key=lambda x: (x["angle"], x["orb"]))

    # 元素分布（火土风水）
    elem_count = {"火": 0, "土": 0, "风": 0, "水": 0}
    for p in planets:
        if p["key"] == "north_node":
            continue
        elem_count[SIGNS[_sign_of(p["lon"])]["element"]] += 1

    # ---- fact 文本（AI 解读的确定性盘面，不可更改）----
    place_txt = place or f"({lat:.2f}°N, {lon:.2f}°E)"
    sun = next(p for p in planets if p["key"] == "sun")
    moon = next(p for p in planets if p["key"] == "moon")
    asc = {"sign": SIGNS[_sign_of(asc_lon)]["name"], "symbol": SIGNS[_sign_of(asc_lon)]["symbol"],
           "degree": _fmt_deg(_deg_of(asc_lon))}
    mc = {"sign": SIGNS[_sign_of(mc_lon)]["name"], "symbol": SIGNS[_sign_of(mc_lon)]["symbol"],
          "degree": _fmt_deg(_deg_of(mc_lon))}

    lines = [
        f"出生资料：公历 {year}-{month:02d}-{day:02d} {hour:02d}:{minute:02d}，"
        f"出生地 {place_txt}，时区 UTC{tz:+g}",
        f"☉ 太阳：{sun['sign']} {sun['degree']}（第 {sun['house']} 宫）——核心自我、意志与生命力",
        f"☽ 月亮：{moon['sign']} {moon['degree']}（第 {moon['house']} 宫）——情绪、安全感与内在需求",
        f"↑ 上升：{asc['sign']} {asc['degree']}——外在呈现、人生态度、第一印象",
        f"  中天：{mc['sign']} {mc['degree']}——事业方向与社会角色",
        "",
        "【行星落座】",
    ]
    for p in planets:
        if p["key"] in ("sun", "moon"):
            continue
        retro = "（逆行）" if p["retro"] else ""
        lines.append(f"  {p['name']}：{p['sign']} {p['degree']}，第 {p['house']} 宫{retro}")
    lines += ["", "【十二宫宫头（Placidus 整宫制回退见下）】" if hsys_used == "P" else "【十二宫宫头（整宫制 Whole Sign）】"]
    for h in houses:
        lines.append(f"  第 {h['num']} 宫：{h['sign']} {h['degree']}")
    lines += ["", "【元素分布】" + "、".join(f"{k}{v}" for k, v in elem_count.items())]
    lines += ["", "【主要相位】"]
    if aspects:
        for a in aspects:
            lines.append(f"  {a['a']} {a['name']} {a['b']}（容许 {a['orb']}°）——{a['tone']}")
    else:
        lines.append("  （主要相位较少）")
    facts = "\n".join(lines)

    # RAG 检索词：太阳/月亮/上升星座 + 主要落座行星 + 宫位 + 相位
    rag_primary = [sun["sign"], moon["sign"], asc["sign"]]
    rag_planets = [f"{p['name']}{p['sign']}" for p in planets if p["key"] not in ("sun", "moon", "north_node")]
    rag_aspects = [f"{a['a']}{a['name']}{a['b']}" for a in aspects[:6]]
    rag_query = " ".join(rag_primary + rag_planets + rag_aspects)
    rag_extra = rag_primary + [p["sign"] for p in planets] + [a["name"] for a in aspects]

    return {
        "birth": {"year": year, "month": month, "day": day, "hour": hour, "minute": minute,
                  "lat": lat, "lon": lon, "tz": tz, "place": place_txt},
        "sun": sun, "moon": moon, "asc": asc, "mc": mc,
        "planets": planets, "houses": houses, "aspects": aspects,
        "element": elem_count, "house_system": "Placidus" if hsys_used == "P" else "Whole Sign",
        "fact": facts, "rag_query": rag_query, "rag_extra": rag_extra,
    }
