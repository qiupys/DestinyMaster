"""黄历查询：lunar-python 确定性输出，字段对齐参考站（宜忌/干支/神煞/方位/星历物候）。

所有字段来自 lunar-python 的确定性计算，前端逐项可核对；AI 解读由 ai.py 负责。
"""
from __future__ import annotations

# 二十八宿全称：宿简称 →（宫 + 宿名 + 五行 + 动物）
XIU_FULL = {
    "角": "东宫 角木蛟", "亢": "东宫 亢金龙", "氐": "东宫 氐土貉",
    "房": "东宫 房日兔", "心": "东宫 心月狐", "尾": "东宫 尾火虎", "箕": "东宫 箕水豹",
    "斗": "北宫 斗木獬", "牛": "北宫 牛金牛", "女": "北宫 女土蝠",
    "虚": "北宫 虚日鼠", "危": "北宫 危月燕", "室": "北宫 室火猪", "壁": "北宫 壁水貐",
    "奎": "西宫 奎木狼", "娄": "西宫 娄金狗", "胃": "西宫 胃土雉",
    "昴": "西宫 昴日鸡", "毕": "西宫 毕月乌", "觜": "西宫 觜火猴", "参": "西宫 参水猿",
    "井": "南宫 井木犴", "鬼": "南宫 鬼金羊", "柳": "南宫 柳土獐",
    "星": "南宫 星日马", "张": "南宫 张月鹿", "翼": "南宫 翼火蛇", "轸": "南宫 轸水蚓",
}


def _call(lunar, name, default=""):
    """安全调用 lunar 的 getter，缺方法/异常时回退默认值（兼容不同版本）。"""
    fn = getattr(lunar, name, None)
    if not fn:
        return default
    try:
        v = fn()
        return default if v is None else v
    except Exception:
        return default


def query(year: int, month: int, day: int) -> dict:
    from lunar_python import Solar
    solar = Solar.fromYmd(year, month, day)
    lunar = solar.getLunar()

    yi = _call(lunar, "getDayYi", [])
    ji = _call(lunar, "getDayJi", [])
    chong_desc = _call(lunar, "getDayChongDesc", "")   # (己丑)牛
    chong = _call(lunar, "getDayChong", "")            # 丑
    sha = _call(lunar, "getDaySha", "")                # 西
    tianshen = _call(lunar, "getDayTianShen", "")      # 明堂
    tianshen_type = _call(lunar, "getDayTianShenType", "")  # 黄道/黑道
    zhixing = _call(lunar, "getZhiXing", "")           # 十二建星
    jieqi = _call(lunar, "getJieQi", "") or ""

    # 节气（当前/下一，含精确时刻）
    prev_jq, next_jq = _call(lunar, "getPrevJieQi", ""), _call(lunar, "getNextJieQi", "")
    jieqi_info = {}
    for tag, jq in (("current", jieqi), ("prev", prev_jq), ("next", next_jq)):
        if tag == "current" and jieqi:
            jieqi_info[tag] = {"name": jieqi}
        elif jq and not isinstance(jq, str):
            try:
                jieqi_info[tag] = {"name": jq.getName(), "time": jq.getSolar().toYmdHms()}
            except Exception:
                pass
        elif jq and tag != "current":
            jieqi_info[tag] = {"name": jq}

    # 干支 + 纳音（年月日时四柱）
    ec = lunar.getEightChar()
    ganzhi = {"year": ec.getYear(), "month": ec.getMonth(), "day": ec.getDay(), "hour": ec.getTime()}
    nayin = {
        "year": _call(lunar, "getYearNaYin"), "month": _call(lunar, "getMonthNaYin"),
        "day": _call(lunar, "getDayNaYin"), "hour": _call(lunar, "getTimeNaYin"),
    }
    shengxiao = {
        "year": _call(lunar, "getYearShengXiao"), "month": _call(lunar, "getMonthShengXiao"),
        "day": _call(lunar, "getDayShengXiao"),
    }
    lunar_date = (f"{_call(lunar,'getYearInChinese')}年{_call(lunar,'getMonthInChinese')}月"
                  f"{_call(lunar,'getDayInChinese')}")

    # 神煞 / 日值关系
    jishen = _call(lunar, "getDayJiShen", [])
    xiongsha = _call(lunar, "getDayXiongSha", [])
    kongwang = _call(ec, "getDayXunKong", "")
    taishen = _call(lunar, "getDayPositionTai")   # 胎神（占门栖 外西南）

    # 神位方位
    positions = {
        "cai": _call(lunar, "getDayPositionCaiDesc"),
        "xi": _call(lunar, "getDayPositionXiDesc"),
        "fu": _call(lunar, "getDayPositionFuDesc"),
        "yanggui": _call(lunar, "getDayPositionYangGuiDesc"),
        "yingu": _call(lunar, "getDayPositionYinGuiDesc"),
    }
    # 星历物候
    xi_u = _call(lunar, "getXiu")          # 二十八宿简称（尾）
    xi_u_luck = _call(lunar, "getXiuLuck") # 吉/凶
    wuhou = _call(lunar, "getWuHou")       # 物候
    hou = _call(lunar, "getHou")           # 立冬 三候
    yue_xiang = _call(lunar, "getYueXiang")  # 月相
    nine_star = _call(lunar, "getDayNineStar")  # 九星
    if nine_star is not None and not isinstance(nine_star, str):
        nine_star = str(nine_star)   # NineStar 对象 → "一白水天枢"
    xi_full = XIU_FULL.get(xi_u, xi_u)  # 二十八宿全称（宫 宿五行兽）

    festival = _call(lunar, "getFestivals", [])
    week = "一二三四五六日"[solar.getWeek()] if solar.getWeek() is not None else "?"

    lines = [
        f"公历：{year}年{month}月{day}日　星期{week}",
        f"农历：{lunar_date}　{shengxiao['year']}年",
        f"干支：{ganzhi['year']}年 {ganzhi['month']}月 {ganzhi['day']}日",
        f"纳音：{' · '.join([nayin['year'], nayin['month'], nayin['day']])}",
        f"宜：{'、'.join(yi[:14]) if yi else '诸事不宜'}",
        f"忌：{'、'.join(ji[:14]) if ji else '—'}",
        f"吉神：{'、'.join(jishen) if jishen else '—'}",
        f"凶煞：{'、'.join(xiongsha) if xiongsha else '—'}",
        f"冲煞：{ganzhi['day'][0]}{shengxiao['day']}日冲{chong_desc} 煞{sha}",
        f"空亡：{kongwang or '—'}",
        f"值神：{tianshen}（{tianshen_type}）",
        f"十二建星：{zhixing}日",
        f"方位：财神{positions['cai']}　喜神{positions['xi']}　福神{positions['fu']}　阳贵{positions['yanggui']}",
    ]
    if jieqi_info.get("current"):
        lines.append(f"节气：该日{jieqi}")
    elif jieqi_info.get("next"):
        lines.append(f"节气：上一节气{jieqi_info.get('prev',{}).get('name','')}，"
                     f"下一节气{jieqi_info['next'].get('name')}"
                     f"（{jieqi_info['next'].get('time','')}）")
    if xi_u or nine_star or hou:
        lines.append(f"星历物候：二十八宿{xi_u}宿({xi_u_luck})　九星{nine_star}　{hou} {wuhou}")
    if festival:
        lines.append(f"节日：{'、'.join(festival)}")
    fact = "\n".join(lines)

    return {
        "solar": f"{year}-{month:02d}-{day:02d}", "lunar": lunar_date, "week": week,
        "ganzhi": ganzhi, "nayin": nayin, "shengxiao": shengxiao,
        "yi": yi, "ji": ji, "jishen": jishen, "xiongsha": xiongsha,
        "chong": chong, "chong_desc": chong_desc, "sha": sha, "kongwang": kongwang,
        "tianshen": tianshen, "tianshen_type": tianshen_type, "zhixing": zhixing,
        "taishen": taishen,
        "jieqi": jieqi, "jieqi_info": jieqi_info, "positions": positions,
        "xiu": xi_u, "xiu_luck": xi_u_luck, "xiu_full": xi_full, "yue_xiang": yue_xiang,
        "wuhou": wuhou, "hou": hou, "nine_star": nine_star,
        "festival": festival, "fact": fact,
        "rag_query": f"{zhixing}日 值神{tianshen} {tianshen_type} 宜{'、'.join(yi[:4])} 忌{'、'.join(ji[:4])}",
        "rag_extra": [zhixing, tianshen, tianshen_type] + yi[:4],
    }
