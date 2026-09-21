#!/usr/bin/env python3
"""Materialize the German vocab UI from the already regression-tested French owner.

The French module is a compact single-file implementation of the 84-word
assessment, manual Known/Unknown persistence and frequency-based
classification; Spanish is already a mechanical derivative of it. German gets
the same treatment instead of a third, slowly diverging copy of that UI.

One thing is German and cannot be a string replacement. The owner resolves a
word to its lemma from one map, and German needs two: the declension tables for
nouns and simplemma for everything else (see build_de_reader_resources.py). The
owner asks a hook before its own map — the French module uses it for lexical
corrections — so the German build points that hook at the case-aware resolver
in de-vocab-data-v1.js and leaves the rest of the module untouched.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "js/reader/fr-vocab-estimate.js"


def materialize(output: Path) -> None:
    source = SOURCE.read_text(encoding="utf-8")

    # French's fixed resource sentinels are dataset-specific. German resource
    # integrity is checked by the builder's own self-test and the APK gate.
    french_probe = "for(const[index,expected]of[[0,'le'],[1,'être'],[2,'de'],[3,'un'],[4,'je']])if(normalizeSurface(data.entries[index]?.word)!==expected)throw new Error(`French frequency mismatch #${index+1}: ${data.entries[index]?.word||'∅'} != ${expected}`);for(const[surface,expected]of Object.entries({est:'être',suis:'être',étaient:'être',ai:'avoir',avait:'avoir'}))if(data.lemma.get(surface)!==expected)throw new Error(`French morphology mismatch: ${surface} -> ${data.lemma.get(surface)||'∅'} != ${expected}`);"
    if french_probe not in source:
        raise SystemExit("French vocab probe anchor changed; refusing a blind German materialization")
    source = source.replace(french_probe, "")

    replacements = [
        ("an2_reader_vocab_estimate_fr_v1", "an2_reader_vocab_estimate_de_v1"),
        ("../../../frreader/fr_vocab_frequency.tsv?v=1", "../../../dereader/de_vocab_frequency.tsv?v=1"),
        ("../../../frreader/fr_vocab_lemma.tsv?v=1", "../../../dereader/de_vocab_lemma.tsv?v=1"),
        ("toLocaleLowerCase('fr-FR')", "toLocaleLowerCase('de-DE')"),
        ("readerFrench", "readerGerman"),
        ("reader-fr-", "reader-de-"),
        ("rw-fr-", "rw-de-"),
        ("reader:fr-", "reader:de-"),
        ("[reader fr vocab]", "[reader de vocab]"),
        ("French", "German"),
        ("french", "german"),
        ("FRENCH", "GERMAN"),
        ("`fr:${", "`de:${"),
        ("'fr'", "'de'"),
        ("'fr-", "'de-",),
    ]
    for old, new in replacements:
        source = source.replace(old, new)

    # Owner identity, not a language string: if these stay French, the French
    # module claims the shared word-panel hook first and German never decorates
    # the panel at all.
    panel_hook_anchor = "readerFrVocabPanelHook"
    panel_marker_check = "panel.dataset.migakuKnowledge!=='fr1'"
    panel_marker_set = "panel.dataset.migakuKnowledge='fr1'"
    for anchor in (panel_hook_anchor, panel_marker_check, panel_marker_set):
        if anchor not in source:
            raise SystemExit(f"German panel identity anchor changed: {anchor}")
    source = source.replace(panel_hook_anchor, "readerDeVocabPanelHook")
    source = source.replace(panel_marker_check, "panel.dataset.migakuKnowledge!=='de1'")
    source = source.replace(panel_marker_set, "panel.dataset.migakuKnowledge='de1'")

    # German nouns are capitalised, so the owner's elision tail — French l'/d'/
    # qu' — has nothing to do here, but the lemma hook has everything to do:
    # Stunden is a form of Stunde only in the declension tables, and the map
    # this module loads holds verbs and adjectives. Point the hook at the
    # resolver that knows both.
    hook_anchor = "globalThis.readerGermanLexicalOverrideLemmaFor?.(raw)"
    if hook_anchor not in source:
        raise SystemExit("German lemma hook anchor changed; refusing to ship a noun-blind vocabulary owner")

    required = (
        "an2_reader_vocab_estimate_de_v1",
        "dereader/de_vocab_frequency.tsv",
        "dereader/de_vocab_lemma.tsv",
        "readerGermanLemmaFor",
        "readerGermanLexicalOverrideLemmaFor",
        "reader:de-vocab-ready",
        "currentLang()!=='de'",
        "lang:'de'",
        "readerDeVocabPanelHook",
        "panel.dataset.migakuKnowledge!=='de1'",
        "panel.dataset.migakuKnowledge='de1'",
    )
    for token in required:
        if token not in source:
            raise SystemExit(f"German vocab materialization missing required token: {token}")
    forbidden = (
        "frreader/fr_vocab_",
        "readerFrench",
        "reader-fr-",
        "rw-fr-",
        "currentLang()!=='fr'",
        "readerFrVocabPanelHook",
        "panel.dataset.migakuKnowledge!=='fr1'",
        "panel.dataset.migakuKnowledge='fr1'",
    )
    for token in forbidden:
        if token in source:
            raise SystemExit(f"German vocab materialization leaked French owner token: {token}")

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(source, encoding="utf-8")


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("output")
    args = ap.parse_args()
    materialize(Path(args.output))
    print(f"German vocab module materialized: {args.output}")
