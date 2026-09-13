#!/usr/bin/env python3
from pathlib import Path

path = Path('android/app/build.gradle')
text = path.read_text(encoding='utf-8')
old = "versionCode 1029\n        versionName '77.42-toc136-es-justified-gloss-layout'"
new = "versionCode 1030\n        versionName '77.42-toc137-es-knowledge-status'"
if old not in text:
    raise SystemExit('toc137 version anchor missing; refusing blind replacement')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
print('Patched Android version to vc1030 / 77.42-toc137-es-knowledge-status')
