#!/usr/bin/env bash
set -euo pipefail
APK="${1:-$(find android/app/build/outputs/apk/debug -name '*.apk' | head -1)}"
test -f "$APK"
if unzip -l "$APK" | grep -q 'assets/www/build/'; then
  echo 'transient repo build cache leaked into APK' >&2
  exit 1
fi
rm -rf /tmp/toc124-apkcheck
mkdir -p /tmp/toc124-apkcheck
unzip -q "$APK" -d /tmp/toc124-apkcheck \
  assets/www/js/reader/interactions.js \
  assets/www/js/reader/pages-mode.js \
  assets/www/js/reader-app.js \
  assets/www/js/reader/epub.js \
  assets/www/js/reader/toc-runtime.js \
  assets/www/js/reader/fr-reader-pipeline-v2.js \
  assets/www/js/reader/fr-context-refine-v2.js \
  assets/www/js/reader/fr-vocab-estimate.js \
  assets/www/js/reader/fr-lexical-pipeline-v2.js \
  assets/www/js/reader/fr-unknown-gloss.js \
  assets/www/js/reader/interactions-runtime.js \
  assets/frreader/fr_vocab_frequency.tsv \
  assets/frreader/fr_vocab_lemma.tsv \
  assets/frreader/fr_ru_core.json \
  assets/frreader/fr_ru_senses.json
cd /tmp/toc124-apkcheck
cat > /tmp/toc124-core.sha256 <<'EOF'
b709451dec2849b8487b054fd8f52c57ef9fc91dc5f5818ed5720e00dda08ba6  assets/www/js/reader/interactions.js
13ce9f42db4427e1c2442abad7c0e66343aad92d79a4e945376fb42afed8e7d9  assets/www/js/reader/pages-mode.js
202e287af1158b8498e44ae3e9ce28cf43b1a0aaaba9f01b25bfdfa2fde47f04  assets/www/js/reader-app.js
896834e059da0a3c59b779e94705bb61187c9b4db31d6590d8c76cc4941770e7  assets/www/js/reader/epub.js
d0ee752392b38822cfaeb0d557f7c359ca4aae166650b8844adfb9012bc38d8c  assets/www/js/reader/toc-runtime.js
EOF
sha256sum -c /tmp/toc124-core.sha256
node --check assets/www/js/reader/fr-reader-pipeline-v2.js
node --check assets/www/js/reader/fr-context-refine-v2.js
node --check assets/www/js/reader/fr-lexical-pipeline-v2.js
node --check assets/www/js/reader/interactions-runtime.js

grep -q "fr-reader-pipeline-v2.js?v=1" assets/www/js/reader/interactions-runtime.js
grep -q "fr-context-refine-v2.js?v=1" assets/www/js/reader/interactions-runtime.js
! grep -q "^import './fr-vocab-estimate.js" assets/www/js/reader/interactions-runtime.js
! grep -q "^import './fr-unknown-gloss.js" assets/www/js/reader/interactions-runtime.js
! grep -q "new MutationObserver" assets/www/js/reader/fr-reader-pipeline-v2.js
! grep -q "new MutationObserver" assets/www/js/reader/fr-context-refine-v2.js

test -s assets/frreader/fr_vocab_frequency.tsv
test -s assets/frreader/fr_vocab_lemma.tsv
test -s assets/frreader/fr_ru_core.json
test -s assets/frreader/fr_ru_senses.json
python3 - <<'PY'
import json
from pathlib import Path
core=json.loads(Path('assets/frreader/fr_ru_core.json').read_text(encoding='utf-8'))
assert core.get('elle','').strip(), core.get('elle')
assert core.get('tendre','').strip(), core.get('tendre')
assert core.get('vouloir','').strip(), core.get('vouloir')
print('toc124 APK payload: frozen Reader + French quality pipeline PASS')
PY
