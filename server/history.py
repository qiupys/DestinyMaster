"""全功能历史与个性化（类 serverless 能力层）：
- feature_history: 7 功能的问答历史，按 profile_id 隔离，带功能标签与结构化盘面；
- 复用 profile.db() 的连接与建表逻辑，不干扰紫微现有 messages/summaries；
- 提供个性化上下文（用户档案 + 该功能近期提问）注入 AI prompt。
"""
from __future__ import annotations

import json
from datetime import datetime

import profile as profile_store
import memory as memory_store

FEATURES = ("bazi", "ziwei", "meihua", "liuyao", "qimen", "tarot", "huangli", "astrology",
            "bazi_marriage", "ziwei_marriage", "astrology_marriage", "huangli_pair")
FEATURE_NAMES = {
    "bazi": "八字排盘", "ziwei": "紫微斗数", "meihua": "梅花易数",
    "liuyao": "六爻", "qimen": "奇门遁甲", "tarot": "塔罗牌", "huangli": "黄历",
    "astrology": "占星命盘",
    "bazi_marriage": "八字合婚", "ziwei_marriage": "紫微合婚",
    "astrology_marriage": "占星合盘",
    "huangli_pair": "双人择日",
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
            dedupe_key TEXT,
            parent_id INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_fh_profile_feature ON feature_history(profile_id, feature, id DESC);
        """
    )
    # 兼容旧库：早期表无 parent_id 列，追问被另存成独立记录；补列后旧记录 parent_id 为 NULL，
    # 自然作为顶层问题保留，不影响既有数据。parent_id 索引必须在补列之后建，否则旧库会因列不存在报错。
    cols = [r["name"] for r in c.execute("PRAGMA table_info(feature_history)").fetchall()]
    if "parent_id" not in cols:
        c.execute("ALTER TABLE feature_history ADD COLUMN parent_id INTEGER")
    c.execute("CREATE INDEX IF NOT EXISTS idx_fh_parent ON feature_history(parent_id)")
    c.commit()


def save(profile_id: int, feature: str, question: str, answer: str,
         payload: dict | None = None, dedupe_key: str | None = None,
         parent_id: int | None = None) -> int:
    """落一条功能问答历史。payload 存确定性盘面（卦象/八字/牌阵等）JSON。

    parent_id 为空 = 顶层问题；非空 = 某条顶层问题下的追问，不单列在历史列表。
    """
    _ensure_table()
    c = profile_store.db()
    cur = c.execute(
        "INSERT INTO feature_history(profile_id, feature, ts, question, answer, payload, dedupe_key, parent_id) "
        "VALUES(?,?,?,?,?,?,?,?)",
        (profile_id, feature, _now(), question, answer,
         json.dumps(payload or {}, ensure_ascii=False), dedupe_key, parent_id),
    )
    c.commit()
    return cur.lastrowid


def append_followup(profile_id: int, root_id: int, question: str, answer: str,
                    payload: dict | None = None) -> bool:
    """把一次追问作为子记录挂到 root_id 这条顶层问题下（不单列）。继承顶层的功能与档案。"""
    _ensure_table()
    c = profile_store.db()
    cur = c.execute(
        "INSERT INTO feature_history(profile_id, feature, ts, question, answer, payload, dedupe_key, parent_id) "
        "SELECT profile_id, feature, ?, ?, ?, ?, NULL, ? "
        "FROM feature_history WHERE id=? AND profile_id=? AND parent_id IS NULL",
        (_now(), question, answer, json.dumps(payload or {}, ensure_ascii=False), root_id,
         root_id, profile_id),
    )
    c.commit()
    return cur.rowcount > 0


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
                 limit: int = 50, offset: int = 0,
                 date: str | None = None) -> list[dict]:
    """按功能 / 日期列出历史。date 为 YYYY-MM-DD，按 ts 前缀精确匹配某一天。
    feature 支持逗号分隔的多个功能（老黄历的个人运势与双人择日在界面上合并展示）。"""
    _ensure_table()
    c = profile_store.db()
    where = "profile_id=? AND parent_id IS NULL"
    args: list = [profile_id]
    if feature:
        names = [x.strip() for x in str(feature).split(",") if x.strip()]
        if names:
            where += " AND feature IN (" + ",".join("?" for _ in names) + ")"
            args.extend(names)
    if date:
        where += " AND ts LIKE ?"
        args.append(str(date).strip()[:10] + "%")
    args += [limit, offset]
    rows = c.execute(
        "SELECT id, feature, ts, question, answer, payload FROM feature_history "
        "WHERE " + where + " ORDER BY id DESC LIMIT ? OFFSET ?",
        args,
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
    c = profile_store.db()
    row = c.execute(
        "SELECT * FROM feature_history WHERE id=? AND profile_id=?",
        (history_id, profile_id),
    ).fetchone()
    if not row:
        return None
    # 若拿到的是追问子记录，归一到它的顶层问题（追问链只有顶层才有完整盘面 payload）。
    root_id = row["parent_id"] or row["id"]
    if root_id != row["id"]:
        row = c.execute(
            "SELECT * FROM feature_history WHERE id=? AND profile_id=?",
            (root_id, profile_id),
        ).fetchone()
        if not row:
            return None
    try:
        payload = json.loads(row["payload"])
    except (ValueError, TypeError):
        payload = {}
    # 追问链：同一顶层问题下的所有追问，按时间正序返回，供详情/追问上下文组装。
    followups = [
        {"id": r["id"], "ts": r["ts"], "question": r["question"], "answer": r["answer"]}
        for r in c.execute(
            "SELECT id, ts, question, answer FROM feature_history "
            "WHERE parent_id=? AND profile_id=? ORDER BY id ASC",
            (root_id, profile_id),
        ).fetchall()
    ]
    return {
        "id": row["id"], "feature": row["feature"], "ts": row["ts"],
        "question": row["question"], "answer": row["answer"], "payload": payload,
        "followups": followups,
    }


def delete_one(profile_id: int, history_id: int) -> bool:
    _ensure_table()
    c = profile_store.db()
    cur = c.execute("DELETE FROM feature_history WHERE id=? AND profile_id=?",
                    (history_id, profile_id))
    # 连坐：顶层问题被删时，其追问子记录一并删除。
    c.execute("DELETE FROM feature_history WHERE parent_id=? AND profile_id=?",
              (history_id, profile_id))
    c.commit()
    return cur.rowcount > 0


def delete_many(profile_id: int, history_ids: list[int]) -> int:
    """批量删除顶层问题及其追问子记录；返回实际删除的顶层条数。"""
    # 逐项安全转换：ids 来自前端 JSON，可能混入 'abc'、超大整数等，int() 会抛 ValueError/OverflowError
    safe: list[int] = []
    for i in history_ids[:500]:
        if isinstance(i, bool) or not isinstance(i, (int, float, str)):
            continue
        try:
            n = int(i)
        except (ValueError, TypeError, OverflowError):
            continue
        if 0 < n < 2**63:  # SQLite INTEGER 上界，超大整数会抛 OverflowError
            safe.append(n)
    ids = list(dict.fromkeys(safe))
    if not ids:
        return 0
    _ensure_table()
    c = profile_store.db()
    marks = ",".join("?" for _ in ids)
    cur = c.execute(
        f"DELETE FROM feature_history WHERE profile_id=? AND id IN ({marks}) AND parent_id IS NULL",
        [profile_id, *ids],
    )
    n = cur.rowcount
    c.execute(
        f"DELETE FROM feature_history WHERE profile_id=? AND parent_id IN ({marks})",
        [profile_id, *ids],
    )
    c.commit()
    return n


def personalization(profile_id: int, feature: str) -> dict:
    """返回个性化上下文：个人记忆 + 档案出生信息 + 本功能近期提问。

    「个性化记忆」唯一来源 = 用户手动维护的个人记忆卡（personal_memory）；
    用户可随时编辑/删除，删除后即时不再注入。早期自动提炼的用户画像（user_profile）
    已废弃不再读取，避免出现「删除历史后 AI 仍凭画像记得旧信息」。
    无数据时返回空结构，调用方安全降级。
    """
    ctx: dict = {"user_profile": "", "birth": {}, "recent": []}
    if not profile_id:
        return ctx
    try:
        p = profile_store.get_profile(profile_id)
        if p:
            ctx["birth"] = p.get("birth") or {}
    except Exception:
        pass
    # 唯一个性化记忆源：个人记忆卡
    try:
        ctx["user_profile"] = memory_store.personalization_text(profile_id)
    except Exception:
        ctx["user_profile"] = ""
    ctx["recent"] = [
        {"ts": h["ts"], "question": h["question"], "answer": h.get("answer", "")}
        for h in list_history(profile_id, feature, limit=6)
    ]
    return ctx


def stats(profile_id: int) -> dict:
    """个人中心：各功能历史条数 + 总数 + 有记录的日期列表（供日期查找）。"""
    _ensure_table()
    c = profile_store.db()
    rows = c.execute(
        "SELECT feature, COUNT(*) AS n FROM feature_history WHERE profile_id=? AND parent_id IS NULL "
        "GROUP BY feature",
        (profile_id,),
    ).fetchall()
    by_feature = {r["feature"]: r["n"] for r in rows}
    drows = c.execute(
        "SELECT DISTINCT substr(ts,1,10) AS d FROM feature_history WHERE profile_id=? AND parent_id IS NULL "
        "ORDER BY d DESC",
        (profile_id,),
    ).fetchall()
    dates = [r["d"] for r in drows if r["d"]]
    return {"total": sum(by_feature.values()), "by_feature": by_feature, "dates": dates}
