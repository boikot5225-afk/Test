from pathlib import Path


def replace_once(path, old, new, label):
    p = Path(path)
    s = p.read_text()
    count = s.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match in {path}, got {count}')
    p.write_text(s.replace(old, new, 1))


# toc113: Chinese context coverage / empty-gloss fix.
# This patch is applied AFTER toc112 in CI.

# 1) The inline layer was stricter than the AI contract: zh_context_batch is
# explicitly instructed to return 1-3 Russian words, while toc112 accepted only
# 1-2 words / 22 chars. Valid contextual translations were therefore painted by
# the batch and immediately erased by the readable layer's next sync pass.
replace_once(
    'js/reader/zh-readable-inline.js',
    "  if (!words.length || words.length > 2 || text.length > 22) return '';\n",
    "  if (!words.length || words.length > 3 || text.length > 36) return '';\n",
    'allow full 1-3 word contextual gloss contract',
)

# 2) Fresh manual DeepSeek must publish whichever Russian field the provider
# returned. The cached paths already did this; the fresh path used payload.ru
# only, so a valid translation_ru/russian/meaning_ru result could leave the
# inline slot blank.
replace_once(
    'js/reader-app.js',
    "    if (sourceLang === 'zh' && hasContext) readerPublishChineseContextGloss(word, context, payload.ru);\n",
    "    if (sourceLang === 'zh' && hasContext) readerPublishChineseContextGloss(\n      word,\n      context,\n      payload.ru || payload.translation_ru || payload.russian || payload.meaning_ru || payload.translation || payload.meaning || ''\n    );\n",
    'publish every fresh Chinese Russian field',
)

# 3) Page mode needs an explicit signal. A page turn is not a window scroll and
# can happen without a mutation observed by zh-context-batch, which is why one
# page could be filled while the next stayed mostly dictionary/pinyin-only.
replace_once(
    'js/reader/pages-mode.js',
    "    onPageChange?.(currentPageIndex, pages.length);\n  }\n",
    "    onPageChange?.(currentPageIndex, pages.length);\n    try {\n      window.dispatchEvent(new CustomEvent('reader:pagechange', {\n        detail: { pageIndex: currentPageIndex, pageCount: pages.length },\n      }));\n    } catch {}\n  }\n",
    'dispatch pagechange from instant page switch',
)
replace_once(
    'js/reader/pages-mode.js',
    "      onPageChange?.(currentPageIndex, pages.length);\n      // Use the page object captured when the gesture began. Looking up\n",
    "      onPageChange?.(currentPageIndex, pages.length);\n      try {\n        window.dispatchEvent(new CustomEvent('reader:pagechange', {\n          detail: { pageIndex: currentPageIndex, pageCount: pages.length },\n        }));\n      } catch {}\n      // Use the page object captured when the gesture began. Looking up\n",
    'dispatch pagechange after animated turn',
)

# 4) Use the server's actual per-call ceiling. 18 was needlessly leaving the
# tail of a dense Chinese screen for later passes; 24 is the hard server limit.
replace_once(
    'js/reader/zh-context-batch.js',
    "const MAX_TARGETS = 18;\nconst RETRY_BATCH_TARGETS = 6;\n",
    "const MAX_TARGETS = 24;\nconst RETRY_BATCH_TARGETS = 10;\n",
    'increase context batch coverage',
)

# Explicit page-turn wakeup for both context generation and inline repaint.
replace_once(
    'js/reader/zh-context-batch.js',
    "  window.addEventListener('reader:chromechange', () => schedule(80));\n",
    "  window.addEventListener('reader:chromechange', () => schedule(80));\n  window.addEventListener('reader:pagechange', () => schedule(35));\n",
    'wake batch on page turn',
)
replace_once(
    'js/reader/zh-readable-inline.js',
    "  window.addEventListener('reader:chromechange', () => schedule(15));\n",
    "  window.addEventListener('reader:chromechange', () => schedule(15));\n  window.addEventListener('reader:pagechange', () => schedule(10));\n",
    'repaint readable inline on page turn',
)

# 5) Batch results can legitimately be 3 words too. Keep client acceptance in
# lock-step with the prompt instead of silently discarding the third word.
replace_once(
    'js/reader/zh-context-batch.js',
    "  if (!words.length || words.length > 4) return '';\n",
    "  if (!words.length || words.length > 3 || text.length > 36) return '';\n",
    'align batch compact RU with 1-3 word prompt',
)

# Cache bust the three runtime modules touched above.
replace_once(
    'js/reader/interactions-runtime.js',
    "import './zh-readable-inline.js?v=7-context-card';\n",
    "import './zh-readable-inline.js?v=8-context-coverage';\n",
    'bust readable inline toc113',
)
replace_once(
    'js/reader/interactions-runtime.js',
    "import './zh-context-batch.js?v=4'; // toc100: retry incomplete visible Chinese glosses; no layout ownership\n",
    "import './zh-context-batch.js?v=5-page-coverage'; // toc113: page-turn wakeup + full 24-target coverage\n",
    'bust context batch toc113',
)
replace_once(
    'js/reader-app.js',
    "import { createReaderPagesMode } from './reader/pages-mode.js?v=3';\n",
    "import { createReaderPagesMode } from './reader/pages-mode.js?v=4-context-wakeup';\n",
    'bust pages mode toc113',
)
replace_once(
    'js/app.js',
    "} from './reader-app.js?v=77.37-zh-context-inline';\n",
    "} from './reader-app.js?v=77.38-zh-context-coverage';\n",
    'bust reader app toc113',
)
replace_once(
    'index.html',
    "window.AN2_BUILD = 'v77.42-toc112-zh-context-inline';",
    "window.AN2_BUILD = 'v77.42-toc113-zh-context-coverage';",
    'bump toc113 marker',
)
replace_once(
    'index.html',
    '<script type="module" src="js/app.js?v=77.36-zh-context-inline"></script>',
    '<script type="module" src="js/app.js?v=77.37-zh-context-coverage"></script>',
    'bust toc113 app entry',
)

print('toc113 Chinese context coverage patch applied')
