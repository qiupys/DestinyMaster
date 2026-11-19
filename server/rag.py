"""轻量知识库检索（RAG）：docs/iztro-learn markdown 分段 + 关键词打分。

设计约束：资料库规模有限（约 540KB），不需要向量库/嵌入模型等重框架；
直接把文档按小节切块，用星曜/宫位/概念词表做精确命中打分，
取 top-K 摘录注入推演 prompt，增强解读的文献依据。
"""
from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

KB_DIR = Path(__file__).resolve().parent.parent / "docs" / "iztro-learn"

# 检索词表：十四主星 + 常见辅煞曜 + 宫位 + 论命概念
VOCAB = [
    # 十四主星
    "紫微", "天机", "太阳", "武曲", "天同", "廉贞",
    "天府", "太阴", "贪狼", "巨门", "天相", "天梁", "七杀", "破军",
    # 六吉六煞与常引用杂曜
    "左辅", "右弼", "文昌", "文曲", "天魁", "天钺",
    "禄存", "天马", "擎羊", "陀罗", "火星", "铃星", "地空", "地劫",
    "化禄", "化权", "化科", "化忌", "红鸾", "天喜", "天姚", "孤辰", "寡宿",
    # 宫位（含别称）
    "命宫", "兄弟", "夫妻", "子女", "财帛", "疾厄", "迁移",
    "仆役", "交友", "官禄", "事业", "田宅", "福德", "父母", "身宫",
    # 论命概念
    "三方四正", "四化", "大限", "流年", "流月", "流日",
    "庙旺", "落陷", "亮度", "格局", "对宫", "夹宫", "借星", "安星",
    "五行局", "命主", "身主", "来因宫", "桃花", "孤克",
    # 飞星派概念
    "飞星", "飞化", "自化", "忌入", "忌冲", "冲宫", "禄随忌走", "归宫", "体用",
    # 中州派 / 钦天门概念
    "中州派", "星系", "借星安宫", "叠法", "定象", "引动", "应期",
    "钦天门", "化象", "串联", "河图", "六内", "六外", "数理",
]


@lru_cache(maxsize=1)
def _chunks() -> list[tuple[str, str, str]]:
    """把知识库 markdown 按 ## 小节切块，返回 (文件名, 小节标题, 正文)。"""
    out: list[tuple[str, str, str]] = []
    if not KB_DIR.exists():
        return out
    for f in sorted(KB_DIR.glob("*.md")):
        try:
            text = f.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for part in re.split(r"\n(?=#{1,3} )", text):
            part = part.strip()
            if len(part) < 80:  # 过短小节无信息量
                continue
            head = part.splitlines()[0].lstrip("#").strip()
            out.append((f.stem, head, part[:1400]))
    return out


# 问法同义扩展：用户口语 → 词表标准词（命中飞星派体系文档的关键）
SYNONYMS = {
    "飞入": ["飞化", "忌入"],     # "化忌飞入X宫" → 飞化 + 忌入
    "飞出": ["飞化"],
    "飞到": ["飞化"],
    "化入": ["忌入", "飞化"],
    "忌冲": ["冲宫"],
    "坐命": ["命宫"],
}

# 生活意图 → 命理概念：真实用户问的是"感情/结婚/换工作"这类生活语言，
# 词表里只有"夫妻/官禄"这类术语，不映射则高频问题检索全空
INTENT_MAP = [
    (("感情", "恋爱", "结婚", "婚姻", "对象", "另一半", "脱单", "相亲", "桃花", "异性"),
     ["夫妻", "桃花", "红鸾", "天喜"]),
    (("赚钱", "财运", "收入", "发财", "存款", "投资", "破财", "财运", "理财"),
     ["财帛", "禄存", "化禄"]),
    (("工作", "事业", "跳槽", "升职", "职场", "创业", "换工作", "失业", "考公"),
     ["官禄", "事业", "化权"]),
    (("健康", "身体", "生病", "手术", "住院", "亚健康"),
     ["疾厄"]),
    (("买房", "房产", "买房子", "搬家", "家宅", "置业"),
     ["田宅"]),
    (("朋友", "人脉", "人际", "社交", "合伙人"),
     ["交友", "兄弟"]),
    (("学习", "考试", "学业", "考学", "考研", "考证", "文书"),
     ["父母", "化科", "文昌"]),
    (("生孩子", "备孕", "怀孕", "生育", "子女", "小孩", "孩子"),
     ["子女"]),
    (("出国", "远行", "旅行", "移民", "外地", "异地"),
     ["迁移"]),
    (("心情", "快乐", "福报", "精神", "内耗", "焦虑"),
     ["福德"]),
    (("父母", "长辈", "爸爸", "妈妈"),
     ["父母"]),
    (("兄弟姐妹", "兄弟", "姐妹", "手足"),
     ["兄弟"]),
    (("运势", "运程", "运气", "今年", "明年", "未来", "今年运势"),
     ["大限", "流年"]),
]


def keywords_from(text: str, extra: list[str] | None = None) -> list[str]:
    """从问题文本提取命理词表命中词 + 生活意图映射 + 问法同义扩展 + 调用方聚焦词。"""
    found = [w for w in VOCAB if w and w in text]
    for triggers, concepts in INTENT_MAP:
        if any(t in text for t in triggers):
            for w in concepts:
                if w not in found:
                    found.append(w)
    for trigger, expand in SYNONYMS.items():
        if trigger in text:
            for w in expand:
                if w in VOCAB and w not in found:
                    found.append(w)
    if extra:
        for w in extra:
            w = w.strip()
            if w and w not in found:
                found.append(w)
    return found


def retrieve(keywords: list[str], top_k: int = 6, max_chars: int = 1800) -> list[str]:
    """按关键词命中次数打分（标题加权），返回 top-K 知识库摘录。"""
    kws = [k for k in dict.fromkeys(keywords) if k]
    if not kws or not _chunks():
        return []
    scored: list[tuple[tuple[int, int], str, str, str]] = []
    for stem, head, body in _chunks():
        hay = head * 3 + body  # 标题命中权重 ×3
        counts = [hay.count(k) for k in kws]
        distinct = sum(1 for c in counts if c > 0)
        total = sum(counts)
        if distinct:
            # 先比命中的不同关键词数（覆盖广者优先），再比总词频
            scored.append(((distinct, total), stem, head, body))
    scored.sort(key=lambda x: (-x[0][0], -x[0][1], x[1]))
    out: list[str] = []
    used = 0
    per = max(240, max_chars // top_k)   # 均匀配额：避免单条长文挤掉后续多样摘录
    for _, stem, head, body in scored:
        if len(out) >= top_k or used >= max_chars:
            break
        seg = body[:per]
        out.append(f"〔{stem} · {head}〕\n{seg}")
        used += len(seg) + 10
    return out
