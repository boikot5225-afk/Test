#!/usr/bin/env python3
"""Stable Reader AI builder for Migaku Chinese resources.

Use the public resource URLs published by Migaku's index directly. This avoids
coupling the Android build to the index's nested UI grouping while still using
only resources advertised in that index.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import build_zh_migaku_resources as base

RESOURCE_URLS = {
    "dictionary": "/zh_CN/en/migaku-mandarin-dict.json.zip",
    "blcu": "/zh_CN/frequency_lists/Beijing Language and Culture University Corpus.json.zip",
    "subtlex": "/zh_CN/frequency_lists/Loach.json.zip",
    "jieba": "/zh_CN/frequency_lists/Jieba.json.zip",
    "hsk": "/zh_CN/word_lists/HSK_Simplified.json",
    "new_hsk": "/zh_CN/word_lists/New_HSK_Simplified.json",
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--output-dir", default="data")
    ap.add_argument("--cache-dir", default="build/migaku-zh-cache")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        base.self_test()
        return 0

    out_dir = Path(args.output_dir)
    cache_dir = Path(args.cache_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    urls = {key: base.absolute_url(value) for key, value in RESOURCE_URLS.items()}

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
    dict_payload = {
        "version": 1,
        "format": "reader-ai-migaku-mandarin-v1",
        "source": base.DICT_NAME,
        "entries": dictionary,
    }
    manifest = {
        "version": 2,
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
    }

    (out_dir / "zh_migaku_dict.json").write_text(
        json.dumps(dict_payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    (out_dir / "zh_migaku_profiles.json").write_text(
        json.dumps(profiles, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    (out_dir / "zh_migaku_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
