#!/usr/bin/env python3
from pathlib import Path

p = Path('index.html')
s = p.read_text(encoding='utf-8')
old = '<span id="build-label">v77.31-footnotes-formatting-translation-test</span>'
new = '<span id="build-label"></span><script>document.getElementById("build-label").textContent=window.AN2_BUILD||"unknown";<\/script>'
if s.count(old) != 1:
    raise SystemExit(f'toc122o build-label anchor count={s.count(old)}')
s = s.replace(old, new, 1)
p.write_text(s, encoding='utf-8')
print('toc122o visible build label now follows AN2_BUILD')
