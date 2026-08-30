from pathlib import Path


def replace_once(path, old, new, label):
    p = Path(path)
    s = p.read_text()
    count = s.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match in {path}, got {count}')
    p.write_text(s.replace(old, new, 1))


# toc114: do not ever paint a Chinese chapter from the tiny fallback lexicon
# while the bundled 120k-entry zh_dict_core.json is still loading. The old
# anti-jitter rule deliberately froze that first cheap segmentation in place,
# so later DeepSeek/context work received broken one-character tokens.

# 1) Drop every segmentation decision made before this fix.
replace_once(
    'js/reader-app.js',
    "const READER_ZH_SEGMENT_CACHE_KEY = 'an2_zh_segment_cache_v5';\n",
    "const READER_ZH_SEGMENT_CACHE_KEY = 'an2_zh_segment_cache_v6_core_first';\n",
    'invalidate pre-core Chinese segmentation cache',
)

# 2) readerOpenBook is already async. For Chinese only, await the bundled core
# before the reading view gets its first chapter render. This is local APK I/O,
# not a network call. If loading fails, ensureZhCore resolves to an empty map and
# the old fallback still works instead of blocking the reader.
open_anchor = '''  if (!book) { showToast('⚠️ Текст не найден'); return; }\n  readerCurrentBookId = id;\n'''
open_replacement = '''  if (!book) { showToast('⚠️ Текст не найден'); return; }\n  readerCurrentBookId = id;\n\n  // Correct Chinese token boundaries are more important than a 100-300 ms\n  // premature first paint. zh_dict_core.json is bundled inside the APK, so\n  // wait once before rendering instead of freezing a character-by-character\n  // fallback and asking DeepSeek to translate the resulting debris.\n  if (readerCanonicalLang(readerBookLang(book)) === 'zh' && !readerZhCoreJson) {\n    try { await readerEnsureZhCoreJsonLoaded({ rerender: false }); }\n    catch (error) { console.warn('[reader zh] core-first paint fallback:', error?.message || error); }\n  }\n'''
replace_once('js/reader-app.js', open_anchor, open_replacement, 'await Chinese core before first paint')

# 3) Remove the deliberate Chinese "freeze the bad first paint" behavior from
# the renderer as a defensive fallback. If some future entry path renders zh
# without readerOpenBook, loading the core must trigger exactly one natural
# rerender rather than merely changing renderedZhCore metadata.
old_freeze = '''        if (isZh) {\n          // Keep the already-painted Chinese chapter immutable, exactly like\n          // English unknown-gloss v2: late data may improve the NEXT natural\n          // render, but must never replace live reading geometry. Mark this DOM\n          // as an accepted snapshot so paragraph navigation does not force a\n          // delayed full rerender merely because the core became available.\n          const chapterText = document.getElementById('reader-chapter-text');\n          if (chapterText && canonicalLang(getBookLang(current)) === 'zh') {\n            chapterText.dataset.renderedZhCore = String(!!isZhCoreLoaded?.());\n          }\n          try { window.dispatchEvent(new CustomEvent('reader:zh-core-ready')); } catch {}\n          return;\n        }\n\n        const scroller = document.querySelector('#reader-reading-view .rd-scroll');\n'''
new_freeze = '''        if (isZh) {\n          // toc114: never preserve a chapter that was segmented before the full\n          // bundled Chinese lexicon became available. readerOpenBook normally\n          // waits for it, but this fallback repairs any other render entry path.\n          const scroller = document.querySelector('#reader-reading-view .rd-scroll');\n          const savedScrollTop = scroller ? scroller.scrollTop : 0;\n          try { window.dispatchEvent(new CustomEvent('reader:zh-core-ready')); } catch {}\n          requestAnimationFrame(() => {\n            render();\n            if (scroller) scroller.scrollTop = savedScrollTop;\n          });\n          return;\n        }\n\n        const scroller = document.querySelector('#reader-reading-view .rd-scroll');\n'''
replace_once('js/reader/chapter-render-next.js', old_freeze, new_freeze, 'rerender Chinese once after core warmup')

# Cache-bust the renderer and reader module path after toc113 has already run.
replace_once(
    'js/reader/chapter-render-dialogue.js',
    "import { createReaderChapterRenderer as createNextRenderer } from './chapter-render-next.js?v=7';\n",
    "import { createReaderChapterRenderer as createNextRenderer } from './chapter-render-next.js?v=8-zh-core-first';\n",
    'bust chapter renderer toc114',
)
replace_once(
    'js/app.js',
    "} from './reader-app.js?v=77.38-zh-context-coverage';\n",
    "} from './reader-app.js?v=77.39-zh-core-first';\n",
    'bust reader app toc114',
)
replace_once(
    'index.html',
    "window.AN2_BUILD = 'v77.42-toc113-zh-context-coverage';",
    "window.AN2_BUILD = 'v77.42-toc114-zh-core-first';",
    'bump toc114 marker',
)
replace_once(
    'index.html',
    '<script type="module" src="js/app.js?v=77.37-zh-context-coverage"></script>',
    '<script type="module" src="js/app.js?v=77.38-zh-core-first"></script>',
    'bust toc114 app entry',
)

print('toc114 Chinese core-first paint patch applied')
