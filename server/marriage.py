"""双盘合婚引擎：八字合婚 + 紫微合婚。

设计原则（与参考站一致）：
- 不给"合不合"的匹配分数、不做单星吉凶断言；只输出可逐条核对的盘面事实。
- 八字：三层结构 = 各自命局（日主强弱喜忌）→ 两盘交互（柱位对齐的干支关系 +
  十神交叉 + 配偶星）→ 时间同步（双方大运与当前年份前后各 5 年的流年干支）。
  神煞仅作辅助证据，每条结论都指明柱位 / 十神 / 关系类型。
- 紫微：先固定两张完整命盘，再建跨盘关系，给六个可核对维度：
  夫妻宫对照、命宫性格主轴、福德宫内在需求、双向生年四化同地支投射、
  桃花星落宫、双方运限时间线对齐。不给单一合不合结论。
- 全部为确定性计算：`fact` 是给 AI 的唯一依据，AI 不得引用盘面之外的信息。

对外接口：
    bazi_marriage(a: dict, b: dict) -> dict
    ziwei_marriage(a: dict, b: dict) -> dict

a / b 为出生参数 dict；可选字段 `as_of_year` 用于固定时间线基准年（缺省为今年）。
运行时以 PYTHONPATH=server 加载：`import bazi`, `import chart`。
"""
from __future__ import annotations

from datetime import datetime

try:  # 兼容 PYTHONPATH=server 与包内 import 两种加载方式
    import bazi as _bazi
    import chart as _chart
except ImportError:  # pragma: no cover - 仅作为包导入时的兜底
    from . import bazi as _bazi
    from . import chart as _chart


# ───────────────────────────── 通用常量 ─────────────────────────────
GAN = "甲乙丙丁戊己庚辛壬癸"
ZHI = "子丑寅卯辰巳午未申酉戌亥"
GANZHI60 = _bazi.GANZHI60
GAN_WUXING = _bazi.GAN_WUXING
ZHI_WUXING = _bazi.ZHI_WUXING
SHENG = {"木": "火", "火": "土", "土": "金", "金": "水", "水": "木"}   # 我生者
KE = {"木": "土", "土": "水", "水": "火", "火": "金", "金": "木"}       # 我克者
BEI_SHENG = {v: k for k, v in SHENG.items()}                            # 生我者（印）
BEI_KE = {v: k for k, v in KE.items()}                                  # 克我者（官杀）

PILLAR_KEYS = ("year", "month", "day", "hour")
PILLAR_LABELS = {"year": "年柱", "month": "月柱", "day": "日柱", "hour": "时柱"}

# 天干五合（含合化五行）与天干相冲
GAN_HE = {frozenset(p): chem for p, chem in (
    (("甲", "己"), "土"), (("乙", "庚"), "金"), (("丙", "辛"), "水"),
    (("丁", "壬"), "木"), (("戊", "癸"), "火"))}
GAN_CHONG = {frozenset(("甲", "庚")), frozenset(("乙", "辛")),
             frozenset(("丙", "壬")), frozenset(("丁", "癸"))}

# 地支关系表
ZHI_LIUHE = {frozenset(p): chem for p, chem in (
    (("子", "丑"), "土"), (("寅", "亥"), "木"), (("卯", "戌"), "火"),
    (("辰", "酉"), "金"), (("巳", "申"), "水"), (("午", "未"), "土"))}
ZHI_BANHE_GROUPS = ("申子辰", "寅午戌", "巳酉丑", "亥卯未")
ZHI_ANHE = {frozenset(("寅", "丑")), frozenset(("卯", "申")), frozenset(("午", "亥"))}
ZHI_LIUCHONG = {frozenset(("子", "午")), frozenset(("丑", "未")), frozenset(("寅", "申")),
                frozenset(("卯", "酉")), frozenset(("辰", "戌")), frozenset(("巳", "亥"))}
ZHI_XING_SAN = (frozenset(("寅", "巳", "申")), frozenset(("丑", "未", "戌")),
                frozenset(("子", "卯")))
ZHI_XING_ZI = {"辰", "午", "酉", "亥"}
ZHI_HAI = {frozenset(("子", "未")), frozenset(("丑", "午")), frozenset(("寅", "巳")),
           frozenset(("卯", "辰")), frozenset(("申", "亥")), frozenset(("酉", "戌"))}
ZHI_PO = {frozenset(("子", "酉")), frozenset(("卯", "午")), frozenset(("辰", "丑")),
          frozenset(("戌", "未")), frozenset(("寅", "亥")), frozenset(("巳", "申"))}

# 紫微：通行天干四化表（生年四化以盘面 mutagen 为准；此表仅用于流年四化落宫线索）
FLOW_MUTAGEN = {
    "甲": {"禄": "廉贞", "权": "破军", "科": "武曲", "忌": "太阳"},
    "乙": {"禄": "天机", "权": "天梁", "科": "紫微", "忌": "太阴"},
    "丙": {"禄": "天同", "权": "天机", "科": "文昌", "忌": "廉贞"},
    "丁": {"禄": "太阴", "权": "天同", "科": "天机", "忌": "巨门"},
    "戊": {"禄": "贪狼", "权": "太阴", "科": "右弼", "忌": "天机"},
    "己": {"禄": "武曲", "权": "贪狼", "科": "天梁", "忌": "文曲"},
    "庚": {"禄": "太阳", "权": "武曲", "科": "太阴", "忌": "天同"},
    "辛": {"禄": "巨门", "权": "太阳", "科": "文曲", "忌": "文昌"},
    "壬": {"禄": "天梁", "权": "紫微", "科": "左辅", "忌": "武曲"},
    "癸": {"禄": "破军", "权": "巨门", "科": "太阴", "忌": "贪狼"},
}
MUTAGEN_ORDER = ("禄", "权", "科", "忌")
PEACH_STARS = ("红鸾", "天喜", "咸池", "天姚")
KEY_PALACES = {"命宫": "命宫", "夫妻": "夫妻宫", "福德": "福德宫"}


# ───────────────────────────── 通用工具 ─────────────────────────────
def _as_of_year(a: dict, b: dict) -> int:
    """时间线基准年：允许调用方固定，保证结果可复现。"""
    raw = a.get("as_of_year") or b.get("as_of_year") or datetime.now().year
    try:
        return int(raw)
    except (TypeError, ValueError):
        return datetime.now().year


def _who(p: dict, fallback: str) -> str:
    return str(p.get("name") or fallback).strip() or fallback


def _gender(p: dict) -> str:
    g = str(p.get("gender") or "男")
    return {"male": "男", "female": "女"}.get(g, g)


def _calendar(p: dict) -> str:
    return "lunar" if str(p.get("calendar") or "solar").lower() in ("lunar", "农历") else "solar"


def _hour_index(hour) -> int:
    """紫微 timeIndex：23点→12（晚子），其余 (hour+1)//2，未知默认 6（午时）。"""
    if hour in (None, ""):
        return 6
    try:
        h = int(hour)
    except (TypeError, ValueError):
        return 6
    return 12 if h == 23 else min(12, max(0, (h + 1) // 2))


def _gan_relations(g1: str, g2: str) -> list[str]:
    if not g1 or not g2:
        return []
    out = []
    pair = frozenset((g1, g2))
    if pair in GAN_HE and g1 != g2:
        out.append(f"天干五合（{g1}{g2}合{GAN_HE[pair]}）")
    if pair in GAN_CHONG and g1 != g2:
        out.append(f"天干相冲（{g1}{g2}冲）")
    w1, w2 = GAN_WUXING[g1], GAN_WUXING[g2]
    if g1 == g2 or w1 == w2:
        out.append(f"天干比和（{g1}{g2}同为{w1}，无生克）")
    elif SHENG[w1] == w2:
        out.append(f"天干相生（{g1}生{g2}：{w1}生{w2}）")
    elif SHENG[w2] == w1:
        out.append(f"天干相生（{g2}生{g1}：{w2}生{w1}）")
    elif KE[w1] == w2:
        out.append(f"天干相克（{g1}克{g2}：{w1}克{w2}）")
    else:
        out.append(f"天干相克（{g2}克{g1}：{w2}克{w1}）")
    return out


def _zhi_relations(z1: str, z2: str) -> list[str]:
    if not z1 or not z2:
        return []
    out = []
    pair = frozenset((z1, z2))
    if z1 == z2:
        if z1 in ZHI_XING_ZI:
            out.append(f"地支自刑（{z1}{z2}自刑）")
        else:
            out.append(f"地支比和（{z1}{z2}同支）")
        return out
    if pair in ZHI_LIUHE:
        out.append(f"地支六合（{z1}{z2}合{ZHI_LIUHE[pair]}）")
    # 半合：三合局任取两支（隔位也算半合）
    for grp in ZHI_BANHE_GROUPS:
        if z1 in grp and z2 in grp:
            out.append(f"地支半合（{z1}{z2}属{grp[0]}{grp[1]}{grp[2]}三合局）")
            break
    if pair in ZHI_ANHE:
        out.append(f"地支暗合（{z1}{z2}暗合）")
    if pair in ZHI_LIUCHONG:
        out.append(f"地支六冲（{z1}{z2}冲）")
    for grp in ZHI_XING_SAN:
        if pair.issubset(grp):
            out.append(f"地支相刑（{z1}{z2}属{''.join(sorted(grp, key=ZHI.index))}之刑）")
            break
    if pair in ZHI_HAI:
        out.append(f"地支相害（{z1}{z2}相害）")
    if pair in ZHI_PO:
        out.append(f"地支相破（{z1}{z2}相破）")
    if not out:
        out.append(f"地支无合冲刑害破（{z1}与{z2}）")
    return out


def _gz_of_year(year: int) -> str:
    return GANZHI60[(year - 4) % 60]


# ═════════════════════════════ 八字合婚 ═════════════════════════════
def _bazi_strength(cd: dict) -> dict:
    """日主强弱喜忌：以月令 + 四柱五行本气分布给出可核对的确定性判断。

    仅作为命局底色参照，不替代柱位关系结论；依据文本逐项列出，供 AI 复核。
    """
    dm = cd["day_master"]
    dw = GAN_WUXING[dm]
    wx = cd["wuxing"]
    month_zhi = cd["pillars"]["month"][1]
    mw = ZHI_WUXING[month_zhi]
    same, resource = wx.get(dw, 0), wx.get(BEI_SHENG[dw], 0)
    officer, output, wealth = wx.get(BEI_KE[dw], 0), wx.get(SHENG[dw], 0), wx.get(KE[dw], 0)
    if mw in (dw, BEI_SHENG[dw]):
       月令分 = 2
       月令判断 = f"月支{month_zhi}({mw})为同党/印绶，得令 +2"
    else:
       月令分 = -1
       月令判断 = f"月支{month_zhi}({mw})非同党/印绶，失令 -1"
    score = same + resource + 月令分 - officer * 0.5
    if score >= 6:
        level, favor = "身强（偏旺）", "喜克泄耗（官杀、食伤、财星）"
    elif score >= 3.5:
        level, favor = "身旺（中和偏强）", "喜克泄耗（官杀、食伤、财星），酌用印"
    elif score >= 2:
        level, favor = "中和", "喜忌随大运调候，重三方柱位合冲"
    elif score >= 0.5:
        level, favor = "身弱（中和偏弱）", "喜生扶（印绶、比劫）"
    else:
        level, favor = "身弱（偏弱）", "喜生扶（印绶、比劫）"
    basis = (f"日主{dm}({dw})；同党(比劫){same}、印绶{resource}、官杀{officer}、"
             f"食伤{output}、财星{wealth}；{月令判断}；综合分{score:.1f}")
    return {"level": level, "favor": favor, "basis": basis, "score": round(score, 1),
            "wuxing": dict(wx), "month_branch": month_zhi,
            "elements": {"同党": same, "印": resource, "官杀": officer,
                         "食伤": output, "财": wealth}}


def _bazi_person(p: dict, fallback: str, as_of_year: int) -> dict:
    name = _who(p, fallback)
    gender = _gender(p)
    hour_raw = p.get("hour")
    hour_unknown = hour_raw in (None, "")
    hour = 12 if hour_unknown else int(hour_raw)
    cd = _bazi.chart(int(p["year"]), int(p["month"]), int(p["day"]), hour,
                     int(p.get("minute") or 0), gender, calendar=_calendar(p))
    dm = cd["day_master"]
    active = [k for k in PILLAR_KEYS if not (hour_unknown and k == "hour")]
    # 时间线：当前大运 + 基准年前后各 5 年共 11 年流年
    liunian = []
    for y in range(as_of_year - 5, as_of_year + 6):
        gz = _gz_of_year(y)
        liunian.append({"year": y, "ganzhi": gz,
                        "shi_shen": _bazi._ten_god(dm, gz[0])})
    return {
        "name": name, "gender": gender, "calendar": _calendar(p),
        "hour_unknown": hour_unknown, "chart": cd, "day_master": dm,
        "pillars": dict(cd["pillars"]), "ten_gods": dict(cd["ten_gods"]),
        "active_pillars": active, "strength": _bazi_strength(cd),
        "liunian": liunian, "current": dict(cd.get("current") or {}),
    }


def _spouse_star(person: dict, target_person: dict) -> dict:
    """以 person 的日主为目标星判定基准，检查对方盘中是否出现其配偶星。

    男看正财/偏财，女看正官/七杀；天干取四柱，地支取藏干，均标明柱位。
    """
    dm = person["day_master"]
    want = {"男": ("正财", "偏财"), "女": ("正官", "七杀")}[person["gender"]]
    hits = []
    for k in target_person["active_pillars"]:
        gan = target_person["pillars"][k][0]
        tg = _bazi._ten_god(dm, gan)
        if tg in want:
            hits.append(f"{target_person['name']}{PILLAR_LABELS[k]}天干{gan}={tg}（{person['name']}配偶星）")
        for hidden_gan in (target_person["chart"].get("hidden", {}).get(k) or []):
            th = _bazi._ten_god(dm, hidden_gan)
            if th in want:
                hits.append(f"{target_person['name']}{PILLAR_LABELS[k]}藏干{hidden_gan}={th}（{person['name']}配偶星）")
    return {"gender": person["gender"], "target_gods": list(want),
            "seen_from": person["name"], "in_chart": target_person["name"],
            "present": bool(hits), "evidence": hits or ["对方盘中未见（以本人日主判定）"]}


def _ten_god_cross(person: dict, target: dict) -> list[dict]:
    """把对方四柱天干放到自己日主下逐柱判十神。"""
    out = []
    for k in target["active_pillars"]:
        gan = target["pillars"][k][0]
        out.append({"who": f"{target['name']}{PILLAR_LABELS[k]}天干{gan}",
                    "day_master": person["day_master"], "gan": gan,
                    "ten_god": _bazi._ten_god(person["day_master"], gan)})
    return out


def _bazi_cross(pa: dict, pb: dict) -> dict:
    groups = []
    for ka in PILLAR_KEYS:
        ga, za = pa["pillars"][ka][0], pa["pillars"][ka][1]
        for kb in PILLAR_KEYS:
            gb, zb = pb["pillars"][kb][0], pb["pillars"][kb][1]
            invalid = (ka == "hour" and pa["hour_unknown"]) or (kb == "hour" and pb["hour_unknown"])
            rels = []
            if invalid:
                rels.append({"scope": "柱位", "a": pa["pillars"][ka], "b": pb["pillars"][kb],
                             "relation": "时柱不详，按三柱论——本组不成立"})
            else:
                for r in _gan_relations(ga, gb):
                    rels.append({"scope": "天干", "a": ga, "b": gb, "relation": r})
                for r in _zhi_relations(za, zb):
                    rels.append({"scope": "地支", "a": za, "b": zb, "relation": r})
            weight = ("最高（日柱=夫妻宫）" if ka == kb == "day"
                      else "较高（涉日柱）" if ka == "day" or kb == "day" else "常规")
            groups.append({
                "who": f"{pa['name']}{PILLAR_LABELS[ka]} vs {pb['name']}{PILLAR_LABELS[kb]}",
                "pair": {"a_pillar": ka, "b_pillar": kb, "a": pa["pillars"][ka], "b": pb["pillars"][kb]},
                "relations": rels, "weight": weight, "unreliable": invalid,
            })
    day_group = next(g for g in groups if g["pair"]["a_pillar"] == "day" and g["pair"]["b_pillar"] == "day")
    return {
        "pillar_groups": groups,
        "day_pillar_relation": day_group,
        "ten_god_cross": {
            "a_day_master_over_b": _ten_god_cross(pa, pb),
            "b_day_master_over_a": _ten_god_cross(pb, pa),
        },
        "spouse_star": {
            "a_spouse_star_in_b": _spouse_star(pa, pb),
            "b_spouse_star_in_a": _spouse_star(pb, pa),
        },
    }


def _bazi_fact(pa: dict, pb: dict, cross: dict, as_of_year: int) -> str:
    L = []
    L.append("【八字合婚 · 盘面事实清单（引擎确定性计算，AI 唯一依据）】")
    L.append(f"当事人：A={pa['name']} / B={pb['name']}；时间线基准年：{as_of_year}。")
    L.append("说明：本清单不含任何匹配分数或『合不合』结论，只列柱位、十神、干支关系与时间线；神煞仅作辅助证据。")
    L.append("")
    L.append("一、个人命局（各自日主强弱喜忌）")
    for p in (pa, pb):
        ps = p["pillars"]
        tg = p["ten_gods"]
        note = "；时柱不详，按三柱论（第4柱仅占位，不参与结论）" if p["hour_unknown"] else ""
        L.append(f"  {p['name']}（{p['gender']}）：四柱 "
                 f"{ps['year']} {ps['month']} {ps['day']} {ps['hour']}；"
                 f"日主{p['day_master']}({GAN_WUXING[p['day_master']]})；"
                 f"十神 年={tg['year']} 月={tg['month']} 日={tg['day']} 时={tg['hour']}{note}")
        st = p["strength"]
        L.append(f"    日主强弱喜忌：{st['level']}；{st['favor']}。依据：{st['basis']}")
        ss = p["chart"].get("shensha") or []
        if ss:
            L.append("    神煞（辅助，不单星断言）：" + "；".join(
                f"{s['name']}({'/'.join(s['pillars'])}柱)" for s in ss))
    L.append("")
    L.append("二、跨盘关系（柱位对齐 4×4=16 组；日柱为夫妻宫，权重最高）")
    d = cross["day_pillar_relation"]
    L.append(f"  ★ 日柱（夫妻宫）对照：{d['who']}，A={d['pair']['a']} B={d['pair']['b']}；"
             + "；".join(r["relation"] for r in d["relations"]))
    L.append("  16 组柱位逐项：")
    for g in cross["pillar_groups"]:
        detail = "；".join(f"{r['scope']}{r['a']}vs{r['b']}={r['relation']}" for r in g["relations"])
        L.append(f"    [{g['weight']}] {g['who']}：{detail}")
    L.append("")
    L.append("  十神交叉（把对方四柱天干放到自己日主下）：")
    for label, key in (("A日主看B", "a_day_master_over_b"), ("B日主看A", "b_day_master_over_a")):
        items = cross["ten_god_cross"][key]
        L.append(f"    {label}：" + "；".join(
            f"{x['who']}→{x['ten_god']}" for x in items))
    L.append("  配偶星（男看正偏财、女看正官七杀；以本人日主判定对方盘）：")
    for key in ("a_spouse_star_in_b", "b_spouse_star_in_a"):
        sp = cross["spouse_star"][key]
        L.append(f"    {sp['seen_from']}({sp['gender']})在{sp['in_chart']}盘中："
                 f"目标十神{'/'.join(sp['target_gods'])}，"
                 f"{'出现' if sp['present'] else '未见'}——" + "；".join(sp["evidence"]))
    L.append("")
    L.append("三、时间线（双方大运 + 基准年前后各 5 年共 11 年流年）")
    for p in (pa, pb):
        cur = p["current"]
        du = cur.get("dayun") or "—"
        rng = cur.get("dayun_range") or []
        L.append(f"  {p['name']}当前大运：{du}"
                 + (f"（{rng[0]}-{rng[1]}）" if len(rng) == 2 else "（区间未标注）"))
    L.append("  流年干支对照表（十神按各自日主标注）：")
    L.append("    年份   A流年(十神)   B流年(十神)")
    for i, la in enumerate(pa["liunian"]):
        lb = pb["liunian"][i]
        L.append(f"    {la['year']}  {la['ganzhi']}({la['shi_shen']})  {lb['ganzhi']}({lb['shi_shen']})")
    L.append("")
    L.append("【校验口径】每条结论已指明柱位（年/月/日/时）、十神或干支关系类型；"
             "神煞只作辅助证据，禁止据单星断言；不做合婚分数或吉凶定性。")
    return "\n".join(L)


def _brief_bazi(p: dict) -> dict:
    cd = p["chart"]
    return {
        "name": p["name"], "gender": p["gender"], "calendar": p["calendar"],
        "hour_unknown": p["hour_unknown"],
        "pillars": dict(cd["pillars"]), "day_master": p["day_master"],
        "ten_gods": dict(cd["ten_gods"]), "wuxing": dict(cd.get("wuxing") or {}),
        "shensha": cd.get("shensha") or [], "strength": p["strength"],
        "dayun": cd.get("dayun") or [], "current_dayun": p["current"],
        "liunian": p["liunian"],
    }


def bazi_marriage(a: dict, b: dict) -> dict:
    """八字合婚：双盘确定性对照，返回事实清单 + 结构化盘面 + 跨盘关系。"""
    steps = []
    as_of_year = _as_of_year(a, b)
    steps.append(f"① 以 bazi.chart() 分别排两盘；时间线基准年={as_of_year}")
    pa = _bazi_person(a, "甲方", as_of_year)
    pb = _bazi_person(b, "乙方", as_of_year)
    for p in (pa, pb):
        if p["hour_unknown"]:
            steps.append(f"   {p['name']}时辰不详：按时柱=午占位排盘，fact 标注『时柱不详，按三柱论』，跳过所有含时柱的结论")
    steps.append("② 计算各自日主强弱喜忌（月令 + 四柱五行本气，依据逐项列出）")
    cross = _bazi_cross(pa, pb)
    steps.append("③ 柱位对齐做 4×4=16 组跨盘对照：天干五合/相冲、地支六合/半合/暗合/六冲/相刑/相害/相破；日柱（夫妻宫）单列最高权重")
    steps.append("④ 十神交叉：把对方四柱天干放到自己日主下判十神；配偶星男看财、女看官，逐柱位/藏干标注")
    steps.append("⑤ 时间同步：取双方当前大运与基准年前后各 5 年共 11 年流年干支，按各自日主标十神")
    fact = _bazi_fact(pa, pb, cross, as_of_year)
    rag_query = (
        f"八字合婚 日柱 夫妻宫 十神 配偶星 财星 官杀 日主 身强身弱 用神 "
        f"{pa['pillars']['day']} {pb['pillars']['day']} "
        f"{pa['pillars']['year']} {pa['pillars']['month']} {pa['pillars']['day']} "
        f"{pb['pillars']['year']} {pb['pillars']['month']} {pb['pillars']['day']} "
        f"天干五合 地支六合 六冲 相刑 相害 大运 流年"
    )
    rag_extra = [pa["pillars"]["day"], pb["pillars"]["day"], pa["day_master"], pb["day_master"],
                 "合婚", "夫妻宫", "配偶星", "日柱", "十神", "大运流年"]
    return {
        "fact": fact,
        "rag_query": rag_query,
        "rag_extra": rag_extra,
        "a_data": _brief_bazi(pa), "b_data": _brief_bazi(pb),
        "cross": cross, "steps": steps,
        "as_of_year": as_of_year,
    }


# ═════════════════════════════ 紫微合婚 ═════════════════════════════
def _palace_key(name: str) -> str:
    """盘面宫名『命宫』带宫字，『夫妻』『福德』不带，统一为带宫形式。"""
    return name if name.endswith("宫") else name + "宫"


def _star_entry(p: dict, s: dict) -> dict:
    return {"name": s.get("name", ""), "brightness": s.get("brightness") or "",
            "mutagen": s.get("mutagen") or "", "palace": p.get("name", ""),
            "branch": p.get("earthlyBranch", ""), "stem": p.get("heavenlyStem", "")}


def _birth_mutagens(chart: dict) -> dict:
    """生年四化：只认盘面星曜上的 mutagen 徽标（禄/权/科/忌）。"""
    out: dict[str, list[dict]] = {m: [] for m in MUTAGEN_ORDER}
    seen = set()
    for p in chart.get("palaces") or []:
        for group in ("majorStars", "minorStars"):
            for s in (p.get(group) or []):
                m = str(s.get("mutagen") or "")
                if m in out and s.get("name") not in seen:
                    seen.add(s.get("name"))
                    out[m].append(_star_entry(p, s))
    return out


def _peach_positions(chart: dict) -> dict:
    out: dict[str, list[dict]] = {s: [] for s in PEACH_STARS}
    for p in chart.get("palaces") or []:
        for group in ("majorStars", "minorStars", "adjectiveStars"):
            for s in (p.get(group) or []):
                if s.get("name") in out:
                    out[s["name"]].append(_star_entry(p, s))
    return out


def _current_decadal(palaces: list[dict], age: int) -> dict:
    for p in palaces:
        dec = p.get("decadal") or {}
        rng = dec.get("range") or []
        if len(rng) == 2 and rng[0] <= age <= rng[1]:
            return {"palace": p.get("name", ""), "branch": p.get("earthlyBranch", ""),
                    "stem": p.get("heavenlyStem", ""), "range": list(rng),
                    "source": "命盘 decadal（虚岁）"}
    return {"palace": "—", "branch": "—", "stem": "—", "range": [], "source": "命盘未标注"}


def _ziwei_person(p: dict, fallback: str, as_of_year: int) -> dict:
    name = _who(p, fallback)
    hour_raw = p.get("hour")
    ti = _hour_index(hour_raw)
    birth_date = f"{int(p['year'])}-{int(p['month'])}-{int(p['day'])}"
    payload = {"date": birth_date, "timeIndex": ti, "gender": _gender(p),
               "fixLeap": True, "calendar": _calendar(p)}
    chart = _chart.get_chart(payload)
    palaces = chart.get("palaces") or []
    branch2palace = {pp.get("earthlyBranch", ""): pp.get("name", "") for pp in palaces}
    star2branch: dict[str, str] = {}
    for pp in palaces:
        for group in ("majorStars", "minorStars"):
            for s in (pp.get(group) or []):
                if s.get("name"):
                    star2branch.setdefault(s["name"], pp.get("earthlyBranch", ""))
    key = {}
    for pp in palaces:
        k = _palace_key(pp.get("name", ""))
        if k in KEY_PALACES.values():
            key[k] = {
                "name": k, "branch": pp.get("earthlyBranch", ""), "stem": pp.get("heavenlyStem", ""),
                "index": pp.get("index"),
                "majorStars": [_star_entry(pp, s) for s in (pp.get("majorStars") or [])],
                "minorStars": [_star_entry(pp, s) for s in (pp.get("minorStars") or [])],
                "adjectiveStars": [s.get("name", "") for s in (pp.get("adjectiveStars") or [])],
            }
    for k in KEY_PALACES.values():
        key.setdefault(k, {"name": k, "branch": "—", "stem": "—", "index": None,
                           "majorStars": [], "minorStars": [], "adjectiveStars": []})
    age = as_of_year - int(p["year"]) + 1  # 虚岁
    horo = chart.get("horoscope") or {}
    if not horo:
        try:
            horo = _chart.horoscope_for(chart, as_of_year) or {}
        except Exception:
            horo = {}
    liunian = []
    for y in range(as_of_year - 5, as_of_year + 6):
        gz = _gz_of_year(y)
        flow = FLOW_MUTAGEN.get(gz[0], {})
        flow_pos = {}
        for m, star in flow.items():
            b = star2branch.get(star)
            flow_pos[m] = {"star": star, "branch": b or "—",
                           "palace": branch2palace.get(b, "—") if b else "—"}
        liunian.append({
            "year": y, "ganzhi": gz, "flow_palace": branch2palace.get(gz[1], "—"),
            "flow_branch": gz[1], "flow_mutagen": flow_pos,
        })
    return {
        "name": name, "gender": _gender(p), "calendar": _calendar(p),
        "time_index": ti, "hour_unknown": hour_raw in (None, ""),
        "chart": chart, "birth_date": birth_date, "solar_date": chart.get("solarDate", ""),
        "lunar_date": chart.get("lunarDate", ""), "chinese_date": chart.get("chineseDate", ""),
        "palaces": palaces, "branch2palace": branch2palace, "star2branch": star2branch,
        "key_palaces": key, "birth_mutagens": _birth_mutagens(chart),
        "peaches": _peach_positions(chart),
        "decadal": _current_decadal(palaces, age), "age": age,
        "horoscope": horo, "horoscope_source": "chart.horoscope" if chart.get("horoscope") else
                       ("chart.horoscope_for" if horo else "盘面 decadal + 干支四化推算（运限脚本不可用）"),
        "liunian": liunian,
    }


def _cross_ziwei(pa: dict, pb: dict) -> dict:
    """双向生年四化同地支投射。"""
    proj = []
    for src, dst, tag in ((pa, pb, "A→B"), (pb, pa, "B→A")):
        for m in MUTAGEN_ORDER:
            for item in src["birth_mutagens"][m]:
                b = item["branch"]
                proj.append({
                    "from": tag, "from_name": src["name"], "to_name": dst["name"],
                    "star": item["name"], "mutagen": m,
                    "from_palace": item["palace"], "from_branch": b,
                    "to_palace": dst["branch2palace"].get(b, "—"), "to_branch": b,
                    "brightness": item.get("brightness", ""),
                })
    return proj


def _fmt_stars(stars: list[dict]) -> str:
    if not stars:
        return "无主星（借对宫）"
    return "、".join(
        f"{s['name']}({s['brightness'] or '亮度未标'})" +
        (f"[{s['mutagen']}]" if s["mutagen"] else "") for s in stars)


def _mutagen_line(p: dict) -> str:
    parts = []
    for m in MUTAGEN_ORDER:
        for it in p["birth_mutagens"][m]:
            parts.append(f"{m}化{it['name']}(落{it['palace']}·{it['branch']})")
    return "，".join(parts) if parts else "未标注"


def _peach_line(p: dict) -> str:
    parts = []
    for star in PEACH_STARS:
        pos = p["peaches"].get(star) or []
        if pos:
            places = "/".join(x["palace"] + "(" + x["branch"] + ")" for x in pos)
            parts.append(f"{star}落{places}")
        else:
            parts.append(f"{star}未见")
    return "；".join(parts)


def _ziwei_fact(pa: dict, pb: dict, proj: list[dict], as_of_year: int,
                horo_note: str) -> str:
    L = []
    L.append("【紫微合婚 · 六维盘面事实清单（引擎确定性计算，AI 唯一依据）】")
    L.append(f"当事人：A={pa['name']}（阳历{pa['solar_date']}）/ B={pb['name']}（阳历{pb['solar_date']}）；"
             f"时间线基准年：{as_of_year}。")
    L.append("说明：不含『合不合』单一结论；每条结论均标注宫位、星曜、亮度、四化或落宫，可逐项核对。")
    L.append(f"两盘十二宫地支映射：A={pa['branch2palace']}；B={pb['branch2palace']}。")
    L.append("")
    for idx, (title, k) in enumerate((("夫妻宫对照（感情相处主轴）", "夫妻宫"),
                                      ("命宫对照（性格主轴）", "命宫"),
                                      ("福德宫对照（内在需求）", "福德宫")), 1):
        L.append(f"{'一二三'[idx-1]}、{title}")
        for p in (pa, pb):
            v = p["key_palaces"][k]
            L.append(f"  {p['name']}{k}：[{v['stem']}{v['branch']}] 主星：{_fmt_stars(v['majorStars'])}；"
                     f"辅星：{'、'.join(s['name'] for s in v['minorStars']) or '无'}；"
                     f"杂曜：{'、'.join(v['adjectiveStars'][:8]) or '无'}")
        a, b = pa["key_palaces"][k], pb["key_palaces"][k]
        am = "、".join(s["name"] for s in a["majorStars"]) or "无主星"
        bm = "、".join(s["name"] for s in b["majorStars"]) or "无主星"
        L.append(f"  对照：{pa['name']}{k}主星[{am}]/{a['branch']} vs "
                 f"{pb['name']}{k}主星[{bm}]/{b['branch']}；"
                 f"亮度与四化见上列各自星曜标注；两宫分属{a['branch']}/{b['branch']}地支，"
                 f"彼此跨盘宫位映射见第四维。")
        L.append("")
    L.append("四、生年四化交叉（一方化星所在宫的地支 → 映射到另一方同地支宫位，双向各一次）")
    L.append(f"  A={pa['name']}生年四化：{_mutagen_line(pa)}")
    L.append(f"  B={pb['name']}生年四化：{_mutagen_line(pb)}")
    for x in proj:
        L.append(f"  {x['from']}：{x['from_name']}{x['star']}化{x['mutagen']}落"
                 f"{x['from_palace']}({x['from_branch']}) → 同地支{x['to_branch']}映射"
                 f"{x['to_name']}{x['to_palace']}({x['to_branch']})")
    L.append("")
    L.append("五、桃花星落宫（红鸾/天喜/咸池/天姚，仅列落宫，不做单星断言）")
    L.append(f"  A={pa['name']}：{_peach_line(pa)}")
    L.append(f"  B={pb['name']}：{_peach_line(pb)}")
    for star in PEACH_STARS:
        for x in (pa["peaches"].get(star) or []):
            b = x["branch"]
            L.append(f"  跨盘：{pa['name']}{star}落{b} → {pb['name']}盘同支宫位『{pb['branch2palace'].get(b, '—')}』")
        for x in (pb["peaches"].get(star) or []):
            b = x["branch"]
            L.append(f"  跨盘：{pb['name']}{star}落{b} → {pa['name']}盘同支宫位『{pa['branch2palace'].get(b, '—')}』")
    L.append("")
    L.append("六、运限时间线对齐（双方当前大限 + 基准年前后各 5 年流年）")
    L.append(f"  运限数据来源：{horo_note}")
    L.append(f"  A={pa['name']}当前大限：{pa['decadal']['palace']}({pa['decadal']['branch']}) "
             f"{pa['decadal']['range']}虚岁，{pa['decadal']['source']}；B={pb['name']}当前大限："
             f"{pb['decadal']['palace']}({pb['decadal']['branch']}) {pb['decadal']['range']}虚岁，{pb['decadal']['source']}")
    L.append("  年份   A流年命宫(干支)   B流年命宫(干支)   A流年四化落宫   B流年四化落宫")
    for la, lb in zip(pa["liunian"], pb["liunian"]):
        fa = "、".join(f"{m}化{v['star']}→{v['palace']}" for m, v in la["flow_mutagen"].items())
        fb = "、".join(f"{m}化{v['star']}→{v['palace']}" for m, v in lb["flow_mutagen"].items())
        L.append(f"  {la['year']}  {la['flow_palace']}({la['ganzhi']})  "
                 f"{lb['flow_palace']}({lb['ganzhi']})  {fa}  {fb}")
    L.append("")
    L.append("【校验口径】六维分列、层次固定；四化与桃花星仅作引动线索，"
             "禁止单星断言；不做匹配分数与合不合定性。")
    return "\n".join(L)


def _brief_ziwei(p: dict) -> dict:
    kp = p["key_palaces"]
    dec = p["decadal"]
    return {
        "name": p["name"], "gender": p["gender"], "calendar": p["calendar"],
        "solarDate": p["solar_date"], "lunarDate": p["lunar_date"],
        "chineseDate": p["chinese_date"], "timeIndex": p["time_index"],
        "hour_unknown": p["hour_unknown"],
        "命宫": kp["命宫"], "夫妻宫": kp["夫妻宫"], "福德宫": kp["福德宫"],
        "branch2palace": dict(p["branch2palace"]),
        "birth_mutagens": {m: [dict(x) for x in p["birth_mutagens"][m]] for m in MUTAGEN_ORDER},
        "peaches": {s: [dict(x) for x in (p["peaches"].get(s) or [])] for s in PEACH_STARS},
        "decadal": dict(dec), "age": p["age"], "horoscope_source": p["horoscope_source"],
        "liunian": p["liunian"],
    }


def ziwei_marriage(a: dict, b: dict) -> dict:
    """紫微合婚：两盘先各自固定，再建六个维度的跨盘对照。"""
    steps = []
    as_of_year = _as_of_year(a, b)
    steps.append("① 按 hour→timeIndex（23点→12；其余(hour+1)//2；未知默认6）调 chart.get_chart() 固定两张完整命盘（fixLeap=True）")
    pa = _ziwei_person(a, "甲方", as_of_year)
    pb = _ziwei_person(b, "乙方", as_of_year)
    steps.append("② 各取命宫/夫妻宫/福德宫主星（含亮度、mutagen）、辅星、杂曜与十二宫地支映射；生年四化只取盘面徽标")
    proj = _cross_ziwei(pa, pb)
    steps.append("③ 双向四化投射：A 生年化星落宫地支→B 同地支宫位，B→A 再做一次")
    steps.append("④ 桃花星红鸾/天喜/咸池/天姚从杂曜中取落宫，并映射到对方同地支宫位；只列落宫不单星断言")
    steps.append("⑤ 运限：优先 chart.horoscope / horoscope_for；本环境若缺运限脚本，用命盘 decadal + 流年干支四化表推算，并在 fact 标注来源")
    steps.append("⑥ 按六维输出可核对事实；不输出合不合结论与分数")
    fact = _ziwei_fact(pa, pb, proj, as_of_year, pa["horoscope_source"])
    am = pa["key_palaces"]["命宫"]["majorStars"]
    bm = pb["key_palaces"]["命宫"]["majorStars"]
    terms = [s["name"] for s in am[:3]] + [s["name"] for s in bm[:3]]
    for m in MUTAGEN_ORDER:
        terms += [x["name"] for x in pa["birth_mutagens"][m]][:1]
        terms += [x["name"] for x in pb["birth_mutagens"][m]][:1]
    rag_query = ("紫微斗数 合婚 夫妻宫 命宫 福德宫 生年四化 化禄 化权 化科 化忌 "
                 "三方四正 对宫 庙旺 落陷 红鸾 天喜 咸池 天姚 大限 流年 " + " ".join(dict.fromkeys(terms)))
    rag_extra = ["夫妻宫", "命宫", "福德宫", "合婚", "生年四化", "大限流年",
                 pa["key_palaces"]["夫妻宫"]["branch"], pb["key_palaces"]["夫妻宫"]["branch"]]
    return {
        "fact": fact,
        "rag_query": rag_query,
        "rag_extra": rag_extra,
        "a_data": _brief_ziwei(pa), "b_data": _brief_ziwei(pb),
        "cross": {
            "夫妻宫对照": {"a": pa["key_palaces"]["夫妻宫"], "b": pb["key_palaces"]["夫妻宫"]},
            "命宫对照": {"a": pa["key_palaces"]["命宫"], "b": pb["key_palaces"]["命宫"]},
            "福德宫对照": {"a": pa["key_palaces"]["福德宫"], "b": pb["key_palaces"]["福德宫"]},
            "四化投射": proj,
            "桃花星分布": {"a": pa["peaches"], "b": pb["peaches"]},
            "运限时间线": {
                "a": {"decadal": pa["decadal"], "liunian": pa["liunian"]},
                "b": {"decadal": pb["decadal"], "liunian": pb["liunian"]},
                "source": pa["horoscope_source"],
            },
        },
        "steps": steps,
        "as_of_year": as_of_year,
    }
