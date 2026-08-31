#!/usr/bin/env python3
from pathlib import Path

p = Path('js/reader/fr-lexical-pipeline-v2.js')
s = p.read_text(encoding='utf-8')
old = """  if (Number.isInteger(surfaceHit?.index)) {
    // A ranked surface is a real lexical headword, not just an unknown spelling.
    // Never erase a common lexicalised -ant word (courant, pendant, etc.) merely
    // because the same letters can also be a present participle of a frequent
    // verb. Without sentence context the safe owner is the surface headword.
    if (!word.endsWith('ant')) return '';
    const COMMON_LEXICALISED_HEAD_MAX_INDEX = 3000;
    if (surfaceHit.index <= COMMON_LEXICALISED_HEAD_MAX_INDEX) return '';

    // For rarer -ant heads, accept a verb owner only when the corpus evidence is
    // overwhelming. This keeps genuinely participial collisions such as fumant
    // -> fumer while refusing weak suffix guesses. Exact contextual senses stay
    // in the context cache and never redefine this global lexical identity.
    const ratioThreshold = Math.floor(surfaceHit.index * 0.28);
    const absoluteGap = surfaceHit.index - best.index;
    if (best.index >= ratioThreshold || absoluteGap < 2200) return '';
  }
  return best.lemma || '';
"""
new = """  if (Number.isInteger(surfaceHit?.index)) {
    // Global lexical identity must never be inferred away from an independently
    // ranked headword by a suffix heuristic.  Forms such as courant/fumant can
    // be either lexical heads or verbal participles; only an exact occurrence
    // context may resolve that usage.  The context/card layer is allowed to say
    // fumer for a particular «fumant», but the surface-wide owner stays fumant.
    return '';
  }
  return best.lemma || '';
"""
if s.count(old) != 1:
    raise SystemExit(f'toc122m lexical-owner anchor count={s.count(old)}')
s = s.replace(old, new, 1)

old_source = """    _source: override ? 'fr-context-cache' : 'fr-open-lexical',
"""
new_source = """    _source: override?.source === 'productive-morphology'
      ? 'fr-productive-morphology'
      : (override ? 'fr-context-cache' : 'fr-open-lexical'),
"""
if s.count(old_source) != 1:
    raise SystemExit(f'toc122m source-label anchor count={s.count(old_source)}')
s = s.replace(old_source, new_source, 1)

if 'Global lexical identity must never be inferred away' not in s:
    raise SystemExit('toc122m lexical ownership guard missing')
p.write_text(s, encoding='utf-8')
print('toc122m French lexical headword ownership applied')
