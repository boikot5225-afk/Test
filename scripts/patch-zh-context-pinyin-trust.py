#!/usr/bin/env python3
from pathlib import Path

path = Path('js/reader/zh-context-batch.js')
text = path.read_text(encoding='utf-8')
old_import = "import { classifyChineseGloss } from './zh-lexical-trust.js?v=1';\n"
new_import = "import { classifyChineseGloss, chinesePinyinNeedsContext } from './zh-lexical-trust.js?v=2';\n"
if text.count(old_import) != 1:
    raise SystemExit(f'pinyin trust import: expected 1 match, got {text.count(old_import)}')
text = text.replace(old_import, new_import, 1)

old = '''function needsDeepSeek(item) {
  return classifyChineseGloss({
    wrap: item?.wrap || null,
    entry: lexicalEntryForOccurrence(item),
  }).needsContext;
}
'''
new = '''function needsDeepSeek(item) {
  const surface = clean(item?.surface || item?.word?.dataset?.word || '', 32);
  // Russian meaning and pronunciation are separate confidence axes. Even a
  // trusted local RU gloss must not freeze the first dictionary reading of a
  // one-Hanzi polyphonic candidate; the already-batched context call resolves it.
  if (chinesePinyinNeedsContext(surface)) return true;
  return classifyChineseGloss({
    wrap: item?.wrap || null,
    entry: lexicalEntryForOccurrence(item),
  }).needsContext;
}
'''
if text.count(old) != 1:
    raise SystemExit(f'pinyin trust target: expected 1 match, got {text.count(old)}')
text = text.replace(old, new, 1)
path.write_text(text, encoding='utf-8')
print('Chinese contextual pinyin trust applied')
