"""全功能历史与个性化（类 serverless 能力层）：
- feature_history: 7 功能的问答历史，按 profile_id 隔离，带功能标签与结构化盘面；
- 复用 profile.db() 的连接与建表逻辑，不干扰紫微现有 messages/summaries；
- 提供个性化上下文（用户档案 + 该功能近期提问）注入 AI prompt。
"""
from __future__ import annotations

import json
from datetime import datetime

import profile as profile_store

FEATURES = ("bazi", "ziwei", "meihua", "liuyao", "qimen", "tarot", "huangli")
FEATURE_NAMES = {
    "bazi": "八字排盘", "ziwei": "紫微斗数", "meihua": "梅花易数",
    "liuyao": "六爻", "qimen": "奇门遁甲", "tarot": "塔罗牌", "huangli": "黄历",
}


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _ensure_table() -> None:
    c = profile_store.db()
    c.executescript(
        """
        CREATE TABLE IF NOT EXISTS feature_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            profile_id INTEGER NOT NULL,
            feature TEXT NOT NULL,
            ts TEXT NOT NULL,
            question TEXT NOT NULL,
            answer TEXT NOT NULL,
            payload TEXT NOT NULL DEFAULT '{}',
            dedupe_key TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_fh_profile_feature ON feature_history(profile_id, feature, id DESC);
        """
    )
    c.commit()


def save(profile_id: int, feature: str, question: str, answer: str,
         payload: dict | None = None, dedupe_key: str | None = None) -> int:
    """落一条功能问答历史。payload 存确定性盘面（卦象/八字/牌阵等）JSON。"""
    _ensure_table()
    c = profile_store.db()
    cur = c.execute(
        "INSERT INTO feature_history(profile_id, feature, ts, question, answer, payload, dedupe_key) "
        "VALUES(?,?,?,?,?,?,?)",
        (profile_id, feature, _now(), question, answer,
         json.dumps(payload or {}, ensure_ascii=False), dedupe_key),
    )
    c.commit()
    return cur.lastrowid


def find_cached(profile_id: int, feature: str, dedupe_key: str) -> str | None:
    entry = find_cached_entry(profile_id, feature, dedupe_key)
    return entry[1] if entry else None


def find_cached_entry(profile_id: int, feature: str, dedupe_key: str) -> tuple[int, str] | None:
    """同 find_cached，但连带返回历史 id，供前端命中缓存时也能继续追问。"""
    _ensure_table()
    row = profile_store.db().execute(
        "SELECT id, answer FROM feature_history WHERE profile_id=? AND feature=? AND dedupe_key=? "
        "AND answer<>'' ORDER BY id DESC LIMIT 1",
        (profile_id, feature, dedupe_key),
    ).fetchone()
    return (row["id"], row["answer"]) if row else None


def list_history(profile_id: int, feature: str | None = None,
                 limit: int = 50, offset: int = 0) -> list[dict]:
    _ensure_table()
    c = profile_store.db()
    if feature:
        rows = c.execute(
            "SELECT id, feature, ts, question, answer, payload FROM feature_history "
            "WHERE profile_id=? AND feature=? ORDER BY id DESC LIMIT ? OFFSET ?",
            (profile_id, feature, limit, offset),
        ).fetchall()
    else:
        rows = c.execute(
            "SELECT id, feature, ts, question, answer, payload FROM feature_history "
            "WHERE profile_id=? ORDER BY id DESC LIMIT ? OFFSET ?",
            (profile_id, limit, offset),
        ).fetchall()
    out = []
    for r in rows:
        try:
            payload = json.loads(r["payload"])
        except (ValueError, TypeError):
            payload = {}
        out.append({
            "id": r["id"], "feature": r["feature"],
            "feature_name": FEATURE_NAMES.get(r["feature"], r["feature"]),
            "ts": r["ts"], "question": r["question"],
            "answer": r["answer"], "payload": payload,
        })
    return out


def get_detail(profile_id: int, history_id: int) -> dict | None:
    _ensure_table()
    row = profile_store.db().execute(
        "SELECT * FROM feature_history WHERE id=? AND profile_id=?",
        (history_id, profile_id),
    ).fetchone()
    if not row:
        return None
    try:
        payload = json.loads(row["payload"])
    except (ValueError, TypeError):
        payload = {}
    return {
        "id": row["id"], "feature": row["feature"], "ts": row["ts"],
        "question": row["question"], "answer": row["answer"], "payload": payload,
    }


def delete_one(profile_id: int, history_id: int) -> bool:
    _ensure_table()
    c = profile_store.db()
    cur = c.execute("DELETE FROM feature_history WHERE id=? AND profile_id=?",
                    (history_id, profile_id))
    c.commit()
    return cur.rowcount > 0


def personalization(profile_id: int, feature: str) -> dict:
    """返回个性化上下文：用户画像 + 档案出生信息 + 本功能近期提问。

    注入 AI prompt 实现千人千面；无数据时返回空结构，调用方安全降级。
    """
    ctx: dict = {"user_profile": "", "birth": {}, "recent": []}
    if not profile_id:
        return ctx
    try:
        p = profile_store.get_profile(profile_id)
        if p:
            ctx["user_profile"] = profile_store.get_user_profile(profile_id) or ""
            ctx["birth"] = p.get("birth") or {}
    except Exception:
        pass
    ctx["recent"] = [
        {"ts": h["ts"], "question": h["question"], "answer": h.get("answer", "")}
        for h in list_history(profile_id, feature, limit=6)
    ]
    return ctx


def stats(profile_id: int) -> dict:
    """个人中心：各功能历史条数 + 总数。"""
    _ensure_table()
    rows = profile_store.db().execute(
        "SELECT feature, COUNT(*) AS n FROM feature_history WHERE profile_id=? GROUP BY feature",
        (profile_id,),
    ).fetchall()
    by_feature = {r["feature"]: r["n"] for r in rows}
    return {"total": sum(by_feature.values()), "by_feature": by_feature}
