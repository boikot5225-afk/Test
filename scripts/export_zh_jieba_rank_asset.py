#!/usr/bin/env python3
"""Export a compact rank-ordered Jieba lexicon for Reader's synchronous segmenter.

The full 555k Migaku database remains native SQLite. WebView only receives the
most useful 100k Jieba entries, one word per line; the 1-based line number is
the rank, so no redundant integers/JSON keys are shipped.
"""
from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path


def export(db_path: Path, output: Path, limit: int = 100_000) -> int:
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = con.execute(
            "SELECT word,jieba FROM entries WHERE jieba IS NOT NULL AND jieba<=? ORDER BY jieba ASC",
            (int(limit),),
        ).fetchall()
    finally:
        con.close()
    if len(rows) < min(50_000, limit // 2):
        raise RuntimeError(f"Jieba rank export unexpectedly small: {len(rows)}")
    output.parent.mkdir(parents=True, exist_ok=True)
    seen = set()
    words = []
    last_rank = 0
    for word, rank in rows:
        word = str(word or "").strip()
        rank = int(rank or 0)
        if not word or rank <= 0 or word in seen:
            continue
        if rank < last_rank:
            raise RuntimeError("Jieba rows are not rank ordered")
        seen.add(word)
        words.append(word)
        last_rank = rank
    output.write_text("\n".join(words) + "\n", encoding="utf-8")
    return len(words)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("db")
    ap.add_argument("output")
    ap.add_argument("--limit", type=int, default=100_000)
    args = ap.parse_args()
    count = export(Path(args.db), Path(args.output), args.limit)
    print(f"Jieba rank asset: {count:,} words -> {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
