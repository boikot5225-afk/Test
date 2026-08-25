from pathlib import Path

# These Reader modules are browser UI layers. Repository regression tests import
# the renderer under a deliberately tiny document mock, so installers must stay
# inert when a real DOM is unavailable.

def insert_after(path, anchor, text):
    p = Path(path)
    s = p.read_text('utf-8')
    assert anchor in s, (path, anchor)
    s = s.replace(anchor, anchor + text, 1)
    p.write_text(s, 'utf-8')

insert_after(
    'js/reader/zh-unknown-gloss.js',
    'function installObservers() {\n',
    "  if (typeof document === 'undefined' || typeof document.createElement !== 'function' || typeof MutationObserver === 'undefined') return;\n",
)
insert_after(
    'js/reader/zh-unknown-gloss-readable.js',
    'function install() {\n',
    "  if (typeof document === 'undefined' || typeof document.createElement !== 'function' || typeof MutationObserver === 'undefined') return;\n",
)
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
insert_after(
    'js/reader/vocab-estimate.js',
    'export function installVocabularyEstimate() {\n',
    "  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;\n",
)

for path in [
    'js/reader/zh-unknown-gloss.js',
    'js/reader/zh-unknown-gloss-readable.js',
    'js/reader/zh-stable-slots.js',
    'js/reader/vocab-estimate.js',
]:
    s = Path(path).read_text('utf-8')
    assert 'document.createElement' in s
