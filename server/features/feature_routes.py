"""calc / deduce 动态路由工厂。

所有查询参数集中在 common_params 依赖里声明，calc 与 deduce 只消费参数字典，
避免同一份长签名在两个端点里复制；新增功能只需注册一个计算函数。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse

import ai
import history
import liuyao
import profile as profile_store
import tarot
from features import calculations, common, context

router = APIRouter()


async def common_params(
    method: str | None = Query(None),
    num1: int | None = Query(None), num2: int | None = Query(None),
    upper: str | None = Query(None), lower: str | None = Query(None),
    moving: int | None = Query(None),
    year: int | None = Query(None), month: int | None = Query(None),
    day: int | None = Query(None), hour: int | None = Query(None),
    minute: int = Query(0), gender: str = Query("男"),
    birth_place: str = Query(""), spread: str = Query("three"),
    calendar: str = Query("solar"),
    when: str | None = Query(None, description="时间/梅花起卦可指定的时刻(ISO)"),
    pillar_year: str | None = Query(None), pillar_month: str | None = Query(None),
    pillar_day: str | None = Query(None), pillar_time: str | None = Query(None),
    lat: float | None = Query(None, description="占星：出生地纬度"),
    lon: float | None = Query(None, description="占星：出生地经度"),
    tz: float = Query(8.0, description="占星：出生地时区(UTC偏移)"),
    place: str = Query("", description="占星：出生地名称"),
    country: str = Query(""), province: str = Query(""), city: str = Query(""),
    question: str = Query(""), q: str = Query(""),
    profile_id: int | None = Query(None), token: str | None = Query(None),
    save: int = Query(0, description="1=把本次出生信息写回档案"),
    force: int = Query(0),
    use_bazi: int = Query(0), use_star: int = Query(0),
    name: str = Query(""), p2_name: str = Query(""),
    p2_year: int | None = Query(None), p2_month: int | None = Query(None),
    p2_day: int | None = Query(None), p2_hour: int | None = Query(None),
    p2_minute: int | None = Query(None), p2_gender: str = Query("女"),
    p2_calendar: str = Query("solar"),
    p2_lat: float | None = Query(None), p2_lon: float | None = Query(None),
    p2_tz: float | None = Query(None), p2_place: str = Query(""),
    p2_city: str = Query(""), p2_province: str = Query(""),
    coins: str | None = Query(None), yaos: str | None = Query(None),
    deck: str | None = Query(None, description="calc 已确定的盘面标识，deduce 原样复用"),
    year_na: int | None = Query(None), yongshen: str = Query(""),
) -> dict:
    """把全部可选查询参数归一成一个字典，供 calc/deduce 共用。"""
    return {
        "method": method, "num1": num1, "num2": num2,
        "upper": upper, "lower": lower, "moving": moving,
        "year": year, "month": month, "day": day, "hour": hour, "minute": minute,
        "gender": gender, "birth_place": birth_place, "spread": spread,
        "calendar": calendar, "when": when,
        "pillar_year": pillar_year, "pillar_month": pillar_month,
        "pillar_day": pillar_day, "pillar_time": pillar_time,
        "lat": lat, "lon": lon, "tz": tz, "place": place,
        "country": country, "province": province, "city": city,
        "question": question, "q": q,
        "profile_id": profile_id, "token": token,
        "save": save, "force": force, "use_bazi": use_bazi, "use_star": use_star,
        "name": name, "p2_name": p2_name,
        "p2_year": p2_year, "p2_month": p2_month, "p2_day": p2_day,
        "p2_hour": p2_hour, "p2_minute": p2_minute, "p2_gender": p2_gender,
        "p2_calendar": p2_calendar,
        "p2_lat": p2_lat, "p2_lon": p2_lon, "p2_tz": p2_tz, "p2_place": p2_place,
        "p2_city": p2_city, "p2_province": p2_province,
        "coins": coins, "yaos": yaos, "deck": deck,
        "year_na": year_na, "yongshen": yongshen,
    }


def _compute(feature: str, compute_fn, params: dict) -> dict | None:
    """计算并兜住第三方库的裸异常，避免透传成 500。"""
    try:
        payload = compute_fn(params)
    except (ValueError, TypeError) as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        # lunar_python 等库对非法输入会抛裸 Exception
        return {"ok": False, "error": f"计算失败：{e}"}
    if not isinstance(payload, dict):
        return {"ok": False, "error": "计算失败：返回格式无效"}
    payload["feature"] = feature
    payload["feature_name"] = history.FEATURE_NAMES[feature]
    return payload


def _lock_deck(feature: str, params: dict, payload: dict, question: str) -> dict:
    """把前端已展示的牌/卦锁定给 AI，保证「用户看到的 == AI 解读的」。

    deck 一旦回传就必须还原成功；绝不能静默回退到重新计算的 payload——
    那会让 AI 解读另一副牌/另一卦，用户看到的两套结果对不上且无从察觉。
    """
    deck = params.get("deck")
    if not deck:
        return payload
    if feature == "tarot":
        locked = tarot.cards_from_deck(deck, params.get("spread") or "three")
        if not locked:
            raise ValueError("牌阵标识无效，请重新抽牌后再解读")
        return locked
    if feature == "liuyao":
        yaos = liuyao.parse_yaos(deck)
        if yaos is None:
            raise ValueError("卦象标识无效，请重新起卦后再解读")
        try:
            from datetime import datetime as dt
            when = params.get("when")
            if isinstance(when, str) and when:
                when = dt.fromisoformat(when.replace("T", " ").replace("Z", ""))
            return liuyao.derive("manual", yaos=yaos, when=when, question=question)
        except (ValueError, TypeError) as exc:
            raise ValueError(f"起卦时间或卦象无效：{exc}") from exc
    return payload


def _mark_identity(feature: str, params: dict, payload: dict) -> None:
    """把属于盘面身份的参数纳入 payload（=纳入去重 key）。"""
    if feature in ("bazi_marriage", "ziwei_marriage", "astrology_marriage"):
        pair = [params.get(k) for k in (
            "name", "p2_name", "year", "month", "day", "hour", "minute", "gender",
            "calendar", "p2_year", "p2_month", "p2_day", "p2_hour",
            "p2_minute", "p2_gender", "p2_calendar")]
        if feature == "astrology_marriage":
            pair += [params.get(k) for k in (
                "lat", "lon", "tz", "place", "p2_lat", "p2_lon", "p2_tz", "p2_place")]
        payload["_pair"] = pair
    if params.get("use_bazi") and feature != "meihua":
        payload["_use_bazi"] = 1
    if params.get("use_star"):
        payload["_use_star"] = 1
    if feature in ("huangli", "huangli_pair") and params.get("p2_year") and params.get("p2_month") and params.get("p2_day"):
        payload["_p2"] = [params.get(k) for k in (
            "p2_name", "p2_year", "p2_month", "p2_day", "p2_hour", "p2_minute", "p2_gender")]
    if feature == "huangli_pair" and params.get("year") and params.get("month") and params.get("day"):
        payload["_p1"] = [params.get(k) for k in (
            "name", "year", "month", "day", "hour", "minute", "gender", "calendar")]


def _make_calc_and_deduce(feature: str, compute_fn):
    async def calc(p: dict = Depends(common_params)):
        # compute_fn 必须 async 执行：py-iztro 依赖 PythonMonkey，非主线程调用会段错误。
        payload = _compute(feature, compute_fn, p)
        if payload is None:
            return {"ok": False, "error": "计算失败"}
        if not payload.get("ok", True):
            return payload
        if p.get("save") and common.auth(p.get("profile_id"), p.get("token")):
            birth = context.birth_of_params(p, payload)
            if birth:
                profile_store.bind_birth(p["profile_id"], birth)
                payload["birth_saved"] = True
        return {"ok": True, **payload}

    async def deduce(p: dict = Depends(common_params)):
        question = (p.get("q") or "").strip()
        if not question:
            return {"ok": False, "error": "问题不能为空"}
        # calc 用 question= 起卦，deduce 用 q= 提问；把 q 回填到 question，
        # 让 compute_fn / 锁盘重算看到同一个问题（fact 的「所问」与检索词才一致）。
        p["question"] = question
        payload = _compute(feature, compute_fn, p)
        if payload is None:
            return {"ok": False, "error": "计算失败"}
        if not payload.get("ok", True):
            return payload
        try:
            payload = _lock_deck(feature, p, payload, question)
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}
        _mark_identity(feature, p, payload)

        pid = common.auth(p.get("profile_id"), p.get("token"))
        if not pid:
            return {"ok": False, "error": "请先登录后再使用 AI 解读与追问"}
        if feature == "meihua" and not context.bazi_complete(pid):
            return {"ok": False, "error": "梅花解卦需结合您的八字命局以提高准确度，请先到「个人中心」补全出生年月日与出生时间（含时辰）。"}

        key = common.dedupe_key(pid, feature, payload, question)
        if not p.get("force"):
            cached = history.find_cached_entry(pid, feature, key)
            if cached:
                return common.sse_replay(cached[1], cached[0])

        if feature == "tarot":
            excerpts = tarot.retrieve_excerpts(payload.get("cards", []), question, total_chars=5200)
        else:
            query = (payload.get("rag_query", "") or "") + " " + question
            excerpts = common._retrieve(feature, query, payload.get("rag_extra"), payload)
        up, recent = context.personalize(pid, feature)
        up, injected = context.augment_profile(
            pid, feature, up, use_bazi=p.get("use_bazi") or 0, use_star=p.get("use_star") or 0,
            y=p.get("year"), m=p.get("month"), d=p.get("day"),
            h=p.get("hour"), mi=p.get("minute"), gender=p.get("gender") or "", name=p.get("name") or "",
            p2_y=p.get("p2_year"), p2_m=p.get("p2_month"), p2_d=p.get("p2_day"),
            p2_h=p.get("p2_hour"), p2_mi=p.get("p2_minute"), p2_gender=p.get("p2_gender") or "",
            p2_name=p.get("p2_name") or "",
        )
        if injected:
            payload["_injected"] = injected
        prompt = ai.build_prompt(
            history.FEATURE_NAMES[feature], payload.get("fact", ""), question,
            excerpts, user_profile=up, history=recent,
        )

        def persist(text: str) -> int:
            return history.save(pid, feature, question, text, payload, key)

        return StreamingResponse(
            common.answer_events(prompt, persist),
            media_type="text/event-stream", headers={"Cache-Control": "no-cache"},
        )

    router.add_api_route(f"/api/{feature}/calc", calc, methods=["GET"])
    router.add_api_route(f"/api/{feature}/deduce", deduce, methods=["GET"])


@router.get("/api/bazi/pillars_to_date")
async def api_bazi_pillars_to_date(
    pillar_year: str = Query(...), pillar_month: str = Query(...),
    pillar_day: str = Query(...), pillar_time: str = Query(...),
):
    """注册弹窗「输入方式：八字」用：四柱干支 → 出生公历日期。"""
    try:
        res = calculations.bazi.pillars_to_solar(pillar_year, pillar_month, pillar_day, pillar_time)
        return {"ok": True, **res}
    except (ValueError, TypeError) as e:
        return {"ok": False, "error": str(e)}


@router.get("/api/huangli/month")
async def api_huangli_month(year: int = Query(...), month: int = Query(...)):
    """整月农历概览 + 前后月补位天：给黄历月历视图用。"""
    import calendar as cal
    from datetime import date as date_cls
    from lunar_python import Solar

    if not (1 <= month <= 12) or not (1901 <= year <= 2099):
        return {"ok": False, "error": "日期超出支持范围"}

    today_iso = date_cls.today().isoformat()

    def day_info(y, m, d, offset):
        solar = Solar.fromYmd(y, m, d)
        lunar = solar.getLunar()
        label = lunar.getDayInChinese()
        if lunar.getDay() == 1:
            label = lunar.getMonthInChinese() + "月"
        marks = []
        jq = lunar.getJieQi()
        if jq:
            marks.append(jq)
        marks += solar.getFestivals() + lunar.getFestivals()
        return {"d": d, "off": offset, "lunar": label,
                "mark": marks[0] if marks else "",
                "today": f"{y}-{m:02d}-{d:02d}" == today_iso}

    days = [day_info(year, month, d, 0) for d in range(1, cal.monthrange(year, month)[1] + 1)]
    lead_wd = (date_cls(year, month, 1).weekday() + 1) % 7
    lead = []
    if lead_wd:
        pm, py = (month - 1, year) if month > 1 else (12, year - 1)
        pm_last = cal.monthrange(py, pm)[1]
        lead = [day_info(py, pm, d, -1) for d in range(pm_last - lead_wd + 1, pm_last + 1)]
    filled = (len(lead) + len(days) + 6) // 7 * 7
    nm, ny = (month + 1, year) if month < 12 else (1, year + 1)
    tail = [day_info(ny, nm, d, 1) for d in range(1, filled - len(lead) - len(days) + 1)]
    mid_lunar = Solar.fromYmd(year, month, 15).getLunar()
    return {
        "ok": True, "year": year, "month": month,
        "lunar_year": mid_lunar.getYearInGanZhi(),
        "lunar_month": mid_lunar.getMonthInChinese() + "月",
        "days": days, "lead": lead, "tail": tail,
    }


_make_calc_and_deduce("meihua", calculations.calc_meihua)
_make_calc_and_deduce("bazi", calculations.calc_bazi)
_make_calc_and_deduce("huangli", calculations.calc_huangli)
_make_calc_and_deduce("huangli_pair", calculations.calc_huangli)
_make_calc_and_deduce("tarot", calculations.calc_tarot)
_make_calc_and_deduce("astrology", calculations.calc_astrology)
_make_calc_and_deduce("bazi_marriage", calculations.calc_bazi_marriage)
_make_calc_and_deduce("ziwei_marriage", calculations.calc_ziwei_marriage)
_make_calc_and_deduce("astrology_marriage", calculations.calc_astrology_marriage)
_make_calc_and_deduce("liuyao", calculations.calc_liuyao)
_make_calc_and_deduce("qimen", calculations.calc_qimen)
