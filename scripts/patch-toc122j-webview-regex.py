#!/usr/bin/env python3
from pathlib import Path

# Chromium/WebView correctly rejects identity-escaping a double quote inside a
# Unicode regexp character class. Node's syntax gate did not catch this exact
# engine difference, so fix the generated reader module explicitly and keep a
# source-level assertion against reintroducing it.
p = Path('js/reader/fr-lexical-pipeline-v2.js')
s = p.read_text(encoding='utf-8')
bad = r"/[.!?…][\s\"'»”)]*$/u"
good = r'''/[.!?…][\s"'»”)]*$/u'''
if s.count(bad) != 1:
    raise SystemExit(f'WebView regexp anchor count={s.count(bad)}')
s = s.replace(bad, good, 1)
if r'\s\"' in s:
    raise SystemExit('WebView-unsafe unicode regexp escape remains')
p.write_text(s, encoding='utf-8')
print('toc122j WebView unicode regexp compatibility applied')
