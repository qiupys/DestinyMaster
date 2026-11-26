"""支撑端点：历史、知识库统计、个人记忆。

追问链路与首轮解读复用 common.answer_events，但盘面事实来自历史 payload，
不重新计算，保证「追问看到的就是首轮那张盘」。
"""
from __future__ import annotations

from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse

import ai
import history
import memory as memory_store
import rag
import rag_kb
import tarot
from features import common, context

router = APIRouter()


def _prior_rounds(item: dict, recent: list[dict]) -> list[dict]:
    """按时间正序拼出「更早历史 + 当前顶层问题 + 已积压追问」。"""
    earlier = [h for h in (recent or [])
               if not (h.get("ts") == item.get("ts") and h.get("question") == item.get("question"))]
    prior = list(reversed(earlier)) + [{
        "ts": item.get("ts", ""), "question": item.get("question", ""),
        "answer": item.get("answer", ""),
    }]
    prior += [{"ts": fu.get("ts", ""), "question": fu.get("question", ""),
               "answer": fu.get("answer", "")} for fu in item.get("followups", [])]
    return prior


def _followup_prompt(pid: int, item: dict, question: str, up: str, recent: list[dict]) -> str:
    feature = item.get("feature", "")
    payload = item.get("payload") or {}
    prior = _prior_rounds(item, recent)
    if feature == "ziwei":
        # 与首轮解读共用同一个 prompt 回调：RAG 实时检索、规则集单一来源。
        query_payload = dict(payload)
        query_payload["rag_query"] = ((payload.get("rag_query") or "") + " "
                                      + item.get("question", "")).strip()
        return ai.build_ziwei_prompt_from_payload(query_payload, question, up, prior)
    if feature == "tarot":
        excerpts = tarot.retrieve_excerpts(payload.get("cards", []), question, total_chars=5200)
    else:
        query = ((payload.get("rag_query") or "") + " " + item.get("question", "") + " " + question).strip()
        excerpts = common._retrieve(feature, query, payload.get("rag_extra"), payload)
    injected = payload.get("_injected", "")
    if injected:
        up = (up + "\n" + injected).strip()
    return ai.build_prompt(
        history.FEATURE_NAMES.get(feature, feature), payload.get("fact", ""), question,
        excerpts, user_profile=up, history=prior,
    )


@router.get("/api/history/list")
async def api_history_list(
    profile_id: int = Query(...), token: str = Query(...),
    feature: str | None = Query(None), limit: int = Query(50), offset: int = Query(0),
    date: str | None = Query(None),
):
    pid = common.auth(profile_id, token)
    if not pid:
        return {"ok": False, "error": "登录状态失效，请重新登录"}
    return {"ok": True, "items": history.list_history(pid, feature, limit, offset, date)}


@router.get("/api/history/detail")
async def api_history_detail(
    profile_id: int = Query(...), token: str = Query(...), id: int = Query(...),
):
    pid = common.auth(profile_id, token)
    if not pid:
        return {"ok": False, "error": "登录状态失效，请重新登录"}
    item = history.get_detail(pid, id)
    return {"ok": bool(item), "item": item}


@router.post("/api/history/delete")
async def api_history_delete(request: Request):
    try:
        body = await request.json()
    except Exception:
        return {"ok": False, "error": "参数错误"}
    try:
        pid = common.auth(int(body.get("profile_id") or 0), body.get("token") or "")
        hid = int(body.get("id") or 0)
    except (TypeError, ValueError):
        return {"ok": False, "error": "参数错误"}
    if not pid:
        return {"ok": False, "error": "登录状态失效，请重新登录"}
    return {"ok": history.delete_one(pid, hid)}


@router.post("/api/history/delete_batch")
async def api_history_delete_batch(request: Request):
    try:
        body = await request.json()
    except Exception:
        return {"ok": False, "error": "参数错误"}
    try:
        pid = common.auth(int(body.get("profile_id") or 0), body.get("token") or "")
    except (TypeError, ValueError):
        return {"ok": False, "error": "参数错误"}
    if not pid:
        return {"ok": False, "error": "登录状态失效，请重新登录"}
    ids = body.get("ids") or []
    if not isinstance(ids, list):
        return {"ok": False, "error": "参数错误"}
    return {"ok": True, "deleted": history.delete_many(pid, ids)}


@router.get("/api/history/stats")
async def api_history_stats(profile_id: int = Query(...), token: str = Query(...)):
    pid = common.auth(profile_id, token)
    if not pid:
        return {"ok": False, "error": "登录状态失效，请重新登录"}
    return {"ok": True, **history.stats(pid)}


@router.get("/api/history/followup")
async def api_history_followup(
    profile_id: int = Query(...), token: str = Query(...),
    id: int = Query(...), q: str = Query(...),
):
    """在历史记录上继续追问：沿用首轮盘面事实，回答挂在顶层记录下。"""
    pid = common.auth(profile_id, token)
    if not pid:
        return {"ok": False, "error": "登录状态失效，请重新登录"}
    item = history.get_detail(pid, id)
    if not item:
        return {"ok": False, "error": "未找到该记录"}
    question = (q or "").strip()
    if not question:
        return {"ok": False, "error": "问题不能为空"}

    up, recent = context.personalize(pid, item.get("feature", ""))
    prompt = _followup_prompt(pid, item, question, up, recent)
    payload = item.get("payload") or {}

    def persist(text: str) -> int:
        history.append_followup(pid, item["id"], question, text, payload)
        return item["id"]  # 追问仍指向顶层记录，便于继续追问

    return StreamingResponse(
        common.answer_events(prompt, persist),
        media_type="text/event-stream", headers={"Cache-Control": "no-cache"},
    )


@router.get("/api/kb/stats")
async def api_kb_stats():
    return {"ok": True, "corpora": rag_kb.kb_stats()}


# ============================ 个人记忆 ============================

@router.get("/api/memory/list")
async def api_memory_list(profile_id: int = Query(...), token: str = Query(...)):
    pid = common.auth(profile_id, token)
    if not pid:
        return {"ok": False, "error": "登录状态失效，请重新登录"}
    return {"ok": True, "items": memory_store.list_items(pid)}


@router.post("/api/memory/save")
async def api_memory_save(request: Request):
    """新增或编辑一条记忆：带 id = 编辑，不带 id = 新增。"""
    try:
        body = await request.json()
    except Exception:
        return {"ok": False, "error": "参数错误"}
    pid = common.auth(int(body.get("profile_id") or 0), body.get("token") or "")
    if not pid:
        return {"ok": False, "error": "登录状态失效，请重新登录"}
    content = (body.get("content") or "").strip()
    if not content:
        return {"ok": False, "error": "记忆内容不能为空"}
    mem_id = int(body.get("id") or 0)
    if mem_id:
        ok = memory_store.update(pid, mem_id, content, body.get("category") or "综合")
        return {"ok": ok, "error": None if ok else "未找到该记忆"}
    item = memory_store.add(pid, content, body.get("category") or "综合",
                            body.get("source") or "手动添加")
    return {"ok": bool(item), "item": item}


@router.post("/api/memory/delete")
async def api_memory_delete(request: Request):
    try:
        body = await request.json()
    except Exception:
        return {"ok": False, "error": "参数错误"}
    try:
        pid = common.auth(int(body.get("profile_id") or 0), body.get("token") or "")
        mid = int(body.get("id") or 0)
    except (TypeError, ValueError):
        return {"ok": False, "error": "参数错误"}
    if not pid:
        return {"ok": False, "error": "登录状态失效，请重新登录"}
    return {"ok": memory_store.delete(pid, mid)}


@router.post("/api/memory/compress")
async def api_memory_compress(request: Request):
    """从历史解读抽取稳定自我认知，AI 压缩成一条可编辑记忆（非流式）。"""
    try:
        body = await request.json()
    except Exception:
        return {"ok": False, "error": "参数错误"}
    try:
        pid = common.auth(int(body.get("profile_id") or 0), body.get("token") or "")
    except (TypeError, ValueError):
        return {"ok": False, "error": "参数错误"}
    if not pid:
        return {"ok": False, "error": "登录状态失效，请重新登录"}
    ids = body.get("ids") or []
    if not isinstance(ids, list) or not ids:
        return {"ok": False, "error": "请先选择要导入的历史对话"}
    excerpts = []
    for hid in ids[:8]:
        try:
            item = history.get_detail(pid, int(hid))
        except (TypeError, ValueError):
            continue
        if not item or not (item.get("answer") or "").strip():
            continue
        excerpts.append("【问】" + (item.get("question") or "").strip()
                        + "\n【解读节选】" + item["answer"].strip()[:900])
    if not excerpts:
        return {"ok": False, "error": "所选历史没有可用的解读内容"}
    prompt = memory_store.COMPRESS_PROMPT.format(excerpts="\n\n---\n\n".join(excerpts))
    try:
        full = ""
        async for delta in ai.stream_answer(prompt, timeout=180.0):
            full += delta
    except Exception:
        return {"ok": False, "error": "压缩生成失败，请稍后重试"}
    content = full.strip()
    if not content:
        return {"ok": False, "error": "压缩生成结果为空"}
    if len(content) > 400:
        content = content[:400].rstrip() + "…"
    return {"ok": True, "content": content, "count": len(excerpts)}
