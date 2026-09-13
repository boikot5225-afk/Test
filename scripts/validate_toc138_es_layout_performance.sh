#!/usr/bin/env bash
set -euo pipefail

# The workflow runs the complete frozen toc137 validator before applying the
# intentional toc138 readerOpenWordPanel hot-path patch. From this point onward
# validate only the toc138 delta instead of pretending reader-app stayed frozen.
python3 scripts/materialize_es_vocab_module.py /tmp/toc138-es-vocab-estimate.js
node --check /tmp/toc138-es-vocab-estimate.js
node --check js/reader/es-smooth-reader-v1.js
node --check js/reader/interactions-runtime.js
node --check js/reader-app.js

python3 - <<'PY'
from pathlib import Path

def read(path): return Path(path).read_text(encoding='utf-8')

gradle=read('android/app/build.gradle')
interactions=read('js/reader/interactions-runtime.js')
smooth=read('js/reader/es-smooth-reader-v1.js')
reader=read('js/reader-app.js')
generated=Path('/tmp/toc138-es-vocab-estimate.js').read_text(encoding='utf-8')

assert 'versionCode 1031' in gradle
assert "versionName '77.42-toc138-es-layout-performance'" in gradle
assert "import './es-smooth-reader-v1.js?v=138';" in interactions

for probe in [
    'text-align:justify!important',
    'text-align-last:auto!important',
    'position:absolute!important',
    'rd-es-unknown-gloss .rw-es-v1-gloss:not(:empty){display:block!important}',
    '#reader-es-known-btn,#reader-es-unknown-btn',
    'event.stopImmediatePropagation()',
    'readerApplySpanishVocabularyEstimate',
    '__toc138SmoothEs',
    'const CHUNK = 72',
    'requestIdleCallback',
    'wordStateIdbPut',
    "readerSpanishRefresh?.('manual-idle', false)",
]:
    assert probe in smooth, f'toc138 Spanish smooth-reader contract missing: {probe}'

assert '#reader-reading-view.rd-es-smooth-v1 .rw-es-v1-gloss:not(:empty){display:block!important}' not in smooth

start=reader.index('async function readerOpenWordPanel(')
end=reader.index('\nasync function ', start + 10)
panel=reader[start:end]
for probe in [
    "if (activeLang === 'es')",
    "readerSpanishRefresh?.('word-tap-fast', false)",
    'readerRefreshParagraphWordClasses(paragraphIndex)',
]:
    assert probe in panel, f'toc138 Spanish word-tap hot path missing: {probe}'
assert panel.index("if (activeLang === 'es')") < panel.index('} else {') < panel.index('renderReaderChapter()')

for probe in [
    'readerEsVocabPanelHook',
    "panel.dataset.migakuKnowledge='es1'",
    'reader-es-known-btn',
    'reader-es-unknown-btn',
    'reader-es-knowledge-source',
]:
    assert probe in generated, f'toc137 Spanish card-status regression: {probe}'
assert 'readerFrVocabPanelHook' not in generated

print('toc138 Spanish layout/performance source gate: PASS')
PY
