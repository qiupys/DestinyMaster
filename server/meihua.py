"""梅花易数起卦引擎：确定性计算（可逐步复核），AI 解读由 ai.py 负责。

起卦法（严格对齐传统规则）：
- 时间起卦：农历(年+月+日) ÷8 取余定上卦，(+时辰数) ÷8 定下卦，总和 ÷6 定动爻。
- 数字起卦：两个数分别 ÷8 定上下卦，和 ÷6 定动爻。
- 随机起卦：随机两数，同数字法。
- 手动起卦：用户直接选上卦/下卦/动爻。
先天八卦数：乾1 兑2 离3 震4 巽5 坎6 艮7 坤8（余0按8/6计）。
"""
from __future__ import annotations

import random
import hashlib
import time as _time
from datetime import datetime

# 先天八卦数 → (卦名, 卦象, 五行, 三爻阴阳列表[初→三], 1阳0阴)
XIAN_TIAN = {
    1: ("乾", "☰", "金", [1, 1, 1]),
    2: ("兑", "☱", "金", [1, 1, 0]),
    3: ("离", "☲", "火", [1, 0, 1]),
    4: ("震", "☳", "木", [1, 0, 0]),
    5: ("巽", "☴", "木", [0, 1, 1]),
    6: ("坎", "☵", "水", [0, 1, 0]),
    7: ("艮", "☶", "土", [0, 0, 1]),
    8: ("坤", "☷", "土", [0, 0, 0]),
}
NAME2NUM = {v[0]: k for k, v in XIAN_TIAN.items()}
# (三爻阴阳 tuple) → 先天卦数，用于爻变后反查
YAOS2NUM = {tuple(v[3]): k for k, v in XIAN_TIAN.items()}

# 文王六十四卦：按 (上卦, 下卦) 查 (序号, 全名)。人工核校的标准对照表。
KINGWEN: dict[tuple[str, str], tuple[int, str]] = {}


def _load_kingwen() -> None:
    # 每行 = 固定上卦，8 列依次为下卦 乾兑离震巽坎艮坤
    table = {
        "乾": [(1,"乾为天"),(10,"天泽履"),(13,"天火同人"),(25,"天雷无妄"),
               (44,"天风姤"),(6,"天水讼"),(33,"天山遁"),(12,"天地否")],
        "兑": [(43,"泽天夬"),(58,"兑为泽"),(49,"泽火革"),(17,"泽雷随"),
               (28,"泽风大过"),(47,"泽水困"),(31,"泽山咸"),(45,"泽地萃")],
        "离": [(14,"火天大有"),(38,"火泽睽"),(30,"离为火"),(21,"火雷噬嗑"),
               (50,"火风鼎"),(64,"火水未济"),(56,"火山旅"),(35,"火地晋")],
        "震": [(34,"雷天大壮"),(54,"雷泽归妹"),(55,"雷火丰"),(51,"震为雷"),
               (32,"雷风恒"),(40,"雷水解"),(62,"雷山小过"),(16,"雷地豫")],
        "巽": [(9,"风天小畜"),(61,"风泽中孚"),(37,"风火家人"),(42,"风雷益"),
               (57,"巽为风"),(59,"风水涣"),(53,"风山渐"),(20,"风地观")],
        "坎": [(5,"水天需"),(60,"水泽节"),(63,"水火既济"),(3,"水雷屯"),
               (48,"水风井"),(29,"坎为水"),(39,"水山蹇"),(8,"水地比")],
        "艮": [(26,"山天大畜"),(41,"山泽损"),(22,"山火贲"),(27,"山雷颐"),
               (18,"山风蛊"),(4,"山水蒙"),(52,"艮为山"),(23,"山地剥")],
        "坤": [(11,"地天泰"),(19,"地泽临"),(36,"地火明夷"),(24,"地雷复"),
               (46,"地风升"),(7,"地水师"),(15,"地山谦"),(2,"坤为地")],
    }
    order = ["乾", "兑", "离", "震", "巽", "坎", "艮", "坤"]
    for up, row in table.items():
        for lo, val in zip(order, row):
            KINGWEN[(up, lo)] = val


_load_kingwen()

BRANCH_HOUR = {"子":1,"丑":2,"寅":3,"卯":4,"辰":5,"巳":6,
               "午":7,"未":8,"申":9,"酉":10,"戌":11,"亥":12}
BRANCHES = "子丑寅卯辰巳午未申酉戌亥"


def _hour_branch(hour: int) -> str:
    return BRANCHES[((hour + 1) // 2) % 12]


def _lunar_ymd(dt: datetime) -> tuple[int, int, int, str, str]:
    """返回 (年支序数, 农历月, 农历日, 时辰地支, 年干支)。

    梅花时间起卦用「年支序数」(子1丑2…亥12)，不是公历/农历年份数字——
    这是参考站与传统梅花易数一致的标准口径。年支以立春为界(getYearZhi)。
    """
    try:
        from lunar_python import Solar
        lunar = Solar.fromYmdHms(dt.year, dt.month, dt.day, dt.hour, dt.minute, 0).getLunar()
        year_zhi = lunar.getYearZhi()
        year_num = BRANCH_HOUR.get(year_zhi, 1)  # 地支→序数(子1…亥12)
        return year_num, abs(lunar.getMonth()), lunar.getDay(), _hour_branch(dt.hour), lunar.getYearInGanZhi()
    except Exception:
        return 1, dt.month, dt.day, _hour_branch(dt.hour), ""


def _mod(n: int, mod: int) -> int:
    r = n % mod
    return mod if r == 0 else r


def _flip_gua(gua_num: int, yao_pos: int) -> int:
    """翻转某卦（先天数）的第 yao_pos 爻（0-based，从初爻算），返回新卦先天数。"""
    yaos = list(XIAN_TIAN[gua_num][3])
    yaos[yao_pos] = 1 - yaos[yao_pos]
    return YAOS2NUM[tuple(yaos)]


def _yao_text(yang: int) -> str:
    return "▬▬▬▬▬" if yang else "▬▬ ▬▬"


def _yao_pos_name(pos: int, yang: int) -> str:
    """动爻标准爻称：阳爻用'九'、阴爻用'六'，配初/二…五/上。如第5爻阳爻→'九五'。"""
    prefix = "九" if yang else "六"
    place = {1: "初", 6: "上"}.get(pos, {2: "二", 3: "三", 4: "四", 5: "五"}.get(pos, str(pos)))
    return prefix + place


def derive(method: str, num1: int | None = None, num2: int | None = None,
           upper: str | None = None, lower: str | None = None, moving: int | None = None,
           when: datetime | None = None, question: str | None = None) -> dict:
    """返回确定性起卦结果（含逐步推导步骤，可复核）。

    question 仅参与「随机起卦」：所问之事与当下时刻、随机源共同作为变量起数，
    问题不是唯一决定因素——同一问题在不同时刻起卦仍会得到不同的卦。
    num1/num2 同时在随机分支作为「锁定回放」入口：前端把 calc 已确定的两数回传，
    保证 AI 解读时复用的是用户看到的那一卦。
    """
    steps: list[str] = []
    when = when or datetime.now()

    if method == "manual":
        if upper not in NAME2NUM or lower not in NAME2NUM or not (1 <= (moving or 0) <= 6):
            raise ValueError("手动起卦需提供有效的上卦/下卦与动爻(1-6)")
        up_n, lo_n = NAME2NUM[upper], NAME2NUM[lower]
        steps.append(f"手动指定：上卦{upper}({up_n})、下卦{lower}({lo_n})、动爻{moving}")
    elif method == "time":
        yn, lm, ld, branch, gz = _lunar_ymd(when)
        year_zhi = gz[-1] if gz else branch  # 年支（丙午年的「午」）
        bh = BRANCH_HOUR[branch]
        total = yn + lm + ld
        up_n = _mod(total, 8)
        total2 = total + bh
        lo_n = _mod(total2, 8)
        moving = _mod(total2, 6)
        steps.append(f"农历{gz}年（年支{year_zhi}，序数{yn}）{lm}月{ld}日 {branch}时（时辰序数{bh}）")
        steps.append(f"上卦=({yn}+{lm}+{ld})÷8 余{up_n} → {XIAN_TIAN[up_n][0]}")
        steps.append(f"下卦=({yn}+{lm}+{ld}+{bh})÷8 余{lo_n} → {XIAN_TIAN[lo_n][0]}")
        steps.append(f"动爻=({yn}+{lm}+{ld}+{bh})÷6 余{moving}")
        steps.append("注：年数以立春为界的年支序数计，非公历年份；时辰以本地时间换算，不做真太阳时校正")
    elif method in ("number", "random"):
        if method == "random":
            # 问题参与起卦，但不是唯一变量：问题 + 当前纳秒时刻 + 系统随机源共同哈希成种子。
            # 同一问题在不同时刻/不同随机序仍是不同的卦；问题改变了种子也必然改变。
            if question:
                seed_material = f"{question}|{_time.time_ns()}|{random.getrandbits(64)}"
                digest = hashlib.sha256(seed_material.encode("utf-8")).digest()
                sub = random.Random(int.from_bytes(digest, "big"))
                num1, num2 = sub.randint(1, 99), sub.randint(1, 99)
                steps.append(f"依所问之事「{question}」并参合当下机缘起数：{num1}、{num2}")
            else:
                num1, num2 = random.randint(1, 99), random.randint(1, 99)
                steps.append(f"随机得数：{num1}、{num2}")
        else:
            steps.append(f"用户输入数：第一数{num1}、第二数{num2}")
        if num1 is None or num2 is None:
            raise ValueError("数字起卦需提供两个数")
        # 约定：第一个数字取下卦，第二个数字取上卦（与参考站一致，动爻以两数之和计）
        up_n, lo_n = _mod(int(num2), 8), _mod(int(num1), 8)
        moving = _mod(int(num1) + int(num2), 6)
        steps.append(f"下卦=第一数{num1}÷8 余{lo_n} → {XIAN_TIAN[lo_n][0]}")
        steps.append(f"上卦=第二数{num2}÷8 余{up_n} → {XIAN_TIAN[up_n][0]}")
        steps.append(f"动爻=({num1}+{num2})÷6 余{moving}")
    else:
        raise ValueError(f"未知起卦方式：{method}")

    up, lo = XIAN_TIAN[up_n], XIAN_TIAN[lo_n]
    ben_idx, ben_name = KINGWEN.get((up[0], lo[0]), (0, f"{up[0]}{lo[0]}"))
    # 变卦：动爻1-3在下卦，4-6在上卦；翻转该爻
    lo_yaos, up_yaos = list(lo[3]), list(up[3])
    if moving <= 3:
        new_lo_n = _flip_gua(lo_n, moving - 1)
        new_up_n = up_n
    else:
        new_lo_n = lo_n
        new_up_n = _flip_gua(up_n, moving - 4)
    bian_idx, bian_name = KINGWEN.get(
        (XIAN_TIAN[new_up_n][0], XIAN_TIAN[new_lo_n][0]), (0, "—")
    )
    bian_up, bian_lo = XIAN_TIAN[new_up_n], XIAN_TIAN[new_lo_n]

    # 六爻自下而上：下卦初→三，上卦四→上；动爻标记
    all_yaos = lo_yaos + up_yaos

    # 互卦：取本卦 2,3,4 爻为下卦、3,4,5 爻为上卦（爻位自下而上）
    hu_up_n = YAOS2NUM[tuple(all_yaos[2:5])]
    hu_lo_n = YAOS2NUM[tuple(all_yaos[1:4])]
    hu_up, hu_lo = XIAN_TIAN[hu_up_n], XIAN_TIAN[hu_lo_n]
    hu_idx, hu_name = KINGWEN.get((hu_up[0], hu_lo[0]), (0, f"{hu_up[0]}{hu_lo[0]}"))
    lines = []
    for i, y in enumerate(all_yaos, 1):
        pos = "初" if i == 1 else ("上" if i == 6 else str(i))
        lines.append(f"{pos}爻 {_yao_text(y)}{'　← 动爻' if i == moving else ''}")

    fact = (
        f"本卦：第{ben_idx}卦 {ben_name}（上{up[0]}下{lo[0]}，"
        f"{up[2]}/{lo[2]}）\n"
        f"互卦：第{hu_idx}卦 {hu_name}（上{hu_up[0]}下{hu_lo[0]}）\n"
        f"动爻：第{moving}爻\n"
        f"变卦：第{bian_idx}卦 {bian_name}（上{bian_up[0]}下{bian_lo[0]}）\n"
        f"六爻（自下而上）：\n" + "\n".join(lines)
    )
    return {
        "method": method, "when": when.strftime("%Y-%m-%d %H:%M"),
        # 起卦数回传：随机起卦时前端据此锁定，deduce 以 num1/num2 走「数字起卦」复现同一卦
        "num1": num1, "num2": num2,
        "upper": {"num": up_n, "name": up[0], "symbol": up[1], "wuxing": up[2]},
        "lower": {"num": lo_n, "name": lo[0], "symbol": lo[1], "wuxing": lo[2]},
        "ben_gua": {"index": ben_idx, "name": ben_name},
        "moving": moving, "lines": lines,
        "hu_gua": {"index": hu_idx, "name": hu_name,
                   "upper": {"name": hu_up[0], "symbol": hu_up[1]},
                   "lower": {"name": hu_lo[0], "symbol": hu_lo[1]}},
        "bian_gua": {"index": bian_idx, "name": bian_name,
                     "upper": {"name": bian_up[0], "symbol": bian_up[1]},
                     "lower": {"name": bian_lo[0], "symbol": bian_lo[1]}},
        # 六爻明细（自下而上）：供前端画卦象预览（爻线/阴阳/动爻）
        "yaos": [
            {"pos": i + 1, "yang": y == "1", "moving": (i + 1) == moving,
             "bian_yang": (y != "1") if (i + 1) == moving else (y == "1")}
            for i, y in enumerate(all_yaos)
        ],
        "steps": steps,
        # 带上标准爻称（初九/六二…）与"爻辞/卦辞"触发词，让 RAG 精确召回本卦爻辞详解及各家解卦
        "rag_query": f"{up[0]}{lo[0]} {ben_name} 卦辞 爻辞 动爻第{moving}爻 {_yao_pos_name(moving, all_yaos[moving-1])} {bian_name}",
        "rag_extra": [ben_name, up[0], lo[0], _yao_pos_name(moving, all_yaos[moving-1])],
        "rag_primary_idx": ben_idx,  # 本卦序号：RAG 据此精确锁定本卦语料，避免上下卦挤占爻辞
        "fact": fact,
    }
