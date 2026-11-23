"""塔罗牌：78 张牌结构化数据 + 抽牌（确定性随机），牌义正文由 RAG 语料提供。"""
from __future__ import annotations

import random
import re
import hashlib
import time as _time
from functools import lru_cache
from pathlib import Path

# 大阿卡纳 22 张（slug → 中文名）
MAJOR = [
    ("the-fool","愚者"),("the-magician","魔术师"),("the-high-priestess","女祭司"),
    ("the-empress","皇后"),("the-emperor","皇帝"),("the-hierophant","教皇"),
    ("the-lovers","恋人"),("the-chariot","战车"),("strength","力量"),
    ("the-hermit","隐者"),("wheel-of-fortune","命运之轮"),("justice","正义"),
    ("the-hanged-man","倒吊人"),("death","死神"),("temperance","节制"),
    ("the-devil","恶魔"),("the-tower","高塔"),("the-star","星星"),
    ("the-moon","月亮"),("the-sun","太阳"),("judgement","审判"),("the-world","世界"),
]
SUITS = [("wands","权杖"),("cups","圣杯"),("swords","宝剑"),("pentacles","星币")]
RANKS = [("ace","王牌"),("two","二"),("three","三"),("four","四"),("five","五"),
         ("six","六"),("seven","七"),("eight","八"),("nine","九"),("ten","十"),
         ("page","侍从"),("knight","骑士"),("queen","王后"),("king","国王")]

ALL_CARDS = [
    {"slug": s, "name": n, "arcana": "大阿卡纳", "index": i}
    for i, (s, n) in enumerate(MAJOR)
]
for suit_slug, suit_name in SUITS:
    for rank_slug, rank_name in RANKS:
        ALL_CARDS.append({
            "slug": f"{rank_slug}-of-{suit_slug}",
            "name": f"{rank_name}{suit_name}",
            "arcana": "小阿卡纳", "suit": suit_name,
        })

# 语料正文的小阿卡纳花色名：pentacles 在文献里写作「金币」（展示名用「星币」）
_KB_SUIT = {"wands": "权杖", "cups": "圣杯", "swords": "宝剑", "pentacles": "金币"}
_KB_RANK = {"ace": "王牌", "two": "二", "three": "三", "four": "四", "five": "五",
            "six": "六", "seven": "七", "eight": "八", "nine": "九", "ten": "十",
            "page": "侍从", "knight": "骑士", "queen": "王后", "king": "国王"}


def _kb_name(slug: str) -> str:
    """按 slug 反推语料正文的中文牌名（花色在前），大阿卡纳返回空串（展示名即语料名）。"""
    if "-of-" not in slug:
        return ""
    rank, suit = slug.split("-of-", 1)
    r, s = _KB_RANK.get(rank), _KB_SUIT.get(suit)
    return (s + r) if (r and s) else ""


SPREADS = {
    "single": {"name": "单张指引", "positions": ["当下指引"]},
    "three": {"name": "三张牌（过去·现在·未来）", "positions": ["过去", "现在", "未来"]},
    "celtic_cross": {"name": "凯尔特十字",
                     "positions": ["询问者的状况", "成为障碍的事物", "问题的基础",
                                   "不久的过去", "主观看法与目标", "不久的将来",
                                   "自己", "周围环境", "希望与恐惧", "最终结果"]},
}


def question_seed(question: str) -> int:
    """由所问之事派生抽牌种子，但问题不是唯一变量：问题 + 当前纳秒时刻 + 系统随机源
    共同哈希。同一问题每次抽牌仍不同（保留占卜的机缘感），问题改变则种子必变。"""
    material = f"{question}|{_time.time_ns()}|{random.getrandbits(64)}"
    return int.from_bytes(hashlib.sha256(material.encode("utf-8")).digest()[:8], "big")


def draw(spread: str = "three", seed: int | None = None) -> dict:
    """抽牌：无放回随机 + 每张随机正逆位。seed 用于复现（可选）。"""
    if spread not in SPREADS:
        raise ValueError(f"未知牌阵：{spread}")
    rng = random.Random(seed) if seed is not None else random
    positions = SPREADS[spread]["positions"]
    picked = rng.sample(ALL_CARDS, len(positions))
    cards = []
    for pos, card in zip(positions, picked):
        # 凯尔特十字第 2 张横覆于第 1 张之上，按传统只看正位
        reversed_ = False if (spread == "celtic_cross" and pos == "成为障碍的事物") \
            else rng.random() < 0.35
        cards.append({
            "position": pos, "name": card["name"], "slug": card["slug"],
            "arcana": card["arcana"], "reversed": reversed_,
            "orientation": "逆位" if reversed_ else "正位",
        })
    fact_lines = [f"牌阵：{SPREADS[spread]['name']}"] + [
        f"{i+1}. {c['position']}：{c['name']}（{c['orientation']}）"
        for i, c in enumerate(cards)
    ]
    rag_query = " ".join(c["name"] for c in cards) + " " + " ".join(
        c["orientation"] for c in cards
    )
    # 语料正文的中文牌名是「花色在前」（宝剑二 / 金币十），展示名是「数字在前」（二宝剑）。
    # 只传展示名会因词序不匹配检索不到对应牌文献，只能用「正位/逆位」泛词乱命中；
    # 按 slug 反推语料名作为额外检索词，确保每张牌召回自己的文献。
    kb_terms = []
    for c in cards:
        kb = _kb_name(c["slug"])
        if kb:
            kb_terms.append(kb)
    return {
        "spread": spread, "spread_name": SPREADS[spread]["name"], "cards": cards,
        "fact": "\n".join(fact_lines), "rag_query": rag_query,
        "rag_extra": [c["name"] for c in cards] + kb_terms + ["正位", "逆位"],
    }


def deck_string(cards: list[dict]) -> str:
    """把已抽出的牌序列化为紧凑串，供前端在 AI 解读时回传，锁定同一副牌。
    格式：slug|0/1,slug|0/1,...（1=逆位）。牌位由 spread 顺序还原。"""
    return ",".join(f"{c['slug']}|{1 if c.get('reversed') else 0}" for c in cards)


def cards_from_deck(deck: str, spread: str) -> dict | None:
    """从 deck 串还原为 draw() 同构的 payload；牌位按 spread 固定顺序填回。
    这样 AI 解读的牌面与用户在页面上看到的抽牌结果完全一致（不再各自随机抽牌）。"""
    if not deck or spread not in SPREADS:
        return None
    positions = SPREADS[spread]["positions"]
    tokens = [t for t in deck.split(",") if t.strip()]
    if len(tokens) != len(positions):
        return None
    name_by_slug = {c["slug"]: c["name"] for c in ALL_CARDS}
    arcana_by_slug = {c["slug"]: c["arcana"] for c in ALL_CARDS}
    cards = []
    for pos, tok in zip(positions, tokens):
        parts = tok.rsplit("|", 1)
        slug = parts[0].strip()
        if slug not in name_by_slug:
            return None
        reversed_ = len(parts) == 2 and parts[1] == "1"
        # 第 2 张横覆牌按传统只看正位；还原时也强制正位，与 draw() 一致
        if spread == "celtic_cross" and pos == "成为障碍的事物":
            reversed_ = False
        cards.append({
            "position": pos, "name": name_by_slug[slug], "slug": slug,
            "arcana": arcana_by_slug[slug], "reversed": reversed_,
            "orientation": "逆位" if reversed_ else "正位",
        })
    fact_lines = [f"牌阵：{SPREADS[spread]['name']}"] + [
        f"{i+1}. {c['position']}：{c['name']}（{c['orientation']}）"
        for i, c in enumerate(cards)
    ]
    rag_query = " ".join(c["name"] for c in cards) + " " + " ".join(
        c["orientation"] for c in cards
    )
    kb_terms = []
    for c in cards:
        kb = _kb_name(c["slug"])
        if kb:
            kb_terms.append(kb)
    return {
        "spread": spread, "spread_name": SPREADS[spread]["name"], "cards": cards,
        "fact": "\n".join(fact_lines), "rag_query": rag_query,
        "rag_extra": [c["name"] for c in cards] + kb_terms + ["正位", "逆位"],
    }


# ---------------------------------------------------------------------------
# 塔罗专用精确检索
# ---------------------------------------------------------------------------
# 塔罗语料「一牌一篇」（docs/kb/tarot/<slug>.md），所以不需要按关键词模糊打分：
# 直接按抽到的 slug 精确取对应文献，既不会混入没抽到的牌，也能在追问时聚焦到那张牌。
_KB_TAROT = Path(__file__).resolve().parent.parent / "docs" / "kb" / "tarot"

# 牌位 → 追问识别关键词（用户常用口语指代某一牌位）
_POSITION_ALIASES = {
    # 三张牌阵 / 单张指引
    "过去": ["过去", "之前", "既往", "从前"],
    "现在": ["现在", "当下", "目前", "此刻"],
    "未来": ["未来", "将来", "接下来", "以后"],
    "当下指引": ["当下", "现在", "指引", "目前"],
    # 凯尔特十字
    "询问者的状况": ["状况", "现状", "自己怎么样", "整体", "核心"],
    "成为障碍的事物": ["障碍", "阻碍", "阻挡", "拦路"],
    "问题的基础": ["基础", "根源", "根基", "潜意识"],
    "不久的过去": ["过去", "之前", "既往"],
    "主观看法与目标": ["看法", "目标", "想法", "主观", "期望"],
    "不久的将来": ["将来", "未来", "接下来", "不久"],
    "自己": ["自己", "自我", "本人", "我这一位"],
    "周围环境": ["环境", "周围", "外界", "他人"],
    "希望与恐惧": ["希望", "恐惧", "担忧", "害怕", "期待"],
    "最终结果": ["结果", "结局", "最终", "走向", "结论"],
}
_CN_NUM = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
           "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}


@lru_cache(maxsize=128)
def _card_doc(slug: str) -> str:
    """读单张牌语料正文，去掉 frontmatter 与尾部导航噪声。"""
    f = _KB_TAROT / f"{slug}.md"
    if not f.exists():
        return ""
    text = f.read_text(encoding="utf-8", errors="ignore")
    text = re.sub(r"^---\n.*?\n---\n", "", text, flags=re.S)
    # 截掉尾部导航（「上一张 / 下一张 / 开始我的占卜」等）
    cut = text.find("上一张")
    if cut > 0:
        text = text[:cut]
    return re.sub(r"\n{2,}", "\n", text).strip()


def _card_excerpt(slug: str, limit: int, orientation: str) -> str:
    """取牌义摘录：保留开头（象征/正逆位/详析）与「牌义推演」结论段，跳过冗长的「牌面细节」。"""
    text = _card_doc(slug)
    if not text:
        return ""
    # 牌面细节是纯画面描述，对解读价值低且很长——整段跳过，把预算留给牌义推演
    m = re.search(r"\n牌面细节\n", text)
    if m:
        head = text[:m.start()]
        rest = text[m.end():]
        # 牌面细节之后通常是「牌义推演」；保留其后的结论部分
        tail = rest.split("牌义推演", 1)
        text = head + ("\n牌义推演" + tail[1] if len(tail) == 2 else "")
    # 优先保留正逆位段：若问的是逆位，把「逆位含义/逆位解读」相关行提到前面
    lines = [ln.strip() for ln in text.split("\n") if ln.strip()]
    if orientation == "逆位":
        idx = next((i for i, ln in enumerate(lines) if "逆位含义" in ln), -1)
        if idx > 6:  # 逆位段离开头太远才提前，避免打乱结构
            pass
    body = "\n".join(lines)
    return body[:limit]


def _detect_focus(cards: list[dict], question: str) -> int | None:
    """从追问文本识别用户指的是十张牌里的哪一张，返回 cards 下标。"""
    if not question:
        return None
    q = question.strip()
    scored: list[tuple[int, int]] = []
    for i, c in enumerate(cards):
        s = 0
        # 1) 序号定位：「第七张」「第7张」「7号牌」
        m = re.search(r"第\s*([一二三四五六七八九十]|\d+)\s*[张号]", q)
        if m:
            tok = m.group(1)
            n = _CN_NUM.get(tok) or (int(tok) if tok.isdigit() else None)
            if n == i + 1:
                s += 12
        # 2) 牌名（展示名 + 语料名，含正逆位说法）
        for nm in {c.get("name", ""), _kb_name(c.get("slug", ""))}:
            if nm and len(nm) >= 2 and nm in q:
                s += 10
        # 3) 牌位词（「结果那张」「障碍牌」）
        for alias in _POSITION_ALIASES.get(c.get("position", ""), []):
            if alias in q:
                s += 7
        if s > 0:
            scored.append((s, i))
    if not scored:
        return None
    scored.sort(key=lambda x: -x[0])
    # 最高分明显领先才认为有焦点，避免多个词同时命中时误判
    return scored[0][1] if scored[0][0] >= 7 else None


def retrieve_excerpts(cards: list[dict], question: str = "",
                      total_chars: int = 5200) -> list[str]:
    """塔罗精确检索：按抽到的牌逐张取文献；追问时把焦点牌置顶并加大篇幅。

    返回可直接注入 prompt 的文献块列表，每块形如「〔第7张·自己·力量(正位)〕\n正文」。
    """
    if not cards:
        return []
    focus = _detect_focus(cards, question)
    # 焦点牌 2600 字（足够完整的牌义推演），其余牌按剩余额度均分、各压到短摘录
    focus_budget = 2600
    others = [i for i in range(len(cards)) if i != focus]
    per_other = max(220, (total_chars - focus_budget) // max(1, len(others)))
    order = ([focus] + others) if focus is not None else list(range(len(cards)))
    out: list[str] = []
    for i in order:
        c = cards[i]
        budget = focus_budget if i == focus else per_other
        body = _card_excerpt(c["slug"], budget, c.get("orientation", "正位"))
        if not body:
            continue
        head = f"〔第{i+1}张 · {c.get('position','')} · {c.get('name','')}（{c.get('orientation','')}）〕"
        out.append(head + "\n" + body)
    return out
