#!/usr/bin/env python3
"""Reader AI Chinese lexical pipeline v2 research harness.

This script does NOT modify application assets. It answers two questions before
we ship another APK:
1) Does a frequency-weighted DAG segmenter beat the old greedy longest-match on
   real Reader failures?
2) Is FreeDict zho-rus useful enough, and under what licence, to become a direct
   Chinese->Russian lexical layer?
"""
from __future__ import annotations

import argparse
import io
import json
import math
import re
import sqlite3
import tarfile
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Iterable

FREEDICT_VERSION = "2025.11.23"
FREEDICT_SRC_URL = (
    "https://download.freedict.org/dictionaries/zho-rus/"
    f"{FREEDICT_VERSION}/freedict-zho-rus-{FREEDICT_VERSION}.src.tar.xz"
)

TARGET_WORDS = [
    "国号", "公元", "正史", "诋毁", "称呼", "称谓", "商业", "供应链",
    "国防部", "业务", "名单", "本身", "有期徒刑", "太平天国", "印行",
    "出版", "国民政府", "内政部", "教育部", "酌办", "嗣后", "违反", "本法",
]

SEGMENT_CASES = [
    {
        "id": "taiping-name",
        "text": "代以太平军或相应之名称",
        "must": ["代", "以", "太平军", "或", "相应", "之", "名称"],
        "forbid": ["以太"],
    },
    {
        "id": "law-violation",
        "text": "凡有违反本法以诋毁称呼太平天国",
        "must": ["凡", "有", "违反", "本法", "以", "诋毁", "称呼", "太平天国"],
        "forbid": ["有违"],
    },
    {
        "id": "historical-government",
        "text": "南京国民政府就禁止诬蔑太平天国案函请内政部教育部参考酌办",
        "must": ["南京", "国民政府", "就", "禁止", "诬蔑", "太平天国", "案", "函", "请", "内政部", "教育部", "参考", "酌办"],
        "forbid": [],
    },
    {
        "id": "dram-lawsuit",
        "text": "CXMT称自己只面向民用和商业市场与中国军方没有关联并指控美国国防部在评估过程中存在程序问题",
        "must_contains": ["商业", "没有", "关联", "指控", "国防部", "评估", "过程", "程序"],
        "forbid": ["有关联"],
    },
    {
        "id": "supply-chain",
        "text": "并可能进一步增加制裁客户流失和国际供应链排斥风险",
        "must": ["并", "可能", "进一步", "增加", "制裁", "客户", "流失", "和", "国际", "供应链", "排斥", "风险"],
        "forbid": [],
    },
]

HAN_RE = re.compile(r"[\u3400-\u9fff]")
ALL_HAN_RE = re.compile(r"^[\u3400-\u9fff]+$")


def load_core_words(path: Path) -> set[str]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return set((payload.get("map") or {}).keys())


def load_jieba_ranks(db_path: Path, limit: int = 100_000) -> dict[str, int]:
    con = sqlite3.connect(str(db_path))
    try:
        rows = con.execute(
            "SELECT word,jieba FROM entries WHERE jieba IS NOT NULL AND jieba<=?",
            (limit,),
        ).fetchall()
    finally:
        con.close()
    return {str(word): int(rank) for word, rank in rows if word and rank}


def old_greedy(text: str, words: set[str], max_len: int = 12) -> list[str]:
    out: list[str] = []
    i = 0
    while i < len(text):
        ch = text[i]
        if not HAN_RE.match(ch):
            j = i + 1
            while j < len(text) and not HAN_RE.match(text[j]):
                j += 1
            out.append(text[i:j])
            i = j
            continue
        best = ""
        for size in range(min(max_len, len(text) - i), 0, -1):
            piece = text[i:i + size]
            if size == 1 or piece in words:
                best = piece
                break
        out.append(best or ch)
        i += len(best or ch)
    return [x for x in out if x]


def token_cost(word: str, rank: int | None) -> float:
    """Zipf-ish surrogate for Jieba's log probability.

    Actual Jieba uses log(freq / total). We only need stable relative ordering;
    rank is enough to heavily prefer common lexical paths while an unranked
    dictionary word remains possible but expensive. A per-token constant makes
    implausible character soup lose without blindly preferring the longest word.
    """
    effective_rank = rank if rank is not None else 300_000
    return math.log(effective_rank + 10.0) + 3.0


def segment_han_run(run: str, words: set[str], ranks: dict[str, int], max_len: int = 8) -> list[str]:
    n = len(run)
    best_cost = [float("inf")] * (n + 1)
    best_next: list[tuple[int, str] | None] = [None] * (n + 1)
    best_cost[n] = 0.0
    for i in range(n - 1, -1, -1):
        for size in range(1, min(max_len, n - i) + 1):
            word = run[i:i + size]
            if size > 1 and word not in words and word not in ranks:
                continue
            cost = token_cost(word, ranks.get(word)) + best_cost[i + size]
            if cost < best_cost[i]:
                best_cost[i] = cost
                best_next[i] = (i + size, word)
    if best_next[0] is None:
        return list(run)
    out: list[str] = []
    i = 0
    while i < n:
        step = best_next[i]
        if step is None:
            out.append(run[i])
            i += 1
        else:
            i, word = step
            out.append(word)
    return out


def weighted_segment(text: str, words: set[str], ranks: dict[str, int]) -> list[str]:
    out: list[str] = []
    i = 0
    while i < len(text):
        if HAN_RE.match(text[i]):
            j = i + 1
            while j < len(text) and HAN_RE.match(text[j]):
                j += 1
            out.extend(segment_han_run(text[i:j], words, ranks))
            i = j
        else:
            j = i + 1
            while j < len(text) and not HAN_RE.match(text[j]):
                j += 1
            out.append(text[i:j])
            i = j
    return [x for x in out if x]


def compact_han(tokens: Iterable[str]) -> list[str]:
    return [x for x in tokens if ALL_HAN_RE.match(x)]


def case_passes(case: dict, tokens: list[str]) -> bool:
    han = compact_han(tokens)
    if "must" in case and han != case["must"]:
        return False
    if any(x in han for x in case.get("forbid", [])):
        return False
    if any(x not in han for x in case.get("must_contains", [])):
        return False
    return True


def benchmark_segmentation(core_path: Path, db_path: Path) -> dict:
    core = load_core_words(core_path)
    ranks = load_jieba_ranks(db_path)
    candidate_words = core | set(ranks)
    rows = []
    old_pass = 0
    new_pass = 0
    for case in SEGMENT_CASES:
        old = old_greedy(case["text"], candidate_words)
        new = weighted_segment(case["text"], candidate_words, ranks)
        op = case_passes(case, old)
        np = case_passes(case, new)
        old_pass += int(op)
        new_pass += int(np)
        rows.append({
            "id": case["id"],
            "text": case["text"],
            "old": old,
            "new": new,
            "old_pass": op,
            "new_pass": np,
        })
    return {
        "rank_count": len(ranks),
        "core_count": len(core),
        "old_pass": old_pass,
        "new_pass": new_pass,
        "total": len(rows),
        "cases": rows,
    }


def download(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "ReaderAI-lexical-research/1.0"})
    with urllib.request.urlopen(request, timeout=180) as response:
        return response.read()


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def all_text(node: ET.Element) -> str:
    return " ".join(" ".join(node.itertext()).split())


def inspect_freedict() -> dict:
    raw = download(FREEDICT_SRC_URL)
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:xz") as tf:
        members = [m for m in tf.getmembers() if m.isfile() and m.name.lower().endswith(".tei")]
        if not members:
            raise RuntimeError("FreeDict source archive has no TEI file")
        member = max(members, key=lambda m: m.size)
        stream = tf.extractfile(member)
        if stream is None:
            raise RuntimeError("Unable to read FreeDict TEI")
        xml_bytes = stream.read()

    root = ET.fromstring(xml_bytes)
    availability = []
    licence_targets = []
    for node in root.iter():
        name = local_name(node.tag)
        if name == "availability":
            text = all_text(node)
            if text: availability.append(text)
        if name in {"licence", "license"}:
            target = node.attrib.get("target") or node.attrib.get("corresp") or ""
            text = all_text(node)
            if target: licence_targets.append(target)
            if text: availability.append(text)

    wanted = set(TARGET_WORDS)
    found: dict[str, list[str]] = {word: [] for word in TARGET_WORDS}
    entry_count = 0
    for entry in root.iter():
        if local_name(entry.tag) != "entry":
            continue
        entry_count += 1
        orths = []
        for node in entry.iter():
            if local_name(node.tag) == "orth":
                value = all_text(node)
                if value: orths.append(value)
        matched = wanted.intersection(orths)
        if not matched:
            continue
        translations = []
        for node in entry.iter():
            if local_name(node.tag) in {"quote", "def"}:
                value = all_text(node)
                if value and value not in orths and value not in translations:
                    translations.append(value)
        for word in matched:
            for value in translations[:8]:
                if value not in found[word]:
                    found[word].append(value)

    return {
        "url": FREEDICT_SRC_URL,
        "archive_bytes": len(raw),
        "tei_bytes": len(xml_bytes),
        "entry_count": entry_count,
        "availability": availability[:8],
        "licence_targets": licence_targets[:8],
        "samples": found,
        "sample_hits": sum(bool(v) for v in found.values()),
        "sample_total": len(found),
    }


def markdown_report(report: dict) -> str:
    seg = report["segmentation"]
    fd = report.get("freedict") or {}
    lines = [
        "# Reader AI — Chinese lexical pipeline v2 research",
        "",
        f"Segmentation regression: old **{seg['old_pass']}/{seg['total']}**, weighted DAG **{seg['new_pass']}/{seg['total']}**.",
        f"Rank lexicon: {seg['rank_count']:,}; core lexicon: {seg['core_count']:,}.",
        "",
        "## Segmentation cases",
        "",
    ]
    for row in seg["cases"]:
        lines += [
            f"### {row['id']}",
            f"- old ({'PASS' if row['old_pass'] else 'FAIL'}): `{' | '.join(row['old'])}`",
            f"- v2 ({'PASS' if row['new_pass'] else 'FAIL'}): `{' | '.join(row['new'])}`",
            "",
        ]
    if fd:
        lines += [
            "## FreeDict zho-rus",
            "",
            f"- entries parsed: {fd.get('entry_count', 0):,}",
            f"- benchmark hits: {fd.get('sample_hits', 0)}/{fd.get('sample_total', 0)}",
            f"- licence targets: {', '.join(fd.get('licence_targets') or []) or 'not found'}",
            "- availability: " + " | ".join(fd.get("availability") or ["not found"]),
            "",
        ]
        for word, values in (fd.get("samples") or {}).items():
            lines.append(f"- **{word}**: {'; '.join(values[:4]) if values else '∅'}")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--core", default="data/zh_dict_core.json")
    parser.add_argument("--sqlite", default="android/app/src/main/assets/data/zh_migaku.sqlite3")
    parser.add_argument("--out", default="build/zh-lexical-pipeline-v2")
    parser.add_argument("--skip-freedict", action="store_true")
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    report = {
        "segmentation": benchmark_segmentation(Path(args.core), Path(args.sqlite)),
    }
    if not args.skip_freedict:
        try:
            report["freedict"] = inspect_freedict()
        except Exception as exc:
            report["freedict_error"] = f"{type(exc).__name__}: {exc}"

    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (out / "report.md").write_text(markdown_report(report), encoding="utf-8")
    print((out / "report.md").read_text(encoding="utf-8"))

    seg = report["segmentation"]
    if seg["new_pass"] < seg["total"]:
        raise SystemExit(f"weighted segmenter regression: {seg['new_pass']}/{seg['total']}")
    if seg["new_pass"] <= seg["old_pass"]:
        raise SystemExit("weighted segmenter did not improve over greedy baseline")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
