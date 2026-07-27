from pathlib import Path
import sys

root = Path(sys.argv[1])


def replace(path, old, new, count=1):
    p = root / path
    s = p.read_text()
    actual = s.count(old)
    if actual != count:
        raise SystemExit(f'{path}: expected {count} occurrences, found {actual}: {old[:120]!r}')
    p.write_text(s.replace(old, new, count))


# On a narrow phone screen, EPUB justification creates huge rivers of whitespace.
# Preserve useful alignment such as center/right, but render justified body text
# with the reader's normal mobile alignment. The renderer change also repairs
# books already imported by v77.30.
replace(
    'js/reader/semantic-import-stage1.js',
    "const align = /^(?:left|right|center|justify|start|end)$/.test(alignRaw) ? alignRaw : '';",
    "const align = /^(?:left|right|center|start|end)$/.test(alignRaw) ? alignRaw : '';",
)
replace(
    'js/reader/semantic-content-footnotes.js',
    "const align = /^(?:left|right|center|justify|start|end)$/.test(String(block.textAlign || '')) ? block.textAlign : '';",
    "const align = /^(?:left|right|center|start|end)$/.test(String(block.textAlign || '')) ? block.textAlign : '';",
)

# Semantic EPUB paragraphs are objects. Prefetch must extract their plain text,
# exactly like manual paragraph translation already does.
replace(
    'js/reader-app.js',
    "    const text = paras[next]; if (!text) return;",
    "    const text = readerCurrentParagraphText(next); if (!text) return;",
)

# v77.30 may already have cached the model's apology produced by the object input.
# Delete only that known-invalid value; keep every valid user translation intact.
p = root / 'js/reader/chapter-render-dialogue.js'
s = p.read_text()
old = """    normalizeSemanticBookTranslations(book, {
      reindexed: lineItemsChanged || textChunksChanged,
    });
    return book;
"""
new = """    normalizeSemanticBookTranslations(book, {
      reindexed: lineItemsChanged || textChunksChanged,
    });
    if (book?.readerTranslations && typeof book.readerTranslations === 'object') {
      for (const [key, value] of Object.entries(book.readerTranslations)) {
        const text = translationValueText(value);
        if (/не является строкой|предоставьте текст в виде строки/i.test(text)) {
          delete book.readerTranslations[key];
        }
      }
    }
    return book;
"""
if s.count(old) != 1:
    raise SystemExit('chapter-render-dialogue: translation cleanup anchor mismatch')
p.write_text(s.replace(old, new, 1))

# Cache-bust only the modules changed by this follow-up patch.
replace('js/reader/semantic-import-bridge.js', "./semantic-import-stage1.js?v=4", "./semantic-import-stage1.js?v=5")
replace('js/reader/chapter-render-stage1.js', "./semantic-content-footnotes.js?v=2", "./semantic-content-footnotes.js?v=3")
replace('js/reader/chapter-render-stage1.js', "./semantic-import-bridge.js?v=4", "./semantic-import-bridge.js?v=5")
replace('js/reader/chapter-render-dialogue.js', "./chapter-render-stage1.js?v=9", "./chapter-render-stage1.js?v=10")
replace('js/reader/chapter-render.js', "./chapter-render-dialogue.js?v=7", "./chapter-render-dialogue.js?v=8")
replace('js/reader-app.js', "./reader/chapter-render.js?v=9", "./reader/chapter-render.js?v=10")
replace('js/app.js', "./reader-app.js?v=77.30", "./reader-app.js?v=77.31")
replace('index.html', "v77.30-footnotes-formatting-test", "v77.31-footnotes-formatting-translation-test")
replace('index.html', "js/app.js?v=77.30", "js/app.js?v=77.31")
replace('sw.js', "v77.30-footnotes-formatting-test", "v77.31-footnotes-formatting-translation-test")

print('patched v77.31', root)
