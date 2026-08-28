#!/usr/bin/env python3
import argparse
import json
import os
import re
import sqlite3
import unicodedata


def norm(value: str) -> str:
    return (value or "").strip().lower().replace("’", "'").replace("‘", "'")


def clean(value: str) -> str:
    text = re.sub(r"\[\[([^\]]+)\]\]", r"\1", value or "")
    text = unicodedata.normalize("NFD", text)
    text = "".join(ch for ch in text if ch != "\u0301")
    text = unicodedata.normalize("NFC", text)
    return " ".join(text.split()).strip()


def first_translation(value: str) -> str:
    parts = [part.strip() for part in (value or "").split("|") if part.strip()]
    return clean(parts[0] if parts else "")


def export(source_db: str, output_json: str) -> None:
    os.makedirs(os.path.dirname(output_json), exist_ok=True)
    conn = sqlite3.connect(f"file:{source_db}?mode=ro", uri=True)
    try:
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        data = {}

        # toc81: export the FULL WikDict source. toc80 accidentally exported the
        # frequency-list-filtered `translations` table, which meant Reader could
        # mark an unranked word Unknown but have no RU entry for it.
        if "simple_translation" in tables:
            rows = conn.execute(
                "SELECT written_rep, trans_list FROM simple_translation "
                "WHERE written_rep IS NOT NULL AND trans_list IS NOT NULL"
            )
            for word, raw_ru in rows:
                key = norm(word)
                ru = first_translation(raw_ru)
                if key and ru and key not in data:
                    data[key] = ru
        elif "translations" in tables:
            # Compatibility with the old compact DB, useful for local tooling.
            for word, ru in conn.execute("SELECT word, ru FROM translations"):
                key = norm(word)
                ru = clean(ru)
                if key and ru and key not in data:
                    data[key] = ru
        else:
            raise SystemExit(f"Unsupported WikDict schema: {sorted(tables)}")
    finally:
        conn.close()

    with open(output_json, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    print(f"WikDict EN-RU FULL JSON: {len(data)} entries -> {output_json}")
    for probe in ("venezuela", "realignment", "reuters", "long-term", "oilfield", "oilfields"):
        print(f"probe {probe}: {data.get(probe, '∅')}")
    if len(data) < 50000:
        raise SystemExit(f"WikDict EN-RU full JSON unexpectedly small: {len(data)}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source_db")
    parser.add_argument("output_json")
    args = parser.parse_args()
    export(args.source_db, args.output_json)


if __name__ == "__main__":
    main()
