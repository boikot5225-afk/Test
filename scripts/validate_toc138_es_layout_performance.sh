#!/usr/bin/env bash
set -euo pipefail

GRADLE=android/app/build.gradle
BACKUP="$(mktemp)"
cp "$GRADLE" "$BACKUP"
restore() {
  cp "$BACKUP" "$GRADLE"
  rm -f "$BACKUP"
}
trap restore EXIT

# Re-run the complete green toc137 source contract against its original release
# metadata. toc138 is additive except for the explicitly audited Spanish tap path.
python3 - <<'PY'
from pathlib import Path
p=Path('android/app/build.gradle')
s=p.read_text(encoding='utf-8')
if s.count('versionCode 1031') != 1 or s.count("versionName '77.42-toc138-es-layout-performance'") != 1:
    raise SystemExit('toc138 Gradle metadata missing before frozen toc137 validation')
s=s.replace('versionCode 1031','versionCode 1030',1)
s=s.replace("versionName '77.42-toc138-es-layout-performance'","versionName '77.42-toc137-es-card-status'",1)
p.write_text(s,encoding='utf-8')
PY
bash scripts/validate_toc137_es_card_status.sh
cp "$BACKUP" "$GRADLE"

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
# Full chapter repaint remains for non-Spanish readers but must be inside the else
# branch after the Spanish fast path, never before it.
assert panel.index("if (activeLang === 'es')") < panel.index('} else {') < panel.index('renderReaderChapter()')

# toc137 card status ownership must survive untouched.
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
