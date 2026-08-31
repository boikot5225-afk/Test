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
    // A ranked surface is a real lexical headword, not just an unknown spelling.
    // Productive morphology may take ownership only for genuinely rare surface
    // heads. This keeps ordinary lexicalised -ant words (courant, pendant,
    // important...) stable while still allowing a rare participial collision
    // such as fumant -> fumer when the verb has overwhelming corpus support.
    if (!word.endsWith('ant')) return '';
    const COMMON_LEXICALISED_HEAD_MAX_INDEX = 3000;
    if (surfaceHit.index <= COMMON_LEXICALISED_HEAD_MAX_INDEX) return '';
    const LEXICAL_HEAD_AMBIGUITY_GUARD_MAX_INDEX = 12000;
    if (surfaceHit.index <= LEXICAL_HEAD_AMBIGUITY_GUARD_MAX_INDEX) return '';

    const ratioThreshold = Math.floor(surfaceHit.index * 0.28);
    const absoluteGap = surfaceHit.index - best.index;
    if (best.index >= ratioThreshold || absoluteGap < 2200) return '';
  }
  return best.lemma || '';
"""
if s.count(old) != 1:
    raise SystemExit(f'toc122m productive morphology anchor count={s.count(old)}')
s = s.replace(old, new, 1)

# Do not call every override a context cache entry: productive morphology and
# exact/context analysis are different owners. Accurate provenance makes a live
# failure actionable instead of pointing debugging at the wrong subsystem.
old_source = "    _source: override ? 'fr-context-cache' : 'fr-open-lexical',"
new_source = "    _source: override ? (override.source || 'fr-analysis-cache') : 'fr-open-lexical',"
if s.count(old_source) != 1:
    raise SystemExit(f'toc122m source-label anchor count={s.count(old_source)}')
s = s.replace(old_source, new_source, 1)

p.write_text(s, encoding='utf-8')
print('toc122m French lexicalized-head/productive-participle split applied')
