#!/usr/bin/env python3
from pathlib import Path

p=Path('android/app/build.gradle')
s=p.read_text(encoding='utf-8')
anchor='        targetSdk 35\n'
block="        ndk {\n            abiFilters 'arm64-v8a'\n        }\n"
if block not in s:
    if s.count(anchor)!=1:
        raise SystemExit(f'targetSdk anchor count={s.count(anchor)}')
    s=s.replace(anchor,anchor+block,1)
p.write_text(s,encoding='utf-8')
print('A54 packaging ABI: arm64-v8a')
