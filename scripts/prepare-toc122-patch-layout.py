#!/usr/bin/env python3
from pathlib import Path

p = Path('js/reader/fr-vocab-estimate.js')
s = p.read_text(encoding='utf-8')
# The source is intentionally minified to one function per no-newline boundary.
# toc122's structural regexes anchor to the next function; insert only the two
# harmless boundaries they need. Do not alter the findWordState -> manual map
# boundary because the patch explicitly matches it without a newline.
changes = {
    '}function classificationForSnapshot': '}\nfunction classificationForSnapshot',
    '}function applyClassificationBatch': '}\nfunction applyClassificationBatch',
}
for old, new in changes.items():
    if old not in s and new not in s:
        raise SystemExit(f'missing toc122 layout anchor: {old}')
    if old in s:
        s = s.replace(old, new, 1)
p.write_text(s, encoding='utf-8')
print('toc122 patch layout prepared')
