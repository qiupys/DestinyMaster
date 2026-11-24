"""多领域知识库检索（RAG）：复用 rag.py 的轻量打分思路，扩展到梅花/塔罗/八字/黄历。

语料来自 FateMaster 公开文献（tools/crawl_docs.py 抓取），按领域存于 docs/kb/<domain>/。
设计约束（延续 rag.py）：2核2G 轻量云，不引入向量库/嵌入模型；按小节切块 + 关键词命中打分。
与 rag.py 的区别：rag.py 服务紫微固定词表；本模块按领域动态选词表与语料目录。
"""
from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
KB_ROOT = BASE / "docs" / "kb"

# 各领域检索词表：命中即加权，覆盖经典概念与用户口语
DOMAIN_VOCAB: dict[str, list[str]] = {
    "meihua": [
        "乾", "坤", "震", "巽", "坎", "离", "艮", "兑",
        "元亨利贞", "潜龙勿用", "见龙在田", "飞龙在天", "亢龙有悔",
        "履霜", "直方大", "含章", "括囊", "黄裳", "龙战于野",
        "卦辞", "爻辞", "象曰", "彖曰", "动爻", "变卦", "本卦",
        "初九", "初六", "九二", "六二", "九三", "六三", "九四", "六四",
        "九五", "六五", "上九", "上六", "用九", "用六",
        "天行健", "地势坤", "自强不息", "厚德载物",
        "周易", "易传", "系辞", "梅花易数", "白话易经", "周易译注", "易经证释",
    ],
    "tarot": [
        "愚者", "魔术师", "女祭司", "皇后", "皇帝", "教皇", "恋人", "战车",
        "力量", "隐者", "命运之轮", "正义", "倒吊人", "死神", "节制", "恶魔",
        "高塔", "星星", "月亮", "太阳", "审判", "世界",
        "正位", "逆位", "大阿卡纳", "小阿卡纳", "权杖", "圣杯", "宝剑", "星币",
        "爱情", "事业", "财运", "精神", "新开始", "冒险", "选择", "转变",
    ],
    "bazi": [
        "甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸",
        "子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥",
        "金", "木", "水", "火", "土", "相生", "相克", "阴阳",
        "正官", "七杀", "正印", "偏印", "比肩", "劫财", "食神", "伤官", "正财", "偏财",
        "日主", "用神", "格局", "大运", "流年", "纳音", "空亡", "十神",
        "身强", "身弱", "从格", "正格", "财星", "官杀", "印绶", "食伤",
        "渊海子平", "三命通会", "千里命稿", "滴天髓", "子平真诠", "李虚中命书", "盲派秘典",
    ],
    "huangli": [
        "宜", "忌", "冲煞", "值神", "建星", "十二建星", "节气", "农历",
        "祭祀", "祈福", "嫁娶", "开市", "出行", "安葬", "移徙",
        "黄道", "黑道", "青龙", "白虎", "朱雀", "玄武", "勾陈", "腾蛇",
        "建", "除", "满", "平", "定", "执", "破", "危", "成", "收", "开", "闭",
    ],
    "ziwei": [
        "紫微", "天机", "太阳", "武曲", "天同", "廉贞", "天府", "太阴",
        "贪狼", "巨门", "天相", "天梁", "七杀", "破军",
        "文昌", "文曲", "左辅", "右弼", "天魁", "天钺", "禄存", "天马",
        "擎羊", "陀罗", "火星", "铃星", "地空", "地劫", "天姚", "天刑",
        "化禄", "化权", "化科", "化忌", "禄权科忌",
        "命宫", "兄弟", "夫妻", "子女", "财帛", "疾厄", "迁移", "交友",
        "官禄", "田宅", "福德", "父母", "身宫",
        "大限", "流年", "小限", "三方四正", "对宫", "空宫", "借星",
        "杀破狼", "紫府相", "巨日", "机月同梁", "火贪", "铃贪", "府相朝垣",
        "五行局", "庙", "旺", "得地", "平", "落陷", "长生", "帝旺",
    ],
    "liuyao": [
        "用神", "世爻", "应爻", "动爻", "变爻", "伏神", "飞神", "旬空",
        "月建", "日辰", "父母", "兄弟", "子孙", "妻财", "官鬼",
        "六神", "青龙", "朱雀", "勾陈", "腾蛇", "白虎", "玄武",
        "纳甲", "装卦", "反吟", "伏吟", "进神", "退神", "六冲", "六合",
        "游魂", "归魂", "本卦", "变卦", "卦身",
        "增删卜易", "黄金策", "卜筮正宗", "火珠林", "易隐", "易冒", "易林补遗", "卜筮大全",
    ],
    "qimen": [
        "三奇", "六仪", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸",
        "休门", "生门", "伤门", "杜门", "景门", "死门", "惊门", "开门", "八门",
        "天蓬", "天任", "天冲", "天辅", "天英", "天芮", "天柱", "天心", "天禽", "九星",
        "值符", "腾蛇", "太阴", "六合", "白虎", "玄武", "九地", "九天", "八神",
        "值使", "阴阳遁", "旬首", "天盘", "地盘", "人盘", "神盘", "局数",
        "奇门遁甲统宗", "奇门遁甲秘笈",
    ],
    "fengshui": [
        "罗盘", "坐向", "明堂", "气口", "玄关", "八宅", "命卦", "东四命", "西四命",
        "玄空", "飞星", "九宫", "峦头", "理气", "阳宅", "阴宅", "太岁", "五黄", "三煞",
        "麻衣相法", "入地眼", "阳宅十书", "神相全编", "地理辨正", "皇极经世",
    ],
    "astrology": [
        # 十二星座
        "白羊座", "金牛座", "双子座", "巨蟹座", "狮子座", "处女座",
        "天秤座", "天蝎座", "射手座", "摩羯座", "水瓶座", "双鱼座",
        # 行星与关键点
        "太阳", "月亮", "水星", "金星", "火星", "木星", "土星", "天王星", "海王星", "冥王星",
        "北交点", "上升", "中天", "命主星",
        # 四元素与性质
        "火象", "土象", "风象", "水象", "基本宫", "固定宫", "变动宫", "元素",
        # 宫位与相位
        "第一宫", "第七宫", "第十宫", "宫位", "合相", "对冲", "刑相", "拱相", "六合", "相位",
        "逆行", "容许度", "本命盘", "星盘", "守护星",
        # 生活领域
        "事业", "感情", "财富", "性格", "沟通", "情绪", "安全感",
    ],
}

# 生活意图 → 领域概念（用户口语映射到术语，提升召回）
INTENT_MAP: dict[str, list[tuple[tuple[str, ...], list[str]]]] = {
    "bazi": [
        (("感情", "婚姻", "对象", "脱单", "桃花"), ["财星", "官杀", "配偶"]),
        (("工作", "事业", "跳槽", "升职", "创业", "考公"), ["正官", "七杀", "格局", "大运"]),
        (("赚钱", "财运", "投资", "发财", "破财"), ["正财", "偏财", "财星"]),
        (("性格", "天赋", "适合"), ["日主", "十神", "用神"]),
        (("健康", "身体"), ["身强", "身弱", "五行"]),
    ],
    "huangli": [
        (("搬家", "入宅", "搬家具"), ["移徙", "入宅"]),
        (("结婚", "办婚礼", "领证"), ["嫁娶"]),
        (("开业", "开张", "签合同"), ["开市", "交易"]),
        (("出行", "旅游", "出差"), ["出行"]),
    ],
}


@lru_cache(maxsize=8)
def _chunks(domain: str) -> list[tuple[str, str, str]]:
    """按 ## 小节切块，返回 (文件名, 标题, 正文)。缓存避免每次 IO。"""
    out: list[tuple[str, str, str]] = []
    d = KB_ROOT / domain
    if not d.exists():
        return out
    for f in sorted(d.glob("*.md")):
        try:
            text = f.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        # 抽取 frontmatter 的 title，拼进每个小节的标题：标题在打分时权重×3，
        # 让「目标卦/牌/条目」自身文件的摘录优先于正文里偶然提到该词的其他文件。
        fm = re.match(r"^---\n(.*?)\n---\n", text, flags=re.S)
        title = ""
        if fm:
            tm = re.search(r"^title:\s*(.+)$", fm.group(1), flags=re.M)
            if tm:
                title = tm.group(1).strip()
            text = text[fm.end():]
        for part in re.split(r"\n(?=#{1,3} )", text):
            part = part.strip()
            if len(part) < 60:
                continue
            head = part.splitlines()[0].lstrip("#").strip()
            head_full = (title + " · " + head) if title else head
            out.append((f.stem, head_full, part[:1500]))
    return out


def keywords_for(domain: str, text: str, extra: list[str] | None = None) -> list[str]:
    vocab = DOMAIN_VOCAB.get(domain, [])
    found = [w for w in vocab if w and w in text]
    for triggers, concepts in INTENT_MAP.get(domain, []):
        if any(t in text for t in triggers):
            for w in concepts:
                if w not in found:
                    found.append(w)
    for w in (extra or []):
        w = w.strip()
        if w and w not in found:
            found.append(w)
    return found


def retrieve(domain: str, query: str, extra: list[str] | None = None,
             top_k: int = 5, max_chars: int = 1400,
             primary: str | int | None = None) -> list[str]:
    """领域化检索：返回 top-K 文献摘录，注入 prompt 作解读依据。
    primary: 主实体。梅花传本卦序号(int)，按文件 stem(如 04 / zhouyi-04) 精确加权，
             确保本卦语料压过上下卦；其他领域可传字符串按标题命中加权。
    """
    kws = keywords_for(domain, query, extra)
    chunks = _chunks(domain)
    if not kws or not chunks:
        return []
    scored: list[tuple[tuple[int, int], str, str, str]] = []
    for stem, head, body in chunks:
        # 标题命中远比正文堆砌可靠：某些长小节（如卦的"哲学含义"）会反复提及
        # 多个卦名，若只看正文词频会挤掉目标条目自己的核心小节。故标题命中给高权重。
        head_hits = sum(head.count(k) for k in kws)
        head_distinct = sum(1 for k in kws if k in head)
        body_hits = sum(body.count(k) for k in kws)
        body_distinct = sum(1 for k in kws if k in body)
        score = (head_distinct * 100 + body_distinct, head_hits * 50 + body_hits)
        # 主实体额外加权，确保"本卦"文件压过"上下卦"文件
        if isinstance(primary, int):
            # 梅花：本卦序号 -> 文件 stem 为 "04" 或 "zhouyi-04"
            tag = f"{primary:02d}"
            if stem == tag or stem == f"zhouyi-{tag}":
                score = (score[0] + 100000, score[1] + 50000)
        elif primary:
            if primary in head:
                score = (score[0] + 10000, score[1] + 5000)
            elif primary in body:
                score = (score[0] + 2000, score[1] + 1000)
        if score[0] > 0 or score[1] > 0:
            scored.append((score, stem, head, body))
    scored.sort(key=lambda x: (-x[0][0], -x[0][1], x[1]))
    out: list[str] = []
    used = 0
    per = max(220, max_chars // top_k)
    for _, stem, head, body in scored:
        if len(out) >= top_k or used >= max_chars:
            break
        seg = body[:per]
        out.append(f"〔{stem} · {head}〕\n{seg}")
        used += len(seg) + 10
    return out


def kb_stats() -> dict[str, int]:
    """各领域语料文件数（运维探活用）。目录动态发现，新增领域无需改代码。"""
    if not KB_ROOT.exists():
        return {}
    return {d.name: len(list(d.glob("*.md")))
            for d in sorted(KB_ROOT.iterdir()) if d.is_dir()}
