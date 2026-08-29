#!/usr/bin/env python3
"""Stable Reader AI builder for Migaku Chinese resources.

Migaku publishes resource paths in /dicts/index.json as language-relative paths
(`/zh_CN/...`). The CDN serves those files under the same /dicts namespace as
the index, so resolve them against https://migaku-public-data.migaku.com/dicts.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from urllib.parse import quote

import build_zh_migaku_resources as base

RESOURCE_ROOT = "https://migaku-public-data.migaku.com/dicts"
RESOURCE_PATHS = {
    "dictionary": "/zh_CN/en/migaku-mandarin-dict.json.zip",
    "blcu": "/zh_CN/frequency_lists/Beijing Language and Culture University Corpus.json.zip",
    "subtlex": "/zh_CN/frequency_lists/Loach.json.zip",
    "jieba": "/zh_CN/frequency_lists/Jieba.json.zip",
    "hsk": "/zh_CN/word_lists/HSK_Simplified.json",
    "new_hsk": "/zh_CN/word_lists/New_HSK_Simplified.json",
}


def resource_url(path: str) -> str:
    # Keep URL path separators but encode spaces/non-ASCII safely for urllib.
    return RESOURCE_ROOT + quote(path, safe="/._-~")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--output-dir", default="data")
    ap.add_argument("--cache-dir", default="build/migaku-zh-cache")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        base.self_test()
        assert resource_url(RESOURCE_PATHS["dictionary"]).startswith(RESOURCE_ROOT + "/zh_CN/")
        return 0

    out_dir = Path(args.output_dir)
    cache_dir = Path(args.cache_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    urls = {key: resource_url(value) for key, value in RESOURCE_PATHS.items()}

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
        "version": 3,
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
