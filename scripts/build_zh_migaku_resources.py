#!/usr/bin/env python3
"""Build a compact Reader AI Chinese resource layer from Migaku public data.

The script intentionally keeps Reader AI's existing 39,999-word assessment list
untouched. It adds independent BLCU / SUBTLEX-CH / Jieba ranks, HSK metadata,
and a supplemental Mandarin dictionary used only as a fallback.
"""
from __future__ import annotations

import argparse
import io
import json
import re
import time
import urllib.request
import zipfile
from collections import OrderedDict
from pathlib import Path
from typing import Any, Iterable

INDEX_URL = "https://migaku-public-data.migaku.com/dicts/index.json"
ORIGIN = "https://migaku-public-data.migaku.com"
UA = "ReaderAI/77.42 (+resource-builder)"

FREQ_NAMES = {
    "blcu": "Standard",
    "subtlex": "TV & Movies",
    "jieba": "Internet",
}
WORD_LIST_NAMES = {
    "hsk": "HSK Simplified",
    "new_hsk": "New HSK Simplified",
}
DICT_NAME = "Migaku Mandarin Dictionary"


def clean_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return "; ".join(x for x in (clean_text(v) for v in value) if x)
    if isinstance(value, dict):
        for key in ("text", "value", "definition", "meaning", "gloss"):
            if key in value:
                return clean_text(value[key])
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def absolute_url(path_or_url: str) -> str:
    raw = clean_text(path_or_url)
    if raw.startswith("https://") or raw.startswith("http://"):
        return raw
    if not raw.startswith("/"):
        raw = "/" + raw
    return ORIGIN + raw


def fetch_bytes(url: str, cache_dir: Path, *, timeout: int = 90) -> bytes:
    cache_dir.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", url.split("/", 3)[-1])[-180:]
    target = cache_dir / safe
    if target.exists() and target.stat().st_size > 0:
        return target.read_bytes()
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        data = response.read()
    if not data:
        raise RuntimeError(f"empty response: {url}")
    target.write_bytes(data)
    return data


def parse_json_bytes(data: bytes, source: str) -> Any:
    if data[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            candidates = [n for n in zf.namelist() if n.lower().endswith(".json") and not n.endswith("/")]
            if not candidates:
                raise RuntimeError(f"zip has no JSON: {source}")
            candidates.sort(key=lambda n: (n.count("/"), -zf.getinfo(n).file_size, n))
            raw = zf.read(candidates[0])
            return json.loads(raw.decode("utf-8-sig"))
    return json.loads(data.decode("utf-8-sig"))


def fetch_json(url: str, cache_dir: Path) -> Any:
    return parse_json_bytes(fetch_bytes(url, cache_dir), url)


def find_language(index: dict[str, Any], code: str = "zh_CN") -> dict[str, Any]:
    for item in index.get("languages", []):
        if item.get("code") == code:
            return item
    raise RuntimeError(f"language {code} missing in Migaku index")


def pick_resource(items: Iterable[dict[str, Any]], name: str) -> dict[str, Any]:
    for item in items or []:
        if clean_text(item.get("name")) == name:
            return item
    raise RuntimeError(f"resource not found: {name}")


WORD_KEYS = ("term", "word", "expression", "surface", "headword", "lemma", "text", "value")
RANK_KEYS = ("rank", "index", "position", "order")
SCORE_KEYS = ("frequency", "freq", "count", "score", "rating")


def word_from_item(item: Any) -> str:
    if isinstance(item, str):
        return clean_text(item)
    if isinstance(item, (list, tuple)):
        for value in item:
            if isinstance(value, str) and clean_text(value):
                return clean_text(value)
        return ""
    if isinstance(item, dict):
        for key in WORD_KEYS:
            if key in item and isinstance(item[key], (str, int, float)):
                value = clean_text(item[key])
                if value:
                    return value
    return ""


def numeric(item: dict[str, Any], keys: tuple[str, ...]) -> float | None:
    for key in keys:
        value = item.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
        if isinstance(value, str):
            try:
                return float(value.replace(",", ""))
            except ValueError:
                pass
    return None


def list_container(payload: Any) -> list[Any] | None:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("entries", "items", "words", "terms", "data", "frequencies", "list"):
            value = payload.get(key)
            if isinstance(value, list):
                return value
    return None


def extract_frequency(payload: Any) -> list[str]:
    seq = list_container(payload)
    if seq is None and isinstance(payload, dict):
        if payload and all(isinstance(k, str) for k in payload.keys()):
            scored = []
            for order, (word, value) in enumerate(payload.items()):
                score = None
                if isinstance(value, (int, float)):
                    score = float(value)
                elif isinstance(value, dict):
                    score = numeric(value, SCORE_KEYS)
                scored.append((word, score, order))
            if any(x[1] is not None for x in scored):
                scored.sort(key=lambda x: (-(x[1] if x[1] is not None else float("-inf")), x[2]))
            seq = [x[0] for x in scored]
        else:
            seq = []
    seq = seq or []

    rows: list[tuple[str, float | None, float | None, int]] = []
    for order, item in enumerate(seq):
        word = word_from_item(item)
        if not word:
            continue
        rank = numeric(item, RANK_KEYS) if isinstance(item, dict) else None
        score = numeric(item, SCORE_KEYS) if isinstance(item, dict) else None
        if isinstance(item, (list, tuple)) and len(item) >= 2 and isinstance(item[1], (int, float)):
            score = float(item[1])
        rows.append((word, rank, score, order))

    if rows and sum(r[1] is not None for r in rows) >= len(rows) * 0.8:
        rows.sort(key=lambda r: (r[1] if r[1] is not None else float("inf"), r[3]))

    out: list[str] = []
    seen: set[str] = set()
    for word, _, _, _ in rows:
        if word and word not in seen:
            seen.add(word)
            out.append(word)
    return out


def normalize_level(value: Any) -> str:
    text = clean_text(value)
    if not text:
        return ""
    m = re.search(r"(?:HSK\s*)?(\d+(?:\.\d+)?)", text, re.I)
    return m.group(1) if m else text[:32]


def extract_word_levels(payload: Any) -> dict[str, str]:
    result: dict[str, str] = {}

    def add(word: str, level: Any = "") -> None:
        w = clean_text(word)
        if not w:
            return
        lvl = normalize_level(level)
        if w not in result or (lvl and not result[w]):
            result[w] = lvl

    def walk(node: Any, inherited: str = "") -> None:
        if isinstance(node, str):
            add(node, inherited)
            return
        if isinstance(node, list):
            for item in node:
                walk(item, inherited)
            return
        if not isinstance(node, dict):
            return
        word = word_from_item(node)
        if word:
            lvl = node.get("level") or node.get("hsk") or node.get("tier") or node.get("band") or inherited
            add(word, lvl)
            return
        for key, value in node.items():
            next_level = inherited
            if re.search(r"(?:level|hsk|band|tier|stage)?\s*\d", str(key), re.I):
                next_level = normalize_level(key)
            if isinstance(value, (dict, list, str)):
                walk(value, next_level)

    walk(payload)
    return result


def flatten_definition(value: Any) -> str:
    if isinstance(value, str):
        return clean_text(value)
    if isinstance(value, list):
        parts = []
        for item in value:
            text = flatten_definition(item)
            if text and text not in parts:
                parts.append(text)
        return "; ".join(parts[:6])
    if isinstance(value, dict):
        for key in ("definition", "definitions", "meaning", "meanings", "gloss", "glosses", "text", "value"):
            if key in value:
                return flatten_definition(value[key])
    return ""


def dictionary_rows(payload: Any) -> Iterable[dict[str, Any]]:
    seq = list_container(payload)
    if seq is not None:
        for item in seq:
            if isinstance(item, dict):
                yield item
            elif isinstance(item, list):
                if len(item) >= 6 and isinstance(item[0], str):
                    yield {
                        "term": item[0],
                        "reading": item[1] if len(item) > 1 else "",
                        "definition": item[5] if len(item) > 5 else "",
                    }
        return
    if isinstance(payload, dict):
        for word, value in payload.items():
            if isinstance(value, dict):
                yield {"term": word, **value}
            elif isinstance(value, (str, list)):
                yield {"term": word, "definition": value}


def extract_dictionary(payload: Any) -> list[dict[str, Any]]:
    merged: OrderedDict[str, dict[str, Any]] = OrderedDict()
    for item in dictionary_rows(payload):
        term = clean_text(item.get("term") or item.get("word") or item.get("expression") or item.get("headword"))
        if not term:
            continue
        reading = clean_text(item.get("reading") or item.get("pinyin") or item.get("pronunciation"))
        alt = clean_text(item.get("termAlt") or item.get("alt") or item.get("traditional") or item.get("simplified"))
        definition = flatten_definition(item.get("definition") or item.get("definitions") or item.get("meaning") or item.get("gloss"))
        tags = clean_text(item.get("vocabularyTags") or item.get("tags"))
        existing = merged.get(term)
        if existing is None:
            merged[term] = {
                "word": term,
                "pinyin": reading,
                "en": definition,
                "alt": alt,
                "tags": tags,
                "source": "migaku-mandarin",
            }
            continue
        if not existing.get("pinyin") and reading:
            existing["pinyin"] = reading
        if not existing.get("alt") and alt:
            existing["alt"] = alt
        if definition:
            defs = [x.strip() for x in re.split(r"\s*;\s*", existing.get("en", "")) if x.strip()]
            for piece in [x.strip() for x in re.split(r"\s*;\s*", definition) if x.strip()]:
                if piece not in defs:
                    defs.append(piece)
            existing["en"] = "; ".join(defs[:8])
    return list(merged.values())


def build_profiles(freqs: dict[str, list[str]], word_lists: dict[str, dict[str, str]]) -> dict[str, Any]:
    union: OrderedDict[str, dict[str, Any]] = OrderedDict()
    rank_field = {"blcu": "b", "subtlex": "s", "jieba": "j"}
    for profile, words in freqs.items():
        key = rank_field[profile]
        for rank, word in enumerate(words, 1):
            row = union.setdefault(word, {"w": word})
            row[key] = rank
    for list_name, levels in word_lists.items():
        key = "h" if list_name == "hsk" else "n"
        for word, level in levels.items():
            row = union.setdefault(word, {"w": word})
            row[key] = level or "1"
    return {
        "version": 1,
        "format": "reader-ai-zh-resource-profiles-v1",
        "profiles": {
            "b": {"id": "blcu", "name": "BLCU", "count": len(freqs.get("blcu", []))},
            "s": {"id": "subtlex", "name": "SUBTLEX-CH", "count": len(freqs.get("subtlex", []))},
            "j": {"id": "jieba", "name": "Jieba", "count": len(freqs.get("jieba", []))},
        },
        "entries": list(union.values()),
    }


def self_test() -> None:
    assert extract_frequency(["我", "的", "你"]) == ["我", "的", "你"]
    assert extract_frequency([{"term": "的", "rank": 1}, {"term": "我", "rank": 2}]) == ["的", "我"]
    assert extract_frequency({"的": 100, "我": 90}) == ["的", "我"]
    d = extract_dictionary([
        {"term": "摇头", "reading": "yáotóu", "termAlt": "搖頭", "definition": "shake one's head", "vocabularyTags": "verb"},
        {"term": "摇头", "reading": "", "definition": "to shake the head"},
    ])
    assert d[0]["word"] == "摇头" and d[0]["pinyin"] == "yáotóu" and "shake" in d[0]["en"]
    levels = extract_word_levels({"HSK 1": ["我", "你"], "HSK 2": ["觉得"]})
    assert levels["我"] == "1" and levels["觉得"] == "2"
    p = build_profiles({"blcu": ["我", "你"], "subtlex": ["你", "好"], "jieba": ["我"]}, {"hsk": levels, "new_hsk": {}})
    assert len(p["entries"]) >= 3
    print("self-test OK")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--output-dir", default="data")
    ap.add_argument("--cache-dir", default="build/migaku-zh-cache")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        self_test()
        return 0

    out_dir = Path(args.output_dir)
    cache_dir = Path(args.cache_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    index = fetch_json(INDEX_URL, cache_dir)
    zh = find_language(index)
    english = next((item for item in zh.get("to_languages", []) if item.get("code") == "en"), None)
    if not english:
        raise RuntimeError("zh_CN -> en dictionary group missing")

    dict_meta = pick_resource(english.get("dictionaries", []), DICT_NAME)
    freq_meta = {k: pick_resource(zh.get("frequency_lists", []), n) for k, n in FREQ_NAMES.items()}
    word_meta = {k: pick_resource(zh.get("word_lists", []), n) for k, n in WORD_LIST_NAMES.items()}

    dictionary = extract_dictionary(fetch_json(absolute_url(dict_meta["url"]), cache_dir))
    if len(dictionary) < 1000:
        raise RuntimeError(f"Migaku Mandarin dictionary unexpectedly small: {len(dictionary)}")

    freqs: dict[str, list[str]] = {}
    for key, meta in freq_meta.items():
        url = absolute_url(meta.get("url_zip") or meta.get("url"))
        words = extract_frequency(fetch_json(url, cache_dir))
        if len(words) < 1000:
            raise RuntimeError(f"{key} frequency list unexpectedly small: {len(words)}")
        freqs[key] = words

    word_lists: dict[str, dict[str, str]] = {}
    for key, meta in word_meta.items():
        levels = extract_word_levels(fetch_json(absolute_url(meta["url"]), cache_dir))
        if len(levels) < 100:
            raise RuntimeError(f"{key} word list unexpectedly small: {len(levels)}")
        word_lists[key] = levels

    profiles = build_profiles(freqs, word_lists)
    dict_payload = {
        "version": 1,
        "format": "reader-ai-migaku-mandarin-v1",
        "source": DICT_NAME,
        "entries": dictionary,
    }
    manifest = {
        "version": 1,
        "builtAt": int(time.time()),
        "index": INDEX_URL,
        "dictionary": {"name": DICT_NAME, "count": len(dictionary), "url": absolute_url(dict_meta["url"])},
        "frequency": {
            key: {"name": meta["name"], "count": len(freqs[key]), "url": absolute_url(meta.get("url_zip") or meta.get("url"))}
            for key, meta in freq_meta.items()
        },
        "wordLists": {
            key: {"name": meta["name"], "count": len(word_lists[key]), "url": absolute_url(meta["url"])}
            for key, meta in word_meta.items()
        },
        "unionCount": len(profiles["entries"]),
    }

    (out_dir / "zh_migaku_dict.json").write_text(json.dumps(dict_payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (out_dir / "zh_migaku_profiles.json").write_text(json.dumps(profiles, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (out_dir / "zh_migaku_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
