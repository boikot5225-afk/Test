#!/usr/bin/env bash
set -euo pipefail

bash scripts/validate_toc134_frozen_toc133.sh
python3 scripts/build_es_reader_resources.py --output-dir /tmp/toc134-es-self --cache-dir /tmp/toc134-es-cache --self-test
python3 scripts/materialize_es_vocab_module.py /tmp/toc134-es-vocab-estimate.js
node --check /tmp/toc134-es-vocab-estimate.js
node --check js/reader/es-reader-pipeline-v1.js
node --check js/reader/es-context-batch-v1.js
node --check js/reader/es-lexical-pipeline-v1.js
node --check js/reader/es-inline-lexical-owner-v1.js
node --check js/reader/es-parity-ui-v1.js
node --check js/reader/word-lookup.js

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
generated=Path('/tmp/toc134-es-vocab-estimate.js').read_text(encoding='utf-8')

assert "versionCode 1027" in gradle
assert "versionName '77.42-toc134-es-parity'" in gradle

# The real Android Reader already has ES as a first-class language. toc134 must
# preserve that rather than patching the excluded legacy root app.js.
assert "es: { code: 'es', label: 'Español'" in reader
assert "if (raw === 'es' || raw.startsWith('es-') || raw === 'spanish') return 'es';" in reader
assert "sourceLang === 'es'" in reader
assert 'For Spanish conjugated verb forms' in reader

# Spanish taps terminate at the Spanish lexical owner before any old French
# quick/cache/verb/noun fallback can execute.
es_route=lookup.index("if (lang === 'es')")
quick=lookup.index('const quick = quickLookup(normalized)')
verbs=lookup.index('const verbHit = findVerbByForm(normalized)')
assert es_route < quick < verbs
assert 'readerSpanishLexicalAnalysisFor' in lookup
assert 'readerSpanishLexicalAnalysisFor' in lexical
assert 'readerSpanishContextualAnalysisFor' in lexical
assert 'readerLoadSpanishVocabularyData' in lexical
assert "const suffixes = ['melos'" in lexical
assert "return baseMapped" in lexical
assert "return mapped" in lexical
assert "analysisOverrides" in lexical
assert "properLemmas" in lexical

# Inline Unknown fallback must use exactly the same Spanish lexical analysis as
# the word card. Context translations keep priority over the local lexical owner,
# and an accepted contextual occurrence must survive Known -> Unknown + repaint.
assert "import './es-inline-lexical-owner-v1.js?v=134';" in ui
for probe in [
    'readerSpanishLexicalAnalysisFor',
    'es-lexical-owner',
    'readerSpanishPipelineV1RefreshNow',
    'readerSpanishInlineLexicalRefresh',
    'context-deepseek-batch',
    'rw-migaku-unknown',
    'contextByOccurrence',
    'restoreRememberedContext',
    "reader:es-vocab-ready",
]:
    assert probe in inline, f'Spanish inline lexical owner missing: {probe}'

# Generated ES vocabulary must own the same mature controls as French: Measure
# my level, lemma-based classification and manual Known/Unknown.
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

# Presentation values intentionally match English Unknown gloss v5 exactly.
for probe in [
    'line-height:1.86!important',
    'vertical-align:-.36em!important',
    'margin:0 .025em!important',
    'padding:0 0 .56em!important',
    "font-family:'IBM Plex Sans',sans-serif!important",
    'font-size:var(--es-v1-gloss-font,.38em)!important',
    'Обычный текст',
    'Русский под Unknown',
    'reader-en-vocab-btn',
    'reader-fr-vocab-btn',
    'reader-es-vocab-btn',
]:
    assert probe in ui, f'Spanish UI parity missing: {probe}'
assert "not(.rd-es-unknown-gloss) .rw-es-v1-wrap" in ui
assert "not(.rd-es-unknown-gloss) .rw-es-v1-gloss{display:none!important}" in ui

for probe in [
    "import './es-reader-pipeline-v1.js?v=1';",
    "import './es-context-batch-v1.js?v=1';",
    "import './es-lexical-pipeline-v1.js?v=134';",
    "import './es-parity-ui-v1.js?v=134';",
]:
    assert probe in interactions, f'Spanish runtime owner missing: {probe}'

print('toc134 Spanish parity source gate: PASS')
PY
