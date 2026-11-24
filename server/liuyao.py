"""六爻排盘引擎：确定性装卦（可逐步复核），AI 解读由 ai.py 负责。

起卦法：
- coin：六次三枚铜钱（6=老阴动、7=少阳、8=少阴、9=老阳动，自下而上）；
  不传 coins 则用「问题 + 当下时刻 + 随机源」派生（问题参与但非唯一变量）。
- time：传统年月日时起卦（年支序数+农历月+日 ÷8 取上卦，加时辰数 ÷8 取下卦，
  总数 ÷6 取动爻；余 0 按 8/6）。
- number：第一数取下卦、第二数取上卦，两数和 ÷6 取动爻（先天八卦数）。
- random：问题+时刻+随机源派生两数，再走 number。
- manual：必须传 yaos；且任何方法只要传 yaos 都直接装卦 —— 前端「看到的卦
  == 解读的卦」即由此锁定。

规则依据：docs/kb/liuyao/（纳甲口诀、六亲、六神、世应），
六十四卦名与序号复用 meihua.KINGWEN，纳甲干支装配遵循「阳卦顺行、阴卦逆行」。
"""
from __future__ import annotations

import hashlib
import random
import time as _time
from datetime import datetime

import meihua

BRANCHES = meihua.BRANCHES                 # 子丑寅卯辰巳午未申酉戌亥
BRANCH_HOUR = meihua.BRANCH_HOUR
XIAN_TIAN = meihua.XIAN_TIAN               # 先天数 → (卦名, 符号, 五行, 三爻[初→三])
YAOS2NUM = meihua.YAOS2NUM
KINGWEN = meihua.KINGWEN                   # (上卦, 下卦) → (序号, 全名)
NAME2NUM = meihua.NAME2NUM

VALID_YAO = (6, 7, 8, 9)
YAO_NAMES = ("初爻", "二爻", "三爻", "四爻", "五爻", "上爻")
YAO_POS = ("初", "二", "三", "四", "五", "上")

# 地支五行（与 bazi.py 一致）
ZHI_WUXING = dict(zip(BRANCHES, ["水", "土", "木", "木", "土", "火",
                                 "火", "土", "金", "金", "土", "水"]))
SHENG = {"木": "火", "火": "土", "土": "金", "金": "水", "水": "木"}
KE = {"木": "土", "土": "水", "水": "火", "火": "金", "金": "木"}

# 八宫：乾坎艮震巽离坤兑，五行依次为 金水木木火土土金
PALACES = (
    ("乾", "金"), ("坎", "水"), ("艮", "土"), ("震", "木"),
    ("巽", "木"), ("离", "火"), ("坤", "土"), ("兑", "金"),
)
PALACE_TYPES = ("本宫", "一世", "二世", "三世", "四世", "五世", "游魂", "归魂")
PALACE_SHI = (6, 1, 2, 3, 4, 5, 4, 3)      # 本宫世六、一世世初…五世世五、游魂世四、归魂世三

# 纳甲口诀：乾甲子外壬午、坎戊寅外戊申、艮丙辰外丙戌、震庚子外庚午、
#           巽辛丑外辛未、离己卯外己酉、坤乙未外癸丑、兑丁巳外丁亥。
# 每项 = (内干, 初爻支, 顺逆, 外干, 四爻支, 顺逆)；+2 隔位顺行、-2 隔位逆行
NAJIA = {
    "乾": ("甲", "子", +2, "壬", "午", +2),
    "坎": ("戊", "寅", +2, "戊", "申", +2),
    "艮": ("丙", "辰", +2, "丙", "戌", +2),
    "震": ("庚", "子", +2, "庚", "午", +2),
    "巽": ("辛", "丑", -2, "辛", "未", -2),
    "离": ("己", "卯", -2, "己", "酉", -2),
    "坤": ("乙", "未", -2, "癸", "丑", -2),
    "兑": ("丁", "巳", -2, "丁", "亥", -2),
}

# 六神次序固定，起排由日干定：甲乙青龙、丙丁朱雀、戊勾陈、己螣蛇、庚辛白虎、壬癸玄武
LIUSHEN = ("青龙", "朱雀", "勾陈", "螣蛇", "白虎", "玄武")
LIUSHEN_START = {"甲": 0, "乙": 0, "丙": 1, "丁": 1, "戊": 2, "己": 3,
                 "庚": 4, "辛": 4, "壬": 5, "癸": 5}


def _flip(bits, pos):
    out = list(bits)
    out[pos - 1] ^= 1
    return tuple(out)


def _trigram_name(bits3):
    return XIAN_TIAN[YAOS2NUM[tuple(bits3)]][0]


def _build_gua_info():
    """由八纯卦按京房八宫变卦次序程序化生成 64 卦 → 卦宫/五行/卦型/世应。"""
    info = {}
    for gong, wx in PALACES:
        base = tuple(XIAN_TIAN[NAME2NUM[gong]][3]) * 2
        g = base
        for k, (typ, shi) in enumerate(zip(PALACE_TYPES, PALACE_SHI)):
            if k > 0:
                if typ == "游魂":
                    g = _flip(g, 4)
                elif typ == "归魂":
                    for p in (1, 2, 3):
                        g = _flip(g, p)
                else:
                    g = _flip(g, k)
            if g in info:
                raise RuntimeError(f"八宫卦映射冲突：{g}")
            info[g] = {
                "gong": gong, "gong_wuxing": wx, "type": typ,
                "shi": shi, "ying": shi + 3 if shi <= 3 else shi - 3,
            }
    if len(info) != 64:
        raise RuntimeError(f"八宫卦映射未覆盖 64 卦：仅 {len(info)} 卦")
    return info


GUA_INFO = _build_gua_info()


def _mod(n, mod):
    r = n % mod
    return mod if r == 0 else r


def _hour_branch(hour):
    return BRANCHES[((hour + 1) // 2) % 12]


def _lunar_context(when):
    """月建（节气月支）、日辰干支、旬空均取 lunar-python 的 Lunar 接口。"""
    from lunar_python import Solar
    lunar = Solar.fromYmdHms(when.year, when.month, when.day,
                             when.hour, when.minute, 0).getLunar()
    return {
        "year_zhi": lunar.getYearZhi(),        # 立春为界，供时间起卦取年支序数
        "lunar_month": abs(lunar.getMonth()),   # 闰月为负，取绝对值
        "lunar_day": lunar.getDay(),
        "hour_branch": _hour_branch(when.hour),
        "yuejian": lunar.getMonthZhi(),         # 节气月支（月建）
        "richen": lunar.getDayInGanZhi(),       # 日辰干支
        "xunkong": lunar.getDayXunKong(),       # 旬空地支，如「辰巳」
    }


def _yaos_from_trigrams(up_n, lo_n, moving):
    """时间/数字/随机起卦：由上下卦与动爻生成 6/7/8/9（自下而上）。
    动爻处阳爻记老阳9、阴爻记老阴6；其余阳7阴8。"""
    bits = list(XIAN_TIAN[lo_n][3]) + list(XIAN_TIAN[up_n][3])
    return [(9 if b else 6) if i == moving else (7 if b else 8)
            for i, b in enumerate(bits, 1)]


def _numbers_to_yaos(n1, n2):
    lo_n, up_n = _mod(n1, 8), _mod(n2, 8)
    moving = _mod(n1 + n2, 6)
    return _yaos_from_trigrams(up_n, lo_n, moving), up_n, lo_n, moving


def _bits_from_values(yaos):
    return tuple(1 if v in (7, 9) else 0 for v in yaos)  # 6/8 阴，7/9 阳


def _najia(upper_name, lower_name):
    """按上下卦分别装初~三、四~上爻的 (天干, 地支)，共 6 组。"""
    out = []
    for trig, start in ((lower_name, 0), (upper_name, 3)):
        nei_gan, nei_zhi, d1, wai_gan, wai_zhi, d2 = NAJIA[trig]
        gan, zhi, d = (nei_gan, nei_zhi, d1) if start == 0 else (wai_gan, wai_zhi, d2)
        base = BRANCHES.index(zhi)
        for k in range(3):
            out.append((gan, BRANCHES[(base + d * k) % 12]))
    return out


def _liuqin(me, other):
    """以卦宫五行为『我』判六亲。"""
    if other == me:
        return "兄弟"
    if SHENG[other] == me:
        return "父母"
    if SHENG[me] == other:
        return "子孙"
    if KE[me] == other:
        return "妻财"
    if KE[other] == me:
        return "官鬼"
    return "—"


def _gua_dict(bits):
    lower, upper = _trigram_name(bits[:3]), _trigram_name(bits[3:])
    idx, name = KINGWEN[(upper, lower)]
    gi = GUA_INFO[bits]
    return {"name": name, "index": idx, "upper": upper, "lower": lower,
            "gong": gi["gong"], "gong_wuxing": gi["gong_wuxing"]}


def _yao_text(yang):
    return "▬▬▬▬▬" if yang else "▬▬ ▬▬"


def derive(method: str = "coin", *, coins: list[int] | None = None,
           num1: int | None = None, num2: int | None = None,
           yaos: list[int] | None = None, when: datetime | None = None,
           question: str | None = None) -> dict:
    """返回确定性六爻盘面（含逐步推导，可复核；fact 为 AI 解读的唯一依据）。

    yaos 一旦提供即直接装卦，忽略 method/coins/num1/num2/question 等起卦参数，
    用于前端锁定「用户看到的那一卦」与 AI 解读的卦完全一致。
    """
    steps = []
    when = when or datetime.now()
    ctx = _lunar_context(when)

    if yaos is not None:
        if (not isinstance(yaos, (list, tuple)) or len(yaos) != 6
                or any(v not in VALID_YAO for v in yaos)):
            raise ValueError("yaos 须为 6 个整数（6老阴/7少阳/8少阴/9老阳），自下而上")
        yaos = [int(v) for v in yaos]
        steps.append(f"yaos 锁定六爻：{''.join(map(str, yaos))}（自下而上），忽略起卦参数直接装卦")
    elif method == "manual":
        raise ValueError("手动起卦需提供 yaos（6 个 6/7/8/9，自下而上）")
    elif method == "coin":
        if coins is not None:
            if len(coins) != 6 or any(v not in VALID_YAO for v in coins):
                raise ValueError("coins 须为 6 次三枚铜钱结果（6/7/8/9）")
            yaos = [int(v) for v in coins]
            steps.append(f"铜钱六掷结果（自下而上）：{','.join(map(str, yaos))}")
        else:
            if question:
                digest = hashlib.sha256(
                    f"{question}|{_time.time_ns()}|{random.getrandbits(64)}".encode("utf-8")
                ).digest()
                sub = random.Random(int.from_bytes(digest, "big"))
                steps.append(f"依所问「{question}」并参合当下时刻与随机源摇卦")
            else:
                sub = random.Random(_time.time_ns() ^ random.getrandbits(64))
                steps.append("以当下时刻与随机源摇卦")
            # 三枚铜钱：阴面记 2、阳面记 3，三枚求和即 6/7/8/9
            yaos = [sum(sub.choice((2, 3)) for _ in range(3)) for _ in range(6)]
            steps.append(f"三枚铜钱六掷（阴2阳3求和，自下而上）：{','.join(map(str, yaos))}")
    elif method == "time":
        ynum = BRANCH_HOUR.get(ctx["year_zhi"], 1)
        lm, ld = ctx["lunar_month"], ctx["lunar_day"]
        bh = BRANCH_HOUR[ctx["hour_branch"]]
        up_n = _mod(ynum + lm + ld, 8)
        total = ynum + lm + ld + bh
        lo_n, moving = _mod(total, 8), _mod(total, 6)
        steps.append(f"农历{ctx['year_zhi']}年（年支序数{ynum}）{lm}月{ld}日 "
                     f"{ctx['hour_branch']}时（时辰序数{bh}）")
        steps.append(f"上卦=({ynum}+{lm}+{ld})÷8 余{up_n} → {XIAN_TIAN[up_n][0]}")
        steps.append(f"下卦=({ynum}+{lm}+{ld}+{bh})÷8 余{lo_n} → {XIAN_TIAN[lo_n][0]}")
        steps.append(f"动爻=({ynum}+{lm}+{ld}+{bh})÷6 余{moving}")
        steps.append("注：年数以立春为界的年支序数计；时辰按本地时间换算，不做真太阳时校正")
        yaos = _yaos_from_trigrams(up_n, lo_n, moving)
    elif method in ("number", "random"):
        if method == "random":
            if question:
                digest = hashlib.sha256(
                    f"{question}|{_time.time_ns()}|{random.getrandbits(64)}".encode("utf-8")
                ).digest()
                sub = random.Random(int.from_bytes(digest, "big"))
                num1, num2 = sub.randint(1, 99), sub.randint(1, 99)
                steps.append(f"依所问「{question}」并参合当下机缘起数：{num1}、{num2}")
            else:
                num1, num2 = random.randint(1, 99), random.randint(1, 99)
                steps.append(f"随机得数：{num1}、{num2}")
        else:
            if num1 is None or num2 is None:
                raise ValueError("数字起卦需提供 num1、num2")
            num1, num2 = int(num1), int(num2)
            steps.append(f"用户输入数：第一数{num1}、第二数{num2}")
        yaos, up_n, lo_n, moving = _numbers_to_yaos(num1, num2)
        steps.append(f"下卦={num1}÷8 余{lo_n} → {XIAN_TIAN[lo_n][0]}")
        steps.append(f"上卦={num2}÷8 余{up_n} → {XIAN_TIAN[up_n][0]}")
        steps.append(f"动爻=({num1}+{num2})÷6 余{moving}")
    else:
        raise ValueError(f"未知起卦方式：{method}")

    deck = "".join(str(v) for v in yaos)
    bits = _bits_from_values(yaos)
    moving_pos = [i + 1 for i, v in enumerate(yaos) if v in (6, 9)]
    bian_bits = tuple(b ^ 1 if v in (6, 9) else b for b, v in zip(bits, yaos))
    ben = _gua_dict(bits)
    bian = _gua_dict(bian_bits) if moving_pos else None
    gi = GUA_INFO[bits]
    shi, ying = gi["shi"], gi["ying"]

    najia = _najia(ben["upper"], ben["lower"])
    day_gan = ctx["richen"][0] if ctx["richen"] else "甲"
    ls_start = LIUSHEN_START.get(day_gan, 0)

    yao_rows = []
    for i, (v, (gan, zhi)) in enumerate(zip(yaos, najia), 1):
        wx = ZHI_WUXING[zhi]
        yao_rows.append({
            "pos": i, "value": v, "yang": v in (7, 9), "moving": v in (6, 9),
            "name": YAO_NAMES[i - 1], "gan": gan, "zhi": zhi, "wuxing": wx,
            "liuqin": _liuqin(gi["gong_wuxing"], wx),
            "liushen": LIUSHEN[(ls_start + i - 1) % 6],
            "shiying": "世" if i == shi else ("应" if i == ying else ""),
        })

    najia_text = "；".join(
        f"{trig} {''.join(g + z for g, z in najia[start:start + 3])}"
        for trig, start in ((ben["lower"], 0), (ben["upper"], 3))
    )
    lq_used = "、".join(dict.fromkeys(r["liuqin"] for r in yao_rows))
    steps.append(f"本卦：上{ben['upper']}下{ben['lower']} → 第{ben['index']}卦 {ben['name']}，"
                 f"{ben['gong']}宫属{ben['gong_wuxing']}，{gi['type']}卦，世{shi}应{ying}")
    steps.append(f"纳甲：{najia_text}")
    steps.append(f"六亲：以{ben['gong']}宫{ben['gong_wuxing']}为『我』 → {lq_used}")
    steps.append(f"六神：日干{day_gan}起{LIUSHEN[ls_start]}，自初爻顺行")
    steps.append(f"月建{ctx['yuejian']}、日辰{ctx['richen']}、旬空{ctx['xunkong']}"
                 "（lunar-python 节气月支/日柱）")

    lines = []
    for row in reversed(yao_rows):
        marks = []
        if row["shiying"]:
            marks.append(row["shiying"])
        if row["moving"]:
            marks.append(f"动({YAO_POS[row['pos']-1]}{'六' if not row['yang'] else '九'}"
                         f"老{'阴' if not row['yang'] else '阳'}→{'阳' if not row['yang'] else '阴'})")
        lines.append(
            f"{row['name']} {_yao_text(row['yang'])} {row['gan']}{row['zhi']}"
            f"({row['wuxing']}) {row['liuqin']} {row['liushen']}"
            + ("　" + " ".join(marks) if marks else "")
        )

    fact_lines = [
        f"起卦：{method}　时间：{when.isoformat(timespec='seconds')}"
        + (f"　所问：{question}" if question else ""),
        f"六爻码：{deck}（自下而上，6老阴动/7少阳/8少阴/9老阳动）",
        f"本卦：第{ben['index']}卦 {ben['name']}（上{ben['upper']}下{ben['lower']}，"
        f"{ben['gong']}宫属{ben['gong_wuxing']}，{gi['type']}卦，世{shi}应{ying}）",
        (f"变卦：第{bian['index']}卦 {bian['name']}（上{bian['upper']}下{bian['lower']}，"
         f"{bian['gong']}宫属{bian['gong_wuxing']}）" if bian else "变卦：无动爻，不变"),
        f"月建：{ctx['yuejian']}（节气月支）　日辰：{ctx['richen']}（日干{day_gan}）　旬空：{ctx['xunkong']}",
        f"纳甲：{najia_text}",
        "六亲以卦宫五行为我：同我兄弟、生我父母、我生子孙、我克妻财、克我官鬼；"
        f"本卦以{ben['gong_wuxing']}为我；六神以日干{day_gan}起，自初爻顺行",
        "六爻明细（自上而下展示；装卦数据自下而上）：",
        *lines,
    ]
    if moving_pos:
        details = []
        for i in moving_pos:
            row = yao_rows[i - 1]
            old = "老阴" if row["value"] == 6 else "老阳"
            new = "阳" if row["value"] == 6 else "阴"
            details.append(f"第{i}爻（{YAO_POS[i-1]}{'六' if not row['yang'] else '九'}，{old}）"
                           f"{row['gan']}{row['zhi']}动→{new}爻")
        fact_lines.append("动爻：" + "；".join(details)
                          + f"，全卦变为第{bian['index']}卦 {bian['name']}")
        steps.append("动爻：" + "、".join(map(str, moving_pos))
                     + f"爻；变卦第{bian['index']}卦 {bian['name']}")
    else:
        fact_lines.append("动爻：无（六爻安静，不变卦）")
        steps.append("无动爻，不变卦")
    fact = "\n".join(fact_lines)

    moving_text = ("动爻第" + "、".join(map(str, moving_pos)) + "爻") if moving_pos else "静卦"
    rag_query = (f"{ben['name']} 六爻 纳甲 卦辞 爻辞 {ben['gong']}宫 "
                 f"六亲 六神 世应 {moving_text} {ben['upper']}{ben['lower']} "
                 f"{ctx['yuejian']}月 {ctx['richen']}日 旬空{ctx['xunkong']}")
    rag_extra = [ben["name"], ben["gong"], ben["gong_wuxing"], ben["upper"], ben["lower"],
                 "六爻", "纳甲", "世应", "六亲", "六神", "月建", "日辰", "旬空"]
    rag_extra += list(dict.fromkeys(r["liuqin"] for r in yao_rows))
    rag_extra += list(dict.fromkeys(r["liushen"] for r in yao_rows))
    if bian:
        rag_extra.append(bian["name"])

    return {
        "method": method,
        "when": when.isoformat(timespec="seconds"),
        "deck": deck,
        "yaos": yao_rows,
        "ben_gua": ben,
        "bian_gua": bian,
        "yuejian": ctx["yuejian"],
        "richen": ctx["richen"],
        "xunkong": ctx["xunkong"],
        "fact": fact,
        "rag_query": rag_query,
        "rag_extra": rag_extra,
        "steps": steps,
    }
