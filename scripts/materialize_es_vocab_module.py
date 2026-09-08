#!/usr/bin/env python3
"""Materialize the Spanish vocab UI from the already regression-tested French owner.

The French module is intentionally a compact single-file implementation of the
84-word assessment, manual Known/Unknown persistence and frequency-based
classification. Keeping one mechanical derivative avoids creating a second,
slowly diverging copy of that UI. Spanish lexical data is supplied separately
by build_es_reader_resources.py.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "js/reader/fr-vocab-estimate.js"


def materialize(output: Path) -> None:
    source = SOURCE.read_text(encoding="utf-8")

    # French's fixed resource sentinels are dataset-specific. Spanish resource
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

    # The French and Spanish vocab owners live in the same document and share
    # the same lazy word-panel DOM. These two sentinels are *owner identity*, not
    # language strings, so the generic replacements above do not touch them.
    # If they remain French, the French module can claim the hook before the
    # first Spanish word tap and Spanish then skips decorating the panel entirely.
    panel_hook_anchor = "readerFrVocabPanelHook"
    panel_marker_check = "panel.dataset.migakuKnowledge!=='fr1'"
    panel_marker_set = "panel.dataset.migakuKnowledge='fr1'"
    for anchor in (panel_hook_anchor, panel_marker_check, panel_marker_set):
        if anchor not in source:
            raise SystemExit(f"Spanish panel identity anchor changed: {anchor}")
    source = source.replace(panel_hook_anchor, "readerEsVocabPanelHook")
    source = source.replace(panel_marker_check, "panel.dataset.migakuKnowledge!=='es1'")
    source = source.replace(panel_marker_set, "panel.dataset.migakuKnowledge='es1'")

    # Context-batch owns occurrence-specific proper-noun decisions. The
    # generic vocabulary owner otherwise reclassifies every rendered word on a
    # later async refresh and would turn sentence-initial names such as Madrid
    # back into Unknown. Preserve only the exact DOM occurrence marked by the
    # context layer; do not promote every capitalized surface globally.
    classification_anchor = "function applyClassificationToElement(el,info){removeKnowledgeClasses(el);const base="
    proper_base_cleanup = "['rw-new','rw-looked','rw-learning','rw-problem','rw-hard','rw-familiar','rw-seen','rw-faded'].forEach(cls=>el.classList.remove(cls));"
    classification_patch = (
        "function applyClassificationToElement(el,info){removeKnowledgeClasses(el);"
        "if(el?.dataset?.esContextProper==='1'){"
        + proper_base_cleanup +
        "el.classList.add('rw-es-proper');el.removeAttribute('title');return;}const base="
    )
    if classification_anchor not in source:
        raise SystemExit("Spanish classification anchor changed; refusing to lose contextual proper verdicts")
    source = source.replace(classification_anchor, classification_patch, 1)

    required = (
        "an2_reader_vocab_estimate_es_v1",
        "esreader/es_vocab_frequency.tsv",
        "esreader/es_vocab_lemma.tsv",
        "readerSpanishLemmaFor",
        "reader:es-vocab-ready",
        "currentLang()!=='es'",
        "lang:'es'",
        "esContextProper==='1'",
        "rw-es-proper",
        "readerEsVocabPanelHook",
        "panel.dataset.migakuKnowledge!=='es1'",
        "panel.dataset.migakuKnowledge='es1'",
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
        "readerFrVocabPanelHook",
        "panel.dataset.migakuKnowledge!=='fr1'",
        "panel.dataset.migakuKnowledge='fr1'",
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
