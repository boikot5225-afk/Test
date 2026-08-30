#!/usr/bin/env python3
from pathlib import Path
import re


def must_replace(path, old, new, label):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match in {path}, got {count}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


def must_sub(path, pattern, replacement, label, flags=0):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    new, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 regex match in {path}, got {count}')
    p.write_text(new, encoding='utf-8')


# ---------------------------------------------------------------------------
# 1) Segmentation: local weighted first paint is authoritative.
#    Remote may win only when it is clearly better AND contains no suspicious
#    unknown 4+ Hanzi blobs. Never rerender a live page just because a remote
#    segmentation arrived; that was the source of visible text jumps.
# ---------------------------------------------------------------------------
must_replace(
    'js/reader-app.js',
    "const READER_ZH_SEGMENT_CACHE_KEY = 'an2_zh_segment_cache_v7_weighted';",
    "const READER_ZH_SEGMENT_CACHE_KEY = 'an2_zh_segment_cache_v8_quality';",
    'invalidate pre-quality Chinese segmentation cache',
)

must_sub(
    'js/reader-app.js',
    r"function readerChooseBestChineseSegmentation\(text, remoteWords, localWords\) \{.*?\n\}",
    r'''function readerChooseBestChineseSegmentation(text, remoteWords, localWords) {
  const remote = (Array.isArray(remoteWords) ? remoteWords : []).filter(x => x !== '');
  const local = (Array.isArray(localWords) ? localWords : []).filter(x => x !== '');
  if (!remote.length) return local;
  if (!local.length) return remote;

  // Local weighted segmentation owns first paint. A remote candidate is useful
  // only if every long Han token is backed by the actual bundled dictionary.
  // This rejects blobs such as 洪秀全曾实行 while still allowing real four-char
  // words / names that CC-CEDICT knows.
  const dynamicDict = readerBuildChineseWordSet();
  const remoteUnsafe = remote.some(raw => {
    const token = String(raw || '');
    const len = readerHanLength(token);
    return readerIsHanToken(token)
      && len >= 4
      && !readerChineseWordExistsDirect(token, dynamicDict);
  });
  if (remoteUnsafe) return local;

  const rs = readerChineseSegScore(remote);
  const ls = readerChineseSegScore(local);
  // Old chooser defaulted to remote on near-ties. That is backwards for a
  // reading UI: stable deterministic local boundaries win unless remote is
  // materially better, not merely different.
  return rs > ls + 2.5 ? remote : local;
}''',
    'make local Chinese segmentation authoritative',
    flags=re.S,
)

must_sub(
    'js/reader-app.js',
    r'''        try \{
          window\.dispatchEvent\(new CustomEvent\('reader:zh-segmentation-ready', \{ detail: \{ key \} \}\)\);
          const readingView = document\.getElementById\('reader-reading-view'\);
          if \(readerCurrentLang\(\) === 'zh' && readingView && readingView\.style\.display !== 'none'\) \{
            renderReaderChapterInPlace\(\);
          \}
        \} catch \{\}''',
    r'''        try {
          // Cache enrichment only. Repainting a live Chinese paragraph changes
          // token widths, pinyin slots and pagination under the reader's eyes.
          window.dispatchEvent(new CustomEvent('reader:zh-segmentation-ready', { detail: { key } }));
        } catch {}''',
    'stop late remote segmentation from jumping live text',
    flags=re.S,
)


# ---------------------------------------------------------------------------
# 2) Inline Russian: isolated ML Kit / EN-pivot output must never paint as if it
#    were a trustworthy answer. Context AI or trusted direct RU owns the lane.
# ---------------------------------------------------------------------------
must_sub(
    'js/reader/zh-readable-inline.js',
    r"function localRussian\(wrap, word\) \{.*?\n\}",
    r'''function localRussian(wrap, word) {
  const source = clean(wrap?.dataset?.zhGlossSource || '').toLowerCase().replace(/_/g, '-');
  const provisional = !source
    ? false
    : source === 'en'
      || source.includes('mlkit')
      || source.includes('machine')
      || source.includes('wikdict')
      || source.includes('offline-en');

  if (!provisional) {
    const raw = wrap?.dataset?.zhGlossStickyRu
      || wrap?.dataset?.zhGlossRuReadable
      || wrap?.dataset?.zhGlossRu
      || '';
    const direct = compactRussian(raw);
    if (direct) return direct;
  }

  const surface = clean(word?.dataset?.word || '');
  if (!surface) return '';
  try {
    const entry = globalThis.readerLookupChineseWord?.(surface) || null;
    const entrySource = clean(entry?._source || '').toLowerCase().replace(/_/g, '-');
    if (entrySource.includes('mlkit')
        || entrySource.includes('machine')
        || entrySource.includes('wikdict-en')
        || entrySource.includes('offline-en')) return '';
    return compactRussian(entry?.ru || entry?.russian || entry?.translation_ru || entry?.translation || '');
  } catch {
    return '';
  }
}''',
    'ignore provisional Russian in inline lane',
    flags=re.S,
)

must_replace(
    'js/reader/zh-readable-inline.js',
    "  const pinyin = clean(pinyinValue);\n",
    "  const pinyin = clean(pinyinValue).toLocaleLowerCase('en-US');\n",
    'normalise displayed pinyin casing',
)

must_replace(
    'js/reader/zh-readable-inline.js',
    "const STYLE_ID = 'reader-zh-readable-inline-v6';",
    "const STYLE_ID = 'reader-zh-readable-inline-v8-quality';",
    'bump Chinese readable style id',
)
must_replace(
    'js/reader/zh-readable-inline.js',
    "  'reader-zh-readable-inline-v5',\n",
    "  'reader-zh-readable-inline-v5',\n  'reader-zh-readable-inline-v6',\n",
    'retire old v6 Chinese readable style',
)
must_replace(
    'js/reader/zh-readable-inline.js',
    "      line-height: 2.22 !important;\n",
    "      line-height: 2.08 !important;\n",
    'tighten Chinese interlinear line rhythm',
)

# Remove the direct isolated ZH->RU painter from the inline reading pipeline.
# It remains in the repository for word-panel/offline experiments; it no longer
# gets to flash wrong first senses under book text.
must_sub(
    'js/reader/interactions-runtime.js',
    r"^import './zh-direct-ru-fallback\.js\?v=[^']+';[^\n]*\n",
    "",
    'disable direct ML Kit Russian painter in reader text',
    flags=re.M,
)


# ---------------------------------------------------------------------------
# 3) Context batch: retry auth readiness and invalidate stale answers.
#    toc113 already aligned compactRu to the 1-3 word server contract; do not
#    patch that line twice here.
# ---------------------------------------------------------------------------
must_replace(
    'js/reader/zh-context-batch.js',
    "const CACHE_BASE_KEY = 'an2_reader_zh_context_gloss_v3';",
    "const CACHE_BASE_KEY = 'an2_reader_zh_context_gloss_v4_quality';",
    'invalidate old contextual Chinese gloss cache',
)
must_replace(
    'js/reader/zh-context-batch.js',
    "  if (!firebaseUserReady()) return;\n",
    "  if (!firebaseUserReady()) { schedule(350); return; }\n",
    'retry contextual batch while Firebase auth settles',
)

# Context request is now the only automatic owner of machine Russian in the
# reading line. Mark pending targets immediately so stale/provisional meanings
# cannot remain visible while a batch is in flight.
must_replace(
    'js/reader/zh-context-batch.js',
    "    item.wrap.dataset.zhContextPending = '1';\n",
    "    item.wrap.dataset.zhContextPending = '1';\n    if (String(item.wrap.dataset.zhGlossSource || '').includes('mlkit')) {\n      const meaning = item.wrap.querySelector(':scope > .rw-zh-readable-ru .rw-zh-readable-meaning');\n      if (meaning) meaning.hidden = true;\n    }\n",
    'hide provisional machine Russian while context is pending',
)


# ---------------------------------------------------------------------------
# 4) Cache bust only the runtime modules whose semantics changed.
# ---------------------------------------------------------------------------
must_sub(
    'js/reader/interactions-runtime.js',
    r"import './zh-readable-inline\.js\?v=[^']+';",
    "import './zh-readable-inline.js?v=8-quality';",
    'bust readable inline quality module',
)
must_sub(
    'js/reader/interactions-runtime.js',
    r"import './zh-context-batch\.js\?v=[^']+';[^\n]*",
    "import './zh-context-batch.js?v=8-quality'; // toc119: context owns Russian; auth retry; fresh cache",
    'bust context batch quality module',
)
must_sub(
    'js/app.js',
    r"\} from './reader-app\.js\?v=[^']+';",
    "} from './reader-app.js?v=77.42-zh-reader-quality';",
    'bust reader app quality build',
)
must_sub(
    'index.html',
    r"window\.AN2_BUILD = 'v77\.42-toc\d+[^']*';",
    "window.AN2_BUILD = 'v77.42-toc119-zh-reader-quality';",
    'bump toc119 build marker',
)
must_sub(
    'index.html',
    r'<script type="module" src="js/app\.js\?v=[^"]+"></script>',
    '<script type="module" src="js/app.js?v=77.42-zh-reader-quality"></script>',
    'bust toc119 app entry',
)

print('toc119 Chinese reader quality patch applied')
