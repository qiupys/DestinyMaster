"""八字排盘：lunar-python 确定性计算四柱 + 十神 + 藏干 + 纳音 + 大运，AI 解读由 ai.py 负责。"""
from __future__ import annotations

from datetime import datetime

GAN_WUXING = dict(zip("甲乙丙丁戊己庚辛壬癸", ["木","木","火","火","土","土","金","金","水","水"]))
GAN_YINYANG = dict(zip("甲乙丙丁戊己庚辛壬癸", ["阳","阴","阳","阴","阳","阴","阳","阴","阳","阴"]))
_GAN = "甲乙丙丁戊己庚辛壬癸"


def liuyue_of_year(year: int) -> list[dict]:
    """该公历年十二个月的流月干支——按每月中旬的真实节气月柱（与八字排盘同源）。

    lunar-python 的 EightChar 月柱由节气精确界定的月支 + 五虎遁年干起月得出，
    取每月 15 日代表该公历月（月中稳在节气之间），保证界面所见与解读所依一致。
    """
    from lunar_python import Solar
    months = []
    for month in range(1, 13):
        try:
            ganzhi = Solar.fromYmdHms(year, month, 15, 12, 0, 0).getLunar().getEightChar().getMonth()
        except Exception:
            ganzhi = ""
        months.append({"month": month, "ganzhi": ganzhi})
    return months


def _solar_to_lunar(year: int, month: int, day: int, hour: int, minute: int = 0):
    from lunar_python import Solar
    try:
        return Solar.fromYmdHms(year, month, day, hour, minute, 0).getLunar()
    except Exception as e:
        # 2 月 30 日等日历上不存在的日期：lunar_python 抛裸 Exception，转成 ValueError 供接口层处理
        raise ValueError(f"出生日期无效：{e}")


def _ten_god(day_gan: str, other_gan: str) -> str:
    """十神：以日主与其他天干的五行生克 + 阴阳同异判定。"""
    if not other_gan:
        return "—"
    dw, ow = GAN_WUXING[day_gan], GAN_WUXING[other_gan]
    same_yy = GAN_YINYANG[day_gan] == GAN_YINYANG[other_gan]
    sheng = {"木":"火","火":"土","土":"金","金":"水","水":"木"}
    ke = {"木":"土","土":"水","水":"火","火":"金","金":"木"}
    if dw == ow:
        return "比肩" if same_yy else "劫财"
    if sheng[dw] == ow:
        return "食神" if same_yy else "伤官"
    if sheng[ow] == dw:
        return "偏印" if same_yy else "正印"
    if ke[dw] == ow:
        return "七杀" if same_yy else "正官"
    if ke[ow] == dw:
        return "偏财" if same_yy else "正财"
    return "—"


ZHI_WUXING = dict(zip("子丑寅卯辰巳午未申酉戌亥",
                      ["水", "土", "木", "木", "土", "火", "火", "土", "金", "金", "土", "水"]))

# 十神释义：传统通识，供八字盘面的「十神分析」卡展示（确定性文本，不依赖 AI）。
TEN_GOD_DESC = {
    "比肩": "与主星同性同气，主自我、独立、协作与分财；过多则固执争竞。",
    "劫财": "与主星同性异气，主行动、争取、竞争与分夺资源；过旺易冲动破财。",
    "食神": "我生而同性，主才艺、口才、享受与生财之源；性温和。",
    "伤官": "我生而异性，主才华、表达、创意与不服约束；过旺易傲气伤官非。",
    "正财": "克我而异性所克（我克之异性），主正当收入、务实、妻财与稳重。",
    "偏财": "我克之同性，主意外之财、机会、慷慨与交际；易得易失。",
    "正官": "克我之异性，主规则、职位、责任与约束；象征事业与名誉。",
    "七杀": "克我之同性，主压力、竞争、魄力与权威；有制则成权，无制为祸。",
    "正印": "生我之异性，主学识、贵人、包容与名誉；护身而有依靠。",
    "偏印": "生我之同性，主偏才、悟性、宗教哲思与孤独；亦名枭神。",
}
# 天干十神与藏干十神共用同一份释义；盘面按柱分别列出主气/中气/余气。

# 神煞表：以日干或三合局定位目标地支（简化常用八种）
SHENSHA_GAN = {
    "天乙贵人": {"甲": "丑未", "戊": "丑未", "庚": "丑未", "乙": "子申", "己": "子申",
                 "丙": "亥酉", "丁": "亥酉", "壬": "巳卯", "癸": "巳卯", "辛": "午寅"},
    "文昌贵人": {"甲": "巳", "乙": "午", "丙": "申", "戊": "申", "丁": "酉", "己": "酉",
                 "庚": "亥", "辛": "子", "壬": "寅", "癸": "卯"},
    "禄神": {"甲": "寅", "乙": "卯", "丙": "巳", "戊": "巳", "丁": "午", "己": "午",
             "庚": "申", "辛": "酉", "壬": "亥", "癸": "子"},
    "羊刃": {"甲": "卯", "乙": "寅", "丙": "午", "戊": "午", "丁": "巳", "己": "巳",
             "庚": "酉", "辛": "申", "壬": "子", "癸": "亥"},
    "金舆": {"甲": "辰", "乙": "巳", "丙": "未", "丁": "申", "戊": "未", "己": "申",
             "庚": "戌", "辛": "亥", "壬": "丑", "癸": "寅"},
}
TAOHUA = {"寅午戌": "卯", "申子辰": "酉", "巳酉丑": "午", "亥卯未": "子"}
YIMA = {"寅午戌": "申", "申子辰": "寅", "巳酉丑": "亥", "亥卯未": "巳"}
HUAGAI = {"寅午戌": "戌", "申子辰": "辰", "巳酉丑": "丑", "亥卯未": "未"}
JIANGXING = {"寅午戌": "午", "申子辰": "子", "巳酉丑": "酉", "亥卯未": "卯"}
SHENSHA_DESC = {
    "天乙贵人": "命中第一吉神，遇事易得贵人扶持",
    "文昌贵人": "聪慧好学，利考试文书与专业表达",
    "禄神": "衣食有源，主正当收入与身体元气",
    "羊刃": "行动力强而刚烈，宜修柔防冲动",
    "金舆": "主车马富贵，得配偶或家庭之助",
    "桃花": "人缘与异性缘佳，主情感与审美",
    "驿马": "主移动变换，宜异地、外派与出行",
    "华盖": "偏才艺与宗教哲思，喜独处",
    "将星": "主统御与决断，宜担当主导",
}
# 神煞吉凶倾向：吉神/凶神/中性，供盘面「神煞分析」卡角标展示（传统通识）。
SHENSHA_TONE = {
    "天乙贵人": "吉", "文昌贵人": "吉", "禄神": "吉", "金舆": "吉",
    "将星": "吉", "驿马": "中", "桃花": "中", "华盖": "中", "羊刃": "凶",
}
GANZHI60 = [(("甲乙丙丁戊己庚辛壬癸")[i % 10]) + ("子丑寅卯辰巳午未申酉戌亥"[i % 12]) for i in range(60)]


def _sansha_group(zhis: list[str]) -> str | None:
    """取三合局（以年支为基准，其次日支）。"""
    for z in zhis:
        for key in TAOHUA:
            if z in key:
                return key
    return None


def _shensha(pillars: dict, day_gan: str) -> list[dict]:
    labels = {"year": "年", "month": "月", "day": "日", "hour": "时"}
    zhis = {k: v[1] for k, v in pillars.items()}
    out: dict[str, list[str]] = {}

    def hit(name: str, target: str):
        for k, z in zhis.items():
            if z == target:
                out.setdefault(name, []).append(labels[k])

    for name, table in SHENSHA_GAN.items():
        tgt = table.get(day_gan, "")
        if tgt:
            for ch in tgt:
                hit(name, ch)

    group = _sansha_group([zhis["year"], zhis["day"]])
    if group:
        for name, table in (("桃花", TAOHUA), ("驿马", YIMA), ("华盖", HUAGAI), ("将星", JIANGXING)):
            hit(name, table[group])

    return [{"name": n, "pillars": ps, "desc": SHENSHA_DESC.get(n, "")} for n, ps in out.items()]


NAYIN_MAP = {
    "甲子":"海中金","乙丑":"海中金","丙寅":"炉中火","丁卯":"炉中火",
    "戊辰":"大林木","己巳":"大林木","庚午":"路旁土","辛未":"路旁土",
    "壬申":"剑锋金","癸酉":"剑锋金","甲戌":"山头火","乙亥":"山头火",
    "丙子":"涧下水","丁丑":"涧下水","戊寅":"城头土","己卯":"城头土",
    "庚辰":"白蜡金","辛巳":"白蜡金","壬午":"杨柳木","癸未":"杨柳木",
    "甲申":"泉中水","乙酉":"泉中水","丙戌":"屋上土","丁亥":"屋上土",
    "戊子":"霹雳火","己丑":"霹雳火","庚寅":"松柏木","辛卯":"松柏木",
    "壬辰":"长流水","癸巳":"长流水","甲午":"沙中金","乙未":"沙中金",
    "丙申":"山下火","丁酉":"山下火","戊戌":"平地木","己亥":"平地木",
    "庚子":"壁上土","辛丑":"壁上土","壬寅":"金箔金","癸卯":"金箔金",
    "甲辰":"覆灯火","乙巳":"覆灯火","丙午":"天河水","丁未":"天河水",
    "戊申":"大驿土","己酉":"大驿土","庚戌":"钗钏金","辛亥":"钗钏金",
    "壬子":"桑松木","癸丑":"桑松木","甲寅":"大溪水","乙卯":"大溪水",
    "丙辰":"沙中土","丁巳":"沙中土","戊午":"天上火","己未":"天上火",
    "庚申":"石榴木","辛酉":"石榴木","壬戌":"大海水","癸亥":"大海水",
}


GANZHI60 = ["甲乙丙丁戊己庚辛壬癸"[i % 10] + "子丑寅卯辰巳午未申酉戌亥"[i % 12] for i in range(60)]


def pillars_to_solar(py: str, pm: str, pd: str, ph: str,
                     y1: int = 1901, y2: int = 2099) -> dict:
    """由四柱干支反查出生公历年月日时（同一八字可能对应多个日期，取最早）。
    日期模式之外新增的「输入方式：八字」即由此支撑：先反查日期，再走常规排盘。"""
    def idx(gz: str) -> int:
        if gz not in GANZHI60:
            raise ValueError(f"干支「{gz}」无效，请用如「甲子」的干支表示")
        return GANZHI60.index(gz)
    iy, im, iday, ih = idx(py), idx(pm), idx(pd), idx(ph)
    # 合法性由 idx() 保证：60 甲子之外的组合（如「甲丑」）不在表中，直接报错

    from datetime import date as _date, timedelta as _td
    from lunar_python import Solar

    # 日柱是连续 60 天循环：用 1900-01-01 锚点做算术扫描，避免逐日建盘（约 4 万天）
    anchor = Solar.fromYmd(1900, 1, 1).getLunar().getDayInGanZhi()
    a_idx = idx(anchor)
    base = _date(1900, 1, 1)
    first = _date(y1, 1, 1)
    delta = (iday - a_idx - (first - base).days) % 60
    d = first + _td(days=delta)

    # 粗筛：日柱匹配（每 60 天一个）；先用年柱算术预筛（立春近似 2/4，±4 天内再精确校验），
    # 再对候选日核对年/月柱（节气边界由 EightChar 精确判定）
    hits = []
    end = _date(y2, 12, 31)
    while d <= end:
        approx_y = (d.year - 4) % 60 if (d.month, d.day) >= (2, 4) else (d.year - 5) % 60
        near = abs((d - _date(d.year, 2, 4)).days) <= 4
        if iy == approx_y or near:
            ec = Solar.fromYmd(d.year, d.month, d.day).getLunar().getEightChar()
            if ec.getYear() == py and ec.getMonth() == pm and ec.getDay() == pd:
                hits.append(d)
        d += _td(days=60)

    for d in hits:
        for h in range(24):
            ec = Solar.fromYmdHms(d.year, d.month, d.day, h, 0, 0).getLunar().getEightChar()
            if ec.getTime() == ph:
                return {"year": d.year, "month": d.month, "day": d.day,
                        "hour": h, "minute": 0, "multiple": len(hits) > 1}
    raise ValueError("在 1901-2099 年间找不到与四柱匹配的出生日期，请核对干支")


def _validate_birth(year, month, day, hour, minute, calendar="solar"):
    """在调用 lunar_python 前校验范围：它对非法日期抛裸 Exception（无 ValueError 子类），
    直接透传会让 /api/bazi/calc 与合婚返回 500。此处提前拦成 ValueError 由接口层转友好错误。"""
    if not all(isinstance(v, (int, float)) for v in (year, month, day)):
        raise ValueError("出生年月日必须为数字")
    y, mo, d = int(year), int(month), int(day)
    if not (1900 <= y <= 2100):
        raise ValueError("出生年份超出支持范围（1900-2100）")
    # 农历闰月以负数表示（如 -6 = 闰六月），故公历范围 1~12、农历 -12~12 且非 0
    if calendar == "lunar":
        if mo == 0 or not (-12 <= mo <= 12):
            raise ValueError("出生月份无效")
    elif not (1 <= mo <= 12):
        raise ValueError("出生月份无效")
    if not (1 <= d <= 31):
        raise ValueError("出生日期无效")
    h = 12 if hour is None else int(hour)
    if not (0 <= h <= 23):
        raise ValueError("出生时辰无效（0-23）")
    mi = int(minute or 0)
    if not (0 <= mi <= 59):
        raise ValueError("出生分钟无效（0-59）")
    return y, mo, d, h, mi


def chart(year: int, month: int, day: int, hour: int, minute: int = 0,
          gender: str = "男", birth_place: str = "", calendar: str = "solar") -> dict:
    # 先校验参数范围（非法值在此转 ValueError，不落到 lunar_python 的裸 Exception）
    year, month, day, hour, minute = _validate_birth(year, month, day, hour, minute, calendar)
    # 支持农历输入：先换算成公历再统一走公历排盘（闰月以负数月表示，如 -6 = 闰六月）
    if calendar == "lunar":
        from lunar_python import Lunar
        try:
            solar = Lunar.fromYmdHms(year, month, day, hour, minute, 0).getSolar()
        except Exception as e:
            raise ValueError(f"农历日期无效：{e}")
        year, month, day = solar.getYear(), solar.getMonth(), solar.getDay()
    lunar = _solar_to_lunar(year, month, day, hour, minute)
    ec = lunar.getEightChar()
    pillars = {
        "year": ec.getYear(), "month": ec.getMonth(),
        "day": ec.getDay(), "hour": ec.getTime(),
    }
    day_gan = pillars["day"][0]
    ten_gods = {k: _ten_god(day_gan, v[0]) for k, v in pillars.items()}

    # 藏干（地支藏干）：lunar-python 的 getter 名为 get{Year,Month,Day,Time}HideGan
    hide_getter = {"year": "getYearHideGan", "month": "getMonthHideGan",
                   "day": "getDayHideGan", "hour": "getTimeHideGan"}
    hidden = {k: (getattr(ec, getter)() or []) for k, getter in hide_getter.items()}

    nayin = {k: NAYIN_MAP.get(v, "—") for k, v in pillars.items()}

    # 大运：起运年份 + 各步大运干支（lunar-python 用 getStartYear/Month/Day，无 getStartAge）
    dayun = []
    try:
        yun = ec.getYun(1 if gender == "男" else 2)  # 1=顺排 2=逆排
        start_age = yun.getStartYear()
        for da in yun.getDaYun():
            gz = da.getGanZhi()
            if not gz:
                continue          # 第 0 步为起运前，无干支
            dayun.append({
                "age": da.getStartAge(), "end_age": da.getEndAge(),
                "start_year": da.getStartYear(), "end_year": da.getEndYear(),
                "ganzhi": gz, "shi_shen": _ten_god(day_gan, gz[0]),
            })
            if len(dayun) >= 10:
                break
    except Exception:
        start_age = None

    # 藏干十神：每个地支的藏干及其十神
    ten_god_zhi = {k: [{"gan": g, "shi_shen": _ten_god(day_gan, g)} for g in (v or [])]
                   for k, v in hidden.items()}
    # 五行分布：四干 + 四支（本气）
    wuxing = {"木": 0, "火": 0, "土": 0, "金": 0, "水": 0}
    for v in pillars.values():
        wuxing[GAN_WUXING[v[0]]] += 1
        wuxing[ZHI_WUXING[v[1]]] += 1

    shensha = _shensha(pillars, day_gan)

    # 十神分析：按柱组织天干十神 + 藏干十神，各带释义（盘面「十神分析」卡数据源）。
    pillar_keys = ("year", "month", "day", "hour")
    ten_god_detail = {
        k: {
            "gan": pillars[k][0], "main": ten_gods[k],
            "main_desc": TEN_GOD_DESC.get(ten_gods[k], ""),
            "hidden": [
                {"gan": d["gan"], "shi_shen": d["shi_shen"],
                 "desc": TEN_GOD_DESC.get(d["shi_shen"], "")}
                for d in ten_god_zhi[k]
            ],
        }
        for k in pillar_keys
    }
    # 神煞分析：引擎原本按神煞聚合（pillars 列表），这里转成按柱聚合，供逐柱展示。
    _pillar_label = {"year": "年", "month": "月", "day": "日", "hour": "时"}
    shensha_by_pillar = {k: [] for k in pillar_keys}
    for item in shensha:
        for pillar_label in item["pillars"]:
            key = next((k for k in pillar_keys if _pillar_label[k] == pillar_label), None)
            if key:
                shensha_by_pillar[key].append({
                    "name": item["name"], "desc": item.get("desc", ""),
                    "tone": SHENSHA_TONE.get(item["name"], "中"),
                })

    # 流年：今年起 10 年（含今年），标出与大运的对应
    now_year = datetime.now().year
    birth_year = year
    liunian = []
    for y in range(now_year, now_year + 10):
        gz = GANZHI60[(y - 4) % 60]
        liunian.append({
            "year": y, "ganzhi": gz, "age": y - birth_year + 1,
            "shi_shen": _ten_god(day_gan, gz[0]),
            "liuyue": liuyue_of_year(y),  # 该流年十二个公历月的节气月柱（供点选提问）
        })
    cur_age = now_year - birth_year + 1
    cur_dayun = next((d for d in dayun if d["start_year"] <= now_year <= d["end_year"]), None)

    labels = {"year":"年柱","month":"月柱","day":"日柱","hour":"时柱"}
    lines = [f"出生：公历{year}-{month:02d}-{day:02d} {hour:02d}:{minute:02d}　农历{lunar.toString()}"]
    for k in ("year", "month", "day", "hour"):
        hg = "、".join(f"{d['gan']}{d['shi_shen']}" for d in ten_god_zhi[k]) or "—"
        lines.append(
            f"{labels[k]}：{pillars[k]}（十神:{ten_gods[k]}，纳音:{nayin[k]}，藏干十神:{hg}）"
        )
    lines.append(f"日主：{day_gan}（{GAN_WUXING[day_gan]}，{GAN_YINYANG[day_gan]}）")
    lines.append("五行：" + "　".join(f"{k}{v}" for k, v in wuxing.items() if v))
    if shensha:
        lines.append("神煞：" + "；".join(f"{s['name']}（{'/'.join(s['pillars'])}柱）" for s in shensha))
    if start_age is not None:
        lines.append(f"起运：约{start_age}岁")
    if dayun:
        lines.append("大运：" + " → ".join(
            f"{d['age']}~{d['end_age']}岁{d['ganzhi']}({d['shi_shen']})" for d in dayun[:6]))
    if cur_dayun:
        lines.append(f"排盘基准大运（按 {now_year} 年计）：{cur_dayun['ganzhi']}（{cur_dayun['start_year']}-{cur_dayun['end_year']}，{cur_age}岁）")
    lines.append(f"基准年起流年（{now_year} 起）：" + "　".join(f"{x['year']}{x['ganzhi']}({x['shi_shen']})" for x in liunian[:5]))
    if birth_place:
        lines.append(f"出生地：{birth_place}")
    fact = "\n".join(lines)

    rag_query = f"{pillars['day']}日主 {ten_gods['year']} {ten_gods['month']} {ten_gods['hour']} " + " ".join(pillars.values())
    return {
        "pillars": pillars, "ten_gods": ten_gods, "ten_god_zhi": ten_god_zhi, "nayin": nayin,
        "hidden": hidden, "day_master": day_gan, "dayun": dayun,
        "wuxing": wuxing, "shensha": shensha, "liunian": liunian,
        "ten_god_detail": ten_god_detail, "shensha_by_pillar": shensha_by_pillar,
        "current": {"year": now_year, "age": cur_age,
                    "dayun": cur_dayun["ganzhi"] if cur_dayun else "",
                    "dayun_range": [cur_dayun["start_year"], cur_dayun["end_year"]] if cur_dayun else []},
        "start_age": start_age,
        "lunar": lunar.toString(), "shengxiao": lunar.getYearShengXiao(),
        "fact": fact, "rag_query": rag_query,
        "rag_extra": [day_gan, ten_gods["month"], ten_gods["hour"], "日主", "格局"],
    }
