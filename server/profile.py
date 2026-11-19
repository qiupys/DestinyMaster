"""用户档案：SQLite 持久化出生信息与推演对话，LLM 定期压缩历史为摘要。

设计：
- profiles: 用户名唯一，PBKDF2-SHA256(120k 轮) 密码哈希，birth 存 JSON（出生信息）
- messages: 每轮问答全量落盘（compressed=0 未压缩）
- summaries: 每用户一行累计摘要（压缩后覆盖）
- 压缩策略：未压缩消息 > COMPRESS_THRESHOLD 时，取最旧 COMPRESS_BATCH 条交给
  外部 async compress_fn（调 LLM），产出要点摘要与 summaries 合并，并推进水位。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import secrets
import sqlite3
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "ziwei.db"
COMPRESS_THRESHOLD = 20   # 未压缩消息条数阈值（user+assistant 合计）
COMPRESS_BATCH = 12       # 每次压缩的最旧条数
MAX_RECENT = 12           # 注入 LLM 的未压缩明细上限（前端展示不截断）

_conn: sqlite3.Connection | None = None


def db() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS profiles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                pass_hash TEXT NOT NULL,
                salt TEXT NOT NULL,
                token TEXT NOT NULL,
                birth TEXT NOT NULL,
                compressed_until INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                profile_id INTEGER NOT NULL,
                chart_id TEXT,
                ts TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                compressed INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_msg_profile ON messages(profile_id, compressed);
            CREATE TABLE IF NOT EXISTS summaries (
                profile_id INTEGER PRIMARY KEY,
                content TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
        _conn.commit()
        _ensure_profile_columns()
    return _conn


def _hash(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 120_000).hex()


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def register(name: str, password: str, birth: dict) -> dict:
    name = name.strip()
    if not name or not password:
        return {"ok": False, "error": "用户名与密码不能为空"}
    if not re.fullmatch(r"[A-Za-z0-9_]{2,24}", name):
        return {"ok": False, "error": "用户名仅支持 2~24 位字母、数字或下划线"}
    if len(password) < 6:
        return {"ok": False, "error": "密码至少 6 位"}
    c = db()
    if c.execute("SELECT 1 FROM profiles WHERE name=?", (name,)).fetchone():
        return {"ok": False, "error": "该用户名已存在，请直接登录"}
    if not birth:
        return {"ok": False, "error": "缺少出生信息"}
    birth = _birth_to_solar(birth)
    salt = secrets.token_hex(8)
    token = secrets.token_hex(16)
    cur = c.execute(
        "INSERT INTO profiles(name, pass_hash, salt, token, birth, created_at) VALUES(?,?,?,?,?,?)",
        (name, _hash(password, salt), salt, token, json.dumps(birth, ensure_ascii=False), _now()),
    )
    c.commit()
    return {"ok": True, "profile_id": cur.lastrowid, "token": token, "name": name}


def login(name: str, password: str) -> dict:
    c = db()
    row = c.execute("SELECT * FROM profiles WHERE name=?", (name.strip(),)).fetchone()
    if not row or _hash(password, row["salt"]) != row["pass_hash"]:
        return {"ok": False, "error": "用户名或密码不正确"}
    token = secrets.token_hex(16)
    c.execute("UPDATE profiles SET token=? WHERE id=?", (token, row["id"]))
    c.commit()
    return {"ok": True, "profile_id": row["id"], "token": token, "name": row["name"]}


def auth(profile_id: int, token: str) -> bool:
    if not profile_id or not token:
        return False
    row = db().execute("SELECT token FROM profiles WHERE id=?", (profile_id,)).fetchone()
    return bool(row and row["token"] == token)


def bind_birth(profile_id: int, birth: dict) -> None:
    """重新排盘后刷新档案出生信息（写入端统一归一为公历）。

    注意：这里必须写完整的标准字段（year/month/day/hour/minute/gender/know_time），
    只写 {date,timeIndex,gender,calendar} 会丢掉精确到分的出生时间，
    导致用户在八字里改过时间后，紫微/黄历再排盘时把档案冲回时辰粒度。
    """
    b = normalize_birth(birth)
    b = _birth_to_solar(b)
    b.setdefault("calendar", "solar")
    db().execute("UPDATE profiles SET birth=? WHERE id=?",
                 (json.dumps(b, ensure_ascii=False), profile_id))
    db().commit()


def update_profile(profile_id: int, *, name=None, birth=None,
                   new_password=None, old_password=None) -> dict:
    """修改档案：用户名（查重）/ 出生信息 / 密码（须验证当前密码）。先校验后写库，避免半提交。"""
    c = db()
    row = c.execute("SELECT * FROM profiles WHERE id=?", (profile_id,)).fetchone()
    if not row:
        return {"ok": False, "error": "档案不存在"}
    if name is not None:
        name = name.strip()
        if not re.fullmatch(r"[A-Za-z0-9_]{2,24}", name):
            return {"ok": False, "error": "用户名仅支持 2~24 位字母、数字或下划线"}
        if c.execute("SELECT 1 FROM profiles WHERE name=? AND id<>?", (name, profile_id)).fetchone():
            return {"ok": False, "error": "该用户名已被其他档案使用"}
    if new_password is not None:
        if len(new_password) < 6:
            return {"ok": False, "error": "新密码至少 6 位"}
        if not old_password or _hash(old_password, row["salt"]) != row["pass_hash"]:
            return {"ok": False, "error": "当前密码不正确"}
    # 校验全部通过，统一写库
    if name is not None:
        c.execute("UPDATE profiles SET name=? WHERE id=?", (name, profile_id))
    if birth is not None:
        c.execute("UPDATE profiles SET birth=? WHERE id=?",
                  (json.dumps(_birth_to_solar(normalize_birth(birth)), ensure_ascii=False), profile_id))
    if new_password is not None:
        salt = secrets.token_hex(8)
        c.execute("UPDATE profiles SET pass_hash=?, salt=? WHERE id=?",
                  (_hash(new_password, salt), salt, profile_id))
    c.commit()
    return {"ok": True, "name": name if name is not None else row["name"]}


def save_message(profile_id: int, chart_id: str, role: str, content: str,
                 dedupe_key: str | None = None) -> None:
    db().execute(
        "INSERT INTO messages(profile_id, chart_id, ts, role, content, dedupe_key) VALUES(?,?,?,?,?,?)",
        (profile_id, chart_id, _now(), role, content, dedupe_key),
    )
    db().commit()


def find_cached(profile_id: int, key: str) -> str | None:
    """按去重 key 查最近一次同题推演的回答，命中则复用（不重复调模型）。

    不按 chart_id 过滤：chart_id 每次排盘都会重新生成，用它过滤会导致
    缓存跨会话永不命中；key 首段已含档案标识且查询本身限定 profile_id。
    """
    row = db().execute(
        "SELECT content FROM messages WHERE profile_id=? AND dedupe_key=? "
        "AND role='assistant' ORDER BY id DESC LIMIT 1",
        (profile_id, key),
    ).fetchone()
    return row["content"] if row else None


def find_cached_full(profile_id: int, key: str) -> dict | None:
    """按去重 key 查同题推演的完整问答（回答 + 时间 + 配对的用户提问）。

    供「查看历史推演」定位跳转使用；不受压缩水位影响（messages 全量保存）。
    """
    row = db().execute(
        "SELECT id, ts, content FROM messages WHERE profile_id=? AND dedupe_key=? "
        "AND role='assistant' ORDER BY id DESC LIMIT 1",
        (profile_id, key),
    ).fetchone()
    if not row:
        return None
    qrow = db().execute(
        "SELECT content FROM messages WHERE id=? AND role='user'", (row["id"] - 1,)
    ).fetchone()
    return {"answer": row["content"], "ts": row["ts"], "key": key,
            "question": qrow["content"] if qrow else ""}


def _birth_to_solar(birth: dict) -> dict:
    """注册/修改档案时把农历输入归一为公历存储。

    所有排盘链路（原紫微 /api/chart、八字 /api/bazi/calc、黄历）都以公历为基准；
    在写入端统一转换，读取端就无需再判断历法。转换失败时保留原样，由读取端兜底。
    """
    if not isinstance(birth, dict):
        return birth
    b = dict(birth)
    if b.get("calendar") == "lunar" and all(b.get(k) is not None for k in ("year", "month", "day")):
        try:
            from lunar_python import Lunar
            h = int(b["hour"]) if b.get("hour") is not None else 12
            solar = Lunar.fromYmdHms(int(b["year"]), int(b["month"]), int(b["day"]),
                                     h, int(b.get("minute") or 0), 0).getSolar()
            b["lunar_original"] = {"year": b["year"], "month": b["month"], "day": b["day"]}
            b["year"], b["month"], b["day"] = solar.getYear(), solar.getMonth(), solar.getDay()
        except Exception:
            pass
    b["calendar"] = "solar"
    return b


def normalize_birth(birth: dict) -> dict:
    """统一出生信息结构，兼容多种历史格式。

    标准结构：{year, month, day}（公历）+ {hour, minute}（0-23 时 / 0-59 分）
    + gender + know_time（是否知道出生时间）。
    排盘体系（chart.py / 原紫微服务）期望 {date, timeIndex, gender, calendar}；
    门户早期注册写入的是 {year, month, day, hourIndex, hour, gender}。
    这里在读取时做一次规范化，既有原字段也有标准字段，gender 的 male/female 归一为 男/女。
    不改变数据库里已存的内容，仅影响对外返回值。
    """
    if not isinstance(birth, dict):
        return birth
    b = dict(birth)
    gender = b.get("gender")
    if gender in ("male", "男"):
        gender = "男"
    elif gender in ("female", "女"):
        gender = "女"
    b["gender"] = gender
    # 从 {year,month,day} 生成标准 date
    if not b.get("date") and all(b.get(k) is not None for k in ("year", "month", "day")):
        b["date"] = "%s-%s-%s" % (b["year"], b["month"], b["day"])
    # 时辰序数（0=早子…12=晚子）：优先显式字段，其次由 hour(0-23) 推导
    if b.get("timeIndex") is None:
        if b.get("hourIndex") is not None:
            b["timeIndex"] = b["hourIndex"]
        elif b.get("hour") is not None:
            h = int(b["hour"])
            b["timeIndex"] = 12 if h == 23 else (h + 1) // 2
    b.setdefault("calendar", "solar")
    b.setdefault("timeIndex", 0)
    # 反向补齐：只有 date 的（原服务注册的老结构）也给出 year/month/day/hourIndex，
    # 供门户八字表单回填与个人中心展示。
    if b.get("year") is None and isinstance(b.get("date"), str):
        parts = b["date"].replace("/", "-").split("-")
        if len(parts) == 3 and all(p.strip().isdigit() for p in parts):
            b["year"], b["month"], b["day"] = int(parts[0]), int(parts[1]), int(parts[2])
    if b.get("hourIndex") is None:
        b["hourIndex"] = b["timeIndex"]
    # hour 统一为 0-23 的出生小时：老结构只有 timeIndex 时按时辰起点近似还原
    if b.get("hour") is None:
        ti = b["timeIndex"]
        b["hour"] = 23 if ti == 12 else ti * 2
    if b.get("minute") is None:
        b["minute"] = 0
    b.setdefault("know_time", True)
    return b


def get_profile(profile_id: int) -> dict | None:
    """返回出生信息 + 累计摘要 + 全部未压缩明细（时间正序）。

    明细不截断：前端以折叠场次展示，被 MAX_RECENT 截断会导致最旧场次"消失"；
    注入 LLM 的明细由 pending_messages/压缩水位控制。
    """
    c = db()
    row = c.execute("SELECT * FROM profiles WHERE id=?", (profile_id,)).fetchone()
    if not row:
        return None
    watermark = row["compressed_until"]
    recent = c.execute(
        "SELECT id, ts, role, content, dedupe_key FROM messages WHERE profile_id=? AND id>? ORDER BY id",
        (profile_id, watermark),
    ).fetchall()
    srow = c.execute("SELECT content FROM summaries WHERE profile_id=?", (profile_id,)).fetchone()
    archived = c.execute(
        "SELECT COUNT(*) AS n FROM messages WHERE profile_id=? AND id<=?",
        (profile_id, watermark),
    ).fetchone()["n"]
    return {
        "id": row["id"],
        "name": row["name"],
        "birth": normalize_birth(json.loads(row["birth"])),
        "summary": srow["content"] if srow else "",
        "messages": [{"ts": m["ts"], "role": m["role"], "content": m["content"],
                      "key": m["dedupe_key"] or ""} for m in recent],
        "uncompressed_count": len(recent),
        "archived_count": archived,
    }


def pending_messages(profile_id: int) -> list[dict]:
    watermark = db().execute(
        "SELECT compressed_until FROM profiles WHERE id=?", (profile_id,)
    ).fetchone()["compressed_until"]
    rows = db().execute(
        "SELECT id, role, content FROM messages WHERE profile_id=? AND id>? ORDER BY id",
        (profile_id, watermark),
    ).fetchall()
    return [{"id": r["id"], "role": r["role"], "content": r["content"]} for r in rows]


def apply_summary(profile_id: int, new_digest: str, upto_id: int) -> None:
    """合并新摘要并推进压缩水位。"""
    c = db()
    srow = c.execute("SELECT content FROM summaries WHERE profile_id=?", (profile_id,)).fetchone()
    merged = (srow["content"] + "\n\n" + new_digest).strip() if srow else new_digest.strip()
    c.execute(
        "INSERT INTO summaries(profile_id, content, updated_at) VALUES(?,?,?) "
        "ON CONFLICT(profile_id) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at",
        (profile_id, merged, _now()),
    )
    c.execute("UPDATE profiles SET compressed_until=? WHERE id=?", (upto_id, profile_id))
    c.commit()


async def maybe_compress(profile_id: int, compress_fn) -> None:
    """未压缩消息超阈值时，取最旧一批交给 compress_fn(messages)->str 压缩。

    compress_fn 为 async；失败静默跳过（下次再压）。并发去重靠模块级锁集合。
    """
    if profile_id in _compressing:
        return
    _compressing.add(profile_id)
    try:
        msgs = pending_messages(profile_id)
        if len(msgs) < COMPRESS_THRESHOLD:
            return
        batch, rest = msgs[:COMPRESS_BATCH], msgs[COMPRESS_BATCH:]
        if len(rest) < 4:   # 剩余太少时多攒一轮再压，避免频繁调用
            return
        digest = await compress_fn(batch)
        if digest:
            apply_summary(profile_id, digest, batch[-1]["id"])
    except Exception:
        pass
    finally:
        _compressing.discard(profile_id)


_compressing: set[int] = set()


def build_digest_prompt(messages: list[dict]) -> str:
    convo = "\n".join(
        f"{'用户' if m['role'] == 'user' else '命理师'}: {m['content'][:600]}"
        for m in messages
    )
    return (
        "你是紫微斗数命理师的记录助理。请把下面这轮推演对话压缩为 250 字以内的要点摘要，"
        "保留：所论宫位/大限/流年、核心结论（格局判断、吉凶方向、应期）、用户的关注点。"
        "直接输出摘要正文，不要任何前言。\n\n【对话】\n" + convo
    )


# ---------------- 用户画像（从对话中持续更新用户侧写） ----------------
PROFILE_TRIGGER = 8          # 自上次画像以来新增 ≥8 条消息则更新
_profiling: set[int] = set()


def _ensure_profile_columns() -> None:
    """SQLite 轻量迁移：profiles / messages 表补新列。"""
    c = db()
    cols = {r["name"] for r in c.execute("PRAGMA table_info(profiles)").fetchall()}
    if "user_profile" not in cols:
        c.execute("ALTER TABLE profiles ADD COLUMN user_profile TEXT DEFAULT ''")
    if "profile_upto" not in cols:
        c.execute("ALTER TABLE profiles ADD COLUMN profile_upto INTEGER DEFAULT 0")
    mcols = {r["name"] for r in c.execute("PRAGMA table_info(messages)").fetchall()}
    if "dedupe_key" not in mcols:
        c.execute("ALTER TABLE messages ADD COLUMN dedupe_key TEXT")
        c.execute("CREATE INDEX IF NOT EXISTS idx_msg_dedupe ON messages(profile_id, chart_id, dedupe_key)")
    c.commit()


def get_user_profile(profile_id: int) -> str:
    row = db().execute(
        "SELECT user_profile FROM profiles WHERE id=?", (profile_id,)
    ).fetchone()
    return (row["user_profile"] or "") if row else ""


def build_user_profile_prompt(old_profile: str, summary: str, messages: list[dict]) -> str:
    convo = "\n".join(
        f"{'用户' if m['role'] == 'user' else '命理师'}: {m['content'][:500]}"
        for m in messages
    )
    old = f"【旧画像】\n{old_profile}\n\n" if old_profile else ""
    summ = f"【更早对话摘要】\n{summary}\n\n" if summary else ""
    return (
        "你是命理馆的用户档案助理。根据推演对话，维护一份用户的侧写画像，"
        "帮助命理师下次推演时更懂这位用户。只依据对话中明确流露的信息，不要臆测编造；"
        "某栏没有线索就写「未知」。控制在 200 字以内，条目式输出，包含："
        "年龄段/人生阶段；职业与工作状态；感情婚姻状况；家庭与子女；"
        "当前最关心的领域（如事业/财运/感情/健康/学业）；提问风格与偏好"
        "（喜欢直接结论还是详细推演、是否追问细节）；其他有用的背景。\n\n"
        + old + summ + "【最近对话】\n" + convo
    )


async def maybe_update_user_profile(profile_id: int, llm_fn) -> None:
    """自上次画像以来新增足够多消息时，滚动更新用户画像。

    llm_fn(prompt)->str 为 async；失败静默（下次再试）。与压缩并发去重分离。
    """
    if profile_id in _profiling:
        return
    _profiling.add(profile_id)
    try:
        _ensure_profile_columns()
        row = db().execute(
            "SELECT user_profile, profile_upto, compressed_until FROM profiles WHERE id=?",
            (profile_id,),
        ).fetchone()
        if not row:
            return
        last_id = row["profile_upto"] or 0
        fresh = db().execute(
            "SELECT id, role, content FROM messages WHERE profile_id=? AND id>? ORDER BY id",
            (profile_id, last_id),
        ).fetchall()
        if len(fresh) < PROFILE_TRIGGER:
            return
        srow = db().execute(
            "SELECT content FROM summaries WHERE profile_id=?", (profile_id,)
        ).fetchone()
        prompt = build_user_profile_prompt(
            row["user_profile"] or "",
            srow["content"] if srow else "",
            [{"role": r["role"], "content": r["content"]} for r in fresh],
        )
        out = await llm_fn(prompt)
        if out and out.strip():
            db().execute(
                "UPDATE profiles SET user_profile=?, profile_upto=? WHERE id=?",
                (out.strip()[:800], fresh[-1]["id"], profile_id),
            )
            db().commit()
    except Exception:
        pass
    finally:
        _profiling.discard(profile_id)


# ---------------- 管理员（可删用户，不可见用户资料） ----------------
def admin_list() -> dict:
    """仅返回用户名与注册时间，不含出生信息 / 对话 / 摘要。"""
    rows = db().execute("SELECT name, created_at FROM profiles ORDER BY id").fetchall()
    return {"ok": True, "users": [{"name": r["name"], "created": r["created_at"]} for r in rows]}


def admin_delete(name: str) -> dict:
    """删除指定用户及其全部对话、摘要、功能历史（不可见任何对话内容）。"""
    c = db()
    row = c.execute("SELECT id FROM profiles WHERE name=?", (name.strip(),)).fetchone()
    if not row:
        return {"ok": False, "error": "用户不存在"}
    uid = row["id"]
    c.execute("DELETE FROM messages WHERE profile_id=?", (uid,))
    c.execute("DELETE FROM summaries WHERE profile_id=?", (uid,))
    c.execute("DELETE FROM feature_history WHERE profile_id=?", (uid,))
    c.execute("DELETE FROM profiles WHERE id=?", (uid,))
    c.commit()
    return {"ok": True}


def admin_delete_all() -> int:
    """清空全部用户数据（首次上线清理用）。"""
    c = db()
    n = c.execute("SELECT COUNT(*) FROM profiles").fetchone()[0]
    c.execute("DELETE FROM messages")
    c.execute("DELETE FROM summaries")
    c.execute("DELETE FROM profiles")
    c.commit()
    return n
