"""紫微斗数 · 智能推演 — FastAPI 服务入口。

注：本机环境存在透明代理会拦截 POST 请求体，因此核心排盘 API 采用 GET
（profile 注册/登录用 POST JSON，线上 nginx 正常转发）；
命盘在服务端按 id 缓存，推演时仅传 id + 问题（可选指定流年年份）。
登录用户（profile_id+token）的问答自动落盘并定期 LLM 压缩为档案摘要。
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import time
import uuid
from collections import deque
from datetime import date as _date
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE / "server"))

from fastapi import FastAPI, Query
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from chart import get_chart, horoscope_for
from deduce import stream_deduce
import prompt as zw_prompt
import ai  # 统一 AI 解读层（prompt 装配 / stream_answer / 免责）
import history  # 统一历史落盘与追问（feature_history 表）
import profile as profile_store
import feature_api  # 全功能统一路由（含紫微 deduce / 历史 / followup）
from applog import log

# API key：优先读环境变量，其次读 server/.apikey
if not os.environ.get("CODEBUDDY_API_KEY"):
    keyfile = BASE / "server" / ".apikey"
    if keyfile.exists():
        os.environ["CODEBUDDY_API_KEY"] = keyfile.read_text().strip()

app = FastAPI(title="紫微斗数 · 智能推演")

# 管理员运行日志（内存环形缓冲）：只记方法/脱敏路径/状态/耗时/时间，
# 绝不含 query string、问题、答案、出生信息、token——管理员也不接触对话内容。
ADMIN_LOGS: deque = deque(maxlen=500)
_SENSITIVE_Q = re.compile(r"(q|question|token|birth|password|pass_hash|answer)=[^&]*", re.I)


@app.middleware("http")
async def _admin_access_log(request: Request, call_next):
    started = time.time()
    try:
        resp = await call_next(request)
        status = resp.status_code
    except Exception:
        status = 500
        raise
    finally:
        raw = request.url.query or ""
        safe_q = _SENSITIVE_Q.sub(r"\1=***", raw)
        path = request.url.path + (("?" + safe_q) if safe_q else "")
        ADMIN_LOGS.append({
            "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
            "method": request.method,
            "path": path[:240],
            "status": status,
            "ms": int((time.time() - started) * 1000),
            "client": (request.client.host if request.client else "") or "",
        })
    return resp


# 命盘缓存: id -> {"chart":..., "history":[{role, content}], "profile_id": int|None}
CHARTS: dict[str, dict] = {}
MAX_HISTORY = 12
# 流曜缓存: (id, year, month) -> horoscope
HOROS: dict[tuple, dict] = {}

# 问题文本中的「YYYY年M月」时机指向
_YM_RE = re.compile(r"(\d{4})\s*年\s*(\d{1,2})\s*月")


class AuthBody(BaseModel):
    name: str
    password: str
    birth: dict | None = None


@app.post("/api/profile/register")
async def api_profile_register(body: AuthBody):
    if not body.birth:
        return {"ok": False, "error": "缺少出生信息"}
    return profile_store.register(body.name, body.password, body.birth)


@app.post("/api/profile/login")
async def api_profile_login(body: AuthBody):
    return profile_store.login(body.name, body.password)


@app.get("/api/profile/get")
async def api_profile_get(
    id: int = Query(...),
    token: str = Query(...),
):
    if not profile_store.auth(id, token):
        return {"ok": False, "error": "登录状态失效，请重新登录"}
    p = profile_store.get_profile(id)
    if not p:
        return {"ok": False, "error": "档案不存在"}
    return {"ok": True, "profile": p}


class ProfileUpdateBody(BaseModel):
    profile_id: int
    token: str
    name: str | None = None
    birth: dict | None = None
    new_password: str | None = None
    old_password: str | None = None


@app.post("/api/profile/update")
async def api_profile_update(body: ProfileUpdateBody):
    if not profile_store.auth(body.profile_id, body.token):
        return {"ok": False, "error": "登录状态失效，请重新登录"}
    return profile_store.update_profile(
        body.profile_id,
        name=body.name, birth=body.birth,
        new_password=body.new_password, old_password=body.old_password,
    )


# ---------------- 管理员端点：口令在 server/.adminkey，可删用户、不可见用户资料 ----------------
from fastapi import Request
from fastapi import HTTPException

ADMIN_KEY_FILE = BASE / "server" / ".adminkey"
ADMIN_KEY = ADMIN_KEY_FILE.read_text().strip() if ADMIN_KEY_FILE.exists() else ""


def _check_admin(request: Request) -> None:
    if not ADMIN_KEY or request.headers.get("x-admin-key") != ADMIN_KEY:
        raise HTTPException(status_code=401, detail="管理员口令不正确")


class AdminBody(BaseModel):
    name: str


@app.get("/api/admin/list")
async def api_admin_list(request: Request):
    _check_admin(request)
    return profile_store.admin_list()


@app.post("/api/admin/delete")
async def api_admin_delete(request: Request, body: AdminBody):
    _check_admin(request)
    return profile_store.admin_delete(body.name)


@app.get("/api/admin/logs")
async def api_admin_logs(request: Request, limit: int = Query(200, ge=1, le=500)):
    """运行日志：仅方法/脱敏路径/状态/耗时，不含任何对话内容。"""
    _check_admin(request)
    items = list(ADMIN_LOGS)[-limit:]
    items.reverse()  # 最新在前
    return {"ok": True, "items": items, "total": len(ADMIN_LOGS)}


@app.get("/api/chart")
async def api_chart(
    date: str = Query(..., description="出生日期 YYYY-M-D"),
    timeIndex: int = Query(..., ge=0, le=12, description="时辰序号 0~12"),
    gender: str = Query(..., description="男 / 女"),
    calendar: str = Query("solar", description="solar / lunar"),
    fixLeap: bool = Query(True),
    profile_id: int | None = Query(None, description="可选：绑定登录档案"),
    token: str | None = Query(None),
    save: int = Query(0, description="1=把本次出生信息写回档案（用户主动修改时用）"),
    hour: int | None = Query(None, description="精确出生小时 0-23，写回档案时保留"),
    minute: int = Query(0, description="精确出生分钟，写回档案时保留"),
    know_time: int = Query(1, description="是否知道出生时间，写回档案时保留"),
):
    try:
        chart = get_chart({"date": date, "timeIndex": timeIndex, "gender": gender,
                           "calendar": calendar, "fixLeap": fixLeap})
    except Exception as e:
        return {"ok": False, "error": str(e)}
    chart_id = uuid.uuid4().hex[:12]
    pid = profile_id if profile_store.auth(profile_id or 0, token or "") else None
    CHARTS[chart_id] = {"chart": chart, "history": [], "profile_id": pid, "chart_id": chart_id}
    if len(CHARTS) > 100:  # 防止内存无限增长
        for k in list(CHARTS)[:-100]:
            CHARTS.pop(k, None)
    # 只有用户主动修改出生信息（save=1）才写回档案；
    # 普通排盘不覆盖，避免紫微的时辰粒度把八字里精确到分的出生时间冲掉。
    if pid and save:
        profile_store.bind_birth(pid, {
            "date": date, "timeIndex": timeIndex, "gender": gender, "calendar": calendar,
            "hour": hour, "minute": minute, "know_time": bool(know_time),
        })
    return {"ok": True, "id": chart_id, "chart": chart}


@app.get("/api/horoscope")
async def api_horoscope(
    id: str = Query(...),
    year: int = Query(..., description="目标公历年份"),
    month: int | None = Query(None, ge=1, le=12),
):
    session = CHARTS.get(id)
    if not session:
        return {"ok": False, "error": "命盘缓存失效，请重新排盘"}
    key = (id, year, month or 0)
    if key not in HOROS:
        horo = horoscope_for(session["chart"], year, month)
        if not horo:
            return {"ok": False, "error": "运限计算失败"}
        HOROS[key] = horo
        if len(HOROS) > 500:
            for k in list(HOROS)[:-500]:
                HOROS.pop(k, None)
    return {"ok": True, "horoscope": HOROS[key]}


def _rebuild_session_from_profile(chart_id: str, pid: int | None):
    """服务重启后用登录档案的出生信息重建命盘会话。

    排盘是确定性计算（无随机），档案 birth 是登录用户的唯一出生信息源，
    因此可用它重建与内存会话同构的 chart，让追问不因重启中断。
    取不到有效出生信息时返回 None，由调用方给出「请重新排盘」提示。
    """
    if not pid:
        return None
    prof = profile_store.get_profile(pid)
    b = (prof or {}).get("birth") or {}
    date = b.get("date")
    if not date and all(b.get(k) is not None for k in ("year", "month", "day")):
        date = "%s-%s-%s" % (b["year"], b["month"], b["day"])
    if not date:
        return None
    gender = b.get("gender") or "男"
    ti = b.get("timeIndex")
    if ti is None:
        if b.get("know_time") is False:
            ti = 6
        else:
            h = b.get("hour")
            ti = 6 if h is None else (12 if int(h) == 23 else (int(h) + 1) // 2)
    try:
        chart = get_chart({"date": date, "timeIndex": int(ti), "gender": gender,
                           "calendar": b.get("calendar", "solar"), "fixLeap": True})
    except Exception:
        return None
    session = {"chart": chart, "history": [], "profile_id": pid, "chart_id": chart_id}
    CHARTS[chart_id] = session
    return session


@app.get("/api/deduce/check")
async def api_deduce_check(
    key: str = Query(..., description="去重键（档案+视图+宫位+问题）"),
    profile_id: int = Query(...),
    token: str = Query(...),
):
    """查询同题推演是否已存在（供前端把按钮换成「查看历史推演」并跳转，不重复生成）。"""
    if not profile_store.auth(profile_id, token):
        return {"ok": False, "error": "登录状态失效，请重新登录"}
    hit = profile_store.find_cached_full(profile_id, key)
    if not hit:
        return {"ok": True, "cached": False}
    return {"ok": True, "cached": True, **hit}


@app.get("/api/deduce")
async def api_deduce(
    id: str = Query(...),
    q: str = Query(...),
    year: int | None = Query(None, description="可选：针对该流年年份推演（立春界）"),
    month: int | None = Query(None, ge=1, le=12, description="可选：针对该公历月推演（注入覆盖该月的流月盘，节气界）"),
    focus: str | None = Query(None, description="可选：逗号分隔的检索聚焦词（宫位星曜等）"),
    key: str | None = Query(None, description="可选：去重键（档案+视图+宫位+问题），命中则复用上次回答"),
    force: int = Query(0, description="1=跳过缓存强制重新生成"),
    profile_id: int | None = Query(None, description="可选：登录档案（重启后命盘会话失效仍可复用缓存）"),
    token: str | None = Query(None),
):
    question = q.strip()
    if not question:
        return {"ok": False, "error": "问题不能为空"}
    # 从问题文本中提取「YYYY年M月」形式的时机指向（如"2027年7月投资如何"），
    # 显式 year/month 参数优先；仅识别近期年份，避免把用户报的出生日期误当推演目标
    month_q = month
    if year is None:
        m = _YM_RE.search(question)
        if m:
            yy, mm = int(m.group(1)), int(m.group(2))
            if 1900 <= yy <= 2100 and 1 <= mm <= 12 and yy >= _date.today().year - 1:
                year, month_q = yy, mm
    # 档案身份：必须是有效的显式凭据（统一链路前端始终带 authParam）。
    # 绝不再从命盘会话回落 profile_id —— chart_id 只是 12 位随机串，一旦泄露（浏览器历史、
    # 日志、转发链接），回落会让攻击者仅凭 id 就借用他人身份推演、消耗额度并写入他人历史。
    pid = None
    if profile_id and token and profile_store.auth(profile_id, token):
        pid = profile_id

    # AI 推演要求登录（与前端门禁一致；未登录/凭据失效直接拒绝，不消耗模型额度）
    if not pid:
        return {"ok": False, "error": "请先登录后再使用 AI 解读与追问"}

    session = CHARTS.get(id)
    if session and session.get("profile_id") and session["profile_id"] != pid:
        # 命盘属于别的账号：即使用户自己的 token 有效，也不能借他人盘面推演、更不能让
        # _record 把对话写进对方会话/档案。用自己出生信息重新排盘即可正常继续。
        return {"ok": False, "error": "该命盘属于其他账号，请用您自己的出生信息重新排盘"}
    if not session:
        # 服务重启会清空内存 CHARTS。登录用户的出生信息以档案为唯一源，
        # 这里用档案 birth 确定性重建同一张盘（排盘纯计算、无随机），
        # 保证重启后仍能继续追问，不再让用户看到「命盘缓存失效」空白卡。
        session = _rebuild_session_from_profile(id, pid)
        if not session:
            return {"ok": False, "error": "命盘缓存失效，请重新排盘"}

    target_horo, target_label = None, ""
    if year and month_q:
        target_horo = horoscope_for(session["chart"], year, month_q)
        target_label = (f"推演目标：{year} 年流年（立春界）+ 覆盖公历 {year}-{month_q} 整月的"
                        "流月盘（节气界，公历月跨两个节气月时含两段）")
    elif year:
        target_horo = horoscope_for(session["chart"], year)
        target_label = f"推演目标：{year} 年流年运限（流年以立春为界，含年初尾盘、所属大限与流曜）"

    focus_terms = [t.strip() for t in (focus or "").split(",") if t.strip()]

    # 统一链路：盘面事实由 prepare_ziwei 结构化（可 JSON 落盘），画像/历史走 history 统一层
    ziwei_data = ai.prepare_ziwei(session["chart"], question, target_horo, target_label, focus_terms)

    # 落盘 payload：保存结构化 prompt 数据 + 排盘参数，追问时无需内存 chart 即可重建
    payload = {"ziwei_data": ziwei_data, "chart_id": id, "year": year, "month": month_q,
               "focus": focus_terms, "rag_query": ziwei_data.get("rag_query", ""),
               "rag_extra": ziwei_data.get("rag_extra", [])}

    # 缓存复用（v128）：同盘 + 同运限 + 同宫位 + 同问题 → 直接回放历史解读，不重复消耗模型。
    # 紫微不能套通用 dedupe_key（payload 含随机 chart_id 与每日变化的「今日运限」），
    # 改用 history.ziwei_fingerprint 只取稳定身份字段；存量老记录首次命中时自动回填指纹。
    key = history.ziwei_fingerprint(payload, question)
    if not force:
        history.ensure_ziwei_fingerprints(pid)
        entry = history.find_cached_entry(pid, "ziwei", key)
        cached_hid, cached_answer = entry if entry else (None, None)
        if cached_answer:
            async def replay():
                yield f"data: {json.dumps({'cached': True}, ensure_ascii=False)}\n\n"
                yield f"data: {json.dumps({'delta': feature_api._with_disclaimer(cached_answer)}, ensure_ascii=False)}\n\n"
                if cached_hid:
                    yield f"data: {json.dumps({'hid': cached_hid}, ensure_ascii=False)}\n\n"
                yield "data: [DONE]\n\n"
            return StreamingResponse(
                replay(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"}
            )

    up, recent = "", []
    if pid:
        ctx = history.personalization(pid, "ziwei")
        up = ctx["user_profile"]
        if ctx["birth"]:
            b = ctx["birth"]
            up = (up + "\n出生信息：" + str(b.get("year", "")) + "-" + str(b.get("month", ""))
                  + "-" + str(b.get("day", ""))).strip()
        recent = ctx["recent"]
        # 个性注入唯一来源=个人记忆（ctx["user_profile"] 已是其文本）；
        # 旧的「对话摘要 summary」属已废弃的 AI 记忆管理，不再注入。
    prompt = ai.build_ziwei_prompt(ziwei_data, question, recent, user_profile=up)

    async def gen():
        full = ""
        disc_sent = False
        try:
            async for chunk in ai.stream_answer(prompt):
                if chunk:
                    full += chunk
                    yield f"data: {json.dumps({'delta': chunk}, ensure_ascii=False)}\n\n"
            if full.strip():
                # 免责由系统统一附加（与其他四功能一致），并计入落盘文本
                tail = feature_api._with_disclaimer(full)
                if tail != full.rstrip():
                    disc = tail[len(full.rstrip()):]
                    full = tail
                    yield f"data: {json.dumps({'delta': disc}, ensure_ascii=False)}\n\n"
                disc_sent = True
            if pid and full.strip():
                # 统一落到 feature_history，回传 hid 供追问（与个人中心/其他功能同表）
                hid = history.save(pid, "ziwei", question, full.strip(), payload, key)
                yield f"data: {json.dumps({'hid': hid}, ensure_ascii=False)}\n\n"
                # 继续写 messages 以驱动用户画像/摘要压缩（紫微原有能力，保留）
                _record(session, question, full, key)
            yield "data: [DONE]\n\n"
        except asyncio.CancelledError:
            if pid and full.strip():
                if not disc_sent:
                    full = feature_api._with_disclaimer(full)
                history.save(pid, "ziwei", question, full.strip(), payload, key)
                _record(session, question, full, key)
            raise

    return StreamingResponse(
        gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"}
    )


def _record(session: dict, question: str, full: str, key: str | None = None):
    """对话入内存历史；登录用户再落盘 SQLite 并在超阈值时后台压缩。"""
    if not full.strip():
        return
    session["history"].append({"role": "user", "content": question})
    session["history"].append({"role": "assistant", "content": full})
    del session["history"][:-MAX_HISTORY]
    pid = session.get("profile_id")
    if pid:
        try:
            profile_store.save_message(pid, session.get("chart_id") or "", "user", question)
            profile_store.save_message(pid, session.get("chart_id") or "", "assistant", full,
                                       dedupe_key=key)
            asyncio.get_running_loop().create_task(maybe_compress_async(pid))
            # 自动画像已废弃：个性化记忆唯一来源改为用户手动维护的个人记忆（personal_memory）
        except Exception:
            # 历史落盘失败是真实错误：解读正文已返回，但记录没写进去，必须留痕可排查。
            log.warning("紫微推演历史落盘失败 pid=%s chart=%s", pid,
                        session.get("chart_id"), exc_info=True)


async def maybe_compress_async(pid: int):
    async def compress_fn(messages):
        digest_prompt = profile_store.build_digest_prompt(messages)
        out = ""
        async for chunk in stream_deduce(digest_prompt):
            out += chunk
        return out.strip()
    await profile_store.maybe_compress(pid, compress_fn)


app.include_router(feature_api.router)

app.mount("/", StaticFiles(directory=BASE / "web", html=True), name="web")
