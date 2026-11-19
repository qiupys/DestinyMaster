"""四功能统一 API 路由（八字/梅花/塔罗/黄历）：计算 → RAG 检索 → 个性化 → AI 流式解读 → 落盘。

每个功能提供两个端点：
- GET /api/<feature>/calc : 确定性计算（含 RAG 摘录，可核对，不调模型）
- GET /api/<feature>/deduce : AI 流式解读（SSE），带去重缓存与历史落盘

沿用 main.py 约定：GET + /api/ 前缀；登录用户传 profile_id+token 时落历史。
"""
from __future__ import annotations

import asyncio
import hashlib
import json

from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse

import ai
import bazi
import history
import huangli
import meihua
import profile as profile_store
import rag  # 紫微 iztro-learn 语料检索（其余功能用 rag_kb）
import rag_kb
import tarot

router = APIRouter()

FEATURES = ("bazi", "meihua", "tarot", "huangli")


def _auth(pid: int | None, token: str | None) -> int | None:
    if pid and token and profile_store.auth(pid, token):
        return pid
    return None


def _retrieve(feature: str, query: str, extra, payload: dict | None = None) -> list[str]:
    """通用功能 RAG 检索。梅花语料含爻辞+各家解卦，需更大额度并让本卦优先。"""
    if feature == "meihua":
        return rag_kb.retrieve(feature, query, extra, top_k=10, max_chars=3600,
                               primary=(payload or {}).get("rag_primary_idx"))
    return rag_kb.retrieve(feature, query, extra, top_k=5, max_chars=1400)


def _dedupe_key(pid: int | None, feature: str, payload: dict, question: str) -> str:
    raw = json.dumps({"f": feature, "p": payload, "q": question},
                     ensure_ascii=False, sort_keys=True)
    return hashlib.md5(raw.encode()).hexdigest()[:16] + (f":{pid}" if pid else "")


def _birth_of_params(params: dict, payload: dict) -> dict | None:
    """从排盘参数里还原标准出生信息，用于写回档案。

    两种输入方式：
    - 直接给年月日时分（date 模式）
    - 给四柱干支（bazi 模式）：用排盘时反查出的公历日期
    """
    # 四柱输入：排盘时已反查过公历
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
    return {
        "year": int(y), "month": int(m), "day": int(d),
        "hour": int(params.get("hour") or 0), "minute": int(params.get("minute") or 0),
        "gender": params.get("gender") or "男",
        "know_time": True, "calendar": params.get("calendar") or "solar",
    }


def _bazi_of_profile(pid: int) -> str:
    """把档案出生信息换算成四柱文本，供「导入本人八字」类场景注入 prompt。"""
    if not pid:
        return ""
    try:
        birth = history.personalization(pid, "bazi").get("birth") or {}
        y, m, d = birth.get("year"), birth.get("month"), birth.get("day")
        if not (y and m and d):
            raw = str(birth.get("date") or "")
            if raw.count("-") == 2:
                y, m, d = (int(x) for x in raw.split("-"))
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


def _personalize(pid: int | None, feature: str) -> tuple[str, list[dict]]:
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


def _make_calc_and_deduce(feature: str, compute_fn):
    """工厂：为一个功能生成 calc + deduce 两个端点，避免重复代码。"""

    def calc():
        def endpoint(
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
            question: str = Query(""),
            profile_id: int | None = Query(None), token: str | None = Query(None),
            save: int = Query(0, description="1=把本次出生信息写回档案（用户主动修改时用）"),
        ):
            params = dict(method=method, num1=num1, num2=num2, upper=upper, lower=lower,
                          moving=moving, year=year, month=month, day=day, hour=hour,
                          minute=minute, gender=gender, birth_place=birth_place, spread=spread,
                          calendar=calendar, when=when,
                          pillar_year=pillar_year, pillar_month=pillar_month,
                          pillar_day=pillar_day, pillar_time=pillar_time)
            try:
                payload = compute_fn(params)
            except (ValueError, TypeError) as e:
                return {"ok": False, "error": str(e)}
            payload["feature"] = feature
            payload["feature_name"] = history.FEATURE_NAMES[feature]
            # 用户主动修改出生信息时，把新的出生信息写回档案（档案是全站唯一数据源）。
            # 只对有出生信息的排盘功能生效（八字），梅花/塔罗/黄历不涉及。
            if save and profile_store.auth(profile_id or 0, token or ""):
                birth = _birth_of_params(params, payload)
                if birth:
                    profile_store.bind_birth(profile_id, birth)
                    payload["birth_saved"] = True
            return {"ok": True, **payload}
        return endpoint

    def deduce():
        async def endpoint(
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
            q: str = Query(""),
            profile_id: int | None = Query(None), token: str | None = Query(None),
            force: int = Query(0),
            use_bazi: int = Query(0, description="1=把登录用户档案八字一并作为解读参考"),
            deck: str | None = Query(None, description="塔罗：前端抽牌结果，锁定同一副牌供 AI 解读"),
        ):
            question = (q or "").strip()
            if not question:
                return {"ok": False, "error": "问题不能为空"}
            params = dict(method=method, num1=num1, num2=num2, upper=upper, lower=lower,
                          moving=moving, year=year, month=month, day=day, hour=hour,
                          minute=minute, gender=gender, birth_place=birth_place, spread=spread,
                          calendar=calendar, when=when,
                          pillar_year=pillar_year, pillar_month=pillar_month,
                          pillar_day=pillar_day, pillar_time=pillar_time)
            try:
                payload = compute_fn(params)
            except (ValueError, TypeError) as e:
                return {"ok": False, "error": str(e)}
            # 塔罗：若前端回传了已抽出的牌，用它覆盖随机抽牌，保证「用户看到的牌 == AI 解读的牌」
            if feature == "tarot" and deck:
                locked = tarot.cards_from_deck(deck, spread)
                if locked:
                    payload = locked

            pid = _auth(profile_id, token)
            key = _dedupe_key(pid, feature, payload, question)
            if pid and not force:
                cached = history.find_cached_entry(pid, feature, key)
                if cached:
                    return _sse_replay(cached[1], cached[0])

            # RAG 检索：普通功能按关键词打分；塔罗一牌一篇，改为按抽到的 slug 精确取文献，
            # 既不会混入没抽到的牌，追问时也能聚焦到用户问的那一张（见 tarot.retrieve_excerpts）。
            if feature == "tarot":
                excerpts = tarot.retrieve_excerpts(payload.get("cards", []), question, total_chars=5200)
            else:
                query = payload.get("rag_query", "") + " " + question
                excerpts = _retrieve(feature, query, payload.get("rag_extra"), payload)
            up, recent = _personalize(pid, feature)
            if use_bazi and pid:
                line = _bazi_of_profile(pid)
                if line:
                    up = (up + "\n" + line).strip()
            prompt = ai.build_prompt(
                history.FEATURE_NAMES[feature], payload["fact"], question,
                excerpts, user_profile=up, history=recent,
            )

            async def gen():
                full = ""
                disc_sent = False
                try:
                    async for delta in ai.stream_answer(prompt):
                        if delta:
                            full += delta
                            yield f"data: {json.dumps({'delta': delta}, ensure_ascii=False)}\n\n"
                    # 系统统一附加免责声明（正文之后），并计入落盘文本，保证回放/追问看到的版本一致
                    if full.strip():
                        tail = _with_disclaimer(full)
                        if tail != full.rstrip():
                            disc = tail[len(full.rstrip()):]
                            full = tail
                            yield f"data: {json.dumps({'delta': disc}, ensure_ascii=False)}\n\n"
                        disc_sent = True
                    if pid and full.strip():
                        hid = history.save(pid, feature, question, full.strip(), payload, key)
                        # 回传历史 id：前端据此在这张解读卡上启用「继续追问」（复用 followup）
                        yield f"data: {json.dumps({'hid': hid}, ensure_ascii=False)}\n\n"
                    yield "data: [DONE]\n\n"
                except asyncio.CancelledError:
                    if pid and full.strip():
                        if not disc_sent:
                            full = _with_disclaimer(full)
                        hid = history.save(pid, feature, question, full.strip(), payload, key)
                        yield f"data: {json.dumps({'hid': hid}, ensure_ascii=False)}\n\n"
                    raise

            return StreamingResponse(
                gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"}
            )
        return endpoint

    router.add_api_route(f"/api/{feature}/calc", calc(), methods=["GET"])
    router.add_api_route(f"/api/{feature}/deduce", deduce(), methods=["GET"])


def _with_disclaimer(answer: str) -> str:
    """正文后统一附加免责声明（系统负责，模型不再自行撰写）。已含则不重复。"""
    text = (answer or "").rstrip()
    if ai.DISCLAIMER in text:
        return text
    return text + "\n\n---\n\n" + ai.DISCLAIMER if text else ai.DISCLAIMER


def _sse_replay(answer: str, hid: int | None = None) -> StreamingResponse:
    answer = _with_disclaimer(answer)
    async def replay():
        yield f"data: {json.dumps({'cached': True}, ensure_ascii=False)}\n\n"
        yield f"data: {json.dumps({'delta': answer}, ensure_ascii=False)}\n\n"
        if hid:
            yield f"data: {json.dumps({'hid': hid}, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"
    return StreamingResponse(replay(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache"})


# ---- 各功能计算函数：从公共参数字典取所需字段 ----

def _calc_meihua(p: dict) -> dict:
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
    )


def _calc_bazi(p: dict) -> dict:
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


def _calc_huangli(p: dict) -> dict:
    from datetime import date
    today = date.today()
    return huangli.query(p.get("year") or today.year,
                         p.get("month") or today.month,
                         p.get("day") or today.day)


def _calc_tarot(p: dict) -> dict:
    return tarot.draw(p.get("spread") or "three")


@router.get("/api/bazi/pillars_to_date")
async def api_bazi_pillars_to_date(
    pillar_year: str = Query(...), pillar_month: str = Query(...),
    pillar_day: str = Query(...), pillar_time: str = Query(...),
):
    """注册弹窗「输入方式：八字」用：四柱干支 → 出生公历日期。"""
    try:
        res = bazi.pillars_to_solar(pillar_year, pillar_month, pillar_day, pillar_time)
        return {"ok": True, **res}
    except (ValueError, TypeError) as e:
        return {"ok": False, "error": str(e)}


@router.get("/api/huangli/month")
async def api_huangli_month(year: int = Query(...), month: int = Query(...)):
    """整月农历概览 + 前后月补位天：给黄历月历视图用。

    days: 本月每天 {d, lunar, mark, today}；lead: 上月补位天；tail: 下月补位天。
    前端以周日开头、6 行 × 7 列固定网格渲染，lead/tail 用于填满网格边缘。
    """
    import calendar as _cal
    from datetime import date as _date
    from lunar_python import Solar

    if not (1 <= month <= 12) or not (1901 <= year <= 2099):
        return {"ok": False, "error": "日期超出支持范围"}

    today_iso = _date.today().isoformat()

    def day_info(y, m, d, offset):
        solar = Solar.fromYmd(y, m, d)
        lunar = solar.getLunar()
        label = lunar.getDayInChinese()
        if lunar.getDay() == 1:  # 农历每月第一天显示月名，如「十月」
            label = lunar.getMonthInChinese() + "月"
        marks = []
        jq = lunar.getJieQi()
        if jq:
            marks.append(jq)
        marks += solar.getFestivals() + lunar.getFestivals()
        return {
            "d": d, "off": offset, "lunar": label,
            "mark": marks[0] if marks else "",
            "today": f"{y}-{m:02d}-{d:02d}" == today_iso,
        }

    days = [day_info(year, month, d, 0) for d in range(1, _cal.monthrange(year, month)[1] + 1)]

    # 周日开头的网格：第一天是星期几（0=周日）
    lead_wd = (_date(year, month, 1).weekday() + 1) % 7
    lead = []
    if lead_wd:
        pm, py = (month - 1, year) if month > 1 else (12, year - 1)
        pm_last = _cal.monthrange(py, pm)[1]
        lead = [day_info(py, pm, d, -1) for d in range(pm_last - lead_wd + 1, pm_last + 1)]

    filled = (len(lead) + len(days) + 6) // 7 * 7  # 补满整周
    tail = []
    nm, ny = (month + 1, year) if month < 12 else (1, year + 1)
    for d in range(1, filled - len(lead) - len(days) + 1):
        tail.append(day_info(ny, nm, d, 1))

    # 月历头部的农历标签：取月中（15 日）的农历年干支与月名，避免月初/月末跨界误差
    mid_lunar = Solar.fromYmd(year, month, 15).getLunar()
    return {
        "ok": True, "year": year, "month": month,
        "lunar_year": mid_lunar.getYearInGanZhi(),
        "lunar_month": mid_lunar.getMonthInChinese() + "月",
        "days": days, "lead": lead, "tail": tail,
    }


_make_calc_and_deduce("meihua", _calc_meihua)
_make_calc_and_deduce("bazi", _calc_bazi)
_make_calc_and_deduce("huangli", _calc_huangli)
_make_calc_and_deduce("tarot", _calc_tarot)


# ---- 历史与个人中心端点 ----

@router.get("/api/history/list")
async def api_history_list(
    profile_id: int = Query(...), token: str = Query(...),
    feature: str | None = Query(None), limit: int = Query(50), offset: int = Query(0),
):
    pid = _auth(profile_id, token)
    if not pid:
        return {"ok": False, "error": "登录状态失效，请重新登录"}
    return {"ok": True, "items": history.list_history(pid, feature, limit, offset)}


@router.get("/api/history/detail")
async def api_history_detail(
    profile_id: int = Query(...), token: str = Query(...), id: int = Query(...),
):
    pid = _auth(profile_id, token)
    if not pid:
        return {"ok": False, "error": "登录状态失效，请重新登录"}
    item = history.get_detail(pid, id)
    return {"ok": bool(item), "item": item}


@router.post("/api/history/delete")
async def api_history_delete(request: Request):
    """删除一条历史提问（二次确认由前端负责）；仅能删除本人记录。"""
    try:
        body = await request.json()
    except Exception:
        return {"ok": False, "error": "参数错误"}
    try:
        pid = _auth(int(body.get("profile_id") or 0), body.get("token") or "")
        hid = int(body.get("id") or 0)
    except (TypeError, ValueError):
        return {"ok": False, "error": "参数错误"}
    if not pid:
        return {"ok": False, "error": "登录状态失效，请重新登录"}
    return {"ok": history.delete_one(pid, hid)}


@router.get("/api/history/stats")
async def api_history_stats(profile_id: int = Query(...), token: str = Query(...)):
    pid = _auth(profile_id, token)
    if not pid:
        return {"ok": False, "error": "登录状态失效，请重新登录"}
    return {"ok": True, **history.stats(pid)}


@router.get("/api/history/followup")
async def api_history_followup(
    profile_id: int = Query(...), token: str = Query(...),
    id: int = Query(...), q: str = Query(...),
):
    """在一条历史记录上继续追问：沿用当次盘面事实（不重算），AI 流式回答并另存一条历史。"""
    pid = _auth(profile_id, token)
    if not pid:
        return {"ok": False, "error": "登录状态失效，请重新登录"}
    item = history.get_detail(pid, id)
    if not item:
        return {"ok": False, "error": "未找到该记录"}
    question = (q or "").strip()
    if not question:
        return {"ok": False, "error": "问题不能为空"}
    payload = item.get("payload") or {}
    feature = item.get("feature", "")
    name = history.FEATURE_NAMES.get(feature, feature)
    up, recent = _personalize(pid, feature)
    # 对话链：当前被追问的这条（带完整回答要点）+ 更早的近期历史。
    # recent 里含当前项，先剔除避免重复；反序成 time 从旧到新，
    # prompt 装配取 [-6:] 得到最近 6 轮，结论保持一致。
    earlier = [h for h in (recent or [])
               if not (h.get("ts") == item.get("ts") and h.get("question") == item.get("question"))]
    prior = list(reversed(earlier)) + [{
        "ts": item.get("ts", ""), "question": item.get("question", ""),
        "answer": item.get("answer", ""),
    }]

    if feature == "ziwei":
        # 紫微：用落盘的 ziwei_data 重建命盘事实，无需内存 chart；追问词刷新 RAG 摘录。
        data = dict(payload.get("ziwei_data") or {})
        kws = rag.keywords_from(question + " " + item.get("question", ""),
                                extra=(payload.get("rag_extra") or []))
        kb = rag.retrieve(kws)
        if kb:
            data["kb_block"] = ("【知识库摘录（星曜/宫位/格局释义，供引用增强解读；"
                                "若与盘面数据冲突，以盘面数据为准）】\n" + "\n\n".join(kb) + "\n\n")
        p = profile_store.get_profile(pid)
        summary = (p.get("summary") or "")[:1800] if p else ""
        prompt = ai.build_ziwei_prompt(data, question, prior,
                                       profile_summary=summary, user_profile=up)
    else:
        # 追问检索：塔罗按 slug 精确取文献并把追问聚焦的那张牌置顶；其余功能按关键词打分
        if feature == "tarot":
            excerpts = tarot.retrieve_excerpts(payload.get("cards", []), question, total_chars=5200)
        else:
            query = ((payload.get("rag_query") or "") + " " + item.get("question", "") + " " + question).strip()
            excerpts = _retrieve(feature, query, payload.get("rag_extra"), payload)
        prompt = ai.build_prompt(name, payload.get("fact", ""), question, excerpts,
                                 user_profile=up, history=prior)

    async def gen():
        full = ""
        try:
            async for delta in ai.stream_answer(prompt):
                if delta:
                    full += delta
                    yield f"data: {json.dumps({'delta': delta}, ensure_ascii=False)}\n\n"
            if full.strip():
                tail = _with_disclaimer(full)
                if tail != full.rstrip():
                    disc = tail[len(full.rstrip()):]
                    full = tail
                    yield f"data: {json.dumps({'delta': disc}, ensure_ascii=False)}\n\n"
                new_id = history.save(pid, feature, question, full.strip(), payload, None)
                # 回传新历史 id：追问结果卡继续支持下一轮追问，形成多轮链
                yield f"data: {json.dumps({'hid': new_id}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
        except asyncio.CancelledError:
            raise

    return StreamingResponse(
        gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"}
    )


@router.get("/api/kb/stats")
async def api_kb_stats():
    return {"ok": True, "corpora": rag_kb.kb_stats()}
