"""个人记忆（Personal Memory）：把历史解读中稳定、可复用的自我认知沉淀成卡片。

- personal_memory: 按 profile_id 隔离，一条记忆 = 一段用户可编辑的结论文本 + 来源 + 分类；
- 复用 profile.db() 的连接与建表逻辑，不引入新数据库；
- import_compress 从历史问答抽取若干条，交给 AI 压缩成一条精炼记忆（复用 ai 链路）。
"""
from __future__ import annotations

import json
from datetime import datetime

import profile as profile_store

CATEGORIES = ("性格特质", "事业方向", "感情关系", "健康作息", "综合")


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _ensure_table() -> None:
    c = profile_store.db()
    c.executescript(
        """
        CREATE TABLE IF NOT EXISTS personal_memory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            profile_id INTEGER NOT NULL,
            content TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT '综合',
            source TEXT NOT NULL DEFAULT '手动添加',
            ts TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pm_profile ON personal_memory(profile_id, id DESC);
        """
    )
    c.commit()


def list_items(profile_id: int) -> list[dict]:
    _ensure_table()
    rows = profile_store.db().execute(
        "SELECT id, content, category, source, ts, updated_at FROM personal_memory "
        "WHERE profile_id=? ORDER BY id DESC", (profile_id,)
    ).fetchall()
    return [
        {"id": r["id"], "content": r["content"], "category": r["category"],
         "source": r["source"], "ts": r["ts"], "updated_at": r["updated_at"]}
        for r in rows
    ]


def add(profile_id: int, content: str, category: str = "综合", source: str = "手动添加") -> dict | None:
    content = (content or "").strip()
    if not content:
        return None
    if category not in CATEGORIES:
        category = "综合"
    now = _now()
    c = profile_store.db()
    cur = c.execute(
        "INSERT INTO personal_memory(profile_id, content, category, source, ts, updated_at) "
        "VALUES(?,?,?,?,?,?)", (profile_id, content, category, (source or "手动添加")[:120], now, now)
    )
    c.commit()
    return {"id": cur.lastrowid, "content": content, "category": category,
            "source": source, "ts": now, "updated_at": now}


def update(profile_id: int, mem_id: int, content: str, category: str | None = None) -> bool:
    content = (content or "").strip()
    if not content:
        return False
    c = profile_store.db()
    if category in CATEGORIES:
        cur = c.execute(
            "UPDATE personal_memory SET content=?, category=?, updated_at=? WHERE id=? AND profile_id=?",
            (content, category, _now(), mem_id, profile_id)
        )
    else:
        cur = c.execute(
            "UPDATE personal_memory SET content=?, updated_at=? WHERE id=? AND profile_id=?",
            (content, _now(), mem_id, profile_id)
        )
    c.commit()
    return cur.rowcount > 0


def delete(profile_id: int, mem_id: int) -> bool:
    c = profile_store.db()
    cur = c.execute("DELETE FROM personal_memory WHERE id=? AND profile_id=?", (mem_id, profile_id))
    c.commit()
    return cur.rowcount > 0


COMPRESS_PROMPT = """你是一位精炼个人档案的助手。下面是从用户历史命理解读中摘录的若干条内容。
请把其中【稳定、可复用、与本人特质相关的结论】压缩成一条简明记忆卡片，供日后快速了解此人。

要求：
1. 只输出压缩后的记忆正文，不写标题、不写解释、不加免责声明。
2. 用第二人称「你」陈述，60~140 字之间，语言克制、具体，避免空泛鸡汤。
3. 保留关键事实（如倾向、优势、需要留意的课题），舍弃具体日期与一次性事件。
4. 若条目主题分散，用「；」并列不同面向，不要强行归结为单一结论。

历史解读摘录：
{excerpts}
"""
