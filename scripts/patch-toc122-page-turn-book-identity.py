#!/usr/bin/env python3
from pathlib import Path

p = Path('js/reader/chapter-render-next.js')
s = p.read_text(encoding='utf-8')
old = """      chapterText.dataset.lang = activeReaderLang;
      chapterText.lang = activeReaderLang;
"""
new = """      chapterText.dataset.lang = activeReaderLang;
      chapterText.dataset.readerBookId = String(book.id || book.importKey || book.title || '');
      chapterText.lang = activeReaderLang;
"""
if s.count(old) != 1:
    raise SystemExit(f'book identity anchor: expected 1 match, got {s.count(old)}')
p.write_text(s.replace(old, new, 1), encoding='utf-8')
print('toc122 page-turn book identity applied')
