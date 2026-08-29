from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f'missing marker in {path}: {old[:100]!r}')
    if s.count(old) != 1:
        raise SystemExit(f'expected one marker in {path}, got {s.count(old)}')
    p.write_text(s.replace(old, new, 1))

p = Path('js/reader/zh-readable-inline.js')
s = p.read_text()
if "const STYLE_ID = 'reader-zh-readable-inline-v6';" in s:
    s = s.replace("const STYLE_ID = 'reader-zh-readable-inline-v6';", "const STYLE_ID = 'reader-zh-readable-inline-v7-known-collapse';", 1)

needle = '''    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap {
      display: contents !important;
      margin: 0 !important;
      padding: 0 !important;
    }

    /* Only a confirmed Unknown becomes a two-row ruby-like unit.'''
replacement = '''    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap {
      display: contents !important;
      margin: 0 !important;
      padding: 0 !important;
    }

    /* The helper lane is opt-in, never opt-out. When Unknown -> Known changes
       the word class, CSS must hide the old pinyin/Russian lane in the very
       same style pass. MutationObserver will remove the node afterwards, but
       no stale frame may inherit the book's large font and escape into layout. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"]
    .rw-zh-gloss-wrap > .rw-zh-readable-ru {
      display: none !important;
    }

    /* Only a confirmed Unknown becomes a two-row ruby-like unit.'''
if needle not in s:
    raise SystemExit('missing readable-inline wrapper CSS marker')
s = s.replace(needle, replacement, 1)
p.write_text(s)

# Bust the complete import chain so Android WebView cannot retain toc109 CSS/JS.
replace_once('js/reader/interactions-runtime.js', "./zh-readable-inline.js?v=6", "./zh-readable-inline.js?v=7-known-collapse")
replace_once('js/reader/chapter-render-next.js', "./interactions-runtime.js?v=3-zh-context-inline", "./interactions-runtime.js?v=4-known-collapse")
replace_once('js/reader/chapter-render-stage1.js', "./chapter-render-next.js?v=15-zh-context-inline", "./chapter-render-next.js?v=16-known-collapse")
replace_once('js/reader/chapter-render-dialogue.js', "./chapter-render-stage1.js?v=13-zh-context-inline", "./chapter-render-stage1.js?v=14-known-collapse")
replace_once('js/reader/chapter-render.js', "./chapter-render-dialogue.js?v=11-zh-context-inline", "./chapter-render-dialogue.js?v=12-known-collapse")
replace_once('js/reader-app.js', "./reader/chapter-render.js?v=13-zh-context-inline", "./reader/chapter-render.js?v=14-known-collapse")
replace_once('js/app.js', "./reader-app.js?v=77.38-zh-context-inline", "./reader-app.js?v=77.39-known-gloss-collapse")
replace_once('index.html', "js/app.js?v=77.37-zh-context-inline", "js/app.js?v=77.38-known-gloss-collapse")

print('toc110 known-gloss collapse patch applied')
