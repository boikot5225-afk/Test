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
if s.count(old) != 1:
    raise SystemExit(f'toc122l productive morphology anchor count={s.count(old)}')
p.write_text(s.replace(old, new, 1), encoding='utf-8')
print('toc122l French ambiguity-safe productive morphology applied')
