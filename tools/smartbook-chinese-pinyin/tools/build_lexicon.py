#!/usr/bin/env python3
"""Convert Reader AI's CC-CEDICT JSON asset to compact gzip TSV."""
from __future__ import annotations

import argparse
import gzip
import json
import pathlib
import re
import zipfile

HAN_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
ASSET = "assets/www/data/zh_dict_core.json"


def escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("\t", "\\t").replace("\r", "\\r").replace("\n", "\\n")


def load_payload(source: pathlib.Path) -> dict:
    if source.suffix.lower() == ".apk":
        with zipfile.ZipFile(source) as archive:
            with archive.open(ASSET) as handle:
                return json.load(handle)
    with source.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=pathlib.Path, help="Reader AI APK or zh_dict_core.json")
    parser.add_argument("output", type=pathlib.Path, help="Output .tsv.gz asset")
    args = parser.parse_args()

    payload = load_payload(args.source)
    raw_map = payload.get("map", payload)
    if not isinstance(raw_map, dict):
        raise SystemExit("dictionary map not found")

    rows: list[tuple[str, str]] = []
    for word, raw in raw_map.items():
        if not isinstance(word, str) or not HAN_RE.search(word):
            continue
        if isinstance(raw, list):
            pinyin = str(raw[0] if raw else "").strip()
        elif isinstance(raw, dict):
            pinyin = str(raw.get("pinyin") or raw.get("py") or raw.get("reading") or "").strip()
        else:
            continue
        if pinyin:
            rows.append((word.strip(), pinyin))

    rows.sort(key=lambda row: row[0])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(args.output, "wt", encoding="utf-8", newline="\n", compresslevel=9) as out:
        out.write(f"# smartbook-pinyin-v1\t{len(rows)}\t{payload.get('version', 'unknown')}\n")
        for word, pinyin in rows:
            out.write(f"{escape(word)}\t{escape(pinyin)}\n")

    print(f"wrote {len(rows):,} entries to {args.output} ({args.output.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
