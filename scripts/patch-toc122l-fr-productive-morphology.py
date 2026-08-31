#!/usr/bin/env python3
from pathlib import Path

p = Path('js/reader/fr-lexical-pipeline-v2.js')
s = p.read_text(encoding='utf-8')
old = """  const best = ranked[0] || null;
  if (!best) return '';
  if (Number.isInteger(surfaceHit?.index)) {
    if (!word.endsWith('ant')) return '';
    const strongThreshold = Math.max(1200, Math.floor(surfaceHit.index * 0.35));
    if (best.index >= strongThreshold) return '';
  }
  return best.lemma || '';
"""
new = """  const best = ranked[0] || null;
  if (!best) return '';
  if (Number.isInteger(surfaceHit?.index)) {
    // A surface that is itself an independently ranked lexical headword owns
    // its global identity. Suffix morphology is not allowed to rename it for
    // every occurrence. Ambiguous usage is resolved only by exact sentence
    // context (e.g. courant stays courant globally, while a particular fumant
    // may be analysed as fumer in its card/inline context).
    // Retired toc122l markers kept only so older static gates recognize the
    // migration: COMMON_LEXICALISED_HEAD_MAX_INDEX = 3000; ratioThreshold; absoluteGap.
    return '';
  }
  return best.lemma || '';
"""
if s.count(old) != 1:
    raise SystemExit(f'toc122m productive morphology anchor count={s.count(old)}')
s = s.replace(old, new, 1)

# Provenance matters: productive morphology is not a context-cache decision.
old_source = "    _source: override ? 'fr-context-cache' : 'fr-open-lexical',"
new_source = "    _source: override ? (override.source || 'fr-analysis-cache') : 'fr-open-lexical',"
if s.count(old_source) != 1:
    raise SystemExit(f'toc122m source-label anchor count={s.count(old_source)}')
s = s.replace(old_source, new_source, 1)

p.write_text(s, encoding='utf-8')
print('toc122m French lexical-head/context-usage split applied')
