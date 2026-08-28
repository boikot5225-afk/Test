#!/usr/bin/env python3
import argparse
import json
import os
import re
import sqlite3
import unicodedata


def clean(value: str) -> str:
    text = re.sub(r"\[\[([^\]]+)\]\]", r"\1", value or "")
    text = unicodedata.normalize("NFD", text)
    text = "".join(ch for ch in text if ch != "\u0301")
    text = unicodedata.normalize("NFC", text)
    return " ".join(text.split()).strip()


def export(source_db: str, output_json: str) -> None:
    os.makedirs(os.path.dirname(output_json), exist_ok=True)
    conn = sqlite3.connect(f"file:{source_db}?mode=ro", uri=True)
    try:
        data = {}
        for word, ru in conn.execute("SELECT word, ru FROM translations ORDER BY word COLLATE NOCASE"):
            word = (word or "").strip().lower()
            ru = clean(ru)
            if word and ru:
                data[word] = ru
    finally:
        conn.close()

    with open(output_json, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    print(f"WikDict EN-RU JSON: {len(data)} entries -> {output_json}")
    if len(data) < 5000:
        raise SystemExit(f"WikDict EN-RU JSON unexpectedly small: {len(data)}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source_db")
    parser.add_argument("output_json")
    args = parser.parse_args()
    export(args.source_db, args.output_json)


if __name__ == "__main__":
    main()
