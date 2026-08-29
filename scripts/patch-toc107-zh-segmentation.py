from pathlib import Path


def repl(text, old, new, label):
    if old not in text:
        raise RuntimeError(f'{label}: expected snippet not found')
    return text.replace(old, new, 1)


def repl_nth(text, old, new, n, label):
    parts = text.split(old)
    if len(parts) - 1 < n:
        raise RuntimeError(f'{label}: expected at least {n} matches, got {len(parts)-1}')
    out = parts[0]
    for i in range(1, len(parts)):
        out += (new if i == n else old) + parts[i]
    return out


p = Path('js/reader-app.js')
s = p.read_text(encoding='utf-8')

# Throw away segmentation decisions made by old builds while the full Chinese
# lexicon was still loading.
s = repl(s,
    "const READER_ZH_SEGMENT_CACHE_KEY = 'an2_zh_segment_cache_v4';",
    "const READER_ZH_SEGMENT_CACHE_KEY = 'an2_zh_segment_cache_v5';",
    'segment cache version')

# The second occurrence is inside readerTokenizeChineseParagraph(). The first
# belongs to the short-lived word-set cache and intentionally stays non-rendering.
old_load = "  if (!readerZhCoreJson && !readerZhCoreJsonPromise) readerEnsureZhCoreJsonLoaded({ rerender: false });"
new_load = "  if (!readerZhCoreJson && !readerZhCoreJsonPromise) readerEnsureZhCoreJsonLoaded({ rerender: true });"
s = repl_nth(s, old_load, new_load, 2, 'zh lexicon rerender')

# The Supabase segmenter is the stronger/context-aware pass. Previously it had
# to beat the cheap local greedy tokenizer by 1.2 points, which made unknown
# proper names such as 张又侠 lose to 张 / 又 / 侠. Reverse the burden of proof:
# prefer remote unless local is clearly (>1.2) better.
s = repl(s,
    "  return rs > ls + 1.2 ? remote : local;",
    "  return ls > rs + 1.2 ? local : remote;",
    'remote segmentation priority')

old_ready = """        try {
          window.dispatchEvent(new CustomEvent('reader:zh-segmentation-ready', { detail: { key } }));
        } catch {}
"""
new_ready = """        try {
          window.dispatchEvent(new CustomEvent('reader:zh-segmentation-ready', { detail: { key } }));
          const readingView = document.getElementById('reader-reading-view');
          if (readerCurrentLang() === 'zh' && readingView && readingView.style.display !== 'none') {
            renderReaderChapterInPlace();
          }
        } catch {}
"""
s = repl(s, old_ready, new_ready, 'remote segmentation rerender')
p.write_text(s, encoding='utf-8')

p = Path('js/app.js')
s = p.read_text(encoding='utf-8')
s = repl(s,
    "./reader-app.js?v=77.35-manual-known",
    "./reader-app.js?v=77.36-zh-segmentation",
    'reader-app cache bust')
p.write_text(s, encoding='utf-8')

p = Path('index.html')
s = p.read_text(encoding='utf-8')
s = repl(s,
    "window.AN2_BUILD = 'v77.42-toc104-deepseek-context';",
    "window.AN2_BUILD = 'v77.42-toc107-zh-segmentation';",
    'build marker')
s = repl(s,
    'js/app.js?v=77.34-manual-known',
    'js/app.js?v=77.35-zh-segmentation',
    'app cache bust')
p.write_text(s, encoding='utf-8')

print('toc107 zh segmentation patch applied')
