#!/usr/bin/env python3
"""Build compact Spanish Reader assets from open datasets.

Primary lexical layer:
  wordhoard v0.1.0 (CC-BY-SA-4.0) — frequency-ranked Spanish lemmas + forms.
Translations:
  WikDict/DBnary 2026-06 (CC-BY-SA) — Spanish -> Russian.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import re
import sqlite3
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

WORDHOARD_URL = "https://github.com/natema/wordhoard/releases/download/v0.1.0/wordhoard-csv-v0.1.0.zip"
WORDHOARD_SHA256 = "83837efd46241e7226fc6daaa9d0cc81b57bf746434b8c539049c660d98ba761"
WIKDICT_URL = "https://download.wikdict.com/dictionaries/sqlite/2_2026-06/es-ru.sqlite3"
USER_AGENT = "Reader-AI-Spanish-resource-builder/1.0"
WORD_RE = re.compile(r"^[a-záéíóúüñ'’-]+$", re.IGNORECASE)


def norm(value: str) -> str:
    return (
        (value or "")
        .strip()
        .replace("’", "'")
        .replace("‘", "'")
        .replace("‐", "-")
        .replace("‑", "-")
        .lower()
    )


def clean_ru(value: str) -> str:
    value = re.sub(r"\[\[([^\]]+)\]\]", r"\1", value or "")
    return " ".join(value.split()).strip()


def download(url: str, path: Path, *, sha256: str = "", min_size: int = 1) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.stat().st_size >= min_size:
        if not sha256 or hashlib.sha256(path.read_bytes()).hexdigest() == sha256:
            return path
        path.unlink()
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=180) as src, path.open("wb") as dst:
        while True:
            chunk = src.read(1024 * 1024)
            if not chunk:
                break
            dst.write(chunk)
    if path.stat().st_size < min_size:
        raise RuntimeError(f"download unexpectedly small: {url} -> {path.stat().st_size} bytes")
    if sha256:
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != sha256:
            raise RuntimeError(f"sha256 mismatch for {url}: {actual} != {sha256}")
    return path


def find_spanish_csv(archive: zipfile.ZipFile) -> str:
    candidates = [n for n in archive.namelist() if n.lower().endswith("/es.csv") or n.lower() == "es.csv"]
    if not candidates:
        candidates = [n for n in archive.namelist() if n.lower().endswith("es.csv")]
    if len(candidates) != 1:
        raise RuntimeError(f"expected exactly one es.csv in wordhoard archive, got {candidates}")
    return candidates[0]


def read_wordhoard(zip_path: Path):
    rows = []
    with zipfile.ZipFile(zip_path) as zf:
        name = find_spanish_csv(zf)
        with zf.open(name) as raw:
            text = io.TextIOWrapper(raw, encoding="utf-8", newline="")
            reader = csv.DictReader(text)
            required = {"lemma", "pos", "frequency_rank", "frequency_count", "cefr_estimate", "forms"}
            missing = required - set(reader.fieldnames or [])
            if missing:
                raise RuntimeError(f"wordhoard es.csv missing columns: {sorted(missing)}")
            for row in reader:
                lemma = norm(row.get("lemma", ""))
                if not lemma or " " in lemma or not WORD_RE.match(lemma):
                    continue
                try:
                    rank = int(row.get("frequency_rank") or 0)
                    count = int(float(row.get("frequency_count") or 0))
                except ValueError:
                    continue
                if rank <= 0:
                    continue
                rows.append({
                    "lemma": lemma,
                    "pos": (row.get("pos") or "").strip(),
                    "rank": rank,
                    "count": count,
                    "cefr": (row.get("cefr_estimate") or "").strip(),
                    "gender": (row.get("gender") or "").strip(),
                    "forms": (row.get("forms") or "").strip(),
                })
    if len(rows) < 45_000:
        raise RuntimeError(f"wordhoard Spanish rows unexpectedly small: {len(rows)}")
    return rows


def build_lexical_assets(rows, output_dir: Path):
    best_by_lemma = {}
    for row in rows:
        old = best_by_lemma.get(row["lemma"])
        if old is None or row["rank"] < old["rank"]:
            best_by_lemma[row["lemma"]] = row

    ranked = sorted(best_by_lemma.values(), key=lambda r: (r["rank"], r["lemma"]))
    with (output_dir / "es_vocab_frequency.tsv").open("w", encoding="utf-8", newline="\n") as fh:
        for row in ranked:
            fh.write(f'{row["lemma"]}\t{row["pos"]}\n')

    candidates = defaultdict(dict)
    lemma_rank = {row["lemma"]: i + 1 for i, row in enumerate(ranked)}
    for row in rows:
        lemma = row["lemma"]
        candidates[lemma][lemma] = min(candidates[lemma].get(lemma, 10**12), lemma_rank.get(lemma, 10**12))
        for item in row["forms"].split(";"):
            if not item:
                continue
            surface = norm(item.split(":", 1)[0])
            if not surface or " " in surface or not WORD_RE.match(surface):
                continue
            rank = lemma_rank.get(lemma, 10**12)
            candidates[surface][lemma] = min(candidates[surface].get(lemma, 10**12), rank)

    lemma_map = {}
    ambiguous = 0
    core_forms = {"soy": "ser", "eres": "ser", "estoy": "estar", "tengo": "tener", "hay": "haber"}
    for surface, options in candidates.items():
        ordered = sorted(options.items(), key=lambda kv: (kv[1], kv[0]))
        if len(ordered) == 1:
            lemma_map[surface] = ordered[0][0]
            continue
        best_lemma, best_rank = ordered[0]
        second_rank = ordered[1][1]
        core = core_forms.get(surface)
        if core and core in options:
            lemma_map[surface] = core
        elif surface in options:
            # Spanish has real collisions such as habla (noun / hablar form).
            # Never destroy the valid headword just to force one morphology.
            lemma_map[surface] = surface
            ambiguous += 1
        elif best_rank <= 1000 and (second_rank >= best_rank * 4 or second_rank - best_rank >= 1500):
            lemma_map[surface] = best_lemma
        else:
            ambiguous += 1

    with (output_dir / "es_vocab_lemma.tsv").open("w", encoding="utf-8", newline="\n") as fh:
        for surface in sorted(lemma_map):
            target = lemma_map[surface]
            if surface != target:
                fh.write(f"{surface}\t{target}\n")

    meta = {
        "source": "wordhoard",
        "source_version": "0.1.0",
        "language": "es",
        "ranked_lemmas": len(ranked),
        "mapped_inflected_forms": sum(1 for s, l in lemma_map.items() if s != l),
        "ambiguous_forms_preserved_or_left_for_context": ambiguous,
        "top20": [row["lemma"] for row in ranked[:20]],
    }
    (output_dir / "es_vocab_manifest.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return ranked, lemma_map, meta


def build_wikdict_json(source_db: Path, output_dir: Path, ranked_lemmas):
    ranked = {row["lemma"] for row in ranked_lemmas}
    conn = sqlite3.connect(f"file:{source_db}?mode=ro", uri=True)
    data = {}
    senses = {}
    try:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "simple_translation" not in tables:
            raise RuntimeError(f"unsupported WikDict ES-RU schema: {sorted(tables)}")
        for word, raw_ru in conn.execute(
            "SELECT written_rep, trans_list FROM simple_translation WHERE written_rep IS NOT NULL AND trans_list IS NOT NULL"
        ):
            key = norm(word)
            if not key:
                continue
            parts, seen = [], set()
            for raw in (raw_ru or "").split("|"):
                item = clean_ru(raw)
                low = item.lower()
                if item and low not in seen:
                    seen.add(low)
                    parts.append(item)
            if not parts:
                continue
            data.setdefault(key, parts[0])
            if key in ranked and len(parts) > 1:
                senses[key] = parts[:12]
    finally:
        conn.close()

    if len(data) < 8_000:
        raise RuntimeError(f"WikDict ES-RU export unexpectedly small: {len(data)}")
    (output_dir / "es_ru_core.json").write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":"), sort_keys=True), encoding="utf-8"
    )
    (output_dir / "es_ru_senses.json").write_text(
        json.dumps(senses, ensure_ascii=False, separators=(",", ":"), sort_keys=True), encoding="utf-8"
    )
    return len(data), len(senses)


NOTICE = """Reader AI Spanish lexical resources

wordhoard v0.1.0
  https://github.com/natema/wordhoard
  Dataset license: CC BY-SA 4.0
  Frequency backbone: OpenSubtitles-2018 via hermitdave/FrequencyWords (MIT)
  Lemma/POS: spaCy (MIT)
  Inflection/gender correction: Wiktionary via kaikki.org (CC BY-SA 4.0)

WikDict / DBnary Spanish-Russian dictionary, 2026-06 export
  https://www.wikdict.com/
  https://download.wikdict.com/
  License: Creative Commons Attribution-ShareAlike
  Wiktionary data processed via DBnary.
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--output-dir", required=True)
    ap.add_argument("--cache-dir", required=True)
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        fake = [
            {"lemma":"ser","pos":"AUX","rank":2,"count":100,"cefr":"A1","gender":"","forms":"soy:pres.1sg;eres:pres.2sg;ser:surface"},
            {"lemma":"estar","pos":"AUX","rank":5,"count":90,"cefr":"A1","gender":"","forms":"estoy:pres.1sg;estar:surface"},
            {"lemma":"tener","pos":"VERB","rank":9,"count":80,"cefr":"A1","gender":"","forms":"tengo:pres.1sg;tener:surface"},
            {"lemma":"hablar","pos":"VERB","rank":20,"count":70,"cefr":"A1","gender":"","forms":"habla:pres.3sg;hablando:ger;hablar:surface"},
            {"lemma":"habla","pos":"NOUN","rank":2000,"count":4,"cefr":"B2","gender":"f","forms":"habla:surface"},
        ]
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            ranked, lemma_map, meta = build_lexical_assets(fake, Path(td))
            assert ranked[0]["lemma"] == "ser"
            assert lemma_map["soy"] == "ser"
            assert lemma_map["estoy"] == "estar"
            assert lemma_map["tengo"] == "tener"
            assert lemma_map["habla"] == "habla"  # genuine collision stays contextual
            assert meta["ranked_lemmas"] == 5
        print("Spanish Reader resource self-test PASS")
        return

    output_dir = Path(args.output_dir)
    cache_dir = Path(args.cache_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    cache_dir.mkdir(parents=True, exist_ok=True)

    wordhoard_zip = download(
        WORDHOARD_URL, cache_dir / "wordhoard-csv-v0.1.0.zip", sha256=WORDHOARD_SHA256, min_size=7_000_000,
    )
    wikdict_db = download(WIKDICT_URL, cache_dir / "es-ru-2_2026-06.sqlite3", min_size=1_000_000)
    rows = read_wordhoard(wordhoard_zip)
    ranked, lemma_map, _ = build_lexical_assets(rows, output_dir)
    dict_count, sense_count = build_wikdict_json(wikdict_db, output_dir, ranked)
    (output_dir / "NOTICE.txt").write_text(NOTICE, encoding="utf-8")
    print(
        "Spanish Reader resources:", f"{len(ranked)} ranked lemmas,", f"{len(lemma_map)} surface mappings,",
        f"{dict_count} ES-RU entries,", f"{sense_count} ambiguous dictionary heads",
    )


if __name__ == "__main__":
    main()
