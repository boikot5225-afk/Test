#!/usr/bin/env python3
"""Build compact French Reader assets from open datasets.

Primary lexical layer:
  wordhoard v0.1.0 (CC-BY-SA-4.0) — frequency-ranked French lemmas + forms.
Translations:
  WikDict/DBnary 2026-06 (CC-BY-SA) — French -> Russian.

The large source archives are build-time only. The APK receives compact TSV/JSON
files tailored to the Reader, not the full upstream databases.
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
WIKDICT_URL = "https://download.wikdict.com/dictionaries/sqlite/2_2026-06/fr-ru.sqlite3"
USER_AGENT = "Reader-AI-French-resource-builder/1.0"
WORD_RE = re.compile(r"^[a-zà-öø-ÿœæç'’-]+$", re.IGNORECASE)


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


def find_french_csv(archive: zipfile.ZipFile) -> str:
    candidates = [n for n in archive.namelist() if n.lower().endswith("/fr.csv") or n.lower() == "fr.csv"]
    if not candidates:
        candidates = [n for n in archive.namelist() if n.lower().endswith("fr.csv")]
    if len(candidates) != 1:
        raise RuntimeError(f"expected exactly one fr.csv in wordhoard archive, got {candidates}")
    return candidates[0]


def read_wordhoard(zip_path: Path):
    rows = []
    with zipfile.ZipFile(zip_path) as zf:
        name = find_french_csv(zf)
        with zf.open(name) as raw:
            text = io.TextIOWrapper(raw, encoding="utf-8", newline="")
            reader = csv.DictReader(text)
            required = {"lemma", "pos", "frequency_rank", "frequency_count", "cefr_estimate", "forms"}
            missing = required - set(reader.fieldnames or [])
            if missing:
                raise RuntimeError(f"wordhoard fr.csv missing columns: {sorted(missing)}")
            for row in reader:
                lemma = norm(row.get("lemma", ""))
                if not lemma or " " in lemma or not WORD_RE.match(lemma):
                    continue
                try:
                    rank = int(row.get("frequency_rank") or 0)
                except ValueError:
                    continue
                if rank <= 0:
                    continue
                rows.append({
                    "lemma": lemma,
                    "pos": (row.get("pos") or "").strip(),
                    "rank": rank,
                    "count": int(float(row.get("frequency_count") or 0)),
                    "cefr": (row.get("cefr_estimate") or "").strip(),
                    "gender": (row.get("gender") or "").strip(),
                    "forms": (row.get("forms") or "").strip(),
                })
    if len(rows) < 50_000:
        raise RuntimeError(f"wordhoard French rows unexpectedly small: {len(rows)}")
    return rows


def build_lexical_assets(rows, output_dir: Path):
    best_by_lemma = {}
    for row in rows:
        lemma = row["lemma"]
        old = best_by_lemma.get(lemma)
        if old is None or row["rank"] < old["rank"]:
            best_by_lemma[lemma] = row

    ranked = sorted(best_by_lemma.values(), key=lambda r: (r["rank"], r["lemma"]))
    frequency_path = output_dir / "fr_vocab_frequency.tsv"
    with frequency_path.open("w", encoding="utf-8", newline="\n") as fh:
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
    for surface, options in candidates.items():
        ordered = sorted(options.items(), key=lambda kv: (kv[1], kv[0]))
        if len(ordered) == 1:
            lemma_map[surface] = ordered[0][0]
            continue
        best_lemma, best_rank = ordered[0]
        second_rank = ordered[1][1]
        if best_rank <= 1000 and (second_rank >= best_rank * 4 or second_rank - best_rank >= 1500):
            lemma_map[surface] = best_lemma
        elif surface == best_lemma:
            lemma_map[surface] = surface
        else:
            ambiguous += 1

    lemma_path = output_dir / "fr_vocab_lemma.tsv"
    with lemma_path.open("w", encoding="utf-8", newline="\n") as fh:
        for surface in sorted(lemma_map):
            target = lemma_map[surface]
            if surface != target:
                fh.write(f"{surface}\t{target}\n")

    meta = {
        "source": "wordhoard",
        "source_version": "0.1.0",
        "language": "fr",
        "ranked_lemmas": len(ranked),
        "mapped_inflected_forms": sum(1 for s, l in lemma_map.items() if s != l),
        "ambiguous_forms_left_unmapped": ambiguous,
        "top20": [row["lemma"] for row in ranked[:20]],
    }
    (output_dir / "fr_vocab_manifest.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    probes = {"est": "être", "suis": "être", "étaient": "être", "ai": "avoir", "avait": "avoir"}
    missing = {s: t for s, t in probes.items() if lemma_map.get(s) != t}
    if missing:
        raise RuntimeError(f"French core morphology probes failed: {missing}")
    return ranked, lemma_map, meta


def build_wikdict_json(source_db: Path, output_dir: Path, ranked_lemmas):
    ranked = {row["lemma"] for row in ranked_lemmas}
    conn = sqlite3.connect(f"file:{source_db}?mode=ro", uri=True)
    data = {}
    senses = {}
    try:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "simple_translation" not in tables:
            raise RuntimeError(f"unsupported WikDict FR-RU schema: {sorted(tables)}")
        for word, raw_ru in conn.execute(
            "SELECT written_rep, trans_list FROM simple_translation "
            "WHERE written_rep IS NOT NULL AND trans_list IS NOT NULL"
        ):
            key = norm(word)
            if not key:
                continue
            parts = []
            seen = set()
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

    if len(data) < 20_000:
        raise RuntimeError(f"WikDict FR-RU export unexpectedly small: {len(data)}")
    (output_dir / "fr_ru_core.json").write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":"), sort_keys=True), encoding="utf-8"
    )
    (output_dir / "fr_ru_senses.json").write_text(
        json.dumps(senses, ensure_ascii=False, separators=(",", ":"), sort_keys=True), encoding="utf-8"
    )
    return len(data), len(senses)


NOTICE = """Reader AI French lexical resources

wordhoard v0.1.0
  https://github.com/natema/wordhoard
  Dataset license: CC BY-SA 4.0
  Frequency backbone: OpenSubtitles-2018 via hermitdave/FrequencyWords (MIT)
  Lemma/POS: spaCy (MIT)
  Inflection/gender correction: Wiktionary via kaikki.org (CC BY-SA 4.0)

WikDict / DBnary French-Russian dictionary, 2026-06 export
  https://www.wikdict.com/
  https://download.wikdict.com/
  License: Creative Commons Attribution-ShareAlike
  Wiktionary data processed via DBnary.

Generated compact files are derivative data and retain the applicable
attribution/share-alike requirements of their upstream datasets.
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--output-dir", required=True)
    ap.add_argument("--cache-dir", required=True)
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        fake = [
            {"lemma":"être","pos":"AUX","rank":2,"count":100,"cefr":"A1","gender":"","forms":"est:surface;suis:surface;être:surface;étaient:surface"},
            {"lemma":"avoir","pos":"VERB","rank":7,"count":80,"cefr":"A1","gender":"","forms":"ai:pres.1sg;avait:impf.3sg;avoir:surface"},
            {"lemma":"faire","pos":"VERB","rank":20,"count":50,"cefr":"A1","gender":"","forms":"fait:surface;faire:surface"},
        ]
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            ranked, lemma_map, meta = build_lexical_assets(fake, Path(td))
            assert ranked[0]["lemma"] == "être"
            assert lemma_map["suis"] == "être"
            assert lemma_map["avait"] == "avoir"
            assert meta["ranked_lemmas"] == 3
        print("French Reader resource self-test PASS")
        return

    output_dir = Path(args.output_dir)
    cache_dir = Path(args.cache_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    cache_dir.mkdir(parents=True, exist_ok=True)

    wordhoard_zip = download(
        WORDHOARD_URL, cache_dir / "wordhoard-csv-v0.1.0.zip", sha256=WORDHOARD_SHA256, min_size=7_000_000,
    )
    wikdict_db = download(WIKDICT_URL, cache_dir / "fr-ru-2_2026-06.sqlite3", min_size=8_000_000)
    rows = read_wordhoard(wordhoard_zip)
    ranked, lemma_map, meta = build_lexical_assets(rows, output_dir)
    dict_count, sense_count = build_wikdict_json(wikdict_db, output_dir, ranked)
    (output_dir / "NOTICE.txt").write_text(NOTICE, encoding="utf-8")
    print(
        "French Reader resources:", f"{len(ranked)} ranked lemmas,", f"{len(lemma_map)} surface mappings,",
        f"{dict_count} FR-RU entries,", f"{sense_count} ambiguous dictionary heads",
    )


if __name__ == "__main__":
    main()
