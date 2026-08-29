#!/usr/bin/env python3
import argparse
import json
import os
import re
import sqlite3
import unicodedata
from pathlib import Path


def norm(value: str) -> str:
    return (value or "").strip().lower().replace("’", "'").replace("‘", "'")


def clean(value: str) -> str:
    text = re.sub(r"\[\[([^\]]+)\]\]", r"\1", value or "")
    text = unicodedata.normalize("NFD", text)
    text = "".join(ch for ch in text if ch != "\u0301")
    text = unicodedata.normalize("NFC", text)
    return " ".join(text.split()).strip()


def translations(value: str) -> list[str]:
    out = []
    seen = set()
    for raw in (value or "").split("|"):
        item = clean(raw)
        key = item.lower()
        if not item or key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out


def first_translation(value: str) -> str:
    parts = translations(value)
    return parts[0] if parts else ""


def frequency_words() -> set[str]:
    path = Path(__file__).resolve().parents[1] / "data" / "en_vocab_frequency.tsv"
    if not path.exists():
        return set()
    words = set()
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            word = norm(line.split("\t", 1)[0])
            if word:
                words.add(word)
    return words


def export(source_db: str, output_json: str) -> None:
    os.makedirs(os.path.dirname(output_json), exist_ok=True)
    senses_json = os.path.join(os.path.dirname(output_json), "en_ru_senses.json")
    ranked = frequency_words()

    conn = sqlite3.connect(f"file:{source_db}?mode=ro", uri=True)
    try:
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        data = {}
        sense_lists = {}

        # toc81: export the FULL WikDict source for immediate first-sense lookup.
        # toc102 additionally preserves multiple RU senses for Reader's ranked
        # English vocabulary. The context layer can then refine a gloss without
        # shipping the entire raw WikDict database or changing the old JSON API.
        if "simple_translation" in tables:
            rows = conn.execute(
                "SELECT written_rep, trans_list FROM simple_translation "
                "WHERE written_rep IS NOT NULL AND trans_list IS NOT NULL"
            )
            for word, raw_ru in rows:
                key = norm(word)
                parts = translations(raw_ru)
                if not key or not parts:
                    continue
                if key not in data:
                    data[key] = parts[0]
                if ranked and key not in ranked:
                    continue
                bucket = sense_lists.setdefault(key, [])
                known = {value.lower() for value in bucket}
                for value in parts:
                    low = value.lower()
                    if low not in known:
                        bucket.append(value)
                        known.add(low)
                    if len(bucket) >= 12:
                        break
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

    # Only genuinely ambiguous ranked words are useful to the runtime. Keeping
    # one-sense entries out makes the asset much smaller and avoids pointless
    # ML Kit requests.
    senses = {
        key: values
        for key, values in sense_lists.items()
        if len(values) >= 2
    }

    with open(output_json, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    with open(senses_json, "w", encoding="utf-8") as fh:
        json.dump(senses, fh, ensure_ascii=False, separators=(",", ":"), sort_keys=True)

    print(f"WikDict EN-RU FULL JSON: {len(data)} entries -> {output_json}")
    print(f"WikDict EN-RU SENSES: {len(senses)} ambiguous ranked entries -> {senses_json}")
    for probe in ("charge", "right", "mean", "match", "left", "better", "bank", "date"):
        print(f"probe {probe}: first={data.get(probe, '∅')} senses={senses.get(probe, [])[:6]}")
    if len(data) < 50000:
        raise SystemExit(f"WikDict EN-RU full JSON unexpectedly small: {len(data)}")
    if ranked and len(senses) < 1000:
        raise SystemExit(f"WikDict EN-RU sense JSON unexpectedly small: {len(senses)}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source_db")
    parser.add_argument("output_json")
    args = parser.parse_args()
    export(args.source_db, args.output_json)


if __name__ == "__main__":
    main()
