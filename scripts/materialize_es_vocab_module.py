#!/usr/bin/env python3
"""Materialize the Spanish vocab UI from the already regression-tested French owner.

The French module is intentionally a compact single-file implementation of the
84-word assessment, manual Known/Unknown persistence and frequency-based
classification.  Keeping one mechanical derivative avoids creating a second,
slowly diverging copy of that UI.  Spanish lexical data is supplied separately
by build_es_reader_resources.py.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "js/reader/fr-vocab-estimate.js"


def materialize(output: Path) -> None:
    source = SOURCE.read_text(encoding="utf-8")

    # French's fixed resource sentinels are dataset-specific.  Spanish resource
    # integrity is checked by the builder and APK gate instead.
    french_probe = "for(const[index,expected]of[[0,'le'],[1,'être'],[2,'de'],[3,'un'],[4,'je']])if(normalizeSurface(data.entries[index]?.word)!==expected)throw new Error(`French frequency mismatch #${index+1}: ${data.entries[index]?.word||'∅'} != ${expected}`);for(const[surface,expected]of Object.entries({est:'être',suis:'être',étaient:'être',ai:'avoir',avait:'avoir'}))if(data.lemma.get(surface)!==expected)throw new Error(`French morphology mismatch: ${surface} -> ${data.lemma.get(surface)||'∅'} != ${expected}`);"
    if french_probe not in source:
        raise SystemExit("French vocab probe anchor changed; refusing a blind Spanish materialization")
    source = source.replace(french_probe, "")

    replacements = [
        ("an2_reader_vocab_estimate_fr_v1", "an2_reader_vocab_estimate_es_v1"),
        ("../../../frreader/fr_vocab_frequency.tsv?v=1", "../../../esreader/es_vocab_frequency.tsv?v=1"),
        ("../../../frreader/fr_vocab_lemma.tsv?v=1", "../../../esreader/es_vocab_lemma.tsv?v=1"),
        ("toLocaleLowerCase('fr-FR')", "toLocaleLowerCase('es-ES')"),
        ("readerFrench", "readerSpanish"),
        ("reader-fr-", "reader-es-"),
        ("rw-fr-", "rw-es-"),
        ("reader:fr-", "reader:es-"),
        ("[reader fr vocab]", "[reader es vocab]"),
        ("French", "Spanish"),
        ("french", "spanish"),
        ("FRENCH", "SPANISH"),
        ("`fr:${", "`es:${"),
        ("'fr'", "'es'"),
        ("'fr-", "'es-"),
    ]
    for old, new in replacements:
        source = source.replace(old, new)

    required = (
        "an2_reader_vocab_estimate_es_v1",
        "esreader/es_vocab_frequency.tsv",
        "esreader/es_vocab_lemma.tsv",
        "readerSpanishLemmaFor",
        "reader:es-vocab-ready",
        "currentLang()!=='es'",
        "lang:'es'",
    )
    for token in required:
        if token not in source:
            raise SystemExit(f"Spanish vocab materialization missing required token: {token}")
    forbidden = (
        "frreader/fr_vocab_",
        "readerFrench",
        "reader-fr-",
        "rw-fr-",
        "currentLang()!=='fr'",
    )
    for token in forbidden:
        if token in source:
            raise SystemExit(f"Spanish vocab materialization leaked French owner token: {token}")

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(source, encoding="utf-8")


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("output")
    args = ap.parse_args()
    materialize(Path(args.output))
    print(f"Spanish vocab module materialized: {args.output}")
