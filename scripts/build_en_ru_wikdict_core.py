#!/usr/bin/env python3
import argparse
import os
import sqlite3


def norm(value: str) -> str:
    return (value or "").strip().lower().replace("’", "'").replace("‘", "'")


def load_wanted(freq_path: str, lemma_path: str) -> set[str]:
    wanted: set[str] = set()
    with open(freq_path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n\r")
            if not line:
                continue
            word = line.split("\t", 1)[0].strip()
            if word:
                wanted.add(norm(word))

    with open(lemma_path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n\r")
            if not line or "\t" not in line:
                continue
            surface, lemma = line.split("\t", 1)
            if surface.strip():
                wanted.add(norm(surface))
            if lemma.strip():
                wanted.add(norm(lemma))
    return wanted


def first_translation(value: str) -> str:
    parts = [part.strip() for part in (value or "").split("|") if part.strip()]
    return parts[0] if parts else ""


def build(source_db: str, freq_path: str, lemma_path: str, output_db: str) -> None:
    wanted = load_wanted(freq_path, lemma_path)
    os.makedirs(os.path.dirname(output_db), exist_ok=True)
    if os.path.exists(output_db):
        os.remove(output_db)

    src = sqlite3.connect(f"file:{source_db}?mode=ro", uri=True)
    dst = sqlite3.connect(output_db)
    try:
        dst.execute("PRAGMA journal_mode=OFF")
        dst.execute("PRAGMA synchronous=OFF")
        dst.execute("PRAGMA temp_store=MEMORY")
        dst.execute("CREATE TABLE translations(word TEXT PRIMARY KEY COLLATE NOCASE, ru TEXT NOT NULL)")

        rows = []
        for written_rep, trans_list in src.execute(
            "SELECT written_rep, trans_list FROM simple_translation WHERE written_rep IS NOT NULL AND trans_list IS NOT NULL"
        ):
            key = norm(written_rep)
            if not key or key not in wanted:
                continue
            ru = first_translation(trans_list)
            if not ru:
                continue
            rows.append((key, ru))
            if len(rows) >= 2000:
                dst.executemany("INSERT OR IGNORE INTO translations(word, ru) VALUES(?, ?)", rows)
                rows.clear()
        if rows:
            dst.executemany("INSERT OR IGNORE INTO translations(word, ru) VALUES(?, ?)", rows)

        dst.execute("CREATE INDEX idx_translations_word ON translations(word COLLATE NOCASE)")
        count = dst.execute("SELECT COUNT(*) FROM translations").fetchone()[0]
        dst.commit()
        dst.execute("VACUUM")
        print(f"WikDict EN-RU core: {count} entries from {len(wanted)} requested forms")
        if count < 5000:
            raise SystemExit(f"WikDict EN-RU core unexpectedly small: {count}")
    finally:
        src.close()
        dst.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source_db")
    parser.add_argument("freq_tsv")
    parser.add_argument("lemma_tsv")
    parser.add_argument("output_db")
    args = parser.parse_args()
    build(args.source_db, args.freq_tsv, args.lemma_tsv, args.output_db)


if __name__ == "__main__":
    main()
