"""个人上下文：档案出生信息 → 八字/星座约束，且首轮与追问复用同一份文本。"""
from __future__ import annotations

import astrology
import bazi
import history


def birth_of_params(params: dict, payload: dict) -> dict | None:
    """从排盘参数还原标准出生信息，用于写回档案。

    - date 模式：直接给年月日时分
    - bazi 模式：用排盘时反查出的公历日期
    """
    lookup = payload.get("pillar_lookup") or {}
    if lookup.get("year") and lookup.get("month") and lookup.get("day"):
        return {
            "year": int(lookup["year"]), "month": int(lookup["month"]), "day": int(lookup["day"]),
            "hour": int(lookup.get("hour") or 12), "minute": int(lookup.get("minute") or 0),
            "gender": params.get("gender") or "男",
            "know_time": True, "calendar": "solar",
        }
    y, m, d = params.get("year"), params.get("month"), params.get("day")
    if not (y and m and d):
        return None
    birth = {
        "year": int(y), "month": int(m), "day": int(d),
        "hour": int(params.get("hour") or 0), "minute": int(params.get("minute") or 0),
        "gender": params.get("gender") or "男",
        "know_time": True, "calendar": params.get("calendar") or "solar",
    }
    # 出生地（占星排盘必需）：与出生信息一并写回档案，供个人档案共用。
    for k in ("country", "province", "city", "place", "lat", "lon", "tz"):
        if params.get(k) is not None and params.get(k) != "":
            birth[k] = params[k]
    return birth


_birth_of_params = birth_of_params


def _personal_birth(pid: int, feature: str) -> dict:
    birth = history.personalization(pid, feature).get("birth") or {}
    y, m, d = birth.get("year"), birth.get("month"), birth.get("day")
    if not (y and m and d):
        raw = str(birth.get("date") or "")
        if raw.count("-") == 2:
            y, m, d = (int(x) for x in raw.split("-"))
    return {**birth, "_ymd": (y, m, d)}


def bazi_of_profile(pid: int) -> str:
    """把档案出生信息换算成四柱文本，供「导入本人八字」类场景注入 prompt。"""
    if not pid:
        return ""
    try:
        birth = _personal_birth(pid, "bazi")
        y, m, d = birth["_ymd"]
        if not (y and m and d):
            return ""
        h = birth.get("hour")
        h = int(h) if h not in (None, "") else 12
        gender = birth.get("gender") or "男"
        if gender in ("male", "female"):
            gender = "男" if gender == "male" else "女"
        pl = bazi.chart(int(y), int(m), int(d), h, int(birth.get("minute") or 0), gender)
        p = pl["pillars"]
        return (f"命主本人八字：{p['year']} {p['month']} {p['day']} {p['hour']}"
                f"（{gender}，日主{pl['day_master']}）。判断日子吉凶时请结合其四柱喜忌，"
                f"并说明当日干支与其年/日柱的合、冲、刑关系。")
    except Exception:
        return ""


_bazi_of_profile = bazi_of_profile


def bazi_of_params(y: int | None, m: int | None, d: int | None,
                   h: int | None, mi: int | None, gender: str, name: str = "",
                   who: str = "第二人") -> str:
    """从显式出生参数算一个人的四柱文本，供合婚/双人择日场景注入。"""
    if not (y and m and d):
        return ""
    try:
        hh = int(h) if h not in (None, "") else 12
        gen = gender or "男"
        if gen in ("male", "female"):
            gen = "男" if gen == "male" else "女"
        pl = bazi.chart(int(y), int(m), int(d), hh, int(mi or 0), gen)
        p = pl["pillars"]
        person = (name or "").strip()
        label = (who + person) if person and person != who else who
        return (f"{label}八字：{p['year']} {p['month']} {p['day']} {p['hour']}"
                f"（{gen}，日主{pl['day_master']}）。择日时请同时核对当日干支与两人的年柱/日柱"
                f"的生克合冲——尤其关注与双方日主的关系，判断这一天对两人是否都相宜；"
                f"若有冲突请明确指出，不可只偏袒一方。")
    except Exception:
        return ""


_bazi_of_params = bazi_of_params


def star_of_profile(pid: int) -> tuple[str, bool]:
    """从档案生日换算太阳星座文本（塔罗用）。返回 (文本, 是否成功取到生日)。"""
    if not pid:
        return "", False
    try:
        birth = _personal_birth(pid, "tarot")
        y, m, d = birth["_ymd"]
        if not (y and m and d):
            return "", False
        s = astrology.sun_sign(int(m), int(d))
        return (f"问卜者太阳星座：{s['name']}（{s['en']}，{s['element']}象 · {s['modality']}宫 · "
                f"守护星{s['ruler']}，特质：{s['keywords']}）。解牌时请结合该星座的性格基调，"
                f"说明牌面信息如何映射到这位问卜者的处境。"), True
    except Exception:
        return "", False


_star_of_profile = star_of_profile


def bazi_complete(pid: int) -> bool:
    """档案是否具备完整出生信息（年月日 + 时分），用于梅花强制引入八字门禁。"""
    if not pid:
        return False
    try:
        birth = _personal_birth(pid, "meihua")
        if not all(birth["_ymd"]):
            return False
        if birth.get("know_time") is False:
            return False
        return birth.get("hour") not in (None, "")
    except Exception:
        return False


_bazi_complete = bazi_complete


def augment_profile(pid: int | None, feature: str, up: str,
                    *, use_bazi: int = 0, use_star: int = 0,
                    y: int | None = None, m: int | None = None, d: int | None = None,
                    h: int | None = None, mi: int | None = None,
                    gender: str = "", name: str = "",
                    p2_y: int | None = None, p2_m: int | None = None, p2_d: int | None = None,
                    p2_h: int | None = None, p2_mi: int | None = None,
                    p2_gender: str = "", p2_name: str = "") -> tuple[str, str]:
    """按功能把八字/星座约束注入用户画像文本。

    返回 (注入后的 up, 注入说明文本)；说明文本存入 payload，追问时原样复用。
    """
    extra = ""
    if not pid:
        return up, extra
    if feature == "meihua":
        line = bazi_of_profile(pid)
        if line:
            line = line.split("判断日子吉凶时")[0].strip() + (
                "。解卦时须结合其四柱五行喜忌：用生体/用克体等体用生克落到命主实际喜忌上，"
                "并说明卦象五行对命主是助是耗，使命盘与卦象相互印证。"
            )
            extra = line
    elif use_bazi:
        line = bazi_of_profile(pid)
        if line:
            extra = line
    if feature == "tarot" and use_star:
        star, _ok = star_of_profile(pid)
        if star:
            extra = (extra + "\n" + star).strip()
    if feature == "huangli_pair" and y and m and d:
        p1 = bazi_of_params(y, m, d, h, mi, gender or "男", name, who="男方")
        if p1:
            extra = (extra + "\n" + p1).strip()
    if feature in ("huangli", "huangli_pair") and p2_y and p2_m and p2_d:
        p2 = bazi_of_params(p2_y, p2_m, p2_d, p2_h, p2_mi, p2_gender, p2_name)
        if p2:
            extra = (extra + "\n" + p2).strip()
    return ((up + "\n" + extra).strip() if extra else up), extra


_augment_profile = augment_profile


def personalize(pid: int | None, feature: str) -> tuple[str, list[dict]]:
    if not pid:
        return "", []
    ctx = history.personalization(pid, feature)
    up = ctx["user_profile"]
    if ctx["birth"]:
        birth = ctx["birth"]
        b = f"出生信息：{birth.get('year','')}-{birth.get('month','')}-{birth.get('day','')}"
        if birth.get("hour") not in (None, ""):
            b += f" {birth.get('hour')}时"
        up = (up + "\n" + b).strip()
    return up, ctx["recent"]


_personalize = personalize
