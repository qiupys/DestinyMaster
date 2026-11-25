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
    yaos = None
    if p.get("yaos"):
        try:
            raw = str(p["yaos"]).strip()
            # 兼容两种回传：calc 的 deck="789786"（6 位连串）与 "7,8,9,7,8,6"
            parts = list(raw) if ("," not in raw and len(raw) == 6) else raw.split(",")
            yaos = [int(x) for x in parts if str(x).strip()]
            if len(yaos) != 6 or any(v not in (6, 7, 8, 9) for v in yaos):
                raise ValueError
        except ValueError:
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
