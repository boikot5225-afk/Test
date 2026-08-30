#!/usr/bin/env python3
from pathlib import Path

p = Path('js/reader/interactions-runtime.js')
s = p.read_text(encoding='utf-8')

pairs = [
    (
        "import './zh-readable-inline.js?v=7-context-card';\n",
        "import './zh-readable-inline.js?v=6';\n",
        'zh-readable-inline',
    ),
    (
        "import './zh-direct-ru-fallback.js?v=2-context-priority'; // context card/batch outrank raw ML Kit\n",
        "import './zh-direct-ru-fallback.js?v=1'; // toc100: direct on-device Chinese -> Russian for every visible Unknown\n",
        'zh-direct-ru-fallback',
    ),
]

for old, new, label in pairs:
    count = s.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected toc112 anchor exactly once, got {count}')
    s = s.replace(old, new, 1)

p.write_text(s, encoding='utf-8')
print('toc112 runtime cache-bust anchors normalized for lexical-v2 patcher')
