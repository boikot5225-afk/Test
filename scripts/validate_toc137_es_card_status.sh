#!/usr/bin/env bash
set -euo pipefail

bash scripts/validate_toc137_frozen_toc136.sh
python3 scripts/materialize_es_vocab_module.py /tmp/toc137-es-vocab-estimate.js
node --check /tmp/toc137-es-vocab-estimate.js

python3 - <<'PY'
from pathlib import Path

gradle=Path('android/app/build.gradle').read_text(encoding='utf-8')
generated=Path('/tmp/toc137-es-vocab-estimate.js').read_text(encoding='utf-8')
materializer=Path('scripts/materialize_es_vocab_module.py').read_text(encoding='utf-8')

assert 'versionCode 1030' in gradle
assert "versionName '77.42-toc137-es-card-status'" in gradle

for probe in [
    'readerEsVocabPanelHook',
    "panel.dataset.migakuKnowledge!=='es1'",
    "panel.dataset.migakuKnowledge='es1'",
    'reader-es-known-btn',
    'reader-es-unknown-btn',
    'reader-es-knowledge-source',
    'syncPanelKnowledge',
    'decorateWordPanel',
]:
    assert probe in generated, f'toc137 Spanish panel status contract missing: {probe}'

for leaked in [
    'readerFrVocabPanelHook',
    "panel.dataset.migakuKnowledge!=='fr1'",
    "panel.dataset.migakuKnowledge='fr1'",
]:
    assert leaked not in generated, f'toc137 Spanish generated owner leaked French sentinel: {leaked}'

assert 'Spanish panel identity anchor changed' in materializer
print('toc137 Spanish card-status source gate: PASS')
PY
