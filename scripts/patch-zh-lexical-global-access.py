#!/usr/bin/env python3
from pathlib import Path
import re

path = Path('js/reader-app.js')
text = path.read_text(encoding='utf-8')
if 'globalThis.readerLookupChineseWord = readerLookupChineseWord;' in text:
    print('Chinese lexical lookup already exposed')
    raise SystemExit(0)

pattern = r"(function readerLookupChineseWord\(word\) \{.*?\n\})\n(?=// readerTokenizeChineseParagraph calls this once per paragraph)"
replacement = r"\1\n// Runtime Chinese gloss modules are separate ES modules. Give them read-only\n// access to the same lexical authority instead of forcing each layer to invent\n// its own dictionary/cache lookup path.\nglobalThis.readerLookupChineseWord = readerLookupChineseWord;\n"
updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
if count != 1:
    raise SystemExit(f'expose readerLookupChineseWord: expected 1 match, got {count}')
path.write_text(updated, encoding='utf-8')
print('Chinese lexical lookup exposed to runtime modules')
