#!/usr/bin/env python3
"""抓取 FateMaster /guides 全站知识 → 按领域写入 docs/kb/<domain>/。

覆盖子 sitemap：guides（含 28宿/64卦/六爻/奇门/紫微子页）、shensha、geju、ziwei、qimen。
正文按标题层级保留为 Markdown（## / ###），以便 rag_kb 按小节切块检索。

用法：
    python tools/crawl_guides.py              # 全量抓取（已存在文件跳过，--force 覆盖）
    python tools/crawl_guides.py --only ziwei # 只抓某领域
    python tools/crawl_guides.py --dry-run    # 只列出待抓 URL 与归类
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import re
import subprocess
import sys
import time
from pathlib import Path

from bs4 import BeautifulSoup

BASE = "https://www.fatemaster.ai"
ROOT = Path(__file__).resolve().parent.parent
KB = ROOT / "docs" / "kb"
UA = "Mozilla/5.0 (compatible; kb-crawler/2.0; +research)"

# 子 sitemap：guides 系列全部知识页
SITEMAPS = [
    "sitemap-guides.xml",
    "sitemap-shensha.xml",
    "sitemap-geju.xml",
    "sitemap-ziwei.xml",
    "sitemap-qimen.xml",
]

# slug 前缀 → 领域（顺序敏感，先匹配到的生效）
DOMAIN_RULES: list[tuple[str, str]] = [
    ("ziwei-", "ziwei"),
    ("purple-star-astrology", "ziwei"),
    ("qimen-", "qimen"),
    ("liuyao-", "liuyao"),
    ("28-mansions", "huangli"),
    ("64-hexagrams", "meihua"),
    ("fengshui", "fengshui"),
    ("geju", "bazi"),
    ("shensha", "bazi"),
    ("four-pillars-of-destiny", "bazi"),
    ("tiangan", "bazi"),
    ("dizhi", "bazi"),
    ("liushijiazi", "bazi"),
    ("nayin", "bazi"),
    ("shishen", "bazi"),
    ("dayun", "bazi"),
    ("qiyun-starting-time", "bazi"),
    ("true-solar-time", "bazi"),
    ("zi-time-theory", "bazi"),
    ("kongwang", "bazi"),
    ("xing-chong-hui-he", "bazi"),
    ("spouse-star", "bazi"),
    ("wuxing", "bazi"),
]


def classify(slug: str) -> str:
    for prefix, domain in DOMAIN_RULES:
        if slug == prefix or slug.startswith(prefix):
            return domain
    return "bazi"


def fetch(url: str, tries: int = 2, timeout: int = 90) -> str:
    """用 curl 抓取（站点单页响应常超过 20s，python urlopen 易读超时；curl 更稳更快）。"""
    last = ""
    for _ in range(tries):
        try:
            r = subprocess.run(
                ["curl", "-sS", "--compressed", "-m", str(timeout), "-A", UA,
                 "-H", "Accept-Language: zh-CN,zh;q=0.9", url],
                capture_output=True, timeout=timeout + 15)
            if r.returncode == 0 and len(r.stdout) > 2000:
                return r.stdout.decode("utf-8", "ignore")
            last = f"rc={r.returncode} size={len(r.stdout)} {r.stderr[:80]!r}"
        except Exception as exc:  # noqa: BLE001
            last = str(exc)
        time.sleep(1.0)
    raise RuntimeError(f"fetch failed: {url} -> {last}")


def guide_urls() -> list[str]:
    """从子 sitemap 汇总中文 guides URL（去重、保序）。"""
    urls: list[str] = []
    seen: set[str] = set()
    for sm in SITEMAPS:
        try:
            xml = fetch(f"{BASE}/{sm}", tries=3, timeout=300)   # sitemap 体积大、源站慢，单独放宽
        except Exception as exc:  # noqa: BLE001
            print(f"  ! {sm} 拉取失败：{exc}", file=sys.stderr)
            continue
        for loc in re.findall(r"<loc>([^<]+)</loc>", xml):
            if "/guides/" not in loc:
                continue
            if re.search(r"/(en|zh-Hant|ja|ko)/", loc):
                continue
            if loc in seen:
                continue
            seen.add(loc)
            urls.append(loc)
        time.sleep(0.3)
    return urls


def extract(html: str) -> tuple[str, str]:
    """提取标题与结构化正文：h2/h3 保留为 Markdown 标题，li 保留为列表。"""
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript", "svg", "nav", "header", "footer",
                     "button", "select", "option", "form"]):
        tag.decompose()
    mains = soup.find_all("main")
    root = mains[-1] if mains else (soup.body or soup)
    h1 = root.find("h1")
    title = h1.get_text(" ", strip=True) if h1 else (soup.title.get_text(strip=True) if soup.title else "")
    if h1:
        h1.decompose()

    lines: list[str] = []
    for node in root.find_all(["h2", "h3", "h4", "p", "li", "table"]):
        if node.find_parent(["li", "table"]):
            continue
        name = node.name
        text = " ".join(node.get_text(" ", strip=True).split())
        if not text:
            continue
        if name == "h2":
            lines.append(f"\n## {text}")
        elif name in ("h3", "h4"):
            lines.append(f"\n### {text}")
        elif name == "li":
            lines.append(f"- {text}")
        elif name == "table":
            rows = []
            for tr in node.find_all("tr"):
                cells = [" ".join(td.get_text(" ", strip=True).split()) for td in tr.find_all(["th", "td"])]
                if any(cells):
                    rows.append(" | ".join(cells))
            if rows:
                lines.append("\n".join(rows))
        else:
            lines.append(text)

    # 去相邻重复行（卡片/摘要常重复标题）
    dedup: list[str] = []
    for ln in lines:
        if dedup and ln == dedup[-1]:
            continue
        dedup.append(ln)
    return title, "\n\n".join(x.strip("\n") for x in dedup if x.strip())


def write_md(domain: str, slug: str, title: str, source: str, body: str) -> int:
    out = KB / domain
    out.mkdir(parents=True, exist_ok=True)
    fm = (f"---\ntitle: {title}\nsource: {source}\nslug: {slug}\ndomain: {domain}\n---\n\n")
    path = out / f"{slug}.md"
    path.write_text(fm + body.strip() + "\n", encoding="utf-8")
    return len(body)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--only", help="仅抓某领域：bazi/ziwei/meihua/tarot/huangli/liuyao/qimen/fengshui")
    ap.add_argument("--force", action="store_true", help="覆盖已存在文件")
    ap.add_argument("--dry-run", action="store_true", help="只打印清单")
    ap.add_argument("--workers", type=int, default=6, help="并发数（站点响应慢，默认 6）")
    args = ap.parse_args()

    urls = guide_urls()
    plan: list[tuple[str, str, str]] = []
    for u in urls:
        rel = u.split("/guides/", 1)[1].strip("/")
        slug = rel.replace("/", "-")
        domain = classify(rel)
        if args.only and domain != args.only:
            continue
        plan.append((domain, slug, u))

    print(f"待抓取 {len(plan)} 篇，分布：")
    dist: dict[str, int] = {}
    for d, _, _ in plan:
        dist[d] = dist.get(d, 0) + 1
    for d, n in sorted(dist.items(), key=lambda x: -x[1]):
        print(f"  {d}: {n}")
    if args.dry_run:
        for d, s, u in plan:
            print(f"{d:9s} {s:45s} {u}")
        return

    todo = [(d, s, u) for d, s, u in plan
            if args.force or not (KB / d / f"{s}.md").exists()]
    skip = len(plan) - len(todo)
    ok = fail = 0
    done = 0

    def work(item: tuple[str, str, str]) -> tuple[str, str, int, str]:
        domain, slug, url = item
        try:
            title, body = extract(fetch(url))
            if len(body) < 200:
                raise RuntimeError(f"正文过短 {len(body)}")
            n = write_md(domain, slug, title or slug, url, body)
            return domain, slug, n, ""
        except Exception as exc:  # noqa: BLE001
            return domain, slug, 0, str(exc)

    with cf.ThreadPoolExecutor(max_workers=args.workers) as pool:
        for domain, slug, n, err in pool.map(work, todo):
            done += 1
            if err:
                fail += 1
                print(f"  [{done}/{len(todo)}] {domain}/{slug} ✗ {err}", file=sys.stderr, flush=True)
            else:
                ok += 1
                print(f"  [{done}/{len(todo)}] {domain}/{slug} ✓ {n} 字", flush=True)

    print(f"\n完成：新增 {ok}，跳过 {skip}，失败 {fail}，总计 {len(plan)}")
    for d in sorted({x[0] for x in plan}):
        print(f"  kb/{d}: {len(list((KB / d).glob('*.md')))} 篇")


if __name__ == "__main__":
    main()
