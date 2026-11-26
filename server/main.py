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


app.include_router(feature_api.router)

app.mount("/", StaticFiles(directory=BASE / "web", html=True), name="web")
