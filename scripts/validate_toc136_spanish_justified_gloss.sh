#!/usr/bin/env bash
set -euo pipefail

bash scripts/validate_toc136_frozen_toc133.sh
python3 scripts/build_es_reader_resources.py --output-dir /tmp/toc136-es-self --cache-dir /tmp/toc136-es-cache --self-test
python3 scripts/materialize_es_vocab_module.py /tmp/toc136-es-vocab-estimate.js
node --check /tmp/toc136-es-vocab-estimate.js
node --check js/reader/es-reader-pipeline-v1.js
node --check js/reader/es-context-batch-v1.js
node --check js/reader/es-lexical-pipeline-v1.js
node --check js/reader/es-inline-lexical-owner-v1.js
node --check js/reader/es-parity-ui-v1.js
node --check js/reader/word-lookup.js
node --check js/reader/interactions-runtime.js

python3 - <<'PY'
from pathlib import Path

def text(path):
    return Path(path).read_text(encoding='utf-8')

lookup=text('js/reader/word-lookup.js')
interactions=text('js/reader/interactions-runtime.js')
lexical=text('js/reader/es-lexical-pipeline-v1.js')
inline=text('js/reader/es-inline-lexical-owner-v1.js')
ui=text('js/reader/es-parity-ui-v1.js')
reader=text('js/reader-app.js')
gradle=text('android/app/build.gradle')
generated=Path('/tmp/toc136-es-vocab-estimate.js').read_text(encoding='utf-8')

assert 'versionCode 1029' in gradle
assert "versionName '77.42-toc136-es-justified-gloss-layout'" in gradle

# Spanish remains a first-class Reader language and never falls through the old
# French lexical chain.
assert "es: { code: 'es', label: 'Español'" in reader
assert "sourceLang === 'es'" in reader
es_route=lookup.index("if (lang === 'es')")
quick=lookup.index('const quick = quickLookup(normalized)')
verbs=lookup.index('const verbHit = findVerbByForm(normalized)')
assert es_route < quick < verbs
for probe in [
    'readerSpanishLexicalAnalysisFor',
    'readerSpanishContextualAnalysisFor',
    'readerLoadSpanishVocabularyData',
    "const suffixes = ['melos'",
    'analysisOverrides',
    'properLemmas',
]:
    assert probe in lexical, f'Spanish lexical owner missing: {probe}'
for probe in [
    'readerSpanishLexicalAnalysisFor',
    'es-lexical-owner',
    'readerSpanishPipelineV1RefreshNow',
    'context-deepseek-batch',
    'restoreRememberedContext',
    "reader:es-vocab-ready",
]:
    assert probe in inline, f'Spanish inline owner missing: {probe}'
for probe in [
    'readerLoadSpanishVocabularyData',
    'readerSpanishLemmaFor',
    'readerApplySpanishVocabularyEstimate',
    'readerSpanishVocabularyKnowledgeFor',
    'reader-es-vocab-btn',
    'reader-es-known-btn',
    'reader-es-unknown-btn',
    'manualKnowledge',
    'conservativeKnownCount',
]:
    assert probe in generated, f'generated Spanish vocabulary parity missing: {probe}'

# toc136 layout contract: source words remain ordinary inline text in the EPUB
# justification algorithm. Only the Russian hint is absolute and therefore has
# zero horizontal width. top:100% anchors it immediately below the one-word
# relative inline box without converting the Spanish word to inline-block.
for probe in [
    "import './es-inline-lexical-owner-v1.js?v=134';",
    'line-height:1.72!important',
    'display:inline!important;position:relative!important;vertical-align:baseline!important',
    'white-space:nowrap!important;word-break:keep-all!important',
    'display:block!important;position:absolute!important;left:50%!important;top:100%!important',
    'transform:translateX(-50%)!important',
    "font-family:'IBM Plex Sans',sans-serif!important",
    'font-size:var(--es-v1-gloss-font,.38em)!important',
    'Обычный текст',
    'Русский под Unknown',
]:
    assert probe in ui, f'toc136 Spanish layout contract missing: {probe}'
# Comments may discuss the retired layout; only an actual CSS declaration is a leak.
assert 'display:inline-block' not in ui
assert "not(.rd-es-unknown-gloss) .rw-es-v1-gloss{display:none!important}" in ui

for probe in [
    "import './es-reader-pipeline-v1.js?v=1';",
    "import './es-context-batch-v1.js?v=1';",
    "import './es-lexical-pipeline-v1.js?v=134';",
    "import './es-parity-ui-v1.js?v=136';",
]:
    assert probe in interactions, f'Spanish runtime owner missing: {probe}'

print('toc136 Spanish justified gloss source gate: PASS')
PY
