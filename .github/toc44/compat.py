from pathlib import Path

# toc44 makes one presentation layer authoritative. Legacy readable/baseline
# layers measured and rewrote the same word boxes, which defeats fixed geometry.

def insert_after(path, anchor, text):
    p = Path(path)
    s = p.read_text('utf-8')
    assert anchor in s, (path, anchor)
    s = s.replace(anchor, anchor + text, 1)
    p.write_text(s, 'utf-8')

# Base data/enrichment module: inert under Node renderer harness.
insert_after(
    'js/reader/zh-unknown-gloss.js',
    'function installObservers() {\n',
    "  if (typeof document === 'undefined' || typeof document.createElement !== 'function' || typeof MutationObserver === 'undefined') return;\n",
)

# Retire two old presentation authorities. Base module supplies compact RU data;
# stable-slots owns geometry. Keep spacing solely for 拼 mode bridge.
p = Path('js/reader/interactions-runtime.js')
s = p.read_text('utf-8')
for line in [
    "import './zh-unknown-gloss-readable.js?v=3';\n",
    "import './zh-unknown-gloss-baseline.js?v=1';\n",
]:
    assert line in s
    s = s.replace(line, '', 1)
p.write_text(s, 'utf-8')

# Spacing module remains only for pinyin-mode bridge and needs to be browser-only.
insert_after(
    'js/reader/zh-unknown-gloss-spacing.js',
    'function install() {\n',
    "  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;\n",
)

# Fixed slots use the base compact Russian attribute directly; no readable layer.
p = Path('js/reader/zh-stable-slots.js')
s = p.read_text('utf-8')
s = s.replace('content:attr(data-zh-gloss-ru-readable) !important;', 'content:attr(data-zh-gloss-ru) !important;', 1)
s = s.replace('[data-zh-gloss-ru-readable="…"]::after,', '[data-zh-gloss-ru="…"]::after,', 1)
s = s.replace('[data-zh-gloss-ru-readable="..."]::after {', '[data-zh-gloss-ru="..."]::after {', 1)
p.write_text(s, 'utf-8')

insert_after(
    'js/reader/zh-stable-slots.js',
    'function install() {\n',
    "  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;\n",
)
insert_after(
    'js/reader/zh-stable-slots.js',
    'function installObserver() {\n',
    "  if (typeof MutationObserver === 'undefined') return;\n",
)

# Vocabulary UI is also browser-only during renderer regression imports.
insert_after(
    'js/reader/vocab-estimate.js',
    'export function installVocabularyEstimate() {\n',
    "  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;\n",
)

runtime = Path('js/reader/interactions-runtime.js').read_text('utf-8')
assert 'zh-unknown-gloss-readable.js' not in runtime
assert 'zh-unknown-gloss-baseline.js' not in runtime
assert "import './zh-unknown-gloss-spacing.js?v=2';" in runtime
assert "import './zh-stable-slots.js?v=1';" in runtime
stable = Path('js/reader/zh-stable-slots.js').read_text('utf-8')
assert 'content:attr(data-zh-gloss-ru) !important;' in stable
assert 'content:attr(data-zh-gloss-ru-readable) !important;' not in stable
