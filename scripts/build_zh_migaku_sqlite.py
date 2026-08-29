#!/usr/bin/env python3
"""Build Reader AI's full offline Mandarin resource database.

The database keeps Migaku's full Mandarin dictionary plus independent BLCU,
SUBTLEX-CH, Jieba and HSK metadata. It is queried natively on Android so the
WebView never parses a 60+ MB JSON dictionary.
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import time
from pathlib import Path

import build_zh_migaku_resources as base
import build_zh_migaku_resources_v2 as published


def strip_markup(value: str) -> str:
    text = str(value or "")
    text = re.sub(r"<br\s*/?>", "; ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def build_database(db_path: Path, dictionary, profiles) -> None:
    if db_path.exists():
        db_path.unlink()
    db_path.parent.mkdir(parents=True, exist_ok=True)

    profile_map = {row["w"]: row for row in profiles["entries"] if row.get("w")}
    db = sqlite3.connect(db_path)
    try:
        db.execute("PRAGMA journal_mode=OFF")
        db.execute("PRAGMA synchronous=OFF")
        db.execute("PRAGMA temp_store=MEMORY")
        db.execute("PRAGMA page_size=4096")
        db.execute(
            """
            CREATE TABLE entries (
                word TEXT PRIMARY KEY,
                pinyin TEXT NOT NULL DEFAULT '',
                en TEXT NOT NULL DEFAULT '',
                alt TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '',
                blcu INTEGER,
                subtlex INTEGER,
                jieba INTEGER,
                hsk TEXT NOT NULL DEFAULT '',
                new_hsk TEXT NOT NULL DEFAULT ''
            ) WITHOUT ROWID
            """
        )

        batch = []
        seen = set()
        for item in dictionary:
            word = base.clean_text(item.get("word"))
            if not word or word in seen:
                continue
            seen.add(word)
            meta = profile_map.pop(word, None) or {}
            batch.append((
                word,
                base.clean_text(item.get("pinyin")),
                strip_markup(item.get("en", "")),
                base.clean_text(item.get("alt")),
                base.clean_text(item.get("tags")),
                meta.get("b"), meta.get("s"), meta.get("j"),
                base.clean_text(meta.get("h")), base.clean_text(meta.get("n")),
            ))
            if len(batch) >= 5000:
                db.executemany("INSERT INTO entries VALUES (?,?,?,?,?,?,?,?,?,?)", batch)
                batch.clear()

        if batch:
            db.executemany("INSERT INTO entries VALUES (?,?,?,?,?,?,?,?,?,?)", batch)
            batch.clear()

        for word, meta in profile_map.items():
            batch.append((
                word, "", "", "", "",
                meta.get("b"), meta.get("s"), meta.get("j"),
                base.clean_text(meta.get("h")), base.clean_text(meta.get("n")),
            ))
            if len(batch) >= 5000:
                db.executemany("INSERT INTO entries VALUES (?,?,?,?,?,?,?,?,?,?)", batch)
                batch.clear()
        if batch:
            db.executemany("INSERT INTO entries VALUES (?,?,?,?,?,?,?,?,?,?)", batch)

        # Traditional/alternate forms are uncommon in the Simplified reader but
        # still useful for imported books. A partial index is cheaper than
        # duplicating half a million rows.
        db.execute("CREATE INDEX idx_entries_alt ON entries(alt) WHERE alt <> ''")
        db.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID")
        db.executemany("INSERT INTO meta(key,value) VALUES (?,?)", [
            ("format", "reader-ai-migaku-zh-sqlite-v1"),
            ("dictionary_source", base.DICT_NAME),
            ("built_at", str(int(time.time()))),
        ])
        db.commit()
        db.execute("VACUUM")
        db.execute("ANALYZE")
        db.commit()
    finally:
        db.close()


def verify_database(db_path: Path, minimum: int) -> dict:
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        count = db.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
        if count < minimum:
            raise RuntimeError(f"SQLite resource layer unexpectedly small: {count}")
        probes = {}
        for word in ("摇头", "立刻", "特警", "觉得", "中国"):
            row = db.execute(
                "SELECT word,pinyin,en,blcu,subtlex,jieba,hsk,new_hsk FROM entries WHERE word=? LIMIT 1",
                (word,),
            ).fetchone()
            probes[word] = bool(row)
        return {"entries": count, "probes": probes, "bytes": db_path.stat().st_size}
    finally:
        db.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--output-dir", default="data")
    ap.add_argument("--cache-dir", default="build/migaku-zh-cache")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        base.self_test()
        assert strip_markup("a<br>b") == "a; b"
        print("sqlite self-test OK")
        return 0

    out_dir = Path(args.output_dir)
    cache_dir = Path(args.cache_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    urls = {key: published.resource_url(value) for key, value in published.RESOURCE_PATHS.items()}

    dictionary = base.extract_dictionary(base.fetch_json(urls["dictionary"], cache_dir))
    if len(dictionary) < 1000:
        raise RuntimeError(f"Migaku Mandarin dictionary unexpectedly small: {len(dictionary)}")

    freqs = {}
    for key in ("blcu", "subtlex", "jieba"):
        words = base.extract_frequency(base.fetch_json(urls[key], cache_dir))
        if len(words) < 1000:
            raise RuntimeError(f"{key} frequency list unexpectedly small: {len(words)}")
        freqs[key] = words

    word_lists = {}
    for key in ("hsk", "new_hsk"):
        levels = base.extract_word_levels(base.fetch_json(urls[key], cache_dir))
        if len(levels) < 100:
            raise RuntimeError(f"{key} word list unexpectedly small: {len(levels)}")
        word_lists[key] = levels

    profiles = base.build_profiles(freqs, word_lists)
    db_path = out_dir / "zh_migaku.sqlite3"
    build_database(db_path, dictionary, profiles)
    check = verify_database(db_path, max(1000, len(dictionary) // 2))

    manifest = {
        "version": 4,
        "format": "reader-ai-migaku-zh-sqlite-v1",
        "builtAt": int(time.time()),
        "index": base.INDEX_URL,
        "dictionary": {"name": base.DICT_NAME, "count": len(dictionary), "url": urls["dictionary"]},
        "frequency": {
            "blcu": {"name": "BLCU Standard", "count": len(freqs["blcu"]), "url": urls["blcu"]},
            "subtlex": {"name": "SUBTLEX-CH TV & Movies", "count": len(freqs["subtlex"]), "url": urls["subtlex"]},
            "jieba": {"name": "Jieba Internet", "count": len(freqs["jieba"]), "url": urls["jieba"]},
        },
        "wordLists": {
            "hsk": {"name": "HSK Simplified", "count": len(word_lists["hsk"]), "url": urls["hsk"]},
            "new_hsk": {"name": "New HSK Simplified", "count": len(word_lists["new_hsk"]), "url": urls["new_hsk"]},
        },
        "unionCount": len(profiles["entries"]),
        "sqlite": check,
    }
    (out_dir / "zh_migaku_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
