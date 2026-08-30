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
# 1. Bundle the exact top-100k Jieba rank list that the tested segmenter uses.
# ---------------------------------------------------------------------------
must_replace(
    'android/app/build.gradle',
    "    inputs.file(new File(repoRoot, 'scripts/build_zh_migaku_sqlite.py'))\n    outputs.file(layout.buildDirectory.file('generated/migakuZhAssets/data/zh_migaku.sqlite3'))\n",
    "    inputs.file(new File(repoRoot, 'scripts/build_zh_migaku_sqlite.py'))\n    inputs.file(new File(repoRoot, 'scripts/export_zh_jieba_rank_asset.py'))\n    outputs.file(layout.buildDirectory.file('generated/migakuZhAssets/data/zh_migaku.sqlite3'))\n    outputs.file(layout.buildDirectory.file('generated/migakuZhAssets/data/zh_jieba_top100k.txt'))\n",
    'declare segmentation rank asset',
)

must_replace(
    'android/app/build.gradle',
    "        exec {\n            commandLine 'python3',\n                    new File(repoRoot, 'scripts/build_zh_migaku_sqlite.py').absolutePath,\n                    '--output-dir', outputDir.absolutePath,\n                    '--cache-dir', cacheDir.absolutePath\n        }\n",
    "        exec {\n            commandLine 'python3',\n                    new File(repoRoot, 'scripts/build_zh_migaku_sqlite.py').absolutePath,\n                    '--output-dir', outputDir.absolutePath,\n                    '--cache-dir', cacheDir.absolutePath\n        }\n        exec {\n            commandLine 'python3',\n                    new File(repoRoot, 'scripts/export_zh_jieba_rank_asset.py').absolutePath,\n                    new File(outputDir, 'zh_migaku.sqlite3').absolutePath,\n                    new File(outputDir, 'zh_jieba_top100k.txt').absolutePath,\n                    '--limit', '100000'\n        }\n",
    'generate segmentation rank asset',
)

# ---------------------------------------------------------------------------
# 2. Replace greedy longest-match with the tested weighted DAG segmenter.
# ---------------------------------------------------------------------------
must_replace(
    'js/reader-app.js',
    "import { createReaderPagesMode } from './reader/pages-mode.js?v=3';\n",
    "import { createReaderPagesMode } from './reader/pages-mode.js?v=3';\nimport { ensureZhSegmentRanks, zhSegmentRanksReady, segmentChineseWeighted, scoreChineseSegmentation } from './reader/zh-segment-v2.js?v=1';\n",
    'import weighted Chinese segmenter',
)

must_replace(
    'js/reader-app.js',
    "const READER_ZH_SEGMENT_CACHE_KEY = 'an2_zh_segment_cache_v6_core_first';",
    "const READER_ZH_SEGMENT_CACHE_KEY = 'an2_zh_segment_cache_v7_weighted';",
    'invalidate greedy segmentation cache',
)

must_sub(
    'js/reader-app.js',
    r"function readerSegmentChineseLocal\(text\) \{.*?\n\}\n\nfunction readerChineseSegScore\(words\) \{.*?\n\}",
    r'''function readerSegmentChineseLocal(text) {
  const source = String(text || '');
  const dynamicDict = readerBuildChineseWordSet();
  if (!zhSegmentRanksReady()) {
    // readerOpenBook waits for this bundled asset before first Chinese paint.
    // This is only a repair path for unusual render entry points.
    ensureZhSegmentRanks()
      .then(() => renderReaderChapterInPlace())
      .catch(error => console.warn('[reader zh] rank asset fallback:', error?.message || error));
  }
  return segmentChineseWeighted(source, {
    hasWord: word => readerChineseWordExistsDirect(word, dynamicDict),
  });
}

function readerChineseSegScore(words) {
  const dynamicDict = readerBuildChineseWordSet();
  // Existing chooser expects a larger score to mean "better". The v2 lattice
  // exposes a cost, so negate it here. Unknown multi-Hanzi remote tokens still
  // remain possible, which lets a better segmenter/NER beat local character soup.
  return -scoreChineseSegmentation(Array.isArray(words) ? words : [], {
    hasWord: word => readerChineseWordExistsDirect(word, dynamicDict),
  });
}''',
    'replace greedy segmentation and scoring',
    flags=re.S,
)

# toc114 inserted a core-first wait. Extend it to the rank asset: no Chinese
# chapter may receive its first paint before both bundled lexical resources are ready.
must_sub(
    'js/reader-app.js',
    r"  // Correct Chinese token boundaries are more important than a premature first\n  // paint\..*?\n  if \(readerCanonicalLang\(readerBookLang\(book\)\) === 'zh' && !readerZhCoreJson\) \{\n    try \{ await readerEnsureZhCoreJsonLoaded\(\{ rerender: false \}\); \}\n    catch \(error\) \{ console\.warn\('\[reader zh\] core-first paint fallback:', error\?\.message \|\| error\); \}\n  \}\n",
    r'''  // Chinese lexical pipeline v2: both resources are bundled in the APK.
  // Waiting once here is cheaper than painting bad token boundaries and trying
  // to repair every pinyin/translation/cache entry afterwards.
  if (readerCanonicalLang(readerBookLang(book)) === 'zh') {
    const [coreReady, ranksReady] = await Promise.allSettled([
      readerEnsureZhCoreJsonLoaded({ rerender: false }),
      ensureZhSegmentRanks(),
    ]);
    if (coreReady.status === 'rejected') console.warn('[reader zh] core-first fallback:', coreReady.reason);
    if (ranksReady.status === 'rejected') console.warn('[reader zh] rank-first fallback:', ranksReady.reason);
  }
''',
    'wait for core plus Jieba ranks before first paint',
    flags=re.S,
)

# ---------------------------------------------------------------------------
# 3. Translation trust: DeepSeek validates missing OR provisional machine RU.
# ---------------------------------------------------------------------------
context_path = Path('js/reader/zh-context-batch.js')
context_text = context_path.read_text(encoding='utf-8')
if not context_text.startswith("import { classifyChineseGloss }"):
    context_text = "import { classifyChineseGloss } from './zh-lexical-trust.js?v=1';\n\n" + context_text
context_path.write_text(context_text, encoding='utf-8')

must_sub(
    'js/reader/zh-context-batch.js',
    r"function existingRussianForOccurrence\(item\) \{.*?\n\}\n\nfunction needsDeepSeek\(item\) \{.*?\n\}",
    r'''function lexicalEntryForOccurrence(item) {
  const surface = clean(item?.surface || item?.word?.dataset?.word || '', 32);
  if (!surface) return null;
  try { return globalThis.readerLookupChineseWord?.(surface) || null; }
  catch { return null; }
}

function needsDeepSeek(item) {
  return classifyChineseGloss({
    wrap: item?.wrap || null,
    entry: lexicalEntryForOccurrence(item),
  }).needsContext;
}''',
    'replace Cyrillic-equals-done with provenance trust',
    flags=re.S,
)

# ---------------------------------------------------------------------------
# 4. Retire the unreliable Chinese -> English -> WikDict Russian display path.
#    English definitions stay available to DeepSeek as evidence; they are no
#    longer shown to the learner as if they were authoritative RU lexical data.
# ---------------------------------------------------------------------------
must_replace(
    'js/reader/zh-readable-inline.js',
    "  const english = localEnglish(word);\n  const translated = translatedRussian(english);\n  setLane(wrap, word, pinyin, translated);\n  if (!translated && english) queueEnglish(english);\n",
    "  // v2: do not turn an English dictionary sense into a Russian answer via\n  // another dictionary. That pipeline produced semantically unrelated first\n  // senses (title→заглавие, violate→изнасиловать, supply→запас). Keep pinyin\n  // visible; contextual AI or the delayed direct-ZH fallback owns Russian.\n  setLane(wrap, word, pinyin, '');\n",
    'retire EN-RU pivot from Chinese inline glosses',
)

# Direct isolated ZH->RU ML Kit remains an offline safety net, but it should not
# race the contextual lexical request and become the first thing the eye learns.
must_replace(
    'js/reader/zh-direct-ru-fallback.js',
    "const RETRY_MS = 20_000;\n",
    "const RETRY_MS = 20_000;\nconst CONTEXT_GRACE_MS = 2_200;\n",
    'add contextual grace before ML Kit fallback',
)
must_replace(
    'js/reader/zh-direct-ru-fallback.js',
    "  state.observer = new MutationObserver(() => setTimeout(queueVisible, 60));\n",
    "  state.observer = new MutationObserver(() => setTimeout(queueVisible, CONTEXT_GRACE_MS));\n",
    'delay mutation ML Kit fallback',
)
must_replace(
    'js/reader/zh-direct-ru-fallback.js',
    "  queueVisible();\n}\n\nif (typeof window !== 'undefined') {\n",
    "  setTimeout(queueVisible, CONTEXT_GRACE_MS);\n}\n\nif (typeof window !== 'undefined') {\n",
    'delay initial ML Kit fallback',
)
must_replace(
    'js/reader/zh-direct-ru-fallback.js',
    "  window.addEventListener('reader:zh-resource-ready', () => setTimeout(queueVisible, 60));\n",
    "  window.addEventListener('reader:zh-resource-ready', () => setTimeout(queueVisible, CONTEXT_GRACE_MS));\n",
    'delay resource ML Kit fallback',
)

# ---------------------------------------------------------------------------
# 5. Cache-bust only the modules whose semantics changed.
# ---------------------------------------------------------------------------
must_replace(
    'js/reader/interactions-runtime.js',
    "import './zh-context-batch.js?v=6-missing-only-auth'; // toc115: blank Unknowns only + authenticated Firebase client\n",
    "import './zh-context-batch.js?v=7-lexical-trust'; // v2: missing + provisional machine RU, trusted lexical RU is free\n",
    'bust context batch lexical trust',
)
must_replace(
    'js/reader/interactions-runtime.js',
    "import './zh-readable-inline.js?v=6';\n",
    "import './zh-readable-inline.js?v=7-context-first';\n",
    'bust readable inline context-first',
)
must_replace(
    'js/reader/interactions-runtime.js',
    "import './zh-direct-ru-fallback.js?v=1'; // toc100: direct on-device Chinese -> Russian for every visible Unknown\n",
    "import './zh-direct-ru-fallback.js?v=2-delayed'; // v2: offline safety net after contextual grace\n",
    'bust delayed direct fallback',
)
must_replace(
    'js/app.js',
    "} from './reader-app.js?v=77.40-zh-missing-only-auth';\n",
    "} from './reader-app.js?v=77.41-zh-lexical-v2';\n",
    'bust reader app lexical v2',
)
must_replace(
    'index.html',
    "window.AN2_BUILD = 'v77.42-toc115-zh-missing-only-auth';",
    "window.AN2_BUILD = 'v77.42-toc116-zh-lexical-v2';",
    'bump lexical v2 build marker',
)
must_replace(
    'index.html',
    '<script type="module" src="js/app.js?v=77.39-zh-missing-only-auth"></script>',
    '<script type="module" src="js/app.js?v=77.40-zh-lexical-v2"></script>',
    'bust lexical v2 app entry',
)

print('Chinese lexical pipeline v2 integrated')
