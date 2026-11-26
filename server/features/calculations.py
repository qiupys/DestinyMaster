"""十一功能的确定性计算入口：只从公共参数字典取所需字段，不碰 AI / 历史。"""
from __future__ import annotations

import astrology
import bazi
import huangli
import liuyao
import marriage
import meihua
import qimen
import tarot


def calc_meihua(p: dict) -> dict:
    from datetime import datetime
    method = p.get("method") or "time"
    when = None
    if p.get("when"):
        try:
            when = datetime.fromisoformat(str(p["when"]).replace("T", " ").replace("Z", ""))
        except ValueError:
            raise ValueError("指定时间格式无效")
    return meihua.derive(
        method, num1=p.get("num1"), num2=p.get("num2"),
        upper=p.get("upper"), lower=p.get("lower"), moving=p.get("moving"), when=when,
        question=p.get("question"),
    )


def calc_bazi(p: dict) -> dict:
    from datetime import datetime
    # 「输入方式：八字」：直接给四柱干支 → 先反查出生公历日期，再走常规排盘
    if p.get("pillar_year") and p.get("pillar_month") and p.get("pillar_day") and p.get("pillar_time"):
        res = bazi.pillars_to_solar(p["pillar_year"], p["pillar_month"], p["pillar_day"], p["pillar_time"])
        payload = bazi.chart(res["year"], res["month"], res["day"], res["hour"], 0,
                             p.get("gender") or "男", p.get("birth_place") or "")
        payload["pillar_lookup"] = res
        return payload
    now = datetime.now()
    y = p.get("year") or now.year
    m = p.get("month") or now.month
    d = p.get("day") or now.day
    h = p.get("hour") if p.get("hour") is not None else 0
    return bazi.chart(y, m, d, h, p.get("minute") or 0,
                      p.get("gender") or "男", p.get("birth_place") or "",
                      calendar=p.get("calendar") or "solar")


def calc_huangli(p: dict) -> dict:
    from datetime import date
    today = date.today()
    return huangli.query(p.get("year") or today.year,
                         p.get("month") or today.month,
                         p.get("day") or today.day)


def calc_tarot(p: dict) -> dict:
    # 所问之事参与抽牌种子（与时间/随机源并列，非唯一决定）；前端仍回传 deck 锁定同一副牌
    return tarot.draw(p.get("spread") or "three",
                      seed=tarot.question_seed(p.get("question") or ""))


def person_params(p: dict, prefix: str = "") -> dict:
    """从公共参数里抽出一方出生信息（prefix='p2_' 取对方）。"""
    g = lambda k: p.get(prefix + k)
    out = {
        "year": g("year"), "month": g("month"), "day": g("day"),
        "hour": g("hour"), "minute": g("minute"),
        "gender": g("gender") or "男", "name": g("name") or "",
        "calendar": g("calendar") or "solar",
    }
    # 占星合盘需要双方的出生地经纬度/时区（占星按出生地算宫位）
    for k in ("lat", "lon", "tz", "place", "city", "province"):
        if g(k) not in (None, ""):
            out[k] = g(k)
    return out


_person_params = person_params


def calc_bazi_marriage(p: dict) -> dict:
    return marriage.bazi_marriage(person_params(p), person_params(p, "p2_"))


def calc_ziwei_marriage(p: dict) -> dict:
    return marriage.ziwei_marriage(person_params(p), person_params(p, "p2_"))


def calc_astrology_marriage(p: dict) -> dict:
    return marriage.astrology_marriage(person_params(p), person_params(p, "p2_"))


def calc_liuyao(p: dict) -> dict:
    from datetime import datetime
    when = None
    if p.get("when"):
        try:
            when = datetime.fromisoformat(str(p["when"]).replace("T", " ").replace("Z", ""))
        except ValueError:
            raise ValueError("起卦时间格式无效")
    coins = None
    if p.get("coins"):
        try:
            coins = [int(x) for x in str(p["coins"]).split(",") if x.strip()]
        except ValueError:
            raise ValueError("铜钱结果格式无效")
    yaos = liuyao.parse_yaos(p.get("yaos"))
    if p.get("yaos") and yaos is None:
        raise ValueError("卦象参数格式无效（需 6 个爻值 6/7/8/9）")
    return liuyao.derive(p.get("method") or "coin", coins=coins,
                         num1=p.get("num1"), num2=p.get("num2"), yaos=yaos,
                         when=when, question=p.get("question"))


def calc_qimen(p: dict) -> dict:
    from datetime import datetime
    when = None
    if p.get("when"):
        try:
            when = datetime.fromisoformat(str(p["when"]).replace("T", " ").replace("Z", ""))
        except ValueError:
            raise ValueError("起局时间格式无效")
    return qimen.derive(when=when, method=p.get("method") or "chaibu",
                        question=p.get("question"),
                        year_na=p.get("year_na"), yongshen=p.get("yongshen") or None)


# 命盘类共用：问题文本里的目标时点解析 + 小时→时辰序号。
# 八字把「只看 2027 丁未流年」拼进问题、紫微把「2027 年流年」拼进问题，
# 时点属于问题语义而非盘面身份参数——所有命盘功能共用同一套解析，不再各造参数。
import re as _re
from datetime import date as _date_cls

_TARGET_YM_RE = _re.compile(r"(?:19|20)\d{2}\s*年\s*\d{1,2}\s*月")
_TARGET_Y_RE = _re.compile(r"(?<!\d)(?:19|20)\d{2}(?!\d)")


def parse_target_period(question: str) -> tuple[int | None, int | None]:
    """从问题文本提取 (目标年, 目标月)；不到可解析时点返回 (None, None)。

    只认近期年份，避免把用户提到的出生年份误当作推演目标。
    """
    today = _date_cls.today()
    match = _TARGET_YM_RE.search(question or "")
    if match:
        parts = _re.findall(r"\d+", match.group(0))
        year, month = int(parts[0]), int(parts[1])
        if 1900 <= year <= 2100 and 1 <= month <= 12 and year >= today.year - 1:
            return year, month
    match = _TARGET_Y_RE.search(question or "")
    if match:
        year = int(match.group(0))
        if 1900 <= year <= 2100 and year >= today.year - 1:
            return year, None
    return None, None


def hour_to_time_index(hour: int | None, know_time: bool = True) -> int:
    """公历小时 → 时辰序号（0 早子 … 12 晚子）；未知时间默认午时。"""
    if not know_time or hour is None:
        return 6
    value = int(hour)
    return 12 if value == 23 else (value + 1) // 2


def calc_ziwei(p: dict) -> dict:
    """紫微确定性盘面事实：与其余功能一样只吃公共参数字典、不碰 AI 流式/历史。

    出生参数沿用通用的 year/month/day/hour/minute/gender/calendar（与八字一致），
    只是内部转成 py-iztro 需要的 date + 时辰序号；目标流年也和八字一样从问题
    文本解析，不新增专属入参。payload 刻意排除两类易变内容：
    - chart_id：每次排盘 uuid4 随机；
    - 「当前运限（今日）」段：随系统日期变化，会让同题隔天失效。
    文献在 prompt 阶段实时检索，不落盘进 payload。
    """
    import ai as ai_layer
    import chart as ziwei_chart

    year, month, day = p.get("year"), p.get("month"), p.get("day")
    if not (year and month and day):
        raise ValueError("紫微推演缺少出生日期参数")
    chart = ziwei_chart.get_chart({
        "date": f"{int(year)}-{int(month)}-{int(day)}",
        "timeIndex": hour_to_time_index(p.get("hour"), p.get("know_time") is not False),
        "gender": p.get("gender") or "男",
        "calendar": p.get("calendar") or "solar",
        "fixLeap": True,
    })
    question = p.get("question") or ""
    target_year, target_month = parse_target_period(question)
    target_horo, target_label = None, ""
    if target_year and target_month:
        target_horo = ziwei_chart.horoscope_for(chart, int(target_year), int(target_month))
        target_label = (f"推演目标：{target_year} 年流年（立春界）+ 覆盖公历 "
                        f"{target_year}-{target_month} 整月的流月盘（节气界，公历月跨两个节气月时含两段）")
    elif target_year:
        target_horo = ziwei_chart.horoscope_for(chart, int(target_year))
        target_label = f"推演目标：{target_year} 年流年运限（流年以立春为界，含年初尾盘、所属大限与流曜）"

    raw = ai_layer.prepare_ziwei(chart, question, target_horo, target_label, [])
    stable_digest = (raw.get("digest") or "").split("【当前运限（今日）】")[0].strip()
    ziwei_data = {
        "digest": stable_digest,
        "target": raw.get("target") or "",
        "rag_query": raw.get("rag_query") or "",
        "rag_extra": raw.get("rag_extra") or [],
    }
    return {
        "ziwei_data": ziwei_data,
        "birth": {
            "date": f"{int(year)}-{int(month)}-{int(day)}",
            "time_index": hour_to_time_index(p.get("hour"), p.get("know_time") is not False),
            "gender": p.get("gender") or "男",
            "calendar": p.get("calendar") or "solar",
        },
        "target_year": target_year, "target_month": target_month,
        "rag_query": ziwei_data["rag_query"], "rag_extra": ziwei_data["rag_extra"],
        "fact": stable_digest + ("\n" + ziwei_data["target"] if ziwei_data["target"] else ""),
    }


def calc_astrology(p: dict) -> dict:
    from datetime import datetime
    now = datetime.now()
    y = int(p.get("year") or now.year)
    m = int(p.get("month") or now.month)
    d = int(p.get("day") or now.day)
    h = int(p.get("hour") if p.get("hour") is not None else 12)
    mi = int(p.get("minute") or 0)
    lat, lon = p.get("lat"), p.get("lon")
    place = p.get("place") or ""
    tz = float(p.get("tz") if p.get("tz") is not None else 8.0)
    if (lat is None or lon is None) and place:
        city = astrology.city_lookup(place)
        if city:
            lat = lat if lat is not None else city["lat"]
            lon = lon if lon is not None else city["lon"]
            if not p.get("tz"):
                tz = city["tz"]
    if lat is None or lon is None:
        raise ValueError("请选择出生城市或填写经纬度")
    return astrology.derive(y, m, d, h, mi, float(lat), float(lon), tz, place)


# 兼容旧名称，便于外部脚本按需引用
_calc_meihua = calc_meihua
_calc_bazi = calc_bazi
_calc_huangli = calc_huangli
_calc_tarot = calc_tarot
_calc_bazi_marriage = calc_bazi_marriage
_calc_ziwei_marriage = calc_ziwei_marriage
_calc_astrology_marriage = calc_astrology_marriage
_calc_liuyao = calc_liuyao
_calc_qimen = calc_qimen
_calc_astrology = calc_astrology
_calc_ziwei = calc_ziwei
