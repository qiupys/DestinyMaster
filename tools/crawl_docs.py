#!/usr/bin/env python3
"""抓取 FateMaster 公开文献 → 结构化 Markdown，作为 RAG 知识库语料。

设计原则：
- 只抓公开 guides / 经文页面，遵守限速（礼貌爬取）；
- 正文统一从最内层 <main> 提取，剔除导航/页脚/脚本；
- 输出带 frontmatter（title/source/slug），便于 rag.py 分块检索；
- 单域可独立抓取，失败重试不中断整体。

用法：
    python tools/crawl_docs.py --all
    python tools/crawl_docs.py --domain meihua
"""
from __future__ import annotations

import argparse
import re
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen

from bs4 import BeautifulSoup

BASE = "https://www.fatemaster.ai"
ROOT = Path(__file__).resolve().parent.parent
KB = ROOT / "docs" / "kb"
UA = "Mozilla/5.0 (compatible; kb-crawler/1.0; +research)"

# 周易 64 卦序（王弼本）卦名，与 /api/hexagram-content?id=1..64 对齐
HEXAGRAMS = [
    "乾", "坤", "屯", "蒙", "需", "讼", "师", "比", "小畜", "履", "泰", "否",
    "同人", "大有", "谦", "豫", "随", "蛊", "临", "观", "噬嗑", "贲", "剥", "复",
    "无妄", "大畜", "颐", "大过", "坎", "离", "咸", "恒", "遁", "大壮", "晋", "明夷",
    "家人", "睽", "蹇", "解", "损", "益", "夬", "姤", "萃", "升", "困", "井",
    "革", "鼎", "震", "艮", "渐", "归妹", "丰", "旅", "巽", "兑", "涣", "节",
    "中孚", "小过", "既济", "未济",
]

# 八字理论 guides（sitemap-guides 中的命理基础条目）
BAZI_SLUGS = [
    "tiangan", "dizhi", "wuxing", "liushijiazi", "nayin", "shishen",
    "geju", "dayun", "qiyun-starting-time", "true-solar-time", "zi-time-theory",
    "kongwang", "shensha", "xing-chong-hui-he", "spouse-star", "fengshui",
]


def fetch(url: str, tries: int = 3, timeout: int = 30) -> str:
    """带重试的 GET，返回解码文本。"""
    last = None
    for i in range(tries):
        try:
            req = Request(url, headers={"User-Agent": UA})
            with urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8", "ignore")
        except Exception as exc:  # noqa: BLE001 - 爬虫需容忍各类网络异常
            last = exc
            time.sleep(1.2 * (i + 1))
    raise RuntimeError(f"fetch failed: {url} -> {last}")


def clean_text(html: str) -> tuple[str, str]:
    """从 HTML 提取标题与正文，剔除导航/脚本/页脚。返回 (title, text)。"""
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript", "svg", "nav", "header", "footer"]):
        tag.decompose()
    mains = soup.find_all("main")
    root = mains[-1] if mains else soup.body or soup
    h1 = root.find("h1")
    title = h1.get_text(" ", strip=True) if h1 else (soup.title.get_text(strip=True) if soup.title else "")
    # 去掉交互按钮文案噪声
    for tag in root(["button", "select", "option"]):
        tag.decompose()
    lines = [ln.strip() for ln in root.get_text("\n").split("\n") if ln.strip()]
    # 去重相邻重复行（页面里 tab/卡片常重复标题）
    dedup = [ln for i, ln in enumerate(lines) if i == 0 or ln != lines[i - 1]]
    return title, "\n".join(dedup)


def write_md(domain: str, slug: str, title: str, source: str, body: str) -> None:
    out = KB / domain
    out.mkdir(parents=True, exist_ok=True)
    fm = f"---\ntitle: {title}\nsource: {source}\nslug: {slug}\n---\n\n"
    (out / f"{slug}.md").write_text(fm + body.strip() + "\n", encoding="utf-8")


def crawl_meihua() -> None:
    """64 卦经文：接口直接返回 Markdown（卦辞/象/爻辞/释义）。"""
    n = 0
    for i, name in enumerate(HEXAGRAMS, 1):
        try:
            raw = fetch(f"{BASE}/api/hexagram-content?locale=zh&id={i}")
            import json
            content = json.loads(raw)["content"]
            write_md("meihua", f"{i:02d}", f"{name}卦", f"{BASE}/guides/64-hexagrams/{i}", content)
            n += 1
            print(f"  [meihua] {i:02d} {name} ✓", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"  [meihua] {i:02d} {name} ✗ {exc}", file=sys.stderr, flush=True)
        time.sleep(0.35)
    print(f"meihua done: {n}/{len(HEXAGRAMS)}")


def crawl_tarot() -> None:
    """塔罗 78 牌：正文内嵌在页面 <main>。slug 从 sitemap 解析。"""
    xml = fetch(f"{BASE}/sitemap-tarot.xml")
    slugs = sorted(set(re.findall(rf"{BASE}/tarot-cards/([a-z0-9-]+)<", xml)))
    n = 0
    for slug in slugs:
        try:
            title, text = clean_text(fetch(f"{BASE}/tarot-cards/{slug}"))
            if len(text) < 200:
                raise RuntimeError("text too short")
            write_md("tarot", slug, title or slug, f"{BASE}/tarot-cards/{slug}", text)
            n += 1
            print(f"  [tarot] {slug} ✓", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"  [tarot] {slug} ✗ {exc}", file=sys.stderr, flush=True)
        time.sleep(0.35)
    print(f"tarot done: {n}/{len(slugs)}")


def crawl_bazi() -> None:
    """八字理论 guides：干支/五行/十神/格局/大运等。"""
    n = 0
    for slug in BAZI_SLUGS:
        try:
            title, text = clean_text(fetch(f"{BASE}/guides/{slug}"))
            if len(text) < 200:
                raise RuntimeError("text too short")
            write_md("bazi", slug, title or slug, f"{BASE}/guides/{slug}", text)
            n += 1
            print(f"  [bazi] {slug} ✓", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"  [bazi] {slug} ✗ {exc}", file=sys.stderr, flush=True)
        time.sleep(0.4)
    print(f"bazi done: {n}/{len(BAZI_SLUGS)}")


def crawl_huangli() -> None:
    """黄历说明文档：workspace/huangli 页正文。"""
    try:
        title, text = clean_text(fetch(f"{BASE}/workspace/huangli"))
        write_md("huangli", "overview", title or "黄历", f"{BASE}/workspace/huangli", text)
        print(f"huangli done: {len(text)} chars")
    except Exception as exc:  # noqa: BLE001
        print(f"huangli ✗ {exc}", file=sys.stderr, flush=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--all", action="store_true", help="抓取全部领域")
    ap.add_argument("--domain", choices=["meihua", "tarot", "bazi", "huangli"], help="仅抓单个领域")
    args = ap.parse_args()
    tasks = {
        "meihua": crawl_meihua,
        "tarot": crawl_tarot,
        "bazi": crawl_bazi,
        "huangli": crawl_huangli,
    }
    if args.domain:
        tasks[args.domain]()
    elif args.all:
        for fn in tasks.values():
            fn()
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
