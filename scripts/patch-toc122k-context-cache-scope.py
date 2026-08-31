#!/usr/bin/env python3
from pathlib import Path

p = Path('js/reader/fr-lexical-pipeline-v2.js')
s = p.read_text(encoding='utf-8')
old = """  deepSeekOverrides.set(surface, item);
  // If the AI corrected an inflected surface, make that correction immediately
  // visible to every French layer in this session.
  if (surface !== lemma) deepSeekOverrides.set(`${surface}::lemma`, item);
  if (item.isProper) properLemmas.add(lemma);
"""
new = """  // Exact-context AI answers belong to that occurrence, not to the global
  // lexical owner for the spelling.  Promoting them globally corrupts genuine
  // homographs (au courant once caused every standalone courant to become
  // courir).  The context-gloss owner consumes the same event/context itself;
  // global overrides are reserved for context-free lexical corrections.
  const exactContext = !!item.context;
  if (!exactContext) {
    deepSeekOverrides.set(surface, item);
    if (surface !== lemma) deepSeekOverrides.set(`${surface}::lemma`, item);
  }
  // Proper-name status is context-independent once positively identified and is
  // safe to share across occurrences; the local chapter heuristic remains the
  // primary path for names that never need AI.
  if (item.isProper) properLemmas.add(lemma);
"""
if s.count(old) != 1:
    raise SystemExit(f'context-scope anchor count={s.count(old)}')
s = s.replace(old, new, 1)

# Guard the architectural invariant in source so later edits cannot silently
# reintroduce a surface-wide write for exact-context analysis.
if 'const exactContext = !!item.context;' not in s:
    raise SystemExit('exact-context scoping guard missing')
p.write_text(s, encoding='utf-8')
print('toc122k French exact-context cache scoping applied')
