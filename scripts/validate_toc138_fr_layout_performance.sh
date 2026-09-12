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

# Reuse the complete green toc137/toc136 source gates with only release metadata
# presented as toc137. toc138 intentionally adds late French UI/perf owners.
python3 - <<'PY'
from pathlib import Path
p=Path('android/app/build.gradle')
s=p.read_text(encoding='utf-8')
assert s.count('versionCode 1031') == 1
assert s.count("versionName '77.42-toc138-fr-layout-performance'") == 1
s=s.replace('versionCode 1031','versionCode 1030',1)
s=s.replace("versionName '77.42-toc138-fr-layout-performance'","versionName '77.42-toc137-es-card-status'",1)
p.write_text(s,encoding='utf-8')
PY
bash scripts/validate_toc137_es_card_status.sh
restore
trap - EXIT

node --check js/reader/fr-smooth-reader-v1.js
node --check js/reader/fr-word-panel-smooth-v1.js
node --check js/reader/interactions-runtime.js

python3 - <<'PY'
from pathlib import Path

def text(path):
    return Path(path).read_text(encoding='utf-8')

smooth=text('js/reader/fr-smooth-reader-v1.js')
panel=text('js/reader/fr-word-panel-smooth-v1.js')
interactions=text('js/reader/interactions-runtime.js')
gradle=text('android/app/build.gradle')

assert 'versionCode 1031' in gradle
assert "versionName '77.42-toc138-fr-layout-performance'" in gradle

for probe in [
    "import { wordStateIdbPut } from './word-state-idb-store.js?v=1';",
    'text-align:justify!important',
    'text-align-last:auto!important',
    'display:inline!important',
    'position:absolute!important',
    'top:100%!important',
    'rw-fr-v2-wrap',
    'rw-fr-gloss-wrap',
    'reader-fr-known-btn,#reader-fr-unknown-btn',
    'event.stopImmediatePropagation()',
    'reader:fr-manual-knowledge-fast',
    'requestIdleCallback',
    'smoothApplyEstimate',
    '__toc138Smooth',
]:
    assert probe in smooth, f'toc138 French smooth contract missing: {probe}'

for probe in [
    '__toc138FrenchSmoothPanel',
    '__toc138FrenchSuppressedChapterRepaints',
    'renderReaderChapter',
    'requestAnimationFrame',
    "currentLang() !== 'fr'",
]:
    assert probe in panel, f'toc138 French word-panel smooth contract missing: {probe}'

# The late owners must be loaded after the lexical French owner and before the
# Spanish pipeline; page actions must not force a redundant French pass.
lex=interactions.index("import './fr-lexical-pipeline-v2.js?v=124';")
smooth_i=interactions.index("import './fr-smooth-reader-v1.js?v=138';")
panel_i=interactions.index("import './fr-word-panel-smooth-v1.js?v=138';")
es=interactions.index("import './es-reader-pipeline-v1.js?v=1';")
assert lex < smooth_i < panel_i < es
assert "window.readerFrenchRefresh?.(reason, false)" in interactions
assert "window.readerSpanishRefresh?.(reason, true)" in interactions

print('toc138 French layout/performance source gate: PASS')
PY
