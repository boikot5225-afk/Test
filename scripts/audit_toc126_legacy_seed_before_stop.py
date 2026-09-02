#!/usr/bin/env python3
import json

from reader_cdp import ReaderCDP

cdp = ReaderCDP(connect_timeout=45)
cdp.connect()
cdp.wait("document.readyState==='complete'", 45)

result = cdp.eval(r"""(()=>{
  const key = window.an2ReaderStorageKey?.('an2_reader_books_v1') || 'an2_reader_books_v1::guest';
  const raw = localStorage.getItem(key) || '';
  let rows = [];
  try { rows = JSON.parse(raw) || []; } catch (_) {}
  const legacy = Array.isArray(rows)
    ? rows.find(book => String(book?.id || '') === 'legacy_seed_toc126') || null
    : null;
  const full = !!(legacy && Array.isArray(legacy.chapters) && legacy.chapters.length > 0);
  const paragraphChars = full
    ? legacy.chapters.reduce((sum, ch) => sum + (ch?.paragraphs || []).reduce((n, p) => n + String(p || '').length, 0), 0)
    : 0;
  return {
    key,
    bytes: new Blob([raw]).size,
    count: Array.isArray(rows) ? rows.length : -1,
    legacyExists: !!legacy,
    legacyFull: full,
    paragraphChars,
    guest: localStorage.getItem('an2_guest'),
  };
})()""", 30)

if not result:
    raise RuntimeError('legacy pre-stop verification returned no result')
if result.get('guest') != '1':
    raise RuntimeError('guest mode disappeared before force-stop: ' + repr(result))
if not result.get('legacyExists') or not result.get('legacyFull'):
    raise RuntimeError('legacy book disappeared before force-stop: ' + repr(result))
if result.get('bytes', 0) < 1_500_000 or result.get('paragraphChars', 0) < 1_500_000:
    raise RuntimeError('legacy full payload shrank before force-stop: ' + repr(result))

print(json.dumps(result, ensure_ascii=False, indent=2))
cdp.close()
