#!/usr/bin/env bash
set -euo pipefail

bash scripts/validate_toc135_frozen_toc134.sh
node --check js/reader/es-parity-ui-v1.js
node --check js/reader/interactions-runtime.js

python3 - <<'PY'
from pathlib import Path

ui=Path('js/reader/es-parity-ui-v1.js').read_text(encoding='utf-8')
interactions=Path('js/reader/interactions-runtime.js').read_text(encoding='utf-8')
gradle=Path('android/app/build.gradle').read_text(encoding='utf-8')

assert "versionCode 1028" in gradle
assert "versionName '77.42-toc135-es-readable-layout'" in gradle
assert "import './es-parity-ui-v1.js?v=135';" in interactions

selector='#reader-reading-view.rd-es-pipeline-v1.rd-es-unknown-gloss .reader-paragraph-text'
pos=ui.index(selector)
block=ui[pos:ui.index('}',pos)+1]
for probe in [
    'line-height:1.86!important',
    'text-align:start!important',
    'text-align-last:auto!important',
    'word-spacing:normal!important',
]:
    assert probe in block, f'toc135 enabled Spanish paragraph rule missing: {probe}'

# The alignment override must be scoped to interlinear mode only. Ordinary-text
# mode must still be able to honor an EPUB's own justified/centered alignment.
assert ui.count('text-align:start!important') == 1
assert 'not(.rd-es-unknown-gloss) .reader-paragraph-text' not in ui
assert 'Switching the mode off restores the EPUB' in ui

# Do not regress the mature toc134 geometry or mode controls while fixing gaps.
for probe in [
    'vertical-align:-.36em!important',
    'margin:0 .025em!important',
    'padding:0 0 .56em!important',
    'Русский под Unknown',
    'Обычный текст',
]:
    assert probe in ui, f'toc135 lost toc134 Spanish parity: {probe}'

print('toc135 Spanish readable layout source gate: PASS')
PY
